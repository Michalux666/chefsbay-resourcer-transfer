'use strict';

// Files the Reed side leaves on disk: CV extensions Phase 2 can find, atomic 0600 writes, queue files that carry personal data,
// and the daily profile-view budget as seen by reed-phase1.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withWorld, validSession, isWin, fileMode } = require('./helpers/world');
const { dep } = require('./helpers/mirror');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const CV_EXTENSIONS = ['.pdf', '.docx', '.doc', '.rtf', '.txt'];
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];

function seedUsage(m, row) {
  const D = dep('better-sqlite3');
  const db = new D(m.p('candidates.db'));
  db.exec('CREATE TABLE IF NOT EXISTS reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER DEFAULT 0, cv_downloads INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 600)');
  db.prepare('INSERT OR REPLACE INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit) VALUES (?, ?, ?, ?)').run(new Date().toISOString().slice(0, 10), row.views, 0, row.limit);
  db.close();
}

test('a CV the site labels .odt is saved under an extension Phase 2 searches for (it used to be saved as .odt and never found)', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.cvKind = 'odt';
  const r = await drive("const res = await require('./reed-download').downloadCandidate({ candidateId: 9001, queryId: 'q', cvOnly: true }); return res.cvPath && require('path').basename(res.cvPath);");
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.ok(CV_EXTENSIONS.includes(path.extname(r.result)), `saved as ${r.result}`);
  assert.deepStrictEqual(fs.readdirSync(m.p('downloads')), [r.result], 'one file, no temp file left behind');
}));

test('CV files are written atomically with mode 0600 (no cv-* name ever holds a partial file)', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive("const res = await require('./reed-download').downloadCandidate({ candidateId: 9002, queryId: 'q', cvOnly: true }); return require('path').basename(res.cvPath);");
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  const names = fs.readdirSync(m.p('downloads'));
  assert.deepStrictEqual(names, ['cv-reed-9002.txt']);
  if (!isWin) assert.strictEqual(fileMode(m.p('downloads', names[0])), 0o600);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'resourcer', 'scripts', 'reed-download.js'), 'utf8');
  assert.ok(!/fs\.writeFileSync\(cvPath/.test(src), 'no direct write to a CV path');
}));

test('the approved queue carries names and contact-adjacent data: it is written 0600', { skip: isWin }, () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.strictEqual(fileMode(m.p('downloads', 'reed-approved-queue-t1.json')), 0o600);
}));

test('daily budget: with no profile views left the run screens nothing, marks nothing and says why', () => world(async ({ m, run }) => {
  seedUsage(m, { views: 600, limit: 600 });
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^REED_DAILY_LIMIT: no Reed profile views left today/m);
  assert.strictEqual(m.readLines('ai-log.jsonl').length, 0, 'nothing was screened');
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  assert.deepStrictEqual(q.candidates, []);
  assert.strictEqual(q.phase1Stats.dailyLimitReached, true);
  const D = dep('better-sqlite3');
  const db = new D(m.p('candidates.db'), { readonly: true });
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE name = 'candidates'").get();
    if (has) assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n, 0, 'no candidate burned');
  } finally { db.close(); }
  assert.match(r.stdout, /^REED_PHASE1_SUMMARY:/m, 'the summary line lets run-pipeline merge the (empty) queue');
}));

test('daily budget: --cv-limit is lowered to the profile views that are left', () => world(async ({ m, run }) => {
  seedUsage(m, { views: 597, limit: 600 });
  const r = await run('reed-phase1.js', ARGS(['--cv-limit', '20']));
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /CV limit lowered from 20 to 3: that is all the Reed profile views left today/);
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  assert.strictEqual(q.candidates.length, 3);
}));

test('daily budget: plenty left changes nothing', () => world(async ({ m, run }) => {
  seedUsage(m, { views: 10, limit: 600 });
  const r = await run('reed-phase1.js', ARGS(['--cv-limit', '20']));
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /lowered/);
  assert.strictEqual(m.readJson('downloads/reed-approved-queue-t1.json').candidates.length, 20);
}));

test('the screening CLI is told the source is Reed (a card without the Reed-only fields is no longer logged as Caterer)', () => world(async ({ m, run }) => {
  const stub = fs.readFileSync(m.p('scripts', 'ai-review.js'), 'utf8');
  m.write('scripts/ai-review.js', stub.replace("const file = get('--candidates-file');", "const file = get('--candidates-file'); require('fs').appendFileSync(process.env.FAKE_AI_LOG + '.argv', JSON.stringify({ source: get('--source') }) + String.fromCharCode(10));"));
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const seen = m.readLines('ai-log.jsonl.argv');
  assert.ok(seen.length >= 1 && seen.every((x) => x.source === 'reed'), JSON.stringify(seen));
}));
