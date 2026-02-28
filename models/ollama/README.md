# Ollama Local Models (GGUF)

Place your local GGUF files in this folder.
The `ollama` Docker service imports them at startup and registers model tags used by the app.

## Required by Default

Based on `.env` defaults:

- `models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf`
- `models/ollama/qwen2.5-7b-instruct-q4_K_M.gguf`

## How It Works

- Host path: `./models/ollama/`
- Container path: `/models/ollama/`
- Startup script: `scripts/ollama-entrypoint.sh`

At container start:
1. `ollama serve` starts inside Docker.
2. The script checks `OLLAMA_MODEL*_PATH` values.
3. Tags are created/refreshed from local GGUF files using `ollama create`.

No `ollama pull` is required for this workflow.

## Git Tracking Policy

Only `README.md` is tracked from this folder.
GGUF model files (`*.gguf`) are git-ignored and must be provided locally by each user.

## Custom Models

If you use different GGUF files, update `.env`:

- `OLLAMA_MODEL_PATH`
- `OLLAMA_MODEL_CHAT_PATH`
- `OLLAMA_MODEL_ANALYSIS_PATH`
- `OLLAMA_MODEL_DECISION_PATH`

The app uses fixed internal tags:
- `healthcare-base`
- `healthcare-chat`
- `healthcare-analysis`
- `healthcare-decision`

These tags are managed by `scripts/ollama-entrypoint.sh` and are not configured via `.env`.
