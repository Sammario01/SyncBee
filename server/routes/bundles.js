// server/routes/bundles.js
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');

router.use(requireAdminSession);

function generateBundleCode(schoolId) {
  const t = Math.floor(Date.now()).toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `BUNDLE-SCH${schoolId}-${t}-${random}`;
}

// Recalculates total_duration_minutes from the SUM of its items' durations —
// called after every item add/remove/reorder, never set manually by the admin.
function recalculateBundleDuration(bundleCode) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(e.duration_minutes), 0) AS total
    FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ?
  `).get(bundleCode);
  db.prepare('UPDATE exam_bundles SET total_duration_minutes = ? WHERE bundle_code = ?')
    .run(row.total, bundleCode);
}

// CREATE
router.post('/', (req, res) => {
  const school_id = req.session.school_id;
    const {
    bundle_title, description, class_id, program_id, is_global,
    navigation_mode, show_result, start_time, end_time, published, anti_cheat_enabled
  } = req.body;

  if (!bundle_title || !start_time || !end_time) {
    return res.status(400).json({ error: 'bundle_title, start_time, and end_time are required' });
  }

  const bundle_code = generateBundleCode(school_id);

    db.prepare(`
    INSERT INTO exam_bundles
      (school_id, bundle_code, bundle_title, description, class_id, program_id, is_global,
       navigation_mode, show_result, start_time, end_time, published, anti_cheat_enabled, created_by)
    VALUES (@school_id, @bundle_code, @bundle_title, @description, @class_id, @program_id, @is_global,
            @navigation_mode, @show_result, @start_time, @end_time, @published, @anti_cheat_enabled, @created_by)
  `).run({
    school_id, bundle_code, bundle_title,
    description: description || null,
    class_id: class_id || null,
    program_id: program_id || null,
    is_global: is_global ? 1 : 0,
    navigation_mode: navigation_mode || 'strict_sequential',
    show_result: show_result || 'After Publish',
    start_time, end_time,
    published: published ? 1 : 0,
    anti_cheat_enabled: anti_cheat_enabled ? 1 : 0,
    created_by: 'admin'
  });

  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ?').get(bundle_code);
  res.status(201).json(bundle);
});

// LIST
router.get('/', (req, res) => {
  const bundles = db.prepare('SELECT * FROM exam_bundles WHERE school_id = ? ORDER BY created_at DESC')
    .all(req.session.school_id);
  res.json(bundles);
});

// GET ONE (with items)
router.get('/:bundle_code', (req, res) => {
  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .get(req.params.bundle_code, req.session.school_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const items = db.prepare(`
    SELECT bi.id, bi.item_order, e.exam_code, e.exam_title, e.duration_minutes, e.total_marks
    FROM exam_bundle_items bi
    INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ?
    ORDER BY bi.item_order ASC
  `).all(req.params.bundle_code);

  res.json({ ...bundle, items });
});

// UPDATE
router.put('/:bundle_code', (req, res) => {
  const existing = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .get(req.params.bundle_code, req.session.school_id);
  if (!existing) return res.status(404).json({ error: 'Bundle not found' });

  const merged = { ...existing, ...req.body };
  merged.is_global = req.body.is_global !== undefined ? (req.body.is_global ? 1 : 0) : existing.is_global;
  merged.published = req.body.published !== undefined ? (req.body.published ? 1 : 0) : existing.published;
  merged.anti_cheat_enabled = req.body.anti_cheat_enabled !== undefined ? (req.body.anti_cheat_enabled ? 1 : 0) : existing.anti_cheat_enabled;  merged.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(`
    UPDATE exam_bundles SET
      bundle_title = @bundle_title, description = @description, class_id = @class_id, program_id = @program_id,
      is_global = @is_global, navigation_mode = @navigation_mode, show_result = @show_result,
      start_time = @start_time, end_time = @end_time, published = @published,
      anti_cheat_enabled = @anti_cheat_enabled, updated_at = @updated_at
    WHERE bundle_code = @bundle_code
  `).run(merged);

  res.json(db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ?').get(req.params.bundle_code));
});

// DELETE
router.delete('/:bundle_code', (req, res) => {
  const result = db.prepare('DELETE FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .run(req.params.bundle_code, req.session.school_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Bundle not found' });
  db.prepare('DELETE FROM exam_bundle_items WHERE bundle_code = ?').run(req.params.bundle_code);
  res.status(204).send();
});

// SET ITEMS (replace the whole ordered list in one call — simplest for a reorderable UI)
// Body: { exam_codes: ['EXAM1', 'EXAM2', 'EXAM3'] }  — order in the array = order in the bundle
router.post('/:bundle_code/items', (req, res) => {
  const bundle = db.prepare('SELECT * FROM exam_bundles WHERE bundle_code = ? AND school_id = ?')
    .get(req.params.bundle_code, req.session.school_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const { exam_codes } = req.body;
  if (!Array.isArray(exam_codes) || exam_codes.length === 0) {
    return res.status(400).json({ error: 'exam_codes must be a non-empty array' });
  }

  const setItems = db.transaction((codes) => {
    db.prepare('DELETE FROM exam_bundle_items WHERE bundle_code = ?').run(req.params.bundle_code);
    const insert = db.prepare('INSERT INTO exam_bundle_items (bundle_code, exam_code, item_order) VALUES (?, ?, ?)');
    codes.forEach((code, i) => insert.run(req.params.bundle_code, code, i + 1));
  });
  setItems(exam_codes);

  recalculateBundleDuration(req.params.bundle_code);

  const items = db.prepare(`
    SELECT bi.item_order, e.exam_code, e.exam_title, e.duration_minutes
    FROM exam_bundle_items bi INNER JOIN examinations e ON bi.exam_code = e.exam_code
    WHERE bi.bundle_code = ? ORDER BY bi.item_order ASC
  `).all(req.params.bundle_code);
  const total_duration_minutes = db.prepare('SELECT total_duration_minutes FROM exam_bundles WHERE bundle_code = ?')
    .get(req.params.bundle_code).total_duration_minutes;

  res.json({ items, total_duration_minutes });
});

module.exports = router;