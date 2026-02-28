# Local AI Models

Pre-downloaded models stored here — mounted into Docker containers via volumes.  
**No model downloads during `docker build`.** Just place the files and run `docker compose up`.

## Directory Structure

```
models/
├── whisper/                          # Whisper STT models (ggml format)
│   └── ggml-small.en.bin             # ~466MB — English small model
├── tts/                              # Coqui TTS models
│   ├── tts_models--en--ljspeech--tacotron2-DDC/
│   │   ├── config.json
│   │   └── model_file.pth.tar        # ~108MB
│   └── vocoder_models--en--ljspeech--hifigan_v2/
│       ├── config.json
│       └── model_file.pth.tar        # ~3.7MB
└── README.md
```

## How to Swap Models

### Whisper (Speech-to-Text)
1. Download a new ggml model (options: `tiny.en`, `base.en`, `small.en`, `medium.en`)
2. Place the `.bin` file in `models/whisper/`
3. Update `WHISPER_MODEL_PATH` in `.env` (e.g., `/models/ggml-medium.en.bin`)
4. Run `docker compose up -d` (no rebuild needed)

### TTS (Text-to-Speech)
1. Download a Coqui TTS model and vocoder
2. Place model folders in `models/tts/` (folder names must match Coqui's naming convention)
3. Update the `--model_name` in `docker-compose.yml` TTS entrypoint
4. Run `docker compose up -d` (no rebuild needed)

### Ollama (LLM) — runs on host
Ollama manages its own models at `~/.ollama/models/` on the host machine.
- Pull: `ollama pull qwen2.5:3b-instruct-q4_K_M`
- Change: update `LLM_MODEL_CHAT` / `LLM_MODEL_ANALYSIS` in `.env`
- Run `docker compose restart backend worker`

> **Note:** Model binaries are gitignored. After cloning, download models per instructions above.
