# Accessible Terminal (starter app)

A minimal browser-based terminal that connects to a real shell (PowerShell on
Windows, `$SHELL`/bash elsewhere) via `node-pty`, and renders it with
xterm.js in `screenReaderMode` so screen readers can navigate the output as
real text — the same "Esc to leave the input, arrow through the output"
pattern discussed in chat.

Backend is TypeScript (`src/server.ts`); frontend is plain JavaScript
(`public/index.html`). xterm.js is installed as a normal npm dependency
(`@xterm/xterm`) and served locally by the Express server at `/vendor/xterm`
— no CDN, no build step needed for the frontend, just for the server.

## Requirements

- Node.js 18 or later
- Build tools for `node-pty` (it's a native module, compiled on install):
  - **Windows**: Visual Studio Build Tools with the "Desktop development
    with C++" workload, plus Python 3
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential` and `python3`

If `npm install` fails specifically on `node-pty`, it's almost always one of
the above missing — search for "node-pty windows build" or "node-pty EACCES"
for current troubleshooting steps, since native build tooling issues vary
by OS version.

## Setup

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**.

For a production-style run instead of `ts-node`:

```bash
npm run build
npm start
```

## What it does

- Spawns a real shell per browser connection, with the working directory set
  to your home folder — the same default a freshly opened PowerShell window
  or terminal starts in.
- Streams shell output to the browser over a WebSocket, and every keystroke
  you type goes straight back to that shell process — so command history,
  tab completion, `Ctrl+C`, etc. all behave exactly as they do in a normal
  terminal, because it *is* a normal terminal underneath.
- `screenReaderMode: true` on the xterm.js `Terminal` is the one line doing
  the accessibility work: it keeps a hidden, linearized text buffer in sync
  with the visual grid, which is what lets a screen reader's virtual cursor
  read the scrollback after you press Esc to leave the input.

## Testing with JAWS

1. Tab or click into the terminal — JAWS should announce an edit field and
   enter forms mode.
2. Type a command and press Enter.
3. Press **Esc** to leave forms mode and arrow through the output.
4. Click back into the terminal (or press Enter) to resume typing.

## Accessible view + command navigation

Loosely modeled on VS Code's terminal accessibility features:

- **Alt+F2**, from the terminal, opens a read-only "accessible view" — a
  static snapshot of the buffer in a plain `<textarea>`, separate from the
  live terminal grid. This tends to behave more predictably for screen
  readers than navigating a constantly-updating live region.
- Inside the accessible view: **Alt+Up** / **Alt+Down** jump between
  command boundaries, announcing whether the previous command succeeded or
  failed. **Escape** (or the Close button) returns to the terminal.

Command navigation only works in PowerShell, and only because
`shell-integration/pwsh-integration.ps1` overrides the PowerShell prompt
function to emit invisible marker sequences (OSC 633, the same informal
convention VS Code's shell integration uses) before each prompt. xterm.js's
parser picks these up via `registerOscHandler` — they're never displayed.
Without shell cooperation like this, there's no reliable way to know where
one command ends and the next begins just by reading the character grid.

This is a minimal implementation, not a full port of VS Code's shell
integration — there's no bash/zsh equivalent yet (only PowerShell), and it
won't survive things like nested prompts or custom `PS1`-style
customization you might already have. If you use bash, the same idea can be
adapted using `PROMPT_COMMAND`.

## Security note

This is a minimal example, not a production app: there's no authentication,
and anyone who can reach the server gets a real shell on the host machine.
Don't deploy this as-is anywhere reachable outside your own machine.
