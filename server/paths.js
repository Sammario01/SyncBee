// server/paths.js
// Where SyncBee keeps files that change while it runs (database, question images, backups).
// An installed copy sets SYNCBEE_DATA_DIR (main/main.js) to the user's app-data folder, because
// the program folder is read-only. During `npm start` it is not set, so nothing moves.
const fs = require('fs');
const path = require('path');

const dataDir = process.env.SYNCBEE_DATA_DIR || path.join(__dirname, '..');

function folder(...parts) {
  const dir = path.join(dataDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  dataDir,
  dbFile: path.join(folder('db'), 'syncbee.db'),
  uploadsDir: folder('uploads', 'question_images'),
  backupsDir: folder('backups')
};