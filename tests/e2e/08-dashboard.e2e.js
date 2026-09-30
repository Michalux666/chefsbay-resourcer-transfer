'use strict';
// SCENARIO 8 - the dashboard plugin (plugin/resourcer/dashboard/plugin_api.py) under FastAPI's TestClient (a venv with
// fastapi and httpx: $E2E_PYTHON) against the simulated workspace. Its numbers must agree with what the rehearsal did, a
// POST /search must produce a pending file the next tick consumes, and POST /halt/clear must work with the supervisor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const PY = process.env.E2E_PYTHON;
const CLIENT = path.join(__dirname, 'lib', 'dashboard_client.py');

function dash(w, calls) {
  assert.ok(PY, 'E2E_PYTHON must name a python with fastapi and httpx (tests/e2e-linux.sh creates a venv)');
  const r = spawnSync(PY, [CLIENT], { input: JSON.stringify({ home: w.home, calls }), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `dashboard client failed: ${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout).results;
}
const get = (w, p) => dash(w, [{ path: p }])[0];

// a second territory with its own fake Caterer results
const EXTRA = [
  { id: 72000001, n: 21, kind: 'approve', page: 1, title: 'Sous Chef', city: 'Manchester', pc: 'M1 1AA', exp: 7, cv: 'pdf' },
  { id: 72000002, n: 22, kind: 'approve', page: 1, title: 'Sous Chef', city: 'Manchester', pc: 'M2 2BB', exp: 9, cv: 'pdf' },
  { id: 72000003, n: 23, kind: 'reject', page: 1, title: 'Bus Driver', city: 'Salford', pc: 'M5 3CC', exp: 4, tokens: '[[REJECT]]' },
];
function addTerritory(w) {
  const extra = D.siteWorld(EXTRA, { location: 'M1' });
  const cur = (JSON.parse(fs.readFileSync(path.join(w.abDir, 'scenario.json'), 'utf8')).site || {}).fetch || [];
  w.setWorld({ searchWorld: { byLocation: { M1: extra.searchWorld.byLocation.M1 } }, fetch: cur.concat(extra.fetch) });
}

const w = new World('s8-dashboard');
test.before(async () => {
  await w.create({});
  w.warmLoggedIn();
  addTerritory(w);
});
test.after(async () => { await w.close(); });

test('8.1 before any run: health is green, the counters are zero, the queue is empty, and the pre-migration copy is not a backup', () => {
  const [health, status, stats, runs, terr, sched] = dash(w, ['/health', '/status', '/stats', '/runs', '/territories', '/schedule'].map((p) => ({ path: p })));
  for (const r of [health, status, stats, runs, terr, sched]) assert.equal(r.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.checks.runResultsTable, true);
  assert.equal(health.json.checks.pendingDirWritable, true);
  assert.equal(status.json.halt.halted, false);
  assert.equal(status.json.queue.depth, 0);
  assert.deepEqual(status.json.activeRuns, []);
  assert.equal(status.json.db.ok, true);
  assert.ok(w.list('backups', /^candidates\.db\.pre-migrate-/).length >= 1, 'the migration left its unencrypted safety copy');
  assert.equal(status.json.backup.count, 0, 'that copy is not a nightly backup');
  assert.equal(status.json.backup.stale, true);
  assert.equal(stats.json.quota.todayRuns, 0);
  assert.equal(runs.json.total, 0);
  assert.equal(terr.json.total, 3);
  assert.equal(stats.json.territories.total, 3);
});

test('8.2 POST /search writes a valid pending file (no spawnedAt), refuses a duplicate and bad input; the next tick consumes it', async () => {
  const body = { jobTitle: 'Sous Chef', location: 'M1', distance: 20 };
  const [ok, dup, badLoc, noTitle, badDist, traversal] = dash(w, [
    { method: 'POST', path: '/search', json: body },
    { method: 'POST', path: '/search', json: { jobTitle: 'sous chef', location: 'm1', distance: 20 } },
    { method: 'POST', path: '/search', json: { jobTitle: 'Chef', location: 'Leeds city centre', distance: 20 } },
    { method: 'POST', path: '/search', json: { jobTitle: '', location: 'M1' } },
    { method: 'POST', path: '/search', json: { jobTitle: 'Chef', location: 'LS29', distance: 7 } },
    { method: 'POST', path: '/search', json: { jobTitle: '../../../etc/passwd', location: 'M1', distance: 20, keywords: '..\\..\\x' } },
  ]);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.file, /^search-[\w-]+\.json$/);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'already_queued');
  for (const r of [badLoc, noTitle, badDist]) { assert.equal(r.status, 400); assert.equal(r.json.error, 'validation'); }
  assert.ok([200, 400].includes(traversal.status));
  assert.deepEqual(w.pendingFiles(), [ok.json.file], 'only the accepted request became a file');

  const file = w.json(`pending-searches/${ok.json.file}`);
  assert.equal(file.jobTitle, 'Sous Chef');
  assert.equal(file.location, 'M1');
  assert.equal(file.distance, 20);
  assert.equal(file.spawnedAt, undefined, 'a pending file must never carry spawnedAt (the gate would skip it for ten minutes)');
  assert.equal(file.source, 'dashboard');
  assert.equal(C.modeOf(w.p('pending-searches', ok.json.file)) & 0o002, 0, 'not world writable');
  const status = get(w, '/status').json;
  assert.equal(status.queue.depth, w.pendingFiles().length);
  assert.equal(status.queue.upNext[0].jobTitle, 'Sous Chef');
  assert.equal(status.queue.upNext[0].claimed, false);

  // the supervisor drains it (Reed is off: the both-request is answered by a Caterer-only run)
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.svc.zoho.created().length, 2);
});

test('8.3 after the run the numbers agree with the fake world: runs, stats, territories, schedule, last push, caterer state', () => {
  const [runs, stats, terr, sched, status] = dash(w, ['/runs', '/stats', '/territories', '/schedule', '/status'].map((p) => ({ path: p })));
  assert.equal(runs.json.total, 1);
  const r = runs.json.runs[0];
  assert.deepEqual([r.jobTitle, r.location, r.distance, r.sources], ['Sous Chef', 'M1', 20, 'caterer']);
  assert.deepEqual([r.pool, r.downloaded, r.newToZoho, r.duplicates, r.errors, r.approvedP1, r.skippedReview], [3, 2, 2, 0, 0, 2, 1]);
  assert.equal(r.screeningModel, 'anthropic/claude-sonnet-5.5');
  assert.equal(r.caterer.newToZoho, 2);
  assert.equal(r.reed, null);

  const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  if (londonDay === new Date().toISOString().slice(0, 10)) {
    assert.equal(stats.json.quota.todayNew, 2);
    assert.equal(stats.json.quota.todayUnlocked, 2);
    assert.equal(stats.json.quota.todayRuns, 1);
    assert.equal(stats.json.targets.todayPulled, 2);
    assert.equal(stats.json.quota.series[stats.json.quota.series.length - 1].new, 2);
  }
  assert.equal(stats.json.credits.remaining, 44463);
  assert.equal(stats.json.credits.source, 'sync');

  const m1 = terr.json.rows.find((x) => x.location === 'M1');
  assert.equal(m1.jobTitle, 'Sous Chef');
  assert.equal(m1.newToZoho, 2);
  assert.ok(m1.lastSearched, 'searched today');
  assert.ok(m1.nextRunDate > new Date().toISOString().slice(0, 10));
  assert.equal(terr.json.total, 3);
  assert.equal(sched.status, 200);

  assert.equal(status.json.lastPush.source, 'run_results');
  assert.ok(status.json.lastPush.ageMinutes <= 5);
  assert.equal(status.json.caterer.state, 'ok');
  assert.equal(status.json.queue.depth, 0);
  assert.equal(status.json.halt.halted, false);
  assert.deepEqual(status.json.activeRuns, []);
  assert.equal(status.json.reed.state, 'unknown', 'nothing has said what Reed is doing yet');
});

test('8.4 the nightly backup shows up as the backup; the pre-flight makes the Reed indicator say "disabled"', async () => {
  const b = await w.cron('resourcer-backup');
  assert.equal(b.code, 0, b.stdout);
  const pre = await w.cron('resourcer-preflight');
  assert.equal(pre.code, 0, pre.stdout);
  const status = get(w, '/status').json;
  assert.equal(status.backup.count, 1);
  assert.equal(status.backup.stale, false);
  assert.equal(status.backup.lastResultOk, true);
  assert.match(status.backup.file, /^candidates-\d{8}-\d{6}\.db\.gz\.enc$/);
  assert.equal(status.reed.state, 'disabled', 'RESOURCER_SOURCES=caterer: the dashboard is told Reed is off');
});

test('8.5 POST /halt/clear clears a halt set by the supervisor tooling, is idempotent, and the supervisor then runs', async () => {
  w.node('pipeline-halt-cli.js', ['set', 'screening gateway unreachable', 'rehearsal']);
  const [h1, st1] = dash(w, [{ path: '/halt' }, { path: '/status' }]);
  assert.equal(h1.json.halted, true);
  assert.equal(st1.json.halt.halted, true);
  const [c1, h2, c2] = dash(w, [{ method: 'POST', path: '/halt/clear', json: {} }, { path: '/halt' }, { method: 'POST', path: '/halt/clear', json: {} }]);
  assert.equal(c1.status, 200);
  assert.equal(c1.json.cleared, true);
  assert.equal(h2.json.halted, false);
  assert.equal(c2.json.cleared, false);
  assert.equal(w.exists('runtime/pipeline-halt.json'), false);
  assert.ok(w.jsonl('logs/errors.jsonl').some((e) => e.context === 'pipeline_resumed' && e.via === 'dashboard'));
  assert.ok(w.alerts().some((a) => a.key === 'pipeline-halt' && a.severity === 'info' && a.meta && a.meta.via === 'dashboard'));
  // work queued afterwards runs: the clear really released the queue
  w.dropPending({ jobTitle: 'Chef', location: 'LS29' });
  w.svc.zoho.state.dupKeys.add('71000010');
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(get(w, '/runs').json.total, 2);
});

test('8.6 nothing the dashboard returns carries a secret, a candidate name, e-mail or phone; nothing was written into the plugin directory', () => {
  const paths = ['/health', '/status', '/stats', '/runs?limit=50', '/territories', '/schedule', '/halt', '/errors'];
  const all = dash(w, paths.map((p) => ({ path: p })));
  const text = JSON.stringify(all);
  for (const [name, v] of Object.entries(C.SECRET_VALUES)) assert.ok(!text.includes(v), `a dashboard response carries ${name}`);
  for (const c of D.CANDIDATES.concat(EXTRA)) {
    const m = C.markers(c.n);
    for (const kind of ['name', 'surname', 'email', 'phone']) assert.ok(!text.includes(m[kind]), `a dashboard response carries the ${kind} of #${c.n}`);
  }
  const plugin = path.resolve(__dirname, '..', '..', 'plugin', 'resourcer');
  const stray = U.walk(plugin).filter((f) => /__pycache__|\.pyc$/.test(f));
  assert.deepEqual(stray, [], 'the plugin directory is copied to the instance: no bytecode may appear in it');
  const jail = dash(w, [{ path: '/runs?limit=999999&offset=-5' }])[0];
  assert.ok([200, 400].includes(jail.status));
});
