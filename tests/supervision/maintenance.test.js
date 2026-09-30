'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'maintbase');
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* skips below */ }
const maint = require(path.join(H.SRC_SCRIPTS, 'maintenance.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const DAY = 86400000;
const MB = 1024 * 1024;

function mkMaint(t, o = {}) {
  const home = H.mkHome(t, 'maint');
  const notify = H.collectNotifier();
  const now = o.now || Date.now();
  const ctx = maint.makeCtx(Object.assign({ home, now: () => now, notify, isBusy: () => false }, o.ctx || {}));
  return { home, ctx, notify, dirs: ctx.dirs };
}

function touch(file, ageMs, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size === undefined ? 10 : size, 65));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

// --- runs/ prune --------------------------------------------------------------------------------

test('pruneRuns: only run bookkeeping older than 7 days goes, by mtime, idempotently', (t) => {
  const m = mkMaint(t);
  const R = m.dirs.runs;
  touch(path.join(R, 'phase1-2026-09-01-1000.json'), 8 * DAY);
  touch(path.join(R, 'run-merged-queue-2026-09-01T10-00-00.json'), 10 * DAY);
  touch(path.join(R, 'params-watchdog-2026-09-01-100000.json'), 9 * DAY);
  touch(path.join(R, 'phase1-2026-09-01-1000.json.run-lock'), 9 * DAY);
  touch(path.join(R, 'phase1-fresh.json'), 1 * DAY);
  touch(path.join(R, 'phase1-boundary-in.json'), 6.9 * DAY);
  touch(path.join(R, 'phase1-boundary-out.json'), 7.1 * DAY);
  touch(path.join(R, 'notes.txt'), 90 * DAY);
  touch(path.join(R, 'other.json'), 90 * DAY);
  const r = maint.pruneRuns(m.ctx);
  assert.equal(r.deleted, 5);
  assert.deepEqual(fs.readdirSync(R).sort(), ['notes.txt', 'other.json', 'phase1-boundary-in.json', 'phase1-fresh.json']);
  assert.equal(maint.pruneRuns(m.ctx).deleted, 0, 'idempotent');
});

test('pruneRuns dry run reports without deleting', (t) => {
  const m = mkMaint(t, { ctx: { dryRun: true } });
  touch(path.join(m.dirs.runs, 'phase1-old.json'), 30 * DAY);
  const r = maint.pruneRuns(m.ctx);
  assert.equal(r.deleted, 1);
  assert.equal(fs.existsSync(path.join(m.dirs.runs, 'phase1-old.json')), true);
});

test('pruneRuns copes with a missing runs directory', (t) => {
  const m = mkMaint(t);
  fs.rmSync(m.dirs.runs, { recursive: true });
  assert.deepEqual(maint.pruneRuns(m.ctx), { deleted: 0, kept: 0, bytes: 0 });
});

// --- logs ---------------------------------------------------------------------------------------

test('rotateLogs: rotates oversized append-only logs, compresses old logs, deletes very old archives', async (t) => {
  const m = mkMaint(t);
  const L = m.dirs.logs;
  touch(path.join(L, 'watchdog-runner.jsonl'), 0, 6 * MB);
  touch(path.join(L, 'errors.jsonl'), 0, 10 * MB);
  touch(path.join(L, 'pipeline-performance.jsonl'), 0, 100);
  fs.writeFileSync(path.join(L, 'phase1-console-old.log'), 'old console output\n'.repeat(50));
  const old = new Date(Date.now() - 15 * DAY);
  fs.utimesSync(path.join(L, 'phase1-console-old.log'), old, old);
  touch(path.join(L, 'tick-recent.log'), 3 * DAY);
  touch(path.join(L, 'tick-old.log'), 20 * DAY);
  touch(path.join(L, 'ancient.log.gz'), 100 * DAY);
  touch(path.join(L, 'month-old.log.gz'), 30 * DAY);
  touch(path.join(L, 'readme.md'), 400 * DAY);

  const r = await maint.rotateLogs(m.ctx);
  assert.equal(r.rotated, 1);
  assert.equal(r.compressed, 2);
  assert.equal(r.deleted, 1);
  const names = fs.readdirSync(L).sort();
  assert.ok(!names.includes('watchdog-runner.jsonl'), 'the rotated log restarts empty on its next append');
  assert.ok(names.some((n) => /^watchdog-runner-\d{8}-\d{6}\.jsonl$/.test(n)));
  assert.ok(names.includes('errors.jsonl'), 'errors.jsonl has a 20 MB limit');
  assert.ok(names.includes('pipeline-performance.jsonl'));
  assert.ok(names.includes('tick-recent.log'));
  assert.ok(!names.includes('tick-old.log') && names.includes('tick-old.log.gz'));
  assert.ok(!names.includes('phase1-console-old.log') && names.includes('phase1-console-old.log.gz'));
  assert.ok(!names.includes('ancient.log.gz') && names.includes('month-old.log.gz'));
  assert.ok(names.includes('readme.md'), 'other file types are never touched');
  const text = zlib.gunzipSync(fs.readFileSync(path.join(L, 'phase1-console-old.log.gz'))).toString();
  assert.equal(text, 'old console output\n'.repeat(50));
  const age = Date.now() - fs.statSync(path.join(L, 'phase1-console-old.log.gz')).mtimeMs;
  assert.ok(age > 14 * DAY, 'archive keeps the original modification time');

  const again = await maint.rotateLogs(m.ctx);
  assert.deepEqual(again, { rotated: 0, compressed: 0, deleted: 0 }, 'idempotent');
});

test('rotateLogs dry run changes nothing', async (t) => {
  const m = mkMaint(t, { ctx: { dryRun: true } });
  touch(path.join(m.dirs.logs, 'a.log'), 30 * DAY);
  touch(path.join(m.dirs.logs, 'watchdog-runner.jsonl'), 0, 6 * MB);
  const r = await maint.rotateLogs(m.ctx);
  assert.equal(r.compressed, 1);
  assert.equal(r.rotated, 1);
  assert.deepEqual(fs.readdirSync(m.dirs.logs).sort(), ['a.log', 'watchdog-runner.jsonl']);
});

// --- Chrome cache cap ---------------------------------------------------------------------------

test('capChromeCache trims the oldest cache files to the cap and never touches cookies or storage', (t) => {
  const m = mkMaint(t);
  const S = m.dirs.state;
  for (let i = 0; i < 6; i++) touch(path.join(S, 'chrome', 'Default', 'Cache', 'Cache_Data', `f_${i}`), (10 - i) * DAY, 1 * MB);
  touch(path.join(S, 'chrome', 'Default', 'Code Cache', 'js', 'a'), 20 * DAY, 1 * MB);
  touch(path.join(S, 'chrome', 'Default', 'GPUCache', 'entry_1'), 2 * DAY, 1 * MB);
  touch(path.join(S, 'chrome', 'Default', 'Cookies'), 100 * DAY, 2 * MB);
  touch(path.join(S, 'chrome', 'Default', 'Local Storage', 'leveldb', '000003.log'), 100 * DAY, 1 * MB);
  touch(path.join(S, 'caterer-session.json'), 100 * DAY, 1000);
  const r = maint.capChromeCache(m.ctx, { capMb: 4 });
  assert.equal(r.beforeMb, 8);
  assert.equal(r.afterMb, 4);
  assert.equal(r.deleted, 4);
  assert.ok(!fs.existsSync(path.join(S, 'chrome', 'Default', 'Code Cache', 'js', 'a')), 'oldest first');
  assert.ok(!fs.existsSync(path.join(S, 'chrome', 'Default', 'Cache', 'Cache_Data', 'f_0')));
  assert.ok(fs.existsSync(path.join(S, 'chrome', 'Default', 'GPUCache', 'entry_1')), 'newest survives');
  assert.ok(fs.existsSync(path.join(S, 'chrome', 'Default', 'Cookies')));
  assert.ok(fs.existsSync(path.join(S, 'chrome', 'Default', 'Local Storage', 'leveldb', '000003.log')));
  assert.ok(fs.existsSync(path.join(S, 'caterer-session.json')));
  assert.equal(maint.capChromeCache(m.ctx, { capMb: 4 }).deleted, 0, 'idempotent');
});

test('capChromeCache does nothing under the cap and skips while a run is in flight', (t) => {
  const m = mkMaint(t);
  touch(path.join(m.dirs.state, 'c', 'Cache', 'x'), 1 * DAY, 2 * MB);
  assert.equal(maint.capChromeCache(m.ctx, { capMb: 500 }).deleted, 0);
  const busy = mkMaint(t, { ctx: { isBusy: () => true } });
  touch(path.join(busy.dirs.state, 'c', 'Cache', 'x'), 1 * DAY, 2 * MB);
  assert.deepEqual(maint.capChromeCache(busy.ctx, { capMb: 1 }), { skipped: 'busy', beforeMb: null, afterMb: null, deleted: 0 });
  assert.ok(fs.existsSync(path.join(busy.dirs.state, 'c', 'Cache', 'x')));
});

test('capChromeCache with a real run record honours liveness', (t) => {
  const home = H.mkHome(t, 'cachebusy');
  const ctx = maint.makeCtx({ home, notify: H.collectNotifier() });
  touch(path.join(home, 'state', 'c', 'Cache', 'x'), DAY, 2 * MB);
  const live = H.sleeper(t);
  H.writeJson(tick.runtimeFiles(home).run, { pid: live.pid, token: tick.procToken(live.pid), nonce: 'n' });
  assert.equal(maint.capChromeCache(ctx, { capMb: 1 }).skipped, 'busy');
  live.kill();
});

test('capChromeCache survives a symlink loop', { skip: H.IS_WIN && 'symlinks need privileges on Windows' }, (t) => {
  const m = mkMaint(t);
  const d = path.join(m.dirs.state, 'c', 'Cache');
  fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(m.dirs.state, 'c'), path.join(d, 'loop'));
  touch(path.join(d, 'f'), DAY, 1000);
  assert.doesNotThrow(() => maint.capChromeCache(m.ctx, { capMb: 500 }));
});

