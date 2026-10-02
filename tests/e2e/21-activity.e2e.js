'use strict';
// SCENARIO 20 - the search window ("active within") and the CV limit reach both sources, and the report shows the filter that was really applied
// (docs/ACTIVITY.md). One world with Reed on, run the way Hermes runs it (cron wrapper, scrubbed environment):
//   21.1 the read-only probe (tools/activity-probe.js) against the fake Caterer and Reed: counts only, no person, no unlock, no profile view; refused while the browser lock is held
//   21.2 a one-off request for 12 months and 30 CVs: the Caterer URL carries the mapped id, the fake page echoes it (match=yes), Reed gets year and a limit of 30,
//        and the run results carry the whole block
//   21.3 a scheduled territory with the stored defaults in the same world: the Caterer URL is the one main builds (byte for byte, no LastActivityId), Reed month and 20
//   21.4 CATERER_ACTIVITY_FILTER=all sends the stored window of a scheduled territory; off sends nothing even for a request
//   21.5 a window with no known id (3 months): no parameter, a WARN event and a note, the run completes
//   21.6 a Caterer that shows another window than the one sent: match=no, ONE alert caterer-activity-mismatch a day, the run completes
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { World, NODE, REPO } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const w = new World('s21-activity');
const PROBE = path.join(REPO, 'tools', 'activity-probe.js');
const REED_MARKERS = Array.from({ length: 12 }, (_, i) => `cand${9001 + i}@example.invalid`);
const done = async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0;
const events = () => w.jsonl('logs/watchdog-runner.jsonl');

const MAIN_URL = (id) => new RegExp(`^https://recruiter\\.caterer\\.com/CandidateSearchWebMvc/CandidateSearch/Results\\?FreeText=Chef&ShowUnspecifiedSalary=False&CurrentLocation=LS29&Radius=32187&SalaryFacetsType=99&PreRegStatusFacet=0%2c1&HideCandidatesSinceDays=7${id === null ? '' : `&LastActivityId=${id}`}&SearchId=[0-9a-f-]{36}&scr=1&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50$`);

let reedLog;
let reedSeen = 0;

const resultsUrls = (from) => w.browserCalls().slice(from).filter((c) => c.cmd === 'open' && /CandidateSearch\/Results/.test((c.argv || []).join(' ')))
  .map((c) => (c.argv || []).find((a) => /^https:/.test(a)));
const consoleLogs = () => w.list('logs', /^phase1-console-/).sort();
const resultsFiles = () => w.list('downloads', /^phase2-results-/);
const reedRequests = () => U.readJsonl(reedLog);
const searchFrames = (from) => reedRequests().slice(from).filter((r) => /^\/candidate\/search\/boolean/.test(r.path)).map((r) => r.activityTimeFrame);

