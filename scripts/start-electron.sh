#!/usr/bin/env bash
set -euo pipefail

OLLAMA_HOST_VALUE="${1:-http://127.0.0.1:11434}"
OLLAMA_HOST_VALUE="${OLLAMA_HOST_VALUE%/}"

export OLLAMA_HOST="$OLLAMA_HOST_VALUE"

echo "Accessible Terminal - Electron"
echo "Using Ollama at: $OLLAMA_HOST"
echo "Starting Electron..."
echo

npm run electron:dev
