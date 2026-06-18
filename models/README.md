# Local AI Models

All model files are stored in the repository under `models/` and mounted into Docker containers.
No model binaries are downloaded during Docker image build.

## Git Tracking Policy

Only `README.md` files are tracked under `models/`.
Model assets are git-ignored and must be provided locally by each user:
- Whisper: `*.bin`
- VAD: `*.onnx`

## Directory Structure

```text
models/
|-- whisper/   # Whisper STT models (GGML)
|-- vad/       # Silero VAD model (ONNX)
`-- README.md
```

## How to Swap Models

### Whisper (Speech-to-Text)
1. Place the `.bin` file in `models/whisper/`.
2. Update `WHISPER_MODEL_PATH` in `.env`.
3. Restart whisper: `docker compose restart whisper`.

### Silero VAD
1. Place the `.onnx` file in `models/vad/`.
2. Update `VAD_MODEL_PATH` in `.env`.
3. Restart backend/worker after VAD integration changes: `docker compose restart backend worker`.
