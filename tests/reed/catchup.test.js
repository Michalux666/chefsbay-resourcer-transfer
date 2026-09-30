'use strict';

// tools/reed-catchup.js (R5): which territories lost their Reed half, what is printed (counts and territory codes only), and the queueing rules
// (unique names, sources both, priority low, never queued/running/ran-today, per-day limit, Reed daily budget, idempotent).

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'catchup-'));
process.env.RESOURCER_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');

const test = require('node:test');
const assert = require('node:assert/strict');
const { dep } = require('./helpers/mirror');
const tool = require('../../tools/reed-catchup');
const gate = require('../../resourcer/scripts/pending-gate');

const Database = dep('better-sqlite3');
const NOW = new Date('2026-10-02T12:00:00Z');
const TODAY = '2026-10-02';

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const FAILED = { pool: 0, errors: 1, status: 'failed', failed: true, failureReason: 'HTTP 400 code 50010', authFailed: false };
const OK = { pool: 30, errors: 0, status: 'ok', authFailed: false };
const OLD_EMPTY = { pool: 0, newToZoho: 0, errors: 0, authFailed: false, phase1: { pagesScraped: 1 } };

// [title, location, territory sources, enabled, runs[{date, sources, reed}]]
const WORLD = [
  ['Alpha Role', 'LS1', 'both', 1, [{ date: '2026-09-30', sources: 'both', reed: FAILED }]],
  ['Alpha Role', 'M1', 'both', 1, [{ date: '2026-10-01', sources: 'caterer', reed: null }]],
  ['Bravo Role', 'YO2', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: OLD_EMPTY }]],
  ['Bravo Role', 'LS2', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: OLD_EMPTY }]], // a genuine empty: no log evidence
  ['Alpha Role', 'B1', 'both', 1, [{ date: '2026-09-30', sources: 'both', reed: FAILED }, { date: '2026-10-01', sources: 'both', reed: OK }]], // recovered
  ['Alpha Role', 'EC1A', 'caterer', 1, [{ date: '2026-09-30', sources: 'caterer', reed: null }]], // asks for Caterer only
  ['Alpha Role', 'DT6', 'both', 0, [{ date: '2026-09-30', sources: 'both', reed: FAILED }]], // disabled
  ['Alpha Role', 'LE1', 'both', 1, [{ date: '2026-09-30', sources: 'both', reed: FAILED }]], // already queued (pending file)
  ['Alpha Role', 'NG1', 'both', 1, [{ date: TODAY, sources: 'both', reed: FAILED }]], // ran today
  ['Alpha Role', 'W1', 'both', 1, [{ date: '2026-09-20', sources: 'both', reed: FAILED }]], // before --since
  ['Alpha Role', 'SW1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: { pool: 0, errors: 0, status: 'not_run' } }]],
  ['Alpha Role', 'AB1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: { pool: 0, errors: 0, authFailed: true, authFailureReason: 'turnstile_blocked' } }]],
];
const EXPECT_LISTED = { failed: ['LS1', 'AB1'], skipped: ['SW1'], reed_off: ['M1'], empty_with_log_failure: ['YO2'] };

function build(opts = {}) {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const d of ['logs', 'pending-searches', 'runs', 'runtime']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
  const db = new Database(path.join(HOME, 'candidates.db'));
  db.exec(`CREATE TABLE territory_searches (id INTEGER PRIMARY KEY, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT DEFAULT '', priority TEXT DEFAULT 'low', enabled INTEGER DEFAULT 1, active_within TEXT DEFAULT '1 month', cv_limit TEXT DEFAULT '20', sources TEXT DEFAULT 'both');
    CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT, completed_at TEXT, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT, sources TEXT, reed_json TEXT);
    CREATE TABLE reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER, cv_downloads INTEGER, daily_limit INTEGER);`);
  let n = 0;
  for (const [title, loc, src, enabled, runs] of (opts.world || WORLD)) {
    db.prepare('INSERT INTO territory_searches (job_title, location, distance, sources, enabled) VALUES (?,?,20,?,?)').run(title, loc, src, enabled);
    for (const r of runs) {
      n++;
      db.prepare('INSERT INTO run_results (run_key, date, completed_at, job_title, location, distance, keywords, sources, reed_json) VALUES (?,?,?,?,?,20,?,?,?)')
        .run(`run-${n}`, r.date, `${r.date}T${String(9 + n % 10).padStart(2, '0')}:00:00.000Z`, title, loc, '', r.sources, r.reed ? JSON.stringify(r.reed) : null);
    }
  }
  if (opts.usage) db.prepare('INSERT INTO reed_daily_usage VALUES (?,?,?,?)').run(TODAY, opts.usage[0], 0, opts.usage[1]);
  db.close();
  // a pending file for LE1 (already queued) and a log with the first-page failure of YO2 plus data that must never be printed
  fs.writeFileSync(path.join(HOME, 'pending-searches', 'territory-9-20261001.json'), JSON.stringify({ jobTitle: 'Alpha Role', location: 'LE1', sources: 'both' }));
  const log = path.join(HOME, 'logs', 'phase1-console-20261001-100000.log');
  fs.writeFileSync(log, [
    '[reed] [reed-search] POST /candidate/search/boolean/ - "Bravo Role" near YO2 (20mi, month, page 1)',
    '[reed] [reed-phase1] FATAL: Could not fetch first page: Reed API POST HTTP 400: {"errorCode":50010}',
    '[reed] candidate Jane Personperson jane.personperson@example.invalid 07000 000000',
    '[reed] [reed-search] POST /candidate/search/boolean/ - "Bravo Role" near LS2 (20mi, month, page 1)',
    '[reed] Total pool: 0 candidates',
  ].join('\n'));
  fs.utimesSync(log, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
}

async function run(args, extra) {
  const out = [];
  const err = [];
  const code = await tool.main(args, { out: (s) => out.push(s), err: (s) => err.push(s), now: NOW, env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'both' }, ...(extra || {}) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const json = async (args) => { const r = await run([...args, '--json']); assert.equal(r.code, 0, r.err); return JSON.parse(r.out); };
const pendingFiles = () => fs.readdirSync(path.join(HOME, 'pending-searches')).filter((f) => f.startsWith('zz-reed-catchup-'));

test('R5: the four categories are found from the latest finished run of each territory; recovered, caterer-only, disabled, queued, ran-today and pre-since ones are left out', async () => {
  build();
  const s = await json([]);
  for (const [cat, codes] of Object.entries(EXPECT_LISTED)) assert.deepEqual(s.categories[cat].codes.slice().sort(), codes.slice().sort(), cat);
  assert.equal(s.territories, 5);
  assert.deepEqual(s.excluded, { notAskingForReed: 1, disabled: 1, queuedOrRunning: 1, ranToday: 1, noTerritoryRow: 0 });
  assert.equal(s.mode, 'dry-run');
  assert.equal(s.queue, null);
  assert.deepEqual(pendingFiles(), [], 'a dry run writes nothing');
  assert.equal(fs.existsSync(path.join(HOME, 'runtime', 'reed-catchup.json')), false);
});

test('R5: --since moves the window (the default is 2026-09-30) and the printed text carries counts and territory codes only', async () => {
  build();
  const early = await json(['--since', '2026-09-01']);
  assert.ok(early.categories.failed.codes.includes('W1'), 'an earlier start date sees the older loss');
  const late = await json(['--since', '2026-10-02']);
  assert.equal(late.territories, 0);
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /failed \(Reed failed or auth failed\): 2 {3}(LS1 AB1|AB1 LS1)/);
  assert.match(r.out, /reed_off \(recorded while Reed was off\): 1 {3}M1/);
  assert.match(r.out, /empty_with_log_failure .*: 1 {3}YO2/);
  assert.ok(!/Alpha|Bravo|Role/.test(r.out), 'no job title is printed');
  assert.ok(!/Jane|Personperson|example\.invalid|07000/.test(r.out), 'no personal data from the logs is printed');
  assert.match(r.out, /nothing was written/);
});

test('R5: a genuine empty Reed pool (old row, no log evidence) is not listed; the log evidence is matched by title and place', async () => {
  build();
  const s = await json([]);
  assert.ok(!s.categories.empty_with_log_failure.codes.includes('LS2'));
  assert.ok(s.categories.empty_with_log_failure.codes.includes('YO2'));
});

test('R5: --queue N writes unique files (sources both, priority low, a format the watcher accepts), records them, and is idempotent', async () => {
  build();
  const first = await json(['--queue', '3', '--per-day', '10']);
  assert.equal(first.mode, 'queue');
  assert.equal(first.queue.wouldQueue, 3);
  const files = pendingFiles();
  assert.equal(files.length, 3);
  assert.equal(new Set(files).size, 3);
  assert.ok(files.every((f) => /^zz-reed-catchup-\d+-[0-9a-f]{8}\.json$/.test(f)), files.join(','));
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(HOME, 'pending-searches', f), 'utf8'));
    assert.equal(p.sources, 'both');
    assert.equal(p.priority, 'low');
    assert.equal(p.source, 'reed-catchup');
    assert.equal(p.spawnedAt, undefined, 'never a claim stamp');
    assert.equal(gate.validatePending(p), null, 'the watcher accepts the file');
    assert.ok(['failed', 'skipped', 'reed_off', 'empty_with_log_failure'].includes(p.catchupReason));
  }
  // oldest loss first, failures before the rest
  assert.deepEqual(first.queue.codes.slice().sort(), ['AB1', 'LS1', 'SW1']);
  const ledger = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime', 'reed-catchup.json'), 'utf8'));
  assert.equal(ledger.days[TODAY].length, 3);
  // the same call again: the three are queued now, so only the others are taken; never the same territory twice
  const second = await json(['--queue', '3', '--per-day', '10']);
  assert.equal(second.queue.wouldQueue, 2, 'only two territories are left');
  assert.equal(pendingFiles().length, 5);
  const third = await json(['--queue', '3', '--per-day', '10']);
  assert.equal(third.queue.wouldQueue, 0);
  assert.equal(pendingFiles().length, 5, 'nothing new');
  const titles = pendingFiles().map((f) => JSON.parse(fs.readFileSync(path.join(HOME, 'pending-searches', f), 'utf8')).location);
  assert.equal(new Set(titles).size, 5, 'no territory twice');
});

