// server/questionImport.js
// Bulk question import: reads an Excel/CSV/pasted sheet, checks every row, and saves the good
// ones in exactly the form the Question Builder saves them (so scoring, shuffling and pools all
// work with imported questions).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { uploadsDir } = require('./paths');

const MAX_ROWS = 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const UPLOADED_URL = /^\/uploads\/question_images\/LQ-[a-z0-9-]+\.(png|jpg|gif|webp)$/;
const LETTERS = ['a', 'b', 'c', 'd', 'e'];
const LIMITS = { question: 4000, option: 1000, explanation: 2000, instructions: 2000, model_answer: 4000 };

// ── Column headings the sheet may use (matched ignoring case, spaces and punctuation) ──
const FIELD_ALIASES = {
  type: ['type', 'questiontype', 'kind', 'format'],
  question: ['question', 'questiontext', 'questions', 'stem'],
  correct: ['correct', 'correctanswer', 'correctoption', 'answer', 'ans', 'key', 'rightanswer'],
  marks: ['marks', 'mark', 'score', 'points', 'point'],
  difficulty: ['difficulty', 'level', 'difficultylevel'],
  explanation: ['explanation', 'explain', 'solution', 'rationale'],
  image: ['image', 'picture', 'questionimage', 'questionpicture', 'img', 'photo', 'imagefile'],
  answer_mode: ['answermode', 'mode', 'responsemode'],
  instructions: ['instructions', 'studentinstructions', 'instruction'],
  max_words: ['maxwords', 'wordlimit', 'words'],
  time_limit: ['timelimit', 'timelimitminutes', 'minutes', 'time'],
  model_answer: ['modelanswer', 'markingguide', 'sampleanswer']
};
LETTERS.forEach(l => {
  FIELD_ALIASES['option_' + l] = ['option' + l, l, 'choice' + l, 'answer' + l];
  FIELD_ALIASES['image_' + l] = ['image' + l, 'option' + l + 'image', 'picture' + l, 'option' + l + 'picture', 'img' + l];
});
const HEADER_TO_FIELD = new Map();
Object.entries(FIELD_ALIASES).forEach(([field, names]) => names.forEach(n => { if (!HEADER_TO_FIELD.has(n)) HEADER_TO_FIELD.set(n, field); }));

const TYPE_ALIASES = {
  MCQ_SINGLE: ['mcq', 'mcqsingle', 'multiplechoice', 'objective', 'single', 'singlechoice', 'mc', 'choice'],
  TRUE_FALSE: ['tf', 'truefalse', 'trueorfalse', 'boolean', 'tof'],
  THEORY: ['theory', 'essay', 'subjective', 'longanswer', 'written']
};
const UNSUPPORTED_TYPES = ['mcqmultiple', 'multipleanswer', 'multipleanswers', 'multipleselect', 'multiselect', 'shortanswer', 'fillintheblank'];

function userError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}
const normKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ───────────────────────── reading the sheet ─────────────────────────
function parseDelimited(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const d = counts[best] > 0 ? best : ',';

  const rows = [];
  let row = [], field = '';
  inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"' && field === '') {
      inQ = true;
    } else if (ch === d) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map((values, i) => ({ line: i + 1, values }));
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.result !== undefined && v.result !== null) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result);
    if (v.text !== undefined) return typeof v.text === 'object' && Array.isArray(v.text.richText) ? v.text.richText.map(t => t.text).join('') : String(v.text);
    return '';
  }
  return String(v);
}

async function tableFromXlsx(buf) {
  const ExcelJS = require('exceljs'); // not installed -> MODULE_NOT_FOUND, handled by the route
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); }
  catch (e) { throw userError('That file could not be read as an Excel (.xlsx) workbook. Save it again as .xlsx or .csv.'); }
  const sheet = wb.worksheets.find(ws => ws.name.trim().toLowerCase() === 'questions')
    || wb.worksheets.find(ws => ws.actualRowCount > 0 && ws.name.trim().toLowerCase() !== 'instructions');
  if (!sheet) throw userError('The workbook has no sheet with questions in it.');
  const width = sheet.columnCount;
  const table = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = [];
    for (let c = 1; c <= width; c++) values.push(cellText(row.getCell(c)));
    table.push({ line: rowNumber, values });
  });
  return table;
}

