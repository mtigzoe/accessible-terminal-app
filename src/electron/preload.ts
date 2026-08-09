import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal, secure API exposed to the renderer process.
 */
contextBridge.exposeInMainWorld('accessibleTerminal', {
  /** Display a native message box. */
  showMessage: (title: string, message: string): Promise<number> => {
    return ipcRenderer.invoke('show-message', { title, message });
  },

  /** Return the port on which the Express backend is listening. */
  getBackendPort: (): Promise<number> => {
    return ipcRenderer.invoke('get-backend-port');
  },

  /** Open the operating-system folder picker and return the selected path. */
  chooseWorkingDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('choose-working-directory');
  },

  /** Current operating-system platform. */
  platform: process.platform as NodeJS.Platform
});
