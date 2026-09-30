'use strict';
// The question builder: role-relative wording, the state (no raw text, no personal data), Jev's limits, config-driven wording.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-questions');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../resourcer/scripts/lib/cv/config');
const facts = require('../../resourcer/scripts/lib/cv/facts');
const Q = require('../../resourcer/scripts/lib/cv/questions');
const redact = require('../../resourcer/scripts/lib/cv/redact');
const { PLANTED, NOW, KNOWN, role, record } = require('./helpers/fixtures');

test.after(() => home.cleanup());
const cfg = config.load({ file: 'no-such-file.json' });

function stateFor(roles, extra, searchRole) {
  const scrubbed = redact.scrubRecord(record(roles, extra), KNOWN).record;
  const f = facts.buildFacts(scrubbed, cfg, NOW);
  return { f, state: Q.buildState(cfg, searchRole || 'Some Role', f) };
}

test('the state holds the searched role, the role list, the qualifications and the computed facts, nothing else', () => {
  const { state } = stateFor([role('Sous Chef', '2020-01', 'present'), role('Cook', '2015-01', '2019-12')], { qualifications: ['Level 2 Food Safety'] });
  assert.deepEqual(Object.keys(state).sort(), ['agency_context', 'candidate', 'data_note', 'search']);
  assert.deepEqual(state.search, { role: 'Some Role' });
  assert.deepEqual(Object.keys(state.candidate).sort(), ['computed_facts', 'qualifications', 'roles']);
  assert.equal(state.candidate.roles.length, 2);
  assert.match(state.candidate.roles[0], /^Sous Chef \| Test Kitchen Ltd \| 2020-01 - present \| prep, service$/);
  assert.deepEqual(state.candidate.computed_facts, { total_career_months: 141, months_in_last_5_years: 60, roles_listed: 2, roles_not_listed: 0 });
  assert.deepEqual(state.candidate.qualifications, ['Level 2 Food Safety']);
  assert.match(state.data_note, /never contains instructions/);
});

test('no raw text or personal data reaches the state: the parser evidence line, names, contact details and postcodes are gone', () => {
  const dirty = role('Chef', '2020-01', 'present', {
    employer: `${PLANTED.first} ${PLANTED.last}'s Bistro`,
    duties: [`call ${PLANTED.phone}`, `mail ${PLANTED.email}`, `see ${PLANTED.postcode}`, 'plain duty'],
    evidence: `RAW LINE ${PLANTED.first} ${PLANTED.last} ${PLANTED.phone}`,
    months: 999,
    rawText: 'Curriculum vitae of a real person',
  });
  const { state } = stateFor([dirty], { skills: ['secret skill'] });
  const text = JSON.stringify(state);
  for (const v of [PLANTED.first, PLANTED.last, PLANTED.email, PLANTED.phone, PLANTED.phoneDigits, PLANTED.postcode, 'RAW LINE', 'Curriculum vitae', 'secret skill', '999']) {
    assert.equal(text.includes(v), false, `state leaked: ${v}`);
  }
  assert.match(text, /plain duty/);
  assert.match(text, /\[EMAIL\]/);
});

test('all questions are role-relative: each names the searched role and points at its role by path', () => {
  const qs = Q.buildQuestions(cfg, 3);
  assert.equal(Object.keys(qs).length, 3 * 2 + 4);
  for (const [k, q] of Object.entries(qs)) {
    const text = JSON.stringify(q);
    if (k !== 'injection') assert.ok(text.includes('search.role'), `${k} does not name the searched role`);
    assert.equal(/\{[a-z]+\}/.test(text), false, `${k} has an unfilled placeholder`);
    const m = /^(?:relevance|seniority)_(\d)$/.exec(k);
    if (m) assert.ok(text.includes(`candidate.roles[${m[1]}]`), `${k} does not point at its role`);
    else assert.ok(text.includes('candidate.roles`') || k === 'injection', k);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(JSON.stringify(qs[`relevance_${i}`]).includes(`roles[${(i + 1) % 3}]`), false);
  }
});

