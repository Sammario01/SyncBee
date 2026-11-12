// server/licenseGate.js
// One checkpoint every API request passes through. Pages and static files are
// always served; only /api/* is gated.
const license = require('../license/manager');

// Admin screens that CREATE or CHANGE things. Blocked for writes in read-only mode.
// Routes a candidate already inside an exam needs in order to finish it.
const WRITE_PREFIXES = ['/api/exams', '/api/questions', '/api/bundles', '/api/students', '/api/grading', '/api/branding', '/api/devices', '/api/catalog', '/api/risk', '/api/features', '/api/uploads', '/api/question-import'];
const IN_EXAM_PREFIXES = ['/api/attempts', '/api/bundle-attempts', '/api/broadcast', '/api/student', '/api/auth/me', '/api/auth/logout'];
// Routes that bring a NEW candidate or a NEW exam into the system.
const CANDIDATE_FACING = ['/api/auth/login', '/api/attempts', '/api/bundle-attempts', '/api/student'];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function startsWithAny(p, list) {
  return list.some((x) => p === x || p.startsWith(x + '/'));
}

function isNewExamOrLogin(req) {
  return req.method === 'POST' &&
    (req.path === '/api/auth/login' || req.path === '/api/attempts/start' || req.path === '/api/bundle-attempts/start');
}

function deny(req, res, m) {
  const message = startsWithAny(req.path, CANDIDATE_FACING)
    ? "This exam center's license is not active. Please see your exam supervisor."
    : m.message;
  return res.status(403).json({ success: false, status: 'error', code: m.code, error: message, message });
}

function licenseGate(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const m = license.getLicenseMode();
  if (m.mode === 'full') return next();

  const p = req.path;

  // Always reachable: activation / renewal / status, and branding so pages can style themselves.
  if (p.startsWith('/api/license')) return next();
  if (p === '/api/branding' && req.method === 'GET') return next();

  if (m.mode === 'unactivated') return deny(req, res, m);

  if (m.mode === 'locked') {
    const inExam = req.session && req.session.student_id;
    if (inExam && startsWithAny(p, IN_EXAM_PREFIXES) && !isNewExamOrLogin(req)) return next();
    return deny(req, res, m);
  }

  // read_only: results stay readable; nothing new can be created, synced, or started.
  if (p.startsWith('/api/sync')) return deny(req, res, m);
  if (isNewExamOrLogin(req)) return deny(req, res, m);
  if (MUTATING.has(req.method) && startsWithAny(p, WRITE_PREFIXES)) return deny(req, res, m);
  return next();
}

module.exports = licenseGate;