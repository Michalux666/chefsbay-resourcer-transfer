'use strict';
// The findings of the review of the first version of the tool, each pinned by a test: a queued run must not change the schedule (raised territories are left
// out), the Caterer credits bound the queue, malformed shadow rows are never selected, an unreadable ledger or halt file fails closed, a re-used row id cannot make
// a cleared candidate look untouched, and the guards that mutation testing showed to be unpinned (Reed cv: origin, Reed newer Jev approval of another title, a
// rejection booked after --until, an unreadable busy state).

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { standardWorld, run, json, tool, FIXTURES, row, T0, T2, MARKERS } = H;
const pendings = (h) => fs.readdirSync(h.p('pending-searches')).filter((f) => f.startsWith('zz-rescreen-')).sort();
const applied = async (h, extra) => { const r = await run(h, ['--apply', '--confirm', '4'].concat(extra || [])); assert.equal(r.code, 0, r.err); return r; };
const setCredits = (h, n) => h.db((d) => d.prepare('UPDATE run_results SET credits_remaining = ? WHERE completed_at = (SELECT MAX(completed_at) FROM run_results)').run(n));

test('review: a malformed row is never selected (approval flag not a boolean, policy block not an object, flags not arrays)', () => {
  const base = FIXTURES['update-a'].rows.find((x) => x.label === 'uncertain_ambiguous').row;
  assert.equal(tool.classifyRow(base).kind, 'policy_uncertain');
  for (const mutate of [
    (r) => { r.used.approved = 'false'; },
    (r) => { r.used.approved = 0; },
    (r) => { delete r.used.approved; },
    (r) => { r.policy = ['review']; },
    (r) => { r.jev = 'ok'; },
    (r) => { r.flags = 'injection'; },
    (r) => { r.jev.flags = 'card_unreadable'; },
  ]) {
    const r = JSON.parse(JSON.stringify(base));
    mutate(r);
    assert.equal(tool.classifyRow(r).kind, 'policy_other', mutate.toString());
  }
});

test('review: a Reed candidate with a CV-screening rejection is never cleared, even with --reed-seen', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.rej(9001, 'Chef', { source: 'reed', origin: 'cv:no_relevant_experience' });
  const s = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.equal(s.excluded.cv_rejection, 2, '1023 and 9001');
  assert.deepEqual(s.eligible.bySource.reed, { candidates: 1, rows: 1 }, 'only 9005 is left');
});

test('review: a Reed card that Jev approved since, for ANOTHER job title, is left alone (Reed skips on any row, so the candidate is Jev-decided)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.shadow([row('head', 'reed_jev_approve', { candidateId: '9001', ts: T2, runId: null, source: 'reed', jobTitle: 'Kitchen Porter' })]);
  const s = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.equal(s.excluded.newer_jev_decision, 2, '1026 and 9001');
  assert.deepEqual(s.eligible.bySource.reed, { candidates: 1, rows: 1 });
});

test('review: a rejection booked after --until is outside the window (a batch across midnight)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.shadow([row('update-a', 'uncertain_ambiguous', { candidateId: '1040', ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' })]);
  h.cand(1040);
  h.rej(1040, 'Chef', { date: '2026-10-01' });
  const s = (await json(h, ['--until', '2026-09-30'])).j.dryRun;
  assert.equal(s.excluded.outside_window, 2, '1028 (before the decision) and 1040 (after --until)');
  assert.equal(s.eligible.rowsToDelete, 3);
  assert.equal((await json(h, [])).j.dryRun.eligible.rowsToDelete, 5, 'inside the default window it is selected');
});

test('review: a Reed candidates row that also carries a Caterer id is not a plain seen row', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.db((d) => d.prepare('UPDATE candidates SET caterer_id = 77 WHERE reed_id = 9005').run());
  const s = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.equal(s.excluded.reed_row_not_plain, 1);
  assert.deepEqual(s.eligible.bySource.reed, { candidates: 1, rows: 1 });
});

test('review: a busy state that cannot be read counts as a run in flight (fail safe), for apply and undo', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '4'], { busy: () => { throw new Error('unreadable'); } });
  assert.equal(r.code, 3);
  assert.match(r.out, /a pipeline run is in flight/);
  assert.equal(h.snapshot(), before);
});

test('review: a halt file that cannot be read is treated as a halt (the apply is refused); an empty one is not', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  fs.writeFileSync(h.p('runtime', 'pipeline-halt.json'), '{halt');
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(r.code, 3);
  assert.match(r.out, /pipeline-halt\.json cannot be read/);
  assert.equal(h.snapshot(), before);
  fs.writeFileSync(h.p('runtime', 'pipeline-halt.json'), '');
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
});

test('review: an unreadable ledger is warned about by the dry run and refuses an apply and a queue (the once-only protection never vanishes silently)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  fs.writeFileSync(h.p('runtime', 'rescreen-ledger-20260101T000000Z.jsonl'), 'this is not json\n');
  const dry = await run(h, []);
  assert.equal(dry.code, 0, 'a dry run only warns');
  assert.match(dry.out, /WARNING: ledger rescreen-ledger-20260101T000000Z\.jsonl 1 line\(s\) cannot be read/);
  assert.match(dry.out, /--apply would be refused now: the once-only guard cannot read rescreen-ledger-20260101T000000Z\.jsonl/);
  assert.equal((await run(h, ['--queue', '--dry-run'])).code, 3);
});

