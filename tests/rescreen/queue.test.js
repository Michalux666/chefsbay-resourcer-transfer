'use strict';
// R5 / R6: --queue writes unique pending-search files for the territories whose candidates a ledger shows as cleared: oldest first, priority low, sources as the
// territory asks, never a territory that is queued, running, held by CV screening, disabled or already run since the apply, never more than --per-day a UTC day
// (a ledger, idempotent), Reed's view budget respected, and a one-off run never pushes the territory's regular next date.

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const gate = require('../../resourcer/scripts/pending-gate');
const territory = require('../../resourcer/scripts/territory-utils');

const { standardWorld, run, json, MARKERS } = H;
const pendings = (h) => fs.readdirSync(h.p('pending-searches')).filter((f) => f.startsWith('zz-rescreen-')).sort();
const payload = (h, f) => JSON.parse(fs.readFileSync(h.p('pending-searches', f), 'utf8'));
const applied = async (h, extra) => { const r = await run(h, ['--apply', '--confirm', '4'].concat(extra || [])); assert.equal(r.code, 0, r.err); return r; };

test('R5: --queue writes one unique file per territory (names with a random suffix, sources as the territory asks, priority low, no claim stamp), oldest decision first', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const r = await json(h, ['--queue']);
  assert.equal(r.code, 0, r.err);
  const files = pendings(h);
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => /^zz-rescreen-\d+-[0-9a-f]{8}\.json$/.test(f)), files.join(','));
  const byTitle = Object.fromEntries(files.map((f) => [payload(h, f).jobTitle, payload(h, f)]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Chef', 'Kitchen Porter']);
  assert.equal(byTitle.Chef.sources, 'both', 'as the territory asks');
  assert.equal(byTitle['Kitchen Porter'].sources, 'caterer');
  for (const p of Object.values(byTitle)) {
    assert.equal(p.priority, 'low');
    assert.equal(p.source, 'rescreen-policy-rejects');
    assert.equal(p.spawnedAt, undefined);
    assert.equal(gate.validatePending(p), null, 'the watcher accepts the file');
    assert.equal(p.distance, 20);
    assert.ok(Number.isInteger(p.rescreenCleared));
  }
  assert.equal(byTitle.Chef.location, 'LS29');
  assert.equal(byTitle.Chef.rescreenCleared, 3);
  assert.deepEqual(r.j.queue.chosen.map((c) => c.territory), ['Chef LS29', 'Kitchen Porter M1'], 'the territory with the oldest decision first');
  assert.equal(r.j.queue.written.length, 2);
  // no personal data anywhere
  for (const f of files) for (const m of MARKERS) assert.ok(!fs.readFileSync(h.p('pending-searches', f), 'utf8').includes(m));
  for (const m of MARKERS) assert.ok(!r.all.includes(m));
});

test('R5: the per-day limit (a ledger of the UTC day) is a total, idempotent, and moves with --per-day; a territory already queued is never queued twice', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const one = await json(h, ['--queue', '--per-day', '1']);
  assert.equal(one.j.queue.chosen.length, 1);
  assert.equal(one.j.queue.chosen[0].territory, 'Chef LS29');
  assert.equal(pendings(h).length, 1);
  const led = JSON.parse(fs.readFileSync(h.p('runtime', 'rescreen-queue.json'), 'utf8'));
  assert.deepEqual(Object.keys(led.days), ['2026-10-01']);
  assert.equal(led.days['2026-10-01'].length, 1);
  // the same call again: the limit is used up and the territory is queued already
  const again = await json(h, ['--queue', '--per-day', '1']);
  assert.equal(again.j.queue.chosen.length, 0);
  assert.equal(again.j.queue.excluded.queued_or_running, 1);
  assert.equal(again.j.queue.excluded.per_day_limit, 1);
  assert.equal(pendings(h).length, 1);
  // a higher limit queues the next one, and only the next one
  const two = await json(h, ['--queue', '--per-day', '2']);
  assert.deepEqual(two.j.queue.chosen.map((c) => c.territory), ['Kitchen Porter M1']);
  assert.equal(pendings(h).length, 2);
  const none = await json(h, ['--queue', '--per-day', '10']);
  assert.equal(none.j.queue.chosen.length, 0);
  assert.equal(pendings(h).length, 2);
  // a later UTC day starts a fresh allowance, but the files of the first day are still queued: nothing is queued twice
  const next = await json(h, ['--queue', '--per-day', '1'], { now: new Date('2026-10-02T09:00:00Z') });
  assert.equal(next.j.queue.chosen.length, 0);
  assert.equal(pendings(h).length, 2);
});

