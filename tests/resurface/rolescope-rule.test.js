'use strict';
// The role scope for people whose role was never recorded (docs/ROLESCOPE.md; scripts/lib/resurface.js classifyDetailed / classify, read through
// candidates-db.js). Caterer: an unlocked, never-pushed person with no usable record, old enough and not in flight, is screened for any title they were not
// judged for (ROLE_SCOPE_LEGACY, default on, independent of CV_SCREEN). Reed: a seen-only person with no row at all is let through once; a person rejected
// or approved for another title only (rows reed:snippet / reed:approved) is screened as normal for this one. A real SQLite file in the legacy schema.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../../resourcer/scripts/lib/resurface');
const cdb = require('../../resourcer/candidates-db');

test.after(() => { cdb.closeDb(); H.ws.cleanup(); });
test.beforeEach(() => { cdb.closeDb(); H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow' }); });

const X = 'Head Chef';
const Y = 'Kitchen Porter';
const Z = 'Sous Chef';
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const ids = (a) => a.slice().sort((x, y) => x - y);
const cat = (list, title) => cdb.classifyBatchScoped(list, title || Y);
const reed = (list, title) => cdb.resurfaceBatchReed(list, title || Y);

test('RL1 Caterer: unlocked, never pushed, no record at all, old (created_at NULL or older than the minimum age), not in flight: screened for any title, independent of CV_SCREEN', () => {
  H.build({
    cands: [
      { caterer_id: 101, unlocked: 1, created: null }, // the legacy rows never had a created_at
      { caterer_id: 102, unlocked: 1, created: ago(15) }, // older than the 14 days
      { caterer_id: 103, unlocked: 1, created: ago(13) }, // younger: the stranded recovery owns it
      { caterer_id: 104, unlocked: 1 }, // just created (the insert trigger stamps now)
      { caterer_id: 105, unlocked: 0, created: null }, // not unlocked: nothing to do with this rule
      { caterer_id: 106, unlocked: 1, zoho_id: 'ZOHO-106', created: null }, // pushed
      { caterer_id: 107, unlocked: 1, created: null, pushed_at: '2026-09-02 10:00:00' }, // a push recorded by the timestamp only
    ],
  });
  for (const mode of ['shadow', 'off', undefined, 'on']) {
    H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: mode });
    cdb.closeDb();
    const r = cat([101, 102, 103, 104, 105, 106, 107]);
    assert.deepEqual(ids(r.resurface), [101, 102], `CV_SCREEN ${mode}`);
    assert.deepEqual(ids(r.legacy), [101, 102]);
    assert.deepEqual(ids(r.skip), [103, 104, 106, 107], 'the young, the pushed: the old skip; 105 was never in the skip list');
  }
  assert.deepEqual(H.rows(101), [], 'the rule reads and writes nothing: the claim is made at the unlock');
});

test('RL1 the minimum age is a setting (ROLE_SCOPE_MIN_AGE_DAYS, default 14), never below 8 (the recovery owns the first 7 days), and a bad value is the default and says so', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: ago(20) }, { caterer_id: 102, unlocked: 1, created: ago(9) }] });
  assert.equal(rs.legacySettings().minAgeDays, 14);
  assert.deepEqual(ids(cat([101, 102]).legacy), [101]);
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow', ROLE_SCOPE_MIN_AGE_DAYS: 30 });
  cdb.closeDb();
  assert.deepEqual(cat([101, 102]).legacy, [], '20 days is younger than 30');
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow', ROLE_SCOPE_MIN_AGE_DAYS: 8 });
  cdb.closeDb();
  assert.deepEqual(ids(cat([101, 102]).legacy), [101, 102], '9 days is older than 8');
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow', ROLE_SCOPE_MIN_AGE_DAYS: 2 });
  assert.equal(rs.legacySettings().minAgeDays, 8);
  assert.match(rs.legacySettings().warnings.join(' '), /inside the 7 days the stranded recovery owns: using 8/);
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow', ROLE_SCOPE_MIN_AGE_DAYS: 'soon' });
  assert.equal(rs.legacySettings().minAgeDays, 14);
  assert.match(rs.allWarnings().join(' '), /ROLE_SCOPE_MIN_AGE_DAYS='soon' is not a whole number: using 14/);
});

