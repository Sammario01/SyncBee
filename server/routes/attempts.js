// server/routes/attempts.js
// server/routes/attempts.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../../db/database');
const { requireStudentSession } = require('./auth');
const features = require('../features');
// Every route below requires a logged-in student. Before this, student_id and
// school_id were trusted straight from the request body — meaning anyone on
// the network could act as any student just by naming a different ID. Now
// identity comes from the server-side session established at login, and can't
// be spoofed by the client.
router.use(requireStudentSession);

// Mirrors PHP's generateAttemptId($user_id):
// base_convert(floor(microtime(true)*1000), 10, 36), padded to 10 chars, + random hex suffix
function generateAttemptId(studentId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `A-SCH${studentId}-${t}-${random}`;
}

// POST /api/attempts/start
// Body: { school_id, student_id, exam_code, exam_id, section }
router.post('/start', (req, res) => {
  const student_id = req.session.student_id;
  const school_id = req.session.school_id;
  const { exam_code, exam_id, section: rawSection } = req.body;
  const section = ['A', 'B'].includes(rawSection) ? rawSection : 'A';

  if (!exam_code || !exam_id) {
    return res.status(400).json({ error: 'exam_code and exam_id are required' });
  }

  // Check for an existing "In Progress" attempt — mirrors PHP's resume behavior
  const existing = db.prepare(`
    SELECT attempt_id FROM student_attempts
    WHERE student_id = ? AND exam_code = ? AND section = ? AND status = 'In Progress'
    ORDER BY id DESC LIMIT 1
  `).get(student_id, exam_code, section);

  if (existing) {
    return res.json({ attempt_id: existing.attempt_id, exam_code, section, resumed: true });
  }

  // Get next attempt_number
  const row = db.prepare(`
    SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
    FROM student_attempts
    WHERE student_id = ? AND exam_code = ? AND section = ?
  `).get(student_id, exam_code, section);

  const nextAttempt = row.last_attempt + 1;
  const attemptId = generateAttemptId(student_id);

  db.prepare(`
    INSERT INTO student_attempts
      (school_id, attempt_id, student_id, exam_code, exam_id, section, attempt_number, status, started_at)
    VALUES (@school_id, @attempt_id, @student_id, @exam_code, @exam_id, @section, @attempt_number, 'In Progress', CURRENT_TIMESTAMP)
  `).run({
    school_id, attempt_id: attemptId, student_id, exam_code, exam_id, section,
    attempt_number: nextAttempt
  });

  res.status(201).json({ attempt_id: attemptId, exam_code, section, resumed: false });
});

// GET /api/attempts/:attempt_id — fetch one attempt's status
// GET /api/attempts/:attempt_id — fetch one attempt's status
router.get('/:attempt_id', (req, res) => {
  const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ?').get(req.params.attempt_id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  if (attempt.student_id !== req.session.student_id) {
    return res.status(403).json({ error: 'This attempt does not belong to you.' });
  }
  res.json(attempt);
});


