'use strict';
// Update C, findings F1 and F4: the screening health check and the CV stage.
//   F1  while CV_SCREEN is on, the deep check also asks one small invented request through the CV stage's own client (the CV canary), so a halt raised
//       by the CV stage only clears when the CV route itself answers; the snippet route being healthy proves nothing about it. In shadow and off
//       nothing about the CV stage is asked (shadow never blocks and never halts).
//   F4  a broken or missing criteria file has its own fixed reason and remedy ("screening criteria invalid", "restore it from git"), and the CHEAP check
//       sees it, so no browser run is started before three failing pages raise the halt.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const health = require(h.lib('screening-health.js'));
const { HttpFailure, reasonKeyOf } = require(h.lib('screening/errors'));
const SHIPPED_CV_CONFIG = path.join(h.REPO, 'resourcer', 'config', 'cv-screening.json');

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => {
  gw.reset(); h.resetHome();
  fs.mkdirSync(path.join(h.HOME, 'config'), { recursive: true });
  fs.copyFileSync(SHIPPED_CV_CONFIG, path.join(h.HOME, 'config', 'cv-screening.json'));
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
  process.env.SCREEN_ENGINE = 'jev_only';
  delete process.env.SCREEN_CRITERIA_FILE;
  delete process.env.CV_SCREEN;
  delete process.env.CV_SCREEN_CONFIG_FILE;
});

const isCv = r => r.questions.includes('search_level') || r.questions.some(k => /^relevance_\d+$/.test(k));
const cvRequests = () => gw.stats().requests.filter(isCv);
const snippetRequests = () => gw.stats().requests.filter(r => !isCv(r));
const cvCfgPath = path.join(h.HOME, 'config', 'cv-screening.json');

test('F1: mode on, snippet route healthy, CV route refusing: the cheap check passes and the deep check FAILS with the CV canary named', async () => {
  process.env.CV_SCREEN = 'on';
  gw.setMode({ cv: '503' });
  assert.equal((await health.check({ deep: false })).ok, true, 'the cheap check is local: it cannot see a route');
  const r = await health.check({ deep: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'screening gateway error', 'a fixed reason, no status code');
  assert.match(r.detail, /^cv canary failed: /);
  assert.equal(r.engines.jev.ok, true, 'the snippet canary passed');
  assert.equal(r.engines.cv.ok, false);
  assert.ok(snippetRequests().length >= 1);
  assert.equal(cvRequests().length, 1, 'one request, no retries: the check is run while halted and must be quick');
});

test('F1: the CV canary is one small invented request made with the CV stage questions, and it passes when the CV route answers', async () => {
  process.env.CV_SCREEN = 'on';
  const r = await health.check({ deep: true });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.engines.cv.ok, true);
  assert.equal(cvRequests().length, 1);
  const req = cvRequests()[0];
  assert.ok(req.questions.includes('relevance_0') && req.questions.includes('overall_match') && req.questions.includes('injection'), req.questions.join(','));
  assert.equal(req.model, 'typesafe-ai/jev');
  // nothing is written: no shadow row, no answers cache, no search-level cache
  for (const d of ['shadow', 'state']) assert.equal(fs.existsSync(path.join(h.HOME, d)), false, `${d}/ was created by the canary`);
});

test('F1: each way the CV route can fail keeps the halt, under the same fixed reasons as the snippet route', async () => {
  process.env.CV_SCREEN = 'on';
  const cases = [
    ['401', 'screening gateway auth failed'],
    ['402', 'screening credits exhausted'],
    ['429', 'screening gateway error'],
    ['500', 'screening gateway error'],
    ['no_providers', 'screening gateway error'], // a refused request (HTTP 400): the stage's own request does not work
    ['down', 'screening gateway unreachable'],
  ];
  for (const [mode, reason] of cases) {
    gw.setMode({ cv: mode });
    const r = await health.check({ deep: true });
    assert.equal(r.ok, false, mode);
    assert.equal(r.reason, reason, mode);
    assert.match(r.detail, /^cv canary failed/, mode);
  }
  gw.setMode({ cv: 'ok' });
  assert.equal((await health.check({ deep: true })).ok, true, 'the halt clears once the CV route answers');
});

test('F1: in shadow, off and unset the CV stage is never asked: a refusing CV route does not keep a halt', async () => {
  gw.setMode({ cv: '503' });
  for (const value of [undefined, 'shadow', 'off', 'sometimes']) {
    if (value === undefined) delete process.env.CV_SCREEN; else process.env.CV_SCREEN = value;
    gw.reset(); gw.setMode({ cv: '503' });
    const r = await health.check({ deep: true });
    assert.equal(r.ok, true, `CV_SCREEN=${value}`);
    assert.equal(cvRequests().length, 0, `CV_SCREEN=${value}: no CV canary`);
    assert.equal(r.engines.cv, undefined);
  }
});

test('F1: the CV canary also runs next to the LLM canary when an LLM engine decides (jev_shadow)', async () => {
  process.env.SCREEN_ENGINE = 'jev_shadow';
  process.env.CV_SCREEN = 'on';
  gw.setMode({ cv: '503' });
  const r = await health.check({ deep: true });
  assert.equal(r.ok, false);
  assert.equal(r.engines.llm.ok, true);
  assert.equal(r.engines.cv.ok, false);
  gw.setMode({ cv: 'ok' });
  assert.equal((await health.check({ deep: true })).ok, true);
});

