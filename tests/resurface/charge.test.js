'use strict';
// The charging rule (docs/RESURFACE.md, C11): a second charge only for a DIFFERENT role, never twice for the same role. The claim (a candidate_rejections
// row for the new title, origin resurface:started) is written BEFORE the candidate is fetched again; it is atomic, so a crash, a retry, an overlapping run
// and a recovered queue all find it. Plus the accounting: the cap, the counters, the measurement and the once-a-day warning.
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
const claim = (id, title, extra) => H.withDb((db) => rs.claim(db, Object.assign({ source: 'caterer', id, jobTitle: title }, extra || {})));

function world() {
  return H.build({
    cands: [{ caterer_id: 101, unlocked: 1 }, { caterer_id: 107, unlocked: 1 }, { caterer_id: 104, unlocked: 1 }, { caterer_id: 102, unlocked: 1, zoho_id: 'Z' }],
    rows: [[101, X, 'cv:under_qualified'], [107, '*', 'log-backfill'], [102, X, 'cv:under_qualified']],
  });
}

test('C11 the claim is written first and is durable: one row for the new title, origin resurface:started, the old row untouched', () => {
  world();
  assert.deepEqual(claim(101, Y), { claimed: true, kind: 'resurface', slot: true });
  assert.deepEqual(H.rows(101), [{ title: X, origin: 'cv:under_qualified' }, { title: Y, origin: 'resurface:started' }]);
  assert.equal(H.candidate(101).unlocked, 1, 'the candidate stays unlocked: a second unlock is never a first unlock');
});

test('C11 never twice for the same role: a retry, a second territory, a recovered queue and a restarted process all find the claim', () => {
  world();
  assert.equal(claim(101, Y).claimed, true);
  const again = claim(101, Y);
  assert.equal(again.claimed, false);
  assert.match(again.why, /not-eligible|already-claimed/);
  // a "new process": a fresh connection, a fresh module state; the row on disk is all that is left of the first run
  cdb.closeDb();
  assert.deepEqual(cdb.classifyBatchScoped([101], Y).resurface, [], 'the dedupe of the next search skips it');
  assert.equal(claim(101, Y).claimed, false);
  assert.equal(H.rows(101).filter((r) => r.title === Y).length, 1);
  assert.equal(rs.readState().today.started, 1, 'the refused claims took no slot of the cap');
});

test('C11 a new role is charged: any number of distinct roles, each once', () => {
  world();
  assert.equal(claim(101, Y).claimed, true);
  assert.equal(claim(101, Z).claimed, true);
  assert.equal(claim(101, 'Commis Chef').claimed, true);
  assert.equal(claim(101, Z).claimed, false);
  assert.deepEqual(H.rows(101).map((r) => r.title), [X, Y, Z, 'Commis Chef']);
});

test('C11 legacy, role unknown (the sentinel): ONE second charge for any role, which records its role; the same role never again, another new role still fine', () => {
  world();
  assert.equal(claim(107, Y).claimed, true);
  assert.equal(claim(107, Y).claimed, false, 'the same role is not charged a third time');
  assert.equal(claim(107, X).claimed, true, 'a further new role is fine');
  assert.deepEqual(H.rows(107).map((r) => r.title), ['*', Y, X]);
});

test('C3 a pushed candidate and a candidate with no record are never claimed', () => {
  world();
  assert.deepEqual(claim(102, Y), { claimed: false, why: 'not-eligible' });
  assert.deepEqual(claim(104, Y), { claimed: false, why: 'not-eligible' });
  assert.deepEqual(H.rows(102), [{ title: X, origin: 'cv:under_qualified' }]);
  assert.deepEqual(H.rows(104), []);
  assert.equal(rs.readState().today.started, 0);
});

test('C11 overlapping runs: eight processes claim the same candidate and role at the same moment, exactly one wins, and the cap loses exactly one slot', async () => {
  world();
  const answers = await Promise.all(Array.from({ length: 8 }, () => H.cli(['resurface-claim', 'caterer', '101', Y])));
  const won = answers.filter((a) => a.json() && a.json().claimed === true);
  assert.equal(won.length, 1, answers.map((a) => a.stdout + a.stderr).join(' | '));
  for (const a of answers) assert.equal(a.code, 0);
  assert.equal(H.rows(101).filter((r) => r.title === Y).length, 1);
  assert.equal(rs.readState().today.started, 1);
  // and a race for different candidates never loses a count
  H.build({ cands: [201, 202, 203, 204, 205, 206].map((id) => ({ caterer_id: id, unlocked: 1 })), rows: [201, 202, 203, 204, 205, 206].map((id) => [id, X, 'cv:under_qualified']) });
  const many = await Promise.all([201, 202, 203, 204, 205, 206].map((id) => H.cli(['resurface-claim', 'caterer', String(id), Y])));
  assert.equal(many.filter((a) => a.json().claimed === true).length, 6);
  assert.equal(rs.readState().today.started, 6, 'every claim counted once, none lost to a race on the counter file');
});

