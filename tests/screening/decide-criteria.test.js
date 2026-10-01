'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, compactAnswers, operatingPoint } = require(h.lib('screening/decide'));
const reasons = require(h.lib('screening/reasons'));
const criteriaLib = require(h.lib('screening/criteria'));

const cfg = h.loadConfig('http://127.0.0.1:1');
const base = h.packaged();
const clone = o => JSON.parse(JSON.stringify(o));

const { KINDS, SEN, ROLES, choice, mix, A } = require('./criteria-answers');

const run = (answers, opts) => {
  const o = opts || {};
  return decide({ answers, searchRole: o.role || 'Chef', searchTier: 2, stage: o.stage || 1, criteria: o.criteria || base }, o.cfg || cfg);
};

// [name, answers, lane, reason code, stage, forced marker expected]
const CASES = [
  ['entry search, entry candidate', A({ role: 'entry', kind: 'entry', sen: 'comparable' }), 'approve', 'approve_level_match'],
  ['entry search, chef de partie is one tier up: fine', A({ role: 'entry', kind: 'cook', sen: 'one_step_senior' }), 'approve', 'approve_senior_ok'],
  ['entry search, sous chef is far too senior', A({ role: 'entry', kind: 'senior_chef', sen: 'two_or_more_steps_senior', over: 0.9, fit: 0.2, rel: [0, 0.02, 0.2, 0.78] }), 'reject', 'reject_overqualified_entry'],
  ['entry search, far too senior on the levels but the plain question and the policy disagree: doubt leans approve', A({ role: 'entry', kind: 'senior_chef', sen: 'two_or_more_steps_senior', over: 0.1, fit: 0.6 }), 'approve', 'approve_other', 1, true],
  ['junior search, head chef is far too senior', A({ role: 'junior_cook', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.9, fit: 0.2 }), 'reject', 'reject_overqualified_entry'],
  ['generic chef search, kitchen porter is too junior', A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.1, rel: [0, 0.05, 0.85, 0.1] }), 'reject', 'reject_too_junior'],
  ['generic chef search, commis is explicitly fine', A({ role: 'chef_generic', kind: 'junior_cook', sen: 'one_step_junior' }), 'approve', 'approve_level_match'],
  ['generic chef search, head chef: over-qualification is not a reason', A({ role: 'chef_generic', kind: 'head_chef', sen: 'two_or_more_steps_senior' }), 'approve', 'approve_senior_ok'],
  ['chef de partie search, commis is too junior', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.9, fit: 0.15, rel: [0, 0.05, 0.85, 0.1] }), 'reject', 'reject_too_junior'],
  ['chef de partie search, sous chef is fine', A({ role: 'chef_de_partie', kind: 'senior_chef', sen: 'one_step_senior' }), 'approve', 'approve_senior_ok'],
  ['sous search, chef de partie is one tier below: in doubt, approve and mark it forced', A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', tooJunior: 0.4, fit: 0.5 }), 'approve', 'approve_other', 1, true],
  ['sous search, chef de partie, and the policy readings say clear mismatch: reject', A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', tooJunior: 0.4, fit: 0.1 }), 'reject', 'reject_other'],
  ['head search, kitchen porter is too junior', A({ role: 'head_chef', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.05, rel: [0, 0.05, 0.85, 0.1] }), 'reject', 'reject_too_junior'],
  ['head search, sous chef is one tier below: doubt, approve', A({ role: 'head_chef', kind: 'senior_chef', sen: 'one_step_junior', tooJunior: 0.4, fit: 0.6 }), 'approve', 'approve_other', 1, true],
  ['head search, head chef', A({ role: 'head_chef', kind: 'head_chef', sen: 'comparable' }), 'approve', 'approve_level_match'],
  ['counter-evidence: too junior on paper but the history shows the searched work', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.6, rel: [0, 0.02, 0.1, 0.88] }), 'approve', 'approve_other', 1, true],

  ['chef search, waiter only: front of house', A({ kind: 'service_or_bar', sen: 'not_comparable', area: 0.05, fit: 0.1, rel: [0.02, 0.95, 0.02, 0.01] }), 'reject', 'reject_foh_only'],
  ['chef search, general manager: management only', A({ kind: 'hospitality_management', sen: 'not_comparable', area: 0.08, fit: 0.1, rel: [0.01, 0.97, 0.01, 0.01] }), 'reject', 'reject_management_only'],
  ['chef search, retail assistant and no hospitality anywhere', A({ kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] }), 'reject', 'reject_unrelated_industry'],
  ['chef search, retail now but hospitality elsewhere on the card: a career changer, doubt, approve', A({ kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.9, area: 0.3, fit: 0.55, rel: [0.6, 0.35, 0.03, 0.02] }), 'approve', 'approve_other', 1, true],
  ['chef search, waiter now but kitchen work seen: not a reject', A({ kind: 'service_or_bar', sen: 'not_comparable', area: 0.8, fit: 0.6, rel: [0.02, 0.5, 0.4, 0.08] }), 'approve', 'approve_other', 1, true],
  ['title says manager, work says cook: the readings disagree, the policy readings decide', A({ kind: 'hospitality_management', kindWork: 'cook', sen: 'comparable', fit: 0.8 }), 'approve', 'approve_other'],
  ['title and work agree on a cook', A({ kind: 'cook', kindWork: 'cook' }), 'approve', 'approve_level_match'],
  ['entry search, a waiter is in band', A({ role: 'entry', kind: 'service_or_bar', sen: 'not_comparable', rel: [0.02, 0.3, 0.6, 0.08] }), 'approve', 'approve_level_match'],
  ['entry search, a retail assistant is an unrelated industry', A({ role: 'entry', kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] }), 'reject', 'reject_unrelated_industry'],
  ['waiter search, waiter candidate', A({ role: 'service_or_bar', kind: 'service_or_bar', sen: 'comparable' }), 'approve', 'approve_level_match'],
  ['waiter search, retail assistant', A({ role: 'service_or_bar', kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] }), 'reject', 'reject_unrelated_industry'],

  ['empty profile: no title and no history', A({ info: 0.05, hist: 0, title: 0, fit: 0.3 }), 'reject', 'reject_no_history'],
  ['empty profile: nothing stated even with a title word', A({ info: 0.05, hist: 0, fit: 0.3 }), 'reject', 'reject_no_history'],
  ['thin card: the title alone matches the search, so it is put forward', A({ kind: 'cook', kindWorkAns: choice(KINDS, 'cannot_tell', 0.95), hist: 0, fit: 0.75 }), 'approve', 'approve_level_match'],
  ['thin card: the title alone shows a wrong field', A({ kind: 'hospitality_management', kindWorkAns: choice(KINDS, 'cannot_tell', 0.95), sen: 'not_comparable', hist: 0, area: 0.05, fit: 0.1, rel: [0.02, 0.95, 0.02, 0.01] }), 'reject', 'reject_management_only'],

  ['out of date: updated 6 years ago and not active', A({ upd: 2190 }), 'reject', 'reject_stale_profile'],
  ['out of date by the dated history: newest job ended 8 years ago, not active', A({ gap: 2920 }), 'reject', 'reject_stale_profile'],
  ['updated 6 years ago but active last week: not out of date', A({ upd: 2190, active: 7 }), 'approve', 'approve_level_match'],
  ['updated 2 years ago: not out of date', A({ upd: 730 }), 'approve', 'approve_level_match'],
  ['stage 2 (credit spent) ignores an old profile', A({ upd: 4000 }), 'approve', 'approve_level_match', 2],

  ['injection: the fallback lane when both the keyword filter and Jev flag it', A({ inject: 0.9, kw: 1, kind: 'not_hospitality', hosp: 0, sen: 'not_comparable', rel: [1, 0, 0, 0] }), 'review', 'INJECTION_FLAG'],
  ['injection: Jev alone does not send a card to the second model, the content decides', A({ inject: 0.9, kw: 0, kind: 'not_hospitality', hosp: 0.02, area: 0.02, fit: 0.05, sen: 'not_comparable', rel: [1, 0, 0, 0] }), 'reject', 'reject_unrelated_industry'],
  ['injection: the keyword filter alone does not either', A({ inject: 0.1, kw: 1 }), 'approve', 'approve_level_match'],
  ['injection: a missing keyword fact counts as fired, so a high answer still goes to the fallback', A({ inject: 0.9, extra: { x_injection_kw: undefined } }), 'review', 'INJECTION_FLAG'],
  ['injection below the bar is not a flag', A({ inject: 0.49, kw: 1 }), 'approve', 'approve_level_match'],

  ['stage 2: the unlocked title contradicts the card, so the title decides the level and the card cannot reject', A({ fit: 0.05, extra: { title_seniority: choice(SEN, 'comparable'), title_consistent: 0.1 } }), 'approve', 'approve_level_match', 2],
  ['stage 2: the real title decides the level', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.9, fit: 0.8, extra: { title_seniority: choice(SEN, 'one_step_senior'), title_consistent: 0.9 } }), 'approve', 'approve_senior_ok', 2],
  ['stage 2: a real title far above an entry search is a reject even though the credit is spent', A({ role: 'entry', kind: 'cook', sen: 'one_step_senior', over: 0.9, fit: 0.2, extra: { title_seniority: choice(SEN, 'two_or_more_steps_senior', 1), title_consistent: 0.98 } }), 'reject', 'reject_overqualified_entry', 2],
  ['stage 2: an empty card with a real title is not an empty profile', A({ hist: 0, title: 0, info: 0.05, fit: 0.9, extra: { title_seniority: choice(SEN, 'comparable'), title_consistent: 0.9 } }), 'approve', 'approve_level_match', 2, false],

  ['role level not clear enough: the tables are skipped and the policy readings decide', A({ roleAns: mix(ROLES, { chef_generic: 0.4, entry: 0.3, junior_cook: 0.3 }), fit: 0.8 }), 'approve', 'approve_other'],
];

