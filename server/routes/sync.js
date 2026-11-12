const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

const CLOUD_BASE_URL = 'https://mariobee.com';
const UPLOAD_FOLDER = require('../paths').uploadsDir;
const BATCH_SIZE = 50;
const PUSH_TIMEOUT_MS = 90000;
const PUSH_CONNECT_RETRIES = 2;

// Mirrors PHP's downloadQuestionImages(): finds <img src="..."> tags in question
// text, downloads any not already saved locally, rewrites the text to point at
// our own server instead of the cloud.
async function downloadQuestionImages(text, skippedImages) {
  if (!text) return text;

  if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });
  }

  const imgTagRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const urls = [];
  let match;
  while ((match = imgTagRegex.exec(text)) !== null) {
    urls.push(match[1]);
  }

  let updatedText = text;

  for (const url of urls) {
    const filename = path.basename(url);
    const savePath = path.join(UPLOAD_FOLDER, filename);
    const localUrl = `/uploads/question_images/${filename}`;

    if (fs.existsSync(savePath)) {
      updatedText = updatedText.split(url).join(localUrl);
      continue;
    }

            const fullOnlineUrl = `${CLOUD_BASE_URL}/admin/upload_question_image/${filename}`;

       let response;
    try {
      response = await axios.get(fullOnlineUrl, { responseType: 'arraybuffer', timeout: 30000 });
    } catch (err) {
      // Missing/broken image on the cloud shouldn't block syncing the rest of the
   
      skippedImages.push({ filename, url, reason: err.response ? `HTTP ${err.response.status}` : err.message });
      continue;
    }

    fs.writeFileSync(savePath, response.data);
    updatedText = updatedText.split(url).join(localUrl);
  }

  return updatedText;
}

