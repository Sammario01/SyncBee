// server/routes/system.js
const express = require('express');
const router = express.Router();
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// ── Backup storage location ──────────────────────────────────────────
const BACKUP_DIR = require('../paths').backupsDir;
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Keep only the newest N backups. Called after every successful backup.
function pruneOldBackups(keep = 14) {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('syncbee-') && f.endsWith('.db'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      return { name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const toDelete = files.slice(keep);
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      db.prepare('DELETE FROM backup_log WHERE filename = ?').run(f.name);
    } catch (_) { /* best effort — ignore individual failures */ }
  }
}

// GET /api/system/environment
// Reports which environment this server instance is running in, plus a few
// identifying details, so the admin UI can show a coloured banner and prevent
// "I thought I was on the test server" mistakes.
router.get('/environment', (req, res) => {
  // In a packaged Electron app, IS_DEV reflects whether you're running from
  // source (dev) or from a compiled .exe (production). If you don't have that
  // flag yet, we fall back to the environment variable.
  const isDev = process.env.SYNCBEE_DEV === '1' || !require('electron')?.app?.isPackaged;

  // Get branding (school name), if it's been set
  let schoolName = null;
  try {
    const brand = db.prepare('SELECT school_display_name FROM branding WHERE id = 1').get();
    if (brand && brand.school_display_name) schoolName = brand.school_display_name;
  } catch (_) { /* branding table may be empty */ }

  // Get license state, if the license module exists
  let licenseState = 'licensed';
  let licenseDaysLeft = null;
  try {
    const lic = db.prepare('SELECT expiry_date FROM licenses ORDER BY id DESC LIMIT 1').get();
    if (lic && lic.expiry_date) {
      const days = Math.ceil((new Date(lic.expiry_date) - Date.now()) / 86400000);
      licenseDaysLeft = days;
      if (days < 0)       licenseState = 'expired';
      else if (days <= 7) licenseState = 'expiring';
    } else if (!lic) {
      licenseState = 'unlicensed';
    }
  } catch (_) { /* no license table yet */ }

  // Base info — always safe to show to the customer
  const payload = {
    school_name: schoolName,
    license_state: licenseState,   // 'licensed' | 'expiring' | 'expired' | 'unlicensed'
    license_days_left: licenseDaysLeft
  };

  // Extra info — only for developer builds
  if (isDev) {
    const pkg = require('../../package.json');
    payload.dev = true;
    payload.version = pkg.version || '0.0.0';
    payload.db_path = 'db/syncbee.db';
  }

  res.json(payload);
});

// GET /api/system/network-info
// Returns every non-internal IPv4 address this machine has, so the admin
// knows what to type into student computers' browsers on the same network.
// A machine can have more than one (Wi-Fi + Ethernet, etc.) — we return all
// of them rather than guess which one is "the right one".
router.get('/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ interface: name, address: iface.address });
      }
    }
  }

  res.json({ addresses, port: 4000 });
});

// GET /api/system/resources — live CPU, RAM, disk, uptime, node process stats.
// Everything here is measured on the machine running the app (the local server).
// Only admin sessions can see it.
router.get('/resources', (req, res) => {
  const os = require('os');
  const fs = require('fs');

  // ── CPU ────────────────────────────────────────────────────────────
  // loadavg returns 1/5/15-minute load averages. On Windows Node returns
  // [0,0,0] unless explicitly enabled — so we fall back to a snapshot-based
  // estimate if loadavg is empty.
  let load1 = 0, load5 = 0, load15 = 0;
  try {
    const [a, b, c] = os.loadavg();
    load1 = a; load5 = b; load15 = c;
  } catch (_) {}

  const cores = os.cpus().length || 1;
  // Percentage estimate: load / cores, capped at 100. On Windows this will
  // read 0 until we add a sampling window — better than showing NaN.
  const cpuPercent = cores > 0 ? Math.min(100, Math.round((load1 / cores) * 100)) : 0;

  // ── Memory ─────────────────────────────────────────────────────────
  const memTotal = os.totalmem();
  const memFree  = os.freemem();
  const memUsed  = memTotal - memFree;
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

  // ── Disk ───────────────────────────────────────────────────────────
  // Windows: use the drive of the project folder. Linux/macOS: root.
  let diskTotal = 0, diskFree = 0, diskPercent = 0;
  try {
    const target = process.platform === 'win32'
      ? (process.env.SystemDrive || 'C:') + '\\'
      : '/';
    const s = fs.statfsSync(target);
    diskTotal = s.bsize * s.blocks;
    diskFree  = s.bsize * s.bfree;
    const diskUsed = diskTotal - diskFree;
    diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
  } catch (_) { /* statfs unsupported — leave zeros */ }

  // ── Uptime (this Node process) ─────────────────────────────────────
  const uptimeSeconds = Math.round(process.uptime());

  // ── Node process memory ────────────────────────────────────────────
  const memUsage = process.memoryUsage();

  res.json({
    cpu: {
      load_1m: load1,
      load_5m: load5,
      load_15m: load15,
      cores,
      percent: cpuPercent
    },
    memory: {
      total: memTotal,
      used: memUsed,
      free: memFree,
      percent: memPercent
    },
    disk: {
      total: diskTotal,
      free: diskFree,
      used: diskTotal - diskFree,
      percent: diskPercent
    },
    uptime_seconds: uptimeSeconds,
    node: {
      version: process.version,
      pid: process.pid,
      rss: memUsage.rss,
      heap_used: memUsage.heapUsed,
      heap_total: memUsage.heapTotal
    }
  });
});

