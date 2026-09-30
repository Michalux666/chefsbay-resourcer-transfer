'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./harness');

const { card } = h;
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);

async function run(t, scenario, args, opts) {
  const home = h.makeHome(scenario, opts);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(args), opts);
  return { home, r, out: r.stdout, calls: r.calls, status: h.statusOf(home), queue: h.queueOf(home) };
}

const onePage = { pages: { 1: { cards: [card(1)] }, 2: { cards: [] } } };

// ------------------------------------------------------------------ SOURCES=both

test('sources=both with approvals: session saved twice, status phase2Status=pending, run-pipeline gets the owned status file, process-approved-queue is not run', async (t) => {
  const { r, out, calls, status, home } = await run(t, onePage, ['--sources', 'both']);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('PHASE2_DEFERRED: true'));
  assert.ok(out.includes('Session saved (post-Phase1)') && out.includes('Session saved (pre-Reed handoff)'));
  assert.ok(out.includes('Calling run-pipeline.js to continue Reed Phase 1 + Phase 2...'));
  assert.ok(out.includes('run-pipeline.js exited with code: 0'));
  assert.ok(!out.includes('PHASE2_DONE'));
  assert.strictEqual(callsOf(calls, 'process-approved-queue').length, 0);
  const rp = callsOf(calls, 'run-pipeline');
  assert.strictEqual(rp.length, 1);
  assert.deepStrictEqual(rp[0].args, ['--status-file', path.join(home, 'runs', `${status.id}.json`)]);
  assert.strictEqual(rp[0].status.phase2Status, 'pending', 'the status file is rewritten before the hand-off');
  assert.strictEqual(rp[0].status.status, 'phase1_complete');
  assert.strictEqual(rp[0].status.sources, 'both');
  assert.strictEqual(rp[0].status.page, 0, 'legacy quirk: the deferred rewrite carries page 0');
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'state save').length, 2);
  assert.ok(out.indexOf('QUEUE_FILE:') < out.indexOf('Calling run-pipeline.js'));
});

test('sources=both with zero approved candidates falls through to run-pipeline (no inline Phase 2)', async (t) => {
  const { r, out, calls, queue } = await run(t, { pages: { 1: { cards: [], text: '0 candidates' } } }, ['--sources', 'both']);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('No Caterer candidates - will check Reed next.'));
  assert.ok(out.includes('PHASE2_DEFERRED: true'));
  assert.ok(out.includes('PROGRESS_MESSAGE: Phase 1 complete - 0 candidates queued'));
  assert.strictEqual((out.match(/QUEUE_FILE: /g) || []).length, 2, 'printed before and after, as the legacy script did');
  assert.strictEqual(callsOf(calls, 'run-pipeline').length, 1);
  assert.strictEqual(callsOf(calls, 'process-approved-queue').length, 0);
  assert.strictEqual(queue.sources, 'both');
  assert.strictEqual(queue.candidates.length, 0);
});

test('the exit code of run-pipeline is passed through unchanged', async (t) => {
  const a = await run(t, Object.assign({ pipeline: { exit: 5 } }, onePage), ['--sources', 'both']);
  assert.strictEqual(a.r.code, 5);
  assert.ok(a.out.includes('run-pipeline.js exited with code: 5'));
  const b = await run(t, Object.assign({ pipeline: { exit: 2 } }, onePage), ['--sources', 'both']);
  assert.strictEqual(b.r.code, 2);
});

test('a hung run-pipeline is killed at the hand-off timeout and the run exits 1', async (t) => {
  const { r, out } = await run(t, Object.assign({ pipeline: { hang: true } }, onePage), ['--sources', 'both'], { env: { PHASE1_HANDOFF_TIMEOUT_SEC: '1', P1_HANG_MS: '30000' }, timeoutMs: 60000 });
  assert.strictEqual(r.code, 1);
  assert.ok(out.includes('run-pipeline.js exited with code: timeout'));
});

