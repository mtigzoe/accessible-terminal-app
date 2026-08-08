import { execFile, spawn } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer, RawData } from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'pwsh.exe' : process.env.SHELL || 'bash';
const defaultCwd = os.homedir();
const shellIntegrationScript = path.join(__dirname, '..', 'shell-integration', 'pwsh-integration.ps1');
const shellIntegrationScriptBash = path.join(__dirname, '..', 'shell-integration', 'bash-integration.sh');
let OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || '';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

interface CompleteResult { type: 'completeResult'; id: number | null; replacementIndex: number; replacementLength: number; matches: string[]; error?: string; }

function resolveCwd(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) return defaultCwd;
  try { const resolved = path.resolve(candidate.trim()); if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved; } catch {}
  return defaultCwd;
}

function getPowerShellCompletions(line: string, cursor: number, cwd: string): Promise<Omit<CompleteResult, 'type' | 'id'>> {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const lineB64 = Buffer.from(line, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${lineB64}'))
$cursor = ${safeCursor}
try {
  $r = TabExpansion2 -inputScript $line -cursorColumn $cursor
  $matches = @($r.CompletionMatches | ForEach-Object { [string]$_.CompletionText })
  @{ replacementIndex = [int]$r.ReplacementIndex; replacementLength = [int]$r.ReplacementLength; matches = $matches } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ replacementIndex = $cursor; replacementLength = 0; matches = @(); error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`.trim();
  return new Promise((resolve) => {
    execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd, timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: process.env }, (err, stdout) => {
      if (err && !stdout) { resolve({ replacementIndex: safeCursor, replacementLength: 0, matches: [], error: err.message }); return; }
      const text = (stdout || '').trim();
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) { resolve({ replacementIndex: safeCursor, replacementLength: 0, matches: parsed.map(String) }); return; }
        if (parsed && typeof parsed === 'object') {
          let matches: string[] = Array.isArray(parsed.matches) ? parsed.matches.map(String) : typeof parsed.matches === 'string' ? [parsed.matches] : [];
          resolve({ replacementIndex: Number(parsed.replacementIndex) || 0, replacementLength: Number(parsed.replacementLength) || 0, matches, error: typeof parsed.error === 'string' ? parsed.error : undefined }); return;
        }
      } catch {}
      resolve({ replacementIndex: safeCursor, replacementLength: 0, matches: [], error: text ? 'Could not parse completion result.' : (err ? err.message : 'No completions.') });
    });
  });
}

function getBasicPathCompletions(line: string, cursor: number, cwd: string): Omit<CompleteResult, 'type' | 'id'> {
  const before = line.slice(0, cursor); const match = before.match(/(?:^|[\s|;])([^\s|;]*)$/);
  if (!match) return { replacementIndex: cursor, replacementLength: 0, matches: [] };
  const token = match[1]; const replacementIndex = cursor - token.length; const replacementLength = token.length;
  let dirToList = cwd; let prefix = token;
  const sep = token.lastIndexOf('/') >= token.lastIndexOf('\\') ? token.lastIndexOf('/') : token.lastIndexOf('\\');
  if (sep >= 0) { const dirPart = token.slice(0, sep + 1); prefix = token.slice(sep + 1); const candidate = path.resolve(cwd, dirPart); if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) dirToList = candidate; else return { replacementIndex, replacementLength, matches: [] }; }
  let entries: string[] = []; try { entries = fs.readdirSync(dirToList); } catch { return { replacementIndex, replacementLength, matches: [] }; }
  const lower = prefix.toLowerCase();
  const matches = entries.filter((name) => name.toLowerCase().startsWith(lower)).map((name) => { const full = path.join(dirToList, name); let completion = token.slice(0, token.length - prefix.length) + name; try { if (fs.statSync(full).isDirectory()) completion += path.sep; } catch {} return completion; }).slice(0, 50);
  return { replacementIndex, replacementLength, matches };
}

async function runComplete(line: string, cursor: number, cwd: string): Promise<Omit<CompleteResult, 'type' | 'id'>> {
  try { return isWindows ? await getPowerShellCompletions(line, cursor, cwd) : getBasicPathCompletions(line, cursor, cwd); }
  catch (e) { return { replacementIndex: cursor, replacementLength: 0, matches: [], error: e instanceof Error ? e.message : String(e) }; }
}

app.post('/api/complete', async (req, res) => {
  const line = typeof req.body?.line === 'string' ? req.body.line : '';
  const cursor = typeof req.body?.cursor === 'number' ? req.body.cursor : line.length;
  const cwd = resolveCwd(req.body?.cwd); const id = typeof req.body?.id === 'number' ? req.body.id : null;
  const result = await runComplete(line, cursor, cwd);
  res.json({ type: 'completeResult', id, replacementIndex: result.replacementIndex, replacementLength: result.replacementLength, matches: result.matches, error: result.error });
});

const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
app.get('/api/file', (req, res) => {
  const cwd = resolveCwd(req.query.cwd); const target = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!target) { res.status(400).json({ ok: false, error: 'Missing path.' }); return; }
  const resolved = path.resolve(cwd, target);
  try {
    if (!fs.existsSync(resolved)) { res.json({ ok: true, path: resolved, content: '', isNew: true }); return; }
    const stat = fs.statSync(resolved); if (stat.isDirectory()) { res.status(400).json({ ok: false, error: resolved + ' is a directory, not a file.' }); return; }
    if (stat.size > MAX_EDIT_FILE_BYTES) { res.status(413).json({ ok: false, error: 'File is larger than 2 MB -- open it in the full console instead.' }); return; }
    res.json({ ok: true, path: resolved, content: fs.readFileSync(resolved, 'utf8'), isNew: false });
  } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
});
app.post('/api/file', (req, res) => {
  const cwd = resolveCwd(req.body?.cwd); const target = typeof req.body?.path === 'string' ? req.body.path.trim() : ''; const content = typeof req.body?.content === 'string' ? req.body.content : null;
  if (!target) { res.status(400).json({ ok: false, error: 'Missing path.' }); return; }
  if (content === null) { res.status(400).json({ ok: false, error: 'Missing content.' }); return; }
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_FILE_BYTES) { res.status(413).json({ ok: false, error: 'Content is larger than 2 MB.' }); return; }
  const resolved = path.resolve(cwd, target);
  try {
    const parentDir = path.dirname(resolved); if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) { res.status(400).json({ ok: false, error: 'Directory does not exist: ' + parentDir }); return; }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) { res.status(400).json({ ok: false, error: resolved + ' is a directory, not a file.' }); return; }
    fs.writeFileSync(resolved, content, 'utf8'); res.json({ ok: true, path: resolved });
  } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
});

function normalizeOllamaHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

async function fetchOllama(apiPath: string, init?: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(`${OLLAMA_HOST}${apiPath}`, { ...init, signal: controller.signal }); }
  catch (e) { if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message))) throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s at ${OLLAMA_HOST}. The model may be slow to load or busy.`); throw e; }
  finally { clearTimeout(timer); }
}

