// main/updater.js
//
// Auto-update + remote kill-switch for SyncBee.
//
// On startup (packaged builds only), checks GitHub Releases for a newer
// version. If found, downloads it, and applies on next restart. If the
// licence server flags a min_supported_version higher than the running
// version, forces the update and blocks normal use until the app restarts.

const { app, dialog, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

// How often to re-check while the app is running (6 hours)
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let initialized = false;
let checkTimer = null;

function compareVersions(a, b) {
  // Returns -1 if a < b, 0 if equal, 1 if a > b. Handles "1.0.10" > "1.0.9".
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function showKillSwitchDialog(minVersion) {
  // Blocking dialog — user can't dismiss it and keep using the old version.
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'error',
    title: 'SyncBee must be updated',
    message: 'This version of SyncBee is no longer supported.',
    detail:
      `A required update to version ${minVersion} or newer is available.\n\n` +
      'Please restart SyncBee to update. If the update does not start automatically, ' +
      'download the latest installer from Mariobee support.',
    buttons: ['Update now', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  if (choice === 1) {
    app.quit();
    return false;
  }
  // Trigger the update; the app will quit when it's ready to install.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    dialog.showErrorBox(
      'Update failed',
      'Could not download the update. Please check your internet connection and try again.'
    );
    app.quit();
  });
  return true;
}

function wireEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // Never block the app on an update error. Log only.
    console.error('[updater] error:', err && err.message);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version);
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'info',
      title: 'SyncBee update ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart SyncBee now to apply the update, or it will install the next time you close the app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    };
    const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });
}

function startCheckLoop() {
  const check = () => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] check failed:', err && err.message);
    });
  };
  // Initial check 5 seconds after startup, then every CHECK_INTERVAL_MS
  setTimeout(check, 5000);
  checkTimer = setInterval(check, CHECK_INTERVAL_MS);
}

function initUpdater() {
  if (initialized) return;
  initialized = true;

  // Dev mode: do nothing. Never auto-update when running `npm start`.
  if (!app.isPackaged) {
    console.log('[updater] dev mode — skipping auto-update');
    return;
  }

  // Check the kill switch: if the licence data says our version is too old,
  // force the update before doing anything else.
  try {
    const license = require('../license/manager');
    const info = license.getLicenseInfo();
    // The licence server returns min_supported_version in the signed payload
    // and we surface it through getLicenseInfo(). If it's higher than our
    // running version, force the update.
    const minVersion = info && info.min_supported_version;
    if (minVersion && compareVersions(app.getVersion(), minVersion) < 0) {
      console.warn('[updater] running', app.getVersion(), 'but min supported is', minVersion, '— forcing update');
      if (!showKillSwitchDialog(minVersion)) return; // user chose Quit
      // The dialog will trigger the update; stop here.
      return;
    }
  } catch (err) {
    console.error('[updater] kill-switch check failed:', err && err.message);
    // Never block the app on kill-switch error. Fall through to normal update check.
  }

  wireEvents();
  startCheckLoop();
}

function stopUpdater() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

module.exports = { initUpdater, stopUpdater, compareVersions };