// --- tmp / outbox -------------------------------------------------------------------------------

test('pruneTmp removes only orphaned atomic-write temp files and stale steal mutexes', (t) => {
  const m = mkMaint(t);
  touch(path.join(m.dirs.runtime, 'watchdog-state.json.1234.1700000000000.tmp'), 2 * DAY);
  touch(path.join(m.dirs.runtime, 'fresh.json.1.2.tmp'), 1000);
  touch(path.join(m.dirs.runtime, 'run.json.steal'), 5 * 60000);
  touch(path.join(m.dirs.runtime, 'tick.lock.steal'), 1000);
  touch(path.join(m.dirs.runs, 'phase1-x.json.9.9.tmp'), 3 * DAY);
  touch(path.join(m.dirs.pending, 'territory-1.json.9.9.tmp'), 3 * DAY);
  touch(path.join(m.dirs.runtime, 'keep.tmp'), 30 * DAY);
  touch(path.join(m.dirs.runtime, 'pipeline-halt.json'), 30 * DAY);
  const r = maint.pruneTmp(m.ctx);
  assert.equal(r.deleted, 4);
  assert.deepEqual(fs.readdirSync(m.dirs.runtime).sort(), ['fresh.json.1.2.tmp', 'keep.tmp', 'pipeline-halt.json', 'tick.lock.steal']);
  assert.equal(maint.pruneTmp(m.ctx).deleted, 0);
});

