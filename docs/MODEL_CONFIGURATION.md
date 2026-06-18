# AI Model Configuration

## Overview

This project is configured for **OpenRouter-only LLM inference**. The backend and worker do not start local LLM runtimes or route LLM traffic to any secondary provider.

```
Speech -> Whisper STT -> OpenRouter LLM -> Kokoro TTS -> Audio response
                         |
                         +-> OpenRouter post-call analysis
```

## Required LLM Settings

Set these in `.env`:

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_real_openrouter_key_here
OPENROUTER_MODEL=openrouter/free
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=Care Outreach Assistant
LLM_TIMEOUT_MS=15000
LLM_REALTIME_TIMEOUT_MS=8000
LLM_REALTIME_MAX_RETRIES=0
LLM_FAILURE_HANDOFF=true
```

`openrouter/free` is the default model router for free OpenRouter model variants. The app uses the same router for realtime turns, decision JSON, and post-call analysis unless you choose explicit OpenRouter model overrides.
`OPENROUTER_HTTP_REFERER` is sent as the `HTTP-Referer` attribution header for OpenRouter. It does not control application routing. Use `http://localhost:3000` locally and the deployed frontend URL in production.

For healthcare workflows, treat `openrouter/free` as a development default. It can route to different free models, so validated deployments should pin explicit `:free` model IDs per stage after call testing.

Optional OpenRouter-only model overrides:

```bash
OPENROUTER_MODEL_CHAT=openrouter/free
OPENROUTER_MODEL_REALTIME=openrouter/free
OPENROUTER_MODEL_DECISION=openrouter/free
OPENROUTER_MODEL_ANALYSIS=openrouter/free
```

## Local Models Still Used

### STT

Whisper remains local:

```bash
WHISPER_MODEL_PATH=/models/whisper/ggml-small.en-q5_1.bin
STT_CHUNK_MS=2500
STT_REALTIME_CHUNK_MS=1800
STT_SILENCE_MS=800
VAD_MODEL_PATH=/models/vad/silero_vad_op18_ifless.onnx
```

`ggml-small.en-q5_1.bin` is the default because it keeps Whisper accuracy reasonably strong while using much less disk and memory than the unquantized small model. `VAD_MODEL_PATH` points to the locally downloaded Silero ONNX model; the current call flow still uses browser-side VAD plus backend RMS finalization until server-side Silero VAD is enabled and tested.

### TTS

Server-side TTS uses Kokoro by default:

```bash
KOKORO_HOST=kokoro
KOKORO_PORT=8880
KOKORO_VOICE=af_bella
KOKORO_LANG=en-us
REQUIRE_SERVER_TTS=true
```

Docker uses the pinned public CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2`.

## Startup

```bash
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

Then restart backend and worker:

```bash
docker compose up -d backend worker
```

### Free model rate limits

OpenRouter free model variants can be rate-limited or temporarily unavailable. The app keeps existing in-call safety behavior: a realtime LLM failure produces a short safe response, and repeated failures end the call with manual follow-up.
