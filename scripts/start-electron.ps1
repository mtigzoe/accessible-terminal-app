param(
  [string]$LinuxOllamaHost = "http://cyber.local:11434"
)

# Linux Ollama is the default. Override with -LinuxOllamaHost if needed.
$env:OLLAMA_HOST = $LinuxOllamaHost.TrimEnd('/')

Write-Host "Accessible Terminal - Electron"
Write-Host "Using Ollama at: $env:OLLAMA_HOST"
Write-Host "Starting Electron..."
Write-Host ""

npm run electron:dev
exit $LASTEXITCODE