// One run: drop a pending file, tick until it is drained. Returns what the run left behind.
async function runOnce(over, opts) {
  const o = Object.assign({ maxTicks: 14 }, opts);
  const callsBefore = w.browserCalls().length;
  const logsBefore = consoleLogs().length;
  const resultsBefore = new Set(resultsFiles());
  const reedBefore = reedRequests().length;
  w.dropPending(over);
  await w.tickUntil(done, { maxTicks: o.maxTicks, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0, JSON.stringify(w.lastRun()));
  const log = consoleLogs().slice(logsBefore).map((f) => w.text(`logs/${f}`)).join('\n');
  const results = resultsFiles().filter((f) => !resultsBefore.has(f)).sort().map((f) => w.json(`downloads/${f}`));
  return {
    urls: resultsUrls(callsBefore), log, results: results[results.length - 1] || null, reedFrames: searchFrames(reedBefore), line: (log.split('\n').find((l) => l.startsWith('ACTIVITY_FILTER ')) || ''),
  };
}

test.before(async () => {
  await w.create({});
  w.warmLoggedIn();
  reedLog = path.join(w.privateDir, 'reed-requests.jsonl');
  w.knobs.E2E_REED_REQUEST_LOG = reedLog;
  await w.enableReed(Array.from({ length: 12 }, () => ({})));
  fs.writeFileSync(reedLog, '');
});
test.after(async () => { await w.close(); });

function runProbe(args, extraEnv) {
  const r = spawnSync(NODE, [PROBE].concat(args), {
    cwd: w.home, encoding: 'utf8', timeout: 240000,
    env: w.cronEnv(Object.assign({ RESOURCER_HOME: w.home, HERMES_HOME: w.profile }, extraEnv || {})),
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('21.1 the probe: counts only for every Caterer id and every Reed value, nothing paid or written, refused while the browser lock is held', async () => {
  const candidatesBefore = w.dbAll('select count(*) n from candidates')[0].n;
  const callsBefore = w.browserCalls().length;
  const r = runProbe(['--job', 'Chef', '--location', 'LS29', '--distance', '20']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lines = r.stdout.split('\n');
  const caterer = lines.filter((l) => l.startsWith('CATERER param='));
  assert.equal(caterer.length, 7, r.stdout);
  assert.deepEqual(caterer.map((l) => /param=(\S+)/.exec(l)[1]), ['none', 'LastActivityId=7', 'LastActivityId=8', 'LastActivityId=9', 'LastActivityId=11', 'LastActivityId=15', 'LastActivityId=0']);
  const echoed = Object.fromEntries(caterer.map((l) => [/param=(\S+)/.exec(l)[1], /applied="([^"]*)"/.exec(l)[1]]));
  assert.deepEqual(echoed, { none: '', 'LastActivityId=7': '14 days', 'LastActivityId=8': '1 month', 'LastActivityId=9': '2 months', 'LastActivityId=11': '6 months', 'LastActivityId=15': '12 months', 'LastActivityId=0': 'All' });
  assert.ok(caterer.every((l) => /pool=\d+ status=ok$/.test(l)), r.stdout);
  const reed = lines.filter((l) => l.startsWith('REED activityTimeFrame='));
  assert.equal(reed.length, 11, r.stdout);
  assert.ok(reed.every((l) => /total=12 status=ok$/.test(l)), r.stdout);
  assert.match(lines[lines.length - 2] || lines[lines.length - 1], /# done: 0 variant\(s\) could not be read/);

  // no person in the output, nothing unlocked, no profile view or CV download on Reed, nothing in the database or in Zoho
  const markers = [];
  for (const c of D.CANDIDATES) { const m = C.markers(c.n); markers.push(m.name, m.surname, m.email, m.phone); }
  for (const m of markers.concat(REED_MARKERS)) assert.ok(!r.stdout.includes(m) && !r.stderr.includes(m), `the probe printed ${m}`);
  const calls = w.browserCalls().slice(callsBefore);
  assert.ok(!calls.some((c) => c.script && /UnlockCandidate|DownloadCV/.test(c.script)), 'no unlock and no CV download');
  assert.ok(calls.filter((c) => c.cmd === 'open' && /CandidateSearch\/Results/.test((c.argv || []).join(' '))).length === 7, 'one results page per variant');
  const paths = reedRequests().map((x) => x.path);
  assert.ok(paths.some((p) => /^\/candidate\/search\/boolean/.test(p)));
  assert.deepEqual(paths.filter((p) => /\/candidate\/profile|\/candidate\/cv/.test(p)), [], 'no Reed profile view and no CV download');
  assert.equal(w.dbAll('select count(*) n from candidates')[0].n, candidatesBefore);
  assert.deepEqual(w.svc.zoho.created(), []);
  assert.equal(w.exists('runtime/browser.lock'), false, 'the lock is released');
  assert.deepEqual(U.procs(/remote-debugging-port=/).filter((p) => p.cmd.includes(w.home)), [], 'the Reed browser the probe started is stopped again');

  // refused while the browser lock is held by a live process that is not the probe's parent
  const holder = spawn('sleep', ['120'], { stdio: 'ignore', detached: true });
  try {
    fs.writeFileSync(w.p('runtime', 'browser.lock'), JSON.stringify({ owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString(), purpose: 'caterer-run' }));
    const refused = runProbe(['--job', 'Chef', '--location', 'LS29', '--distance', '20']);
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /REFUSED: browser\.lock is held by caterer/);
    assert.equal(refused.stdout.split('\n').filter((l) => l.startsWith('CATERER param=')).length, 0, 'not one page was loaded');
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { try { process.kill(holder.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(w.p('runtime', 'browser.lock'), { force: true });
  }
  assert.equal(runProbe(['--job', 'Chef', '--location', 'LS29', '--distance', '20', '--dry-run']).code, 0);

  // the extra ids (what the old skill table calls 7 days, 3 months and 12 months): three more pages through the same adapters, read like the others
  w.setWorld({ searchWorld: { activity: { echoById: { 14: '18 months', 10: '3 months', 6: '7 days' } } } });
  const extra = runProbe(['--job', 'Chef', '--location', 'LS29', '--distance', '20', '--source', 'caterer', '--extra-ids', '6,10,14']);
  assert.equal(extra.code, 0, extra.stdout + extra.stderr);
  const extraLines = extra.stdout.split('\n').filter((l) => l.startsWith('CATERER param='));
  assert.deepEqual(extraLines.map((l) => /param=(\S+)/.exec(l)[1]), ['none', 'LastActivityId=7', 'LastActivityId=8', 'LastActivityId=9', 'LastActivityId=11', 'LastActivityId=15', 'LastActivityId=0', 'LastActivityId=6', 'LastActivityId=10', 'LastActivityId=14']);
  const extraEchoed = Object.fromEntries(extraLines.map((l) => [/param=(\S+)/.exec(l)[1], /applied="([^"]*)"/.exec(l)[1]]));
  assert.equal(extraEchoed['LastActivityId=14'], '18 months');
  assert.equal(extraEchoed['LastActivityId=10'], '3 months');
  assert.equal(extraEchoed['LastActivityId=6'], '7 days');
  assert.equal(extraEchoed['LastActivityId=15'], '12 months');
  assert.ok(extraLines.every((l) => /pool=\d+ status=ok$/.test(l)), extra.stdout);
  for (const m of markers) assert.ok(!extra.stdout.includes(m), 'no person in the extra run');
  assert.ok(!w.browserCalls().slice(callsBefore).some((c) => c.script && /UnlockCandidate|DownloadCV/.test(c.script)), 'still no unlock and no download');
  assert.equal(w.exists('runtime/browser.lock'), false, 'the lock is released after the extra run');
  fs.writeFileSync(reedLog, '');
  // from here on the Caterer search finds nobody: the runs below are about the window, and stay short
  w.setWorld({ searchWorld: { byLocation: { LS29: { total: 777, pages: { 1: [], 2: [], 3: [] } } } } });
});

test('21.2 a one-off request for 12 months and 30 CVs: Caterer gets LastActivityId=15 and echoes it, Reed gets year and 30, the results carry the block', async () => {
  const r = await runOnce({ source: 'request-search-cli', sources: 'both', activeWithin: '12 months', cvLimit: 30, priority: 'high' });
  assert.equal(r.urls.length >= 1, true);
  assert.match(r.urls[0], MAIN_URL(15));
  assert.equal(r.line, 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="12 months" match=yes');
  assert.match(r.log, /REED_ACTIVITY requested="12 months" sent="year" cvLimit=30/);
  assert.ok(r.reedFrames.length >= 1 && r.reedFrames.every((f) => f === 'year'), JSON.stringify(r.reedFrames));
  assert.ok(events().some((e) => e.event === 'activity-filter' && e.sent === 15 && e.requested === '12 months' && e.manual === true));
  assert.deepEqual(r.results.activity, {
    requestedActiveWithin: '12 months', requestedCvLimit: 30, sentLastActivityId: 15, appliedFilterText: '12 months', poolHeaderCount: 777, matched: 'yes',
    reed: { activeWithin: 'year', requestedActiveWithin: '12 months', cvLimit: 30, cvLimitRequested: 30, ran: true },
  });
  assert.equal(r.results.activeWithin, '12 months');
  // (the merged queue of a two-source run has never carried cvLimit: the limit of the request is in the activity block)
  assert.equal(r.results.sources, 'both');
  assert.equal(r.results.reedStats.newToZoho, 12, 'Reed did its work with that window');
  const status = w.json(`runs/${w.list('runs', /^phase1-\d{4}.*\.json$/).sort().pop()}`);
  assert.equal(status.activity.matched, 'yes');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
});

test('21.3 a scheduled territory with the stored defaults, same world: the URL is the one main builds, byte for byte, with no window; Reed gets month and 20', async () => {
  const r = await runOnce({ source: 'territory-scheduler', sources: 'both', activeWithin: '1 month', cvLimit: 20, priority: 'low' });
  assert.match(r.urls[0], MAIN_URL(null), 'main builds exactly this URL (the random SearchId aside)');
  assert.ok(!r.urls.some((u) => /LastActivityId/.test(u)));
  assert.equal(r.line, 'ACTIVITY_FILTER requested="1 month" sent="LastActivityId=none" applied="" match=n/a', 'applied is empty: the fake page shows no window when none is sent');
  assert.match(r.log, /REED_ACTIVITY requested="1 month" sent="month" cvLimit=20/);
  assert.ok(r.reedFrames.length >= 1 && r.reedFrames.every((f) => f === 'month'), JSON.stringify(r.reedFrames));
  assert.deepEqual(r.results.activity, {
    requestedActiveWithin: '1 month', requestedCvLimit: 20, sentLastActivityId: 'none', appliedFilterText: '', poolHeaderCount: 777, matched: 'n/a',
    reed: { activeWithin: 'month', requestedActiveWithin: '1 month', cvLimit: 20, cvLimitRequested: 20, ran: true },
  });
  assert.ok(!events().slice(-40).some((e) => /^activity-filter/.test(e.event) && e.manual === false), 'a plain scheduled run logs no window decision');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
});

test('21.4 CATERER_ACTIVITY_FILTER=all sends the stored window of a scheduled territory; off sends nothing even for a request', async () => {
  w.writeEnv({ CATERER_ACTIVITY_FILTER: 'all' });
  const all = await runOnce({ source: 'territory-scheduler', sources: 'caterer', activeWithin: '1 month' });
  assert.match(all.urls[0], MAIN_URL(8));
  assert.equal(all.line, 'ACTIVITY_FILTER requested="1 month" sent="LastActivityId=8" applied="1 month" match=yes');
  w.writeEnv({ CATERER_ACTIVITY_FILTER: 'off' });
  const off = await runOnce({ source: 'dashboard', sources: 'caterer', activeWithin: '12 months', cvLimit: 30 });
  assert.match(off.urls[0], MAIN_URL(null));
  assert.match(off.log, /ACTIVITY_FILTER_NOTE CATERER_ACTIVITY_FILTER=off: the requested window is not sent to Caterer/);
  assert.equal(off.line, 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=none" applied="" match=n/a');
  assert.equal(off.results.activity.sentLastActivityId, 'none');
  assert.match(off.results.activity.note, /CATERER_ACTIVITY_FILTER=off/);
  w.writeEnv({ CATERER_ACTIVITY_FILTER: null });
});

test('21.5 a window with no known id (3 months): no parameter, a WARN event and a note, the run completes', async () => {
  const r = await runOnce({ source: 'request-search-cli', sources: 'caterer', activeWithin: '3 months', cvLimit: 25 });
  assert.match(r.urls[0], MAIN_URL(null));
  assert.match(r.log, /ACTIVITY_FILTER_NOTE no Caterer LastActivityId is known for "3 months" \(caterer-activity\.json\): no filter sent to Caterer/);
  const warn = events().filter((e) => e.event === 'activity-filter-warn');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].sent, 'none');
  assert.match(warn[0].note, /3 months/);
  assert.equal(r.results.activity.requestedActiveWithin, '3 months');
  assert.match(r.results.activity.note, /no Caterer LastActivityId is known for "3 months"/);
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), [], 'a window that cannot be sent is a log warning, not an alert');
});

test('21.6 a Caterer that shows another window than the one sent: match=no, one alert a day, the run completes', async () => {
  w.setWorld({ searchWorld: { activity: { forceEcho: '1 month' } } });
  const first = await runOnce({ source: 'request-search-cli', sources: 'caterer', activeWithin: '12 months', cvLimit: 30 });
  assert.match(first.urls[0], MAIN_URL(15));
  assert.equal(first.line, 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="1 month" match=no');
  assert.equal(first.results.activity.matched, 'no');
  assert.equal(first.results.activity.appliedFilterText, '1 month');
  let mismatches = w.alerts().filter((a) => a.key === 'caterer-activity-mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, 'warn');
  assert.match(mismatches[0].text, /asked for "12 months" \(LastActivityId=15\) and the results page says "1 month"/);
  const second = await runOnce({ source: 'dashboard', sources: 'caterer', activeWithin: '6 months' });
  assert.equal(second.line, 'ACTIVITY_FILTER requested="6 months" sent="LastActivityId=11" applied="1 month" match=no');
  mismatches = w.alerts().filter((a) => a.key === 'caterer-activity-mismatch');
  assert.equal(mismatches.length, 1, 'the second mismatch of the same day raises nothing');

  // what the owner reads afterwards: the last runs, window by window, without reading any code
  const recent = runProbe(['--recent', '10']);
  assert.equal(recent.code, 0, recent.stderr);
  assert.match(recent.stdout, /requested="12 months" cv_limit=30 sent="LastActivityId=15" applied="12 months" match=yes pool=777 reed_window=year reed_cv_limit=30/);
  assert.match(recent.stdout, /requested="1 month" cv_limit=20 sent="LastActivityId=none" applied="" match=n\/a pool=777 reed_window=month reed_cv_limit=20/);
  assert.match(recent.stdout, /requested="6 months" cv_limit=20 sent="LastActivityId=11" applied="1 month" match=no/);
});

test('21.7 end of the scenario: nothing leaked, nothing left running, no stray lock, no blocked network', () => {
  assert.deepEqual(C.secretHits(w), []);
  assert.deepEqual(w.lockProblems(), []);
  assert.deepEqual(w.netBlocked(), []);
  assert.deepEqual(U.procs(/remote-debugging-port=/).filter((p) => p.cmd.includes(w.home)), []);
  // no Caterer person in a log line: the self-check reads a count and one short text, nothing else of the page
  const logs = w.list('logs').map((f) => w.text(`logs/${f}`)).join('\n');
  for (const c of D.CANDIDATES) assert.ok(!logs.includes(C.markers(c.n).name));
});