test('R5: two calls in the same millisecond cannot overwrite each other (random suffix, unlike the minute-named helper)', async () => {
  build();
  const fixed = { now: NOW };
  const a = await run(['--queue', '1', '--per-day', '10'], fixed);
  const b = await run(['--queue', '1', '--per-day', '10'], fixed);
  assert.equal(a.code + b.code, 0);
  assert.equal(pendingFiles().length, 2);
});

test('R5: --per-day is a hard limit per UTC day across calls', async () => {
  build();
  const a = await json(['--queue', '10', '--per-day', '2']);
  assert.equal(a.queue.wouldQueue, 2);
  assert.equal(a.queue.reason, 'per-day limit reached');
  const b = await json(['--queue', '10', '--per-day', '2']);
  assert.equal(b.queue.wouldQueue, 0);
  assert.equal(b.queue.reason, 'per-day limit reached');
  assert.equal(pendingFiles().length, 2);
  const c = await json(['--queue', '10', '--per-day', '3']);
  assert.equal(c.queue.wouldQueue, 1, 'raising the limit allows the difference only');
});

test('R5: Reed daily usage key: nothing is queued once the day\'s views reach the limit, and each catch-up file reserves the views of one run', async () => {
  build({ usage: [600, 600] });
  let s = await json(['--queue', '5', '--per-day', '10']);
  assert.equal(s.queue.wouldQueue, 0);
  assert.match(s.queue.reason, /daily view budget is used up/);
  assert.deepEqual(s.reedBudget, { used: 600, limit: 600 });
  build({ usage: [565, 600] }); // 35 views left: one run's reserve (20), not two
  s = await json(['--queue', '5', '--per-day', '10']);
  assert.equal(s.queue.wouldQueue, 1);
  assert.equal(s.queue.allowedByBudget, 1);
  assert.match(s.queue.reason, /budget/);
  build({ usage: [0, 600] });
  s = await json(['--queue', '5', '--per-day', '10']);
  assert.equal(s.queue.wouldQueue, 5);
  assert.equal(s.queue.reason, null);
});