async function readRows(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw userError('The file is empty.');
  const isXlsx = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  let table;
  if (isXlsx) table = await tableFromXlsx(buf);
  else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder('windows-1252').decode(buf); } // an older Excel "CSV"
    table = parseDelimited(text);
  }

  const headerAt = table.findIndex(r => r.values.some(v => String(v).trim() !== ''));
  if (headerAt < 0) throw userError('The file has no rows.');
  const headers = table[headerAt].values;
  const colField = new Array(headers.length).fill(null);
  const taken = new Set();
  const ignored = [];
  headers.forEach((h, i) => {
    const label = String(h ?? '').trim();
    if (!label) return;
    const field = HEADER_TO_FIELD.get(normKey(label));
    if (field && !taken.has(field)) { colField[i] = field; taken.add(field); }
    else ignored.push(label);
  });
  if (!taken.has('question')) {
    throw userError(`Could not find a "Question" column. Columns found: ${headers.filter(h => String(h).trim()).join(', ') || 'none'}. Download the template to see the expected headings.`);
  }

  const rows = [];
  for (const r of table.slice(headerAt + 1)) {
    const row = { line: r.line };
    let any = false;
    r.values.forEach((v, i) => {
      const f = colField[i];
      if (!f) return;
      const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
      row[f] = s;
      if (s) any = true;
    });
    if (any) rows.push(row);
  }
  if (rows.length === 0) throw userError('No question rows were found below the headings.');
  if (rows.length > MAX_ROWS) throw userError(`Upload at most ${MAX_ROWS} questions at a time. Split the file.`);
  return { rows, columns_found: [...taken], ignored_columns: ignored };
}

// ───────────────────────── checking one row ─────────────────────────
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}
const dupBase = (plain) => plain.toLowerCase().replace(/\s+/g, ' ').trim();
function dbKeyOfHtml(html) {
  return dupBase(stripHtml(html)) + (/<img\b/i.test(html) ? '||img' : '');
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function textToHtml(s, allowHtml) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  return allowHtml ? t : escapeText(t).replace(/\n/g, '<br>');
}
const imgTag = (url) => `<img src="${url}" style="max-width:100%;height:auto;" alt="">`;

function baseName(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
}

function makeContext(schoolId, examCode, o) {
  const exam = db.prepare('SELECT exam_code FROM examinations WHERE exam_code = ? AND school_id = ?').get(examCode, schoolId);
  if (!exam) return null;
  const images = new Map();
  (o.images || []).forEach(i => {
    const k = baseName(i.name);
    if (k && !images.has(k)) images.set(k, { size: Number(i.size) || 0, type: String(i.type || ''), url: i.url || null });
  });
  const existingKeys = new Set(
    db.prepare('SELECT question_text FROM exam_questions WHERE exam_code = ?').all(examCode).map(r => dbKeyOfHtml(r.question_text))
  );
  let defaultMarks = parseFloat(o.default_marks);
  if (!(defaultMarks > 0 && defaultMarks <= 1000)) defaultMarks = 1;
  return {
    schoolId, examCode, images, existingKeys, seen: new Set(),
    allowHtml: !!o.allow_html, allowDuplicates: !!o.allow_duplicates, defaultMarks, requireUrls: !!o.requireUrls
  };
}

// Finds the picture a cell names among the pictures the admin selected.
function findImage(value, ctx) {
  const raw = String(value ?? '').trim();
  if (!raw) return { none: true };
  if (UPLOADED_URL.test(raw)) {
    if (ctx.requireUrls && !fs.existsSync(path.join(uploadsDir, path.basename(raw)))) return { error: `Picture "${raw}" is not on this computer.` };
    return { key: raw, url: raw, uploaded: true };
  }
  let key = baseName(raw);
  let img = ctx.images.get(key);
  if (!img && !/\.[a-z0-9]+$/.test(key)) {
    const hits = IMAGE_EXT.map(e => `${key}.${e}`).filter(n => ctx.images.has(n));
    if (hits.length === 1) { key = hits[0]; img = ctx.images.get(key); }
    else if (hits.length > 1) return { error: `Picture "${raw}" matches more than one file. Write the full file name.` };
  }
  if (!img) return { error: `Picture "${raw}" was not among the pictures you selected.` };
  if (img.type && !IMAGE_TYPES.includes(img.type)) return { error: `"${raw}" is not a PNG, JPG, GIF or WebP picture.` };
  if (img.size > MAX_IMAGE_BYTES) return { error: `Picture "${raw}" is larger than 8 MB.` };
  if (ctx.requireUrls && !img.url) return { error: `Picture "${raw}" was not uploaded.` };
  if (ctx.requireUrls && !UPLOADED_URL.test(img.url)) return { error: `Picture "${raw}" has an invalid address.` };
  return { key, url: img.url || null };
}

