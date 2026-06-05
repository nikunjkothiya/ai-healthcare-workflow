# AI Model Configuration & Migration Guide

## Overview

This project uses a **multi-model, multi-provider architecture** optimized for low-resource local deployment (8-16GB RAM). Each pipeline stage can use a different model/provider for optimal accuracy/speed trade-offs.

---

## Model Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐
│   STT       │───▶│   LLM Chat   │───▶│   TTS       │───▶│  Audio Out  │
│ Speech→Text │    │  (Realtime)  │    │  Text→Speech│    │             │
└─────────────┘    └──────────────┘    └─────────────┘    └─────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ LLM Analysis │
                  │ (Post-call)  │
                  └──────────────┘
```

---

## Recommended Models (2026)

### STT — Speech-to-Text

| Model | Params | RAM | Speed | WER | Best For |
|-------|--------|-----|-------|-----|----------|
| **Whisper Small** (current) | 244M | ~1GB | 1x | 6.5% | General purpose, multilingual |
| **Whisper Large V3 Turbo** | 809M | ~6GB | 6x | 7.75% | Batch analysis, 99+ languages |
| **Moonshine Base** (new) | 106M | ~400MB | 5x | 8.2% | Real-time edge, lowest latency |
| **Distil-Whisper** | 756M | ~4GB | 2x | 7.0% | Balanced speed/accuracy |

**Recommendation**: Use Moonshine for real-time turns + Whisper for post-call batch analysis.

```bash
# Enable Moonshine
STT_PROVIDER=moonshine
```

---

### LLM — Chat/Realtime (Live Conversation Turns)

| Model | Params | RAM (Q4) | Speed | JSON Quality | Best For |
|-------|--------|----------|-------|-------------|----------|
| **Qwen3 4B** (recommended) | 4B | ~2.5GB | Fast | Good | Dual thinking/non-thinking, 119 languages |
| **Phi-4-mini 3.8B** | 3.8B | ~2.3GB | Fast | Very Good | Best reasoning in small size |
| **Llama 3.2 3B** | 3B | ~2GB | Fast | Excellent | Best structured JSON output |
| **Gemma 3 4B** | 4B | ~2.5GB | Fast | Good | 128K context, 140+ languages |

**Recommendation**: Qwen3 4B for general use, Llama 3.2 3B if JSON reliability is critical.

```bash
# Pull and configure
ollama pull qwen3:4b
# .env: OLLAMA_MODEL_CHAT=qwen3:4b
```

---

### LLM — Analysis (Post-Call)

| Model | Params | RAM (Q4) | Speed | Reasoning | Best For |
|-------|--------|----------|-------|-----------|----------|
| **Qwen3 8B** (recommended) | 8B | ~5GB | Medium | Strong | Deep analysis, 119 languages |
| **Llama 3.1 8B** | 8B | ~5GB | Medium | Strong | General purpose |
| **Mistral 7B** | 7B | ~4.5GB | Medium | Good | Efficient baseline |

```bash
ollama pull qwen3:8b
# .env: OLLAMA_MODEL_ANALYSIS=qwen3:8b
```

---

### TTS — Text-to-Speech

| Model | Params | RAM | Speed | Quality | License |
|-------|--------|-----|-------|---------|---------|
| **Kokoro-82M** (new, recommended) | 82M | ~300MB | Fast | #1 TTS Arena | Apache 2.0 |
| **Coqui Tacotron2** (current) | 28M+14M | ~1GB | Slow | Good | Various |
| **CosyVoice2 0.5B** | 500M | ~1.5GB | Fast (150ms) | Excellent | Apache 2.0 |
| **Kyutai Pocket TTS** | 100M | ~400MB | CPU real-time | Good | MIT |

**Recommendation**: Kokoro-82M — highest quality, smallest size, Apache 2.0 license.

```bash
# Enable Kokoro
TTS_PROVIDER=kokoro
KOKORO_VOICE=af_bella  # American female
```

---

## Quick Start — Local Deployment

### 1. Pull Models

```bash
# LLM models
ollama pull qwen3:4b      # Chat/realtime (~2.5GB)
ollama pull qwen3:8b      # Analysis (~5GB)

# Optional alternatives
ollama pull llama3.2:3b   # Best JSON output
ollama pull phi:3.8b      # Best reasoning
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env:
#   LLM_PROVIDER=ollama
#   TTS_PROVIDER=kokoro
#   STT_PROVIDER=whisper  (or moonshine)
```

### 3. Start Services

```bash
# Full stack with Kokoro TTS
docker-compose up -d

# Without optional services (Moonshine)
docker-compose up -d --scale moonshine=0
```

---

## Memory Budget (8GB RAM System)

| Service | RAM Usage |
|---------|-----------|
| PostgreSQL | ~200MB |
| Redis | ~100MB |
| Whisper (small) | ~1GB |
| Kokoro TTS | ~300MB |
| Qwen3 4B (chat) | ~2.5GB |
| Qwen3 8B (analysis) | ~5GB (swapped in/out) |
| Backend + Worker | ~500MB |
| **Total** | **~8-9GB** |

For 8GB systems, use the same model for chat and analysis:
```bash
OLLAMA_MODEL_ANALYSIS=qwen3:4b  # Use 4B for analysis too
```

---

## Model Switching Guide

### Switch Chat Model

```bash
# Pull new model
ollama pull llama3.2:3b

# Update .env
OLLAMA_MODEL_CHAT=llama3.2:3b

# Restart
docker-compose restart backend worker
```

### Switch TTS Provider

```bash
# .env
TTS_PROVIDER=kokoro  # or 'coqui'

# Restart
docker-compose up -d kokoro  # start Kokoro if switching to it
docker-compose restart backend worker
```

### Switch STT Provider

```bash
# .env
STT_PROVIDER=moonshine  # or 'whisper'

# Start Moonshine service
docker-compose up -d moonshine
docker-compose restart backend worker
```

---

## Performance Benchmarks (Expected)

| Pipeline Stage | Old (Qwen2.5 3B + Tacotron2) | New (Qwen3 4B + Kokoro) |
|---------------|------------------------------|--------------------------|
| STT (1.2s audio) | ~2.0s | ~1.2s (Whisper) / ~0.4s (Moonshine) |
| LLM (realtime turn) | ~4-5s | ~2-3s |
| TTS (1 sentence) | ~2.0s | ~0.8s |
| **End-to-end turn** | **~8-9s** | **~4-5s** |
| Post-call analysis | ~15-20s | ~8-12s |

---

## Troubleshooting

### Model not found
```bash
ollama list                    # Check installed models
ollama pull qwen3:4b           # Pull missing model
```

### Out of memory
```bash
# Use smaller models
OLLAMA_MODEL_CHAT=qwen3:4b     # 4B instead of 8B
OLLAMA_MODEL_ANALYSIS=qwen3:4b # Same model for analysis
```

### Kokoro not responding
```bash
docker-compose logs kokoro     # Check logs
curl http://localhost:8880/health  # Health check
```
