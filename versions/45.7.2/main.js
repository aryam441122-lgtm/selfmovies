// Self Movies — Electron shell for https://selfy.lovable.app
//
// OAuth flow:
//   1. Site triggers OAuth — either window.open(authUrl), window.location = authUrl,
//      or a redirect chain that starts with https://selfy.lovable.app/~oauth/initiate
//   2. We intercept ALL of those (navigation, redirects, popups) and open the
//      final URL in the user's default browser (Chrome/Edge/…).
//   3. The site redirects back to selfmovies://auth#<tokens> after consent.
//   4. Windows fires our protocol handler -> we forward the hash to
//      https://selfy.lovable.app/auth/electron-callback so the site can call
//      supabase.auth.setSession() and the user ends up logged in inside the app.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = 'selfmovies';
const ELECTRON_CALLBACK_PATH = '/auth/electron-callback';

// Same-origin paths that START an OAuth flow — must be opened in the system browser
const APP_OAUTH_PATH_PATTERNS = [
  /^\/~oauth\//i,           // Lovable Cloud managed OAuth broker
  /^\/auth\/v1\/authorize/i,
  /^\/auth\/oauth/i,
];

// External provider hosts — also open in the system browser
const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)accounts\.youtube\.com$/i,
  /(^|\.)oauth2?\.googleapis\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)icloud\.com$/i,
  /(^|\.)idmsa\.apple\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)live\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)supabase\.co$/i,
  /(^|\.)supabase\.in$/i,
];

function parseUrl(u) { try { return new URL(u); } catch { return null; } }
function isAppOrigin(url) { const u = parseUrl(url); return !!u && u.origin === ALLOWED_ORIGIN; }
function isAppOAuthPath(url) {
  const u = parseUrl(url);
  if (!u || u.origin !== ALLOWED_ORIGIN) return false;
  return APP_OAUTH_PATH_PATTERNS.some((re) => re.test(u.pathname));
}
function isProviderAuthUrl(url) {
  const u = parseUrl(url);
  return !!u && AUTH_HOST_PATTERNS.some((re) => re.test(u.hostname));
}
function shouldOpenExternal(url) {
  return isAppOAuthPath(url) || isProviderAuthUrl(url);
}

// --- Single instance + protocol -----------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

let win = null;

function findDeepLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
}

function handleDeepLink(deepLink) {
  if (!deepLink || !win || win.isDestroyed()) return;
  try {
    const u = new URL(deepLink);
    const target = `${APP_URL}${ELECTRON_CALLBACK_PATH}${u.search || ''}${u.hash || ''}`;
    win.loadURL(target);
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch {
    try { win.loadURL(APP_URL); } catch {}
  }
}

app.on('second-instance', (_e, argv) => {
  const link = findDeepLink(argv);
  if (link) handleDeepLink(link);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (win) handleDeepLink(url);
  else app.once('browser-window-created', () => setTimeout(() => handleDeepLink(url), 300));
});

// --- Window -------------------------------------------------------------------

function attachAuthInterceptors(contents, opts = {}) {
  const { isMain = false } = opts;

  const intercept = (event, url) => {
    if (shouldOpenExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
      // For the main window, stay on the current page (don't navigate away)
      return true;
    }
    return false;
  };

  contents.on('will-navigate', (e, url) => {
    if (intercept(e, url)) return;
    // For non-main webContents (popups), block everything off-origin to the system browser
    if (!isMain && !isAppOrigin(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  contents.on('will-redirect', (e, url) => {
    if (intercept(e, url)) return;
    if (!isMain && !isAppOrigin(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (isAppOrigin(url)) {
      try { win && win.loadURL(url); } catch {}
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

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

  attachAuthInterceptors(win.webContents, { isMain: true });

  // Block devtools / inspect
  win.webContents.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (k === 'f12') return event.preventDefault();
    if ((input.control || input.meta) && input.shift && ['i', 'j', 'c', 'k'].includes(k))
      return event.preventDefault();
    if ((input.control || input.meta) && ['u', 's', 'p'].includes(k)) return event.preventDefault();
  });
  win.webContents.on('devtools-opened', () => { try { win.webContents.closeDevTools(); } catch {} });
  win.webContents.on('context-menu', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  const ses = session.fromPartition('persist:selfmovies');
  const ua = ses.getUserAgent()
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\sSelf Movies\/[\d.]+/g, '');
  ses.setUserAgent(ua);

  createWindow();

  const initialLink = findDeepLink(process.argv);
  if (initialLink) setTimeout(() => handleDeepLink(initialLink), 500);
});

app.on('window-all-closed', () => app.quit());

// Catch any popup that still gets created — apply the same interceptors
app.on('web-contents-created', (_e, contents) => {
  if (contents !== win?.webContents) {
    attachAuthInterceptors(contents, { isMain: false });
  }
  contents.on('devtools-opened', () => { try { contents.closeDevTools(); } catch {} });
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.close());
