'use strict';
// The Jev client and the stores: answer validation, transport rules, caches, the streak guard.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-jev');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeJev } = require('./helpers/fake-jev');
const config = require('../../resourcer/scripts/lib/cv/config');
const jev = require('../../resourcer/scripts/lib/cv/jev');
const cache = require('../../resourcer/scripts/lib/cv/cache');
const Q = require('../../resourcer/scripts/lib/cv/questions');

let gw;
test.before(async () => { gw = await startFakeJev(); });
test.after(async () => { await gw.close(); home.cleanup(); });
test.beforeEach(() => { home.reset(); gw.reset(); home.point(gw); });

const shape = { a: { type: 'noul' }, b: { type: 'choice', options: ['x', 'y', 'z'] }, c: { type: 'score', levels: 3 } };
const good = () => ({ model: 'typesafe-ai/jev', answers: { a: { type: 'noul', noul: 0.4 }, b: { type: 'choice', choice: 'x', probabilities: { x: 0.7, y: 0.2, z: 0.1 } }, c: { type: 'score', probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } } } });

test('parseAnswers accepts the three answer types and keeps numbers and the top option', () => {
  const r = jev.parseAnswers(good(), shape);
  assert.equal(r.model, 'typesafe-ai/jev');
  assert.equal(r.answers.a, 0.4);
  assert.deepEqual(r.answers.b, { p: { x: 0.7, y: 0.2, z: 0.1 }, top: 'x' });
  assert.deepEqual(r.answers.c.p, { 0: 0.1, 1: 0.2, 2: 0.7 });
  assert.equal(r.answers.c.top, '2');
});

test('parseAnswers rejects everything unusable with a code: missing, malformed, out of range, not adding up, wrong choice, not Jev', () => {
  const mutate = f => { const j = good(); f(j); return j; };
  const cases = {
    no_answers: mutate(j => { delete j.answers; }),
    not_jev: mutate(j => { j.model = 'other/model'; }),
    missing: mutate(j => { delete j.answers.b; }),
    bad_noul: mutate(j => { j.answers.a.noul = 'high'; }),
    bad_noul2: mutate(j => { j.answers.a.noul = 2; }),
    no_probs: mutate(j => { delete j.answers.b.probabilities; }),
    bad_prob: mutate(j => { j.answers.b.probabilities.x = 'NaN'; }),
    bad_sum: mutate(j => { j.answers.c.probabilities = { 0: 0.05, 1: 0.05, 2: 0.05 }; }),
    bad_choice: mutate(j => { j.answers.b.choice = 'q'; }),
    unrelated_probs: mutate(j => { j.answers.b.probabilities = { q: 1 }; }),
  };
  for (const [name, body] of Object.entries(cases)) assert.throws(() => jev.parseAnswers(body, shape), e => e.name === 'InvalidAnswers', name);
  // the sentinel a language model fallback would produce (empty probabilities) is unusable
  assert.throws(() => jev.parseAnswers(mutate(j => { j.answers.b.probabilities = {}; }), shape), e => e.code === 'no_probs');
  // two-decimal rounding is fine
  assert.doesNotThrow(() => jev.parseAnswers(mutate(j => { j.answers.b.probabilities = { x: 0.33, y: 0.33, z: 0.33 }; }), shape));
});

test('the request: POST to the systemone route with the key, the model typesafe-ai/jev, the state and the questions, and no other field unless zero data retention is on', async () => {
  const cfg = config.load({ file: 'no-such-file.json' });
  const client = new jev.CvJev({ cfg });
  const req = Q.buildSearchLevelRequest(cfg, 'Some Role');
  const r = await client.evaluate({ state: req.state, questions: req.questions, shape: Q.expectedShape(req.questions) });
  assert.equal(r.ok, true);
  const body = gw.stats().captured[0];
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.model, 'typesafe-ai/jev');
  const zdr = config.load({ file: 'no-such-file.json', overrides: { jev: { zeroDataRetention: true } } });
  await new jev.CvJev({ cfg: zdr }).evaluate({ state: req.state, questions: req.questions, shape: Q.expectedShape(req.questions) });
  assert.deepEqual(gw.stats().captured[1].providerOptions, { gateway: { zeroDataRetention: true } });
});

