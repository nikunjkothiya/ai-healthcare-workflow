# Project Setup & Developer Guide

Welcome to the AI-Caller-Healthcare project! This guide covers everything a new developer needs to set up the application, configure AI models, and manage Docker containers.

---

## 1. Prerequisites

Install these on your development machine:

- **Docker & Docker Compose** (Engine 20.10+ / Compose 2.0+)
- **Git**
- **Ollama** — installed natively on host (not in Docker)
  - Download: [ollama.com](https://ollama.com)
  - Must be running on `http://localhost:11434`
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

> **IMPORTANT — Host vs Container paths:**
> The `.env` file uses **container paths** (inside Docker), not host paths.
> Docker mounts transform your local directories into container paths:
>
> | Host Directory | Container Mount Point | Used By |
> |---------------|----------------------|---------|
> | `./models/whisper/` | `/models/` | Whisper container |
> | `./models/tts/` | `/root/.local/share/tts/` | TTS container |
>
> So `WHISPER_MODEL_PATH=/models/ggml-small.en.bin` in `.env` maps to `./models/whisper/ggml-small.en.bin` on your machine.

### A. Whisper (Speech-to-Text)

See: [`models/whisper/README.md`](./models/whisper/README.md)

```bash
# Download the model (~466MB)
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
  -O models/whisper/ggml-small.en.bin
```

Verify `.env` has: `WHISPER_MODEL_PATH=/models/ggml-small.en.bin`

### B. Coqui TTS (Text-to-Speech)

See: [`models/tts/README.md`](./models/tts/README.md)

If `models/tts/` is empty (first setup), get the models:
```bash
# Start TTS without mount to auto-download models
docker compose up -d tts
# Wait until healthy, then copy out
docker cp healthcare_tts:/root/.local/share/tts/. models/tts/
# Restart to use mounted files
docker compose restart tts
```

### C. Ollama (LLM)

Ollama runs on your host machine (not in Docker). Pull the required models:
```bash
ollama pull qwen2.5:3b-instruct-q4_K_M
ollama pull qwen2.5:7b-instruct-q4_K_M
```

Verify `.env` has:
```
LLM_MODEL_CHAT=qwen2.5:3b-instruct-q4_K_M
LLM_MODEL_ANALYSIS=qwen2.5:7b-instruct-q4_K_M
```

---

## 4. First-Time Start

```bash
docker compose up -d --build
```

Wait for all containers to be healthy:
```bash
docker ps
```

You should see 7 containers: `frontend`, `backend`, `worker`, `db`, `redis`, `whisper`, `tts` — all `Up (healthy)`.

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

### You swapped a model file
```bash
# Models are mounted volumes — just restart the service
docker compose restart whisper    # After changing whisper model
docker compose restart tts        # After changing TTS model
docker compose restart backend worker  # After changing Ollama model in .env
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
docker logs -f healthcare_tts
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

```
AI-Caller-Healthcare/
├── models/                    # AI model files (mounted into containers)
│   ├── whisper/               # Whisper GGML models → mounted at /models/
│   │   ├── ggml-small.en.bin
│   │   └── README.md
│   ├── tts/                   # Coqui TTS models → mounted at /root/.local/share/tts/
│   │   ├── tts_models--en--ljspeech--tacotron2-DDC/
│   │   ├── vocoder_models--en--ljspeech--hifigan_v2/
│   │   └── README.md
│   └── README.md
├── ai/whisper/Dockerfile      # Whisper container build file
├── backend/                   # Express API + orchestrator
├── worker/                    # BullMQ job processor
├── frontend/                  # Vue 3 dashboard
├── .env                       # Environment variables (container paths)
├── .env.example               # Template for new developers
├── docker-compose.yml         # Service definitions
└── setup.md                   # This file
```
