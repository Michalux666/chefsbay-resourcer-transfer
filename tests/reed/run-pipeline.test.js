'use strict';

// run-pipeline orchestration with fake phases: Reed gating (RESOURCER_SOURCES), merge, Phase 2 exactly once, run-lock, exit codes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { makeMirror } = require('./helpers/mirror');

const { FAKE_REED, FAKE_PAQ, FAKE_OPT } = require('./helpers/fake-phases');

function setup(statusOver, opts = {}) {
  const m = makeMirror();
  m.write('scripts/process-approved-queue.js', FAKE_PAQ);
  m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
  if (!opts.realReed) m.write('scripts/reed-phase1.js', FAKE_REED);
  m.write('downloads/approved-queue-2026-09-29-101010.json', {
    searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 15, activeWithin: 'month', sources: 'both', screeningModel: 'unknown',
    candidateCount: 10, phase1Stats: { pool: 10, approved: 1 }, candidates: [{ id: 'c1' }],
  });
  const status = { status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 15, pool: 10, approved: 1, errors: 0, credits: '1234', ...(statusOver || {}) };
  const statusFile = m.write('runs/phase1-2026-09-29-101010.json', status);
  const calls = () => m.readLines('calls.jsonl');
  return { m, statusFile, calls, run: (env, args) => m.run('run-pipeline.js', args || ['--status-file', statusFile], { env }) };
}
const kv = (out) => Object.fromEntries(out.split('\n').filter((l) => /^[A-Z_]+: /.test(l)).map((l) => [l.split(': ')[0], l.slice(l.indexOf(': ') + 2)]));

test('both + RESOURCER_SOURCES=both: Reed -> merge -> Phase 2 once -> optimiser, status marked done, exit 0, stdout markers kept', async () => {
  const { m, statusFile, calls, run } = setup();
  try {
    const r = await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(r.code, 0, r.stderr);
    const c = calls();
    assert.deepStrictEqual(c.map((x) => x.who), ['reed', 'phase2', 'optimiser']);
    assert.deepStrictEqual(c[0].argv, ['--job-title', 'Chef', '--location', 'LS1', '--distance', '15', '--active-within', 'month', '--cv-limit', '20', '--caterer-queue', m.p('downloads', 'approved-queue-2026-09-29-101010.json')]);
    assert.strictEqual(c[0].holder, String(c[0].ppid), 'the Reed step inherits the browser-lock hand-off pid');
    assert.match(c[1].queue, /^merged-queue-.+\.json$/);
    const merged = m.readJson(`downloads/${c[1].queue}`);
    assert.strictEqual(merged.sources, 'both');
    assert.strictEqual(merged.candidates.length, 3);
    assert.strictEqual(merged.candidateCount, 50);
    assert.deepStrictEqual(Object.keys(merged.phase1Stats), ['caterer', 'reed']);
    assert.strictEqual(merged.screeningModel, 'fake/model-1', 'a real model name beats unknown');
    assert.strictEqual(merged.distance, 15);
    assert.strictEqual(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
    const o = kv(r.stdout);
    assert.strictEqual(r.stdout.split('\n')[0], 'PIPELINE_COMPLETE');
    assert.strictEqual(o.SOURCES, 'both');
    assert.strictEqual(o.QUEUE_FILE, m.p('downloads', c[1].queue));
    assert.match(o.RESULTS_FILE, /phase2-results-fake\.json$/);
    assert.strictEqual(o.CREDITS, '1234');
    assert.strictEqual(o.VERDICT, 'NOMINAL');
    assert.strictEqual(fs.existsSync(`${statusFile}.run-lock`), false, 'run-lock released');
    assert.strictEqual(m.exists('runtime/browser.lock'), false, 'browser lock released');
    assert.ok(/[reed] /.test(r.stderr), 'child output is echoed to stderr for the logs');
  } finally { m.cleanup(); }
});

test('RESOURCER_SOURCES gate: default (unset) and caterer skip Reed and run Phase 2 once on the Caterer queue; invalid values fall back to caterer', async () => {
  for (const value of [undefined, 'caterer', 'nonsense']) {
    const { m, statusFile, calls, run } = setup();
    try {
      const r = await run(value === undefined ? {} : { RESOURCER_SOURCES: value });
      assert.strictEqual(r.code, 0, r.stderr);
      assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser'], `value=${value}`);
      assert.strictEqual(calls()[0].queue, 'approved-queue-2026-09-29-101010.json');
      assert.match(r.stderr, /REED_DISABLED: RESOURCER_SOURCES=/);
      assert.strictEqual(m.readJson('runtime/reed-status.json').state, 'disabled');
      if (value === 'nonsense') assert.match(r.stderr, /WARN: RESOURCER_SOURCES='nonsense'/);
      assert.strictEqual(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
      assert.strictEqual(m.exists('runtime/browser.lock'), false);
      assert.ok(!fs.readdirSync(m.p('downloads')).some((f) => f.startsWith('reed-empty-') || f.startsWith('merged-queue-')), 'no placeholder, no merge when Reed is disabled by config');
      assert.strictEqual(kv(r.stdout).QUEUE_FILE, m.p('downloads', 'approved-queue-2026-09-29-101010.json'));
    } finally { m.cleanup(); }
  }
});

test('RESOURCER_SOURCES=reed also enables the Reed step', async () => {
  const { m, calls, run } = setup();
  try {
    await run({ RESOURCER_SOURCES: 'reed' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['reed', 'phase2', 'optimiser']);
  } finally { m.cleanup(); }
});

test('single-source or already-done runs run nothing: results are located for the optimiser only', async () => {
  for (const over of [{ sources: 'caterer', phase2Status: 'done' }, { sources: 'both', phase2Status: 'done' }, { sources: 'caterer', phase2Status: undefined }]) {
    const { m, calls, run } = setup(over);
    try {
      m.write('downloads/phase2-results-old.json', { sources: 'caterer' });
      const r = await run({ RESOURCER_SOURCES: 'both' });
      assert.strictEqual(r.code, 0, r.stderr);
      assert.deepStrictEqual(calls().map((x) => x.who), ['optimiser'], JSON.stringify(over));
      assert.match(kv(r.stdout).RESULTS_FILE, /phase2-results-old\.json$/);
    } finally { m.cleanup(); }
  }
});

test('Reed auth failure (marker) still merges a placeholder carrying authFailed + reason and runs Phase 2 once', async () => {
  const { m, calls, run } = setup();
  try {
    const r = await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'auth-marker' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(calls().map((x) => x.who), ['reed', 'phase2', 'optimiser']);
    const merged = m.readJson(`downloads/${calls()[1].queue}`);
    assert.strictEqual(merged.sources, 'both');
    assert.strictEqual(merged.phase1Stats.reed.authFailed, true);
    assert.strictEqual(merged.phase1Stats.reed.authFailureReason, 'turnstile_blocked');
    assert.ok(merged.phase1Stats.reed.authFailedAt);
    assert.strictEqual(merged.candidates.length, 1);
    assert.match(r.stderr, /Reed AUTH FAILED - reason=turnstile_blocked/);
    assert.match(r.stderr, /Reed Phase 1 FAILED - diagnostic output/);
  } finally { m.cleanup(); }
});

test('auth signatures in the output of a failed Reed run are recognised without a marker; unrelated failures are not flagged as auth', async () => {
  let { m, calls, run } = setup();
  try {
    await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'auth-output' });
    let merged = m.readJson(`downloads/${calls()[1].queue}`);
    assert.strictEqual(merged.phase1Stats.reed.authFailed, true);
    assert.strictEqual(merged.phase1Stats.reed.authFailureReason, 'reed_401_or_relogin');
  } finally { m.cleanup(); }
  ({ m, calls, run } = setup());
  try {
    const r = await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'boom' });
    const merged = m.readJson(`downloads/${calls()[1].queue}`);
    assert.strictEqual(merged.phase1Stats.reed.authFailed, false);
    assert.match(r.stderr, /WARNING: Reed produced no queue/);
  } finally { m.cleanup(); }
});

