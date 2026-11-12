// server/analytics.js
// Post-exam statistics, worked out from raw answers and Replay events.
// Item analysis covers objective questions (single-answer and true/false).
const db = require('../db/database');

const OBJECTIVE_TYPES = ['MCQ_SINGLE', 'TRUE_FALSE'];
const MAX_SEGMENT_MS = 10 * 60 * 1000;   // one unbroken stay on a question counts for at most 10 minutes
const MIN_ANSWERED_FOR_FLAG = 5;         // too few answers to say a question looks wrong
const HIGH_SKIP_RATE = 30;               // percent

function utcMs(value) {
  if (!value) return null;
  const s = String(value);
  const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); // SQLite times are UTC
  return Number.isNaN(ms) ? null : ms;
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<img\b[^>]*>/gi, ' [image] ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function difficultyLabel(p) {
  if (p === null) return '—';
  if (p >= 80) return 'Easy';
  if (p >= 50) return 'Moderate';
  if (p >= 30) return 'Hard';
  return 'Very hard';
}

const FLAG_TEXT = {
  review: 'A wrong option was chosen more often than the correct one. Check the answer key.',
  bad_key: 'The saved correct answer matches none of the options.',
  high_skip: 'Many candidates left this question unanswered.'
};

function examAnalytics(schoolId, examCode, opts) {
  opts = opts || {};
  const exam = db.prepare(
    'SELECT exam_code, exam_title, total_marks, passing_marks, questions_to_attempt FROM examinations WHERE exam_code = ? AND school_id = ?'
  ).get(examCode, schoolId);
  if (!exam) return null;

  const typeList = OBJECTIVE_TYPES.map(t => `'${t}'`).join(',');
  const questions = db.prepare(
    `SELECT question_id, question_text, correct_answer, marks FROM exam_questions
     WHERE exam_code = ? AND question_type IN (${typeList}) ORDER BY id ASC`
  ).all(examCode);
  const optionRows = db.prepare(`
    SELECT o.question_id, o.option_id, o.option_text, o.is_correct
    FROM exam_question_options o
    WHERE o.question_id IN (SELECT question_id FROM exam_questions WHERE exam_code = ?)
    ORDER BY o.id ASC
  `).all(examCode);

  // Latest submitted objective attempt for each candidate (bundle attempts included)
    const bundleOnly = opts.bundleOnly ? 1 : 0;
  const bundleCode = opts.bundleCode || null;
  const attempts = db.prepare(`
    SELECT sa.attempt_id, sa.student_id, sa.score, sa.started_at, sa.finished_at, sa.bundle_attempt_id,
           s.firstname, s.middlename, s.lastname
    FROM student_attempts sa
    LEFT JOIN students s ON s.student_id = sa.student_id
    WHERE sa.school_id = ? AND sa.exam_code = ? AND sa.section = 'A' AND sa.status = 'Submitted'
      AND (
        (? = 0 AND sa.bundle_attempt_id IS NULL)
        OR
        (? = 1 AND sa.bundle_attempt_id IN (
          SELECT bundle_attempt_id FROM student_bundle_attempts WHERE bundle_code = ? AND school_id = ?
        ))
      )
      AND sa.id IN (
        SELECT MAX(id) FROM student_attempts
        WHERE school_id = ? AND exam_code = ? AND section = 'A' AND status = 'Submitted'
          AND (
            (? = 0 AND bundle_attempt_id IS NULL)
            OR (? = 1 AND bundle_attempt_id IN (
              SELECT bundle_attempt_id FROM student_bundle_attempts WHERE bundle_code = ? AND school_id = ?
            ))
          )
        GROUP BY student_id)
  `).all(schoolId, examCode, bundleOnly, bundleOnly, bundleCode, schoolId, schoolId, examCode, bundleOnly, bundleOnly, bundleCode, schoolId);

  const questionsTotalMarks = questions.reduce((n, q) => n + (Number(q.marks) || 0), 0);
    const marksOf = new Map(questions.map(q => [q.question_id, Number(q.marks) || 0]));

  // ── Per-question scaffolding ──
  const qMap = new Map();
  questions.forEach((q, i) => {
    qMap.set(q.question_id, {
      number: i + 1, question_id: q.question_id, text: stripHtml(q.question_text),
      correctKey: norm(q.correct_answer), assigned: 0, answered: 0, correct: 0,
      picks: new Map(), timeSum: 0, timeN: 0, options: []
    });
  });
  for (const o of optionRows) {
    const q = qMap.get(o.question_id);
    if (q) q.options.push({ id: o.option_id, text: stripHtml(o.option_text), flagged: o.is_correct === 1 });
  }
   for (const q of qMap.values()) {
    // Check if the saved key matches an option ID or an option text
    const matchById = q.options.find(o => norm(o.id) === q.correctKey);
    const matchByText = q.options.find(o => norm(o.text) === q.correctKey);
    
    if (matchById) {
      q.correctKey = norm(matchById.id);
    } else if (matchByText) {
      q.correctKey = norm(matchByText.id);
    } else {
      // Fallback: if no match is found, use whichever option has the green checkmark
      const marked = q.options.find(o => o.flagged);
      if (marked) q.correctKey = norm(marked.id);
    }
  }

  const perAttempt = new Map();
  attempts.forEach(a => perAttempt.set(a.attempt_id, { assigned: new Set(), answered: 0, correct: 0 }));

  let timing = { attempts_with_events: 0, total_attempts: attempts.length };

  if (attempts.length) {
    const idsJson = JSON.stringify(attempts.map(a => a.attempt_id));

    for (const r of db.prepare(
      `SELECT attempt_id, question_id FROM attempt_questions WHERE section = 'A' AND attempt_id IN (SELECT value FROM json_each(?))`
    ).all(idsJson)) {
      const q = qMap.get(r.question_id);
      const pa = perAttempt.get(r.attempt_id);
      if (!q || !pa || pa.assigned.has(r.question_id)) continue;
      pa.assigned.add(r.question_id);
      q.assigned++;
    }

    const seen = new Set();
    for (const r of db.prepare(
      `SELECT attempt_id, question_id, answer FROM student_answers WHERE attempt_id IN (SELECT value FROM json_each(?))`
    ).all(idsJson)) {
      const q = qMap.get(r.question_id);
      const pa = perAttempt.get(r.attempt_id);
      const key = `${r.attempt_id}|${r.question_id}`;
      if (!q || !pa || !pa.assigned.has(r.question_id) || seen.has(key)) continue;
      seen.add(key);
      const ans = norm(r.answer);
      if (!ans) continue; // an empty answer counts as skipped
      q.answered++; pa.answered++;
      q.picks.set(ans, (q.picks.get(ans) || 0) + 1);
      if (ans === q.correctKey) { q.correct++; pa.correct++; }
    }

    // ── Time on each question, from Replay events ──
    // Time stops while the candidate is away from the tab or the screen is locked, and a single
    // unbroken stay counts for at most 10 minutes, so walking away doesn't distort the average.
    const endMs = new Map(attempts.map(a => [a.attempt_id, utcMs(a.finished_at)]));
    let cur = null, curQ = null, mark = 0, pauses = 0, times = null, sawQuestion = false;

    const addTime = (qid, ms) => {
      if (!qid || !(ms > 0)) return;
      times[qid] = (times[qid] || 0) + Math.min(ms, MAX_SEGMENT_MS);
    };
    const closeAttempt = () => {
      if (cur === null) return;
      if (curQ && pauses === 0) {
        const end = endMs.get(cur);
        if (end && end > mark) addTime(curQ, end - mark);
      }
      for (const [qid, ms] of Object.entries(times)) {
        const q = qMap.get(qid);
        if (q && ms >= 1000) { q.timeSum += ms; q.timeN++; }
      }
      if (sawQuestion) timing.attempts_with_events++;
    };

    const evStmt = db.prepare(`
      SELECT attempt_id, event_type, question_id, occurred_at FROM exam_events
      WHERE attempt_id IN (SELECT value FROM json_each(?))
        AND event_type IN ('question_opened','tab_hidden','tab_visible','screen_locked','screen_unlocked','page_loaded')
      ORDER BY attempt_id, occurred_at, id
    `);
    for (const r of evStmt.iterate(idsJson)) {
      if (r.attempt_id !== cur) {
        closeAttempt();
        cur = r.attempt_id; curQ = null; mark = 0; pauses = 0; times = {}; sawQuestion = false;
      }
      const t = utcMs(r.occurred_at);
      if (t === null) continue;
      switch (r.event_type) {
        case 'question_opened':
          if (curQ && pauses === 0) addTime(curQ, t - mark);
          curQ = r.question_id; mark = t; sawQuestion = true;
          break;
        case 'tab_hidden':
        case 'screen_locked':
          if (curQ && pauses === 0) addTime(curQ, t - mark);
          pauses++;
          break;
        case 'tab_visible':
        case 'screen_unlocked':
          if (pauses > 0) { pauses--; if (pauses === 0) mark = t; }
          break;
        case 'page_loaded': // a refresh: the time in between is unknown, so start fresh
          curQ = null; pauses = 0;
          break;
        default: break;
      }
    }
    closeAttempt();
  }

  // ── Per-question results ──
  const questionList = [...qMap.values()].map(q => {
    const skipped = q.assigned - q.answered;
    const difficulty = q.assigned > 0 ? pct(q.correct, q.assigned) : null;

    const options = q.options.map(o => {
      const count = q.picks.get(norm(o.id)) || 0;
      return { id: o.id, text: o.text, is_correct: norm(o.id) === q.correctKey, count, pct: pct(count, q.assigned) };
    });
    const known = options.reduce((n, o) => n + o.count, 0);
    const wrong = options.filter(o => !o.is_correct && o.count > 0).sort((a, b) => b.count - a.count);
    const topWrong = wrong[0] ? { text: wrong[0].text, count: wrong[0].count, pct: wrong[0].pct } : null;

    const flags = [];
    if (options.length > 0 && !options.some(o => o.is_correct)) flags.push('bad_key');
    else if (q.answered >= MIN_ANSWERED_FOR_FLAG && topWrong && topWrong.count > q.correct) flags.push('review');
    if (q.assigned >= MIN_ANSWERED_FOR_FLAG && pct(skipped, q.assigned) >= HIGH_SKIP_RATE) flags.push('high_skip');

    return {
      number: q.number, question_id: q.question_id, text: q.text,
      assigned: q.assigned, answered: q.answered, skipped, skip_rate: pct(skipped, q.assigned),
      correct: q.correct, difficulty, difficulty_label: difficultyLabel(difficulty),
      avg_seconds: q.timeN ? Math.round(q.timeSum / q.timeN / 1000) : null, time_samples: q.timeN,
      top_wrong: topWrong, no_answer: skipped, other: Math.max(0, q.answered - known),
      flags, flag_text: flags.map(f => FLAG_TEXT[f]), options
    };
  });

  // ── Candidates and summary ──
  const rows = attempts.map(a => {
    const pa = perAttempt.get(a.attempt_id);
    const start = utcMs(a.started_at), end = utcMs(a.finished_at);
    const seconds = start !== null && end !== null && end >= start ? Math.round((end - start) / 1000) : null;
    const score = Number.isFinite(Number(a.score)) && a.score !== null ? Number(a.score) : null;
    return {
      name: [a.firstname, a.middlename, a.lastname].filter(Boolean).join(' ') || a.student_id,
      score, passed: score !== null && score >= Number(exam.passing_marks || 0),
      assigned: pa.assigned.size, answered: pa.answered, correct: pa.correct,
      skipped: pa.assigned.size - pa.answered, seconds, in_bundle: !!a.bundle_attempt_id,
      max_score: [...pa.assigned].reduce((n, id) => n + (marksOf.get(id) || 0), 0)
    };
  });

  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i > 0 && r.score === rows[i - 1].score ? rows[i - 1].rank : i + 1; });

  const scores = rows.map(r => r.score).filter(s => s !== null);
  const withQuestions = rows.filter(r => r.assigned > 0);
  const durations = rows.map(r => r.seconds).filter(s => s !== null && s > 0);
  const passed = rows.filter(r => r.passed).length;
    const maxes = rows.map(r => r.max_score).filter(m => m > 0);
  const examTotal = exam.questions_to_attempt > 0 && maxes.length ? round1(avg(maxes)) : questionsTotalMarks;

  return {
    exam: {
      exam_code: exam.exam_code, title: exam.exam_title, passing_marks: exam.passing_marks,
      questions_total_marks: examTotal, questions_to_attempt: exam.questions_to_attempt
    },
    summary: {
      candidates: rows.length,
      average_score: round1(avg(scores)), median_score: median(scores),
      highest_score: scores.length ? Math.max(...scores) : null,
      lowest_score: scores.length ? Math.min(...scores) : null,
      passed, pass_rate: pct(passed, rows.length),
      avg_percent_correct: round1(avg(withQuestions.map(r => (r.correct / r.assigned) * 100))),
      avg_minutes_to_finish: durations.length ? round1(avg(durations) / 60) : null,
      in_bundle: rows.filter(r => r.in_bundle).length
    },
    timing,
    questions: questionList,
    candidates: rows
  };
}

function bundleAnalytics(schoolId, bundleCode) {
  const bundle = db.prepare(
      'SELECT bundle_code, bundle_title FROM exam_bundles WHERE bundle_code = ?'
  ).get(bundleCode);
  if (!bundle) return null;

   const items = db.prepare(
    'SELECT exam_code, item_order FROM exam_bundle_items WHERE bundle_code = ? ORDER BY item_order'
  ).all(bundleCode);
  // console.log('[bundleAnalytics]', bundleCode, 'items:', items);

  const parts = [];
  for (const it of items) {
    const part = examAnalytics(schoolId, it.exam_code, { bundleOnly: true, bundleCode });
    if (part) parts.push({ order: it.item_order, ...part });
  }

  const candidates = parts.reduce((n, p) => n + p.summary.candidates, 0);
  return {
    kind: 'bundle',
    bundle: { code: bundleCode, title: bundle.bundle_title },
    items: parts,
    summary: { candidates }
  };
}

module.exports = { examAnalytics, bundleAnalytics, stripHtml, FLAG_TEXT };