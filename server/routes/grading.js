// server/routes/grading.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// GET /api/grading/exams — exams that have at least one theory answer
router.get('/exams', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT e.exam_code, e.exam_title
    FROM theory_answers ta
    INNER JOIN examinations e ON ta.exam_code = e.exam_code
    WHERE e.school_id = ?
    ORDER BY e.exam_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/grading/exam/:exam_code — pending first, then marked
router.get('/exam/:exam_code', (req, res) => {
  const rows = db.prepare(`
    SELECT ta.answer_id, ta.question_id, ta.student_id, ta.answer_text, ta.word_count,
           ta.max_score, ta.score, ta.status, ta.marker_comment, ta.submitted_at,
           eq.question_text, eq.answer_mode,
           s.firstname, s.middlename, s.lastname
    FROM theory_answers ta
    INNER JOIN exam_questions eq ON ta.question_id = eq.question_id
    LEFT JOIN students s ON ta.student_id = s.student_id
    WHERE ta.exam_code = ? AND ta.school_id = ?
    ORDER BY (ta.status = 'pending') DESC, ta.submitted_at ASC
  `).all(req.params.exam_code, req.session.school_id);

  res.json(rows);
});

// POST /api/grading/mark
// Body: { answer_id, score, marker_comment }
router.post('/mark', (req, res) => {
  const { answer_id, score, marker_comment } = req.body;

  if (!answer_id || score === undefined || score === null) {
    return res.status(400).json({ success: false, message: 'answer_id and score are required' });
  }

  const answer = db.prepare('SELECT * FROM theory_answers WHERE answer_id = ? AND school_id = ?')
    .get(answer_id, req.session.school_id);
  if (!answer) return res.status(404).json({ success: false, message: 'Answer not found' });

  const numericScore = parseFloat(score);
  if (isNaN(numericScore) || numericScore < 0 || numericScore > answer.max_score) {
    return res.status(400).json({ success: false, message: `Score must be between 0 and ${answer.max_score}` });
  }

  db.prepare(`
    UPDATE theory_answers
    SET score = ?, marker_comment = ?, status = 'marked', marked_at = CURRENT_TIMESTAMP
    WHERE answer_id = ?
  `).run(numericScore, marker_comment || null, answer_id);

  res.json({ success: true });
});

module.exports = router;