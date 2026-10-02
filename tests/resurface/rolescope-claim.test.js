'use strict';
// The claim of the role scope (docs/ROLESCOPE.md): ONE mechanism for the CV rule and for people whose role was never recorded. The claim is a
// candidate_rejections row for the new title (origin resurface:started) written BEFORE the person is fetched again, atomically, so a crash, a retry, an
// overlapping run, a recovered queue and a second territory all find it. A Caterer look takes a slot of the daily cap; a Reed look of an unrecorded role
// takes none (the Reed daily views and the run limits bound it). Whatever the outcome the role is recorded: the same role is never charged twice.
const H = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const rs = require('../../resourcer/scripts/lib/resurface');
const cdb = require('../../resourcer/candidates-db');

test.after(() => { cdb.closeDb(); H.ws.cleanup(); });
test.beforeEach(() => { cdb.closeDb(); H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'shadow' }); });

const X = 'Head Chef';
const Y = 'Kitchen Porter';
const Z = 'Sous Chef';
const claim = (id, title, extra, source) => H.withDb((db) => rs.claim(db, Object.assign({ source: source || 'caterer', id, jobTitle: title }, extra || {})));
const reedClaim = (id, title, extra) => claim(id, title, extra, 'reed');
const state = () => rs.readState().today;

function world() {
  return H.build({
    cands: [
      { caterer_id: 101, unlocked: 1, created: null }, // legacy, no record
      { caterer_id: 102, unlocked: 1 }, // young: the old skip
      { caterer_id: 103, unlocked: 1, created: null, zoho_id: 'ZOHO-103' }, // pushed
      { reed_id: 201, unlocked: 0 }, // Reed, seen only, no row: role unknown
      { reed_id: 202, unlocked: 0 }, // Reed, rejected for X at the snippet stage (reed:snippet)
      { reed_id: 203, unlocked: 0, zoho_id: 'ZOHO-203' },
    ],
    rows: [[202, X, 'reed:snippet', 'reed']],
  });
}

test('RC1 the claim of a Caterer person whose role was never recorded: written first, durable, takes a slot of the cap, independent of CV_SCREEN; young and pushed people are refused', () => {
  world();
  for (const mode of ['shadow', 'off', undefined]) {
    H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: mode });
    H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }] });
    assert.deepEqual(claim(101, Y), { claimed: true, kind: 'legacy', slot: true }, `CV_SCREEN ${mode}`);
    assert.deepEqual(H.rows(101), [{ title: Y, origin: 'resurface:started' }]);
    assert.equal(state().started, 1);
    assert.equal(H.candidate(101).unlocked, 1);
  }
  world();
  assert.deepEqual(claim(102, Y), { claimed: false, why: 'not-eligible' }, 'young: the stranded recovery owns it');
  assert.deepEqual(claim(103, Y), { claimed: false, why: 'not-eligible' }, 'pushed: never');
  assert.deepEqual(H.rows(102), []);
  assert.deepEqual(H.rows(103), []);
  assert.equal(rs.readState().today.started, 0, 'refused claims take no slot');
});

test('RC2 never twice for the same role, a new role is fine, with no limit on the number of distinct roles: the look records its role', () => {
  world();
  const roles = ['Kitchen Porter', 'Sous Chef', 'Commis Chef', 'Pastry Chef', 'Line Cook', 'Head Chef'];
  for (const r of roles) assert.equal(claim(101, r).claimed, true, r);
  for (const r of roles) assert.equal(claim(101, r).claimed, false, `${r} again`);
  assert.deepEqual(H.rows(101).map((x) => x.title), roles);
  assert.equal(state().started, roles.length);
  // the same through the dedupe of the next search: nothing is let through for a role that has its row
  cdb.closeDb();
  for (const r of roles) assert.deepEqual(cdb.classifyBatchScoped([101], r).resurface, [], r);
  assert.deepEqual(cdb.classifyBatchScoped([101], 'Waiter').resurface, [101], 'a role nobody looked at: fine');
});

