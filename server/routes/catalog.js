// server/routes/catalog.js
// Classes, programs and subjects. Cloud-synced rows are read-only here (the next
// sync would overwrite an edit); rows created on this computer can be renamed or deleted.
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');
const { LOCAL_ID_START, nextLocalId } = require('../localIds');

router.use(requireAdminSession);

// Table and column names below are fixed constants, never taken from the request.
const ENTITIES = {
  classes: {
    table: 'classes', idCol: 'id', nameCol: 'name', hasCode: false,
    listSql: `
      SELECT c.id AS id, c.name AS name, NULL AS code,
             (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS students,
             (SELECT COUNT(*) FROM examinations e WHERE e.class_id = c.id) AS exams
      FROM classes c WHERE c.school_id = ? ORDER BY c.name COLLATE NOCASE`,
    usage: [
      ['SELECT COUNT(*) AS c FROM students WHERE class_id = ?', 'student(s)'],
      ['SELECT COUNT(*) AS c FROM examinations WHERE class_id = ?', 'exam(s)'],
      ['SELECT COUNT(*) AS c FROM exam_bundles WHERE class_id = ?', 'bundle(s)']
    ],
    insert: (id, schoolId, name) => db.prepare(`
      INSERT INTO classes (id, school_id, class_teacher_id, name, compartment, class_type, create_date)
      VALUES (?, ?, '', ?, '', '', CURRENT_TIMESTAMP)`).run(id, schoolId, name),
    update: (id, name) => db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, id)
  },
  programs: {
    table: 'programs', idCol: 'id', nameCol: 'program_name', hasCode: true,
    listSql: `
      SELECT p.id AS id, p.program_name AS name, p.program_code AS code,
             (SELECT COUNT(*) FROM students s WHERE s.program_id = p.id) AS students,
             (SELECT COUNT(*) FROM examinations e WHERE e.program_id = p.id) AS exams
      FROM programs p WHERE p.school_id = ? ORDER BY p.program_name COLLATE NOCASE`,
    usage: [
      ['SELECT COUNT(*) AS c FROM students WHERE program_id = ?', 'student(s)'],
      ['SELECT COUNT(*) AS c FROM examinations WHERE program_id = ?', 'exam(s)'],
      ['SELECT COUNT(*) AS c FROM exam_bundles WHERE program_id = ?', 'bundle(s)']
    ],
    insert: (id, schoolId, name, code) => db.prepare(
      'INSERT INTO programs (id, school_id, program_name, program_code) VALUES (?, ?, ?, ?)'
    ).run(id, schoolId, name, code || null),
    update: (id, name, code) => db.prepare(
      'UPDATE programs SET program_name = ?, program_code = ? WHERE id = ?'
    ).run(name, code || null, id)
  },
  subjects: {
    table: 'subjects', idCol: 'subject_id', nameCol: 'subject_name', hasCode: true,
    listSql: `
      SELECT s.subject_id AS id, s.subject_name AS name, s.subject_code AS code,
             0 AS students,
             (SELECT COUNT(*) FROM examinations e WHERE e.subject_id = s.subject_id) AS exams
      FROM subjects s WHERE s.school_id = ? ORDER BY s.subject_name COLLATE NOCASE`,
    usage: [
      ['SELECT COUNT(*) AS c FROM examinations WHERE subject_id = ?', 'exam(s)']
    ],
    insert: (id, schoolId, name, code) => db.prepare(
      'INSERT INTO subjects (subject_id, school_id, subject_name, subject_code) VALUES (?, ?, ?, ?)'
    ).run(id, schoolId, name, code || null),
    update: (id, name, code) => db.prepare(
      'UPDATE subjects SET subject_name = ?, subject_code = ? WHERE subject_id = ?'
    ).run(name, code || null, id)
  }
};

function entityOf(req, res) {
  const e = ENTITIES[req.params.type];
  if (!e) { res.status(404).json({ error: 'Unknown type.' }); return null; }
  return e;
}

function readFields(e, body) {
  const name = String((body && body.name) || '').replace(/\s+/g, ' ').trim();
  const code = e.hasCode ? String((body && body.code) || '').trim().toUpperCase().slice(0, 20) : null;
  if (!name) return { error: 'A name is required.' };
  if (name.length > 100) return { error: 'The name must be 100 characters or fewer.' };
  return { name, code };
}

function nameTaken(e, schoolId, name, exceptId) {
  return !!db.prepare(
    `SELECT 1 FROM ${e.table} WHERE school_id = ? AND LOWER(${e.nameCol}) = LOWER(?) AND ${e.idCol} != ? LIMIT 1`
  ).get(schoolId, name, exceptId);
}

// Only rows created on this computer may be changed.
function localIdOrReject(e, req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid ID.' }); return null; }
  if (id < LOCAL_ID_START) {
    res.status(403).json({ error: 'This one is managed in your Mariobee cloud account, so it cannot be changed here.' });
    return null;
  }
  const row = db.prepare(`SELECT ${e.idCol} AS id FROM ${e.table} WHERE ${e.idCol} = ? AND school_id = ?`)
    .get(id, req.session.school_id);
  if (!row) { res.status(404).json({ error: 'Not found.' }); return null; }
  return id;
}

router.get('/:type', (req, res) => {
  const e = entityOf(req, res);
  if (!e) return;
  const rows = db.prepare(e.listSql).all(req.session.school_id)
    .map(r => ({ ...r, is_local: r.id >= LOCAL_ID_START }));
  res.json(rows);
});

router.post('/:type', (req, res) => {
  const e = entityOf(req, res);
  if (!e) return;
  const f = readFields(e, req.body);
  if (f.error) return res.status(400).json({ error: f.error });

  const schoolId = req.session.school_id;
  if (nameTaken(e, schoolId, f.name, 0)) return res.status(409).json({ error: `"${f.name}" already exists.` });

  const id = nextLocalId(req.params.type);
  e.insert(id, schoolId, f.name, f.code);
  res.status(201).json({ id, name: f.name, code: f.code });
});

router.put('/:type/:id', (req, res) => {
  const e = entityOf(req, res);
  if (!e) return;
  const id = localIdOrReject(e, req, res);
  if (id === null) return;

  const f = readFields(e, req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  if (nameTaken(e, req.session.school_id, f.name, id)) return res.status(409).json({ error: `"${f.name}" already exists.` });

  e.update(id, f.name, f.code);
  res.json({ success: true });
});

router.delete('/:type/:id', (req, res) => {
  const e = entityOf(req, res);
  if (!e) return;
  const id = localIdOrReject(e, req, res);
  if (id === null) return;

  const used = e.usage
    .map(([sql, what]) => ({ n: db.prepare(sql).get(id).c, what }))
    .filter(u => u.n > 0);
  if (used.length) {
    return res.status(409).json({ error: `It is still used by ${used.map(u => `${u.n} ${u.what}`).join(', ')}. Move or remove those first.` });
  }

  db.prepare(`DELETE FROM ${e.table} WHERE ${e.idCol} = ?`).run(id);
  res.json({ success: true });
});

module.exports = router;