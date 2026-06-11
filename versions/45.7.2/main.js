// Self Movies — Electron shell for https://selfy.lovable.app
//
// Auth flow (new):
//   1. User clicks "Sign in with Google/Apple" inside the app.
//   2. We intercept the OAuth URL and open it in the user's DEFAULT browser
//      (Chrome/Edge/etc.) using shell.openExternal — so their existing
//      Google sessions are visible and the flow is familiar.
//   3. The website is configured to redirect back to:  selfmovies://auth#<tokens>
//   4. Windows fires our registered protocol handler -> Electron receives the
//      deep link, parses the Supabase tokens, and hands them to the app via
//      a one-time URL: https://selfy.lovable.app/auth/electron-callback#<tokens>
//   5. The site reads the hash, calls supabase.auth.setSession(), and the
//      user is logged in inside the desktop app.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = 'selfmovies';
// Path the website should redirect to after OAuth (we read tokens from the hash)
const ELECTRON_CALLBACK_PATH = '/auth/electron-callback';

// Hosts that mean "this is an OAuth / provider login page" — open in external browser
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
  try { return new URL(url).origin === ALLOWED_ORIGIN; } catch { return false; }
}

// --- Single instance + protocol registration ---------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Register selfmovies:// as our custom protocol on Windows/Linux
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

// Hand off a selfmovies:// callback to the website so it can finish the login
function handleDeepLink(deepLink) {
  if (!deepLink || !win || win.isDestroyed()) return;
  try {
    // selfmovies://auth#access_token=...&refresh_token=...
    // Forward the hash to the site's /auth/electron-callback page.
    const u = new URL(deepLink);
    const hash = u.hash || '';
    const search = u.search || '';
    const target = `${APP_URL}${ELECTRON_CALLBACK_PATH}${search}${hash}`;
    win.loadURL(target);
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (e) {
    // Fallback: just reload the home page
    try { win.loadURL(APP_URL); } catch {}
  }
}

// Windows: second instance carries the deep link in argv
app.on('second-instance', (_event, argv) => {
  const link = findDeepLink(argv);
  if (link) handleDeepLink(link);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// macOS: deep link arrives via open-url
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (win) handleDeepLink(url);
  else app.once('browser-window-created', () => setTimeout(() => handleDeepLink(url), 300));
});

// --- Main window -------------------------------------------------------------

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

  // Intercept navigations to OAuth providers and send them to the system browser
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppOrigin(url)) return;
    if (isAuthUrl(url)) {
      e.preventDefault();
      shell.openExternal(url);
      return;
    }
    e.preventDefault();
    shell.openExternal(url);
  });

  // window.open(...) — block popups and send the URL to the system browser instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppOrigin(url)) {
      // Same site: just navigate the main window
      try { win.loadURL(url); } catch {}
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block DevTools / inspection
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
  // Identify as plain Chrome so the site can serve the normal layout
  const ua = ses.getUserAgent()
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\sSelf Movies\/[\d.]+/g, '');
  ses.setUserAgent(ua);

  createWindow();

  // If the app was launched directly via a deep link (Windows cold start)
  const initialLink = findDeepLink(process.argv);
  if (initialLink) setTimeout(() => handleDeepLink(initialLink), 500);
});

app.on('window-all-closed', () => app.quit());

app.on('web-contents-created', (_e, contents) => {
  contents.on('devtools-opened', () => { try { contents.closeDevTools(); } catch {} });
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.close());
