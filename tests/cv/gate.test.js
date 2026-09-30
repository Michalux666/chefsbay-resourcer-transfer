'use strict';
// Gate: table tests for every rule and every operating-point path. The gate is pure (answers and facts in, decision out) and
// FORCED CHOICE: it always returns pass or reject from one number, pReject, and one operating point.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-gate');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../resourcer/scripts/lib/cv/config');
const facts = require('../../resourcer/scripts/lib/cv/facts');
const gate = require('../../resourcer/scripts/lib/cv/gate');
const { NOW } = require('./helpers/fixtures');

test.after(() => home.cleanup());

const SEN = ['much_more_junior', 'one_step_junior', 'comparable', 'one_step_senior', 'two_or_more_steps_senior', 'cannot_tell'];

function spread(keys, main, top) {
  const t = top === undefined ? 1 : top;
  const rest = keys.filter(k => k !== main);
  const p = {};
  for (const k of keys) p[k] = k === main ? t : (1 - t) / rest.length;
  return p;
}

const lvl = (n, main, top) => spread(Array.from({ length: n }, (_, i) => String(i)), String(main), top);
const CFG = config.load({ file: 'no-such-file.json', getEnv: () => undefined });

// spec: {title, start, end, rel: 0..3 | number[4], sen: option | object}
function build(level, specs, o) {
  const opts = o || {};
  const cfg = opts.cfg || CFG;
  const record = { parseConfidence: opts.parse === undefined ? 0.9 : opts.parse, roles: specs.map((s, i) => ({ title: `Role ${i}`, employer: 'Employer', start: s.start, end: s.end, duties: ['duty'] })) };
  const f = facts.buildFacts(record, cfg, NOW);
  const byTitle = t => specs[Number(String(t).replace('Role ', ''))];
  const answers = {
    relevance: f.roles.map(r => { const s = byTitle(r.title); return { p: Array.isArray(s.rel) ? Object.fromEntries(s.rel.map((v, i) => [String(i), v])) : lvl(4, s.rel === undefined ? 3 : s.rel) }; }),
    seniority: f.roles.map(r => { const s = byTitle(r.title); return { p: typeof s.sen === 'object' ? s.sen : spread(SEN, s.sen || 'comparable') }; }),
    overall: { p: Array.isArray(opts.overall) ? Object.fromEntries(opts.overall.map((v, i) => [String(i), v])) : lvl(4, opts.overall === undefined ? 3 : opts.overall) },
    progression: { p: spread(['rising', 'stable', 'declining', 'unclear'], 'stable') },
    careerChange: opts.cc === undefined ? 0 : opts.cc,
    injection: opts.inj === undefined ? 0 : opts.inj,
  };
  return { facts: f, answers, level, levelDist: opts.dist, levelP: 1, cfg, tau: opts.tau };
}

const run = (level, specs, o) => gate.evaluate(build(level, specs, o));
const over = o => config.load({ file: 'no-such-file.json', overrides: o, getEnv: () => undefined });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.006, `${msg || ''} ${a} vs ${b}`);

// a relevant, comparable role that ran for a long time up to now
const GOOD = { start: '2020-01', end: 'present', rel: 3, sen: 'comparable' };
const RETAIL = { start: '2015-01', end: 'present', rel: 0, sen: 'cannot_tell' };

test('the decision is only ever pass or reject and never abstains: a grid of random answers under every level and operating point', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const dist = (keys) => { const w = keys.map(() => rnd() ** 3); const s = w.reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(keys.map((k, i) => [k, w[i] / s])); };
  const levels = ['entry', 'mid', 'senior', 'head', 'not_a_kitchen_role', 'unknown'];
  let rejects = 0;
  for (let n = 0; n < 1500; n++) {
    const count = 1 + Math.floor(rnd() * 6);
    const specs = Array.from({ length: count }, () => {
      const start = 2005 + Math.floor(rnd() * 20);
      const dur = 1 + Math.floor(rnd() * 8);
      const endY = Math.min(2026, start + dur);
      return { start: `${start}-0${1 + Math.floor(rnd() * 9)}`, end: endY >= 2026 && rnd() < 0.5 ? 'present' : `${endY}-0${1 + Math.floor(rnd() * 9)}`, rel: Object.values(dist(['0', '1', '2', '3'])), sen: dist(SEN) };
    });
    const level = levels[Math.floor(rnd() * levels.length)];
    const tau = rnd();
    const r = run(level, specs, { overall: Object.values(dist(['0', '1', '2', '3'])), cc: rnd(), parse: rnd(), tau, dist: dist(levels) });
    assert.ok(r.decision === 'pass' || r.decision === 'reject', r.decision);
    assert.ok(r.pReject >= 0 && r.pReject <= 1, `pReject ${r.pReject}`);
    if (Math.abs(r.pReject - tau) > 0.0006) assert.equal(r.decision === 'reject', r.pReject >= tau - 1e-9, 'the decision is the operating point applied to pReject (pReject is reported to three decimals)');
    assert.equal(typeof r.forced, 'boolean');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(r.reasonCodes.length >= 1);
    for (const v of Object.values(r.evidence)) assert.equal(typeof v, 'number');
    if (r.decision === 'reject') rejects++;
  }
  assert.ok(rejects > 50 && rejects < 1450, `both sides are used (${rejects})`);
});

