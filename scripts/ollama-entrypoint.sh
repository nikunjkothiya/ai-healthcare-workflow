#!/bin/sh
set -eu

log() {
  printf '[OLLAMA-INIT] %s\n' "$1"
}

ollama serve &
OLLAMA_PID=$!

cleanup() {
  kill "$OLLAMA_PID" 2>/dev/null || true
}
trap cleanup INT TERM

wait_for_ollama() {
  attempts=0
  until ollama list >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      log "Timed out waiting for Ollama API to become ready."
      exit 1
    fi
    sleep 2
  done
}

model_exists() {
  model_name="$1"
  ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -Fxq "$model_name"
}

register_model() {
  model_name="$1"
  model_path="$2"

  if [ -z "$model_name" ]; then
    log "Missing internal model tag."
    exit 1
  fi

  if [ -z "$model_path" ]; then
    log "Missing model path for ${model_name}. Set OLLAMA_MODEL_*_PATH in .env."
    exit 1
  fi

  if [ ! -f "$model_path" ]; then
    log "Model file not found for ${model_name}: ${model_path}"
    exit 1
  fi

  modelfile="$(mktemp)"
  printf 'FROM %s\n' "$model_path" > "$modelfile"
  if model_exists "$model_name"; then
    log "Refreshing model ${model_name} from ${model_path}"
  else
    log "Registering model ${model_name} from ${model_path}"
  fi
  ollama create "$model_name" -f "$modelfile"
  rm -f "$modelfile"
}

wait_for_ollama

BASE_MODEL="healthcare-base"
CHAT_MODEL="healthcare-chat"
ANALYSIS_MODEL="healthcare-analysis"
DECISION_MODEL="healthcare-decision"

BASE_PATH="${OLLAMA_MODEL_PATH:?Missing OLLAMA_MODEL_PATH in environment}"
CHAT_PATH="${OLLAMA_MODEL_CHAT_PATH:?Missing OLLAMA_MODEL_CHAT_PATH in environment}"
ANALYSIS_PATH="${OLLAMA_MODEL_ANALYSIS_PATH:?Missing OLLAMA_MODEL_ANALYSIS_PATH in environment}"
DECISION_PATH="${OLLAMA_MODEL_DECISION_PATH:?Missing OLLAMA_MODEL_DECISION_PATH in environment}"

register_model "$BASE_MODEL" "$BASE_PATH"
register_model "$CHAT_MODEL" "$CHAT_PATH"
register_model "$ANALYSIS_MODEL" "$ANALYSIS_PATH"
register_model "$DECISION_MODEL" "$DECISION_PATH"

log "Ollama models initialized."

wait "$OLLAMA_PID"
