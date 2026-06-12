const { contextBridge, ipcRenderer } = require('electron');

// Expose a flag so the website can detect the desktop app and switch its
// OAuth redirectTo to the selfmovies:// deep link.
contextBridge.exposeInMainWorld('selfMovies', {
  isElectron: true,
  platform: 'desktop',
  protocol: 'selfmovies',
  // The website should redirect OAuth back to this URL.
  // After provider login, the site reads supabase tokens from the URL hash
  // and redirects the user's browser to: selfmovies://auth#<same hash>
  authReturnUrl: 'selfmovies://auth',
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
});
