'use strict';
// Phase 1 against the REAL browser wrapper (driving the fake agent-browser binary) and the REAL screening CLI
// (talking to the fake gateway on loopback). Everything else is still a fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { startFakeGateway } = require('../fake-gateway/server');

const { card } = h;
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);

const GATEWAY_ENV = (g) => ({
  SCREEN_GATEWAY_ORIGIN: g.origin,
  AI_GATEWAY_API_KEY: 'fake-test-key',
  SCREEN_ENGINE: 'llm',
  SCREEN_BACKOFF_BASE_MS: '5',
  SCREEN_CACHE_TTL_SEC: '0',
  SCREEN_RETRY_AFTER_CAP_MS: '50',
});

function browserEnv(home) {
  return { RESOURCER_AB_BIN: path.join(home, '_fakes', 'agent-browser.js'), RESOURCER_AB_NAV_GAP_MS: '0' };
}

test('real lib/browser: open, wait, eval, get url and state save through the fake binary; session file written and valid', async (t) => {
  const home = h.makeHome({ pages: { 1: { cards: [card(1)] }, 2: { cards: [], text: '0 candidates' } } }, { real: ['browser'] });
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(), { env: browserEnv(home) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('Session OK - credits: 62185'));
  assert.ok(r.stdout.includes('Cards on page 1 : 1'));
  assert.ok(r.stdout.includes('No cards - results exhausted'));
  assert.ok(r.stdout.includes('Session saved (post-Phase1)'));
  const cmds = callsOf(r.calls, 'agent-browser').map((c) => c.cmd);
  assert.deepStrictEqual(cmds.filter((c) => c === 'open').length, 2);
  assert.ok(cmds.includes('state save'));
  const saved = callsOf(r.calls, 'agent-browser').find((c) => c.cmd === 'state save');
  assert.ok(saved.file.includes('.tmp-'), 'the real wrapper saves to a temp name and renames');
  const sessionFile = path.join(home, 'state', 'caterer-session.json');
  assert.ok(fs.existsSync(sessionFile), 'session file at the shared location');
  assert.ok(Array.isArray(h.readJson(sessionFile).cookies));
});

test('real lib/browser: a browser on /login is detected through the real getUrl', async (t) => {
  const home = h.makeHome({ session: { cookieValid: true, browserOnLogin: true }, login: { heals: false }, pages: { 1: { cards: [] } } }, { real: ['browser'] });
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(), { env: browserEnv(home) });
  assert.strictEqual(r.code, 2, r.stdout);
  assert.ok(r.stdout.includes('SESSION_STALE: still on /login after auto re-login'));
});

for (const mode of ['stdin', 'file']) {
  test(`real ai-review + fake gateway (${mode} input): approve, reject and post-unlock review through the real CLI contract`, async (t) => {
    const g = await startFakeGateway();
    t.after(() => g.close());
    const sc = {
      pages: {
        1: { cards: [card(11, { snippet: '1. Alex Sample Sous Chef | Ilkley, LS29 8AB Unlock candidate Never unlocked Recent experience Other CV snippets Sous Chef Jan 2021 - Current Test Kitchen Ltd Key Responsibilities cooking [[APPROVE]]' }),
          card(12, { snippet: '2. Sam Other Retail Cashier | Ilkley, LS29 8AB Unlock candidate Never unlocked Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Shop Ltd [[REJECT]]' })] },
        2: { cards: [] },
      },
    };
    const home = h.makeHome(sc, { real: ['ai-review', 'browser'] });
    t.after(() => h.cleanup(home));
    const r = await h.runPhase1(home, h.baseArgs(), { env: Object.assign({ SCREEN_INPUT_MODE: mode }, GATEWAY_ENV(g), browserEnv(home)), timeoutMs: 120000 });
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('    APPROVED pre-unlock'), r.stdout);
    assert.ok(/REJECTED pre-unlock: .+/.test(r.stdout), r.stdout);
    const q = h.queueOf(home);
    assert.deepStrictEqual(q.candidates.map((c) => c.id), ['11']);
    assert.notStrictEqual(q.screeningModel, 'unknown');
    assert.ok(q.screeningModel.length > 0);
    const dbCalls = callsOf(r.calls, 'candidates-db').map((c) => [c.cmd].concat(c.args).join(' '));
    assert.ok(dbCalls.includes('seen 12') && dbCalls.includes('reject-title 12 Chef'));
    assert.ok(!dbCalls.some((l) => l === 'seen 11' || l === 'reject-title 11 Chef'));
    assert.strictEqual(callsOf(r.calls, 'caterer-unlock').map((c) => c.id).join(','), '11');
    assert.ok(g.stats().calls, 'the gateway saw traffic');
    const dir = path.join(home, 'runtime', 'screening-input');
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no snippet file left behind');
    if (mode === 'stdin') assert.ok(!fs.existsSync(dir), 'stdin mode never creates the directory');
  });
}

test('real ai-review + fake gateway down: API_UNAVAILABLE exit 3 x3 raises the halt with the real pipeline-halt module', async (t) => {
  const g = await startFakeGateway();
  t.after(() => g.close());
  g.setMode({ llm: '503', jev: '503' });
  const home = h.makeHome({ pages: { 1: { cards: [card(21)] }, 2: { cards: [card(22)] } } }, { real: ['ai-review', 'browser', 'pipeline-halt'] });
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(), { env: Object.assign({}, GATEWAY_ENV(g), browserEnv(home)), timeoutMs: 120000 });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('failure 1/3') && r.stdout.includes('failure 2/3') && r.stdout.includes('failure 3/3'), r.stdout);
  assert.ok(r.stdout.includes('STOPPING Phase 1: AI screening API down for 3 consecutive pages'));
  assert.match(r.stdout, /HEARTBEAT: AI batch end page 1 \(exit=3, /);
  const halt = h.readJson(path.join(home, 'runtime', 'pipeline-halt.json'));
  assert.strictEqual(halt.reason, 'AI screening unavailable');
  const q = h.queueOf(home);
  assert.strictEqual(q.phase1Stats.errors, 1);
  assert.ok(!callsOf(r.calls, 'candidates-db').some((c) => ['seen', 'add', 'reject-title'].includes(c.cmd)), 'nothing was marked while screening was down');
  assert.strictEqual(callsOf(r.calls, 'caterer-unlock').length, 0);
});

test('real ai-review: a recovering gateway (two failures then success) goes through with the failure counter reset', async (t) => {
  const g = await startFakeGateway();
  t.after(() => g.close());
  const home = h.makeHome({ pages: { 1: { cards: [card(31)] }, 2: { cards: [] } } }, { real: ['ai-review', 'browser'] });
  t.after(() => h.cleanup(home));
  // the reviewer retries internally 3 times per invocation; the first invocation fails entirely, the second succeeds
  g.setMode({ llm: '503', jev: '503' });
  setTimeout(() => g.setMode({ llm: 'ok', jev: 'ok' }), 400);
  const r = await h.runPhase1(home, h.baseArgs(), { env: Object.assign({ SCREEN_PAGE_RETRY_PAUSE_SEC: '1' }, GATEWAY_ENV(g), browserEnv(home)), timeoutMs: 120000 });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('STOPPING Phase 1'));
  assert.deepStrictEqual(h.queueOf(home).candidates.map((c) => c.id), ['31']);
});