test('RL1 an age that cannot be read, or a database without created_at, degrades to the old skip (never a crash, never eligible)', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: 'sometime last spring' }, { caterer_id: 102, unlocked: 1, created: '' }, { caterer_id: 103, unlocked: 1, created: '2026-01-01T00:00:00Z' }, { caterer_id: 104, unlocked: 1, created: '2999-01-01 00:00:00' }] });
  assert.deepEqual(ids(cat([101, 102, 103, 104]).legacy), [102, 103], 'an empty stamp is a legacy row; a date in the future is young; words are unknown');
  assert.equal(rs.ageState('2026-01-01 00:00:00', 14, Date.parse('2026-01-20T00:00:00Z')), 'old');
  assert.equal(rs.ageState('2026-01-10 00:00:00', 14, Date.parse('2026-01-20T00:00:00Z')), 'young');
  assert.equal(rs.ageState('2026-01-10T00:00:00+01:00', 14, Date.parse('2026-01-20T00:00:00Z')), 'young');
  assert.equal(rs.ageState('nonsense', 14, Date.now()), 'unknown');
  assert.equal(rs.ageState(null, 14, Date.now()), 'old');
  // the column is gone: nobody can be called old
  H.withDb((db) => { db.exec('DROP TRIGGER candidates_set_created_at'); db.exec('ALTER TABLE candidates DROP COLUMN created_at'); });
  cdb.closeDb();
  const r = cat([101, 102, 103, 104]);
  assert.deepEqual(r.legacy, []);
  assert.deepEqual(ids(r.skip), [101, 102, 103, 104]);
});

test('RL2 Caterer: a rejection binds only the title that was searched: a title of * or empty, or a plain pre-unlock rejection of ANOTHER real title, leaves the role of the unlock unknown (one more look when old); a CV rejection needs CV_SCREEN on', () => {
  H.build({
    cands: [101, 102, 103, 104, 105, 106, 107].map((id) => ({ caterer_id: id, unlocked: 1, created: null })),
    rows: [
      [101, '*', 'log-backfill'], // role unknown
      [102, '', 'pipeline'], // role unknown
      [103, X, 'pipeline'], // a rejection of another real title: binds X only, the role of the unlock is not recorded
      [104, X, 'log-backfill'],
      [105, X, 'cv:under_qualified'], // a CV rejection: the CV rule, not this one
      [106, X, 'resurface:postunlock'], // a look of this system already happened for X
      [107, Y, 'pipeline'], // rejected for Y itself
    ],
  });
  const r = cat([101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual(ids(r.legacy), [101, 102, 103, 104, 106]);
  assert.deepEqual(ids(r.skip), [105, 107]);
  // with the CV stage on the CV rule takes 105 (and 106, 101, 102 stay in the list once, by the CV rule: one list, nobody twice)
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'on' });
  cdb.closeDb();
  const on = cat([101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual(ids(on.resurface), [101, 102, 103, 104, 105, 106]);
  assert.deepEqual(ids(on.legacy), [103, 104], 'the legacy list is only the people the CV rule does not have (a plain rejection of another title is not a CV rejection)');
  assert.equal(new Set(on.resurface).size, on.resurface.length);
});

test('RL3 Caterer: a person who already had their one more look (a resurface: row of another role) is screened for a NEW role, any number of them, each once; never for a role they were judged for', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1 }], rows: [[101, X, 'resurface:snippet']] });
  assert.deepEqual(cat([101], Y).legacy, [101], 'young by created_at, but a recorded look is not an unknown state: no age rule');
  assert.deepEqual(cat([101], X).legacy, [], 'the role they were looked at for: final');
  assert.deepEqual(cat([101], Z).legacy, [101]);
  H.withDb((db) => db.prepare("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (101, ?, '2026-09-01', 'resurface:started')").run(Y));
  cdb.closeDb();
  assert.deepEqual(cat([101], Y).legacy, [], 'an unfinished claim for Y is a row for Y');
  assert.deepEqual(cat([101], Z).legacy, [101]);
});