test('R5: --queue with --dry-run prints the plan and writes nothing; bad usage exits 2; --help exits 0', async () => {
  build();
  const d = await run(['--queue', '2', '--dry-run']);
  assert.equal(d.code, 0);
  assert.match(d.out, /would queue 2/);
  assert.deepEqual(pendingFiles(), []);
  for (const bad of [['--since', 'yesterday'], ['--queue', 'many'], ['--per-day', '-1'], ['--nonsense'], ['--queue']]) {
    const r = await run(bad);
    assert.equal(r.code, 2, bad.join(' '));
  }
  assert.equal((await run(['--help'])).code, 0);
  const missing = await run(['--home', path.join(HOME, 'nowhere')]);
  assert.equal(missing.code, 1);
});

test('R5: an unwritable pending folder is reported with exit 4 and nothing is half-written', async () => {
  build();
  fs.rmSync(path.join(HOME, 'pending-searches'), { recursive: true, force: true });
  fs.writeFileSync(path.join(HOME, 'pending-searches'), 'not a folder');
  const r = await run(['--queue', '2']);
  assert.equal(r.code, 4, r.err);
});

test('R5: the Reed-pending mark of the territory map counts when no run row exists any more; an old mark before --since does not', async () => {
  build();
  const db = new Database(path.join(HOME, 'candidates.db'));
  db.exec('ALTER TABLE territory_searches ADD COLUMN reed_pending_since TEXT');
  db.prepare("INSERT INTO territory_searches (job_title, location, distance, sources, enabled, reed_pending_since) VALUES ('Alpha Role', 'CV1', 20, 'both', 1, '2026-10-01')").run();
  db.prepare("INSERT INTO territory_searches (job_title, location, distance, sources, enabled, reed_pending_since) VALUES ('Alpha Role', 'CV2', 20, 'both', 1, '2026-09-10')").run();
  db.close();
  const s = await json([]);
  assert.ok(s.categories.failed.codes.includes('CV1'));
  assert.ok(!s.categories.failed.codes.includes('CV2'));
  assert.equal(s.territories, 6);
});

