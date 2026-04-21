/**
 * dictation — Electron main process
 * v0.3 バックグラウンド常駐・最前面/半透明トグル・ホットキー・タスクトレイ
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev');
const userDataDir = app.getPath('userData');
const stateFile = path.join(userDataDir, 'window-state.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { width: 520, height: 720, x: undefined, y: undefined, alwaysOnTop: false, opacity: 1.0 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const data = {
    ...bounds,
    alwaysOnTop: mainWindow.isAlwaysOnTop(),
    opacity: mainWindow.getOpacity(),
  };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('saveWindowState failed', e);
  }
}

function createWindow() {
  const s = loadWindowState();

  mainWindow = new BrowserWindow({
    width: s.width,
    height: s.height,
    x: s.x,
    y: s.y,
    minWidth: 360,
    minHeight: 420,
    alwaysOnTop: s.alwaysOnTop,
    opacity: s.opacity ?? 1.0,
    backgroundColor: '#1a1a1f',
    title: 'dictation',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem' || permission === 'audioCapture') {
      callback(true);
    } else {
      callback(true);
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    } else {
      saveWindowState();
    }
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildTrayMenu() {
  const onTop = mainWindow?.isAlwaysOnTop() ?? false;
  const opacity = mainWindow?.getOpacity() ?? 1.0;
  const isTranslucent = opacity < 1.0;

  return Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? '隠す' : '表示',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: '常に最前面',
      type: 'checkbox',
      checked: onTop,
      click: () => toggleAlwaysOnTop(),
    },
    {
      label: '半透明',
      type: 'checkbox',
      checked: isTranslucent,
      click: () => toggleTransparent(),
    },
    { type: 'separator' },
    {
      label: 'ホットキー: Ctrl+Shift+D で表示切替',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let image;
  if (fs.existsSync(iconPath)) {
    image = nativeImage.createFromPath(iconPath);
  } else {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('dictation');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
}

function updateTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
  broadcastState();
}

function hideWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
  updateTrayMenu();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function toggleAlwaysOnTop() {
  if (!mainWindow) return;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  saveWindowState();
  updateTrayMenu();
  broadcastState();
}

function toggleTransparent() {
  if (!mainWindow) return;
  const current = mainWindow.getOpacity();
  const next = current < 1.0 ? 1.0 : 0.75;
  mainWindow.setOpacity(next);
  saveWindowState();
  updateTrayMenu();
  broadcastState();
}

function broadcastState() {
  if (!mainWindow) return;
  mainWindow.webContents.send('window-state', {
    alwaysOnTop: mainWindow.isAlwaysOnTop(),
    opacity: mainWindow.getOpacity(),
  });
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+D', () => toggleWindow());
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    createWindow();
    createTray();
    registerShortcuts();
  });
}

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('win:toggleAlwaysOnTop', () => { toggleAlwaysOnTop(); });
ipcMain.handle('win:toggleTransparent', () => { toggleTransparent(); });
ipcMain.handle('win:minimize', () => mainWindow?.minimize());
ipcMain.handle('win:hideToTray', () => hideWindow());
ipcMain.handle('win:close', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.handle('win:getState', () => ({
  alwaysOnTop: mainWindow?.isAlwaysOnTop() ?? false,
  opacity: mainWindow?.getOpacity() ?? 1.0,
}));