test('RL4 safety (Caterer): pushed, a recorded push, a candidate file, a CV file, an entry of an unfinished queue or a results file with a push keep the old skip; a finished queue does not', () => {
  H.build({ cands: [201, 202, 203, 204, 205, 206, 207, 208].map((id) => ({ caterer_id: id, unlocked: 1, created: null })) });
  assert.deepEqual(ids(cat([201, 202, 203, 204, 205, 206, 207, 208]).legacy), [201, 202, 203, 204, 205, 206, 207, 208]);
  H.download('candidate-201.json', {});
  H.download('cv-202.pdf', 'x');
  H.download('approved-queue-r1.json', { candidates: [{ id: 203 }] });
  H.download('merged-queue-r2.json', { candidates: [{ id: 204 }] });
  H.download('approved-queue-r3.json', { candidates: [{ id: 205 }] });
  H.download('phase2-results-r3.json', { completedAt: '2026-09-01T00:00:00Z', candidates: [] }); // finished: 205 is decided
  H.download('phase2-results-r4.json', { candidates: [{ id: 206, zohoId: 'ZOHO-206', status: 'new' }] });
  const r = cat([201, 202, 203, 204, 205, 206, 207, 208]);
  assert.deepEqual(ids(r.legacy), [205, 207, 208], '201 (file), 202 (CV), 203 and 204 (unfinished queues) and 206 (a push in a results file) are in flight or in Zoho');
  assert.deepEqual(ids(r.skip), [201, 202, 203, 204, 206]);
});

test('RL5 the switch: ROLE_SCOPE_LEGACY off restores the old skip exactly (the answer is {"inDb":[...]} and nothing else); a typo is off and says so; a clear "true" is on', async () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }, { caterer_id: 102, unlocked: 0 }] });
  const onOut = await H.cli(['check-batch-scoped', '101,102', Y], { CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: 'on' });
  assert.deepEqual(onOut.json(), { inDb: [], resurface: [101], resurfaceCapped: 0, legacy: [101] });
  for (const v of ['off', 'false', '0', 'no', 'maybe', 'OFFF']) {
    const o = await H.cli(['check-batch-scoped', '101,102', Y], { CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: v });
    assert.equal(o.stdout, '{"inDb":[101]}', `ROLE_SCOPE_LEGACY=${v}`);
  }
  for (const v of ['true', '1', 'yes', 'ON', '']) {
    const o = await H.cli(['check-batch-scoped', '101,102', Y], { CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: v });
    assert.deepEqual(o.json().legacy, [101], `ROLE_SCOPE_LEGACY=${v}`);
  }
  H.settings({ ROLE_SCOPE_LEGACY: 'maybe', CV_SCREEN: 'shadow' });
  assert.equal(rs.legacyActive(), false);
  assert.match(rs.allWarnings().join(' '), /ROLE_SCOPE_LEGACY='maybe' is neither on nor off: treated as off/);
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow' });
  assert.equal(rs.legacyActive(), true, 'unset is on');
  assert.deepEqual(rs.allWarnings(), []);
});

test('RL5 CV_RESURFACE off does not switch the role scope off, and ROLE_SCOPE_LEGACY off does not switch the CV rule off: two switches, one list', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }, { caterer_id: 102, unlocked: 1 }], rows: [[102, X, 'cv:under_qualified']] });
  H.settings({ CV_SCREEN: 'on', CV_RESURFACE: 'off', ROLE_SCOPE_LEGACY: undefined });
  cdb.closeDb();
  assert.deepEqual(ids(cat([101, 102]).resurface), [101], 'the CV rule is off, the legacy rule is on');
  H.settings({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: 'off' });
  cdb.closeDb();
  assert.deepEqual(ids(cat([101, 102]).resurface), [102], 'the legacy rule is off, the CV rule is on');
});

test('RL6 the daily cap and the credit reserve apply to the Caterer legacy looks: page order, the rest held back and counted, nothing written', () => {
  H.build({ cands: [101, 102, 103, 104].map((id) => ({ caterer_id: id, unlocked: 1, created: null })) });
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: undefined, CV_RESURFACE_MAX_PER_DAY: 2 });
  cdb.closeDb();
  const r = cat([104, 103, 102, 101]);
  assert.deepEqual(r.legacy, [104, 103], 'the first two of the page');
  assert.equal(r.capped, 2);
  assert.deepEqual(ids(r.skip), [101, 102]);
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: undefined, CV_RESURFACE_MAX_PER_DAY: 0 });
  cdb.closeDb();
  const none = cat([101, 102, 103, 104]);
  assert.deepEqual([none.legacy.length, none.capped], [0, 4]);
  assert.deepEqual(H.rows(101), []);
});

