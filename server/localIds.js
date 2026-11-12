// server/localIds.js
// Rows created on this computer get IDs from a reserved range, so they can never
// collide with IDs the cloud sync brings in (cloud IDs are far below this).
const db = require('../db/database');

const LOCAL_ID_START = 1000000000;
const ID_COLUMN = { classes: 'id', programs: 'id', subjects: 'subject_id' };

function nextLocalId(table) {
  const col = ID_COLUMN[table];
  if (!col) throw new Error('Unknown table');
  const row = db.prepare(`SELECT MAX(${col}) AS m FROM ${table} WHERE ${col} >= ?`).get(LOCAL_ID_START);
  return row.m ? row.m + 1 : LOCAL_ID_START;
}

module.exports = { LOCAL_ID_START, nextLocalId };