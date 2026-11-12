// server/licenseScheduler.js
// Checks in with Mariobee at startup and then every 6 hours (every 10 minutes
// while locked, so a restored license unlocks quickly). Also reports how many
// candidate seats are in use, so Mariobee can see usage per school.
const db = require('../db/database');
const license = require('../license/manager');

const NORMAL_MS = 6 * 60 * 60 * 1000;
const LOCKED_MS = 10 * 60 * 1000;

let timer = null;
let running = false;

function candidateSeatsUsed() {
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM candidate_devices').get().c;
  } catch (err) {
    return null;
  }
}

function schedule() {
  clearTimeout(timer);
  const delay = license.getLicenseMode().mode === 'locked' ? LOCKED_MS : NORMAL_MS;
  timer = setTimeout(runNow, delay);
  if (timer.unref) timer.unref();
}

async function runNow() {
  if (running) return null;
  running = true;
  try {
    return await license.checkInOnline({ candidateSeatsUsed: candidateSeatsUsed() });
  } catch (err) {
    return { reachable: false, changed: false, message: err.message };
  } finally {
    running = false;
    schedule();
  }
}

function start() {
  const t = setTimeout(runNow, 5000);
  if (t.unref) t.unref();
}

module.exports = { start, runNow, reschedule: schedule };