test('more tolerance never rejects more: raising the operating point only moves decisions from reject to pass', () => {
  const specs = [{ start: '2019-01', end: 'present', rel: [0.2, 0.5, 0.2, 0.1], sen: spread(SEN, 'one_step_junior', 0.6) }];
  let last = 'reject';
  for (let tau = 0.05; tau <= 0.96; tau += 0.05) {
    const d = run('mid', specs, { overall: [0.3, 0.3, 0.2, 0.2], cc: 0.4, tau }).decision;
    if (last === 'pass') assert.equal(d, 'pass', `tau ${tau}`);
    last = d;
  }
});

test('pass: relevant, recent, comparable history passes at every level with the plain code and no forced marker', () => {
  for (const level of ['entry', 'mid', 'senior', 'head', 'not_a_kitchen_role', 'unknown']) {
    const r = run(level, [GOOD]);
    assert.equal(r.decision, 'pass', level);
    assert.deepEqual(r.reasonCodes, ['pass_relevant_history'], level);
    assert.equal(r.forced, false);
    assert.equal(r.pReject, 0);
    assert.equal(r.confidence, 1);
  }
});

test('operating point: a reject needs pReject at or above tau; the default tau is costLost / (costLost + costWasted) = 0.75', () => {
  assert.equal(CFG.tau, 0.75);
  assert.equal(config.operatingTau({ costWasted: 1, costLost: 3, rejectAbove: null }), 0.75);
  assert.equal(config.operatingTau({ costWasted: 1, costLost: 1, rejectAbove: null }), 0.5);
  assert.equal(config.operatingTau({ costWasted: 3, costLost: 1, rejectAbove: null }), 0.25);
  assert.equal(config.operatingTau({ costWasted: 1, costLost: 3, rejectAbove: 0.4 }), 0.4);
  const f = { low: 0.2, high: 0.8 };
  const table = [[0, 0.75, 'pass'], [0.5, 0.75, 'pass'], [0.749, 0.75, 'pass'], [0.75, 0.75, 'reject'], [1, 0.75, 'reject'], [0.5, 0.5, 'reject'], [0.49, 0.5, 'pass'], [0.3, 0.25, 'reject'], [0.1, 0.05, 'reject']];
  for (const [p, tau, want] of table) assert.equal(gate.applyOperatingPoint(p, tau, f).decision, want, `${p} at ${tau}`);
});

test('forced marker: a decision inside the doubt band carries forced and its confidence, on either side', () => {
  const f = { low: 0.2, high: 0.8 };
  assert.deepEqual(gate.applyOperatingPoint(0.6, 0.75, f), { decision: 'pass', forced: true, confidence: 0.4 });
  assert.deepEqual(gate.applyOperatingPoint(0.78, 0.75, f), { decision: 'reject', forced: true, confidence: 0.78 });
  assert.deepEqual(gate.applyOperatingPoint(0.95, 0.75, f), { decision: 'reject', forced: false, confidence: 0.95 });
  assert.deepEqual(gate.applyOperatingPoint(0.1, 0.75, f), { decision: 'pass', forced: false, confidence: 0.9 });
  assert.equal(gate.applyOperatingPoint(0.2, 0.75, f).forced, true, 'the band edges are inside');
  assert.equal(gate.applyOperatingPoint(0.8, 0.75, f).forced, true);
});

test('doubt leans pass: with the default costs a mismatch that is only 60 percent likely is a forced pass, at equal costs it is a reject', () => {
  const specs = [{ ...RETAIL }];
  const answers = { overall: [0.6, 0.0, 0.2, 0.2], cc: 0.6 };
  const asIs = run('mid', specs, answers);
  near(asIs.pReject, 0.6);
  assert.equal(asIs.decision, 'pass');
  assert.equal(asIs.forced, true);
  assert.deepEqual(asIs.reasonCodes.slice(0, 3), ['forced', 'pass_doubt', 'no_relevant_experience']);
  near(asIs.confidence, 0.4);
  const equalCosts = run('mid', specs, { ...answers, tau: config.operatingTau({ costWasted: 1, costLost: 1, rejectAbove: null }) });
  assert.equal(equalCosts.decision, 'reject');
  assert.equal(equalCosts.forced, true, 'the same doubt, still marked');
});

