'use strict';
// SCENARIO 15 - the Reed first-page failure (HTTP 400, RequiredHeaderMissingException, code 50010; docs/parity/reed-first-page.md) through the WHOLE
// pipeline, Reed on, against the fake Reed site and API (a fault file read by every fresh Reed browser):
//  (a) the first search page never works: the Reed attempt is recorded as a FAILURE (reed_status failed, errors 1, dashboard "Reed failed", one
//      warn alert), the Caterer half completes exactly as before (5 candidates in Zoho), the territory is marked searched but Reed-pending with
//      one automatic retry, and tools/reed-catchup.js lists it;
//  (b) the fault is gone: the next run for that territory searches Reed (20 candidates in Zoho), the mark is cleared and the alert episode closed;
//  (c) transient 400s and reloads of the page between the steps are absorbed by the request path (retries, token in the same evaluation, idle tab):
//      the run is a normal success with Reed candidates and no alert;
//  (d) a place Reed cannot look up is an empty search, and a pool whose search pages cannot be fetched is a failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { World, REPO } = require('./lib/world');
const U = require('./lib/util');

const PY = process.env.E2E_PYTHON;
const CLIENT = path.join(__dirname, 'lib', 'dashboard_client.py');
const HEADER_MISSING = { errorCode: 50010, exception: 'RequiredHeaderMissingException', message: 'Required header is missing or unavailable' };
const done = (w) => async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0;
const reedBrowserProcs = (w) => U.procs(/remote-debugging-port=/).filter((p) => p.cmd.includes(w.home));
const firstPageAlerts = (w) => w.alerts().filter((a) => a.key === 'reed-first-page-failed');
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

function setFault(w, fault) {
  const f = path.join(w.privateDir, 'reed-fault.json');
  fs.writeFileSync(f, JSON.stringify(fault || {}));
  w.knobs.FAKE_REED_FAULT_FILE = f;
}

async function scene(name) {
  const w = new World(name);
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  await w.enableReed();
  // the retry waits are shortened for the rehearsal; every other Reed timing is the production default
  Object.assign(w.knobs, { REED_RETRY_BACKOFF_MS: '200', REED_TAB_SETTLE_MS: '300' });
  return w;
}

const territory = (w) => w.dbAll('select * from territory_searches')[0];
const runRows = (w) => w.dbAll('select sources, new_to_zoho, errors, caterer_json, reed_json from run_results order by completed_at');
const logText = (w) => w.list('logs', /^phase1-console-.*\.log$/).map((f) => w.text(`logs/${f}`)).join('\n');

