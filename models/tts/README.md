# Coqui TTS Models

Place your Coqui TTS model folders in this directory.

## Current Models
- `tts_models--en--ljspeech--tacotron2-DDC/` — Tacotron2 speech model (~108MB)
- `vocoder_models--en--ljspeech--hifigan_v2/` — HiFiGAN vocoder (~3.7MB)

## How It Works

This folder is mounted into the TTS Docker container via `docker-compose.yml`:
```
Host path:      ./models/tts/             →  Container path: /root/.local/share/tts/
```

Coqui TTS automatically reads its models from `/root/.local/share/tts/` inside the container.
Since we mount this folder there, it uses your local files instead of downloading.

## Folder Structure (must match exactly)

```
models/tts/
├── tts_models--en--ljspeech--tacotron2-DDC/
│   ├── config.json
│   └── model_file.pth.tar          (~108MB)
├── vocoder_models--en--ljspeech--hifigan_v2/
│   ├── config.json
│   └── model_file.pth.tar          (~3.7MB)
└── README.md
```

> **Important:** Folder names use `--` (double dash) as separators. This is Coqui's naming convention.

## How to Get Models (first time)

The easiest way is to temporarily remove the volume mount, start the container (it auto-downloads), then copy the files:
```bash
# 1. Temporarily comment out the volume mount in docker-compose.yml
# 2. Start TTS: docker compose up -d tts
# 3. Wait for it to be healthy, then copy:
docker cp healthcare_tts:/root/.local/share/tts/. models/tts/
# 4. Restore the volume mount
```

## After Swapping
1. Place new model folders here (follow Coqui naming convention)
2. Update `--model_name` in `docker-compose.yml` TTS entrypoint
3. Run `docker compose restart tts`
