// Self Movies — Electron shell that loads https://selfy.lovable.app only.
// Any tab, popup, or external navigation is denied / closed instantly.
// DevTools and right-click are fully blocked.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0203',
    title: 'Self Movies',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
      devTools: false,
    },
  });

  // Lock origin
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== ALLOWED_ORIGIN) {
        e.preventDefault();
      }
    } catch { e.preventDefault(); }
  });

  // Deny ALL window opens — close popups instantly
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-create-window', (child) => {
    try { child.close(); } catch {}
    try { child.destroy(); } catch {}
  });

  // Block DevTools / inspection
  win.webContents.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (k === 'f12') return event.preventDefault();
    if ((input.control || input.meta) && input.shift && ['i','j','c','k'].includes(k)) return event.preventDefault();
    if ((input.control || input.meta) && ['u','s','p'].includes(k)) return event.preventDefault();
  });
  win.webContents.on('devtools-opened', () => { try { win.webContents.closeDevTools(); } catch {} });
  win.webContents.on('context-menu', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());
  win.loadURL(APP_URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// Also guard any future BrowserWindow created in this process
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== ALLOWED_ORIGIN) e.preventDefault();
    } catch { e.preventDefault(); }
  });
  contents.on('devtools-opened', () => { try { contents.closeDevTools(); } catch {} });
  contents.on('context-menu', (e) => e.preventDefault());
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.close());
