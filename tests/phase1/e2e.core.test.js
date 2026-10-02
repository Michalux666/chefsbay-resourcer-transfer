'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;

async function run(t, scenario, args, opts) {
  const home = h.makeHome(scenario, opts);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(args), opts);
  return { home, r, out: r.stdout, calls: r.calls, status: h.statusOf(home), queue: h.queueOf(home) };
}

const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);
const browserCmds = (calls) => callsOf(calls, 'agent-browser').map((c) => c.cmd);

test('normal multi-page run: dedupe, screening, unlock, queue, status schema, hand-off', async (t) => {
  const sc = {
    pages: {
      1: { cards: [card(1001), card(1002, { unlockedPrev: true, neverUnlocked: false }), card(1003), card(1004)] },
      2: { cards: [card(2001), card(2002, { postcode: 'BD1 1AA', cityRaw: 'Foo' })] },
      3: { cards: [] },
    },
    db: { candidates: { 1003: { unlocked: 1 } }, rejections: [{ id: 1004, title: 'Chef' }] },
    ai: { batch: [{ outcome: 'ok' }, { outcome: 'ok', overrides: { 2001: { approved: false, reason: 'Too junior for this role' } } }], single: [{ outcome: 'ok', approved: true, model: 'fake/last-model' }] },
    unlock: { 2002: { success: true, name: 'Sam Two', firstName: 'Sam', lastName: 'Two', email: 'sam2@example.invalid', phone: '07 700 900 002', cvUrl: '/cv2', encId: 'e2', auditId: 'a2', jobTitle: 'Manchester, M22 4AD' } },
  };
  const { r, out, calls, status, queue, home } = await run(t, sc);
  assert.strictEqual(r.code, 0, out);

  // legacy console markers
  for (const m of ['=== PHASE 1 START:', 'JOB: Chef in LS29 | 0 candidates | CV_LIMIT=20', 'Global pipeline lock: clear', 'Pre-validating Caterer session...',
    'Session OK - credits: 62185', '--- Page 1 ---', 'Cards on page 1 : 4', '    SKIP (in DB)', 'HEARTBEAT: AI batch start page 1 (2 candidates)',
    'HEARTBEAT: AI batch end page 1 (exit=0,', '    APPROVED pre-unlock', '    REJECTED pre-unlock: Too junior for this role', '    QUEUED (1 total)',
    '[CHECKPOINT] Saved 2 candidates to queue file after page 1', 'Cards on page 3 : 0', 'No cards - results exhausted', '=== PHASE 1 DONE:',
    'Browser round-trips: 10', 'Approved: 3 | DB skips: 2 | Review rejects: 1 | Errors: 0', 'Credits remaining: 62185', 'After Zoho pre-check: 3 remain (was 3)',
    'Queue file updated', 'PROGRESS_MESSAGE: Phase 1 complete - 3 candidates queued for Chef in LS29.', 'Session saved (post-Phase1)', 'SCREENING_MODEL: fake/last-model',
    'CREDITS: 62185', 'PHASE2_DONE: true']) {
    assert.ok(out.includes(m), `missing marker: ${m}\n${out}`);
  }
  assert.ok(out.includes('QUEUE_FILE: '));

  // status file schema (key order matters to nobody but is kept) and values
  assert.deepStrictEqual(Object.keys(status), ['id', 'status', 'jobTitle', 'location', 'distance', 'pool', 'startedAt', 'page', 'approved', 'skippedDb', 'errors', 'sources', 'phase2Status', 'updatedAt', 'activity']);
  assert.deepStrictEqual(status.activity, { requestedActiveWithin: '1 month', requestedCvLimit: 20, sentLastActivityId: 'none', appliedFilterText: null, poolHeaderCount: null, matched: 'not-checked' }, 'the harness has no activity library: what was asked and sent is recorded, nothing is read from the page');
  assert.match(status.id, /^phase1-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.strictEqual(status.status, 'phase1_complete');
  assert.strictEqual(status.pool, 2 + 3 + 1);
  assert.strictEqual(status.page, 3);
  assert.strictEqual(status.approved, 3);
  assert.strictEqual(status.skippedDb, 2);
  assert.strictEqual(status.errors, 0);
  assert.strictEqual(status.sources, 'caterer');
  assert.strictEqual(status.phase2Status, 'pending', 'written before the first phase1_complete so a kill before Phase 2 stays recoverable');
  assert.strictEqual(status.distance, 20);

  // queue file schema
  assert.deepStrictEqual(Object.keys(queue), ['searchId', 'searchDate', 'jobTitle', 'location', 'distance', 'activeWithin', 'keywords', 'cvLimit', 'priority', 'sources', 'phase2Status',
    'screeningModel', 'candidateCount', 'creditsRemaining', 'phase1StartedAt', 'requestedAt', 'phase1Stats', 'candidates', 'activity']);
  assert.deepStrictEqual(Object.keys(queue.phase1Stats), ['pagesScraped', 'approved', 'skippedDb', 'scrapingStartedAt', 'phase1CompletedAt', 'sessionValidationTimeSecs', 'scrapingTimeSecs',
    'avgTimePerPageSecs', 'avgTimePerBrowserRoundtrip', 'pageTimings', 'sessionRefreshed', 'skippedReview', 'errors', 'browserRoundtrips', 'totalCandidatesSeen']);
  assert.strictEqual(queue.phase2Status, 'pending');
  assert.strictEqual(queue.screeningModel, 'fake/last-model');
  assert.strictEqual(queue.candidateCount, 6);
  assert.strictEqual(queue.creditsRemaining, '62185');
  assert.strictEqual(queue.phase1Stats.pagesScraped, 3);
  assert.strictEqual(queue.phase1Stats.browserRoundtrips, 10);
  assert.strictEqual(queue.phase1Stats.totalCandidatesSeen, 6);
  assert.strictEqual(queue.phase1Stats.skippedReview, 1);
  assert.strictEqual(queue.phase1Stats.sessionRefreshed, false);
  assert.strictEqual(queue.phase1Stats.pageTimings.length, 2);
  assert.strictEqual(queue.requestedAt, queue.phase1StartedAt);
  assert.match(queue.searchDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(queue.candidates.length, 3);
  assert.deepStrictEqual(Object.keys(queue.candidates[0]), ['id', 'name', 'firstName', 'lastName', 'email', 'phone', 'currentTitle', 'currentEmployer', 'city', 'postcode', 'state',
    'experience', 'encId', 'auditId', 'cvUrl']);

  // candidate values: phone whitespace stripped, city resolution order, state from the map
  const byId = Object.fromEntries(queue.candidates.map((c) => [c.id, c]));
  assert.strictEqual(byId['1001'].phone, '07700900001');
  assert.strictEqual(byId['1001'].city, 'Leeds');
  assert.strictEqual(byId['1001'].state, 'West Yorkshire');
  assert.strictEqual(byId['2002'].city, 'Manchester');
  assert.strictEqual(byId['2002'].state, 'Greater Manchester');
  assert.strictEqual(byId['2002'].currentTitle, 'Manchester, M22 4AD');
  assert.strictEqual(byId['2002'].currentEmployer, '');

  // screening call contract: args, ids, no unlock token, input file removed
  const batches = callsOf(calls, 'ai-review').filter((c) => c.mode === 'batch');
  assert.strictEqual(batches.length, 2);
  assert.deepStrictEqual(batches[0].ids, ['1001', '1002']);
  assert.deepStrictEqual(batches[1].ids, ['2001', '2002']);
  assert.strictEqual(batches[0].job, 'Chef');
  assert.strictEqual(batches[0].location, 'LS29');
  assert.strictEqual(batches[0].distance, '20');
  assert.strictEqual(batches[0].hasToken, false);
  assert.strictEqual(batches[0].fileMode, 'stdin', 'candidates are piped, never written to disk');
  assert.strictEqual(batches[0].source, 'caterer');
  assert.match(batches[0].runId, /^phase1-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.ok(!fs.existsSync(path.join(home, 'runtime', 'screening-input')) || fs.readdirSync(path.join(home, 'runtime', 'screening-input')).length === 0);

  // DB bookkeeping order and content
  const db = callsOf(calls, 'candidates-db').map((c) => [c.cmd].concat(c.args).join(' '));
  assert.ok(db.includes('check-batch-scoped 1001,1002,1003,1004 Chef'), db.join('\n'));
  assert.ok(db.includes('seen 2001') && db.includes('reject-title 2001 Chef'));
  const order = calls.map((c) => (c.tool === 'candidates-db' ? `db:${c.cmd} ${c.args.join(' ')}` : (c.tool === 'caterer-unlock' ? `unlock:${c.id}` : c.tool)));
  assert.ok(order.indexOf('db:add 1002') > order.indexOf('unlock:1002'), 'unlockedPrev add now happens after the unlock: a failed unlock must not hide an approved candidate');
  assert.ok(order.indexOf('db:add 1001') > order.indexOf('unlock:1001'), 'neverUnlocked add happens after the unlock');
  assert.ok(db.includes('add 1001'), 'neverUnlocked add after the single review');
  assert.ok(!db.some((l) => l.startsWith('reject-title 1002')));

  // hand-off: caterer-only runs Phase 2 inline with the queue file
  const pap = callsOf(calls, 'process-approved-queue');
  assert.strictEqual(pap.length, 1);
  assert.strictEqual(pap[0].queue.candidates.length, 3);
  assert.strictEqual(callsOf(calls, 'run-pipeline').length, 0);

  // browser call forms: page 2 carries PageNumber, PageSize was already in the URL
  const opens = callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open');
  assert.strictEqual(opens.length, 3);
  assert.ok(opens[0].url.includes('PageSize=50') && !opens[0].url.includes('PageNumber'));
  assert.ok(opens[1].url.endsWith('&PageNumber=2'));
  assert.ok(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'eval').every((c) => c.jsMarker), 'the extract script is sent verbatim');

  // no personal data on the console beyond the minimised lines
  assert.ok(!out.includes('sam2@example.invalid') && !out.includes('Sam Two') && !out.includes('TOKEN-'));
  assert.ok(!out.includes('LS29 8AB'), 'full postcodes stay out of the log');
  if (process.platform !== 'win32') {
    const probe = path.join(home, '_modeprobe');
    fs.writeFileSync(probe, '', { mode: 0o600 });
    if ((fs.statSync(probe).mode & 0o777) === 0o600) {
      const qf = fs.readdirSync(path.join(home, 'downloads')).find((f) => f.startsWith('approved-queue-'));
      assert.strictEqual(fs.statSync(path.join(home, 'downloads', qf)).mode & 0o777, 0o600, 'queue files (personal data) are owner-only');
    }
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'runs')).filter((f) => f.endsWith('.tmp')), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'downloads')).filter((f) => f.endsWith('.tmp')), []);
});

