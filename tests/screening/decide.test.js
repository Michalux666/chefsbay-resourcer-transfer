'use strict';
// decide() scenario table: the archetype cases of the ladder design (KP, Chef, CDP, Sous, Head, tier-0 titles, thin cards,
// injection, stage 2) re-asked of the forced-choice design. Each title says what the ladder did; the columns say what the
// criteria do now. The tables and the numbers under test are in config/screening-criteria.json (docs/SCREENING-CRITERIA.md).
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, compactAnswers } = require(h.lib('screening/decide'));
const reasons = require(h.lib('screening/reasons'));
const { KINDS, SEN, ROLES, choice, mix, A } = require('./criteria-answers');

const cfg = h.loadConfig('http://127.0.0.1:1');
const base = h.packaged();
const clone = o => JSON.parse(JSON.stringify(o));
const run = (ans, stage, criteria) => decide({ answers: ans, searchRole: 'x', searchTier: 0, stage: stage || 1, criteria: criteria || base }, cfg);

const SURE_JUNIOR = { tooJunior: 0.95, fit: 0.1, rel: [0, 0.05, 0.85, 0.1] };
const RETAIL = { kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] };

// [name, answers, stage, lane, reason code or fallback reason, forced marker expected (undefined = not asserted)]
const CASES = [
  ['KP search, Head Chef, sure: over-qualified (ladder: reject_overqualified_entry)', A({ role: 'entry', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.95, fit: 0.1 }), 1, 'reject', 'reject_overqualified_entry'],
  ['KP search, Head Chef but the plain question and the policy readings do not agree: doubt leans approve (ladder: review, _UNCERTAIN)', A({ role: 'entry', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.2, fit: 0.6 }), 1, 'approve', 'approve_other', true],
  ['KP search, CDP (one tier up is fine)', A({ role: 'entry', kind: 'cook', sen: 'one_step_senior' }), 1, 'approve', 'approve_senior_ok'],
  ['KP search, Sous/Head split 50/45 (both too senior)', A({ role: 'entry', kindAns: mix(KINDS, { senior_chef: 0.5, head_chef: 0.45, cook: 0.05 }), kindWorkAns: mix(KINDS, { senior_chef: 0.5, head_chef: 0.45, cook: 0.05 }), sen: 'two_or_more_steps_senior', over: 0.9, fit: 0.2 }), 1, 'reject', 'reject_overqualified_entry'],
  ['KP search, general manager (non-kitchen management): a doubt cell, the readings say clear mismatch (ladder: over-qualified)', A({ role: 'entry', kind: 'hospitality_management', sen: 'not_comparable', area: 0.1, fit: 0.1, rel: [0.02, 0.9, 0.06, 0.02] }), 1, 'reject', 'reject_other'],
  ['KP search, general manager, readings say suitable: approved and marked forced', A({ role: 'entry', kind: 'hospitality_management', sen: 'not_comparable', area: 0.3, fit: 0.6, rel: [0.02, 0.5, 0.4, 0.08] }), 1, 'approve', 'approve_other', true],
  ['Chef search, Commis is fine (generic Chef)', A({ role: 'chef_generic', kind: 'junior_cook', sen: 'one_step_junior' }), 1, 'approve', 'approve_level_match'],
  ['Chef search, Head Chef (over-qualification is not a reason): senior ok', A({ role: 'chef_generic', kind: 'head_chef', sen: 'two_or_more_steps_senior' }), 1, 'approve', 'approve_senior_ok'],
  ['Chef search, Kitchen Porter only is too junior', A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', ...SURE_JUNIOR }), 1, 'reject', 'reject_too_junior'],
  ['CDP search, Commis sure + not a fit + weak role evidence', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.9, fit: 0.15, rel: [0, 0.05, 0.85, 0.1] }), 1, 'reject', 'reject_too_junior'],
  ['CDP search, Commis but the history shows CDP duties (relevance 3): counter-evidence, approve and mark forced (ladder: review)', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.85, fit: 0.6, rel: [0, 0.02, 0.1, 0.88] }), 1, 'approve', 'approve_other', true],
  ['CDP search, Sous Chef (over-qualification is not a reason)', A({ role: 'chef_de_partie', kind: 'senior_chef', sen: 'one_step_senior' }), 1, 'approve', 'approve_senior_ok'],
  ['Sous search, CDP is one tier below: a doubt cell, approved when the readings do not see a clear mismatch (ladder: review AMBIGUOUS_LEVEL)', A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', tooJunior: 0.5, fit: 0.5 }), 1, 'approve', 'approve_other', true],
  ['Sous search, CDP one tier below and the readings say clear mismatch: reject', A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', tooJunior: 0.5, fit: 0.1 }), 1, 'reject', 'reject_other'],
  ['Sous search, Commis is two tiers below: reject', A({ role: 'senior_chef', kind: 'junior_cook', sen: 'much_more_junior', ...SURE_JUNIOR }), 1, 'reject', 'reject_too_junior'],
  ['Head Chef search, Sous is one tier below: a doubt cell, approved and forced (ladder: review)', A({ role: 'head_chef', kind: 'senior_chef', sen: 'one_step_junior', tooJunior: 0.4, fit: 0.6 }), 1, 'approve', 'approve_other', true],
  ['Head Chef search, CDP is two tiers below: reject', A({ role: 'head_chef', kind: 'cook', sen: 'much_more_junior', ...SURE_JUNIOR }), 1, 'reject', 'reject_too_junior'],
  ['Head Chef search, Head Chef: approve', A({ role: 'head_chef', kind: 'head_chef', sen: 'comparable' }), 1, 'approve', 'approve_level_match'],
  ['Chef search, retail assistant, no hospitality anywhere', A({ ...RETAIL }), 1, 'reject', 'reject_unrelated_industry'],
  ['Chef search, retail now but kitchen history elsewhere on the card: a career changer, approve and mark forced (ladder: review)', A({ kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.9, area: 0.3, fit: 0.55, rel: [0.6, 0.35, 0.03, 0.02] }), 1, 'approve', 'approve_other', true],
  ['Chef search, waiter only, no kitchen seen: front-of-house reject', A({ kind: 'service_or_bar', sen: 'not_comparable', area: 0.05, fit: 0.1, rel: [0.02, 0.95, 0.02, 0.01] }), 1, 'reject', 'reject_foh_only'],
  ['Chef search, waiter now but kitchen work in the history: not a reject (ladder: review)', A({ kind: 'service_or_bar', sen: 'not_comparable', area: 0.8, fit: 0.6, rel: [0.02, 0.5, 0.4, 0.08] }), 1, 'approve', 'approve_other', true],
  ['Chef search, general manager with no kitchen: management reject', A({ kind: 'hospitality_management', sen: 'not_comparable', area: 0.08, fit: 0.1, rel: [0.01, 0.97, 0.01, 0.01] }), 1, 'reject', 'reject_management_only'],
  ['Catering Assistant search (an entry role, no tier-0 ladder any more): a front-of-house candidate is in band', A({ role: 'entry', kind: 'service_or_bar', sen: 'not_comparable', area: 0.2, rel: [0.02, 0.3, 0.6, 0.08] }), 1, 'approve', 'approve_level_match'],
  ['Catering Assistant search: a Head Chef is over-qualified for an entry-level role', A({ role: 'entry', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.95, fit: 0.1 }), 1, 'reject', 'reject_overqualified_entry'],
  ['Waiter search (a role level of its own, no title list): a front-of-house candidate is comparable', A({ role: 'service_or_bar', kind: 'service_or_bar', sen: 'comparable' }), 1, 'approve', 'approve_level_match'],
  ['Bartender search: a Head Chef is a doubt cell for a non-kitchen role, the readings say clear mismatch (ladder: too senior)', A({ role: 'service_or_bar', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.5, fit: 0.1 }), 1, 'reject', 'reject_other'],
  ['Bartender search: a Head Chef the readings would put forward is approved and forced', A({ role: 'service_or_bar', kind: 'head_chef', sen: 'two_or_more_steps_senior', fit: 0.6 }), 1, 'approve', 'approve_other', true],
  ['Barista search (service_or_bar): a cook is judged by the readings, never sent to a fallback for lack of a ladder (ladder: UNKNOWN_SEARCH_LADDER)', A({ role: 'service_or_bar', kind: 'cook', sen: 'not_comparable', fit: 0.8 }), 1, 'approve', 'approve_other'],
  ['Kitchen Supervisor search (hospitality_management): a sous chef is a doubt cell, approved on the readings (ladder: review)', A({ role: 'hospitality_management', kind: 'senior_chef', sen: 'one_step_senior', fit: 0.75 }), 1, 'approve', 'approve_other'],
  ['Restaurant Manager search: a management-only candidate is not rejected by a kitchen rule', A({ role: 'hospitality_management', kind: 'hospitality_management', sen: 'comparable' }), 1, 'approve', 'approve_level_match'],
  ['Restaurant Manager search: retail is an unrelated industry', A({ role: 'hospitality_management', ...RETAIL }), 1, 'reject', 'reject_unrelated_industry'],
  ['a title of no known kind (role level other): every level and kind cell is a doubt cell, so the readings decide (ladder: UNKNOWN_SEARCH_LADDER)', A({ role: 'other', kind: 'cook', sen: 'not_comparable', fit: 0.8 }), 1, 'approve', 'approve_other'],
  ['a title of no known kind and a card the readings call a clear mismatch: reject', A({ role: 'other', kind: 'cook', sen: 'not_comparable', fit: 0.05 }), 1, 'reject', 'reject_other'],
  ['Thin information, a kitchen porter for a Head Chef search: the level call still blocks the approve (ladder: review INSUFFICIENT_INFO)', A({ role: 'head_chef', kind: 'entry', sen: 'much_more_junior', info: 0.45, ...SURE_JUNIOR }), 1, 'reject', 'reject_too_junior'],
  ['Thin information but a card with a history: not an empty profile, so the readings decide', A({ info: 0.45, fit: 0.8 }), 1, 'approve', 'approve_level_match'],
  ['No usable information at all (no title, no history): an empty profile, rejected as the recruiters do (ladder: review, never reject)', A({ info: 0.1, hist: 0, title: 0, fit: 0.3 }), 1, 'reject', 'reject_no_history'],
  ['A title and no history, and Jev says nothing is stated: an empty profile', A({ info: 0.1, hist: 0, fit: 0.3 }), 1, 'reject', 'reject_no_history'],
  ['A title and no history that Jev can read and place: decided on the title (a fitting one is put forward)', A({ hist: 0, info: 0.9, fit: 0.75, kindWorkAns: choice(KINDS, 'cannot_tell', 0.95) }), 1, 'approve', 'approve_level_match'],
  ['No job title but a history that shows the searched work: approve (ladder: approve when hospitality is clear)', A({ title: 0, hist: 300, info: 0.6, fit: 0.8 }), 1, 'approve', 'approve_level_match'],
  ['Injection flagged by Jev and by the keyword filter: the fallback lane, even if everything else says reject', A({ inject: 0.9, kw: 1, ...RETAIL, fit: 0, rel: [1, 0, 0, 0] }), 1, 'review', 'INJECTION_FLAG'],
  ['Injection flagged by Jev only: the content decides (a retail card is rejected)', A({ inject: 0.9, kw: 0, ...RETAIL, fit: 0, rel: [1, 0, 0, 0] }), 1, 'reject', 'reject_unrelated_industry'],
  ['Malformed answer (NaN): the fallback lane, flagged unusable', A({ info: NaN }), 1, 'review', 'ANSWER_UNUSABLE'],
  ['Missing answers: the fallback lane, flagged unusable', {}, 1, 'review', 'ANSWER_UNUSABLE'],
  ['Missing probabilities: the fallback lane, flagged unusable', A({ extra: { relevance: { p: null } } }), 1, 'review', 'ANSWER_UNUSABLE'],
  ['Stage 2: real title Sous Chef for a CDP search', A({ role: 'chef_de_partie', extra: { title_seniority: choice(SEN, 'one_step_senior'), title_consistent: 0.95 } }), 2, 'approve', 'approve_senior_ok'],
  ['Stage 2: real title Kitchen Assistant for a CDP search, consistent, 98%', A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.9, fit: 0.1, rel: [0, 0.05, 0.85, 0.1], extra: { title_seniority: choice(SEN, 'much_more_junior', 0.98), title_consistent: 0.9 } }), 2, 'reject', 'reject_too_junior'],
  ['Stage 2: the title contradicts the card: the title decides the level and the card cannot reject (ladder: review TITLE_SNIPPET_MISMATCH)', A({ role: 'chef_de_partie', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.9, fit: 0.1, extra: { title_seniority: choice(SEN, 'comparable'), title_consistent: 0.1 } }), 2, 'approve', 'approve_level_match'],
  ['Stage 2 with a title Jev cannot place falls back to the card level', A({ extra: { title_seniority: choice(SEN, 'cannot_tell', 0.9), title_consistent: 0.9 } }), 2, 'approve', 'approve_level_match'],
];

