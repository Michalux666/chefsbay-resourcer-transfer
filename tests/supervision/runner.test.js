'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'runnerbase');
const runner = require(path.join(H.SRC_SCRIPTS, 'watchdog-runner.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const { EXIT } = runner;

const READY = (home, extra) => JSON.stringify({
  status: 'READY', file: 'territory-7-x.json', filePath: path.join(home, 'pending-searches', 'territory-7-x.json'),
  pending: Object.assign({ jobTitle: 'Sous Chef', location: 'AB1', distance: 30, keywords: 'kitchen', priority: 'high', sources: 'both', cvLimit: 25, requestedAt: '2026-09-29T09:00:00.000Z' }, extra),
  queueDepth: 4,
});

// In-process runner with fakes for everything outside the runner itself.
function mkRunner(t, o = {}) {
  const home = H.mkHome(t, 'runner');
  const calls = [];
  const pendingData = Object.assign({ jobTitle: 'Sous Chef', location: 'AB1', distance: 30, keywords: 'kitchen', priority: 'high', sources: 'both', cvLimit: 25, requestedAt: '2026-09-29T09:00:00.000Z' }, o.pending);
  H.writeJson(path.join(home, 'pending-searches', 'territory-7-x.json'), pendingData);
  const ctx = runner.makeCtx(Object.assign({
    home,
    settleMs: 0,
    heartbeatMs: 50,
    log: () => {},
    allowedSources: () => o.allowed || 'both',
    buildResultsUrl: ({ jobTitle, location, distance, keywords }) => ({ url: `https://example.test/r?q=${encodeURIComponent(jobTitle)}&l=${location}&d=${distance}&k=${keywords}`, searchId: 'sid-1' }),
    browserLockWaitMs: 0,
    browserLock: {
      wait: async (owner, opts) => {
        calls.push(['browser-lock', owner, opts]);
        if (o.lockThrows) throw new Error('lock module exploded');
        if (o.lockBusy) return { acquired: false, holder: { owner: 'reed', pid: 4242 }, reason: 'busy' };
        return { acquired: true, borrowed: false, reentrant: false, holder: { owner, pid: process.pid }, release: () => calls.push(['browser-release']) };
      },
    },
    ensureLoggedIn: async (opts) => { calls.push(['login', opts]); if (o.loginThrows) throw new Error('browser exploded'); return o.session === undefined ? 'ok' : o.session; },
    exec: async (script, args) => {
      calls.push([script, args]);
      if (script === 'pending-gate.js' && args[0] === '--mark-spawned') return o.markFails ? { code: 1, stdout: '', stderr: 'nope' } : { code: 0, stdout: `MARKED: ${args[1]}`, stderr: '' };
      if (script === 'pending-gate.js') {
        if (o.gateCode) return { code: o.gateCode, stdout: 'ERROR:all_files_corrupt (1 parse failures)', stderr: '' };
        return { code: 0, stdout: o.gate === undefined ? READY(home, o.pending) : o.gate, stderr: '' };
      }
      if (script === 'create-init-status.js') {
        if (o.initFails) return { code: 1, stdout: '', stderr: 'bad pending' };
        const f = path.join(home, 'runs', 'phase1-2026-09-29-1000.json');
        H.writeJson(f, { id: 'phase1-2026-09-29-1000', status: 'phase1_initializing', jobTitle: 'Sous Chef', location: 'AB1', updatedAt: new Date().toISOString() });
        return { code: 0, stdout: `INIT_FILE:${f}`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    runPhase1: async (ctx2, paramsFile, fd, lock) => {
      calls.push(['phase1', paramsFile]);
      fs.writeSync(fd, 'FAKE CONSOLE OUTPUT\n');
      if (o.phase1) return o.phase1;
      return { code: 0, killed: false, aborted: null };
    },
  }, o.ctx || {}));
  return { home, ctx, calls, files: tick.runtimeFiles(home), names: () => calls.map((c) => c[0]) };
}

// --- pure functions -----------------------------------------------------------------------------

test('effectiveSources: RESOURCER_SOURCES gates Reed off until the canary passes', () => {
  const f = runner.effectiveSources;
  for (const req of ['caterer', 'reed', 'both']) {
    assert.equal(f(req, 'caterer'), 'caterer', `caterer gate, requested ${req}`);
    assert.equal(f(req, undefined), 'caterer', 'default is caterer');
    assert.equal(f(req, 'nonsense'), 'caterer', 'an invalid setting falls back to the safe value');
    assert.equal(f(req, 'both'), req, 'both leaves the request alone');
    assert.equal(f(req, ' BOTH '), req);
    assert.equal(f(req, 'reed'), 'reed');
  }
});

test('normaliseSession accepts the shapes a login module may return', () => {
  const n = runner.normaliseSession;
  assert.equal(n('ok'), 'ok');
  assert.equal(n('OK'), 'ok');
  assert.equal(n('login'), 'login');
  assert.equal(n('safelist'), 'safelist');
  assert.equal(n('SafeListBlocked'), 'safelist');
  assert.equal(n('safe-list'), 'safelist');
  assert.equal(n('error'), 'error');
  assert.equal(n('unknown'), 'unknown');
  assert.equal(n({ state: 'safelist' }), 'safelist');
  assert.equal(n({ status: 'login' }), 'login');
  assert.equal(n({ ok: true }), 'ok');
  assert.equal(n({ ok: false }), 'login');
  assert.equal(n({ safelist: true }), 'safelist');
  assert.equal(n(true), 'ok');
  assert.equal(n(false), 'login');
  assert.equal(n(undefined), 'unknown');
  assert.equal(n(42), 'unknown');
});

test('mapPhase1Exit keeps the legacy exit-code policy', () => {
  const m = (r) => runner.mapPhase1Exit(Object.assign({ code: 0, killed: false }, r)).code;
  assert.equal(m({ code: 0 }), EXIT.OK);
  assert.equal(m({ code: 2 }), EXIT.SESSION_STALE);
  for (const c of [1, 3, 4, 5, 6, 7, 99, null]) assert.equal(m({ code: c }), EXIT.PHASE1_FAILED, `phase1 exit ${c}`);
  assert.equal(m({ code: null, killed: true }), EXIT.KILLED);
  assert.equal(m({ code: 0, killed: true }), EXIT.KILLED, 'killed wins');
  assert.equal(m({ spawnError: 'ENOENT' }), EXIT.PHASE1_FAILED);
  assert.equal(m({ code: 0, aborted: 'SIGTERM' }), EXIT.ERROR);
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.NO_WORK, 10);
  assert.equal(EXIT.SESSION_STALE, 11);
  assert.equal(EXIT.PHASE1_FAILED, 12);
  assert.equal(EXIT.KILLED, 13);
  assert.equal(EXIT.ERROR, 1);
});

test('the run ceiling is 70 minutes', () => {
  assert.equal(runner.MAX_RUN_MS, 70 * 60 * 1000);
});

test('buildParams: legacy mapping, defaults and the source default rule', (t) => {
  const { ctx } = mkRunner(t, { allowed: 'both' });
  const p = runner.buildParams(ctx, { jobTitle: 'Chef', location: 'B25', distance: '40', keywords: 'grill', activeWithin: '2 weeks', cvLimit: '30', requestedAt: 'R', priority: 'medium', sources: 'reed' }, 'INIT');
  assert.deepEqual(p, {
    RESULTS_URL: 'https://example.test/r?q=Chef&l=B25&d=40&k=grill', SEARCH_ID: 'sid-1', JOB_TITLE: 'Chef', LOCATION: 'B25',
    DISTANCE_MILES: 40, ACTIVE_WITHIN: '2 weeks', CV_LIMIT: 30, KEYWORDS: 'grill', CANDIDATE_COUNT: 0, SOURCES: 'reed',
    REQUESTED_AT: 'R', PRIORITY: 'medium', INIT_STATUS_FILE: 'INIT',
  });
  const d = runner.buildParams(ctx, { jobTitle: 'Chef', location: 'B25' }, 'INIT');
  assert.equal(d.DISTANCE_MILES, 20);
  assert.equal(d.ACTIVE_WITHIN, '1 month');
  assert.equal(d.CV_LIMIT, 20);
  assert.equal(d.PRIORITY, 'low');
  assert.equal(d.KEYWORDS, '');
  assert.equal(d.SOURCES, 'both', 'no sources and not a scheduler file: both');
  assert.equal(runner.buildParams(ctx, { jobTitle: 'Chef', location: 'B25', source: 'territory-scheduler' }, 'I').SOURCES, 'caterer');
});

test('buildParams applies the source gate and logs it', (t) => {
  const logged = [];
  const { ctx } = mkRunner(t, { allowed: 'caterer' });
  const p = runner.buildParams(ctx, { jobTitle: 'Chef', location: 'B25', sources: 'both' }, 'I', (e, d) => logged.push([e, d]));
  assert.equal(p.SOURCES, 'caterer');
  assert.deepEqual(logged[0][0], 'sources-gated');
  assert.equal(logged[0][1].requested, 'both');
});

test('findFinalStatus prefers the newest matching file since the run began and falls back to the init file', (t) => {
  const home = H.mkHome(t, 'final');
  const runs = path.join(home, 'runs');
  const now = Date.now();
  H.writeJson(path.join(runs, 'phase1-a.json'), { jobTitle: 'Chef', location: 'AB1', status: 'old' });
  fs.utimesSync(path.join(runs, 'phase1-a.json'), new Date(now - 3600000), new Date(now - 3600000));
  H.writeJson(path.join(runs, 'phase1-b.json'), { jobTitle: 'chef', location: 'ab1', status: 'complete', pool: 9 });
  H.writeJson(path.join(runs, 'phase1-c.json'), { jobTitle: 'Cook', location: 'AB1', status: 'other' });
  const r = runner.findFinalStatus(runs, 'Chef', 'AB1', now - 1000, null);
  assert.equal(r.data.status, 'complete');
  const init = path.join(home, 'init.json');
  H.writeJson(init, { status: 'phase1_initializing' });
  assert.equal(runner.findFinalStatus(runs, 'Nobody', 'ZZ9', now, init).data.status, 'phase1_initializing');
  assert.deepEqual(runner.findFinalStatus(runs, 'Nobody', 'ZZ9', now, null).data, {});
});

// --- runOnce with fakes -------------------------------------------------------------------------

test('no work: exit 10, claim released, no result file', async (t) => {
  const r = mkRunner(t, { gate: 'NO_WORK' });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.NO_WORK);
  assert.equal(fs.existsSync(r.files.run), false);
  assert.equal(fs.existsSync(r.files.lastRun), false);
  assert.deepEqual(r.names(), ['pending-gate.js']);
});

test('happy path: mark-spawned, init status, params file (no BOM), session check, phase1, exit 0 with result', async (t) => {
  const r = mkRunner(t);
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.OK);
  assert.deepEqual(r.names(), ['pending-gate.js', 'ensure-chrome-cdp.js', 'browser-lock', 'pending-gate.js', 'create-init-status.js', 'login', 'phase1', 'ensure-chrome-cdp.js', 'browser-release']);
  assert.deepEqual(r.calls[3], ['pending-gate.js', ['--mark-spawned', 'territory-7-x.json']]);
  assert.deepEqual(r.calls[5][1], { allowRelogin: true });
  const paramsFile = r.calls[6][1];
  const raw = fs.readFileSync(paramsFile);
  assert.notEqual(raw[0], 0xEF, 'no BOM');
  const params = JSON.parse(raw.toString('utf8'));
  assert.equal(params.JOB_TITLE, 'Sous Chef');
  assert.equal(params.SOURCES, 'both');
  assert.match(params.INIT_STATUS_FILE, /phase1-2026-09-29-1000\.json$/);
  assert.match(path.basename(paramsFile), /^params-watchdog-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  const last = H.readJson(r.files.lastRun);
  assert.equal(last.exitCode, 0);
  assert.equal(last.file, 'territory-7-x.json');
  assert.ok(last.nonce);
  assert.equal(fs.existsSync(r.files.run), false, 'run record released');
  const logs = fs.readdirSync(path.join(r.home, 'logs')).filter((f) => f.startsWith('phase1-console-'));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(r.home, 'logs', logs[0]), 'utf8'), /FAKE CONSOLE OUTPUT/);
});

test('a run that had a Reed tail quits the Reed browser before it gives up the lock; a caterer-only run and REED_KEEP_CHROME=1 leave it alone', async (t) => {
  const stops = (r) => r.calls.filter((c) => c[0] === 'ensure-chrome-cdp.js' && c[1][0] === '--stop');
  const both = mkRunner(t);
  await runner.runOnce(both.ctx, ['--from-gate']);
  assert.equal(stops(both).length, 1);
  const names = both.names();
  assert.ok(names.indexOf('phase1') < names.lastIndexOf('ensure-chrome-cdp.js') && names.lastIndexOf('ensure-chrome-cdp.js') < names.indexOf('browser-release'), 'stopped after phase 1 and before the lock is released');

  const only = mkRunner(t, { allowed: 'caterer' });
  await runner.runOnce(only.ctx, ['--from-gate']);
  assert.equal(stops(only).length, 0);

  process.env.REED_KEEP_CHROME = '1';
  try {
    const kept = mkRunner(t);
    await runner.runOnce(kept.ctx, ['--from-gate']);
    assert.equal(stops(kept).length, 0);
  } finally { delete process.env.REED_KEEP_CHROME; }
});

test('session safelist: exit 11 with reason, territory claimed, phase1 never started', async (t) => {
  const r = mkRunner(t, { session: 'safelist' });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.SESSION_STALE);
  assert.equal(H.readJson(r.files.lastRun).reason, 'safelist');
  assert.equal(r.names().includes('phase1'), false);
  assert.ok(r.calls.some((c) => c[0] === 'pending-gate.js' && c[1][0] === '--mark-spawned'), 'left claimed like the legacy runner');
  assert.equal(fs.existsSync(r.files.run), false);
});

