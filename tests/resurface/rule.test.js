'use strict';
// The rule of the role-scoped second look (scripts/lib/resurface.js classify, read through candidates-db.js): an UNLOCKED candidate is not skipped for
// the search title R when (a) never pushed, (b) a record of an unlock-and-reject exists (a CV rejection or a row of the second look, or a legacy row with no
// usable title; a plain pre-unlock rejection of another role is NOT one), (c) none for R, (d) the cap allows, (e) CV_RESURFACE and CV_SCREEN=on; nothing in flight. Everything else keeps the old skip. A real SQLite file in the legacy schema, no mocks.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rs = require('../../resourcer/scripts/lib/resurface');
const cdb = require('../../resourcer/candidates-db');

test.after(() => { cdb.closeDb(); H.ws.cleanup(); });
test.beforeEach(() => { cdb.closeDb(); H.settings(); });

const X = 'Head Chef';
const Y = 'Kitchen Porter';
const Z = 'Sous Chef';

// every shape of candidate the rule has to tell apart
function world() {
  return H.build({
    cands: [
      { caterer_id: 101, unlocked: 1 }, // rejected by the CV stage for X
      { caterer_id: 102, unlocked: 1, zoho_id: 'ZOHO-102' }, // pushed
      { caterer_id: 103, unlocked: 1, pushed_at: '2026-09-02 10:00:00' }, // a push is recorded only by the timestamp
      { caterer_id: 104, unlocked: 1 }, // stranded: no record at all
      { caterer_id: 105, unlocked: 1 }, // rejected for Y itself
      { caterer_id: 106, unlocked: 1 }, // an unfinished claim for Y
      { caterer_id: 107, unlocked: 1 }, // legacy: the sentinel
      { caterer_id: 108, unlocked: 0 }, // not unlocked, the sentinel
      { caterer_id: 109, unlocked: 0 }, // not unlocked, rejected for X by the snippet screening
      { caterer_id: 110, unlocked: 1 }, // a real title, origin pipeline only: a pre-unlock rejection, may be a failed push of another role: old skip
      { caterer_id: 111, unlocked: 1 }, // rejected for X and Y
      { caterer_id: 112, unlocked: 0 }, // never rejected, never unlocked
      { caterer_id: 113, unlocked: 1 }, // legacy: a real title, origin log-backfill only: same as 110
      { caterer_id: 114, unlocked: 1 }, // legacy: an empty title (role unknown)
      { caterer_id: 115, unlocked: 1 }, // Phase 1's own review rejected it after the unlock, for X
    ],
    rows: [
      [101, X, 'cv:under_qualified'],
      [102, X, 'cv:under_qualified'],
      [103, X, 'cv:under_qualified'],
      [105, Y, 'cv:over_qualified'],
      [105, X, 'cv:under_qualified'],
      [106, X, 'cv:under_qualified'],
      [106, Y, 'resurface:started'],
      [107, '*', 'log-backfill'],
      [108, '*', 'log-backfill'],
      [109, X, 'pipeline'],
      [110, X, 'pipeline'],
      [111, X, 'cv:under_qualified'],
      [111, Y, 'resurface:pushed'],
      [113, X, 'log-backfill'],
      [114, '', 'pipeline'],
      [115, X, 'resurface:postunlock'],
    ],
  });
}

const IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
const skip = (title) => cdb.checkCandidatesBatchScoped(IDS, title).slice().sort((a, b) => a - b);
const again = (title) => cdb.classifyBatchScoped(IDS, title).resurface.slice().sort((a, b) => a - b);

test('R1 the rule: an unlocked, never-pushed candidate rejected for another role is not skipped; everyone else keeps the old skip', () => {
  world();
  // for Y: 101 (CV rejected for X), 107 (sentinel), 114 (empty title), 115 (rejected after the unlock for X); 111 is rejected for Y already (resurface:pushed);
  // 110 and 113 have only a plain pre-unlock row of another role: no record of an unlock-and-reject, old skip
  assert.deepEqual(again(Y), [101, 107, 114, 115]);
  assert.deepEqual(skip(Y), [102, 103, 104, 105, 106, 108, 110, 111, 113]);
  // 109 (not unlocked) was never skipped for Y, 112 neither: they are screened as before
  assert.ok(!skip(Y).includes(109) && !skip(Y).includes(112));
  // for Z: also 105, 106 and 111, who were judged for other roles only
  assert.deepEqual(again(Z), [101, 105, 106, 107, 111, 114, 115]);
  assert.deepEqual(skip(Z), [102, 103, 104, 108, 110, 113]);
});