function parseType(text, hasOptions, correctText) {
  const k = normKey(text);
  if (k) {
    for (const [type, names] of Object.entries(TYPE_ALIASES)) if (names.includes(k)) return { type };
    if (UNSUPPORTED_TYPES.includes(k)) return { error: 'Questions with several correct answers (or short answers) are not supported yet. Use MCQ, True/False or Theory.' };
    return { error: `Type "${text}" is not recognised. Use MCQ, True/False or Theory.` };
  }
  if (hasOptions >= 2) return { type: 'MCQ_SINGLE' };
  if (/^(true|t|false|f)$/i.test(String(correctText).trim())) return { type: 'TRUE_FALSE' };
  return { error: 'Type is missing. Use MCQ, True/False or Theory.' };
}

function parseMarks(v, dflt) {
  const s = String(v ?? '').trim();
  if (!s) return { value: dflt };
  const n = Number(s.includes('.') ? s : s.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return { error: `Marks "${s}" must be a number above 0 (up to 1000).` };
  return { value: n };
}

function resolveCorrect(correctRaw, opts) {
  const c = String(correctRaw ?? '').trim();
  if (!c) return { error: 'The correct answer is missing.' };
  const byLetter = (letter) => {
    const o = opts.find(x => x.letter === letter);
    return o ? { index: opts.indexOf(o) } : { error: `The correct answer ${letter.toUpperCase()} points to an empty option.` };
  };
  let m = /^(?:option\s*)?([a-e])[.)]?$/i.exec(c);
  if (m) return byLetter(m[1].toLowerCase());
  m = /^[1-5]$/.exec(c);
  if (m) return byLetter(LETTERS[Number(c) - 1]);
  const target = c.toLowerCase().replace(/\s+/g, ' ');
  const hits = opts.filter(o => o.text && o.text.toLowerCase().replace(/\s+/g, ' ') === target);
  if (hits.length === 1) return { index: opts.indexOf(hits[0]) };
  if (hits.length > 1) return { error: `The correct answer "${c}" matches more than one option. Use the letter instead.` };
  if (/^[a-e]([\s,;&/]+(and\s+)?[a-e])+$/i.test(c)) return { error: `More than one correct answer ("${c}"). Only one is supported.` };
  return { error: `The correct answer "${c}" does not match any option. Use a letter A to E.` };
}