test('session login: exit 11, reason login', async (t) => {
  const r = mkRunner(t, { session: { state: 'login' } });
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.SESSION_STALE);
  assert.equal(H.readJson(r.files.lastRun).reason, 'login');
});

test('session error, unknown or a throwing login module: the run proceeds (best effort, as before)', async (t) => {
  for (const o of [{ session: 'error' }, { session: 'unknown' }, { session: undefined, loginThrows: true }]) {
    const r = mkRunner(t, o);
    const res = await runner.runOnce(r.ctx, ['--from-gate']);
    assert.equal(res.code, EXIT.OK, JSON.stringify(o));
    assert.ok(r.names().includes('phase1'));
  }
});

test('reed-only runs skip the Caterer session check', async (t) => {
  const r = mkRunner(t, { allowed: 'both', pending: { sources: 'reed' } });
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK);
  assert.equal(r.names().includes('login'), false);
});

test('phase1 exit codes map to runner exit codes and are recorded in the result file', async (t) => {
  const cases = [
    [{ code: 2, killed: false }, 11, 'phase1-session-stale'],
    [{ code: 3, killed: false }, 12, 'phase1-exit-3'],
    [{ code: 4, killed: false }, 12, 'phase1-exit-4'],
    [{ code: null, killed: false }, 12, 'phase1-exit-null'],
    [{ code: null, killed: true }, 13, 'timeout'],
    [{ spawnError: 'ENOENT' }, 12, 'spawn-error'],
  ];
  for (const [phase1, code, reason] of cases) {
    const r = mkRunner(t, { phase1 });
    const res = await runner.runOnce(r.ctx, ['--from-gate']);
    assert.equal(res.code, code, JSON.stringify(phase1));
    const last = H.readJson(r.files.lastRun);
    assert.equal(last.exitCode, code);
    assert.equal(last.reason, reason);
  }
});

