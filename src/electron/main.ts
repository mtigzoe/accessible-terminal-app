import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  ipcMain
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as net from 'net';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let selectedPort = 3000;

const HOST = '127.0.0.1';
const isDev = !app.isPackaged;

/** Locate an available TCP port beginning at `startPort`. */
function findFreePort(startPort = 3000, maxAttempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;

    const tryPort = () => {
      if (attempts >= maxAttempts) {
        reject(new Error(`No free port found near ${startPort}`));
        return;
      }
      attempts += 1;

      const server = net.createServer();
      server.once('error', () => {
        port += 1;
        tryPort();
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, HOST);
    };

    tryPort();
  });
}

function waitForServer(port: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const attempt = () => {
      const req = http.get(`http://${HOST}:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not become ready on port ${port}`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      HOST
    };

    if (isDev) {
      const tsNodeBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node'
      );
      const serverEntry = path.join(process.cwd(), 'src', 'server.ts');

      serverProcess = spawn(tsNodeBin, [serverEntry], {
        stdio: 'inherit',
        env,
        shell: process.platform === 'win32',
        cwd: process.cwd()
      });
    } else {
      const serverJs = path.join(__dirname, '..', 'server.js');
      serverProcess = spawn(process.execPath, [serverJs], {
        stdio: 'inherit',
        env
      });
    }

    if (!serverProcess) {
      reject(new Error('Failed to spawn server process'));
      return;
    }

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code && code !== 0) {
        console.error(`Server process exited with code ${code}`);
      }
    });

    waitForServer(port).then(resolve).catch(reject);
  });
}

function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 650,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Accessible Terminal'
  });

  mainWindow.loadURL(`http://${HOST}:${port}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // On Windows/Linux, hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (tray && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload()
        },
        { type: 'separator' },
        {
          label: process.platform === 'darwin' ? 'Quit Accessible Terminal' : 'Exit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => {
            cleanup();
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://${HOST}:${selectedPort}`)
        },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Accessible Terminal',
              message: 'Accessible Terminal',
              detail: 'A screen-reader-friendly PowerShell / shell interface.\n\nVersion 1.0.0'
            });
          }
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  let icon: Electron.NativeImage;

  try {
    const candidates = [
      path.join(process.resourcesPath || '', 'assets', 'icon.png'),
      path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      path.join(process.cwd(), 'assets', 'icon.png')
    ];

    let iconPath = '';
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        iconPath = candidate;
        break;
      }
    }

    icon = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Accessible Terminal');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(`http://${HOST}:${selectedPort}`)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        cleanup();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t'], {
        stdio: 'ignore'
      });
    } else {
      serverProcess.kill('SIGTERM');
    }
    serverProcess = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

// IPC handlers for the preload bridge
ipcMain.handle('show-message', async (_event, payload: { title?: string; message?: string }) => {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: payload?.title || 'Accessible Terminal',
    message: payload?.message || ''
  });
  return result.response;
});

ipcMain.handle('get-backend-port', () => selectedPort);

app.whenReady().then(async () => {
  try {
    selectedPort = await findFreePort(3000);
    await startServer(selectedPort);
    createWindow(selectedPort);
    createMenu();
    createTray();
  } catch (err) {
    console.error('Failed to start application:', err);
    dialog.showErrorBox(
      'Startup Error',
      err instanceof Error ? err.message : String(err)
    );
    cleanup();
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(selectedPort);
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', () => {
  cleanup();
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
