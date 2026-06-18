# Project Setup & Developer Guide

Welcome to the AI-Caller-Healthcare project! This guide covers everything a new developer needs to set up the application, configure AI models, and manage Docker containers.

---

## 1. Prerequisites

Install these on your development machine:

- **Docker & Docker Compose** (Engine 20.10+ / Compose 2.0+)
- **Git**
- **System Requirements**:
  - 16GB RAM minimum
  - 15GB free disk space (Docker images + AI models)

---

## 2. Clone & Configure

```bash
git clone <repository_url>
cd AI-Caller-Healthcare
cp .env.example .env
```

Review `.env` and adjust if needed. The defaults work out-of-the-box.

---

## 3. Setting Up AI Models

All large AI model files live in the `models/` directory. Each subfolder has its own README with detailed instructions.

Model assets are not committed to git in this project.
Only `README.md` files are tracked under `models/`, so each user must place model files locally in the correct folders.

> **Note:** OpenRouter is the only LLM provider for this setup.
> Only the Whisper and Silero VAD local model files are required; Kokoro TTS runs from its Docker image.

> **IMPORTANT — Host vs Container paths:**
> The `.env` file uses **container paths** (inside Docker), not host paths.
> Docker mounts transform your local directories into container paths:
>
> | Host Directory      | Container Mount Point |       Used By     |
> |---------------------|-----------------------|-------------------|
> | `./models/whisper/` |   `/models/whisper/`  | Whisper container |
> | `./models/vad/`     |   `/models/vad/`      | Backend/worker    |
>
> So `WHISPER_MODEL_PATH=/models/whisper/ggml-small.en-q5_1.bin` in `.env` maps to `./models/whisper/ggml-small.en-q5_1.bin` on your machine.

### A. Whisper (Speech-to-Text)

See: [`models/whisper/README.md`](./models/whisper/README.md)

```bash
# Download the recommended low-hardware model (~181MB)
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin \
  -O models/whisper/ggml-small.en-q5_1.bin
```

Verify `.env` has: `WHISPER_MODEL_PATH=/models/whisper/ggml-small.en-q5_1.bin`

### A1. Silero VAD Model

See: [`models/vad/README.md`](./models/vad/README.md)

```bash
wget https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad_op18_ifless.onnx \
  -O models/vad/silero_vad_op18_ifless.onnx
```

Verify `.env` has: `VAD_MODEL_PATH=/models/vad/silero_vad_op18_ifless.onnx`

### B. Kokoro TTS (Text-to-Speech)

Kokoro is the default low-hardware TTS provider. Verify `.env` has:
```bash
KOKORO_HOST=kokoro
KOKORO_PORT=8880
KOKORO_VOICE=af_bella
KOKORO_LANG=en-us
```

Docker pulls the pinned public CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2`.

### C. LLM — OpenRouter API (Primary, Default)

Set in `.env`:
```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_real_openrouter_key_here
OPENROUTER_MODEL=openrouter/free
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=Care Outreach Assistant
```

No local LLM model files needed — all LLM inference runs via OpenRouter's OpenAI-compatible chat completions API. The default `openrouter/free` slug routes requests to currently available free model variants.
`OPENROUTER_HTTP_REFERER` is an OpenRouter attribution header, not a backend routing URL. Keep `http://localhost:3000` for local Docker, and use your deployed frontend URL in production.
For healthcare validation, test and pin an explicit `:free` model when possible because `openrouter/free` is a no-cost router, not a fixed model.
Get your API key from [OpenRouter](https://openrouter.ai/keys).

---

## 4. First-Time Start

```bash
docker compose up -d --build
```

Wait for all containers to be healthy:
```bash
docker ps
```

You should see 7 containers: `frontend`, `backend`, `worker`, `postgres`, `redis`, `whisper`, `tts` — all `Up (healthy)`.

- **Dashboard**: [http://localhost:3000](http://localhost:3000)
- **API**: [http://localhost:4000](http://localhost:4000)

**Default Logins:**
- Product Admin: `productadmin@healthcare.com` / `admin123`
- Hospital Admin: `admin@demo.com` / `admin123`

---

## 5. Development Workflow

### You changed backend/worker/frontend code
```bash
# Rebuild only affected container(s)
docker compose build backend worker
docker compose up -d backend worker

# If changes aren't appearing (Docker cache), force no-cache:
docker compose build --no-cache backend
docker compose up -d backend
```

### You changed `.env` or `docker-compose.yml`
```bash
# Recreate containers (no rebuild needed)
docker compose up -d
```

### You swapped a local STT/TTS model file
```bash
# Models are mounted volumes — just restart the service
docker compose restart whisper    # After changing whisper model
docker compose restart tts        # After changing TTS model
```

### Full rebuild from scratch
```bash
docker compose down -v --remove-orphans
docker compose build --no-cache
docker compose up -d
```

---

## 6. Checking Logs

```bash
# Backend (API, WebSocket, LLM calls)
docker logs -f healthcare_backend

# Worker (call job processing)
docker logs -f healthcare_worker

# Whisper (STT inference)
docker logs -f healthcare_whisper

# TTS (voice synthesis)
docker logs -f healthcare_kokoro
```

---

## 7. Verification

```bash
# Automated system test (simulation mode)
./verify.sh

# Live WebSocket test (requires manual call acceptance)
VERIFY_CALL_MODE=websocket ./verify.sh
```

---

## 8. Project Structure (Key Directories)

```text
AI-Caller-Healthcare/
|-- models/                    # AI model files (mounted into containers)
|   |-- whisper/               # Whisper GGML models -> mounted at /models/whisper/
|   |   |-- ggml-small.en-q5_1.bin
|   |   `-- README.md
|   |-- vad/                   # Silero VAD ONNX model -> mounted at /models/vad/
|   |   |-- silero_vad_op18_ifless.onnx
|   |   `-- README.md
|   `-- README.md
|-- ai/whisper/Dockerfile      # Whisper container build file
|-- backend/                   # Express API + orchestrator
|-- worker/                    # BullMQ job processor
|-- frontend/                  # Vue 3 dashboard
|-- .env                       # Environment variables (container paths)
|-- .env.example               # Sample Environment variables with default values
|-- docker-compose.yml         # Service definitions
`-- setup.md                   # This file
```
