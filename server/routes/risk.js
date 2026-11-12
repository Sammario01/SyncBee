// server/routes/risk.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');
const engine = require('../riskEngine');
const features = require('../features');

router.use(requireAdminSession);
// Risk rules stay editable while the feature is off; everything that shows scores is switched off with it.
router.use((req, res, next) => {
  if (req.path.startsWith('/settings')) return next();
  return features.requireFeature('risk_scoring', 'Risk scoring is switched off. Turn it on under Features.')(req, res, next);
});

const MAX_IDLE = 500;

function utcMs(value) {
  if (!value) return null;
  const s = String(value);
  const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); // SQLite times are UTC
  return Number.isNaN(ms) ? null : ms;
}

function nameMap(schoolId) {
  const map = new Map();
  for (const s of db.prepare('SELECT student_id, firstname, middlename, lastname FROM students WHERE school_id = ?').all(schoolId)) {
    map.set(s.student_id, [s.firstname, s.middlename, s.lastname].filter(Boolean).join(' ') || 'Unknown candidate');
  }
  return map;
}

// student -> position of the computer they most recently logged in from
function seatMap(schoolId) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT last_student_id, seat_label FROM candidate_devices
    WHERE school_id = ? AND last_student_id IS NOT NULL AND seat_label IS NOT NULL
    ORDER BY last_seen_at ASC, id ASC
  `).all(schoolId);
  for (const r of rows) map.set(r.last_student_id, r.seat_label); // the newest login wins
  return map;
}

function objectiveTotal(info) {
  return info.questions_to_attempt > 0 ? Math.min(info.objective, info.questions_to_attempt) : info.objective;
}

function fallbackTotal(attempt, info) {
  if (!info) return 0;
  return attempt.section === 'B' ? info.theory : objectiveTotal(info);
}

// Loads everything for a set of attempts in a handful of grouped queries (never one per student).
function analyze(attempts, extraExamCodes) {
  const cfg = engine.getConfig();
  const byAttempt = new Map();
  const examInfo = new Map();

  const codes = [...new Set([...attempts.map(a => a.exam_code), ...(extraExamCodes || [])])];
  const codesJson = JSON.stringify(codes);
  if (codes.length) {
    const infoRows = db.prepare(`
      SELECT e.exam_code, e.questions_to_attempt,
        (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_code = e.exam_code AND q.question_type IN ('MCQ_SINGLE','TRUE_FALSE')) AS objective,
        (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_code = e.exam_code AND q.question_type = 'THEORY') AS theory
      FROM examinations e WHERE e.exam_code IN (SELECT value FROM json_each(?))
    `).all(codesJson);
    infoRows.forEach(r => examInfo.set(r.exam_code, r));
  }
  if (!attempts.length) return { cfg, byAttempt, examInfo };

  const idsJson = JSON.stringify(attempts.map(a => a.attempt_id));

  const theoryIds = new Set(db.prepare(`
    SELECT question_id FROM exam_questions
    WHERE question_type = 'THEORY' AND exam_code IN (SELECT value FROM json_each(?))
  `).all(codesJson).map(r => r.question_id));

  const events = new Map();
  const eventRows = db.prepare(`
    SELECT attempt_id, event_type, question_id, occurred_at,
           CASE WHEN event_type = 'page_loaded' THEN data END AS data
    FROM exam_events
    WHERE attempt_id IN (SELECT value FROM json_each(?))
    ORDER BY occurred_at ASC, id ASC
  `).all(idsJson);
  for (const r of eventRows) {
    const t = utcMs(r.occurred_at);
    if (t === null) continue;
    let nav = null;
    if (r.data) { try { nav = JSON.parse(r.data).navigation || null; } catch (err) { nav = null; } }
    if (!events.has(r.attempt_id)) events.set(r.attempt_id, []);
    events.get(r.attempt_id).push({ type: r.event_type, qid: r.question_id, t, nav });
  }

  const incidents = new Map();
  const incidentRows = db.prepare(`
    SELECT attempt_id, incident_type, COUNT(*) AS c FROM exam_incidents
    WHERE attempt_id IN (SELECT value FROM json_each(?)) GROUP BY attempt_id, incident_type
  `).all(idsJson);
  for (const r of incidentRows) {
    if (!incidents.has(r.attempt_id)) incidents.set(r.attempt_id, {});
    incidents.get(r.attempt_id)[r.incident_type] = r.c;
  }

  const answered = new Map(db.prepare(`
    SELECT attempt_id, COUNT(*) AS c FROM student_answers
    WHERE attempt_id IN (SELECT value FROM json_each(?)) GROUP BY attempt_id
  `).all(idsJson).map(r => [r.attempt_id, r.c]));

  const locked = new Map(db.prepare(`
    SELECT attempt_id, COUNT(*) AS c FROM attempt_questions
    WHERE attempt_id IN (SELECT value FROM json_each(?)) GROUP BY attempt_id
  `).all(idsJson).map(r => [r.attempt_id, r.c]));

  const now = Date.now();
  for (const a of attempts) {
    // finished_at defaults to the start time while an attempt is still running, so only trust it once submitted
    const endMs = a.status === 'Submitted' && utcMs(a.finished_at) ? utcMs(a.finished_at) : now;
    const metrics = engine.computeMetrics(events.get(a.attempt_id) || [], {
      cfg, theoryIds, endMs,
      incidents: incidents.get(a.attempt_id) || {},
      submissionReason: a.submission_reason
    });
    byAttempt.set(a.attempt_id, {
      metrics,
      answered: answered.get(a.attempt_id) || 0,
      total: locked.get(a.attempt_id) || fallbackTotal(a, examInfo.get(a.exam_code)),
      lastMs: utcMs(a.last_activity) || utcMs(a.started_at)
    });
  }
  return { cfg, byAttempt, examInfo };
}

function makeTile(o) {
  return {
    key: o.key,
    kind: o.kind,
    name: o.names.get(o.studentId) || 'Unknown candidate',
    status: o.status,
    note: o.note || null,
    answered: o.answered,
    total: o.total,
    percent: o.total > 0 ? Math.min(100, Math.round((o.answered / o.total) * 100)) : 0,
    seconds_since_activity: o.lastMs ? Math.max(0, Math.round((Date.now() - o.lastMs) / 1000)) : null,
    seat_label: o.seats.get(o.studentId) || null,
    has_events: o.metrics.events > 0,
    risk: engine.scoreMetrics(o.metrics, o.cfg)
  };
}

// Students expected to sit this exam or bundle who have not started yet.
function idleTiles(schoolId, scope, haveIds, names, seats) {
  const rows = db.prepare(`
    SELECT student_id FROM students
    WHERE school_id = ? AND active_status = 1
      AND (? = 1 OR class_id = ? OR program_id = ?)
    ORDER BY firstname COLLATE NOCASE, lastname COLLATE NOCASE
    LIMIT 5000
  `).all(schoolId, scope.is_global ? 1 : 0, scope.class_id ?? null, scope.program_id ?? null);

  const tiles = [];
  let truncated = false;
  for (const r of rows) {
    if (haveIds.has(r.student_id)) continue;
    if (tiles.length >= MAX_IDLE) { truncated = true; break; }
    tiles.push({
      key: `idle-${tiles.length}`, kind: 'idle',
      name: names.get(r.student_id) || 'Unknown candidate',
      status: 'Not started', note: null, answered: 0, total: 0, percent: 0,
      seconds_since_activity: null, seat_label: seats.get(r.student_id) || null,
      has_events: false, risk: null
    });
  }
  return { tiles, truncated };
}

function summarize(attemptTiles, idleCount) {
  const s = { green: 0, yellow: 0, red: 0, idle: idleCount };
  attemptTiles.forEach(t => { s[t.risk.level]++; });
  return s;
}



// GET /api/risk/exam/:exam_code
router.get('/exam/:exam_code', (req, res) => {
  const schoolId = req.session.school_id;
  const exam = db.prepare(
    'SELECT exam_code, exam_title, class_id, program_id, is_global FROM examinations WHERE exam_code = ? AND school_id = ?'
  ).get(req.params.exam_code, schoolId);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  // Bundled exams are monitored through their bundle — don't score them in isolation
  const isBundled = db.prepare(
    'SELECT 1 FROM exam_bundle_items WHERE exam_code = ? LIMIT 1'
  ).get(exam.exam_code);
  if (isBundled) {
    return res.status(400).json({
      error: 'This exam is part of a bundle. Open the bundle heat map instead.',
      code: 'EXAM_IS_BUNDLED'
    });
  }

  const attempts = db.prepare(`
    SELECT sa.id, sa.attempt_id, sa.student_id, sa.section, sa.status, sa.submission_reason, sa.exam_code,
           sa.started_at, sa.finished_at, sa.last_activity
    FROM student_attempts sa
    WHERE sa.school_id = ? AND sa.exam_code = ? AND sa.bundle_attempt_id IS NULL
      AND sa.id IN (
        SELECT MAX(id) FROM student_attempts
        WHERE school_id = ? AND exam_code = ? AND bundle_attempt_id IS NULL GROUP BY student_id, section)
  `).all(schoolId, exam.exam_code, schoolId, exam.exam_code);

  const { cfg, byAttempt } = analyze(attempts, []);
  const names = nameMap(schoolId);
  const seats = seatMap(schoolId);

  // One tile per student: sections A and B are combined
  const byStudent = new Map();
  for (const a of attempts) {
    if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, []);
    byStudent.get(a.student_id).push(a);
  }

  const tiles = [];
  for (const [studentId, list] of byStudent) {
    list.sort((x, y) => x.id - y.id);
    const parts = list.map(a => byAttempt.get(a.attempt_id));
    tiles.push(makeTile({
      key: list[list.length - 1].attempt_id, kind: 'attempt', studentId, names, seats, cfg,
      status: list.some(a => a.status === 'In Progress') ? 'In Progress' : 'Submitted',
      answered: parts.reduce((n, p) => n + p.answered, 0),
      total: parts.reduce((n, p) => n + p.total, 0),
      lastMs: Math.max(...parts.map(p => p.lastMs || 0)) || null,
      metrics: engine.mergeMetrics(parts.map(p => p.metrics))
    }));
  }

  const idle = idleTiles(schoolId, exam, new Set(byStudent.keys()), names, seats);
  res.json({
    kind: 'exam', title: exam.exam_title, thresholds: cfg.thresholds,
    summary: summarize(tiles, idle.tiles.length), idle_truncated: idle.truncated,
    candidates: [...tiles, ...idle.tiles]
  });
});

// GET /api/risk/bundle/:bundle_code
router.get('/bundle/:bundle_code', (req, res) => {
  const schoolId = req.session.school_id;
  const bundle = db.prepare(
    'SELECT bundle_code, bundle_title, class_id, program_id, is_global FROM exam_bundles WHERE bundle_code = ? AND school_id = ?'
  ).get(req.params.bundle_code, schoolId);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const itemCodes = db.prepare('SELECT exam_code FROM exam_bundle_items WHERE bundle_code = ? ORDER BY item_order')
    .all(bundle.bundle_code).map(r => r.exam_code);

  const bundleAttempts = db.prepare(`
    SELECT * FROM student_bundle_attempts
    WHERE bundle_code = ? AND school_id = ?
      AND id IN (SELECT MAX(id) FROM student_bundle_attempts WHERE bundle_code = ? AND school_id = ? GROUP BY student_id)
  `).all(bundle.bundle_code, schoolId, bundle.bundle_code, schoolId);

  const baJson = JSON.stringify(bundleAttempts.map(b => b.bundle_attempt_id));
  const children = bundleAttempts.length ? db.prepare(`
    SELECT sa.id, sa.attempt_id, sa.student_id, sa.section, sa.status, sa.submission_reason, sa.exam_code,
           sa.started_at, sa.finished_at, sa.last_activity, sa.bundle_attempt_id
    FROM student_attempts sa
    WHERE sa.bundle_attempt_id IN (SELECT value FROM json_each(?))
      AND sa.id IN (
        SELECT MAX(id) FROM student_attempts
        WHERE bundle_attempt_id IN (SELECT value FROM json_each(?)) GROUP BY bundle_attempt_id, exam_code)
  `).all(baJson, baJson) : [];

  const { cfg, byAttempt, examInfo } = analyze(children, itemCodes);
  const names = nameMap(schoolId);
  const seats = seatMap(schoolId);

  const kidsByBundle = new Map();
  for (const k of children) {
    if (!kidsByBundle.has(k.bundle_attempt_id)) kidsByBundle.set(k.bundle_attempt_id, []);
    kidsByBundle.get(k.bundle_attempt_id).push(k);
  }

  const tiles = [];
  for (const ba of bundleAttempts) {
    const kids = kidsByBundle.get(ba.bundle_attempt_id) || [];
    const parts = kids.map(k => byAttempt.get(k.attempt_id));

    // Total = every exam in the bundle: what the student was given, or the exam's size if not opened yet
    let total = 0;
    for (const code of itemCodes) {
      const kid = kids.find(k => k.exam_code === code);
      if (kid) total += byAttempt.get(kid.attempt_id).total;
      else if (examInfo.get(code)) total += objectiveTotal(examInfo.get(code));
    }

    tiles.push(makeTile({
      key: ba.bundle_attempt_id, kind: 'bundle', studentId: ba.student_id, names, seats, cfg,
      status: ba.status,
      note: ba.status === 'Submitted' ? 'Bundle completed' : `Exam ${ba.current_item_order} of ${itemCodes.length}`,
      answered: parts.reduce((n, p) => n + p.answered, 0),
      total,
      lastMs: Math.max(0, ...parts.map(p => p.lastMs || 0)) || utcMs(ba.started_at),
      metrics: engine.mergeMetrics(parts.map(p => p.metrics))
    }));
  }

  const idle = idleTiles(schoolId, bundle, new Set(bundleAttempts.map(b => b.student_id)), names, seats);
  res.json({
    kind: 'bundle', title: bundle.bundle_title, thresholds: cfg.thresholds,
    summary: summarize(tiles, idle.tiles.length), idle_truncated: idle.truncated,
    candidates: [...tiles, ...idle.tiles]
  });
});

// GET /api/risk/recent?attempt_id=...  or  ?bundle_attempt_id=...   (latest activity for the side panel)
router.get('/recent', (req, res) => {
  const schoolId = req.session.school_id;
  let ids = [];

  if (req.query.bundle_attempt_id) {
    const ba = db.prepare('SELECT bundle_attempt_id FROM student_bundle_attempts WHERE bundle_attempt_id = ? AND school_id = ?')
      .get(String(req.query.bundle_attempt_id), schoolId);
    if (!ba) return res.status(404).json({ error: 'Not found' });
    ids = db.prepare('SELECT attempt_id FROM student_attempts WHERE bundle_attempt_id = ?')
      .all(ba.bundle_attempt_id).map(r => r.attempt_id);
  } else if (req.query.attempt_id) {
    const a = db.prepare('SELECT student_id, exam_code FROM student_attempts WHERE attempt_id = ? AND school_id = ?')
      .get(String(req.query.attempt_id), schoolId);
    if (!a) return res.status(404).json({ error: 'Not found' });
    ids = db.prepare('SELECT attempt_id FROM student_attempts WHERE student_id = ? AND exam_code = ? AND school_id = ? AND bundle_attempt_id IS NULL')
      .all(a.student_id, a.exam_code, schoolId).map(r => r.attempt_id);
  } else {
    return res.status(400).json({ error: 'attempt_id or bundle_attempt_id is required' });
  }
  if (!ids.length) return res.json({ events: [] });

  const idsJson = JSON.stringify(ids);
  const events = db.prepare(`
    SELECT attempt_id, event_type AS type, question_id, occurred_at AS at, NULL AS detail
    FROM exam_events WHERE attempt_id IN (SELECT value FROM json_each(?))
    ORDER BY occurred_at DESC, id DESC LIMIT 25
  `).all(idsJson);
  const strikes = db.prepare(`
    SELECT attempt_id, 'strike_logged' AS type, NULL AS question_id, created_at AS at, details AS detail
    FROM exam_incidents WHERE attempt_id IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC, id DESC LIMIT 15
  `).all(idsJson);

  const order = new Map(db.prepare(`
    SELECT attempt_id, question_id, question_order FROM attempt_questions
    WHERE attempt_id IN (SELECT value FROM json_each(?))
  `).all(idsJson).map(r => [`${r.attempt_id}|${r.question_id}`, r.question_order]));

  const merged = [...events, ...strikes]
    .map(e => ({ type: e.type, ms: utcMs(e.at), q: order.get(`${e.attempt_id}|${e.question_id}`) || null, detail: e.detail }))
    .filter(e => e.ms !== null)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 20)
    .map(e => ({ type: e.type, t: new Date(e.ms).toISOString(), q: e.q, detail: e.detail }));

  res.json({ events: merged });
});

// GET /api/risk/settings
router.get('/settings', (req, res) => {
  res.json({ config: engine.getConfig(), defaults: engine.DEFAULT_CONFIG, rules: engine.RULES });
});

// PUT /api/risk/settings
router.put('/settings', (req, res) => {
  const result = engine.sanitizeConfig(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, config: engine.saveConfig(result.config) });
});

module.exports = router;