test('a Reed run that prints no queue (pool 0) is merged as an empty placeholder without an auth flag', async () => {
  const { m, calls, run } = setup();
  try {
    await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'quiet' });
    const merged = m.readJson(`downloads/${calls()[1].queue}`);
    assert.strictEqual(merged.sources, 'both');
    assert.strictEqual(merged.phase1Stats.reed.authFailed, false);
    assert.strictEqual(merged.phase1Stats.reed.authFailureReason, null);
  } finally { m.cleanup(); }
});

test('the Reed queue path comes from the summary line, with the legacy file-name regex as fallback', async () => {
  for (const mode of ['ok', 'regex-path']) {
    const { m, calls, run } = setup();
    try {
      await run({ RESOURCER_SOURCES: 'both', FAKE_REED_MODE: mode });
      const merged = m.readJson(`downloads/${calls()[1].queue}`);
      assert.strictEqual(merged.candidates.length, 3, mode);
      assert.strictEqual(merged.phase1Stats.reed.pool, 40);
    } finally { m.cleanup(); }
  }
});

test('Phase 2 failure keeps the legacy exit 0 and still marks the status done', async () => {
  const { m, run } = setup();
  try {
    const r = await run({ RESOURCER_SOURCES: 'both', FAKE_PAQ_EXIT: '1' });
    assert.strictEqual(r.code, 0);
    assert.match(r.stderr, /Phase 2 exit: 1/);
    assert.strictEqual(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
  } finally { m.cleanup(); }
});

test('optimiser regressions are printed (ASCII) after ATTENTION/DEGRADED verdicts', async () => {
  const { m, run } = setup();
  try {
    const r = await run({ RESOURCER_SOURCES: 'both', FAKE_VERDICT: 'DEGRADED' });
    assert.match(r.stdout, /^WARNING: PERFORMANCE DEGRADED$/m);
    assert.match(r.stdout, /^ {2}m: 1 vs baseline 2 \(-50%\)$/m);
    assert.ok(!/[^\x00-\x7f]/.test(r.stdout), 'stdout is ASCII');
  } finally { m.cleanup(); }
});

test('per-status-file run-lock: a live holder makes a second invocation a no-op (PIPELINE_SKIPPED, exit 0), stale/dead/old holders are taken over', async () => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    let { m, statusFile, calls, run } = setup();
    fs.writeFileSync(`${statusFile}.run-lock`, JSON.stringify({ pid: holder.pid, startedAt: Date.now(), statusFile }));
    let r = await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^PIPELINE_SKIPPED: parallel run in progress/m);
    assert.deepStrictEqual(calls(), []);
    assert.ok(fs.existsSync(`${statusFile}.run-lock`), 'the holder lock is left alone');
    // holder alive but older than 60 minutes -> taken over
    fs.writeFileSync(`${statusFile}.run-lock`, JSON.stringify({ pid: holder.pid, startedAt: Date.now() - 61 * 60000, statusFile }));
    r = await run({ RESOURCER_SOURCES: 'both' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['reed', 'phase2', 'optimiser']);
    assert.match(r.stderr, /Stale run-lock/);
    m.cleanup();
    // dead pid and unreadable lock -> taken over
    ({ m, statusFile, calls, run } = setup());
    fs.writeFileSync(`${statusFile}.run-lock`, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '0']).pid, startedAt: Date.now(), statusFile }));
    await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(calls().length, 3);
    fs.writeFileSync(`${statusFile}.run-lock`, '{garbage');
    await run({ RESOURCER_SOURCES: 'both', FAKE_PAQ_EXIT: '0' });
    m.cleanup();
  } finally { holder.kill(); }
});

