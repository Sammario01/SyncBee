// server/routes/system-alerts.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// ── helpers ────────────────────────────────────────────────────────────
function checkLicense() {
  try {
    const row = db.prepare(
      'SELECT * FROM licenses ORDER BY id DESC LIMIT 1'
    ).get();

    if (!row) {
      return {
        id: 'license_missing',
        severity: 'red',
        title: 'No license installed',
        detail: 'Activate a license to unlock all features.',
        link: '/admin-branding'
      };
    }

    const expiry = row.expiry_date || row.expiry;
    if (!expiry) return null;

    const days = Math.ceil((new Date(expiry) - Date.now()) / 86400000);

    if (days < 0) {
      return {
        id: 'license_expired',
        severity: 'red',
        title: 'License expired',
        detail: `Expired ${Math.abs(days)} day(s) ago. Renew to keep the system running.`,
        link: '/admin-branding'
      };
    }
    if (days <= 7) {
      return {
        id: 'license_expiring',
        severity: days <= 3 ? 'red' : 'orange',
        title: `License expires in ${days} day(s)`,
        detail: `Expiry date: ${String(expiry).slice(0, 10)}.`,
        link: '/admin-branding'
      };
    }
    return null;
  } catch (_) {
    // licenses table may not exist yet — silently skip
    return null;
  }
}

function checkDisk() {
  try {
    const stat = fs.statfsSync(require('../paths').dataDir);
    const freeBytes = stat.bsize * stat.bfree;
    const totalBytes = stat.bsize * stat.blocks;
    const freeGb = freeBytes / (1024 ** 3);
    const pctFree = (freeBytes / totalBytes) * 100;

    if (freeGb < 1) {
      return {
        id: 'disk_critical',
        severity: 'red',
        title: `Disk critically low (${freeGb.toFixed(1)} GB free)`,
        detail: 'Free up space before starting or continuing an exam.'
      };
    }
    if (pctFree < 10) {
      return {
        id: 'disk_low',
        severity: 'orange',
        title: `Disk space low (${freeGb.toFixed(1)} GB free)`,
        detail: `Only ${pctFree.toFixed(0)}% of disk remaining.`
      };
    }
    return null;
  } catch (_) {
    return null; // statfs unsupported on this platform
  }
}

function checkMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;

  if (usedPct >= 95) {
    return {
      id: 'ram_critical',
      severity: 'red',
      title: `Server RAM at ${usedPct.toFixed(0)}%`,
      detail: 'System may become unstable. Close unused processes.'
    };
  }
  if (usedPct >= 85) {
    return {
      id: 'ram_high',
      severity: 'orange',
      title: `Server RAM at ${usedPct.toFixed(0)}%`,
      detail: 'Monitor closely during the current exam.'
    };
  }
  return null;
}

function checkUpcomingExams() {
  try {
    const school_id = null; // alerts run scoped to the session — see note below

    const soon = db.prepare(`
      SELECT exam_code, exam_title, start_time
      FROM examinations
      WHERE published = 1
        AND datetime(start_time) BETWEEN datetime('now') AND datetime('now', '+15 minutes')
      ORDER BY start_time ASC
      LIMIT 1
    `).get();

    if (!soon) return null;

    // Count how many distinct students have a session/attempt open for it
    const active = db.prepare(`
      SELECT COUNT(DISTINCT student_id) AS c FROM student_attempts
      WHERE exam_code = ?
        AND status = 'In Progress'
        AND started_at >= datetime('now', '-15 minutes')
    `).get(soon.exam_code).c;

    if (active === 0) {
      return {
        id: 'exam_starting_no_candidates',
        severity: 'orange',
        title: `"${soon.exam_title}" starts in <15 min`,
        detail: 'No candidates have connected yet.',
        link: '/admin-monitor'
      };
    }
    return null;
  } catch (_) { return null; }
}