test('R1 (a) a candidate with a Zoho id, or a recorded push, is never resurfaced', () => {
  world();
  assert.ok(!again(Y).includes(102), 'zoho_id set');
  assert.ok(!again(Y).includes(103), 'zoho_pushed_at set');
  assert.ok(skip(Y).includes(102) && skip(Y).includes(103));
});

test('R1 (b) an unlocked candidate with no rejection record at all (stranded, failed processing) keeps the old skip', () => {
  world();
  assert.ok(!again(Y).includes(104));
  assert.ok(skip(Y).includes(104) && skip(Z).includes(104));
});

test('R1 (c) a row for the search title blocks, of any origin, including an unfinished claim (resurface:started)', () => {
  world();
  assert.ok(!again(Y).includes(105), 'a CV rejection for Y');
  assert.ok(!again(Y).includes(106), 'resurface:started for Y');
  assert.ok(!again(Y).includes(111), 'resurface:pushed for Y');
  // the same candidates are free for another role
  assert.ok(again(Z).includes(105) && again(Z).includes(106) && again(Z).includes(111));
});

test('C11 the sentinel * on an unlocked, never-pushed candidate means "role unknown"; on a candidate that is not unlocked it still blocks every title', () => {
  world();
  assert.ok(again(Y).includes(107) && again(Z).includes(107), 'role unknown: eligible for any role');
  assert.ok(skip(Y).includes(108) && skip(Z).includes(108) && skip(X).includes(108), 'not unlocked: the old rule, * blocks every title');
  assert.ok(!again(Y).includes(108));
});

test('C3 C11 a plain pre-unlock rejection (a real title, origin pipeline or log-backfill) is no record of an unlock-and-reject: an unlocked, never-pushed candidate with only that keeps the old skip for every title', () => {
  world();
  // 110 could be an unlock for Y whose push failed, with an earlier snippet rejection for X: a second charge for Y would be a second charge for the same role
  for (const id of [110, 113]) {
    assert.ok(!again(Y).includes(id) && !again(Z).includes(id) && !again(X).includes(id), `${id}: never resurfaced`);
    assert.ok(skip(Y).includes(id) && skip(Z).includes(id) && skip(X).includes(id), `${id}: skipped for every title, as before`);
  }
});

test('C11 a legacy row with an empty title is role unknown (like the sentinel); a row written after an unlock (resurface:postunlock) is a known role: eligible for any other title, blocked for its own', () => {
  world();
  assert.ok(again(Y).includes(114) && again(Z).includes(114) && again(X).includes(114), 'role unknown: any title (the claim then records it)');
  assert.ok(again(Y).includes(115) && again(Z).includes(115), 'known role X: eligible for others');
  assert.ok(!again(X).includes(115) && skip(X).includes(115), 'its own title');
});

test('C11 the unlock-and-reject records are exactly: cv:..., resurface:..., a title of * or empty (isPostUnlockRecord)', () => {
  const f = rs.isPostUnlockRecord;
  assert.equal(f({ title: X, origin: 'cv:under_qualified' }), true);
  assert.equal(f({ title: X, origin: 'resurface:started' }), true);
  assert.equal(f({ title: X, origin: 'resurface:postunlock' }), true);
  assert.equal(f({ title: '*', origin: 'pipeline' }), true);
  assert.equal(f({ title: '*', origin: 'log-backfill' }), true);
  assert.equal(f({ title: '', origin: null }), true);
  assert.equal(f({ title: null, origin: 'pipeline' }), true);
  assert.equal(f({ title: X, origin: 'pipeline' }), false);
  assert.equal(f({ title: X, origin: 'log-backfill' }), false);
  assert.equal(f({ title: X, origin: null }), false);
  assert.equal(f({ title: X, origin: 'something-else' }), false);
});

test('C4 pre-unlock (snippet) rejections of a candidate who is not unlocked are exactly as before: skipped for their title only', () => {
  world();
  assert.ok(skip(X).includes(109));
  assert.ok(!skip(Y).includes(109) && !skip(Z).includes(109));
  assert.ok(!again(Y).includes(109) && !again(X).includes(109), 'never part of the second look');
});

test('R1 (e) CV_SCREEN shadow, off or unset: the rule never fires and the skip list is the old one, byte for byte', () => {
  world();
  H.settings({ CV_SCREEN: undefined });
  const old = skip(Y);
  assert.deepEqual(old, [101, 102, 103, 104, 105, 106, 107, 108, 110, 111, 113, 114, 115]);
  for (const mode of ['shadow', 'off', 'sahdow', '']) {
    H.settings({ CV_SCREEN: mode });
    assert.deepEqual(skip(Y), old, `CV_SCREEN=${mode}`);
    assert.deepEqual(again(Y), []);
  }
  H.settings({ CV_SCREEN: 'on' });
  assert.notDeepEqual(skip(Y), old);
});

