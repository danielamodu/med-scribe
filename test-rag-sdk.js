const qvac = require('@qvac/sdk');

async function main() {
  console.log("Starting QVAC provider...");
  await qvac.startQVACProvider();

  console.log("Loading EMBEDDINGGEMMA model...");
  const embedModelId = await qvac.loadModel({
    modelSrc: qvac.EMBEDDINGGEMMA_300M_Q4_0.src,
    modelType: 'embeddings'
  });
  console.log("Embedding model loaded successfully. ID:", embedModelId);

  const workspace = "test-clinical-history";

  console.log("Ingesting test patient history documents...");
  const ingestResult = await qvac.ragIngest({
    modelId: embedModelId,
    documents: [
      "Patient John Doe (ID: 101) has a history of severe asthma diagnosed in 2018. Prescribed albuterol inhaler.",
      "Patient John Doe (ID: 101) visited in Jan 2025 for mild pneumonia. Treated successfully with amoxicillin.",
      "Patient Jane Smith (ID: 102) has a history of type 2 diabetes and hypertension. Prescribed metformin."
    ],
    workspace
  });
  console.log("Ingestion result:", ingestResult);

  console.log("\nSearching history for John Doe...");
  const searchResult1 = await qvac.ragSearch({
    modelId: embedModelId,
    query: "John Doe clinical history and past respiratory issues",
    topK: 2,
    workspace
  });
  console.log("Search results for John Doe:", searchResult1);

  console.log("\nCleaning up workspace...");
  await qvac.ragCloseWorkspace({ workspace, deleteOnClose: true });
  console.log("Done.");
}

main().catch(console.error);
