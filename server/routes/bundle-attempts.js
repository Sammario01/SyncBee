// server/routes/bundle-attempts.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../../db/database');
const { requireStudentSession } = require('./auth');

router.use(requireStudentSession);

function generateBundleAttemptId(studentId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BA-SCH${studentId}-${t}-${random}`;
}
function generateAttemptId(studentId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `A-SCH${studentId}-${t}-${random}`;
}

// Starts (or resumes) the child exam attempt for a given bundle item, tagging
// it with bundle_attempt_id — reuses the exact same resume/create logic as
// the standalone /api/attempts/start route, just scoped to bundles.
function startOrResumeItem(bundleAttemptId, studentId, schoolId, exam) {
  const existing = db.prepare(`
    SELECT attempt_id FROM student_attempts
    WHERE bundle_attempt_id = ? AND exam_code = ? AND status = 'In Progress'
    ORDER BY id DESC LIMIT 1
  `).get(bundleAttemptId, exam.exam_code);

  if (existing) return existing.attempt_id;

  const attemptId = generateAttemptId(studentId);
  db.prepare(`
    INSERT INTO student_attempts
      (school_id, attempt_id, student_id, exam_code, exam_id, section, attempt_number, status, started_at, bundle_attempt_id)
    VALUES (?, ?, ?, ?, ?, 'A', 1, 'In Progress', CURRENT_TIMESTAMP, ?)
  `).run(schoolId, attemptId, studentId, exam.exam_code, exam.id, bundleAttemptId);

  return attemptId;
}

// POST /api/bundle-attempts/start
// Body: { bundle_code }
router.post('/start', (req, res) => {
  const { bundle_code } = req.body;
  const { student_id, school_id } = req.session;

  if (!bundle_code) return res.status(400).json({ error: 'bundle_code is required' });

  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?').get(bundle_code, school_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const items = db.prepare(`
    SELECT bi.item_order, e.* FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundle_code);

  if (items.length === 0) return res.status(400).json({ error: 'This bundle has no exams in it.' });

  let bundleAttempt = db.prepare(`
    SELECT * FROM student_bundle_attempts WHERE student_id = ? AND bundle_code = ? AND status = 'In Progress'
    ORDER BY id DESC LIMIT 1
  `).get(student_id, bundle_code);

  if (!bundleAttempt) {
    const bundleAttemptId = generateBundleAttemptId(student_id);
    db.prepare(`
      INSERT INTO student_bundle_attempts
        (school_id, bundle_attempt_id, bundle_code, student_id, status, started_at, current_item_order, remaining_seconds)
      VALUES (?, ?, ?, ?, 'In Progress', CURRENT_TIMESTAMP, 1, ?)
    `).run(school_id, bundleAttemptId, bundle_code, student_id, bundle.total_duration_minutes * 60);
    bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?').get(bundleAttemptId);
  }

  const currentItem = items[bundleAttempt.current_item_order - 1];
  const attemptId = startOrResumeItem(bundleAttempt.bundle_attempt_id, student_id, school_id, currentItem);

  res.json({
    bundle_attempt_id: bundleAttempt.bundle_attempt_id,
    attempt_id: attemptId,
    exam_code: currentItem.exam_code,
    exam_id: currentItem.id,
    current_item_order: bundleAttempt.current_item_order,
    total_items: items.length,
    remaining_seconds: bundleAttempt.remaining_seconds
  });
});