test('sources=reed is treated like a single-source run by the hand-off (legacy behaviour)', async (t) => {
  const { r, calls } = await run(t, onePage, ['--sources', 'reed']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(callsOf(calls, 'run-pipeline').length, 0);
  assert.strictEqual(callsOf(calls, 'process-approved-queue').length, 1);
});

// ------------------------------------------------------------------ caterer-only hand-off

test('caterer-only: Phase 2 runs inline and its exit code never fails the run (legacy), a hang does', async (t) => {
  const a = await run(t, Object.assign({ pap: { exit: 9 } }, onePage));
  assert.strictEqual(a.r.code, 0);
  assert.ok(a.out.includes('WARN process-approved-queue.js did not finish cleanly (9)'));
  assert.ok(a.out.includes('PHASE2_DONE: true'));
  const b = await run(t, Object.assign({ pap: { hang: true } }, onePage), undefined, { env: { PHASE1_HANDOFF_TIMEOUT_SEC: '1', P1_HANG_MS: '30000' }, timeoutMs: 60000 });
  assert.strictEqual(b.r.code, 1);
  assert.ok(b.out.includes('did not finish cleanly (timeout)'));
});

test('process-approved-queue output is streamed to the run log by the parent', async (t) => {
  const { out } = await run(t, onePage);
  assert.ok(out.includes('[process-approved-queue] fake run'));
});

// ------------------------------------------------------------------ recovery and crashes

test('checkpoint recovery: a queue file with this run\'s timestamp is reloaded and merged into the final queue', async (t) => {
  const ts = '2026-09-29-101500';
  const home = h.makeHome({ pages: { 1: { cards: [card(701)] }, 2: { cards: [] } } });
  t.after(() => h.cleanup(home));
  const recovered = [
    { id: '9001', name: 'Rec One', firstName: 'Rec', lastName: 'One', email: 'r1@example.invalid', phone: '', currentTitle: 'Chef', currentEmployer: '', city: 'Leeds', postcode: 'LS1 1AA', state: 'West Yorkshire', experience: 3, encId: 'e', auditId: 'a', cvUrl: '/cv' },
    { id: '9002', name: 'Rec Two', firstName: 'Rec', lastName: 'Two', email: 'r2@example.invalid', phone: '', currentTitle: 'Cook', currentEmployer: '', city: 'Leeds', postcode: 'LS1 1AA', state: 'West Yorkshire', experience: 2, encId: 'e2', auditId: 'a2', cvUrl: '/cv2' },
  ];
  fs.writeFileSync(path.join(home, 'downloads', `approved-queue-${ts}.json`), JSON.stringify({ searchDate: null, jobTitle: 'Chef', location: 'LS29', source: 'caterer', candidates: recovered }));
  const r = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_RUN_TIMESTAMP: ts } });
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('[RECOVERY] Loaded 2 previously-approved candidates from checkpoint'));
  const q = h.readJson(path.join(home, 'downloads', `approved-queue-${ts}.json`));
  assert.deepStrictEqual(q.candidates.map((c) => c.id), ['9001', '9002', '701']);
  assert.ok(r.stdout.includes('QUEUED (3 total)'));
  assert.strictEqual(q.phase1Stats.approved, 3);
  assert.strictEqual(h.readJson(path.join(home, 'runs', `phase1-${ts}.json`)).id, `phase1-${ts}`, 'the status file uses the timestamp given');
});

test('an unreadable checkpoint starts fresh instead of failing', async (t) => {
  const ts = '2026-09-29-101501';
  const home = h.makeHome({ pages: { 1: { cards: [], text: '0 candidates' } } });
  t.after(() => h.cleanup(home));
  fs.writeFileSync(path.join(home, 'downloads', `approved-queue-${ts}.json`), '{not json');
  const r = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_RUN_TIMESTAMP: ts } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('[RECOVERY] Could not parse existing queue file - starting fresh:'));
});

