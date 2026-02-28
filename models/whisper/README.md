# Whisper STT Models

Place your Whisper GGML model files in this directory.

## Current Model
- `ggml-small.en.bin` - English small model (~466MB)

## How It Works

This folder is mounted into the Whisper Docker container via `docker-compose.yml`:
```
Host path:      ./models/whisper/          ->  Container path: /models/whisper/
```

So when `.env` says `WHISPER_MODEL_PATH=/models/whisper/ggml-small.en.bin`, it reads from this folder.

## Git Tracking Policy

Only `README.md` is tracked from this folder.
Whisper model binaries (`*.bin`) are git-ignored and must be provided locally by each user.

## How to Download

```bash
# Option 1: wget from HuggingFace
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin -O models/whisper/ggml-small.en.bin

# Option 2: Using whisper.cpp download script
bash ai/whisper/download-model.sh small.en
mv ai/whisper/models/ggml-small.en.bin models/whisper/
```

## Available Models (pick one based on your hardware)

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `ggml-tiny.en.bin` | 75MB | Fastest | Low |
| `ggml-base.en.bin` | 142MB | Fast | Medium |
| `ggml-small.en.bin` | 466MB | Medium | **Good (recommended)** |
| `ggml-medium.en.bin` | 1.5GB | Slow | Best |

## After Swapping
1. Place new `.bin` file here.
2. Update `WHISPER_MODEL_PATH` in `.env` (example: `/models/whisper/ggml-medium.en.bin`).
3. Run `docker compose restart whisper`.
