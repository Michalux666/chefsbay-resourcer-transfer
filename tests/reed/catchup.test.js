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
  assert.deepEqual(s.excluded, { notAskingForReed: 1, disabled: 1, queuedOrRunning: 1, heldByCvScreening: 0, ranToday: 1, noTerritoryRow: 0 });
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

// ---------------------------------------------------------------- release additions

test('R5: "ran today" is the LONDON day of run_results (between 00:00 and 01:00 BST it is already tomorrow in UTC)', async () => {
  // 23:30 UTC on 30 September is 00:30 BST on 1 October: a run recorded with the date 2026-10-01 ran today, one dated 2026-09-30 did not.
  const world = [
    ['Alpha Role', 'NG1', 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: FAILED }]],
    ['Alpha Role', 'LS1', 'both', 1, [{ date: '2026-09-30', sources: 'both', reed: FAILED }]],
  ];
  build({ world });
  const r = await run(['--since', '2026-09-30', '--json'], { now: new Date('2026-09-30T23:30:00Z') });
  assert.equal(r.code, 0, r.err);
  const s = JSON.parse(r.out);
  assert.equal(s.excluded.ranToday, 1);
  assert.deepEqual(s.categories.failed.codes, ['LS1']);
});

test('R5: the failure rate of ACCEPTANCE RE08 is printed per run day without reading a log (attempts = runs that asked for Reed and did not stop before it)', async () => {
  build();
  const s = await json([]);
  assert.deepEqual(s.reedByDay, [
    { date: '2026-09-30', attempts: 4, failed: 4, failedPercent: 100 },
    { date: '2026-10-01', attempts: 4, failed: 1, failedPercent: 25 },
    { date: '2026-10-02', attempts: 1, failed: 1, failedPercent: 100 },
  ]);
  const r = await run([]);
  assert.match(r.out, /Reed attempts by run day[^\n]*2026-10-01 4 attempts, 1 failed \(25%\)/);
});

// ---------------------------------------------------------------- view reservation: only searches that are still PENDING reserve views

// 28 catch-ups that FINISHED today (a run row dated today; their pending files are gone) and 40 territories that still lost their Reed half
function reservationWorld(opts) {
  const o = Object.assign({ finished: 28, fresh: 40, usage: [39, 600] }, opts || {});
  const world = [];
  for (let i = 1; i <= o.finished; i++) world.push(['Alpha Role', `FA${i}`, 'both', 1, [{ date: TODAY, sources: 'both', reed: OK }]]);
  for (let i = 1; i <= o.fresh; i++) world.push(['Alpha Role', `NB${i}`, 'both', 1, [{ date: '2026-10-01', sources: 'both', reed: FAILED }]]);
  build({ world, usage: o.usage });
  if (o.noUsageTable) { const db = new Database(path.join(HOME, 'candidates.db')); db.exec('DROP TABLE reed_daily_usage'); db.close(); }
  const keys = [];
  for (let i = 1; i <= o.finished; i++) keys.push(tool.keyOf('Alpha Role', `FA${i}`, ''));
  fs.mkdirSync(path.join(HOME, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'runtime', 'reed-catchup.json'), JSON.stringify({ days: { [TODAY]: keys } }));
  return keys;
}
const catchupPending = (n, extra) => {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(HOME, 'pending-searches', `zz-reed-catchup-1790000000${String(i).padStart(3, '0')}-0000000${i % 10}.json`),
      JSON.stringify({ jobTitle: 'Alpha Role', location: `PD${i}`, sources: 'both', source: 'reed-catchup', priority: 'low', ...(extra || {}) }));
  }
};