// Mirrors PHP's generateAnswerQuestionId($user_id): same format as attempt IDs, "AQ-" prefix
function generateAttemptQuestionId(userId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AQ-SCH${userId}-${t}-${random}`;
}

// Fisher-Yates shuffle — JS has no built-in shuffle, PHP's shuffle() does this internally
function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Mirrors PHP's calculateWordCount(): strip HTML tags, collapse whitespace, count words
// Mirrors PHP's calculateWordCount(): strip HTML tags, collapse whitespace, count words
function calculateWordCount(html) {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  // Mirrors PHP's str_word_count(): counts alphabetic word sequences only
  // (letters, with internal apostrophes/hyphens allowed) — standalone numbers
  // or symbols are NOT counted as words, same as PHP's default behavior.
  const matches = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g);
  return matches ? matches.length : 0;
}
// GET /api/attempts/:attempt_id/load-exam?section=A
// Mirrors load_exam.php's OBJECTIVE-section lock-on-first-load behavior.
// (Section B / THEORY intentionally left out of this step — separate task.)
// Mirrors PHP's date('d M Y h:i A', ...) formatting for availability error messages
function formatExamDateTime(sqlDateTime) {
  const d = new Date(String(sqlDateTime).replace(' ', 'T'));
  if (isNaN(d.getTime())) return sqlDateTime;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

// Mirrors PHP's date('Y-m-d H:i:s') — used for string comparison against start_time/end_time
function nowSqlString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logAnswerChange(attemptId, studentId, questionId, oldValue, newValue) {
  if ((oldValue ?? null) === (newValue ?? null)) return; // genuinely unchanged — don't spam the log
  db.prepare(`
    INSERT INTO answer_audit_log (attempt_id, student_id, question_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(attemptId, studentId, questionId, oldValue ?? null, newValue ?? null);
}

// GET /api/attempts/:attempt_id/load-exam?section=A
// Mirrors load_exam.php's OBJECTIVE-section lock-on-first-load behavior.
// (Section B / THEORY intentionally left out of this step — separate task.)
router.get('/:attempt_id/load-exam', (req, res) => {
  const { attempt_id } = req.params;
  const section = (req.query.section === 'B') ? 'B' : 'A';

  const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ?').get(attempt_id);
  if (!attempt) {
    return res.status(404).json({ error: 'Invalid attempt. Please start the exam again.', code: 'INVALID_ATTEMPT' });
  }
  if (attempt.student_id !== req.session.student_id) {
    return res.status(403).json({ error: 'This attempt does not belong to you.' });
  }
  if (section === 'A' && attempt.status === 'Submitted') {
    return res.status(400).json({ error: 'This attempt has already been submitted.', code: 'ALREADY_SUBMITTED' });
  }

  const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ? AND school_id = ?')
    .get(attempt.exam_code, attempt.school_id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found.', code: 'EXAM_NOT_FOUND' });
  }

  let effectiveAntiCheat = exam.anti_cheat_enabled;
  if (attempt.bundle_attempt_id) {
    const bundleRow = db.prepare(`
      SELECT eb.anti_cheat_enabled FROM student_bundle_attempts sba
      INNER JOIN exam_bundles eb ON sba.bundle_code = eb.bundle_code
      WHERE sba.bundle_attempt_id = ?
    `).get(attempt.bundle_attempt_id);
    if (bundleRow) effectiveAntiCheat = bundleRow.anti_cheat_enabled;
  }

  if (!attempt.bundle_attempt_id) {
    if (exam.published !== 1) {
      return res.status(400).json({ error: 'This exam is not published yet.', code: 'NOT_PUBLISHED' });
    }
    const nowStr = nowSqlString();
    if (nowStr < exam.start_time) {
      return res.status(400).json({
        error: `Exam has not started yet. Start time: ${formatExamDateTime(exam.start_time)}`,
        code: 'NOT_STARTED'
      });
    }
    if (nowStr > exam.end_time) {
      return res.status(400).json({
        error: `Exam has ended. End time: ${formatExamDateTime(exam.end_time)}`,
        code: 'ENDED'
      });
    }
  }

  let questions;

  if (section === 'A') {
    const lockedCount = db.prepare(
      `SELECT COUNT(*) AS count FROM attempt_questions WHERE attempt_id = ? AND section = 'A'`
    ).get(attempt_id).count;

    if (lockedCount > 0) {
      questions = db.prepare(`
        SELECT eq.question_id, eq.question_text, eq.question_type, eq.marks, eq.passage_id, aq.question_order,
               eq.image_url, eq.image_width_pct, eq.image_align
        FROM attempt_questions aq
        INNER JOIN exam_questions eq ON aq.question_id = eq.question_id
        WHERE aq.attempt_id = ? AND aq.section = 'A'
        ORDER BY aq.question_order ASC
      `).all(attempt_id);
    } else {
      let allQuestions = db.prepare(`
        SELECT question_id, question_text, question_type, marks, passage_id,
               image_url, image_width_pct, image_align
        FROM exam_questions
        WHERE exam_code = ? AND question_type IN ('MCQ_SINGLE', 'TRUE_FALSE')
        ORDER BY id ASC
      `).all(attempt.exam_code);

      if (allQuestions.length === 0) {
        return res.status(404).json({ error: 'No objective questions found for this exam.', code: 'NO_QUESTIONS' });
      }

      if (exam.shuffle_questions === 1 && allQuestions.length > 1) {
        allQuestions = shuffleArray(allQuestions);
      }

      const questionsToAttempt = exam.questions_to_attempt && exam.questions_to_attempt > 0
        ? exam.questions_to_attempt
        : allQuestions.length;

      if (questionsToAttempt < allQuestions.length) {
        allQuestions = allQuestions.slice(0, questionsToAttempt);
      }

      const insertLock = db.prepare(`
        INSERT INTO attempt_questions
          (section, school_id, attempt_question_id, attempt_id, exam_code, student_id, question_id, question_order)
        VALUES ('A', @school_id, @attempt_question_id, @attempt_id, @exam_code, @student_id, @question_id, @question_order)
      `);

      const lockAll = db.transaction((qs) => {
        qs.forEach((q, index) => {
          insertLock.run({
            school_id: attempt.school_id,
            attempt_question_id: generateAttemptQuestionId(attempt.student_id),
            attempt_id,
            exam_code: attempt.exam_code,
            student_id: attempt.student_id,
            question_id: q.question_id,
            question_order: index + 1
          });
        });
      });
      lockAll(allQuestions);

      questions = allQuestions;
    }
  } else {
    const lockedCount = db.prepare(
      `SELECT COUNT(*) AS count FROM attempt_questions WHERE attempt_id = ? AND section = 'B'`
    ).get(attempt_id).count;

    if (lockedCount > 0) {
      questions = db.prepare(`
        SELECT eq.question_id, eq.student_instructions, eq.question_text, eq.question_type,
               eq.marks, eq.passage_id, eq.answer_mode, eq.max_words, eq.time_limit_minutes, aq.question_order,
               eq.image_url, eq.image_width_pct, eq.image_align
        FROM attempt_questions aq
        INNER JOIN exam_questions eq ON aq.question_id = eq.question_id
        WHERE aq.attempt_id = ? AND aq.section = 'B'
        ORDER BY aq.question_order ASC
      `).all(attempt_id);
    } else {
      questions = db.prepare(`
        SELECT question_id, student_instructions, question_text, question_type, marks, passage_id,
               answer_mode, max_words, time_limit_minutes,
               image_url, image_width_pct, image_align
        FROM exam_questions
        WHERE exam_code = ? AND question_type = 'THEORY'
          AND (answer_mode IN ('screen_to_paper', 'screen_to_screen') OR answer_mode IS NULL)
        ORDER BY id ASC
      `).all(attempt.exam_code);

      if (questions.length === 0) {
        return res.status(404).json({ error: 'No theory questions found for this exam.', code: 'NO_QUESTIONS' });
      }

      const insertLock = db.prepare(`
        INSERT INTO attempt_questions
          (section, school_id, attempt_question_id, attempt_id, exam_code, student_id, question_id, question_order)
        VALUES ('B', @school_id, @attempt_question_id, @attempt_id, @exam_code, @student_id, @question_id, @question_order)
      `);

      const lockAll = db.transaction((qs) => {
        qs.forEach((q, index) => {
          insertLock.run({
            school_id: attempt.school_id,
            attempt_question_id: generateAttemptQuestionId(attempt.student_id),
            attempt_id,
            exam_code: attempt.exam_code,
            student_id: attempt.student_id,
            question_id: q.question_id,
            question_order: index + 1
          });
        });
      });
      lockAll(questions);
    }
  }

  const withOptionsAndPassage = questions.map(q => {
    let options = [];

    if (section === 'A') {
      options = db.prepare(
        'SELECT option_id AS id, option_text, image_url, image_width_pct, image_align FROM exam_question_options WHERE question_id = ? ORDER BY id ASC'
      ).all(q.question_id);

      if (exam.shuffle_options === 1 && options.length > 1) {
        options = shuffleArray(options);
      }
    }

    const passage = q.passage_id
      ? db.prepare('SELECT passage_title AS title, passage_text FROM exam_passages WHERE passage_id = ?').get(q.passage_id)
      : null;

    let saved_answer = null;
    if (section === 'A') {
      const row = db.prepare('SELECT answer FROM student_answers WHERE attempt_id = ? AND question_id = ?').get(attempt_id, q.question_id);
      if (row) saved_answer = row.answer;
    } else {
      const row = db.prepare('SELECT answer_text FROM theory_answers WHERE attempt_id = ? AND question_id = ?').get(attempt_id, q.question_id);
      if (row) saved_answer = row.answer_text;
    }

    const { passage_id, image_url, image_width_pct, image_align, ...rest } = q;
    return {
      ...rest,
      question_image: image_url ? { url: image_url, width_pct: image_width_pct, align: image_align } : null,
      options: options.map(o => {
        const { image_url: ou, image_width_pct: ow, image_align: oa, ...optRest } = o;
        return {
          ...optRest,
          image: ou ? { url: ou, width_pct: ow, align: oa } : null
        };
      }),
      passage,
      saved_answer
    };
  });

  res.json({
    success: true,
    exam: {
      exam_title: exam.exam_title,
      exam_code: exam.exam_code,
      description: exam.description,
      duration_minutes: exam.duration_minutes,
      theory_allowed_to_answer: exam.theory_allowed_to_answer,
      theory_duration: exam.theory_duration,
      theory_format: exam.theory_format,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      start_time: exam.start_time,
      end_time: exam.end_time,
      anti_cheat_enabled: effectiveAntiCheat
    },
    questions: withOptionsAndPassage,
    student_id: attempt.student_id,
    attempt_id,
    total_questions: withOptionsAndPassage.length,
    features: features.forCandidates(),
    section,
    locked: true
  });
});

// Mirrors PHP's generateAnswerId($user_id) — note: same "A-SCH" prefix format as attempt IDs.
// This matches the original PHP behavior exactly (not something we're introducing).
function generateAnswerId(userId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `A-SCH${userId}-${t}-${random}`;
}

// POST /api/attempts/:attempt_id/save-answers
// Body: { exam_code, section: 'A', answers: { "Q001": "OPT002", ... } }
// Mirrors save_answers.php's Section A (objective) branch.
// POST /api/attempts/:attempt_id/save-answers
// Body: { exam_code, section: 'A' | 'B', answers: {...}, answer_mode }
// Section A → objective answers (MCQ / TRUE_FALSE)
// Section B → theory answers (screen_to_screen / screen_to_paper)
router.post('/:attempt_id/save-answers', (req, res) => {
  const { attempt_id } = req.params;
    const { exam_code, section: rawSection, answers: rawAnswers, answer_mode, submission_reason } = req.body;
  const reason = ['timeout', 'anti_cheat', 'admin_force_submit'].includes(submission_reason) ? submission_reason : 'student_manual';
  const section = (rawSection === 'B') ? 'B' : 'A';

  if (!exam_code) {
    return res.status(400).json({ success: false, message: 'Missing exam code' });
  }

   const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ?').get(attempt_id);
  if (!attempt) {
    return res.status(404).json({ success: false, message: 'Attempt not found' });
  }
  if (attempt.student_id !== req.session.student_id) {
    return res.status(403).json({ success: false, message: 'This attempt does not belong to you.' });
  }


  // ============================================================
  // SECTION A — OBJECTIVE
  // ============================================================
  if (section === 'A') {
    // Fetch the locked question set for this attempt — same validation PHP does
    const lockedRows = db.prepare(
      `SELECT question_id FROM attempt_questions WHERE attempt_id = ? AND student_id = ? AND exam_code = ? AND section = 'A'`
    ).all(attempt_id, attempt.student_id, exam_code);

    const lockedIds = lockedRows.map(r => r.question_id);

    if (lockedIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No locked questions found for this attempt. Please reload the exam.' });
    }

    // Filter incoming answers to only locked questions — silently reject the rest, matching PHP
    const filteredAnswers = {};
    for (const [questionId, answer] of Object.entries(rawAnswers || {})) {
      if (lockedIds.includes(questionId)) {
        filteredAnswers[questionId] = answer;
      }
    }

    if (Object.keys(filteredAnswers).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid answers to save. All answers were rejected.' });
    }

       const checkExisting = db.prepare(
      `SELECT answer_id, answer FROM student_answers WHERE student_id = ? AND exam_code = ? AND attempt_id = ? AND question_id = ?`
    );
    const updateAnswer = db.prepare(`UPDATE student_answers SET answer = ? WHERE answer_id = ?`);
    const insertAnswer = db.prepare(`
      INSERT INTO student_answers (school_id, answer_id, student_id, exam_code, attempt_id, exam_id, question_id, answer)
      VALUES (@school_id, @answer_id, @student_id, @exam_code, @attempt_id, @exam_id, @question_id, @answer)
    `);

    const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ?').get(exam_code);

    const saveAll = db.transaction((answersToSave) => {
      for (const [questionId, answer] of Object.entries(answersToSave)) {
                const existing = checkExisting.get(attempt.student_id, exam_code, attempt_id, questionId);
        logAnswerChange(attempt_id, attempt.student_id, questionId, existing ? existing.answer : null, answer);
        if (existing) {
          updateAnswer.run(answer, existing.answer_id);
        } else {
          insertAnswer.run({
            school_id: attempt.school_id,
            answer_id: generateAnswerId(attempt.student_id),
            student_id: attempt.student_id,
            exam_code,
            attempt_id,
            exam_id: attempt.exam_id,
            question_id: questionId,
            answer
          });
        }
      }

          // Compute score — sum the marks of each question the student answered
      // correctly. A question is "correct" when the student's stored answer
      // (an option_id) matches the option flagged is_correct=1 for that
      // question. Do NOT compare against exam_questions.correct_answer —
      // that column holds option TEXT, not option IDs, so it never matches.
      const scoreRow = db.prepare(`
        SELECT COALESCE(SUM(eq.marks), 0) AS total_score
        FROM student_answers sa
        INNER JOIN exam_questions eq
          ON eq.question_id = sa.question_id
        INNER JOIN exam_question_options opt
          ON opt.question_id = sa.question_id
         AND opt.option_id = sa.answer
         AND opt.is_correct = 1
        WHERE sa.exam_code = ?
          AND sa.student_id = ?
          AND sa.attempt_id = ?
          AND eq.question_type IN ('MCQ_SINGLE', 'TRUE_FALSE')
      `).get(exam_code, attempt.student_id, attempt_id);

      const score = scoreRow.total_score;

            db.prepare(`
        UPDATE student_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP, score = ?, submission_reason = ?
        WHERE attempt_id = ? AND student_id = ? AND exam_code = ?
      `).run(score, reason, attempt_id, attempt.student_id, exam_code);

      return score;
    });

    let computedScore;
    try {
      computedScore = saveAll(filteredAnswers);
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }

    const response = {
      success: true,
      message: 'Answers submitted successfully',
      saved_count: Object.keys(filteredAnswers).length
    };

    if (exam && exam.show_result === 'Immediately') {
      response.score = computedScore;
      response.total_marks = exam.total_marks;
    } else if (exam && exam.show_result === 'Never') {
      response.result_message = 'Results for this exam are not shown to students.';
    } else {
      response.result_message = 'Your result will be available once published by your school.';
    }

    return res.json(response);
  }

  // ============================================================
  // SECTION B — THEORY
  // ============================================================
  else {
    const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ?').get(exam_code);
    let answers = rawAnswers || {};

    if (answer_mode === 'screen_to_paper') {
      // Ignore any answer text the client sent — screen_to_paper only tracks WHICH
      // questions were assigned, not their content (student writes on physical paper)
      const assignedRows = db.prepare(
        `SELECT question_id FROM attempt_questions WHERE attempt_id = ? AND student_id = ? AND exam_code = ? AND section = 'B'`
      ).all(attempt_id, attempt.student_id, exam_code);

      if (assignedRows.length === 0) {
        return res.status(400).json({ success: false, message: 'No assigned questions found for this screen-to-paper attempt.' });
      }

      answers = {};
      assignedRows.forEach(r => { answers[r.question_id] = ''; });
    }

    const answeredQuestionIds = Object.keys(answers);
    if (answeredQuestionIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No theory answers provided.' });
    }

    const getMaxScore = db.prepare('SELECT marks FROM exam_questions WHERE question_id = ?');
       const checkExistingTheory = db.prepare(
      `SELECT answer_id, answer_text FROM theory_answers WHERE student_id = ? AND exam_code = ? AND attempt_id = ? AND question_id = ?`
    );
    const updateTheory = db.prepare(
      `UPDATE theory_answers SET answer_text = ?, word_count = ?, submitted_at = ? WHERE answer_id = ?`
    );
    const insertTheory = db.prepare(`
      INSERT INTO theory_answers
        (school_id, exam_code, student_id, question_id, answer_id, attempt_id, answer_text, word_count, max_score, status, submitted_at)
      VALUES (@school_id, @exam_code, @student_id, @question_id, @answer_id, @attempt_id, @answer_text, @word_count, @max_score, 'pending', @submitted_at)
    `);

    const saveTheory = db.transaction((answersToSave) => {
      const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

      for (const [questionId, answerValue] of Object.entries(answersToSave)) {
        const maxScoreRow = getMaxScore.get(questionId);
        const maxScore = maxScoreRow ? maxScoreRow.marks : 0;

        let answerText = null;
        let wordCount = 0;

        if (answer_mode === 'screen_to_screen') {
          answerText = answerValue;
          wordCount = calculateWordCount(answerValue);
        } else if (answer_mode === 'screen_to_paper') {
          answerText = '';
          wordCount = 0;
        }

                const existing = checkExistingTheory.get(attempt.student_id, exam_code, attempt_id, questionId);
        logAnswerChange(attempt_id, attempt.student_id, questionId, existing ? existing.answer_text : null, answerText);
        if (existing) {
          updateTheory.run(answerText, wordCount, nowIso, existing.answer_id);
        } else {
          insertTheory.run({
            school_id: attempt.school_id,
            exam_code,
            student_id: attempt.student_id,
            question_id: questionId,
            answer_id: generateAnswerId(attempt.student_id),
            attempt_id,
            answer_text: answerText,
            word_count: wordCount,
            max_score: maxScore,
            submitted_at: nowIso
          });
        }
      }

      db.prepare(
        `UPDATE student_attempts SET status = 'Submitted', finished_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND student_id = ? AND exam_code = ?`
      ).run(attempt_id, attempt.student_id, exam_code);
    });

    try {
      saveTheory(answers);
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }

      return res.json({
      success: true,
      message: answer_mode === 'screen_to_paper'
        ? 'Section B (Theory - Paper) completed! Please submit your answer sheet to your teacher.'
        : 'Your Section B (Theory) has been submitted successfully! Your answers will be reviewed by your teacher.',
      saved_count: answeredQuestionIds.length
    });
  }
});

// POST /api/attempts/:attempt_id/heartbeat
// Body: { answered }
// Mirrors heartbeat.php — updates last_activity + questions_answered so the exam
// stays "live" for proctoring/sync purposes. PHP trusts any attempt_id blindly;
router.post('/:attempt_id/heartbeat', (req, res) => {
  const { attempt_id } = req.params;
  const answered = parseInt(req.body.answered, 10) || 0;
  const currentQuestion = parseInt(req.body.current_question, 10) || 0;

  const attempt = db.prepare('SELECT attempt_id, student_id FROM student_attempts WHERE attempt_id = ?').get(attempt_id);
  if (!attempt) {
    return res.status(404).json({ status: 'error', message: 'Attempt not found' });
  }
  if (attempt.student_id !== req.session.student_id) {
    return res.status(403).json({ status: 'error', message: 'This attempt does not belong to you.' });
  }

  db.prepare(`
    UPDATE student_attempts
    SET last_activity = CURRENT_TIMESTAMP,
        questions_answered = ?,
        current_question_index = ?
    WHERE attempt_id = ? AND status = 'In Progress'
  `).run(answered, currentQuestion, attempt_id);

  res.json({ status: 'ok', message: 'Updated' });
});

// POST /api/attempts/:attempt_id/incidents
// Body: { incident_type, details }
// Mirrors log_incident.php — records anti-cheat events (e.g. tab_switch strikes,
// focus loss). Strike-counting / auto-submit-on-3-strikes is client-side logic
// (currently only in objective_exam_page.php's JS) — not implemented here.
router.post('/:attempt_id/incidents', (req, res) => {
  const { attempt_id } = req.params;
  const { incident_type, details } = req.body;

  if (!incident_type) {
    return res.status(400).json({ status: 'error', message: 'incident_type is required' });
  }

    const attempt = db.prepare('SELECT attempt_id, student_id FROM student_attempts WHERE attempt_id = ?').get(attempt_id);
  if (!attempt) {
    return res.status(404).json({ status: 'error', message: 'Attempt not found' });
  }
  if (attempt.student_id !== req.session.student_id) {
    return res.status(403).json({ status: 'error', message: 'This attempt does not belong to you.' });
  }

  db.prepare(`
    INSERT INTO exam_incidents (attempt_id, incident_type, details)
    VALUES (?, ?, ?)
  `).run(attempt_id, incident_type, details || '');

  res.json({ status: 'success', message: 'Incident logged' });
});


// POST /api/attempts/:attempt_id/autosave
// Body: { exam_code, section, answers, answer_mode }
// Continuously persists DRAFT answers — never touches status or score.
// This is what makes answers survive a power cut or app crash before a real
// Submit happens, and is what lets tab-switching in free bundle mode stay silent.
router.post('/:attempt_id/autosave', (req, res) => {
  const { attempt_id } = req.params;
  const { exam_code, section: rawSection, answers, answer_mode } = req.body;
  const section = rawSection === 'B' ? 'B' : 'A';

  const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ?').get(attempt_id);
  if (!attempt) return res.status(404).json({ success: false });
  if (attempt.student_id !== req.session.student_id) return res.status(403).json({ success: false });
  if (attempt.status === 'Submitted') return res.json({ success: true }); // nothing to draft anymore

  if (section === 'A') {
    const lockedRows = db.prepare(
      `SELECT question_id FROM attempt_questions WHERE attempt_id = ? AND section = 'A'`
    ).all(attempt_id);
    const lockedIds = lockedRows.map(r => r.question_id);

    const checkExisting = db.prepare(`SELECT answer_id, answer FROM student_answers WHERE attempt_id = ? AND question_id = ?`);    const updateAnswer = db.prepare(`UPDATE student_answers SET answer = ? WHERE answer_id = ?`);
    const insertAnswer = db.prepare(`
      INSERT INTO student_answers (school_id, answer_id, student_id, exam_code, attempt_id, exam_id, question_id, answer)
      VALUES (@school_id, @answer_id, @student_id, @exam_code, @attempt_id, @exam_id, @question_id, @answer)
    `);
    const crypto = require('crypto');

    const saveAll = db.transaction(() => {
      for (const [questionId, answer] of Object.entries(answers || {})) {
        if (!lockedIds.includes(questionId)) continue;
                const existing = checkExisting.get(attempt_id, questionId);
        logAnswerChange(attempt_id, attempt.student_id, questionId, existing ? existing.answer : null, answer);
        if (existing) {
          updateAnswer.run(answer, existing.answer_id);
        } else {
          const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
          const random = crypto.randomBytes(3).toString('hex').toUpperCase();
          insertAnswer.run({
            school_id: attempt.school_id, answer_id: `A-SCH${attempt.student_id}-${t}-${random}`,
            student_id: attempt.student_id, exam_code, attempt_id, exam_id: attempt.exam_id,
            question_id: questionId, answer
          });
        }
      }
    });
    saveAll();
  } else {
    const checkExisting = db.prepare(`SELECT answer_id, answer_text FROM theory_answers WHERE attempt_id = ? AND question_id = ?`);    const updateAnswer = db.prepare(`UPDATE theory_answers SET answer_text = ?, word_count = ? WHERE answer_id = ?`);
    const insertAnswer = db.prepare(`
      INSERT INTO theory_answers (school_id, exam_code, student_id, question_id, answer_id, attempt_id, answer_text, word_count, max_score, status)
      VALUES (@school_id, @exam_code, @student_id, @question_id, @answer_id, @attempt_id, @answer_text, @word_count, @max_score, 'pending')
    `);
    const getMaxScore = db.prepare('SELECT marks FROM exam_questions WHERE question_id = ?');
    const crypto = require('crypto');

    const saveAll = db.transaction(() => {
      for (const [questionId, answerValue] of Object.entries(answers || {})) {
        if (answer_mode !== 'screen_to_screen') continue; // paper mode has nothing to autosave
        const wordCount = (answerValue || '').trim().split(/\s+/).filter(Boolean).length;
                const existing = checkExisting.get(attempt_id, questionId);
        logAnswerChange(attempt_id, attempt.student_id, questionId, existing ? existing.answer_text : null, answerValue);
        if (existing) {
          updateAnswer.run(answerValue, wordCount, existing.answer_id);
        } else {
          const maxScoreRow = getMaxScore.get(questionId);
          const t = Math.floor(Date.now()).toString(36).toUpperCase().padStart(10, '0');
          const random = crypto.randomBytes(3).toString('hex').toUpperCase();
          insertAnswer.run({
            school_id: attempt.school_id, exam_code, student_id: attempt.student_id, question_id: questionId,
            answer_id: `A-SCH${attempt.student_id}-${t}-${random}`, attempt_id,
            answer_text: answerValue, word_count: wordCount, max_score: maxScoreRow ? maxScoreRow.marks : 0
          });
        }
      }
    });
    saveAll();
  }

  res.json({ success: true });
});

// POST /api/attempts/:attempt_id/events — Exam Replay event stream from the exam page.
// Batched, idempotent (event_uid), and clock-corrected.
const REPLAY_EVENT_TYPES = new Set([
  'page_loaded', 'question_opened', 'answer_selected', 'answer_changed', 'answer_cleared',
  'fullscreen_entered', 'fullscreen_lost', 'fullscreen_restored',
  'tab_hidden', 'tab_visible', 'connection_lost', 'connection_restored',
  'screen_locked', 'screen_unlocked', 'admin_message', 'force_submit_notice'
]);

router.post('/:attempt_id/events', (req, res) => {
    if (!features.isEnabled('replay_recording')) return res.json({ success: true, saved: 0, disabled: true });
  const attempt = db.prepare(
    'SELECT attempt_id, student_id, school_id, bundle_attempt_id FROM student_attempts WHERE attempt_id = ?'
  ).get(req.params.attempt_id);
  if (!attempt) return res.status(404).json({ success: false });
  if (attempt.student_id !== req.session.student_id) return res.status(403).json({ success: false });

  const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 200) : [];
  const now = Date.now();
  const sentAt = Number(req.body.sent_at);
  // How far this computer's clock is from ours; applied to every event in the batch.
  const offset = Number.isFinite(sentAt) ? now - sentAt : 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO exam_events
      (attempt_id, bundle_attempt_id, student_id, school_id, event_uid, event_type, question_id, data, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const saveAll = db.transaction((list) => {
    let saved = 0;
    for (const e of list) {
      if (!e || typeof e.uid !== 'string' || e.uid.length > 64 || !REPLAY_EVENT_TYPES.has(e.type)) continue;

      let occurred = Number.isFinite(Number(e.ts)) ? Number(e.ts) + offset : now;
      if (occurred > now + 5000) occurred = now;                       // never in the future
      if (Math.abs(occurred - now) > 7 * 24 * 3600 * 1000) occurred = now; // nor absurdly old

      let data = null;
      if (e.data !== undefined && e.data !== null) {
        try {
          data = JSON.stringify(e.data);
          if (data.length > 40000) data = JSON.stringify({ truncated: true });
        } catch (x) { data = null; }
      }

      const questionId = typeof e.question_id === 'string' ? e.question_id.slice(0, 100) : null;
      saved += insert.run(
        attempt.attempt_id, attempt.bundle_attempt_id, attempt.student_id, attempt.school_id,
        e.uid, e.type, questionId, data, new Date(occurred).toISOString()
      ).changes;
    }
    return saved;
  });

  res.json({ success: true, saved: saveAll(events) });
});

module.exports = router;