function checkBackups() {
  try {
    const lastOk = db.prepare(`
      SELECT created_at FROM backup_log
      WHERE status = 'success'
      ORDER BY id DESC LIMIT 1
    `).get();

    const lastFail = db.prepare(`
      SELECT created_at, error FROM backup_log
      WHERE status = 'failed'
      ORDER BY id DESC LIMIT 1
    `).get();

    // A failed backup newer than the last successful one is a real problem.
    if (lastFail && (!lastOk || lastFail.created_at > lastOk.created_at)) {
      return {
        id: 'backup_failed',
        severity: 'red',
        title: 'Last backup failed',
        detail: lastFail.error || 'Check the Database Backups panel.',
        link: '/admin-dashboard'
      };
    }

    if (!lastOk) {
      return {
        id: 'backup_never',
        severity: 'orange',
        title: 'No backup has ever been created',
        detail: 'Create a manual backup now to protect your data.',
        link: '/admin-dashboard'
      };
    }

    const hoursSince = (Date.now() - new Date(lastOk.created_at.replace(' ', 'T')).getTime()) / 3600000;
    if (hoursSince >= 24) {
      return {
        id: 'backup_stale',
        severity: hoursSince >= 72 ? 'red' : 'orange',
        title: `Last backup was ${Math.floor(hoursSince)}h ago`,
        detail: 'Create a fresh backup to keep your data safe.',
        link: '/admin-dashboard'
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function checkSyncQueue() {
  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS c FROM sync_queue WHERE status = 'pending'`
    ).get().c;

    const failed = db.prepare(
      `SELECT COUNT(*) AS c FROM sync_queue WHERE status = 'failed'`
    ).get().c;

    const alerts = [];
    if (failed > 0) {
      alerts.push({
        id: 'sync_failed',
        severity: 'red',
        title: `${failed} sync item(s) failed`,
        detail: 'Check the Sync page for error details.',
        link: '/sync'
      });
    }
    if (pending >= 20) {
      alerts.push({
        id: 'sync_backlog',
        severity: 'orange',
        title: `${pending} item(s) pending sync`,
        detail: 'Sync queue is backing up.',
        link: '/sync'
      });
    }
    return alerts;
  } catch (_) {
    return [];
  }
}

function checkIncidents() {
  try {
    const recent = db.prepare(`
      SELECT COUNT(*) AS c FROM exam_incidents
      WHERE created_at >= datetime('now', '-1 hour')
    `).get().c;

    if (recent < 5) return null;

    // Name the top type so the alert is actually diagnostic
    const top = db.prepare(`
      SELECT incident_type, COUNT(*) AS c
      FROM exam_incidents
      WHERE created_at >= datetime('now', '-1 hour')
      GROUP BY incident_type
      ORDER BY c DESC
      LIMIT 1
    `).get();

    const topLabel = top
      ? top.incident_type.replace(/_/g, ' ')
      : 'unknown';

    return {
      id: 'incidents_spike',
      severity: recent >= 10 ? 'red' : 'orange',
      title: `${recent} incident(s) in the last hour`,
      detail: `Most common: ${topLabel} (${top ? top.c : 0})`,
      link: '/admin-incidents'
    };
  } catch (_) {
    return [];
  }
}

// Track recent readings so we only alert on SUSTAINED pressure, not momentary spikes
const resourceHistory = { cpu: [], mem: [] };

function checkServerPressure() {
  try {
    const os = require('os');
    const cores = os.cpus().length || 1;
    const load1 = os.loadavg()[0] || 0;
    const cpuPct = Math.min(100, Math.round((load1 / cores) * 100));

    const memTotal = os.totalmem();
    const memFree  = os.freemem();
    const memPct   = Math.round(((memTotal - memFree) / memTotal) * 100);

    // Keep last 5 readings (≈2.5 min if called every 30s)
    resourceHistory.cpu.push(cpuPct);
    resourceHistory.mem.push(memPct);
    if (resourceHistory.cpu.length > 5) resourceHistory.cpu.shift();
    if (resourceHistory.mem.length > 5) resourceHistory.mem.shift();

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    if (resourceHistory.cpu.length >= 3 && avg(resourceHistory.cpu) >= 90) {
      return {
        id: 'cpu_sustained_high',
        severity: 'orange',
        title: `Server CPU averaging ${Math.round(avg(resourceHistory.cpu))}%`,
        detail: 'Close unused apps on the server or reduce load.'
      };
    }
    if (resourceHistory.mem.length >= 3 && avg(resourceHistory.mem) >= 90) {
      return {
        id: 'ram_sustained_high',
        severity: 'orange',
        title: `Server RAM averaging ${Math.round(avg(resourceHistory.mem))}%`,
        detail: 'System may become unstable during the exam.'
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function checkTheoryGrading() {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c, MIN(submitted_at) AS oldest
      FROM theory_answers
      WHERE status = 'pending'
    `).get();

    if (!row || row.c === 0) return null;

    const oldestMs = row.oldest
      ? new Date(String(row.oldest).replace(' ', 'T') + 'Z').getTime()
      : null;
    const oldestHours = oldestMs ? (Date.now() - oldestMs) / 3600000 : 0;

    // Only alert if the oldest pending answer has been waiting 48+ hours
    if (oldestHours < 48) return null;

    const days = Math.floor(oldestHours / 24);
    return {
      id: 'theory_grading_backlog',
      severity: oldestHours >= 168 ? 'red' : 'orange',   // 7d = red
      title: `${row.c} theory answer${row.c === 1 ? '' : 's'} pending grading`,
      detail: `Oldest has been waiting ${days} day${days === 1 ? '' : 's'}`,
      link: '/admin-grading'
    };
  } catch (_) {
    return null;
  }
}

function checkConnectedCandidates() {
  try {
    // Is an exam scheduled to be running right now?
    const liveExam = db.prepare(`
      SELECT id, exam_title FROM examinations
      WHERE published = 1
        AND datetime('now') BETWEEN start_time AND end_time
      LIMIT 1
    `).get();
    if (!liveExam) return null;

    // Count "In Progress" attempts whose candidate has signed in recently.
    // We rely on student_attempts having a heartbeat/last-seen column, OR
    // we fall back to counting recent answer submissions.
    //
    // Option A (recommended): add `last_seen_at` to student_attempts and
    // update it from the existing save-answers / heartbeat route.
    const active = db.prepare(`
      SELECT COUNT(*) AS c FROM student_attempts
      WHERE status = 'In Progress'
        AND last_seen_at >= datetime('now', '-2 minutes')
    `).get().c;

    if (active === 0) {
      return {
        id: 'no_active_candidates',
        severity: 'red',
        title: 'Live exam running but no candidate heartbeats',
        detail: `"${liveExam.exam_title}" is scheduled now, but no candidate has checked in for 2+ minutes. Check the network and monitor page.`,
        link: '/admin-monitor'
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── route ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const alerts = [];

  const push = v => {
    if (Array.isArray(v)) alerts.push(...v.filter(Boolean));
    else if (v) alerts.push(v);
  };

  push(checkLicense());
  push(checkDisk());
  push(checkMemory());
  push(checkSyncQueue());
  push(checkIncidents());
  push(checkBackups());        // added with the backup feature
  push(checkUpcomingExams());  // new "exam starting soon" alert
push(checkServerPressure());

  // Sort by severity: red > orange > yellow
  const rank = { red: 0, orange: 1, yellow: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);

  res.json({ alerts, count: alerts.length });
});



module.exports = router;