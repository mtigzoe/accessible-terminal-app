/**
 * terminal-state.js
 * ------------------
 * Phase 1 terminal state model for interactive-console.html.
 *
 * Replaces the append-only "cleanAnsi() -> split on \n -> static lines"
 * pipeline with a small state machine that models:
 *   - a live, in-place-editable "current" line (cursor + text)
 *   - an append-only list of "committed" lines (what your existing
 *     .output-line / search / navigation code already expects)
 *
 * Why this fixes the Up-arrow / Tab "appears then disappears" bug:
 * PSReadLine redraws the prompt line using CR + erase-line + cursor
 * positioning, with NO trailing \n. Real command output always ends in
 * \n. So "\n" is the only signal we need to decide when a line is
 * final vs. still being edited - no heuristics required.
 *
 * Only 5 VT ops are handled on purpose (see design notes in
 * INTEGRATION.md): CHA (col), CUB (left), CUF (right), EL (erase line),
 * plus CR and NL. Everything else (colors/SGR, OSC titles/links, other
 * CSI codes) is recognized and swallowed so it never leaks into visible
 * text, but doesn't otherwise affect state yet. Extend the switch
 * statement below when you get to Phase 2.
 *
 * Usage (see bottom of file and INTEGRATION.md for a fuller example):
 *
 *   const state = TerminalState.createTerminalState();
 *   socket.onmessage = (evt) => {
 *     const events = TerminalState.processChunk(state, evt.data);
 *     for (const ev of events) {
 *       if (ev.type === 'line-committed') appendOutputLine(ev.line);
 *       if (ev.type === 'line-updated') renderCurrentLine(ev.line);
 *     }
 *   };
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TerminalState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ESC = '\x1b';

  /**
   * @typedef {{ text: string, cursorCol: number }} EditableLine
   * @typedef {{ id: number, text: string, kind: 'prompt'|'output'|'error', timestamp: number }} CommittedLine
   * @typedef {{ committed: CommittedLine[], current: EditableLine, nextId: number }} TermState
   */

  /** @returns {TermState} */
  function createTerminalState() {
    return {
      committed: [],
      current: { text: '', cursorCol: 0 },
      nextId: 1,
    };
  }

  /**
   * Very rough line classifier for styling / screen-reader phrasing.
   * Tune the prompt regex to match your actual PowerShell prompt format.
   * @param {string} text
   * @returns {'prompt'|'output'|'error'}
   */
  function classifyLine(text) {
    if (/^PS [A-Za-z]:\\.*>\s*/.test(text)) return 'prompt';
    if (/^(Error|Exception|.*: The term .* is not recognized)/i.test(text)) return 'error';
    return 'output';
  }

  /**
   * Feed one raw chunk of PTY output (as received from the WebSocket)
   * into the state machine. Mutates `state` in place and returns the
   * list of events produced, in order.
   *
   * @param {TermState} state
   * @param {string} chunkStr
   * @returns {Array<{type: 'line-committed', line: CommittedLine} | {type: 'line-updated', line: EditableLine}>}
   */
  function processChunk(state, chunkStr) {
    const events = [];
    const len = chunkStr.length;
    let i = 0;
    let lineChanged = false;

    function commitCurrentLine() {
      const committedLine = {
        id: state.nextId++,
        text: state.current.text,
        kind: classifyLine(state.current.text),
        timestamp: Date.now(),
      };
      state.committed.push(committedLine);
      events.push({ type: 'line-committed', line: committedLine });
      state.current = { text: '', cursorCol: 0 };
      lineChanged = false;
    }

    while (i < len) {
      const ch = chunkStr[i];

      // Newline - commits the current line. This is the ONLY commit signal.
      if (ch === '\n') {
        commitCurrentLine();
        i++;
        continue;
      }

      // Carriage return - move cursor to column 0 (start of a redraw).
      if (ch === '\r') {
        state.current.cursorCol = 0;
        lineChanged = true;
        i++;
        continue;
      }

      // Backspace / DEL - delete the character before the cursor.
      if (ch === '\b' || ch === '\x7f') {
        if (state.current.cursorCol > 0) {
          const col = state.current.cursorCol - 1;
          state.current.text =
            state.current.text.slice(0, col) + state.current.text.slice(col + 1);
          state.current.cursorCol = col;
          lineChanged = true;
        }
        i++;
        continue;
      }

      // Escape sequences.
      if (ch === ESC) {
        const rest = chunkStr.slice(i);

        // CSI sequence: ESC [ params letter   e.g. \x1b[12G  \x1b[0K  \x1b[3C
        const csiMatch = rest.match(/^\x1b\[([0-9;]*)([A-Za-z@])/);
        if (csiMatch) {
          const [full, paramStr, final] = csiMatch;
          const params = paramStr.split(';').filter(Boolean).map(Number);
          const n = params.length ? params[0] : 1;

          switch (final) {
            case 'G': // CHA - cursor to absolute column (1-indexed in VT)
              state.current.cursorCol = Math.max(0, n - 1);
              lineChanged = true;
              break;
            case 'C': // CUF - cursor forward
              state.current.cursorCol += n;
              lineChanged = true;
              break;
            case 'D': // CUB - cursor back
              state.current.cursorCol = Math.max(0, state.current.cursorCol - n);
              lineChanged = true;
              break;
            case 'K': { // EL - erase in line
              const mode = params.length ? params[0] : 0;
              const { text, cursorCol } = state.current;
              if (mode === 0) state.current.text = text.slice(0, cursorCol);
              else if (mode === 1) state.current.text = text.slice(cursorCol);
              else if (mode === 2) state.current.text = '';
              lineChanged = true;
              break;
            }
            default:
              // SGR ('m'), cursor position ('H'/'f'), insert/delete char
              // ('@'/'P'), and anything else: intentionally swallowed for
              // now so raw escape bytes never leak into visible text.
              // Add cases here for Phase 2 (see INTEGRATION.md).
              break;
          }

          i += full.length;
          continue;
        }

        // OSC sequence: ESC ] ... (terminated by BEL or ESC \) - e.g. window title.
        const oscMatch = rest.match(/^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/);
        if (oscMatch) {
          i += oscMatch[0].length;
          continue;
        }

        // Unrecognized escape byte - skip just it so we can't get stuck.
        i++;
        continue;
      }

      // Plain printable character - insert at the cursor position.
      {
        const col = state.current.cursorCol;
        state.current.text =
          state.current.text.slice(0, col) + ch + state.current.text.slice(col);
        state.current.cursorCol = col + 1;
        lineChanged = true;
        i++;
      }
    }

    if (lineChanged) {
      events.push({ type: 'line-updated', line: { ...state.current } });
    }

    return events;
  }

  return { createTerminalState, processChunk, classifyLine };
});

