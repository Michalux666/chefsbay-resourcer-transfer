'use strict';
// SCENARIO 7 - Reed. (a) Reed off (RESOURCER_SOURCES=caterer, the default) and a pending search that asks for both: the
// request is answered once by a Caterer-only run and consumed, no Reed browser ever starts. (b) Reed on, against the fake Reed
// site and API: both halves run one after the other, merge and are pushed by one Phase 2; the Reed browser tree is gone
// afterwards. (c) A request gated while Reed was off is restored when the operator switches Reed on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const events = (w) => w.jsonl('logs/watchdog-runner.jsonl');
const done = (w) => async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0;
const reedBrowserProcs = (w) => U.procs(/remote-debugging-port=/).filter((p) => p.cmd.includes(w.home));
const REED_MARKERS = Array.from({ length: 30 }, (_, i) => `cand${9001 + i}@example.invalid`);

async function scene(name, reed) {
  const w = new World(name);
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  if (reed) await w.enableReed();
  return w;
}

test('7a Reed off, pending file says both: one Caterer-only run consumes it; no Reed browser, no Reed call', async (t) => {
  const w = await scene('s7a-reed-off', false);
  t.after(() => w.close());
  assert.equal(w.envFile.RESOURCER_SOURCES, 'caterer');
  const pending = w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 10, tickMin: 1 });
  for (let i = 0; i < 2; i += 1) await w.cron('resourcer-tick');
  assert.equal(events(w).filter((e) => e.event === 'picked').length, 1, 'the request was answered once, not again and again');
  const gated = events(w).find((e) => e.event === 'sources-gated');
  assert.ok(gated, 'the gate is logged');
  assert.deepEqual([gated.requested, gated.effective], ['both', 'caterer']);
  assert.deepEqual(w.pendingFiles(), []);
  assert.equal(w.lastRun().exitCode, 0);
  const rr = w.dbAll('select sources, new_to_zoho, reed_json from run_results');
  assert.deepEqual(rr.map((r) => [r.sources, r.new_to_zoho, r.reed_json]), [['caterer', 5, null]]);
  assert.equal(w.svc.zoho.created().filter((r) => r.payload.Source === 'Reed').length, 0);
  assert.equal(w.exists('state/chrome-reed'), false, 'no Reed browser profile was ever created');
  assert.equal(w.exists('state/reed-session.json'), false);
  assert.deepEqual(reedBrowserProcs(w), []);
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  assert.equal(w.dbAll('select count(*) n from candidates where reed_id is not null and reed_id between 9000 and 9100')[0].n, 0);
  assert.ok(pending);
});