test('C8 the daily cap: claims stop at the cap, nothing is recorded against the candidate the cap stopped, a new day starts again', () => {
  H.build({ cands: [301, 302, 303].map((id) => ({ caterer_id: id, unlocked: 1 })), rows: [301, 302, 303].map((id) => [id, X, 'cv:under_qualified']) });
  H.settings({ CV_RESURFACE_MAX_PER_DAY: 2 });
  assert.equal(claim(301, Y).claimed, true);
  assert.equal(claim(302, Y).claimed, true);
  assert.deepEqual(claim(303, Y), { claimed: false, why: 'cap' });
  assert.deepEqual(H.rows(303), [{ title: X, origin: 'cv:under_qualified' }], 'not rejected, nothing recorded: eligible again after the reset');
  const tomorrow = Date.now() + 30 * 3600 * 1000;
  assert.equal(claim(303, Y, { now: tomorrow }).claimed, true);
  const st = rs.readState(tomorrow);
  assert.equal(st.today.started, 1);
  assert.equal(st.history.length, 1);
  assert.equal(st.history[0].started, 2, 'yesterday is kept in the history for the report');
});

test('C8 a claim that is taken back (the unlock failed and nothing was spent) frees its slot and its role; a claim that is not "started" is never deleted', () => {
  world();
  assert.equal(claim(101, Y).claimed, true);
  assert.equal(H.withDb((db) => rs.release(db, { source: 'caterer', id: 101, jobTitle: Y })), true);
  assert.deepEqual(H.rows(101), [{ title: X, origin: 'cv:under_qualified' }]);
  assert.equal(rs.readState().today.started, 0);
  assert.equal(claim(101, Y).claimed, true, 'the role can be tried again');
  H.withDb((db) => db.prepare("UPDATE candidate_rejections SET origin = 'cv:under_qualified' WHERE caterer_id = 101 AND job_title = ?").run(Y));
  assert.equal(H.withDb((db) => rs.release(db, { source: 'caterer', id: 101, jobTitle: Y })), false, 'a CV rejection is never taken back');
  assert.equal(H.withDb((db) => rs.release(db, { source: 'caterer', id: 101, jobTitle: X })), false, 'neither is the row of the earlier role');
});

test('R3 a failure of the accounting degrades to the old skip: no row, no push, no crash', () => {
  world();
  // the counters cannot be written: the runtime directory is a file
  fs.rmSync(path.join(H.ws.home, 'runtime'), { recursive: true, force: true });
  fs.writeFileSync(path.join(H.ws.home, 'runtime'), 'not a directory');
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'error' });
  assert.deepEqual(H.rows(101), [{ title: X, origin: 'cv:under_qualified' }], 'no claim row without its slot');
  assert.equal(rs.remaining(), 40, 'a missing counter reads as a new day, but writing it fails: the claim above is the proof');
  fs.rmSync(path.join(H.ws.home, 'runtime'));
  fs.mkdirSync(path.join(H.ws.home, 'runtime'));
  // an unreadable counter file is a new day, never an error
  fs.writeFileSync(H.stateFile(), '{ this is not json');
  assert.equal(claim(101, Y).claimed, true);
  // the database cannot be written: the slot goes back
  H.build({ cands: [{ caterer_id: 401, unlocked: 1 }], rows: [[401, X, 'cv:under_qualified']] });
  const broken = H.withDb((db) => { db.exec('DROP INDEX idx_rej_caterer'); db.exec("CREATE TRIGGER no_more BEFORE INSERT ON candidate_rejections BEGIN SELECT RAISE(ABORT, 'read only'); END"); return rs.claim(db, { source: 'caterer', id: 401, jobTitle: Y }); });
  assert.deepEqual(broken, { claimed: false, why: 'error' });
  assert.equal(rs.readState().today.started, 0, 'the slot of the failed claim was given back');
});

