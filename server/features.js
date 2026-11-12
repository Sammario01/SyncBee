// server/features.js
// Optional features the administrator has to switch on. Everything here is OFF until enabled.
// effective state = what the administrator chose. (A future license layer can cap it here.)
const db = require('../db/database');

const DEFINITIONS = [
  { key: 'hand_raise', group: 'During the exam', label: 'Candidate help requests',
    description: 'Shows a “Need Help?” button on the candidate’s screen. Requests appear on the Live Monitor.',
    note: null },
  { key: 'hall_control', group: 'During the exam', label: 'Live exam-hall control',
    description: 'Lets you lock every candidate screen, send announcements, and submit all exams at once from the Live Monitor. While this is on, each candidate computer checks in with this server every few seconds.',
    note: 'Turning this off unlocks any screens that are currently locked.' },
  { key: 'replay_recording', group: 'Review and integrity', label: 'Record exam activity for Replay',
    description: 'Keeps a timestamped log of what each candidate did (questions opened, answers changed, leaving fullscreen, connection drops) so an exam can be replayed afterwards. No video, screenshots or keystrokes are recorded.',
    note: 'Exams taken while this is off cannot be replayed in full, and “time per question” in Analytics needs it.' },
  { key: 'risk_scoring', group: 'Review and integrity', label: 'Risk scoring and Classroom Heat Map',
    description: 'Gives every candidate a review score based on their behavior and shows the live Classroom Heat Map. A high score is a reason to look closer, never proof of cheating.',
    note: 'Works best with activity recording turned on.' }
];

const DEFAULTS = {};
DEFINITIONS.forEach(d => { DEFAULTS[d.key] = false; });

let cache = null;

function readAll() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT feature_key, enabled FROM feature_flags').all()) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, r.feature_key)) out[r.feature_key] = r.enabled === 1;
  }
  return out;
}

function all() {
  if (!cache) cache = readAll();
  return { ...cache };
}

function isEnabled(key) {
  return all()[key] === true;
}

// What a candidate's exam page needs to know. Nothing about review or integrity features.
function forCandidates() {
  const a = all();
  return { hand_raise: a.hand_raise, hall_control: a.hall_control, replay_recording: a.replay_recording };
}

function setMany(changes) {
  const before = all();
  const upsert = db.prepare(`
    INSERT INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(feature_key) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const [key, value] of Object.entries(changes)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key) && typeof value === 'boolean') upsert.run(key, value ? 1 : 0);
    }
  })();
  cache = null;
  const after = all();
  // Switching hall control off must not leave screens locked, or they'd lock again the moment it is switched back on.
  if (before.hall_control && !after.hall_control) db.prepare('UPDATE exam_locks SET locked = 0').run();
  return after;
}

function requireFeature(key, message) {
  return (req, res, next) => {
    if (isEnabled(key)) return next();
    const msg = message || 'This feature is switched off. Turn it on under Features.';
    res.status(403).json({ success: false, status: 'error', code: 'FEATURE_DISABLED', error: msg, message: msg });
  };
}

module.exports = { DEFINITIONS, all, isEnabled, forCandidates, setMany, requireFeature };