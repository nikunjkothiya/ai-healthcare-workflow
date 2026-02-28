# Local AI Models

All model files are stored in the repository under `models/` and mounted into Docker containers.
No model binaries are downloaded during Docker image build.

## Git Tracking Policy

Only `README.md` files are tracked under `models/`.
Model assets are git-ignored and must be provided locally by each user:
- Whisper: `*.bin`
- Ollama: `*.gguf`
- TTS: `*.pth.tar`, `*.tar`, `config.json`

## Directory Structure

```text
models/
|-- whisper/   # Whisper STT models (GGML)
|-- ollama/    # Ollama LLM models (GGUF)
|-- tts/       # Coqui TTS model + vocoder files
`-- README.md
```

## How to Swap Models

### Whisper (Speech-to-Text)
1. Place the `.bin` file in `models/whisper/`.
2. Update `WHISPER_MODEL_PATH` in `.env`.
3. Restart whisper: `docker compose restart whisper`.

### Ollama (LLM in Docker)
1. Place GGUF files in `models/ollama/`.
2. Update `OLLAMA_MODEL*_PATH` values in `.env`.
3. Start/restart ollama: `docker compose up -d ollama`.

### TTS (Text-to-Speech)
1. Place Coqui model folders/files in `models/tts/`.
2. Update `TTS_MODEL_PATH`, `TTS_CONFIG_PATH`, `TTS_VOCODER_PATH`, and `TTS_VOCODER_CONFIG_PATH` in `.env` if needed.
3. Restart TTS: `docker compose restart tts`.
