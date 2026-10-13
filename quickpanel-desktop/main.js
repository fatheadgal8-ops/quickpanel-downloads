'use strict';
/**
 * QuickPanel Desktop
 * A native window around your live QuickPanel Dashboard. The website does all
 * the real work, so site updates show up here automatically -- this shell
 * only handles the window, links, the offline screen and a few app niceties.
 */
const { app, BrowserWindow, Menu, Tray, Notification, globalShortcut, desktopCapturer, dialog, systemPreferences, nativeImage, shell, screen, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Which website this app opens ───────────────────────────────────────────
// Priority: QUICKPANEL_URL env var  >  <user data>/config.json  >  app-config.json
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function normalizeUrl(u) {
  if (typeof u !== 'string') return null;
  u = u.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) return null;
  try { new URL(u); return u; } catch (_) { return null; }
}
function resolveSiteUrl() {
  const picks = [
    process.env.QUICKPANEL_URL,
    readJson(path.join(app.getPath('userData'), 'config.json')).url,
    readJson(path.join(__dirname, 'app-config.json')).url,
  ];
  for (const p of picks) { const n = normalizeUrl(p); if (n) return n; }
  return 'https://quickpanelrbx.freesrv.com';
}

const SITE_URL = resolveSiteUrl();
const SITE_ORIGIN = new URL(SITE_URL).origin;
const OFFLINE_FILE = path.join(__dirname, 'offline.html');
const DEBUG = !!process.env.QP_DEBUG;

// Identify ourselves to the server (so the site can tell it's the desktop app)
// and drop the "Electron/x" token that makes some sites treat us differently.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/[\d.]+/i, '')
  .replace(/\s[\w.-]+\/[\d.]+(?=\sChrome\/)/i, '')
  + ' QuickPanelDesktop/' + app.getVersion();

if (process.platform === 'win32') app.setAppUserModelId('com.quickpanel.dashboard');
app.setAboutPanelOptions({
  applicationName: 'QuickPanel',
  applicationVersion: app.getVersion(),
  copyright: 'QuickPanel Dashboard',
  website: SITE_URL,
});

// ── Link handling: our site (and Stripe checkout) stay in the app, rest opens in the browser ──
function isOfflineFrame(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)).endsWith(path.basename(OFFLINE_FILE));
  } catch (_) { return false; }
}
function isInternal(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol === 'file:') return isOfflineFrame(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.origin === SITE_ORIGIN || u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com');
}
function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch (_) { /* ignore malformed */ }
}

// ── Remember window size/position between launches ─────────────────────────
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  const s = readJson(stateFile());
  const fallback = { width: 1280, height: 820 };
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return fallback;
  const state = { width: Math.max(900, s.width), height: Math.max(600, s.height), maximized: !!s.maximized };
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    // Only reuse the position if it's still on a connected screen.
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return s.x + 100 < a.x + a.width && s.x + s.width - 100 > a.x && s.y >= a.y - 10 && s.y + 100 < a.y + a.height;
    });
    if (visible) { state.x = s.x; state.y = s.y; }
  }
  return state;
}
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (_) { /* non-fatal */ }
}

// ── Window ─────────────────────────────────────────────────────────────────
let mainWindow = null;

// ── Clips: record Roblox, press a key, get a named link ────────────────────
// Only the Roblox window is recorded, and only while clip recording is turned on. Nothing leaves the PC until you press the key.
const CLIP_KEY = 'CommandOrControl+Shift+C';
const CLIP_KEY_TEXT = process.platform === 'darwin' ? 'Cmd+Shift+C' : 'Ctrl+Shift+C';
const clipSettingsFile = () => path.join(app.getPath('userData'), 'clip-settings.json');
const clip = Object.assign({ enabled: false, sound: true, consented: false }, readJson(clipSettingsFile()));
function saveClipSettings() { try { fs.writeFileSync(clipSettingsFile(), JSON.stringify(clip)); } catch (_) { /* non-fatal */ } }

let recWin = null, recState = 'idle', recStarting = false, tray = null, pollTimer = null;
let quitting = false;

