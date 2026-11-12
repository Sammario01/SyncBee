// server/riskEngine.js
// Rule-based "review priority" score. Every point comes from a named rule with a plain
// reason, so an administrator can always see WHY someone is flagged. It prompts a human
// to look. It is never proof of cheating, and nothing here punishes anyone automatically.
// Scoring is kept separate from data loading, so a learned model can replace
// scoreMetrics() later without touching the routes or pages.
const db = require('../db/database');

const ENGINE_VERSION = 1;

const DEFAULT_CONFIG = {
  thresholds: { yellow: 20, red: 50 },
  rules: {
    fullscreen_exits:  { enabled: true, points: 8,  cap: 40 },
    tab_switches:      { enabled: true, points: 6,  cap: 36 },
    long_away:         { enabled: true, points: 12, threshold: 90 },
    fast_answers:      { enabled: true, points: 20, threshold: 3, min_count: 5 },
    answer_changes:    { enabled: true, points: 8,  threshold: 8 },
    reconnects:        { enabled: true, points: 6,  threshold: 3 },
    page_refreshes:    { enabled: true, points: 6,  threshold: 2 },
    anti_cheat_submit: { enabled: true, points: 45 }
  }
};

// Drives the settings screen and the validation of what it sends back.
const RULES = [
  { id: 'fullscreen_exits', label: 'Left fullscreen',
    help: 'Points for each time the candidate left fullscreen mode.',
    fields: [{ key: 'points', label: 'Points each', min: 0, max: 100 }, { key: 'cap', label: 'Maximum points', min: 0, max: 100 }] },
  { id: 'tab_switches', label: 'Switched away from the exam tab',
    help: 'Points for each time the candidate moved to another tab or window.',
    fields: [{ key: 'points', label: 'Points each', min: 0, max: 100 }, { key: 'cap', label: 'Maximum points', min: 0, max: 100 }] },
  { id: 'long_away', label: 'Long time away from the exam',
    help: 'Total time spent away from the exam tab.',
    fields: [{ key: 'threshold', label: 'Flag after (seconds away)', min: 10, max: 7200 }, { key: 'points', label: 'Points', min: 0, max: 100 }] },
  { id: 'fast_answers', label: 'Answering unusually fast',
    help: 'Objective questions answered almost as soon as they were opened. This can mean guessing or knowing the answers in advance.',
    fields: [{ key: 'threshold', label: 'Counts as fast if within (seconds)', min: 1, max: 60 }, { key: 'min_count', label: 'Flag after this many fast answers', min: 1, max: 500 }, { key: 'points', label: 'Points', min: 0, max: 100 }] },
  { id: 'answer_changes', label: 'Many answer changes',
    help: 'Objective answers changed again and again.',
    fields: [{ key: 'threshold', label: 'Flag after (changes)', min: 2, max: 500 }, { key: 'points', label: 'Points', min: 0, max: 100 }] },
  { id: 'reconnects', label: 'Repeated connection loss',
    help: 'The exam page lost its connection to the server. This is often a network fault, not the candidate, so keep it low.',
    fields: [{ key: 'threshold', label: 'Flag after (times)', min: 1, max: 100 }, { key: 'points', label: 'Points', min: 0, max: 100 }] },
  { id: 'page_refreshes', label: 'Refreshed the exam page',
    help: 'The candidate reloaded the exam page.',
    fields: [{ key: 'threshold', label: 'Flag after (refreshes)', min: 1, max: 100 }, { key: 'points', label: 'Points', min: 0, max: 100 }] },
  { id: 'anti_cheat_submit', label: 'Auto-submitted for violations',
    help: 'The exam ended automatically because of anti-cheat strikes.',
    fields: [{ key: 'points', label: 'Points', min: 0, max: 100 }] }
];

// ── Settings ──
let cached = null;