test('pruneOutbox deletes old rotated alert files and trims the delivered audit log', (t) => {
  const m = mkMaint(t);
  touch(path.join(m.dirs.outbox, 'alerts-20260101-120000.jsonl'), 60 * DAY);
  touch(path.join(m.dirs.outbox, 'alerts-20260920-120000.jsonl'), 5 * DAY);
  touch(path.join(m.dirs.outbox, 'alerts.jsonl'), 90 * DAY);
  const lines = [];
  for (let i = 0; i < 6000; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(400) }));
  fs.writeFileSync(path.join(m.dirs.outbox, 'alerts-delivered.jsonl'), `${lines.join('\n')}\n`);
  const r = maint.pruneOutbox(m.ctx);
  assert.equal(r.deleted, 1);
  assert.equal(r.trimmed, true);
  assert.deepEqual(fs.readdirSync(m.dirs.outbox).sort(), ['alerts-20260920-120000.jsonl', 'alerts-delivered.jsonl', 'alerts.jsonl']);
  const kept = fs.readFileSync(path.join(m.dirs.outbox, 'alerts-delivered.jsonl'), 'utf8').trim().split('\n');
  assert.equal(kept.length, 2000);
  assert.equal(JSON.parse(kept.at(-1)).i, 5999, 'the newest entries are kept');
  assert.equal(maint.pruneOutbox(m.ctx).trimmed, false, 'idempotent');
});

