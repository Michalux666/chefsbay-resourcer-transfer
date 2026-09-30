'use strict';
// Poison territories (review findings "claim release on every failed run" and "a poison territory is retried every
// minute forever"): the pending gate quarantines malformed files, the runner keeps the claim on territory failures,
// the watchdog counts failures per file and quarantines at three, and an operator can release a file again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
const SKIP = !H.IS_LINUX && 'process semantics are verified on Linux (WSL)';
process.env.RESOURCER_HOME = H.mkHome(null, 'poisonbase');
const gate = require(path.join(H.SRC_SCRIPTS, 'pending-gate.js'));
const runner = require(path.join(H.SRC_SCRIPTS, 'watchdog-runner.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const MIN = 60000;

function runGate(home, args) {
  return spawnSync(process.execPath, [path.join(H.SRC_SCRIPTS, 'pending-gate.js'), ...(args || [])], {
    cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8',
  });
}

const put = (home, name, data, raw) => {
  const p = path.join(home, 'pending-searches', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, raw !== undefined ? raw : JSON.stringify(data));
  return p;
};
const alertsOf = (home) => H.readLines(path.join(home, 'outbox', 'alerts.jsonl'));

// --- pending-gate: validation and quarantine --------------------------------------------------------

test('validatePending: a launchable search has a job title, a location and known sources; everything else has a reason', () => {
  const ok = { jobTitle: 'Chef', location: 'LS1' };
  assert.equal(gate.validatePending(ok), null);
  assert.equal(gate.validatePending({ ...ok, sources: 'Both', sourcesRequested: 'reed', distance: 'far', keywords: 5 }), null, 'sources are case-insensitive, other fields are not judged');
  for (const bad of [{}, [], null, 'x', 7, { jobTitle: 'Chef' }, { location: 'LS1' }, { jobTitle: '', location: 'LS1' }, { jobTitle: '  ', location: 'LS1' }, { jobTitle: 5, location: 'LS1' },
    { jobTitle: 'Chef', location: ['LS1'] }, { job_title: 'Chef', location: 'LS1' }, { ...ok, sources: 'everywhere' }, { ...ok, sources: 7 }, { ...ok, sourcesRequested: 'nope' },
    { jobTitle: 'x'.repeat(121), location: 'LS1' }, { jobTitle: 'Chef', location: 'y'.repeat(81) }]) {
    assert.equal(typeof gate.validatePending(bad), 'string', JSON.stringify(bad));
  }
});

test('the gate quarantines a valid-JSON file of the wrong shape with one critical alert, and serves the good file behind it', (t) => {
  const home = H.mkHome(t, 'gateq');
  put(home, 'a-empty.json', {});
  put(home, 'b-snake.json', { job_title: 'Chef', location: 'LS1' });
  put(home, 'c-array.json', [1, 2]);
  put(home, 'd-good.json', { jobTitle: 'Chef', location: 'LS1' });
  const r = runGate(home);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.status, 'READY');
  assert.equal(out.file, 'd-good.json');
  assert.equal(out.queueDepth, 1, 'quarantined files are not queued work');
  assert.deepEqual(fs.readdirSync(path.join(home, 'pending-searches')).filter((f) => f.endsWith('.json')), ['d-good.json']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'pending-searches', '.quarantine')).filter((f) => f.endsWith('.json')).sort(), ['a-empty.json', 'b-snake.json', 'c-array.json']);
  assert.match(fs.readFileSync(path.join(home, 'pending-searches', '.quarantine', 'a-empty.why.txt'), 'utf8'), /jobTitle is missing/);
  const al = alertsOf(home);
  assert.equal(al.length, 3);
  assert.ok(al.every((a) => a.severity === 'critical' && /^territory-quarantined:/.test(a.key)));
  assert.match(al[0].text, /release-quarantine a-empty\.json/);
  assert.equal(new Set(al.map((a) => a.key)).size, 3, 'one dedupe key per file, so each is delivered');
  assert.equal(runGate(home).stdout.includes('READY'), true, 'a second look raises nothing new');
  assert.equal(alertsOf(home).length, 3);
});

test('when every file is quarantined the queue is simply empty, not "spawned" or "corrupt"', (t) => {
  const home = H.mkHome(t, 'gateall');
  put(home, 'a.json', {});
  put(home, 'b.json', { jobTitle: 'Chef' });
  const r = runGate(home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'NO_WORK');
});