function mergeConfig(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!stored || typeof stored !== 'object') return out;
  if (stored.thresholds) {
    for (const k of ['yellow', 'red']) {
      if (Number.isFinite(stored.thresholds[k])) out.thresholds[k] = stored.thresholds[k];
    }
  }
  if (stored.rules) {
    for (const rule of RULES) {
      const s = stored.rules[rule.id];
      if (!s) continue;
      if (typeof s.enabled === 'boolean') out.rules[rule.id].enabled = s.enabled;
      for (const f of rule.fields) {
        if (Number.isFinite(s[f.key])) out.rules[rule.id][f.key] = s[f.key];
      }
    }
  }
  return out;
}

function getConfig() {
  if (cached) return cached;
  let stored = null;
  try {
    const row = db.prepare('SELECT config FROM risk_settings WHERE id = 1').get();
    if (row) stored = JSON.parse(row.config);
  } catch (err) { stored = null; }
  cached = mergeConfig(stored);
  return cached;
}

function sanitizeConfig(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid settings.' };

  const t = input.thresholds || {};
  const yellow = Number(t.yellow);
  const red = Number(t.red);
  if (!Number.isInteger(yellow) || !Number.isInteger(red) || yellow < 1 || red > 100 || red <= yellow) {
    return { error: 'Yellow and red levels must be whole numbers from 1 to 100, with red higher than yellow.' };
  }

  const rules = {};
  for (const rule of RULES) {
    const given = (input.rules && input.rules[rule.id]) || {};
    const out = { enabled: given.enabled === true };
    for (const f of rule.fields) {
      const raw = given[f.key] === undefined ? DEFAULT_CONFIG.rules[rule.id][f.key] : given[f.key];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < f.min || v > f.max) {
        return { error: `${rule.label}: "${f.label}" must be a whole number from ${f.min} to ${f.max}.` };
      }
      out[f.key] = v;
    }
    rules[rule.id] = out;
  }
  return { config: { thresholds: { yellow, red }, rules } };
}