test('rule no_relevant_experience: reject with an agreeing whole-history answer, add career_change when that answer leads', () => {
  let r = run('mid', [RETAIL], { overall: 0, cc: 0.9 });
  assert.deepEqual([r.decision, r.reasonCodes, r.pReject], ['reject', ['no_relevant_experience', 'career_change'], 1]);
  r = run('mid', [RETAIL], { overall: 0, cc: 0.1 });
  assert.deepEqual([r.decision, r.reasonCodes], ['reject', ['no_relevant_experience']]);
  r = run('mid', [RETAIL], { overall: [0.2, 0.3, 0.3, 0.2], cc: 0.9 });
  assert.deepEqual([r.decision, r.reasonCodes], ['reject', ['no_relevant_experience', 'career_change']]);
  const noCc = over({ levels: { mid: { rejects: { careerChange: false } } } });
  r = run('mid', [RETAIL], { overall: [0.2, 0.3, 0.3, 0.2], cc: 1, cfg: noCc });
  assert.equal(r.decision, 'pass', 'with the career-change switch off only the overall answer counts');
});

test('rule no_relevant_experience: contradicting whole-history answers make it a pass (nothing to agree with the roles)', () => {
  const r = run('mid', [RETAIL], { overall: 3, cc: 0.03 });
  assert.equal(r.decision, 'pass');
  assert.ok(r.pReject < 0.1);
  assert.equal(r.evidence.overallStrongP, 1);
});

test('rule no_relevant_experience: months of relevant work are counted by code, exact over the chance that each role is relevant', () => {
  // ten months of relevant work against a minimum of 6 months (mid): enough
  const ok = run('mid', [{ start: '2025-11', end: '2026-08', rel: 3, sen: 'comparable' }, RETAIL], { overall: 0, cc: 0.9 });
  assert.equal(ok.evidence.relevantMonths, 10);
  assert.equal(ok.decision, 'pass');
  // the same role, but only 60 percent likely to be relevant: 40 percent chance the months are missing, times the agreement
  const half = run('mid', [{ start: '2025-11', end: '2026-08', rel: [0.4, 0, 0, 0.6], sen: 'comparable' }, RETAIL], { overall: 0, cc: 1 });
  near(half.pReject, 0.4);
  assert.equal(half.decision, 'pass');
  // overlapping roles are one stretch of time
  const overlap = run('mid', [{ start: '2026-04', end: 'present', rel: 3, sen: 'comparable' }, { start: '2026-03', end: '2026-08', rel: 3, sen: 'comparable' }, RETAIL], { overall: 0, cc: 0.9 });
  assert.equal(overlap.evidence.relevantMonths, 7);
  // work older than the window does not count (mid: 12 years)
  const old = run('mid', [{ start: '2005-01', end: '2007-12', rel: 3, sen: 'comparable' }, RETAIL], { overall: 0, cc: 0.9 });
  assert.equal(old.decision, 'reject');
});

test('thin evidence weakens the amount rules only: a very short history is a pass, a longer one is not', () => {
  const short = run('mid', [{ start: '2026-07', end: 'present', rel: 0, sen: 'cannot_tell' }], { overall: 0, cc: 0.9 });
  assert.equal(short.evidence.totalMonths, 3);
  assert.equal(short.evidence.thinWeight, 0);
  assert.equal(short.decision, 'pass');
  assert.ok(short.reasonCodes.includes('thin_evidence'));
  const six = run('mid', [{ start: '2026-04', end: 'present', rel: 0, sen: 'cannot_tell' }], { overall: 0, cc: 0.9 });
  near(six.evidence.thinWeight, 0.5);
  near(six.pReject, 0.5);
  assert.equal(six.forced, true);
  const nine = run('mid', [{ start: '2025-12', end: 'present', rel: 0, sen: 'cannot_tell' }], { overall: 0, cc: 0.9 });
  assert.equal(nine.evidence.thinWeight, 1);
  assert.equal(nine.decision, 'reject');
  // the level rules stand on their own even for a short history
  const junior = run('senior', [{ start: '2026-07', end: 'present', rel: 3, sen: 'much_more_junior' }], { overall: 3 });
  assert.deepEqual([junior.decision, junior.reasonCodes], ['reject', ['under_qualified']]);
});

