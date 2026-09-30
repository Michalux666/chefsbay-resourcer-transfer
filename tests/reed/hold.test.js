'use strict';

// run-pipeline Reed hold: a pending human login (or a fresh auth failure) skips the Reed step cleanly, keeps the pending search's Reed
// retries, and still completes the Caterer half. Also runtime/reed-status.json following the RESOURCER_SOURCES gate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn } = require('child_process');
const { makeMirror } = require('./helpers/mirror');
const { FAKE_REED, FAKE_PAQ, FAKE_OPT } = require('./helpers/fake-phases');

const HOUR = 3600000;
const APPROVED = 'approved-queue-2026-09-29-101010.json';
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

function setup(statusOver) {
  const m = makeMirror();
  m.write('scripts/process-approved-queue.js', FAKE_PAQ);
  m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
  m.write('scripts/reed-phase1.js', FAKE_REED);
  m.write(`downloads/${APPROVED}`, {
    searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 15, activeWithin: 'month', sources: 'both', screeningModel: 'unknown',
    candidateCount: 10, phase1Stats: { pool: 10, approved: 1 }, candidates: [{ id: 'c1' }],
  });
  const status = { status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 15, pool: 10, approved: 1, errors: 0, credits: '1234', ...(statusOver || {}) };
  const statusFile = m.write('runs/phase1-2026-09-29-101010.json', status);
  const calls = () => m.readLines('calls.jsonl');
  return { m, statusFile, calls, run: (env, args) => m.run('run-pipeline.js', args || ['--status-file', statusFile], { env }) };
}
const kv = (out) => Object.fromEntries(out.split('\n').filter((l) => /^[A-Z_]+: /.test(l)).map((l) => [l.split(': ')[0], l.slice(l.indexOf(': ') + 2)]));
const noReedArtifacts = (m) => !fs.readdirSync(m.p('downloads')).some((f) => f.startsWith('reed-empty-') || f.startsWith('merged-queue-'));
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

test('hold: a recorded Turnstile block skips the Reed step; Phase 2 runs on the ORIGINAL Caterer queue; no placeholder, no auth-failed flag; marker, block and pending file untouched', async () => {
  const { m, calls, run } = setup();
  try {
    m.write('runtime/reed-login-block.json', { blockedAt: iso(HOUR), reason: 'turnstile_unsolved', attempts: 1 });
    m.write('runtime/reed-auth-failed.marker', { reason: 'turnstile_blocked', failedAt: iso(HOUR), jobTitle: 'Chef', location: 'LS1' });
    const pendingBody = { jobTitle: 'Chef', location: 'LS1', sources: 'both', reedAuthRetries: 1 };
    m.write('pending-searches/territory-9-20260929-1000.json', pendingBody);
    const r = await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser']);
    assert.strictEqual(calls()[0].queue, APPROVED);
    assert.match(r.stderr, /REED_HELD: human_login_pending \(a Turnstile block is recorded \(turnstile_unsolved\)\)/);
    assert.ok(noReedArtifacts(m), 'no Reed placeholder and no merged queue');
    assert.strictEqual(kv(r.stdout).QUEUE_FILE, m.p('downloads', APPROVED));
    assert.strictEqual(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
    assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'turnstile_blocked', 'the marker is not rewritten or removed by a hold');
    assert.ok(m.exists('runtime/reed-login-block.json'));
    assert.deepStrictEqual(m.readJson('pending-searches/territory-9-20260929-1000.json'), pendingBody, 'the pending search keeps its Reed retries');
    assert.strictEqual(m.exists('runtime/browser.lock'), false);
    assert.strictEqual(m.exists('runtime/reed-status.json'), false, 'a hold does not touch the status');
  } finally { m.cleanup(); }
});

test('hold windows by failure reason: people-needed reasons hold for the login-block window (12 h), other auth failures back off for 30 min, a lock conflict never holds', async () => {
  const cases = [
    ['turnstile_blocked', 11 * HOUR, true], ['turnstile_blocked', 13 * HOUR, false],
    ['reed_451_international', 2 * HOUR, true], ['reed_451_international', 13 * HOUR, false],
    ['auto_login_failed', 10 * 60000, true], ['auto_login_failed', 45 * 60000, false],
    ['post_login_verify_failed', 5 * 60000, true], ['reed_credentials_missing', 5 * 60000, true],
    ['browser_lock_busy', 30000, false],
  ];
  for (const [reason, ago, held] of cases) {
    const { m, calls, run } = setup();
    try {
      m.write('runtime/reed-auth-failed.marker', { reason, failedAt: iso(ago), jobTitle: 'Chef', location: 'LS1' });
      const r = await run({ RESOURCER_SOURCES: 'both' });
      assert.strictEqual(r.code, 0, r.stderr);
      const label = `${reason} ${Math.round(ago / 60000)} min ago`;
      assert.deepStrictEqual(calls().map((x) => x.who), held ? ['phase2', 'optimiser'] : ['reed', 'phase2', 'optimiser'], label);
      assert.strictEqual(/REED_HELD/.test(r.stderr), held, label);
      if (!held) assert.strictEqual(m.exists('runtime/reed-auth-failed.marker'), false, `${label}: the Reed step clears the stale marker before running`);
    } finally { m.cleanup(); }
  }
});