test('R5: --queue works on an already applied ledger on a later day, over several days, and --dry-run writes nothing', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const before = h.snapshot();
  const dry = await json(h, ['--queue', '--dry-run']);
  assert.equal(dry.j.mode, 'queue-dry-run');
  assert.equal(dry.j.queue.chosen.length, 2);
  assert.equal(dry.j.queue.written, null);
  assert.equal(h.snapshot(), before);
  assert.match((await run(h, ['--queue', '--dry-run'])).out, /would queue 2: Chef LS29 \(3\), Kitchen Porter M1 \(1\)/);
  // day 1: one territory; its pending file is consumed by the run (as phase 2 does); day 2: the other
  const d1 = await json(h, ['--queue', '--per-day', '1'], { now: new Date('2026-10-01T12:00:00Z') });
  assert.equal(d1.j.queue.chosen[0].territory, 'Chef LS29');
  for (const f of pendings(h)) fs.unlinkSync(h.p('pending-searches', f));
  h.db((d) => d.prepare("INSERT INTO run_results (run_key, date, completed_at, job_title, location, distance, keywords, sources) VALUES ('rr-1','2026-10-01','2026-10-01T13:00:00.000Z','Chef','LS29',20,'','both')").run());
  const d2 = await json(h, ['--queue', '--per-day', '1'], { now: new Date('2026-10-02T09:00:00Z') });
  assert.deepEqual(d2.j.queue.chosen.map((c) => c.territory), ['Kitchen Porter M1']);
  assert.equal(d2.j.queue.excluded.ran_since_apply, 1, 'Chef LS29 already ran after the apply: its cleared candidates were screened by that run');
  assert.deepEqual(JSON.parse(fs.readFileSync(h.p('runtime', 'rescreen-queue.json'), 'utf8')).days['2026-10-01'].length, 1);
});

test('R5: a ledger whose rows are still in the table (not applied, rolled back, or undone) queues nothing; with no ledger there is nothing to queue', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const none = await json(h, ['--queue']);
  assert.equal(none.code, 0);
  assert.equal(none.j.queue.ledgers, 0);
  assert.equal(none.j.queue.chosen.length, 0);
  const failed = await run(h, ['--apply', '--confirm', '4'], { hooks: { afterDelete: (n) => { if (n === 1) throw new Error('injected'); } } });
  assert.equal(failed.code, 4);
  const rolledBack = await json(h, ['--queue']);
  assert.equal(rolledBack.j.queue.clearedRows, 0, 'the ledger of a rolled-back apply cleared nothing');
  assert.equal(rolledBack.j.queue.chosen.length, 0);
  assert.equal(pendings(h).length, 0);
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  const ledger = fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-ledger/.test(n)).sort();
  assert.equal(ledger.length, 2);
  assert.equal((await json(h, ['--queue', '--dry-run'])).j.queue.chosen.length, 2);
  // after an undo the rows are back, so the ledger no longer counts
  assert.equal((await run(h, ['--undo', ledger[1]])).code, 0);
  assert.equal((await json(h, ['--queue', '--dry-run'])).j.queue.chosen.length, 0);
  // --ledger narrows the queue to one ledger
  assert.equal((await run(h, ['--queue', '--ledger', h.p('runtime', ledger[0]), '--dry-run'])).code, 0);
  assert.equal((await run(h, ['--queue', '--ledger', h.p('runtime', 'other.jsonl')])).code, 3);
});