for (const [name, ans, lane, code, stage, forced] of CASES) {
  test(`decide: ${name}`, () => {
    const d = run(ans, { stage });
    assert.equal(d.lane, lane, JSON.stringify(d));
    assert.equal(d.reasonCode || d.reviewReason, code, JSON.stringify(d));
    if (d.lane === 'review') {
      assert.equal(d.confidence, null);
    } else {
      assert.ok(d.confidence >= 0 && d.confidence <= 1, String(d.confidence));
      const r = d.scores.R;
      assert.equal(d.confidence, d.lane === 'reject' ? r : 1 - r);
      if (forced !== undefined) assert.equal(d.flags.includes('forced'), forced, JSON.stringify(d));
    }
  });
}

test('every reason code decide returns is one the engine knows', () => {
  for (const [, ans, , , stage] of CASES) {
    const d = run(ans, { stage });
    if (d.lane !== 'review') assert.ok(reasons.ENGINE_CODES.includes(d.reasonCode), d.reasonCode);
  }
});

test('forced choice: with usable answers the lane is approve or reject for every role level, kind, level answer and policy reading', () => {
  let n = 0;
  for (const role of ROLES) {
    for (const kind of KINDS) {
      for (const sen of SEN) {
        for (const fit of [0, 0.3, 0.5, 0.7, 1]) {
          for (const hist of [0, 300]) {
            const d = run(A({ role, kind, sen, fit, hist, kindWorkAns: choice(KINDS, kind === 'cannot_tell' ? 'entry' : 'cannot_tell', 0.6) }));
            assert.ok(d.lane === 'approve' || d.lane === 'reject', `${role} ${kind} ${sen} ${fit} ${hist}: ${JSON.stringify(d)}`);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 5000);
});

test('the fallback lane exists only for an unusable answer or for an injection that both filters flag', () => {
  const bar = cfg.decide.stage1.injectionP;
  const lanes = [];
  for (const inject of [0, bar / 2, bar, 1]) for (const kw of [0, 1]) lanes.push([inject, kw, run(A({ inject, kw })).lane]);
  const fallbackCases = lanes.filter(x => x[2] === 'review').map(x => `${x[0]}/${x[1]}`).sort();
  assert.deepEqual(fallbackCases, [`${bar}/1`, '1/1'].sort());
});

test('doubt leans approve: a lower fit never turns a reject into an approve, and the switch happens once at the operating point', () => {
  for (const role of ['chef_generic', 'senior_chef', 'entry']) {
    let prev = 'approve';
    let flips = 0;
    for (let fit = 1; fit >= 0; fit -= 0.05) {
      const d = run(A({ role, kind: 'cook', sen: 'one_step_junior', tooJunior: 0.4, fit: Math.max(0, fit) }));
      if (d.lane !== prev) flips++;
      if (prev === 'reject') assert.equal(d.lane, 'reject', `${role} fit ${fit}`);
      prev = d.lane;
    }
    assert.ok(flips <= 1, `${role}: ${flips} flips`);
  }
});

test('the operating point is one number in the file: rejectAt moves the switch, and a card in the middle carries the forced marker and its confidence', () => {
  const mid = A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', fit: 0.4 });
  const d = run(mid);
  assert.equal(d.lane, 'approve');
  assert.ok(d.flags.includes('forced'));
  assert.ok(Math.abs(d.confidence - 0.4) < 1e-9, String(d.confidence));
  const strict = clone(base);
  strict.decision.operatingPoint.stage1.rejectAt = 0.55;
  assert.equal(run(mid, { criteria: strict }).lane, 'reject');
  assert.ok(run(mid, { criteria: strict }).flags.includes('forced'));
  const lax = clone(base);
  lax.decision.operatingPoint.stage1.rejectAt = 0.95;
  const weak = A({ fit: 0.15 });
  assert.equal(run(weak).lane, 'reject');
  assert.equal(run(weak, { criteria: lax }).lane, 'approve');
});

test('the stage 2 operating point is its own: the same evidence is rejected before the unlock and approved after it', () => {
  const ans = A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', fit: 0.2 });
  assert.equal(run(ans, { stage: 1 }).lane, 'reject');
  assert.equal(run(ans, { stage: 2 }).lane, 'approve');
  const op1 = operatingPoint(base.decision, 1);
  const op2 = operatingPoint(base.decision, 2);
  assert.ok(op2.rejectAt > op1.rejectAt);
});

test('the cost weights and the bar are consistent: rejectAt is near costLost / (costLost + costWasted)', () => {
  for (const s of ['stage1', 'stage2']) {
    const o = base.decision.operatingPoint[s];
    const implied = o.costLostCandidate / (o.costLostCandidate + o.costWastedCredit);
    assert.ok(Math.abs(o.rejectAt - implied) <= 0.1, `${s}: ${o.rejectAt} against ${implied}`);
  }
});

test('the forced marker follows the band in the file', () => {
  const inside = run(A({ fit: 0.5 }));
  assert.ok(inside.flags.includes('forced'));
  const outside = run(A({ fit: 0.95 }));
  assert.ok(!outside.flags.includes('forced'));
  const wide = clone(base);
  wide.decision.operatingPoint.forced = { from: 0.0, to: 1.0 };
  assert.ok(run(A({ fit: 0.95 }), { criteria: wide }).flags.includes('forced'));
});

test('a malformed or missing answer is the fallback lane, never a reject and never a crash', () => {
  const good = A({});
  for (const [name, ans] of [
    ['NaN', { ...good, info_sufficient: NaN }],
    ['missing answers', {}],
    ['null answers', null],
    ['missing probabilities', { ...good, relevance: { p: null } }],
    ['a string instead of a number', { ...good, injection: 'high' }],
    ['a role level the rules do not know', { ...good, role_level: { p: { brand_new_level: 1 } } }],
    ['no kind answer', (() => { const c = { ...good }; delete c.candidate_kind; return c; })()],
    ['no policy reading', (() => { const c = { ...good }; delete c.would_place2; return c; })()],
  ]) {
    const d = run(ans);
    assert.equal(d.lane, 'review', name);
    assert.equal(d.reviewReason, 'ANSWER_UNUSABLE', name);
  }
});

test('no criteria at all is the fallback lane, not a crash', () => {
  const d = decide({ answers: A({}), searchRole: 'Chef', searchTier: 2, stage: 1, criteria: undefined }, cfg);
  assert.ok(['approve', 'review'].includes(d.lane));
});

test('the rules are data: changing one cell of the table changes the decision', () => {
  const kp = A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.1, rel: [0, 0.05, 0.85, 0.1] });
  assert.equal(run(kp).lane, 'reject');
  const c = clone(base);
  c.decision.rules.chef_generic.much_more_junior = 'approve';
  c.decision.fieldRules.chef_generic.entry = 'ok';
  c.decision.policy = { readings: [{ question: 'would_place', sense: 'fit' }] };
  const easy = A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.9, rel: [0, 0.05, 0.85, 0.1] });
  assert.equal(run(easy, { criteria: c }).lane, 'approve');
  const doubtful = clone(base);
  doubtful.decision.rules.chef_generic.much_more_junior = 'doubt';
  const d = run(A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.9, rel: [0, 0.05, 0.85, 0.1] }), { criteria: doubtful });
  assert.equal(d.lane, 'approve');
});