test('parse quality: a badly read CV is never rejected on its own, a well read one counts fully, in between counts in proportion', () => {
  const hard = { overall: 0, cc: 0.9 };
  const [low, mid, high] = [0.1, 0.4, 0.9].map(parse => run('mid', [RETAIL], { ...hard, parse }));
  assert.deepEqual([low.decision, low.evidence.parseWeight, low.pReject], ['pass', 0, 0]);
  assert.ok(low.reasonCodes.includes('parse_low_confidence'));
  near(mid.evidence.parseWeight, 0.5);
  near(mid.pReject, 0.5);
  assert.equal(mid.decision, 'pass');
  assert.equal(mid.forced, true);
  assert.deepEqual([high.decision, high.evidence.parseWeight], ['reject', 1]);
  const unknown = run('mid', [RETAIL], { ...hard, parse: null });
  assert.equal(unknown.evidence.parseWeight, 1, 'an unknown confidence is not held against the CV');
  assert.equal(gate.parseWeight(0.3, CFG.evidence), 0);
  assert.equal(gate.parseWeight(0.5, CFG.evidence), 1);
  assert.equal(gate.thinWeight(3, CFG.evidence), 0);
  assert.equal(gate.thinWeight(9, CFG.evidence), 1);
});

test('roles without dates: a relevant undated role counts for undatedCreditMonths, an irrelevant undated history is too thin to reject', () => {
  const undated = run('mid', [{ start: null, end: null, rel: 3, sen: 'comparable' }], { overall: 3 });
  assert.equal(undated.decision, 'pass');
  assert.equal(undated.evidence.undatedRoles, 1);
  const noCredit = run('mid', [{ start: null, end: null, rel: 3, sen: 'comparable' }], { overall: 0, cc: 0.9, cfg: over({ evidence: { undatedCreditMonths: 0 } }) });
  assert.equal(noCredit.decision, 'pass', 'no dates at all means no total months, so the amount rules do not count');
  const irrelevantUndated = run('mid', [{ start: null, end: null, rel: 0, sen: 'cannot_tell' }], { overall: 0, cc: 0.9 });
  assert.equal(irrelevantUndated.decision, 'pass');
});

test('rule stale_experience: relevant work that ended too long ago is a reject, recent or uncertain recent work is not', () => {
  const old = { start: '2008-01', end: '2013-01', rel: 3, sen: 'comparable' };
  let r = run('mid', [old], { overall: 3 });
  assert.deepEqual([r.decision, r.reasonCodes], ['reject', ['stale_experience']]);
  const recentUncertain = { start: '2024-01', end: 'present', rel: [0.3, 0.3, 0.3, 0.1], sen: 'cannot_tell' };
  r = run('mid', [recentUncertain, old], { overall: 3 });
  assert.equal(r.decision, 'pass');
  assert.equal(r.forced, true, 'a 40 percent chance that the recent role is relevant is real doubt');
  r = run('mid', [{ start: '2019-01', end: '2020-01', rel: 3, sen: 'comparable' }], { overall: 3 });
  assert.notEqual(r.reasonCodes[0], 'stale_experience', 'six years ago is not stale at ten');
  r = run('mid', [old], { overall: 3, cfg: over({ levels: { mid: { rejects: { stale: false } } } }) });
  assert.equal(r.decision, 'pass');
});

