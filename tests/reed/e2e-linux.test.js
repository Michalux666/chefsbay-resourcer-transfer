'use strict';

// End to end on Linux: run-pipeline -> real reed-phase1 -> real launcher -> fake chromium under the REAL xvfb-run (hosting the fake
// Reed CDP + API) -> fake screening / Phase 2 / optimiser. Verifies the browser lifecycle: launched for the Reed step, torn down after.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeMirror, dep } = require('./helpers/mirror');
const { FAKE_PAQ, FAKE_OPT } = require('./helpers/fake-phases');

const hasXvfb = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run && command -v Xvfb && command -v xauth']).status === 0;
const SKIP = hasXvfb ? false : 'needs Linux with xvfb-run, Xvfb and xauth';
const FAKE = path.resolve(__dirname, 'helpers', 'fake-chromium.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { procs, withProfile, xvfbOrphans } = require('./helpers/procs');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function until(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; }

async function setup(extraEnv) {
  const m = makeMirror();
  m.write('scripts/process-approved-queue.js', FAKE_PAQ);
  m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
  const bin = m.write('fake-chromium', `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, 0o755);
  m.write('downloads/approved-queue-2026-09-29-101010.json', { searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 20, sources: 'both', candidateCount: 3, phase1Stats: { pool: 3 }, candidates: [{ id: 'c1' }] });
  const statusFile = m.write('runs/phase1-2026-09-29-101010.json', { status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 20 });
  const port = await freePort();
  const apiPort = await freePort();
  const profile = m.p('state', 'chrome-reed');
  const env = {
    RESOURCER_SOURCES: 'both', CHROMIUM_PATH: bin, REED_CDP_PORT: String(port), FAKE_API_PORT: String(apiPort),
    REED_API_BASE: `http://127.0.0.1:${apiPort}/api-bff-recruiter-candidates`, REED_CDP_WAIT_S: '15', REED_KEEP_CHROME: '',
    ...(extraEnv || {}),
  };
  return {
    m, profile, statusFile, env,
    run: (e) => m.run('run-pipeline.js', ['--status-file', statusFile], { env: { ...env, ...(e || {}) }, timeoutMs: 120000 }),
  };
}
const dbRows = (m) => { const D = dep('better-sqlite3'); const db = new D(m.p('candidates.db'), { readonly: true }); try { return db.prepare('SELECT reed_id, unlocked FROM candidates').all(); } finally { db.close(); } };

test('full Reed step on Linux: browser launched under xvfb-run for Reed, session captured, queue merged, Phase 2 once, browser tree torn down, no orphans', { skip: SKIP }, async () => {
  const w = await setup();
  try {
    const orphansBefore = new Set(xvfbOrphans());
    const r = await w.run();
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /CDP_LAUNCHING: starting Chromium/);
    assert.match(r.stderr, /Token refreshed OK/);
    const calls = w.m.readLines('calls.jsonl');
    assert.deepStrictEqual(calls.map((c) => c.who), ['phase2', 'optimiser']);
    const merged = w.m.readJson(`downloads/${calls[0].queue}`);
    assert.strictEqual(merged.sources, 'both');
    assert.strictEqual(merged.candidates.length, 21, '1 caterer + 20 Reed approvals (run-pipeline passes --cv-limit 20)');
    assert.strictEqual(merged.phase1Stats.reed.pool, 30);
    assert.strictEqual(dbRows(w.m).length, 20);
    assert.ok(w.m.exists('state/reed-session.json'));
    assert.ok(fs.existsSync(path.join(w.profile, 'launches.txt')), 'the profile lives under state/');
    assert.strictEqual(withProfile(w.profile).length, 0, 'the whole browser tree is gone after the run');
    assert.ok(await until(() => xvfbOrphans().every((p) => orphansBefore.has(p))), 'no orphaned Xvfb');
    assert.strictEqual(w.m.exists('runtime/browser.lock'), false);
    assert.strictEqual(fs.existsSync(`${w.statusFile}.run-lock`), false);
    assert.strictEqual(w.m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
  } finally { spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop', '--force'], { env: w.m.env(w.env) }); w.m.cleanup(); }
});

test('REED_KEEP_CHROME=1 leaves the browser up after the run (operator debugging switch); --stop-if-idle then cleans it', { skip: SKIP }, async () => {
  const w = await setup({ REED_KEEP_CHROME: '1' });
  try {
    const r = await w.run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(withProfile(w.profile).length > 0, 'browser kept');
    const s = spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop-if-idle'], { env: w.m.env(w.env) });
    assert.match(s.stdout.toString(), /CDP_STOPPED/);
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop', '--force'], { env: w.m.env(w.env) }); w.m.cleanup(); }
});

test('D4 through the whole chain: screening down -> halt raised, nothing burned, Phase 2 still runs once, browser torn down', { skip: SKIP }, async () => {
  const w = await setup({ FAKE_AI_PLAN: 'unavailable,unavailable,unavailable' });
  try {
    const r = await w.run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(dbRows(w.m).length, 0, 'no Reed candidate was marked seen');
    assert.strictEqual(w.m.readJson('runtime/pipeline-halt.json').reason, 'AI screening unavailable');
    const calls = w.m.readLines('calls.jsonl');
    assert.deepStrictEqual(calls.map((c) => c.who), ['phase2', 'optimiser']);
    const merged = w.m.readJson(`downloads/${calls[0].queue}`);
    assert.strictEqual(merged.phase1Stats.reed.screeningHalted, true);
    assert.strictEqual(merged.phase1Stats.reed.errors, 1);
    assert.strictEqual(merged.candidates.length, 1, 'only the Caterer candidate proceeds');
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop', '--force'], { env: w.m.env(w.env) }); w.m.cleanup(); }
});

test('Turnstile block through the whole chain: human-login alert once, Reed flagged authFailed(turnstile_blocked), Phase 2 still runs once, next run does not retry the login', { skip: SKIP }, async () => {
  const w = await setup({ FAKE_LOGGED_IN: '0', FAKE_SITE_MODE: 'turnstile', REED_CAPTURE_TIMEOUT_MS: '1500' });
  try {
    w.m.write('secrets/reed-credentials.json', { email: 'reed.test.user@example.invalid', password: 'Pw-SENTINEL-1234' }, 0o600);
    let r = await w.run();
    assert.strictEqual(r.code, 0, r.stderr);
    let calls = w.m.readLines('calls.jsonl');
    assert.deepStrictEqual(calls.map((c) => c.who), ['phase2', 'optimiser']);
    const merged = w.m.readJson(`downloads/${calls[0].queue}`);
    assert.strictEqual(merged.phase1Stats.reed.authFailed, true);
    assert.strictEqual(merged.phase1Stats.reed.authFailureReason, 'turnstile_blocked');
    const alerts = () => w.m.readLines('outbox/alerts.jsonl').filter((a) => a.key === 'reed-human-login');
    assert.strictEqual(alerts().length, 1);
    assert.ok(alerts()[0].text.includes('node scripts/cdp-reed-full-login.js --human'));
    assert.strictEqual(withProfile(w.profile).length, 0, 'browser torn down even though Reed failed');
    // second run on a fresh status: no new alert, no login attempt
    w.m.write('runs/phase1-2026-09-29-111111.json', { status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 20 });
    r = await w.m.run('run-pipeline.js', ['--status-file', w.m.p('runs', 'phase1-2026-09-29-111111.json')], { env: { ...w.env }, timeoutMs: 120000 });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(alerts().length, 1, 'no alert storm');
    assert.ok(!(r.stdout + r.stderr).includes('Pw-SENTINEL-1234'));
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop', '--force'], { env: w.m.env(w.env) }); w.m.cleanup(); }
});