test('hold: an unreadable marker or one without failedAt is judged by its file time; REED_AUTH_HOLD_MIN=0 switches the short hold off', async () => {
  let { m, calls, run } = setup();
  try {
    m.write('runtime/reed-auth-failed.marker', '{garbage');
    const r = await run({ RESOURCER_SOURCES: 'both' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser']);
    assert.match(r.stderr, /REED_HELD: marker_unreadable/);
  } finally { m.cleanup(); }
  ({ m, calls, run } = setup());
  try {
    m.write('runtime/reed-auth-failed.marker', { reason: 'auto_login_failed' });
    await run({ RESOURCER_SOURCES: 'both' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser'], 'file time is fresh');
  } finally { m.cleanup(); }
  ({ m, calls, run } = setup());
  try {
    m.write('runtime/reed-auth-failed.marker', { reason: 'auto_login_failed', failedAt: iso(60000) });
    await run({ RESOURCER_SOURCES: 'both', REED_AUTH_HOLD_MIN: '0' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['reed', 'phase2', 'optimiser']);
  } finally { m.cleanup(); }
});

test('hold: a live human-login session (browser.lock purpose human-login) skips Reed at once instead of waiting out REED_LOCK_WAIT_SEC', async () => {
  const holder = sleeper();
  const { m, calls, run } = setup();
  try {
    m.write('runtime/browser.lock', { owner: 'reed', pid: holder.pid, startedAt: new Date().toISOString(), purpose: 'human-login' });
    const t0 = Date.now();
    const r = await run({ RESOURCER_SOURCES: 'both', REED_LOCK_WAIT_SEC: '120' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 20000, 'no lock wait');
    assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser']);
    assert.match(r.stderr, /REED_HELD: human_login_in_progress/);
    assert.ok(noReedArtifacts(m));
    assert.strictEqual(m.readJson('runtime/browser.lock').pid, holder.pid, 'the human session keeps its lock');
  } finally { holder.kill(); m.cleanup(); }
});

test('no hold for an ordinary Reed run that holds the lock: that is the browser_lock_busy path with its bounded retries', async () => {
  const holder = sleeper();
  const { m, calls, run } = setup();
  try {
    m.write('runtime/browser.lock', { owner: 'reed', pid: holder.pid, startedAt: new Date().toISOString(), purpose: 'reed-phase1' });
    const r = await run({ RESOURCER_SOURCES: 'both', REED_LOCK_WAIT_SEC: '0' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /REED_HELD/);
    assert.strictEqual(m.readJson(`downloads/${calls()[0].queue}`).phase1Stats.reed.authFailureReason, 'browser_lock_busy');
  } finally { holder.kill(); m.cleanup(); }
});

test('a REAL Reed failure during the run still records authFailed (bounded retries); the marker it leaves then holds the next runs', async () => {
  const { m, calls, run } = setup();
  try {
    await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'auth-marker' });
    assert.strictEqual(m.readJson(`downloads/${calls()[1].queue}`).phase1Stats.reed.authFailed, true);
    const marker = m.readJson('runtime/reed-auth-failed.marker');
    assert.strictEqual(marker.reason, 'turnstile_blocked');
    const second = setup();
    try {
      second.m.write('runtime/reed-auth-failed.marker', marker);
      await second.run({ RESOURCER_SOURCES: 'both' });
      assert.deepStrictEqual(second.calls().map((x) => x.who), ['phase2', 'optimiser']);
    } finally { second.m.cleanup(); }
  } finally { m.cleanup(); }
});

test('the gate writes {state:disabled, updatedAt, detail} on EVERY run-pipeline start, even a caterer-only run, and removes the flag when Reed is enabled again', async () => {
  const { m, run } = setup({ sources: 'caterer', phase2Status: 'done' });
  try {
    await run({ RESOURCER_SOURCES: 'caterer' });
    const st = m.readJson('runtime/reed-status.json');
    assert.deepStrictEqual(Object.keys(st).sort(), ['detail', 'state', 'updatedAt']);
    assert.strictEqual(st.state, 'disabled');
    assert.strictEqual(st.detail, 'RESOURCER_SOURCES=caterer');
    assert.strictEqual(new Date(st.updatedAt).toISOString(), st.updatedAt, 'ISO timestamp');
    await new Promise((r) => setTimeout(r, 30));
    await run({ RESOURCER_SOURCES: 'caterer' });
    assert.strictEqual(m.readJson('runtime/reed-status.json').updatedAt, st.updatedAt, 'an unchanged gate does not rewrite the file');
    await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(m.exists('runtime/reed-status.json'), false, 'a stale disabled flag does not survive enabling Reed');
  } finally { m.cleanup(); }
});
