'use strict';
// Configuration loading (defaults <- config/screening.json <- env) and the decision cache.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require(h.lib('screening/config'));
const { DecisionCache } = require(h.lib('screening/cache'));

const noEnv = () => undefined;
const withEnv = obj => n => obj[n];

test('config/screening.json is the owner-facing copy of the built-in defaults (no drift)', () => {
  const file = path.join(h.REPO, 'resourcer', 'config', 'screening.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.stripUnderscore(json), config.stripUnderscore(config.DEFAULTS));
  // the bar and the rules moved to screening-criteria.json: only the four keys decide() still reads are left, and they say so
  for (const st of ['stage1', 'stage2']) {
    assert.match(json.decide[st]._note, /screening-criteria.json/);
    assert.deepEqual(Object.keys(config.stripUnderscore(json.decide[st])).sort(), ['infoFloor', 'injectionP', 'notStatedP', 'titleConsistentMin'], st);
  }
  assert.equal(json.decide.ladder, undefined, 'the ladder of the retired design is gone');
  assert.equal(json.decide.calibration.calibrated, false);
  assert.deepEqual(json.stage1.rules, { 'S1-NA-NONHOSP': 'shadow', 'T-ENTRY-OVERQUAL-HEAD': 'off', 'T-ENTRY-OVERQUAL-SOUS': 'off', 'T-UNDER-GAP': 'off' }, 'no title table is consulted by default');
  assert.equal(json.engine, 'jev_only');
  assert.deepEqual(json.decide.reviewPolicy, { preUnlock: 'reject', postUnlock: 'approve' });
  assert.equal(json.tierMode, 'legacy');
});

test('defaults: jev_only, legacy tier mode, gateway origin, models, no ZDR, redaction on', () => {
  const c = config.load({ getEnv: noEnv, file: 'none.json' });
  assert.equal(c.engine, 'jev_only');
  assert.equal(c.engineEffective, 'jev_only');
  assert.deepEqual(c.decide.reviewPolicy, { preUnlock: 'reject', postUnlock: 'approve' });
  assert.equal(c.tierMode, 'legacy');
  assert.equal(c.gateway.origin, 'https://ai-gateway.vercel.sh');
  assert.equal(c.llm.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(c.jev.model, 'typesafe-ai/jev');
  assert.equal(c.redact.enabled, true);
  assert.equal(c.llm.zeroDataRetention, false);
  assert.equal(c.pageRetryPauseSec, 120);
  assert.equal(c.shadow.retentionDays, 180);
  assert.equal(c.shadow.storeText, true, 'D3: the redacted input is kept for gold-set labelling');
  assert.equal(c.batch.onInvalid, 'reject');
  assert.equal(c.stage1.rules['S1-NA-NONHOSP'], 'shadow', 'no stage-1 reject is enforced by default');
  assert.ok(Object.values(c.stage1.rules).every(m => m !== 'enforce'));
});

test('environment overrides', () => {
  const c = config.load({
    getEnv: withEnv({
      SCREEN_ENGINE: 'LLM', SCREEN_ALLOW_LLM: '1', SCREEN_TIER_MODE: 'fixed', SCREEN_GATEWAY_ORIGIN: 'http://127.0.0.1:1/', SCREEN_LLM_MODEL: 'x/y',
      SCREEN_CONCURRENCY: '3', SCREEN_LLM_CONCURRENCY: '2', SCREEN_MAX_ATTEMPTS: '5', SCREEN_BACKOFF_BASE_MS: '7',
      SCREEN_SHADOW_RATE: '0.25', SCREEN_REDACT: '0', SCREEN_CACHE_TTL_SEC: '60', SCREEN_STALE_RULE: '1', SCREEN_ZDR: 'true',
      SCREEN_PAGE_RETRY_PAUSE_SEC: '5', SCREEN_JEV_TIMEOUT_MS: '1234', SCREEN_LLM_TIMEOUT_MS: '4321', SCREEN_SHADOW_TEXT: '0',
    }),
    file: 'none.json',
  });
  assert.equal(c.engine, 'llm');
  assert.equal(c.tierMode, 'fixed');
  assert.equal(c.gateway.origin, 'http://127.0.0.1:1');
  assert.equal(c.llm.model, 'x/y');
  assert.equal(c.jev.concurrency, 3);
  assert.equal(c.llm.concurrency, 2);
  assert.equal(c.llm.maxAttempts, 5);
  assert.equal(c.jev.maxAttempts, 5);
  assert.equal(c.retry.baseMs, 7);
  assert.equal(c.shadow.rate, 0.25);
  assert.equal(c.redact.enabled, false);
  assert.equal(c.cache.ttlSec, 60);
  assert.equal(c.rubric.staleProfileClause, true);
  assert.equal(c.jev.zeroDataRetention, true);
  assert.equal(c.llm.zeroDataRetention, true);
  assert.equal(c.pageRetryPauseSec, 5);
  assert.equal(c.jev.timeoutMs, 1234);
  assert.equal(c.llm.timeoutMs, 4321);
  assert.equal(c.shadow.storeText, false);
});

test('bad values never crash: they fall back to safe defaults with a warning', () => {
  const c = config.load({ getEnv: withEnv({ SCREEN_ENGINE: 'bogus', SCREEN_TIER_MODE: 'bogus', SCREEN_CONCURRENCY: 'abc', SCREEN_SHADOW_RATE: '9' }), file: 'none.json' });
  assert.equal(c.engine, 'jev_only');
  assert.equal(c.tierMode, 'legacy');
  assert.equal(c.jev.concurrency, 6);
  assert.equal(c.shadow.rate, 1);
  assert.equal(c.warnings.length, 2);
});

test('a corrupt config file falls back to built-in defaults with a warning', () => {
  const f = path.join(h.HOME, 'corrupt.json');
  fs.writeFileSync(f, '{oops');
  const c = config.load({ getEnv: noEnv, file: f });
  assert.equal(c.engine, 'jev_only');
  assert.ok(c.warnings.some(w => /unreadable/.test(w)));
});

test('file values override defaults; env overrides the file; underscore keys are ignored', () => {
  const f = h.writeConfig({ _readme: 'x', engine: 'llm', llm: { model: 'file/model', timeoutMs: 5000 }, stage1: { rules: { 'S1-NA-NONHOSP': 'enforce' } } });
  const a = config.load({ getEnv: noEnv, file: f });
  assert.equal(a.engine, 'llm');
  assert.equal(a.llm.model, 'file/model');
  assert.equal(a.llm.timeoutMs, 5000);
  assert.equal(a.llm.backupModel, 'anthropic/claude-sonnet-5', 'unspecified keys keep their defaults');
  assert.equal(a.stage1.rules['S1-NA-NONHOSP'], 'enforce');
  const b = config.load({ getEnv: withEnv({ SCREEN_ENGINE: 'jev_shadow', SCREEN_LLM_MODEL: 'env/model' }), file: f });
  assert.equal(b.engine, 'jev_shadow');
  assert.equal(b.llm.model, 'env/model');
  assert.equal(config.DEFAULTS.llm.model, 'anthropic/claude-sonnet-5.5', 'DEFAULTS is never mutated');
});

test('safety: engine=jev only decides once the thresholds are marked calibrated', () => {
  const a = config.load({ getEnv: withEnv({ SCREEN_ENGINE: 'jev', SCREEN_ALLOW_LLM: '1' }), file: 'none.json' });
  assert.equal(a.engineRequested, 'jev');
  assert.equal(a.engineEffective, 'jev_shadow');
  assert.ok(a.warnings.some(w => /calibrated/.test(w)));
  const b = config.load({ getEnv: withEnv({ SCREEN_ENGINE: 'jev', SCREEN_ALLOW_LLM: '1', SCREEN_CALIBRATED: '1' }), file: 'none.json' });
  assert.equal(b.engineEffective, 'jev');
  assert.equal(b.warnings.length, 0);
});

test('unknown stage-1 rule modes fall back to shadow', () => {
  const f = h.writeConfig({ stage1: { rules: { 'S1-NA-NONHOSP': 'always' } } });
  const c = config.load({ getEnv: noEnv, file: f });
  assert.equal(c.stage1.rules['S1-NA-NONHOSP'], 'shadow');
  assert.equal(c.warnings.length, 1);
});

test('cache: stores decisions only, honours the TTL and the size cap', () => {
  const file = path.join(h.HOME, 'cache-test.json');
  let now = 1000000;
  const c = new DecisionCache({ file, ttlSec: 10, maxEntries: 3, now: () => now });
  const k1 = DecisionCache.key({ sig: 's', job: 'Chef', stage: 'pre_unlock', text: 'SECRET SNIPPET TEXT' });
  assert.equal(c.get(k1), null);
  c.set(k1, { a: 1, rc: 'approve_other', cf: 0.9, m: 'm' });
  assert.equal(c.get(k1).a, 1);
  assert.ok(c.save());
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SECRET SNIPPET TEXT'), 'no snippet text on disk');
  const c2 = new DecisionCache({ file, ttlSec: 10, maxEntries: 3, now: () => now });
  assert.equal(c2.get(k1).rc, 'approve_other', 'persists across processes');
  now += 11000;
  const c3 = new DecisionCache({ file, ttlSec: 10, maxEntries: 3, now: () => now });
  assert.equal(c3.get(k1), null, 'expired');
  for (let i = 0; i < 6; i++) { now += 1; c3.set(`k${i}`, { a: 0, rc: 'reject_other', cf: null, m: 'm' }); }
  c3.save();
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries).length <= 3);
});