test('RC3 a crash after the claim: the row is on disk, the next process (a retry, a second territory, a recovered queue) finds it and never charges the role twice', () => {
  world();
  // a real process that claims and is killed right away, before it could do anything else (no unlock, no release, no counter update)
  const script = `const rs = require(${JSON.stringify(path.join(H.REPO, 'resourcer/scripts/lib/resurface'))}); const cdb = require(${JSON.stringify(H.CLI)});
    const r = rs.claim(cdb.getDb(), { source: 'caterer', id: 101, jobTitle: ${JSON.stringify(Y)} }); process.stdout.write(JSON.stringify(r)); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env), cwd: H.ws.home, encoding: 'utf8' });
  assert.ok(child.signal === 'SIGKILL' || child.status !== 0, 'the process was killed');
  assert.deepEqual(H.rows(101), [{ title: Y, origin: 'resurface:started' }], 'durable');
  cdb.closeDb();
  assert.equal(claim(101, Y).claimed, false);
  assert.deepEqual(cdb.classifyBatchScoped([101], Y).resurface, []);
  assert.deepEqual(cdb.classifyBatchScoped([101], Z).legacy, [101], 'a different role is still fine');
  // and for Reed
  const reedScript = `const rs = require(${JSON.stringify(path.join(H.REPO, 'resourcer/scripts/lib/resurface'))}); const cdb = require(${JSON.stringify(H.CLI)});
    rs.claim(cdb.getDb(), { source: 'reed', id: 201, jobTitle: ${JSON.stringify(Y)} }); process.kill(process.pid, 'SIGKILL');`;
  spawnSync(process.execPath, ['-e', reedScript], { env: Object.assign({}, process.env), cwd: H.ws.home, encoding: 'utf8' });
  assert.deepEqual(H.rows(201, 'reed'), [{ title: Y, origin: 'resurface:started' }]);
  cdb.closeDb();
  assert.equal(reedClaim(201, Y).claimed, false);
  assert.deepEqual(cdb.resurfaceBatchReed([201], Y).judged, [201], 'the Reed dedupe skips it for this title');
});

test('RC4 overlapping processes: eight claim the same person and role at the same moment, exactly one wins, and the cap loses exactly one slot (Caterer); a Reed legacy claim takes no slot', async () => {
  world();
  const answers = await Promise.all(Array.from({ length: 8 }, () => H.cli(['resurface-claim', 'caterer', '101', Y])));
  const won = answers.filter((a) => a.json() && a.json().claimed === true);
  assert.equal(won.length, 1, answers.map((a) => a.stdout + a.stderr).join(' | '));
  assert.deepEqual(won[0].json(), { claimed: true, kind: 'legacy', slot: true });
  for (const a of answers) assert.equal(a.code, 0);
  assert.equal(H.rows(101).filter((r) => r.title === Y).length, 1);
  assert.equal(state().started, 1);
  const reedAnswers = await Promise.all(Array.from({ length: 8 }, () => H.cli(['resurface-claim', 'reed', '201', Y])));
  const reedWon = reedAnswers.filter((a) => a.json() && a.json().claimed === true);
  assert.equal(reedWon.length, 1, reedAnswers.map((a) => a.stdout + a.stderr).join(' | '));
  assert.deepEqual(reedWon[0].json(), { claimed: true, kind: 'legacy', slot: false });
  assert.equal(H.rows(201, 'reed').filter((r) => r.title === Y).length, 1);
  assert.equal(state().started, 1, 'the Reed claim took no slot of the cap');
});

test('RC5 Reed: the claim of a seen-only person with no row takes no slot and no cap; a person rejected for another title only is "scoped" and is never claimed; a person in Zoho is refused', () => {
  world();
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: undefined, CV_RESURFACE_MAX_PER_DAY: 1 });
  assert.deepEqual(reedClaim(201, Y), { claimed: true, kind: 'legacy', slot: false });
  assert.deepEqual(reedClaim(201, Z), { claimed: true, kind: 'legacy', slot: false }, 'a new role');
  assert.deepEqual(claim(101, Y), { claimed: true, kind: 'legacy', slot: true }, 'the Caterer look still has its slot');
  assert.deepEqual(claim(101, Z), { claimed: false, why: 'cap' });
  assert.deepEqual(reedClaim(202, Y), { claimed: false, why: 'not-eligible' }, 'scoped: an ordinary first screening, nothing to claim');
  assert.deepEqual(reedClaim(203, Y), { claimed: false, why: 'not-eligible' }, 'pushed');
  assert.deepEqual(H.rows(202, 'reed'), [{ title: X, origin: 'reed:snippet' }]);
  assert.equal(state().started, 1);
});

test('RC6 release gives back the slot only when the claim took one; a Reed legacy claim released does not touch the counters', () => {
  world();
  assert.equal(claim(101, Y).claimed, true);
  assert.equal(reedClaim(201, Y).claimed, true);
  assert.equal(state().started, 1);
  H.withDb((db) => assert.equal(rs.release(db, { source: 'reed', id: 201, jobTitle: Y, slot: false }), true));
  assert.equal(state().started, 1, 'no slot was taken, none is given back');
  assert.deepEqual(H.rows(201, 'reed'), []);
  H.withDb((db) => assert.equal(rs.release(db, { source: 'caterer', id: 101, jobTitle: Y }), true));
  assert.equal(state().started, 0);
  assert.equal(claim(101, Y).claimed, true, 'a released role is free again');
});

test('RC7 the CV rule and the role scope are ONE mechanism: a person the CV rule has is claimed as "resurface" (never "legacy"), once, with one row', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }], rows: [[101, X, 'cv:under_qualified']] });
  H.settings({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: undefined });
  assert.deepEqual(claim(101, Y), { claimed: true, kind: 'resurface', slot: true });
  assert.equal(claim(101, Y).claimed, false);
  assert.deepEqual(H.rows(101).map((r) => r.title), [X, Y]);
  // with the CV stage not on the same person has a CV rejection and is not claimed at all (the old skip), whatever the role scope says
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }], rows: [[101, X, 'cv:under_qualified']] });
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: undefined });
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'not-eligible' });
});

test('RC8 the switches are checked by the claim too: ROLE_SCOPE_LEGACY off and CV_SCREEN not on claims nothing (disabled); the typo of the switch is off', () => {
  world();
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: 'off' });
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'disabled' });
  assert.deepEqual(reedClaim(201, Y), { claimed: false, why: 'disabled' });
  H.settings({ CV_SCREEN: 'shadow', ROLE_SCOPE_LEGACY: 'ofF-ish' });
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'disabled' });
  assert.deepEqual(H.rows(101), []);
  assert.equal(fs.existsSync(H.stateFile()), false, 'a refused claim writes no counter file');
});

test('RC9 an unreadable state degrades to the old skip, never a crash: a counter file that cannot be written, a database that cannot be written, a person that does not exist', () => {
  world();
  fs.rmSync(path.join(H.ws.home, 'runtime'), { recursive: true, force: true });
  fs.writeFileSync(path.join(H.ws.home, 'runtime'), 'not a directory');
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'error' }, 'a Caterer look without its slot is not made');
  assert.deepEqual(H.rows(101), []);
  assert.deepEqual(reedClaim(201, Y), { claimed: true, kind: 'legacy', slot: false }, 'a Reed look needs no slot: the counters are accounting, not the guard');
  assert.equal(rs.record({ kind: 'charged', views: 1, legacy: true, look: 'reed' }), false, 'a counter that cannot be written is reported as false, never thrown');
  fs.rmSync(path.join(H.ws.home, 'runtime'));
  fs.mkdirSync(path.join(H.ws.home, 'runtime'));
  assert.deepEqual(claim(999999, Y), { claimed: false, why: 'not-eligible' });
  assert.deepEqual(claim('banana', Y), { claimed: false, why: 'not-eligible' });
  assert.deepEqual(claim(101, ''), { claimed: false, why: 'not-eligible' });
  const broken = H.withDb((db) => { db.exec('DROP INDEX idx_rej_caterer'); db.exec("CREATE TRIGGER no_more BEFORE INSERT ON candidate_rejections BEGIN SELECT RAISE(ABORT, 'read only'); END"); return rs.claim(db, { source: 'caterer', id: 101, jobTitle: Y }); });
  assert.deepEqual(broken, { claimed: false, why: 'error' });
  assert.equal(state().started, 0, 'the slot of the failed claim went back');
  assert.deepEqual(rs.claim(null, { source: 'caterer', id: 101, jobTitle: Y }), { claimed: false, why: 'error' });
});

test('RC10 the counters of the role scope: looks given (Caterer, Reed), rejected again, pushed, charges, credits, views; mode 0600, numbers only', () => {
  world();
  rs.record({ look: 'caterer', kind: 'charged', credits: 1, legacy: true });
  rs.record({ look: 'caterer', kind: 'notCharged', legacy: true });
  rs.record({ look: 'reed', kind: 'charged', views: 2, legacy: true });
  rs.record({ legacyRejected: true });
  rs.record({ pushed: true, legacy: true });
  rs.record({ rejected: true, legacy: true });
  rs.record({ pushed: true }); // not a person of the role scope
  const t = state();
  assert.deepEqual([t.legacyCaterer, t.legacyReed, t.legacyCharged, t.legacyCredits, t.legacyViews, t.legacyRejected, t.legacyPushed], [2, 1, 2, 1, 2, 2, 1]);
  assert.deepEqual([t.charged, t.credits, t.reedViews, t.pushed, t.rejected], [2, 1, 2, 2, 1], 'the legacy numbers are part of the RESURFACED numbers, not extra');
  assert.equal(fs.statSync(H.stateFile()).mode & 0o777, 0o600);
  for (const [k, v] of Object.entries(t)) if (k !== 'day' && k !== 'failed') assert.equal(typeof v, 'number', k);
  // an older counter file without the new keys reads as zeros
  fs.writeFileSync(H.stateFile(), JSON.stringify({ version: 1, today: { day: rs.londonDay(), started: 3 }, history: [{ day: '2026-09-01', started: 1 }], alertDays: {} }));
  assert.deepEqual([state().started, state().legacyReed], [3, 0]);
});

test('RC11 the command line: resurface-reject ... legacy records resurface:snippet for the role and counts the look once; again it records nothing', async () => {
  world();
  const a = await H.cli(['resurface-reject', 'caterer', '101', Y, 'legacy']);
  assert.deepEqual(a.json(), { recorded: true });
  assert.deepEqual(H.rows(101), [{ title: Y, origin: 'resurface:snippet' }]);
  assert.deepEqual([state().legacyCaterer, state().legacyRejected], [1, 1]);
  const b = await H.cli(['resurface-reject', 'caterer', '101', Y, 'legacy']);
  assert.deepEqual(b.json(), { recorded: false });
  assert.deepEqual([state().legacyCaterer, state().legacyRejected], [1, 1], 'not counted twice');
  const c = await H.cli(['resurface-reject', 'caterer', '101', Z]);
  assert.deepEqual(c.json(), { recorded: true });
  assert.equal(state().legacyCaterer, 1, 'without the word legacy nothing is counted as a look of the role scope');
  // and the person is eligible for another role, never for these two
  cdb.closeDb();
  assert.deepEqual(cdb.classifyBatchScoped([101], Y).resurface, []);
  assert.deepEqual(cdb.classifyBatchScoped([101], Z).resurface, []);
  assert.deepEqual(cdb.classifyBatchScoped([101], 'Waiter').legacy, [101]);
});

test('RC12 the write helpers of Reed: reed:snippet and reed:approved rows are written without any switch, once per person and title, never over an existing row', () => {
  world();
  for (const v of ['off', undefined]) {
    H.settings({ CV_SCREEN: 'off', CV_RESURFACE: 'off', ROLE_SCOPE_LEGACY: v });
    H.withDb((db) => assert.equal(rs.recordSnippetReject(db, { source: 'reed', id: 201, jobTitle: `T-${v}`, origin: rs.ORIGIN_REED_SNIPPET }), true));
  }
  H.withDb((db) => assert.equal(rs.recordSnippetReject(db, { source: 'reed', id: 201, jobTitle: 'T-off', origin: rs.ORIGIN_REED_APPROVED }), false, 'a row for this title exists: the first one stays'));
  H.withDb((db) => assert.equal(rs.recordSnippetReject(db, { source: 'reed', id: 201, jobTitle: 'A', origin: rs.ORIGIN_REED_APPROVED }), true));
  H.withDb((db) => assert.equal(rs.recordSnippetReject(db, { source: 'caterer', id: 101, jobTitle: 'A', origin: rs.ORIGIN_REED_APPROVED }), true));
  assert.deepEqual(H.rows(201, 'reed').map((r) => [r.title, r.origin]), [['T-off', 'reed:snippet'], ['T-undefined', 'reed:snippet'], ['A', 'reed:approved']]);
  assert.deepEqual(H.rows(101), [{ title: 'A', origin: 'resurface:snippet' }], 'a Caterer row never gets a Reed origin');
});
