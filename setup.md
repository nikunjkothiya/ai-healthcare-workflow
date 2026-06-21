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

All large AI model files live in the `models/` directory.

Model assets are not committed to git in this project. Only `README.md` files are tracked under `models/`.

> **Note:** OpenRouter is the only LLM provider for this setup.
> The only local model files needed are for Whisper STT. Kokoro TTS runs natively in its Docker image, and VAD is handled inside the LiveKit agent container.

> **IMPORTANT — Automated Setup:**
> The `.env` file uses **container paths** (inside Docker). Local host directories are mapped into container directories on startup:
>
> | Host Directory      | Container Mount Point |       Used By     |
> |---------------------|-----------------------|-------------------|
> | `./models/whisper/` |   `/models/whisper/`  | Whisper container |
>
> **Automatic Setup**: Our startup environment **automatically checks and downloads** the default Whisper GGML model (`ggml-small.en-q5_1.bin`) on its first run if it is missing on the host. This means you do NOT need to perform any manual download steps.

### A. Whisper (Speech-to-Text)

See: [`models/whisper/README.md`](./models/whisper/README.md)

On startup, if the model file is not found at `models/whisper/ggml-small.en-q5_1.bin`, the `./start.sh` script or the `whisper` Docker container will download it automatically. You can also manually download it if preferred:
```bash
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin \
  -O models/whisper/ggml-small.en-q5_1.bin
```

Verify `.env` has: `WHISPER_MODEL_PATH=/models/whisper/ggml-small.en-q5_1.bin`

### B. Kokoro TTS (Text-to-Speech)

Kokoro is the default low-hardware TTS provider. Verify `.env` has:
```bash
KOKORO_HOST=kokoro
KOKORO_PORT=8880
KOKORO_VOICE=af_bella
KOKORO_LANG=en-us
```

Docker pulls the pinned public CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2`. No manual model files are required.

### C. LLM — OpenRouter API (Primary, Default)

Set in `.env`:
```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_real_openrouter_key_here
OPENROUTER_MODEL=google/gemma-4-31b-it:free
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=Care Outreach Assistant
```

No local LLM model files needed — all LLM inference runs via OpenRouter's OpenAI-compatible chat completions API. The default routes requests to available free model variants.
`OPENROUTER_HTTP_REFERER` is an OpenRouter attribution header, not a backend routing URL. Keep `http://localhost:3000` for local Docker, and use your deployed frontend URL in production.
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

You should see 9 containers: `healthcare_frontend`, `healthcare_backend`, `healthcare_worker`, `healthcare_db`, `healthcare_redis`, `healthcare_whisper`, `healthcare_kokoro`, `healthcare_livekit`, and `healthcare_livekit_agent` — all `Up (healthy)`.

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
AI-CallerAI-Healthcare-Workflow/
|-- models/                    # AI model files (mounted into containers)
|   |-- whisper/               # Whisper GGML models -> mounted at /models/whisper/
|   |   |-- ggml-small.en-q5_1.bin
|   |   `-- README.md
|   `-- README.md
|-- ai/whisper/Dockerfile      # Whisper container build file
|-- livekit-agent/             # Python LiveKit WebRTC Voice Agent
|-- livekit.yaml               # LiveKit local server configuration
|-- backend/                   # Express API + orchestrator
|-- worker/                    # BullMQ job processor
|-- frontend/                  # Vue 3 dashboard
|-- .env                       # Environment variables (container paths)
|-- .env.example               # Sample Environment variables with default values
|-- docker-compose.yml         # Service definitions
`-- setup.md                   # This file
```
