'use strict';
// RESOURCER_SOURCES gating, traced through the whole chain: territory file (sources=both) -> tick ->
// runner (gate) -> phase1 (fake) -> the REAL Phase 2 pending-file cleanup. With Reed off, the file must
// be consumed once and the result must not claim a Reed run that never happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'srcbase');
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* skipped below */ }
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const SKIP = (!Database && 'better-sqlite3 is not installed (the real Phase 2 needs it)') || (!H.IS_LINUX && 'runs on Linux (WSL)');
const CHILD = path.join(__dirname, 'fixtures', 'phase2-child.js');

const DRIVER = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const wd = require(path.join(home, 'scripts', 'pipeline-watchdog.js'));
const ctx = wd.makeCtx({ home, inWindow: () => true, slowChecks: async () => {}, diskGuard: () => ({}), log: () => {} });
wd.runTick(ctx, { maxMinutes: 3, superviseMs: 250 }).then((r) => process.exit(r.exitCode), (e) => { console.error(e); process.exit(99); });
`;

function runTick(home, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(home, 'driver.js')], { cwd: home, env: { ...process.env, RESOURCER_HOME: home, RESOURCER_SETTLE_MS: '0', ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.stdout.on('data', () => {});
    c.on('close', (code) => resolve({ code, err }));
  });
}

function phase2(t, input) {
  const dir = H.mkHome(t, 'p2in');
  const file = path.join(dir, 'input.json');
  H.writeJson(file, input);
  const r = spawnSync(process.execPath, [CHILD, file], { encoding: 'utf8', timeout: 120000, env: { ...process.env, RESOURCER_HOME: '', RESOURCER_SOURCES: 'caterer', LIFECYCLE_TEST_TMP: H.tmpRoot() } });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `phase 2 child gave no result: ${r.stdout}${r.stderr}`);
  return JSON.parse(line.slice(7));
}

function setup(t) {
  const home = H.mkHome(t, 'srcchain', { db: true });
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver.js'), DRIVER);
  H.setCtl(home, 'phase1', { sleepMs: 200 });
  const name = 'territory-1-20260929-1000.json';
  H.pendingFile(home, name, { sources: 'both', jobTitle: 'Chef', location: 'AB1' });
  return { home, name, file: path.join(home, 'pending-searches', name) };
}

const markers = (home) => fs.readdirSync(path.join(home, 'markers')).filter((f) => f.startsWith('phase1-')).map((f) => H.readJson(path.join(home, 'markers', f)));

test('Reed off, territory says both: the tick runs it once as caterer, the real Phase 2 deletes the file and labels the result caterer', { skip: SKIP, timeout: 180000 }, async (t) => {
  const s = setup(t);
  const res = await runTick(s.home);
  assert.equal(res.code, 0, res.err);
  const m = markers(s.home);
  assert.equal(m.length, 1, 'the territory ran once');
  assert.equal(m[0].sources, 'caterer');

  const gated = H.readJson(s.file);
  assert.equal(gated.sources, 'caterer');
  assert.equal(gated.sourcesRequested, 'both');

  // What phase1 hands to Phase 2 for those params: a queue file whose sources are the params' sources.
  const out = phase2(t, { jobTitle: 'Chef', location: 'AB1', queue: { sources: m[0].sources }, pending: [{ name: s.name, data: gated }] });
  assert.equal(out.code, 0);
  assert.deepEqual(out.pending, [], 'Phase 2 consumed the pending file');
  assert.equal(out.sources, 'caterer', 'and did not report a Reed run that never happened');

  fs.unlinkSync(s.file);
  const again = await runTick(s.home);
  assert.equal(again.code, 0, again.err);
  assert.equal(markers(s.home).length, 1, 'nothing is left to run twice');
});

test('belt and braces: even a pending file the runner never rewrote is consumed by Phase 2 while Reed is off, and the result stays caterer', { skip: SKIP, timeout: 180000 }, (t) => {
  const out = phase2(t, { jobTitle: 'Chef', location: 'AB1', queue: { sources: 'caterer' }, pending: [{ name: 'territory-1-20260929-1000.json', data: { jobTitle: 'Chef', location: 'AB1', sources: 'both', spawnedAt: new Date().toISOString() } }] });
  assert.equal(out.code, 0);
  assert.deepEqual(out.pending, []);
  assert.equal(out.sources, 'caterer', 'Phase 2 ignores the pending hint while RESOURCER_SOURCES keeps Reed off');
});

test('Reed on: the request is left alone and Phase 2 sees a both run', { skip: SKIP, timeout: 180000 }, async (t) => {
  const s = setup(t);
  const res = await runTick(s.home, { RESOURCER_SOURCES: 'both' });
  assert.equal(res.code, 0, res.err);
  const m = markers(s.home);
  assert.equal(m.length, 1);
  assert.equal(m[0].sources, 'both');
  const p = H.readJson(s.file);
  assert.equal(p.sources, 'both');
  assert.equal(p.sourcesRequested, undefined, 'nothing was downgraded, so nothing is recorded');
});

test('a territory gated while Reed was off runs with Reed again once the operator enables it', { skip: SKIP, timeout: 180000 }, async (t) => {
  const s = setup(t);
  await runTick(s.home);
  assert.equal(H.readJson(s.file).sources, 'caterer');
  // the claim from the first run is ten minutes old in real life; the operator has meanwhile flipped RESOURCER_SOURCES
  const p = H.readJson(s.file);
  delete p.spawnedAt;
  H.writeJson(s.file, p);
  const st = H.readJson(tick.runtimeFiles(s.home).state);
  st.launchNotBefore = 0;
  H.writeJson(tick.runtimeFiles(s.home).state, st);
  const res = await runTick(s.home, { RESOURCER_SOURCES: 'both' });
  assert.equal(res.code, 0, res.err);
  const m = markers(s.home);
  assert.equal(m.length, 2);
  assert.equal(m[1].sources, 'both');
  assert.equal(H.readJson(s.file).sources, 'both');
  assert.equal(H.readJson(s.file).sourcesRequested, 'both');
});
