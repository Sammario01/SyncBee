// server/routes/monitor.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// GET /api/monitor/exams — exams with at least one attempt, for the picker dropdown
router.get('/exams', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT e.exam_code, e.exam_title
    FROM student_attempts sa
    INNER JOIN examinations e ON sa.exam_code = e.exam_code
    WHERE e.school_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM exam_bundle_items ebi
        WHERE ebi.exam_code = e.exam_code
      )
    ORDER BY e.exam_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/monitor/exam/:exam_code — live attempt status for one exam
router.get('/exam/:exam_code', (req, res) => {
  const rows = db.prepare(`
    SELECT sa.attempt_id, sa.student_id, sa.section, sa.status, sa.score,
           sa.questions_answered, sa.current_question_index, sa.started_at, sa.last_activity,
           s.firstname, s.middlename, s.lastname,
           (SELECT COUNT(*) FROM attempt_questions aq
            WHERE aq.attempt_id = sa.attempt_id AND aq.section = sa.section) AS total_questions
    FROM student_attempts sa
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sa.exam_code = ? AND sa.school_id = ?
    ORDER BY sa.last_activity DESC
  `).all(req.params.exam_code, req.session.school_id);

  const now = Date.now();
  const withFreshness = rows.map(r => {
    const lastActivityMs = r.last_activity ? new Date(r.last_activity.replace(' ', 'T') + 'Z').getTime() : null;
    const secondsSinceActivity = lastActivityMs ? Math.floor((now - lastActivityMs) / 1000) : null;
    return { ...r, seconds_since_activity: secondsSinceActivity };
  });

  res.json(withFreshness);
});

// GET /api/monitor/bundles — bundles that have at least one attempt
router.get('/bundles', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT eb.bundle_code, eb.bundle_title
    FROM student_bundle_attempts sba
    INNER JOIN exam_bundles eb ON sba.bundle_code = eb.bundle_code
    WHERE eb.school_id = ? ORDER BY eb.bundle_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/monitor/bundle/:bundle_code — one row per student, aggregated across all their items
router.get('/bundle/:bundle_code', (req, res) => {
  const totalItems = db.prepare(`SELECT COUNT(*) AS c FROM exam_bundle_items WHERE bundle_code = ?`)
    .get(req.params.bundle_code).c;

  const bundleAttempts = db.prepare(`
    SELECT sba.*, s.firstname, s.middlename, s.lastname
    FROM student_bundle_attempts sba LEFT JOIN students s ON sba.student_id = s.student_id
    WHERE sba.bundle_code = ? AND sba.school_id = ?
    ORDER BY sba.started_at DESC
  `).all(req.params.bundle_code, req.session.school_id);

  const now = Date.now();
  const rows = bundleAttempts.map(ba => {
    const itemsSubmitted = db.prepare(`
      SELECT COUNT(*) AS c FROM student_attempts WHERE bundle_attempt_id = ? AND status = 'Submitted'
    `).get(ba.bundle_attempt_id).c;

    const lastActivity = db.prepare(`
      SELECT MAX(last_activity) AS t FROM student_attempts WHERE bundle_attempt_id = ?
    `).get(ba.bundle_attempt_id).t;

    const incidents = db.prepare(`
      SELECT COUNT(*) AS c FROM exam_incidents ei
      INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
      WHERE sa.bundle_attempt_id = ?
    `).get(ba.bundle_attempt_id).c;

    const lastActivityMs = lastActivity ? new Date(lastActivity.replace(' ', 'T') + 'Z').getTime() : null;

    return {
      bundle_attempt_id: ba.bundle_attempt_id,
      full_name: [ba.firstname, ba.middlename, ba.lastname].filter(Boolean).join(' ') || ba.student_id,
      status: ba.status,
      current_item_order: ba.current_item_order,
      total_items: totalItems,
      items_submitted: itemsSubmitted,
      incidents,
      seconds_since_activity: lastActivityMs ? Math.floor((now - lastActivityMs) / 1000) : null
    };
  });

  res.json(rows);
});

module.exports = router;