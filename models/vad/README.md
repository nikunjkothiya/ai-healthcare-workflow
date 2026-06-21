# Silero VAD Model (Optional)

This directory is an optional storage space for local Silero voice activity detection model files.

## Status: Optional / Automatic

The production call flow uses client-side Voice Activity Detection (VAD) built into the browser/mobile client (`MobileCall.vue`) for the web client, and the standard LiveKit Agent leverages the `livekit-plugins-silero` library. 

The library automatically downloads, caches, and runs the Silero VAD model inside the container at runtime. You do not need to download this file manually.

## Manual Setup (If needed for custom pipelines)

If you wish to host a local VAD file for custom extensions, you can download it here:

```bash
wget https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad_op18_ifless.onnx \
  -O models/vad/silero_vad_op18_ifless.onnx
```

Only this `README.md` is tracked in git. All `*.onnx` files are ignored.
