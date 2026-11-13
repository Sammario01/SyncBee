// server/app.js
const express = require('express');
const app = express();

const path = require('path');
app.use('/uploads/question_images', express.static(require('./paths').uploadsDir));

app.use(express.json({ limit: '1mb' }));

const session = require('express-session');
const sessionStore = new session.MemoryStore();
app.locals.sessionStore = sessionStore;

// device_id -> Set of session IDs currently logged in from that device.
// Used by "Free Seat" so freeing a seat also logs that machine out.
const sessionsByDevice = new Map();
app.locals.sessionsByDevice = sessionsByDevice;

// Wrap the store so we know the moment a session is destroyed (logout,
// expiry, or our own manual kill) and can clean up the index.
const origDestroy = sessionStore.destroy.bind(sessionStore);
sessionStore.destroy = function (sid, cb) {
  // Remove sid from any device bucket it belongs to.
  for (const [, set] of sessionsByDevice) set.delete(sid);
  return origDestroy(sid, cb);
};

app.use(session({
  secret: 'syncbee-local-session-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const licenseGate = require('./licenseGate');
app.use(licenseGate); // must come after the session middleware and before every router

const examsRouter = require('./routes/exams');
app.use('/api/exams', examsRouter);

const featuresRouter = require('./routes/features');
app.use('/api/features', featuresRouter);

const analyticsRouter = require('./routes/analytics');
app.use('/api/analytics', analyticsRouter);

const incidentsRouter = require('./routes/incidents');
app.use('/api/incidents', incidentsRouter);

const replayRouter = require('./routes/replay');
app.use('/api/replay', replayRouter);

const riskRouter = require('./routes/risk');
app.use('/api/risk', riskRouter);

const catalogRouter = require('./routes/catalog');
app.use('/api/catalog', catalogRouter);

const syncRouter = require('./routes/sync');
app.use('/api/sync', syncRouter);

const broadcastRouter = require('./routes/broadcast');
app.use('/api/broadcast', broadcastRouter);

const bundleAttemptsRouter = require('./routes/bundle-attempts');
app.use('/api/bundle-attempts', bundleAttemptsRouter);

const bundlesRouter = require('./routes/bundles');
app.use('/api/bundles', bundlesRouter);

const questionsRouter = require('./routes/questions');
app.use('/api/questions', questionsRouter);

const systemAlertsRouter = require('./routes/system-alerts');
app.use('/api/system/alerts', systemAlertsRouter);

const gradingRouter = require('./routes/grading');
app.use('/api/grading', gradingRouter);

const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);

const resultsRouter = require('./routes/results');
app.use('/api/results', resultsRouter);

const systemRouter = require('./routes/system');
app.use('/api/system', systemRouter);

const brandingRouter = require('./routes/branding');
app.use('/api/branding', brandingRouter);

const questionImportRouter = require('./routes/question-import');
app.use('/api/question-import', questionImportRouter);

const monitorRouter = require('./routes/monitor');
app.use('/api/monitor', monitorRouter);

const studentPortalRouter = require('./routes/student-portal');
app.use('/api/student', studentPortalRouter);

const dashboardRouter = require('./routes/dashboard');
app.use('/api/dashboard', dashboardRouter);

const studentsRouter = require('./routes/students');
app.use('/api/students', studentsRouter);

app.use('/api/sync', require('./routes/sync-prep-questions'));

const attemptsRouter = require('./routes/attempts');
app.use('/api/attempts', attemptsRouter);

const uploadsRouter = require('./routes/uploads');
app.use('/api/uploads', uploadsRouter);

const licenseRouter = require('./routes/license');
app.use('/api/license', licenseRouter);

const devicesRouter = require('./routes/devices');
app.use('/api/devices', devicesRouter);

const PORT = 4000;
app.set('port', PORT);
const server = app.listen(PORT, (err) => {
  if (err) return; // Express 5 also calls this when the port is taken; the handler below explains it
  require('./licenseScheduler').start();
  console.log(`Syncbee local server running at http://localhost:${PORT}`);

  // Kick off the daily auto-backup scheduler once the server is up.
  try {
  } catch (err) {
    console.error('[app] Failed to start backup scheduler:', err.message);
  }
});

server.on('error', (err) => {
  const msg = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use by another program. Close it, or restart this computer, and open SyncBee again.`
    : `The exam server could not start: ${err.message}`;
  console.error('[server]', msg);
  try { require('electron').dialog.showErrorBox('SyncBee', msg); } catch (e) { /* not running inside the desktop app */ }
  process.exit(1);
});


// Tells the UI what version is actually installed, so the footer/login pages
// don't show a hardcoded version that goes stale after every update.
app.get('/api/version', (req, res) => res.json({ version: require('../package.json').version }));

app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/login'));

module.exports = app;