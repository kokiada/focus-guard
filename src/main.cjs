const { app, BrowserWindow, ipcMain, screen, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./core.cjs');

// Test runs use an isolated directory; normal runs use Electron's local userData.
if (process.env.FOCUS_GUARD_TEST_DATA) app.setPath('userData', path.resolve(process.env.FOCUS_GUARD_TEST_DATA));
let store, main, heartbeat, quitting = false;
let storageError = '';
const overlays = new Map();
const preferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
function state() { return { ...store.view(), storage_error: storageError }; }
function broadcast() {
  if (!store) return;
  if (main && !main.isDestroyed()) main.webContents.send('focus:state', state());
  for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('focus:state', overlayState());
}
function overlayState() { return { active: store.data.active ? { task_name: store.data.active.task_name, status: store.data.active.status } : null, elapsed_seconds: store.elapsed() }; }
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
}
function syncOverlays() {
  const visible = store.data.active?.status === 'running' && store.data.settings.overlay;
  const displays = screen.getAllDisplays();
  for (const [id, w] of overlays) if (!visible || !displays.some(d => d.id === id)) { w.destroy(); overlays.delete(id); }
  if (!visible) return;
  for (const d of displays) {
    const a = d.workArea, width = Math.min(320, a.width - 24), height = 86;
    const bounds = { x: a.x + a.width - width - 16, y: a.y + a.height - height - 12, width, height };
    let w = overlays.get(d.id);
    if (!w) {
      w = new BrowserWindow({ ...bounds, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, webPreferences: preferences });
      secureWindow(w);
      w.setIgnoreMouseEvents(false);
      w.setAlwaysOnTop(true, 'screen-saver');
      overlays.set(d.id, w);
      w.loadFile(path.join(__dirname, 'overlay.html'));
      w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.webContents.send('focus:state', overlayState()); w.showInactive(); } });
    } else w.setBounds(bounds);
  }
}
function showMain() {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show(); main.focus();
}
function sync() { syncOverlays(); broadcast(); }
function mutate(action, input) {
  store.transaction(() => {
    switch (action) {
      case 'task:create': return store.createTask(input);
      case 'task:edit': return store.editTask(input);
      case 'task:complete': return store.completeTask(input.id);
      case 'task:delete': return store.deleteTask(input.id);
      case 'session:start': return store.start(input);
      case 'session:suspend': return store.suspend();
      case 'session:switch': return store.switchTask(input.task_id);
      case 'session:end-suspended': return store.endSuspended(input.session_id);
      case 'session:pause': return store.pause();
      case 'session:resume': return store.resume();
      case 'session:end': return store.end();
      case 'settings:overlay': store.data.settings.overlay = Boolean(input.visible); return;
      default: throw Error('未対応の操作です。');
    }
  });
  storageError = ''; sync(); return state();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app.whenReady().then(() => {
    // No remote content, telemetry, or runtime network requests.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') }));
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try { store = new Store(app.getPath('userData')); }
    catch (error) { dialog.showErrorBox('保存データを読み込めません', `${error.message}\n元のデータは上書きしていません。\n${app.getPath('userData')}`); app.quit(); return; }
    ipcMain.handle('focus:command', async (event, action, input = {}) => {
      const isMain = main && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame;
      const isOverlay = [...overlays.values()].some(w => w.webContents === event.sender);
      if (!isMain && !(isOverlay && ['state', 'window:show'].includes(action))) throw Error('この画面では操作できません。');
      try {
        if (action === 'window:show') { showMain(); return { ok: true }; }
        if (action === 'window:minimize') { main.minimize(); return { ok: true }; }
        if (action === 'window:maximize') { main.isMaximized() ? main.unmaximize() : main.maximize(); return { ok: true }; }
        if (action === 'window:close') { main.close(); return { ok: true }; }
        if (action === 'state') return { ok: true, data: isMain ? state() : overlayState() };
        if (action === 'export') {
          const result = await dialog.showSaveDialog(main, { title: '作業ログを書き出す', defaultPath: `focus-guard-${new Date().toISOString().slice(0, 10)}.jsonl`, filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
          if (result.canceled) return { ok: true, canceled: true };
          if ([store.file, store.file + '.tmp'].some(file => path.resolve(file).toLowerCase() === path.resolve(result.filePath).toLowerCase())) throw Error('保存データとは別のファイルを選んでください。');
          fs.writeFileSync(result.filePath, store.exportJSONL(), 'utf8');
          return { ok: true, path: result.filePath };
        }
        return { ok: true, data: mutate(action, input) };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    main = new BrowserWindow({ frame: false, width: 1160, height: 820, minWidth: 850, minHeight: 640, title: 'Focus Guard', icon: path.join(__dirname, '../assets/icon.ico'), backgroundColor: '#f6f7f9', autoHideMenuBar: true, webPreferences: preferences });
    secureWindow(main); main.loadFile(path.join(__dirname, 'index.html'));
    main.on('close', event => {
      if (quitting) return;
      try { if (store.data.active) store.transaction(() => store.end('app_closed')); }
      catch (error) { event.preventDefault(); dialog.showErrorBox('終了前の保存に失敗しました', error.message); return; }
      quitting = true; clearInterval(heartbeat); for (const w of overlays.values()) w.destroy(); overlays.clear();
    });
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, syncOverlays);
    heartbeat = setInterval(() => {
      if (store.data.active?.status === 'running') {
        try { store.transaction(() => { store.data.active.heartbeat = Date.now(); }); storageError = ''; }
        catch (error) { storageError = `保存できません: ${error.message}`; }
      }
      broadcast();
    }, 1000);
    sync();
  });
  app.on('window-all-closed', () => app.quit());
}
