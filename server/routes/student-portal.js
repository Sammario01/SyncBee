// server/routes/student-portal.js
// Session-based endpoints for the LOGGED-IN student's own view (dashboard, "my
// exams"). Distinct from routes/students.js, which is admin-facing CRUD for
// managing student records.
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireStudentSession } = require('./auth');

router.use(requireStudentSession);

function nowSqlString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// GET /api/student/exams
// Simplified from PHP's index.php: no active-session/term gating (Syncbee syncs
// exams per offline event, not an ongoing term catalog) — just published exams
// matching the student's class/program, or global, for their school.
// GET /api/student/exams
// Published exams matching the student's class/program (or global).
// Exams that are already part of a bundle the student qualifies for are
// excluded — those show up in /bundles instead, so the dashboard doesn't
// list the same exam twice.
router.get('/exams', (req, res) => {
  const { school_id, class_id, program_id, student_id } = req.session;

  const exams = db.prepare(`
    SELECT * FROM examinations e
    WHERE e.school_id = ?
      AND e.published = 1
      AND (e.class_id = ? OR e.program_id = ? OR e.is_global = 1)
      AND e.exam_code NOT IN (
        SELECT bi.exam_code
        FROM exam_bundle_items bi
        INNER JOIN exam_bundles b ON b.bundle_code = bi.bundle_code
        WHERE b.school_id = ?
          AND b.published = 1
          AND (b.class_id = ? OR b.program_id = ? OR b.is_global = 1)
      )
    ORDER BY e.start_time DESC
  `).all(school_id, class_id, program_id, school_id, class_id, program_id);

  const now = nowSqlString();

  const withStatus = exams.map(exam => {
    let status = 'upcoming';
    if (now >= exam.start_time && now <= exam.end_time) status = 'ongoing';
    else if (now > exam.end_time) status = 'ended';

    const attempt = db.prepare(`
      SELECT status, score FROM student_attempts
      WHERE student_id = ? AND exam_code = ? AND section = 'A'
      ORDER BY id DESC LIMIT 1
    `).get(student_id, exam.exam_code);

    return {
      exam_code: exam.exam_code,
      exam_title: exam.exam_title,
      description: exam.description,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      duration_minutes: exam.duration_minutes,
      start_time: exam.start_time,
      end_time: exam.end_time,
      has_theory: exam.has_theory,
      status,
      attempt_status: attempt ? attempt.status : null
    };
  });

  res.json({ success: true, exams: withStatus });
});