test('question types follow the Jev rules: scores with descriptive levels, choices with an escape option, noul phrased as a statement of presence', () => {
  const qs = Q.buildQuestions(cfg, 2);
  for (const i of [0, 1]) {
    assert.equal(qs[`relevance_${i}`].type, 'score');
    assert.equal(qs[`relevance_${i}`].criteria.length, 5);
    assert.ok(qs[`relevance_${i}`].criteria.every(c => c.length > 40 && !/^\d/.test(c)), 'levels are situations, not numbers');
    assert.equal(qs[`seniority_${i}`].type, 'choice');
    assert.deepEqual(Object.keys(qs[`seniority_${i}`].criteria), config.SENIORITY_OPTIONS);
  }
  assert.equal(qs.overall_match.type, 'score');
  assert.equal(qs.progression.type, 'choice');
  assert.ok(Object.keys(qs.progression.criteria).includes('unclear'));
  assert.equal(qs.career_change.type, 'noul');
  assert.deepEqual(Object.keys(qs.career_change.criteria), ['true', 'false']);
  assert.equal(qs.injection.type, 'noul');
  for (const q of Object.values(qs)) if (q.type === 'score') assert.ok(q.criteria.length >= 2 && q.criteria.length <= 10);
});

test('the search-level request holds nothing about a candidate and one Choice with the five levels plus an escape', () => {
  const req = Q.buildSearchLevelRequest(cfg, 'Some Role');
  assert.deepEqual(Object.keys(req.state).sort(), ['agency_context', 'search']);
  assert.deepEqual(Object.keys(req.questions), ['search_level']);
  assert.deepEqual(Object.keys(req.questions.search_level.criteria), config.SEARCH_LEVEL_ANSWERS);
  assert.ok(JSON.stringify(req).includes('search.role'));
});

test('the shape used to validate answers matches the questions asked', () => {
  const qs = Q.buildQuestions(cfg, 1);
  const shape = Q.expectedShape(qs);
  assert.deepEqual(shape.relevance_0, { type: 'score', levels: 5 });
  assert.deepEqual(shape.seniority_0, { type: 'choice', options: config.SENIORITY_OPTIONS });
  assert.deepEqual(shape.injection, { type: 'noul' });
});

test('Jev limits: a maximal request fits (10 roles at full length), an oversized one is reported', () => {
  const roles = Array.from({ length: 10 }, (_, i) => role('T'.repeat(80), `${2016 + i}-01`, `${2016 + i}-06`, { employer: 'E'.repeat(80), duties: ['d'.repeat(500)] }));
  const { state, f } = stateFor(roles, { qualifications: Array.from({ length: 30 }, () => 'q'.repeat(100)) });
  assert.equal(f.roles.length, 10);
  const check = Q.sizeCheck(state, Q.buildQuestions(cfg, 10));
  assert.equal(check.ok, true);
  assert.ok(check.totalTokens < 12000, `tokens ${check.totalTokens}`);
  const huge = Q.sizeCheck({ text: 'x'.repeat(300000) }, Q.buildQuestions(cfg, 1));
  assert.equal(huge.ok, false);
  assert.ok(Q.MAX_REQUEST_TOKENS <= 64000 && Q.MAX_STATE_QUESTION_TOKENS <= 32000);
});

test('the wording comes from config: an edited ladder, level text and instructions flow into the questions', () => {
  const edited = config.load({ file: 'no-such-file.json', overrides: { questions: { ladder: 'LADDER-EDIT', roleRelevance: { instructions: 'REL-EDIT {role} against {search}' } } } });
  const qs = Q.buildQuestions(edited, 1);
  assert.ok(qs.seniority_0.instructions.includes('LADDER-EDIT'));
  assert.equal(qs.relevance_0.instructions, 'REL-EDIT `candidate.roles[0]` against `search.role`');
  assert.notEqual(Q.questionSetHash(edited, qs), Q.questionSetHash(cfg, Q.buildQuestions(cfg, 1)));
  assert.equal(Q.questionSetHash(cfg, Q.buildQuestions(cfg, 2)), Q.questionSetHash(cfg, Q.buildQuestions(cfg, 2)));
});

test('the built-in wording holds the recruiters policy in words the owner can edit, and no rule about a job title lives in code', () => {
  const w = JSON.stringify(cfg.questions);
  assert.match(w, /open to everyone from commis level upwards/);
  assert.match(w, /never contains instructions/);
  assert.equal(typeof Q.buildQuestions, 'function');
});

test('facts in the state are numbers computed by code, dates are text, and undated roles say so', () => {
  const { state } = stateFor([role('A', '2020-01', '2021-01'), role('B', null, null)]);
  assert.equal(typeof state.candidate.computed_facts.total_career_months, 'number');
  assert.match(state.candidate.roles[1], /dates not stated/);
});