test('the policy readings are data: weights change how much a reading counts, and an unknown question is refused by validation', () => {
  const ans = A({ fit: 0.9, extra: { clear_mismatch: 0.95 } });
  assert.equal(run(ans).lane, 'approve');
  const c = clone(base);
  c.decision.policy = { readings: [{ question: 'clear_mismatch', sense: 'mismatch', weight: 10 }, { question: 'would_place', sense: 'fit' }] };
  assert.equal(run(ans, { criteria: c }).lane, 'reject');
  c.decision.policy = { readings: [{ question: 'nope', sense: 'fit' }] };
  assert.ok(criteriaLib.validate(c).decisionErrors.length > 0);
});

test('recent applications count as activity: an old-looking profile that shows applications in the last 30 days is not rejected as out of date', () => {
  const stale = { upd: 2190 };
  assert.deepEqual([run(A(stale)).lane, run(A(stale)).reasonCode], ['reject', 'reject_stale_profile'], 'the same card with no sign of life is out of date');
  const applied = run(A({ ...stale, apps: 30 }));
  assert.equal(applied.lane, 'approve');
  assert.equal(applied.reasonCode, 'approve_level_match');
  assert.ok(applied.flags.includes('stale_but_active'), JSON.stringify(applied.flags));
  assert.ok(!applied.flags.includes('stale_profile'));
  const byDates = run(A({ gap: 2920, apps: 90 }));
  assert.deepEqual([byDates.lane, byDates.flags.includes('stale_but_active')], ['approve', true], 'also when the newest dated job is what looks old');
  const both = run(A({ upd: 2920, gap: 3200, apps: 30, active: 5 }));
  assert.equal(both.lane, 'approve');
  assert.equal(run(A({ upd: 2190, active: 7 })).lane, 'approve', 'the Active age counts as before');
  assert.deepEqual(run(A({ upd: 730, apps: 30 })).flags.filter(f => /stale/.test(f)), [], 'a card that is not old carries no stale flag');
});