test('the URL is normalised before the first open (PageSize, SearchFormType, SearchOptionColumn injected)', async (t) => {
  const bare = 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results?FreeText=Chef&CurrentLocation=LS29&PageNumber=2#search-results';
  const home = h.makeHome({ pages: { 1: { cards: [] , text: '0 candidates' } } });
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, ['--results-url', bare, '--job-title', 'Chef', '--location', 'LS29', '--sources', 'caterer']);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('URL normalisation: appended SearchFormType=Targeted (was missing)'));
  assert.ok(r.stdout.includes('URL normalisation: appended SearchOptionColumn=ExactMatch (was missing)'));
  assert.ok(r.stdout.includes('URL normalisation: appended PageSize=50 (was missing)'));
  const open = callsOf(r.calls, 'agent-browser').find((c) => c.cmd === 'open');
  assert.strictEqual(open.url, 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results?FreeText=Chef&CurrentLocation=LS29&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50');
});

test('empty results on page 1 with an explicit "0 candidates" page is genuine exhaustion, not an error (remote territory)', async (t) => {
  const { r, out, status, queue, calls } = await run(t, { pages: { 1: { cards: [], text: 'Search results 0 candidates found' } } });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('page explicitly reports 0 candidates: genuine exhaustion for Chef/LS29 (not an error)'), out);
  assert.strictEqual(status.errors, 0);
  assert.strictEqual(status.status, 'phase1_complete');
  assert.strictEqual(queue.phase1Stats.errors, 0);
  assert.strictEqual(queue.phase1Stats.pagesScraped, 1);
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'eval' && c.probe).length, 1);
  assert.strictEqual(callsOf(calls, 'process-approved-queue').length, 1, 'zero approved on a caterer-only run still runs Phase 2 inline');
  assert.ok(out.includes('No candidates to process - calling Phase 2 inline to guarantee cleanup.'));
  assert.ok(!out.includes('PROGRESS_MESSAGE'));
  assert.ok(!browserCmds(calls).includes('state save'), 'no session save on the zero-approved single-source path');
});

