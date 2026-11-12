// server/routes/incidents.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// GET /api/incidents/exams — exams that have at least one logged incident
// GET /api/incidents/exams — exams that have at least one logged incident (excludes bundled exams)
router.get('/exams', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT e.exam_code, e.exam_title
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
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

// GET /api/incidents/exam/:exam_code
router.get('/exam/:exam_code', (req, res) => {
  const incidents = db.prepare(`
    SELECT ei.id, ei.incident_type, ei.details, ei.created_at,
           sa.student_id, sa.section, s.firstname, s.middlename, s.lastname
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sa.exam_code = ? AND sa.school_id = ?
    ORDER BY ei.created_at DESC
  `).all(req.params.exam_code, req.session.school_id);

  // Per-student strike counts, for the summary row
  const summaryMap = {};
  for (const inc of incidents) {
    const name = [inc.firstname, inc.middlename, inc.lastname].filter(Boolean).join(' ') || inc.student_id;
    if (!summaryMap[inc.student_id]) summaryMap[inc.student_id] = { name, count: 0 };
    summaryMap[inc.student_id].count++;
  }
  const summary = Object.values(summaryMap).sort((a, b) => b.count - a.count);

  res.json({ incidents, summary });
});

// GET /api/incidents/bundles — bundles that have at least one logged incident
router.get('/bundles', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT eb.bundle_code, eb.bundle_title
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    INNER JOIN student_bundle_attempts sba ON sa.bundle_attempt_id = sba.bundle_attempt_id
    INNER JOIN exam_bundles eb ON sba.bundle_code = eb.bundle_code
    WHERE eb.school_id = ?
    ORDER BY eb.bundle_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/incidents/bundle/:bundle_code
router.get('/bundle/:bundle_code', (req, res) => {
  const incidents = db.prepare(`
    SELECT ei.id, ei.incident_type, ei.details, ei.created_at,
           sa.student_id, sa.section, s.firstname, s.middlename, s.lastname
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    INNER JOIN student_bundle_attempts sba ON sa.bundle_attempt_id = sba.bundle_attempt_id
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sba.bundle_code = ? AND sba.school_id = ?
    ORDER BY ei.created_at DESC
  `).all(req.params.bundle_code, req.session.school_id);

  const summaryMap = {};
  for (const inc of incidents) {
    const name = [inc.firstname, inc.middlename, inc.lastname].filter(Boolean).join(' ') || inc.student_id;
    if (!summaryMap[inc.student_id]) summaryMap[inc.student_id] = { name, count: 0 };
    summaryMap[inc.student_id].count++;
  }
  const summary = Object.values(summaryMap).sort((a, b) => b.count - a.count);

  res.json({ incidents, summary });
});

module.exports = router;