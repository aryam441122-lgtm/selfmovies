const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge — the site does not gate on this, but we expose a marker
// for parity with the installer shell.
contextBridge.exposeInMainWorld('selfMovies', {
  isElectron: true,
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
});
