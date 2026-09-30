'use strict';
// The interfaces phase 1 depends on, checked against the real repo files (run-lock, constants, pipeline-halt, notify).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;
const REAL = { real: ['run-lock', 'pipeline-halt'] };
const okScenario = { pages: { 1: { cards: [card(1)] }, 2: { cards: [] } }, db: { candidates: { 1: { unlocked: 1 } } } };

function writeRun(home, name, status, ageMs) {
  const at = new Date(Date.now() - (ageMs || 0)).toISOString();
  fs.writeFileSync(path.join(home, 'runs', name), JSON.stringify({ id: name.replace('.json', ''), status, jobTitle: 'Chef', location: 'B1', distance: 20, startedAt: at, updatedAt: at, sources: 'caterer' }));
}

async function run(t, scenario, args, extra) {
  const home = h.makeHome(scenario, Object.assign({}, REAL, extra || {}));
  t.after(() => h.cleanup(home));
  return { home, prepare: (fn) => fn(home), go: (o) => h.runPhase1(home, args || h.baseArgs(), o) };
}

test('real run-lock: no other run, exit 0', async (t) => {
  const x = await run(t, okScenario);
  const r = await x.go();
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('Global pipeline lock: clear'));
});

test('real run-lock: a fresh phase1_running file of another run blocks with exit 3 and shows the lock JSON', async (t) => {
  const x = await run(t, okScenario);
  writeRun(x.home, 'phase1-2026-09-29-090000.json', 'phase1_running', 60 * 1000);
  const r = await x.go();
  assert.strictEqual(r.code, 3);
  assert.ok(r.stdout.includes('PIPELINE_BLOCKED: Another pipeline is already active.'));
  assert.ok(r.stdout.includes('"blocked": true') && r.stdout.includes('phase1_running'));
  assert.deepStrictEqual(h.listRuns(x.home), ['phase1-2026-09-29-090000.json'], 'no status file of our own');
});

test('real run-lock: a stale phase1_running file (older than its 60 minute limit) does not block', async (t) => {
  const x = await run(t, okScenario);
  writeRun(x.home, 'phase1-2026-09-29-090000.json', 'phase1_running', 90 * 60 * 1000);
  const r = await x.go();
  assert.strictEqual(r.code, 0, r.stdout);
});

test('own bridge passed via --init-status-file: skipped by the flip and by the lock, then deleted', async (t) => {
  const x = await run(t, okScenario);
  writeRun(x.home, 'phase1-2026-09-29-2100.json', 'phase1_initializing', 5000);
  const own = path.join(x.home, 'runs', 'phase1-2026-09-29-2100.json');
  const r = await h.runPhase1(x.home, h.baseArgs(['--init-status-file', own]));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(!fs.existsSync(own));
  assert.ok(h.statusOf(x.home));
});

test('a stale foreign init bridge is flipped without refreshing updatedAt, so it no longer blocks the run that cleared it', async (t) => {
  const x = await run(t, okScenario);
  writeRun(x.home, 'phase1-2026-09-29-2050.json', 'phase1_initializing', 30 * 60 * 1000);
  const r = await x.go();
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('Bridge cleared: phase1-2026-09-29-2050.json -> phase1_taking_over'));
});

test('a fresh foreign init bridge still blocks for the remainder of its taking-over life (a live spawn is not trampled)', async (t) => {
  const x = await run(t, okScenario);
  writeRun(x.home, 'phase1-2026-09-29-2050.json', 'phase1_initializing', 2 * 60 * 1000);
  const r = await x.go();
  assert.strictEqual(r.code, 3, r.stdout);
});

test('real pipeline-halt and notify: 3 screening failures write the halt state, the error feed and the alerts', async (t) => {
  const x = await run(t, { pages: { 1: { cards: [card(11)] } }, ai: { batch: [{ outcome: 'api_down' }] } });
  const r = await x.go();
  assert.strictEqual(r.code, 0, r.stdout);
  const halt = h.readJson(path.join(x.home, 'runtime', 'pipeline-halt.json'));
  assert.deepStrictEqual(Object.keys(halt).sort(), ['blockedRuns', 'detail', 'halted', 'lastCheckedAt', 'reason', 'remedy', 'since']);
  assert.strictEqual(halt.halted, true);
  assert.strictEqual(halt.reason, 'AI screening unavailable');
  assert.strictEqual(halt.blockedRuns, 1);
  assert.ok(halt.detail.includes('Chef/LS29'));

  const errs = fs.readFileSync(path.join(x.home, 'logs', 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].context, 'pipeline_halted');
  assert.strictEqual(errs[0].severity, 'critical');

  const alerts = fs.readFileSync(path.join(x.home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(alerts.map((a) => [a.severity, a.key]).sort(), [['critical', 'pipeline-halt'], ['warn', 'phase1-screening-down']].sort());
  for (const a of alerts) assert.ok(a.ts && a.text);
});

test('a second halt for the same reason is idempotent in the real module (no second error entry)', async (t) => {
  const x = await run(t, { pages: { 1: { cards: [card(21)] } }, ai: { batch: [{ outcome: 'api_down' }] } });
  await x.go();
  // Phase 2 would mark the first run complete; until then its phase1_complete file holds the global lock
  for (const f of h.listRuns(x.home)) fs.writeFileSync(path.join(x.home, 'runs', f), JSON.stringify({ id: f, status: 'complete' }));
  fs.writeFileSync(path.join(x.home, '_state', 'ai.json'), JSON.stringify({ batch: 0, single: 0 }));
  const second = await x.go();
  assert.strictEqual(second.code, 0, second.stdout);
  const errs = fs.readFileSync(path.join(x.home, 'logs', 'errors.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(h.readJson(path.join(x.home, 'runtime', 'pipeline-halt.json')).blockedRuns, 2);
});