test('the result carries the final status numbers the watchdog needs', async (t) => {
  const r = mkRunner(t, {
    phase1: { code: 0, killed: false },
    ctx: {
      runPhase1: async (c, paramsFile, fd) => {
        const init = path.join(c.home, 'runs', 'phase1-2026-09-29-1000.json');
        H.writeJson(init, { id: 'x', status: 'complete', jobTitle: 'Sous Chef', location: 'AB1', pool: 150, approved: 0, skippedDb: 150, errors: 1, phase2Status: 'done', updatedAt: new Date().toISOString() });
        return { code: 0, killed: false, aborted: null };
      },
    },
  });
  await runner.runOnce(r.ctx, ['--from-gate']);
  const last = H.readJson(r.files.lastRun);
  assert.equal(last.pool, 150);
  assert.equal(last.skippedDb, 150);
  assert.equal(last.errors, 1);
  assert.equal(last.phase1Status, 'complete');
});

test('a live claim by another runner: exit 10 without touching the gate (no double run)', async (t) => {
  const r = mkRunner(t);
  const other = H.sleeper(t);
  H.writeJson(r.files.run, { pid: other.pid, token: tick.procToken(other.pid), nonce: 'other', startedAt: new Date().toISOString() });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.NO_WORK);
  assert.equal(r.calls.length, 0, 'the gate is not even asked');
  assert.equal(tick.readRecord(r.files.run).rec.nonce, 'other', 'the other claim is untouched');
});

test('a dead claim is taken over', async (t) => {
  const r = mkRunner(t);
  H.writeJson(r.files.run, { pid: H.deadPid(), nonce: 'dead', startedAt: new Date().toISOString() });
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK);
});

