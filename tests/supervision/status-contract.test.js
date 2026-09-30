'use strict';
// The files the supervision package writes for the dashboard plugin (docs/parity/dashboard.md section 5):
// exact field names, state enums and ISO timestamps, checked against a port of the plugin's own derivation
// and, when a Python with fastapi is available (RESOURCER_PYTHON), against the real plugin_api.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'contractbase');
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* the backup success path skips */ }
const runner = require(path.join(H.SRC_SCRIPTS, 'watchdog-runner.js'));
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const backup = require(path.join(H.SRC_SCRIPTS, 'backup-db.js'));

const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// plugin_api.py: _CATERER_EVENT_STATE and caterer_state()
const EVENT_STATE = {
  'session-safelist-blocked': 'safelist_blocked', 'session-dead': 'stale', 'session-stale': 'stale',
  'session-relogin': 'relogin', 'session-loaded': 'ok', 'phase1-start': 'ok', done: 'ok',
};
const CATERER_STATES = ['ok', 'stale', 'safelist_blocked', 'login_failed', 'relogin'];
const HEARTBEAT_RE = /(heartbeat|\.hb$|\.pid$)/i;

function deriveCaterer(events, explicit) {
  let derived = { state: 'unknown', updatedAt: null };
  for (let i = events.length - 1; i >= 0; i--) {
    let state = EVENT_STATE[events[i].event];
    if (!state) continue;
    if (events[i].event === 'session-dead' && /safelist/i.test(String(events[i].note || ''))) state = 'safelist_blocked';
    derived = { state, updatedAt: events[i].ts };
    break;
  }
  if (explicit && typeof explicit.state === 'string') {
    const e = Date.parse(explicit.updatedAt);
    const d = Date.parse(derived.updatedAt);
    if (derived.state === 'unknown' || (Number.isFinite(e) && (!Number.isFinite(d) || e >= d))) derived = { state: explicit.state, updatedAt: explicit.updatedAt };
  }
  return derived;
}

