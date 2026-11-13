// license/manager.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const LICENSE_PUBLIC_KEY = require('./publicKey');

// Legacy HMAC secret: only verifies the legacy signature the server still sends for the PHP app.
const LICENSE_SECRET = 'just_you_and_i';
const LICENSE_API_URL = 'https://mariobee.com/license-api/check';

const WARN_AFTER_DAYS = 30;       // show a warning banner
const READ_ONLY_AFTER_DAYS = 45;  // no successful online check for this long -> read-only
// Installed copies accept only licenses signed by Mariobee's server. While developing
// (npm start) the older kind is still allowed so your test setup keeps working.
const REQUIRE_SIGNED_V2 = (() => { try { return require('electron').app.isPackaged === true; } catch (e) { return false; } })();
const CACHE_MS = 5000;

if (LICENSE_PUBLIC_KEY.includes('PASTE_YOUR_PUBLIC_KEY_HERE')) {
  console.warn('[license] license/publicKey.js still has the placeholder. Signed licenses cannot be verified.');
}

const LOCK_STATES = {
  revoked:        { code: 'LICENSE_REVOKED',      message: 'This license has been revoked. Please contact Mariobee support.' },
  suspended:      { code: 'LICENSE_SUSPENDED',    message: 'This license has been suspended. Please contact Mariobee support.' },
  inactive:       { code: 'LICENSE_INACTIVE',     message: 'This license is inactive. Please contact Mariobee support.' },
  device_removed: { code: 'DEVICE_REMOVED',       message: 'This computer was deactivated by Mariobee. Re-activate it with your license code, or contact support.' },
  device_limit:   { code: 'DEVICE_LIMIT_REACHED', message: 'This license is already active on the maximum number of admin computers. Contact Mariobee to free a slot.' }
};

const SERVER_CODE_TO_STATE = {
  LICENSE_REVOKED: 'revoked',
  LICENSE_SUSPENDED: 'suspended',
  LICENSE_INACTIVE: 'inactive',
  DEVICE_REMOVED: 'device_removed',
  DEVICE_LIMIT_REACHED: 'device_limit'
};

// ---------------------------------------------------------------------------
// Where license.json lives
// ---------------------------------------------------------------------------
function getLicenseFilePath() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      const dir = app.getPath('userData');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, 'license.json');
    }
  } catch (err) {
    // Not running under Electron: fall through.
  }
  return path.join(__dirname, 'license.json');
}

// ---------------------------------------------------------------------------
// Machine fingerprint (matches PHP's functions.php on Windows). Cached: the
// wmic calls are slow and this is read on every request through the license gate.
// ---------------------------------------------------------------------------
let cachedFingerprint = null;

function getMachineFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  let raw = '';

  try {
    if (process.platform === 'win32') {
      const cpu = execSync('wmic cpu get ProcessorId /value', { timeout: 5000 }).toString();
      const vol = execSync(
        'wmic logicaldisk where "DeviceID=\'C:\'" get VolumeSerialNumber /value',
        { timeout: 5000 }
      ).toString();
      raw = cpu + vol;
    } else {
      try {
        raw = fs.readFileSync('/etc/machine-id', 'utf8');
      } catch (innerErr) {
        raw = os.hostname();
      }
    }
  } catch (err) {
    raw = '';
  }

  if (!raw || !raw.trim()) raw = os.hostname();

  cachedFingerprint = crypto.createHash('sha256').update(raw.trim()).digest('hex');
  return cachedFingerprint;
}
setImmediate(getMachineFingerprint); // warm it up so the first request isn't slow

// ---------------------------------------------------------------------------
// license.json read/write (atomic write: a power cut can't leave a half-written file)
// ---------------------------------------------------------------------------
let cache = null;
let cacheAt = 0;
function invalidateCache() { cache = null; }

function readLicenseFile() {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeLicenseFile(config) {
  const filePath = getLicenseFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 4));
  fs.renameSync(tmp, filePath);
  invalidateCache();
  return config;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
