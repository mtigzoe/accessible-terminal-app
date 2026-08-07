import { execFile } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer, RawData } from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const app = express();
app.use(express.json({ limit: '64kb' }));
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

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

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
    const resolved = path.resolve(candidate.trim());
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

async function runComplete(
  line: string,
  cursor: number,
  cwd: string
): Promise<Omit<CompleteResult, 'type' | 'id'>> {
  try {
    if (process.platform === 'win32') {
      return await getPowerShellCompletions(line, cursor, cwd);
    }
    return getBasicPathCompletions(line, cursor, cwd);
  } catch (e) {
    return {
      replacementIndex: cursor,
      replacementLength: 0,
      matches: [],
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Tab completion is HTTP — never the shell WebSocket — so a complete request
 * cannot be mistaken for keystrokes and pasted into PowerShell.
 */
app.post('/api/complete', async (req, res) => {
  const line = typeof req.body?.line === 'string' ? req.body.line : '';
  const cursor = typeof req.body?.cursor === 'number' ? req.body.cursor : line.length;
  const cwd = resolveCwd(req.body?.cwd);
  const id = typeof req.body?.id === 'number' ? req.body.id : null;

  const result = await runComplete(line, cursor, cwd);
  const payload: CompleteResult = {
    type: 'completeResult',
    id,
    replacementIndex: result.replacementIndex,
    replacementLength: result.replacementLength,
    matches: result.matches,
    error: result.error
  };
  res.json(payload);
});

/** Proxy helpers so the browser can talk to Ollama without CORS issues. */
async function fetchOllama(apiPath: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${OLLAMA_HOST}${apiPath}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/ollama/status', async (_req, res) => {
  try {
    const r = await fetchOllama('/api/tags');
    if (!r.ok) {
      res.json({
        ok: false,
        host: OLLAMA_HOST,
        error: `Ollama returned HTTP ${r.status}`
      });
      return;
    }
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models || []).map((m) => m.name || '').filter(Boolean);
    res.json({ ok: true, host: OLLAMA_HOST, modelCount: models.length, models });
  } catch (e) {
    res.json({
      ok: false,
      host: OLLAMA_HOST,
      error: e instanceof Error ? e.message : String(e)
    });
  }
});

app.get('/api/ollama/models', async (_req, res) => {
  try {
    const r = await fetchOllama('/api/tags');
    if (!r.ok) {
      res.status(502).json({
        ok: false,
        host: OLLAMA_HOST,
        models: [],
        error: `Ollama returned HTTP ${r.status}`
      });
      return;
    }
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models || []).map((m) => m.name || '').filter(Boolean);
    res.json({ ok: true, host: OLLAMA_HOST, models });
  } catch (e) {
    res.status(503).json({
      ok: false,
      host: OLLAMA_HOST,
      models: [],
      error: e instanceof Error ? e.message : String(e)
    });
  }
});

function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

/** Escape a path for use inside a single-quoted PowerShell string. */
function psSingleQuoted(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

wss.on('connection', (ws: WebSocket) => {
  let ptyProcess: any = null;

  function buildShellArgs(cwd: string): string[] {
    if (process.platform !== 'win32') {
      return [];
    }
    return [
      '-NoLogo',
      '-NoExit',
      '-WorkingDirectory',
      cwd,
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      shellIntegrationScript
    ];
  }

  function spawnPty(cwd: string) {
    const resolved = resolveCwd(cwd);
    ptyProcess = pty.spawn(shell, buildShellArgs(resolved), {
      name: 'xterm-color',
      cols: 90,
      rows: 24,
      cwd: resolved,
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
  }

  function forceSetLocation(target: string) {
    if (!ptyProcess) {
      return;
    }
    const resolved = resolveCwd(target);
    const cmd =
      'Set-Location -LiteralPath ' +
      psSingleQuoted(resolved) +
      '\r';
    ptyProcess.write(cmd);
  }

  ws.on('message', (raw: RawData) => {
    const text = rawDataToString(raw);

    if (text.length > 0 && text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text) as {
          type?: string;
          cols?: number;
          rows?: number;
          cwd?: string;
          path?: string;
        };

        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          if (
            parsed.type === 'resize' &&
            typeof parsed.cols === 'number' &&
            typeof parsed.rows === 'number'
          ) {
            if (ptyProcess) {
              ptyProcess.resize(parsed.cols, parsed.rows);
            }
            return;
          }

          if (parsed.type === 'cwd') {
            const target =
              typeof parsed.cwd === 'string'
                ? parsed.cwd
                : typeof parsed.path === 'string'
                  ? parsed.path
                  : '';

            if (target) {
              if (!ptyProcess) {
                spawnPty(target);
              } else {
                forceSetLocation(target);
              }
            } else if (!ptyProcess) {
              spawnPty(defaultCwd);
            }
            return;
          }

          return;
        }
      } catch {
        // Not valid JSON — treat as shell text below.
      }
    }

    if (!ptyProcess) {
      spawnPty(defaultCwd);
    }

    ptyProcess!.write(text);
  });

  ws.on('close', () => {
    if (ptyProcess) {
      ptyProcess.kill();
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

server.listen(PORT, () => {
  console.log(`Accessible terminal running at http://localhost:${PORT}`);
  console.log(`Shell: ${shell}   Working directory: ${defaultCwd}`);
  console.log(`Ollama proxy: ${OLLAMA_HOST}  (GET /api/ollama/status, /api/ollama/models)`);
});