test('applications older than the activity window are no sign of life, and the switch is in the file', () => {
  assert.equal(run(A({ upd: 2190, apps: 400 })).reasonCode, 'reject_stale_profile', 'an application window of more than activeDays is no recent activity');
  const off = clone(base);
  off.decision.stale.applicationsAreActivity = false;
  assert.equal(run(A({ upd: 2190, apps: 30 }), { criteria: off }).reasonCode, 'reject_stale_profile', 'applicationsAreActivity false: applications are ignored again');
  assert.equal(run(A({ upd: 2190, apps: 30, active: 5 }), { criteria: off }).lane, 'approve', 'the Active age still counts');
  const wide = clone(base);
  wide.decision.stale.activeDays = 500;
  assert.equal(run(A({ upd: 2190, apps: 400 }), { criteria: wide }).lane, 'approve', 'activeDays is the window');
  const legacyFile = clone(base);
  delete legacyFile.decision.stale.applicationsAreActivity;
  assert.equal(run(A({ upd: 2190, apps: 30 }), { criteria: legacyFile }).lane, 'approve', 'a file without the key counts applications (the design default described in docs/SCREENING.md, rule 6 of the decision rules)');
});

test('a card that shows recent applications is still rejected when the content is a clear mismatch, and the flag says why the stale rule stepped aside', () => {
  const d = run(A({ upd: 2190, apps: 30, kind: 'not_hospitality', hosp: 0.03, area: 0.02, sen: 'not_comparable', fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] }));
  assert.deepEqual([d.lane, d.reasonCode], ['reject', 'reject_unrelated_industry']);
  assert.ok(d.flags.includes('stale_but_active'));
});

