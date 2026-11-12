// server/routes/dashboard.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

function nowSqlString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

router.get('/summary', (req, res) => {
  const school_id = req.session.school_id;
  const now = nowSqlString();

  const totalExams = db.prepare('SELECT COUNT(*) AS c FROM examinations WHERE school_id = ?').get(school_id).c;
  const publishedExams = db.prepare('SELECT COUNT(*) AS c FROM examinations WHERE school_id = ? AND published = 1').get(school_id).c;
  const activeExams = db.prepare(`
    SELECT COUNT(*) AS c FROM examinations
    WHERE school_id = ? AND published = 1 AND start_time <= ? AND end_time >= ?
  `).get(school_id, now, now).c;
  const totalStudents = db.prepare('SELECT COUNT(*) AS c FROM students WHERE school_id = ?').get(school_id).c;
  const completedAttempts = db.prepare(
    `SELECT COUNT(*) AS c FROM student_attempts WHERE school_id = ? AND status = 'Submitted'`
  ).get(school_id).c;
  const pendingSync = db.prepare(
    `SELECT COUNT(*) AS c FROM student_attempts WHERE school_id = ? AND is_synced = 0 AND status = 'Submitted'`
  ).get(school_id).c;
  const totalIncidents = db.prepare(`
    SELECT COUNT(*) AS c FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    WHERE sa.school_id = ?
  `).get(school_id).c;
  const totalSubjects = db.prepare('SELECT COUNT(*) AS c FROM subjects WHERE school_id = ?').get(school_id).c;

  res.json({
    total_exams: totalExams, published_exams: publishedExams, active_exams: activeExams,
    total_students: totalStudents, completed_attempts: completedAttempts,
    pending_sync: pendingSync, total_incidents: totalIncidents, total_subjects: totalSubjects
  });
});

router.get('/monitor/exams', (req, res) => {
  const school_id = req.session.school_id;
  const now = nowSqlString();

  const exam = db.prepare(`
    SELECT * FROM examinations
    WHERE school_id = ? AND published = 1 AND start_time <= ? AND end_time >= ?
    ORDER BY start_time DESC LIMIT 1
  `).get(school_id, now, now);

  if (!exam) return res.json({ active: false });

  const candidates = db.prepare(`
    SELECT COUNT(*) AS c FROM students
    WHERE school_id = ? AND (class_id = ? OR program_id = ? OR ? = 1)
  `).get(school_id, exam.class_id, exam.program_id, exam.is_global).c;

  const writing = db.prepare(
    `SELECT COUNT(*) AS c FROM student_attempts WHERE exam_code = ? AND status = 'In Progress'`
  ).get(exam.exam_code).c;
  const completed = db.prepare(
    `SELECT COUNT(*) AS c FROM student_attempts WHERE exam_code = ? AND status = 'Submitted'`
  ).get(exam.exam_code).c;
  const incidents = db.prepare(`
    SELECT COUNT(*) AS c FROM exam_incidents ei
    INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    WHERE sa.exam_code = ?
  `).get(exam.exam_code).c;

  res.json({
    active: true, exam_title: exam.exam_title, start_time: exam.start_time, end_time: exam.end_time,
    candidates, writing, completed, incidents
  });
});

router.get('/sync-status', (req, res) => {
  const school_id = req.session.school_id;

   const lastResultSync = db.prepare(`
    SELECT finished_at FROM sync_logs WHERE school_id = ? AND direction = 'upload' AND status = 'success'
    ORDER BY finished_at DESC LIMIT 1
  `).get(school_id);
  const lastMasterSync = db.prepare(`
    SELECT finished_at FROM sync_logs WHERE school_id = ? AND direction = 'download' AND status = 'success'
    ORDER BY finished_at DESC LIMIT 1
  `).get(school_id);
  const pendingUpload = db.prepare(
    `SELECT COUNT(*) AS c FROM student_attempts WHERE school_id = ? AND is_synced = 0 AND status = 'Submitted'`
  ).get(school_id).c;

  res.json({
    last_result_sync: lastResultSync ? lastResultSync.finished_at : null,
    last_master_sync: lastMasterSync ? lastMasterSync.finished_at : null,
    pending_upload: pendingUpload
  });
});

