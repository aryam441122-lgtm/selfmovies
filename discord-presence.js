// Discord Rich Presence integration for Self Movies
// Application (Client) ID from Discord Developer Portal
// Make sure an Art Asset named exactly "selfmovies" is uploaded under
// Rich Presence → Art Assets in the Discord Developer Portal.

let RPC;
try {
  RPC = require('discord-rpc');
} catch (err) {
  console.warn('[discord-rpc] not installed — Rich Presence disabled.');
  module.exports = { startDiscordPresence: () => {}, stopDiscordPresence: () => {} };
  return;
}

const CLIENT_ID = '1302405087112597594';
const LARGE_IMAGE_KEY = 'selfmovies';

let rpc = null;
let startTimestamp = null;
let reconnectTimer = null;
let connected = false;

RPC.register(CLIENT_ID);

function buildActivity() {
  return {
    type: 3, // WATCHING
    details: 'أفلام ومسلسلات مجاناً',
    state: 'بدون إعلانات',
    startTimestamp: startTimestamp || new Date(),
    largeImageKey: LARGE_IMAGE_KEY,
    largeImageText: 'Self Movies',
    instance: false,
  };
}

async function setActivity() {
  if (!rpc || !connected) return;
  try {
    await rpc.setActivity(buildActivity());
  } catch (err) {
    console.warn('[discord-rpc] setActivity failed:', err?.message || err);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startDiscordPresence();
  }, 15000);
}

function startDiscordPresence() {
  if (rpc) return;
  startTimestamp = startTimestamp || new Date();
  rpc = new RPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    connected = true;
    setActivity();
    // Refresh every 15s so elapsed time stays accurate
    setInterval(setActivity, 15000);
  });

  rpc.on('disconnected', () => {
    connected = false;
    try { rpc?.destroy(); } catch {}
    rpc = null;
    scheduleReconnect();
  });

  rpc.login({ clientId: CLIENT_ID }).catch((err) => {
    // Discord not running, or IPC pipe not available. Try again later.
    connected = false;
    try { rpc?.destroy(); } catch {}
    rpc = null;
    scheduleReconnect();
  });
}

function stopDiscordPresence() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (rpc) {
    try { rpc.clearActivity(); } catch {}
    try { rpc.destroy(); } catch {}
  }
  rpc = null;
  connected = false;
}

module.exports = { startDiscordPresence, stopDiscordPresence };
