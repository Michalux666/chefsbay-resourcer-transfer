'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const criteria = require(h.lib('screening/criteria'));

const clone = o => JSON.parse(JSON.stringify(o));

test('the packaged criteria file loads with no error and no decision error', () => {
  const r = criteria.load({ file: h.PACKAGED });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.decisionErrors, []);
  assert.match(r.hash, /^[0-9a-f]{12}$/);
});

test('every role level has a level rule row and a field rule row, and every row covers every answer', () => {
  const c = h.packaged();
  const roleLevels = Object.keys(c.roleLevel.role_level.criteria);
  const seniority = Object.keys(c.questions.candidate[c.decision.levelQuestion].criteria);
  const kinds = Object.keys(c.questions.candidate[c.decision.kindQuestions[0]].criteria);
  for (const level of roleLevels) {
    assert.deepEqual(Object.keys(c.decision.rules[level]).sort(), seniority.slice().sort(), level);
    assert.deepEqual(Object.keys(c.decision.fieldRules[level]).sort(), kinds.slice().sort(), level);
  }
});

test('the criteria file is ASCII, has no carriage returns and names no local path', () => {
  const raw = fs.readFileSync(h.PACKAGED);
  for (let i = 0; i < raw.length; i++) {
    assert.ok(raw[i] < 0x80, `non-ASCII byte at ${i}`);
    assert.notEqual(raw[i], 0x0d, `CR at ${i}`);
  }
});

test('the wording lives in the file: role-relative questions point at search.role by field path', () => {
  const c = h.packaged();
  for (const key of ['relevance', 'seniority', 'same_area_seen', 'too_junior', 'overqualified', 'would_place', 'would_place2', 'clear_mismatch']) {
    assert.ok(c.questions.candidate[key].instructions.includes('`search.role`'), key);
  }
  assert.ok(c.roleLevel.role_level.instructions.includes('`search.role`'));
});

const BAD = [
  ['no context', c => { delete c.context; }, /context is missing/],
  ['no version', c => { delete c.version; }, /version is missing/],
  ['unknown question type', c => { c.questions.candidate.injection.type = 'maybe'; }, /type must be noul, choice or score/],
  ['a choice with one option', c => { c.questions.candidate.candidate_kind.criteria = { entry: 'only one' }; }, /at least two options/],
  ['a choice option without text', c => { c.roleLevel.role_level.criteria.entry = ''; }, /option entry has no description/],
  ['a score with eleven levels', c => { c.questions.candidate.relevance.criteria = Array.from({ length: 11 }, (_, i) => `level ${i}`); }, /2 to 10 levels/],
  ['a yes/no criteria block with another key', c => { c.questions.candidate.injection.criteria = { maybe: 'x' }; }, /may only hold true and false/],
  ['empty instructions', c => { c.questions.candidate.injection.instructions = ' '; }, /instructions are missing/],
  ['no role level question', c => { delete c.roleLevel.role_level; }, /role_level must be a choice/],
  ['no candidate questions', c => { c.questions.candidate = {}; }, /questions.candidate is missing/],
];

for (const [name, mutate, re] of BAD) {
  test(`validate rejects: ${name}`, () => {
    const c = clone(h.packaged());
    mutate(c);
    const v = criteria.validate(c);
    assert.ok(v.errors.some(e => re.test(e)), JSON.stringify(v));
  });
}

const BAD_DECISION = [
  ['a missing role level row', c => { delete c.decision.rules.chef_generic; }, /no row for role level chef_generic/],
  ['a rule cell that is not an action', c => { c.decision.rules.entry.comparable = 'maybe'; }, /rules.entry.comparable must be approve, reject or doubt/],
  ['the retired review word in a rule cell', c => { c.decision.rules.entry.comparable = 'review'; }, /rules.entry.comparable must be approve, reject or doubt/],
  ['a field cell that is not a reason', c => { c.decision.fieldRules.head_chef.not_hospitality = 'reject_because'; }, /fieldRules.head_chef.not_hospitality/],
  ['kind questions with different options', c => { c.questions.candidate.kind_work.criteria = { entry: 'a', cook: 'b' }; }, /same options as candidate_kind/],
  ['a level question that is not a choice', c => { c.decision.levelQuestion = 'injection'; }, /levelQuestion must name a choice question/],
  ['a policy reading that is not a yes/no question', c => { c.decision.policy.readings[0].question = 'seniority'; }, /decision.policy.readings: each needs a yes\/no question/],
  ['a policy reading with a sense that does not exist', c => { c.decision.policy.readings[0].sense = 'maybe'; }, /decision.policy.readings: each needs/],
  ['a policy with no readings', c => { c.decision.policy.readings = []; }, /decision.policy.readings must list at least one/],
  ['a stale mode that does not exist', c => { c.decision.stale.mode = 'shrug'; }, /decision.stale needs mode/],
  ['a stale mode that is the retired review', c => { c.decision.stale.mode = 'review'; }, /decision.stale needs mode/],
  ['no operating point', c => { delete c.decision.operatingPoint; }, /operatingPoint is missing/],
  ['a reject bar above 1', c => { c.decision.operatingPoint.stage1.rejectAt = 1.5; }, /stage1.rejectAt must be a number above 0 and up to 1/],
  ['a reject bar of 0', c => { c.decision.operatingPoint.stage2.rejectAt = 0; }, /stage2.rejectAt must be a number above 0 and up to 1/],
  ['a cost weight of 0 for a lost candidate', c => { c.decision.operatingPoint.stage1.costLostCandidate = 0; }, /stage1 needs costWastedCredit/],
  ['a negative cost for a wasted credit', c => { c.decision.operatingPoint.stage1.costWastedCredit = -1; }, /stage1 needs costWastedCredit/],
  ['a forced band the wrong way round', c => { c.decision.operatingPoint.forced = { from: 0.8, to: 0.2 }; }, /forced needs from and to/],
  ['a reason that is not a reject code', c => { c.decision.reasons.much_more_junior = 'approve_other'; }, /is not a reject reason code/],
  ['a corroboration question that does not exist', c => { c.decision.corroborate.reject_too_junior.question = 'nope'; }, /decision.corroborate/],
  ['a threshold that is not a number', c => { c.decision.thresholds.fieldOkMin = 'high'; }, /thresholds.fieldOkMin must be a number/],
  ['applicationsAreActivity that is not true or false', c => { c.decision.stale.applicationsAreActivity = 'yes'; }, /stale.applicationsAreActivity must be true or false/],
  ['an unreadable-card size that is not above 0', c => { c.decision.thresholds.unreadableMinChars = 0; }, /unreadableMinChars must be a number above 0/],
  ['no decision at all', c => { delete c.decision; }, /decision is missing/],
];