function validateRow(row, ctx) {
  const errors = [];
  const warnings = [];
  const get = (k) => String(row[k] ?? '').trim();

  const text = get('question');
  if (!text) errors.push('The question is missing.');
  else if (text.length > LIMITS.question) errors.push(`The question is longer than ${LIMITS.question} characters.`);

  // pictures
  const imageKeys = [];
  const useImage = (value) => {
    const r = findImage(value, ctx);
    if (r.none) return null;
    if (r.error) { errors.push(r.error); return null; }
    if (!r.uploaded) imageKeys.push(r.key);
    return r;
  };
  const questionImage = useImage(row.image);

  // options as written
  const present = [];
  for (const l of LETTERS) {
    const t = get('option_' + l);
    const imageRaw = get('image_' + l);
    if (!t && !imageRaw) continue;
    if (t.length > LIMITS.option) errors.push(`Option ${l.toUpperCase()} is longer than ${LIMITS.option} characters.`);
    present.push({ letter: l, text: t, image: useImage(imageRaw) });
  }

  const t = parseType(get('type'), present.length, get('correct'));
  if (t.error) errors.push(t.error);
  const type = t.type || null;

  const marks = parseMarks(row.marks, ctx.defaultMarks);
  if (marks.error) errors.push(marks.error);

  let difficulty = null;
  const dRaw = get('difficulty').toLowerCase();
  if (dRaw) {
    const d = dRaw === 'moderate' ? 'medium' : dRaw;
    if (['easy', 'medium', 'hard'].includes(d)) difficulty = d;
    else errors.push(`Difficulty "${get('difficulty')}" must be easy, medium or hard.`);
  }
  const explanation = String(row.explanation ?? '').trim();
  if (explanation.length > LIMITS.explanation) errors.push(`The explanation is longer than ${LIMITS.explanation} characters.`);

  let options = [];
  let correctIndex = null;
  let answerMode = null, instructions = null, maxWords = null, timeLimit = null, modelAnswer = null;

  if (type === 'MCQ_SINGLE') {
    if (present.length < 2) errors.push('A multiple-choice question needs at least 2 options.');
    options = present;
    if (get('correct') || present.length >= 2) {
      const r = resolveCorrect(row.correct, present);
      if (r.error) errors.push(r.error); else correctIndex = r.index;
    }
    const texts = present.map(o => o.text.toLowerCase()).filter(Boolean);
    if (new Set(texts).size < texts.length) warnings.push('Two options have the same text.');
  } else if (type === 'TRUE_FALSE') {
    options = [{ letter: 'a', text: 'True', image: null }, { letter: 'b', text: 'False', image: null }];
    const c = get('correct').toLowerCase();
    if (/^(true|t)$/.test(c)) correctIndex = 0;
    else if (/^(false|f)$/.test(c)) correctIndex = 1;
    else errors.push(c ? `The correct answer "${get('correct')}" must be True or False.` : 'The correct answer (True or False) is missing.');
    if (present.length) warnings.push('Options are ignored for True/False questions.');
  } else if (type === 'THEORY') {
    if (present.length) warnings.push('Options are ignored for theory questions.');
    const modeRaw = get('answer_mode').toLowerCase();
    if (!modeRaw) answerMode = 'screen_to_screen';
    else if (modeRaw.includes('paper')) answerMode = 'screen_to_paper';
    else if (/screen|type|online|computer/.test(modeRaw)) answerMode = 'screen_to_screen';
    else errors.push(`Answer mode "${get('answer_mode')}" must be "Type on screen" or "Write on paper".`);
    instructions = get('instructions') || null;
    if (instructions && instructions.length > LIMITS.instructions) errors.push(`The instructions are longer than ${LIMITS.instructions} characters.`);
    modelAnswer = get('model_answer') || null;
    if (modelAnswer && modelAnswer.length > LIMITS.model_answer) errors.push(`The model answer is longer than ${LIMITS.model_answer} characters.`);
    const mw = get('max_words');
    if (mw) { const n = Number(mw); if (Number.isInteger(n) && n >= 1 && n <= 20000) maxWords = n; else errors.push(`Max words "${mw}" must be a whole number.`); }
    const tl = get('time_limit');
    if (tl) { const n = Number(tl); if (Number.isInteger(n) && n >= 1 && n <= 600) timeLimit = n; else errors.push(`Time limit "${tl}" must be a whole number of minutes.`); }
  }

  const parsed = {
    type, text, questionImage, marks: marks.value, difficulty, explanation: explanation || null,
    options, correctIndex, answerMode, instructions, maxWords, timeLimit, modelAnswer
  };
  return { errors, warnings, parsed, uploads: [...new Set(imageKeys)] };
}

function summarize(p) {
  const plain = String(p.text || '');
  return {
    type: p.type, text: plain.length > 110 ? plain.slice(0, 110) + '…' : plain,
    options: p.type === 'THEORY' ? 0 : p.options.length,
    correct: p.correctIndex === null || p.correctIndex === undefined ? null : (p.type === 'TRUE_FALSE' ? p.options[p.correctIndex].text : p.options[p.correctIndex].letter.toUpperCase()),
    marks: p.marks,
    pictures: (p.questionImage ? 1 : 0) + p.options.filter(o => o.image).length
  };
}

function duplicateReason(parsed, ctx) {
  const hasImage = !!parsed.questionImage;
  const plain = ctx.allowHtml ? stripHtml(parsed.text) : parsed.text;
  const dbKey = dupBase(plain) + (hasImage ? '||img' : '');
  const fileKey = dbKey + (hasImage ? '|' + parsed.questionImage.key : '');
  let reason = null;
  if (ctx.existingKeys.has(dbKey)) reason = 'This question is already in the exam.';
  else if (ctx.seen.has(fileKey)) reason = 'The same question appears earlier in this file.';
  ctx.seen.add(fileKey);
  return { reason, fileKey };
}

