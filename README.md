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

Use:

```bash
npm run electron:dev
```

This command starts the **Electron runtime** and loads the TypeScript main process through `ts-node`. Do not run `src/electron/main.ts` directly with `ts-node`; Electron APIs such as `app.isPackaged` are only available when the file is launched by Electron.

The Electron main process starts the Express backend on an available localhost port, waits for the server to become ready, and then opens the desktop window.

The original browser workflow remains available:

```bash
npm run dev
```

### Test the compiled Electron application locally

First compile the TypeScript sources:

```bash
npm run build
```

Then run the compiled Electron application:

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

Requires Ollama running (default `http://127.0.0.1:11434`). Use `!model` to pick a model, `!help` for commands, `exit` to quit.

### CLI from another directory

You can start the same tool from any working directory without `cd` into the repo first:

```bash
# from anywhere — adjust the path to where you cloned this project
npx --prefix ~/ai_shell/accessible-terminal-app ts-node \
  ~/ai_shell/accessible-terminal-app/src/nlsh.ts
```

On Windows (PowerShell), for example:

```powershell
npx --prefix $HOME\ai_shell\accessible-terminal-app ts-node `
  $HOME\ai_shell\accessible-terminal-app\src\nlsh.ts
```

Optional: add a shell alias that points at that command so you can type `nlsh` from any folder.

The CLI’s working directory is wherever you started it; you can still `cd` to other paths after it launches. The web app’s nlsh feature is separate: keep `npm run dev` running from the repo, then use natural language in the browser from any path in the shell.

## How it works

- The server spawns `pwsh` (or `$SHELL` / bash on non-Windows) per WebSocket connection, starting in your home folder.
- The page sends one full command line at a time when you press Enter.
- Shell output is cleaned of ANSI escape codes and shown as plain text in the output box.
- The current path is taken from the PowerShell prompt (`PS C:\…>`) or a bash/zsh-style prompt on Linux/macOS.
- Optional shell integration (`shell-integration/pwsh-integration.ps1`) emits OSC 633 markers so the UI can announce success vs failure more reliably.

Interactive full-screen programs (editors, pagers) are not the goal of this simple form UI — line-oriented shell commands are. Use **Full console** mode for vim and similar tools.

## Security note

There is no authentication. Anyone who can reach the server gets a real shell on the host. Keep it on localhost unless you add proper access control.