for (const [name, mutate, re] of BAD_DECISION) {
  test(`validate rejects a decision with: ${name}`, () => {
    const c = clone(h.packaged());
    mutate(c);
    const v = criteria.validate(c);
    assert.deepEqual(v.errors, []);
    assert.ok(v.decisionErrors.some(e => re.test(e)), JSON.stringify(v));
  });
}

test('applicationsAreActivity is optional: a criteria file written before it existed still validates, and the packaged file switches it on', () => {
  const old = clone(h.packaged());
  delete old.decision.stale.applicationsAreActivity;
  const v = criteria.validate(old);
  assert.deepEqual([v.errors, v.decisionErrors], [[], []]);
  assert.equal(h.packaged().decision.stale.applicationsAreActivity, true);
  const off = clone(h.packaged());
  off.decision.stale.applicationsAreActivity = false;
  assert.deepEqual(criteria.validate(off).decisionErrors, []);
});

test('a file that is not JSON or is missing is reported, never half applied', () => {
  const bad = path.join(h.HOME, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const r = criteria.load({ file: bad });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /not valid JSON/);
  const none = criteria.load({ file: path.join(h.HOME, 'nope.json'), getEnv: () => undefined });
  assert.equal(none.ok, true, 'the packaged file is the fallback when the named file does not exist');
});

test('SCREEN_CRITERIA_FILE points at another file', () => {
  const f = h.writeCriteria(c => { c.version = 'custom-9'; });
  const r = criteria.load({ getEnv: n => (n === 'SCREEN_CRITERIA_FILE' ? f : undefined) });
  assert.equal(r.criteria.version, 'custom-9');
  assert.equal(r.file, f);
});

test('any edit changes the hash, including a rule cell and a threshold, so cached decisions are not reused', () => {
  const base = criteria.load({ file: h.PACKAGED }).hash;
  const cell = criteria.load({ file: h.writeCriteria(c => { c.decision.rules.entry.comparable = 'doubt'; }) }).hash;
  const num = criteria.load({ file: h.writeCriteria(c => { c.decision.thresholds.fieldOkMin = 0.7; }) }).hash;
  const wording = criteria.load({ file: h.writeCriteria(c => { c.questions.candidate.injection.instructions += ' Answer carefully.'; }) }).hash;
  const bar = criteria.load({ file: h.writeCriteria(c => { c.decision.operatingPoint.stage1.rejectAt = 0.6; }) }).hash;
  assert.equal(new Set([base, cell, num, wording, bar]).size, 5);
});

test('get() serves the cached result until the file changes on disk', () => {
  const f = h.writeCriteria(c => { c.version = 'v-one'; }, 'watched.json');
  const opts = { file: f, getEnv: () => undefined };
  assert.equal(criteria.get(opts).criteria.version, 'v-one');
  assert.equal(criteria.get(opts), criteria.get(opts));
  const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
  obj.version = 'v-two';
  fs.writeFileSync(f, JSON.stringify(obj));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.equal(criteria.get(opts).criteria.version, 'v-two');
});

test('notes and other keys never reach the request', () => {
  const Q = require(h.lib('screening/jev-questions'));
  const c = clone(h.packaged());
  c.questions.candidate.injection.secret_note = 'not for Jev';
  const qs = Q.buildQuestions({ stage: 1, criteria: c });
  assert.deepEqual(Object.keys(qs.injection).sort(), ['criteria', 'instructions', 'type']);
  assert.ok(!JSON.stringify(qs).includes('_note'));
  assert.ok(!JSON.stringify(qs).includes('not for Jev'));
});
