// server/routes/questions.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

function generateLocalQuestionId() {
  return `LQ-${Math.floor(Date.now()).toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}
function generateLocalOptionId() {
  return `LO-${Math.floor(Date.now()).toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/* ---------- Server-side HTML sanitizer (allow-list) ---------- */
const ALLOWED_TAGS = new Set(['b','i','u','strong','em','ul','ol','li','p','br','a','code','h3','span']);

function sanitizeHtml(input) {
  if (input == null) return '';
  let html = String(input);

  html = html.replace(/<\s*(script|style|iframe|object|embed|svg|math)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');

  html = html.replace(/<([a-zA-Z0-9]+)((?:\s+[^>]*)?)\s*\/?>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (t === 'a') {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      const url = href ? (href[2] || href[3] || '') : '';
      if (!/^(https?:|mailto:)/i.test(url)) return '<a>';
      const safe = url.replace(/"/g, '&quot;');
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
    }
    return `<${t}>`;
  });

  html = html.replace(/<\s*\/\s*([a-zA-Z0-9]+)\s*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    return ALLOWED_TAGS.has(t) ? `</${t}>` : '';
  });
  return html.trim();
}

function normalizeImage(img) {
  if (!img || !img.url || typeof img.url !== 'string') return null;
  const url = img.url.trim();
  if (url.startsWith('blob:')) {
    console.warn('[normalizeImage] rejecting blob: URL — upload did not complete');
    return null;
  }
  if (!/^(\/|https?:\/\/)/i.test(url)) return null;
  const w = Math.min(100, Math.max(10, parseInt(img.width_pct, 10) || 60));
  const a = ['left','center','right'].includes(img.align) ? img.align : 'center';
  return { url, width_pct: w, align: a };
}

/* ---------- Prepared statements ---------- */
const insertQuestion = db.prepare(`
  INSERT INTO exam_questions
    (question_id, school_id, exam_code, question_type, question_text, marks,
     correct_answer, explanation, difficulty_level, negative_marks, passage_id,
     answer_mode, model_answer, student_instructions, max_words, time_limit_minutes,
     image_url, image_width_pct, image_align)
  VALUES
    (@question_id, @school_id, @exam_code, @question_type, @question_text, @marks,
     @correct_answer, @explanation, @difficulty_level, @negative_marks, @passage_id,
     @answer_mode, @model_answer, @student_instructions, @max_words, @time_limit_minutes,
     @image_url, @image_width_pct, @image_align)
`);

const insertOption = db.prepare(`
  INSERT INTO exam_question_options
    (question_id, option_text, is_correct, school_id, option_id,
     image_url, image_width_pct, image_align)
  VALUES
    (@question_id, @option_text, @is_correct, @school_id, @option_id,
     @image_url, @image_width_pct, @image_align)
`);

/* ---------- CREATE transaction ---------- */
const createQuestionWithOptions = db.transaction((data) => {
  const {
    question_id, school_id, passage_id, exam_code, question_type,
    question_text, marks, correct_answer, explanation, difficulty_level,
    negative_marks, answer_mode, model_answer, student_instructions,
    max_words, time_limit_minutes, options, question_image
  } = data;

  const qi = normalizeImage(question_image);

  insertQuestion.run({
    question_id, school_id, exam_code,
    question_type: question_type || 'MCQ_SINGLE',
    question_text: sanitizeHtml(question_text),
    marks: marks || 1.00,
    correct_answer: correct_answer || null,
    explanation: explanation ? sanitizeHtml(explanation) : null,
    difficulty_level: difficulty_level || null,
    negative_marks: negative_marks || null,
    passage_id: passage_id || null,
    answer_mode: answer_mode || null,
    model_answer: model_answer || null,
    student_instructions: student_instructions || null,
    max_words: max_words || null,
    time_limit_minutes: time_limit_minutes || null,
    image_url: qi ? qi.url : null,
    image_width_pct: qi ? qi.width_pct : null,
    image_align: qi ? qi.align : null
  });

  if (Array.isArray(options)) {
    for (const opt of options) {
      const oi = normalizeImage(opt.image);
      insertOption.run({
        question_id,
        option_text: sanitizeHtml(opt.option_text),
        is_correct: opt.is_correct ? 1 : 0,
        school_id,
        option_id: opt.option_id,
        image_url: oi ? oi.url : null,
        image_width_pct: oi ? oi.width_pct : null,
        image_align: oi ? oi.align : null
      });
    }
  }
});

/* ---------- UPDATE transaction ---------- */
const updateQuestionWithOptions = db.transaction((data) => {
  const {
    question_id, school_id, question_text, marks, correct_answer, explanation,
    difficulty_level, negative_marks, answer_mode, model_answer,
    student_instructions, max_words, time_limit_minutes,
    question_image, options
  } = data;

  const qi = normalizeImage(question_image);

  db.prepare(`
    UPDATE exam_questions SET
      question_text = @question_text,
      marks = @marks,
      correct_answer = @correct_answer,
      explanation = @explanation,
      difficulty_level = @difficulty_level,
      negative_marks = @negative_marks,
      answer_mode = @answer_mode,
      model_answer = @model_answer,
      student_instructions = @student_instructions,
      max_words = @max_words,
      time_limit_minutes = @time_limit_minutes,
      image_url = @image_url,
      image_width_pct = @image_width_pct,
      image_align = @image_align
    WHERE question_id = @question_id
  `).run({
    question_id,
    question_text: sanitizeHtml(question_text),
    marks: marks || 1.00,
    correct_answer: correct_answer || null,
    explanation: explanation ? sanitizeHtml(explanation) : null,
    difficulty_level: difficulty_level || null,
    negative_marks: negative_marks || null,
    answer_mode: answer_mode || null,
    model_answer: model_answer || null,
    student_instructions: student_instructions || null,
    max_words: max_words || null,
    time_limit_minutes: time_limit_minutes || null,
    image_url: qi ? qi.url : null,
    image_width_pct: qi ? qi.width_pct : null,
    image_align: qi ? qi.align : null
  });

  db.prepare('DELETE FROM exam_question_options WHERE question_id = ?').run(question_id);

  if (Array.isArray(options)) {
    for (const opt of options) {
      const oi = normalizeImage(opt.image);
      insertOption.run({
        question_id,
        option_text: sanitizeHtml(opt.option_text),
        is_correct: opt.is_correct ? 1 : 0,
        school_id,
        option_id: opt.option_id || generateLocalOptionId(),
        image_url: oi ? oi.url : null,
        image_width_pct: oi ? oi.width_pct : null,
        image_align: oi ? oi.align : null
      });
    }
  }
});

/* ---------- POST / ---------- */
router.post('/', (req, res) => {
  const school_id = req.session.school_id;
  const { exam_code, question_text } = req.body;
  const question_id = req.body.question_id || generateLocalQuestionId();

  if (!exam_code || !question_text) {
    return res.status(400).json({ error: 'Missing required fields: exam_code, question_text' });
  }

  if (Array.isArray(req.body.options)) {
    req.body.options.forEach(opt => {
      if (!opt.option_id) opt.option_id = generateLocalOptionId();
    });

    const type = req.body.question_type || 'MCQ_SINGLE';
    if (type === 'MCQ_SINGLE' || type === 'TRUE_FALSE') {
      let correctOpt = req.body.options.find(o => o.is_correct) || null;
      if (!correctOpt && req.body.correct_answer) {
        correctOpt = req.body.options.find(o => o.option_id === req.body.correct_answer) || null;
      }
      if (!correctOpt && req.body.correct_answer) {
        const target = String(req.body.correct_answer).trim().toLowerCase();
        correctOpt = req.body.options.find(
          o => String(o.option_text).trim().toLowerCase() === target
        ) || null;
      }
      req.body.correct_answer = correctOpt ? correctOpt.option_id : null;
    }
  }

  try {
    createQuestionWithOptions({ ...req.body, question_id, school_id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const question = db.prepare('SELECT * FROM exam_questions WHERE question_id = ?').get(question_id);
  const options = db.prepare('SELECT * FROM exam_question_options WHERE question_id = ?').all(question_id);
  res.status(201).json({ ...question, options });
});

/* ---------- GET / ---------- */
router.get('/', (req, res) => {
  const { exam_code } = req.query;
  if (!exam_code) return res.status(400).json({ error: 'exam_code query param is required' });

  const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_code = ?').all(exam_code);
  const withOptions = questions.map(q => ({
    ...q,
    question_image: q.image_url
      ? { url: q.image_url, width_pct: q.image_width_pct, align: q.image_align }
      : null,
    options: db.prepare('SELECT * FROM exam_question_options WHERE question_id = ?').all(q.question_id)
      .map(o => ({
        ...o,
        image: o.image_url
          ? { url: o.image_url, width_pct: o.image_width_pct, align: o.image_align }
          : null
      }))
  }));

  res.json(withOptions);
});

/* ---------- GET /:question_id ---------- */
router.get('/:question_id', (req, res) => {
  const question = db.prepare('SELECT * FROM exam_questions WHERE question_id = ?').get(req.params.question_id);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  const options = db.prepare('SELECT * FROM exam_question_options WHERE question_id = ?').all(req.params.question_id);
  res.json({
    ...question,
    question_image: question.image_url
      ? { url: question.image_url, width_pct: question.image_width_pct, align: question.image_align }
      : null,
    options: options.map(o => ({
      ...o,
      image: o.image_url
        ? { url: o.image_url, width_pct: o.image_width_pct, align: o.image_align }
        : null
    }))
  });
});

/* ===========================================================================
 * POST /api/questions/import-from-bank
 * Body: {
 *   exam_code: "EXAM-...",
 *   questions: [ { question_code, question_text, option_a..d, correct_option,
 *                  explanation, difficulty, image_url, ... } ]
 * }
 * Writes into exam_questions + exam_question_options.
 * Skips rows whose question_code already exists in that exam.
 * ======================================================================== */
const fsPath   = require('path');
const fs       = require('fs');
const axiosLib = require('axios');
const CLOUD_BASE_URL = 'https://mariobee.com';
const UPLOAD_FOLDER  = require('../paths').uploadsDir;

async function downloadOneImage(srcUrl, skipped) {
  if (!srcUrl) return null;
  if (!/^https?:\/\//i.test(srcUrl)) return srcUrl;
  if (!fs.existsSync(UPLOAD_FOLDER)) fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });

  const filename = fsPath.basename(srcUrl.split('?')[0]);
  const savePath = fsPath.join(UPLOAD_FOLDER, filename);
  const localUrl = `/uploads/question_images/${filename}`;

  if (fs.existsSync(savePath)) return localUrl;

  const fullOnlineUrl = `${CLOUD_BASE_URL}/admin/upload_question_image/${filename}`;
  try {
    const response = await axiosLib.get(fullOnlineUrl, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(savePath, response.data);
    return localUrl;
  } catch (err) {
    skipped.push({
      filename, url: srcUrl,
      reason: err.response ? `HTTP ${err.response.status}` : err.message
    });
    return null;
  }
}

router.post('/import-from-bank', async (req, res) => {
  const school_id = req.session.school_id;
  const { exam_code } = req.body;
  const rows = Array.isArray(req.body.questions) ? req.body.questions : [];

  if (!exam_code)   return res.status(400).json({ success: false, message: 'exam_code is required.' });
  if (!rows.length) return res.status(400).json({ success: false, message: 'No questions provided.' });
  if (rows.length > 40) return res.status(400).json({ success: false, message: 'Maximum 40 questions per import.' });

  // Confirm the exam belongs to this school
 const exam = db.prepare(`SELECT exam_code, exam_title FROM examinations WHERE exam_code = ? AND school_id = ?`).get(exam_code, school_id);
if (!exam) return res.status(404).json({ success: false, message: 'Exam not found for this school.' });

  // Download images up-front (outside the transaction)
  const skippedImages = [];
  for (const row of rows) {
    if (row.image_url) {
      row.image_url = await downloadOneImage(row.image_url, skippedImages);
    }
    for (const field of ['question_text', 'explanation']) {
      if (!row[field]) continue;
      const urls = [...String(row[field]).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
      for (const url of urls) {
        if (!/^https?:\/\//i.test(url)) continue;
        const local = await downloadOneImage(url, skippedImages);
        if (local) row[field] = row[field].split(url).join(local);
      }
    }
  }

  const insQ = db.prepare(`
    INSERT INTO exam_questions
      (question_id, school_id, exam_code, question_type, question_text, marks,
       correct_answer, explanation, difficulty_level, negative_marks,
       source_question_code, image_url, image_width_pct, image_align)
    VALUES
      (@question_id, @school_id, @exam_code, 'MCQ_SINGLE', @question_text, @marks,
       @correct_answer, @explanation, @difficulty_level, @negative_marks,
       @source_question_code, @image_url, @image_width_pct, @image_align)
  `);
  const insO = db.prepare(`
    INSERT INTO exam_question_options
      (school_id, option_id, question_id, option_text, is_correct)
    VALUES (@school_id, @option_id, @question_id, @option_text, @is_correct)
  `);
  const dupCheck = db.prepare(`
    SELECT 1 FROM exam_questions
    WHERE exam_code = ? AND source_question_code = ?
    LIMIT 1
  `);

  const persist = db.transaction((school_id, exam_code, list) => {
    let imported = 0, skipped = 0;
    for (const row of list) {
      if (!row.question_code) { skipped++; continue; }
      if (!row.question_text || !String(row.question_text).trim()) { skipped++; continue; }
      if (dupCheck.get(exam_code, row.question_code)) { skipped++; continue; }

      const question_id = generateLocalQuestionId();
      const map = {
        A: row.option_a, B: row.option_b,
        C: row.option_c, D: row.option_d
      };
      const correctLetter = String(row.correct_option || '').trim().toUpperCase();
      const correct_answer = map[correctLetter] || null;

      insQ.run({
        question_id,
        school_id,
        exam_code,
        question_text:        sanitizeHtml(row.question_text),
        marks:                1.0,
        correct_answer,
        explanation:          row.explanation ? sanitizeHtml(row.explanation) : null,
        difficulty_level:     ['easy','medium','hard'].includes(row.difficulty) ? row.difficulty : null,
        negative_marks:       0,
        source_question_code: row.question_code,
        image_url:            row.image_url || null,
        image_width_pct:      row.image_url ? 60 : null,
        image_align:          row.image_url ? 'center' : null
      });

      for (const L of ['A','B','C','D']) {
        const text = map[L];
        if (!text || !String(text).trim()) continue;
        insO.run({
          school_id,
          option_id:   generateLocalOptionId(),
          question_id,
          option_text: sanitizeHtml(text),
          is_correct:  L === correctLetter ? 1 : 0
        });
      }
      imported++;
    }
    return { imported, skipped };
  });

  let result;
  try {
    result = persist(school_id, exam_code, rows);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }

 const examLabel = exam.exam_title || exam.exam_code;
const msg =
  `${result.imported} question(s) imported into "${examLabel}".` +
  (result.skipped ? ` ${result.skipped} skipped (duplicate or empty).` : '') +
  (skippedImages.length ? ` ${skippedImages.length} image(s) failed to download.` : '');

  res.json({
    success: true,
    imported: result.imported,
    skipped:  result.skipped,
    skipped_images: skippedImages,
    message: msg
  });
});
/* ---------- PUT /:question_id ---------- */
router.put('/:question_id', (req, res) => {
  const existing = db.prepare('SELECT * FROM exam_questions WHERE question_id = ?').get(req.params.question_id);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  if (Array.isArray(req.body.options)) {
    req.body.options.forEach(opt => {
      if (!opt.option_id) opt.option_id = generateLocalOptionId();
    });

    const type = req.body.question_type || existing.question_type || 'MCQ_SINGLE';
    if (type === 'MCQ_SINGLE' || type === 'TRUE_FALSE') {
      let correctOpt = req.body.options.find(o => o.is_correct) || null;
      if (!correctOpt && req.body.correct_answer) {
        correctOpt = req.body.options.find(o => o.option_id === req.body.correct_answer) || null;
      }
      req.body.correct_answer = correctOpt ? correctOpt.option_id : null;
    }
  }

  try {
    updateQuestionWithOptions({
      ...req.body,
      question_id: req.params.question_id,
      school_id: existing.school_id
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const updated = db.prepare('SELECT * FROM exam_questions WHERE question_id = ?').get(req.params.question_id);
  const options = db.prepare('SELECT * FROM exam_question_options WHERE question_id = ?').all(req.params.question_id);
  res.json({
    ...updated,
    question_image: updated.image_url
      ? { url: updated.image_url, width_pct: updated.image_width_pct, align: updated.image_align }
      : null,
    options: options.map(o => ({
      ...o,
      image: o.image_url
        ? { url: o.image_url, width_pct: o.image_width_pct, align: o.image_align }
        : null
    }))
  });
});

/* ---------- DELETE /:question_id ---------- */
const deleteQuestionWithOptions = db.transaction((question_id) => {
  db.prepare('DELETE FROM exam_question_options WHERE question_id = ?').run(question_id);
  db.prepare('DELETE FROM exam_questions WHERE question_id = ?').run(question_id);
});

router.delete('/:question_id', (req, res) => {
    const existing = db.prepare('SELECT question_id FROM exam_questions WHERE question_id = ?').get(req.params.question_id);
  // const existing = db.prepare('SELECT * FROM exam_questions WHERE question_id = ?').get(req.params.question_id);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  deleteQuestionWithOptions(req.params.question_id);
  res.status(204).send();
});

module.exports = router;