test('15a the first page never works: a FAILED Reed attempt, Caterer done as before, territory Reed-pending, dashboard and alert say so, catch-up lists it', async (t) => {
  const w = await scene('s15a-first-page-fails');
  t.after(() => w.close());
  setFault(w, { api: { alwaysHeaderMissing: true } });
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });

  assert.equal(w.lastRun().exitCode, 0, 'the run is a success: the Caterer half completed');
  // the Caterer half exactly as a Caterer-only success
  assert.equal(w.svc.zoho.created().length, 5);
  assert.ok(w.svc.zoho.created().every((r) => r.payload.Source === 'Caterer'), 'no Reed candidate, no fake one either');
  const rows = runRows(w);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sources, 'both');
  assert.equal(rows[0].new_to_zoho, 5);
  assert.equal(rows[0].errors, 0, 'the run-level errors are the Caterer and Zoho side, unchanged');
  assert.equal(JSON.parse(rows[0].caterer_json).newToZoho, 5);
  // the Reed half: failed, errors 1, never "pool 0, OK"
  const reed = JSON.parse(rows[0].reed_json);
  assert.deepEqual([reed.status, reed.failed, reed.errors, reed.pool], ['failed', true, 1, 0]);
  assert.match(reed.failureReason, /HTTP 400 code 50010/);
  const results = w.json(`downloads/${w.list('downloads').find((n) => /^phase2-results-merged-queue-/.test(n))}`);
  assert.equal(results.reedStatus, 'failed');
  assert.equal(results.reedStats.errors, 1);
  // honest log lines: the failure marker, the forensic lines, no "recorded both-source attempt", no token
  const log = logText(w);
  assert.match(log, /REED_FIRST_PAGE_FAILED: HTTP 400 code 50010 attempts=3 streak=1/);
  // (the failure tail that run-pipeline prints for a failed Reed child repeats them once more, so count the live echo lines)
  assert.equal((log.match(/^\[reed\] \[reed-browser-fetch\] REED_REQUEST_FORENSIC attempt=\d\/3 status=400 code=50010 /gm) || []).length, 3);
  assert.ok(!/record both-source attempt/.test(log));
  assert.ok(!/Bearer |eyJ/.test(log), 'no token in the logs');
  // one warn alert for the episode
  assert.deepEqual(firstPageAlerts(w).map((a) => a.severity), ['warn']);
  assert.equal(w.alerts().filter((a) => /^reed-auth/.test(a.key || '')).length, 0, 'not treated as an auth failure');
  // the territory: searched for the Caterer half, Reed-pending, one automatic retry tomorrow
  const t0 = territory(w);
  assert.equal(t0.reed_pending_since, today());
  assert.equal(t0.next_run_date, tomorrow());
  assert.equal(t0.last_searched, today());
  assert.deepEqual(w.pendingFiles(), [], 'no Reed-auth retry of the whole territory');
  // the dashboard shows Reed as failed for this run
  if (PY) {
    const r = spawnSync(PY, [CLIENT], { input: JSON.stringify({ home: w.home, calls: [{ path: '/runs' }] }), encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr.slice(-400));
    const run = JSON.parse(r.stdout).results[0].json.runs[0];
    assert.equal(run.reed.failed, true);
    assert.equal(run.reed.status, 'failed');
    assert.equal(run.reed.errors, 1);
    assert.equal(run.sources, 'both');
  }
  // the catch-up tool: a territory that ran today is left out (the retry is tomorrow's); seen from tomorrow it is listed (codes only) and would be queued
  const cli = (args) => spawnSync(process.execPath, [path.join(REPO, 'tools', 'reed-catchup.js'), '--home', w.home, ...args], { encoding: 'utf8' });
  const same = cli(['--since', today(), '--queue', '1', '--dry-run']);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /ran today 1/);
  const tool = require(path.join(REPO, 'tools', 'reed-catchup.js'));
  const lines = [];
  const code = await tool.main(['--home', w.home, '--since', today(), '--queue', '1', '--dry-run'], { out: (x) => lines.push(x), err: (x) => lines.push(x), now: new Date(Date.now() + 86400000) });
  const text = lines.join(' | ');
  assert.equal(code, 0, text);
  assert.match(text, /failed \(Reed failed or auth failed\): 1/);
  assert.match(text, /would queue 1/);
  assert.ok(!/Sous|Chef/.test(text), 'no job title is printed');
  // the usual cleanliness
  assert.deepEqual(reedBrowserProcs(w), []);
  assert.deepEqual(w.lockProblems(), []);
  assert.deepEqual(w.netBlocked(), []);
});

test('15b the fault is gone: the next run for the territory does the Reed half (20 in Zoho), the mark is cleared and the alert episode is closed', async (t) => {
  const w = await scene('s15b-recovery');
  t.after(() => w.close());
  setFault(w, { api: { alwaysHeaderMissing: true } });
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(territory(w).reed_pending_since, today());
  assert.deepEqual(firstPageAlerts(w).map((a) => a.severity), ['warn']);

  setFault(w, {});
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0);
  const rows = runRows(w);
  assert.equal(rows.length, 2);
  const reed = JSON.parse(rows[1].reed_json);
  assert.deepEqual([reed.status, reed.errors], ['ok', 0]);
  assert.equal(reed.newToZoho, 20);
  assert.equal(w.svc.zoho.created().filter((r) => r.payload.Source === 'Reed').length, 20);
  assert.equal(territory(w).reed_pending_since, null, 'the episode is closed');
  assert.equal(w.exists('runtime/reed-first-page-streak.json'), false);
  assert.equal(firstPageAlerts(w).length, 1, 'no second alert');
  assert.ok(!('reed-first-page-failed' in (w.json('runtime/reed-alert-episodes.json') || {})), 'the alert episode was closed by the good first page');
  assert.deepEqual(reedBrowserProcs(w), []);
});

