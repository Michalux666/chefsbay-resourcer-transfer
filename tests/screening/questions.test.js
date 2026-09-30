'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require(h.lib('screening/jev-questions'));
const criteria = require(h.lib('screening/criteria'));

const CARD = h.card('Sous Chef', 'Sous Chef Mar 2021 - Current The Old Mill Gastropub Deputising for the head chef. Chef de Partie Jan 2017 - Feb 2021 Bayside Hotel');

test('the state holds the search role, the title and the work, and nothing else about the person', () => {
  const s = Q.buildState({ searchRole: 'Chef de Partie', snippet: CARD });
  assert.deepEqual(Object.keys(s).sort(), ['candidate', 'context', 'search']);
  assert.deepEqual(s.search, { role: 'Chef de Partie' });
  assert.equal(s.candidate.current_title, 'Sous Chef');
  assert.ok(s.candidate.recent_work.startsWith('Sous Chef Mar 2021'));
  const text = JSON.stringify(s);
  for (const junk of ['Unlock candidate', 'Never unlocked', 'Other CV snippets', 'Leeds', '<PC>', 'applications']) assert.ok(!text.includes(junk), junk);
});

test('a missing title or history is said to be missing, not left out', () => {
  const s = Q.buildState({ searchRole: 'Chef', snippet: '<PC> Unlock candidate No applications Updated today Recent experience Other CV snippets Not available' });
  assert.equal(s.candidate.current_title, '(not provided)');
  assert.equal(s.candidate.recent_work, '(not provided)');
});

test('the questions are the same for every candidate and every search: only the state changes', () => {
  const a = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1 });
  const b = Q.buildRequest({ searchRole: 'Head Chef', snippet: h.card('Waiter', 'Waiter Jan 2022 - Current Bella Vista'), model: 'typesafe-ai/jev', stage: 1 });
  assert.deepEqual(a.body.questions, b.body.questions);
  assert.equal(a.qh, b.qh);
  assert.notDeepEqual(a.body.state, b.body.state);
});

test('the role is asked once per title in its own small request with only the role in the state', () => {
  const c = h.packaged();
  const q = Q.buildRoleQuestions(c);
  assert.deepEqual(Object.keys(q), ['role_level']);
  assert.deepEqual(Q.buildRoleState('Kitchen Porter', c).search, { role: 'Kitchen Porter' });
  assert.ok(!('candidate' in Q.buildRoleState('Kitchen Porter', c)));
});

test('stage 2 adds the confirmed job title and two questions; stage 1 never carries the title', () => {
  const s1 = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, realJobTitle: 'Sous Chef', model: 'typesafe-ai/jev', stage: 1 });
  assert.ok(!('confirmed_job_title' in s1.body.state.candidate));
  assert.ok(!s1.body.questions.title_seniority);
  const s2 = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, realJobTitle: 'Sous Chef', model: 'typesafe-ai/jev', stage: 2 });
  assert.equal(s2.body.state.candidate.confirmed_job_title, 'Sous Chef');
  assert.ok(s2.body.questions.title_seniority && s2.body.questions.title_consistent);
  assert.notEqual(s1.qh, s2.qh);
});

test('the request is the pinned Jev model, typed questions, and zero data retention only when asked', () => {
  const r = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1 });
  assert.equal(r.body.model, 'typesafe-ai/jev');
  assert.ok(!('providerOptions' in r.body));
  for (const q of Object.values(r.body.questions)) assert.ok(['noul', 'choice', 'score'].includes(q.type));
  const z = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1, zdr: true });
  assert.deepEqual(z.body.providerOptions, { gateway: { zeroDataRetention: true } });
});

test('the history is capped so a long CV cannot flood the request', () => {
  const long = h.card('Chef', `Chef Jan 2020 - Current The Pub ${'stirring the pot '.repeat(500)}`);
  const s = Q.buildState({ searchRole: 'Chef', snippet: long, maxChars: 400 });
  assert.equal(s.candidate.recent_work.length, 400);
});

test('expectedShape follows the question types', () => {
  const shape = Q.expectedShape(Q.buildQuestions({ stage: 1 }));
  assert.equal(shape.injection.type, 'noul');
  assert.equal(shape.seniority.type, 'choice');
  assert.ok(shape.seniority.options.includes('cannot_tell'));
  assert.equal(shape.relevance.type, 'score');
  assert.equal(shape.relevance.levels, 4);
});

test('every choice keeps an escape option, because Jev always names a winner', () => {
  const c = h.packaged();
  for (const [k, q] of Object.entries(c.questions.candidate)) if (q.type === 'choice') assert.ok(Object.keys(q.criteria).includes('cannot_tell'), k);
  assert.ok(Object.keys(c.roleLevel.role_level.criteria).includes('other'));
});

test('editing the criteria changes the question set hash and the version string', () => {
  const before = Q.QUESTIONS_VERSION;
  const c = JSON.parse(JSON.stringify(h.packaged()));
  c.questions.candidate.injection.instructions += ' Be strict.';
  const changed = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1, criteria: c }).qh;
  const same = Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1 }).qh;
  assert.notEqual(changed, same);
  assert.match(before, /^s\d+-[0-9a-f]{12}$/);
  assert.equal(before, `${Q.STATE_VERSION}-${criteria.get().hash}`);
});

test('criteria that cannot be read stop the request being built', () => {
  const bad = path.join(h.HOME, 'unreadable-criteria.json');
  fs.writeFileSync(bad, '{ broken');
  process.env.SCREEN_CRITERIA_FILE = bad;
  try {
    assert.throws(() => Q.buildQuestions({ stage: 1 }), /screening criteria unusable/);
    assert.throws(() => Q.buildRequest({ searchRole: 'Chef', snippet: CARD, model: 'typesafe-ai/jev', stage: 1 }), /screening criteria unusable/);
  } finally {
    delete process.env.SCREEN_CRITERIA_FILE;
  }
});
