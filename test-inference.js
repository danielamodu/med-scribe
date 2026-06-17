const qvac = require('@qvac/sdk');

async function main() {
  await qvac.startQVACProvider();
  await qvac.loadModel({
    modelSrc: qvac.MEDGEMMA_4B_IT_Q4_1.src,
    modelType: 'llamacpp-completion'
  });
  const result = await qvac.completion({
    modelId: '2dd0f7376d4a2348',
    history: [{ role: 'user', content: 'Patient presents with fever and headache. Generate a brief SOAP note.' }]
  });
  const text = await result.text;
  console.log(text);
}

main().catch(console.error);