test('the "No candidates found" wording is also an explicit zero', async (t) => {
  const { r, out, status } = await run(t, { pages: { 1: { cards: [], text: 'Sorry - No candidates found for your search.' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('genuine exhaustion'));
  assert.strictEqual(status.errors, 0);
});

test('page 1 with 0 cards and a page that shows a non-zero count is an ERROR (silent-zero guard)', async (t) => {
  const { r, out, status, queue } = await run(t, { pages: { 1: { cards: [], text: 'Showing 150 candidates' } } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes("ERROR no cards on page 1 (page returned empty result set despite successful networkidle) AND page did not confirm an explicit zero (probe='\"COUNT:150\"')"), out);
  assert.strictEqual(status.errors, 1);
  assert.strictEqual(queue.phase1Stats.errors, 1);
});

test('silent-zero guard names a networkidle timeout as the cause', async (t) => {
  const { r, out, status } = await run(t, { pages: { 1: { cards: [], text: 'Loading...', waitHang: true } } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('TIMEOUT: wait networkidle page 1 exceeded 90s'));
  assert.ok(out.includes('WARN wait networkidle timed out on page 1 - sleeping 0.01s for page to settle'));
  assert.ok(out.includes('ERROR no cards on page 1 (networkidle timeout) AND page did not confirm an explicit zero'));
  assert.strictEqual(status.errors, 1);
});

test('a probe that times out is treated as no confirmation', async (t) => {
  const { out, status } = await run(t, { pages: { 1: { cards: [], text: '0 candidates', probeHang: true } } });
  assert.ok(out.includes("probe='')"), out);
  assert.strictEqual(status.errors, 1);
});

test('page 2 with zero cards after a successful page 1 is plain exhaustion (no probe)', async (t) => {
  const { out, calls, status } = await run(t, {
    pages: { 1: { cards: [card(1)] }, 2: { cards: [] } },
    db: { candidates: { 1: { unlocked: 1 } } },
  });
  assert.ok(out.includes('No cards - results exhausted'));
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.probe).length, 0);
  assert.strictEqual(status.errors, 0);
});

test('repeated page payload: streak warnings, then stop after three repeats', async (t) => {
  const same = [card(11), card(12)];
  const known = { 11: { unlocked: 1 }, 12: { unlocked: 1 } };
  const { out, calls, queue } = await run(t, { pages: { 1: { cards: same }, 2: { cards: same }, 3: { cards: same }, 4: { cards: same }, 5: { cards: [card(99)] } }, db: { candidates: known } });
  assert.ok(out.includes('WARN repeated page payload detected (streak=1)'));
  assert.ok(out.includes('WARN repeated page payload detected (streak=2)'));
  assert.ok(out.includes('WARN repeated page payload detected (streak=3)'));
  assert.ok(out.includes('Stopping Phase 1: same candidate set repeated across pages - likely pagination/query issue'));
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 4);
  assert.strictEqual(queue.phase1Stats.pagesScraped, 4);
  assert.strictEqual(queue.phase1Stats.skippedDb, 6, 'pages 1-3 counted; the stopping page is not deduped');
});

test('CV_LIMIT+5 stops the page loop immediately and the checkpoint is still written', async (t) => {
  const cards = [];
  for (let i = 1; i <= 8; i++) cards.push(card(3000 + i));
  const { r, out, calls, queue } = await run(t, { pages: { 1: { cards }, 2: { cards: [card(4001)] } } }, ['--cv-limit', '1']);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('QUEUED (6 total)'));
  assert.ok(!out.includes('QUEUED (7 total)'));
  assert.ok(out.includes('Queue size 6 exceeds CV_LIMIT+5 - stopping Phase 1'));
  assert.ok(out.includes('[CHECKPOINT] Saved 6 candidates to queue file after page 1'));
  assert.strictEqual(queue.candidates.length, 6);
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 1, 'page 2 is never opened');
  assert.strictEqual(callsOf(calls, 'caterer-unlock').length, 6);
  assert.strictEqual(queue.cvLimit, 1);
});