test('R5 reservation: the live case. 39 of 600 views used, 28 catch-ups queued and FINISHED today, a request for 30: the finished ones reserve nothing, 28 may be queued (the old formula gave floor(561 / 20) - 28 = 0)', async () => {
  reservationWorld();
  assert.equal(Math.floor((600 - 39) / tool.CV_RESERVE) - 28, 0, 'what the old formula allowed');
  const s = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(s.queue.pendingCatchups, 0);
  assert.equal(s.queue.queuedToday, 28);
  assert.equal(s.queue.allowedByBudget, 28);
  assert.equal(s.queue.wouldQueue, 28);
  assert.match(s.queue.reason, /not enough of the Reed daily view budget left/);
  assert.deepEqual(pendingFiles(), [], 'a dry run writes nothing');
  const r = await run(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.match(r.out, /view budget allows 28 more \(0 catch-up searches still pending reserve 20 views each; finished ones are counted in the views used\): would queue 28/);
  const real = await json(['--queue', '30', '--per-day', '100']);
  assert.equal(real.queue.wouldQueue, 28);
  assert.equal(pendingFiles().length, 28);
  // they are pending now: each reserves its views, so a second request finds the budget used up (28 reserved of 28)
  const again = await json(['--queue', '30', '--per-day', '100']);
  assert.equal(again.queue.pendingCatchups, 28);
  assert.equal(again.queue.allowedByBudget, 0);
  assert.equal(again.queue.wouldQueue, 0);
  assert.match(again.queue.reason, /budget/);
  assert.equal(pendingFiles().length, 28, 'nothing more was queued');
});

test('R5 reservation: pending catch-ups reserve their views: files still in pending-searches/ (by name, by source, or unreadable) count; other searches, hidden files and the quarantine do not', async () => {
  reservationWorld();
  catchupPending(5); // queued earlier today, not run yet
  fs.writeFileSync(path.join(HOME, 'pending-searches', 'hand-renamed.json'), JSON.stringify({ jobTitle: 'Alpha Role', location: 'HR1', sources: 'both', source: 'reed-catchup' }));
  fs.writeFileSync(path.join(HOME, 'pending-searches', 'zz-reed-catchup-1790000009999-deadbeef.json'), '{ not json');
  fs.writeFileSync(path.join(HOME, 'pending-searches', 'zz-rescreen-1790000000000-aaaaaaaa.json'), JSON.stringify({ jobTitle: 'Alpha Role', location: 'RS1', sources: 'both', source: 'rescreen-policy-rejects' }));
  fs.writeFileSync(path.join(HOME, 'pending-searches', 'territory-5-20261002.json'), JSON.stringify({ jobTitle: 'Alpha Role', location: 'TS1', sources: 'both' }));
  fs.writeFileSync(path.join(HOME, 'pending-searches', '.zz-reed-catchup-hidden.json'), JSON.stringify({ source: 'reed-catchup' }));
  fs.mkdirSync(path.join(HOME, 'pending-searches', '.quarantine'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'pending-searches', '.quarantine', 'zz-reed-catchup-1790000000000-quarant.json'), JSON.stringify({ jobTitle: 'Alpha Role', location: 'QU1', sources: 'both', source: 'reed-catchup' }));
  const s = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(s.queue.pendingCatchups, 7, '5 by name, 1 by source, 1 unreadable');
  assert.equal(s.queue.allowedByBudget, 21, 'floor(561 / 20) - 7');
  assert.equal(s.queue.wouldQueue, 21);
  // a run that finished deletes its file: its reserve goes away (its real views are in reed_daily_usage by then)
  for (const f of fs.readdirSync(path.join(HOME, 'pending-searches')).filter((n) => /^zz-reed-catchup-17900000000(00|01)-/.test(n))) fs.unlinkSync(path.join(HOME, 'pending-searches', f));
  const freed = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(freed.queue.pendingCatchups, 5);
  assert.equal(freed.queue.allowedByBudget, 23);
});

test('R5 reservation: the per-day ledger keeps its meaning (a hard total per UTC day) and the budget never goes below zero', async () => {
  reservationWorld();
  const perDay = await json(['--queue', '30', '--per-day', '30', '--dry-run']);
  assert.equal(perDay.queue.allowedByBudget, 28);
  assert.equal(perDay.queue.wouldQueue, 2, '30 per day minus the 28 already queued today');
  assert.equal(perDay.queue.reason, 'per-day limit reached');
  catchupPending(40); // more pending than the whole budget
  const over = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(over.queue.allowedByBudget, 0);
  assert.equal(over.queue.wouldQueue, 0);
  assert.match(over.queue.reason, /budget/);
});

test('R5 reservation: with the usage table missing the fallback limit (300) applies and pending catch-ups still reserve; with the table present but today without a row it is the same', async () => {
  reservationWorld({ noUsageTable: true, finished: 0, fresh: 30 });
  const none = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(none.reedBudget, null);
  assert.equal(none.queue.allowedByBudget, 15, 'floor(300 / 20)');
  assert.equal(none.queue.wouldQueue, 15);
  catchupPending(3);
  const some = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(some.queue.pendingCatchups, 3);
  assert.equal(some.queue.allowedByBudget, 12);
  assert.equal(some.queue.wouldQueue, 12);
  reservationWorld({ usage: null, finished: 0, fresh: 30 });
  const norow = await json(['--queue', '30', '--per-day', '100', '--dry-run']);
  assert.equal(norow.queue.allowedByBudget, 15);
});

test('R5 reservation: a refused queue (Reed off) still reports the plan with the pending reserve and writes nothing', async () => {
  reservationWorld();
  catchupPending(2);
  const off = await run(['--queue', '5', '--json'], { env: { RESOURCER_HOME: HOME, RESOURCER_SOURCES: 'caterer' } });
  assert.equal(off.code, 3);
  assert.equal(JSON.parse(off.out).queue.pendingCatchups, 2);
  assert.equal(pendingFiles().length, 2, 'only the two that were there');
});