function scenario(t, o) {
  const home = H.mkHome(t, 'contract');
  const calls = [];
  H.writeJson(path.join(home, 'pending-searches', 'territory-7-x.json'), { jobTitle: 'Chef', location: 'AB1', distance: 20, keywords: '', priority: 'low', sources: 'caterer', cvLimit: 20, source: 'territory-scheduler', requestedAt: new Date().toISOString() });
  const ctx = runner.makeCtx({
    home,
    settleMs: 0,
    heartbeatMs: 50,
    browserLockWaitMs: 0,
    browserLock: { wait: async () => ({ acquired: true, borrowed: false, holder: {}, release: () => {} }) },
    buildResultsUrl: () => ({ url: 'https://example.test/r', searchId: 's' }),
    ensureLoggedIn: o.hang ? () => new Promise(() => {}) : async () => o.session,
    sessionStepMaxMs: o.hang ? 60 : undefined,
    exec: async (script, args) => {
      calls.push(script);
      if (script === 'pending-gate.js' && args.length === 0) {
        return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-7-x.json', filePath: path.join(home, 'pending-searches', 'territory-7-x.json'), pending: { jobTitle: 'Chef', location: 'AB1', sources: 'caterer' }, queueDepth: 1 }), stderr: '' };
      }
      if (script === 'create-init-status.js') {
        const f = path.join(home, 'runs', 'phase1-2026-09-29-1000.json');
        H.writeJson(f, { id: 'x', status: 'phase1_initializing', jobTitle: 'Chef', location: 'AB1' });
        return { code: 0, stdout: `INIT_FILE:${f}`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    runPhase1: async () => o.phase1 || { code: 0, killed: false, aborted: null },
  });
  return { home, ctx, calls, files: tick.runtimeFiles(home) };
}

const SCENARIOS = [
  { name: 'ok', session: 'ok', expect: 'ok', file: 'ok' },
  { name: 'signed in again', session: { state: 'ok', reloggedIn: true }, expect: 'ok', file: 'ok' },
  { name: 'safe-list block', session: 'safelist', expect: 'safelist_blocked', file: 'safelist_blocked' },
  { name: 'logged out, login failed', session: 'login', expect: 'login_failed', file: 'login_failed' },
  { name: 'sign-in hangs', hang: true, expect: 'login_failed', file: 'login_failed' },
  { name: 'CV Database module error', session: 'moduleerror', expect: 'stale', file: 'stale' },
  { name: 'phase1 reports a stale session', session: 'ok', phase1: { code: 2, killed: false }, expect: 'stale', file: 'stale' },
];

test('runtime/caterer-status.json and watchdog-runner.jsonl: field names, enum, ISO timestamps, and the dashboard derives the intended state for every session outcome', async (t) => {
  for (const sc of SCENARIOS) {
    const s = scenario(t, sc);
    await runner.runOnce(s.ctx, ['--from-gate']);
    const file = path.join(s.files.dir, 'caterer-status.json');
    const explicit = H.readJson(file, null);
    assert.ok(explicit, `${sc.name}: status file written`);
    assert.deepEqual(Object.keys(explicit).sort(), ['detail', 'state', 'updatedAt'], sc.name);
    assert.equal(explicit.state, sc.file, sc.name);
    assert.ok(CATERER_STATES.includes(explicit.state), `${sc.name}: ${explicit.state} is in the dashboard enum`);
    assert.match(explicit.updatedAt, ISO_MS_Z, sc.name);
    assert.equal(typeof explicit.detail, 'string');
    assert.ok(explicit.detail.length <= 200);

    const events = H.readLines(path.join(s.home, 'logs', 'watchdog-runner.jsonl'));
    assert.ok(events.length > 0);
    for (const ev of events) {
      assert.match(ev.ts, ISO_MS_Z, `${sc.name}: ${ev.event} has an ISO timestamp`);
      assert.equal(typeof ev.event, 'string');
    }
    const derived = deriveCaterer(events, explicit);
    assert.equal(derived.state, sc.expect, `${sc.name}: the dashboard shows ${derived.state}`);
    assert.ok(CATERER_STATES.includes(derived.state));
  }
});

test('every session event the dashboard maps is emitted by the runner under exactly that name', async (t) => {
  const seen = new Set();
  for (const sc of SCENARIOS) {
    const s = scenario(t, sc);
    await runner.runOnce(s.ctx, ['--from-gate']);
    for (const ev of H.readLines(path.join(s.home, 'logs', 'watchdog-runner.jsonl'))) seen.add(ev.event);
  }
  for (const name of Object.keys(EVENT_STATE)) assert.ok(seen.has(name), `event ${name} is written`);
  // the safe-list note must contain the word the plugin looks for
  const s = scenario(t, SCENARIOS[2]);
  await runner.runOnce(s.ctx, ['--from-gate']);
  const dead = H.readLines(path.join(s.home, 'logs', 'watchdog-runner.jsonl')).find((e) => e.event === 'session-dead');
  assert.match(dead.note, /safelist/i);
});

test('a later successful run overrides an earlier failure in what the dashboard shows (newest wins)', async (t) => {
  const s = scenario(t, { session: 'safelist' });
  await runner.runOnce(s.ctx, ['--from-gate']);
  const first = deriveCaterer(H.readLines(path.join(s.home, 'logs', 'watchdog-runner.jsonl')), H.readJson(path.join(s.files.dir, 'caterer-status.json')));
  assert.equal(first.state, 'safelist_blocked');
  await new Promise((r) => setTimeout(r, 15));
  H.writeJson(path.join(s.home, 'pending-searches', 'territory-7-x.json'), { jobTitle: 'Chef', location: 'AB1', sources: 'caterer', source: 'territory-scheduler' });
  s.ctx.ensureLoggedIn = async () => 'ok';
  delete s.ctx.ensureLoggedInDetailed;
  await runner.runOnce(s.ctx, ['--from-gate']);
  const second = deriveCaterer(H.readLines(path.join(s.home, 'logs', 'watchdog-runner.jsonl')), H.readJson(path.join(s.files.dir, 'caterer-status.json')));
  assert.equal(second.state, 'ok');
});

test('runtime/backup-status.json: {ok, finishedAt, error?} with an ISO timestamp, for a failed and for a good backup', async (t) => {
  const home = H.mkHome(t, 'bkcontract');
  const notify = H.collectNotifier();
  const statusFile = path.join(home, 'runtime', 'backup-status.json');
  const now = Date.UTC(2026, 8, 29, 3, 30, 0);
  const base = { home, now: () => now, notify, log: () => {} };

  const failed = await backup.runAuto(backup.makeCtx({ ...base, passphrase: () => null }));
  assert.equal(failed, backup.EXIT.BACKUP);
  let st = H.readJson(statusFile);
  assert.deepEqual(Object.keys(st).sort(), ['error', 'finishedAt', 'ok']);
  assert.equal(st.ok, false);
  assert.match(st.finishedAt, ISO_MS_Z);
  assert.ok(st.error.length > 0 && st.error.length <= 300);
  assert.equal(notify.keys().includes('backup-failed'), true);

  if (!Database) return;
  const db = new Database(path.join(home, 'candidates.db'));
  db.exec("CREATE TABLE candidates (id INTEGER PRIMARY KEY, x TEXT); INSERT INTO candidates (x) VALUES ('a'),('b');");
  db.close();
  const ok = await backup.runAuto(backup.makeCtx({ ...base, passphrase: () => 'a long enough passphrase for the contract test', log2n: 10 }));
  assert.equal(ok, backup.EXIT.OK);
  st = H.readJson(statusFile);
  assert.deepEqual(Object.keys(st).sort(), ['finishedAt', 'ok']);
  assert.equal(st.ok, true);
  assert.match(st.finishedAt, ISO_MS_Z);

  // what the plugin counts as "the newest backup": a regular file that is not a dotfile, .json, .tmp, .partial, .part or .lock
  const names = fs.readdirSync(path.join(home, 'backups'));
  const counted = names.filter((n) => !n.startsWith('.') && !/\.(tmp|partial|part|lock)$/.test(n) && !n.endsWith('.json'));
  assert.equal(counted.length, 1);
  assert.match(counted[0], /^candidates-\d{8}-\d{6}\.db\.gz\.enc$/);
  assert.equal(names.some((n) => /\.(tmp|partial)$/.test(n)), false, 'no half-written file is left in backups/');
  assert.equal(fs.existsSync(path.join(home, 'state', 'backup-tmp', 'nothing-left')), false);
  assert.deepEqual(fs.readdirSync(path.join(home, 'state', 'backup-tmp')), [], 'the plaintext snapshot is gone');
});

test('runtime/tick.heartbeat is the only heartbeat-named file the supervision package writes, refreshed on every iteration, ISO content', async (t) => {
  const home = H.mkHome(t, 'hbcontract');
  const files = tick.runtimeFiles(home);
  let clock = H.londonEpoch(2026, 9, 29, 10, 0);
  const ctx = wd.makeCtx({
    home,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
    notify: H.collectNotifier(),
    slowChecks: async () => {},
    diskGuard: () => ({}),
    exec: async () => ({ code: 0, stdout: 'NO_WORK', stderr: '' }),
  });
  H.writeJson(files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: new Date(clock).toISOString() });
  await wd.runTick(ctx, { maxMinutes: 2, superviseMs: 10000 });
  const runtime = fs.readdirSync(files.dir);
  assert.deepEqual(runtime.filter((n) => HEARTBEAT_RE.test(n)), ['tick.heartbeat']);
  const body = fs.readFileSync(files.tickHeartbeat, 'utf8');
  assert.match(body, ISO_MS_Z);
  assert.ok(Date.parse(body) >= H.londonEpoch(2026, 9, 29, 10, 1), 'refreshed as the tick kept going');
});

// --- the real plugin --------------------------------------------------------------------------

function findPython() {
  for (const c of [process.env.RESOURCER_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(c, ['-c', 'import fastapi'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) return c;
  }
  return null;
}
const python = findPython();

test('the real plugin_api.py reads these files the way the writers intend (Caterer state, backup, activity)', { skip: python ? false : 'no Python with fastapi (set RESOURCER_PYTHON)', timeout: 180000 }, async (t) => {
  const probe = (home) => {
    const r = spawnSync(python, [path.join(__dirname, 'fixtures', 'plugin_probe.py'), path.join(H.REPO, 'plugin', 'resourcer', 'dashboard', 'plugin_api.py')], {
      encoding: 'utf8', timeout: 120000, env: { ...process.env, RESOURCER_HOME: home, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  for (const sc of SCENARIOS) {
    const s = scenario(t, sc);
    await runner.runOnce(s.ctx, ['--from-gate']);
    const out = probe(s.home);
    assert.equal(out.caterer.state, sc.expect, `${sc.name}: plugin says ${out.caterer.state}`);
    assert.ok(out.eventCount > 0);
    assert.ok(out.activity, 'the runner log counts as activity');
  }

  const home = H.mkHome(t, 'pyctx');
  const files = tick.runtimeFiles(home);
  H.writeJson(files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'n', startedAt: new Date().toISOString() });
  let clock = Date.now();
  const ctx = wd.makeCtx({ home, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {}, notify: H.collectNotifier(), slowChecks: async () => {}, diskGuard: () => ({}), exec: async () => ({ code: 0, stdout: 'NO_WORK', stderr: '' }) });
  await wd.runTick(ctx, { maxMinutes: 1, superviseMs: 10000 });
  const out = probe(home);
  assert.ok(out.activity, 'tick.heartbeat counts as activity');
  assert.ok(Math.abs(Date.now() - Date.parse(out.activity)) < 5 * 60000);

  const bhome = H.mkHome(t, 'pybackup');
  H.writeJson(path.join(bhome, 'runtime', 'backup-status.json'), { ok: false, finishedAt: new Date().toISOString(), error: 'x' });
  fs.writeFileSync(path.join(bhome, 'backups', 'candidates-20260929-033000.db.gz.enc'), 'x');
  fs.writeFileSync(path.join(bhome, 'backups', 'candidates-20260929-033000.db.gz.enc.json'), '{}');
  fs.writeFileSync(path.join(bhome, 'backups', 'candidates-20260929-040000.db.gz.enc.1.2.tmp'), 'x');
  const b = probe(bhome).backup;
  assert.equal(b.count, 1, 'manifest and temp file are not counted as backups');
  assert.equal(b.file, 'candidates-20260929-033000.db.gz.enc');
  assert.equal(b.lastResultOk, false);
  assert.equal(b.stale, true, 'ok:false marks the backup stale');
});
