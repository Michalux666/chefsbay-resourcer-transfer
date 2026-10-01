'use strict';
// R1 / R3: the dry run (the default): exact selection from shadow rows of both engines and the stored rejections, every exclusion counted by reason, nothing
// written, and an output of counts, days and territories only.

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { standardWorld, json, run, MARKERS } = H;

test('R3: the selection is the policy-uncertain rejections that are still stored, minus the excluded ones, and each exclusion is counted by its reason', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const r = await json(h, []);
  assert.equal(r.code, 0, r.err);
  const s = r.j.dryRun;
  assert.equal(s.eligible.candidates, 4, 'Caterer 1001, 1002, 1003 and 1032');
  assert.equal(s.eligible.rowsToDelete, 4);
  assert.deepEqual(s.eligible.bySource, { caterer: { candidates: 4, rows: 4 } });
  assert.deepEqual(s.excluded, {
    unlocked: 4, // 1021 (unlocked), 1022 (Zoho id), 9002, 9004
    cv_rejection: 1,
    no_stored_rejection: 2,
    newer_jev_decision: 1,
    newer_other_decision: 1,
    outside_window: 1,
    still_blocked: 1,
    other_origin: 1,
    bad_id: 1,
    unknown_source: 1,
    reed_not_blocked: 1,
  });
  assert.equal(s.reedHeldBack, 2, 'Reed candidates 9001 and 9005 are only counted without --reed-seen');
  assert.equal(s.policyUncertainRejects, 21, 'distinct (source, candidate, title) policy rejections of an uncertain card before the unlock: 16 Caterer and 5 Reed cards');
});

test('R3: the pre-unlock rows are counted by who decided them (injection, empty, invalid and Jev rows are never selected); the post-unlock rows are only counted', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const s = (await json(h, [])).j.dryRun;
  assert.equal(s.preUnlockByKind.policy_injection_reject, 2);
  assert.equal(s.preUnlockByKind.policy_empty_reject, 1);
  assert.equal(s.preUnlockByKind.policy_uncertain_approve, 2, '1015 and the newer approval of 1027: an uncertain card the policy APPROVED is not a rejection');
  assert.equal(s.preUnlockByKind.system, 1);
  assert.ok(s.preUnlockByKind.jev >= 2);
  assert.equal(s.postUnlockRows, 1, 'the post-unlock row (1017) is counted and never touched');
  // the cards of those kinds keep their rejection after an apply (see apply.test.js); here: none of their ids is selected
  const apply = await json(h, ['--apply', '--confirm', '4', '--dry-run']);
  assert.equal(apply.j.apply.rows, 4);
});

test('R3 per-day and per-territory counts: Caterer rows tie to their territory through the run id (run_results and the status file), the day is the London day of the decision', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const s = (await json(h, [])).j.dryRun;
  assert.deepEqual(s.eligible.byDay, { '2026-09-30': 3, '2026-10-01': 1 }); // 1001, 1002 and 1032 on the 30th, 1003 on the 1st
  assert.deepEqual(s.eligible.byTerritory.map((x) => [x.territory, x.candidates]), [['Chef LS29', 3], ['Kitchen Porter M1', 1]]);
});

test('R3: a run that is only in its status file (run_results has no row yet) still gives the territory', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.db((d) => d.prepare('DELETE FROM run_results').run());
  const s = (await json(h, [])).j.dryRun;
  assert.deepEqual(s.eligible.byTerritory.map((x) => [x.territory, x.candidates]), [['Chef LS29', 3], ['Kitchen Porter M1', 1]]);
  fs.rmSync(h.p('runs'), { recursive: true });
  fs.mkdirSync(h.p('runs'));
  const s2 = (await json(h, [])).j.dryRun;
  assert.deepEqual(s2.eligible.byTerritory.map((x) => x.territory), ['unknown territory'], 'no run, no territory: counted, but it can not be queued');
  assert.equal(s2.eligible.rowsToDelete, 4);
});

test('R3: the window: --since and --until move the shadow rows and the rejection dates they accept', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const late = (await json(h, ['--since', '2026-10-01'])).j.dryRun;
  assert.equal(late.eligible.rowsToDelete, 1, 'only the decision of 2026-10-01 (1003)');
  assert.equal(late.policyUncertainRejects, 1, 'the shadow rows before --since are not even looked at');
  const early = (await json(h, ['--until', '2026-09-30'])).j.dryRun;
  assert.equal(early.eligible.rowsToDelete, 3, '1003 was decided after --until');
  assert.equal(early.policyUncertainRejects, 20, 'the shadow rows after --until are not looked at: 21 minus 1003');
  const wide = (await json(h, ['--since', '2026-09-01'])).j.dryRun;
  assert.equal(wide.eligible.rowsToDelete, 4, 'the rejection of 1028 is dated 2026-09-20, before its decision of the 30th: it is not the rejection that decision made, however early the window starts');
  assert.equal(wide.excluded.outside_window, 1);
});

test('R3: a newer Jev decision of another title does not hide a candidate; one of the same title does', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const s = (await json(h, [])).j.dryRun;
  assert.equal(s.excluded.newer_jev_decision, 1);
  assert.equal(s.eligible.candidates, 4, '1032 (Jev decided Kitchen Porter later) is still selected');
});