test('7b Reed on: Caterer half, then Reed half, one merged queue, one Phase 2; the Reed browser tree is gone afterwards', async (t) => {
  const w = await scene('s7b-reed-on', true);
  t.after(() => w.close());
  let firstReed = null;
  const timer = setInterval(() => {
    if (firstReed === null && reedBrowserProcs(w).length > 0) firstReed = Date.now();
  }, 20);
  w.dropPending({ sources: 'both' });
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  clearInterval(timer);

  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(events(w).filter((e) => e.event === 'picked').length, 1);
  assert.ok(firstReed, 'the Reed browser really ran');
  // Caterer scraping and unlocking (phase 1) are over before the Reed browser is started. (Phase 2 then downloads the Caterer CVs
  // through the still-warm Caterer browser while the Reed browser is up: two browsers at once, see docs/parity/integration.md.)
  const lastCatererScrape = Math.max(...w.browserCalls().filter((c) => (c.cmd === 'open' && /CandidateSearch\/Results/.test((c.argv || []).join(' '))) || (c.script && /UnlockCandidate/.test(c.script))).map((c) => c.t));
  assert.ok(lastCatererScrape < firstReed, 'the Reed browser was not started before the Caterer scrape and unlocks finished');

  const names = w.list('downloads');
  assert.equal(names.filter((n) => /^merged-queue-/.test(n)).length, 1, names.join(','));
  assert.equal(names.filter((n) => /^reed-approved-queue-/.test(n)).length, 1);
  const results = w.json(`downloads/${names.find((n) => /^phase2-results-merged-queue-/.test(n))}`);
  assert.equal(results.sources, 'both');
  assert.equal(results.new, 25);
  assert.equal(results.duplicates, 1);
  assert.equal(results.errors, 0);
  assert.equal(results.catererStats.newToZoho, 5);
  assert.equal(results.reedStats.newToZoho, 20);

  const z = w.svc.zoho;
  assert.equal(z.created().length, 25);
  assert.equal(z.created().filter((r) => r.payload.Source === 'Reed').length, 20);
  assert.equal(z.created().filter((r) => r.payload.Source === 'Caterer').length, 5);
  assert.ok(z.created().every((r) => r.attachments.length === 1), 'every new candidate got its CV');
  const reedRec = z.created().find((r) => r.payload.Source === 'Reed');
  assert.match(reedRec.payload.ReedID, /^90\d\d$/);
  assert.match(reedRec.payload.Email, /^cand90\d\d@example\.invalid$/);

  const rr = w.dbAll('select sources, pool, new_to_zoho, duplicates, caterer_json, reed_json from run_results');
  assert.equal(rr.length, 1);
  assert.equal(rr[0].sources, 'both');
  assert.equal(rr[0].new_to_zoho, 25);
  assert.equal(JSON.parse(rr[0].reed_json).newToZoho, 20);
  assert.equal(JSON.parse(rr[0].caterer_json).newToZoho, 5);
  const reedRows = w.dbAll('select reed_id, zoho_id from candidates where reed_id between 9000 and 9100');
  assert.equal(reedRows.length, 20);
  assert.ok(reedRows.every((r) => r.zoho_id));
  const usage = w.dbAll("select profile_views, cv_downloads from reed_daily_usage order by date desc limit 1")[0];
  assert.deepEqual([usage.profile_views, usage.cv_downloads], [20, 20], 'the Reed daily budget was counted');

  const shadow = w.jsonl(`shadow/${w.list('shadow', /^screening-/)[0]}`);
  assert.ok(shadow.some((r) => r.source === 'reed'), 'Reed candidates went through the same screening');
  assert.ok(shadow.some((r) => r.source === 'caterer'));

  assert.deepEqual(reedBrowserProcs(w), [], 'the Reed browser tree is gone');
  assert.equal(w.exists('runtime/browser.lock'), false);
  assert.ok(w.exists('state/reed-session.json'));
  assert.equal(C.modeOf(w.p('state', 'reed-session.json')) & 0o077, 0, 'the Reed token file is owner-only');
  assert.ok(w.jsonl('logs/watchdog-runner.jsonl').some((e) => e.event === 'reed-browser-stop'));
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), [], 'no CV or candidate JSON left, Caterer or Reed');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  assert.deepEqual(w.lockProblems(), []);
  assert.deepEqual(C.secretHits(w), []);
  assert.deepEqual(w.netBlocked(), []);
  // Reed personal data: only in the queue and result files the sweep removes
  const leaks = [];
  for (const f of C.profileFiles(w)) {
    const rel = path.relative(w.profile, f).split(path.sep).join('/');
    if (/workspace\/resourcer\/downloads\/(approved-queue|merged-queue|reed-approved-queue|phase2-results)-/.test(rel)) continue;
    const buf = fs.readFileSync(f);
    for (const m of REED_MARKERS) if (buf.includes(m)) leaks.push(`${rel} (${m})`);
  }
  assert.deepEqual(leaks, []);
});

test('7c a request gated while Reed was off is restored when Reed is switched on', async (t) => {
  const w = await scene('s7c-switch-on', false);
  t.after(() => w.close());
  w.setWorld({ login: { mode: 'safelist' } });
  w.setFakeBrowserState({ loggedIn: false });
  const name = w.dropPending({ sources: 'both' });
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  assert.equal(w.lastRun().exitCode, 11, 'stopped at the session check, after the gate');
  const gated = w.json(`pending-searches/${name}`);
  assert.deepEqual([gated.sources, gated.sourcesRequested], ['caterer', 'both'], 'the request is remembered');

  // the operator fixes the session and passes the Reed canary
  await w.enableReed();
  w.setWorld({ login: { mode: 'success' } });
  w.node('caterer-login.js', ['--open-link', 'https://recruiter.caterer.com/login/TwoFaAuthRedirect?token=tok-newest']);
  w.node('pipeline-watchdog.js', ['--clear-cooldown']);
  await w.tickUntil(done(w), { maxTicks: 12, tickMin: 1, gapMs: 1500 });
  assert.equal(w.lastRun().exitCode, 0);
  const restored = events(w).filter((e) => e.event === 'sources-gated');
  assert.ok(restored.some((e) => e.effective === 'both'), JSON.stringify(restored));
  assert.equal(w.dbAll('select sources from run_results')[0].sources, 'both');
  assert.equal(w.svc.zoho.created().length, 25);
  assert.deepEqual(reedBrowserProcs(w), []);
});