for (const [name, ans, stage, lane, code, forced] of CASES) {
  test(`decide: ${name}`, () => {
    const d = run(ans, stage);
    assert.equal(d.lane, lane, JSON.stringify(d));
    assert.equal(d.reasonCode || d.reviewReason, code, JSON.stringify(d));
    if (d.lane === 'review') assert.equal(d.confidence, null);
    else {
      assert.ok(d.confidence >= 0 && d.confidence <= 1);
      if (forced !== undefined) assert.equal(d.flags.includes('forced'), forced, JSON.stringify(d));
    }
  });
}

test('every scenario ends in approve or reject except an unusable answer and a double injection flag, and every code is one the engine knows', () => {
  const fallbacks = CASES.filter(c => c[3] === 'review').map(c => c[4]).sort();
  assert.deepEqual(fallbacks, ['ANSWER_UNUSABLE', 'ANSWER_UNUSABLE', 'ANSWER_UNUSABLE', 'INJECTION_FLAG']);
  for (const [, ans, stage] of CASES) {
    const d = run(ans, stage);
    if (d.lane !== 'review') assert.ok(reasons.ENGINE_CODES.includes(d.reasonCode), d.reasonCode);
  }
});

test('an answer that says nothing never rejects a card that has something on it: every role level, with cannot_tell everywhere and neutral readings, is approved', () => {
  for (const role of ROLES) {
    for (const hist of [80, 300]) {
      const d = run(A({ role, kindAns: choice(KINDS, 'cannot_tell', 0.95), kindWorkAns: choice(KINDS, 'cannot_tell', 0.95), senAns: choice(SEN, 'cannot_tell', 0.95), info: 0.3, fit: 0.5, area: 0.5, hosp: 0.5, rel: [0.25, 0.25, 0.25, 0.25], hist }));
      assert.equal(d.lane, 'approve', `${role} ${hist}: ${JSON.stringify(d)}`);
      assert.equal(d.reasonCode, 'approve_other', role);
    }
  }
});