// ---------------------------------------------------------------- finalizer additions (review findings)

test('R5: two catch-up processes started together queue each territory once (analysis, plan and ledger are read under the lock)', async () => {
  build();
  const [a, b] = await Promise.all([run(['--queue', '5', '--per-day', '5', '--json']), run(['--queue', '5', '--per-day', '5', '--json'])]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const places = pendingFiles().map((f) => JSON.parse(fs.readFileSync(path.join(HOME, 'pending-searches', f), 'utf8')).location);
  assert.equal(places.length, 5, 'the per-day limit holds across the two processes');
  assert.equal(new Set(places).size, 5, 'no territory twice');
});

test('R5: --queue refuses while Reed is switched off: exit 3, nothing written, the list is still printed; a dry run is not refused', async () => {
  build();
  const off = await run(['--queue', '2', '--json'], { env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'caterer' } });
  assert.equal(off.code, 3);
  assert.match(off.err, /NOT QUEUED: Reed is switched off/);
  assert.deepEqual(pendingFiles(), []);
  assert.equal(fs.existsSync(path.join(HOME, 'runtime', 'reed-catchup.json')), false);
  assert.equal(JSON.parse(off.out).queue.wouldQueue, 0);
  assert.equal(JSON.parse(off.out).territories, 5);
  const unset = await run(['--queue', '2'], { env: { RESOURCER_HOME: HOME } });
  assert.equal(unset.code, 3, 'an unset RESOURCER_SOURCES means Caterer only');
  const dry = await run(['--queue', '2', '--dry-run'], { env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'caterer' } });
  assert.equal(dry.code, 0);
  const on = await run(['--queue', '2'], { env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'reed' } });
  assert.equal(on.code, 0);
  assert.equal(pendingFiles().length, 2);
});