function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (_) { /* non-fatal */ }
}
function findRoblox() {
  return desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
    .then((list) => list.find((s) => /^roblox$/i.test((s.name || '').trim())) || null)
    .catch(() => null);
}
function ensureRecWin() {
  if (recWin && !recWin.isDestroyed()) return recWin;
  const ses = session.fromPartition('qp-recorder');
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const src = await findRoblox();
    if (!src) return cb({});
    const r = { video: src };
    if (clip.sound && process.platform === 'win32') r.audio = 'loopback';
    cb(r);
  });
  recWin = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'recorder-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'qp-recorder' },
  });
  recWin.loadFile(path.join(__dirname, 'recorder.html'));
  recWin.on('closed', () => { recWin = null; recState = 'idle'; updateTray(); });
  return recWin;
}
async function recStart() {
  if (recStarting || recState === 'recording') return;
  recStarting = true;
  try {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      notify('Allow screen recording', 'Open System Settings, Privacy & Security, Screen Recording, turn on QuickPanel, then restart the app.');
      return;
    }
    const w = ensureRecWin();
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', r));
    // The "true" counts as a user gesture, which the browser requires before it will start a screen capture.
    await w.webContents.executeJavaScript('qpStart(' + (clip.sound && process.platform === 'win32' ? 'true' : 'false') + ')', true);
  } catch (_) { /* reported through qp:rec-status */ }
  finally { recStarting = false; }
}
function recStop() {
  if (recWin && !recWin.isDestroyed()) recWin.webContents.executeJavaScript('qpStop()').catch(() => {});
  recState = 'idle'; updateTray();
}
async function pollRoblox() {
  if (!clip.enabled) { if (recState === 'recording') recStop(); return; }
  const src = await findRoblox();
  if (src && recState !== 'recording' && !recStarting) recStart();
  else if (!src && recState === 'recording') recStop();
}
ipcMain.on('qp:rec-status', (event, status) => {
  if (!recWin || event.sender !== recWin.webContents) return;
  if (status === 'recording') { recState = 'recording'; updateTray(); return; }
  if (status === 'ended') { recState = 'idle'; updateTray(); return; }
  if (status === 'saving') return;
  const msgs = {
    toosoon: ['Keep playing a little longer', 'Recording just started. Try again in a few seconds.'],
    empty: ["Nothing to save yet", 'Try again in a few seconds.'],
    toobig: ['That clip is too big', 'Lower your game resolution and try again.'],
  };
  if (msgs[status]) notify(msgs[status][0], msgs[status][1]);
  else if (status.startsWith('error')) { recState = 'idle'; updateTray(); notify("Couldn't record", 'QuickPanel could not capture the Roblox window. Make sure Roblox is open, then try again.'); }
});
function onClipKey() {
  if (!clip.enabled) { notify('Clip recording is off', 'Turn it on from the QuickPanel tray icon or the Clips menu.'); return; }
  if (recState !== 'recording' || !recWin) { notify('Roblox not detected', 'Open Roblox, wait a moment, then press ' + CLIP_KEY_TEXT + ' again.'); return; }
  recWin.webContents.send('qp:rec-save');
}
ipcMain.handle('qp:clip-data', async (event, buf, meta) => {
  if (!recWin || event.sender !== recWin.webContents) return { ok: false };
  const ext = /mp4/.test(String(meta && meta.type)) ? '.mp4' : '.webm';
  const dir = path.join(app.getPath('userData'), 'clips');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const file = path.join(dir, 'clip-' + Date.now() + ext);
  try { fs.writeFileSync(file, Buffer.from(buf)); } catch (_) { notify("Couldn't save the clip", 'Your disk may be full.'); return { ok: false }; }
  uploadClip(file, ext, Math.max(0, Math.min(Number(meta && meta.seconds) || 0, 300)));
  return { ok: true };
});
async function uploadClip(file, ext, seconds) {
  notify('Saving your clip…', 'Sending it to QuickPanel.');
  const keep = () => shell.showItemInFolder(file);
  try {
    const data = fs.readFileSync(file);
    const b = '----qp' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    const field = (n, v) => parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n'));
    field('source', 'desktop'); field('duration', String(seconds)); field('game', 'Roblox');
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="clip"; filename="clip' + ext + '"\r\nContent-Type: ' + (ext === '.mp4' ? 'video/mp4' : 'video/webm') + '\r\n\r\n'), data, Buffer.from('\r\n--' + b + '--\r\n'));
    // Uses the same sign-in as the app window, so there is nothing extra to log into.
    const res = await session.defaultSession.fetch(SITE_URL + '/api/clips/upload', {
      method: 'POST', credentials: 'include', redirect: 'manual',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + b }, body: Buffer.concat(parts),
    });
    let j = null;
    try { if (((res.headers.get('content-type')) || '').includes('json')) j = await res.json(); } catch (_) { /* not json */ }
    if (j && j.ok) { fs.unlink(file, () => {}); notify('🎬 Clip saved', 'Click to name it and get a share link.', () => openPath('/clips?new=' + encodeURIComponent(j.clip.id))); return; }
    if (!j) { notify('Sign in to save clips', 'Sign in to QuickPanel, then clip again. This one is saved on your PC.', keep); return; }
    notify("Couldn't save the clip", (j.message || 'Try again.') + ' It is saved on your PC.', keep);
  } catch (_) { notify("Couldn't upload the clip", 'Check your connection. It is saved on your PC.', keep); }
}
function pruneOldClips() {
  try {
    const dir = path.join(app.getPath('userData'), 'clips'), cutoff = Date.now() - 14 * 86400000;
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); }
  } catch (_) { /* nothing to prune */ }
}
async function setClipEnabled(on) {
  if (on && !clip.consented) {
    const r = await dialog.showMessageBox({
      type: 'info', buttons: ['Turn on', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Record clips', message: 'Turn on clip recording?',
      detail: 'QuickPanel records only the Roblox window, and only while Roblox is open. It keeps about the last 45 seconds on your PC and uploads nothing until you press ' + CLIP_KEY_TEXT + '. ' +
        (process.platform === 'win32' ? 'Your computer\'s sound (including voice chat) is included unless you turn off "Record game sound" in the Clips menu.' : 'Sound is not recorded on this system.'),
    });
    if (r.response !== 0) { buildMenu(); updateTray(); return; }
    clip.consented = true;
  }
  clip.enabled = !!on; saveClipSettings(); buildMenu(); updateTray();
  if (on) pollRoblox(); else recStop();
}
function setClipSound(on) { clip.sound = !!on; saveClipSettings(); if (recState === 'recording') { recStop(); setTimeout(pollRoblox, 600); } buildMenu(); updateTray(); }
function openPath(p) {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(p); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus(); mainWindow.loadURL(SITE_URL + p);
}
function updateTray() {
  if (!tray) return;
  const status = !clip.enabled ? 'Clip recording is off' : recState === 'recording' ? 'Recording Roblox · ' + CLIP_KEY_TEXT + ' saves a clip' : 'Waiting for Roblox to open';
  tray.setToolTip('QuickPanel · ' + status);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false }, { type: 'separator' },
    { label: 'Record clips (only while Roblox is open)', type: 'checkbox', checked: clip.enabled, click: (i) => setClipEnabled(i.checked) },
    { label: 'Save a clip now (' + CLIP_KEY_TEXT + ')', enabled: recState === 'recording', click: onClipKey },
    { label: 'My clips', click: () => openPath('/clips') },
    { label: 'Open QuickPanel', click: () => openPath('') },
    { type: 'separator' }, { label: 'Quit QuickPanel', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'window-icon.png')).resize({ width: 18, height: 18 });
    tray = new Tray(img); tray.on('click', () => openPath('')); updateTray();
  } catch (_) { tray = null; }
}


