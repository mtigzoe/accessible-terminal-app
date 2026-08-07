#!/usr/bin/env node
/**
 * nlsh — natural-language shell powered by local Ollama.
 * TypeScript port of nlshv2.py.
 *
 * Usage:
 *   npx ts-node src/nlsh.ts
 *   npm run nlsh
 *
 * Requires Ollama running (https://ollama.com) and at least one model, e.g.:
 *   ollama pull llama3.2
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';

const ENV_PATH = path.join(process.cwd(), '.env');
const MAX_HISTORY = 10;
const MAX_CONTEXT_CHARS = 4000;

interface HistoryEntry {
  command: string;
  output: string;
}

const commandHistory: HistoryEntry[] = [];

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) {
    return;
  }
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) {
      process.env[key] = value;
    }
  }
}

function saveConfig(model: string, host: string): void {
  const body = `OLLAMA_MODEL=${model}\nOLLAMA_HOST=${host}\n`;
  fs.writeFileSync(ENV_PATH, body, 'utf8');
}

async function ollamaRequest(
  apiPath: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: Record<string, unknown>,
  timeoutMs = 10000
): Promise<unknown> {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const url = `${host}${apiPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    };
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(): Promise<string[]> {
  try {
    const data = (await ollamaRequest('/api/tags')) as {
      models?: Array<{ name?: string }>;
    };
    return (data.models || [])
      .map((m) => m.name || '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function completer(line: string): [string[], string] {
  const m = line.match(/(?:^|[\s;|&])([^\s;|&]*)$/);
  const token = m ? m[1] : line;

  const hits: string[] = [];

  const builtins = ['!model', '!help', '!cmd ', 'exit', 'quit', 'cd ', 'ls', 'pwd'];
  if (!line.includes(' ') || line.startsWith(token)) {
    for (const b of builtins) {
      if (b.startsWith(line) || b.startsWith(token)) {
        if (line.includes(' ')) {
          if (b.startsWith(token)) hits.push(b);
        } else if (b.startsWith(line)) {
          hits.push(b);
        }
      }
    }
  }

  let prefix = token;
  let dir = process.cwd();
  try {
    const sep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
    let dirPrefix = '';
    if (sep >= 0) {
      dirPrefix = prefix.slice(0, sep + 1);
      prefix = prefix.slice(sep + 1);
      const candidate = path.resolve(process.cwd(), dirPrefix);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        dir = candidate;
      } else {
        return [hits.length ? hits : [], token];
      }
    }

    const lower = prefix.toLowerCase();
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().startsWith(lower)) continue;
      let full = dirPrefix + name;
      try {
        if (fs.statSync(path.join(dir, name)).isDirectory()) {
          full += path.sep;
        }
      } catch {
        // ignore
      }
      hits.push(full);
    }
  } catch {
    // ignore
  }

  const unique = Array.from(new Set(hits));
  return [unique.length ? unique : [], token];
}

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer
  });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer || '').trim()));
  });
}

async function setupModel(rl: readline.Interface): Promise<void> {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  console.log(`\n\x1b[36mLooking for Ollama at: ${host}\x1b[0m`);

  const models = await listModels();
  let model: string;

  if (models.length === 0) {
    console.log('\x1b[31mCould not reach Ollama, or no models are installed yet.\x1b[0m');
    console.log('Make sure Ollama is running (https://ollama.com) and pull a model, e.g.:');
    console.log('  \x1b[36mollama pull llama3.2\x1b[0m\n');
    model = await question(rl, '\x1b[33mEnter the model name to use anyway:\x1b[0m ');
    if (!model) {
      console.log('No model provided.');
      process.exit(1);
    }
  } else {
    console.log('\n\x1b[1mAvailable models:\x1b[0m');
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    const choice = await question(
      rl,
      `\n\x1b[33mPick a model [1-${models.length}] or type a name:\x1b[0m `
    );
    if (/^\d+$/.test(choice)) {
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= models.length) {
        model = models[n - 1];
      } else {
        model = choice || models[0];
      }
    } else if (choice) {
      model = choice;
    } else {
      model = models[0];
    }
  }

  saveConfig(model, host);
  process.env.OLLAMA_MODEL = model;
  process.env.OLLAMA_HOST = host;
  console.log(`\x1b[32m✓ Using model: ${model}\x1b[0m\n`);
}

function showHelp(): void {
  console.log('\x1b[1mCommands\x1b[0m');
  console.log('\x1b[36m!model\x1b[0m          Change Ollama model');
  console.log('\x1b[36m!help\x1b[0m           Show this help');
  console.log('\x1b[36m!cmd <command>\x1b[0m  Run a shell command directly (skip AI)');
  console.log('\x1b[36m!<command>\x1b[0m      Same as !cmd — e.g. \x1b[36m!ls\x1b[0m, \x1b[36m!pwd\x1b[0m, \x1b[36m!git status\x1b[0m');
  console.log('\x1b[36mexit\x1b[0m / \x1b[36mquit\x1b[0m     Leave nlsh');
  console.log();
  console.log('Type natural language for AI translation, or a real shell command to run it as-is.');
  console.log('Press \x1b[36mTab\x1b[0m to complete file and folder names in the current directory.');
  console.log(
    'Interactive programs (e.g. python3 script.py) use the real terminal — type answers at their prompts.'
  );
  console.log();
}

function getContextSize(): number {
  return commandHistory.reduce(
    (sum, e) => sum + e.command.length + e.output.length,
    0
  );
}

function addToHistory(command: string, output = ''): void {
  commandHistory.push({
    command,
    output: output ? output.slice(0, 500) : ''
  });
  while (commandHistory.length > MAX_HISTORY) {
    commandHistory.shift();
  }
  while (getContextSize() > MAX_CONTEXT_CHARS && commandHistory.length > 1) {
    commandHistory.shift();
  }
}

function formatHistory(): string {
  if (commandHistory.length === 0) {
    return 'No previous commands.';
  }
  const lines: string[] = [];
  const recent = commandHistory.slice(-5);
  recent.forEach((entry, i) => {
    lines.push(`${i + 1}. $ ${entry.command}`);
    if (entry.output) {
      const outLines = entry.output.trim().split('\n').slice(0, 2);
      for (const line of outLines) {
        lines.push(`   ${line}`);
      }
    }
  });
  return lines.join('\n');
}

function shellDescription(): string {
  if (process.platform === 'win32') {
    return 'Windows PowerShell (pwsh / powershell)';
  }
  if (process.platform === 'darwin') {
    return 'macOS / zsh';
  }
  return 'Linux / bash';
}

async function getCommand(userInput: string, cwd: string): Promise<string> {
  const historyContext = formatHistory();
  const prompt = `You are a shell command translator. Convert the user's request into a single shell command for ${shellDescription()}.

Current directory: ${cwd}

Recent command history:
${historyContext}

Rules:
- Output ONLY the command, nothing else
- No explanations, no markdown, no backticks
- If unclear, make a reasonable assumption
- Prefer simple, common commands
- Use the command history for context (e.g. "do that again", "delete the file I just created")
- When creating or writing a file, prefer a robust method (not fragile nested quotes):
${
  process.platform === 'win32'
    ? `  - PowerShell: use Set-Content -Path file -Value @'
content here
'@  or Out-File
  - Prefer PowerShell cmdlets when appropriate (Get-ChildItem, Set-Location, etc.)`
    : `  - Bash: use a heredoc, e.g. cat > file.py << 'EOF'
code or text here
EOF
  - Single quotes around EOF prevent the shell from expanding $, backticks, etc.
  - Avoid echo "..." with nested quotes for multi-line or quote-heavy content`
}

User request: ${userInput}`;

  const model = process.env.OLLAMA_MODEL;
  if (!model) {
    throw new Error('OLLAMA_MODEL is not set. Run !model first.');
  }

  const data = (await ollamaRequest(
    '/api/generate',
    'POST',
    { model, prompt, stream: false },
    60000
  )) as { response?: string };

  let command = (data.response || '').trim();
  command = command
    .replace(/^```(?:bash|sh|shell|powershell|pwsh)?\s*/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  return command;
}

