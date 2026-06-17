# Med-Scribe

> Fully offline, transport-secured clinical documentation tool with on-device Patient History RAG, powered by local AI agents.

A doctor records a patient encounter on their phone. The audio is transcribed locally via Whisper, sent peer-to-peer over Hyperswarm DHT to a laptop, matched against matching local patient histories via `EmbeddingGemma`, processed through a three-agent MedGemma 4B SOAP pipeline, and returned as a secure, structured SOAP note — with differential diagnoses — in under two minutes. 

Zero cloud. Zero internet. Fully HIPAA-compliant transit. Zero data leaves the clinic.

---

## What it does

1. **Patient Identifier Capture**: Doctor inputs a Patient ID and Name.
2. **On-Device History RAG**: Server queries the local vector database (`EmbeddingGemma`) for past notes matching the Patient ID. The client displays a history timeline of past visits in a dedicated tab for quick reference.
3. **Audio Capture**: Doctor records the encounter. Raw binary streams are sent to prevent base64 memory spikes.
4. **Local Transcription**: Whisper EN Small transcribes the encounter on the local WSL2 server.
5. **Prompt Augmentation**: Historical records retrieved via RAG are dynamically injected as context into the SOAP prompt.
6. **Agentic Documentation & Auditing Pipeline**:
   - **SOAP Note & Entity Extraction Agent** — A single-stage MedGemma 4B completion call that generates the structured clinical SOAP Note and extracts key medical entity arrays (symptoms, medications, vitals, allergies, history) in one pass, reducing LLM cold-starts.
   - **Quality Auditor** — A programmatic checklist validator that parses the generated SOAP note and extracted entities to score documentation completeness (0-100), identify omissions (like missing patient details or vitals), and provide guidelines.
   - **Differential Diagnoses Agent** — A secondary MedGemma 4B call that evaluates the SOAP Note and suggests three clinical differentials for review.
   - **Follow-Up Questions Agent** — An interactive sub-agent that triggers on-click to generate 3 high-yield questions the clinician can ask to confirm or rule out a selected differential diagnosis.
7. **Background Auto-Ingestion**: The completed SOAP note is automatically indexed back into the RAG database for future visits.

All inference runs locally via `@qvac/sdk`. No API calls leave the device pair.

---

## Hardware & Architecture

| Device | Role | Specs |
|--------|------|-------|
| Phone (browser) | Edge node — secure audio capture + UI | Any modern phone with Chrome/Safari |
| Laptop (WSL2) | Provider node — STT + RAG + LLM inference | 16GB RAM, CPU only (no GPU) |

### Protocol Diagram
```
Phone (Secure Browser Context)
  │
  │  HTTPS POST (binary wav blob) + patientId
  │
  ▼
POST /audit ──────────────────────────► Laptop (HTTPS WSL2 :3001)
                                            │
                                        Whisper STT
                                            │
                                     EmbeddingGemma (RAG)
                                            │
                                     MedGemma SOAP Pipeline
                                            │
                                     Auto-ingestion to RAG
                                            │
RAG Context + SOAP + Differentials ◄────────┘
```

---

## Stack & Local Models

### The Stack
- `@qvac/sdk` — Whisper, MedGemma, and EmbeddingGemma inference.
- `https` — Native SSL transport (solves browser secure context constraints for mobile mic access).
- `hyperswarm` — P2P DHT peer discovery and raw delegation.
- `express` & `p-queue` — Local HTTP server & task scheduling.
- Vanilla HTML/CSS/JS — Styled under the **Ease Health** token system (Linen White `#fffefc`, Forest Ink `#0f3e17`, Mist Blue `#b6ced5`, weights 300 & 400 only, zero drop shadows).

### Models Used

| Model | Purpose | Size |
|-------|---------|------|
| `MEDGEMMA_4B_IT_Q4_1` | SOAP Note generation, completeness audit, differentials | 2.5GB |
| `WHISPER_EN_SMALL_Q8_0` | Local speech-to-text | 264MB |
| `EMBEDDINGGEMMA_300M_Q4_0`| Local patient history RAG indexing and search | 277MB |

---

## Quickstart

### Prerequisites
- Node.js 22+
- WSL2 (Ubuntu) or native Linux
- `ffmpeg` installed in WSL2 (`sudo apt install ffmpeg`)
- Both devices connected to the same local WiFi network

### 1. Clone and Install
```bash
git clone https://github.com/danielamodu/med-scribe
cd med-scribe
npm install
```

### 2. Generate SSL Certificates (for HTTPS)
Generate self-signed certificates in the repo directory:
```bash
mkdir -p ssl && openssl req -nodes -new -x509 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -subj "/CN=localhost"
```

### 3. Register WSL2 Port Forwarding
Run `setup-wsl-network.ps1` as Administrator in Windows PowerShell to map external requests to WSL2:
```powershell
.\setup-wsl-network.ps1
```

### 4. Run Server
```bash
node server.js
```
Wait for `Secure HTTPS server running on :3001`. (First run downloads model weight files; subsequent runs load from cache).

### 5. Access and Record
1. Find your Windows WiFi IP.
2. Open on your phone: `https://<YOUR_IP>:3001/index.html`.
3. Accept the self-signed SSL warning (Advanced → Proceed).
4. input a **Patient ID** (e.g. `101`), tap record, record an encounter, and tap stop.
5. Record a second encounter with the same **Patient ID** to see RAG matching history loaded and displayed!

---

## Verification

Run local test suites to verify offline integrity and Zero-Knowledge RAG execution:

```bash
# Verify model pipeline endpoints without external requests
node verify-pipeline.js

# Verify the HTTPS and EmbeddingGemma RAG endpoints directly
node verify-rag.js
```

---

## API Reference

| Endpoint | Method | Body Payload | Returns |
|----------|--------|--------------|---------|
| `/transcribe` | POST | raw binary body | `{ transcript }` |
| `/ingest` | POST | `{ patientId, note }` | `{ success, result }` |
| `/rag-search` | POST | `{ patientId }` | `{ results }` |
| `/audit` | POST | `{ transcript, patientId, patientName }` | `{ extracted, soap, audit, historicalContext }` |
| `/differentials`| POST | `{ soap }` | `{ differentials }` |
| `/health` | GET | — | `{ status, medgemmaId, whisperId }` |

---

## Hackathon Targets

- **General Purpose**: Local peer-discovery DHT delegation + multi-agent CPU inference pipeline.
- **Our Psy Models**: MedGemma 4B integration for SOAP compilation, audit reviews, and diagnosis suggestion.
- **Local-first / Privacy**: Secure HTTPS transit and zero-knowledge vector indexing on-device.

---

Built by [@fortyxbt](https://twitter.com/fortyxbt) for QVAC Hackathon I — Unleash Edge AI (June 2026). License: MIT.