test('R3: a Reed candidate is cleared only with --reed-seen, and only when its candidates row is a plain seen row; the eligibility has no candidate_rejections row for Reed', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const s = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.equal(s.eligible.rowsToDelete, 6);
  assert.deepEqual(s.eligible.bySource, { caterer: { candidates: 4, rows: 4 }, reed: { candidates: 2, rows: 2 } });
  assert.equal(s.reedHeldBack, 0);
  assert.equal(h.rejections().filter((x) => x.reed_id).length, 0, 'the pipeline never books a Reed rejection in candidate_rejections');
  // a Reed row that is not a plain Reed row is left alone
  h.db((d) => d.prepare("UPDATE candidates SET source = 'caterer' WHERE reed_id = 9005").run());
  const s2 = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.equal(s2.excluded.reed_row_not_plain, 1);
  assert.equal(s2.eligible.rowsToDelete, 5);
});

test('R1: the dry run writes nothing (no ledger, no backup, no pending file, no table change) and says what to do next', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const r = await run(h, []);
  assert.equal(r.code, 0, r.err);
  assert.equal(h.snapshot(), before);
  assert.match(r.out, /rows that --apply would delete: 4 {3}\(--apply --confirm 4\)/);
  assert.match(r.out, /nothing was written/);
  assert.match(r.out, /by territory \(2 territories\):/);
  assert.match(r.out, /Chef LS29: 3/);
  assert.match(r.out, /--apply is possible now/);
  assert.deepEqual(fs.readdirSync(h.p('runtime')), []);
  assert.deepEqual(fs.existsSync(h.p('backups')), false);
  const apply = await run(h, ['--apply', '--confirm', '4', '--dry-run']);
  assert.equal(apply.code, 0);
  assert.equal(h.snapshot(), before, '--dry-run wins over --apply');
});

test('R1: the dry run tells what --apply would be refused for (a run in flight, a halt, more rows than --max-rows)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const big = await run(h, ['--max-rows', '3']);
  assert.match(big.out, /--apply would be refused now: 4 rows is more than --max-rows 3/);
  const busy = await run(h, [], { busy: () => true });
  assert.match(busy.out, /a pipeline run is in flight/);
  fs.writeFileSync(h.p('runtime', 'pipeline-halt.json'), JSON.stringify({ halted: true, reason: 'screening unavailable', since: '2026-10-01T10:00:00Z' }));
  const halt = await run(h, []);
  assert.match(halt.out, /the screening halt is set/);
});

test('R3: the shadow files hold personal data: a file that is not mode 0600 is reported, never copied', async (t) => {
  if (process.platform === 'win32') { t.skip('no POSIX modes here'); return; }
  const h = standardWorld();
  t.after(() => h.cleanup());
  const good = await json(h, []);
  assert.deepEqual(good.j.dryRun.shadow.looseModeFiles, []);
  const f = fs.readdirSync(h.p('shadow'))[0];
  fs.chmodSync(h.p('shadow', f), 0o644);
  const loose = await run(h, []);
  assert.match(loose.out, /WARNING: 1 shadow file not mode 0600 \(screening-2026-09-30\.jsonl\)/);
  assert.equal(fs.statSync(h.p('shadow', f)).mode & 0o777, 0o644, 'the tool does not change modes');
});

test('R1 hygiene: no name, e-mail, phone number or card text appears in any output of the dry run, text or JSON, nor in a file it could have written', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const text = await run(h, ['--reed-seen']);
  const js = await run(h, ['--reed-seen', '--json']);
  for (const m of MARKERS) {
    assert.ok(!text.all.includes(m), `text output holds ${m}`);
    assert.ok(!js.all.includes(m), `JSON output holds ${m}`);
  }
  assert.ok(!/planted text/.test(text.all + js.all));
  for (const id of ['1001', '1002', '1003', '1032', '9001']) assert.ok(!new RegExp(`\\b${id}\\b`).test(text.all + js.all), `the candidate id ${id} is not printed: counts only`);
});

test('R1: usage errors are exit 2 and write nothing', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  for (const args of [['--since', '2026-13-45'], ['--until', 'x'], ['--since', '2026-10-02', '--until', '2026-10-01'], ['--confirm', '3'], ['--apply', '--confirm', 'x'],
    ['--per-day', '-1'], ['--max-rows', 'many'], ['--undo', 'rescreen-ledger-x.jsonl', '--apply'], ['--ledger', 'x.jsonl'], ['--bogus'], ['--since']]) {
    const r = await run(h, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /ERROR: /);
  }
  const help = await run(h, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: node tools\/rescreen-policy-rejects\.js/);
});

test('R3/R5: a Reed row carries no run id: its territory is the ONE run for that title, asking for Reed, whose time span holds the row; two such runs (or none) leave it without a territory', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const s = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.deepEqual(s.eligible.byTerritory.map((x) => [x.territory, x.candidates]), [['Chef LS29', 5], ['Kitchen Porter M1', 1]], 'the two Reed candidates join the territory of the Chef run of that afternoon');
  // a second run for the same title that asked for Reed and overlaps in time: the Reed rows can not be told apart
  h.territory('Chef', 'M1', { sources: 'both' });
  h.run('2026-09-30-1510', 'Chef', 'M1', { sources: 'both', started: '2026-09-30T14:50:00.000Z', completed: '2026-09-30T16:10:00.000Z' });
  const amb = (await json(h, ['--reed-seen'])).j.dryRun;
  assert.deepEqual(amb.eligible.byTerritory.map((x) => [x.territory, x.candidates]), [['Chef LS29', 3], ['unknown territory', 2], ['Kitchen Porter M1', 1]]);
  assert.equal(amb.eligible.rowsToDelete, 6, 'the candidates are still cleared: only their territory is unknown');
});