test('R3 the counters: one small file, mode 0600, one London day, atomic (no temporary file left), the lock is released', () => {
  world();
  claim(101, Y);
  rs.record({ kind: 'charged', credits: 1 });
  rs.record({ kind: 'notCharged' });
  rs.record({ kind: 'unknown' });
  rs.record({ kind: 'charged', views: 3 });
  rs.record({ pushed: true });
  rs.record({ rejected: true });
  rs.record({ stop: 'capped', n: 2 });
  const st = rs.readState();
  assert.equal(st.version, 1);
  assert.equal(st.today.day, rs.londonDay());
  assert.deepEqual(['started', 'caterer', 'reed', 'charged', 'notCharged', 'unknown', 'credits', 'reedViews', 'pushed', 'rejected', 'capped'].map((k) => st.today[k]), [1, 1, 0, 2, 1, 1, 1, 3, 1, 1, 2]);
  assert.equal(fs.statSync(H.stateFile()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(H.ws.home, 'runtime')).filter((n) => /\.tmp$|\.lock$/.test(n)), []);
  const text = fs.readFileSync(H.stateFile(), 'utf8');
  assert.ok(!/101|Head|Kitchen|Sous/.test(text), 'no candidate id and no title: counters only');
});

test('R3 a stale lock (a process that died holding it) does not block the counters', () => {
  world();
  fs.writeFileSync(path.join(H.ws.home, 'runtime', 'cv-resurface.lock'), '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(H.ws.home, 'runtime', 'cv-resurface.lock'), old, old);
  assert.equal(claim(101, Y).claimed, true);
});

test('C7 measure(): a charging platform, a platform that does not charge for the second look, and an unreadable balance', () => {
  assert.deepEqual(rs.measure(5000, 4999, 'credits'), { kind: 'charged', credits: 1, views: 0 });
  assert.deepEqual(rs.measure(5000, 5000, 'credits'), { kind: 'notCharged', credits: 0, views: 0 });
  assert.deepEqual(rs.measure(5000, null, 'credits'), { kind: 'unknown', credits: 0, views: 0 });
  assert.deepEqual(rs.measure(null, 5000, 'credits'), { kind: 'unknown', credits: 0, views: 0 });
  assert.deepEqual(rs.measure(undefined, undefined, 'credits'), { kind: 'unknown', credits: 0, views: 0 });
  assert.deepEqual(rs.measure(5000, 5003, 'credits'), { kind: 'unknown', credits: 0, views: 0 }, 'a balance that went UP (a top-up) is not a measurement');
  assert.deepEqual(rs.measure(10, 11, 'views'), { kind: 'charged', credits: 0, views: 1 });
  assert.deepEqual(rs.measure(10, 10, 'views'), { kind: 'notCharged', credits: 0, views: 0 });
  assert.deepEqual(rs.measure(10, 9, 'views'), { kind: 'unknown', credits: 0, views: 0 });
  assert.deepEqual(rs.measure('abc', 4, 'credits'), { kind: 'unknown', credits: 0, views: 0 });
  assert.equal(rs.combine(rs.measure(5, 5, 'credits'), rs.measure(5, 4, 'credits')).kind, 'charged');
  assert.equal(rs.combine(rs.measure(5, 5, 'credits'), rs.measure(5, null, 'credits')).kind, 'unknown');
});

test('C8 the warning: one WARN alert a day for the cap and one for the reserve, registered key, text names the setting and says nothing was recorded', () => {
  world();
  const sent = [];
  const notify = (a) => sent.push(a);
  assert.equal(rs.alertStopped({ why: 'cap', notify }), true);
  assert.equal(rs.alertStopped({ why: 'cap', notify }), false, 'once a day');
  assert.equal(rs.alertStopped({ why: 'reserve', notify }), true, 'the reserve has its own alert (the cap warning does not hide it), also once a day');
  assert.equal(rs.alertStopped({ why: 'reserve', notify }), false);
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[0].severity, sent[0].key], ['warn', 'cv-resurface-cap-reached']);
  assert.match(sent[0].text, /CV_RESURFACE_MAX_PER_DAY/);
  assert.match(sent[0].text, /nothing was recorded/);
  assert.equal(rs.alertStopped({ why: 'cap', notify, now: Date.now() + 30 * 3600 * 1000 }), true, 'the next day it is raised again');
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /cap of 40/);
});

test('C8 an alert that could not be sent does not use up the day: the next stop raises it again', () => {
  world();
  const sent = [];
  assert.equal(rs.alertStopped({ why: 'cap', notify: () => { throw new Error('delivery down'); } }), false);
  assert.equal(rs.readState().alertDays.cap, null, 'the day was given back');
  assert.equal(rs.alertStopped({ why: 'cap', notify: (a) => sent.push(a) }), true);
  assert.equal(sent.length, 1);
  assert.equal(rs.alertStopped({ why: 'cap', notify: (a) => sent.push(a) }), false);
});

