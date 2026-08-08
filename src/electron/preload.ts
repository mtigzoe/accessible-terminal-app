import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal, secure API exposed to the renderer process.
 * Add new methods only when a concrete requirement appears.
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

  /** Current operating-system platform. */
  platform: process.platform as NodeJS.Platform
});
