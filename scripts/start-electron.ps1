param(
  [string]$LinuxOllamaHost = "http://cyber.local:11434"
)

Write-Host "Accessible Terminal - Electron Ollama setup"
Write-Host ""
Write-Host "1. Use Ollama on this Windows computer"
Write-Host "2. Use Ollama on Linux ($LinuxOllamaHost)"
Write-Host "3. Enter a different Ollama URL"
Write-Host ""

$choice = Read-Host "Choose 1, 2, or 3"

switch ($choice) {
  "1" {
    $env:OLLAMA_HOST = "http://127.0.0.1:11434"
  }
  "2" {
    $env:OLLAMA_HOST = $LinuxOllamaHost
  }
  "3" {
    $customHost = Read-Host "Enter Ollama URL"
    if ([string]::IsNullOrWhiteSpace($customHost)) {
      Write-Error "Ollama URL cannot be empty."
      exit 1
    }
    $env:OLLAMA_HOST = $customHost.TrimEnd('/')
  }
  default {
    Write-Error "Invalid choice. Enter 1, 2, or 3."
    exit 1
  }
}

Write-Host ""
Write-Host "Using Ollama at: $env:OLLAMA_HOST"
Write-Host "Starting Electron..."
Write-Host ""

npm run electron:dev
exit $LASTEXITCODE