test('an orphaned phase1 child of a dead runner still blocks a new claim', async (t) => {
  const r = mkRunner(t);
  const child = H.sleeper(t);
  H.writeJson(r.files.run, { pid: H.deadPid(), nonce: 'dead', childPid: child.pid, childToken: tick.procToken(child.pid), startedAt: new Date().toISOString() });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.NO_WORK);
  assert.equal(r.calls.length, 0);
});

test('other live pipeline processes (adopted recovery, run-lock) make the runner defer with exit 10', async (t) => {
  const live = H.sleeper(t);
  let r = mkRunner(t);
  tick.addAdopted(r.files, [{ pid: live.pid, id: 'phase1-x', mode: 'run-pipeline' }]);
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.NO_WORK);
  assert.equal(r.names().includes('create-init-status.js'), false);
  assert.equal(fs.existsSync(r.files.run), false, 'claim released on a busy abort');

  r = mkRunner(t);
  fs.writeFileSync(path.join(r.files.runs, 'phase1-q.json.run-lock'), JSON.stringify({ pid: live.pid, startedAt: Date.now() }));
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.NO_WORK);
});

test('dry run claims nothing, marks nothing, spawns nothing', async (t) => {
  const r = mkRunner(t);
  const res = await runner.runOnce(r.ctx, ['--from-gate', '--dry-run']);
  assert.equal(res.code, EXIT.OK);
  assert.deepEqual(r.names(), ['pending-gate.js']);
  assert.equal(fs.existsSync(r.files.run), false);
  assert.equal(fs.existsSync(r.files.lastRun), false);
});

test('runner-level errors exit 1 and say why', async (t) => {
  for (const [o, reason] of [[{ gateCode: 1 }, 'resolve-error'], [{ markFails: true }, 'mark-spawned-error'], [{ initFails: true }, 'init-status-error']]) {
    const r = mkRunner(t, o);
    const res = await runner.runOnce(r.ctx, ['--from-gate']);
    assert.equal(res.code, EXIT.ERROR, reason);
    assert.equal(H.readJson(r.files.lastRun).reason, reason);
    assert.equal(r.names().includes('phase1'), false);
    assert.equal(fs.existsSync(r.files.run), false);
  }
});

test('--pending runs an explicit file without asking the gate', async (t) => {
  const r = mkRunner(t);
  H.pendingFile(r.home, 'search-1.json', { jobTitle: 'Cook', location: 'ZZ1', sources: 'caterer' });
  const res = await runner.runOnce(r.ctx, ['--pending', 'search-1.json']);
  assert.equal(res.code, EXIT.OK);
  const gateCalls = r.calls.filter((c) => c[0] === 'pending-gate.js' && c[1].length === 0);
  assert.equal(gateCalls.length, 0);
  assert.deepEqual(r.calls.find((c) => c[1][0] === '--mark-spawned')[1], ['--mark-spawned', 'search-1.json']);
});

test('an abort signal during the run gives exit 1 and never claims success', async (t) => {
  const r = mkRunner(t);
  r.ctx.runPhase1 = async () => { r.ctx.aborted = 'SIGTERM'; return { code: 0, killed: false, aborted: 'SIGTERM' }; };
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.ERROR);
  assert.match(H.readJson(r.files.lastRun).reason, /signal/);
});

test('the runner keeps its record fresh with a heartbeat while it works', async (t) => {
  const r = mkRunner(t);
  let seen = false;
  r.ctx.runPhase1 = async () => {
    const before = fs.statSync(r.files.run).mtimeMs;
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(r.files.run, old, old);
    await new Promise((res) => setTimeout(res, 300));
    seen = fs.statSync(r.files.run).mtimeMs > old.getTime() + 60000 && before > 0;
    return { code: 0, killed: false, aborted: null };
  };
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(seen, true, 'heartbeat refreshed the mtime');
});

test('pipelineBusyPid keeps the legacy contract (pid, null, or -1 when unknown)', (t) => {
  const home = H.mkHome(t, 'busypid');
  assert.equal(runner.pipelineBusyPid(home), null);
  const s = H.sleeper(t);
  H.writeJson(tick.runtimeFiles(home).run, { pid: s.pid, token: tick.procToken(s.pid), nonce: 'n' });
  assert.equal(runner.pipelineBusyPid(home), s.pid);
});

// --- CLI ----------------------------------------------------------------------------------------

test('CLI: --help exits 0 and unknown arguments exit 1', () => {
  const script = path.join(H.SRC_SCRIPTS, 'watchdog-runner.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
  const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: process.env.RESOURCER_HOME } });
  assert.equal(bad.status, 1);
});

// --- real processes -----------------------------------------------------------------------------