test('R5: never a territory that is already queued, running, quarantined, held by CV screening, disabled, gone from the map, or that ran since the apply', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  // Chef LS29 is already queued; Kitchen Porter M1 is in flight
  fs.writeFileSync(h.p('pending-searches', 'search-1.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS29', sources: 'both' }));
  fs.writeFileSync(h.p('runs', 'phase1-2026-10-01-1150.json'), JSON.stringify({ id: 'phase1-2026-10-01-1150', status: 'phase1_running', jobTitle: 'Kitchen Porter', location: 'M1', distance: 20, sources: 'caterer', updatedAt: '2026-10-01T11:59:00.000Z' }));
  const a = await json(h, ['--queue']);
  assert.equal(a.j.queue.chosen.length, 0);
  assert.equal(a.j.queue.excluded.queued_or_running, 2);
  fs.unlinkSync(h.p('pending-searches', 'search-1.json'));
  fs.unlinkSync(h.p('runs', 'phase1-2026-10-01-1150.json'));
  // quarantined
  fs.mkdirSync(h.p('pending-searches', '.quarantine'));
  fs.writeFileSync(h.p('pending-searches', '.quarantine', 'search-2.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS29', sources: 'both' }));
  // held by CV screening: a status file with phase2Hold that nobody completed
  fs.writeFileSync(h.p('runs', 'phase1-2026-10-01-1000.json'), JSON.stringify({ id: 'x', status: 'phase1_complete', phase2Hold: true, jobTitle: 'Kitchen Porter', location: 'M1', startedAt: '2026-10-01T10:00:00.000Z' }));
  const b = await json(h, ['--queue']);
  assert.equal(b.j.queue.chosen.length, 0);
  assert.equal(b.j.queue.excluded.queued_or_running, 1);
  assert.equal(b.j.queue.excluded.held_by_cv_screening, 1);
  fs.rmSync(h.p('pending-searches', '.quarantine'), { recursive: true });
  fs.unlinkSync(h.p('runs', 'phase1-2026-10-01-1000.json'));
  // disabled, and gone from the territory map
  h.db((d) => { d.prepare("UPDATE territory_searches SET enabled = 0 WHERE job_title = 'Chef'").run(); d.prepare("DELETE FROM territory_searches WHERE job_title = 'Kitchen Porter'").run(); });
  const c = await json(h, ['--queue']);
  assert.equal(c.j.queue.chosen.length, 0);
  assert.equal(c.j.queue.excluded.disabled, 1);
  assert.equal(c.j.queue.excluded.no_territory, 1);
  assert.equal(pendings(h).length, 0);
});

test('R5: Reed off or held: a territory that asks for Reed is not queued (it would be recorded Caterer-only and listed as a lost Reed half), a Caterer-only one is', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const r = await json(h, ['--queue'], { env: { RESOURCER_HOME: h.home, RESOURCER_SOURCES: 'caterer' } });
  assert.deepEqual(r.j.queue.chosen.map((c) => c.territory), ['Kitchen Porter M1']);
  assert.equal(r.j.queue.excluded.reed_unavailable, 1);
  assert.match(r.j.queue.reedOff, /Reed is switched off/);
  assert.deepEqual(pendings(h).map((f) => payload(h, f).sources), ['caterer']);
  assert.ok(!pendings(h).some((f) => payload(h, f).jobTitle === 'Chef'));
});

test('R5: the Reed daily profile-view budget is respected the way tools/reed-catchup.js respects it: each queued run that asks for Reed reserves 20 views of what is left', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  h.db((d) => d.prepare("INSERT INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit) VALUES ('2026-10-01', 285, 0, 300)").run());
  const r = await json(h, ['--queue', '--dry-run']);
  assert.deepEqual(r.j.queue.chosen.map((c) => c.territory), ['Kitchen Porter M1'], '15 views left: not enough for a Reed run');
  assert.equal(r.j.queue.excluded.reed_budget, 1);
  assert.deepEqual(r.j.queue.reedBudget, { used: 285, limit: 300 });
  h.db((d) => d.prepare("UPDATE reed_daily_usage SET profile_views = 270 WHERE date = '2026-10-01'").run());
  assert.equal((await json(h, ['--queue', '--dry-run'])).j.queue.chosen.length, 2, '30 views left: one Reed run fits');
});

