(function () {
  const menuToggle = document.getElementById('menu-toggle');
  const menuPanel = document.getElementById('menu-panel');
  const menuItems = Array.prototype.slice.call(
    menuPanel.querySelectorAll('[role="menuitem"]')
  );

  function isMenuOpen() {
    return menuToggle.getAttribute('aria-expanded') === 'true';
  }

  function setMenuOpen(open, focusItemIndex) {
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuPanel.dataset.open = open ? 'true' : 'false';
    if (open) {
      const index =
        typeof focusItemIndex === 'number' && focusItemIndex >= 0
          ? focusItemIndex
          : 0;
      if (menuItems[index]) {
        menuItems[index].focus();
      }
    } else {
      menuToggle.focus();
    }
  }

  function focusMenuItem(index) {
    if (!menuItems.length) {
      return;
    }
    const n = menuItems.length;
    const i = ((index % n) + n) % n;
    menuItems[i].focus();
  }

  function currentMenuIndex() {
    const active = document.activeElement;
    return menuItems.indexOf(active);
  }

  menuToggle.addEventListener('click', function () {
    if (isMenuOpen()) {
      setMenuOpen(false);
    } else {
      setMenuOpen(true, 0);
    }
  });

  menuToggle.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setMenuOpen(true, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMenuOpen(true, menuItems.length - 1);
    }
  });

  menuPanel.addEventListener('keydown', function (event) {
    if (!isMenuOpen()) {
      return;
    }
    const idx = currentMenuIndex();

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusMenuItem(idx < 0 ? 0 : idx + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItem(idx < 0 ? menuItems.length - 1 : idx - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusMenuItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusMenuItem(menuItems.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
    } else if (event.key === 'Tab') {
      setMenuOpen(false);
    }
  });

  document.addEventListener('click', function (event) {
    if (!menuToggle.contains(event.target) && !menuPanel.contains(event.target)) {
      if (isMenuOpen()) {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuPanel.dataset.open = 'false';
      }
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isMenuOpen()) {
      event.preventDefault();
      setMenuOpen(false);
    }
  });

  const pathEl = document.getElementById('path-value');
  const outputEl = document.getElementById('output');
  const commandEl = document.getElementById('command');
  const formEl = document.getElementById('command-form');
  const runBtn = document.getElementById('run-btn');
  const stopBtn = document.getElementById('stop-btn');
  const clearBtn = document.getElementById('clear-btn');
  const srStatus = document.getElementById('sr-status');
  const srAlert = document.getElementById('sr-alert');
  const structuredPanel = document.getElementById('structured-panel');
  const structuredContent = document.getElementById('structured-content');

  const history = [];
  let historyIndex = -1;
  let draftBeforeHistory = '';

  let rawBuffer = '';
  let currentPath = '';
  let lastExitOk = true;
  let commandRunning = false;
  let ready = false;
  let pendingCommand = null;
  let restoredPath = null;
  let pathRestoreAttempted = false;

  let commandOutputChunks = [];

  let completionRequestId = 0;
  let completionPending = false;
  let applyingCompletion = false;
  const completion = {
    baseLine: '',
    replacementIndex: 0,
    replacementLength: 0,
    matches: [],
    index: 0
  };

  // PowerShell: PS C:\path>
  // Bash/zsh:   user@host:~/path$   or   user@host:/path#
  function matchPrompt(line) {
    var ps = line.match(/^PS\s+(.+?)(>+)\s*$/);
    if (ps) return ps[1];
    var bash = line.match(/^[\w.-]+@[\w.-]+:([^\s$#]+)[$#]\s*$/);
    if (bash) return bash[1];
    var simple = line.match(/^([/~][^\s$#]*)\s*[$#]\s*$/);
    if (simple) return simple[1];
    return null;
  }

  function announce(text) {
    srStatus.textContent = '';
    window.setTimeout(function () {
      srStatus.textContent = text;
    }, 100);
  }

  function announceAlert(text) {
    srAlert.textContent = '';
    window.setTimeout(function () {
      srAlert.textContent = text;
    }, 60);
  }

  function setControlsEnabled(enabled) {
    commandEl.disabled = !enabled;
    runBtn.disabled = !enabled;
    if (stopBtn) stopBtn.disabled = !enabled;
    clearBtn.disabled = !enabled;
  }

  function sendInterrupt() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      announce('Not connected.');
      return;
    }
    socket.send('\u0003');
    appendOutput('^C\n');
    announce('Sent interrupt (Ctrl+C).');
  }

  function sendStdin(text) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const line = text == null ? '' : String(text);
    appendOutput(line + '\n');
    socket.send(line + '\n');
  }

  function pathsEqual(a, b) {
    if (!a || !b) {
      return false;
    }
    const norm = function (p) {
      return String(p).replace(/[\\/]+$/, '').toLowerCase();
    };
    return norm(a) === norm(b);
  }

  function setPath(path) {
    if (!path || path === currentPath) {
      return;
    }
    currentPath = path;
    pathEl.textContent = path;
    try {
      localStorage.setItem('terminal-last-path', path);
    } catch {
    }
  }

  function restorePath() {
    try {
      const saved = localStorage.getItem('terminal-last-path');
      if (saved && saved.trim()) {
        restoredPath = saved.trim();
        currentPath = restoredPath;
        pathEl.textContent = restoredPath;
      }
    } catch {
    }
  }

  function appendOutput(text) {
    if (!text) {
      return;
    }
    if (outputEl.value) {
      outputEl.value += text;
    } else {
      outputEl.value = text.replace(/^\n+/, '');
    }
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function stripAnsi(text) {
    return text
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
      .replace(/\u001b./g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\u0000\u0007]/g, '');
  }

  function processOscMarkers(chunk) {
    const oscRe = /\u001b\]633;([^\u0007]*)\u0007/g;
    let match;
    while ((match = oscRe.exec(chunk)) !== null) {
      const parts = match[1].split(';');
      const code = parts[0];
      if (code === 'D') {
        lastExitOk = parts[1] === '0';
      } else if (code === 'A') {
        finishCommand();
      }
    }
    return chunk.replace(/\u001b\]633;[^\u0007]*\u0007/g, '');
  }

  function clearStructuredView() {
    if (!structuredPanel || !structuredContent) {
      return;
    }
    structuredContent.innerHTML = '';
    structuredPanel.hidden = true;
  }

  function normalizeGitCommand(cmd) {
    if (!cmd) {
      return '';
    }
    return String(cmd).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function isGitStatusCommand(cmd) {
    const n = normalizeGitCommand(cmd);
    return n === 'git status' || n === 'git status -sb' || n === 'git status --short';
  }

  function isGitBranchCommand(cmd) {
    const n = normalizeGitCommand(cmd);
    return (
      n === 'git branch' ||
      n === 'git branch -v' ||
      n === 'git branch -vv' ||
      n === 'git branch --list'
    );
  }

  function interpretOutput(command, outputText) {
    if (isGitStatusCommand(command)) {
      return interpretGitStatus(outputText);
    }
    if (isGitBranchCommand(command)) {
      return interpretGitBranch(outputText);
    }
    return null;
  }

  function interpretGitStatus(text) {
    const lines = String(text || '').split('\n').map(function (l) {
      return l.replace(/\r$/, '');
    });

    let branch = null;
    let ahead = null;
    let behind = null;
    const staged = [];
    const unstaged = [];
    const untracked = [];
    let section = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const branchMatch = line.match(/^On branch\s+(.+)\s*$/i);
      if (branchMatch) {
        branch = branchMatch[1].trim();
        continue;
      }
      const aheadBehind = line.match(
        /Your branch is (ahead of|behind) '([^']+)' by (\d+) commit/i
      );
      if (aheadBehind) {
        if (/ahead/i.test(aheadBehind[1])) {
          ahead = parseInt(aheadBehind[3], 10);
        } else {
          behind = parseInt(aheadBehind[3], 10);
        }
        continue;
      }
      if (/Changes to be committed/i.test(line)) {
        section = 'staged';
        continue;
      }
      if (/Changes not staged for commit/i.test(line)) {
        section = 'unstaged';
        continue;
      }
      if (/Untracked files/i.test(line)) {
        section = 'untracked';
        continue;
      }
      if (/^\s*$/.test(line) || /^\s*\(use "/i.test(line) || /^no changes added/i.test(line)) {
        continue;
      }
      const fileMatch = line.match(/^\s*(modified|new file|deleted|renamed):\s+(.+)$/i);
      if (fileMatch) {
        const entry = fileMatch[1].toLowerCase() + ': ' + fileMatch[2].trim();
        if (section === 'staged') staged.push(entry);
        else if (section === 'unstaged') unstaged.push(entry);
        continue;
      }
      if (section === 'untracked' && /^\s+\S/.test(line)) {
        untracked.push(line.trim());
      }
    }

    if (!branch && staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      return null;
    }

    const summaryParts = [];
    if (branch) summaryParts.push('Branch ' + branch);
    if (ahead) summaryParts.push(ahead + ' commit' + (ahead === 1 ? '' : 's') + ' ahead');
    if (behind) summaryParts.push(behind + ' commit' + (behind === 1 ? '' : 's') + ' behind');
    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      summaryParts.push('working tree clean');
    } else {
      if (staged.length) summaryParts.push(staged.length + ' staged');
      if (unstaged.length) summaryParts.push(unstaged.length + ' unstaged');
      if (untracked.length) summaryParts.push(untracked.length + ' untracked');
    }

    const items = [];
    function addFileGroup(label, files) {
      if (!files.length) return;
      items.push({
        title: label,
        meta: files.join(', '),
        actions: []
      });
    }
    addFileGroup('Staged changes', staged);
    addFileGroup('Unstaged changes', unstaged);
    addFileGroup('Untracked files', untracked);

    const globalActions = [
      { id: 'diff', label: 'View diff', command: 'git diff' },
      { id: 'log', label: 'Recent commits', command: 'git log --oneline -n 10' }
    ];
    if (staged.length > 0) {
      globalActions.unshift({
        id: 'commit',
        label: 'Commit staged changes',
        command: 'git commit'
      });
    }
    if (ahead && ahead > 0) {
      globalActions.unshift({ id: 'push', label: 'Push', command: 'git push' });
    }
    if (unstaged.length > 0 || untracked.length > 0) {
      globalActions.push({
        id: 'add-all',
        label: 'Stage all changes',
        command: 'git add -A'
      });
    }

    return {
      title: 'Git status',
      summary: summaryParts.join('. ') + '.',
      items: items,
      globalActions: globalActions
    };
  }

  function interpretGitBranch(text) {
    const lines = String(text || '')
      .split('\n')
      .map(function (l) {
        return l.replace(/\r$/, '');
      })
      .filter(function (l) {
        return l.trim().length > 0;
      });

    const branches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^([* ])\s+(\S+)(?:\s+(.*))?$/);
      if (!m) {
        continue;
      }
      const isCurrent = m[1] === '*';
      const name = m[2];
      const rest = (m[3] || '').trim();
      branches.push({
        name: name,
        isCurrent: isCurrent,
        meta: rest || null
      });
    }

    if (branches.length === 0) {
      return null;
    }

    const current = branches.find(function (b) {
      return b.isCurrent;
    });
    const summary =
      'You are on ' +
      (current ? current.name : 'an unknown branch') +
      '. ' +
      branches.length +
      ' local branch' +
      (branches.length === 1 ? '' : 'es') +
      '.';

    const items = branches.map(function (b) {
      const actions = [];
      if (!b.isCurrent) {
        actions.push({
          id: 'switch-' + b.name,
          label: 'Switch to this branch',
          command: 'git switch ' + b.name
        });
        actions.push({
          id: 'delete-' + b.name,
          label: 'Delete branch',
          command: 'git branch -d ' + b.name,
          confirm: true
        });
      } else {
        actions.push({
          id: 'status',
          label: 'Show status',
          command: 'git status'
        });
      }
      return {
        title: b.name + (b.isCurrent ? ' (current)' : ''),
        meta: b.meta,
        current: b.isCurrent,
        actions: actions
      };
    });

    return {
      title: 'Git branches',
      summary: summary,
      items: items,
      globalActions: [
        { id: 'fetch', label: 'Fetch from remote', command: 'git fetch' },
        { id: 'status', label: 'Show status', command: 'git status' }
      ]
    };
  }

  function renderStructuredView(view) {
    if (!structuredPanel || !structuredContent || !view) {
      clearStructuredView();
      return;
    }

    structuredContent.innerHTML = '';

    const heading = document.createElement('h3');
    heading.textContent = view.title || 'Results';
    structuredContent.appendChild(heading);

    if (view.summary) {
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = view.summary;
      structuredContent.appendChild(summary);
    }

    if (view.items && view.items.length) {
      const list = document.createElement('ul');
      list.setAttribute('aria-label', view.title || 'Items');

      view.items.forEach(function (item) {
        const li = document.createElement('li');
        if (item.current) {
          li.className = 'current';
        }

        const title = document.createElement('p');
        title.className = 'item-title';
        title.textContent = item.title || '';
        li.appendChild(title);

        if (item.meta) {
          const meta = document.createElement('p');
          meta.className = 'item-meta';
          meta.textContent = item.meta;
          li.appendChild(meta);
        }

        if (item.actions && item.actions.length) {
          const actions = document.createElement('div');
          actions.className = 'item-actions';
          item.actions.forEach(function (action) {
            actions.appendChild(createActionButton(action));
          });
          li.appendChild(actions);
        }

        list.appendChild(li);
      });

      structuredContent.appendChild(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No detailed items.';
      structuredContent.appendChild(empty);
    }

    if (view.globalActions && view.globalActions.length) {
      const global = document.createElement('div');
      global.className = 'global-actions';
      global.setAttribute('aria-label', 'Actions');
      view.globalActions.forEach(function (action) {
        global.appendChild(createActionButton(action));
      });
      structuredContent.appendChild(global);
    }

    structuredPanel.hidden = false;
    announce(
      (view.title || 'Structured results') +
        ' available. ' +
        (view.summary || '') +
        ' Use Tab to reach action buttons, or Alt+O for raw output.'
    );
  }

  function createActionButton(action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label || action.id || 'Run';
    if (action.confirm) {
      btn.className = 'danger';
    }
    btn.addEventListener('click', function () {
      runStructuredAction(action);
    });
    return btn;
  }

  function runStructuredAction(action) {
    if (!action || !action.command) {
      return;
    }
    if (action.confirm) {
      const ok = window.confirm(
        'Run this command?\n\n' + action.command + '\n\nThis may be destructive.'
      );
      if (!ok) {
        announce('Cancelled.');
        commandEl.focus();
        return;
      }
    }
    runCommand(action.command);
  }

  function tryBuildStructuredView(command) {
    const outputText = commandOutputChunks.join('');
    const view = interpretOutput(command, outputText);
    if (view) {
      renderStructuredView(view);
    } else {
      clearStructuredView();
    }
  }

  function finishCommand() {
    if (!commandRunning) {
      return;
    }
    commandRunning = false;
    const status = lastExitOk ? 'succeeded' : 'failed';
    const label = pendingCommand ? pendingCommand : 'Command';
    announce(label + ' ' + status + '.');

    if (pendingCommand) {
      tryBuildStructuredView(pendingCommand);
    }

    pendingCommand = null;
    commandOutputChunks = [];
    if (ready && socket.readyState === WebSocket.OPEN) {
      runBtn.disabled = false;
      commandEl.focus();
    }
  }

  function requestPathRestore(target) {
    if (!target || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: 'cwd', cwd: target }));
  }

  function focusOutput() {
    if (commandEl.disabled) {
      return;
    }
    outputEl.focus();
    const end = outputEl.value.length;
    try {
      outputEl.setSelectionRange(end, end);
    } catch {
    }
    announce('Output focused.');
  }

  function onPromptSeen(path) {
    if (restoredPath && pathsEqual(path, restoredPath)) {
      restoredPath = null;
      pathRestoreAttempted = true;
    }
    setPath(path);
    finishCommand();
    if (!ready) {
      ready = true;
      setControlsEnabled(true);
      if (restoredPath && !pathsEqual(path, restoredPath) && !pathRestoreAttempted) {
        pathRestoreAttempted = true;
        const target = restoredPath;
        requestPathRestore(target);
        announce('Shell ready. Restoring path ' + target + '.');
      } else {
        announce('Shell ready. Current path ' + path + '. Type a command.');
      }
      commandEl.focus();
    }
  }

  function handleIncoming(data) {
    rawBuffer += processOscMarkers(data);
    const clean = stripAnsi(rawBuffer);
    const lines = clean.split('\n');
    rawBuffer = lines.pop() || '';
    const displayLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const promptPath = matchPrompt(line);
      if (promptPath) {
        onPromptSeen(promptPath);
        continue;
      }
      if (commandRunning && pendingCommand && line.trim() === pendingCommand) {
        continue;
      }
      displayLines.push(line);
      if (commandRunning) {
        commandOutputChunks.push(line + '\n');
      }
    }
    const tailPath = matchPrompt(rawBuffer);
    if (tailPath) {
      onPromptSeen(tailPath);
      rawBuffer = '';
    }
    if (displayLines.length > 0) {
      appendOutput(displayLines.join('\n') + '\n');
    }
  }

  function resetCompletion() {
    completion.baseLine = '';
    completion.replacementIndex = 0;
    completion.replacementLength = 0;
    completion.matches = [];
    completion.index = 0;
  }

  function applyCompletionMatch(index) {
    if (!completion.matches.length) {
      return;
    }
    const match = completion.matches[index];
    completion.index = index;
    if (completion.matches.length === 1) {
      announceAlert(match);
    } else {
      announceAlert((index + 1) + ' of ' + completion.matches.length + ', ' + match);
    }
    const before = completion.baseLine.slice(0, completion.replacementIndex);
    const after = completion.baseLine.slice(
      completion.replacementIndex + completion.replacementLength
    );
    const newLine = before + match + after;
    const caret = before.length + match.length;
    applyingCompletion = true;
    commandEl.value = newLine;
    commandEl.setSelectionRange(caret, caret);
    applyingCompletion = false;
  }

  function cycleCompletion(direction) {
    const n = completion.matches.length;
    if (n === 0) {
      return;
    }
    const next = (completion.index + direction + n) % n;
    applyCompletionMatch(next);
  }

  function requestTabCompletion(direction) {
    if (commandRunning) {
      announce('Wait for the current command to finish.');
      return;
    }
    if (completion.matches.length > 0) {
      cycleCompletion(direction);
      return;
    }
    if (completionPending) {
      return;
    }
    const line = commandEl.value;
    const cursor =
      typeof commandEl.selectionStart === 'number'
        ? commandEl.selectionStart
        : line.length;
    const baseLine = line;
    completionPending = true;
    completionRequestId += 1;
    const id = completionRequestId;
    fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id,
        line: line,
        cursor: cursor,
        cwd: currentPath || undefined
      })
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Completion request failed (' + response.status + ').');
        }
        return response.json();
      })
      .then(function (msg) {
        handleCompleteResult(msg, baseLine);
      })
      .catch(function (err) {
        completionPending = false;
        resetCompletion();
        announce(
          err && err.message
            ? err.message
            : 'Completion request failed. Is the server running the latest code?'
        );
      });
  }

  function handleCompleteResult(msg, baseLine) {
    completionPending = false;
    if (msg && msg.id != null && msg.id !== completionRequestId) {
      return;
    }
    const matches = Array.isArray(msg.matches)
      ? msg.matches
      : typeof msg.matches === 'string'
        ? [msg.matches]
        : [];
    if (matches.length === 0) {
      resetCompletion();
      announce(msg.error ? 'No completions. ' + msg.error : 'No completions.');
      return;
    }
    completion.baseLine = typeof baseLine === 'string' ? baseLine : commandEl.value;
    completion.replacementIndex =
      typeof msg.replacementIndex === 'number' ? msg.replacementIndex : 0;
    completion.replacementLength =
      typeof msg.replacementLength === 'number' ? msg.replacementLength : 0;
    completion.matches = matches;
    applyCompletionMatch(0);
  }

  function isNlshEnabled() {
    try {
      return localStorage.getItem('terminal-nlsh-enabled') === 'true';
    } catch (e) {
      return false;
    }
  }

  function getSelectedOllamaModel() {
    try {
      return localStorage.getItem('terminal-ollama-model') || '';
    } catch (e) {
      return '';
    }
  }

  function isNaturalLanguage(text) {
    if (!text || text.startsWith('!')) return false;
    var shellCommands = {
      ls: 1, pwd: 1, clear: 1, exit: 1, quit: 1, whoami: 1, date: 1, dir: 1, cls: 1, cd: 1,
      history: 1, which: 1, man: 1, touch: 1, head: 1, tail: 1, grep: 1, find: 1
    };
    if (shellCommands[text]) return false;
    var starters = [
      'cd ', 'ls ', 'dir ', 'echo ', 'cat ', 'type ', 'mkdir ', 'rm ', 'del ', 'cp ', 'mv ',
      'git ', 'npm ', 'node ', 'npx ', 'python', 'pip ', 'curl ', 'wget ', 'sudo ', 'docker ',
      'kubectl ', 'Get-', 'Set-', 'New-', 'Remove-', './', '.\\', '/', '~', '$', '>', '|', '&&'
    ];
    for (var i = 0; i < starters.length; i++) {
      if (text.indexOf(starters[i]) === 0) return false;
    }
    return true;
  }

  function translateNaturalLanguage(input) {
    var model = getSelectedOllamaModel();
    announce('Translating with Ollama' + (model ? ' (' + model + ')' : '') + '\u2026');
    return fetch('/api/nlsh/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: input,
        cwd: currentPath || undefined,
        model: model || undefined
      })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok || !body.ok) {
          throw new Error((body && body.error) || 'Translation failed.');
        }
        return body.command;
      });
    });
  }

  function submitCommandLine(rawText) {
    var text = (rawText || '').trim();
    if (!text) return;

    if (isNlshEnabled() && isNaturalLanguage(text)) {
      runBtn.disabled = true;
      translateNaturalLanguage(text)
        .then(function (command) {
          runBtn.disabled = false;
          if (!command) {
            announce('Model returned an empty command.');
            return;
          }
          var ok = window.confirm(
            'Natural language shell proposes:\n\n' + command + '\n\nRun this command?'
          );
          if (!ok) {
            announce('Cancelled.');
            commandEl.focus();
            return;
          }
          runCommand(command);
        })
        .catch(function (err) {
          runBtn.disabled = false;
          announce(
            err && err.message
              ? err.message
              : 'Could not translate. Is Ollama running? Check Settings \u2192 model.'
          );
          commandEl.focus();
        });
      return;
    }

    runCommand(text);
  }

  function runCommand(commandText) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (commandRunning) {
      const text = commandText;
      commandEl.value = '';
      sendStdin(text);
      announce('Sent input to running command.');
      return;
    }
    const text = commandText.trim();
    if (!text) {
      return;
    }
    resetCompletion();
    clearStructuredView();
    commandOutputChunks = [];
    const echo = (currentPath ? currentPath : '$') + '> ' + text + '\n';
    appendOutput(echo);
    pendingCommand = text;
    commandRunning = true;
    lastExitOk = true;
    runBtn.disabled = true;
    history.push(text);
    historyIndex = history.length;
    draftBeforeHistory = '';
    commandEl.value = '';
    announce('Running ' + text);
    socket.send(text + '\n');
  }

  restorePath();

  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const socket = new WebSocket(protocol + location.host + '/ws');

  socket.addEventListener('open', function () {
    if (restoredPath) {
      requestPathRestore(restoredPath);
    } else {
      socket.send(JSON.stringify({ type: 'cwd', cwd: '' }));
    }
    announce('Connecting. Waiting for shell prompt.');
    window.setTimeout(function () {
      if (!ready && socket.readyState === WebSocket.OPEN) {
        ready = true;
        setControlsEnabled(true);
        if (!currentPath) {
          pathEl.textContent = '(shell ready)';
        }
        announce('Shell ready. Type a command.');
        commandEl.focus();
      }
    }, 2500);
  });

  socket.addEventListener('message', function (event) {
    const data = typeof event.data === 'string' ? event.data : String(event.data);
    handleIncoming(data);
  });

  socket.addEventListener('close', function () {
    setControlsEnabled(false);
    appendOutput('\n[connection closed]\n');
    announce('Connection closed.');
  });

  socket.addEventListener('error', function () {
    announce('Connection error.');
  });

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    submitCommandLine(commandEl.value);
  });

  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      sendInterrupt();
      commandEl.focus();
    });
  }

  clearBtn.addEventListener('click', function () {
    outputEl.value = '';
    clearStructuredView();
    announce('Output cleared.');
    commandEl.focus();
  });

  commandEl.addEventListener('input', function () {
    if (applyingCompletion) {
      return;
    }
    resetCompletion();
  });

  commandEl.addEventListener('keydown', function (event) {
    if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'c' || event.key === 'C')) {
      const start = commandEl.selectionStart;
      const end = commandEl.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && start !== end) {
        return;
      }
      event.preventDefault();
      sendInterrupt();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      requestTabCompletion(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      resetCompletion();
      if (history.length === 0) {
        return;
      }
      if (historyIndex === history.length) {
        draftBeforeHistory = commandEl.value;
      }
      historyIndex = Math.max(0, historyIndex - 1);
      commandEl.value = history[historyIndex];
      commandEl.setSelectionRange(commandEl.value.length, commandEl.value.length);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      resetCompletion();
      if (history.length === 0) {
        return;
      }
      if (historyIndex >= history.length - 1) {
        historyIndex = history.length;
        commandEl.value = draftBeforeHistory;
      } else {
        historyIndex += 1;
        commandEl.value = history[historyIndex];
      }
      commandEl.setSelectionRange(commandEl.value.length, commandEl.value.length);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      resetCompletion();
      commandEl.value = '';
      historyIndex = history.length;
      draftBeforeHistory = '';
      announce('Command cleared.');
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'c' || event.key === 'C')) {
      const active = document.activeElement;
      if (commandRunning && active !== commandEl) {
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).length > 0) {
          return;
        }
        event.preventDefault();
        sendInterrupt();
        return;
      }
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'f2' || event.key === 'F2' || key === 'o') {
        event.preventDefault();
        focusOutput();
      } else if (key === 'c') {
        event.preventDefault();
        commandEl.focus();
        announce('Command field focused.');
      }
    }
  });
})();
