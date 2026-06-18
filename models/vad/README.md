# Silero VAD Model

Place local voice activity detection model files in this directory.

## Current Model

- `silero_vad_op18_ifless.onnx` - Silero VAD ONNX model for low-resource CPU inference.

## How It Works

This folder is mounted into backend and worker containers as:

```text
Host path:      ./models/vad/          ->  Container path: /models/vad/
```

The configured path is:

```bash
VAD_MODEL_PATH=/models/vad/silero_vad_op18_ifless.onnx
```

The current production call flow still uses the existing browser-side VAD plus backend RMS silence detection. This ONNX model is stored and validated so server-side Silero VAD can be enabled after call-timing tests, without changing the model placement again.

## Download

```bash
wget https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad_op18_ifless.onnx \
  -O models/vad/silero_vad_op18_ifless.onnx
```

## Git Tracking Policy

Only this `README.md` is tracked from this folder.
ONNX model files (`*.onnx`) are git-ignored and must be provided locally by each user.
