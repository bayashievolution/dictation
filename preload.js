/**
 * dictation — preload (contextBridge)
 * renderer <-> main の IPC ブリッジ
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  toggleAlwaysOnTop: () => ipcRenderer.invoke('win:toggleAlwaysOnTop'),
  toggleTransparent: () => ipcRenderer.invoke('win:toggleTransparent'),
  setOpacity: (v) => ipcRenderer.invoke('win:setOpacity', v),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  hideToTray: () => ipcRenderer.invoke('win:hideToTray'),
  close: () => ipcRenderer.invoke('win:close'),
  getState: () => ipcRenderer.invoke('win:getState'),
  onWindowState: (cb) => {
    ipcRenderer.on('window-state', (_, state) => cb(state));
  },
});

contextBridge.exposeInMainWorld('isElectron', true);
