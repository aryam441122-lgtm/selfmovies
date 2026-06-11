// Self Movies — Electron shell for https://selfy.lovable.app
//
// OAuth flow:
//   1. Site triggers OAuth — either window.open(authUrl), window.location = authUrl,
//      or a redirect chain that starts with https://selfy.lovable.app/~oauth/initiate
//   2. We intercept ALL of those (navigation, redirects, popups) and open the
//      final URL in the user's default browser (Chrome/Edge/…).
//   3. The site redirects back to selfmovies://auth?<tokens> after consent.
//   4. Windows fires our protocol handler -> we forward the payload to
//      https://selfy.lovable.app/auth/electron-callback so the site can call
//      supabase.auth.setSession() and the user ends up logged in inside the app.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const http = require('http');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = 'selfmovies';
const ELECTRON_CALLBACK_PATH = '/auth/electron-callback';
const SUPABASE_URL = 'https://akmldmfvyutcjrcwvhgf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrbWxkbWZ2eXV0Y2pyY3d2aGdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwNzQ1MzQsImV4cCI6MjA5MTY1MDUzNH0.vm0jXHIQTlUTi6NpWdU8aU7L6l_2tN_L-YxitcBRFSw';
const SUPABASE_STORAGE_KEY = 'sb-akmldmfvyutcjrcwvhgf-auth-token';

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

async function openExternalAuthUrl(url) {
  let target = url;
  const u = parseUrl(url);
  if (u && u.origin === ALLOWED_ORIGIN && APP_OAUTH_PATH_PATTERNS.some((re) => re.test(u.pathname))) {
    const callbackUrl = await startLocalAuthServer();
    u.searchParams.set('redirect_uri', callbackUrl);
    target = u.toString();
  }
  shell.openExternal(target);
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
let pendingAuthPayload = '';
let localAuthServer = null;
let localAuthCallbackUrl = '';

function startLocalAuthServer() {
  return new Promise((resolve) => {
    if (localAuthCallbackUrl) return resolve(localAuthCallbackUrl);

    localAuthServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

      const finish = (html) => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(html);
      };

      if (requestUrl.pathname === '/capture') {
        const payload = requestUrl.search.slice(1);
        if (payload) handleDeepLink(`${PROTOCOL}://auth?${payload}`);
        return finish('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#090909;color:#fff;display:grid;place-items:center;height:100vh"><h2>تم تسجيل الدخول، ارجع للتطبيق.</h2><script>window.close()</script></body>');
      }

      if (requestUrl.pathname !== '/auth/electron-callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }

      const queryPayload = requestUrl.search.slice(1);
      if (queryPayload) handleDeepLink(`${PROTOCOL}://auth?${queryPayload}`);

      return finish(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Self Movies</title></head>
<body style="margin:0;font-family:Arial,sans-serif;background:#090909;color:#fff;display:grid;place-items:center;height:100vh;text-align:center">
  <main><h2>جاري إكمال تسجيل الدخول...</h2><p>يمكنك إغلاق هذه النافذة بعد الرجوع للتطبيق.</p></main>
  <script>
    (async function(){
      var payload = (location.hash && location.hash.slice(1)) || (location.search && location.search.slice(1)) || '';
      if (payload) {
        try { await fetch('/capture?' + payload, { cache: 'no-store' }); } catch (e) {}
        try { location.href = '${PROTOCOL}://auth?' + payload; } catch (e) {}
      }
      setTimeout(function(){ window.close(); }, 1200);
    })();
  </script>
</body></html>`);
    });

    localAuthServer.listen(0, '127.0.0.1', () => {
      const address = localAuthServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      localAuthCallbackUrl = `http://127.0.0.1:${port}/auth/electron-callback`;
      resolve(localAuthCallbackUrl);
    });

    localAuthServer.on('error', () => {
      localAuthCallbackUrl = `${APP_URL}${ELECTRON_CALLBACK_PATH}`;
      resolve(localAuthCallbackUrl);
    });
  });
}

function findDeepLink(argv) {
  for (const arg of argv || []) {
    if (typeof arg !== 'string') continue;
    const match = arg.match(new RegExp(`${PROTOCOL}:\\/\\/[^\"'\\s]+`, 'i'));
    if (match) return match[0];
  }
  return null;
}

function cleanPayload(raw) {
  if (!raw) return '';
  let payload = String(raw).trim();
  for (let i = 0; i < 3; i += 1) {
    if (payload.startsWith('?') || payload.startsWith('#')) payload = payload.slice(1);
    try {
      const decoded = decodeURIComponent(payload);
      if (decoded === payload) break;
      payload = decoded;
    } catch {
      break;
    }
  }
  return payload.replace(/^\?/, '').replace(/^#/, '');
}

function extractAuthPayload(urlOrPayload) {
  const u = parseUrl(urlOrPayload);
  if (!u) {
    const direct = cleanPayload(urlOrPayload);
    return direct;
  }

  const candidates = [u.search.slice(1), u.hash.slice(1)];
  for (const key of ['url', 'returnUrl', 'redirect_to', 'redirect_uri', 'next']) {
    const value = u.searchParams.get(key) || u.hash && new URLSearchParams(u.hash.slice(1)).get(key);
    if (value) candidates.push(value);
  }

  for (const candidate of candidates) {
    const payload = cleanPayload(candidate);
    if (/(^|&)(access_token|refresh_token|code|error)=/i.test(payload)) return payload;
  }
  return cleanPayload(urlOrPayload);
}

function buildCallbackUrl(payload) {
  if (!payload) return `${APP_URL}${ELECTRON_CALLBACK_PATH}?electron=1`;
  const safePayload = payload.replace(/^\?/, '').replace(/^#/, '');
  // Send the same payload in BOTH query and hash. The current website callback
  // reads the hash, while this keeps a recoverable copy if a browser/protocol
  // handler strips the fragment during the hand-off.
  return `${APP_URL}${ELECTRON_CALLBACK_PATH}?${safePayload}#${safePayload}`;
}

function handleDeepLink(deepLink) {
  if (!deepLink || !win || win.isDestroyed()) return;
  try {
    const raw = extractAuthPayload(deepLink);
    pendingAuthPayload = raw || pendingAuthPayload;
    const target = buildCallbackUrl(raw || pendingAuthPayload);
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
      openExternalAuthUrl(url);
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
      openExternalAuthUrl(url);
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
