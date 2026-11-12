// server/routes/question-import.js
// Bulk question upload: read a sheet, check it, save it. Pictures are sent separately through
// /api/uploads/question-image, one at a time, by the page.
const express = require('express');
const router = express.Router();
const { requireAdminSession } = require('./auth');
const qi = require('../questionImport');

router.use(requireAdminSession);

const SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_CHUNK = 50;

function fail(res, err) {
  if (err && err.userMessage) return res.status(400).json({ error: err.userMessage });
  if (err && err.code === 'MODULE_NOT_FOUND') {
    return res.status(501).json({ error: 'Reading and creating Excel files needs a one-time install. Close SyncBee and run: npm install exceljs' });
  }
  console.error('[question-import]', err && err.message);
  return res.status(500).json({ error: 'Something went wrong while handling the file.' });
}

// POST /api/question-import/parse   (the file or pasted text is the request body)
router.post('/parse', express.raw({ type: [SHEET, 'text/plain', 'text/csv', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  try {
    res.json(await qi.readRows(req.body));
  } catch (err) {
    fail(res, err);
  }
});

function shared(req) {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : [];
  return { b, rows };
}

// POST /api/question-import/validate   { exam_code, rows, images:[{name,size,type}], allow_html, default_marks, allow_duplicates }
router.post('/validate', (req, res) => {
  try {
    const { b, rows } = shared(req);
    if (!b.exam_code || rows.length === 0 || rows.length > MAX_CHUNK) {
      return res.status(400).json({ error: `Send between 1 and ${MAX_CHUNK} rows at a time.` });
    }
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 3000)
      .map(i => ({ name: String((i && i.name) || '').slice(0, 300), size: Number(i && i.size) || 0, type: String((i && i.type) || '').slice(0, 60) }));
    const result = qi.validateRows(req.session.school_id, String(b.exam_code), rows.map(qi.cleanRow), {
      images, allow_html: !!b.allow_html, default_marks: b.default_marks, allow_duplicates: !!b.allow_duplicates
    });
    if (!result) return res.status(404).json({ error: 'Exam not found.' });
    res.json({ rows: result });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/question-import/commit   { exam_code, rows, image_urls:{ "heart.png": "/uploads/question_images/LQ-….png" }, ... }
router.post('/commit', (req, res) => {
  try {
    const { b, rows } = shared(req);
    if (!b.exam_code || rows.length === 0 || rows.length > MAX_CHUNK) {
      return res.status(400).json({ error: `Send between 1 and ${MAX_CHUNK} rows at a time.` });
    }
    const image_urls = {};
    Object.entries(b.image_urls && typeof b.image_urls === 'object' ? b.image_urls : {}).slice(0, 300)
      .forEach(([name, url]) => { image_urls[String(name).slice(0, 300)] = String(url).slice(0, 300); });
    const result = qi.commitRows(req.session.school_id, String(b.exam_code), rows.map(qi.cleanRow), {
      image_urls, allow_html: !!b.allow_html, default_marks: b.default_marks, allow_duplicates: !!b.allow_duplicates
    });
    if (!result) return res.status(404).json({ error: 'Exam not found.' });
    res.json(result);
  } catch (err) {
    console.error('[question-import] batch failed:', err && err.message);
    res.status(500).json({ error: 'This batch could not be saved. Nothing from it was added.' });
  }
});

router.get('/template.xlsx', async (req, res) => {
  try {
    const buffer = await qi.buildTemplate().xlsx.writeBuffer();
    res.set({ 'Content-Type': SHEET, 'Content-Disposition': 'attachment; filename="questions-template.xlsx"' });
    res.send(Buffer.from(buffer));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="questions-template.csv"' });
  res.send(qi.templateCsv());
});

router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is larger than 10 MB.' });
  next(err);
});

module.exports = router;