// POST /api/bundle-attempts/:bundle_attempt_id/advance
// Called right after a bundled item's save-answers succeeds.
router.post('/:bundle_attempt_id/advance', (req, res) => {
  const { bundle_attempt_id } = req.params;
  const { student_id, school_id } = req.session;

  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?').get(bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Bundle attempt not found' });
  if (bundleAttempt.student_id !== student_id) return res.status(403).json({ error: 'This bundle attempt does not belong to you.' });

  const items = db.prepare(`
    SELECT bi.item_order, e.* FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundleAttempt.bundle_code);

  const nextOrder = bundleAttempt.current_item_order + 1;

  if (nextOrder > items.length) {
    db.prepare(`UPDATE student_bundle_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP WHERE bundle_attempt_id = ?`)
      .run(bundle_attempt_id);
    return res.json({ completed: true });
  }

  db.prepare(`UPDATE student_bundle_attempts SET current_item_order = ? WHERE bundle_attempt_id = ?`)
    .run(nextOrder, bundle_attempt_id);

  const nextItem = items[nextOrder - 1];
  const attemptId = startOrResumeItem(bundle_attempt_id, student_id, school_id, nextItem);

  res.json({
    completed: false,
    attempt_id: attemptId,
    exam_code: nextItem.exam_code,
    exam_id: nextItem.id,
    exam_title: nextItem.exam_title,
    current_item_order: nextOrder,
    total_items: items.length,
    remaining_seconds: bundleAttempt.remaining_seconds
  });
});

// POST /api/bundle-attempts/:bundle_attempt_id/heartbeat
// Persists the shared timer server-side so it survives an app restart/crash.
router.post('/:bundle_attempt_id/heartbeat', (req, res) => {
  const { remaining_seconds } = req.body;
  const bundleAttempt = db.prepare('SELECT student_id FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });
  if (bundleAttempt.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('UPDATE student_bundle_attempts SET remaining_seconds = ? WHERE bundle_attempt_id = ?')
    .run(parseInt(remaining_seconds, 10) || 0, req.params.bundle_attempt_id);
  res.json({ status: 'ok' });
});

// GET /api/bundle-attempts/:bundle_attempt_id/items — lean status list for the
// in-exam switcher bar (ownership already proven via bundle_attempt_id + session).
router.get('/:bundle_attempt_id/items', (req, res) => {
  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });
  if (bundleAttempt.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });

  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title, e.id AS exam_id
    FROM exam_bundle_items bi INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundleAttempt.bundle_code);

  const withStatus = items.map(item => {
    const attempt = db.prepare(`
      SELECT status FROM student_attempts
      WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
    `).get(req.params.bundle_attempt_id, item.exam_code);
    return { ...item, status: attempt ? (attempt.status === 'Submitted' ? 'submitted' : 'in_progress') : 'not_started' };
  });

  res.json({ items: withStatus, all_submitted: withStatus.every(i => i.status === 'submitted') });
});

// POST /api/bundle-attempts/:bundle_attempt_id/switch-item
// Body: { item_order } — only valid for navigation_mode = 'free'.
router.post('/:bundle_attempt_id/switch-item', (req, res) => {
  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });
  if (bundleAttempt.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });

  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ?').get(bundleAttempt.bundle_code);
  if (bundle.navigation_mode !== 'free') {
    return res.status(403).json({ error: 'This bundle does not allow free navigation between exams.' });
  }

  const { item_order } = req.body;
  const item = db.prepare(`
    SELECT bi.item_order, e.* FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? AND bi.item_order = ?
  `).get(bundleAttempt.bundle_code, item_order);
  if (!item) return res.status(404).json({ error: 'Item not found in this bundle.' });


  const attemptId = startOrResumeItem(req.params.bundle_attempt_id, req.session.student_id, req.session.school_id, item);

  db.prepare('UPDATE student_bundle_attempts SET current_item_order = ? WHERE bundle_attempt_id = ?')
    .run(item_order, req.params.bundle_attempt_id);

  res.json({
    attempt_id: attemptId, exam_code: item.exam_code, exam_id: item.id,
    current_item_order: item_order, remaining_seconds: bundleAttempt.remaining_seconds
  });
});

// POST /api/bundle-attempts/:bundle_attempt_id/finish-now
// Manual "I'm done" for free mode — any never-submitted items score 0,
// matching the same rule we already use for timer-expiry.
router.post('/:bundle_attempt_id/finish-now', (req, res) => {
  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });
  if (bundleAttempt.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });

    db.prepare(`UPDATE student_bundle_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP, submission_reason = ? WHERE bundle_attempt_id = ?`)
      .run(reason, req.params.bundle_attempt_id);

  res.json({ success: true });
});

// POST /api/bundle-attempts/:bundle_attempt_id/submit-all
// The ONE final action for free-navigation bundles — scores and finalizes
// every item at once, using whatever has already been autosaved.
router.post('/:bundle_attempt_id/submit-all', (req, res) => {
  const reason = ['timeout', 'anti_cheat', 'admin_force_submit'].includes(req.body.submission_reason) ? req.body.submission_reason : 'student_manual';
  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });
  if (bundleAttempt.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });

  const items = db.prepare(`
    SELECT bi.item_order, e.* FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundleAttempt.bundle_code);

  const finalizeAll = db.transaction(() => {
    for (const item of items) {
      const attempt = db.prepare(`
        SELECT * FROM student_attempts WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
      `).get(req.params.bundle_attempt_id, item.exam_code);

      if (!attempt || attempt.status === 'Submitted') continue;

      const correctCountRow = db.prepare(`
        SELECT COUNT(*) AS correct_count FROM student_answers sa
        INNER JOIN exam_questions eq ON sa.question_id = eq.question_id
        WHERE sa.attempt_id = ? AND LOWER(TRIM(sa.answer)) = LOWER(TRIM(eq.correct_answer))
          AND eq.question_type IN ('MCQ_SINGLE', 'TRUE_FALSE')
      `).get(attempt.attempt_id);

      const totalQuestionsRow = db.prepare(`
        SELECT COUNT(*) AS total FROM exam_questions WHERE exam_code = ? AND question_type IN ('MCQ_SINGLE', 'TRUE_FALSE')
      `).get(item.exam_code);

      const score = totalQuestionsRow.total > 0
        ? (correctCountRow.correct_count / totalQuestionsRow.total) * item.total_marks
        : 0;

           db.prepare(`UPDATE student_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP, score = ?, submission_reason = ? WHERE id = ?`)
        .run(score, reason, attempt.id);
    }

       db.prepare(`UPDATE student_bundle_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP, submission_reason = ? WHERE bundle_attempt_id = ?`)
      .run(reason, req.params.bundle_attempt_id);
  });

  finalizeAll();
  res.json({ success: true });
});

// GET /api/bundle-attempts/:bundle_attempt_id/timer — always the live, true value.
router.get('/:bundle_attempt_id/timer', (req, res) => {
  const row = db.prepare('SELECT student_id, remaining_seconds FROM student_bundle_attempts WHERE bundle_attempt_id = ?')
    .get(req.params.bundle_attempt_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.student_id !== req.session.student_id) return res.status(403).json({ error: 'Forbidden' });
  res.json({ remaining_seconds: row.remaining_seconds });
});
module.exports = router;