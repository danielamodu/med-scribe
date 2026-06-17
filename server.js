const express = require('express');
const cors = require('cors');
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

async function runPipeline(transcript) {
  const extracted = await complete(`Extract all medical entities from this transcript. Return JSON only with fields: symptoms, medications, vitals, allergies, history. Transcript: "${truncate(transcript, 600)}"`);
  const soap = await complete(`Using these medical entities, generate a structured SOAP note. Be concise. Entities: ${truncate(extracted, 800)}`);
  const audit = await complete(`Review this SOAP note. Return JSON only with: score (0-100), missing_fields (array), recommendations (array). SOAP note: ${truncate(soap, 1200)}`);
  return { extracted, soap, audit };
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

  await createProvider(async (msg) => {
    if (msg.type === 'transcribe') {
      const buffer = await getTranscodedAudio(msg.audio);
      const transcript = await qvac.transcribe({ modelId: whisperId, audioChunk: buffer });
      return { type: 'transcript', transcript };
    }
    if (msg.type === 'audit') {
      const result = await runPipeline(msg.transcript);
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
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  llmQueue.add(async () => {
    try {
      const result = await runPipeline(transcript);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
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

app.get('/health', (_, res) => res.json({ status: 'ok', medgemmaId, whisperId }));

init().then(() => {
  const server = app.listen(3001, () => console.log('Server running on :3001'));
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
});