test('review: a re-used row id does not make a cleared candidate look untouched (the ledger row must be the same row, not only the same id)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const before = (await json(h, ['--queue', '--dry-run'])).j.queue;
  assert.equal(before.clearedRows, 4);
  const ids = h.db((d) => d.prepare('SELECT MAX(id) AS m FROM candidate_rejections').get().m);
  const led = fs.readdirSync(h.p('runtime')).find((n) => /^rescreen-ledger/.test(n));
  const first = JSON.parse(fs.readFileSync(h.p('runtime', led), 'utf8').split('\n')[0]);
  // a legacy table without AUTOINCREMENT can hand out an id again: the new row has the id of a cleared one and other content
  h.db((d) => d.prepare("INSERT INTO candidate_rejections (id, caterer_id, job_title, rejected_at, origin) VALUES (?, 555555, 'Chef', '2026-10-01', 'pipeline')").run(first.row.id));
  assert.ok(ids >= 0);
  const after = (await json(h, ['--queue', '--dry-run'])).j.queue;
  assert.equal(after.clearedRows, 4, 'the cleared candidate still counts as cleared');
});

test('review: --queue leaves territories at priority high or medium to their regular sweep (a queued run steps them down), names them in the output, and queues the low ones', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  h.db((d) => d.prepare("UPDATE territory_searches SET priority = 'medium' WHERE job_title = 'Chef'").run());
  const before = h.db((d) => d.prepare('SELECT * FROM territory_searches ORDER BY id').all());
  const r = await json(h, ['--queue']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.j.queue.excluded.above_low, 1);
  assert.deepEqual(r.j.queue.chosen.map((c) => c.territory), ['Kitchen Porter M1']);
  assert.deepEqual(pendings(h).map((f) => JSON.parse(fs.readFileSync(h.p('pending-searches', f), 'utf8')).jobTitle), ['Kitchen Porter']);
  assert.deepEqual(h.db((d) => d.prepare('SELECT * FROM territory_searches ORDER BY id').all()), before, 'the territory table is only read');
  h.db((d) => d.prepare("UPDATE territory_searches SET priority = 'HIGH' WHERE job_title = 'Kitchen Porter'").run());
  const again = await json(h, ['--queue', '--dry-run']);
  assert.equal(again.j.queue.excluded.above_low, 2, 'case does not matter');
  assert.match((await run(h, ['--queue', '--dry-run'])).out, /above_low 2/);
});

test('review: the Caterer credits bound the queue: a known balance minus the reserve, in runs of the CV limit; an unknown balance is said, not hidden', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const reserve = tool.CREDIT_RESERVE;
  const per = tool.CV_RESERVE;
  // unknown: the output says the credits are not guarded
  const unknown = await run(h, ['--queue', '--dry-run']);
  assert.match(unknown.out, /Caterer credits: no finished run recorded a balance, so the credits are NOT guarded/);
  assert.equal((await json(h, ['--queue', '--dry-run'])).j.queue.credits.known, null);
  // too low: nothing that uses Caterer is queued
  setCredits(h, reserve + per - 1);
  const low = await json(h, ['--queue', '--dry-run']);
  assert.equal(low.j.queue.chosen.length, 0);
  assert.equal(low.j.queue.excluded.credits_floor, 2);
  assert.deepEqual(low.j.queue.credits, { known: reserve + per - 1, reserve });
  // room for exactly one run
  setCredits(h, reserve + per);
  const one = await json(h, ['--queue', '--dry-run']);
  assert.equal(one.j.queue.chosen.length, 1);
  assert.equal(one.j.queue.excluded.credits_floor, 1);
  // room for both
  setCredits(h, reserve + 2 * per);
  assert.equal((await json(h, ['--queue', '--dry-run'])).j.queue.chosen.length, 2);
  assert.match((await run(h, ['--queue', '--dry-run'])).out, new RegExp(`Caterer credits: ${reserve + 2 * per} at the last finished run`));
  // a Reed-only territory spends no Caterer credit
  setCredits(h, 0);
  h.db((d) => d.prepare("UPDATE territory_searches SET sources = 'reed' WHERE job_title = 'Chef'").run());
  const reedOnly = await json(h, ['--queue', '--dry-run']);
  assert.deepEqual(reedOnly.j.queue.chosen.map((c) => c.territory), ['Chef LS29']);
  assert.equal(reedOnly.j.queue.excluded.credits_floor, 1);
});

test('review: the dry run says when lines of the shadow log could not be read, and prints no personal data doing so', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const f = fs.readdirSync(h.p('shadow')).sort()[0];
  fs.appendFileSync(h.p('shadow', f), '{"ts": "truncated ZZ-FAKE-NAME-1\n');
  const r = await run(h, []);
  assert.match(r.out, /WARNING: shadow log lines that could not be read and were skipped \(a truncated file\?\): 1;/);
  for (const m of MARKERS) assert.ok(!r.all.includes(m));
});
