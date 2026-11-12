// server/routes/license.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const license = require('../../license/manager');
const scheduler = require('../licenseScheduler');
const { requireAdminSession } = require('./auth');

function publicView(m) {
  return { mode: m.mode, code: m.code, message: m.message, warning: m.warning || null };
}

// POST /api/license/activate  Body: { email, password, license_key }
// The browser only gets the outcome, never the license data (it contains the school ID).
router.post('/activate', async (req, res) => {
  const { email, password, license_key } = req.body || {};
  const result = await license.activateLicense({ email, password, license_key });
  if (result.status) scheduler.reschedule();
  res.json({ status: result.status, code: result.code, message: result.message });
});

// Safe for pages that run before anyone is logged in (admin login, locked screen).
router.get('/public-status', (req, res) => {
  res.json(publicView(license.getLicenseMode()));
});

// "Check again" button on the locked screen. A cooldown stops it being abused.
let lastRecheck = 0;
router.post('/recheck', async (req, res) => {
  if (Date.now() - lastRecheck >= 30000) {
    lastRecheck = Date.now();
    await scheduler.runNow();
  }
  res.json(publicView(license.getLicenseMode()));
});

// Kept in the same shape the dashboard's License card already reads.
router.get('/status', requireAdminSession, (req, res) => {
  const m = license.getLicenseMode();
  res.json({
    valid: m.mode === 'full',
    mode: m.mode,
    message: m.message,
    expiry: m.expiry || null,
    grace_warning: !!m.warning
  });
});

router.get('/info', requireAdminSession, (req, res) => {
  const info = license.getLicenseInfo();
  let used = 0;
  try { used = db.prepare('SELECT COUNT(*) AS c FROM candidate_devices').get().c; } catch (err) { /* table may not exist yet */ }
  res.json({ ...info, candidate_seats_used: used });
});

router.post('/check-now', requireAdminSession, async (req, res) => {
  const result = await scheduler.runNow();
  res.json({
    checked: !!result,
    reachable: result ? result.reachable : null,
    message: result ? result.message : 'A check is already running. Try again in a moment.',
    info: license.getLicenseInfo()
  });
});

module.exports = router;