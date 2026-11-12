// server/backup-scheduler.js
// Runs a daily automatic backup of the SQLite database, using the same
// mechanics as the manual "Create Backup Now" button, but on a timer.
//
// Design notes:
//  • Runs an hourly check, not a single 24h setTimeout — self-healing across
//    server restarts. If the process dies at 22:59 and comes back at 23:15,
//    the next hourly tick still triggers today's backup.
//  • If the server is started *after* BACKUP_HOUR and no auto-backup has
//    run today yet, one runs on the first tick (~60s after startup).
//  • Failures are logged to backup_log with status = 'failed', and the
//    existing checkBackups() alert will pick them up.

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const BACKUP_DIR = require('./paths').backupsDir;
const BACKUP_HOUR      = 0;   // 11 PM server-local time
const BACKUP_RETENTION = 14;   // keep the newest N .db files

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── helpers ────────────────────────────────────────────────────────────
function lastAutoBackupDate() {
  const row = db.prepare(`
    SELECT created_at FROM backup_log
    WHERE reason = 'auto_daily' AND status = 'success'
    ORDER BY id DESC LIMIT 1
  `).get();

  if (!row || !row.created_at) return null;
  // Compare on date only (YYYY-MM-DD in UTC)
  return String(row.created_at).slice(0, 10);
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('syncbee-') && f.endsWith('.db'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      return { name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(BACKUP_RETENTION);
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      db.prepare('DELETE FROM backup_log WHERE filename = ?').run(f.name);
    } catch (_) { /* best effort */ }
  }
}

async function runAutoBackup() {
  const stamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `syncbee-${stamp}.db`;
  const destPath = path.join(BACKUP_DIR, filename);

  try {
    await db.backup(destPath);
    const size = fs.statSync(destPath).size;

    db.prepare(`
      INSERT INTO backup_log (filename, size_bytes, reason, status)
      VALUES (?, ?, 'auto_daily', 'success')
    `).run(filename, size);

    pruneOldBackups();

    console.log(`[backup-scheduler] Auto backup created: ${filename} (${Math.round(size / 1024)} KB)`);
  } catch (err) {
    db.prepare(`
      INSERT INTO backup_log (filename, size_bytes, reason, status, error)
      VALUES (?, 0, 'auto_daily', 'failed', ?)
    `).run(filename, err.message);

    console.error(`[backup-scheduler] Auto backup FAILED:`, err.message);
  }
}

function shouldRunNow() {
  const now = new Date();
  const hour = now.getHours();          // server-local hour (0–23)
  if (hour < BACKUP_HOUR) return false;

  const lastDate = lastAutoBackupDate();
  return lastDate !== todayUtcDate();
}

// ── public API ─────────────────────────────────────────────────────────
function start() {
  // First check happens ~60s after startup, then every hour.
  const FIRST_CHECK_MS = 60 * 1000;
  const INTERVAL_MS    = 60 * 60 * 1000;

  console.log(`[backup-scheduler] Started — daily backup at ${String(BACKUP_HOUR).padStart(2, '0')}:00 server time`);

  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS);
  }, FIRST_CHECK_MS);
}

async function tick() {
  try {
    if (shouldRunNow()) {
      await runAutoBackup();
    }
  } catch (err) {
    console.error('[backup-scheduler] Tick error:', err.message);
  }
}

module.exports = { start };