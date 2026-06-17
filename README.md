# Med-Scribe

> Fully offline, two-device clinical documentation tool powered by local AI agents.

A doctor records a patient encounter on their phone. The audio is transcribed locally via Whisper, sent peer-to-peer over Hyperswarm DHT to a laptop, processed through a three-agent MedGemma 4B pipeline, and returned as a verified SOAP note — with differential diagnoses — in under two minutes. Zero cloud. Zero internet. Zero data leaves the clinic.

---

## What it does

1. Doctor taps record on their phone browser
2. Audio captured via MediaRecorder, streamed to the laptop provider node
3. Whisper EN Small transcribes the audio locally on the laptop
4. Three sequential MedGemma 4B agents run:
   - **Extractor** — pulls symptoms, medications, vitals, allergies, history from the transcript
   - **Formatter** — structures entities into a SOAP note
   - **Auditor** — scores completeness (0–100) and flags missing fields
5. A fourth agent generates three differential diagnoses with clinical reasoning
6. Structured SOAP note + score + differentials returned to the phone UI

All inference runs via `@qvac/sdk`. No API calls leave the device pair.

---

## Hardware

| Device | Role | Specs |
|--------|------|-------|
| Android phone | Edge node — audio capture + UI | Any modern Android with Chrome |
| Laptop (WSL2) | Provider node — STT + LLM inference | 16GB RAM, CPU only (no GPU) |

Both devices on the same local network. Internet not required after initial model download.

---

## Stack

- `@qvac/sdk` — all inference (Whisper + MedGemma)
- `hyperswarm` — P2P DHT peer discovery and delegation
- `express` — local HTTP server on WSL2
- `p-queue` — concurrency control for sequential CPU inference
- Vanilla HTML/CSS/JS — phone UI, no framework, no build step

### Models used

| Model | Purpose | Size |
|-------|---------|------|
| `MEDGEMMA_4B_IT_Q4_1` | Clinical entity extraction, SOAP formatting, audit, differentials | 2.5GB |
| `WHISPER_EN_SMALL_Q8_0` | Speech-to-text transcription | 264MB |

---

## Architecture

```
Phone (browser)
  │
  │  MediaRecorder → base64 audio
  │
  ▼
POST /transcribe ──────────────────────► Laptop (WSL2 :3001)
                                              │
                                         Whisper STT
                                              │
                                         transcript
                                              │
POST /audit ◄──────────────────────────      │
  │                                      Agent 1: Extractor
  │                                      Agent 2: Formatter  
  │                                      Agent 3: Auditor
  │                                      Agent 4: Differentials
  │
  ▼
Phone UI renders SOAP note + score + differentials

Hyperswarm DHT announces provider on topic: med-scribe-v1
```

---

## Quickstart

### Prerequisites

- Node.js 22+
- WSL2 (Ubuntu) on Windows, or native Linux
- `ffmpeg` installed in WSL2: `sudo apt install ffmpeg`
- Both devices on the same WiFi network

### 1. Clone and install

```bash
git clone https://github.com/danielamodu/med-scribe
cd med-scribe
npm install
```

### 2. Windows port forwarding (WSL2 only)

Run `setup-wsl-network.ps1` as Administrator in PowerShell. This creates the port proxy and firewall rule so your phone can reach the WSL2 server.

```powershell
.\setup-wsl-network.ps1
```

### 3. Start the server

```bash
node server.js
```

Wait for:
```
MedGemma loaded: <modelId>
Whisper loaded: <modelId>
Provider listening on DHT topic
Server running on :3001
```

First run downloads models (~2.8GB total). Subsequent runs use cache.

### 4. Open the phone UI

Find your Windows WiFi IP (`ipconfig` → Wi-Fi adapter). Open on your phone:

```
http://<YOUR_WINDOWS_IP>:3001/index.html
```

Tap record, speak a patient encounter, tap stop. SOAP note appears in ~60–90 seconds (CPU inference).

---

## Evidence Bundle

### Inference logs

Every inference call is logged to `qvac-logs/inference.json`:

```json
[
  {
    "timestamp": "2026-06-17T...",
    "kind": "transcription",
    "modelId": "98dcc532d759d1de",
    "durationMs": 18763,
    "promptLen": 264477,
    "outputLen": 187,
    "hardware": "CPU only — no GPU",
    "device": "Laptop WSL2 Ubuntu"
  },
  {
    "timestamp": "2026-06-17T...",
    "kind": "completion",
    "modelId": "2dd0f7376d4a2348",
    "durationMs": 51491,
    "promptLen": 312,
    "outputLen": 420,
    "hardware": "CPU only — no GPU",
    "device": "Laptop WSL2 Ubuntu"
  }
]
```

### Verification

```bash
# Confirm no outbound network calls during inference
node verify-pipeline.js

# Check all inference stayed local
cat qvac-logs/inference.json
```

No API keys. No `.env` file. No cloud endpoints. All inference via `@qvac/sdk`.

---

## API Reference

| Endpoint | Method | Body | Returns |
|----------|--------|------|---------|
| `/transcribe` | POST | `{ audio: base64 }` | `{ transcript: string }` |
| `/extract` | POST | `{ transcript: string }` | `{ extracted: json }` |
| `/soap` | POST | `{ extracted: string }` | `{ soap: string }` |
| `/audit-only` | POST | `{ soap: string }` | `{ score, missing_fields, recommendations }` |
| `/differentials` | POST | `{ soap: string }` | `{ differentials: string }` |
| `/audit` | POST | `{ transcript: string }` | `{ extracted, soap, audit }` |
| `/health` | GET | — | `{ status, medgemmaId, whisperId }` |

---

## Track

**General Purpose** — multi-agent orchestration + P2P delegation on consumer hardware (16GB RAM laptop + Android phone).

Also targets **Our Psy Models** — MedGemma 4B used for clinical entity extraction, SOAP formatting, completeness auditing, and differential diagnosis generation.

---

## License

MIT

---

Built by [@fortyxbt](https://twitter.com/fortyxbt) for QVAC Hackathon I — Unleash Edge AI (June 2026)
