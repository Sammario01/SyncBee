// server/routes/features.js
const express = require('express');
const router = express.Router();
const features = require('../features');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

// GET /api/features: current switches + the descriptions the settings page shows
router.get('/', (req, res) => {
  res.json({ features: features.all(), definitions: features.DEFINITIONS });
});

// PUT /api/features   Body: { features: { hand_raise: true, ... } }
router.put('/', (req, res) => {
  const input = req.body && req.body.features;
  if (!input || typeof input !== 'object') return res.status(400).json({ error: 'No settings were sent.' });

  const changes = {};
  for (const d of features.DEFINITIONS) {
    if (typeof input[d.key] === 'boolean') changes[d.key] = input[d.key];
  }
  res.json({ success: true, features: features.setMany(changes) });
});

module.exports = router;