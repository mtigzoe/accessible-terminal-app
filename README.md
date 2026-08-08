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

The Electron development command first compiles the TypeScript sources with `tsc` and then launches Electron using the compiled entry point configured by the `main` field in `package.json`:

```text
src/electron/main.ts    -> dist/electron/main.js
src/electron/preload.ts -> dist/electron/preload.js
```

This approach intentionally does **not** launch `main.ts` directly with `ts-node`. Electron's main process needs the Electron runtime, and compiling first keeps the application in the CommonJS configuration used by this project. It also avoids the `__dirname is not defined` error that occurs when the TypeScript entry point is incorrectly treated as an ES module.

On Windows, you can run `npm run electron:dev` directly from PowerShell. The Electron window will appear on the Windows desktop; SSH is not required for the Electron GUI when the project is running on Windows.

The original browser workflow remains available:

```bash
npm run dev
```

### Test the compiled Electron application locally

The `electron` script also builds before launching:

```bash
npm run electron
```

The compiled Electron entry point is `dist/electron/main.js`, and the preload script is compiled to `dist/electron/preload.js`.

### Build a directory package

```bash
npm run pack
```

This runs the TypeScript build and asks `electron-builder` to create an unpacked application directory in `release/`.

### Build distributables

```bash
npm run dist
```

This runs the TypeScript build and creates platform-specific distributables in the `release/` folder:

- Windows: NSIS installer (`.exe`)
- macOS: DMG (`.dmg`)
- Linux: AppImage (`.AppImage`)

The target is selected by `electron-builder` for the platform on which the build is run.

### Electron build layout

The TypeScript configuration uses `src` as the source root and `dist` as the output directory:

```text
src/electron/main.ts      -> dist/electron/main.js
src/electron/preload.ts   -> dist/electron/preload.js
src/server.ts             -> dist/server.js
```

The Electron production configuration includes `dist/`, `public/`, `shell-integration/`, and `package.json` in the application package. Shell integration and application assets are also copied as extra resources.

### Features added by the desktop shell

- Automatic free-port selection (starts at 3000)
- Application menu (File, Edit, View, Help)
- System tray icon with “Show Window” and “Quit”
- Single-instance behaviour
- Clean shutdown of the backend server process
- Secure renderer settings with context isolation and a preload bridge

### Icons (optional)

Place platform icons in an `assets/` directory:

- `icon.png` (Linux / master)
- `icon.ico` (Windows)
- `icon.icns` (macOS)

## Ollama on Windows or Linux

The Electron app can run on Windows while using an Ollama server running either on Windows or on another computer such as your Linux machine. The backend reads the `OLLAMA_HOST` environment variable.

### Easy Windows launcher

The recommended Windows launcher defaults to your Linux Ollama server and no longer asks you to choose a hostname every time:

```powershell
.\scripts\start-electron.ps1
```

By default, it uses:

```text
http://cyber.local:11434
```

You can override the Linux Ollama host when needed:

```powershell
.\scripts\start-electron.ps1 -LinuxOllamaHost "http://192.168.1.50:11434"
```

The launcher only sets `OLLAMA_HOST` for the Electron process. It does not install, start, stop, or move Ollama models.

### Windows Ollama

If you want to use Ollama installed on Windows instead, set the environment variable before starting Electron:

```powershell
$env:OLLAMA_HOST="http://127.0.0.1:11434"
npm run electron:dev
```

### Linux Ollama from Windows Electron

When the Electron app runs on Windows and Ollama runs on Linux, the Windows app sends requests to the Linux Ollama server. The model remains on Linux.

The Linux Ollama server must be reachable from Windows and configured to accept connections from the Windows computer. Keep the Ollama port restricted to your trusted network rather than exposing it to the public Internet.

### Choosing the model

Open **Settings → Natural language shell (nlsh / Ollama)** and refresh the model list. The models shown are the models available from the configured Ollama server. If the server is Linux, the model remains on Linux; the Windows Electron application sends requests to that Linux server.

The `OLLAMA_MODEL` environment variable can also be used to provide a default model name.

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