test('a structural reject needs a second, independent question to agree: a level call alone is not enough', () => {
  const alone = A({ role: 'entry', kind: 'senior_chef', sen: 'two_or_more_steps_senior', over: 0.1, fit: 0.9 });
  assert.equal(run(alone).lane, 'approve');
  const junior = A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.05, fit: 0.9, rel: [0, 0.05, 0.85, 0.1] });
  assert.equal(run(junior).lane, 'approve', 'the plain too_junior question disagrees');
  const agreed = A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.9, rel: [0, 0.05, 0.85, 0.1] });
  assert.equal(run(agreed).lane, 'reject', 'two independent level answers agree: the structural reject stands even when the readings are positive');
  assert.equal(run(A({ role: 'chef_generic', kind: 'entry', sen: 'much_more_junior', ...SURE_JUNIOR })).lane, 'reject');
});

test('the bar comes from the criteria: a stricter bar turns a reject into an approve, a looser one the other way (ladder: rejectP moved a reject into review)', () => {
  const ans = A({ role: 'chef_de_partie', kind: 'junior_cook', sen: 'one_step_junior', tooJunior: 0.7, fit: 0.2, rel: [0, 0.05, 0.85, 0.1] });
  const strict = clone(base);
  strict.decision.operatingPoint.stage1.rejectAt = 0.95;
  const loose = clone(base);
  loose.decision.operatingPoint.stage1.rejectAt = 0.4;
  assert.equal(run(ans).lane, 'reject');
  assert.equal(run(ans, 1, strict).lane, 'approve');
  const mid = A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', fit: 0.45 });
  assert.equal(run(mid).lane, 'approve');
  assert.equal(run(mid, 1, loose).lane, 'reject');
});

