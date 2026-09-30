'use strict';
// Coding-standard checks (DESIGN section 9) for the lifecycle package, plus the interface contract
// with the other packages' modules (checked only when those modules are present in the repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MINE = [
  'resourcer/scripts/process-approved-queue.js',
  'resourcer/scripts/migrate-schema.js',
  'resourcer/scripts/retention-sweep.js',
  'resourcer/scripts/backfill-run-results.js',
  'resourcer/scripts/lib/cv-retention.js',
  'resourcer/scripts/preflight-db.js',
  'resourcer/scripts/fill-mandatory-fields.js',
  'resourcer/candidates-db.js',
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = [...MINE.map(f => path.join(ROOT, f)), ...walk(__dirname)];

// assembled from parts so this file does not contain the tokens it forbids
const BANNED = [
  ['C', ':', String.fromCharCode(92)].join(''), ['C', ':/Users'].join(''), ['w', 'sl '].join(''), ['power', 'shell'].join(''),
  ['pw', 'sh'].join(''), ['open', 'claw'].join(''), ['pm', '2'].join(''), ['sch', 'tasks'].join(''), ['187', '89'].join(''),
  ['WHATS', 'APP'].join(''), ['ng', 'rok'].join(''),
];

// A pair of backslashes between two path-like characters (the shape of a Windows path written in a string).
function hasDoubleBackslashBetweenWordChars(src, pair) {
  const wordChar = /[A-Za-z0-9_.-]/;
  for (let i = src.indexOf(pair); i !== -1; i = src.indexOf(pair, i + 1)) {
    if (wordChar.test(src.charAt(i - 1)) && wordChar.test(src.charAt(i + pair.length))) return true;
  }
  return false;
}

test('lifecycle sources and tests are ASCII, LF, and free of banned tokens', () => {
  const problems = [];
  const bsbs = String.fromCharCode(92, 92);
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    if (/[^\x00-\x7f]/.test(src)) problems.push(`${rel}: non-ASCII character`);
    if (src.includes('\r')) problems.push(`${rel}: CR found (LF only)`);
    const lower = src.toLowerCase();
    for (const tok of BANNED) if (lower.includes(tok.toLowerCase())) problems.push(`${rel}: banned token`);
    if (hasDoubleBackslashBetweenWordChars(src, bsbs)) problems.push(`${rel}: double-backslash path literal`);
  }
  assert.deepEqual(problems, []);
});

test('no source file of the package contains a double-backslash literal at all (the banned-token scan looks for one)', () => {
  const bsbs = String.fromCharCode(92, 92);
  const problems = MINE.map(f => path.join(ROOT, f)).filter(f => fs.readFileSync(f, 'utf8').includes(bsbs)).map(f => path.relative(ROOT, f));
  assert.deepEqual(problems, []);
});

test('no secrets or personal data patterns in the lifecycle package', () => {
  const problems = [];
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    if (/\b(sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/.test(src)) problems.push(`${rel}: token-like string`);
    const emails = src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi) || [];
    for (const e of emails) if (!/@example\.invalid$/i.test(e)) problems.push(`${rel}: email ${e.replace(/^[^@]+/, '***')}`);
  }
  assert.deepEqual(problems, []);
});

test('scripts have --help and never call process.exit inside the library', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'resourcer/scripts/lib/cv-retention.js'), 'utf8');
  assert.doesNotMatch(lib, /process\.exit/);
  for (const f of ['migrate-schema.js', 'retention-sweep.js', 'backfill-run-results.js', 'process-approved-queue.js', 'preflight-db.js', 'fill-mandatory-fields.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'resourcer/scripts', f), 'utf8');
    assert.match(src, /--help/);
    assert.match(src, /require\.main === module/);
  }
});

test('the lifecycle scripts never use a shell string built from data', () => {
  for (const f of MINE) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bexecSync\b|shell:\s*true/, `${f}: shell execution`);
    assert.doesNotMatch(src, /\{[^}]*\bexec\b[^}]*\}\s*=\s*require\('child_process'\)/, `${f}: child_process.exec imported`);
  }
});

// ---- interface contract with the other packages (skipped until their modules exist) ------------------

const CONTRACT = [
  ['resourcer/scripts/zoho-auth.js', ['refreshToken']],
  ['resourcer/scripts/zoho-create-candidate.js', ['createCandidate']],
  ['resourcer/scripts/zoho-attach-resume.js', ['attachResume']],
  ['resourcer/scripts/fill-mandatory-fields.js', ['fillMandatoryFields']],
  ['resourcer/scripts/territory-utils.js', ['upsertTerritory']],
  ['resourcer/scripts/reed-download.js', ['downloadCandidate', 'normalizeProfileToZoho']],
  ['resourcer/scripts/caterer-cookie-jar.js', ['fetchWithCookieJarUpdate']],
  ['resourcer/scripts/caterer-session-utils.js', ['loadCookieHeader']],
  ['resourcer/candidates-db.js', ['getDb', 'getZohoId', 'setZohoId']],
];

for (const [rel, names] of CONTRACT) {
  test(`contract: ${rel} exports ${names.join(', ')}`, (t) => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return t.skip('module not present in this checkout yet');
    let mod;
    try { mod = require(file); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND') return t.skip(`dependency missing here: ${String(e.message).split('\n')[0]}`);
      throw e;
    }
    for (const n of names) assert.equal(typeof mod[n], 'function', `${rel} must export function ${n}`);
  });
}

test('contract: BASE_CATERER is exported as a string by caterer-session-utils when present', (t) => {
  const file = path.join(ROOT, 'resourcer/scripts/caterer-session-utils.js');
  if (!fs.existsSync(file)) return t.skip('module not present in this checkout yet');
  let mod;
  try { mod = require(file); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return t.skip('dependency missing here');
    throw e;
  }
  assert.equal(typeof mod.BASE_CATERER, 'string');
});
