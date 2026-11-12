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
// the ID can never be used to dodge the seat limit.
function resolveDeviceId(rawId, ip, userAgent) {
  if (typeof rawId === 'string' && DEVICE_ID_FORMAT.test(rawId)) return rawId;
  const hash = crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 24);
  return `IPUA-${hash}`;
}

const registerTx = db.transaction((schoolId, deviceId, ip, userAgent, studentId, max) => {
  const existing = db.prepare('SELECT id FROM candidate_devices WHERE school_id = ? AND device_id = ?')
    .get(schoolId, deviceId);

  if (existing) {
    db.prepare(`
      UPDATE candidate_devices
      SET last_ip = ?, user_agent = ?, last_student_id = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ip, userAgent, studentId, existing.id);
    return { allowed: true };
  }

  const used = db.prepare('SELECT COUNT(*) AS c FROM candidate_devices WHERE school_id = ?').get(schoolId).c;
  if (max !== null && used >= max) return { allowed: false, max, used };

  db.prepare(`
    INSERT INTO candidate_devices (school_id, device_id, last_ip, user_agent, last_student_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(schoolId, deviceId, ip, userAgent, studentId);
  return { allowed: true };
});

function registerCandidateDevice({ schoolId, deviceId, ip, userAgent, studentId }) {
  const cleanIp = normalizeIp(ip);
  const cleanUa = (userAgent || '').slice(0, 300);
  const id = resolveDeviceId(deviceId, cleanIp, cleanUa);
  const { max_candidate_computers } = license.getLicenseLimits();
  return registerTx(schoolId, id, cleanIp, cleanUa, studentId, max_candidate_computers);
}

module.exports = { registerCandidateDevice };