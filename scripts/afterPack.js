// scripts/afterPack.js
//
// electron-builder afterPack hook. Runs after app.asar is packed, before the
// installer is built. Signs a SHA-256 of app.asar with the local private key
// and writes app.asar.sig next to it in resources/. main/integrity.js verifies
// it at startup and refuses to launch if the signature doesn't match.
//
// Private key path (default: build/keys/asar-private.pem) can be overridden
// with env var SYNCBEE_ASAR_KEY_PATH. Never commit or ship this key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest()))
      .on('error', reject);
  });
}

module.exports = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');

  if (!fs.existsSync(asarPath)) {
    throw new Error(`[afterPack] app.asar not found at ${asarPath}. Confirm asar: true in build config.`);
  }

  const keyPath =
    process.env.SYNCBEE_ASAR_KEY_PATH ||
    path.join(process.cwd(), 'build', 'keys', 'asar-private.pem');

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `[afterPack] private key not found at ${keyPath}.\n` +
      `Set SYNCBEE_ASAR_KEY_PATH, or place the key there.`
    );
  }

  const privateKey = fs.readFileSync(keyPath, 'utf8');
  const hashBuf = await sha256File(asarPath);
  const signature = crypto.sign('RSA-SHA256', hashBuf, privateKey);

  const sigPath = path.join(resourcesDir, 'app.asar.sig');
  fs.writeFileSync(sigPath, signature);

  const sizeMb = (fs.statSync(asarPath).size / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] signed app.asar (${sizeMb} MB) -> app.asar.sig (${signature.length} bytes)`);
};