// GET /api/student/exam-details?exam_code=X
// Mirrors exam-details.php's full status-determination logic.
router.get('/exam-details', (req, res) => {
  const { exam_code } = req.query;
  const { student_id, school_id, class_id, program_id } = req.session;

  if (!exam_code) {
    return res.status(400).json({ success: false, message: 'exam_code is required' });
  }

  const exam = db.prepare(`
    SELECT * FROM examinations
    WHERE exam_code = ? AND school_id = ? AND (class_id = ? OR program_id = ? OR is_global = 1)
    LIMIT 1
  `).get(exam_code, school_id, class_id, program_id);

  if (!exam) {
    return res.status(404).json({ success: false, message: 'Exam not found or not assigned to you.' });
  }

  const theoryCountRow = db.prepare(
    `SELECT COUNT(*) AS c FROM exam_questions WHERE exam_code = ? AND school_id = ? AND question_type = 'THEORY'`
  ).get(exam_code, school_id);
  const has_theory = theoryCountRow.c > 0;

  const totalQuestions = (exam.questions_to_attempt && exam.questions_to_attempt > 0)
    ? exam.questions_to_attempt
    : db.prepare(`SELECT COUNT(*) AS c FROM exam_questions WHERE exam_code = ? AND school_id = ?`).get(exam_code, school_id).c;

  // Section completion (only matters if the exam has theory)
  let sectionA_completed = false;
  let sectionB_completed = false;

  if (has_theory) {
    const rows = db.prepare(`
      SELECT section, status FROM student_attempts
      WHERE student_id = ? AND exam_code = ? AND section IN ('A','B') AND status = 'Submitted'
      ORDER BY section, attempt_number DESC
    `).all(student_id, exam_code);
    const seen = {};
    for (const row of rows) {
      if (!seen[row.section]) {
        seen[row.section] = row.status;
        if (row.section === 'A') sectionA_completed = true;
        if (row.section === 'B') sectionB_completed = true;
      }
    }
  }

  // Determine which section's attempt to check
  let section_to_check;
  if (has_theory) {
    section_to_check = !sectionA_completed ? 'A' : (!sectionB_completed ? 'B' : null);
  } else {
    section_to_check = 'A';
  }

  let attempted = 0;
  let last_status = null;

  if (section_to_check) {
    const row = db.prepare(`
      SELECT COUNT(*) AS attempted, MAX(attempt_number) AS latest_attempt,
        (SELECT status FROM student_attempts WHERE student_id = ? AND exam_code = ? AND section = ? ORDER BY attempt_number DESC LIMIT 1) AS last_status
      FROM student_attempts WHERE student_id = ? AND exam_code = ? AND section = ?
    `).get(student_id, exam_code, section_to_check, student_id, exam_code, section_to_check);
    attempted = row.attempted || 0;
    last_status = row.last_status;
  } else {
    // Both sections completed
    const row = db.prepare(`
      SELECT COUNT(DISTINCT section) AS attempted FROM student_attempts WHERE student_id = ? AND exam_code = ?
    `).get(student_id, exam_code);
    attempted = row.attempted || 0;
    last_status = 'Submitted';
  }

  // Status determination — mirrors PHP's if/elseif chain exactly
  const now = new Date();
  const startTime = new Date(exam.start_time.replace(' ', 'T'));
  const endTime = new Date(exam.end_time.replace(' ', 'T'));

  let status_text, button_disabled, reason_message = '', status_class;

  if (now < startTime) {
    status_text = 'Not Started'; button_disabled = true;
    reason_message = 'This exam has not started yet.'; status_class = 'warning';
  } else if (now > endTime) {
    status_text = 'Ended'; button_disabled = true;
    reason_message = 'This exam has already ended.'; status_class = 'danger';
  } else if (has_theory && sectionA_completed && sectionB_completed) {
    status_text = 'Completed'; button_disabled = true;
    reason_message = 'You have completed both sections of this exam.'; status_class = 'muted';
  } else if (has_theory && sectionA_completed && !sectionB_completed) {
    status_text = 'Section B Pending'; button_disabled = false; status_class = 'info';
  } else if (!last_status) {
    status_text = 'Ready to Start'; button_disabled = false; status_class = 'success';
  } else if (last_status === 'In Progress') {
    status_text = 'Ongoing Attempt'; button_disabled = false; status_class = 'info';
  } else if (last_status === 'Submitted' && !has_theory) {
    if (attempted >= exam.max_attempts) {
      status_text = 'Completed'; button_disabled = true;
      reason_message = `You have reached the maximum number of attempts allowed (${exam.max_attempts}).`;
      status_class = 'muted';
    } else {
      status_text = 'Retake Allowed'; button_disabled = false; status_class = 'primary';
    }
  } else {
    status_text = 'Unavailable'; button_disabled = true;
    reason_message = 'You cannot start this exam right now.'; status_class = 'danger';
  }

  res.json({
    success: true,
       exam: {
      id: exam.id,
      exam_code: exam.exam_code,
      exam_title: exam.exam_title,
      description: exam.description,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      duration_minutes: exam.duration_minutes,
      max_attempts: exam.max_attempts,
      total_questions: totalQuestions
    },
    has_theory,
    section_to_check,
    status_text,
    status_class,
    button_disabled,
    reason_message
  });
});