function isNaturalLanguage(text: string): boolean {
  if (text.startsWith('!')) {
    return false;
  }

  const shellCommands = new Set([
    'ls', 'pwd', 'clear', 'exit', 'quit', 'whoami', 'date', 'cal', 'top', 'htop',
    'history', 'which', 'man', 'touch', 'head', 'tail', 'grep', 'find', 'sort',
    'wc', 'diff', 'tar', 'zip', 'unzip', 'dir', 'cls', 'cd'
  ]);

  const shellStarters = [
    'cd ', 'ls ', 'dir ', 'echo ', 'cat ', 'type ', 'mkdir ', 'md ', 'rm ', 'del ',
    'cp ', 'copy ', 'mv ', 'move ', 'git ', 'npm ', 'node ', 'npx ', 'python', 'python3',
    'pip ', 'brew ', 'curl ', 'wget ', 'chmod ', 'chown ', 'sudo ', 'vi ', 'vim ',
    'nano ', 'code ', 'open ', 'export ', 'source ', 'docker ', 'kubectl ', 'aws ',
    'gcloud ', 'Get-', 'Set-', 'New-', 'Remove-', 'Write-', './', '.\\', '/', '~',
    '$', '>', '>>', '|', '&&'
  ];

  if (shellCommands.has(text)) {
    return false;
  }
  return !shellStarters.some((s) => text.startsWith(s));
}