test('R1 (e) CV_RESURFACE=off restores the old skip exactly; a value that is neither on nor off is off, never on; unset is on', () => {
  world();
  H.settings({ CV_RESURFACE: undefined });
  assert.deepEqual(again(Y), [101, 107, 114, 115]);
  H.settings({ CV_RESURFACE: 'on' });
  assert.deepEqual(again(Y), [101, 107, 114, 115]);
  const old = (H.settings({ CV_SCREEN: 'shadow' }), skip(Y));
  H.settings({ CV_RESURFACE: 'off' });
  assert.deepEqual(skip(Y), old);
  assert.deepEqual(again(Y), []);
  H.settings({ CV_RESURFACE: 'OFF ' });
  assert.deepEqual(again(Y), []);
  for (const typo of ['of', 'offf', 'onn', 'nope']) {
    H.settings({ CV_RESURFACE: typo });
    assert.deepEqual(again(Y), [], `CV_RESURFACE=${typo} is not "on"`);
    assert.ok(rs.settings().warnings.length >= 1, 'the typo is reported (Phase 1 and cv-report print it)');
  }
  for (const word of ['false', '0', 'no']) {
    H.settings({ CV_RESURFACE: word });
    assert.deepEqual(again(Y), [], `CV_RESURFACE=${word} is off`);
    assert.equal(rs.settings().warnings.length, 0, 'a clear off is not a typo');
  }
  for (const word of ['ON', 'true', '1', 'yes', ' On ']) {
    H.settings({ CV_RESURFACE: word });
    assert.deepEqual(again(Y), [101, 107, 114, 115], `CV_RESURFACE=${word} is on`);
    assert.equal(rs.settings().warnings.length, 0);
  }
});

test('R1 (d) the daily cap: only as many as it allows are looked at again, the rest stay skipped and are counted as held back; nothing is written', () => {
  world();
  H.settings({ CV_RESURFACE_MAX_PER_DAY: 2 });
  const r = cdb.classifyBatchScoped(IDS, Y);
  assert.deepEqual(r.resurface, [101, 107], 'the first two in the order of the page');
  assert.equal(r.capped, 2);
  assert.ok(r.skip.includes(114) && r.skip.includes(115), 'the held-back ones stay skipped');
  assert.deepEqual(H.rows(114), [{ title: '', origin: 'pipeline' }], 'nothing recorded against a candidate the cap held back');
  assert.equal(H.readState(), null, 'classifying writes no counter');
  H.settings({ CV_RESURFACE_MAX_PER_DAY: 0 });
  assert.deepEqual(cdb.classifyBatchScoped(IDS, Y).resurface, [], 'a cap of 0 is the same as off');
  H.settings({ CV_RESURFACE_MAX_PER_DAY: 'forty' });
  assert.equal(rs.settings().max, 40);
  assert.match(rs.settings().warnings.join(' '), /CV_RESURFACE_MAX_PER_DAY/);
});

test('R1 (d) slots already taken today reduce what is left; a new London day starts again', () => {
  world();
  H.settings({ CV_RESURFACE_MAX_PER_DAY: 3 });
  assert.equal(rs.reserveSlot('caterer').ok, true);
  assert.equal(rs.reserveSlot('caterer').ok, true);
  assert.equal(rs.remaining(), 1);
  assert.deepEqual(cdb.classifyBatchScoped(IDS, Y).resurface, [101]);
  assert.equal(cdb.classifyBatchScoped(IDS, Y).capped, 3);
  assert.equal(rs.remaining({ now: Date.now() + 36 * 3600 * 1000 }), 3, 'another London day');
});

test('R1 nothing in flight: a candidate file, a CV file, an entry of an unfinished queue, or a recorded push keeps the old skip; a finished queue does not', () => {
  world();
  assert.deepEqual(again(Y), [101, 107, 114, 115]);
  H.download('candidate-101.json', { Last_Name: 'x' });
  assert.deepEqual(again(Y), [107, 114, 115], 'a candidate file of Phase 2');
  H.download('cv-107.pdf', 'x');
  assert.deepEqual(again(Y), [114, 115], 'a CV file');
  H.download('approved-queue-2026-09-30-100000.json', { candidates: [{ id: '114', source: 'caterer' }] });
  assert.deepEqual(again(Y), [115], 'an entry of an unfinished queue');
  H.download('phase2-results-2026-09-30-100000.json', { completedAt: '2026-09-30T10:30:00Z', candidates: [{ id: '114', status: 'cv_rejected' }] });
  assert.deepEqual(again(Y), [114, 115], 'the queue is finished: 114 is free again, 101 and 107 are held back by their own files');
  fs.unlinkSync(path.join(H.ws.downloads, 'candidate-101.json'));
  fs.unlinkSync(path.join(H.ws.downloads, 'cv-107.pdf'));
  assert.deepEqual(again(Y), [101, 107, 114, 115], 'a finished queue holds nobody back');
  H.download('merged-queue-2026-09-30-110000.json', { candidates: [{ id: '101' }] });
  assert.deepEqual(again(Y), [107, 114, 115], 'a merged queue counts too');
  fs.unlinkSync(path.join(H.ws.downloads, 'merged-queue-2026-09-30-110000.json'));
  H.download('phase2-results-2026-09-30-120000.json', { completedAt: '2026-09-30T12:30:00Z', candidates: [{ id: '107', status: 'new', zohoId: 'ZOHO-107' }] });
  assert.deepEqual(again(Y), [101, 114, 115], 'a results file that records a push (a crash between the Zoho write and the database write)');
});