/* ---------------------------------------------------------------------
 * Minimal self-test. Run with `node terminal-state.js` to sanity-check
 * the reducer against a simulated PSReadLine redraw sequence. Safe to
 * delete once you've wired this into interactive-console.html.
 * ------------------------------------------------------------------- */
if (typeof require !== 'undefined' && require.main === module) {
  const { createTerminalState, processChunk } = module.exports;
  const state = createTerminalState();

  // Simulate: user types "cd per", then presses Tab, PSReadLine redraws
  // the line in place as "cd Personal\" via CR + erase-line + text.
  let events = processChunk(state, 'PS C:\\Users\\Miriam> cd per');
  console.log('after typing:', state.current);

  events = processChunk(state, '\r\x1b[0KPS C:\\Users\\Miriam> cd Personal\\');
  console.log('after tab-complete redraw:', state.current);
  console.assert(
    state.current.text === 'PS C:\\Users\\Miriam> cd Personal\\',
    'FAIL: redraw did not replace the line in place'
  );

  events = processChunk(state, '\r\n');
  console.log('committed:', state.committed);
  console.assert(state.committed.length === 1, 'FAIL: line was not committed on \\n');
  console.assert(state.current.text === '', 'FAIL: current line did not reset after commit');

  console.log('All checks passed.');
}
