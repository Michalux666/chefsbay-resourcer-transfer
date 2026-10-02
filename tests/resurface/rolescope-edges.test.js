'use strict';
// Edges of the role scope that the first suites left open (docs/ROLESCOPE.md): the failed list of the day stops a claim, a CV rejection is never the legacy
// rule's, an empty Zoho id is not a push, and a rejection of ANOTHER real title does not bind this one (the owner of 2026-10-01: a rejection from the keyword
// search binds only the role that was searched). A real SQLite file in the legacy schema.
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
const ids = (a) => a.slice().sort((x, y) => x - y);
const cat = (list, title) => cdb.classifyBatchScoped(list, title || Y);
const claim = (id, title, extra) => H.withDb((db) => rs.claim(db, Object.assign({ source: 'caterer', id, jobTitle: title }, extra || {})));

test('RE1 the failed list of the day stops a claim for that title only, and the next London day is free again', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null }] });
  assert.equal(rs.noteFailed('caterer', 101, Y), true);
  assert.deepEqual(claim(101, Y), { claimed: false, why: 'failed-today' });
  assert.deepEqual(H.rows(101), []);
  assert.equal(claim(101, Z).claimed, true, 'another title is a different role');
  const tomorrow = Date.now() + 36 * 3600000;
  assert.equal(claim(101, Y, { now: tomorrow }).claimed, true);
});

test('RE2 a CV rejection belongs to the CV rule and never to the legacy rule: with CV_RESURFACE off a person with a CV row keeps the old skip, whatever other rows they carry', () => {
  H.build({
    cands: [101, 102, 103].map((id) => ({ caterer_id: id, unlocked: 1, created: null })),
    rows: [[101, X, 'cv:under_qualified'], [102, X, 'cv:under_qualified'], [102, Z, 'resurface:pushed'], [103, X, 'pipeline']],
  });
  H.settings({ ROLE_SCOPE_LEGACY: undefined, CV_SCREEN: 'on', CV_RESURFACE: 'off' });
  cdb.closeDb();
  const r = cat([101, 102, 103]);
  assert.deepEqual(ids(r.legacy), [103], 'only the plain rejection of another title is for the role scope');
  assert.deepEqual(ids(r.skip), [101, 102]);
});

test('RE3 an empty Zoho id is not a push, a real one is; a push recorded by the timestamp is a push', () => {
  H.build({ cands: [{ caterer_id: 101, unlocked: 1, created: null, zoho_id: '' }, { caterer_id: 102, unlocked: 1, created: null, zoho_id: 'ZOHO-102' }, { caterer_id: 103, unlocked: 1, created: null, pushed_at: '2026-09-02 10:00:00' }] });
  const r = cat([101, 102, 103]);
  assert.deepEqual(ids(r.legacy), [101]);
  assert.deepEqual(ids(r.skip), [102, 103]);
});

test('RE4 a rejection of ANOTHER real title does not bind this one: an old unlocked, never-pushed person is screened once for a new title, never for the title of the rejection, never twice for the new one; the young keep the old skip', () => {
  H.build({
    cands: [{ caterer_id: 101, unlocked: 1, created: null }, { caterer_id: 102, unlocked: 1 }, { caterer_id: 103, unlocked: 1, created: null }],
    rows: [[101, X, 'pipeline'], [102, X, 'pipeline'], [103, X, 'log-backfill'], [103, '*', 'log-backfill']],
  });
  assert.deepEqual(ids(cat([101, 102, 103]).legacy), [101, 103]);
  assert.deepEqual(ids(cat([101, 102, 103], X).legacy), [], 'the title of the rejection: judged, skipped');
  assert.deepEqual(claim(101, Y), { claimed: true, kind: 'legacy', slot: true });
  assert.deepEqual(ids(cat([101, 102, 103]).legacy), [103], 'the look records its role: 101 is never looked at for Y again');
  assert.deepEqual(ids(cat([101, 102, 103], Z).legacy), [101, 103], 'a third title is a new role');
});

test('RE5 a failed write of a Reed ledger row is reported to the caller (never silent) and never throws; a row that already exists is not an error', () => {
  H.build({ cands: [{ reed_id: 9001, unlocked: 0 }] });
  const broken = { prepare() { throw new Error('database is locked'); } };
  const seen = [];
  assert.equal(rs.recordSnippetReject(broken, { source: 'reed', id: 9001, jobTitle: Y, origin: rs.ORIGIN_REED_SNIPPET, onError: (e) => seen.push(String(e.message)) }), false);
  assert.deepEqual(seen, ['database is locked']);
  assert.equal(rs.recordSnippetReject(broken, { source: 'reed', id: 9001, jobTitle: Y, origin: rs.ORIGIN_REED_SNIPPET, onError: () => { throw new Error('a throwing reporter'); } }), false, 'a reporter that throws changes nothing');
  const again = [];
  H.withDb((db) => {
    assert.equal(rs.recordSnippetReject(db, { source: 'reed', id: 9001, jobTitle: Y, origin: rs.ORIGIN_REED_SNIPPET, onError: (e) => again.push(e) }), true);
    assert.equal(rs.recordSnippetReject(db, { source: 'reed', id: 9001, jobTitle: Y, origin: rs.ORIGIN_REED_SNIPPET, onError: (e) => again.push(e) }), false, 'already there: nothing written');
  });
  assert.deepEqual(again, [], 'a row that exists is not an error');
});