test('cache: a different signature (models, rubric, thresholds) is a different key; ttl 0 disables', () => {
  const a = DecisionCache.key({ sig: 'A', job: 'Chef', stage: 'pre_unlock', text: 't' });
  const b = DecisionCache.key({ sig: 'B', job: 'Chef', stage: 'pre_unlock', text: 't' });
  const c = DecisionCache.key({ sig: 'A', job: 'Cook', stage: 'pre_unlock', text: 't' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  const off = new DecisionCache({ file: path.join(h.HOME, 'off.json'), ttlSec: 0, maxEntries: 5 });
  off.set(a, { a: 1 });
  assert.equal(off.get(a), null);
  assert.equal(off.save(), false);
  assert.ok(!fs.existsSync(path.join(h.HOME, 'off.json')));
});

test('config hardening: file values are normalised, wrong-typed sections and bad thresholds fall back with a warning', () => {
  const f = h.writeConfig({ engine: ' LLM ', tierMode: 'FIXED', llm: null, shadow: null, batch: null, cache: null, redact: null, stage1: null, decide: { stage1: { infoFloor: null, notStatedP: 2, injectionP: 'x', titleConsistentMin: '' } } });
  const c = config.load({ getEnv: noEnv, file: f });
  assert.equal(c.engine, 'llm', 'a file value is trimmed and lower-cased like the environment one');
  assert.equal(c.tierMode, 'fixed');
  assert.equal(c.llm.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(c.batch.breakerConsecutive, 3);
  assert.equal(c.cache.ttlSec, 3600);
  assert.equal(c.redact.enabled, true);
  assert.equal(c.decide.stage1.infoFloor, 0.5, 'null would have turned the empty-profile floor off');
  assert.equal(c.decide.stage1.notStatedP, 0.5, 'a value above 1 is out of range');
  assert.equal(c.decide.stage1.injectionP, 0.7, 'a text would have disabled the injection guard');
  assert.equal(c.decide.stage1.titleConsistentMin, 0.3);
  for (const s of ['llm', 'shadow', 'batch', 'cache', 'redact', 'stage1']) assert.ok(c.warnings.some(w => w.includes('section ' + s)), s);
  assert.ok(c.warnings.some(w => /decide.stage1.infoFloor/.test(w)));
  const arr = config.load({ getEnv: noEnv, file: h.writeConfig({ decide: [] }) });
  assert.equal(arr.decide.stage2.injectionP, 0.7);
});

// the file of Update A (and of the first release) still holds the ladder and the old bars: it must load, keep working and name what is dead
const OLD_DECIDE = {
  stage1: { rejectP: 0.9, approveP: 0.6, needCorroboration: true, notFitMin: 0.6, counterRoleMatch: 0.6, noInfoApproveHospP: 0.5, clearFitP: 0.6, clearFitHardMax: 0.5, approveNotFitMax: 0.5, injectionP: 0.6 },
  stage2: { rejectP: 0.95, approveP: 0.5 },
  ladder: { tier0Titles: ['waiter'], bySearchTier: { 0: { inBand: ['front_of_house'] } }, overrides: [{ name: 'mine', tiers: [2], matchAny: ['pastry'] }] },
};

test('an old-design file loads: retired keys are ignored and named in one warning, the keys still read keep their effect', () => {
  const c = config.load({ getEnv: noEnv, file: h.writeRawConfig({ decide: OLD_DECIDE }) });
  assert.equal(c.decide.stage1.injectionP, 0.6, 'a key decide() still reads keeps its effect');
  assert.equal(c.decide.stage1.infoFloor, 0.5);
  const line = c.warnings.filter(w => /not read any more/.test(w));
  assert.equal(line.length, 1, c.warnings.join(' | '));
  for (const k of ['decide.ladder', 'decide.stage1.rejectP', 'decide.stage1.approveP', 'decide.stage1.clearFitHardMax', 'decide.stage2.rejectP']) assert.ok(line[0].includes(k), k);
  assert.ok(!line[0].includes('injectionP'), 'a key that is still read is not named');
  assert.match(line[0], /screening-criteria.json/);
  assert.equal(c.engineEffective, 'jev_only');
  assert.equal(config.load({ getEnv: noEnv, file: 'none.json' }).warnings.length, 0, 'the built-in defaults and the shipped file are silent');
  assert.equal(config.load({ getEnv: noEnv, file: path.join(h.REPO, 'resourcer', 'config', 'screening.json') }).warnings.length, 0);
});

test('an old-design file with a wrong-typed ladder or retired bars never crashes the loader and never changes how a card is decided', () => {
  for (const ladder of [null, [], 'x', 7, { bySearchTier: null }, { bySearchTier: { 2: 'sous' } }, { tier0Titles: 'waiter' }, { overrides: 'x' }, { overrides: [null] }]) {
    for (const bar of [null, 'x', 5, -1]) {
      const c = config.load({ getEnv: noEnv, file: h.writeRawConfig({ decide: { ladder, stage1: { rejectP: bar, approveP: bar } } }) });
      assert.equal(c.engineEffective, 'jev_only');
      assert.equal(c.decide.stage1.injectionP, 0.7);
      assert.ok(c.warnings.some(w => /not read any more/.test(w)), JSON.stringify(ladder));
      assert.equal(c.warnings.filter(w => /ladder|rejectP|approveP/.test(w) && !/not read any more/.test(w)).length, 0, 'no per-key repair warnings for retired keys');
    }
  }
});

test('config hardening: empty model names, a missing explicit config file, and the gateway origin', () => {
  const m = config.load({ getEnv: noEnv, file: h.writeConfig({ llm: { model: '', backupModel: '  ' }, jev: { model: null } }) });
  assert.equal(m.llm.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(m.llm.backupModel, null);
  assert.equal(m.jev.model, 'typesafe-ai/jev');
  assert.ok(m.warnings.some(w => /llm.model is empty/.test(w)) && m.warnings.some(w => /jev.model is empty/.test(w)));
  const gone = config.load({ getEnv: withEnv({ SCREEN_CONFIG_FILE: path.join(h.HOME, 'not-there.json') }) });
  assert.ok(gone.warnings.some(w => /named explicitly but does not exist/.test(w)));
  assert.equal(config.load({ getEnv: noEnv, file: 'none.json' }).warnings.length, 0, 'the default file being absent stays silent');
  for (const origin of ['http://ai-gateway.example', 'ftp://x', 'not a url', 'http://127.0.0.1.evil.example']) {
    const c = config.load({ getEnv: withEnv({ SCREEN_GATEWAY_ORIGIN: origin }), file: 'none.json' });
    assert.equal(c.gateway.origin, 'https://ai-gateway.vercel.sh', origin);
    assert.ok(c.warnings.some(w => /gateway.origin/.test(w)), origin);
  }
  for (const origin of ['https://ai-gateway.vercel.sh', 'https://gw.example/base', 'http://127.0.0.1:8080', 'http://localhost:9']) {
    assert.equal(config.load({ getEnv: withEnv({ SCREEN_GATEWAY_ORIGIN: origin }), file: 'none.json' }).gateway.origin, origin);
  }
});

test('zero data retention: the language model and Jev can be switched separately; SCREEN_ZDR still sets both', () => {
  const both = config.load({ getEnv: withEnv({ SCREEN_ZDR: '1' }), file: 'none.json' });
  assert.deepEqual([both.llm.zeroDataRetention, both.jev.zeroDataRetention], [true, true]);
  const jevOnly = config.load({ getEnv: withEnv({ SCREEN_JEV_ZDR: '1' }), file: 'none.json' });
  assert.deepEqual([jevOnly.llm.zeroDataRetention, jevOnly.jev.zeroDataRetention], [false, true]);
  const llmOnly = config.load({ getEnv: withEnv({ SCREEN_ZDR: '1', SCREEN_LLM_ZDR: '0' }), file: 'none.json' });
  assert.deepEqual([llmOnly.llm.zeroDataRetention, llmOnly.jev.zeroDataRetention], [false, true], 'a specific switch beats the shared one');
});

test('with redaction off the shadow log never stores snippet text', () => {
  const c = config.load({ getEnv: withEnv({ SCREEN_REDACT: '0' }), file: 'none.json' });
  assert.equal(c.shadow.storeText, false);
  assert.ok(c.warnings.some(w => /storeText forced off/.test(w)));
  assert.equal(config.load({ getEnv: noEnv, file: 'none.json' }).shadow.storeText, true);
});

test('an environment override on a section that is null in the file does not crash the loader', () => {
  const f = h.writeConfig({ jev: null, gateway: null, shadow: null, llm: null });
  const c = config.load({ getEnv: withEnv({ SCREEN_CONCURRENCY: '3', SCREEN_GATEWAY_ORIGIN: 'https://gw.example', SCREEN_SHADOW_RATE: '0.5', SCREEN_MAX_ATTEMPTS: '2' }), file: f });
  assert.equal(c.jev.concurrency, 3);
  assert.equal(c.gateway.origin, 'https://gw.example');
  assert.equal(c.shadow.rate, 0.5);
  assert.equal(c.llm.maxAttempts, 2);
});