test('rule over_qualified: entry searches reject recent roles two or more steps senior, other levels never do', () => {
  const head = { start: '2015-01', end: 'present', rel: 2, sen: 'two_or_more_steps_senior' };
  const r = run('entry', [head], { overall: 2 });
  assert.deepEqual([r.decision, r.reasonCodes], ['reject', ['over_qualified']]);
  for (const level of ['mid', 'senior', 'head', 'not_a_kitchen_role', 'unknown']) assert.equal(run(level, [head], { overall: 2 }).decision, 'pass', level);
  const both = run('entry', [{ start: '2024-01', end: 'present', rel: 3, sen: 'comparable' }, { start: '2010-01', end: '2023-12', rel: 2, sen: 'two_or_more_steps_senior' }], { overall: 3 });
  assert.equal(both.decision, 'pass', 'a recent role at the searched level shows the person accepts this work');
  const mixed = run('entry', [{ start: '2015-01', end: 'present', rel: 2, sen: 'two_or_more_steps_senior' }, { start: '2025-01', end: 'present', rel: 3, sen: 'comparable' }], { overall: 3 });
  assert.equal(mixed.decision, 'pass');
  const unsure = run('entry', [{ start: '2015-01', end: 'present', rel: 2, sen: spread(SEN, 'two_or_more_steps_senior', 0.6) }], { overall: 2 });
  assert.equal(unsure.decision, 'pass', 'a 60 percent chance is doubt, and doubt leans pass');
  assert.equal(unsure.forced, true);
  assert.ok(unsure.reasonCodes.includes('over_qualified'));
  assert.equal(run('entry', [{ start: '2015-01', end: 'present', rel: 3, sen: 'one_step_senior' }]).decision, 'pass', 'one step up is fine');
  const notRecent = run('entry', [{ start: '2005-01', end: '2015-01', rel: 2, sen: 'two_or_more_steps_senior' }, { start: '2015-02', end: '2026-06', rel: 3, sen: 'comparable' }], { overall: 3 });
  assert.equal(notRecent.decision, 'pass');
  const off = run('entry', [head], { overall: 2, cfg: over({ levels: { entry: { rejects: { overQualified: false } } } }) });
  assert.equal(off.decision, 'pass');
});

test('rule over_qualified: the share of recent roles that must be over is a setting', () => {
  const cfg = over({ levels: { entry: { overRecentShare: 0.5 } } });
  const specs = [{ start: '2015-01', end: 'present', rel: 2, sen: 'two_or_more_steps_senior' }, { start: '2025-01', end: 'present', rel: 3, sen: 'comparable' }];
  assert.equal(run('entry', specs, { overall: 3, cfg }).decision, 'reject');
  assert.equal(run('entry', specs, { overall: 3 }).decision, 'pass');
});

test('rule under_qualified: roles in the same field that are all clearly below the level reject, per level list', () => {
  const oneDown = { start: '2019-01', end: 'present', rel: 3, sen: 'one_step_junior' };
  const twoDown = { start: '2019-01', end: 'present', rel: 3, sen: 'much_more_junior' };
  assert.equal(run('mid', [oneDown]).decision, 'pass', 'one step below is not an obvious gap of two levels: doubt leans pass');
  assert.deepEqual([run('mid', [twoDown]).decision, run('mid', [twoDown]).reasonCodes], ['reject', ['under_qualified']]);
  const strict = over({ levels: { mid: { seniority: { tooJunior: ['much_more_junior', 'one_step_junior'] } } } });
  assert.deepEqual([run('mid', [oneDown], { cfg: strict }).decision, run('mid', [oneDown], { cfg: strict }).reasonCodes], ['reject', ['under_qualified']], 'the stricter reading is one setting away');
  assert.equal(run('senior', [oneDown]).decision, 'pass', 'one step below a senior role is not clear enough');
  assert.equal(run('senior', [twoDown]).decision, 'reject');
  assert.equal(run('head', [twoDown]).decision, 'reject');
  assert.equal(run('head', [oneDown]).decision, 'pass');
  assert.equal(run('entry', [twoDown]).decision, 'pass', 'nothing is too junior for an entry role');
  assert.equal(run('not_a_kitchen_role', [twoDown]).decision, 'pass');
  assert.equal(run('unknown', [twoDown]).decision, 'pass', 'an unknown level switches the level rules off');
  // one role at the level is enough; a vague title is not evidence of being below
  assert.equal(run('mid', [oneDown, { start: '2015-01', end: '2018-12', rel: 3, sen: 'comparable' }]).decision, 'pass');
  assert.equal(run('mid', [{ start: '2019-01', end: 'present', rel: 3, sen: 'cannot_tell' }]).decision, 'pass');
  // roles outside the field are not evidence of being too junior: that is the no-relevant-experience rule's business
  const unrelated = run('mid', [{ start: '2019-01', end: 'present', rel: 0, sen: 'much_more_junior' }], { overall: 3, cc: 0 });
  assert.equal(unrelated.decision, 'pass');
  const off = over({ levels: { mid: { requireComparableOrSenior: false } } });
  assert.equal(run('mid', [twoDown], { cfg: off }).decision, 'pass');
  const uncertain = run('senior', [{ start: '2019-01', end: 'present', rel: 3, sen: spread(SEN, 'much_more_junior', 0.6) }]);
  assert.deepEqual([uncertain.decision, uncertain.forced], ['pass', true]);
});

