// main/integrity.js
//
// Verifies that app.asar has not been modified since it was signed by
// scripts/afterPack.js. Called once at startup from main.js, before the
// server starts. In dev (npm start) it does nothing.
//
// IMPORTANT: we use `original-fs` (Electron's unpatched fs) instead of `fs`.
// Electron's patched `fs` treats any *.asar path as an archive and tries to
// read a file *inside* it, which makes readFileSync('.../app.asar') throw
// ENOENT even though the file is right there. original-fs reads the file
// itself, which is what we need for hashing.

const crypto = require('crypto');
const fs = require('fs');
const originalFs = require('original-fs');
const path = require('path');
const { app, dialog } = require('electron');

function loadPublicKey() {
  const raw = require('../license/publicKey');
  if (typeof raw === 'string') return raw;
  return raw.publicKey || raw.key || raw.default;
}

function hashAsar(asarPath) {
  // original-fs avoids Electron's asar interception. Stream so a 70 MB file
  // doesn't sit in memory all at once.
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    originalFs.createReadStream(asarPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest()))
      .on('error', reject);
  });
}

async function verifyAsarSignature() {
  const resourcesDir = process.resourcesPath;
  const asarPath = path.join(resourcesDir, 'app.asar');
  const sigPath = path.join(resourcesDir, 'app.asar.sig');

  if (!fs.existsSync(asarPath)) return { ok: false, reason: 'app.asar missing' };
  if (!fs.existsSync(sigPath)) return { ok: false, reason: 'app.asar.sig missing' };

  let sig;
  try { sig = fs.readFileSync(sigPath); }
  catch (e) { return { ok: false, reason: 'cannot read sig: ' + e.message }; }

  let hash;
  try { hash = await hashAsar(asarPath); }
  catch (e) { return { ok: false, reason: 'cannot read asar: ' + e.message }; }

  const pub = loadPublicKey();
  if (!pub || String(pub).includes('PASTE_YOUR_PUBLIC_KEY_HERE')) {
    return { ok: false, reason: 'public key not configured' };
  }

  try {
    const valid = crypto.verify('RSA-SHA256', hash, pub, sig);
    return valid ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  } catch (e) {
    return { ok: false, reason: 'verify error: ' + e.message };
  }
}

async function enforceIntegrityOrQuit() {
  if (!app.isPackaged) {
    console.log('[integrity] dev mode — skipping asar check');
    return true;
  }
  const result = await verifyAsarSignature();
  if (result.ok) {
    console.log('[integrity] app.asar signature verified');
    return true;
  }
  console.error('[integrity] FAILED:', result.reason);
  try {
    dialog.showErrorBox(
      'SyncBee cannot start',
      'The application files have been modified or damaged.\n\n' +
      'Please reinstall SyncBee from the official installer. If this keeps happening, contact Mariobee support.\n\n' +
      'Details: ' + result.reason
    );
  } catch (_) {}
  process.exit(1);
}

module.exports = { enforceIntegrityOrQuit, verifyAsarSignature };