test('the gate ignores dot files, dot directories and directories named like a file; unparseable files keep their old handling', (t) => {
  const home = H.mkHome(t, 'gatedot');
  put(home, '.hidden.json', { jobTitle: 'Chef', location: 'LS1' });
  fs.mkdirSync(path.join(home, 'pending-searches', 'dir.json'));
  fs.mkdirSync(path.join(home, 'pending-searches', '.quarantine'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pending-searches', '.quarantine', 'old.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS1' }));
  assert.equal(runGate(home).stdout.trim(), 'NO_WORK');
  put(home, 'bad.json', null, '{nope');
  const r = runGate(home);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR:all_files_corrupt \(1 parse failures\)/);
  assert.equal(fs.existsSync(path.join(home, 'pending-searches', 'bad.json')), true, 'left in place, as before');
});

test('releaseQuarantined puts the file back with its claim and failure counters cleared, and never overwrites', (t) => {
  const home = H.mkHome(t, 'gaterel');
  const dir = path.join(home, 'pending-searches');
  put(home, 'territory-1.json', { jobTitle: 'Chef', location: 'AB1', spawnedAt: new Date().toISOString(), failedRuns: 3, lastFailure: { exitCode: 12 } });
  gate.quarantineFile(dir, 'territory-1.json', 'test');
  assert.deepEqual(gate.listQuarantined(dir), ['territory-1.json']);
  assert.equal(gate.releaseQuarantined(dir, '../evil.json').ok, false);
  assert.equal(gate.releaseQuarantined(dir, 'nope.json').ok, false);
  const r = gate.releaseQuarantined(dir, 'territory-1.json');
  assert.equal(r.ok, true);
  assert.deepEqual(H.readJson(path.join(dir, 'territory-1.json')), { jobTitle: 'Chef', location: 'AB1' });
  assert.deepEqual(gate.listQuarantined(dir), []);
  assert.equal(fs.existsSync(path.join(dir, '.quarantine', 'territory-1.why.txt')), false);
  put(home, 'territory-2.json', { jobTitle: 'Chef', location: 'AB2' });
  gate.quarantineFile(dir, 'territory-2.json', 'again');
  put(home, 'territory-2.json', { jobTitle: 'Chef', location: 'AB2', fresh: true });
  const clash = gate.releaseQuarantined(dir, 'territory-2.json');
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already exists/);
  assert.equal(H.readJson(path.join(dir, 'territory-2.json')).fresh, true, 'the newer file is untouched');
});

// --- runner: which failures keep the claim ---------------------------------------------------------------

test('faultless(): only failures the territory did not cause give the claim back and stay uncounted', () => {
  const E = runner.EXIT;
  assert.equal(runner.faultless(E.SESSION_STALE, 'safelist'), true);
  assert.equal(runner.faultless(E.SESSION_STALE, undefined), true);
  for (const reason of ['signal-SIGTERM', 'phase1-exit-3', 'phase1-exit-7', 'spawn-error', 'browser-lock-error', 'resolve-error', 'mark-spawned-error', 'screening-unavailable']) {
    assert.equal(runner.faultless(E.ERROR, reason), true, reason);
  }
  for (const [code, reason] of [[E.PHASE1_FAILED, 'phase1-exit-5'], [E.PHASE1_FAILED, 'phase1-exit-4'], [E.PHASE1_FAILED, 'phase1-exit-6'], [E.KILLED, 'timeout'],
    [E.ERROR, 'init-status-error'], [E.ERROR, 'params-error'], [E.ERROR, 'sources-gate-error'], [E.ERROR, 'fatal'], [E.ERROR, 'invalid-pending'], [E.ERROR, undefined]]) {
    assert.equal(runner.faultless(code, reason), false, `${code} ${reason}`);
  }
});

const DRIVER = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const r = require(path.join(home, 'scripts', 'watchdog-runner.js'));
const ctx = r.makeCtx({ home, settleMs: 0, heartbeatMs: 200, log: () => {} });
r.runOnce(ctx, process.argv.slice(2)).then((res) => process.exit(res.code), (e) => { console.error(e); process.exit(99); });
`;

function runnerHome(t, ctl, files) {
  const home = H.mkHome(t, 'poisonrun');
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver.js'), DRIVER);
  H.setCtl(home, 'phase1', ctl);
  for (const [name, extra] of files) H.pendingFile(home, name, extra);
  return home;
}

function drive(home, args) {
  return spawnSync(process.execPath, [path.join(home, 'driver.js'), ...(args || ['--from-gate'])], { cwd: home, env: { ...process.env, RESOURCER_HOME: home, RESOURCER_SETTLE_MS: '0' }, encoding: 'utf8', timeout: 60000 });
}

test('real runner: a phase1 failure (exit 12) keeps the territory claimed; a session failure (11) gives it back', () => {
  const t = { after: () => {} };
  for (const [ctl, code, claimed] of [[{ sleepMs: 30, exit: 5 }, 12, true], [{ sleepMs: 30, exit: 2 }, 11, false], [{ sleepMs: 30, exit: 3 }, 12, false]]) {
    const home = runnerHome(t, ctl, [['territory-1-x.json', { location: 'AB1' }]]);
    const r = drive(home);
    assert.equal(r.status, code, r.stderr);
    const pending = H.readJson(path.join(home, 'pending-searches', 'territory-1-x.json'));
    assert.equal(Boolean(pending.spawnedAt), claimed, `${JSON.stringify(ctl)}: claim ${claimed ? 'kept (stale-spawn rotation)' : 'released'}`);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('real runner: a file the gate never quarantined but that is invalid (explicit --pending) is refused before anything is claimed', (t) => {
  const home = runnerHome(t, { sleepMs: 30 }, []);
  put(home, 'manual.json', { location: 'AB1' });
  const r = drive(home, ['--pending', 'manual.json']);
  assert.equal(r.status, 1);
  assert.equal(H.readJson(tick.runtimeFiles(home).lastRun).reason, 'invalid-pending');
  assert.equal(fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-')).length, 0, 'phase1 never started');
  assert.equal(H.readJson(path.join(home, 'pending-searches', 'manual.json')).spawnedAt, undefined);
});

// --- end to end: one poison territory cannot block the queue --------------------------------------------

const TICK_DRIVER = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const wd = require(path.join(home, 'scripts', 'pipeline-watchdog.js'));
const ctx = wd.makeCtx({ home, inWindow: () => true, slowChecks: async () => {}, diskGuard: () => ({}), log: (m, l) => console.log((l || 'info') + ': ' + m) });
wd.runTick(ctx, { maxMinutes: 3, superviseMs: 250 }).then((r) => {
  console.log('TICK_RESULT ' + JSON.stringify({ reason: r.reason, launched: r.launched, exitCode: r.exitCode }));
  process.exit(r.exitCode);
}, (e) => { console.error(e); process.exit(99); });
`;