test('RL7 a candidate that is not in the database, or a database that cannot answer, is never eligible and never throws (the old skip)', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }] });
  assert.deepEqual(cat([999]).legacy, []);
  H.withDb((db) => db.exec('DROP TABLE candidate_rejections'));
  cdb.closeDb();
  assert.deepEqual(cat([101]).resurface, [], 'no rejections table: the old behaviour (the unscoped skip)');
  const d = H.withDb((db) => ({ c: rs.classify(db, 'reed', [1], Y), r: rs.classifyDetailed(db, 'caterer', [101], Y, {}) }));
  assert.deepEqual(d.c, { resurface: [], legacy: [], scoped: [], capped: 0 });
  assert.deepEqual(d.r, []);
  assert.deepEqual(rs.classify({ prepare() { throw new Error('boom'); } }, 'caterer', [1], Y), { resurface: [], legacy: [], scoped: [], capped: 0 }, 'a broken handle answers "nobody"');
  assert.deepEqual(rs.reedJudged({ prepare() { throw new Error('boom'); } }, [1], Y), []);
});

// ---- Reed ----------------------------------------------------------------------------------------------------------------------------------------

test('RL8 Reed: a seen-only person with no row at all is a legacy look for any title (CV_SCREEN or not); one with a row for this title is judged and skipped', () => {
  H.build({
    cands: [301, 302, 303, 304, 305].map((id) => ({ reed_id: id, unlocked: 0 })),
    rows: [[303, Y, 'reed:snippet', 'reed'], [304, Y, 'reed:approved', 'reed'], [305, X, 'resurface:snippet', 'reed']],
  });
  for (const mode of ['shadow', 'off', undefined, 'on']) {
    H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: mode });
    cdb.closeDb();
    const r = reed([301, 302, 303, 304, 305, 999]);
    assert.deepEqual(ids(r.judged), [303, 304], `CV_SCREEN ${mode}`);
    assert.deepEqual(ids(r.legacy), mode === 'on' ? [301, 302] : [301, 302, 305], 'a look of this system for another role is a role already known: a new role is fine');
    assert.deepEqual(ids(r.resurface), mode === 'on' ? [301, 302, 305] : [301, 302, 305]);
    assert.deepEqual(r.scoped, []);
  }
});

test('RL8 Reed: rejected or approved for ANOTHER title only (rows reed:snippet / reed:approved) is screened as normal for this one, with or without the switches; never claimed', () => {
  H.build({
    cands: [401, 402, 403].map((id) => ({ reed_id: id, unlocked: 0 })),
    rows: [[401, X, 'reed:snippet', 'reed'], [402, X, 'reed:approved', 'reed'], [403, X, 'reed:snippet', 'reed'], [403, Z, 'reed:snippet', 'reed']],
  });
  for (const env of [{ CV_SCREEN: 'shadow' }, { CV_SCREEN: 'on' }, { CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: 'off' }, { CV_SCREEN: 'off', CV_RESURFACE: 'off', ROLE_SCOPE_LEGACY: 'off' }]) {
    H.settings(Object.assign({ ROLE_SCOPE_LEGACY: undefined }, env));
    cdb.closeDb();
    const r = reed([401, 402, 403], Y);
    assert.deepEqual(ids(r.scoped), [401, 402, 403], JSON.stringify(env));
    assert.deepEqual(r.resurface, []);
    assert.deepEqual(ids(reed([401, 402, 403], X).judged), [401, 402, 403], 'for the title of the row they are judged');
    assert.deepEqual(reed([401, 402, 403], X).scoped, [], '... and not scoped');
  }
  assert.equal(H.withDb((db) => rs.claim(db, { source: 'reed', id: 401, jobTitle: Y })).claimed, false, 'a scoped candidate is an ordinary first screening: nothing to claim');
  assert.deepEqual(H.rows(401, 'reed'), [{ title: X, origin: 'reed:snippet' }]);
});

test('RL8 Reed: with ROLE_SCOPE_LEGACY off a seen-only person with no row is skipped exactly as before; the title-scoped rows still work', () => {
  H.build({ cands: [{ reed_id: 301, unlocked: 0 }, { reed_id: 302, unlocked: 0 }], rows: [[302, X, 'reed:snippet', 'reed']] });
  H.settings({ ROLE_SCOPE_LEGACY: 'off', CV_SCREEN: 'shadow' });
  cdb.closeDb();
  const r = reed([301, 302], Y);
  assert.deepEqual([r.legacy, r.resurface, r.scoped, r.judged], [[], [], [302], []]);
});

