import express from 'express';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
// Serve xterm.js's own css/lib files locally so the page doesn't depend on a CDN.
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// On Windows, use PowerShell 7 (pwsh.exe). It is resolved from PATH.
// On Linux/macOS, use the user's default shell.
const shell = process.platform === 'win32'
  ? 'pwsh.exe'
  : process.env.SHELL || 'bash';

const defaultCwd = os.homedir();

// On Windows, load the shell-integration script so the browser side can find
// command boundaries and success/failure (used by the accessible view's
// jump-to-previous/next-command navigation). -ExecutionPolicy Bypass only
// affects this one process, not the user's system-wide policy.
const shellIntegrationScript = path.join(__dirname, '..', 'shell-integration', 'pwsh-integration.ps1');

const shellArgs = process.platform === 'win32'
  ? ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', shellIntegrationScript]
  : [];

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
      }
    } catch {
      // Not JSON — this is normal keystroke data, fall through and write it.
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