function runTick(home) {
  const c = spawn(process.execPath, [path.join(home, 'driver-tick.js')], { cwd: home, env: { ...process.env, RESOURCER_HOME: home, RESOURCER_SETTLE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => c.on('close', (code) => resolve({ code, out })));
}

test('one poison territory in front of a good one: the good one runs, the poison one is retried on the stale-spawn rotation and quarantined at the third failure', { skip: SKIP, timeout: 180000 }, async (t) => {
  const home = H.mkHome(t, 'poisone2e', { db: true });
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver-tick.js'), TICK_DRIVER);
  H.setCtl(home, 'phase1', { sleepMs: 200, failLocations: ['AB1'], failExit: 6, consumePending: true });
  const poison = path.join(home, 'pending-searches', 'territory-1-20260929-1000.json');
  H.pendingFile(home, 'territory-1-20260929-1000.json', { location: 'AB1' });
  H.pendingFile(home, 'territory-2-20260929-1000.json', { location: 'AB2' });
  const files = tick.runtimeFiles(home);
  const age = () => { const d = H.readJson(poison); d.spawnedAt = new Date(Date.now() - 11 * MIN).toISOString(); H.writeJson(poison, d); };
  const noBackoff = () => { const s = H.readJson(files.state, {}); s.launchNotBefore = 0; H.writeJson(files.state, s); };
  const ran = () => fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-')).map((f) => H.readJson(path.join(home, 'markers', f)).location);

  let r = await runTick(home);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(ran(), ['AB1'], 'the oldest file runs first and fails');
  assert.equal(H.readJson(poison).spawnedAt !== undefined, true, 'the claim is kept (legacy stale-spawn rotation)');
  assert.equal(H.readJson(files.state).recentRuns[0].exitCode, 12);
  assert.equal(H.readJson(poison).failedRuns, 1);
  noBackoff();
  r = await runTick(home);
  assert.deepEqual(ran().sort(), ['AB1', 'AB2'], `the good territory behind the poison one ran: ${r.out}`);
  assert.equal(fs.existsSync(path.join(home, 'pending-searches', 'territory-2-20260929-1000.json')), false, 'and was consumed');

  age();
  noBackoff();
  r = await runTick(home);
  assert.equal(H.readJson(poison).failedRuns, 2, r.out);
  age();
  noBackoff();
  r = await runTick(home);
  assert.equal(fs.existsSync(poison), false, `quarantined after three failures: ${r.out}`);
  const q = path.join(home, 'pending-searches', '.quarantine', 'territory-1-20260929-1000.json');
  assert.equal(H.readJson(q).failedRuns, 3);
  assert.equal(H.readJson(q).lastFailure.exitCode, 12);
  const qa = alertsOf(home).filter((a) => /^territory-quarantined:/.test(a.key));
  assert.equal(qa.length, 1);
  assert.equal(qa[0].severity, 'critical');
  assert.match(qa[0].text, /territory-1-20260929-1000\.json/);
  assert.match(qa[0].text, /bad url encoding/);
  assert.match(qa[0].text, /--release-quarantine territory-1-20260929-1000\.json/);

  const gateNow = runGate(home);
  assert.equal(gateNow.stdout.trim(), 'NO_WORK', 'nothing left to run');

  const cli = spawnSync(process.execPath, [path.join(home, 'scripts', 'pipeline-watchdog.js'), '--release-quarantine', 'territory-1-20260929-1000.json'], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /released territory-1-20260929-1000\.json/);
  assert.deepEqual(H.readJson(poison), { jobTitle: 'Chef', location: 'AB1', distance: 20, keywords: '', priority: 'low', sources: 'caterer', cvLimit: 20, requestedAt: H.readJson(poison).requestedAt, source: 'territory-scheduler' });
  const bad = spawnSync(process.execPath, [path.join(home, 'scripts', 'pipeline-watchdog.js'), '--release-quarantine', 'ghost.json'], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not in \.quarantine/);
  const st = spawnSync(process.execPath, [path.join(home, 'scripts', 'pipeline-watchdog.js'), '--status'], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(st.stdout).quarantined, []);
});