// GET /api/system/connected — lists currently logged-in sessions (students + admin).
// "Connected" here means a valid, non-expired session cookie exists — not a live
// socket/heartbeat check. A student who closes their browser without logging out
// will still show as online until their session naturally expires (8 hours).
router.get('/connected', (req, res) => {
  const store = req.app.locals.sessionStore;

  store.all((err, sessionsRaw) => {
    if (err) return res.status(500).json({ error: err.message });

    const sessionsArray = Array.isArray(sessionsRaw) ? sessionsRaw : Object.values(sessionsRaw || {});
    const now = Date.now();

    const active = sessionsArray.filter(s => {
      if (!s || !s.cookie || !s.cookie.expires) return true;
      return new Date(s.cookie.expires).getTime() > now;
    });

    const students = active
      .filter(s => s.student_id)
      .map(s => ({ role: 'student', student_id: s.student_id, full_name: s.full_name }));

    const admins = active
      .filter(s => s.role === 'admin')
      .map(s => ({ role: 'admin', full_name: s.admin_email }));

    res.json({
      counts: { students: students.length, admins: admins.length, total: students.length + admins.length },
      sessions: [...students, ...admins]
    });
  });
});

// POST /api/system/backup — create a manual snapshot of the SQLite database.
// Uses better-sqlite3's .backup() which is safe with concurrent writes
// (unlike a plain file copy, which can produce a corrupted snapshot).
router.post('/backup', async (req, res) => {
  const stamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `syncbee-${stamp}.db`;
  const destPath = path.join(BACKUP_DIR, filename);

  try {
    await db.backup(destPath);

    const size = fs.statSync(destPath).size;

    db.prepare(`
      INSERT INTO backup_log (filename, size_bytes, reason, status)
      VALUES (?, ?, 'manual', 'success')
    `).run(filename, size);

    pruneOldBackups(14);

    res.json({
      success: true,
      filename,
      size_bytes: size,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    db.prepare(`
      INSERT INTO backup_log (filename, size_bytes, reason, status, error)
      VALUES (?, 0, 'manual', 'failed', ?)
    `).run(filename, err.message);

    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// GET /api/system/backups — list recent backups + summary for the dashboard panel.
router.get('/backups', (req, res) => {
  const rows = db.prepare(`
    SELECT id, filename, size_bytes, reason, status, error, created_at
    FROM backup_log
    ORDER BY id DESC
    LIMIT 20
  `).all();

  const lastSuccess = db.prepare(`
    SELECT created_at FROM backup_log
    WHERE status = 'success'
    ORDER BY id DESC LIMIT 1
  `).get();

  const lastFailure = db.prepare(`
    SELECT created_at, error FROM backup_log
    WHERE status = 'failed'
    ORDER BY id DESC LIMIT 1
  `).get();

  const totalBytes = rows
    .filter(r => r.status === 'success')
    .reduce((sum, r) => sum + (r.size_bytes || 0), 0);

  res.json({
    backups: rows,
    last_success_at: lastSuccess ? lastSuccess.created_at : null,
    last_failure_at: lastFailure ? lastFailure.created_at : null,
    last_failure_error: lastFailure ? lastFailure.error : null,
    total_bytes: totalBytes,
    retention: 14,
    backup_dir: BACKUP_DIR
  });
});

module.exports = router;