// GET /api/student/exam-finish?exam_code=X&section=A|B
router.get('/exam-finish', (req, res) => {
  const { exam_code, section } = req.query;
  const { student_id } = req.session;

  if (!exam_code) {
    return res.status(400).json({ success: false, message: 'exam_code is required' });
  }

  const exam = db.prepare('SELECT * FROM examinations WHERE exam_code = ?').get(exam_code);
  if (!exam) {
    return res.status(404).json({ success: false, message: 'Exam not found.' });
  }

  const theoryCountRow = db.prepare(
    `SELECT COUNT(*) AS c FROM exam_questions WHERE exam_code = ? AND question_type = 'THEORY'`
  ).get(exam_code);
  const has_theory = theoryCountRow.c > 0;

  const rows = db.prepare(`
    SELECT section, status, score FROM student_attempts
    WHERE student_id = ? AND exam_code = ? AND section IN ('A','B') AND status = 'Submitted'
    ORDER BY section, attempt_number DESC
  `).all(student_id, exam_code);

  let section_a_completed = false, section_b_completed = false, aScore = null;
  const seen = {};
  for (const row of rows) {
    if (!seen[row.section]) {
      seen[row.section] = true;
      if (row.section === 'A') { section_a_completed = true; aScore = row.score; }
      if (row.section === 'B') section_b_completed = true;
    }
  }

  const both_sections_completed = has_theory ? (section_a_completed && section_b_completed) : section_a_completed;

  let scoreMessage;
  if (exam.show_result === 'Immediately' && aScore !== null) {
    scoreMessage = { score: aScore, total_marks: exam.total_marks };
  } else if (exam.show_result === 'Never') {
    scoreMessage = { text: 'Results for this exam are not shown to students.' };
  } else {
    scoreMessage = { text: 'Your result will be available once published by your school.' };
  }

  res.json({
    success: true,
    exam_title: exam.exam_title,
    section,
    has_theory,
    section_a_completed,
    section_b_completed,
    both_sections_completed,
    score_display: scoreMessage
  });
});

// GET /api/student/bundles
router.get('/bundles', (req, res) => {
  const { school_id, class_id, program_id, student_id } = req.session;

  const bundles = db.prepare(`
    SELECT * FROM exam_bundles
    WHERE school_id = ? AND published = 1 AND (class_id = ? OR program_id = ? OR is_global = 1)
    ORDER BY start_time DESC
  `).all(school_id, class_id, program_id);

  const now = nowSqlString();

  const withStatus = bundles.map(bundle => {
    let status = 'upcoming';
    if (now >= bundle.start_time && now <= bundle.end_time) status = 'ongoing';
    else if (now > bundle.end_time) status = 'ended';

    const attempt = db.prepare(`
      SELECT status, bundle_attempt_id FROM student_bundle_attempts
      WHERE student_id = ? AND bundle_code = ? ORDER BY id DESC LIMIT 1
    `).get(student_id, bundle.bundle_code);

    return {
      bundle_code: bundle.bundle_code, bundle_title: bundle.bundle_title, description: bundle.description,
      total_duration_minutes: bundle.total_duration_minutes, start_time: bundle.start_time, end_time: bundle.end_time,
      status, attempt_status: attempt ? attempt.status : null
    };
  });

  res.json({ success: true, bundles: withStatus });
});