test('crash simulation: kill the process after the page-1 checkpoint, rerun with the same timestamp, nothing approved is lost', async (t) => {
  const ts = '2026-09-29-101502';
  const sc = {
    pages: { 1: { cards: [card(801), card(802)] }, 2: { cards: [card(803)] } },
    ai: { batch: [{ outcome: 'ok' }, { outcome: 'hang' }] },
  };
  const home = h.makeHome(sc);
  t.after(() => h.cleanup(home));
  const env = Object.assign({}, process.env, {
    P1_SCENARIO: path.join(home, 'scenario.json'), P1_STATE_DIR: path.join(home, '_state'), P1_FAKE_AB: path.join(home, '_fakes', 'agent-browser.js'), P1_HOME: home,
    HERMES_HOME: path.join(home, '_hermes'), RESOURCER_ENV_FILE: path.join(home, '_none.env'), PHASE1_SETTLE_MS: '10', PHASE1_UNLOCK_PAUSE_MS: '0',
    P1_SHIM_TIMEOUT_MS: '1500', P1_HANG_MS: '20000', PHASE1_RUN_TIMESTAMP: ts,
  });
  delete env.RESOURCER_HOME;
  const child = spawn(process.execPath, [path.join(home, 'scripts', 'phase1.js')].concat(h.baseArgs()), { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out1 = '';
  child.stdout.on('data', (d) => { out1 += d; });
  const queueFile = path.join(home, 'downloads', `approved-queue-${ts}.json`);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const deadline = Date.now() + 40000;
  let sawSecondBatch = false;
  while (Date.now() < deadline && !sawSecondBatch) {
    await new Promise((res) => setTimeout(res, 100));
    sawSecondBatch = out1.includes('HEARTBEAT: AI batch start page 2');
  }
  assert.ok(sawSecondBatch, `never reached page 2:\n${out1}`);
  assert.ok(fs.existsSync(queueFile), 'checkpoint exists before the crash');
  child.kill('SIGKILL');
  await closed;
  assert.strictEqual(h.readJson(path.join(home, 'runs', `phase1-${ts}.json`)).status, 'phase1_running', 'a killed process leaves the running status behind (lock ages out or cull-ghost handles it)');
  assert.strictEqual(h.readJson(queueFile).candidates.length, 2);

  // rerun: page 1 candidates are in the DB now (unlocked), page 2 is screened normally
  const sc2 = JSON.parse(fs.readFileSync(path.join(home, 'scenario.json'), 'utf8'));
  sc2.ai = { batch: [{ outcome: 'ok' }] };
  fs.writeFileSync(path.join(home, 'scenario.json'), JSON.stringify(sc2));
  fs.writeFileSync(path.join(home, '_state', 'ai.json'), JSON.stringify({ batch: 0, single: 0 }));
  const r2 = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_RUN_TIMESTAMP: ts } });
  assert.strictEqual(r2.code, 0, r2.stdout);
  assert.ok(r2.stdout.includes('[RECOVERY] Loaded 2 previously-approved candidates from checkpoint'));
  const q = h.readJson(queueFile);
  assert.deepStrictEqual(q.candidates.map((c) => c.id).sort(), ['801', '802', '803']);
  assert.strictEqual(h.readJson(path.join(home, 'runs', `phase1-${ts}.json`)).status, 'phase1_complete');
});