// --- disk and memory guards ---------------------------------------------------------------------

test('diskGuard: critical strictly above 85 percent, with the numbers in the alert', (t) => {
  const fake = (usedPct) => (dir) => ({ bsize: 4096, blocks: 1000000, bfree: Math.round(1000000 * (1 - usedPct / 100)), bavail: Math.round(1000000 * (1 - usedPct / 100)) });
  let m = mkMaint(t, { ctx: { statfs: fake(90) } });
  let r = maint.diskGuard(m.ctx);
  assert.equal(r.critical, true);
  assert.equal(r.usedPct, 90);
  assert.equal(m.notify.list.length, 1);
  assert.equal(m.notify.list[0].severity, 'critical');
  assert.equal(m.notify.list[0].key, 'disk-usage');
  assert.match(m.notify.list[0].text, /Disk 90% used \(\d+ MB free\)/);
  m = mkMaint(t, { ctx: { statfs: fake(85) } });
  assert.equal(maint.diskGuard(m.ctx).critical, false, '85.0 is not above the limit');
  assert.equal(m.notify.list.length, 0);
  m = mkMaint(t, { ctx: { statfs: fake(40) } });
  assert.equal(maint.diskGuard(m.ctx).critical, false);
  assert.equal(m.notify.list.length, 0);
});

test('diskGuard treats root-reserved blocks like df does (used / (used + available))', (t) => {
  const m = mkMaint(t, { ctx: { statfs: () => ({ bsize: 1000, blocks: 1000, bfree: 200, bavail: 100 }) } });
  const r = maint.diskGuard(m.ctx);
  assert.equal(r.usedPct, 88.9, 'df would say 89% here, not 80%');
  assert.equal(r.critical, true);
});

test('diskGuard on the real volume returns sane numbers', (t) => {
  const m = mkMaint(t);
  const r = maint.diskGuard(m.ctx);
  assert.ok(r.usedPct >= 0 && r.usedPct <= 100);
  assert.ok(r.totalMb > 0);
});

