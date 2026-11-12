// server/routes/exams.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);
// Read-only reference data for the Exam Builder's dropdowns — scoped to
// this license's school automatically.
router.get('/meta/subjects', (req, res) => {
  const rows = db.prepare('SELECT subject_id, subject_name FROM subjects WHERE school_id = ? ORDER BY subject_name').all(req.session.school_id);
  res.json(rows);
});

router.get('/meta/classes', (req, res) => {
  const rows = db.prepare('SELECT id, name FROM classes WHERE school_id = ? ORDER BY name').all(req.session.school_id);
  res.json(rows);
});

router.get('/meta/programs', (req, res) => {
  const rows = db.prepare('SELECT id, program_name FROM programs WHERE school_id = ? ORDER BY program_name').all(req.session.school_id);
  res.json(rows);
});

function generateLocalExamCode(schoolId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LOCAL-SCH${schoolId}-${t}-${random}`;
}
// CREATE — add a new exam
router.post('/', (req, res) => {
  const school_id = req.session.school_id;
 const {
  exam_title, exam_code, description, subject_id,
  class_id, program_id, total_marks, passing_marks,
  duration_minutes, start_time, end_time, created_by,
      published, questions_to_attempt, shuffle_questions, shuffle_options,
    anti_cheat_enabled, require_camera, ip_restriction
} = req.body;

  // Basic required-field check — mirrors your MySQL NOT NULL columns
  if (!exam_title || !subject_id || !total_marks ||
      !passing_marks || !duration_minutes || !start_time || !end_time || !created_by) {
    return res.status(400).json({ error: 'Missing required exam fields' });
  }

  const stmt = db.prepare(`
    INSERT INTO examinations
      (school_id, exam_title, exam_code, description, subject_id,
       class_id, program_id, total_marks, passing_marks,
       duration_minutes, start_time, end_time, created_by,
              published, questions_to_attempt, shuffle_questions, shuffle_options,
       anti_cheat_enabled, require_camera, ip_restriction)
    VALUES (@school_id, @exam_title, @exam_code, @description, @subject_id,
            @class_id, @program_id, @total_marks, @passing_marks,
            @duration_minutes, @start_time, @end_time, @created_by,
                        @published, @questions_to_attempt, @shuffle_questions, @shuffle_options,
            @anti_cheat_enabled, @require_camera, @ip_restriction)
  `);

  const info = stmt.run({
    school_id, exam_title,
        exam_code: exam_code || generateLocalExamCode(school_id),
    description: description || null,
    subject_id,
    class_id: class_id || null,
    program_id: program_id || null,
    total_marks, passing_marks, duration_minutes,
    start_time, end_time, created_by,
        published: published ? 1 : 0,
    anti_cheat_enabled: anti_cheat_enabled ? 1 : 0,
    require_camera: require_camera ? 1 : 0,
    ip_restriction: ip_restriction || null,
    questions_to_attempt: questions_to_attempt || null,
    shuffle_questions: shuffle_questions ? 1 : 0,
    shuffle_options: shuffle_options ? 1 : 0
  });

  const newExam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(newExam);
});

// READ — list all exams (optionally filter by school_id)
router.get('/', (req, res) => {
  const exams = db.prepare('SELECT * FROM examinations WHERE school_id = ?').all(req.session.school_id);
  res.json(exams);
});

// READ — get one exam by id
router.get('/:id', (req, res) => {
  const exam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json(exam);
});

// UPDATE — edit an exam
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM examinations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Exam not found' });

  const merged = { ...existing, ...req.body, updated_at: new Date().toISOString() };
    merged.published = req.body.published !== undefined ? (req.body.published ? 1 : 0) : existing.published;
  merged.anti_cheat_enabled = req.body.anti_cheat_enabled !== undefined ? (req.body.anti_cheat_enabled ? 1 : 0) : existing.anti_cheat_enabled;
  merged.require_camera = req.body.require_camera !== undefined ? (req.body.require_camera ? 1 : 0) : existing.require_camera;
  merged.ip_restriction = req.body.ip_restriction !== undefined ? (req.body.ip_restriction || null) : existing.ip_restriction;
  merged.shuffle_questions = req.body.shuffle_questions !== undefined ? (req.body.shuffle_questions ? 1 : 0) : existing.shuffle_questions;
  merged.shuffle_options = req.body.shuffle_options !== undefined ? (req.body.shuffle_options ? 1 : 0) : existing.shuffle_options;
  merged.questions_to_attempt = req.body.questions_to_attempt !== undefined ? req.body.questions_to_attempt : existing.questions_to_attempt;

  db.prepare(`
    UPDATE examinations SET
      exam_title = @exam_title, exam_code = @exam_code, description = @description,
      subject_id = @subject_id, class_id = @class_id, program_id = @program_id,
      total_marks = @total_marks, passing_marks = @passing_marks,
      duration_minutes = @duration_minutes, start_time = @start_time,
      end_time = @end_time, status = @status, updated_at = @updated_at,
            published = @published, questions_to_attempt = @questions_to_attempt,
      anti_cheat_enabled = @anti_cheat_enabled, require_camera = @require_camera, ip_restriction = @ip_restriction,
      shuffle_questions = @shuffle_questions, shuffle_options = @shuffle_options
    WHERE id = @id
  `).run(merged);

  const updated = db.prepare('SELECT * FROM examinations WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE — remove an exam
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM examinations WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Exam not found' });
  res.status(204).send();
});

module.exports = router;