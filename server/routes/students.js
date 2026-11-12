// server/routes/students.js
// Student registration, credentials and bulk upload.
// Cloud-synced students are read-only here (the next sync would overwrite edits) but can be
// deactivated. Students created on this computer are "local" and fully manageable.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../db/database');
const { requireAdminSession } = require('./auth');
const { nextLocalId } = require('../localIds');

router.use(requireAdminSession);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L
const BCRYPT_COST = 10;
const MAX_IMPORT_ROWS = 2000;
const MAX_COMMIT_CHUNK = 100;

function generatePassword() {
  let out = '';
  for (let i = 0; i < 8; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

function tidy(value) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeGender(value) {
  const g = String(value ?? '').trim().toLowerCase();
  if (g === '') return '';
  if (g === 'm' || g === 'male') return 'Male';
  if (g === 'f' || g === 'female') return 'Female';
  return null; // not understood
}

function toId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readOptions(o) {
  o = o || {};
  return {
    create_missing: !!o.create_missing,
    allow_duplicates: !!o.allow_duplicates,
    default_class_id: toId(o.default_class_id),
    default_program_id: toId(o.default_program_id)
  };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── Validation (used by preview, bulk import and single registration) ──
function buildContext(schoolId, options) {
  const classes = new Map();
  db.prepare('SELECT id, name FROM classes WHERE school_id = ?').all(schoolId)
    .forEach(c => classes.set(String(c.name).trim().toLowerCase(), { id: c.id, name: c.name }));

  const programs = new Map();
  db.prepare('SELECT id, program_name AS name FROM programs WHERE school_id = ?').all(schoolId)
    .forEach(p => programs.set(String(p.name).trim().toLowerCase(), { id: p.id, name: p.name }));

  const findById = (map, id) => {
    for (const v of map.values()) if (v.id === id) return v;
    return null;
  };

  return {
    schoolId, options, classes, programs,
    defaultClass: options.default_class_id ? findById(classes, options.default_class_id) : null,
    defaultProgram: options.default_program_id ? findById(programs, options.default_program_id) : null,
    idExists: db.prepare('SELECT 1 FROM students WHERE student_id = ? COLLATE NOCASE'),
    regExists: db.prepare('SELECT 1 FROM students WHERE school_id = ? AND registration_number = ? COLLATE NOCASE'),
    nameExists: db.prepare(`
      SELECT 1 FROM students
      WHERE school_id = ? AND LOWER(firstname) = ? AND LOWER(middlename) = ? AND LOWER(lastname) = ?
        AND IFNULL(class_id, 0) = ? AND IFNULL(program_id, 0) = ?
      LIMIT 1`),
    seenIds: new Set(), seenRegs: new Set(), seenNames: new Set()
  };
}

function validateRow(raw, ctx) {
  const errors = [];
  const warnings = [];

  const firstname = tidy(raw.firstname);
  const middlename = tidy(raw.middlename);
  const lastname = tidy(raw.lastname);
  const registration_number = tidy(raw.registration_number);
  const requestedId = String(raw.student_id ?? '').trim();
  const password = String(raw.password ?? '').trim();
  const classText = tidy(raw.class);
  const programText = tidy(raw.program);
  const gender = normalizeGender(raw.gender);

  if (!firstname) errors.push('First name is required.');
  if (!lastname) errors.push('Last name is required.');
  if (firstname.length > 50 || middlename.length > 50 || lastname.length > 50) errors.push('Each name must be 50 characters or fewer.');
  if (registration_number.length > 30) errors.push('Registration number must be 30 characters or fewer.');
  if (gender === null) errors.push('Gender must be Male or Female, or left blank.');
  if (password && (password.length < 6 || password.length > 64)) errors.push('Password must be 6 to 64 characters.');

  if (requestedId) {
    const key = requestedId.toLowerCase();
    if (!ID_PATTERN.test(requestedId)) errors.push('Student ID can only use letters, numbers, dot, dash and underscore (2 to 40 characters).');
    else if (ctx.seenIds.has(key)) errors.push('This student ID appears more than once in the upload.');
    else if (ctx.idExists.get(requestedId)) errors.push('This student ID is already in use.');
    ctx.seenIds.add(key);
  }

  if (registration_number) {
    const key = registration_number.toLowerCase();
    if (ctx.seenRegs.has(key)) errors.push('This registration number appears more than once in the upload.');
    else if (ctx.regExists.get(ctx.schoolId, registration_number)) errors.push('This registration number is already in use.');
    ctx.seenRegs.add(key);
  }

  let class_id = null, class_name = null, create_class = false;
  if (classText) {
    if (classText.length > 100) errors.push('Class name is too long.');
    const hit = ctx.classes.get(classText.toLowerCase());
    if (hit) { class_id = hit.id; class_name = hit.name; }
    else if (ctx.options.create_missing) { create_class = true; class_name = classText; }
    else errors.push(`Class "${classText}" does not exist. Tick "Create missing classes" or add it first.`);
  } else if (ctx.defaultClass) {
    class_id = ctx.defaultClass.id; class_name = ctx.defaultClass.name;
  }

  let program_id = null, program_name = null, create_program = false;
  if (programText) {
    if (programText.length > 100) errors.push('Program name is too long.');
    const hit = ctx.programs.get(programText.toLowerCase());
    if (hit) { program_id = hit.id; program_name = hit.name; }
    else if (ctx.options.create_missing) { create_program = true; program_name = programText; }
    else errors.push(`Program "${programText}" does not exist. Tick "Create missing programs" or add it first.`);
  } else if (ctx.defaultProgram) {
    program_id = ctx.defaultProgram.id; program_name = ctx.defaultProgram.name;
  }

  if (!class_name && !program_name && !errors.length) {
    warnings.push('No class or program: this candidate will only see exams marked Global.');
  }

  let duplicate = false;
  if (!errors.length) {
    const classKey = create_class ? `new:${class_name.toLowerCase()}` : String(class_id || 0);
    const programKey = create_program ? `new:${program_name.toLowerCase()}` : String(program_id || 0);
    const nameKey = [firstname, middlename, lastname].map(s => s.toLowerCase()).join('|') + '#' + classKey + '#' + programKey;

    if (ctx.seenNames.has(nameKey)) {
      duplicate = true;
      warnings.push('Same name and class/program appears earlier in this upload.');
    } else if (!create_class && !create_program &&
        ctx.nameExists.get(ctx.schoolId, firstname.toLowerCase(), middlename.toLowerCase(), lastname.toLowerCase(), class_id || 0, program_id || 0)) {
      duplicate = true;
      warnings.push('A student with the same name and class/program already exists.');
    }
    ctx.seenNames.add(nameKey);
  }

  return {
    status: errors.length ? 'error' : (duplicate ? 'duplicate' : 'ok'),
    errors, warnings,
    clean: { student_id: requestedId, firstname, middlename, lastname, gender: gender || '', registration_number, password },
    class_id, class_name, create_class, program_id, program_name, create_program
  };
}

// ── Creating students ──
function ensureCatalogRow(table, schoolId, name) {
  const col = table === 'classes' ? 'name' : 'program_name';
  const found = db.prepare(`SELECT id FROM ${table} WHERE school_id = ? AND LOWER(${col}) = LOWER(?)`).get(schoolId, name);
  if (found) return found.id;

  const id = nextLocalId(table);
  if (table === 'classes') {
    db.prepare(`INSERT INTO classes (id, school_id, class_teacher_id, name, compartment, class_type, create_date)
                VALUES (?, ?, '', ?, '', '', CURRENT_TIMESTAMP)`).run(id, schoolId, name);
  } else {
    db.prepare('INSERT INTO programs (id, school_id, program_name) VALUES (?, ?, ?)').run(id, schoolId, name);
  }
  return id;
}

function nextStudentNumber() {
  let max = 0;
  for (const r of db.prepare("SELECT student_id FROM students WHERE student_id LIKE 'STU-%'").all()) {
    const m = /^STU-(\d+)$/i.exec(r.student_id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// Validates, hashes (async, so the exam server never freezes), then inserts the whole
// batch in ONE transaction. Never trusts the browser's earlier preview.
async function createStudents(schoolId, rawRows, options) {
  const ctx = buildContext(schoolId, options);
  const created = [], skipped = [], failed = [], plan = [];

  rawRows.forEach((raw, i) => {
    const line = raw && raw.line != null ? raw.line : i + 1;
    const v = validateRow(raw || {}, ctx);
    if (v.status === 'error') failed.push({ line, reason: v.errors.join(' ') });
    else if (v.status === 'duplicate' && !options.allow_duplicates) skipped.push({ line, reason: v.warnings.join(' ') });
    else plan.push({ line, v });
  });

  for (const item of plan) {
    item.password = item.v.clean.password || generatePassword();
    item.hash = await bcrypt.hash(item.password, BCRYPT_COST);
  }

  // Explicit IDs first, so an auto-generated ID can never take one that was asked for.
  const ordered = [
    ...plan.filter(p => p.v.clean.student_id),
    ...plan.filter(p => !p.v.clean.student_id)
  ];

  const insert = db.prepare(`
    INSERT INTO students
      (student_id, registration_number, school_id, class_id, program_id, firstname, middlename, lastname,
       email, gender, religion, state, nationality, pass, role, image, joined, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N/A', 'N/A', 'N/A', ?, 'student', 'default.png', ?, 'local')
  `);
  const idTaken = db.prepare('SELECT 1 FROM students WHERE student_id = ? COLLATE NOCASE');

  db.transaction(() => {
    let counter = nextStudentNumber();
    for (const item of ordered) {
      const v = item.v;
      const classId = v.create_class ? ensureCatalogRow('classes', schoolId, v.class_name) : v.class_id;
      const programId = v.create_program ? ensureCatalogRow('programs', schoolId, v.program_name) : v.program_id;

      let studentId = v.clean.student_id;
      if (!studentId) {
        do { studentId = `STU-${String(counter++).padStart(5, '0')}`; } while (idTaken.get(studentId));
      }

      insert.run(
        studentId, v.clean.registration_number || null, schoolId, classId, programId,
        v.clean.firstname, v.clean.middlename, v.clean.lastname,
        `${studentId}@syncbee.local`, v.clean.gender, item.hash, todayIso()
      );

      created.push({
        line: item.line, student_id: studentId, password: item.password,
        firstname: v.clean.firstname, middlename: v.clean.middlename, lastname: v.clean.lastname,
        class_name: v.class_name, program_name: v.program_name
      });
    }
  })();

  created.sort((a, b) => a.line - b.line);
  return { created, skipped, failed };
}

// ── Routes ──

// GET /api/students — roster for the admin page
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT s.student_id, s.firstname, s.middlename, s.lastname, s.gender, s.registration_number,
           s.class_id, c.name AS class_name, s.program_id, p.program_name AS program_name,
           s.origin, s.active_status AS active,
           (SELECT COUNT(*) FROM student_attempts a WHERE a.student_id = s.student_id) AS attempts
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN programs p ON s.program_id = p.id
    WHERE s.school_id = ?
    ORDER BY s.firstname COLLATE NOCASE, s.lastname COLLATE NOCASE
  `).all(req.session.school_id);
  res.json(rows);
});

// Bulk upload, step 1: check every row, write nothing
router.post('/import/validate', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'There are no rows to check.' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `Upload at most ${MAX_IMPORT_ROWS} students at a time.` });

  const ctx = buildContext(req.session.school_id, readOptions(req.body.options));
  const newClasses = new Set();
  const newPrograms = new Set();

  const out = rows.map((raw, i) => {
    const v = validateRow(raw || {}, ctx);
    if (v.status !== 'error') {
      if (v.create_class) newClasses.add(v.class_name);
      if (v.create_program) newPrograms.add(v.program_name);
    }
    return {
      index: i, status: v.status, errors: v.errors, warnings: v.warnings,
      name: [v.clean.firstname, v.clean.middlename, v.clean.lastname].filter(Boolean).join(' '),
      student_id: v.clean.student_id, class_name: v.class_name, program_name: v.program_name
    };
  });

  res.json({ rows: out, new_classes: [...newClasses], new_programs: [...newPrograms] });
});

// Bulk upload, step 2: create one chunk (the page sends 25 at a time)
router.post('/import/commit', async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > MAX_COMMIT_CHUNK) {
    return res.status(400).json({ error: `Send between 1 and ${MAX_COMMIT_CHUNK} students at a time.` });
  }
  try {
    res.json(await createStudents(req.session.school_id, rows, readOptions(req.body.options)));
  } catch (err) {
    console.error('[students] import batch failed:', err.message);
    res.status(500).json({ error: 'This batch could not be saved. Nothing from it was created.' });
  }
});

// POST /api/students — register one student
router.post('/', async (req, res) => {
  const schoolId = req.session.school_id;
  const b = req.body || {};

  const classId = toId(b.class_id);
  const programId = toId(b.program_id);
  const classRow = classId ? db.prepare('SELECT name FROM classes WHERE id = ? AND school_id = ?').get(classId, schoolId) : null;
  const programRow = programId ? db.prepare('SELECT program_name FROM programs WHERE id = ? AND school_id = ?').get(programId, schoolId) : null;
  if (classId && !classRow) return res.status(400).json({ error: 'That class no longer exists.' });
  if (programId && !programRow) return res.status(400).json({ error: 'That program no longer exists.' });

  try {
    const result = await createStudents(schoolId, [{
      firstname: b.firstname, middlename: b.middlename, lastname: b.lastname, gender: b.gender,
      registration_number: b.registration_number, student_id: b.student_id, password: b.password,
      class: classRow ? classRow.name : '', program: programRow ? programRow.program_name : ''
    }], readOptions({ allow_duplicates: b.confirm_duplicate === true }));

    if (result.failed.length) return res.status(400).json({ error: result.failed[0].reason });
    if (result.skipped.length) return res.status(409).json({ code: 'POSSIBLE_DUPLICATE', error: result.skipped[0].reason });
    res.status(201).json(result.created[0]);
  } catch (err) {
    console.error('[students] register failed:', err.message);
    res.status(500).json({ error: 'The student could not be saved.' });
  }
});

function findStudent(studentId, schoolId) {
  return db.prepare('SELECT * FROM students WHERE student_id = ? AND school_id = ?').get(studentId, schoolId);
}

const CLOUD_MESSAGE = 'This student is managed in your Mariobee cloud account, so it cannot be changed here.';

// PUT /api/students/:student_id — edit a local student
router.put('/:student_id', (req, res) => {
  const schoolId = req.session.school_id;
  const s = findStudent(req.params.student_id, schoolId);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  if (s.origin !== 'local') return res.status(403).json({ error: CLOUD_MESSAGE });

  const b = req.body || {};
  const firstname = tidy(b.firstname), middlename = tidy(b.middlename), lastname = tidy(b.lastname);
  const registration_number = tidy(b.registration_number);
  const gender = normalizeGender(b.gender);

  if (!firstname || !lastname) return res.status(400).json({ error: 'First name and last name are required.' });
  if (firstname.length > 50 || middlename.length > 50 || lastname.length > 50) return res.status(400).json({ error: 'Each name must be 50 characters or fewer.' });
  if (registration_number.length > 30) return res.status(400).json({ error: 'Registration number must be 30 characters or fewer.' });
  if (gender === null) return res.status(400).json({ error: 'Gender must be Male or Female, or left blank.' });

  const classId = toId(b.class_id);
  const programId = toId(b.program_id);
  if (classId && !db.prepare('SELECT 1 FROM classes WHERE id = ? AND school_id = ?').get(classId, schoolId)) {
    return res.status(400).json({ error: 'That class no longer exists.' });
  }
  if (programId && !db.prepare('SELECT 1 FROM programs WHERE id = ? AND school_id = ?').get(programId, schoolId)) {
    return res.status(400).json({ error: 'That program no longer exists.' });
  }
  if (registration_number && db.prepare(
    'SELECT 1 FROM students WHERE school_id = ? AND registration_number = ? COLLATE NOCASE AND student_id != ?'
  ).get(schoolId, registration_number, s.student_id)) {
    return res.status(409).json({ error: 'This registration number is already in use.' });
  }

  db.prepare(`
    UPDATE students
    SET firstname = ?, middlename = ?, lastname = ?, gender = ?, registration_number = ?,
        class_id = ?, program_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE student_id = ?
  `).run(firstname, middlename, lastname, gender || '', registration_number || null, classId, programId, s.student_id);

  res.json({ success: true });
});

// POST /api/students/:student_id/reset-password — local students only
router.post('/:student_id/reset-password', async (req, res) => {
  const s = findStudent(req.params.student_id, req.session.school_id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  if (s.origin !== 'local') return res.status(403).json({ error: CLOUD_MESSAGE });

  const custom = String((req.body && req.body.password) || '').trim();
  if (custom && (custom.length < 6 || custom.length > 64)) return res.status(400).json({ error: 'Password must be 6 to 64 characters.' });

  const password = custom || generatePassword();
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  db.prepare('UPDATE students SET pass = ?, updated_at = CURRENT_TIMESTAMP WHERE student_id = ?').run(hash, s.student_id);
  res.json({ student_id: s.student_id, password });
});

// POST /api/students/:student_id/active — works on cloud students too (the sync never touches this)
router.post('/:student_id/active', (req, res) => {
  const active = req.body && req.body.active ? 1 : 0;
  const result = db.prepare('UPDATE students SET active_status = ? WHERE student_id = ? AND school_id = ?')
    .run(active, req.params.student_id, req.session.school_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Student not found.' });
  res.json({ success: true, active });
});

// DELETE /api/students/:student_id — local students with no exam history only
router.delete('/:student_id', (req, res) => {
  const s = findStudent(req.params.student_id, req.session.school_id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  if (s.origin !== 'local') return res.status(403).json({ error: CLOUD_MESSAGE });

  const attempts = db.prepare('SELECT COUNT(*) AS c FROM student_attempts WHERE student_id = ?').get(s.student_id).c;
  if (attempts > 0) {
    return res.status(409).json({ error: `This student has ${attempts} exam attempt(s) on record. Deactivate them instead, so results and audit trails stay intact.` });
  }

  db.prepare('DELETE FROM students WHERE student_id = ?').run(s.student_id);
  res.json({ success: true });
});

module.exports = router;