test('15c transient 400s and page reloads between the steps are absorbed: a normal success with Reed candidates, no alert, no marker', async (t) => {
  const w = await scene('s15c-transient');
  t.after(() => w.close());
  setFault(w, {
    api: { failNext: [{ status: 400, body: HEADER_MISSING, path: '/candidate/search/' }, { status: 400, body: HEADER_MISSING, path: '/candidate/search/' }] },
    site: { reloadAfterEvals: [1, 2, 3], spaReloadMs: 400 },
  });
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0);
  const reed = JSON.parse(runRows(w)[0].reed_json);
  assert.deepEqual([reed.status, reed.errors], ['ok', 0]);
  assert.equal(w.svc.zoho.created().filter((r) => r.payload.Source === 'Reed').length, 20);
  assert.equal((logText(w).match(/^\[reed\] \[reed-browser-fetch\] REED_REQUEST_FORENSIC/gm) || []).length, 2, 'the two failed attempts left one forensic line each');
  assert.deepEqual(firstPageAlerts(w), []);
  assert.ok(!territory(w).reed_pending_since);
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  assert.deepEqual(reedBrowserProcs(w), []);
});

test('15d a place Reed cannot look up is an EMPTY Reed search (no failure, no alert, no Reed-pending mark, not listed by the catch-up); a search whose pages can not be fetched after a good first page is a FAILURE', async (t) => {
  const w = await scene('s15d-classes');
  t.after(() => w.close());
  fs.rmSync(path.join(w.home, 'reed-location-cache.json'), { force: true }); // the world ships a warm location cache: without this the place is never looked up
  setFault(w, { api: { noLocations: true } });
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.svc.zoho.created().length, 5, 'the Caterer half is unchanged');
  const reed = JSON.parse(runRows(w)[0].reed_json);
  assert.deepEqual([reed.status, reed.errors, reed.pool], ['empty', 0, 0]);
  assert.ok(!reed.failed);
  assert.match(logText(w), /REED_LOCATION_NOT_FOUND/);
  assert.ok(!/REED_FIRST_PAGE_FAILED/.test(logText(w)));
  assert.deepEqual(firstPageAlerts(w), []);
  assert.ok(!territory(w).reed_pending_since);
  assert.equal(w.exists('runtime/reed-first-page-streak.json'), false);

  // the first page works, every search page after it fails: the Reed half did not happen and is recorded as failed
  setFault(w, { api: { failNext: [{ status: 400, body: HEADER_MISSING, path: '/candidate/search/', skip: 1 }].concat(Array.from({ length: 14 }, () => ({ status: 400, body: HEADER_MISSING, path: '/candidate/search/' }))) } });
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0);
  const rows = runRows(w);
  assert.equal(rows.length, 2);
  const reed2 = JSON.parse(rows[1].reed_json);
  assert.deepEqual([reed2.status, reed2.failed], ['failed', true]);
  assert.ok(reed2.errors >= 1);
  assert.equal(territory(w).reed_pending_since, today());
  assert.deepEqual(firstPageAlerts(w).map((a) => a.severity), ['warn']);
  assert.match(logText(w), /no search page could be fetched/);
  assert.deepEqual(reedBrowserProcs(w), []);
  assert.deepEqual(w.lockProblems(), []);
});