test('MAX_PAGES stops the loop after that many pages', async (t) => {
  const known = {};
  const pages = {};
  for (let p = 1; p <= 4; p++) { pages[p] = { cards: [card(5000 + p)] }; known[5000 + p] = { unlocked: 1 }; }
  const { out, calls, queue } = await run(t, { pages, db: { candidates: known } }, ['--max-pages', '2']);
  assert.ok(out.includes('Reached max page limit (2)'));
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 2);
  assert.strictEqual(queue.phase1Stats.pagesScraped, 2);
});

test('failed pages are skipped and counted; the run continues with the next page', async (t) => {
  const known = { 61: { unlocked: 1 }, 64: { unlocked: 1 }, 65: { unlocked: 1 } };
  const sc = {
    pages: {
      1: { cards: [card(61)] },
      2: { rawEval: '"unterminated' },
      3: { rawEval: 'Error: something went wrong' },
      4: { cards: [card(64)] },
      5: { rawEval: 'this is not json' },
      6: { evalError: 'x ECONNRESET' },
      7: { rawEval: '"{}"' },
      8: { cards: [card(65)] },
      9: { cards: [] },
    },
    db: { candidates: known },
  };
  const { out, status, queue } = await run(t, sc, ['--max-pages', '20']);
  assert.ok(out.includes('WARN outer-string decode failed on page 2 - skipping page'));
  assert.ok(out.includes('WARN agent-browser returned an error on page 3 - skipping: Error: something went wrong'));
  assert.ok(out.includes('WARN parsing cards on page 5 failed - skipping page'));
  assert.ok(out.includes('  Raw snippet (first 200): this is not json'));
  assert.ok(out.includes('WARN parsing cards on page 6 failed - skipping page'));
  assert.ok(out.includes('WARN parsing cards on page 7 failed - skipping page'), 'a JSON object is not a card array');
  assert.ok(out.includes('Cards on page 4 : 1') && out.includes('Cards on page 8 : 1'));
  assert.strictEqual(status.errors, 5);
  assert.strictEqual(queue.phase1Stats.pagesScraped, 4);
});

