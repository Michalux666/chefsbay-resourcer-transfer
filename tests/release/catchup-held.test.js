'use strict';
// Release integration (STEP 2 f): tools/reed-catchup.js never lists or queues a territory whose run is merely HELD by CV screening (Update C, exit 14
// phase2-held): the held queue is completed by the stranded-run recovery once the screening halt clears, and a catch-up run queued now would only hold
// again. Anything else keeps its old behaviour: a held run that was COMPLETED, an old one (the recovery ignores files over 7 days) and another place.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-held-'));
process.env.RESOURCER_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { dep } = require('../reed/helpers/mirror');
const tool = require('../../tools/reed-catchup');

const Database = dep('better-sqlite3');
const NOW = new Date('2026-10-02T12:00:00Z');
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const FAILED = { pool: 0, errors: 1, status: 'failed', failed: true, failureReason: 'HTTP 400 code 50010', authFailed: false };
const PLACES = ['LS1', 'M1', 'YO2', 'B1'];

function build(statusFiles) {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const d of ['logs', 'pending-searches', 'runs', 'runtime']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
  const db = new Database(path.join(HOME, 'candidates.db'));
  db.exec(`CREATE TABLE territory_searches (id INTEGER PRIMARY KEY, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT DEFAULT '', priority TEXT DEFAULT 'low', enabled INTEGER DEFAULT 1, active_within TEXT DEFAULT '1 month', cv_limit INTEGER DEFAULT 20, sources TEXT, next_run_date TEXT);
    CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT, completed_at TEXT, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT, sources TEXT, reed_json TEXT);
    CREATE TABLE reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER, cv_downloads INTEGER, daily_limit INTEGER);`);
  PLACES.forEach((loc, i) => {
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, sources, enabled) VALUES ('Alpha Role', ?, 20, 'both', 1)").run(loc);
    db.prepare("INSERT INTO run_results (run_key, date, completed_at, job_title, location, distance, keywords, sources, reed_json) VALUES (?, '2026-10-01', ?, 'Alpha Role', ?, 20, '', 'both', ?)")
      .run(`run-${i}`, `2026-10-01T1${i}:00:00.000Z`, loc, JSON.stringify(FAILED));
  });
  db.close();
  statusFiles.forEach(([loc, extra], i) => fs.writeFileSync(path.join(HOME, 'runs', `phase1-2026-10-01T1${i}-00-00.json`), JSON.stringify({
    id: `phase1-${i}`, jobTitle: 'Alpha Role', location: loc, sources: 'both', status: 'phase1_abandoned', startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:30:00.000Z', ...extra,
  })));
}

async function json(args) {
  const out = [];
  const err = [];
  const code = await tool.main([...args, '--json'], { out: (s) => out.push(s), err: (s) => err.push(s), now: NOW, env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'both' } });
  assert.equal(code, 0, err.join('\n'));
  return JSON.parse(out.join('\n'));
}
const HOLD = { phase2Hold: { reason: 'cv-screening-unavailable', at: '2026-10-01T10:20:00.000Z' } };

test('a held run is left out of the list, counted as held by CV screening, and never queued', async () => {
  build([['LS1', HOLD]]);
  const s = await json([]);
  assert.deepEqual(s.categories.failed.codes.slice().sort(), ['B1', 'M1', 'YO2']);
  assert.equal(s.excluded.heldByCvScreening, 1);
  const q = await json(['--queue', '10']);
  assert.ok(!q.queue.codes.includes('LS1'), 'the dry-run plan never names the held territory');
  const r = await tool.main(['--queue', '10'], { out: () => {}, err: () => {}, now: NOW, env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'both' } });
  assert.equal(r, 0);
  const written = fs.readdirSync(path.join(HOME, 'pending-searches')).filter((f) => f.startsWith('zz-reed-catchup-'));
  assert.equal(written.length, 3, 'three queued, the held one is not among them');
  for (const f of written) assert.notEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'pending-searches', f), 'utf8')).location, 'LS1');
  const text = [];
  await tool.main([], { out: (x) => text.push(x), err: () => {}, now: NOW, env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'both' } });
  assert.match(text.join('\n'), /held by CV screening 1/);
});

test('a held run that was completed, one older than 7 days and a hold of another place do not keep a territory out', async () => {
  build([
    ['LS1', { ...HOLD, status: 'complete', phase2Complete: true }],
    ['M1', { ...HOLD, startedAt: '2026-09-20T10:00:00.000Z' }],
    ['ZZ9', HOLD],
  ]);
  const s = await json([]);
  assert.deepEqual(s.categories.failed.codes.slice().sort(), ['B1', 'LS1', 'M1', 'YO2']);
  assert.equal(s.excluded.heldByCvScreening, 0);
});
