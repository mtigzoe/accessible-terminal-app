# Wiring `terminal-state.js` into `interactive-console.html`

## 1. Include the script

Drop `terminal-state.js` next to `interactive-console.html` (e.g. in `public/`) and add:

```html
<script src="terminal-state.js"></script>
```

It attaches a `TerminalState` global with `createTerminalState()` and `processChunk(state, chunk)` — no build step needed.

## 2. Replace the `cleanAnsi()` → split-on-`\n` pipeline

Wherever the WebSocket `onmessage` handler currently does something like:

```js
socket.onmessage = (evt) => {
  const clean = cleanAnsi(evt.data);
  clean.split('\n').forEach(line => appendOutputLine(line));
};
```

Replace it with:

```js
const termState = TerminalState.createTerminalState();

socket.onmessage = (evt) => {
  const events = TerminalState.processChunk(termState, evt.data);
  for (const ev of events) {
    if (ev.type === 'line-committed') {
      appendOutputLine(ev.line);      // your existing .output-line creation
    } else if (ev.type === 'line-updated') {
      renderCurrentLine(ev.line);     // new — see step 3
    }
  }
};
```

`appendOutputLine` can stay almost as-is — `ev.line.text` replaces the old cleaned line string, and `ev.line.kind` ('prompt' | 'output' | 'error') is available if you want to style or announce differently.

## 3. Replace the `<textarea>` with a cursor-aware current-line view

The textarea was doing double duty: capturing keystrokes *and* displaying PTY-driven redraws. Split those:

- Keep a plain (possibly visually hidden) `<input>` or key-event listener purely for **capturing** keystrokes and forwarding them to the PTY over the WebSocket, exactly as today.
- Add a small `renderCurrentLine(line)` that writes `line.text` into a display element and positions a visual caret at `line.cursorCol` (e.g. splitting the text into two spans around the cursor, or using a `<span class="cursor">` between them). This element is *never* edited directly by the browser — it only ever reflects what `processChunk` computed from the PTY's own bytes.

This is what eliminates the flash-then-vanish bug: there's no longer a second, independently-drifting copy of the line living in browser textarea state.

## 4. Screen-reader / Braille layer

`ev.line.kind` and the committed-line list are exactly what your existing JAWS-announcement and Braille-navigation code already consumes — no changes needed there beyond swapping the data source.

## 5. Verify against your actual PTY output before trusting it

Windows PowerShell vs. `pwsh` (and different PSReadLine versions) can differ slightly in the exact redraw sequence. Before relying on this:

```js
socket.onmessage = (evt) => console.log(JSON.stringify(evt.data));
```

Reproduce the Up-arrow bug once with that logging in place and confirm the bytes match the assumption in `terminal-state.js` (CR/CHA + EL + text, no `\n` until Enter). If PSReadLine is using a different op — e.g. `CSI n @` (insert char) instead of full-line erase+retype — add that case to the `switch` in `processChunk`.

## Known gaps (intentionally out of scope for this pass)

- **SGR (color) codes** are parsed and swallowed but not tracked — text renders in a single color for now. Add a `sgrState` field to `EditableLine`/`CommittedLine` if you want colored output next.
- **Mid-line insert/delete** (`CSI n @` / `CSI n P`) isn't handled — only whole-line erase (`CSI K`). If editing in the middle of a long command (e.g. Home, then typing) still misbehaves, this is why.
- **Alternate screen** (`vim`/`less`/`htop`) is untouched — that's Phase 2/3 territory per the original architecture doc, not this module.
