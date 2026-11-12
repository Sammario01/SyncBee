// server/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../../db/database');
const license = require('../../license/manager');
const deviceRegistry = require('../deviceRegistry');

// POST /api/auth/login
// Body: { username, password }  — mirrors PHP's auth.php student branch.
// (super_admin/schools login intentionally not built yet — separate step)
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const user = db.prepare(
    `SELECT * FROM students WHERE student_id = ? COLLATE NOCASE AND role = 'student' LIMIT 1`
  ).get(username.trim());

  if (!user || !bcrypt.compareSync(password.trim(), user.pass)) {
    return res.status(401).json({ success: false, message: 'Invalid student ID or password.' });
  }

  // Establish the server-side session — this is what makes every later request
  // from this browser trustworthy without re-sending credentials each time.
    // Seat check happens AFTER the password is verified, so wrong-password
      if (user.active_status === 0) {
    return res.status(403).json({
      success: false,
      message: 'This account has been deactivated. Please see your exam supervisor.'
    });
  }
  
  // attempts never use up a seat.
  const seat = deviceRegistry.registerCandidateDevice({
    schoolId: user.school_id,
    deviceId: req.body.device_id,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    studentId: user.student_id
  });
  if (!seat.allowed) {
    return res.status(403).json({
      success: false,
      code: 'CAPACITY_REACHED',
      message: `This center has reached its licensed limit of ${seat.max} candidate computers. Please see your exam supervisor.`
    });
  }


  req.session.role = 'student';
  req.session.student_id = user.student_id;
  req.session.school_id = user.school_id;
  req.session.class_id = user.class_id;
  req.session.program_id = user.program_id;
  req.session.full_name = `${user.firstname} ${user.lastname}`;
  req.session.device_id = seat.device_id;

  // Track this session under its device so "Free Seat" can log it out later.
  if (seat.device_id && req.app.locals.sessionsByDevice) {
    const map = req.app.locals.sessionsByDevice;
    if (!map.has(seat.device_id)) map.set(seat.device_id, new Set());
    map.get(seat.device_id).add(req.sessionID);
  }

  res.json({
    success: true,
    student_id: user.student_id,
    school_id: user.school_id,
    full_name: req.session.full_name
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const deviceId = req.session && req.session.device_id;
  const sid = req.sessionID;

  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });

    // Drop this session from the device index.
    if (deviceId && req.app.locals.sessionsByDevice) {
      const set = req.app.locals.sessionsByDevice.get(deviceId);
      if (set) {
        set.delete(sid);
        if (set.size === 0) req.app.locals.sessionsByDevice.delete(deviceId);
      }
    }

    // Release the seat: no more active session on this device = free seat.
        // Release the seat: clear the current student, but KEEP the seat label (B2)
    if (deviceId) {
      try {
        const db = require('../../db/database');
        db.prepare(`
          UPDATE candidate_devices 
          SET last_student_id = NULL 
          WHERE device_id = ?
        `).run(deviceId);
      } catch (e) { /* swallow — logout must always succeed */ }
    }

    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// POST /api/auth/admin-login
// Body: { email, password } — verified against the license file, fully offline.
router.post('/admin-login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const result = license.verifyAdminLogin(email.trim(), password.trim());

  if (!result.success) {
    return res.status(401).json({ success: false, message: result.message });
  }

  // school_id lives in the session only from here on — never in a response body.
  req.session.role = 'admin';
  req.session.school_id = result.school_id;
  req.session.admin_email = result.email;

  res.json({ success: true, email: result.email });
});



// GET /api/auth/admin-me — lets admin pages check "am I logged in?"
router.get('/admin-me', (req, res) => {
  if (req.session.role !== 'admin' || !req.session.school_id) {
    return res.status(401).json({ success: false, message: 'Not logged in.' });
  }
  res.json({ success: true, email: req.session.admin_email });
});

// GET /api/auth/me — lets the frontend check "am I logged in?" on page load
router.get('/me', (req, res) => {
  if (!req.session.student_id) {
    return res.status(401).json({ success: false, message: 'Not logged in.' });
  }
  res.json({
    success: true,
    student_id: req.session.student_id,
    school_id: req.session.school_id,
    full_name: req.session.full_name
  });
});

// Middleware other routes can reuse to require a logged-in student
function requireStudentSession(req, res, next) {
  if (!req.session.student_id) {
    return res.status(401).json({ success: false, message: 'Not logged in.' });
  }
  next();
}

function requireAdminSession(req, res, next) {
  if (req.session.role !== 'admin' || !req.session.school_id) {
    return res.status(401).json({ success: false, message: 'Not logged in.' });
  }
  next();
}

module.exports = router;
module.exports.requireStudentSession = requireStudentSession;
module.exports.requireAdminSession = requireAdminSession;