test('memoryAvailableMb reads MemAvailable, honours a tighter cgroup limit, and falls back off Linux', () => {
  const files = {
    '/proc/meminfo': 'MemTotal: 4000000 kB\nMemFree: 100000 kB\nMemAvailable: 2048000 kB\n',
  };
  const ctx = (extra) => maint.makeCtx({ readFile: (f) => { if (f in Object.assign({}, files, extra)) return Object.assign({}, files, extra)[f]; throw new Error('ENOENT'); } });
  assert.equal(maint.memoryAvailableMb(ctx()), 2000);
  const cg = ctx({ '/sys/fs/cgroup/memory.max': `${1000 * MB}\n`, '/sys/fs/cgroup/memory.current': `${400 * MB}\n`, '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${100 * MB}\n` });
  assert.equal(maint.memoryAvailableMb(cg), 700, 'limit - current + reclaimable page cache');
  const unlimited = ctx({ '/sys/fs/cgroup/memory.max': 'max\n' });
  assert.equal(maint.memoryAvailableMb(unlimited), 2000);
  const none = maint.makeCtx({ readFile: () => { throw new Error('no /proc'); } });
  assert.equal(maint.memoryAvailableMb(none), Math.round(os.freemem() / MB) , 'fallback to the OS free memory');
});

test('memoryGuard: 700 MB is the floor', () => {
  assert.equal(maint.memoryGuard(null, { availMb: 699 }).ok, false);
  assert.equal(maint.memoryGuard(null, { availMb: 700 }).ok, true);
  assert.equal(maint.memoryGuard(null, { availMb: 5000, minMb: 6000 }).ok, false);
  assert.equal(maint.DEFAULTS.minMemMb, 700);
});

// --- VACUUM -------------------------------------------------------------------------------------

function bloatedDb(file) {
  const db = new Database(file);
  db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY, blob BLOB)');
  const ins = db.prepare('INSERT INTO candidates (blob) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(Buffer.alloc(1000, i % 250)); })();
  db.prepare('DELETE FROM candidates WHERE id > 100').run();
  db.close();
}

test('vacuumIfDue: monthly, skips when not due, when busy, without a database; shrinks a bloated file', { skip: !Database && 'better-sqlite3 is not installed' }, (t) => {
  const m = mkMaint(t);
  assert.equal(maint.vacuumIfDue(m.ctx).skipped, 'no-db');
  bloatedDb(m.ctx.dirs.db);
  const before = fs.statSync(m.ctx.dirs.db).size;
  const busy = mkMaint(t, { ctx: { isBusy: () => true } });
  bloatedDb(busy.ctx.dirs.db);
  assert.equal(maint.vacuumIfDue(busy.ctx).skipped, 'busy');

  const r = maint.vacuumIfDue(m.ctx);
  assert.equal(r.vacuumed, true);
  assert.ok(fs.statSync(m.ctx.dirs.db).size < before / 5, 'file shrank');
  const db = new Database(m.ctx.dirs.db, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM candidates').get().c, 100, 'data intact');
  db.close();

  assert.equal(maint.vacuumIfDue(m.ctx).skipped, 'not-due', 'ran just now');
  const state = H.readJson(path.join(m.home, 'runtime', 'maintenance-state.json'));
  assert.ok(state.lastVacuumAt);
  H.writeJson(path.join(m.home, 'runtime', 'maintenance-state.json'), { lastVacuumAt: new Date(Date.now() - 27 * DAY).toISOString() });
  assert.equal(maint.vacuumIfDue(m.ctx).skipped, 'not-due', '27 days is not yet due');
  H.writeJson(path.join(m.home, 'runtime', 'maintenance-state.json'), { lastVacuumAt: new Date(Date.now() - 29 * DAY).toISOString() });
  assert.equal(maint.vacuumIfDue(m.ctx).vacuumed, true, '29 days is due');
  assert.equal(maint.vacuumIfDue(mkMaint(t, { ctx: { dryRun: true } }).ctx, { force: true }).skipped, 'no-db');
});

test('vacuumIfDue on a damaged database warns and retries the next night', { skip: !Database && 'better-sqlite3 is not installed' }, (t) => {
  const m = mkMaint(t);
  fs.writeFileSync(m.ctx.dirs.db, Buffer.alloc(8192, 9));
  const r = maint.vacuumIfDue(m.ctx);
  assert.ok(r.error);
  assert.equal(m.notify.list.at(-1).key, 'vacuum-failed');
  assert.equal(m.notify.list.at(-1).severity, 'warn');
  assert.equal(fs.existsSync(path.join(m.home, 'runtime', 'maintenance-state.json')), false, 'a failed vacuum does not count as done');
});

// --- orchestration and CLI ----------------------------------------------------------------------

test('runDaily runs every step, keeps going when one fails, and reports each', async (t) => {
  const m = mkMaint(t, { ctx: { statfs: () => { throw new Error('statfs unsupported'); } } });
  touch(path.join(m.dirs.runs, 'phase1-old.json'), 30 * DAY);
  const r = await maint.runDaily(m.ctx);
  assert.deepEqual(Object.keys(r).sort(), ['chromeCache', 'disk', 'logs', 'outbox', 'preMigrate', 'runs', 'tmp', 'vacuum']);
  assert.equal(r.runs.deleted, 1);
  assert.equal(r.disk.error, 'statfs unsupported');
  assert.ok(r.vacuum.skipped);
});

test('CLI: --daily prints one JSON line; --help 0; no arguments or unknown ones exit 2; --mem exits 0 or 3', (t) => {
  const home = H.mkHome(t, 'maintcli');
  H.installScripts(home);
  touch(path.join(home, 'runs', 'phase1-old.json'), 30 * DAY);
  const run = (args) => spawnSync(process.execPath, [path.join(home, 'scripts', 'maintenance.js'), ...args], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  let r = run(['--runs']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runs.deleted, 1);
  r = run(['--daily']);
  assert.ok([0, 3].includes(r.status), `daily exit ${r.status}: ${r.stderr}`);
  assert.ok(JSON.parse(r.stdout).runs);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--dry-run']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
  r = run(['--mem']);
  assert.ok([0, 3].includes(r.status));
  assert.ok(JSON.parse(r.stdout).mem.availMb > 0);
  r = run(['--runs', '--dry-run']);
  assert.equal(JSON.parse(r.stdout).runs.deleted, 0);
});

test('capChromeCache never removes index, lock or manifest files, even the oldest ones', (t) => {
  const m = mkMaint(t);
  const cache = path.join(m.dirs.state, 'chrome', 'Default', 'Cache', 'Cache_Data');
  for (const n of ['index', 'the-real-index', 'data_0', 'data_1', 'LOCK', 'CURRENT', 'MANIFEST-000001', 'LOG', 'LOG.old', 'something.lock']) touch(path.join(cache, n), 90 * DAY, 1 * MB);
  for (let i = 0; i < 4; i++) touch(path.join(cache, `f_00000${i}`), (10 - i) * DAY, 1 * MB);
  const r = maint.capChromeCache(m.ctx, { capMb: 1 });
  assert.equal(r.deleted, 3, 'only the entry files are candidates');
  for (const n of ['index', 'the-real-index', 'data_0', 'data_1', 'LOCK', 'CURRENT', 'MANIFEST-000001', 'LOG', 'LOG.old', 'something.lock']) {
    assert.ok(fs.existsSync(path.join(cache, n)), `${n} kept`);
  }
});

// --- pre-migrate copies and the directories nothing may prune early -------------------------------

const PRE = (stamp) => `candidates.db.pre-migrate-${stamp}`;

test('prunePreMigrate: candidates.db.pre-migrate-* older than 7 days go, younger ones and every other backup file stay', (t) => {
  const m = mkMaint(t);
  const B = m.dirs.backups;
  touch(path.join(B, PRE('2026-09-01T10-00-00-000Z')), 8 * DAY, 100);
  touch(path.join(B, PRE('2026-09-05T10-00-00-000Z')), 40 * DAY, 100);
  touch(path.join(B, PRE('2026-09-29T09-00-00-000Z')), 1 * DAY, 100);
  touch(path.join(B, PRE('boundary-in')), 6.9 * DAY, 100);
  touch(path.join(B, PRE('boundary-out')), 7.1 * DAY, 100);
  touch(path.join(B, 'candidates-20250101-030000.db.gz.enc'), 400 * DAY, 100);
  touch(path.join(B, 'candidates-20250101-030000.db.gz.enc.json'), 400 * DAY, 100);
  touch(path.join(B, 'candidates.db'), 400 * DAY, 100);
  touch(path.join(B, 'notes.pre-migrate-old'), 400 * DAY, 100);
  touch(path.join(B, 'other-candidates.db.pre-migrate-old'), 400 * DAY, 100);
  touch(path.join(B, 'candidates.db.pre-migrate-'), 400 * DAY, 100);
  const r = maint.prunePreMigrate(m.ctx);
  assert.equal(r.deleted, 3);
  assert.equal(r.kept, 2);
  assert.deepEqual(fs.readdirSync(B).sort(), [
    'candidates-20250101-030000.db.gz.enc', 'candidates-20250101-030000.db.gz.enc.json', 'candidates.db',
    'candidates.db.pre-migrate-', 'notes.pre-migrate-old', 'other-candidates.db.pre-migrate-old',
    PRE('2026-09-29T09-00-00-000Z'), PRE('boundary-in'),
  ].sort());
  assert.equal(maint.prunePreMigrate(m.ctx).deleted, 0, 'idempotent');
});

test('prunePreMigrate: dry run reports without deleting; a directory or symlink with the name is never followed', (t) => {
  const m = mkMaint(t, { ctx: { dryRun: true } });
  const B = m.dirs.backups;
  touch(path.join(B, PRE('old')), 30 * DAY, 10);
  const r = maint.prunePreMigrate(m.ctx);
  assert.equal(r.deleted, 1);
  assert.equal(fs.existsSync(path.join(B, PRE('old'))), true);

  const live = mkMaint(t);
  fs.mkdirSync(path.join(live.dirs.backups, PRE('a-directory')), { recursive: true });
  const old = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(path.join(live.dirs.backups, PRE('a-directory')), old, old);
  const victim = path.join(live.home, 'precious.txt');
  fs.writeFileSync(victim, 'keep me');
  try { fs.symlinkSync(victim, path.join(live.dirs.backups, PRE('a-link'))); } catch { /* no symlink privilege on this host */ }
  assert.equal(maint.prunePreMigrate(live.ctx).deleted, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(live.dirs.backups, PRE('a-directory'))), true);
});

test('prunePreMigrate copes with a missing backups directory; runDaily includes it', async (t) => {
  const m = mkMaint(t);
  fs.rmSync(m.dirs.backups, { recursive: true, force: true });
  assert.deepEqual(maint.prunePreMigrate(m.ctx), { deleted: 0, kept: 0, bytes: 0 });
  touch(path.join(m.dirs.backups, PRE('x')), 9 * DAY);
  const r = await maint.runDaily(m.ctx);
  assert.equal(r.preMigrate.deleted, 1);
});

test('pruneTmp also clears crashed backup temp files from backups/ but nothing else there', (t) => {
  const m = mkMaint(t);
  touch(path.join(m.dirs.backups, 'candidates-20260929-030000.db.gz.enc.4242.1790000000000.tmp'), 3 * DAY);
  touch(path.join(m.dirs.backups, 'candidates-20260928-030000.db.gz.enc'), 3 * DAY);
  touch(path.join(m.dirs.backups, 'fresh.4242.1790000000000.tmp'), 0);
  const r = maint.pruneTmp(m.ctx);
  assert.equal(r.deleted, 1);
  assert.deepEqual(fs.readdirSync(m.dirs.backups).sort(), ['candidates-20260928-030000.db.gz.enc', 'fresh.4242.1790000000000.tmp']);
});

test('the daily run never touches secrets/, shadow/, config/, downloads/, pending-searches/ or the sessions and profiles in state/, however old they are', async (t) => {
  const m = mkMaint(t, { ctx: { statfs: () => ({ bsize: 4096, blocks: 1000000, bfree: 900000, bavail: 900000 }) } });
  const ancient = 900 * DAY;
  // The monthly VACUUM would legitimately open the (here fake) database file; it is not due in this scenario.
  H.writeJson(path.join(m.home, 'runtime', 'maintenance-state.json'), { lastVacuumAt: new Date().toISOString() });
  const keep = [
    path.join(m.home, 'secrets', 'caterer-credentials.json'),
    path.join(m.home, 'secrets', 'zoho-credentials.json'),
    path.join(m.home, 'secrets', 'backup-passphrase'),
    path.join(m.home, 'shadow', 'screening-2024-01-01.jsonl'),
    path.join(m.home, 'shadow', 'screening-2026-09-01.jsonl'),
    path.join(m.home, 'config', 'postcode-cities.json'),
    path.join(m.home, 'state', 'caterer-session.json'),
    path.join(m.home, 'state', 'chrome-reed', 'Default', 'Cookies'),
    path.join(m.home, 'state', 'chrome-reed', 'Default', 'Login Data'),
    path.join(m.home, 'state', 'agent-browser', 'sessions', 'caterer.json'),
    path.join(m.home, 'state', 'backup-tmp', 'candidates-x.db'),
    path.join(m.home, 'downloads', 'phase2-results-old.json'),
    path.join(m.home, 'pending-searches', 'territory-1-old.json'),
    path.join(m.home, 'backups', 'candidates-20240101-030000.db.gz.enc'),
    path.join(m.home, 'backups', 'candidates-20240101-030000.db.gz.enc.json'),
    path.join(m.home, 'candidates.db'),
    path.join(m.home, 'candidates.db-wal'),
  ];
  for (const f of keep) touch(f, ancient, 20);
  // Only entry files inside cache directories are ever removed from state/, and only above the cap.
  touch(path.join(m.home, 'state', 'chrome-reed', 'Default', 'Cache', 'f_000001'), ancient, 3 * MB);
  const before = keep.map((f) => [f, fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]);
  for (let i = 0; i < 2; i++) {
    const r = await maint.runDaily(m.ctx);
    assert.equal(r.runs.deleted, 0);
    assert.equal(r.chromeCache.deleted, 0, 'far below the cache cap: nothing removed');
    assert.equal(r.preMigrate.deleted, 0);
  }
  for (const [f, text, mtime] of before) {
    assert.equal(fs.readFileSync(f, 'utf8'), text, `${path.relative(m.home, f)} unchanged`);
    assert.equal(fs.statSync(f).mtimeMs, mtime);
  }
  // Above the cap the cache goes oldest-first, and even then the profile around it stays.
  touch(path.join(m.home, 'state', 'chrome-reed', 'Default', 'Cache', 'f_000002'), ancient, 3 * MB);
  const capped = maint.capChromeCache(m.ctx, { capMb: 4 });
  assert.equal(capped.deleted, 1);
  for (const f of keep) assert.equal(fs.existsSync(f), true, `${path.relative(m.home, f)} still there after the cache cap`);
});

test('CLI: --pre-migrate runs on its own, honours --dry-run and is listed in the usage line', (t) => {
  const home = H.mkHome(t, 'maintpre');
  H.installScripts(home);
  touch(path.join(home, 'backups', PRE('old')), 30 * DAY);
  touch(path.join(home, 'backups', PRE('new')), 1 * DAY);
  const run = (args) => spawnSync(process.execPath, [path.join(home, 'scripts', 'maintenance.js'), ...args], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  let r = run(['--pre-migrate', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).preMigrate.deleted, 1);
  assert.equal(fs.existsSync(path.join(home, 'backups', PRE('old'))), true);
  r = run(['--pre-migrate']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(home, 'backups', PRE('old'))), false);
  assert.equal(fs.existsSync(path.join(home, 'backups', PRE('new'))), true);
  assert.match(run(['--help']).stdout, /--pre-migrate/);
});

test('the name migrate-schema.js gives its safety copy is the name maintenance prunes', () => {
  const src = fs.readFileSync(path.join(H.SRC_SCRIPTS, 'migrate-schema.js'), 'utf8');
  assert.match(src, /\$\{path\.basename\(dbPath\)\}\.pre-migrate-\$\{stamp\}/);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  assert.match(`candidates.db.pre-migrate-${stamp}`, maint.PRE_MIGRATE_RE);
});