function computeSignature({ email, domain, expiry, machine_hash: machineHash }) {
  return crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(`${email}|${domain}|${expiry}|${machineHash}`)
    .digest('hex');
}

function verifyRsa(signedPayload, signatureB64) {
  try {
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(String(signedPayload), 'utf8'),
      LICENSE_PUBLIC_KEY,
      Buffer.from(String(signatureB64), 'base64')
    );
  } catch (err) {
    return false;
  }
}

// Returns the terms inside a signed payload, or null if the signature is bad.
function readSignedTerms(signedPayload, signatureB64) {
  if (!verifyRsa(signedPayload, signatureB64)) return null;
  try {
    const p = JSON.parse(signedPayload);
    return {
      license_key: p.license_key,
      email: p.email,
      domain: p.domain,
      school_id: p.school_id,
      machine_hash: p.machine_hash,
      status: p.status,
      expiry: p.expiry_date,
      max_devices: p.max_devices ?? null,
      max_candidate_computers: p.max_candidate_computers ?? null,
            min_supported_version: p.min_supported_version ?? null
    };
  } catch (err) {
    return null;
  }
}

// The limits and school identity the app actually trusts: from the signed
// payload when there is one, never from loose fields in license.json.
function effectiveTerms(config) {
  if (config.signed_payload && config.signature_v2) {
    const t = readSignedTerms(config.signed_payload, config.signature_v2);
    if (!t || t.status !== 'active') {
      return { ok: false, code: 'BAD_SIGNATURE', message: 'Invalid license signature. The file may have been tampered with.' };
    }
    if (t.machine_hash !== getMachineFingerprint()) {
      return { ok: false, code: 'WRONG_MACHINE', message: 'License is not valid for this machine. Please reactivate.' };
    }
    return { ok: true, source: 'signed', ...t };
  }

  if (REQUIRE_SIGNED_V2) {
    return { ok: false, code: 'REFRESH_REQUIRED', message: 'This license must be refreshed online. Please connect to the internet and activate again.' };
  }

  return {
    ok: true, source: 'legacy',
    license_key: config.license_key || null, email: config.email, school_id: config.school_id,
    expiry: config.expiry, max_devices: null, max_candidate_computers: null
  };
}

// ---------------------------------------------------------------------------
// The one question the whole app asks: what is this license allowed to do right now?
//   unactivated -> nothing works until activated
//   full        -> everything
//   read_only   -> expired / offline too long: view and download results only
//   locked      -> revoked / suspended / removed machine: nothing new, admin blocked
// ---------------------------------------------------------------------------
function parseTime(value) {
  if (!value) return NaN;
  const s = String(value);
  return new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T')).getTime();
}

function unactivated(code, message) {
  return { mode: 'unactivated', code, message, warning: null, terms: null, config: null };
}

