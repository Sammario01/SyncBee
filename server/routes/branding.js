// server/routes/branding.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

// GET /api/branding — PUBLIC, no login required. The login page itself needs
// to know the school's colors/logo before anyone has authenticated.
router.get('/', (req, res) => {
  const row = db.prepare('SELECT * FROM branding WHERE id = 1').get();
  res.json(row || {});
});

// POST /api/branding — admin only
router.post('/', requireAdminSession, (req, res) => {
  const { school_display_name, logo_data_uri, color_primary, color_accent, color_success } = req.body;

  db.prepare(`
    INSERT INTO branding (id, school_display_name, logo_data_uri, color_primary, color_accent, color_success, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      school_display_name=excluded.school_display_name, logo_data_uri=excluded.logo_data_uri,
      color_primary=excluded.color_primary, color_accent=excluded.color_accent,
      color_success=excluded.color_success, updated_at=excluded.updated_at
  `).run(school_display_name || null, logo_data_uri || null, color_primary || null, color_accent || null, color_success || null);

  res.json({ success: true });
});

module.exports = router;