app.get('/api/ollama/config', (_req, res) => {
  res.json({ ok: true, host: OLLAMA_HOST });
});

app.post('/api/ollama/config', async (req, res) => {
  const host = normalizeOllamaHost(req.body?.host);
  if (!host) { res.status(400).json({ ok: false, error: 'Enter a valid Ollama server address, such as http://cyber.local:11434.' }); return; }
  const previous = OLLAMA_HOST;
  OLLAMA_HOST = host;
  try {
    const r = await fetchOllama('/api/tags', undefined, 5000);
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}.`);
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models || []).map((m) => m.name || '').filter(Boolean);
    res.json({ ok: true, host: OLLAMA_HOST, modelCount: models.length, models, message: `Connected to ${OLLAMA_HOST}.` });
  } catch (e) {
    OLLAMA_HOST = previous;
    res.status(502).json({ ok: false, error: `Could not connect to ${host}. ${e instanceof Error ? e.message : String(e)}` });
  }
});

app.get('/api/ollama/status', async (_req, res) => {
  try { const r = await fetchOllama('/api/tags'); if (!r.ok) { res.json({ ok: false, host: OLLAMA_HOST, error: `Ollama returned HTTP ${r.status}` }); return; }
    const data = (await r.json()) as { models?: Array<{ name?: string }> }; const models = (data.models || []).map((m) => m.name || '').filter(Boolean); res.json({ ok: true, host: OLLAMA_HOST, modelCount: models.length, models });
  } catch (e) { res.json({ ok: false, host: OLLAMA_HOST, error: e instanceof Error ? e.message : String(e) }); }
});
app.get('/api/ollama/models', async (_req, res) => {
  try { const r = await fetchOllama('/api/tags'); if (!r.ok) { res.status(502).json({ ok: false, host: OLLAMA_HOST, models: [], error: `Ollama returned HTTP ${r.status}` }); return; }
    const data = (await r.json()) as { models?: Array<{ name?: string; size?: number; modified_at?: string }> };
    const models = (data.models || []).map((m) => ({ name: m.name || '', size: m.size || 0, modifiedAt: m.modified_at || '' })).filter((m) => m.name);
    res.json({ ok: true, host: OLLAMA_HOST, models });
  } catch (e) { res.status(503).json({ ok: false, host: OLLAMA_HOST, models: [], error: e instanceof Error ? e.message : String(e) }); }
});
app.get('/api/ollama/setup-hints', (_req, res) => {
  const platform = process.platform; const downloadUrl = 'https://ollama.com/download'; let title = 'Install Ollama'; let steps: string[] = []; let commands: string[] = [];
  if (platform === 'win32') { title = 'Install Ollama on Windows'; steps = ['Download and run the installer from the official site.', 'Start Ollama, then return here and refresh the model list.']; commands = ['winget install Ollama.Ollama']; }
  else if (platform === 'darwin') { title = 'Install Ollama on macOS'; steps = ['Download Ollama for macOS from the official site.', 'Start Ollama, then return here and refresh the model list.']; commands = ['brew install ollama']; }
  else { title = 'Install Ollama on Linux'; steps = ['Install Ollama from the official site or package instructions.', 'Start Ollama, then return here and refresh the model list.']; commands = ['curl -fsSL https://ollama.com/install.sh | sh']; }
  res.json({ ok: true, platform, host: OLLAMA_HOST, downloadUrl, title, steps, commands });
});

function validModelName(model: unknown): model is string { return typeof model === 'string' && /^[a-zA-Z0-9._:/-]+$/.test(model.trim()) && model.trim().length <= 128; }

app.post('/api/ollama/pull', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) { res.status(400).json({ ok: false, error: 'Missing model name.' }); return; }
  if (!validModelName(model)) { res.status(400).json({ ok: false, error: 'Invalid model name. Use a name like llama3.2 or qwen3.5:9b.' }); return; }
  try {
    const r = await fetchOllama('/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false }) }, 30 * 60 * 1000);
    const body = await r.text();
    if (!r.ok) { res.status(502).json({ ok: false, model, error: `Ollama HTTP ${r.status}`, output: body.slice(-2000) }); return; }
    res.json({ ok: true, model, message: `Installed ${model}.`, output: body.slice(-2000) });
  } catch (e) { res.status(503).json({ ok: false, model, error: e instanceof Error ? e.message : String(e) }); }
});

app.delete('/api/ollama/models/:model', async (req, res) => {
  const model = decodeURIComponent(req.params.model || '').trim();
  if (!validModelName(model)) { res.status(400).json({ ok: false, error: 'Invalid model name.' }); return; }
  try {
    const r = await fetchOllama('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }, 30000);
    const body = await r.text(); if (!r.ok) { res.status(502).json({ ok: false, model, error: `Ollama HTTP ${r.status}`, output: body.slice(-1000) }); return; }
    res.json({ ok: true, model, message: `Removed ${model}.` });
  } catch (e) { res.status(503).json({ ok: false, model, error: e instanceof Error ? e.message : String(e) }); }
});

function shellDescription(): string { if (isWindows) return 'Windows PowerShell (pwsh)'; if (process.platform === 'darwin') return 'macOS / zsh or bash'; return 'Linux / bash'; }
app.post('/api/nlsh/translate', async (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : ''; const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim() ? req.body.cwd.trim() : defaultCwd; const model = (typeof req.body?.model === 'string' && req.body.model.trim()) || DEFAULT_OLLAMA_MODEL;
  if (!input) { res.status(400).json({ ok: false, error: 'Missing input.' }); return; }
  if (!model) { res.status(400).json({ ok: false, error: 'No Ollama model selected. Choose one in Settings.' }); return; }
  const prompt = `You are a shell command translator. Convert the user's request into a single shell command for ${shellDescription()}.\n\nCurrent directory: ${cwd}\n\nRules:\n- Output ONLY the command, nothing else\n- No explanations, no markdown, no backticks\n- If unclear, make a reasonable assumption\n- Prefer simple, common commands\n${isWindows ? '- Prefer PowerShell cmdlets when appropriate (Get-ChildItem, Set-Location, Get-Location, etc.)' : '- Prefer standard POSIX tools (pwd, ls, cd, etc.)'}\n\nUser request: ${input}`;
  try {
    const r = await fetchOllama('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt, stream: false }) }, 180000);
    if (!r.ok) { const body = await r.text().catch(() => ''); res.status(502).json({ ok: false, error: `Ollama HTTP ${r.status}: ${body.slice(0, 200)}` }); return; }
    const data = (await r.json()) as { response?: string }; let command = (data.response || '').trim();
    command = command.replace(/^```(?:bash|sh|powershell|pwsh)?\s*/i, '').replace(/```$/i, '').replace(/^(?:command|cmd)\s*[:=]\s*/i, '').trim().split('\n')[0].trim();
    if (!command) { res.json({ ok: false, error: 'Model returned an empty command.' }); return; }
    res.json({ ok: true, command, model });
  } catch (e) { res.status(503).json({ ok: false, error: e instanceof Error ? e.message : 'Could not reach Ollama.' }); }
});

function rawDataToString(raw: RawData): string { if (typeof raw === 'string') return raw; if (Buffer.isBuffer(raw)) return raw.toString('utf8'); if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8'); return Buffer.from(raw).toString('utf8'); }
function psSingleQuoted(value: string): string { return "'" + value.replace(/'/g, "''") + "'"; }
function shSingleQuoted(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

wss.on('connection', (ws: WebSocket) => {
  let ptyProcess: any = null; let clientMode: 'accessible' | 'full' = 'full';
  function buildShellArgs(cwd: string): string[] {
    if (isWindows) return ['-NoLogo', '-NoExit', '-WorkingDirectory', cwd, '-ExecutionPolicy', 'Bypass', '-File', shellIntegrationScript];
    if (path.basename(shell) === 'bash') return ['--rcfile', shellIntegrationScriptBash, '-i'];
    return [];
  }
  function spawnPty(cwd: string) {
    const resolved = resolveCwd(cwd); const env: NodeJS.ProcessEnv = { ...process.env };
    if (clientMode === 'accessible') { env.PAGER = env.PAGER || 'cat'; env.GIT_PAGER = env.GIT_PAGER || 'cat'; env.MANPAGER = env.MANPAGER || 'cat'; }
    ptyProcess = pty.spawn(shell, buildShellArgs(resolved), { name: 'xterm-color', cols: 90, rows: 24, cwd: resolved, env });
    ptyProcess.onData((data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    ptyProcess.onExit(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
  }
  function forceSetLocation(target: string) { if (!ptyProcess) return; const resolved = resolveCwd(target); if (isWindows) ptyProcess.write('Set-Location -LiteralPath ' + psSingleQuoted(resolved) + '\r'); else ptyProcess.write('cd ' + shSingleQuoted(resolved) + '\n'); }
  ws.on('message', (raw: RawData) => {
    const text = rawDataToString(raw);
    if (text.length > 0 && text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text) as { type?: string; cols?: number; rows?: number; cwd?: string; path?: string; mode?: string };
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') { if (ptyProcess) ptyProcess.resize(parsed.cols, parsed.rows); return; }
          if (parsed.type === 'cwd') { if (parsed.mode === 'accessible') clientMode = 'accessible'; const target = typeof parsed.cwd === 'string' ? parsed.cwd : typeof parsed.path === 'string' ? parsed.path : ''; if (target) { if (!ptyProcess) spawnPty(target); else forceSetLocation(target); } else if (!ptyProcess) spawnPty(defaultCwd); return; }
          return;
        }
      } catch {}
    }
    if (!ptyProcess) spawnPty(defaultCwd); ptyProcess!.write(text);
  });
  ws.on('close', () => { if (ptyProcess) ptyProcess.kill(); });
});

server.listen(PORT, HOST, () => { console.log(`Accessible terminal running at http://localhost:${PORT}`); console.log(`Bind: ${HOST}:${PORT}  platform: ${process.platform}`); console.log(`Shell: ${shell}   Working directory: ${defaultCwd}`); console.log(`Ollama proxy: ${OLLAMA_HOST}`); });