test('the stale rule is data: doubt mode raises the mismatch but does not reject alone, a recent-activity band, and off', () => {
  const old = A({ upd: 2190, fit: 0.5 });
  const doubt = clone(base);
  doubt.decision.stale.mode = 'doubt';
  const d = run(old, { criteria: doubt });
  assert.equal(d.lane, 'reject', 'a doubtful card that is also out of date crosses the bar');
  assert.equal(run(A({ upd: 2190, fit: 0.9 }), { criteria: doubt }).lane, 'approve');
  const band = clone(base);
  band.decision.stale.recentlyActive = 'doubt';
  assert.equal(run(A({ upd: 2190, active: 3, fit: 0.5 }), { criteria: band }).lane, 'reject');
  assert.equal(run(A({ upd: 2190, active: 3, fit: 0.5 })).lane, 'approve');
  const off = clone(base);
  off.decision.stale.mode = 'off';
  assert.equal(run(A({ upd: 2190 }), { criteria: off }).lane, 'approve');
});

test('an empty profile is rejected from the card facts and Jev\'s own answer, and a title alone that Jev can read is not empty', () => {
  const empty = run(A({ info: 0.05, hist: 0, title: 0 }));
  assert.equal(empty.reasonCode, 'reject_no_history');
  assert.ok(empty.flags.includes('empty_profile'));
  assert.notEqual(run(A({ info: 0.9, hist: 0, title: 1 })).reasonCode, 'reject_no_history');
  assert.notEqual(run(A({ info: 0.05, hist: 300, title: 1 })).reasonCode, 'reject_no_history');
});

