'use strict';
// Stage 2 of the design: Jev typed answers, defensive parsing, retries, concurrency, and the jev
// engine (Jev first, LLM on doubt). Against the fake gateway only.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const { JevClient, parseAnswers } = require(h.lib('screening/jev-client'));
const Q = require(h.lib('screening/jev-questions'));
const { ScreeningUnavailable } = require(h.lib('screening/errors'));

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); });

const JEV = 'POST /typesafe/v1/systemone';
const LLM = 'POST /v1/chat/completions';
const calls = r => gw.stats().calls[r] || 0;

function cfgWith(overrides) {
  // the background audit samples 5% of Jev decisions at random: off unless a test asks for it, or call counts flake
  return screening.loadConfig({ overrides: { cache: { ttlSec: 0 }, shadow: { auditRate: 0 }, ...(overrides || {}) } });
}
function jevEngine(overrides, deps) {
  const cfg = cfgWith({ engine: 'jev', decide: { calibration: { calibrated: true } }, ...(overrides || {}) });
  return { cfg, engine: screening.createEngine(cfg, { log: () => {}, ...(deps || {}) }) };
}
const C = (snippet, extra) => ({ id: String(Math.random()).slice(2, 8), name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}`, ...(extra || {}) });
const CTX = { job: 'Chef', location: 'M1', distance: 20 };

async function evalOne(snippet, opts) {
  const cfg = cfgWith((opts && opts.overrides) || {});
  const client = new JevClient({ cfg, log: () => {} });
  return client.evaluate({ searchRole: 'Chef', searchTier: 2, snippet, stage: 1, ...(opts || {}) });
}

test('request shape: pinned Jev model, atomic typed questions, no location/distance/name in the state, no providerOptions by default', async () => {
  gw.state.capture = true;
  const r = await evalOne('ordinary cook [[APPROVE]]');
  assert.equal(r.ok, true);
  const body = gw.stats().captured[0].body;
  assert.equal(body.model, 'typesafe-ai/jev');
  assert.equal(body.providerOptions, undefined);
  assert.deepEqual(Object.keys(body.state), ['agency_context', 'search', 'candidate']);
  assert.deepEqual(body.state.search, { role: 'Chef' });
  assert.deepEqual(Object.keys(body.state.candidate), ['snippet']);
  const flat = JSON.stringify(body);
  assert.ok(!/distance|location/i.test(flat.replace(/Salary, location and driving licence are never reasons to reject/, '')), 'search location and distance are not sent');
  const qs = body.questions;
  assert.deepEqual(Object.keys(qs).sort(), ['current_tier', 'hospitality_seen', 'info_sufficient', 'instruction_injection', 'kitchen_seen', 'overall_fit', 'role_match_seen']);
  for (const q of Object.values(qs)) {
    assert.ok(['noul', 'choice', 'score'].includes(q.type));
    assert.ok(typeof q.instructions === 'string' && q.instructions.length > 20);
  }
  assert.ok(Object.keys(qs.current_tier.criteria).includes('not_stated'), 'a Choice always has an escape option');
  assert.ok(Object.keys(qs.current_tier.criteria).length <= 255);
  assert.equal(qs.overall_fit.criteria.length, 3);
  assert.ok(!qs.overall_fit.criteria.some(c => /^\d|level \d|previous/i.test(c)), 'score levels are self-contained situations');
  assert.match(qs.hospitality_seen.instructions, /`candidate\.snippet`/, 'fields are referenced by path');
});

test('stage 2 adds only the real job title and two questions', async () => {
  gw.state.capture = true;
  const r = await evalOne('x', { stage: 2, realJobTitle: 'Sous Chef' });
  assert.equal(r.ok, true);
  const body = gw.stats().captured[0].body;
  assert.deepEqual(Object.keys(body.state.candidate), ['snippet', 'real_job_title']);
  assert.ok(body.questions.real_title_tier && body.questions.title_consistent);
  assert.ok(Object.keys(body.questions.real_title_tier.criteria).includes('unclear'));
  // no real title: stage-1 question set
  gw.state.captured = [];
  await evalOne('x', { stage: 2, realJobTitle: '' });
  assert.ok(!gw.stats().captured[0].body.questions.real_title_tier);
});

test('question wording depends on the search tier (entry-level searches mention too-senior; others say seniority is fine)', () => {
  const entry = Q.buildQuestions({ stage: 1, searchTier: 1 }).overall_fit;
  const std = Q.buildQuestions({ stage: 1, searchTier: 2 }).overall_fit;
  assert.match(entry.criteria[0], /too senior/);
  assert.match(std.instructions, /more senior than the role is not a reason/i);
  assert.notEqual(Q.questionSetHash(Q.buildQuestions({ stage: 1, searchTier: 1 })), Q.questionSetHash(Q.buildQuestions({ stage: 1, searchTier: 2 })));
  assert.match(Q.buildState({ searchRole: 'Kitchen Porter', searchTier: 1, snippet: 's' }).agency_context, /entry-level/);
  assert.match(Q.buildState({ searchRole: 'Chef', searchTier: 2, snippet: 's' }).agency_context, /over-qualification is not a reason/);
});

test('invalid answers: missing question, bad choice, no probabilities (sentinel), non-Jev model', async () => {
  for (const [token, code] of [['[[MALFORMED]]', 'missing'], ['[[BADCHOICE]]', 'bad_choice'], ['[[NOPROBS]]', 'no_probs'], ['[[NOTJEV]]', 'not_jev']]) {
    const r = await evalOne(token);
    assert.equal(r.ok, false, token);
    assert.equal(r.kind, 'invalid', token);
    assert.equal(r.code, code, token);
  }
});

test('confidence is read from the answer, else provider metadata, else computed from the probabilities', () => {
  const shape = { t: { type: 'choice', options: ['a', 'b', 'c'] } };
  const mk = (extra, ans) => ({ model: 'typesafe-ai/jev', answers: { t: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.1, c: 0.1 }, ...ans } }, ...extra });
  const a = parseAnswers(mk({}, { confidence: 0.7 }), shape).answers.t;
  assert.deepEqual([a.confidence, a.confidenceFrom], [0.7, 'answer']);
  const b = parseAnswers(mk({ providerMetadata: { typesafe: { confidence: { t: 0.66 } } } }, {}), shape).answers.t;
  assert.deepEqual([b.confidence, b.confidenceFrom], [0.66, 'metadata']);
  const c = parseAnswers(mk({ provider_metadata: { typesafe: { confidence: { t: 0.61 } } } }, {}), shape).answers.t;
  assert.deepEqual([c.confidence, c.confidenceFrom], [0.61, 'metadata']);
  const d = parseAnswers(mk({}, {}), shape).answers.t;
  assert.equal(d.confidenceFrom, 'computed');
  assert.ok(Math.abs(d.confidence - (3 * 0.8 - 1) / 2) < 1e-9);
  assert.throws(() => parseAnswers(mk({}, { probabilities: {}, confidence: 0 }), shape), /probabilities/);
  assert.throws(() => parseAnswers(mk({}, { probabilities: { a: 0.1, b: 0.1, c: 0.1 } }), shape), /sum/);
  assert.throws(() => parseAnswers({ model: 'typesafe-ai/jev', answers: { t: { type: 'choice', choice: 'a', probabilities: { a: 'x' } } } }, shape));
  assert.throws(() => parseAnswers({ answers: { n: { type: 'noul', noul: 'high' } } }, { n: { type: 'noul' } }));
  // rounding: probabilities summing to 0.99 are fine
  assert.ok(parseAnswers(mk({}, { probabilities: { a: 0.8, b: 0.1, c: 0.09 } }), shape));
});

test('retry policy: 500 twice then OK = 3 calls; 429 honours retry-after; 422 is never retried', async () => {
  const ok = await evalOne('[[J:HTTP500x2]] [[APPROVE]]');
  assert.equal(ok.ok, true);
  assert.equal(calls(JEV), 3);
  gw.reset();
  const t0 = Date.now();
  const rl = await evalOne('[[J:HTTP429x1]] [[APPROVE]]');
  assert.equal(rl.ok, true);
  assert.equal(calls(JEV), 2);
  assert.ok(Date.now() - t0 < 2000);
  gw.reset();
  const bad = await evalOne('[[J:HTTP422]]');
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'request');
  assert.equal(calls(JEV), 1, '422 is a request bug: no retry');
  gw.reset();
  const exhausted = await evalOne('[[J:HTTP500]]', { maxAttempts: 3 });
  assert.equal(exhausted.kind, 'transient');
  assert.equal(calls(JEV), 3);
});

test('401 / 402 / 403 are hard failures without retry', async () => {
  for (const code of ['401', '402', '403']) {
    gw.reset();
    gw.setMode({ jev: code });
    const r = await evalOne('x');
    assert.equal(r.ok, false);
    assert.equal(r.kind, code === '402' ? 'credits' : 'auth');
    assert.equal(calls(JEV), 1, code);
  }
});

test('timeout: a hung request aborts at the configured timeout and counts as an attempt', async () => {
  const t0 = Date.now();
  const r = await evalOne('[[J:TIMEOUT]]', { timeoutMs: 150, maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'transient');
  assert.match(r.message, /timeout after 150ms/);
  assert.equal(calls(JEV), 2);
  assert.ok(Date.now() - t0 < 2500);
});

test('jev engine: confident approve and reject are final and need no LLM call; the label names the deciding engine', async () => {
  const { engine } = jevEngine();
  const r = await engine.screenBatch(CTX, [C('[[APPROVE]]'), C('[[REJECT]]')]);
  assert.deepEqual(r.decisions.map(d => [d.source, d.approved]), [['jev', true], ['jev', false]]);
  assert.equal(calls(LLM), 0);
  assert.equal(r.modelLabel, 'typesafe-ai/jev');
  assert.equal(r.decisions[0].reasonCode, 'approve_level_match');
  assert.equal(r.decisions[1].reasonCode, 'reject_unrelated_industry');
  assert.equal(r.decisions[1].reason, 'Background in an unrelated industry');
  assert.equal(r.decisions[0].engineModel, 'typesafe-ai/jev');
});

test('jev engine: a review-lane answer escalates to the LLM; the label lists both engines', async () => {
  const { engine } = jevEngine();
  const r = await engine.screenBatch(CTX, [C('[[APPROVE]]'), C('[[LOWCONF]]')]);
  assert.equal(r.decisions[0].source, 'jev');
  assert.equal(r.decisions[1].source, 'llm');
  assert.equal(r.decisions[1].escalated, true);
  assert.equal(calls(LLM), 1);
  assert.equal(r.modelLabel, 'typesafe-ai/jev+anthropic/claude-sonnet-5.5');
  const rows = h.readShadow();
  assert.equal(rows[1].jev.lane, 'review');
  assert.equal(rows[1].used.engine, 'llm');
});

test('jev engine: invalid Jev answers are retried once (counted attempts) then escalate to the LLM', async () => {
  for (const tok of ['[[J:MALFORMED]]', '[[J:BADCHOICE]]', '[[J:NOPROBS]]']) {
    gw.reset(); h.resetHome();
    const { engine } = jevEngine();
    const r = await engine.screenBatch(CTX, [C(tok)]);
    assert.equal(r.decisions[0].source, 'llm', tok);
    assert.equal(calls(JEV), 2, `${tok}: two Jev attempts`);
    assert.equal(calls(LLM), 1, tok);
    assert.equal(h.readShadow()[0].jev.status, 'invalid');
  }
});

test('jev engine: a Jev outage falls back to the LLM for every candidate and raises the degraded flag; recovery clears it', async () => {
  const { engine } = jevEngine({ jev: { maxAttempts: 1 } });
  gw.setMode({ jev: 'down' });
  const r = await engine.screenBatch(CTX, [C('a'), C('b'), C('c')]);
  assert.ok(r.decisions.every(d => d.source === 'llm'));
  assert.equal(r.modelLabel, 'anthropic/claude-sonnet-5.5');
  const flag = path.join(h.HOME, 'runtime', 'screening-degraded.json');
  assert.ok(fs.existsSync(flag));
  assert.equal(JSON.parse(fs.readFileSync(flag, 'utf8')).degraded, true);
  gw.setMode({ jev: 'ok' });
  await engine.screenBatch(CTX, [C('[[APPROVE]]')]);
  assert.ok(!fs.existsSync(flag), 'cleared once Jev answers again');
});

test('concurrency cap holds, total time shows real parallelism, results stay index-aligned with out-of-order responses', async () => {
  gw.setMode({ latencyMs: 30, randomLatency: true });
  const { engine } = jevEngine({ jev: { concurrency: 4 } });
  const cands = Array.from({ length: 50 }, (_, i) => C(i % 2 === 0 ? '[[APPROVE]]' : '[[REJECT]]', { id: String(1000 + i) }));
  const t0 = Date.now();
  const r = await engine.screenBatch(CTX, cands);
  const elapsed = Date.now() - t0;
  assert.ok(gw.stats().maxByRoute[JEV] <= 4, `max in flight ${gw.stats().maxByRoute[JEV]}`);
  assert.ok(gw.stats().maxByRoute[JEV] >= 2, 'it did run in parallel');
  assert.ok(elapsed < 50 * 30 * 0.8, `elapsed ${elapsed}ms`);
  r.decisions.forEach((d, i) => assert.equal(d.approved, i % 2 === 0, `index ${i}`));
});

test('Jev up + LLM down + low confidence: unavailable for that candidate; the others are cached and only the failed one is re-asked', async () => {
  const cfg = cfgWith({ engine: 'jev', decide: { calibration: { calibrated: true } }, cache: { ttlSec: 3600 }, llm: { maxAttempts: 1 } });
  const cacheFile = path.join(h.HOME, 'cache-retry.json');
  const { DecisionCache } = require(h.lib('screening/cache'));
  const mk = () => screening.createEngine(cfg, { log: () => {}, cache: new DecisionCache({ file: cacheFile, ttlSec: 3600, maxEntries: 100 }) });
  const list = () => [C('[[APPROVE]] alpha', { id: 'a' }), C('[[LOWCONF]] beta', { id: 'b' })];
  gw.setMode({ llm: '500' });
  await assert.rejects(() => mk().screenBatch(CTX, list()), e => e instanceof ScreeningUnavailable && /1 of 2 candidates could not be screened/.test(e.detail));
  assert.equal(calls(JEV), 2);
  gw.setMode({ llm: 'ok' });
  const before = calls(JEV);
  const r = await mk().screenBatch(CTX, list());
  assert.equal(calls(JEV) - before, 1, 'only the failed candidate was re-asked');
  assert.equal(r.decisions[0].source, 'cache');
  assert.equal(r.decisions[1].source, 'llm');
  assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes('alpha'));
});

test('audit: a share of Jev decisions is re-checked by the LLM in the background and logged, never changing the decision', async () => {
  const { engine } = jevEngine({ shadow: { auditRate: 1 } });
  const r = await engine.screenBatch(CTX, [C('[[APPROVE]]'), C('[[REJECT]] [[L:HTTP500]]')]);
  assert.deepEqual(r.decisions.map(d => d.source), ['jev', 'jev']);
  const rows = h.readShadow();
  assert.equal(rows[0].llm.status, 'ok');
  assert.equal(rows[0].llm.approved, true);
  assert.ok(['error', 'timeout'].includes(rows[1].llm.status), 'a failing audit is logged, not fatal');
});

test('the wrong-surface response (/v1/evaluate names) is treated as invalid, never parsed as TypeSafe', async () => {
  const cfg = cfgWith({ gateway: { origin: gw.origin } });
  const http = require(h.lib('screening/http'));
  const res = await http.request('POST', `${gw.origin}/v1/evaluate`, { headers: { Authorization: 'Bearer fake-test-key' }, body: { model: 'typesafe-ai/jev', state: { candidate: { snippet: 'x' } }, questions: Q.buildQuestions({ stage: 1, searchTier: 2 }) }, timeoutMs: 2000, maxAttempts: 1, retry: cfg.retry });
  assert.throws(() => parseAnswers(res.json, Q.expectedShape(Q.buildQuestions({ stage: 1, searchTier: 2 }))));
});
