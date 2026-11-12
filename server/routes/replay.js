// server/routes/replay.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

function toMs(value) {
  if (!value) return null;
  const s = String(value);
  const v = Date.parse(/Z$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); // stored times are UTC
  return Number.isNaN(v) ? null : v;
}

const ORDER = { bundle_started: 0, exam_started: 1, submitted: 8, bundle_submitted: 9 };

function sortEvents(events) {
  events.sort((a, b) =>
    (a.t - b.t) ||
    ((ORDER[a.type] ?? 5) - (ORDER[b.type] ?? 5)) ||
    ((a.ord || 0) - (b.ord || 0))
  );
}

// One attempt = its questions (in the order the student saw them) + every event we know about.
function buildAttempt(attempt) {
  const exam = db.prepare('SELECT exam_title FROM examinations WHERE exam_code = ?').get(attempt.exam_code);

  let questions = db.prepare(`
    SELECT eq.question_id, eq.question_text, eq.question_type, eq.correct_answer
    FROM attempt_questions aq
    INNER JOIN exam_questions eq ON aq.question_id = eq.question_id
    WHERE aq.attempt_id = ?
    ORDER BY aq.question_order ASC
  `).all(attempt.attempt_id);

  if (questions.length === 0) {
    questions = db.prepare(
      'SELECT question_id, question_text, question_type, correct_answer FROM exam_questions WHERE exam_code = ? ORDER BY id ASC'
    ).all(attempt.exam_code);
  }

  const optionStmt = db.prepare(
    'SELECT option_id AS id, option_text FROM exam_question_options WHERE question_id = ? ORDER BY id ASC'
  );

  const item = {
    attempt_id: attempt.attempt_id,
    exam_code: attempt.exam_code,
    exam_title: exam ? exam.exam_title : attempt.exam_code,
    section: attempt.section,
    status: attempt.status,
    submission_reason: attempt.submission_reason,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    questions: questions.map(q => ({ ...q, options: optionStmt.all(q.question_id) }))
  };

  const events = [];
  const push = (type, t, extra = {}) => {
    if (t !== null) events.push({ type, t, attempt_id: attempt.attempt_id, ...extra });
  };

  push('exam_started', toMs(attempt.started_at));

  // Events recorded by the exam page itself
  const clientEvents = db.prepare(
    'SELECT id, event_type, question_id, data, occurred_at FROM exam_events WHERE attempt_id = ? ORDER BY occurred_at ASC, id ASC'
  ).all(attempt.attempt_id);

  const answeredByClient = new Set();
  for (const e of clientEvents) {
    let data = null;
    try { data = e.data ? JSON.parse(e.data) : null; } catch (x) { data = null; }
    if (e.event_type.startsWith('answer_')) answeredByClient.add(e.question_id);
    push(e.event_type, toMs(e.occurred_at), { question_id: e.question_id, data, ord: e.id });
  }

  // For questions with no client-side answer events (older attempts), fall back to the server audit trail
  const audit = db.prepare(
    'SELECT id, question_id, old_value, new_value, changed_at FROM answer_audit_log WHERE attempt_id = ? ORDER BY changed_at ASC, id ASC'
  ).all(attempt.attempt_id);
  for (const a of audit) {
    if (answeredByClient.has(a.question_id)) continue;
    const type = a.old_value ? (a.new_value ? 'answer_changed' : 'answer_cleared') : 'answer_selected';
    push(type, toMs(a.changed_at), { question_id: a.question_id, data: { old: a.old_value, new: a.new_value }, ord: a.id });
  }

  const incidents = db.prepare(
    'SELECT id, incident_type, details, created_at FROM exam_incidents WHERE attempt_id = ? ORDER BY created_at ASC, id ASC'
  ).all(attempt.attempt_id);
  for (const i of incidents) {
    push('strike_logged', toMs(i.created_at), { data: { incident_type: i.incident_type, details: i.details }, ord: i.id });
  }

  const helps = db.prepare('SELECT id, created_at, resolved_at FROM help_requests WHERE attempt_id = ?').all(attempt.attempt_id);
  for (const h of helps) {
    push('help_requested', toMs(h.created_at), { ord: h.id });
    if (h.resolved_at) push('help_resolved', toMs(h.resolved_at), { ord: h.id });
  }

  if (attempt.status === 'Submitted' && attempt.finished_at) {
    push('submitted', toMs(attempt.finished_at), { data: { reason: attempt.submission_reason } });
  }

  return { item, events };
}

function studentName(studentId) {
  const s = db.prepare('SELECT firstname, middlename, lastname FROM students WHERE student_id = ?').get(studentId);
  return s ? [s.firstname, s.middlename, s.lastname].filter(Boolean).join(' ') : studentId;
}

// GET /api/replay/attempt/:attempt_id
router.get('/attempt/:attempt_id', (req, res) => {
  const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ? AND school_id = ?')
    .get(req.params.attempt_id, req.session.school_id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const { item, events } = buildAttempt(attempt);
  sortEvents(events);

  res.json({
    kind: 'single',
    student_name: studentName(attempt.student_id),
    title: item.exam_title,
    submission_reason: attempt.submission_reason,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    items: [item],
    events
  });
});

// GET /api/replay/bundle/:bundle_attempt_id — every exam in the bundle, stitched into one timeline
router.get('/bundle/:bundle_attempt_id', (req, res) => {
  const ba = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ? AND school_id = ?')
    .get(req.params.bundle_attempt_id, req.session.school_id);
  if (!ba) return res.status(404).json({ error: 'Bundle attempt not found' });

  const bundle = db.prepare('SELECT bundle_title FROM exam_bundles WHERE bundle_code = ?').get(ba.bundle_code);
  const attempts = db.prepare('SELECT * FROM student_attempts WHERE bundle_attempt_id = ? ORDER BY id ASC')
    .all(ba.bundle_attempt_id);

  const items = [];
  const events = [];
  const startedMs = toMs(ba.started_at);
  if (startedMs !== null) events.push({ type: 'bundle_started', t: startedMs });

  for (const attempt of attempts) {
    const built = buildAttempt(attempt);
    items.push(built.item);
    events.push(...built.events);
  }

  if (ba.status === 'Submitted' && ba.finished_at) {
    events.push({ type: 'bundle_submitted', t: toMs(ba.finished_at), data: { reason: ba.submission_reason } });
  }
  sortEvents(events);

  res.json({
    kind: 'bundle',
    student_name: studentName(ba.student_id),
    title: bundle ? bundle.bundle_title : ba.bundle_code,
    submission_reason: ba.submission_reason,
    started_at: ba.started_at,
    finished_at: ba.finished_at,
    items,
    events
  });
});

module.exports = router;