// POST /api/sync/pull-exam
// Body: { school_id, exam_code }
// Mirrors process_sync.php: fetch from cloud, download images, delete+replace
// local exam/passages/questions/options for this exam_code, in a transaction.
router.post('/pull-exam', async (req, res) => {
  const school_id = req.session.school_id;
  const { exam_code } = req.body;

  if (!exam_code) {
    return res.status(400).json({ status: 'error', message: 'exam_code is required' });
  }

  // STEP 1: Fetch from cloud
  let response;
  try {
    response = await axios.get(`${CLOUD_BASE_URL}/api/sync/fetch_exam.php`, {
      params: { school_id, exam_code },
      timeout: 60000
    });
  } catch (err) {
    const msg = err.response
      ? `Server returned HTTP ${err.response.status}`
      : `Connection failed: ${err.message}`;
    return res.status(502).json({ status: 'error', message: msg });
  }

  const body = response.data;
  if (!body || body.status !== 'success') {
    return res.status(502).json({ status: 'error', message: 'Failed to fetch cloud data' });
  }

  // STEP 2: Validate structure
  const { data } = body;
  if (!data || !data.exam || !data.passages || !data.questions || !data.options) {
    return res.status(502).json({ status: 'error', message: 'Incomplete data received from cloud' });
  }

  // STEP 3: Download images BEFORE touching the database — same order as PHP,
  // so a failed image download never leaves the DB half-updated.
  const skippedImages = [];
  for (const q of data.questions) {
    q.question_text = await downloadQuestionImages(q.question_text, skippedImages);
  }

  // STEP 4: Delete-and-replace transaction
  const runSync = db.transaction(() => {
    db.prepare(
      `DELETE FROM exam_question_options WHERE question_id IN (SELECT question_id FROM exam_questions WHERE exam_code = ?)`
    ).run(exam_code);
    db.prepare(`DELETE FROM exam_questions WHERE exam_code = ?`).run(exam_code);
    db.prepare(`DELETE FROM exam_passages WHERE exam_code = ?`).run(exam_code);
    db.prepare(`DELETE FROM examinations WHERE exam_code = ?`).run(exam_code);

    const e = data.exam;
    db.prepare(`
      INSERT INTO examinations
        (questions_to_attempt, school_id, exam_title, exam_code, description, subject_id, class_id, program_id,
         is_global, session_id, term_id, total_marks, passing_marks, duration_minutes, start_time, end_time,
         status, max_attempts, retake_policy, shuffle_questions, shuffle_options, require_camera, auto_grade,
         show_result, published, created_by, theory_duration, has_theory, theory_allowed_to_answer)
      VALUES
        (@questions_to_attempt, @school_id, @exam_title, @exam_code, @description, @subject_id, @class_id, @program_id,
         @is_global, @session_id, @term_id, @total_marks, @passing_marks, @duration_minutes, @start_time, @end_time,
         @status, @max_attempts, @retake_policy, @shuffle_questions, @shuffle_options, @require_camera, @auto_grade,
         @show_result, @published, @created_by, @theory_duration, @has_theory, @theory_allowed_to_answer)
    `).run(e);

    const insertPassage = db.prepare(`
      INSERT INTO exam_passages (school_id, passage_by, exam_code, passage_title, passage_text, passage_order, passage_id)
      VALUES (@school_id, @passage_by, @exam_code, @passage_title, @passage_text, @passage_order, @passage_id)
    `);
    for (const p of data.passages) insertPassage.run(p);

    const insertQuestion = db.prepare(`
      INSERT INTO exam_questions
        (question_id, school_id, exam_code, question_type, question_text, marks, correct_answer, explanation,
         difficulty_level, negative_marks, passage_id, answer_mode, model_answer, student_instructions,
         max_words, time_limit_minutes)
      VALUES
        (@question_id, @school_id, @exam_code, @question_type, @question_text, @marks, @correct_answer, @explanation,
         @difficulty_level, @negative_marks, @passage_id, @answer_mode, @model_answer, @student_instructions,
         @max_words, @time_limit_minutes)
    `);
    for (const q of data.questions) insertQuestion.run(q);

    const insertOption = db.prepare(`
      INSERT INTO exam_question_options (school_id, question_id, option_text, is_correct, option_id)
      VALUES (@school_id, @question_id, @option_text, @is_correct, @option_id)
    `);
    for (const o of data.options) insertOption.run(o);

    // Verify completeness, same check PHP does
    const count = db.prepare(`SELECT COUNT(*) AS c FROM exam_questions WHERE exam_code = ?`).get(exam_code).c;
    if (count !== data.questions.length) {
      throw new Error(`Sync incomplete: Expected ${data.questions.length} questions, but found ${count}`);
    }
  });

  try {
    runSync();
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }

 db.prepare(`
  INSERT INTO sync_logs
    (school_id, sync_type, direction, status, target, started_at, finished_at)
  VALUES
    (?, 'pull_exam', 'download', 'success', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).run(school_id, exam_code);

  res.json({
    status: 'success',
    message: 'Exam synced successfully',
    synced: {
      exam: data.exam.exam_title,
      passages: data.passages.length,
      questions: data.questions.length,
      options: data.options.length
    },
    skipped_images: skippedImages // empty array if everything downloaded fine
  });
});

// POST /api/sync/push-results
// Mirrors push_results.php: batch unsynced attempts + their answers + locked
// question sets, push to cloud, mark synced on success. Retries on failure.
router.post('/push-results', async (req, res) => {
  const attempts = db.prepare(`
    SELECT * FROM student_attempts
    WHERE is_synced = 0 AND status = 'Submitted'
    ORDER BY finished_at ASC
    LIMIT ?
  `).all(BATCH_SIZE);

  if (attempts.length === 0) {
    return res.json({ status: 'empty', message: 'Nothing to sync' });
  }

    const getAnswers = db.prepare(`
    SELECT sa.school_id, sa.answer_id, sa.exam_code, sa.student_id, sa.attempt_id, sa.question_id, 
           sa.submitted_at,
           COALESCE(o.option_text, sa.answer) AS answer
    FROM student_answers sa
    LEFT JOIN exam_question_options o ON sa.answer = o.option_id
    WHERE sa.attempt_id = ?
  `);
  const getAttemptQuestions = db.prepare(`
    SELECT attempt_question_id, attempt_id, exam_code, student_id, question_id, section, question_order, school_id, created_at
    FROM attempt_questions WHERE attempt_id = ?
  `);

  const payload = attempts.map(att => ({
    attempt: att,
    answers: getAnswers.all(att.attempt_id),
    attempt_questions: getAttemptQuestions.all(att.attempt_id)
  }));

  let result;
  let lastError = null;

  for (let attempt = 1; attempt <= PUSH_CONNECT_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `${CLOUD_BASE_URL}/api/sync/receive_results.php`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: PUSH_TIMEOUT_MS }
      );
      result = response.data;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < PUSH_CONNECT_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (lastError) {
    const msg = lastError.response
      ? `Server error: HTTP ${lastError.response.status}`
      : `Network error: ${lastError.message}`;
    return res.json({ status: 'error', message: msg });
  }

  if (!result || result.status !== 'success') {
    return res.json(result || { status: 'error', message: 'Invalid response from cloud' });
  }

  const markSynced = db.prepare(
    `UPDATE student_attempts SET is_synced = 1, synced_at = CURRENT_TIMESTAMP WHERE attempt_id = ?`
  );
  const markAllSynced = db.transaction((atts) => {
    for (const att of atts) markSynced.run(att.attempt_id);
  });
  markAllSynced(attempts);

  const remaining = db.prepare(`
    SELECT COUNT(*) AS c FROM student_attempts WHERE is_synced = 0 AND status = 'Submitted'
  `).get().c;

  db.prepare(`
  INSERT INTO sync_logs
    (school_id, sync_type, direction, status, target, records_synced, started_at, finished_at)
  VALUES
    (?, 'push_results', 'upload', 'success', 'batch', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).run(req.session.school_id, attempts.length);

  res.json({
    status: 'success',
    message: `${attempts.length} results synced`,
    synced_count: attempts.length,
    has_more: remaining > 0
  });
});

// GET /api/sync/cloud-exams?school_id=X
// Mirrors sync-exams.php's loadCloudExams(): calls fetch_exam.php with no
// exam_code, which returns a browsable list instead of full exam data.
router.get('/cloud-exams', async (req, res) => {
  const school_id = req.session.school_id;

  let response;
  try {
    response = await axios.get(`${CLOUD_BASE_URL}/api/sync/fetch_exam.php`, {
      params: { school_id },
      timeout: 30000
    });
  } catch (err) {
    const msg = err.response
      ? `Server returned HTTP ${err.response.status}`
      : `Connection failed: ${err.message}`;
    return res.status(502).json({ status: 'error', message: msg });
  }

  const body = response.data;

  if (!body || body.status !== 'list') {
    return res.status(502).json({ status: 'error', message: body?.message || 'Unexpected response from cloud' });
  }

  res.json({
    status: 'success',
    exams: body.data // [{ exam_code, exam_title, created_at }, ...]
  });
});

// POST /api/sync/pull-master-data
// Mirrors curl-api.php's post-activation sync block for these 4 types.
// (sessions/terms/branches/schools/school_settings intentionally not pulled
// yet — add when a screen actually needs them, same discipline as everything
// else we've built.)
router.post('/pull-master-data', async (req, res) => {
  const school_id = req.session.school_id;
  const results = {};

  // --- STUDENTS ---
  try {
    const response = await axios.get(`${CLOUD_BASE_URL}/api/sync/api.php`, {
      params: { school_id, type: 'students' }, timeout: 30000
    });
    const students = Array.isArray(response.data) ? response.data : [];

    const insertStudent = db.prepare(`
      INSERT INTO students
        (student_id, program_id, gender, registration_number, school_id, class_id,
         firstname, middlename, lastname, pass, role, branch_id, email, religion,
         state, nationality, image, joined)
      VALUES
        (@student_id, @program_id, @gender, @registration_number, @school_id, @class_id,
         @firstname, @middlename, @lastname, @pass, @role, @branch_id, @email, @religion,
         @state, @nationality, @image, @joined)
      ON CONFLICT(student_id) DO UPDATE SET
        program_id=excluded.program_id, gender=excluded.gender, class_id=excluded.class_id,
        firstname=excluded.firstname, middlename=excluded.middlename, lastname=excluded.lastname,
                pass=excluded.pass, role=excluded.role, branch_id=excluded.branch_id
      WHERE students.origin = 'cloud'
    `);

    const saveStudents = db.transaction((rows) => {
      for (const s of rows) {
        if (!s.student_id) continue;
        insertStudent.run({
          student_id: s.student_id,
          program_id: s.program_id || null,
          gender: s.gender || '',
          registration_number: s.registration_number || null,
          school_id: s.school_id || school_id,
          class_id: s.class_id || null,
          firstname: s.firstname || '',
          middlename: s.middlename || '',
          lastname: s.lastname || '',
          pass: s.pass,
          role: s.role || 'student',
          branch_id: s.branch_id || null,
          email: s.email || `${s.student_id}@syncbee.local`,
          religion: s.religion || 'N/A',
          state: s.state || 'N/A',
          nationality: s.nationality || 'N/A',
          image: s.image || 'default.png',
          joined: s.joined || new Date().toISOString().slice(0, 10)
        });
      }
    });
    saveStudents(students);
    results.students = students.length;
  } catch (err) {
    results.students = { error: err.message };
  }

  // --- SUBJECTS ---
  try {
    const response = await axios.get(`${CLOUD_BASE_URL}/api/sync/api.php`, {
      params: { school_id, type: 'subjects' }, timeout: 30000
    });
    const subjects = Array.isArray(response.data) ? response.data : [];

    const insertSubject = db.prepare(`
      INSERT INTO subjects (subject_id, subject_code, subject_type, school_id, branch_id, subject_name)
      VALUES (@subject_id, @subject_code, @subject_type, @school_id, @branch_id, @subject_name)
      ON CONFLICT(subject_id) DO UPDATE SET
        subject_code=excluded.subject_code, subject_type=excluded.subject_type,
        branch_id=excluded.branch_id, subject_name=excluded.subject_name
    `);

    const saveSubjects = db.transaction((rows) => {
      for (const s of rows) {
        if (!s.subject_id) continue;
        insertSubject.run({
          subject_id: s.subject_id, subject_code: s.subject_code || null,
          subject_type: s.subject_type || null, school_id: s.school_id || school_id,
          branch_id: s.branch_id || null, subject_name: s.subject_name
        });
      }
    });
    saveSubjects(subjects);
    results.subjects = subjects.length;
  } catch (err) {
    results.subjects = { error: err.message };
  }

  // --- CLASSES ---
  try {
    const response = await axios.get(`${CLOUD_BASE_URL}/api/sync/api.php`, {
      params: { school_id, type: 'classes' }, timeout: 30000
    });
    const classes = Array.isArray(response.data) ? response.data : [];

    const insertClass = db.prepare(`
      INSERT INTO classes (id, school_id, class_teacher_id, name, compartment, create_date, class_type, branch_id)
      VALUES (@id, @school_id, @class_teacher_id, @name, @compartment, @create_date, @class_type, @branch_id)
      ON CONFLICT(id) DO UPDATE SET
        class_teacher_id=excluded.class_teacher_id, name=excluded.name, compartment=excluded.compartment,
        create_date=excluded.create_date, class_type=excluded.class_type, branch_id=excluded.branch_id
    `);

    const saveClasses = db.transaction((rows) => {
      for (const c of rows) {
        const id = parseInt(c.id, 10);
        if (!id) continue;
        insertClass.run({
          id, school_id: c.school_id || school_id, class_teacher_id: c.class_teacher_id || '',
          name: c.name, compartment: c.compartment || '', create_date: c.create_date || null,
          class_type: c.class_type || '', branch_id: c.branch_id || null
        });
      }
    });
    saveClasses(classes);
    results.classes = classes.length;
  } catch (err) {
    results.classes = { error: err.message };
  }

  // --- PROGRAMS ---
  try {
    const response = await axios.get(`${CLOUD_BASE_URL}/api/sync/api.php`, {
      params: { school_id, type: 'programs' }, timeout: 30000
    });
    const programs = Array.isArray(response.data) ? response.data : [];

    const insertProgram = db.prepare(`
      INSERT INTO programs (id, school_id, program_name, program_code, branch_id)
      VALUES (@id, @school_id, @program_name, @program_code, @branch_id)
      ON CONFLICT(id) DO UPDATE SET
        program_name=excluded.program_name, program_code=excluded.program_code, branch_id=excluded.branch_id
    `);

    const savePrograms = db.transaction((rows) => {
      for (const p of rows) {
        const id = parseInt(p.id, 10);
        if (!id) continue;
        insertProgram.run({
          id, school_id: p.school_id || school_id, program_name: p.program_name,
          program_code: p.program_code || null, branch_id: p.branch_id || null
        });
      }
    });
    savePrograms(programs);
    results.programs = programs.length;
  } catch (err) {
    results.programs = { error: err.message };
  }

  res.json({ status: 'success', synced: results });
});

module.exports = router;