test('R1 an unreadable database or a missing table never makes anything eligible', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1 }] });
  H.withDb((db) => db.exec('DROP TABLE candidate_rejections'));
  cdb.closeDb();
  assert.deepEqual(cdb.checkCandidatesBatchScoped([101], Y), [101], 'no rejection table: the unscoped rule, as before');
  assert.deepEqual(cdb.classifyBatchScoped([101], Y).resurface, []);
});

test('R1 Reed: a candidate with a CV rejection (cv: or resurface: row) of another role, no Zoho id, and none for this role, is looked at again; Reed snippet rejections have no row and stay skipped', () => {
  H.build({
    cands: [
      { reed_id: 201 }, // CV rejected for X
      { reed_id: 202 }, // seen only (a snippet rejection leaves no row)
      { reed_id: 203, zoho_id: 'ZOHO-203' }, // pushed
      { reed_id: 204 }, // CV rejected for Y already
      { reed_id: 205 }, // an unfinished claim for Y
      { reed_id: 206 }, // a row of another origin: not a CV rejection, keeps the old skip
    ],
    rows: [
      [201, X, 'cv:under_qualified', 'reed'],
      [203, X, 'cv:under_qualified', 'reed'],
      [204, X, 'cv:under_qualified', 'reed'],
      [204, Y, 'cv:no_relevant_experience', 'reed'],
      [205, X, 'cv:under_qualified', 'reed'],
      [205, Y, 'resurface:started', 'reed'],
      [206, X, 'something-else', 'reed'],
    ],
  });
  const ids = [201, 202, 203, 204, 205, 206];
  assert.deepEqual(cdb.resurfaceBatchReed(ids, Y).resurface.slice().sort(), [201]);
  assert.deepEqual(cdb.resurfaceBatchReed(ids, Z).resurface.slice().sort(), [201, 204, 205]);
  H.settings({ CV_SCREEN: 'shadow' });
  assert.deepEqual(cdb.resurfaceBatchReed(ids, Y).resurface, []);
  H.settings({ CV_RESURFACE: 'off' });
  assert.deepEqual(cdb.resurfaceBatchReed(ids, Z).resurface, []);
});

test('R1 Reed ids and Caterer ids never mix: a Reed row does not make a Caterer candidate eligible, and the other way round', () => {
  H.build({ cands: [{ caterer_id: 301, unlocked: 1 }, { reed_id: 301 }], rows: [[301, X, 'cv:under_qualified', 'reed']] });
  assert.deepEqual(cdb.classifyBatchScoped([301], Y).resurface, [], 'the Caterer 301 has no row of its own');
  assert.deepEqual(cdb.resurfaceBatchReed([301], Y).resurface, [301]);
});

test('R1 the pipeline asks through the CLI: with the switch off the answer is exactly {"inDb":[...]}; with it on the two extra keys appear only when there is something to say', async () => {
  world();
  H.settings({ CV_SCREEN: 'shadow' });
  const off = await H.cli(['check-batch-scoped', '101,104,107', Y]);
  assert.equal(off.code, 0);
  assert.equal(off.stdout, '{"inDb":[101,104,107]}');
  H.settings({ CV_SCREEN: 'on' });
  const on = await H.cli(['check-batch-scoped', '101,104,107', Y]);
  assert.deepEqual(JSON.parse(on.stdout), { inDb: [104], resurface: [101, 107], resurfaceCapped: 0 });
  const nothing = await H.cli(['check-batch-scoped', '104,112', Y]);
  assert.equal(nothing.stdout, '{"inDb":[104]}', 'no key when nothing was found');
  H.settings({ CV_SCREEN: 'on', CV_RESURFACE_MAX_PER_DAY: 1 });
  const capped = await H.cli(['check-batch-scoped', '101,104,107', Y]);
  assert.deepEqual(JSON.parse(capped.stdout), { inDb: [104, 107], resurface: [101], resurfaceCapped: 1 });
});