test('F1: a snippet failure is reported before the CV canary result', async () => {
  process.env.CV_SCREEN = 'on';
  gw.setMode({ jev: '402', cv: '503' });
  const r = await health.check({ deep: true });
  assert.equal(r.reason, 'screening credits exhausted');
  assert.match(r.detail, /^jev canary failed/);
});

// ---------------------------------------------------------------------------- F4

function badCriteria(text) {
  const file = path.join(h.HOME, 'bad-criteria.json');
  fs.writeFileSync(file, text);
  process.env.SCREEN_CRITERIA_FILE = file;
  return file;
}

test('F4: a broken criteria file is "screening criteria invalid" with its own remedy, found by the CHEAP check (no network, no browser run started)', async () => {
  badCriteria('{ not json');
  const r = await health.check({ deep: false });
  assert.equal(r.ok, false);
  assert.equal(r.key, 'config');
  assert.equal(r.reason, 'screening criteria invalid');
  assert.match(r.detail, /screening-criteria\.json/);
  assert.match(health.REMEDIES.config, /^Fix config\/screening-criteria\.json or restore it from git/);
  assert.deepEqual(gw.stats().calls, {}, 'a local read: nothing was asked of the gateway');
  // the deep check reports the same reason, so the halt raised by the cheap check clears only when the file is valid again
  assert.equal((await health.check({ deep: true })).reason, 'screening criteria invalid');
  await new Promise(resolve => setTimeout(resolve, 40)); // the criteria file is re-read when its modification time changes
  fs.writeFileSync(process.env.SCREEN_CRITERIA_FILE, fs.readFileSync(path.join(h.REPO, 'resourcer', 'config', 'screening-criteria.json')));
  assert.equal((await health.check({ deep: false })).ok, true);
  assert.equal((await health.check({ deep: true })).ok, true);
});

test('F4: a file that parses but fails the criteria validation is the same fault; a criteria problem is not checked for an engine that does not use it', async () => {
  const real = JSON.parse(fs.readFileSync(path.join(h.REPO, 'resourcer', 'config', 'screening-criteria.json'), 'utf8'));
  delete real.context;
  badCriteria(JSON.stringify(real));
  const bad = await health.check({ deep: false });
  assert.equal(bad.key, 'config');
  assert.match(bad.detail, /context is missing/);
  process.env.SCREEN_ENGINE = 'jev_shadow'; // the LLM decides: Jev is only logged, the criteria file cannot hold anything up
  assert.equal((await health.check({ deep: false })).ok, true);
});

test('F4: the error classes carry the new kind: kind config is reason key config, never the gateway remedy', () => {
  assert.equal(reasonKeyOf(new HttpFailure('config', 'x')), 'config');
  assert.equal(reasonKeyOf(new HttpFailure('cvconfig', 'x')), 'cvconfig', 'the CV canary reports a broken CV criteria file under its own key');
  assert.equal(reasonKeyOf(new HttpFailure('transient', 'x', { status: 503 })), 'error');
  assert.notEqual(health.REMEDIES.config, health.REMEDIES.error);
  assert.match(health.REASONS.config, /^screening criteria invalid$/);
  assert.match(health.REASONS.cvconfig, /^CV screening criteria invalid$/);
  assert.ok(!/gateway/i.test(health.REASONS.config), 'not the gateway');
});

test('F3/F4: while CV_SCREEN is on, the cheap check also sees a broken or missing config/cv-screening.json (its own reason); in shadow it does not care', async () => {
  process.env.CV_SCREEN = 'on';
  fs.writeFileSync(cvCfgPath, '{ broken');
  let r = await health.check({ deep: false });
  assert.equal(r.ok, false);
  assert.equal(r.key, 'cvconfig');
  assert.equal(r.reason, 'CV screening criteria invalid');
  assert.match(r.detail, /cv-screening\.json is not usable/);
  assert.equal((await health.check({ deep: true })).reason, 'CV screening criteria invalid');
  fs.writeFileSync(cvCfgPath, JSON.stringify({ operatingPoint: { rejectAbove: 5 } })); // out of range
  assert.equal((await health.check({ deep: false })).key, 'cvconfig');
  fs.rmSync(cvCfgPath);
  assert.equal((await health.check({ deep: false })).key, 'cvconfig', 'the file ships in the repository: missing is a fault');
  process.env.CV_SCREEN = 'shadow';
  assert.equal((await health.check({ deep: false })).ok, true, 'shadow never halts');
  process.env.CV_SCREEN = 'on';
  fs.copyFileSync(SHIPPED_CV_CONFIG, cvCfgPath);
  assert.equal((await health.check({ deep: true })).ok, true);
});

test('Update C finalizer: the CV canary given a faulty CV configuration fails with the cvconfig key, without any request', async () => {
  const { cvCanary } = require(h.lib('cv/canary'));
  const r = await cvCanary({ cfg: { fault: { key: 'cvconfig', detail: 'cv-screening.json: not valid JSON' } } });
  assert.equal(r.ok, false);
  assert.equal(reasonKeyOf(r.err), 'cvconfig');
  assert.equal(gw.stats().requests.length, 0);
});
