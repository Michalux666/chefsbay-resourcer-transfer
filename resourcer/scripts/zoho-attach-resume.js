#!/usr/bin/env node
/**
 * zoho-attach-resume.js
 */

const fs = require('fs');
const path = require('path');
const { zohoRequestRaw } = require('./zoho-auth');

async function attachOnce(zohoId, filePath) {
  const fileName = path.basename(filePath);
  const fileBytes = fs.readFileSync(filePath);
  const blob = new Blob([fileBytes]);

  const form = new FormData();
  form.append('file', blob, fileName);

  const res = await zohoRequestRaw('POST', `/Candidates/${zohoId}/Attachments?attachments_category=Resume`, {
    body: form,
    timeoutMs: 60000,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  const record = data?.data?.[0];
  if (record?.status === 'success') {
    return { ok: true, alreadyExists: false, id: record.details?.id, status: res.status, data };
  }
  if (record?.message?.includes('not allowed to attach more than one')) {
    return { ok: true, alreadyExists: true, id: null, status: res.status, data };
  }

  return { ok: false, alreadyExists: false, id: null, status: res.status, data };
}

// Retry wrapper (2026-06-02): Zoho throttles file attachments separately from record
// creates. When many candidates are pushed in quick succession (e.g. an 11-candidate
// run at ZOHO_DELAY_MS=500), the attach endpoint returns
// {"code":"INTERNAL_ERROR","message":"URL_FIXED_THROTTLES_LIMIT_EXCEEDED"} - 6 such
// failures appeared on 2026-06-02 (first ever) once the watchdog-as-runner cadence +
// the 3000->500ms delay raised throughput. The candidate IS already created; only the
// CV attach was rate-limited, so retrying after a short backoff lets the throttle window
// clear and the CV attaches. Non-throttle errors fail fast (no behaviour change).
const ATTACH_BACKOFFS_MS = [4000, 8000, 15000];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isThrottleError(result) {
  try { return /THROTTLE|LIMIT_EXCEEDED|TOO_MANY|RATE_LIMIT/i.test(JSON.stringify(result.data || {})); }
  catch { return false; }
}

async function attachResume(zohoId, filePath, opts = {}) {
  const maxAttempts = opts.maxAttempts || (ATTACH_BACKOFFS_MS.length + 1);
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await attachOnce(zohoId, filePath);
    if (result.ok) return result;
    if (attempt >= maxAttempts || !isThrottleError(result)) return result;
    const wait = ATTACH_BACKOFFS_MS[attempt - 1] || ATTACH_BACKOFFS_MS[ATTACH_BACKOFFS_MS.length - 1];
    console.error(`[attach] zoho ${zohoId} throttled (attempt ${attempt}/${maxAttempts}) - retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  return result;
}

async function main() {
  const [, , zohoId, filePath] = process.argv;
  if (zohoId === '--help' || zohoId === '-h') {
    console.log('Usage: node zoho-attach-resume.js <zoho_id> <cv_file_path>');
    return;
  }
  if (!zohoId || !filePath) {
    console.error('Usage: node zoho-attach-resume.js <zoho_id> <cv_file_path>');
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const fileSizeMB = fs.statSync(absPath).size / (1024 * 1024);
  if (fileSizeMB > 20) {
    console.error(`File too large: ${fileSizeMB.toFixed(1)}MB (Zoho limit: 20MB)`);
    process.exit(1);
  }

  console.log(`Attaching ${path.basename(absPath)} (${fileSizeMB.toFixed(2)}MB) to Zoho candidate ${zohoId}...`);

  const result = await attachResume(zohoId, absPath);
  const exit = (code) => setTimeout(() => process.exit(code), 100);

  if (result.ok && !result.alreadyExists) {
    console.log(`ATTACHED: attachment ID ${result.id}`);
    return exit(0);
  }

  if (result.ok && result.alreadyExists) {
    console.log(`ALREADY_HAS_RESUME: candidate ${zohoId} already has a Resume attached - skipping`);
    return exit(0);
  }

  console.error(`ERROR (HTTP ${result.status}):`, JSON.stringify(result.data));
  return exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err.message);
    setTimeout(() => process.exit(1), 100);
  });
}

module.exports = { attachResume, attachOnce, ATTACH_BACKOFFS_MS };