function compute() {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) return unactivated('NOT_ACTIVATED', 'License file not found. Please activate your license.');

  let config = null;
  try { config = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) { config = null; }

  const required = ['email', 'domain', 'expiry', 'signature', 'machine_hash'];
  if (!config || required.some((k) => config[k] === undefined || config[k] === null)) {
    return unactivated('LICENSE_CORRUPT', 'License file is invalid or corrupted.');
  }
  if (config.machine_hash !== getMachineFingerprint()) {
    return unactivated('WRONG_MACHINE', 'License is not valid for this machine. Please reactivate.');
  }

  const terms = effectiveTerms(config);
  if (!terms.ok) return unactivated(terms.code, terms.message);
  if (terms.source === 'legacy' && config.signature !== computeSignature(config)) {
    return unactivated('BAD_SIGNATURE', 'Invalid license signature. The file may have been tampered with.');
  }

  const nowMs = Date.now();
  const expiryDay = String(terms.expiry || '').slice(0, 10);
  const expiryEnd = Date.parse(`${expiryDay}T23:59:59`);
  const daysLeft = Number.isNaN(expiryEnd) ? null : Math.ceil((expiryEnd - nowMs) / 86400000);

  const lastMs = parseTime(config.last_checkin_utc) || parseTime(config.last_online_check) || parseTime(config.activated_at) || nowMs;
  const offlineDays = Math.max(0, Math.floor((nowMs - lastMs) / 86400000));

  const base = { terms, config, expiry: expiryDay, days_left: daysLeft, offline_days: offlineDays };

  const lock = config.license_state && LOCK_STATES[config.license_state];
  if (lock) {
    return { ...base, mode: 'locked', code: lock.code, message: config.state_message || lock.message, warning: null };
  }

  if (config.license_state === 'expired' || (daysLeft !== null && daysLeft < 0)) {
    return {
      ...base, mode: 'read_only', code: 'LICENSE_EXPIRED', reason: 'expired', warning: null,
      message: 'Your license has expired. You can still view and download results. Renew to create exams, sync with the cloud, or run new sessions.'
    };
  }

  if (offlineDays > READ_ONLY_AFTER_DAYS) {
    return {
      ...base, mode: 'read_only', code: 'OFFLINE_TOO_LONG', reason: 'offline_too_long', warning: null,
      message: `This computer has not verified its license online for ${offlineDays} days. Connect to the internet to restore full access. Your results remain available.`
    };
  }

  let warning = null;
  if (offlineDays > WARN_AFTER_DAYS) {
    warning = `This computer has not verified its license online for ${offlineDays} days. Connect to the internet within ${READ_ONLY_AFTER_DAYS - offlineDays} day(s) to avoid read-only mode.`;
  } else if (daysLeft !== null && daysLeft <= 14) {
    warning = daysLeft === 0
      ? 'Your license expires today. Renew to avoid losing access to exams and sync.'
      : `Your license expires in ${daysLeft} day(s). Renew to avoid losing access to exams and sync.`;
  }

  return { ...base, mode: 'full', code: 'OK', message: 'License is valid.', warning };
}

function evaluate() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    cache = compute();
  } catch (err) {
    cache = unactivated('LICENSE_ERROR', 'The license could not be read.');
  }
  cacheAt = Date.now();
  return cache;
}

function getLicenseMode() {
  const { terms, config, ...publicPart } = evaluate();
  return publicPart;
}

// Same shape the app used before, so older callers keep working.
function checkLicense() {
  const m = getLicenseMode();
  return {
    status: m.mode === 'full',
    message: m.message,
    mode: m.mode,
    code: m.code,
    grace_warning: !!m.warning,
    expiry: m.expiry || undefined
  };
}

// Safe summary for the admin License page: no school ID, no signatures, key masked.
function getLicenseInfo() {
  const ev = evaluate();
  const c = ev.config || {};
  const key = (ev.terms && ev.terms.license_key) || c.license_key || '';
  return {
    mode: ev.mode,
    code: ev.code,
    message: ev.message,
    warning: ev.warning || null,
    email: (ev.terms && ev.terms.email) || c.email || null,
    domain: c.domain || null,
    license_key_hint: key ? `****${String(key).slice(-4)}` : null,
    expiry: ev.expiry || null,
    days_left: ev.days_left ?? null,
    last_checkin_utc: c.last_checkin_utc || null,
    offline_days: ev.offline_days ?? null,
    max_devices: ev.terms ? ev.terms.max_devices : null,
    max_candidate_computers: ev.terms ? ev.terms.max_candidate_computers : null,
        min_supported_version: c.min_supported_version || (ev.terms && ev.terms.min_supported_version) || null,
    signed: !!(ev.terms && ev.terms.source === 'signed'),
    computer_name: os.hostname()
  };
}

function getLicenseLimits() {
  const ev = evaluate();
  const n = ev.terms ? parseInt(ev.terms.max_candidate_computers, 10) : NaN;
  return { max_candidate_computers: Number.isInteger(n) && n > 0 ? n : null };
}

