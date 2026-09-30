'use strict';
// DESIGN.md section 9 coding standards, checked over every file this package ships (and its
// tests): ASCII-only, LF line endings, none of the banned platform tokens, valid syntax.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/home');

const BS = String.fromCharCode(92);
// Built from pieces so this file passes its own scan.
const BANNED = [
  'C:' + BS, 'C:' + '/Users', 'wsl' + ' ', 'power' + 'shell', 'pw' + 'sh', 'open' + 'claw', 'pm' + '2',
  'sch' + 'tasks', '187' + '89', 'WHATS' + 'APP', 'ng' + 'rok', BS + BS,
];

// Files owned by the core package (resourcer/ relative).
const OWNED = [
  'candidates-db.js',
  'config/postcode-cities.json',
  'config/territory-defaults.json',
  'scripts/applying-for-role-map.js',
  'scripts/build-caterer-results-url.js',
  'scripts/caterer-fetch-results.js',
  'scripts/caterer-keepalive.js',
  'scripts/caterer-session-utils.js',
  'scripts/constants.js',
  'scripts/create-init-status.js',
  'scripts/cull-ghost-phase1.js',
  'scripts/fetch-with-timeout.js',
  'scripts/fill-mandatory-fields.js',
  'scripts/migrate-reed-schema.js',
  'scripts/pending-gate.js',
  'scripts/pipeline-halt-cli.js',
  'scripts/pipeline-optimiser.js',
  'scripts/postcode-lookup.js',
  'scripts/query-territory.js',
  'scripts/queue-due-territories.js',
  'scripts/recover-stranded-phase1.js',
  'scripts/run-lock.js',
  'scripts/territory-manager.js',
  'scripts/territory-scheduler.js',
  'scripts/territory-utils.js',
  'scripts/zoho-attach-resume.js',
  'scripts/zoho-auth.js',
  'scripts/zoho-create-candidate.js',
  'scripts/lib/caterer-credentials.js',
  'scripts/lib/pipeline-halt.js',
  'scripts/lib/postcode-to-city.js',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

const shipped = [...OWNED.map(f => path.join(H.RES, f)), ...walk(__dirname)];

test('every owned file exists', () => {
  for (const f of OWNED) assert.ok(fs.existsSync(path.join(H.RES, f)), f);
  assert.ok(fs.existsSync(path.join(H.RES, 'scripts', 'extract-js.b64')));
});

test('source is ASCII-only with LF line endings', () => {
  for (const f of shipped) {
    const s = fs.readFileSync(f, 'utf8');
    const bad = [...s].find(c => c.codePointAt(0) > 127);
    assert.equal(bad, undefined, `${path.relative(H.REPO, f)} has a non-ASCII character U+${bad ? bad.codePointAt(0).toString(16) : ''}`);
    assert.ok(!s.includes('\r'), `${path.relative(H.REPO, f)} has CR characters`);
  }
});

test('none of the banned platform tokens appear (DESIGN.md section 9)', () => {
  for (const f of shipped) {
    const low = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const t of BANNED) assert.ok(!low.includes(t.toLowerCase()), `${path.relative(H.REPO, f)} contains a banned token (${t.length} chars: ${t.slice(0, 3)}...)`);
  }
});

test('every JavaScript file parses', () => {
  for (const f of shipped.filter(x => x.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(H.REPO, f)}: ${r.stderr.split('\n')[0]}`);
  }
});

test('the JSON data files parse', () => {
  for (const f of shipped.filter(x => x.endsWith('.json'))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), f);
});

test('no credential-looking literals (long token strings, key assignments) in shipped source', () => {
  const patterns = [/sk-[A-Za-z0-9]{20,}/, /Bearer [A-Za-z0-9._-]{30,}/, /(api[_-]?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i];
  for (const f of OWNED.filter(x => x.endsWith('.js')).map(x => path.join(H.RES, x))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of patterns) assert.ok(!re.test(s), `${path.relative(H.REPO, f)} matches ${re}`);
  }
});

test('the scripts that are CLIs answer --help with exit 0 and no side effects', () => {
  const home = H.makeHome('help');
  const clis = [
    'candidates-db.js', 'scripts/applying-for-role-map.js', 'scripts/build-caterer-results-url.js', 'scripts/caterer-fetch-results.js',
    'scripts/caterer-keepalive.js', 'scripts/create-init-status.js', 'scripts/cull-ghost-phase1.js', 'scripts/fill-mandatory-fields.js',
    'scripts/migrate-reed-schema.js', 'scripts/pending-gate.js', 'scripts/pipeline-halt-cli.js', 'scripts/pipeline-optimiser.js',
    'scripts/postcode-lookup.js', 'scripts/query-territory.js', 'scripts/queue-due-territories.js', 'scripts/recover-stranded-phase1.js',
    'scripts/run-lock.js', 'scripts/territory-manager.js', 'scripts/territory-scheduler.js', 'scripts/zoho-attach-resume.js',
    'scripts/zoho-create-candidate.js',
  ];
  for (const rel of clis) {
    const r = H.run(rel, ['--help'], { home });
    assert.equal(r.status, 0, `${rel}: ${r.stderr.split('\n')[0]}`);
    assert.ok(r.stdout.length > 0, `${rel} printed nothing`);
  }
  const leftovers = fs.readdirSync(home).filter(n => n !== 'config');
  assert.deepEqual(leftovers, [], 'help must not create any file or directory');
});