test('C8 an older counter file with one alertDay still counts as "alerted today" for both reasons', () => {
  world();
  fs.mkdirSync(path.dirname(H.stateFile()), { recursive: true });
  fs.writeFileSync(H.stateFile(), JSON.stringify({ version: 1, today: { day: rs.londonDay() }, history: [], alertDay: rs.londonDay() }));
  const sent = [];
  assert.equal(rs.alertStopped({ why: 'cap', notify: (a) => sent.push(a) }), false);
  assert.equal(rs.alertStopped({ why: 'reserve', notify: (a) => sent.push(a) }), false);
  assert.equal(sent.length, 0);
});

test('C2 C8 a second look that failed with nothing spent is not tried again the same day (any run, any territory), and is free again the next day; the list is not history', () => {
  world();
  assert.equal(rs.noteFailed('caterer', 101, Y), true);
  assert.equal(rs.failedToday('caterer', 101, Y), true);
  assert.equal(rs.failedToday('caterer', 101, Z), false, 'another role is a different attempt');
  assert.equal(rs.failedToday('reed', 101, Y), false, 'another source');
  assert.deepEqual(cdb.classifyBatchScoped([101, 107], Y).resurface, [107], 'the next page or run does not screen it again');
  assert.equal(claim(101, Y).why, 'failed-today', 'and the claim refuses it too');
  assert.deepEqual(H.rows(101), [{ title: X, origin: 'cv:under_qualified' }], 'nothing recorded against the candidate');
  const tomorrow = Date.now() + 30 * 3600 * 1000;
  assert.equal(rs.failedToday('caterer', 101, Y, { now: tomorrow }), false);
  assert.equal(rs.noteFailed('caterer', 107, Y, { now: tomorrow }), true);
  const st = rs.readState(tomorrow);
  assert.deepEqual(st.today.failed, ['caterer:107:' + Y]);
  assert.ok(st.history.every((d) => d.failed === undefined), 'yesterday\'s failed list is dropped');
});

test('C8 the reserve alert names its own setting', () => {
  world();
  const sent = [];
  assert.equal(rs.alertStopped({ why: 'reserve', notify: (a) => sent.push(a) }), true);
  assert.match(sent[0].text, /CV_RESURFACE_MIN_CREDITS/);
});

test('C9 the claim stores ids, titles, dates and an origin, nothing else; the snippet rejection of a resurfaced candidate and the push bookkeeping do the same', () => {
  world();
  claim(101, Y);
  H.withDb((db) => rs.recordSnippetReject(db, { source: 'caterer', id: 107, jobTitle: Y }));
  H.withDb((db) => rs.markPushed(db, { source: 'caterer', id: 101, jobTitle: Y }));
  const cols = H.withDb((db) => db.prepare('PRAGMA table_info(candidate_rejections)').all().map((c) => c.name));
  assert.deepEqual(cols, ['id', 'caterer_id', 'reed_id', 'job_title', 'rejected_at', 'origin'], 'no schema change');
  assert.deepEqual(H.rows(101).pop(), { title: Y, origin: 'resurface:pushed' });
  assert.deepEqual(H.rows(107).pop(), { title: Y, origin: 'resurface:snippet' });
  const row = H.withDb((db) => db.prepare('SELECT * FROM candidate_rejections WHERE caterer_id = 101 AND job_title = ?').get(Y));
  assert.match(row.rejected_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.reed_id, null);
});

test('C10 Reed: the same claim on reed_id, and a Reed claim never touches a Caterer row', () => {
  H.build({ cands: [{ reed_id: 501 }, { caterer_id: 501, unlocked: 1 }], rows: [[501, X, 'cv:under_qualified', 'reed']] });
  H.settings();
  const r = H.withDb((db) => rs.claim(db, { source: 'reed', id: 501, jobTitle: Y }));
  assert.deepEqual(r, { claimed: true, kind: 'resurface', slot: true });
  assert.deepEqual(H.rows(501, 'reed').map((x) => x.origin), ['cv:under_qualified', 'resurface:started']);
  assert.deepEqual(H.rows(501, 'caterer'), []);
  assert.equal(H.withDb((db) => rs.claim(db, { source: 'reed', id: 501, jobTitle: Y })).claimed, false);
  assert.equal(rs.readState().today.reed, 1);
});

test('R1 the switch is checked by the claim too: off, or CV_SCREEN not on, claims nothing', () => {
  world();
  H.settings({ CV_RESURFACE: 'off' });
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'disabled' });
  H.settings({ CV_SCREEN: 'shadow' });
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'disabled' });
  assert.deepEqual(H.rows(101), [{ title: X, origin: 'cv:under_qualified' }]);
});
