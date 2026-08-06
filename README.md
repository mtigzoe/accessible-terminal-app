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

## How it works

- The server spawns `pwsh` (or `$SHELL` / bash on non-Windows) per WebSocket connection, starting in your home folder.
- The page sends one full command line at a time when you press Enter.
- Shell output is cleaned of ANSI escape codes and shown as plain text in the output box.
- The current path is taken from the PowerShell prompt (`PS C:\…>`).
- Optional shell integration (`shell-integration/pwsh-integration.ps1`) emits OSC 633 markers so the UI can announce success vs failure more reliably.

Interactive full-screen programs (editors, pagers) are not the goal of this simple form UI — line-oriented PowerShell commands are.

## Security note

There is no authentication. Anyone who can reach the server gets a real shell on the host. Keep it on localhost unless you add proper access control.
