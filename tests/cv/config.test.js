'use strict';
// config/cv-screening.json: the shipped file equals the built-in defaults, unknown keys are ignored, wrong values are corrected to the
// defaults with a warning, a broken file is a fault (the defaults are shown for display only, nothing decides on them: fail closed, update C),
// environment settings win, and Jev is the only model.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-config');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../../resourcer/scripts/lib/cv/config');

test.after(() => home.cleanup());

const SHIPPED = path.join(__dirname, '..', '..', 'resourcer', 'config', 'cv-screening.json');
const load = (over, env) => config.load({ file: 'no-such-file.json', overrides: over, getEnv: n => (env || {})[n] });

test('the shipped config/cv-screening.json is the built-in defaults, so the two cannot drift', () => {
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.deepEqual(config.stripUnderscore(shipped), config.DEFAULTS);
  const cfg = config.load({ file: SHIPPED, getEnv: () => undefined });
  assert.deepEqual(cfg.warnings, []);
  assert.equal(cfg.configLoaded, true);
});

test('defaults: Jev only, concurrency 4, fallback policy approve, the 1:3 operating point, the alert ceilings, the cache lifetimes, retention 180 days', () => {
  const cfg = load();
  assert.equal(cfg.jev.model, 'typesafe-ai/jev');
  assert.equal(cfg.jev.concurrency, 4);
  assert.deepEqual(cfg.fallback, { policy: 'approve', keepJevReject: true });
  assert.deepEqual(cfg.operatingPoint, { costWasted: 1, costLost: 3, rejectAbove: 0.75 });
  assert.equal(cfg.tau, 0.75);
  assert.deepEqual(cfg.forced, { low: 0.2, high: 0.8 });
  assert.equal(cfg.evidence.minReadableChars, 120);
  assert.deepEqual(cfg.alerts, { rejectRateCeiling: 0.1, rejectRateMinCandidates: 10, fallbackRateCeiling: 0.05, fallbackMinCandidates: 20, forcedRateCeiling: 0.35, unreadableRateCeiling: 0.3 });
  assert.deepEqual(cfg.cache, { answersTtlSec: 604800, searchLevelTtlSec: 2592000, maxEntries: 2000 });
  assert.deepEqual(cfg.phase2, { shadowStopAfterFailures: 5, shadowMaxSeconds: 120 });
  assert.equal(cfg.shadow.retentionDays, 180);
  assert.equal(cfg.input.maxRoles, 16);
  assert.equal(cfg.input.maxYears, 15);
  assert.equal(cfg.input.maxDutiesChars, 200);
  assert.equal(cfg.facts.recentYears, 5);
  assert.equal(cfg.gateway.origin, 'https://ai-gateway.vercel.sh');
  for (const l of config.LEVEL_NAMES) assert.ok(cfg.levels[l], l);
  assert.ok(/^[0-9a-f]{12}$/.test(cfg.signature));
});

test('the owner file overrides only what it names; unknown keys are ignored with a warning; underscore keys are notes', () => {
  const file = path.join(home.root, 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ _note: 'x', levels: { mid: { minRelevantMonths: 24, typoKey: 1 } }, thresholds: { sameFieldMinLevel: 2 }, brandNewSection: { a: 1 } }));
  const cfg = config.load({ file, getEnv: () => undefined });
  assert.equal(cfg.levels.mid.minRelevantMonths, 24);
  assert.equal(cfg.levels.mid.relevantWindowYears, config.DEFAULTS.levels.mid.relevantWindowYears);
  assert.equal(cfg.thresholds.sameFieldMinLevel, 2);
  assert.equal(cfg.brandNewSection, undefined);
  assert.equal(cfg.warnings.filter(w => /unknown setting/.test(w)).length, 2);
});

test('a value of the wrong type or range is replaced by its default with a warning', () => {
  const cfg = load({ evidence: { parseFloor: 7, thinFullMonths: 'many' }, levels: { mid: { minRelevantMonths: -3, requireComparableOrSenior: 'yes' } }, alerts: { rejectRateCeiling: null }, fallback: { policy: 'maybe' }, operatingPoint: { costLost: 'lots', rejectAbove: 2 } });
  assert.equal(cfg.evidence.parseFloor, config.DEFAULTS.evidence.parseFloor);
  assert.equal(cfg.evidence.thinFullMonths, config.DEFAULTS.evidence.thinFullMonths);
  assert.equal(cfg.levels.mid.minRelevantMonths, config.DEFAULTS.levels.mid.minRelevantMonths);
  assert.equal(cfg.levels.mid.requireComparableOrSenior, true);
  assert.equal(cfg.alerts.rejectRateCeiling, 0.1);
  assert.equal(cfg.fallback.policy, 'approve');
  assert.equal(cfg.operatingPoint.costLost, 3);
  assert.equal(cfg.operatingPoint.rejectAbove, 0.75);
  assert.ok(cfg.warnings.length >= 7, cfg.warnings.join(' | '));
});