test('the search level is a distribution: an unsure level mixes the rules of the levels it might be', () => {
  const twoDown = { start: '2019-01', end: 'present', rel: 3, sen: 'much_more_junior' };
  const mixed = run('senior', [twoDown], { dist: { senior: 0.5, entry: 0.5 } });
  near(mixed.pReject, 0.5);
  assert.deepEqual([mixed.decision, mixed.forced], ['pass', true]);
  const mostlySenior = run('senior', [twoDown], { dist: { senior: 0.9, entry: 0.1 } });
  near(mostlySenior.pReject, 0.9);
  assert.equal(mostlySenior.decision, 'reject');
  const unsureAboutTitle = run('unknown', [twoDown], { dist: { unknown: 1 } });
  assert.equal(unsureAboutTitle.decision, 'pass');
  const stranger = run('senior', [twoDown], { dist: { galaxy: 1 } });
  assert.equal(stranger.decision, 'pass', 'a level the config does not know counts as unknown');
});

test('an empty profile (no roles at all): rejected only when the reader was sure, otherwise a forced pass', () => {
  const run0 = parse => gate.evaluate({ facts: facts.buildFacts({ roles: [], parseConfidence: parse }, CFG, NOW), level: 'mid', answers: null, cfg: CFG });
  const sure = run0(0.9);
  assert.deepEqual([sure.decision, sure.reasonCodes, sure.pReject], ['reject', ['no_roles'], 1]);
  const unsure = run0(0.4);
  assert.deepEqual([unsure.decision, unsure.forced], ['pass', true]);
  assert.ok(unsure.reasonCodes.includes('parse_low_confidence'));
  assert.equal(run0(0.1).decision, 'pass');
});

test('the gate never reads Jev confidence or the injection answer as a decision input; the injection answer is only evidence', () => {
  const a = run('mid', [GOOD], { inj: 0 });
  const b = run('mid', [GOOD], { inj: 1 });
  assert.equal(a.decision, b.decision);
  assert.equal(b.evidence.injectionP, 1);
});

test('atLeast: exact counts over independent events', () => {
  assert.equal(gate.atLeast([], 1), 0);
  assert.equal(gate.atLeast([1, 1], 2), 1);
  near(gate.atLeast([0.5, 0.5], 1), 0.75);
  near(gate.atLeast([0.5, 0.5], 2), 0.25);
  near(gate.atLeast([0.9, 0.1, 0.5], 2), 0.5);
});

test('deterministic and pure: the same input gives the same output and leaves the input alone', () => {
  const input = build('mid', [RETAIL, GOOD], { overall: [0.2, 0.3, 0.3, 0.2], cc: 0.5 });
  const before = JSON.stringify(input.answers);
  const one = gate.evaluate(input);
  const two = gate.evaluate(input);
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(input.answers), before);
});

test('answers that do not match the roles are a thrown error (the caller turns it into the fallback lane), never a decision', () => {
  const input = build('mid', [GOOD]);
  input.answers.relevance = [];
  assert.throws(() => gate.evaluate(input), /do not match/);
});

test('resolve: pass and reject are Jev lane, unreadable always passes, the fallback lane follows the policy; an injection attempt never gains a pass', () => {
  assert.deepEqual(gate.resolve('pass', ['a'], CFG), { final: 'approve', lane: 'jev', policy: null, finalReasonCodes: ['a'] });
  assert.deepEqual(gate.resolve('reject', ['b'], CFG), { final: 'reject', lane: 'jev', policy: null, finalReasonCodes: ['b'] });
  const u = gate.resolve('unreadable', ['unreadable_x'], CFG);
  assert.deepEqual([u.final, u.lane, u.policy], ['approve', 'unreadable', null]);
  const strictCfg = over({ fallback: { policy: 'reject' } });
  assert.equal(gate.resolve('unreadable', ['unreadable_x'], strictCfg).final, 'approve', 'never a reject, whatever the policy');
  const f = gate.resolve('review', ['answers_invalid'], CFG);
  assert.deepEqual([f.final, f.lane, f.policy.code, f.finalReasonCodes], ['approve', 'fallback', 'policy_fallback_approve', ['policy_fallback_approve', 'answers_invalid']]);
  const g = gate.resolve('review', ['answers_invalid'], strictCfg);
  assert.deepEqual([g.final, g.policy.code], ['reject', 'policy_fallback_reject']);
  const kept = gate.resolve('review', ['injection_flag'], CFG, { injection: true, jevDecision: 'reject' });
  assert.deepEqual([kept.final, kept.lane, kept.policy.code], ['reject', 'fallback', 'policy_kept_reject']);
  const notKept = gate.resolve('review', ['injection_flag'], CFG, { injection: true, jevDecision: 'pass' });
  assert.equal(notKept.final, 'approve');
  const off = gate.resolve('review', ['injection_flag'], over({ fallback: { keepJevReject: false } }), { injection: true, jevDecision: 'reject' });
  assert.equal(off.final, 'approve');
});

