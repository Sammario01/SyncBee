// server/routes/results.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');
const pLimit = require('p-limit');
const archiver = require('archiver');

router.use(requireAdminSession);

// The most a candidate could score on THEIR set of questions. This differs from the exam's total
// when each candidate is given only some of the questions (a pool).
const maxScoreStmt = db.prepare(`
  SELECT COALESCE(SUM(eq.marks), 0) AS m
  FROM attempt_questions aq
  INNER JOIN exam_questions eq ON eq.question_id = aq.question_id
  WHERE aq.attempt_id = ? AND aq.section = 'A'
`);
function attemptMax(attemptId) {
  return maxScoreStmt.get(attemptId).m;
}

// ─── shared helper for correctness comparison ─────────────────────
function isAnswerCorrect(questionType, rawFinal, rawCorrect, correctOptionRow) {
  if (rawFinal === null || rawFinal === undefined) return false;
  if (rawCorrect === null || rawCorrect === undefined) return false;

  const a = String(rawFinal).toLowerCase().trim();
  const b = String(rawCorrect).toLowerCase().trim();

  if (a === b) return true;

  if (questionType === 'MCQ_SINGLE' || questionType === 'TRUE_FALSE') {
    const byId = db.prepare(
      'SELECT option_id, option_text FROM exam_question_options WHERE option_id = ?'
    );

    const aRow = byId.get(rawFinal);
    const bRow = byId.get(rawCorrect);

    const aId = aRow ? aRow.option_id : null;
    const bId = bRow ? bRow.option_id : (correctOptionRow ? correctOptionRow.option_id : null);

    if (aId && bId && aId === bId) return true;

    const aText = aRow ? aRow.option_text : String(rawFinal);
    const bText = bRow ? bRow.option_text : String(rawCorrect);
    if (aText.toLowerCase().trim() === bText.toLowerCase().trim()) return true;
  }

  return false;
}

// ─── Puppeteer browser (lazy singleton) + helpers ─────────────────
// Puppeteer is an OPTIONAL dependency. It is only required by the bulk
// ZIP endpoints, which render print views to PDF. If it isn't installed
// (e.g. packaged build without Chromium), the rest of the app still works;
// the bulk ZIP endpoints simply return a 503 with a clear message.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      throw new Error('PDF export is not available in this build (puppeteer not installed).');
    }
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    // In packaged builds main.js sets PUPPETEER_EXECUTABLE_PATH to the bundled chrome.exe.
    // Honor it explicitly so puppeteer can't get confused by cache-dir detection.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log('[puppeteer] launching:', launchOpts.executablePath);
    }
    browserPromise = puppeteer.launch(launchOpts);
  }
  return browserPromise;
}

function safeStudentName(r) {
  return [r.firstname, r.middlename, r.lastname]
    .filter(Boolean).join('_').replace(/[^\w\-]+/g, '_') || r.student_id;
}

