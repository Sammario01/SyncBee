// server/routes/analytics.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');
const { examAnalytics, bundleAnalytics } = require('../analytics');

router.use(requireAdminSession);

function run(req, res) {
  try {
    const result = examAnalytics(req.session.school_id, req.params.exam_code);
    if (!result) { res.status(404).json({ error: 'Exam not found.' }); return null; }
    return result;
  } catch (err) {
    console.error('[analytics] failed:', err.message);
    res.status(500).json({ error: 'The analytics could not be worked out.' });
    return null;
  }
}

// GET /api/analytics/exam/:exam_code
router.get('/exam/:exam_code', (req, res) => {
  const result = run(req, res);
  if (result) res.json(result);
});

// GET /api/analytics/bundles — bundle picker
router.get('/bundles', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT eb.bundle_code, eb.bundle_title
    FROM student_bundle_attempts sba
    INNER JOIN exam_bundles eb ON sba.bundle_code = eb.bundle_code
    ORDER BY eb.bundle_title
  `).all();
  res.json(rows);
});

// GET /api/analytics/bundle/:bundle_code
router.get('/bundle/:bundle_code', (req, res) => {
  try {
    const result = bundleAnalytics(req.session.school_id, req.params.bundle_code);
    if (!result) return res.status(404).json({ error: 'Bundle not found.' });
    res.json(result);
  } catch (err) {
    console.error('[analytics] bundle failed:', err.message);
    res.status(500).json({ error: 'The bundle analytics could not be worked out.' });
  }
});

// GET /api/analytics/exam/:exam_code/export.xlsx
router.get('/exam/:exam_code/export.xlsx', async (req, res) => {
  const result = run(req, res);
  if (!result) return;

  let buffer;
  try {
    const { buildWorkbook } = require('../analyticsExport');
    buffer = await buildWorkbook(result).xlsx.writeBuffer();
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      return res.status(501).json({ error: 'Excel export needs a one-time install. Close SyncBee and run: npm install exceljs' });
    }
    console.error('[analytics] export failed:', err.message);
    return res.status(500).json({ error: 'The Excel file could not be created.' });
  }

  const safe = String(result.exam.title || 'exam').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'exam';
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="analytics-${safe}.xlsx"`
  });
  res.send(Buffer.from(buffer));
});

module.exports = router;