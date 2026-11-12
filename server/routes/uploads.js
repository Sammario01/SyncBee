// server/routes/uploads.js
// Images added to questions on this computer. They are saved next to the images that sync brings
// in from the cloud, so the exam page shows both the same way.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { requireAdminSession } = require('./auth');
const { uploadsDir } = require('../paths');

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Judge the file by what it really is, never by the name or type the browser claims.
function detect(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// POST /api/uploads/question-image   (the image itself is the request body)
router.post('/question-image', requireAdminSession, express.raw({ type: TYPES, limit: '8mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Choose a PNG, JPG, GIF or WebP image (up to 8 MB).' });
  }
  const ext = detect(req.body);
  if (!ext) return res.status(400).json({ error: 'That file is not a valid PNG, JPG, GIF or WebP image.' });

  const name = `LQ-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), req.body);
  res.status(201).json({ url: `/uploads/question_images/${name}`, filename: name });
});

router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That image is larger than 8 MB.' });
  next(err);
});

module.exports = router;