test('open and eval timeouts skip the page (error counted), and a non-timeout open failure is tolerated', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(71)] }, 2: { openHang: true }, 3: { evalHang: true }, 4: { openError: true, cards: [card(72)] }, 5: { cards: [] } },
    db: { candidates: { 71: { unlocked: 1 }, 72: { unlocked: 1 } } },
  };
  const { out, status } = await run(t, sc, ['--max-pages', '9']);
  assert.ok(out.includes('WARN open timed out on page 2 - skipping page'));
  assert.ok(out.includes('TIMEOUT: open page 2 exceeded 90s'));
  assert.ok(out.includes('WARN eval extract timed out on page 3 - skipping page'));
  assert.ok(out.includes('WARN open returned an error on page 4:'));
  assert.ok(out.includes('Cards on page 4 : 1'), 'the legacy script evaluated the page anyway');
  assert.strictEqual(status.errors, 2);
});

test('five consecutive failed pages stop the run instead of looping forever (deliberate guard)', async (t) => {
  const pages = {};
  for (let p = 1; p <= 12; p++) pages[p] = { rawEval: 'garbage' };
  const { r, out, status, calls } = await run(t, { pages }, ['--max-pages', '50']);
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('STOPPING Phase 1: 5 consecutive page failures'));
  assert.strictEqual(status.errors, 5);
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 5);
  // a run that scraped nothing must not consume the territory: Phase 2 is skipped and the pending search stays
  assert.strictEqual(status.status, 'phase1_abandoned');
  assert.strictEqual(status.incomplete, 'scrape-failure');
  assert.strictEqual(status.incompleteRuns, 1);
  assert.strictEqual(callsOf(calls, 'process-approved-queue').length, 0);
  assert.ok(out.includes('PHASE2_SKIPPED'));
});

