'use strict';
// screening-health.js: cheap probe every tick, real canary only when asked (halted), fixed reason
// strings, degraded state, legacy-compatible wrapper.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const health = require(h.lib('screening-health.js'));
const halt = require(h.lib('pipeline-halt.js'));

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => {
  gw.reset(); h.resetHome();
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
  delete process.env.SCREEN_ENGINE;
  delete process.env.SCREEN_CALIBRATED;
});

const JEV = 'POST /typesafe/v1/systemone';
const LLM = 'POST /v1/chat/completions';
const calls = r => gw.stats().calls[r] || 0;

test('cheap probe: ok when the gateway is reachable, in well under a second, with no API calls', async () => {
  const r = await health.check({ deep: false });
  assert.equal(r.ok, true);
  assert.equal(r.reason, '');
  assert.equal(r.level, 'network');
  assert.ok(r.ms < 1000, `${r.ms}ms`);
  assert.equal(typeof r.ms, 'number');
  assert.deepEqual(gw.stats().calls, {}, 'a TCP probe only: no HTTP request was made');
});

test('cheap probe: not ok when nothing listens, fast, with the fixed reason', async () => {
  const dead = await h.newGateway();
  const origin = dead.origin;
  await dead.close();
  process.env.SCREEN_GATEWAY_ORIGIN = origin;
  const r = await health.check({ deep: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'screening gateway unreachable');
  assert.equal(r.key, 'unreachable');
  assert.ok(r.ms < 1500);
  assert.match(r.detail, /ECONNREFUSED|timeout/);
});

test('a missing key is an auth failure without any network use', async () => {
  delete process.env.AI_GATEWAY_API_KEY;
  const r = await health.check({ deep: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'screening gateway auth failed');
  assert.match(r.detail, /AI_GATEWAY_API_KEY/);
  assert.deepEqual(gw.stats().calls, {});
});

test('deep check: credits then one LLM canary; ok when the canary is answered as expected', async () => {
  const r = await health.check({ deep: true });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.level, 'auth');
  assert.equal(calls('GET /v1/credits'), 1);
  assert.equal(calls(LLM), 1);
  assert.equal(calls(JEV), 0, 'in jev_shadow the LLM decides: Jev is not probed');
  assert.equal(r.engines.llm.ok, true);
  assert.equal(r.degraded, false);
});

test('deep check maps failures to the fixed reasons', async () => {
  const cases = [
    [{ credits: '401' }, 'screening gateway auth failed'],
    [{ credits: '403' }, 'screening gateway auth failed'],
    [{ credits: '402' }, 'screening credits exhausted'],
    [{ credits: '500' }, 'screening gateway error'],
    [{ llm: '401' }, 'screening gateway auth failed'],
    [{ llm: '402' }, 'screening credits exhausted'],
    [{ llm: '500' }, 'screening gateway error'],
    [{ llm: 'down' }, 'screening gateway unreachable'],
    [{ canary: 'approve' }, 'screening gateway error'],
  ];
  for (const [mode, reason] of cases) {
    gw.reset();
    gw.setMode(mode);
    const r = await health.check({ deep: true });
    assert.equal(r.ok, false, JSON.stringify(mode));
    assert.equal(r.reason, reason, JSON.stringify(mode));
  }
});

test('a credits endpoint that is missing for this key type (404) does not fail the check; the canary decides', async () => {
  gw.setMode({ credits: '404' });
  assert.equal((await health.check({ deep: true })).ok, true);
});

test('the reason strings are a fixed set and never contain a status code (no halt churn)', async () => {
  assert.deepEqual(Object.values(health.REASONS).sort(), [
    'AI screening unavailable', 'screening credits exhausted', 'screening gateway auth failed', 'screening gateway error', 'screening gateway unreachable',
  ].sort());
  for (const r of Object.values(health.REASONS)) assert.ok(!/\d{3}/.test(r), r);
  gw.setMode({ credits: '500' });
  const a = await health.check({ deep: true });
  gw.setMode({ credits: '503' });
  const b = await health.check({ deep: true });
  assert.equal(a.reason, b.reason);
  assert.notEqual(a.detail, b.detail, 'the status lives in detail');
  // consumed by the halt state: same reason, different detail => one halt, no second pipeline_halted entry
  halt.setHalt(a.reason, a.detail, { remedy: health.REMEDIES[a.key] });
  const since = halt.getHalt().since;
  halt.setHalt(b.reason, b.detail, { remedy: health.REMEDIES[b.key] });
  assert.equal(halt.getHalt().since, since);
  const log = fs.readFileSync(path.join(h.HOME, 'logs', 'errors.jsonl'), 'utf8').split('\n').filter(l => /pipeline_halted/.test(l));
  assert.equal(log.length, 1);
  gw.setMode({ credits: 'ok' });
  const ok = await health.check({ deep: true });
  assert.equal(ok.ok, true);
  halt.clearHalt();
  assert.equal(halt.getHalt(), null);
});

test('jev engine: Jev canary failing but the LLM answering is DEGRADED, not down; both failing is down', async () => {
  process.env.SCREEN_ENGINE = 'jev';
  process.env.SCREEN_CALIBRATED = '1';
  const flag = path.join(h.HOME, 'runtime', 'screening-degraded.json');
  gw.setMode({ jev: '500' });
  const d = await health.check({ deep: true });
  assert.equal(d.ok, true);
  assert.equal(d.degraded, true);
  assert.equal(d.engines.jev.ok, false);
  assert.ok(fs.existsSync(flag));
  gw.setMode({ jev: 'ok' });
  const ok = await health.check({ deep: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.degraded, false);
  assert.ok(!fs.existsSync(flag));
  gw.setMode({ llm: '500' });
  const llmDown = await health.check({ deep: true });
  assert.equal(llmDown.ok, true, 'Jev alone can decide');
  assert.equal(llmDown.degraded, true);
  gw.setMode({ llm: '500', jev: '500' });
  const both = await health.check({ deep: true });
  assert.equal(both.ok, false);
  assert.equal(both.reason, 'screening gateway error');
  assert.ok(calls(JEV) >= 3);
});

test('legacy-compatible checkScreening keeps the old shape and its deep default', async () => {
  const ok = await health.checkScreening();
  assert.deepEqual(Object.keys(ok).sort(), ['detail', 'level', 'ok', 'reason']);
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.level, 'auth');
  assert.equal(calls(LLM), 1, 'default is deep, as before');
  const cheap = await health.checkScreening({ deep: false });
  assert.equal(cheap.level, 'port');
  gw.setMode({ credits: '401' });
  const bad = await health.checkScreening();
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'screening gateway auth failed');
  assert.equal(typeof bad.detail, 'string');
  assert.equal(await health.portOpen(gw.port, 500), true);
});

test('sentinels: model labels and markers other code matches on', () => {
  assert.deepEqual(health.SENTINELS.MODEL_LABELS, { UNKNOWN: 'unknown', UNAVAILABLE: 'unavailable', ERROR: 'error', NONE: 'none' });
  assert.equal(health.SENTINELS.MARKERS.API_UNAVAILABLE, 'API_UNAVAILABLE');
  assert.equal(health.SENTINELS.MARKERS.SCREENING_MODEL, 'SCREENING_MODEL:');
  assert.equal(health.SENTINELS.REASONS.unavailable, 'AI screening unavailable');
});

test('check never throws: an invalid origin is reported, not raised', async () => {
  process.env.SCREEN_GATEWAY_ORIGIN = 'not a url';
  const r = await health.check({ deep: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'screening gateway error');
});
