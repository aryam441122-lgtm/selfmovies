// Self Movies — Electron shell that loads https://selfy.lovable.app
// OAuth flows (Google, Apple/iCloud, Microsoft) are allowed as popups,
// share the same session, and auto-close once they redirect back to the app.
// DevTools and right-click stay fully blocked.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;

// Domains allowed to open as auth popups (and stay open during the OAuth flow)
const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)accounts\.youtube\.com$/i,
  /(^|\.)oauth2?\.googleapis\.com$/i,
  /(^|\.)gstatic\.com$/i,
  /(^|\.)google\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)apple\.com$/i,
  /(^|\.)icloud\.com$/i,
  /(^|\.)idmsa\.apple\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)live\.com$/i,
  /(^|\.)microsoft\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)supabase\.co$/i,
  /(^|\.)supabase\.in$/i,
];

function isAuthUrl(url) {
  try {
    const u = new URL(url);
    return AUTH_HOST_PATTERNS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function isAppOrigin(url) {
  try {
    return new URL(url).origin === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

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
      partition: 'persist:selfmovies',
    },
  });

  // If the main window is itself navigated to an auth URL, hand it off to a popup
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppOrigin(url)) return;
    if (isAuthUrl(url)) {
      e.preventDefault();
      openAuthPopup(url);
      return;
    }
    e.preventDefault();
  });

  // Allow popups only for auth flows — same session, so cookies are shared
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || isAppOrigin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          minWidth: 400,
          minHeight: 500,
          parent: win,
          modal: false,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          title: 'Sign in',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: false,
            partition: 'persist:selfmovies', // same partition as main = shared cookies
          },
        },
      };
    }
    return { action: 'deny' };
  });

  // Wire each child window: close it on return to app, reload main with session
  win.webContents.on('did-create-window', (child) => {
    wireAuthPopup(child);
  });

  // Block DevTools / inspection
  win.webContents.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (k === 'f12') return event.preventDefault();
    if ((input.control || input.meta) && input.shift && ['i', 'j', 'c', 'k'].includes(k))
      return event.preventDefault();
    if ((input.control || input.meta) && ['u', 's', 'p'].includes(k)) return event.preventDefault();
  });
  win.webContents.on('devtools-opened', () => {
    try { win.webContents.closeDevTools(); } catch {}
  });
  win.webContents.on('context-menu', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());
  win.loadURL(APP_URL);
}

function openAuthPopup(url) {
  const popup = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    parent: win,
    modal: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'Sign in',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,
      partition: 'persist:selfmovies',
    },
  });
  wireAuthPopup(popup);
  popup.loadURL(url);
}

function wireAuthPopup(popup) {
  if (!popup || popup.isDestroyed()) return;

  const maybeFinish = (url) => {
    if (!url) return;
    if (isAppOrigin(url)) {
      // OAuth completed and redirected back to the app — refresh main, close popup
      try {
        if (win && !win.isDestroyed()) {
          win.loadURL(url);
          win.focus();
        }
      } catch {}
      try { popup.close(); } catch {}
    }
  };

  popup.webContents.on('will-redirect', (_e, url) => maybeFinish(url));
  popup.webContents.on('will-navigate', (_e, url) => maybeFinish(url));
  popup.webContents.on('did-navigate', (_e, url) => maybeFinish(url));
  popup.webContents.on('did-redirect-navigation', (_e, url) => maybeFinish(url));

  popup.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || isAppOrigin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:selfmovies',
            devTools: false,
          },
        },
      };
    }
    return { action: 'deny' };
  });
  popup.webContents.on('did-create-window', (child) => wireAuthPopup(child));

  popup.webContents.on('context-menu', (e) => e.preventDefault());
  popup.webContents.on('devtools-opened', () => {
    try { popup.webContents.closeDevTools(); } catch {}
  });
}

app.whenReady().then(() => {
  // Use the same persistent partition so cookies/storage are shared with popups
  const ses = session.fromPartition('persist:selfmovies');
  // Some providers (Google) block embedded user agents — present as standard Chrome
  const ua = ses
    .getUserAgent()
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\sSelf Movies\/[\d.]+/g, '');
  ses.setUserAgent(ua);

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Guard any future BrowserWindow created in this process
app.on('web-contents-created', (_e, contents) => {
  contents.on('devtools-opened', () => {
    try { contents.closeDevTools(); } catch {}
  });
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.close());