router.get('/activity', (req, res) => {
  const school_id = req.session.school_id;

  const examsCreated = db.prepare(`
    SELECT exam_title AS label, created_at AS at, 'exam_created' AS type
    FROM examinations WHERE school_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(school_id);

  const attemptsStarted = db.prepare(`
    SELECT sa.exam_code AS label, sa.started_at AS at, 'attempt_started' AS type
    FROM student_attempts sa WHERE sa.school_id = ? ORDER BY sa.started_at DESC LIMIT 10
  `).all(school_id);

  const attemptsSubmitted = db.prepare(`
    SELECT sa.exam_code AS label, sa.finished_at AS at, 'attempt_submitted' AS type
    FROM student_attempts sa WHERE sa.school_id = ? AND sa.status = 'Submitted' AND sa.finished_at IS NOT NULL
    ORDER BY sa.finished_at DESC LIMIT 10
  `).all(school_id);

  const incidents = db.prepare(`
    SELECT ei.incident_type AS label, ei.created_at AS at, 'incident' AS type
    FROM exam_incidents ei INNER JOIN student_attempts sa ON ei.attempt_id = sa.attempt_id
    WHERE sa.school_id = ? ORDER BY ei.created_at DESC LIMIT 10
  `).all(school_id);

  const syncs = db.prepare(`
    SELECT sync_type AS label, finished_at AS at, 'sync' AS type
    FROM sync_logs WHERE school_id = ? AND status = 'success' ORDER BY finished_at DESC LIMIT 10
  `).all(school_id);

  const all = [...examsCreated, ...attemptsStarted, ...attemptsSubmitted, ...incidents, ...syncs]
    .filter(e => e.at)
    .sort((a, b) => new Date(b.at.replace(' ', 'T')) - new Date(a.at.replace(' ', 'T')))
    .slice(0, 15);

  res.json(all);
});

// GET /api/dashboard/today-schedule
// Returns every exam scheduled for "today" (server-local date), plus any exam
// currently in progress even if it started yesterday. Ordered: ongoing first,
// then upcoming (by start_time), then completed (most recent first).
router.get('/today-schedule', (req, res) => {
  const school_id = req.session.school_id;

  // "Today" boundaries in server-local time
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm   = String(today.getMonth() + 1).padStart(2, '0');
  const dd   = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`; // e.g. '2026-10-08'

  // 1) Today's published exams + any exam currently running
  const exams = db.prepare(`
    SELECT
      id, exam_code, exam_title, class_id, program_id, is_global,
      start_time, end_time, status, duration_minutes, total_marks
    FROM examinations
    WHERE school_id = ?
      AND published = 1
      AND (
        DATE(start_time) = ?
        OR (datetime('now','localtime') BETWEEN start_time AND end_time)
      )
    ORDER BY start_time ASC
  `).all(school_id, dateStr);

  if (exams.length === 0) {
    return res.json({
      date: dateStr, total_today: 0, total_candidates: 0, exams: []
    });
  }

  // 2) For each exam, count expected students + attempt counts
  const expectedStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM students
    WHERE school_id = ?
      AND active_status = 1
      AND graduated = 0
      AND (
        ? = 1
        OR (class_id   IS NOT NULL AND class_id   = ?)
        OR (program_id IS NOT NULL AND program_id = ?)
      )
  `);

  const attemptCountsStmt = db.prepare(`
    SELECT
      COUNT(DISTINCT student_id)                              AS started,
      SUM(CASE WHEN status = 'Submitted' THEN 1 ELSE 0 END)   AS submitted
    FROM student_attempts
    WHERE exam_code = ?
  `);

  const now = Date.now();

  const rows = exams.map(e => {
    const expected = expectedStmt.get(
      school_id,
      e.is_global ? 1 : 0,
      e.class_id,
      e.program_id
    ).c;

    const counts = attemptCountsStmt.get(e.exam_code) || { started: 0, submitted: 0 };

    const startMs = new Date(e.start_time.replace(' ', 'T') + 'Z').getTime();
    const endMs   = new Date(e.end_time.replace(' ', 'T') + 'Z').getTime();

    // Classify relative to "now"
    let phase;
    if (now < startMs)          phase = 'upcoming';
    else if (now <= endMs)      phase = 'ongoing';
    else                        phase = 'completed';

    return {
      exam_code:           e.exam_code,
      exam_title:          e.exam_title,
      start_time:          e.start_time,
      end_time:            e.end_time,
      phase,
      minutes_until_start: Math.round((startMs - now) / 60000),
      minutes_until_end:   Math.round((endMs   - now) / 60000),
      expected_candidates: expected,
      started_attempts:    counts.started   || 0,
      submitted_attempts:  counts.submitted || 0
    };
  });

  // Order: ongoing → upcoming → completed (completed most-recent first)
  const phaseRank = { ongoing: 0, upcoming: 1, completed: 2 };
  rows.sort((a, b) => {
    if (phaseRank[a.phase] !== phaseRank[b.phase]) return phaseRank[a.phase] - phaseRank[b.phase];
    if (a.phase === 'completed') return b.minutes_until_end - a.minutes_until_end;
    return a.minutes_until_start - b.minutes_until_start;
  });

  const totalCandidates = rows
    .filter(r => r.phase !== 'completed')
    .reduce((sum, r) => sum + r.expected_candidates, 0);

  res.json({
    date: dateStr,
    total_today: rows.length,
    total_candidates: totalCandidates,
    exams: rows
  });
});

// GET /api/dashboard/incidents-breakdown
// Counts incidents by type over the last 24 hours, scoped to this school.
// Joins through student_attempts so we only count incidents belonging to
// this school's attempts.
router.get('/incidents-breakdown', (req, res) => {
  const school_id = req.session.school_id;

  const rows = db.prepare(`
    SELECT
      ei.incident_type,
      COUNT(*) AS count,
      MAX(ei.created_at) AS last_at
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON sa.attempt_id = ei.attempt_id
    WHERE sa.school_id = ?
      AND ei.created_at >= datetime('now', '-24 hours')
    GROUP BY ei.incident_type
    ORDER BY count DESC
  `).all(school_id);

  const total = rows.reduce((sum, r) => sum + r.count, 0);

  const allTime = db.prepare(`
    SELECT COUNT(*) AS c
    FROM exam_incidents ei
    INNER JOIN student_attempts sa ON sa.attempt_id = ei.attempt_id
    WHERE sa.school_id = ?
  `).get(school_id).c;

  res.json({
    window_hours: 24,
    total_24h: total,
    total_all_time: allTime,
    breakdown: rows
  });
});


// GET /api/dashboard/checkin-status
// For the current live exam (or the next upcoming one), shows how many
// enrolled candidates are actually connected vs. expected.
// GET /api/dashboard/checkin-status
router.get('/checkin-status', (req, res) => {
  const school_id = req.session.school_id;

  // 1) Pick the live exam (or one starting within 15 min)
  const exam = db.prepare(`
    SELECT id, exam_code, exam_title, class_id, program_id, is_global,
           start_time, end_time
    FROM examinations
    WHERE school_id = ?
      AND published = 1
      AND (
        (datetime('now','localtime') BETWEEN start_time AND end_time)
        OR datetime(start_time) BETWEEN datetime('now','localtime') AND datetime('now','localtime','+15 minutes')
      )
    ORDER BY
      CASE WHEN datetime('now','localtime') BETWEEN start_time AND end_time THEN 0 ELSE 1 END,
      start_time ASC
    LIMIT 1
  `).get(school_id);

  if (!exam) return res.json({ active: false });

  // 2) Expected candidates
  const expected = db.prepare(`
    SELECT student_id, firstname, lastname
    FROM students
    WHERE school_id = ?
      AND active_status = 1
      AND graduated = 0
      AND (
        ? = 1
        OR (class_id   IS NOT NULL AND class_id   = ?)
        OR (program_id IS NOT NULL AND program_id = ?)
      )
  `).all(school_id, exam.is_global ? 1 : 0, exam.class_id, exam.program_id);

  // 3) In-progress attempts for this exam
  const attempts = db.prepare(`
    SELECT student_id, attempt_id, status, last_activity, started_at
    FROM student_attempts
    WHERE exam_code = ?
      AND status = 'In Progress'
  `).all(exam.exam_code);

  // 4) Classify by freshness of last_activity
  const now = Date.now();
  const ageMin = (t) => t
    ? Math.floor((now - new Date(String(t).replace(' ', 'T') + 'Z').getTime()) / 60000)
    : null;

  const connected = [];
  const stale     = [];

  for (const a of attempts) {
    const age = ageMin(a.last_activity);
    if (age !== null && age <= 2) connected.push(a);
    else                          stale.push({ ...a, age_minutes: age });
  }

  const connectedIds = new Set(connected.map(a => a.student_id));
  const staleIds     = new Set(stale.map(a => a.student_id));
  const notSeen      = expected.filter(s => !connectedIds.has(s.student_id) && !staleIds.has(s.student_id));

  res.json({
    active: true,
    exam: {
      exam_code:  exam.exam_code,
      exam_title: exam.exam_title,
      start_time: exam.start_time,
      end_time:   exam.end_time
    },
    counts: {
      expected:  expected.length,
      connected: connected.length,
      stale:     stale.length,
      not_seen:  notSeen.length
    },
    not_seen_sample: notSeen.slice(0, 15),
    stale_sample:    stale.slice(0, 15)
  });
});

// GET /api/dashboard/help-requests — pending help requests, oldest first.
// Used by the floating widget that appears on every admin page.
router.get('/help-requests', (req, res) => {
  const school_id = req.session.school_id;

  const rows = db.prepare(`
    SELECT hr.id, hr.attempt_id, hr.student_id, hr.exam_code, hr.bundle_code,
           hr.created_at,
           s.firstname, s.middlename, s.lastname
    FROM help_requests hr
    LEFT JOIN students s ON hr.student_id = s.student_id
    WHERE hr.school_id = ?
      AND hr.status = 'pending'
    ORDER BY hr.created_at ASC
  `).all(school_id);

  const now = Date.now();
  const withWait = rows.map(r => {
    const created = r.created_at
      ? new Date(String(r.created_at).replace(' ', 'T') + 'Z').getTime()
      : null;
    const wait_seconds = created ? Math.floor((now - created) / 1000) : null;
    const name = [r.firstname, r.middlename, r.lastname].filter(Boolean).join(' ') || r.student_id;
    return {
      id: r.id,
      name: name,
      exam_code: r.exam_code || r.bundle_code || '—',
      wait_seconds: wait_seconds
    };
  });

  res.json({
    pending_count: withWait.length,
    requests: withWait
  });
});

// GET /api/dashboard/theory-grading — pending theory work summary
router.get('/theory-grading', (req, res) => {
  const school_id = req.session.school_id;

  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'     THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status = 'marked'      THEN 1 ELSE 0 END) AS marked
    FROM theory_answers
    WHERE school_id = ?
  `).get(school_id);

  // Marked in the last 7 days
  const markedThisWeek = db.prepare(`
    SELECT COUNT(*) AS c FROM theory_answers
    WHERE school_id = ?
      AND status = 'marked'
      AND marked_at >= datetime('now', '-7 days')
  `).get(school_id).c;

  // Oldest pending (for urgency)
  const oldest = db.prepare(`
    SELECT MIN(submitted_at) AS oldest, COUNT(DISTINCT exam_code) AS exams
    FROM theory_answers
    WHERE school_id = ? AND status = 'pending'
  `).get(school_id);

  let oldestSeconds = null;
  if (oldest && oldest.oldest) {
    const oldestMs = new Date(String(oldest.oldest).replace(' ', 'T') + 'Z').getTime();
    oldestSeconds = Math.floor((Date.now() - oldestMs) / 1000);
  }

  res.json({
    pending:      counts.pending     || 0,
    in_progress:  counts.in_progress || 0,
    marked_week:  markedThisWeek,
    exams_with_pending: oldest ? (oldest.exams || 0) : 0,
    oldest_seconds: oldestSeconds
  });
});

module.exports = router;