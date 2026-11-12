// server/routes/sync-prep-questions.js
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

const CLOUD_BASE_URL = 'https://mariobee.com';

/* ---------- GET /api/sync/prep-questions?exam_code=X ----------
 * Proxy to the cloud, tag each row with already_imported.
 * No persistence — the picker takes what it needs and posts it back.
 */
router.get('/prep-questions', async (req, res) => {
  const school_id = req.session.school_id;
  const { exam_code } = req.query;

  let body;
  try {
    const response = await axios.get(`${CLOUD_BASE_URL}/api/sync/fetch_prep_questions.php`, {
      params: { school_id },
      timeout: 60000
    });
    body = response.data;
  } catch (err) {
    const msg = err.response
      ? `Server returned HTTP ${err.response.status}`
      : `Connection failed: ${err.message}`;
    return res.status(502).json({ status: 'error', message: msg });
  }

  if (!body || body.status !== 'success' || !Array.isArray(body.data)) {
    return res.status(502).json({
      status: 'error',
      message: body?.message || 'Unexpected response from cloud.'
    });
  }

  // Tag already-imported rows for this exam
  let importedSet = new Set();
  if (exam_code) {
    const rows = db.prepare(`
      SELECT source_question_code FROM exam_questions
      WHERE exam_code = ? AND source_question_code IS NOT NULL
    `).all(exam_code);
    importedSet = new Set(rows.map(r => r.source_question_code));
  }

  const questions = body.data.map(q => ({
    ...q,
    already_imported: importedSet.has(q.question_code)
  }));

  res.json({ status: 'success', questions });
});

module.exports = router;