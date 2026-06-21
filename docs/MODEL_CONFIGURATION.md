# AI Model Configuration

## Overview

This project is configured for **OpenRouter-only LLM inference** and WebRTC-based calling via LiveKit. The backend and worker do not start local LLM runtimes or route LLM traffic to any secondary provider.

```
Speech (WebRTC) -> LiveKit -> Voice Agent -> Whisper STT (Local) -> OpenRouter LLM (Gemma 4) -> Kokoro TTS (Local) -> Audio response
```

## Required LLM Settings

Set these in `.env`:

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_real_openrouter_key_here
OPENROUTER_MODEL=google/gemma-4-31b-it:free
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=Care Outreach Assistant
```

## LiveKit WebRTC Configuration

Set these in `.env` if connecting to a custom LiveKit deployment:

```bash
LIVEKIT_URL=ws://localhost:7800
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret
```

## Local Models Still Used

### STT

Whisper is hosted locally and used by the LiveKit Voice Agent container to transcribe user audio chunks on CPU:

```bash
WHISPER_HOST=whisper
WHISPER_PORT=9000
WHISPER_MODEL_PATH=/models/whisper/ggml-small.en-q5_1.bin
```

`ggml-small.en-q5_1.bin` is the default because it keeps Whisper accuracy strong while using much less disk and memory than the unquantized model.

> [!NOTE]
> **Automated Setup:** You do not need to download this model manually. On the first startup, either the `./start.sh` script or the Whisper container itself will download it automatically from Hugging Face if it is missing.

### TTS

Kokoro is hosted locally and used by the LiveKit Voice Agent container to synthesize agent speech:

```bash
KOKORO_HOST=kokoro
KOKORO_PORT=8880
KOKORO_VOICE=af_bella
KOKORO_LANG=en-us
```

Docker uses the pinned public CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2`. No local model files are required for Kokoro.

## Startup

A single command starts the entire system and handles downloading missing models:

```bash
# Using startup script (auto-checks env and models)
./start.sh

# Or directly using Docker Compose
docker compose up -d
```

The expected LLM-related behavior is:

- no local LLM container
- no local LLM model path validation
- no secondary LLM API key requirement
- all LLM calls go through OpenRouter

## Troubleshooting

### OpenRouter key missing

Add your key to `.env`:

```bash
OPENROUTER_API_KEY=your_real_openrouter_key_here
```

Then restart backend, worker, and livekit-agent:

```bash
docker compose up -d backend worker livekit-agent
```

### Free model rate limits

OpenRouter free model variants can be rate-limited or temporarily unavailable. The app keeps existing in-call safety behavior: if OpenRouter is unavailable, the agent will handle failures gracefully and transition appropriately.
