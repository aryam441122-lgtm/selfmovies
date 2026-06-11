// Self Movies — Electron shell for https://selfy.lovable.app
//
// OAuth flow:
//   1. Site triggers OAuth — either window.open(authUrl), window.location = authUrl,
//      or a redirect chain that starts with https://selfy.lovable.app/~oauth/initiate
//   2. We intercept ALL of those (navigation, redirects, popups) and open the
//      final URL in the user's default browser (Chrome/Edge/…).
//   3. The site redirects back to selfmovies://auth?<tokens> after consent.
//   4. Windows fires our protocol handler -> we write the auth session into
//      the app webview storage, then reload the site already signed in.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://selfy.lovable.app';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = 'selfmovies';
const ELECTRON_CALLBACK_PATH = '/auth/electron-callback';
const SUPABASE_URL = 'https://akmldmfvyutcjrcwvhgf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrbWxkbWZ2eXV0Y2pyY3d2aGdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwNzQ1MzQsImV4cCI6MjA5MTY1MDUzNH0.vm0jXHIQTlUTi6NpWdU8aU7L6l_2tN_L-YxitcBRFSw';
const SUPABASE_STORAGE_KEY = 'sb-akmldmfvyutcjrcwvhgf-auth-token';
const ALLOWED_AUTH_PROVIDERS = new Set(['google', 'apple']);

// Same-origin paths that START an OAuth flow — must be opened in the system browser
const APP_OAUTH_PATH_PATTERNS = [
  /^\/~oauth\//i,           // Lovable Cloud managed OAuth broker
  /^\/auth\/v1\/authorize/i,
  /^\/auth\/oauth/i,
];

// External auth hosts — only the supported login flow may leave the app.
const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)accounts\.youtube\.com$/i,
  /(^|\.)oauth2?\.googleapis\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)icloud\.com$/i,
  /(^|\.)idmsa\.apple\.com$/i,
];

function parseUrl(u) { try { return new URL(u); } catch { return null; } }
function isAppOrigin(url) { const u = parseUrl(url); return !!u && u.origin === ALLOWED_ORIGIN; }
function getProvider(url) {
  const u = parseUrl(url);
  return (u?.searchParams.get('provider') || u?.searchParams.get('provider_id') || '').toLowerCase();
}
function isAllowedAuthProvider(url) {
  const provider = getProvider(url);
  return provider ? ALLOWED_AUTH_PROVIDERS.has(provider) : true;
}
function isAppOAuthPath(url) {
  const u = parseUrl(url);
  if (!u || u.origin !== ALLOWED_ORIGIN) return false;
  return APP_OAUTH_PATH_PATTERNS.some((re) => re.test(u.pathname)) && isAllowedAuthProvider(url);
}
function isLovableOAuthBrokerUrl(url) {
  const u = parseUrl(url);
  return !!u && /(^|\.)oauth\.lovable\.app$/i.test(u.hostname) && /^\/initiate/i.test(u.pathname) && isAllowedAuthProvider(url);
}
function isSupabaseOAuthAuthorizeUrl(url) {
  const u = parseUrl(url);
  return !!u && u.origin === new URL(SUPABASE_URL).origin && /^\/auth\/v1\/authorize/i.test(u.pathname) && isAllowedAuthProvider(url);
}
function isProviderAuthUrl(url) {
  const u = parseUrl(url);
  return !!u && AUTH_HOST_PATTERNS.some((re) => re.test(u.hostname));
}
function shouldOpenExternal(url) {
  return isAppOAuthPath(url) || isLovableOAuthBrokerUrl(url) || isSupabaseOAuthAuthorizeUrl(url) || isProviderAuthUrl(url);
}

