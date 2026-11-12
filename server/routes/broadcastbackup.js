// server/routes/broadcast.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession, requireStudentSession } = require('./auth');

// ---------- STUDENT-FACING ----------

// GET /api/broadcast/status/:code?scope=exam|bundle&since=<timestamp>
router.get('/status/:code', requireStudentSession, (req, res) => {
  const { code } = req.params;
  const scope = req.query.scope === 'bundle' ? 'bundle' : 'exam';
  const sinceId = parseInt(req.query.since_id, 10) || 0;
  const col = scope === 'bundle' ? 'bundle_code' : 'exam_code';

  const lockRow = db.prepare(`SELECT locked FROM exam_locks WHERE ${col} = ?`).get(code);
  const locked = lockRow ? !!lockRow.locked : false;

  const newEvents = db.prepare(`
    SELECT id, type, message, created_at FROM exam_broadcasts
    WHERE ${col} = ? AND id > ? ORDER BY id ASC
  `).all(code, sinceId);

  res.json({ locked, events: newEvents });
});

// POST /api/broadcast/help
router.post('/help', requireStudentSession, (req, res) => {
  const { attempt_id, exam_code, bundle_code } = req.body;
  if (!attempt_id) return res.status(400).json({ success: false, message: 'attempt_id is required' });

  const existing = db.prepare(`SELECT id FROM help_requests WHERE attempt_id = ? AND status = 'pending'`).get(attempt_id);
  if (existing) return res.json({ success: true, message: 'Help request already pending' });

  db.prepare(`
    INSERT INTO help_requests (attempt_id, student_id, exam_code, bundle_code, school_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(attempt_id, req.session.student_id, exam_code || null, bundle_code || null, req.session.school_id);

  res.json({ success: true });
});

// ---------- ADMIN-FACING ----------

router.get('/help-requests/:code', requireAdminSession, (req, res) => {
  const col = req.query.scope === 'bundle' ? 'bundle_code' : 'exam_code';
  const rows = db.prepare(`
    SELECT hr.id, hr.attempt_id, hr.student_id, hr.created_at, s.firstname, s.middlename, s.lastname
    FROM help_requests hr LEFT JOIN students s ON hr.student_id = s.student_id
    WHERE hr.${col} = ? AND hr.school_id = ? AND hr.status = 'pending'
    ORDER BY hr.created_at ASC
  `).all(req.params.code, req.session.school_id);
  res.json(rows);
});

router.post('/help-requests/:id/resolve', requireAdminSession, (req, res) => {
  db.prepare(`UPDATE help_requests SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

router.get('/lock-status/:code', requireAdminSession, (req, res) => {
  const col = req.query.scope === 'bundle' ? 'bundle_code' : 'exam_code';
  const row = db.prepare(`SELECT locked FROM exam_locks WHERE ${col} = ?`).get(req.params.code);
  res.json({ locked: row ? !!row.locked : false });
});

router.post('/lock', requireAdminSession, (req, res) => {
  setLock(req.body.exam_code, req.body.bundle_code, 1);
  res.json({ success: true });
});

router.post('/unlock', requireAdminSession, (req, res) => {
  setLock(req.body.exam_code, req.body.bundle_code, 0);
  res.json({ success: true });
});

function setLock(examCode, bundleCode, locked) {
  const col = bundleCode ? 'bundle_code' : 'exam_code';
  const value = bundleCode || examCode;
  const existing = db.prepare(`SELECT id FROM exam_locks WHERE ${col} = ?`).get(value);
  if (existing) {
    db.prepare(`UPDATE exam_locks SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(locked, existing.id);
  } else {
    db.prepare(`INSERT INTO exam_locks (${col}, locked) VALUES (?, ?)`).run(value, locked);
  }
}

router.post('/message', requireAdminSession, (req, res) => {
  const { exam_code, bundle_code, message } = req.body;
  if (!message || (!exam_code && !bundle_code)) return res.status(400).json({ success: false, message: 'message and a target are required' });

  db.prepare(`INSERT INTO exam_broadcasts (exam_code, bundle_code, school_id, type, message) VALUES (?, ?, ?, 'message', ?)`)
    .run(exam_code || null, bundle_code || null, req.session.school_id, message);
  res.json({ success: true });
});

router.post('/force-submit', requireAdminSession, (req, res) => {
  const { exam_code, bundle_code } = req.body;
  if (!exam_code && !bundle_code) return res.status(400).json({ success: false, message: 'exam_code or bundle_code is required' });

  db.prepare(`INSERT INTO exam_broadcasts (exam_code, bundle_code, school_id, type, message) VALUES (?, ?, ?, 'force_submit', NULL)`)
    .run(exam_code || null, bundle_code || null, req.session.school_id);
  res.json({ success: true });
});

module.exports = router;