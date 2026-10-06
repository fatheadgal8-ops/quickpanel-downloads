'use strict';
/**
 * QuickPanel Desktop
 * A native window around your live QuickPanel Dashboard. The website does all
 * the real work, so site updates show up here automatically -- this shell
 * only handles the window, links, the offline screen and a few app niceties.
 */
const { app, BrowserWindow, Menu, shell, screen, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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

function createWindow() {
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

  win.loadURL(SITE_URL);
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
    if (!mainWindow) return;
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
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