test('transport rules: 5xx and 429 are retried, 400 401 402 403 404 422 never', async () => {
  const cfg = config.load({ file: 'no-such-file.json' });
  const req = Q.buildSearchLevelRequest(cfg, 'Some Role');
  const shp = Q.expectedShape(req.questions);
  for (const [status, retried] of [[503, true], [500, true], [429, true], [408, true], [400, false], [401, false], [402, false], [403, false], [404, false], [422, false]]) {
    const g = await startFakeJev({ respond: () => ({ status, body: { message: 'x' } }) });
    home.point(g);
    const r = await new jev.CvJev({ cfg: config.load({ file: 'no-such-file.json' }) }).evaluate({ state: req.state, questions: req.questions, shape: shp });
    assert.equal(r.ok, false);
    assert.equal(g.stats().requests, retried ? 3 : 1, `status ${status}`);
    assert.equal(r.status, status);
    await g.close();
  }
  home.point(gw);
});

test('ask: an outage throws ScreeningUnavailable with the right reason key; invalid answers are asked again and returned, not thrown', async () => {
  const cfg = config.load({ file: 'no-such-file.json' });
  const req = Q.buildSearchLevelRequest(cfg, 'Some Role');
  const payload = { state: req.state, questions: req.questions, shape: Q.expectedShape(req.questions) };
  const fake = { calls: 0, evaluate: async () => { fake.calls++; return { ok: false, kind: 'invalid', code: 'missing', message: 'x' }; } };
  const r = await jev.ask(fake, payload, cfg, undefined, 'x');
  assert.equal(r.ok, false);
  assert.equal(fake.calls, 2, 'maxInvalidAttempts');
  for (const [kind, status, key] of [['auth', 401, 'auth'], ['credits', 402, 'credits'], ['transient', 503, 'error'], ['transient', 429, 'error'], ['transient', undefined, 'unreachable']]) {
    const f = { calls: 0, evaluate: async () => { f.calls++; return { ok: false, kind, status, message: `boom ${kind}` }; } };
    await assert.rejects(() => jev.ask(f, payload, cfg), e => e.name === 'ScreeningUnavailable' && e.reasonKey === key);
    assert.equal(f.calls, 1, `${kind} ${status} is never asked again`);
  }
  const aborted = { evaluate: async () => ({ ok: false, kind: 'aborted', message: 'aborted by caller' }) };
  await assert.rejects(() => jev.ask(aborted, payload, cfg), e => e.name === 'ScreeningUnavailable' && /time allowed/.test(e.detail));
});

test('the key never appears in an error, whatever the gateway echoes back', async () => {
  const echo = await startFakeJev({ key: 'right-key', respond: (idx, body, req) => ({ status: 401, body: { message: `bad key ${req.headers.authorization}` } }) });
  home.point({ origin: echo.origin, key: 'a-secret-key-value' });
  const cfg = config.load({ file: 'no-such-file.json' });
  const req = Q.buildSearchLevelRequest(cfg, 'Some Role');
  const r = await new jev.CvJev({ cfg }).evaluate({ state: req.state, questions: req.questions, shape: Q.expectedShape(req.questions) });
  const err = jev.unavailableFrom(r, 'cv');
  assert.equal(String(err.detail).includes('a-secret-key-value'), false);
  await echo.close();
  home.point(gw);
});

