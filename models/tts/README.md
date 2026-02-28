# Coqui TTS Models

Place your Coqui TTS model folders in this directory.

## Current Models
- `tts_models--en--ljspeech--tacotron2-DDC/` - Tacotron2 speech model (~108MB)
- `vocoder_models--en--ljspeech--hifigan_v2/` - HiFiGAN vocoder (~3.7MB)

## How It Works

This folder is mounted into the TTS Docker container via `docker-compose.yml`:
```
Host path:      ./models/tts/             ->  Container path: /models/tts/
```

The container loads model files from explicit local paths:
- `TTS_MODEL_PATH`
- `TTS_CONFIG_PATH`
- `TTS_VOCODER_PATH`
- `TTS_VOCODER_CONFIG_PATH`

All of them point to files under `/models/tts/` (mounted from `./models/tts/`).

## Git Tracking Policy

Only `README.md` is tracked from this folder.
TTS model assets (`*.pth.tar`, `*.tar`, and `config.json`) are git-ignored and must be provided locally by each user.

## Folder Structure (must match exactly)

```text
models/tts/
|-- tts_models--en--ljspeech--tacotron2-DDC/
|   |-- config.json
|   `-- model_file.pth.tar          (~108MB)
|-- vocoder_models--en--ljspeech--hifigan_v2/
|   |-- config.json
|   `-- model_file.pth.tar          (~3.7MB)
`-- README.md
```

> Important: Folder names use `--` (double dash) as separators. This is Coqui's naming convention.

## How to Get Models (first time)

Put model files in this folder before starting the stack.
The required files are:
- `models/tts/tts_models--en--ljspeech--tacotron2-DDC/model_file.pth.tar`
- `models/tts/tts_models--en--ljspeech--tacotron2-DDC/config.json`
- `models/tts/vocoder_models--en--ljspeech--hifigan_v2/model_file.pth.tar`
- `models/tts/vocoder_models--en--ljspeech--hifigan_v2/config.json`

## After Swapping
1. Place new model folders here (follow Coqui naming convention).
2. Update `TTS_MODEL_PATH`, `TTS_CONFIG_PATH`, `TTS_VOCODER_PATH`, and `TTS_VOCODER_CONFIG_PATH` in `.env` if folder names changed.
3. Run `docker compose restart tts`.
