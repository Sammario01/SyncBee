// main/main.js
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

// Gives the taskbar the right identity and icon on Windows.
app.setAppUserModelId('com.mariobee.syncbee');

// An installed copy keeps its data (database, license, images) in the user's app-data folder,
// because the program folder is read-only. During `npm start` nothing changes.
if (app.isPackaged) {
  process.env.SYNCBEE_DATA_DIR = app.getPath('userData');

  // Puppeteer's Chromium is bundled at resources/puppeteer-cache in packaged builds.
  // These env vars tell puppeteer where to find it, since the default cache dir
  // (~/.cache/puppeteer) doesn't exist on the target machine.
  process.env.PUPPETEER_CACHE_DIR = path.join(process.resourcesPath, 'puppeteer-cache');
  const fs = require('fs');
  const chromeCandidates = [];
  try {
    const chromeRoot = path.join(process.env.PUPPETEER_CACHE_DIR, 'chrome');
    for (const ver of fs.readdirSync(chromeRoot)) {
      chromeCandidates.push(path.join(chromeRoot, ver, 'chrome-win64', 'chrome.exe'));
    }
  } catch (_) {}
  const bundledChrome = chromeCandidates.find(p => fs.existsSync(p));
  if (bundledChrome) {
    process.env.PUPPETEER_EXECUTABLE_PATH = bundledChrome;
    console.log('[puppeteer] bundled chrome:', bundledChrome);
  } else {
    console.warn('[puppeteer] no bundled chrome found under', process.env.PUPPETEER_CACHE_DIR);
  }
}

const ORIGIN = 'http://localhost:4000';
const ICON = path.join(__dirname, '..', 'public', 'img', 'app.ico');
const PRELOAD = path.join(__dirname, 'preload.js');
const WEB_PREFERENCES = { nodeIntegration: false, contextIsolation: true, preload: PRELOAD };

// After an alert/confirm dialog, Windows can leave the page unable to take typing until the
// window is switched away from and back. The pages ask for focus back and we give it here.
ipcMain.on('syncbee:refocus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.blur();
  win.focus();
  event.sender.focus();
});

// Result slips, replays, audit pages and the like open in their own windows. Give them the same
// icon, and send any outside web address to the normal browser instead of inside the app.
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: ICON, autoHideMenuBar: true, width: 1200, height: 850, backgroundColor: '#ffffff',
          webPreferences: WEB_PREFERENCES
        }
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Only one copy may run: a second would fight the first over port 4000 and the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Refuse to start if app.asar was modified (packaged builds only; dev skips).
  require('./integrity').enforceIntegrityOrQuit().catch((e) => {
    console.error('[integrity] fatal:', e);
    process.exit(1);
  });
  // Auto-update + remote kill-switch (packaged builds only; dev skips).
  const updater = require('./updater');
  // server/app.js calls app.listen(4000) as a side effect of being required.
  require('../server/app.js');
  updater.initUpdater();
  const license = require('../license/manager');

  let mainWindow = null;

  const resolveStartScreen = () => {
    const m = license.getLicenseMode();
    if (m.mode === 'unactivated') return `${ORIGIN}/activate`;
    if (m.mode === 'locked') return `${ORIGIN}/license-locked`;
    return `${ORIGIN}/admin-dashboard`; // full and read-only both open the dashboard
  };

  const createWindow = () => {
    let retries = 0;
    mainWindow = new BrowserWindow({
      width: 1280, height: 800, minWidth: 1000, minHeight: 650,
      title: 'SyncBee', icon: ICON, backgroundColor: '#0F2647', autoHideMenuBar: true,
      webPreferences: WEB_PREFERENCES
    });
    // On a slow start the server may not be listening yet: try again for a few seconds.
    mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
      if (isMainFrame && code === -102 && retries++ < 20) {
        setTimeout(() => { if (mainWindow) mainWindow.loadURL(url); }, 500);
      }
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(resolveStartScreen());
  };

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}