function showOffline(reason, edit) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(OFFLINE_FILE, { query: { target: SITE_URL, reason: reason || '', edit: edit ? '1' : '' } });
}

// Lets people point the app at a new address without reinstalling (e.g. if the site moves to a new domain).
// Only the built-in offline screen may ask for this -- never a website.
ipcMain.handle('qp:set-site-url', (event, raw) => {
  if (!event.senderFrame || !isOfflineFrame(event.senderFrame.url)) return { ok: false, error: 'Not allowed here.' };
  const url = normalizeUrl(raw);
  if (!url) return { ok: false, error: 'Enter the full address, starting with https://' };
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'config.json'), JSON.stringify({ url }));
  } catch (_) { return { ok: false, error: "Couldn't save the new address." }; }
  setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
  return { ok: true };
});

function createWindow(startPath) {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 900, minHeight: 600,
    show: false,
    backgroundColor: '#0a0d14',          // matches the site so there's no white flash
    title: 'QuickPanel',
    icon: path.join(__dirname, 'build', 'window-icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  const win = mainWindow;
  if (state.maximized) win.maximize();

  let shown = false;
  const reveal = () => { if (!shown && !win.isDestroyed()) { shown = true; win.show(); } };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 5000);              // never leave the user with an invisible window

  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) { event.preventDefault(); openExternalSafe(url); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) { win.loadURL(url); } else { openExternalSafe(url); }
    return { action: 'deny' };
  });
  contents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // -3 = navigation cancelled, not a real failure
    showOffline(desc);
  });
  contents.on('render-process-gone', () => showOffline('The page crashed'));

  // Small right-click menu (copy/paste, open links in the browser)
  contents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push({ label: 'Open Link in Browser', click: () => openExternalSafe(p.linkURL) });
      items.push({ label: 'Copy Link Address', click: () => require('electron').clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveWindowState(win), 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => { mainWindow = null; });

  win.loadURL(SITE_URL + (typeof startPath === 'string' ? startPath : ''));
}