test('compactAnswers: rounded numbers only, enough to re-run the gate offline', () => {
  const input = build('mid', [GOOD, RETAIL], { overall: [0.111111, 0.2, 0.3, 0.388889], cc: 0.123456 });
  const c = gate.compactAnswers(input.answers);
  assert.equal(c.relevance.length, 2);
  assert.equal(c.overall['0'], 0.111);
  assert.equal(c.careerChange, 0.123);
  assert.equal(JSON.stringify(c).includes('Role'), false);
});

test('the shipped criteria reproduce the recruiters rules on the classic cases', () => {
  const kp = { start: '2020-01', end: 'present', rel: 3, sen: 'comparable' };
  // head chef for a porter shift is the automatic reject; a mid-level cook for a porter is not
  assert.equal(run('entry', [{ ...kp, rel: 2, sen: 'two_or_more_steps_senior' }], { overall: 2 }).decision, 'reject');
  assert.equal(run('entry', [{ ...kp, rel: 3, sen: 'one_step_senior' }], { overall: 3 }).decision, 'pass');
  // a porter for a head chef search: under-qualified
  assert.equal(run('head', [{ ...kp, sen: 'much_more_junior' }], { overall: 2 }).decision, 'reject');
  // sous chef for a mid search: over-qualification is not a reason to reject
  assert.equal(run('mid', [{ ...kp, sen: 'one_step_senior' }], { overall: 3 }).decision, 'pass');
  // latest job unrelated but years of relevant work before it: a pass
  const mix = run('mid', [{ start: '2024-01', end: 'present', rel: 0, sen: 'cannot_tell' }, { start: '2012-01', end: '2023-12', rel: 3, sen: 'comparable' }], { overall: 2, cc: 0.1 });
  assert.equal(mix.decision, 'pass');
  assert.equal(mix.evidence.relevantMonths, 111, 'the twelve-year window cuts the oldest months');
});

test('no relevant experience is a straight line, not a step: next to no relevant months is a reject, a few months is doubt, enough is fine', () => {
  const stint = months => [{ start: months === 1 ? '2026-09' : `2026-${String(10 - months).padStart(2, '0')}`, end: 'present', rel: 3, sen: 'comparable' }, RETAIL];
  const at = m => run('mid', stint(m), { overall: 0, cc: 0.9 });
  assert.equal(at(1).decision, 'reject', 'one month of relevant work is next to none');
  const three = at(3);
  assert.equal(three.decision, 'pass', 'three months of a six month minimum is doubt');
  assert.equal(three.forced, true);
  assert.ok(three.pReject > 0.3 && three.pReject < 0.75, String(three.pReject));
  assert.ok(at(2).pReject > three.pReject && at(4).pReject < three.pReject, 'more relevant months, less reject');
  assert.equal(at(6).pReject, 0);
  const steps = over({ evidence: { noneAtMonths: 1000 } });
  assert.equal(run('mid', stint(3), { overall: 0, cc: 0.9, cfg: steps }).decision, 'reject', 'noneAtMonths very large is the old step at the minimum');
  const generous = over({ evidence: { noneAtMonths: 0 } });
  assert.ok(run('mid', stint(1), { overall: 0, cc: 0.9, cfg: generous }).pReject < 0.9);
});

test('staleness is a straight line from staleYears to staleFullYears: eleven years is doubt, fourteen or more is a clear mismatch', () => {
  const endedAgo = years => ({ start: `${2026 - years - 5}-09`, end: `${2026 - years}-09`, rel: 3, sen: 'comparable' });
  const at = y => run('mid', [endedAgo(y)], { overall: 3 });
  assert.equal(at(9).pReject, 0, 'nine years ago is not stale');
  const eleven = at(11);
  assert.equal(eleven.decision, 'pass');
  assert.ok(eleven.reasonCodes.includes('stale_experience') && eleven.forced, eleven.reasonCodes.join());
  assert.equal(at(14).decision, 'reject');
  assert.equal(at(17).pReject, 1);
  const step = over({ levels: { mid: { staleFullYears: 0 } } });
  assert.equal(run('mid', [endedAgo(11)], { overall: 3, cfg: step }).decision, 'reject', 'staleFullYears 0 is the old step at staleYears');
});