test('the same evidence is rejected before the unlock and approved after it (bars 0.70 and 0.90; ladder: 0.90 and 0.95)', () => {
  const ans = A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', fit: 0.2 });
  assert.equal(run(ans, 1).lane, 'reject');
  assert.equal(run({ ...ans, title_seniority: choice(SEN, 'one_step_junior', 0.85), title_consistent: 0.9 }, 2).lane, 'approve');
  assert.equal(base.decision.operatingPoint.stage1.rejectAt, 0.7);
  assert.equal(base.decision.operatingPoint.stage2.rejectAt, 0.9);
});

test('a 70/30 split is not a reject and not a fallback: it is decided, and marked forced when it lands in the middle (ladder: review)', () => {
  const ans = A({ role: 'chef_de_partie', kind: 'junior_cook', senAns: mix(SEN, { much_more_junior: 0.35, one_step_junior: 0.35, comparable: 0.3 }), tooJunior: 0.5, fit: 0.4, rel: [0, 0.05, 0.6, 0.35] });
  const d = run(ans);
  assert.ok(d.lane === 'approve' || d.lane === 'reject');
  assert.ok(d.flags.includes('forced'), JSON.stringify(d));
});

test('a commis search is an entry-level search (owner decision): a sous or head chef is over-qualified, a cook and a commis are fine', () => {
  const role = { role: 'junior_cook' };
  assert.equal(run(A({ ...role, kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.95, fit: 0.1 })).reasonCode, 'reject_overqualified_entry');
  assert.equal(run(A({ ...role, kind: 'senior_chef', sen: 'two_or_more_steps_senior', over: 0.95, fit: 0.1 })).reasonCode, 'reject_overqualified_entry');
  assert.equal(run(A({ ...role, kind: 'cook', sen: 'one_step_senior' })).reasonCode, 'approve_senior_ok');
  assert.equal(run(A({ ...role, kind: 'junior_cook', sen: 'comparable' })).reasonCode, 'approve_level_match');
  assert.equal(run(A({ ...role, kind: 'entry', sen: 'one_step_junior' })).lane, 'approve');
  assert.deepEqual(base.decision.rules.junior_cook, base.decision.rules.entry, 'the two rows are the same rule');
});