test('RL8 Reed safety: a person in Zoho (id or timestamp), one profile-viewed (unlocked 1), one with a candidate file, a CV file, an entry of an unfinished Reed queue, or a push in a results file is never let through for the legacy or the scoped rule', () => {
  H.build({
    cands: [501, 502, 503, 504, 505, 506, 507, 508].map((id) => (id === 502 ? { reed_id: id, unlocked: 0, zoho_id: 'ZOHO-502' } : id === 503 ? { reed_id: id, unlocked: 0, pushed_at: '2026-09-02 10:00:00' } : { reed_id: id, unlocked: id === 504 ? 1 : 0 })),
    rows: [[507, X, 'reed:snippet', 'reed'], [508, X, 'reed:approved', 'reed']],
  });
  const all = [501, 502, 503, 504, 505, 506, 507, 508];
  assert.deepEqual(ids(reed(all).legacy), [501, 505, 506], 'before anything is in flight');
  H.download('candidate-505.json', {});
  H.download('cv-reed-506.pdf', 'x');
  H.download('reed-approved-queue-q1.json', { candidates: [{ id: 507 }] });
  H.download('phase2-results-q2.json', { candidates: [{ id: 508, zohoId: 'ZOHO-508', status: 'duplicate' }] });
  const r = reed(all);
  assert.deepEqual(r.legacy, [501], '502 and 503 are in Zoho, 504 was viewed, 505 to 508 are in flight');
  assert.deepEqual(r.scoped, [], '507 is in an unfinished queue and 508 has a recorded push: not scoped either');
  // a queue whose Phase 2 finished (its results file says so) protects nobody: its people are decided (pushed ones have their Zoho id)
  H.download('phase2-results-reed-approved-queue-q1.json', { completedAt: '2026-09-02T00:00:00Z', candidates: [] });
  assert.deepEqual(ids(reed(all).scoped), [507], 'the results file of a Reed queue is named after the queue');
});

test('RL8 Reed: CV-rejected people keep the CV rule only (cv: rows are skipped unless CV_SCREEN and CV_RESURFACE are on), a look of this system for another role is a role already known, and a mixture of both is the CV rule', () => {
  H.build({
    cands: [601, 602, 603, 604].map((id) => ({ reed_id: id, unlocked: 0 })),
    rows: [[601, X, 'cv:under_qualified', 'reed'], [602, X, 'resurface:started', 'reed'], [603, X, 'cv:over_qualified', 'reed'], [603, Z, 'resurface:started', 'reed'], [604, X, 'reed:snippet', 'reed'], [604, Z, 'cv:a', 'reed']],
  });
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: undefined });
  cdb.closeDb();
  let r = reed([601, 602, 603, 604]);
  assert.deepEqual([ids(r.legacy), r.scoped], [[602], []], 'only the person with no CV rejection is let through without CV_SCREEN: the old skip for the rest');
  H.settings({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: undefined });
  cdb.closeDb();
  r = reed([601, 602, 603, 604]);
  assert.deepEqual([ids(r.resurface), r.legacy, r.scoped], [[601, 602, 603, 604], [], []], 'the CV rule has them all, once, and none of them is called legacy');
  H.settings({ CV_SCREEN: 'on', CV_RESURFACE: 'off', ROLE_SCOPE_LEGACY: undefined });
  cdb.closeDb();
  r = reed([601, 602, 603, 604]);
  assert.deepEqual([ids(r.resurface), r.scoped], [[602], []], 'CV_RESURFACE off: the CV rejections are skipped again');
});

test('RL9 no flood (Reed): 500 legacy profiles are all let through to the normal screening and none is capped by the daily cap of the CV rule; what bounds them is the page, the run limit and the daily views', () => {
  const idsList = Array.from({ length: 500 }, (_, i) => 10000 + i);
  H.build({ cands: idsList.map((id) => ({ reed_id: id, unlocked: 0 })) });
  H.settings({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: undefined, CV_RESURFACE_MAX_PER_DAY: 3 });
  cdb.closeDb();
  const r = reed(idsList);
  assert.equal(r.legacy.length, 500);
  assert.equal(r.capped, 0, 'the cap is for the unlocks of Caterer and the CV looks of Reed');
  assert.deepEqual(rs.readState().today.started, 0, 'classifying takes no slot and writes nothing');
});

test('RL10 one list, one kind per person: the CV rule wins over the role scope, and a person is never listed twice or in two kinds', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }, { caterer_id: 102, unlocked: 1, created: null }], rows: [[102, X, 'cv:under_qualified']] });
  H.settings({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: undefined });
  cdb.closeDb();
  const d = H.withDb((db) => rs.classifyDetailed(db, 'caterer', [101, 102, 101], Y, {}));
  assert.deepEqual(d.map((i) => [i.id, i.kind]), [[101, 'legacy'], [102, 'resurface']]);
});