// ───────────────────────── public: validate and commit ─────────────────────────
function validateRows(schoolId, examCode, rows, opts) {
  const ctx = makeContext(schoolId, examCode, opts || {});
  if (!ctx) return null;
  return rows.map(row => {
    const v = validateRow(row, ctx);
    let status = v.errors.length ? 'error' : 'ok';
    let fileKey = null;
    if (!v.errors.length) {
      const d = duplicateReason(v.parsed, ctx);
      fileKey = d.fileKey;
      if (d.reason) { status = 'duplicate'; v.warnings.push(d.reason); }
    }
    return { line: row.line, status, errors: v.errors, warnings: v.warnings, summary: summarize(v.parsed), uploads: v.uploads, file_key: fileKey };
  });
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const insertQuestion = db.prepare(`
  INSERT INTO exam_questions
    (question_id, school_id, exam_code, question_type, question_text, marks, correct_answer,
     explanation, difficulty_level, answer_mode, model_answer, student_instructions, max_words, time_limit_minutes)
  VALUES
    (@question_id, @school_id, @exam_code, @question_type, @question_text, @marks, @correct_answer,
     @explanation, @difficulty_level, @answer_mode, @model_answer, @student_instructions, @max_words, @time_limit_minutes)
`);
const insertOption = db.prepare(`
  INSERT INTO exam_question_options (question_id, option_text, is_correct, school_id, option_id)
  VALUES (@question_id, @option_text, @is_correct, @school_id, @option_id)
`);

function commitRows(schoolId, examCode, rows, opts) {
  const o = Object.assign({}, opts || {}, { requireUrls: true });
  o.images = Object.entries(o.image_urls || {}).map(([name, url]) => ({ name, url, size: 0, type: 'image/png' }));
  const ctx = makeContext(schoolId, examCode, o);
  if (!ctx) return null;

  const created = [], skipped = [], failed = [], toSave = [];
  for (const row of rows) {
    const v = validateRow(row, ctx);
    if (v.errors.length) { failed.push({ line: row.line, reason: v.errors.join(' ') }); continue; }
    const d = duplicateReason(v.parsed, ctx);
    if (d.reason && !ctx.allowDuplicates) { skipped.push({ line: row.line, reason: d.reason }); continue; }
    toSave.push({ line: row.line, p: v.parsed });
  }

  db.transaction(() => {
    for (const { line, p } of toSave) {
      const questionId = newId('LQ');
      const qParts = [textToHtml(p.text, ctx.allowHtml)];
      if (p.questionImage) qParts.push(imgTag(p.questionImage.url));
      const optionRows = p.options.map((opt, i) => {
        const parts = [textToHtml(opt.text, p.type === 'TRUE_FALSE' ? true : ctx.allowHtml)];
        if (opt.image) parts.push(imgTag(opt.image.url));
        return { option_id: newId('LO'), option_text: parts.filter(Boolean).join('<br>'), is_correct: i === p.correctIndex ? 1 : 0 };
      });
      const correct = p.correctIndex === null ? null : optionRows[p.correctIndex].option_id;

      insertQuestion.run({
        question_id: questionId, school_id: schoolId, exam_code: examCode, question_type: p.type,
        question_text: qParts.filter(Boolean).join('<br>'), marks: p.marks, correct_answer: correct,
        explanation: p.explanation ? textToHtml(p.explanation, ctx.allowHtml) : null,
        difficulty_level: p.difficulty, answer_mode: p.answerMode,
        model_answer: p.modelAnswer, student_instructions: p.instructions, max_words: p.maxWords, time_limit_minutes: p.timeLimit
      });
      for (const r of optionRows) insertOption.run({ question_id: questionId, option_text: r.option_text, is_correct: r.is_correct, school_id: schoolId, option_id: r.option_id });
      created.push({ line, question_id: questionId });
    }
  })();

  return { created, skipped, failed };
}

// ───────────────────────── template ─────────────────────────
const TEMPLATE_COLUMNS = [
  ['Type', 12], ['Question', 56], ['Option A', 24], ['Option B', 24], ['Option C', 24], ['Option D', 24], ['Option E', 24],
  ['Correct', 10], ['Marks', 8], ['Difficulty', 11], ['Explanation', 34], ['Image', 16],
  ['Image A', 12], ['Image B', 12], ['Image C', 12], ['Image D', 12], ['Image E', 12],
  ['Answer mode', 16], ['Instructions', 30], ['Max words', 11], ['Time limit (minutes)', 14], ['Model answer', 34]
];
const TEMPLATE_SAMPLES = [
  ['MCQ', 'Which planet is known as the Red Planet?', 'Venus', 'Mars', 'Jupiter', 'Saturn', '', 'B', 1, 'easy', 'Mars looks red because of iron oxide on its surface.'],
  ['True/False', 'The Sun is a star.', '', '', '', '', '', 'True', 1, 'easy', ''],
  ['Theory', 'Explain how photosynthesis works.', '', '', '', '', '', '', 10, 'medium', '', '', '', '', '', '', '', 'Type on screen', 'Answer in full sentences.', 300, 15, 'Light energy converts carbon dioxide and water into glucose and oxygen.']
];

function templateCsv() {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [TEMPLATE_COLUMNS.map(c => q(c[0])).join(',')];
  TEMPLATE_SAMPLES.forEach(r => lines.push(TEMPLATE_COLUMNS.map((c, i) => r[i] ?? '').map(q).join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function buildTemplate() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SyncBee';
  const ws = wb.addWorksheet('Questions');
  ws.columns = TEMPLATE_COLUMNS.map(([header, width]) => ({ header, width }));
  TEMPLATE_SAMPLES.forEach(r => ws.addRow(TEMPLATE_COLUMNS.map((c, i) => r[i] ?? '')));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2647' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const col = (title) => TEMPLATE_COLUMNS.findIndex(c => c[0] === title) + 1;
  const listFor = (title, items) => {
    for (let r = 2; r <= 501; r++) ws.getCell(r, col(title)).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${items}"`] };
  };
  listFor('Type', 'MCQ,True/False,Theory');
  listFor('Correct', 'A,B,C,D,E,True,False');
  listFor('Difficulty', 'easy,medium,hard');
  listFor('Answer mode', 'Type on screen,Write on paper');

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ header: 'How to fill in the Questions sheet', key: 'a', width: 110 }];
  [
    'Delete the three example rows, then add yours. Keep the heading row.',
    'Type: MCQ (multiple choice), True/False, or Theory. If you leave it blank and fill in 2 or more options, it is treated as MCQ.',
    'Question: the question text. Plain text is shown exactly as typed (symbols like < and > are safe). Tick "My text contains HTML" on the upload page only if you wrote HTML tags on purpose.',
    'Options: fill Option A to Option E (at least 2). Leave unused ones blank.',
    'Correct: the letter of the right option (A to E), or for True/False write True or False. Only one correct answer is supported.',
    'Marks: a number above 0. Leave blank to use the default you choose on the upload page.',
    'Difficulty (optional): easy, medium or hard.   Explanation (optional): shown to the student after the exam.',
    'Pictures: write the picture file name in Image (for the question) or Image A to Image E (for an option), for example heart.png. Select the pictures on the upload page and they are matched by file name.',
    'Theory only: Answer mode (Type on screen or Write on paper), Instructions, Max words, Time limit (minutes), Model answer.',
    'Up to 1000 questions per file. Questions already in the exam are skipped, so it is safe to upload a corrected file again.'
  ].forEach(t => help.addRow({ a: t }));
  help.getRow(1).font = { bold: true };
  help.getColumn('a').alignment = { wrapText: true, vertical: 'top' };
  return wb;
}

// Only known columns, as short text, ever reach the checker (rows arrive from the browser).
const ROW_FIELDS = Object.keys(FIELD_ALIASES);
function cleanRow(r) {
  const out = { line: Number(r && r.line) || 0 };
  ROW_FIELDS.forEach(f => { if (r && r[f] !== undefined && r[f] !== null) out[f] = String(r[f]).slice(0, 5000); });
  return out;
}

module.exports = { MAX_ROWS, readRows, validateRows, commitRows, buildTemplate, templateCsv, userError, cleanRow };