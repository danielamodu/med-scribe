const express = require('express');
const cors = require('cors');
const https = require('https');
const qvac = require('@qvac/sdk');
const PQueue = require('p-queue').default;
const { createProvider } = require('./hyperswarm-bridge');
const { spawn } = require('child_process');
const fs = require('fs');
const PROFILE_LOG = '/home/xbt/med-scribe/qvac-logs/inference.json';
fs.mkdirSync('/home/xbt/med-scribe/qvac-logs', { recursive: true });

function logInference(kind, modelId, durationMs, promptLen, outputLen) {
  const entry = {
    timestamp: new Date().toISOString(),
    kind,
    modelId,
    durationMs,
    promptLen,
    outputLen,
    hardware: 'CPU only — no GPU',
    device: 'Laptop WSL2 Ubuntu'
  };
  const existing = fs.existsSync(PROFILE_LOG) ? JSON.parse(fs.readFileSync(PROFILE_LOG)) : [];
  existing.push(entry);
  fs.writeFileSync(PROFILE_LOG, JSON.stringify(existing, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('/home/xbt/med-scribe'));

const llmQueue = new PQueue({ concurrency: 1 });
const sttQueue = new PQueue({ concurrency: 1 });

let medgemmaId = null;
let whisperId = null;
let embeddingModelId = null;

function convertToWav(inputBuffer) {
  return new Promise((resolve, reject) => {
    if (!inputBuffer || inputBuffer.length === 0) {
      return reject(new Error('Input audio buffer is empty'));
    }

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'wav',
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ]);

    const chunks = [];
    const errorChunks = [];

    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (chunk) => {
      errorChunks.push(chunk);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const errorMsg = Buffer.concat(errorChunks).toString();
        reject(new Error(`ffmpeg exited with code ${code}: ${errorMsg}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    ffmpeg.stdin.on('error', (err) => {
      console.error('ffmpeg stdin error:', err);
    });

    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}

async function getTranscodedAudio(base64Audio) {
  let buffer = Buffer.from(base64Audio, 'base64');
  try {
    console.log('Transcoding audio using ffmpeg...');
    buffer = await convertToWav(buffer);
    console.log('Transcoding successful, new size:', buffer.length);
  } catch (transcodeError) {
    console.error('Transcoding failed, passing raw buffer:', transcodeError);
  }
  return buffer;
}

async function getTranscodedAudioBuffer(inputBuffer) {
  let buffer = inputBuffer;
  try {
    console.log('Transcoding audio using ffmpeg...');
    buffer = await convertToWav(buffer);
    console.log('Transcoding successful, new size:', buffer.length);
  } catch (transcodeError) {
    console.error('Transcoding failed, passing raw buffer:', transcodeError);
  }
  return buffer;
}

const truncate = (str, n) => str.length > n ? str.slice(0, n) + '...' : str;

async function complete(prompt) {
  const start = Date.now();
  const result = await qvac.completion({
    modelId: medgemmaId,
    history: [{ role: 'user', content: prompt }]
  });
  const text = await result.text;
  logInference('completion', medgemmaId, Date.now() - start, prompt.length, text.length);
  return text;
}

function runRuleBasedAudit(soap, extracted, patientName = '') {
  const missing_fields = [];
  const recommendations = [];
  let score = 100;

  // 1. Check patient identity info
  if (!patientName || patientName.trim().length === 0) {
    missing_fields.push("Patient Name");
    score -= 15;
    recommendations.push("Document the patient's name for proper medical record matching.");
  }

  // 2. Check Date (is there a date-like pattern in the SOAP note?)
  const dateRegex = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?(?:,)? \d{4}\b/i;
  if (!dateRegex.test(soap)) {
    missing_fields.push("Encounter Date");
    score -= 15;
    recommendations.push("Include the current date in the documentation headers.");
  }

  // 3. Check SOAP sections in the text
  const cleanSoap = soap.toLowerCase();
  
  if (!cleanSoap.includes("subjective") && !/\b(s|subj)\b\s*:/i.test(soap)) {
    missing_fields.push("Subjective (S) Notes");
    score -= 20;
    recommendations.push("Document the patient's chief complaint and history of present illness.");
  }
  
  if (!cleanSoap.includes("objective") && !/\b(o|obj)\b\s*:/i.test(soap)) {
    missing_fields.push("Objective (O) / Exam Findings");
    score -= 20;
    recommendations.push("Document the physical exam findings or vital signs observed.");
  } else if (!extracted || !extracted.vitals || extracted.vitals.length === 0) {
    missing_fields.push("Vitals (Objective)");
    score -= 10;
    recommendations.push("Ensure patient vital signs (BP, Temp, HR) are recorded.");
  }

  if (!cleanSoap.includes("assessment") && !/\b(a|assess)\b\s*:/i.test(soap)) {
    missing_fields.push("Assessment (A) / Diagnosis");
    score -= 20;
    recommendations.push("Provide a clinical impression, differential, or finalized diagnosis.");
  }

  if (!cleanSoap.includes("plan") && !/\b(p|plan)\b\s*:/i.test(soap)) {
    missing_fields.push("Clinical Plan (P)");
    score -= 20;
    recommendations.push("Detail the treatment plan, prescriptions, and follow-up timeline.");
  }

  return {
    score: Math.max(0, score),
    missing_fields,
    recommendations
  };
}

async function runPipeline(transcript, patientId = null, patientName = null) {
  let historicalContext = '';
  if (patientId && embeddingModelId) {
    try {
      console.log(`Searching RAG clinical history for patientId: ${patientId}`);
      const searchResult = await qvac.ragSearch({
        modelId: embeddingModelId,
        query: `Patient ${patientId}`,
        topK: 3,
        workspace: "med-scribe-clinical-history"
      });
      if (searchResult && searchResult.length > 0) {
        // Only use the most recent 1 match, not all matches
        historicalContext = searchResult[0].content;
        console.log(`Retrieved RAG context:\n${historicalContext}`);
      } else {
        console.log('No historical context found in RAG.');
      }
    } catch (e) {
      console.error('RAG search during pipeline failed:', e);
    }
  }

  const systemPrompt = `You are a precise clinical AI assistant compiling a patient visit.
Analyze the patient encounter transcript. 
First, generate a structured, professional SOAP Note. Do NOT include any introductory or conversational text like "Here is your note" - start directly with the SOAP content.
Second, extract all medical entities into categories (symptoms, medications, vitals, allergies, history).

You MUST return your response strictly as a valid JSON object matching this structure (no markdown formatting outside of JSON):
{
  "soap": "Subjective:\\n[symptoms, patient description]\\n\\nObjective:\\n[vitals, exam details]\\n\\nAssessment:\\n[diagnosis, clinical impression]\\n\\nPlan:\\n[treatment plan, follow up]",
  "extracted": {
    "symptoms": ["list", "of", "symptoms", "found"],
    "medications": ["list", "of", "medications", "found"],
    "vitals": ["list", "of", "vitals", "found"],
    "allergies": ["list", "of", "allergies", "found"],
    "history": ["list", "of", "history", "details", "found"]
  }
}`;

  let userPrompt = `Current encounter transcript:\n"${truncate(transcript, 800)}"`;
  if (historicalContext) {
    userPrompt = `Historical clinical history for this patient:\n"${truncate(historicalContext, 400)}"\n\nCurrent encounter transcript:\n"${truncate(transcript, 800)}"`;
  }

  console.log("Starting combined SOAP note & entity extraction inference call...");
  const combinedOutput = await complete(`${systemPrompt}\n\n${userPrompt}`);
  console.log("Combined inference call complete.");

  let soap = '';
  let extObj = { symptoms: [], medications: [], vitals: [], allergies: [], history: [] };

  try {
    const cleanJson = combinedOutput.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    soap = parsed.soap || '';
    if (parsed.extracted) {
      extObj = parsed.extracted;
    }
  } catch (parseErr) {
    console.error("Failed to parse combined JSON output, trying simple text fallback:", parseErr);
    soap = combinedOutput;
    
    // Simple text extraction heuristics as fallback
    const symptomsMatch = combinedOutput.match(/symptoms?\s*:\s*([^]*?)(?=\n\n|\n[A-Z]|$)/i);
    if (symptomsMatch) extObj.symptoms = symptomsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  // Run the programmatic, instant completeness audit (replaces the slow third LLM call!)
  console.log("Executing programmatic completeness audit...");
  const auditResult = runRuleBasedAudit(soap, extObj, patientName);
  console.log(`Encounter Audit Score: ${auditResult.score}/100`);

  const extracted = JSON.stringify(extObj);
  const audit = JSON.stringify(auditResult);

  if (patientId && embeddingModelId && soap) {
    (async () => {
      try {
        console.log(`Ingesting SOAP note to RAG for patientId: ${patientId}`);
        const cleanSoap = soap.replace(/```json|```/g, '').trim();
        const doc = `Patient ${patientId}${patientName ? ' (' + patientName + ')' : ''}: ${cleanSoap}`;
        await qvac.ragIngest({
          modelId: embeddingModelId,
          documents: [doc],
          workspace: "med-scribe-clinical-history"
        });
        console.log(`Successfully ingested SOAP note to RAG for patientId: ${patientId}`);
      } catch (e) {
        console.error('Background SOAP ingestion to RAG failed:', e);
      }
    })();
  }

  return { extracted, soap, audit, historicalContext };
}

async function init() {
  await qvac.startQVACProvider();

  medgemmaId = await qvac.loadModel({
    modelSrc: qvac.MEDGEMMA_4B_IT_Q4_1.src,
    modelType: 'llamacpp-completion'
  });
  console.log('MedGemma loaded:', medgemmaId);

  whisperId = await qvac.loadModel({
    modelSrc: qvac.WHISPER_EN_SMALL_Q8_0.src,
    modelType: 'whispercpp-transcription'
  });
  console.log('Whisper loaded:', whisperId);

  try {
    console.log('Loading EmbeddingGemma model...');
    embeddingModelId = await qvac.loadModel({
      modelSrc: qvac.EMBEDDINGGEMMA_300M_Q4_0.src,
      modelType: 'llamacpp-embedding'
    });
    console.log('EmbeddingGemma loaded:', embeddingModelId);
  } catch (err) {
    console.error('Failed to load EmbeddingGemma model:', err);
  }

  await createProvider(async (msg) => {
    if (msg.type === 'transcribe') {
      const buffer = await getTranscodedAudio(msg.audio);
      const transcript = await qvac.transcribe({ modelId: whisperId, audioChunk: buffer });
      return { type: 'transcript', transcript };
    }
    if (msg.type === 'audit') {
      const result = await runPipeline(msg.transcript, msg.patientId);
      return { type: 'result', ...result };
    }
    return { type: 'error', error: 'unknown message type' };
  });
}

app.post('/transcribe', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  
  if (contentType.includes('application/octet-stream')) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      sttQueue.add(async () => {
        try {
          let buffer = Buffer.concat(chunks);
          buffer = await getTranscodedAudioBuffer(buffer);
          const start = Date.now();
          const result = await qvac.transcribe({ modelId: whisperId, audioChunk: buffer });
          logInference('transcription', whisperId, Date.now() - start, buffer.length, result.length);
          res.json({ transcript: result });
        } catch (e) {
          console.error("STT stream processing error:", e);
          res.status(500).json({ error: e.message });
        }
      });
    });
    req.on('error', (err) => {
      res.status(500).json({ error: "Stream read error: " + err.message });
    });
  } else {
    const { audio } = req.body;
    if (!audio) return res.status(400).json({ error: 'audio (base64) required' });

    sttQueue.add(async () => {
      try {
        const buffer = await getTranscodedAudio(audio);
        const start = Date.now();
        const result = await qvac.transcribe({ modelId: whisperId, audioChunk: buffer });
        logInference('transcription', whisperId, Date.now() - start, buffer.length, result.length);
        res.json({ transcript: result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }
});

app.post('/audit', async (req, res) => {
  const { transcript, patientId, patientName } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  llmQueue.add(async () => {
    try {
      const result = await runPipeline(transcript, patientId, patientName);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/ingest', async (req, res) => {
  const { patientId, note } = req.body;
  if (!patientId || !note) {
    return res.status(400).json({ error: 'patientId and note required' });
  }
  try {
    const doc = `Patient ${patientId}: ${note}`;
    const ingestResult = await qvac.ragIngest({
      modelId: embeddingModelId,
      documents: [doc],
      workspace: "med-scribe-clinical-history"
    });
    res.json({ success: true, result: ingestResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rag-search', async (req, res) => {
  const { patientId } = req.body;
  if (!patientId) {
    return res.status(400).json({ error: 'patientId required' });
  }
  try {
    const searchResult = await qvac.ragSearch({
      modelId: embeddingModelId,
      query: `Patient ${patientId}`,
      topK: 3,
      workspace: "med-scribe-clinical-history"
    });
    res.json({ results: searchResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/extract', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  llmQueue.add(async () => {
    try {
      const extracted = await complete(`Extract all medical entities from this transcript. Return JSON only with fields: symptoms, medications, vitals, allergies, history. Transcript: "${truncate(transcript, 600)}"`);
      res.json({ extracted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/soap', async (req, res) => {
  const { extracted } = req.body;
  if (!extracted) return res.status(400).json({ error: 'extracted entities required' });

  llmQueue.add(async () => {
    try {
      const soap = await complete(`Using these medical entities, generate a structured SOAP note. Be concise. Entities: ${truncate(extracted, 800)}`);
      res.json({ soap });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/audit-only', async (req, res) => {
  const { soap } = req.body;
  if (!soap) return res.status(400).json({ error: 'soap note required' });

  llmQueue.add(async () => {
    try {
      const audit = await complete(`Review this SOAP note. Return JSON only with: score (0-100), missing_fields (array), recommendations (array). SOAP note: ${truncate(soap, 1200)}`);
      res.json({ audit });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/differentials', async (req, res) => {
  const { soap } = req.body;
  if (!soap) return res.status(400).json({ error: 'soap note required' });

  llmQueue.add(async () => {
    try {
      const differentials = await complete(`Based on this SOAP note, suggest 3 potential differential diagnoses with brief reasoning (1-2 sentences each). Present them strictly as clinical prompts for the doctor's review. SOAP note: ${truncate(soap, 1200)}`);
      res.json({ differentials });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post('/differentials/questions', async (req, res) => {
  const { soap, diagnosis } = req.body;
  if (!soap || !diagnosis) return res.status(400).json({ error: 'soap and diagnosis required' });

  llmQueue.add(async () => {
    try {
      const prompt = `Based on this SOAP note, generate 3 specific, high-yield follow-up questions the doctor should ask the patient to rule out or confirm the diagnosis: "${diagnosis}". SOAP note: ${truncate(soap, 1000)}`;
      const questions = await complete(prompt);
      res.json({ questions });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', medgemmaId, whisperId }));

app.get('/metrics', (_, res) => {
  if (fs.existsSync(PROFILE_LOG)) {
    try {
      const data = fs.readFileSync(PROFILE_LOG, 'utf8');
      res.json(JSON.parse(data));
    } catch (e) {
      console.error("Error reading metrics:", e);
      res.json([]);
    }
  } else {
    res.json([]);
  }
});

init().then(() => {
  const sslOptions = {
    key: fs.readFileSync('/home/xbt/med-scribe/ssl/key.pem'),
    cert: fs.readFileSync('/home/xbt/med-scribe/ssl/cert.pem')
  };
  const server = https.createServer(sslOptions, app).listen(3001, () => {
    console.log('Secure HTTPS server running on :3001');
  });
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
});