test('R5: two copies started together queue each territory once (the pending-searches lock)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  const [a, b] = await Promise.all([run(h, ['--queue']), run(h, ['--queue'])]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.equal(pendings(h).length, 2);
});

test('R5: a one-off run does not push the territory regular next date a whole interval (the not-yet-due rule of upsertTerritory, which tools/reed-catchup.js relies on)', async (t) => {
  const h = H.makeHome();
  t.after(() => h.cleanup());
  h.territory('Chef', 'LS29', { sources: 'both', next: '2026-10-15', priority: 'medium' });
  const stamp = (newToZoho) => h.db((d) => territory.upsertTerritory(d, {
    jobTitle: 'Chef', location: 'LS29', keywords: '', searchDistance: 20, initialPriority: 'low', candidateCount: 30, newToZoho, duplicates: 0, skipped: 5, errors: 0, creditsRemaining: 100, lastSearched: '2026-10-01',
  }));
  // not yet due, the run is ahead of its slot: next_run_date stays, last_searched moves
  const r = stamp(12);
  assert.equal(r.nextRunDate, '2026-10-15');
  assert.deepEqual(h.db((d) => d.prepare('SELECT next_run_date, last_searched, priority FROM territory_searches').get()), { next_run_date: '2026-10-15', last_searched: '2026-10-01', priority: 'medium' });
  // a territory that IS due: this run is its regular run and the date advances in whole intervals from the due date, as always
  h.db((d) => d.prepare("UPDATE territory_searches SET next_run_date = '2026-10-01'").run());
  const due = stamp(12);
  assert.ok(due.nextRunDate > '2026-10-01' && due.nextRunDate <= '2026-10-12', due.nextRunDate);
});

test('R5 (documented limit K-RESCREEN3): a re-screen run that finds fewer than 5 new candidates steps the territory priority down one tier, like any other run, and re-bases its cadence', async (t) => {
  const h = H.makeHome();
  t.after(() => h.cleanup());
  h.territory('Chef', 'LS29', { sources: 'both', next: '2026-10-15', priority: 'medium' });
  const r = h.db((d) => territory.upsertTerritory(d, {
    jobTitle: 'Chef', location: 'LS29', keywords: '', searchDistance: 20, initialPriority: 'low', candidateCount: 30, newToZoho: 2, duplicates: 0, skipped: 5, errors: 0, creditsRemaining: 100, lastSearched: '2026-10-01',
  }));
  assert.equal(r.autoDowngraded, true);
  assert.equal(r.effectivePriority, 'low');
  assert.notEqual(r.nextRunDate, '2026-10-15', 'the downgrade re-bases the cadence: the docs tell the operator, nothing here changes it');
});

test('R5: the Reed half is never marked done by a re-screen: the payload asks for what the territory asks for, and the pending file is an ordinary search (docs/parity/reed-first-page.md R4)', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await applied(h);
  // a Reed-pending mark on the territory is only closed by a run whose Reed half worked; the tool never touches the territory table
  h.db((d) => { d.exec('ALTER TABLE territory_searches ADD COLUMN reed_pending_since TEXT'); d.prepare("UPDATE territory_searches SET reed_pending_since = '2026-09-30' WHERE job_title = 'Chef'").run(); });
  const before = h.db((d) => d.prepare('SELECT * FROM territory_searches ORDER BY id').all());
  assert.equal((await run(h, ['--queue'])).code, 0);
  assert.deepEqual(h.db((d) => d.prepare('SELECT * FROM territory_searches ORDER BY id').all()), before, 'the territory table is only read');
  assert.equal(payload(h, pendings(h).find((f) => payload(h, f).jobTitle === 'Chef')).sources, 'both');
});