// ---------------------------------------------------------------------------
// First activation: Email + Account Password + License Code
// ---------------------------------------------------------------------------
async function activateLicense({ email, license_key, password }) {
  email = (email || '').trim();
  license_key = (license_key || '').trim();

  if (!email || !license_key || !password) {
    return { status: false, code: 'BAD_REQUEST', message: 'Email, password and license code are required.' };
  }

  const machineHash = getMachineFingerprint();
  const body = new URLSearchParams({
    email, license_key, password, activate: '1', machine_hash: machineHash, device_label: os.hostname()
  });

  let response;
  try {
    response = await axios.post(LICENSE_API_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
  } catch (err) {
    const d = err.response && err.response.data;
    return {
      status: false,
      code: (d && d.code) || 'NETWORK',
      message: (d && d.message) || `Cannot connect to license server. ${err.message}`
    };
  }

  const data = response.data;
  if (!data || data.status !== true) {
    return { status: false, code: (data && data.code) || 'REFUSED', message: (data && data.message) || 'License validation failed.' };
  }
  if (!data.school_id) {
    return { status: false, code: 'BAD_RESPONSE', message: 'License response missing school ID.' };
  }

  let signed = null;
  if (data.signed_payload && data.signature_v2) {
    signed = readSignedTerms(data.signed_payload, data.signature_v2);
    if (!signed || signed.machine_hash !== machineHash || signed.status !== 'active') {
      return { status: false, code: 'BAD_SIGNATURE', message: 'The license response could not be verified.' };
    }
  } else if (REQUIRE_SIGNED_V2) {
    return { status: false, code: 'BAD_RESPONSE', message: 'The license server did not return a signed license.' };
  }

  const nowIso = new Date().toISOString();
  const licenseConfig = {
    school_id: data.school_id,
    email: data.email || email,
    domain: data.domain || '',
    license_key: data.license_key || license_key,
    machine_hash: machineHash,
    valid: true,
    expiry: data.expiry_date || null,
    activated_at: nowIso.slice(0, 19).replace('T', ' '),
    last_online_check: data.last_online_check || nowIso.slice(0, 19).replace('T', ' '),
    last_checkin_utc: nowIso,
    signature: data.signature || null,
    days_left: data.days_left != null ? data.days_left : null,
    max_devices: data.max_devices ?? null,
    max_candidate_computers: data.max_candidate_computers ?? null,
    signed_payload: signed ? data.signed_payload : null,
    signature_v2: signed ? data.signature_v2 : null,
    license_state: 'active',
    state_message: null,
    // The account password also becomes this computer's admin login (stored as a hash, never in plain text).
    admin_password_hash: bcrypt.hashSync(password, 10)
  };

  writeLicenseFile(licenseConfig);

  let message = 'License validated successfully.';
  if (licenseConfig.days_left !== null && licenseConfig.days_left < 7) {
    message = `License activated, but expires in ${Math.max(0, Math.ceil(licenseConfig.days_left))} day(s).`;
  }
  return { status: true, code: 'OK', message };
}

// ---------------------------------------------------------------------------
// Periodic check-in. Applies remote limit changes, revocation, removed-machine
// and renewal. NEVER locks anything because of a network or server problem.
// ---------------------------------------------------------------------------
async function checkInOnline({ candidateSeatsUsed = null } = {}) {
  const config = readLicenseFile();
  if (!config || !config.email || !config.machine_hash) {
    return { skipped: true, reachable: null, changed: false, message: 'No license to check.' };
  }
  if (config.machine_hash !== getMachineFingerprint()) {
    return { skipped: true, reachable: null, changed: false, message: 'License belongs to a different computer.' };
  }

  const params = { email: config.email, machine_hash: config.machine_hash, device_label: os.hostname() };
  if (config.license_key) params.license_key = config.license_key; else params.domain = config.domain;
  if (candidateSeatsUsed !== null && candidateSeatsUsed !== undefined) params.candidate_seats_used = String(candidateSeatsUsed);

  let data;
  try {
    const res = await axios.post(LICENSE_API_URL, new URLSearchParams(params).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    data = res.data;
  } catch (err) {
    const d = err.response && err.response.data;
    if (!d || typeof d !== 'object' || !d.code) {
      return { reachable: !!err.response, changed: false, message: `Could not verify the license right now (${err.message}).` };
    }
    data = d;
  }

  if (!data || typeof data !== 'object') {
    return { reachable: true, changed: false, message: 'Unexpected response from the license server.' };
  }

  const nowIso = new Date().toISOString();

  if (data.status === true) {
    let signed = null;
    if (data.signed_payload && data.signature_v2) {
      signed = readSignedTerms(data.signed_payload, data.signature_v2);
      if (!signed || signed.machine_hash !== config.machine_hash || signed.status !== 'active') {
        return { reachable: true, changed: false, message: 'The license response could not be verified.' };
      }
    } else if (REQUIRE_SIGNED_V2) {
      return { reachable: true, changed: false, message: 'The license server did not return a signed license.' };
    }

    writeLicenseFile({
      ...config,
      school_id: data.school_id || config.school_id,
      domain: data.domain || config.domain,
      license_key: data.license_key || config.license_key,
      expiry: data.expiry_date || config.expiry,
      signature: data.signature || config.signature,
      days_left: data.days_left != null ? data.days_left : config.days_left,
      max_devices: data.max_devices ?? null,
      max_candidate_computers: data.max_candidate_computers ?? null,
      signed_payload: signed ? data.signed_payload : config.signed_payload,
      signature_v2: signed ? data.signature_v2 : config.signature_v2,
      last_online_check: data.last_online_check || config.last_online_check,
      last_checkin_utc: nowIso,
      license_state: 'active',
      state_message: null
    });
    return { reachable: true, changed: true, mode: getLicenseMode().mode, message: 'License verified.' };
  }

  const state = SERVER_CODE_TO_STATE[data.code];
  if (state || data.code === 'LICENSE_EXPIRED') {
    writeLicenseFile({
      ...config,
      license_state: state || 'expired',
      state_message: data.message || null,
      last_checkin_utc: nowIso // the server answered, so we did reach it
    });
    return { reachable: true, changed: true, mode: getLicenseMode().mode, message: data.message };
  }

  // Anything else (not found, bad request, server error...) is NOT grounds to lock a paying customer.
  return { reachable: true, changed: false, message: data.message || 'The license server could not verify this license.' };
}

// ---------------------------------------------------------------------------
// Admin login: checked against the password hash set at activation, fully offline.
// ---------------------------------------------------------------------------
function verifyAdminLogin(email, password) {
  const ev = evaluate();

  if (ev.mode === 'unactivated') {
    return { success: false, message: 'No admin account found. Please activate the license first.' };
  }
  if (ev.mode === 'locked') {
    return { success: false, message: ev.message };
  }

  const config = ev.config;
  if (!config.admin_password_hash) {
    return { success: false, message: 'No admin account found. Please activate the license first.' };
  }

  const licenseEmail = String((ev.terms && ev.terms.email) || config.email || '').toLowerCase();
  if (String(email || '').trim().toLowerCase() !== licenseEmail) {
    return { success: false, message: 'Invalid email or password.' };
  }
  if (!bcrypt.compareSync(password, config.admin_password_hash)) {
    return { success: false, message: 'Invalid email or password.' };
  }

  // school_id comes from the SIGNED terms when available, so it can't be edited in the file.
  return { success: true, school_id: (ev.terms && ev.terms.school_id) || config.school_id, email: config.email };
}

function requireLicense(req, res, next) {
  const m = getLicenseMode();
  if (m.mode !== 'full') {
    return res.status(403).json({ error: m.message, code: m.code });
  }
  req.license = m;
  next();
}

module.exports = {
  getMachineFingerprint,
  getLicenseFilePath,
  activateLicense,
  checkInOnline,
  checkLicense,
  getLicenseMode,
  getLicenseInfo,
  getLicenseLimits,
  verifyAdminLogin,
  requireLicense
};