test('MAX_PAGES also applies when pages fail', async (t) => {
  const pages = {};
  for (let p = 1; p <= 4; p++) pages[p] = { rawEval: 'garbage' };
  const { out, calls } = await run(t, { pages }, ['--max-pages', '3']);
  assert.ok(out.includes('Reached max page limit (3)'));
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 3);
});

test('a failed batched DB check falls back to the per-card check', async (t) => {
  const sc = { pages: { 1: { cards: [card(81), card(82)] }, 2: { cards: [] } }, db: { batchFail: true, candidates: { 81: { unlocked: 1 } } } };
  const { out, calls, queue } = await run(t, sc);
  assert.ok(out.includes('WARN check-batch exit 1 - using per-card check'));
  const checks = callsOf(calls, 'candidates-db').filter((c) => c.cmd === 'check');
  assert.deepStrictEqual(checks.map((c) => c.args[0]), ['81', '82']);
  assert.strictEqual(queue.phase1Stats.skippedDb, 1);
  assert.deepStrictEqual(callsOf(calls, 'ai-review').find((c) => c.mode === 'batch').ids, ['82']);
});

test('an unparseable batched DB answer also falls back', async (t) => {
  const sc = { pages: { 1: { cards: [card(91)] }, 2: { cards: [] } }, db: { batchGarbage: true } };
  const { out, calls } = await run(t, sc);
  assert.ok(out.includes('WARN check-batch parse failed - using per-card check'));
  assert.strictEqual(callsOf(calls, 'candidates-db').filter((c) => c.cmd === 'check').length, 1);
});

test('a page of only known candidates never calls the screener or the unlock', async (t) => {
  const { calls, queue } = await run(t, { pages: { 1: { cards: [card(101)] }, 2: { cards: [] } }, db: { candidates: { 101: { unlocked: 1 } } } });
  assert.strictEqual(callsOf(calls, 'ai-review').length, 0);
  assert.strictEqual(callsOf(calls, 'caterer-unlock').length, 0);
  assert.strictEqual(queue.candidates.length, 0);
});

test('a card without an id still goes through (id blank) without crashing the page', async (t) => {
  const { r, out } = await run(t, { pages: { 1: { cards: [Object.assign(card(1), { id: null })] }, 2: { cards: [] } } });
  assert.strictEqual(r.code, 0, out);
});

test('the session is saved only while authenticated (post-Phase1 save skipped on /login)', async (t) => {
  const sc = { pages: { 1: { cards: [card(111)] }, 2: { cards: [] } }, session: { cookieValid: true, loginFromGetUrlCall: 2 } };
  const { r, out, calls } = await run(t, sc);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN session NOT saved (post-Phase1) -- browser on /login (logged out); keeping prior good session file'));
  assert.ok(!browserCmds(calls).includes('state save'));
});

test('the session is not saved from the device-verification page either', async (t) => {
  const sc = { pages: { 1: { cards: [card(112)] }, 2: { cards: [] } }, session: { cookieValid: true, urlFromCall: { 2: 'https://recruiter.caterer.com/Account/SafeListLoginBlocked' } } };
  const { r, out, calls } = await run(t, sc);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN session NOT saved (post-Phase1) -- browser on the device-verification page'));
  assert.ok(!browserCmds(calls).includes('state save'));
});