function saveConfig(config) {
  db.prepare(`
    INSERT INTO risk_settings (id, config, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(config));
  cached = mergeConfig(config);
  return cached;
}

// ── Measuring one attempt ──
// events: [{ type, qid, t (ms), nav }] oldest first.
// ctx: { cfg, theoryIds:Set, endMs, incidents:{fullscreen_exit, tab_switch}, submissionReason }
const METRIC_KEYS = ['fullscreen_exits', 'tab_switches', 'away_seconds', 'fast_answers',
  'answer_changes', 'reconnects', 'page_refreshes', 'anti_cheat_submit', 'events'];

function computeMetrics(events, ctx) {
  const m = {};
  METRIC_KEYS.forEach(k => { m[k] = 0; });
  m.events = events.length;

  const fastWindowMs = ctx.cfg.rules.fast_answers.threshold * 1000;
  const firstOpened = {};
  const answeredOnce = new Set();
  let hiddenAt = null;

  for (const e of events) {
    switch (e.type) {
      case 'fullscreen_lost': m.fullscreen_exits++; break;
      case 'tab_hidden':
        m.tab_switches++;
        if (hiddenAt === null) hiddenAt = e.t;
        break;
      case 'tab_visible':
        if (hiddenAt !== null) { m.away_seconds += Math.max(0, (e.t - hiddenAt) / 1000); hiddenAt = null; }
        break;
      case 'connection_lost': m.reconnects++; break;
      case 'page_loaded': if (e.nav === 'reload') m.page_refreshes++; break;
      case 'question_opened':
        if (e.qid && firstOpened[e.qid] === undefined) firstOpened[e.qid] = e.t;
        break;
      case 'answer_selected':
        // Only the FIRST pick on an objective question counts, measured from the FIRST time it was opened.
        if (e.qid && !ctx.theoryIds.has(e.qid) && !answeredOnce.has(e.qid)) {
          answeredOnce.add(e.qid);
          if (firstOpened[e.qid] !== undefined && e.t - firstOpened[e.qid] <= fastWindowMs) m.fast_answers++;
        }
        break;
      case 'answer_changed':
        if (e.qid && !ctx.theoryIds.has(e.qid)) m.answer_changes++;
        break;
      default: break;
    }
  }
  if (hiddenAt !== null) m.away_seconds += Math.max(0, (ctx.endMs - hiddenAt) / 1000); // still away

  // Attempts from before Replay existed have no events: fall back to the strike log.
  m.fullscreen_exits = Math.max(m.fullscreen_exits, (ctx.incidents && ctx.incidents.fullscreen_exit) || 0);
  m.tab_switches = Math.max(m.tab_switches, (ctx.incidents && ctx.incidents.tab_switch) || 0);
  m.anti_cheat_submit = ctx.submissionReason === 'anti_cheat' ? 1 : 0;
  return m;
}

function mergeMetrics(list) {
  const out = {};
  METRIC_KEYS.forEach(k => { out[k] = 0; });
  for (const m of list) METRIC_KEYS.forEach(k => { out[k] += m[k] || 0; });
  out.anti_cheat_submit = out.anti_cheat_submit > 0 ? 1 : 0;
  return out;
}

function fmtSeconds(s) {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

// ── Turning measurements into a score with reasons ──
function scoreMetrics(m, cfg) {
  const R = cfg.rules;
  const reasons = [];
  const add = (rule, label, detail, points) => {
    if (points > 0) reasons.push({ rule, label, detail, points: Math.round(points) });
  };

  if (R.fullscreen_exits.enabled && m.fullscreen_exits > 0) {
    add('fullscreen_exits', 'Left fullscreen', `Left fullscreen ${m.fullscreen_exits} time(s)`,
      Math.min(R.fullscreen_exits.cap, m.fullscreen_exits * R.fullscreen_exits.points));
  }
  if (R.tab_switches.enabled && m.tab_switches > 0) {
    add('tab_switches', 'Switched away from the exam tab', `Switched away from the exam tab ${m.tab_switches} time(s)`,
      Math.min(R.tab_switches.cap, m.tab_switches * R.tab_switches.points));
  }
  if (R.long_away.enabled && m.away_seconds >= R.long_away.threshold) {
    add('long_away', 'Long time away', `Spent ${fmtSeconds(m.away_seconds)} away from the exam tab`, R.long_away.points);
  }
  if (R.fast_answers.enabled && m.fast_answers >= R.fast_answers.min_count) {
    add('fast_answers', 'Answering unusually fast',
      `${m.fast_answers} objective answer(s) given within ${R.fast_answers.threshold}s of first opening the question`, R.fast_answers.points);
  }
  if (R.answer_changes.enabled && m.answer_changes >= R.answer_changes.threshold) {
    add('answer_changes', 'Many answer changes', `Changed objective answers ${m.answer_changes} times`, R.answer_changes.points);
  }
  if (R.reconnects.enabled && m.reconnects >= R.reconnects.threshold) {
    add('reconnects', 'Repeated connection loss',
      `Lost connection to the server ${m.reconnects} time(s). Often a network fault, not the candidate`, R.reconnects.points);
  }
  if (R.page_refreshes.enabled && m.page_refreshes >= R.page_refreshes.threshold) {
    add('page_refreshes', 'Refreshed the exam page', `Refreshed the exam page ${m.page_refreshes} time(s)`, R.page_refreshes.points);
  }
  if (R.anti_cheat_submit.enabled && m.anti_cheat_submit > 0) {
    add('anti_cheat_submit', 'Auto-submitted for violations', 'The exam was submitted automatically because of anti-cheat strikes', R.anti_cheat_submit.points);
  }

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  const level = score >= cfg.thresholds.red ? 'red' : score >= cfg.thresholds.yellow ? 'yellow' : 'green';
  reasons.sort((a, b) => b.points - a.points);
  return { score, level, reasons };
}

module.exports = {
  ENGINE_VERSION, DEFAULT_CONFIG, RULES,
  getConfig, sanitizeConfig, saveConfig,
  computeMetrics, mergeMetrics, scoreMetrics
};