async function openExternalAuthUrl(url) {
  // The Lovable OAuth broker has a strict allow-list for redirect_uri,
  // so we MUST NOT override it. Just open the URL as-is in the system
  // browser. The site's /auth/electron-callback page handles the rest by
  // redirecting to selfmovies://auth#<tokens>.
  shell.openExternal(url);
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
  if (!payload) return APP_URL;
  const safePayload = payload.replace(/^\?/, '').replace(/^#/, '');
  return `${APP_URL}${ELECTRON_CALLBACK_PATH}#${safePayload}`;
}

async function fetchUserForSession(accessToken) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function sessionFromPayload(payload) {
  const params = new URLSearchParams(cleanPayload(payload));
  const accessToken = params.get('access_token') || '';
  const refreshToken = params.get('refresh_token') || '';
  if (!accessToken || !refreshToken) return null;

  const claims = decodeJwtPayload(accessToken) || {};
  const expiresIn = Number(params.get('expires_in')) || Math.max(60, Number(claims.exp || 0) - Math.floor(Date.now() / 1000)) || 3600;
  const expiresAt = Number(params.get('expires_at')) || Number(claims.exp) || Math.floor(Date.now() / 1000) + expiresIn;

  return {
    access_token: accessToken,
    token_type: params.get('token_type') || 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    provider_token: params.get('provider_token') || null,
    provider_refresh_token: params.get('provider_refresh_token') || null,
    user: {
      id: claims.sub || '',
      aud: claims.aud || 'authenticated',
      role: claims.role || 'authenticated',
      email: claims.email || '',
      email_confirmed_at: claims.email ? new Date((claims.iat || Date.now() / 1000) * 1000).toISOString() : null,
      phone: claims.phone || '',
      confirmed_at: new Date((claims.iat || Date.now() / 1000) * 1000).toISOString(),
      last_sign_in_at: new Date().toISOString(),
      app_metadata: claims.app_metadata || {},
      user_metadata: claims.user_metadata || {},
      identities: [],
      created_at: new Date((claims.iat || Date.now() / 1000) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      is_anonymous: false,
    },
  };
}

function loadAppUrl(url) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onFinish);
      win.webContents.removeListener('did-fail-load', onFail);
      resolve(ok);
    };
    const onFinish = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), 10000);
    win.webContents.once('did-finish-load', onFinish);
    win.webContents.once('did-fail-load', onFail);
    win.loadURL(url).catch(() => finish(false));
  });
}

async function writeSessionToWebview(payload) {
  const authSession = sessionFromPayload(payload);
  if (!authSession || !win || win.isDestroyed()) return false;

  const user = await fetchUserForSession(authSession.access_token);
  if (user && user.id) authSession.user = user;

  if (!isAppOrigin(win.webContents.getURL())) await loadAppUrl(APP_URL);

  const storedValue = JSON.stringify(authSession);
  const script = `(() => {
    const key = ${JSON.stringify(SUPABASE_STORAGE_KEY)};
    const value = ${JSON.stringify(storedValue)};
    localStorage.setItem(key, value);
    sessionStorage.setItem('selfmovies:last-auth-sync', String(Date.now()));
    window.dispatchEvent(new Event('selfmovies-auth-sync'));
    return localStorage.getItem(key) === value;
  })()`;

  try {
    const ok = await win.webContents.executeJavaScript(script, true);
    return ok === true;
  } catch {
    await loadAppUrl(APP_URL);
    try { return await win.webContents.executeJavaScript(script, true) === true; } catch { return false; }
  }
}

async function handleDeepLink(deepLink) {
  if (!deepLink || !win || win.isDestroyed()) return;
  try {
    const raw = extractAuthPayload(deepLink);
    pendingAuthPayload = raw || pendingAuthPayload;
    const payload = raw || pendingAuthPayload;
    if (payload) {
      const stored = await writeSessionToWebview(payload);
      if (stored) {
        pendingAuthPayload = '';
        await loadAppUrl(APP_URL);
      } else {
        await loadAppUrl(buildCallbackUrl(payload));
      }
    } else {
      await loadAppUrl(APP_URL);
    }
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

  if (isMain) {
    // Main window: only intercept OAuth URLs (Google/Apple) to open in the
    // system browser. Everything else — including iframes, embedded players,
    // and any other navigation — is allowed normally.
    const interceptOAuth = (event, url) => {
      if (shouldOpenExternal(url)) {
        event.preventDefault();
        openExternalAuthUrl(url);
      }
    };
    contents.on('will-navigate', interceptOAuth);
    contents.on('will-redirect', interceptOAuth);
  }

  // Block ALL new tabs/popups. If it's an OAuth URL, send it to the system
  // browser instead. Otherwise just deny silently.
  contents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternal(url)) {
      openExternalAuthUrl(url);
    }
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

  // Cancel any download attempts immediately.
  win.webContents.session.on('will-download', (event, item) => {
    event.preventDefault();
    try { item.cancel(); } catch {}
  });

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

// Close any popup webContents that slips past setWindowOpenHandler.
// (iframes are part of the main webContents and are NOT affected here.)
app.on('web-contents-created', (_e, contents) => {
  if (contents !== win?.webContents) {
    try { contents.close(); } catch {
      try { contents.destroy(); } catch {}
    }
    return;
  }
  contents.on('devtools-opened', () => { try { contents.closeDevTools(); } catch {} });
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.close());