// GET /api/student/bundle-details?bundle_code=X
router.get('/bundle-details', (req, res) => {
  const { bundle_code } = req.query;
  const { school_id, class_id, program_id, student_id } = req.session;

  const bundle = db.prepare(`
    SELECT * FROM exam_bundles
    WHERE bundle_code = ? AND school_id = ? AND (class_id = ? OR program_id = ? OR is_global = 1)
  `).get(bundle_code, school_id, class_id, program_id);

  if (!bundle) return res.status(404).json({ success: false, message: 'Bundle not found or not assigned to you.' });

  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title, e.duration_minutes, e.total_marks
    FROM exam_bundle_items bi INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundle_code);

  const bundleAttempt = db.prepare(`
    SELECT * FROM student_bundle_attempts WHERE student_id = ? AND bundle_code = ? ORDER BY id DESC LIMIT 1
  `).get(student_id, bundle_code);

  const itemsWithStatus = items.map(item => {
    let itemStatus = 'not_started';
    if (bundleAttempt) {
      const attempt = db.prepare(`
        SELECT status FROM student_attempts
        WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
      `).get(bundleAttempt.bundle_attempt_id, item.exam_code);
      if (attempt) itemStatus = attempt.status === 'Submitted' ? 'submitted' : 'in_progress';
    }

    let locked = false;
    if (bundle.navigation_mode !== 'free' && item.item_order > 1) {
      const previousItem = items[item.item_order - 2];
      const prevAttempt = bundleAttempt ? db.prepare(`
        SELECT status FROM student_attempts WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
      `).get(bundleAttempt.bundle_attempt_id, previousItem.exam_code) : null;
      locked = !prevAttempt || prevAttempt.status !== 'Submitted';
    }

    return { ...item, status: itemStatus, locked };
  });

  res.json({
    success: true,
    bundle: {
      bundle_code: bundle.bundle_code, bundle_title: bundle.bundle_title, description: bundle.description,
      total_duration_minutes: bundle.total_duration_minutes, navigation_mode: bundle.navigation_mode,
      show_result: bundle.show_result, start_time: bundle.start_time, end_time: bundle.end_time
    },
    items: itemsWithStatus,
    bundle_attempt: bundleAttempt ? { bundle_attempt_id: bundleAttempt.bundle_attempt_id, status: bundleAttempt.status, current_item_order: bundleAttempt.current_item_order } : null
  });
});

// GET /api/student/bundle-finish?bundle_attempt_id=X — JAMB-style score breakdown
router.get('/bundle-finish', (req, res) => {
  const { bundle_attempt_id } = req.query;
  const { student_id } = req.session;

  const bundleAttempt = db.prepare('SELECT * FROM student_bundle_attempts WHERE bundle_attempt_id = ?').get(bundle_attempt_id);
  if (!bundleAttempt || bundleAttempt.student_id !== student_id) {
    return res.status(404).json({ success: false, message: 'Bundle attempt not found.' });
  }

  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ?').get(bundleAttempt.bundle_code);

  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title, e.total_marks
    FROM exam_bundle_items bi INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(bundleAttempt.bundle_code);

  const breakdown = items.map(item => {
    const attempt = db.prepare(`
      SELECT score, status, started_at, finished_at FROM student_attempts
      WHERE bundle_attempt_id = ? AND exam_code = ? ORDER BY id DESC LIMIT 1
    `).get(bundle_attempt_id, item.exam_code);

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
      time_spent_seconds: timeSpentSeconds
    };
  });

  const combinedScore = breakdown.reduce((sum, b) => sum + b.score, 0);
  const combinedTotal = breakdown.reduce((sum, b) => sum + b.total_marks, 0);

  let scoreDisplay;
  if (bundle.show_result === 'Immediately') {
    scoreDisplay = { visible: true, breakdown, combined_score: combinedScore, combined_total: combinedTotal };
  } else if (bundle.show_result === 'Never') {
    scoreDisplay = { visible: false, text: 'Results for this bundle are not shown to students.' };
  } else {
    scoreDisplay = { visible: false, text: 'Your result will be available once published by your school.' };
  }

  res.json({ success: true, bundle_title: bundle.bundle_title, score_display: scoreDisplay });
});

// GET /api/student/features: what the candidate's exam page should show right now
router.get('/features', (req, res) => {
  res.json({ features: require('../features').forCandidates() });
});

module.exports = router;