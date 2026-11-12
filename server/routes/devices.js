// server/routes/devices.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const license = require('../../license/manager');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// GET /api/devices: seat usage + every registered candidate computer.
// The raw device ID is never sent to the browser.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT cd.id, cd.last_ip, cd.user_agent, cd.first_seen_at, cd.last_seen_at, cd.seat_label,
           s.firstname, s.middlename, s.lastname
    FROM candidate_devices cd
    LEFT JOIN students s ON cd.last_student_id = s.student_id
    WHERE cd.school_id = ?
    ORDER BY cd.id ASC
  `).all(req.session.school_id);

  const devices = rows.map(r => ({
    id: r.id,
    last_ip: r.last_ip,
    user_agent: r.user_agent,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    seat_label: r.seat_label,
    last_student_name: [r.firstname, r.middlename, r.lastname].filter(Boolean).join(' ') || null
  }));

  res.json({ max: license.getLicenseLimits().max_candidate_computers, used: devices.length, devices });
});

// PUT /api/devices/:id/seat: where this computer sits in the room (A1, B12…). Blank clears it.
router.put('/:id/seat', (req, res) => {
  const raw = String((req.body && req.body.seat_label) || '').trim().toUpperCase().replace(/\s+/g, '');
  if (raw && !/^[A-Z]{1,2}-?\d{1,3}$/.test(raw)) {
    return res.status(400).json({ error: 'Use a row letter and a number, like A1, B12 or AA3.' });
  }
  const label = raw ? raw.replace('-', '') : null;

  const device = db.prepare('SELECT id FROM candidate_devices WHERE id = ? AND school_id = ?')
    .get(req.params.id, req.session.school_id);
  if (!device) return res.status(404).json({ error: 'Computer not found' });

  if (label) {
    const taken = db.prepare('SELECT 1 FROM candidate_devices WHERE school_id = ? AND seat_label = ? AND id != ?')
      .get(req.session.school_id, label, device.id);
    if (taken) return res.status(409).json({ error: `Position ${label} is already assigned to another computer.` });
  }

  db.prepare('UPDATE candidate_devices SET seat_label = ? WHERE id = ?').run(label, device.id);
  res.json({ success: true, seat_label: label });
});

// DELETE /api/devices/:id: free a licensed seat
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM candidate_devices WHERE id = ? AND school_id = ?')
    .run(req.params.id, req.session.school_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Seat not found' });
  res.json({ success: true });
});

module.exports = router;