test('the operating point: rejectAbove wins, null derives it from the two costs, costs must be positive, the doubt band and weights must be ordered', () => {
  assert.equal(load().tau, 0.75);
  assert.equal(load({ operatingPoint: { rejectAbove: 0.6 } }).tau, 0.6);
  const derived = load({ operatingPoint: { rejectAbove: null, costWasted: 1, costLost: 3 } });
  assert.equal(derived.operatingPoint.rejectAbove, null);
  assert.equal(derived.tau, 0.75);
  assert.equal(load({ operatingPoint: { rejectAbove: null, costWasted: 2, costLost: 2 } }).tau, 0.5);
  assert.equal(load({ operatingPoint: { rejectAbove: null, costWasted: 1, costLost: 9 } }).tau, 0.9);
  const zero = load({ operatingPoint: { costLost: 0 } });
  assert.equal(zero.operatingPoint.costLost, 3);
  assert.ok(zero.warnings.length >= 1);
  const band = load({ forced: { low: 0.9, high: 0.1 } });
  assert.deepEqual(band.forced, { low: 0.2, high: 0.8 });
  assert.ok(band.warnings.some(w => /forced.low must be lower/.test(w)));
  const ev = load({ evidence: { parseFloor: 0.8, parseFull: 0.4, thinFloorMonths: 12, thinFullMonths: 6 } });
  assert.equal(ev.evidence.parseFull, config.DEFAULTS.evidence.parseFull);
  assert.equal(ev.evidence.thinFullMonths, config.DEFAULTS.evidence.thinFullMonths);
  assert.equal(ev.warnings.length, 2);
  const viaEnv = load(undefined, { CV_REJECT_ABOVE: '0.9' });
  assert.equal(viaEnv.tau, 0.9);
  const badEnv = load(undefined, { CV_REJECT_ABOVE: '7' });
  assert.equal(badEnv.tau, 0.75);
  assert.ok(badEnv.warnings.some(w => /CV_REJECT_ABOVE/.test(w)));
  assert.notEqual(load({ operatingPoint: { rejectAbove: 0.5 } }).signature, load().signature, 'the signature follows the operating point');
});

test('injection patterns: compiled once, a pattern that is not valid or matches nothing-at-all is dropped with a warning, the list is replaceable', () => {
  const cfg = load({ injection: { patterns: ['valid pattern', '(unclosed', 'x*', 'another one'] } });
  assert.equal(cfg.injectionRes.length, 2);
  assert.equal(cfg.warnings.length, 2);
  assert.ok(cfg.injectionRes.every(re => re instanceof RegExp));
  assert.ok(load().injectionRes.length >= 12, 'the shipped list');
  assert.equal(load({ injection: { patterns: [] } }).injectionRes.length, 0);
  assert.equal(load({ injection: { probability: 0.9 } }).injection.probability, 0.9);
});

test('a broken or unreadable file: the defaults for display only, a warning that says nothing is decided on them, a fault, never an exception', () => {
  for (const [name, text] of [['bad.json', '{ not json'], ['array.json', '[1,2]'], ['empty.json', '']]) {
    const file = path.join(home.root, name);
    fs.writeFileSync(file, text);
    const cfg = config.load({ file, getEnv: () => undefined });
    assert.deepEqual(config.stripUnderscore(cfg.levels), config.DEFAULTS.levels, name);
    assert.ok(cfg.warnings.some(w => /for display only, nothing is decided on them \(fail closed\)/.test(w)), name);
    assert.ok(cfg.fault && cfg.fault.key === 'cvconfig', `${name}: a fault, so nothing decides on the defaults`);
    assert.equal(cfg.configLoaded, false);
  }
  const missing = config.load({ file: path.join(home.root, 'absent.json'), getEnv: () => undefined });
  assert.deepEqual(missing.warnings, []);
  const named = config.load({ getEnv: n => (n === 'CV_SCREEN_CONFIG_FILE' ? path.join(home.root, 'absent.json') : undefined) });
  assert.ok(named.warnings.some(w => /named explicitly/.test(w)));
  // a section of the wrong type
  const file = path.join(home.root, 'section.json');
  fs.writeFileSync(file, JSON.stringify({ levels: 5, thresholds: [], questions: 'x' }));
  const cfg = config.load({ file, getEnv: () => undefined });
  assert.equal(cfg.levels.mid.minRelevantMonths, config.DEFAULTS.levels.mid.minRelevantMonths);
  assert.ok(cfg.warnings.length >= 3);
});