test('AnswersCache: hit, miss, expiry, the size cap and a damaged file', () => {
  const file = path.join(home.state, 'cv-answers.jsonl');
  let now = 1000000;
  const c = new cache.AnswersCache({ file, ttlSec: 10, maxEntries: 10, now: () => now });
  assert.equal(c.get('k1'), null);
  c.put('k1', { n: 1 });
  assert.deepEqual(c.get('k1'), { n: 1 });
  const again = new cache.AnswersCache({ file, ttlSec: 10, maxEntries: 10, now: () => now });
  assert.deepEqual(again.get('k1'), { n: 1 }, 'persisted');
  now += 11000;
  assert.equal(new cache.AnswersCache({ file, ttlSec: 10, maxEntries: 10, now: () => now }).get('k1'), null, 'expired');
  assert.equal(new cache.AnswersCache({ file, ttlSec: 0, maxEntries: 10 }).enabled, false);
  fs.appendFileSync(file, 'not json\n{"k":1}\n');
  assert.doesNotThrow(() => new cache.AnswersCache({ file, ttlSec: 10, maxEntries: 10, now: () => now }).get('x'));
  const big = new cache.AnswersCache({ file: path.join(home.state, 'big.jsonl'), ttlSec: 100, maxEntries: 10, now: () => now });
  for (let i = 0; i < 40; i++) { now += 1; big.put(`k${i}`, { i }); }
  const reload = new cache.AnswersCache({ file: path.join(home.state, 'big.jsonl'), ttlSec: 100, maxEntries: 10, now: () => now });
  assert.deepEqual(reload.get('k39'), { i: 39 });
  assert.equal(reload.map.size <= 10, true, 'compacted to the cap on load');
  assert.equal(fs.readFileSync(path.join(home.state, 'big.jsonl'), 'utf8').split('\n').filter(Boolean).length <= 10, true);
});

test('answersKey depends on the model, the questions and the state and on nothing else', () => {
  const a = cache.answersKey('m', 'q', { x: 1 });
  assert.equal(a, cache.answersKey('m', 'q', { x: 1 }));
  assert.notEqual(a, cache.answersKey('m2', 'q', { x: 1 }));
  assert.notEqual(a, cache.answersKey('m', 'q2', { x: 1 }));
  assert.notEqual(a, cache.answersKey('m', 'q', { x: 2 }));
});

test('SearchLevels: per title, normalised, and a new wording of the question starts a fresh store', () => {
  const file = path.join(home.state, 'levels.json');
  const s = new cache.SearchLevels({ file, qhash: 'h1' });
  assert.equal(s.get('Some  Role'), null);
  s.put('Some  Role', { p: { mid: 0.9 }, model: 'm' });
  assert.equal(new cache.SearchLevels({ file, qhash: 'h1' }).get('some role').p.mid, 0.9);
  assert.equal(new cache.SearchLevels({ file, qhash: 'h2' }).get('some role'), null);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).entries).includes('Some'), false, 'the title is stored lower-cased and normalised only as a key');
});

test('the invalid-answer streak counts, trips at the maximum, resets on a success and forgets after its time', () => {
  const file = path.join(home.runtime, 'streak.json');
  const o = { max: 3, ttlMs: 1000, file };
  assert.deepEqual(cache.recordStreak({ ...o, invalid: 1, successes: 0, now: 0 }), { count: 1, trip: false });
  assert.deepEqual(cache.recordStreak({ ...o, invalid: 1, successes: 0, now: 10 }), { count: 2, trip: false });
  assert.deepEqual(cache.recordStreak({ ...o, invalid: 1, successes: 0, now: 20 }), { count: 3, trip: true });
  assert.deepEqual(cache.recordStreak({ ...o, invalid: 0, successes: 1, now: 30 }), { count: 0, trip: false });
  assert.equal(fs.existsSync(file), false);
  cache.recordStreak({ ...o, invalid: 1, successes: 0, now: 40 });
  assert.deepEqual(cache.recordStreak({ ...o, invalid: 1, successes: 0, now: 5000 }), { count: 1, trip: false }, 'forgotten after the ttl');
});