test('a second invocation after completion does not re-run Reed or Phase 2 (phase2Status done)', async () => {
  const { m, calls, run } = setup();
  try {
    await run({ RESOURCER_SOURCES: 'both' });
    await run({ RESOURCER_SOURCES: 'both' });
    assert.deepStrictEqual(calls().map((x) => x.who), ['reed', 'phase2', 'optimiser', 'optimiser']);
  } finally { m.cleanup(); }
});

test('a live Caterer browser lock: Reed is skipped after the wait with reason browser_lock_busy, Phase 2 still runs once', async () => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const { m, calls, run } = setup();
  try {
    m.write('runtime/browser.lock', { owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() });
    const r = await run({ RESOURCER_SOURCES: 'both', REED_LOCK_WAIT_SEC: '0' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(calls().map((x) => x.who), ['phase2', 'optimiser']);
    const merged = m.readJson(`downloads/${calls()[0].queue}`);
    assert.strictEqual(merged.phase1Stats.reed.authFailed, true);
    assert.strictEqual(merged.phase1Stats.reed.authFailureReason, 'browser_lock_busy');
    assert.ok(m.exists('runtime/browser.lock'), 'foreign lock untouched');
  } finally { holder.kill(); m.cleanup(); }
});

test('a lock held by the caller (phase1 hand-off) is borrowed, not replaced and not released', async () => {
  const { m, calls, run } = setup();
  try {
    // the test process is the "phase1" that holds the lock and spawns run-pipeline
    m.write('runtime/browser.lock', { owner: 'caterer', pid: process.pid, startedAt: new Date().toISOString() });
    const r = await run({ RESOURCER_SOURCES: 'both' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(calls()[0].who, 'reed', 'hand-off from an ancestor is allowed');
    assert.strictEqual(m.readJson('runtime/browser.lock').pid, process.pid);
    assert.strictEqual(calls()[0].holder, String(process.pid));
  } finally { m.cleanup(); }
});

test('exit codes: no status file -> 1; unparseable status -> 1 and the lock is released; --help -> 0; newest status is used when no flag', async () => {
  const { m, statusFile, run, calls } = setup();
  try {
    let r = await run({}, ['--status-file', m.p('runs', 'missing.json')]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /FATAL: No phase1 status file found/);
    fs.writeFileSync(statusFile, '{not json');
    r = await run({});
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /FATAL: Could not parse status file/);
    assert.strictEqual(fs.existsSync(`${statusFile}.run-lock`), false);
    r = await run({}, ['--help']);
    assert.strictEqual(r.code, 0);
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'phase1_complete', sources: 'caterer' }));
    r = await run({}, []);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(calls(), []);
  } finally { m.cleanup(); }
});

test('no queue file: Phase 2 is skipped but the run still completes and marks the status done', async () => {
  const { m, calls, run } = setup({ jobTitle: 'Chef' });
  try {
    fs.unlinkSync(m.p('downloads', 'approved-queue-2026-09-29-101010.json'));
    const r = await run({ RESOURCER_SOURCES: 'caterer' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /No queue file - Phase 2 skipped/);
    assert.deepStrictEqual(calls().map((x) => x.who), []);
  } finally { m.cleanup(); }
});