// ── Menu ───────────────────────────────────────────────────────────────────
function navigate(dir) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const c = mainWindow.webContents;
  const h = c.navigationHistory;
  if (dir === 'back') { if (h ? h.canGoBack() : c.canGoBack()) (h ? h.goBack() : c.goBack()); }
  else if (h ? h.canGoForward() : c.canGoForward()) (h ? h.goForward() : c.goForward());
}
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => navigate('back') },
      { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => navigate('forward') },
      { type: 'separator' },
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(DEBUG ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []) ] },
    { label: 'Clips', submenu: [
      { label: 'Record clips (only while Roblox is open)', type: 'checkbox', checked: clip.enabled, click: (i) => setClipEnabled(i.checked) },
      { label: 'Save a clip now (' + CLIP_KEY_TEXT + ')', enabled: clip.enabled, click: onClipKey },
      { label: 'Record game sound', type: 'checkbox', checked: clip.sound, enabled: process.platform === 'win32', click: (i) => setClipSound(i.checked) },
      { type: 'separator' },
      { label: 'My clips', click: () => openPath('/clips') } ] },
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]) ] },
    { label: 'Help', submenu: [
      { label: 'Open QuickPanel in Browser', click: () => openExternalSafe(SITE_URL) },
      { label: 'Service Status', click: () => openExternalSafe(SITE_URL + '/status') },
      { label: 'Report an Issue', click: () => openExternalSafe(SITE_URL + '/status_report') },
      { type: 'separator' },
      { label: 'Change Site Address…', click: () => showOffline('', true) },
      { label: 'QuickPanel Desktop v' + app.getVersion(), enabled: false } ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();                              // already running -> the first window gets focus instead
} else {
  app.on('second-instance', () => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });

  app.on('web-contents-created', (_e, c) => c.on('will-attach-webview', ev => ev.preventDefault()));

  app.whenReady().then(() => {
    // Deny device/notification permission prompts; the dashboard needs none of them.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
    buildMenu();
    createWindow();
    createTray();
    pruneOldClips();
    if (!globalShortcut.register(CLIP_KEY, onClipKey)) console.warn('Could not register the clip key');
    pollTimer = setInterval(pollRoblox, 4000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} clearInterval(pollTimer); });
  // With clip recording on, closing the window keeps QuickPanel running in the tray so the hotkey still works.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && (!clip.enabled || quitting)) app.quit(); });
}
