# Local AI Models

This directory holds the model assets used for local offline inference. Only `README.md` files are tracked in git; the actual model binaries are ignored.

> [!NOTE]
> **Zero Manual Setup Required:** You do not need to download these files manually. The system will automatically detect if they are missing and download them on the first startup.

## Automated Download & Management

1. **Whisper STT Model (`ggml-small.en-q5_1.bin`):**
   - Automatically downloaded by the `./start.sh` startup script or inside the `healthcare_whisper` container on startup.
   - Saves to the host path `models/whisper/ggml-small.en-q5_1.bin` (which is bind-mounted to `/models/whisper/` inside the Whisper container).
2. **Silero VAD ONNX Model:**
   - The WebRTC LiveKit agent uses the `livekit-plugins-silero` library, which automatically downloads and caches the required voice activity detection model inside the container at runtime. No manual download is necessary.

---

## Directory Structure

```text
models/
|-- whisper/   # Whisper STT GGML models (mounted at /models/whisper/)
|   |-- ggml-small.en-q5_1.bin (quantized, ~181MB)
|   `-- README.md
`-- README.md
```

## Manual Download (Optional)

If you prefer to download files manually, run:

```bash
# Download Whisper GGML model
mkdir -p models/whisper
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin -O models/whisper/ggml-small.en-q5_1.bin
```

## How to Swap Whisper Models

1. Place the new GGML `.bin` file in `models/whisper/`.
2. Update the `WHISPER_MODEL_PATH` variable in your `.env` file (e.g., `WHISPER_MODEL_PATH=/models/whisper/ggml-medium.en.bin`).
3. Restart the Whisper service: `docker compose restart whisper`.