test('compactAnswers keeps numbers only and is enough to re-run the decision', () => {
  const full = A({ role: 'entry', kind: 'senior_chef', sen: 'two_or_more_steps_senior', over: 0.9, fit: 0.2 });
  const withExtras = { ...full, seniority: { ...full.seniority, choice: 'x', top: 'x', confidence: 0.9, confidenceFrom: 'answer' } };
  const compact = compactAnswers(withExtras);
  assert.deepEqual(Object.keys(compact.seniority).sort(), ['c', 'p']);
  assert.equal(typeof compact.info_sufficient, 'number');
  const a = run(withExtras);
  const b = run(compact);
  assert.equal(a.lane, b.lane);
  assert.equal(a.reasonCode, b.reasonCode);
  assert.deepEqual(a.flags, b.flags);
});

test('a long card that the parser did not understand is a fault (the fallback lane), not an empty profile', () => {
  const lost = A({ hist: 0, title: 0, info: 0.05, fit: 0.3, extra: { x_content_chars: 500 } });
  const d = run(lost);
  assert.equal(d.lane, 'review');
  assert.equal(d.reviewReason, 'ANSWER_UNUSABLE');
  assert.ok(d.flags.includes('card_unreadable'));
  assert.equal(d.confidence, null);
});

test('a genuinely empty card, or one with a title or a history, is not an unreadable card', () => {
  assert.equal(run(A({ hist: 0, title: 0, info: 0.05, extra: { x_content_chars: 20 } })).reasonCode, 'reject_no_history');
  assert.equal(run(A({ hist: 0, title: 0, info: 0.05 })).reasonCode, 'reject_no_history');
  assert.notEqual(run(A({ hist: 0, title: 1, info: 0.9, extra: { x_content_chars: 900 } })).lane, 'review');
  assert.notEqual(run(A({ hist: 300, title: 0, extra: { x_content_chars: 900 } })).lane, 'review');
  const post = run(A({ hist: 0, title: 0, info: 0.05, fit: 0.9, extra: { x_content_chars: 900, title_seniority: choice(SEN, 'comparable'), title_consistent: 0.9 } }), { stage: 2 });
  assert.notEqual(post.lane, 'review');
});

test('the unreadable-card size is one number in the file and defaults to 300 characters', () => {
  const card = A({ hist: 0, title: 0, info: 0.05, extra: { x_content_chars: 500 } });
  const c = clone(base);
  c.decision.thresholds.unreadableMinChars = 1000;
  assert.equal(run(card, { criteria: c }).reasonCode, 'reject_no_history');
  c.decision.thresholds.unreadableMinChars = 100;
  assert.equal(run(A({ hist: 0, title: 0, info: 0.05, extra: { x_content_chars: 150 } }), { criteria: c }).reviewReason, 'ANSWER_UNUSABLE');
  assert.equal(run(A({ hist: 0, title: 0, info: 0.05, extra: { x_content_chars: 299 } })).reasonCode, 'reject_no_history');
  assert.equal(run(A({ hist: 0, title: 0, info: 0.05, extra: { x_content_chars: 300 } })).reviewReason, 'ANSWER_UNUSABLE');
});