test('a job Jev could not place (the last relevance answer) counts as possibly relevant, so a bare title never carries a reject', () => {
  const vague = { start: '2024-01', end: '2025-12', rel: [0, 0, 0, 0, 1], sen: 'cannot_tell' };
  const r = run('mid', [vague], { overall: 0, cc: 0.9 });
  assert.equal(r.decision, 'pass');
  assert.equal(r.forced, true);
  assert.ok(r.reasonCodes.includes('vague_roles'), r.reasonCodes.join());
  assert.equal(r.evidence.maxUnclearP, 1);
  const unrelated = run('mid', [{ start: '2024-01', end: '2025-12', rel: [1, 0, 0, 0, 0], sen: 'cannot_tell' }], { overall: 0, cc: 0.9 });
  assert.equal(unrelated.decision, 'reject', 'a job that is clearly elsewhere still rejects');
  const strict = over({ evidence: { unclearRelevantP: 0 } });
  assert.equal(run('mid', [vague], { overall: 0, cc: 0.9, cfg: strict }).decision, 'reject', 'unclearRelevantP 0 treats a bare title as not relevant');
  const noAnswer = over({ thresholds: { unclearLevel: 0 } });
  assert.equal(noAnswer.thresholds.unclearLevel, 0);
  const good = run('mid', [{ start: '2020-01', end: 'present', rel: [0, 0, 0.1, 0.8, 0.1], sen: 'comparable' }]);
  assert.equal(good.decision, 'pass');
  near(good.evidence.maxUnclearP, 0.1);
});

test('the two amount rules are asked of the same combination of relevant roles: a role that is either not relevant or relevant but old is a reject either way', () => {
  const oldMaybe = { start: '2005-01', end: '2009-12', rel: [0.5, 0, 0, 0.5, 0], sen: 'cannot_tell' };
  const r = run('head', [oldMaybe], { overall: [0.5, 0.5, 0, 0], cc: 0.9 });
  assert.equal(r.decision, 'reject', `half not relevant and half relevant but 17 years old is a reject, not half a reject (${r.pReject})`);
  assert.ok(r.pReject > 0.9);
  assert.ok(r.reasonCodes.includes('stale_experience') || r.reasonCodes.includes('no_relevant_experience'));
});

test('a long history costs nothing extra: roles Jev is sure about are settled, only roles in real doubt are enumerated', () => {
  const specs = [];
  for (let i = 0; i < 18; i++) specs.push({ start: `${2017 + (i % 9)}-01`, end: `${2017 + (i % 9)}-06`, rel: i === 3 ? [0.3, 0.3, 0.2, 0.2] : 0, sen: 'cannot_tell' });
  const t0 = Date.now();
  const r = run('mid', specs, { overall: 0, cc: 0.9 });
  assert.ok(Date.now() - t0 < 500, 'sixteen roles decided quickly');
  assert.ok(r.decision === 'pass' || r.decision === 'reject');
  assert.equal(r.evidence.roles, CFG.input.maxRoles);
});

test('roles Jev could not place (cannot_tell) neither save a candidate from the level rules nor dilute them', () => {
  const twoDown = { start: '2021-01', end: 'present', rel: 3, sen: 'much_more_junior' };
  const elsewhere = { start: '2019-01', end: 'present', rel: [0, 0.9, 0.1, 0], sen: 'cannot_tell' };
  assert.equal(run('head', [twoDown]).decision, 'reject');
  const withOther = run('head', [twoDown, elsewhere]);
  assert.equal(withOther.decision, 'reject', 'a front-of-house or vague job next to two-levels-below kitchen work is not a saver');
  assert.deepEqual(withOther.reasonCodes, ['under_qualified']);
  assert.equal(run('head', [elsewhere]).decision, 'pass', 'nothing Jev could place: no evidence of being too junior');
  const reaches = { start: '2015-01', end: '2020-12', rel: 3, sen: 'comparable' };
  assert.equal(run('head', [twoDown, reaches]).decision, 'pass', 'one job at the level saves the candidate');
  const chef = { start: '2022-01', end: 'present', rel: 3, sen: 'two_or_more_steps_senior' };
  const shop = { start: '2024-01', end: 'present', rel: 0, sen: 'cannot_tell' };
  assert.equal(run('entry', [chef]).decision, 'reject');
  assert.equal(run('entry', [chef, shop]).decision, 'reject', 'a recent job in another line of work does not hide an over-qualified career');
  assert.equal(run('entry', [shop]).decision, 'pass');
  const mid = { start: '2023-01', end: 'present', rel: 3, sen: 'comparable' };
  assert.equal(run('entry', [chef, mid]).decision, 'pass', 'a recent job at the searched level saves the candidate');
});