function attachSigint(rl: readline.Interface): void {
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    try {
      rl.write(null, { ctrl: true, name: 'u' });
    } catch {
      // ignore
    }
  });
}

/**
 * Run a shell command on the real terminal.
 * After the child exits, drain leftover stdin and recreate readline so the
 * next prompt does not require an extra Enter.
 */
function runShell(
  cmd: string,
  session: { rl: readline.Interface }
): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const oldRl = session.rl;

    try {
      oldRl.pause();
    } catch {
      // ignore
    }
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    stdin.resume();

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    };

    const child = spawn(cmd, {
      cwd: process.cwd(),
      shell: defaultShell(),
      env,
      stdio: 'inherit'
    });

    const finish = (code: number | null) => {
      try {
        stdin.resume();
        const rs = stdin as NodeJS.ReadStream & { read?: () => unknown };
        if (typeof rs.read === 'function') {
          while (rs.read() !== null) {
            // discard leftover bytes from mode switch
          }
        }
      } catch {
        // ignore
      }

      try {
        oldRl.removeAllListeners();
        oldRl.close();
      } catch {
        // ignore
      }

      const next = createRl();
      attachSigint(next);
      session.rl = next;

      setImmediate(() => resolve({ code }));
    };

    child.on('error', (err) => {
      console.error(err.message);
      finish(1);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}

function tryChdir(target: string): void {
  const expanded =
    target === '~' || target.startsWith('~/') || target.startsWith('~\\')
      ? path.join(os.homedir(), target.slice(1).replace(/^[\\/]/, ''))
      : target;
  try {
    process.chdir(path.resolve(expanded));
  } catch (e) {
    console.log(`cd: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

  const session = { rl: createRl() };
  attachSigint(session.rl);

  const firstRun = !process.env.OLLAMA_MODEL;
  if (firstRun) {
    await setupModel(session.rl);
  }

  const model = process.env.OLLAMA_MODEL || '(none — type !model)';
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  console.log('\x1b[1mnlsh\x1b[0m — natural-language shell');
  console.log(`Ollama: ${host}  model: \x1b[32m${model}\x1b[0m\n`);
  showHelp();

  for (;;) {
    try {
      const cwd = process.cwd();
      const base = path.basename(cwd) || cwd;
      const userInput = await question(session.rl, `\x1b[32m${base}\x1b[0m > `);

      if (!userInput) {
        continue;
      }

      if (userInput === 'exit' || userInput === 'quit') {
        session.rl.close();
        process.exit(0);
      }

      if (userInput === 'cd') {
        process.chdir(os.homedir());
        continue;
      }
      if (userInput.startsWith('cd ')) {
        tryChdir(userInput.slice(3).trim());
        continue;
      }

      if (userInput === '!model') {
        await setupModel(session.rl);
        continue;
      }

      if (userInput === '!help') {
        showHelp();
        continue;
      }

      if (userInput.startsWith('!')) {
        const cmd = userInput.slice(1).trim();
        if (!cmd) {
          continue;
        }
        const direct = cmd.toLowerCase().startsWith('cmd ')
          ? cmd.slice(4).trim()
          : cmd;
        if (!direct) {
          continue;
        }
        await runShell(direct, session);
        addToHistory(direct, '(interactive / live output)');
        continue;
      }

      if (!isNaturalLanguage(userInput)) {
        await runShell(userInput, session);
        addToHistory(userInput, '(interactive / live output)');
        continue;
      }

      const command = await getCommand(userInput, cwd);
      if (!command) {
        console.log('\x1b[31mModel returned an empty command.\x1b[0m');
        continue;
      }

      const confirm = await question(session.rl, `\x1b[33m→ ${command}\x1b[0m [Enter] `);
      if (confirm !== '') {
        continue;
      }

      if (command === 'cd' || command.startsWith('cd ')) {
        if (command === 'cd') {
          process.chdir(os.homedir());
        } else {
          tryChdir(command.slice(3).trim());
        }
        addToHistory(command, '');
        continue;
      }

      await runShell(command, session);
      addToHistory(command, '(interactive / live output)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/aborted|AbortError/i.test(msg)) {
        console.log(
          `\x1b[31mCould not reach Ollama at ${process.env.OLLAMA_HOST} — is it running?\x1b[0m`
        );
      } else if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
        console.log(
          `\x1b[31mCould not reach Ollama at ${process.env.OLLAMA_HOST} — is it running?\x1b[0m`
        );
      } else {
        console.log(`\x1b[31merror: ${msg.slice(0, 200)}\x1b[0m`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