test('R5: an open Reed-pending mark is listed even when the latest run was halted or hit the daily view limit (those runs do not clear it)', async () => {
  build({
    world: [
      ['Alpha Role', 'HA1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: { pool: 0, errors: 1, status: 'halted', screeningHalted: true } }]],
      ['Alpha Role', 'LI1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: { pool: 0, errors: 0, status: 'limit', dailyLimitReached: true } }]],
      ['Alpha Role', 'OK1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: OK }]],
      ['Alpha Role', 'HB1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: { pool: 0, errors: 1, status: 'halted', screeningHalted: true } }]], // halted, no open mark
    ],
  });
  const db = new Database(path.join(HOME, 'candidates.db'));
  db.exec('ALTER TABLE territory_searches ADD COLUMN reed_pending_since TEXT');
  db.prepare("UPDATE territory_searches SET reed_pending_since = '2026-10-01' WHERE location IN ('HA1', 'LI1')").run();
  db.close();
  const s = await json([]);
  assert.deepEqual(s.categories.failed.codes.slice().sort(), ['HA1', 'LI1']);
  assert.equal(s.territories, 2, 'a halted run without a mark, and a good run, are not listed');
});

test('R5: an old log line for a place Reed could not look up is not counted as a first-page failure', async () => {
  build();
  fs.appendFileSync(path.join(HOME, 'logs', 'phase1-console-20261001-100000.log'), [
    '',
    '[reed] [reed-search] POST /candidate/search/boolean/ - "Bravo Role" near YO2 (20mi, month, page 1)',
  ].join(String.fromCharCode(10)));
  // LS2 has a failure line in the log that is an unsearchable place, not a failure: it must not make LS2 listed
  fs.appendFileSync(path.join(HOME, 'logs', 'phase1-console-20261001-100000.log'), [
    '',
    '[reed] [reed-search] POST /candidate/search/boolean/ - "Bravo Role" near LS2 (20mi, month, page 1)',
    '[reed] [reed-phase1] FATAL: Could not fetch first page: No locations found for "LS2"',
  ].join(String.fromCharCode(10)));
  const s = await json([]);
  assert.ok(!s.categories.empty_with_log_failure.codes.includes('LS2'));
});

test('R5: two catch-up PROCESSES started at the same moment queue each territory once (the lock covers the analysis, not only the write)', async () => {
  build();
  const { spawn } = require('child_process');
  const script = path.join(__dirname, '..', '..', 'tools', 'reed-catchup.js');
  const go = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [script, '--queue', '5', '--per-day', '5', '--since', '2026-09-01', '--home', HOME, '--json'], {
      env: { ...process.env, RESOURCER_HOME: HOME, RESOURCER_ENV_FILE: path.join(HOME, 'none.env'), RESOURCER_SOURCES: 'both', REED_AUTH_HOLD_MIN: '0', REED_LOGIN_BLOCK_HOURS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let e = '';
    p.stderr.on('data', (c) => { e += c; });
    p.on('close', (code) => resolve({ code, err: e }));
  });
  const [a, b] = await Promise.all([go(), go()]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const places = pendingFiles().map((f) => JSON.parse(fs.readFileSync(path.join(HOME, 'pending-searches', f), 'utf8')).location);
  assert.equal(places.length, new Set(places).size, `no territory twice: ${places.join(',')}`);
  assert.ok(places.length <= 5, 'the per-day limit holds across the two processes');
  assert.ok(places.length >= 1);
});