test('SIGTERM: children are killed, the screening input file is removed and the running status becomes phase1_abandoned', { skip: process.platform === 'win32' ? 'signal handlers cannot be exercised through Windows termination' : false }, async (t) => {
  const sc = { pages: { 1: { cards: [card(901)] } }, ai: { batch: [{ outcome: 'hang' }] } };
  const home = h.makeHome(sc);
  t.after(() => h.cleanup(home));
  const env = Object.assign({}, process.env, {
    P1_SCENARIO: path.join(home, 'scenario.json'), P1_STATE_DIR: path.join(home, '_state'), P1_FAKE_AB: path.join(home, '_fakes', 'agent-browser.js'), P1_HOME: home,
    HERMES_HOME: path.join(home, '_hermes'), RESOURCER_ENV_FILE: path.join(home, '_none.env'), PHASE1_SETTLE_MS: '10', P1_HANG_MS: '20000', SCREEN_INPUT_MODE: 'file', P1_NO_CONSUME: '1',
  });
  delete env.RESOURCER_HOME;
  const child = spawn(process.execPath, [path.join(home, 'scripts', 'phase1.js')].concat(h.baseArgs()), { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !out.includes('HEARTBEAT: AI batch start page 1')) await new Promise((res) => setTimeout(res, 100));
  assert.ok(out.includes('HEARTBEAT: AI batch start page 1'), out);
  const dir = path.join(home, 'runtime', 'screening-input');
  assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length === 1, 'input file present during the batch');
  child.kill('SIGTERM');
  const res = await closed;
  assert.strictEqual(res.code, 143);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(h.statusOf(home).status, 'phase1_abandoned');
});

test('a queue file that cannot be written is a FATAL exit 1 with the reason logged, not a hang or a silent success', async (t) => {
  const ts = '2026-09-29-101503';
  const home = h.makeHome({ pages: { 1: { cards: [card(1)] }, 2: { cards: [] } }, db: { candidates: { 1: { unlocked: 1 } } } });
  t.after(() => h.cleanup(home));
  fs.mkdirSync(path.join(home, 'downloads', `approved-queue-${ts}.json`));
  const r = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_RUN_TIMESTAMP: ts } });
  assert.strictEqual(r.code, 1);
  assert.ok(r.stdout.includes('FATAL'));
  assert.ok(r.stdout.includes('[RECOVERY] Could not parse existing queue file - starting fresh:'));
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);
});

// ------------------------------------------------------------------ hygiene

test('the run never prints the gateway key or any candidate secret, even when a child echoes it', async (t) => {
  const { out, r, home } = await run(t, { pages: { 1: { cards: [card(991)] }, 2: { cards: [] } } });
  assert.ok(!out.includes(h.SECRET) && !r.stderr.includes(h.SECRET));
  assert.ok(!out.includes('TOKEN-991'));
  for (const f of fs.readdirSync(path.join(home, 'runs'))) assert.ok(!fs.readFileSync(path.join(home, 'runs', f), 'utf8').includes(h.SECRET));
});

test('the process exits on its own promptly after finishing (no stray handles)', async (t) => {
  const started = Date.now();
  const { r } = await run(t, { pages: { 1: { cards: [], text: '0 candidates' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(Date.now() - started < 30000);
});

// ------------------------------------------------------------------ Update C, finding F9: a HELD Phase 2 is neither done nor failed

test('caterer-only: Phase 2 exit 2 (HELD by CV screening) ends the run with exit 14, not as a success; it is not announced as done; any other non-zero exit still never fails the run', async (t) => {
  const held = await run(t, Object.assign({ pap: { exit: 2 } }, onePage));
  assert.strictEqual(held.r.code, 14, held.out);
  assert.ok(held.out.includes('PHASE2_HELD: CV screening could not run'));
  assert.ok(!held.out.includes('PHASE2_DONE'));
  assert.ok(!held.out.includes('did not finish cleanly'), 'a hold is not a warning about a crash');
  assert.ok(held.out.includes('CREDITS:'));
  for (const code of [1, 3, 9]) {
    const other = await run(t, Object.assign({ pap: { exit: code } }, onePage));
    assert.strictEqual(other.r.code, 0, `Phase 2 exit ${code}: legacy, never fails the run`);
    assert.ok(other.out.includes('PHASE2_DONE: true'));
  }
});

test('sources=both: run-pipeline exit 14 (Phase 2 held) is passed through, and any other code as before', async (t) => {
  const held = await run(t, Object.assign({ pipeline: { exit: 14 } }, onePage), ['--sources', 'both']);
  assert.strictEqual(held.r.code, 14);
  assert.ok(held.out.includes('run-pipeline.js exited with code: 14'));
});