const DRIVER = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const r = require(path.join(home, 'scripts', 'watchdog-runner.js'));
const over = JSON.parse(process.env.DRIVER_CTX || '{}');
const ctx = r.makeCtx(Object.assign({ home, settleMs: 0, heartbeatMs: 200, log: () => {} }, over));
r.runOnce(ctx, process.argv.slice(2)).then((res) => process.exit(res.code), (e) => { console.error(e); process.exit(99); });
`;

function realHome(t, phase1Ctl) {
  const home = H.mkHome(t, 'realrunner');
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver.js'), DRIVER);
  if (phase1Ctl) H.setCtl(home, 'phase1', phase1Ctl);
  H.pendingFile(home, 'territory-7-x.json', { sources: 'both' });
  return home;
}

function runDriver(home, args, over, opts) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(home, 'driver.js'), ...(args || ['--from-gate'])], {
      cwd: home, env: { ...process.env, RESOURCER_HOME: home, DRIVER_CTX: JSON.stringify(over || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.stdout.on('data', () => {});
    c.on('close', (code) => resolve({ code, err, child: c }));
    if (opts && opts.onSpawn) opts.onSpawn(c);
  });
}

test('real processes: success path with the real gate and init-status scripts', async (t) => {
  const home = realHome(t, { sleepMs: 400, final: { pool: 12, approved: 4, skippedDb: 6, errors: 0 } });
  const res = await runDriver(home, ['--from-gate']);
  assert.equal(res.code, 0, res.err);
  const markers = fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-'));
  assert.equal(markers.length, 1);
  const m = H.readJson(path.join(home, 'markers', markers[0]));
  assert.equal(m.sources, 'caterer', 'RESOURCER_SOURCES defaults to caterer, so the "both" request is gated');
  const files = tick.runtimeFiles(home);
  const last = H.readJson(files.lastRun);
  assert.equal(last.exitCode, 0);
  assert.equal(last.pool, 12);
  assert.equal(last.approved, 4);
  assert.equal(fs.existsSync(files.run), false);
  const log = fs.readdirSync(path.join(home, 'logs')).filter((f) => f.startsWith('phase1-console-'));
  assert.match(fs.readFileSync(path.join(home, 'logs', log[0]), 'utf8'), /FAKE_PHASE1_START job=Chef/);
  const pending = H.readJson(path.join(home, 'pending-searches', 'territory-7-x.json'));
  assert.ok(pending.spawnedAt, 'the pending file was claimed through the real gate');
});

test('real processes: phase1 exit 2 gives runner exit 11; other failures give 12', async (t) => {
  let home = realHome(t, { sleepMs: 50, exit: 2 });
  assert.equal((await runDriver(home)).code, 11);
  home = realHome(t, { sleepMs: 50, exit: 5 });
  assert.equal((await runDriver(home)).code, 12);
});

test('real processes: the run record carries the phase1 child pid while it runs', async (t) => {
  const home = realHome(t, { sleepMs: 1500 });
  const files = tick.runtimeFiles(home);
  const p = runDriver(home, ['--from-gate']);
  const rec = await H.waitFor(() => { const r = H.readJson(files.run, null); return r && r.childPid ? r : null; }, 8000);
  assert.ok(rec, 'run.json shows the child');
  assert.equal(rec.role, 'runner');
  assert.ok(rec.phase1StartedAt);
  assert.equal(tick.busyState({ home }).busy, true);
  assert.equal((await p).code, 0);
  assert.equal(tick.busyState({ home }).busy, false);
});

test('real processes: two runners started together run phase1 exactly once', async (t) => {
  const home = realHome(t, { sleepMs: 1200 });
  const [a, b] = await Promise.all([runDriver(home), runDriver(home)]);
  const codes = [a.code, b.code].sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 10], `codes ${codes}`);
  assert.equal(fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-')).length, 1);
});

test('real processes: the 70-minute ceiling kills phase1 and its whole group (exit 13)', { skip: !H.IS_LINUX && 'group kill is verified on Linux (WSL)', timeout: 60000 }, async (t) => {
  const home = realHome(t, { sleepMs: 60000, grandchild: true });
  const res = await runDriver(home, ['--from-gate'], { maxRunMs: 1500 });
  assert.equal(res.code, 13, res.err);
  const files = tick.runtimeFiles(home);
  const last = H.readJson(files.lastRun);
  assert.equal(last.exitCode, 13);
  assert.equal(last.killed, true);
  const gc = Number(fs.readFileSync(path.join(home, 'markers', 'grandchild.pid'), 'utf8'));
  assert.equal(await H.waitFor(() => !H.pidExists(gc), 5000), true, 'the grandchild died with the group');
});

test('real processes: a leaked non-detached grandchild is reaped after phase1 exits; a detached daemon is left alone', { skip: !H.IS_LINUX && 'group semantics verified on Linux (WSL)', timeout: 60000 }, async (t) => {
  let home = realHome(t, { sleepMs: 200, grandchild: true });
  let res = await runDriver(home);
  assert.equal(res.code, 0, res.err);
  let gc = Number(fs.readFileSync(path.join(home, 'markers', 'grandchild.pid'), 'utf8'));
  assert.equal(await H.waitFor(() => !H.pidExists(gc), 5000), true, 'leftover in the run group is ended');

  home = realHome(t, { sleepMs: 200, grandchild: true, grandchildDetached: true });
  res = await runDriver(home);
  assert.equal(res.code, 0, res.err);
  gc = Number(fs.readFileSync(path.join(home, 'markers', 'grandchild.pid'), 'utf8'));
  assert.equal(H.pidExists(gc), true, 'a process that left the group on purpose (browser daemon) survives');
  process.kill(gc, 'SIGKILL');
});

test('real processes: the full CLI runs end to end (includes the 5 s session settle)', { timeout: 60000 }, async (t) => {
  const home = realHome(t, { sleepMs: 200 });
  const res = spawnSync(process.execPath, [path.join(home, 'scripts', 'watchdog-runner.js'), '--from-gate'], {
    cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const jsonl = H.readLines(path.join(home, 'logs', 'watchdog-runner.jsonl')).map((l) => l.event);
  for (const ev of ['picked', 'marked-spawned', 'init-status', 'params-written', 'session-loaded', 'phase1-start', 'done']) {
    assert.ok(jsonl.includes(ev), `log event ${ev} present: ${jsonl}`);
  }
  assert.match(res.stdout, /\[watchdog-runner\] done/);
});

test('a login that hangs past its ceiling backs off (exit 11) instead of running beside a live login', async (t) => {
  const r = mkRunner(t, { ctx: { sessionStepMaxMs: 80, ensureLoggedIn: () => new Promise(() => {}) } });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.SESSION_STALE);
  assert.equal(H.readJson(r.files.lastRun).reason, 'session-timeout');
  assert.equal(H.readJson(path.join(r.files.dir, 'caterer-status.json')).state, 'login_failed');
  assert.equal(r.names().includes('phase1'), false);
});

test('the source gate rewrites the pending file so pending, params and init status agree (no endless re-run)', async (t) => {
  const r = mkRunner(t, { allowed: 'caterer', pending: { sources: 'both', priority: 'high' } });
  const pendingFile = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.OK);
  const p = H.readJson(pendingFile);
  assert.equal(p.sources, 'caterer', 'Phase 2 will now see caterer in the pending file and delete it when done');
  assert.equal(p.sourcesRequested, 'both', 'the original request is kept for the record');
  assert.equal(p.priority, 'high', 'other fields untouched');
  const params = JSON.parse(fs.readFileSync(r.calls.find((c) => c[0] === 'phase1')[1], 'utf8'));
  assert.equal(params.SOURCES, 'caterer');
  const order = r.names();
  assert.ok(order.indexOf('create-init-status.js') > -1);
  assert.equal(H.readJson(pendingFile).sourcesRequested, 'both');
});

test('the source gate leaves an agreeing pending file alone and never rewrites in a dry run', async (t) => {
  let r = mkRunner(t, { allowed: 'both', pending: { sources: 'both' } });
  const f = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  const before = fs.readFileSync(f, 'utf8');
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(fs.readFileSync(f, 'utf8'), before);

  r = mkRunner(t, { allowed: 'caterer', pending: { sources: 'both' } });
  const f2 = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  const before2 = fs.readFileSync(f2, 'utf8');
  await runner.runOnce(r.ctx, ['--from-gate', '--dry-run']);
  assert.equal(fs.readFileSync(f2, 'utf8'), before2);
});

test('the gate also rewrites a pending file that asked only for Reed, and keeps a BOM-prefixed file readable', async (t) => {
  const r = mkRunner(t, { allowed: 'caterer', pending: { sources: 'reed' } });
  const f = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  fs.writeFileSync(f, '\ufeff' + fs.readFileSync(f, 'utf8'));
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(H.readJson(f).sources, 'caterer');
});

test('a CV Database module error stops the run before phase1 (exit 11, reason cvdb-module)', async (t) => {
  const r = mkRunner(t, { session: { state: 'moduleerror', detail: 'redirect loop' } });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.SESSION_STALE);
  assert.equal(H.readJson(r.files.lastRun).reason, 'cvdb-module');
  assert.equal(r.names().includes('phase1'), false);
  assert.equal(H.readJson(path.join(r.files.dir, 'caterer-status.json')).state, 'stale');
  for (const v of ['moduleerror', 'MODULE_ERROR', 'cvdb-module', 'CATERER_MODULE_ERROR', { state: 'moduleerror' }, { status: 'CV Database module error' }, { state: 'cvdbmodule' }, { moduleError: true }]) {
    assert.equal(runner.normaliseSession(v), 'moduleerror', JSON.stringify(v));
  }
});

test('CV Database module error, any way the login module answers: exit 11 cvdb-module, phase1 never starts, the browser lock is given back', async (t) => {
  const answers = [
    { session: 'moduleerror' },
    { session: { state: 'moduleerror', detail: 'redirect loop', reloggedIn: false } },
    { session: 'MODULE_ERROR' },
    { ctx: { ensureLoggedInDetailed: async () => ({ state: 'moduleerror', detail: 'error page', reloggedIn: true }) } },
  ];
  for (const a of answers) {
    const events = [];
    const r = mkRunner(t, a);
    r.ctx.log = (e, d) => events.push([e, d]);
    const res = await runner.runOnce(r.ctx, ['--from-gate']);
    assert.equal(res.code, EXIT.SESSION_STALE, JSON.stringify(a));
    const last = H.readJson(r.files.lastRun);
    assert.equal(last.exitCode, 11);
    assert.equal(last.reason, 'cvdb-module');
    assert.equal(r.names().includes('phase1'), false, 'phase1 must not start against a failing CV Database module');
    assert.equal(events.some((e) => e[0] === 'phase1-start'), false);
    assert.ok(events.some((e) => e[0] === 'session-dead' && /CV Database module/.test(e[1].note)));
    assert.equal(H.readJson(path.join(r.files.dir, 'caterer-status.json')).detail, 'CV Database module error');
    assert.equal(r.names().at(-1), 'browser-release', 'the lock does not outlive the refused run');
    assert.equal(fs.existsSync(r.files.run), false);
  }
});

test('browser exclusion: idle Reed browser stopped first, lock taken before anything is claimed, held through phase1, released last', async (t) => {
  const r = mkRunner(t);
  let holder = null;
  const inner = r.ctx.runPhase1;
  r.ctx.runPhase1 = async (c, paramsFile, fd, lock, log) => {
    holder = runner.childEnv(c).RESOURCER_BROWSER_LOCK_HOLDER_PID;
    return inner(c, paramsFile, fd, lock, log);
  };
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.OK);
  const names = r.names();
  assert.ok(names.indexOf('ensure-chrome-cdp.js') < names.indexOf('browser-lock'), 'stop-if-idle comes before taking the lock');
  assert.ok(names.indexOf('browser-lock') < names.indexOf('create-init-status.js'), 'the lock comes before the territory is claimed');
  assert.ok(names.indexOf('browser-lock') < names.indexOf('login'), 'the session check is inside the lock');
  assert.equal(names.at(-1), 'browser-release');
  assert.deepEqual(r.calls[names.indexOf('ensure-chrome-cdp.js')], ['ensure-chrome-cdp.js', ['--stop-if-idle']]);
  const lockCall = r.calls[names.indexOf('browser-lock')];
  assert.equal(lockCall[1], 'caterer');
  assert.equal(lockCall[2].purpose, 'caterer-run');
  assert.equal(holder, String(process.pid), 'phase1 is told who holds browser.lock');
  assert.equal(runner.childEnv(r.ctx).RESOURCER_BROWSER_LOCK_HOLDER_PID, undefined, 'and only for the duration of the run');
});

test('browser exclusion: a borrowed lock hands the real holder pid to the children', async (t) => {
  const r = mkRunner(t);
  r.ctx.browserLock = { wait: async () => ({ acquired: true, borrowed: true, holder: { owner: 'caterer', pid: 987654 }, release: () => {} }) };
  let holder = null;
  r.ctx.runPhase1 = async (c) => { holder = runner.childEnv(c).RESOURCER_BROWSER_LOCK_HOLDER_PID; return { code: 0, killed: false, aborted: null }; };
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK);
  assert.equal(holder, '987654');
});

test('browser exclusion: a live Reed (or other) holder makes the runner defer with exit 10 and claim nothing', async (t) => {
  const r = mkRunner(t, { lockBusy: true });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.NO_WORK);
  assert.equal(res.reason, 'browser-busy');
  assert.equal(r.calls.some((c) => c[1] && c[1][0] === '--mark-spawned'), false, 'the pending file is not claimed');
  assert.equal(r.names().includes('create-init-status.js'), false);
  assert.equal(r.names().includes('login'), false);
  assert.equal(r.names().includes('phase1'), false);
  assert.equal(fs.existsSync(r.files.run), false, 'the run claim is released');
  assert.equal(fs.existsSync(r.files.lastRun), false, 'a deferral is not a result');
  assert.equal(H.readJson(path.join(r.home, 'pending-searches', 'territory-7-x.json')).spawnedAt, undefined);
});

test('browser exclusion: a broken lock module is a loud runner error, never an unprotected run', async (t) => {
  const r = mkRunner(t, { lockThrows: true });
  const res = await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(res.code, EXIT.ERROR);
  assert.equal(H.readJson(r.files.lastRun).reason, 'browser-lock-error');
  assert.equal(r.names().includes('phase1'), false);
  assert.equal(r.names().includes('create-init-status.js'), false);
});

test('browser exclusion: the lock is released on every way out of a run', async (t) => {
  const cases = [
    { session: 'safelist' },
    { session: 'login' },
    { phase1: { code: 2, killed: false } },
    { phase1: { code: 9, killed: false } },
    { phase1: { code: null, killed: true } },
    { phase1: { spawnError: 'ENOENT' } },
    { initFails: true },
    { markFails: true },
  ];
  for (const c of cases) {
    const r = mkRunner(t, c);
    await runner.runOnce(r.ctx, ['--from-gate']);
    assert.equal(r.names().filter((n) => n === 'browser-lock').length, 1, JSON.stringify(c));
    assert.equal(r.names().filter((n) => n === 'browser-release').length, 1, 'released exactly once: ' + JSON.stringify(c));
  }
  const thrown = mkRunner(t);
  thrown.ctx.runPhase1 = async () => { throw new Error('boom'); };
  assert.equal((await runner.runOnce(thrown.ctx, ['--from-gate'])).code, EXIT.ERROR);
  assert.equal(thrown.names().at(-1), 'browser-release');
});

test('browser exclusion: a failing or throwing stop-if-idle never stops the run; a dry run touches no browser', async (t) => {
  for (const mode of ['exit', 'throw']) {
    const r = mkRunner(t);
    const inner = r.ctx.exec;
    r.ctx.exec = async (script, args, opts) => {
      if (script === 'ensure-chrome-cdp.js') {
        if (mode === 'throw') throw new Error('spawn failed');
        return { code: 1, stdout: '', stderr: 'CDP_LAUNCH_FAILED: nope', error: 'x' };
      }
      return inner(script, args, opts);
    };
    const events = [];
    r.ctx.log = (e, d) => events.push([e, d]);
    assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK, mode);
    assert.ok(events.some((e) => e[0] === 'browser-stop-idle'), mode);
  }
  const d = mkRunner(t);
  await runner.runOnce(d.ctx, ['--from-gate', '--dry-run']);
  assert.equal(d.names().includes('ensure-chrome-cdp.js'), false);
  assert.equal(d.names().includes('browser-lock'), false);
});

test('source gate: a file gated while Reed was off gets its original request back once the canary has passed', async (t) => {
  const r = mkRunner(t, { allowed: 'both', pending: { sources: 'caterer', sourcesRequested: 'both' } });
  const f = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK);
  const p = H.readJson(f);
  assert.equal(p.sources, 'both');
  assert.equal(p.sourcesRequested, 'both');
  const params = JSON.parse(fs.readFileSync(r.calls.find((c) => c[0] === 'phase1')[1], 'utf8'));
  assert.equal(params.SOURCES, 'both');
});

test('source gate: an already gated file is left exactly as it is while Reed stays off (idempotent across retries)', async (t) => {
  const r = mkRunner(t, { allowed: 'caterer', pending: { sources: 'caterer', sourcesRequested: 'both' } });
  const f = path.join(r.home, 'pending-searches', 'territory-7-x.json');
  const before = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal((await runner.runOnce(r.ctx, ['--from-gate'])).code, EXIT.OK);
  const after = H.readJson(f);
  assert.equal(after.sources, 'caterer');
  assert.equal(after.sourcesRequested, 'both');
  assert.deepEqual(after, before, 'not rewritten at all');
  const params = JSON.parse(fs.readFileSync(r.calls.find((c) => c[0] === 'phase1')[1], 'utf8'));
  assert.equal(params.SOURCES, 'caterer');
});

test('source gate: the dry run shows the same effective sources as a real run, and the request is derived in one place', async (t) => {
  const r = mkRunner(t, { allowed: 'both' });
  const p = runner.buildParams(r.ctx, { jobTitle: 'Chef', location: 'B25', sources: 'caterer', sourcesRequested: 'both' }, 'I');
  assert.equal(p.SOURCES, 'both');
  assert.equal(runner.requestedSources({ sources: 'caterer' }), 'caterer');
  assert.equal(runner.requestedSources({ source: 'territory-scheduler' }), 'caterer');
  assert.equal(runner.requestedSources({}), 'both');
});

test('runtime/caterer-status.json follows the session outcome for the dashboard', async (t) => {
  const status = (r) => H.readJson(path.join(r.files.dir, 'caterer-status.json'));
  let r = mkRunner(t, { session: 'ok' });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(status(r).state, 'ok');
  assert.ok(status(r).updatedAt);
  r = mkRunner(t, { session: 'safelist' });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(status(r).state, 'safelist_blocked');
  r = mkRunner(t, { session: 'login' });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(status(r).state, 'login_failed');
  r = mkRunner(t, { session: { state: 'ok', reloggedIn: true } });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(status(r).state, 'ok');
  assert.match(status(r).detail, /signed in again/);
  r = mkRunner(t, { phase1: { code: 2, killed: false } });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(status(r).state, 'stale');
  r = mkRunner(t, { session: 'error' });
  await runner.runOnce(r.ctx, ['--from-gate']);
  assert.equal(fs.existsSync(path.join(r.files.dir, 'caterer-status.json')), false, 'an inconclusive check writes nothing');
});

test('legacy log events the dashboard maps are emitted (safelist, relogin, loaded, done)', async (t) => {
  const events = [];
  const mk = (o) => { const r = mkRunner(t, o); r.ctx.log = (e, d) => events.push([e, d]); return r; };
  await runner.runOnce(mk({ session: 'safelist' }).ctx, ['--from-gate']);
  const names = events.map((e) => e[0]);
  assert.ok(names.includes('session-safelist-blocked') && names.includes('session-dead'));
  assert.match(events.find((e) => e[0] === 'session-dead')[1].note, /safelist/i);
  events.length = 0;
  await runner.runOnce(mk({ session: { state: 'ok', reloggedIn: true } }).ctx, ['--from-gate']);
  const n2 = events.map((e) => e[0]);
  for (const ev of ['session-relogin', 'session-loaded', 'phase1-start', 'done']) assert.ok(n2.includes(ev), ev);
  events.length = 0;
  await runner.runOnce(mk({ phase1: { code: 2, killed: false } }).ctx, ['--from-gate']);
  assert.ok(events.map((e) => e[0]).includes('session-stale'));
});

// --- browser.lock with the real launcher module --------------------------------------------------

const phase1Markers = (home) => fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-')).map((f) => H.readJson(path.join(home, 'markers', f)));

test('real processes: browser.lock is held by the runner for the whole run and phase1 is told who holds it', async (t) => {
  const home = realHome(t, { sleepMs: 1500 });
  const files = tick.runtimeFiles(home);
  const lockFile = path.join(files.dir, 'browser.lock');
  const p = runDriver(home, ['--from-gate']);
  const rec = await H.waitFor(() => { const r = H.readJson(files.run, null); return r && r.childPid ? r : null; }, 10000);
  assert.ok(rec, 'phase1 started');
  const lock = H.readJson(lockFile, null);
  assert.ok(lock, 'browser.lock exists while phase1 runs');
  assert.equal(lock.owner, 'caterer');
  assert.equal(lock.pid, rec.pid, 'the runner is the holder');
  assert.equal(lock.purpose, 'caterer-run');
  const res = await p;
  assert.equal(res.code, 0, res.err);
  const m = phase1Markers(home)[0];
  assert.equal(m.holderPid, String(rec.pid), 'RESOURCER_BROWSER_LOCK_HOLDER_PID reached phase1');
  assert.equal(m.browserLock.owner, 'caterer', 'phase1 saw the lock while it ran');
  assert.equal(fs.existsSync(lockFile), false, 'released when the run ended');
});

test('real processes: a live foreign holder defers the run and claims nothing; a dead holder is taken over', async (t) => {
  const home = realHome(t, { sleepMs: 200 });
  const files = tick.runtimeFiles(home);
  const lockFile = path.join(files.dir, 'browser.lock');
  const pending = path.join(home, 'pending-searches', 'territory-7-x.json');
  const other = H.sleeper(t);
  H.writeJson(lockFile, { owner: 'reed', pid: other.pid, startedAt: new Date().toISOString(), purpose: 'reed-phase1' });
  const res = await runDriver(home, ['--from-gate'], { browserLockWaitMs: 0 });
  assert.equal(res.code, EXIT.NO_WORK, res.err);
  assert.equal(H.readJson(pending).spawnedAt, undefined, 'the territory was not claimed');
  assert.equal(phase1Markers(home).length, 0);
  assert.equal(H.readJson(lockFile).pid, other.pid, 'the foreign lock is untouched');
  assert.equal(fs.existsSync(files.run), false);

  other.kill();
  assert.equal(await H.waitFor(() => !H.pidExists(other.pid), 5000), true);
  const again = await runDriver(home, ['--from-gate'], { browserLockWaitMs: 0 });
  assert.equal(again.code, 0, again.err);
  assert.equal(phase1Markers(home).length, 1);
  assert.equal(fs.existsSync(lockFile), false);
});

test('releasePendingClaim removes spawnedAt from a pending search and logs it; a file without the stamp is left alone', () => {
  const fs2 = require('fs');
  const os2 = require('os');
  const path2 = require('path');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'rpc-'));
  try {
    const file = path2.join(dir, 'search-1.json');
    fs2.writeFileSync(file, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', spawnedAt: '2026-09-29T10:00:00.000Z' }));
    const events = [];
    runner.releasePendingClaim({}, file, (e, d) => events.push([e, d]), 'safelist');
    assert.deepEqual(JSON.parse(fs2.readFileSync(file, 'utf8')), { jobTitle: 'Chef', location: 'LS1' });
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'pending-released');
    assert.equal(events[0][1].reason, 'safelist');
    runner.releasePendingClaim({}, file, (e, d) => events.push([e, d]));
    assert.equal(events.length, 1, 'nothing to release the second time');
    runner.releasePendingClaim({}, path2.join(dir, 'missing.json'), (e, d) => events.push([e, d]));
    assert.equal(events.length, 1);
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});
