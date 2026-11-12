// server/deviceRegistry.js
// Candidate capacity: each browser/computer takes one "seat" the first time a
// student logs in from it. The limit comes from the signed license.
const crypto = require('crypto');
const db = require('../db/database');
const license = require('../license/manager');

const DEVICE_ID_FORMAT = /^DEV-[0-9a-f]{32}$/;

function normalizeIp(ip) {
  return (ip || '').replace(/^::ffff:/, '');
}

// If the browser didn't send a valid device ID (old cached page, or someone
// calling the API directly), derive one from IP + browser. This means omitting
function resolveDeviceId(rawId, ip, userAgent) {
  if (typeof rawId === 'string' && DEVICE_ID_FORMAT.test(rawId)) return rawId;
  // Stable fallback that MATCHES the DEV- format so the same browser/OS
  // is always recognised as the same seat, even if localStorage is cleared.
  const hash = crypto.createHash('sha256').update(`${userAgent || 'unknown'}`).digest('hex').slice(0, 32);
  return `DEV-${hash}`;
}

const registerTx = db.transaction((schoolId, deviceId, ip, userAgent, studentId, max) => {
  // 1) Exact device_id already registered?
  let existing = db.prepare(
    'SELECT id FROM candidate_devices WHERE school_id = ? AND device_id = ?'
  ).get(schoolId, deviceId);

  // 2) Otherwise, does this same IP + User-Agent already hold a seat?
  //    (covers the case where the browser cleared localStorage / incognito)
  if (!existing && ip && userAgent) {
    existing = db.prepare(
      'SELECT id FROM candidate_devices WHERE school_id = ? AND last_ip = ? AND user_agent = ?'
    ).get(schoolId, ip, userAgent);

    if (existing) {
      // Migrate the existing row to the fresh device_id so future logins match it.
      db.prepare('UPDATE candidate_devices SET device_id = ? WHERE id = ?')
        .run(deviceId, existing.id);
    }
  }
  if (existing) {
    db.prepare(`
      UPDATE candidate_devices
      SET last_ip = ?, user_agent = ?, last_student_id = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ip, userAgent, studentId, existing.id);
    return { allowed: true, device_id: deviceId };
  }

  const used = db.prepare('SELECT COUNT(*) AS c FROM candidate_devices WHERE school_id = ?').get(schoolId).c;
   if (max !== null && used >= max) return { allowed: false, max, used, device_id: deviceId };

    db.prepare(`
    INSERT INTO candidate_devices (school_id, device_id, last_ip, user_agent, last_student_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(schoolId, deviceId, ip, userAgent, studentId);
  return { allowed: true, device_id: deviceId };
});

function registerCandidateDevice({ schoolId, deviceId, ip, userAgent, studentId }) {
  const cleanIp = normalizeIp(ip);
  const cleanUa = (userAgent || '').slice(0, 300);
  const id = resolveDeviceId(deviceId, cleanIp, cleanUa);
  const { max_candidate_computers } = license.getLicenseLimits();
  console.log('[deviceRegistry] max =', max_candidate_computers, 'id =', id, 'school =', schoolId);
  return registerTx(schoolId, id, cleanIp, cleanUa, studentId, max_candidate_computers);
}
function getDeviceById(id) {
  return db.prepare('SELECT * FROM candidate_devices WHERE id = ?').get(id);
}

function deleteDeviceById(id) {
  return db.prepare('DELETE FROM candidate_devices WHERE id = ?').run(id);
}

module.exports = { registerCandidateDevice, getDeviceById, deleteDeviceById };