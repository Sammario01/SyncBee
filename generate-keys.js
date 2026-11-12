const crypto = require('crypto');
const fs = require('fs');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync('license-private.pem', privateKey);
fs.writeFileSync('license-public.pem', publicKey);
console.log('Created license-private.pem (SERVER ONLY) and license-public.pem (goes into the app).');