// GET /api/results/exams — exams with at least one Submitted attempt (single exams only)
router.get('/exams', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT e.exam_code, e.exam_title, e.total_marks, e.passing_marks
    FROM student_attempts sa
    INNER JOIN examinations e ON sa.exam_code = e.exam_code
    WHERE e.school_id = ?
      AND sa.status = 'Submitted'
      AND sa.bundle_attempt_id IS NULL
    ORDER BY e.exam_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/results/exam/:exam_code
router.get('/exam/:exam_code', (req, res) => {
  const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ? AND school_id = ?')
    .get(req.params.exam_code, req.session.school_id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  const theoryCountRow = db.prepare(
    `SELECT COUNT(*) AS c FROM exam_questions WHERE exam_code = ? AND question_type = 'THEORY'`
  ).get(req.params.exam_code);
  const has_theory = theoryCountRow.c > 0;

  const rows = db.prepare(`
    SELECT
      sa.attempt_id, sa.student_id,
      s.firstname, s.middlename, s.lastname,
      sa.score, sa.attempt_number, sa.finished_at,
      (SELECT COALESCE(SUM(eq.marks), 0) FROM attempt_questions aq
         INNER JOIN exam_questions eq ON eq.question_id = aq.question_id
       WHERE aq.attempt_id = sa.attempt_id AND aq.section = 'A') AS max_score
    FROM student_attempts sa
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sa.exam_code = ?
      AND sa.section = 'A'
      AND sa.status = 'Submitted'
      AND sa.bundle_attempt_id IS NULL
      AND sa.attempt_number = (
        SELECT MAX(sa2.attempt_number)
        FROM student_attempts sa2
        WHERE sa2.exam_code = sa.exam_code
          AND sa2.section = 'A'
          AND sa2.status = 'Submitted'
          AND sa2.bundle_attempt_id IS NULL
          AND sa2.student_id = sa.student_id
      )
    ORDER BY sa.score DESC
  `).all(req.params.exam_code);

  const withTheoryStatus = rows.map(r => {
    let theory_status = null;
    if (has_theory) {
      const theoryRow = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'marked' THEN 1 ELSE 0 END) AS marked,
          COUNT(*) AS total,
          SUM(score) AS total_score
        FROM theory_answers WHERE exam_code = ? AND student_id = ?
      `).get(req.params.exam_code, r.student_id);

      if (!theoryRow.total) theory_status = 'Not Attempted';
      else if (theoryRow.pending > 0) theory_status = `Pending (${theoryRow.pending}/${theoryRow.total})`;
      else theory_status = `Marked — ${theoryRow.total_score || 0} pts`;
    }
    return { ...r, theory_status };
  });

  const totalMarksRow = db.prepare(`
    SELECT COALESCE(SUM(marks), 0) AS total
    FROM exam_questions
    WHERE exam_code = ? AND question_type IN ('MCQ_SINGLE','TRUE_FALSE')
  `).get(req.params.exam_code);

  res.json({
    exam: {
      exam_title: exam.exam_title,
      total_marks: totalMarksRow.total,
      passing_marks: exam.passing_marks
    },
    has_theory,
    results: withTheoryStatus
  });
});

// GET /api/results/exam/:exam_code/question-stats
router.get('/exam/:exam_code/question-stats', (req, res) => {
  const rows = db.prepare(`
    SELECT eq.question_id, eq.question_text,
           COUNT(sa.id) AS total_answered,
           SUM(CASE WHEN LOWER(TRIM(sa.answer)) = LOWER(TRIM(eq.correct_answer)) THEN 1 ELSE 0 END) AS correct_count
    FROM exam_questions eq
    LEFT JOIN student_answers sa ON sa.question_id = eq.question_id
    WHERE eq.exam_code = ? AND eq.school_id = ? AND eq.question_type IN ('MCQ_SINGLE', 'TRUE_FALSE')
    GROUP BY eq.question_id
    HAVING total_answered > 0
    ORDER BY (CAST(correct_count AS FLOAT) / total_answered) ASC
    LIMIT 5
  `).all(req.params.exam_code, req.session.school_id);

  const withPct = rows.map(r => ({
    question_text: r.question_text,
    wrong_pct: Math.round((1 - r.correct_count / r.total_answered) * 100)
  }));

  res.json(withPct);
});

// GET /api/results/slip/:attempt_id
router.get('/slip/:attempt_id', (req, res) => {
  const attempt = db.prepare(`
    SELECT sa.*, s.firstname, s.middlename, s.lastname
    FROM student_attempts sa
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sa.attempt_id = ? AND sa.school_id = ?
  `).get(req.params.attempt_id, req.session.school_id);

  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ?').get(attempt.exam_code);

  res.json({
    student_name: [attempt.firstname, attempt.middlename, attempt.lastname].filter(Boolean).join(' ') || attempt.student_id,
    exam_title: exam.exam_title,
    total_marks: (exam.questions_to_attempt > 0 && attemptMax(attempt.attempt_id)) || exam.total_marks,
    passing_marks: exam.passing_marks,
    score: attempt.score,
    status: attempt.status,
    finished_at: attempt.finished_at,
    attempt_id: attempt.attempt_id
  });
});

// GET /api/results/bundles
router.get('/bundles', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT eb.bundle_code, eb.bundle_title
    FROM student_bundle_attempts sba
    INNER JOIN exam_bundles eb ON sba.bundle_code = eb.bundle_code
    WHERE eb.school_id = ? AND sba.status = 'Submitted'
    ORDER BY eb.bundle_title
  `).all(req.session.school_id);
  res.json(rows);
});

// GET /api/results/bundle/:bundle_code
router.get('/bundle/:bundle_code', (req, res) => {
  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .get(req.params.bundle_code, req.session.school_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const items = db.prepare(`
    SELECT e.total_marks FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code WHERE bi.bundle_code = ?
  `).all(req.params.bundle_code);
  const combinedTotal = items.reduce((sum, i) => sum + i.total_marks, 0);

  const bundleAttempts = db.prepare(`
    SELECT sba.bundle_attempt_id, sba.student_id, sba.finished_at, s.firstname, s.middlename, s.lastname
    FROM student_bundle_attempts sba LEFT JOIN students s ON sba.student_id = s.student_id
    WHERE sba.bundle_code = ? AND sba.status = 'Submitted'
  `).all(req.params.bundle_code);

  const results = bundleAttempts.map(ba => {
    const combinedScore = db.prepare(`
      SELECT COALESCE(SUM(score), 0) AS total FROM student_attempts WHERE bundle_attempt_id = ?
    `).get(ba.bundle_attempt_id).total;

    const firstAttempt = db.prepare(`
      SELECT attempt_id FROM student_attempts
      WHERE bundle_attempt_id = ? ORDER BY id ASC LIMIT 1
    `).get(ba.bundle_attempt_id);

    return {
      bundle_attempt_id: ba.bundle_attempt_id,
      student_id: ba.student_id,
      full_name: [ba.firstname, ba.middlename, ba.lastname].filter(Boolean).join(' ') || ba.student_id,
      combined_score: combinedScore,
      finished_at: ba.finished_at,
      first_attempt_id: firstAttempt ? firstAttempt.attempt_id : null,
    };
  }).sort((a, b) => b.combined_score - a.combined_score);
  res.json({ bundle: { bundle_title: bundle.bundle_title, combined_total: combinedTotal }, results });
});

// GET /api/results/bundle/:bundle_code/breakdown/:bundle_attempt_id
router.get('/bundle/:bundle_code/breakdown/:bundle_attempt_id', (req, res) => {
  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ? AND school_id = ?')
    .get(req.params.bundle_attempt_id, req.session.school_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Not found' });

  const student = db.prepare('SELECT firstname, middlename, lastname FROM students WHERE student_id = ?').get(bundleAttempt.student_id);
  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title, e.total_marks FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code WHERE bi.bundle_code = ? ORDER BY bi.item_order
  `).all(req.params.bundle_code);

  const breakdown = items.map(item => {
    const attempt = db.prepare(`
      SELECT attempt_id, score, started_at, finished_at FROM student_attempts
      WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
    `).get(req.params.bundle_attempt_id, item.exam_code);

    let timeSpentSeconds = null;
    if (attempt && attempt.started_at && attempt.finished_at) {
      const start = new Date(attempt.started_at.replace(' ', 'T'));
      const end = new Date(attempt.finished_at.replace(' ', 'T'));
      timeSpentSeconds = Math.max(0, Math.round((end - start) / 1000));
    }

    return {
      exam_title: item.exam_title,
      total_marks: item.total_marks,
      score: attempt ? (attempt.score ?? 0) : 0,
      attempted: !!attempt,
      time_spent_seconds: timeSpentSeconds,
      attempt_id: attempt ? attempt.attempt_id : null
    };
  });

  const combinedScore = breakdown.reduce((sum, b) => sum + b.score, 0);
  const combinedTotal = breakdown.reduce((sum, b) => sum + b.total_marks, 0);

  res.json({
    student_name: [student?.firstname, student?.middlename, student?.lastname].filter(Boolean).join(' ') || bundleAttempt.student_id,
    bundle_attempt_id: bundleAttempt.bundle_attempt_id,
    finished_at: bundleAttempt.finished_at,
    breakdown, combined_score: combinedScore, combined_total: combinedTotal
  });
});

// GET /api/results/audit/:attempt_id
router.get('/audit/:attempt_id', (req, res) => {
  const attempt = db.prepare('SELECT * FROM student_attempts WHERE attempt_id = ? AND school_id = ?')
    .get(req.params.attempt_id, req.session.school_id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const questions = db.prepare(
    `SELECT question_id, question_text, question_type, correct_answer FROM exam_questions WHERE exam_code = ? ORDER BY id ASC`
  ).all(attempt.exam_code);

  const answers = db.prepare(`SELECT question_id, answer FROM student_answers WHERE attempt_id = ?`).all(req.params.attempt_id);
  const answerMap = {};
  answers.forEach(a => { answerMap[a.question_id] = a.answer; });

  const changeLog = db.prepare(
    `SELECT question_id, old_value, new_value, changed_at FROM answer_audit_log WHERE attempt_id = ? ORDER BY changed_at ASC`
  ).all(req.params.attempt_id);
  const changesByQuestion = {};
  changeLog.forEach(c => { (changesByQuestion[c.question_id] = changesByQuestion[c.question_id] || []).push(c); });

  const resolveOptionText = db.prepare('SELECT option_text FROM exam_question_options WHERE option_id = ?');
  function toReadable(questionType, value) {
    if (value === null || value === undefined) return value;
    if (questionType === 'MCQ_SINGLE' || questionType === 'TRUE_FALSE') {
      const row = resolveOptionText.get(value);
      return row ? row.option_text : value;
    }
    return value;
  }

  const correctOptionStmt = db.prepare(
    'SELECT option_id, option_text FROM exam_question_options WHERE question_id = ? AND is_correct = 1'
  );

  const result = questions.map(q => {
    const rawFinal = answerMap[q.question_id] ?? null;
    const rawCorrect = q.correct_answer;

    const correctRow = (q.question_type === 'MCQ_SINGLE' || q.question_type === 'TRUE_FALSE')
      ? (correctOptionStmt.get(q.question_id) || null)
      : null;

    return {
      question_id: q.question_id,
      question_text: q.question_text,
      answered: q.question_id in answerMap,
      final_answer: toReadable(q.question_type, rawFinal),
      correct: (q.question_id in answerMap) &&
        isAnswerCorrect(q.question_type, rawFinal, rawCorrect, correctRow),
      change_history: (changesByQuestion[q.question_id] || []).map(h => ({
        old_value: toReadable(q.question_type, h.old_value),
        new_value: toReadable(q.question_type, h.new_value),
        changed_at: h.changed_at
      }))
    };
  });

  res.json({
    attempt_id: attempt.attempt_id, student_id: attempt.student_id,
    submission_reason: attempt.submission_reason, questions: result
  });
});

// GET /api/results/audit/bundle/:bundle_attempt_id
router.get('/audit/bundle/:bundle_attempt_id', (req, res) => {
  const bundleAttempt = db.prepare(
    'SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ? AND school_id = ?'
  ).get(req.params.bundle_attempt_id, req.session.school_id);
  if (!bundleAttempt) return res.status(404).json({ error: 'Bundle attempt not found' });

  const student = db.prepare(
    'SELECT firstname, middlename, lastname FROM students WHERE student_id = ?'
  ).get(bundleAttempt.student_id);

  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title
    FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ?
    ORDER BY bi.item_order
  `).all(bundleAttempt.bundle_code);

  const resolveOptionText = db.prepare(
    'SELECT option_text FROM exam_question_options WHERE option_id = ?'
  );
  const correctOptionStmt = db.prepare(
    'SELECT option_id, option_text FROM exam_question_options WHERE question_id = ? AND is_correct = 1'
  );
  function toReadable(questionType, value) {
    if (value === null || value === undefined) return value;
    if (questionType === 'MCQ_SINGLE' || questionType === 'TRUE_FALSE') {
      const row = resolveOptionText.get(value);
      return row ? row.option_text : value;
    }
    return value;
  }

  const sections = items.map(item => {
    const attempt = db.prepare(`
      SELECT * FROM student_attempts
      WHERE bundle_attempt_id = ? AND exam_code = ?
      ORDER BY id DESC LIMIT 1
    `).get(req.params.bundle_attempt_id, item.exam_code);

    if (!attempt) {
      return {
        exam_code: item.exam_code,
        exam_title: item.exam_title,
        attempt_id: null,
        not_attempted: true,
        submission_reason: null,
        questions: []
      };
    }

    const questions = db.prepare(`
      SELECT question_id, question_text, question_type, correct_answer
      FROM exam_questions WHERE exam_code = ? ORDER BY id ASC
    `).all(item.exam_code);

    const answers = db.prepare(
      'SELECT question_id, answer FROM student_answers WHERE attempt_id = ?'
    ).all(attempt.attempt_id);
    const answerMap = {};
    answers.forEach(a => { answerMap[a.question_id] = a.answer; });

    const changeLog = db.prepare(`
      SELECT question_id, old_value, new_value, changed_at
      FROM answer_audit_log WHERE attempt_id = ? ORDER BY changed_at ASC
    `).all(attempt.attempt_id);
    const changesByQuestion = {};
    changeLog.forEach(c => {
      (changesByQuestion[c.question_id] = changesByQuestion[c.question_id] || []).push(c);
    });

    return {
      exam_code: item.exam_code,
      exam_title: item.exam_title,
      attempt_id: attempt.attempt_id,
      not_attempted: false,
      submission_reason: attempt.submission_reason,
      questions: questions.map(q => {
        const rawFinal = answerMap[q.question_id] ?? null;
        const rawCorrect = q.correct_answer;

        const correctRow = (q.question_type === 'MCQ_SINGLE' || q.question_type === 'TRUE_FALSE')
          ? (correctOptionStmt.get(q.question_id) || null)
          : null;

        return {
          question_id: q.question_id,
          question_text: q.question_text,
          answered: q.question_id in answerMap,
          final_answer: toReadable(q.question_type, rawFinal),
          correct: (q.question_id in answerMap) &&
            isAnswerCorrect(q.question_type, rawFinal, rawCorrect, correctRow),
          change_history: (changesByQuestion[q.question_id] || []).map(h => ({
            old_value: toReadable(q.question_type, h.old_value),
            new_value: toReadable(q.question_type, h.new_value),
            changed_at: h.changed_at
          }))
        };
      })
    };
  });

  res.json({
    mode: 'bundle',
    bundle_attempt_id: bundleAttempt.bundle_attempt_id,
    student_id: bundleAttempt.student_id,
    student_name: [student?.firstname, student?.middlename, student?.lastname].filter(Boolean).join(' ') || bundleAttempt.student_id,
    finished_at: bundleAttempt.finished_at,
    sections
  });
});

// ─── BULK ZIP: single exam ──────────────────────────────────────
router.get('/bulk-zip/exam/:exam_code', async (req, res) => {
  const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ? AND school_id = ?')
    .get(req.params.exam_code, req.session.school_id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  const rows = db.prepare(`
    SELECT sa.attempt_id, s.firstname, s.middlename, s.lastname, sa.student_id
    FROM student_attempts sa
    LEFT JOIN students s ON sa.student_id = s.student_id
    WHERE sa.exam_code = ?
      AND sa.section = 'A'
      AND sa.status = 'Submitted'
      AND sa.bundle_attempt_id IS NULL
      AND sa.attempt_number = (
        SELECT MAX(sa2.attempt_number) FROM student_attempts sa2
        WHERE sa2.exam_code = sa.exam_code AND sa2.section = 'A'
          AND sa2.status = 'Submitted' AND sa2.bundle_attempt_id IS NULL
          AND sa2.student_id = sa.student_id
      )
  `).all(req.params.exam_code);

  if (rows.length === 0) return res.status(404).json({ error: 'No submitted attempts' });

  // Puppeteer is optional. Fail cleanly if this build has no PDF support.
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    console.error('bulk-zip/exam: browser unavailable:', err.message);
    return res.status(503).json({
      error: 'PDF export is not available in this build. Use the individual print pages, or install puppeteer to enable bulk ZIP export.'
    });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="results_${req.params.exam_code}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { console.error('Archive error:', err); res.destroy(); });
  archive.pipe(res);

  const cookieHeader = req.headers.cookie || '';
  const baseUrl = `http://127.0.0.1:${req.app.get('port')}`;
  const limit = pLimit(4);

  const tasks = rows.map(r => limit(async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ cookie: cookieHeader });
      await page.goto(
        `${baseUrl}/print-result?attempt_id=${encodeURIComponent(r.attempt_id)}`,
        { waitUntil: 'domcontentloaded', timeout: 45000 }
      );
      await page.waitForSelector('body', { timeout: 5000 });
      await new Promise(res => setTimeout(res, 300));
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      archive.append(Buffer.from(pdf), { name: `${safeStudentName(r)}.pdf` });
    } catch (err) {
      console.error(`Skipping ${r.attempt_id}:`, err.message);
    } finally {
      await page.close();
    }
  }));

  try {
    await Promise.all(tasks);
    await archive.finalize();
  } catch (err) {
    console.error('Bulk zip failed:', err);
    try { archive.abort(); } catch (_) {}
    res.destroy();
  }
});

// ─── BULK ZIP: bundle ───────────────────────────────────────────
router.get('/bulk-zip/bundle/:bundle_code', async (req, res) => {
  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .get(req.params.bundle_code, req.session.school_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const rows = db.prepare(`
    SELECT sba.bundle_attempt_id, s.firstname, s.middlename, s.lastname, sba.student_id
    FROM student_bundle_attempts sba
    LEFT JOIN students s ON sba.student_id = s.student_id
    WHERE sba.bundle_code = ? AND sba.status = 'Submitted'
  `).all(req.params.bundle_code);

  if (rows.length === 0) return res.status(404).json({ error: 'No submitted bundles' });

  // Puppeteer is optional. Fail cleanly if this build has no PDF support.
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    console.error('bulk-zip/bundle: browser unavailable:', err.message);
    return res.status(503).json({
      error: 'PDF export is not available in this build. Use the individual print pages, or install puppeteer to enable bulk ZIP export.'
    });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bundle_${req.params.bundle_code}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { console.error('Archive error:', err); res.destroy(); });
  archive.pipe(res);

  const cookieHeader = req.headers.cookie || '';
  const baseUrl = `http://127.0.0.1:${req.app.get('port')}`;
  const limit = pLimit(4);

  const tasks = rows.map(r => limit(async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ cookie: cookieHeader });
      await page.goto(
        `${baseUrl}/print-bundle-result?bundle_code=${encodeURIComponent(req.params.bundle_code)}&bundle_attempt_id=${encodeURIComponent(r.bundle_attempt_id)}`,
        { waitUntil: 'domcontentloaded', timeout: 45000 }
      );
      await page.waitForSelector('body', { timeout: 5000 });
      await new Promise(res => setTimeout(res, 300));
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      archive.append(Buffer.from(pdf), { name: `${safeStudentName(r)}.pdf` });
    } catch (err) {
      console.error(`Skipping ${r.bundle_attempt_id}:`, err.message);
    } finally {
      await page.close();
    }
  }));

  try {
    await Promise.all(tasks);
    await archive.finalize();
  } catch (err) {
    console.error('Bulk zip failed:', err);
    try { archive.abort(); } catch (_) {}
    res.destroy();
  }
});

module.exports = router;