# Accessible PowerShell

A simple browser shell built for screen readers. Three clear regions:

1. **Current path** — where you are in the filesystem  
2. **Output** — read-only history of commands and results  
3. **Command** — a normal text field to type PowerShell commands  

No canvas terminal grid. Screen readers can tab between path, output, and the command box like any other form.

Backend is TypeScript (`src/server.ts`); frontend is plain HTML/JS (`public/index.html`). Each browser connection gets a real PowerShell process via `node-pty` over a WebSocket.

## Requirements

- Node.js 18 or later
- Build tools for `node-pty` (native module):
  - **Windows**: Visual Studio Build Tools with the "Desktop development with C++" workload, plus Python 3
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential` and `python3`
- On Windows, **PowerShell 7** (`pwsh`) on `PATH`
- Optional: [Ollama](https://ollama.com) for natural-language commands (nlsh)

## Setup

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

Production-style:

```bash
npm run build
npm start
```

## Desktop application (Electron)

The same accessible UI can also run as a standalone desktop application. The Electron main process is `src/electron/main.ts`, and the preload bridge is `src/electron/preload.ts`.

### Electron development

Run:

```bash
npm run electron:dev
```

The Electron development command first compiles the TypeScript sources with `tsc` and then launches Electron using the compiled entry point configured by the `main` field in `package.json`.

On Windows, you can run `npm run electron:dev` directly from PowerShell. The Electron window will appear on the Windows desktop.

The original browser workflow remains available with `npm run dev`.

### Linux Electron launcher

On Linux, the recommended launcher is:

```bash
./scripts/start-electron.sh
```

It defaults to a local Ollama server at:

```text
http://127.0.0.1:11434
```

You can specify another Ollama server without editing the script:

```bash
./scripts/start-electron.sh http://192.168.1.50:11434
```

The launcher sets `OLLAMA_HOST` for the Electron process and then runs `npm run electron:dev`.

### Test the compiled Electron application locally

```bash
npm run electron
```

### Build a directory package

```bash
npm run pack
```

### Build distributables

```bash
npm run dist
```

This creates platform-specific distributables in `release/`:

- Windows: NSIS installer (`.exe`)
- macOS: DMG (`.dmg`)
- Linux: AppImage (`.AppImage`)

## Ollama on Windows or Linux

The Electron app can run on Windows or Linux while using an Ollama server on the same computer or on another computer. The backend reads the `OLLAMA_HOST` environment variable, and the Settings page also lets you change the Ollama server without editing scripts.

### Windows launcher

```powershell
.\scripts\start-electron.ps1
```

The Windows launcher defaults to:

```text
http://cyber.local:11434
```

You can override it when needed:

```powershell
.\scripts\start-electron.ps1 -LinuxOllamaHost "http://192.168.1.50:11434"
```

### Linux launcher

```bash
./scripts/start-electron.sh
```

The Linux launcher defaults to:

```text
http://127.0.0.1:11434
```

To use Ollama on another computer:

```bash
./scripts/start-electron.sh http://192.168.1.50:11434
```

### Change the Ollama server from Settings

You do not have to edit either launcher to change servers permanently for the application UI. Open:

**Settings → Natural language shell (nlsh / Ollama)**

Enter the Ollama server address and choose **Connect**. The application tests the connection before switching to it, then refreshes the available models. This setting is saved for the application.

For example:

```text
http://cyber.local:11434
http://192.168.1.50:11434
http://127.0.0.1:11434
```

When Windows Electron connects to Linux Ollama, the model remains on Linux. The Windows application communicates with the Linux Ollama HTTP API.

The remote Ollama server must be reachable from the computer running Electron and should be restricted to a trusted network rather than exposed to the public Internet.

### Choosing and managing models

Open **Settings → Natural language shell (nlsh / Ollama)**. The application can list installed models, install supported models, remove models, and select the model used for natural-language commands. No `ollama pull` command is required for normal model management.

## How to use (screen reader)

1. When the page loads, wait for “Shell ready” / “Connected to PowerShell.”
2. Focus lands on the **Command** field.
3. Type a command (for example `Get-Date` or `Get-ChildItem`) and press **Enter**.
4. A short status is announced when the command finishes (succeeded or failed).
5. Press **Alt+O** (or “Go to output”) to read results in the output box with browse mode / the virtual cursor.
6. Press **Alt+C** to return to the command field.

### Keyboard

| Key | Action |
|-----|--------|
| Enter | Run command |
| Tab | Complete paths/commands (PowerShell `TabExpansion2`) |
| Shift+Tab | Previous completion match |
| Up / Down | Command history |
| Escape | Clear the command field |
| Alt+O | Focus output |
| Alt+C | Focus command field |

Tab stays in the command field — it does not move focus to the Run button. Completions use your **current path** so `cd per` + Tab can expand to a folder under that directory.

## Natural language shell (nlsh / Ollama)

With **Settings → Enable natural language commands** and an Ollama model selected, the **Accessible terminal** can turn everyday language into a shell command (after confirmation). The shell can `cd` anywhere; you do not need to stay inside this repository.

### Standalone CLI inside the repo

```bash
cd /path/to/accessible-terminal-app
npm run nlsh
```