test('the four numbers of config/screening.json that decide() still reads keep their effect: injectionP, infoFloor, notStatedP, titleConsistentMin', () => {
  const c = clone(cfg);
  c.decide.stage1.injectionP = 0.95;
  assert.equal(decide({ answers: A({ inject: 0.9, kw: 1 }), searchRole: 'x', stage: 1, criteria: base }, c).lane, 'approve');
  assert.equal(run(A({ inject: 0.9, kw: 1 })).reviewReason, 'INJECTION_FLAG');
  const f = clone(cfg);
  f.decide.stage1.infoFloor = 0.95;
  assert.equal(decide({ answers: A({ info: 0.9, hist: 0 }), searchRole: 'x', stage: 1, criteria: base }, f).reasonCode, 'reject_no_history');
  assert.notEqual(run(A({ info: 0.9, hist: 0 })).reasonCode, 'reject_no_history');
  const ns = clone(cfg);
  ns.decide.stage2.notStatedP = 0.05;
  const vague = A({ kind: 'entry', sen: 'much_more_junior', tooJunior: 0.95, fit: 0.9, rel: [0, 0.05, 0.85, 0.1], extra: { title_seniority: mix(SEN, { cannot_tell: 0.3, comparable: 0.7 }), title_consistent: 0.9 } });
  assert.equal(decide({ answers: vague, searchRole: 'x', stage: 2, criteria: base }, ns).lane, 'reject', 'a title Jev cannot place above notStatedP is ignored');
  assert.equal(run(vague, 2).lane, 'approve', 'below notStatedP the title decides the level');
  const tc = clone(cfg);
  tc.decide.stage2.titleConsistentMin = 0.05;
  const contra = A({ kind: 'entry', sen: 'much_more_junior', ...SURE_JUNIOR, extra: { title_seniority: choice(SEN, 'comparable'), title_consistent: 0.1 } });
  assert.equal(decide({ answers: contra, searchRole: 'x', stage: 2, criteria: base }, tc).flags.includes('title_contradiction'), false);
  assert.equal(run(contra, 2).flags.includes('title_contradiction'), true);
});

test('compactAnswers keeps numbers only and is enough to re-run decide(), card facts included', () => {
  const ans = A({ role: 'entry', kind: 'head_chef', sen: 'two_or_more_steps_senior', over: 0.95, fit: 0.1, upd: 400, apps: 30 });
  const withExtras = { ...ans, seniority: { ...ans.seniority, choice: 'x', top: 'x', confidence: 0.9, confidenceFrom: 'answer', legend: 'no' } };
  const compact = compactAnswers(withExtras);
  assert.equal(typeof compact.info_sufficient, 'number');
  assert.equal(typeof compact.x_apps_days, 'number', 'card facts are numbers and survive');
  assert.deepEqual(Object.keys(compact.seniority).sort(), ['c', 'p']);
  assert.ok(!JSON.stringify(compact).includes('legend'));
  const a = run(withExtras);
  const b = run(compact);
  assert.equal(a.lane, b.lane);
  assert.equal(a.reasonCode, b.reasonCode);
  assert.deepEqual(a.flags, b.flags);
});