test('environment settings win over the file: fallback policy, gateway origin, concurrency, timeouts', () => {
  const cfg = load(undefined, {
    CV_FALLBACK_POLICY: 'reject', SCREEN_GATEWAY_ORIGIN: 'http://127.0.0.1:9999/', CV_SCREEN_CONCURRENCY: '2',
    SCREEN_JEV_TIMEOUT_MS: '500', SCREEN_MAX_ATTEMPTS: '2', SCREEN_BACKOFF_BASE_MS: '1', SCREEN_JEV_ZDR: '1',
  });
  assert.equal(cfg.fallback.policy, 'reject');
  assert.equal(cfg.gateway.origin, 'http://127.0.0.1:9999');
  assert.equal(cfg.jev.concurrency, 2);
  assert.equal(cfg.jev.timeoutMs, 500);
  assert.equal(cfg.jev.maxAttempts, 2);
  assert.equal(cfg.jev.zeroDataRetention, true);
  const bad = load(undefined, { CV_FALLBACK_POLICY: 'sometimes', SCREEN_GATEWAY_ORIGIN: 'http://example.com' });
  assert.equal(bad.fallback.policy, 'approve');
  assert.equal(bad.gateway.origin, 'https://ai-gateway.vercel.sh');
  assert.equal(bad.warnings.length, 2);
});

test('the gateway carries Jev only: another model name is replaced with a warning', () => {
  for (const name of ['anthropic/claude-sonnet-5.5', '', 42]) {
    const cfg = load({ jev: { model: name } });
    assert.equal(cfg.jev.model, 'typesafe-ai/jev');
  }
  const viaEnv = load(undefined, { SCREEN_JEV_MODEL: 'openai/gpt-x' });
  assert.equal(viaEnv.jev.model, 'typesafe-ai/jev');
  assert.ok(viaEnv.warnings.some(w => /not a Jev model/.test(w)));
});

test('the question wording must keep every option the code reads, else the built-in wording is used', () => {
  const q = JSON.parse(JSON.stringify(config.DEFAULTS.questions));
  delete q.roleSeniority.options.comparable;
  q.roleSeniority.options.one_step_junior = '';
  let cfg = load({ questions: q });
  assert.equal(cfg.questions.roleSeniority.options.comparable, config.DEFAULTS.questions.roleSeniority.options.comparable, 'a missing option keeps its default wording');
  assert.equal(cfg.questions.roleSeniority.options.one_step_junior, config.DEFAULTS.questions.roleSeniority.options.one_step_junior, 'an empty wording keeps its default');
  assert.ok(cfg.warnings.some(w => /must be a text/.test(w)));
  const q2 = JSON.parse(JSON.stringify(config.DEFAULTS.questions));
  q2.roleRelevance.levels = ['only one'];
  cfg = load({ questions: q2 });
  assert.deepEqual(cfg.questions, config.DEFAULTS.questions);
  assert.ok(cfg.warnings.some(w => /questions roleRelevance.levels needs 2 to 10 texts/.test(w)), cfg.warnings.join('|'));
  assert.equal(config.questionsProblem({ ...config.DEFAULTS.questions, ladder: '' }), 'ladder is empty');
  const q3 = JSON.parse(JSON.stringify(config.DEFAULTS.questions));
  q3.ladder = 'A shorter ladder text.';
  q3.roleRelevance.levels = ['No', 'Some', 'Much'];
  cfg = load({ questions: q3 });
  assert.equal(cfg.questions.ladder, 'A shorter ladder text.');
  assert.equal(cfg.questions.roleRelevance.levels.length, 3);
  assert.notEqual(cfg.signature, load().signature, 'the signature changes with the wording');
});

