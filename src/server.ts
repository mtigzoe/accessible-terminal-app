import { execFile } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// On Windows, use PowerShell 7 (pwsh.exe). It is resolved from PATH.
// On Linux/macOS, use the user's default shell.
const shell = process.platform === 'win32'
  ? 'pwsh.exe'
  : process.env.SHELL || 'bash';

const defaultCwd = os.homedir();

// On Windows, load the shell-integration script so the browser can detect
// command success/failure via OSC 633 markers.
const shellIntegrationScript = path.join(__dirname, '..', 'shell-integration', 'pwsh-integration.ps1');

const shellArgs = process.platform === 'win32'
  ? ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', shellIntegrationScript]
  : [];

interface CompleteRequest {
  type: 'complete';
  id?: number;
  line?: string;
  cursor?: number;
  cwd?: string;
}

interface CompleteResult {
  type: 'completeResult';
  id: number | null;
  replacementIndex: number;
  replacementLength: number;
  matches: string[];
  error?: string;
}

function resolveCwd(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return defaultCwd;
  }
  try {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    // fall through
  }
  return defaultCwd;
}

/**
 * Tab completion via PowerShell's TabExpansion2, run in a short-lived process
 * at the client's current path — does not touch the interactive PTY session.
 */
function getPowerShellCompletions(
  line: string,
  cursor: number,
  cwd: string
): Promise<Omit<CompleteResult, 'type' | 'id'>> {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const lineB64 = Buffer.from(line, 'utf8').toString('base64');

  // Line is base64 so user text cannot break out of the script string.
  const script = `
$ErrorActionPreference = 'Stop'
$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${lineB64}'))
$cursor = ${safeCursor}
try {
  $r = TabExpansion2 -inputScript $line -cursorColumn $cursor
  $matches = @(
    $r.CompletionMatches | ForEach-Object { [string]$_.CompletionText }
  )
  @{
    replacementIndex = [int]$r.ReplacementIndex
    replacementLength = [int]$r.ReplacementLength
    matches = $matches
  } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{
    replacementIndex = $cursor
    replacementLength = 0
    matches = @()
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
}
`.trim();

  return new Promise((resolve) => {
    execFile(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        cwd,
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        env: process.env
      },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({
            replacementIndex: safeCursor,
            replacementLength: 0,
            matches: [],
            error: err.message
          });
          return;
        }

        const text = (stdout || '').trim();
        // TabExpansion2 / ConvertTo-Json may emit a bare string or an object.
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            resolve({
              replacementIndex: safeCursor,
              replacementLength: 0,
              matches: parsed.map(String)
            });
            return;
          }
          if (parsed && typeof parsed === 'object') {
            // ConvertTo-Json turns a single-element array into a bare string.
            let matches: string[] = [];
            if (Array.isArray(parsed.matches)) {
              matches = parsed.matches.map(String);
            } else if (typeof parsed.matches === 'string') {
              matches = [parsed.matches];
            }
            resolve({
              replacementIndex: Number(parsed.replacementIndex) || 0,
              replacementLength: Number(parsed.replacementLength) || 0,
              matches,
              error: typeof parsed.error === 'string' ? parsed.error : undefined
            });
            return;
          }
        } catch {
          // fall through
        }

        resolve({
          replacementIndex: safeCursor,
          replacementLength: 0,
          matches: [],
          error: text ? 'Could not parse completion result.' : (err ? err.message : 'No completions.')
        });
      }
    );
  });
}

/** Very small path-segment completion for non-Windows shells. */
function getBasicPathCompletions(
  line: string,
  cursor: number,
  cwd: string
): Omit<CompleteResult, 'type' | 'id'> {
  const before = line.slice(0, cursor);
  const match = before.match(/(?:^|[\s|;])([^\s|;]*)$/);
  if (!match) {
    return { replacementIndex: cursor, replacementLength: 0, matches: [] };
  }

  const token = match[1];
  const replacementIndex = cursor - token.length;
  const replacementLength = token.length;

  let dirToList = cwd;
  let prefix = token;

  const sep = token.lastIndexOf('/') >= token.lastIndexOf('\\')
    ? token.lastIndexOf('/')
    : token.lastIndexOf('\\');

  if (sep >= 0) {
    const dirPart = token.slice(0, sep + 1);
    prefix = token.slice(sep + 1);
    const candidate = path.resolve(cwd, dirPart);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      dirToList = candidate;
    } else {
      return { replacementIndex, replacementLength, matches: [] };
    }
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirToList);
  } catch {
    return { replacementIndex, replacementLength, matches: [] };
  }

  const lower = prefix.toLowerCase();
  const matches = entries
    .filter((name) => name.toLowerCase().startsWith(lower))
    .map((name) => {
      const full = path.join(dirToList, name);
      let completion = token.slice(0, token.length - prefix.length) + name;
      try {
        if (fs.statSync(full).isDirectory()) {
          completion += path.sep;
        }
      } catch {
        // ignore
      }
      return completion;
    })
    .slice(0, 50);

  return { replacementIndex, replacementLength, matches };
}

async function handleComplete(ws: WebSocket, parsed: CompleteRequest): Promise<void> {
  const line = typeof parsed.line === 'string' ? parsed.line : '';
  const cursor = typeof parsed.cursor === 'number' ? parsed.cursor : line.length;
  const cwd = resolveCwd(parsed.cwd);
  const id = typeof parsed.id === 'number' ? parsed.id : null;

  let result: Omit<CompleteResult, 'type' | 'id'>;
  try {
    if (process.platform === 'win32') {
      result = await getPowerShellCompletions(line, cursor, cwd);
    } else {
      result = getBasicPathCompletions(line, cursor, cwd);
    }
  } catch (e) {
    result = {
      replacementIndex: cursor,
      replacementLength: 0,
      matches: [],
      error: e instanceof Error ? e.message : String(e)
    };
  }

  if (ws.readyState === WebSocket.OPEN) {
    const payload: CompleteResult = {
      type: 'completeResult',
      id,
      replacementIndex: result.replacementIndex,
      replacementLength: result.replacementLength,
      matches: result.matches,
      error: result.error
    };
    ws.send(JSON.stringify(payload));
  }
}

wss.on('connection', (ws: WebSocket) => {
  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-color',
    cols: 90,
    rows: 24,
    cwd: defaultCwd,
    env: process.env
  });

  ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  ws.on('message', (raw: Buffer) => {
    const text = raw.toString();
    let handledAsControlMessage = false;

    try {
      const parsed = JSON.parse(text);

      if (parsed && parsed.type === 'resize' && parsed.cols && parsed.rows) {
        ptyProcess.resize(parsed.cols, parsed.rows);
        handledAsControlMessage = true;
      } else if (parsed && parsed.type === 'complete') {
        handledAsControlMessage = true;
        void handleComplete(ws, parsed as CompleteRequest);
      }
    } catch {
      // Not JSON — normal command text, fall through and write it.
    }

    if (!handledAsControlMessage) {
      ptyProcess.write(text);
    }
  });

  ws.on('close', () => {
    ptyProcess.kill();
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

server.listen(PORT, () => {
  console.log(`Accessible terminal running at http://localhost:${PORT}`);
  console.log(`Shell: ${shell}   Working directory: ${defaultCwd}`);
});
