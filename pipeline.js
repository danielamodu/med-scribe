const qvac = require('@qvac/sdk');

async function complete(modelId, prompt) {
  const result = await qvac.completion({
    modelId,
    history: [{ role: 'user', content: prompt }]
  });
  return await result.text;
}

async function runPipeline(transcript) {
  await qvac.startQVACProvider();
  
  const modelId = await qvac.loadModel({
    modelSrc: qvac.MEDGEMMA_4B_IT_Q4_1.src,
    modelType: 'llamacpp-completion'
  });

  console.log('Agent 1: Extracting entities...');
  const extracted = await complete(modelId, `
    Extract all medical entities from this transcript. Return JSON only with fields:
    symptoms, medications, vitals, allergies, history.
    Transcript: "${transcript}"
  `);
  console.log('Extracted:', extracted);

  console.log('Agent 2: Formatting SOAP note...');
  const soap = await complete(modelId, `
    Using these medical entities, generate a structured SOAP note.
    Entities: ${extracted}
  `);
  console.log('SOAP:', soap);

  console.log('Agent 3: Auditing completeness...');
  const audit = await complete(modelId, `
    Review this SOAP note for completeness. Return JSON with:
    score (0-100), missing_fields (array), recommendations (array).
    SOAP note: ${soap}
  `);
  console.log('Audit:', audit);

  return { extracted, soap, audit };
}

runPipeline("Patient is a 45 year old male presenting with fever of 101.5F, severe headache for 2 days, taking ibuprofen 400mg with no relief, no known allergies.")
  .then(r => console.log('Pipeline complete'))
  .catch(console.error);