test('level tables: answers the code does not know are dropped, an empty comparable list is repaired, bad level indexes fall back', () => {
  const cfg = load({ levels: { mid: { relevantMinLevel: 9, seniority: { comparableOrSenior: [], tooJunior: ['one_step_junior', 'bogus', 'cannot_tell'] } } }, thresholds: { overallWeakMaxLevel: 9 } });
  assert.deepEqual(cfg.levels.mid.seniority.comparableOrSenior, config.DEFAULTS.levels.mid.seniority.comparableOrSenior);
  assert.deepEqual(cfg.levels.mid.seniority.tooJunior, ['one_step_junior']);
  assert.equal(cfg.levels.mid.relevantMinLevel, 2);
  assert.equal(cfg.thresholds.overallWeakMaxLevel, 1);
});

test('searchLevelOverrides: only known levels, titles are normalised', () => {
  const cfg = load({ searchLevelOverrides: { '  Kitchen   Manager ': 'head', 'Odd Role': 'galaxy', _x: 'head' } });
  assert.deepEqual(cfg.searchLevelOverrides, { 'kitchen manager': 'head' });
  assert.equal(cfg.warnings.length, 1);
});

test('CV_SCREEN: shadow by default, off, shadow and on are exact, a typo is shadow (never on) with a warning', () => {
  assert.deepEqual(config.screenMode(undefined), { mode: 'shadow', warning: null });
  assert.deepEqual(config.screenMode(null), { mode: 'shadow', warning: null });
  assert.deepEqual(config.screenMode(''), { mode: 'shadow', warning: null });
  assert.deepEqual(config.screenMode('   '), { mode: 'shadow', warning: null });
  assert.equal(config.DEFAULT_MODE, 'shadow');
  assert.equal(config.screenMode('shadow').mode, 'shadow');
  assert.equal(config.screenMode(' ON ').mode, 'on');
  assert.deepEqual(config.screenMode('off'), { mode: 'off', warning: null });
  for (const v of ['false', '0', 'no', 'none', 'disabled', 'OFF']) assert.deepEqual(config.screenMode(v), { mode: 'off', warning: null }, v);
  for (const v of ['onn', 'yes please', 'enable', 'true', '1']) {
    const typo = config.screenMode(v);
    assert.equal(typo.mode, 'shadow', v);
    assert.match(typo.warning, /runs in shadow mode \(it never blocks\)/);
  }
});

test('the two new settings are validated like every number: a search-level lifetime up to 30 days, at least one failure before a shadow queue stops', () => {
  assert.equal(load({ cache: { searchLevelTtlSec: 0 } }).cache.searchLevelTtlSec, 0);
  assert.equal(load({ cache: { searchLevelTtlSec: 86400 } }).cache.searchLevelTtlSec, 86400);
  const tooLong = load({ cache: { searchLevelTtlSec: 99999999 } });
  assert.equal(tooLong.cache.searchLevelTtlSec, 2592000);
  assert.ok(tooLong.warnings.some(w => /cache\.searchLevelTtlSec/.test(w)));
  assert.equal(load({ phase2: { shadowStopAfterFailures: 2 } }).phase2.shadowStopAfterFailures, 2);
  const zero = load({ phase2: { shadowStopAfterFailures: 0 } });
  assert.equal(zero.phase2.shadowStopAfterFailures, 1);
  assert.equal(load({ phase2: { shadowStopAfterFailures: 'many' } }).phase2.shadowStopAfterFailures, 5);
});

test('loading never mutates the shared defaults', () => {
  const before = JSON.stringify(config.DEFAULTS);
  const cfg = load({ levels: { mid: { minRelevantMonths: 99 } } });
  cfg.levels.mid.seniority.tooJunior.push('comparable');
  cfg.questions.ladder = 'changed';
  assert.equal(JSON.stringify(config.DEFAULTS), before);
  assert.throws(() => { 'use strict'; config.DEFAULTS.levels = {}; });
});

test('input limits: at most 12 roles are ever sent, whatever the file says', () => {
  assert.equal(load({ input: { maxRoles: 99 } }).input.maxRoles, config.DEFAULTS.input.maxRoles);
  assert.equal(load({ input: { maxRoles: 12 } }).input.maxRoles, 12);
  assert.equal(load({ input: { maxRoles: 20 } }).input.maxRoles, 20);
});
