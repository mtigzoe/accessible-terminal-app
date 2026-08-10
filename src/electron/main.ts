import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell } from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProcess: ChildProcess | null = null;
let selectedPort = 3000;

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(findFreePort(startPort + 1)));
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : startPort;
      server.close(() => resolve(port));
    });
    server.listen(startPort, '127.0.0.1');
  });
}

function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'server.js');
    serverProcess = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'inherit'
    });
    serverProcess.once('error', reject);
    setTimeout(resolve, 500);
  });
}

function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stopServer() {
  if (serverProcess) {
    if (process.platform === 'win32') serverProcess.kill();
    else serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  if (tray) { tray.destroy(); tray = null; }
}

ipcMain.handle('show-message', async (_event, payload: { title?: string; message?: string }) => {
  const result = await dialog.showMessageBox({ type: 'info', title: payload?.title || 'Accessible Terminal', message: payload?.message || '' });
  return result.response;
});

ipcMain.handle('get-backend-port', () => selectedPort);

// Open the native Windows folder picker so keyboard/screen-reader users can
// choose a directory without manually typing the full path.
ipcMain.handle('choose-working-directory', async () => {
  // Do not pass mainWindow when it may be null. Electron's current TypeScript
  // definitions require a concrete BaseWindow when a parent is supplied.
  const result = await dialog.showOpenDialog({
    title: 'Choose working directory',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choose folder'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    selectedPort = await findFreePort(3000);
    await startServer(selectedPort);
    createWindow(selectedPort);
    createMenu();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(selectedPort);
    });
  } catch (error) {
    console.error('Failed to start application:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopServer);