test('session save: state file goes to the resolved session path; a timed out save only warns', async (t) => {
  const { r, out, calls, home } = await run(t, { pages: { 1: { cards: [card(121)] }, 2: { cards: [] } } });
  assert.strictEqual(r.code, 0);
  const saved = callsOf(calls, 'agent-browser').find((c) => c.cmd === 'state save');
  assert.ok(saved && saved.file.endsWith('caterer-session.json'), JSON.stringify(saved));
  assert.ok(fs.existsSync(saved.file));
  assert.ok(saved.file.startsWith(home), 'session path is inside the resourcer home');

  const t2 = await run(t, { pages: { 1: { cards: [card(122)] }, 2: { cards: [] } }, session: { cookieValid: true, saveHang: true } });
  assert.strictEqual(t2.r.code, 0);
  assert.ok(t2.out.includes('WARN session save timed out (post-Phase1) -- pipeline continues'));
  const t3 = await run(t, { pages: { 1: { cards: [card(123)] }, 2: { cards: [] } }, session: { cookieValid: true, saveFail: true } });
  assert.ok(t3.out.includes('WARN session save failed (post-Phase1)'));
});

test('lib/browser returning an object from getUrl is handled the same as a string', async (t) => {
  const { r, out } = await run(t, { pages: { 1: { cards: [], text: '0 candidates' } } }, [], { env: { P1_SHIM_GETURL_OBJECT: '1' } });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('Session OK'));
});

test('KEYWORDS, SEARCH_ID, PRIORITY, ACTIVE_WITHIN, REQUESTED_AT and DISTANCE flow into the queue file; keywords are trimmed', async (t) => {
  const { queue, calls } = await run(t, { pages: { 1: { cards: [card(131)] }, 2: { cards: [] } } },
    ['--keywords', ' sous ', '--search-id', 'S-42', '--priority', 'high', '--active-within', '1 week', '--requested-at', '2026-09-29T10:00:00.000Z', '--distance-miles', '25', '--candidate-count', '77']);
  assert.strictEqual(queue.keywords, 'sous');
  assert.strictEqual(queue.searchId, 'S-42');
  assert.strictEqual(queue.priority, 'high');
  assert.strictEqual(queue.activeWithin, '1 week');
  assert.strictEqual(queue.requestedAt, '2026-09-29T10:00:00.000Z');
  assert.strictEqual(queue.distance, 25);
  assert.strictEqual(callsOf(calls, 'ai-review').find((c) => c.mode === 'batch').distance, '25');
});

test('post-unlock title derivation, city order and queue fields when the unlock returns a postcode title', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(141, { snippet: '1. Alex Sample Kitchen Porter | Ilkley, LS29 8AB Unlock candidate' })] }, 2: { cards: [] } },
    unlock: { 141: { success: true, name: 'Alex Sample', firstName: 'Alex', lastName: 'Sample', email: 'a@example.invalid', phone: '', cvUrl: '', encId: '', auditId: '', jobTitle: 'LS29' } },
  };
  const { out, calls, queue } = await run(t, sc);
  assert.ok(out.includes("WARN post-unlock title 'LS29' unusable -> using 'Kitchen Porter' for AI suitability check"), out);
  const single = callsOf(calls, 'ai-review').find((c) => c.mode === 'single');
  assert.strictEqual(single.title, 'Kitchen Porter');
  assert.strictEqual(single.job, 'Chef');
  assert.strictEqual(single.name, 'Alex', 'the card first name is passed so the reviewer can redact it');
  assert.strictEqual(single.source, 'caterer');
  assert.ok(single.snippet.startsWith('1. Alex Sample Kitchen Porter'));
  assert.strictEqual(queue.candidates[0].currentTitle, 'Kitchen Porter');
  assert.strictEqual(queue.candidates[0].city, 'Leeds');
});

test('when the snippet gives no title either, the search job title is used', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(151, { snippet: '' })] }, 2: { cards: [] } },
    unlock: { 151: { success: true, name: 'A B', firstName: 'A', lastName: 'B', email: 'a@example.invalid', phone: '', cvUrl: '', encId: '', auditId: '', jobTitle: '' } },
  };
  const { calls, queue } = await run(t, sc);
  assert.strictEqual(callsOf(calls, 'ai-review').find((c) => c.mode === 'single').title, 'Chef');
  assert.strictEqual(queue.candidates[0].currentTitle, 'Chef');
});
