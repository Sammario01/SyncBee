// server/analyticsExport.js
// Turns an analytics result into a multi-sheet Excel workbook.
// exceljs is loaded only when an export is requested, so the app still starts without it.
const { FLAG_TEXT } = require('./analytics');

function buildWorkbook(a) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SyncBee';
  wb.created = new Date();

  const styleHeader = (sheet) => {
    const row = sheet.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2647' } };
    row.alignment = { vertical: 'middle', wrapText: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const fmtTime = (s) => (s === null || s === undefined ? '' : `${Math.floor(s / 60)}m ${s % 60}s`);
  const blank = (v) => (v === null || v === undefined ? '' : v);

  // Summary
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Item', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 44 }];
  const s = a.summary;
  [
    ['Exam', a.exam.title],
    ['Exam code', a.exam.exam_code],
    ['Candidates', s.candidates],
    ['Average score', blank(s.average_score)],
    ['Median score', blank(s.median_score)],
    ['Highest score', blank(s.highest_score)],
    ['Lowest score', blank(s.lowest_score)],
    ['Total marks (objective questions)', a.exam.questions_total_marks],
    ['Passing mark', blank(a.exam.passing_marks)],
    ['Passed', s.passed],
    ['Pass rate (%)', s.pass_rate],
    ['Average % of questions correct', blank(s.avg_percent_correct)],
    ['Average time to finish (minutes)', blank(s.avg_minutes_to_finish)],
    ['Taken inside a bundle', s.in_bundle],
    ['Time per question based on', `${a.timing.attempts_with_events} of ${a.timing.total_attempts} candidates`],
    ['Report created', new Date().toLocaleString('en-GB')]
  ].forEach(([k, v]) => sum.addRow({ k, v }));
  styleHeader(sum);

  // Questions
  const qs = wb.addWorksheet('Questions');
  qs.columns = [
    { header: 'No.', key: 'n', width: 6 }, { header: 'Question', key: 'q', width: 60 },
    { header: 'Given to', key: 'given', width: 10 }, { header: 'Answered', key: 'ans', width: 10 },
    { header: 'Skipped', key: 'skip', width: 10 }, { header: 'Skipped (%)', key: 'skipPct', width: 12 },
    { header: 'Correct', key: 'cor', width: 10 }, { header: 'Difficulty index (% correct)', key: 'di', width: 16 },
    { header: 'Difficulty', key: 'dl', width: 12 }, { header: 'Average time', key: 'time', width: 13 },
    { header: 'Most chosen wrong option', key: 'tw', width: 40 }, { header: 'Chosen by', key: 'twc', width: 10 },
    { header: 'Notes', key: 'notes', width: 60 }
  ];
  a.questions.forEach(q => qs.addRow({
    n: q.number, q: q.text, given: q.assigned, ans: q.answered, skip: q.skipped, skipPct: q.skip_rate,
    cor: q.correct, di: blank(q.difficulty), dl: q.difficulty_label, time: fmtTime(q.avg_seconds),
    tw: q.top_wrong ? q.top_wrong.text : '', twc: q.top_wrong ? q.top_wrong.count : '',
    notes: q.flags.map(f => FLAG_TEXT[f]).join(' ')
  }));
  qs.getColumn('q').alignment = { wrapText: true, vertical: 'top' };
  qs.getColumn('tw').alignment = { wrapText: true, vertical: 'top' };
  qs.getColumn('notes').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(qs);

  // Options
  const os = wb.addWorksheet('Options');
  os.columns = [
    { header: 'Question no.', key: 'n', width: 12 }, { header: 'Question', key: 'q', width: 50 },
    { header: 'Option', key: 'o', width: 44 }, { header: 'Correct answer', key: 'c', width: 14 },
    { header: 'Chosen by', key: 'cnt', width: 11 }, { header: 'Of those given (%)', key: 'p', width: 16 }
  ];
  a.questions.forEach(q => {
    q.options.forEach(o => os.addRow({ n: q.number, q: q.text, o: o.text, c: o.is_correct ? 'Yes' : '', cnt: o.count, p: o.pct }));
    if (q.no_answer > 0) os.addRow({ n: q.number, q: q.text, o: '(no answer)', c: '', cnt: q.no_answer, p: Math.round((q.no_answer / Math.max(1, q.assigned)) * 100) });
  });
  os.getColumn('q').alignment = { wrapText: true, vertical: 'top' };
  os.getColumn('o').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(os);

  // Candidates
  const cs = wb.addWorksheet('Candidates');
  cs.columns = [
    { header: 'Rank', key: 'rank', width: 7 }, { header: 'Candidate', key: 'name', width: 34 },
    { header: 'Score', key: 'score', width: 9 }, { header: 'Result', key: 'res', width: 9 },
    { header: 'Answered', key: 'ans', width: 10 }, { header: 'Correct', key: 'cor', width: 9 },
    { header: 'Skipped', key: 'skip', width: 9 }, { header: 'Questions given', key: 'given', width: 15 },
    { header: 'Time taken', key: 'time', width: 12 }
  ];
  a.candidates.forEach(c => cs.addRow({
    rank: c.rank, name: c.name, score: blank(c.score), res: c.score === null ? '' : (c.passed ? 'Pass' : 'Fail'),
    ans: c.answered, cor: c.correct, skip: c.skipped, given: c.assigned, time: fmtTime(c.seconds)
  }));
  styleHeader(cs);

  return wb;
}

module.exports = { buildWorkbook };