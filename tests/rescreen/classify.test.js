'use strict';
// R3 / R6: who decided a shadow row, for BOTH engine shapes. The rows come from the real engines (tests/rescreen/fixtures/make-rows.js):
// update-a-rows.json from the d60d917 code (the engine that wrote the rows this tool re-screens), head-rows.json from this repository's engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tool, FIXTURES, row } = require('./helpers');

const kind = (set, label) => {
  const r = FIXTURES[set].rows.find((x) => x.label === label).row;
  const c = tool.classifyRow(r);
  return `${c.kind}${c.kind.startsWith('policy_') ? (c.approved ? '/approve' : '/reject') : ''}`;
};

test('R3: every row of the Update A engine is placed by who decided it; only a policy rejection of an uncertain card is policy_uncertain/reject', () => {
  assert.deepEqual(Object.fromEntries(FIXTURES['update-a'].rows.map((x) => [x.label, kind('update-a', x.label)])), {
    uncertain_ambiguous: 'policy_uncertain/reject',
    uncertain_x: 'policy_uncertain/reject', // reviewReason <code>_UNCERTAIN
    injection_keyword: 'policy_injection/reject', // the keyword filter fired: Jev was not asked (jev.status skipped)
    injection_jev: 'policy_injection/reject', // Jev's own flag (INJECTION_FLAG)
    empty: 'policy_empty/reject',
    jev_approve: 'jev',
    jev_reject: 'jev',
    invalid: 'system',
    policy_approve_pre: 'policy_uncertain/approve', // an uncertain card the policy APPROVED (SCREEN_REVIEW_PRE=approve): not a rejection
    post_unlock_policy_reject: 'policy_uncertain/reject', // classified the same, excluded by its stage in the selection
    post_unlock_jev_reject: 'jev',
    reed_uncertain: 'policy_uncertain/reject',
    reed_jev_approve: 'jev',
  });
});

test('R3: every row of the current engine is placed; the current engine cannot reach the review lane, its policy rows are injection and empty cards', () => {
  assert.deepEqual(Object.fromEntries(FIXTURES.head.rows.map((x) => [x.label, kind('head', x.label)])), {
    jev_approve: 'jev',
    jev_reject: 'jev',
    jev_forced_approve: 'jev', // an uncertain card the current engine decides by forced choice: a Jev decision
    injection_policy: 'policy_injection/reject', // jev {status ok, lane review, INJECTION_FLAG}: the other shape of the same decision
    empty: 'policy_empty/reject',
    invalid: 'system',
    post_unlock_jev_reject: 'jev',
    reed_jev_approve: 'jev',
    reed_jev_reject: 'jev',
  });
});

test('R3: the shape differences of the two engines (keyword injection skips Jev in Update A, reaches it in the current one) classify to the same kind', () => {
  const a = FIXTURES['update-a'].rows.find((x) => x.label === 'injection_keyword').row;
  const h = FIXTURES.head.rows.find((x) => x.label === 'injection_policy').row;
  assert.equal(a.jev.status, 'skipped');
  assert.equal(h.jev.status, 'ok');
  assert.equal(tool.classifyRow(a).kind, 'policy_injection');
  assert.equal(tool.classifyRow(h).kind, 'policy_injection');
});

test('R3: a row without a policy block is placed from its jev block, and an inconsistent row is never uncertain', () => {
  const base = FIXTURES['update-a'].rows.find((x) => x.label === 'uncertain_ambiguous').row;
  const noPolicy = JSON.parse(JSON.stringify(base));
  delete noPolicy.policy;
  assert.equal(tool.classifyRow(noPolicy).kind, 'policy_uncertain');
  const inj = JSON.parse(JSON.stringify(noPolicy));
  inj.jev.reviewReason = 'INJECTION_FLAG';
  assert.equal(tool.classifyRow(inj).kind, 'policy_injection');
  const unusable = JSON.parse(JSON.stringify(noPolicy));
  unusable.jev.reviewReason = 'ANSWER_UNUSABLE';
  assert.equal(tool.classifyRow(unusable).kind, 'policy_invalid');
  // why says review but something says otherwise: never touched
  for (const mutate of [
    (r) => { r.flags = ['injection']; },
    (r) => { r.jev.flags = ['card_unreadable']; },
    (r) => { r.jev.status = 'invalid'; },
    (r) => { r.jev.lane = 'approve'; },
    (r) => { r.policy.reviewReason = 'INJECTION_FLAG'; },
    (r) => { r.used.reasonCode = 'sys_review_policy_approve'; },
    (r) => { r.policy.side = 'approve'; },
    (r) => { r.policy.why = 'something_new'; },
    (r) => { r.used.engine = 'second_opinion'; },
  ]) {
    const r = JSON.parse(JSON.stringify(base));
    mutate(r);
    const c = tool.classifyRow(r);
    assert.ok(!(c.kind === 'policy_uncertain' && !c.approved), `${JSON.stringify(mutate.toString())} must not be selectable`);
  }
  assert.equal(tool.classifyRow({}).kind, 'none');
  assert.equal(tool.classifyRow(null).kind, 'none');
});

test('R3: compactRow keeps only what the selection needs and drops the card text and every other field', () => {
  const r = row('update-a', 'uncertain_ambiguous', { candidateId: '77', ts: '2026-09-30T15:00:00.000Z', runId: 'phase1-x-1', jobTitle: 'Chef' });
  const c = tool.compactRow(r);
  assert.deepEqual(Object.keys(c).sort(), ['approved', 'id', 'kind', 'runId', 'source', 'stage', 't', 'title']);
  assert.ok(!JSON.stringify(c).includes('ZZ-FAKE'));
  assert.equal(tool.compactRow({ ...r, runId: 'install-canary-zdr' }), null, 'install canaries are invented cards and never count');
  assert.equal(tool.compactRow({ ...r, ts: 'not a date' }), null);
  assert.equal(tool.compactRow({ ...r, stage: 'whatever' }), null);
});
