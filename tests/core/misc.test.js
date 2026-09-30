'use strict';
// caterer-session-utils, caterer-keepalive, caterer-fetch-results, fetch-with-timeout,
// pipeline-optimiser, migrate-reed-schema, plus byte-equality of the data files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const H = require('./helpers/home');

const home = H.makeHome('misc');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
require('./helpers/netguard');

const S = H.SCRIPTS;
const now = () => Date.now() / 1000;

// ---------------------------------------------------------------- caterer-session-utils
test.describe('caterer-session-utils', () => {
  const sessionFile = path.join(home, 'state', 'caterer-session.json');
  const write = (cookies) => H.writeJson(sessionFile, { cookies });
  const utils = () => {
    delete require.cache[require.resolve(path.join(S, 'caterer-session-utils.js'))];
    return require(path.join(S, 'caterer-session-utils.js'));
  };
  const c = (name, domain, expires) => ({ name, value: `${name}-val`, domain, ...(expires === undefined ? {} : { expires }) });
  test.beforeEach(() => fs.rmSync(sessionFile, { force: true }));

  test('exports the session path (under state/) and the base URL', () => {
    const u = utils();
    assert.equal(u.SESSION_PATH, sessionFile);
    assert.equal(u.BASE_CATERER, 'https://recruiter.caterer.com');
  });

  test('loadCookieHeader keeps Caterer cookies that have not expired', () => {
    write([
      c('.ASPXAUTH', '.recruiter.caterer.com', now() + 3600),
      c('sess', 'recruiter.caterer.com', -1),
      c('noexp', '.caterer.com'),
      c('old', '.caterer.com', now() - 10),
      c('other', '.example.com', now() + 3600),
      { name: 'nodomain', value: 'x' },
    ]);
    assert.equal(utils().loadCookieHeader(), '.ASPXAUTH=.ASPXAUTH-val; sess=sess-val; noexp=noexp-val');
  });

  test('loadCookieHeader errors: no file, all expired', () => {
    const u = utils();
    assert.throws(() => u.loadCookieHeader(), /No Caterer session file - run caterer-login first/);
    write([c('old', '.caterer.com', now() - 10)]);
    assert.throws(() => u.loadCookieHeader(), /All Caterer session cookies have expired - need fresh login/);
    write([]);
    assert.throws(() => u.loadCookieHeader(), /have expired/);
  });

  test('checkSessionHealth counts valid and expired cookies; a missing or corrupt file is invalid', () => {
    const u = utils();
    assert.deepEqual(u.checkSessionHealth(), { valid: false, validCount: 0, expiredCount: 0 });
    write([c('a', '.caterer.com', now() + 100), c('b', '.caterer.com', now() - 100), c('c', 'x.com', now() + 100)]);
    assert.deepEqual(u.checkSessionHealth(), { valid: true, validCount: 1, expiredCount: 1 });
    write([c('b', '.caterer.com', now() - 100)]);
    assert.deepEqual(u.checkSessionHealth(), { valid: false, validCount: 0, expiredCount: 1 });
    fs.writeFileSync(sessionFile, '{nope');
    assert.equal(u.checkSessionHealth().valid, false);
  });

  test('validateSession reports the auth cookie state', () => {
    const u = utils();
    assert.deepEqual(u.validateSession(), { valid: false, missing: ['session file'], warnings: ['Session file does not exist'] });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{nope');
    const corrupt = u.validateSession();
    assert.equal(corrupt.valid, false);
    assert.deepEqual(corrupt.missing, ['parseable session']);
    assert.match(corrupt.warnings[0], /^Session file corrupt: /);
    write([c('x', 'other.com', now() + 100)]);
    assert.deepEqual(u.validateSession(), { valid: false, missing: ['any cookies'], warnings: ['Session file contains no Caterer cookies'] });
    write([c('sess', '.caterer.com', now() + 100)]);
    let v = u.validateSession();
    assert.equal(v.valid, false);
    assert.deepEqual(v.missing, ['.ASPXAUTH']);
    assert.deepEqual(v.warnings, ['.ASPXAUTH cookie not found in session']);
    write([c('.ASPXAUTH', '.caterer.com', now() - 60), c('sess', '.caterer.com', now() + 100)]);
    v = u.validateSession();
    assert.equal(v.valid, false);
    assert.match(v.warnings[0], /^\.ASPXAUTH cookie found but EXPIRED \(\d{4}-\d{2}-\d{2}T/);
    write([c('.ASPXAUTH', '.caterer.com', now() + 600)]);
    v = u.validateSession();
    assert.equal(v.valid, true);
    assert.match(v.warnings[0], /^\.ASPXAUTH expires in (9|10) minutes - consider refreshing session$/);
    write([c('.ASPXAUTH', '.caterer.com', now() + 7200), c('b', '.caterer.com', now() + 7200)]);
    v = u.validateSession();
    assert.deepEqual({ valid: v.valid, missing: v.missing, warnings: v.warnings, validCookieCount: v.validCookieCount, totalCookieCount: v.totalCookieCount },
      { valid: true, missing: [], warnings: [], validCookieCount: 2, totalCookieCount: 2 });
  });
});

// ---------------------------------------------------------------- caterer-keepalive
test.describe('caterer-keepalive', () => {
  const sessionFile = path.join(home, 'state', 'caterer-session.json');
  const ka = () => {
    for (const k of Object.keys(require.cache)) if (k.startsWith(S)) delete require.cache[k];
    return require(path.join(S, 'caterer-keepalive.js'));
  };
  const validSession = () => H.writeJson(sessionFile, { cookies: [{ name: '.ASPXAUTH', value: 'v', domain: '.caterer.com', expires: now() + 3600 }] });
  test.beforeEach(() => fs.rmSync(sessionFile, { force: true }));

  test('no valid session: expired, exit 1, no request', async () => {
    let called = false;
    const r = await ka().run({ fetchImpl: async () => { called = true; } });
    assert.deepEqual(r, { out: 'expired\n', err: '', code: 1 });
    assert.equal(called, false);
  });

  test('a 200 from the search page means kept-alive (exit 0); the request carries the cookies and does not follow redirects', async () => {
    validSession();
    let seen;
    const r = await ka().run({ fetchImpl: async (url, opts, timeout) => { seen = { url, opts, timeout }; return { status: 200 }; } });
    assert.deepEqual(r, { out: 'kept-alive\n', err: '', code: 0 });
    assert.equal(seen.url, 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch');
    assert.equal(seen.opts.method, 'GET');
    assert.equal(seen.opts.redirect, 'manual');
    assert.equal(seen.opts.headers.Cookie, '.ASPXAUTH=v');
    assert.match(seen.opts.headers['User-Agent'], /^Mozilla\/5\.0/);
    assert.equal(seen.timeout, 15000);
  });

  test('a redirect means expired; any other status is unknown; both exit 1', async () => {
    validSession();
    for (const [status, out] of [[302, 'expired\n'], [301, 'expired\n'], [500, 'unknown\n'], [403, 'unknown\n']]) {
      assert.deepEqual(await ka().run({ fetchImpl: async () => ({ status }) }), { out, err: '', code: 1 }, String(status));
    }
  });

  test('a network error prints error and the message on stderr, exit 1', async () => {
    validSession();
    const r = await ka().run({ fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(r, { out: 'error\n', err: 'Network error: offline\n', code: 1 });
  });

  test('CLI: expired without a session (exit 1), --help (exit 0)', () => {
    let r = H.run('scripts/caterer-keepalive.js', [], { home });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'expired\n');
    r = H.run('scripts/caterer-keepalive.js', ['--help'], { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /kept-alive/);
  });
});

// ---------------------------------------------------------------- caterer-fetch-results
test.describe('caterer-fetch-results', () => {
  const fr = require(path.join(S, 'caterer-fetch-results.js'));
  const card = (id, { name = 'Fake Person', loc = 'Leeds, LS1 4AB', job = 'Sous Chef', unlocked = false, miles = '3.5' } = {}) => `
    <div id="candidate-header-bar-left-${id}" class="bar">
      <input id="candidate-unlock-state-${id}" value="${unlocked}" />
      <div class="identifier"><a href="/p?candidateId=${id}">${name}</a></div>
      <div class="candidate-identifier-summary">${job} |<span> ${loc}</span></div>
      | <span>${loc}</span> <b>${miles} miles</b>
    </div>`;
  const html = `<html>${card('101')}${card('102', { name: "Mary O'Neil", unlocked: true, miles: '12' })}<input id="candidate-unlock-state-103" value="false"/></html>`;

  test('parseCandidates extracts id, name, location, job title, unlock state and distance per card', () => {
    const cs = fr.parseCandidates(html);
    assert.deepEqual(cs.map(x => x.id), ['101', '102', '103']);
    assert.equal(cs[0].name, 'Fake Person');
    assert.equal(cs[0].cityPostcode, 'Leeds, LS1 4AB');
    assert.equal(cs[0].jobTitle, 'Sous Chef');
    assert.equal(cs[0].unlocked, false);
    assert.equal(cs[0].miles, '3.5');
    assert.equal(cs[1].name, "Mary O'Neil");
    assert.equal(cs[1].unlocked, true);
    assert.equal(cs[1].miles, '12');
    assert.deepEqual(cs[2], { id: '103', error: 'section not found' });
  });

  test('decodeHtml handles the entities the page uses', () => {
    assert.equal(fr.decodeHtml('a &amp; b &lt;c&gt;&nbsp;d&#39;e'), 'a & b <c> de');
  });

  test('no cards gives an empty list', () => {
    assert.deepEqual(fr.parseCandidates('<html>nothing</html>'), []);
  });

  test('fetchResults sends the cookies and parses the body; HTTP errors carry the status', async () => {
    let seen;
    const ok = async (url, opts, timeout) => { seen = { url, opts, timeout }; return { ok: true, status: 200, text: async () => html }; };
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const cs = await fr.fetchResults({ fetchImpl: ok, cookieHeader: 'a=b' });
      assert.equal(cs.length, 3);
      assert.equal(seen.url, fr.DEFAULT_URL);
      assert.equal(seen.opts.headers.Cookie, 'a=b');
      assert.equal(seen.opts.redirect, 'follow');
      assert.equal(seen.timeout, 30000);
      await fr.fetchResults({ fetchImpl: ok, cookieHeader: 'a=b', url: 'https://recruiter.caterer.com/x' });
      assert.equal(seen.url, 'https://recruiter.caterer.com/x');
      await assert.rejects(fr.fetchResults({ fetchImpl: async () => ({ ok: false, status: 503 }), cookieHeader: 'a=b' }), (e) => e.httpStatus === 503 && e.message === 'HTTP 503');
    } finally {
      process.stderr.write = errWrite;
    }
  });

  test('the default search URL is the legacy diagnostic search and no candidate ids are baked in', () => {
    assert.match(fr.DEFAULT_URL, /^https:\/\/recruiter\.caterer\.com\/CandidateSearchWebMvc\/CandidateSearch\/Results\?FreeText=Kitchen\+Assistant\+DBS&/);
    assert.match(fr.DEFAULT_URL, /&PageSize=50$/);
    assert.ok(!/\b\d{8,9}\b/.test(fs.readFileSync(path.join(S, 'caterer-fetch-results.js'), 'utf8').replace(fr.DEFAULT_URL, '')), 'no numeric candidate ids in the source');
  });

  test('CLI --help exits 0', () => {
    assert.equal(H.run('scripts/caterer-fetch-results.js', ['--help'], { home }).status, 0);
  });
});

// ---------------------------------------------------------------- fetch-with-timeout
test.describe('fetch-with-timeout', () => {
  const { fetchWithTimeout } = require(path.join(S, 'fetch-with-timeout.js'));
  let server;
  let base;
  test.before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow') return setTimeout(() => { res.end('late'); }, 1500);
      res.end('hello');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  test.after(() => { server.closeAllConnections(); server.close(); });

  test('returns the response when it arrives in time', async () => {
    const res = await fetchWithTimeout(`${base}/fast`, {}, 2000);
    assert.equal(await res.text(), 'hello');
  });

  test('a slow response rejects with FETCH_TIMEOUT naming the url and the limit', async () => {
    await assert.rejects(fetchWithTimeout(`${base}/slow`, {}, 100), (e) => e.code === 'FETCH_TIMEOUT' && e.message === `Fetch timeout after 100ms for ${base}/slow`);
  });

  test('a caller abort is passed through, not reported as a timeout', async () => {
    const ctl = new AbortController();
    const p = fetchWithTimeout(`${base}/slow`, { signal: ctl.signal }, 5000);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(p, (e) => e.code !== 'FETCH_TIMEOUT' && /abort/i.test(e.name + e.message));
  });

  test('the network guard blocks anything but loopback', async () => {
    await assert.rejects(fetchWithTimeout('https://example.com/', {}, 1000), (e) => e.code === 'NETGUARD');
  });
});

// ---------------------------------------------------------------- pipeline-optimiser
test.describe('pipeline-optimiser', () => {
  const opt = require(path.join(S, 'pipeline-optimiser.js'));
  const EM = String.fromCharCode(0x2014);
  const perfLog = path.join(home, 'logs', 'pipeline-performance.jsonl');
  const errLog = path.join(home, 'logs', 'errors.jsonl');
  const results = (over = {}) => ({
    runId: 'r1', date: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 20, candidateCount: 40, total: 10, downloaded: 10,
    new: 8, duplicates: 2, skipped: 30, errors: 0, creditsRemaining: 40000,
    timing: {
      totalWallClockSecs: 300, sessionValidationSecs: 10, phase1ScrapingSecs: 200, handoffSecs: 5, phase2TotalSecs: 100,
      phase2DownloadStepSecs: 60, phase2PushStepSecs: 40, avgTimePerPageSecs: 20, avgTimePerBrowserRoundtripSecs: 3,
      cvDownload: { avgSecs: 2, minSecs: 1, maxSecs: 4 }, zohoPush: { avgSecs: 1, minSecs: 1, maxSecs: 2 },
    },
    phase1: { candidateCount: 40, pagesScraped: 3, browserRoundtrips: 12, approved: 10, skippedDb: 20, skippedReview: 10, errors: 0, sessionRefreshed: false },
    ...over,
  });
  // A history entry as the performance log writes it (flat) ...
  const flat = (i, over = {}) => ({
    ts: `2026-09-2${i}T10:00:00.000Z`, jobTitle: 'Chef', location: 'LS1', totalWallClockSecs: 300, phase1ScrapingSecs: 200, phase2TotalSecs: 100,
    avgCvDownloadSecs: 2, avgZohoPushSecs: 1, avgBrowserRoundtripSecs: 3, errorsP1: 0, errorsP2: 0, sessionRefreshed: false, errorContexts: [], ...over,
  });
  // ... and with the nested timing object the regression code looks for (see the quirk test below).
  const hist = (n, over = {}) => Array.from({ length: n }, (_, i) => {
    const e = flat(i, over);
    return { ...e, timing: { totalWallClockSecs: e.totalWallClockSecs, phase1ScrapingSecs: e.phase1ScrapingSecs, phase2TotalSecs: e.phase2TotalSecs, avgCvDownloadSecs: e.avgCvDownloadSecs, avgZohoPushSecs: e.avgZohoPushSecs, avgBrowserRoundtripSecs: e.avgBrowserRoundtripSecs } };
  });
  const run = (r, h, errs = []) => opt.analyse(opt.extractMetrics(r), h, errs);

  test('fmtSecs', () => {
    assert.equal(opt.fmtSecs(null), EM);
    assert.equal(opt.fmtSecs(45), '45s');
    assert.equal(opt.fmtSecs(75), '1m15s');
    assert.equal(opt.fmtSecs(60), '1m0s');
  });

  test('extractMetrics maps the results file (with fallbacks) into the metric shape', () => {
    const m = opt.extractMetrics(results());
    assert.equal(m.runId, 'r1');
    assert.equal(m.timing.totalWallClockSecs, 300);
    assert.equal(m.timing.avgBrowserRoundtripSecs, 3);
    assert.equal(m.timing.avgCvDownloadSecs, 2);
    assert.equal(m.phase1.catererPool, 40);
    assert.equal(m.phase2.newToZoho, 8);
    assert.equal(m.creditsRemaining, 40000);
    const e = opt.extractMetrics({});
    assert.equal(e.runId, null);
    assert.equal(e.jobTitle, '');
    assert.equal(e.phase1.unlockErrors, 0);
    assert.equal(e.phase2.errors, 0);
    assert.equal(e.timing.totalWallClockSecs, null);
  });

  test('a first run is NOMINAL and says it is a baseline', () => {
    const a = run(results(), []);
    assert.equal(a.verdict, 'NOMINAL');
    assert.deepEqual(a.regressions, []);
    assert.ok(a.observations.some(o => o.startsWith(`Baseline run ${EM} accumulating history`)));
    assert.ok(a.observations.some(o => o.includes('Total: 5m0s (validate 10s')));
  });

  test('regressions against the territory average: ATTENTION from 35 percent, DEGRADED from 65 percent', () => {
    const h = hist(3);
    let a = run(results({ timing: { ...results().timing, totalWallClockSecs: 420 } }), h);
    assert.equal(a.verdict, 'ATTENTION');
    let r = a.regressions.find(x => x.metric === 'Total wall-clock');
    assert.equal(r.severity, 'ATTENTION');
    assert.equal(r.pctOver, 40);
    assert.equal(r.baseline, '5m0s territory avg (3 runs)');
    a = run(results({ timing: { ...results().timing, totalWallClockSecs: 510 } }), h);
    assert.equal(a.verdict, 'DEGRADED');
    r = a.regressions.find(x => x.metric === 'Total wall-clock');
    assert.equal(r.severity, 'DEGRADED');
    assert.equal(r.pctOver, 70);
  });

  test('legacy quirk kept: history read from the flat performance-log format never triggers a timing regression', () => {
    // buildLogEntry() writes flat fields but checkRegression() looks under timing.*, so the
    // comparison sees no baseline. Fixing it means reading h[lastPathSegment]; see docs/parity/core.md.
    const slow = results({ timing: { ...results().timing, totalWallClockSecs: 900 } });
    const a = run(slow, Array.from({ length: 6 }, (_, i) => flat(i)));
    assert.equal(a.regressions.filter(r => r.baseline && r.baseline.includes('avg')).length, 0);
    assert.equal(a.verdict, 'NOMINAL');
  });

  test('a big improvement is an observation, not a regression', () => {
    const a = run(results({ timing: { ...results().timing, totalWallClockSecs: 180 } }), hist(3));
    assert.ok(a.observations.some(o => o.includes('Total wall-clock improved: 3m0s vs territory avg 5m0s (-40%)')));
    assert.ok(!a.regressions.some(x => x.metric === 'Total wall-clock'));
  });

  test('the global baseline applies when the territory has fewer than 2 runs', () => {
    const h = hist(4, { location: 'M1' });
    const a = run(results({ timing: { ...results().timing, totalWallClockSecs: 450 } }), h);
    const r = a.regressions.find(x => x.metric === 'Total wall-clock');
    assert.equal(r.baseline, '5m0s global avg (4 runs)');
    assert.ok(a.observations.some(o => o.startsWith('First run for Chef | LS1')));
  });

  test('phase 1 unlock errors and phase 2 push errors are ATTENTION', () => {
    const a = run(results({ errors: 2, phase1: { ...results().phase1, errors: 1 } }), []);
    assert.equal(a.verdict, 'ATTENTION');
    assert.deepEqual(a.regressions.map(r => r.metric), ['Phase 1 unlock errors', 'Phase 2 Zoho push errors']);
    const b = run(results(), [], [{ context: 'zoho_push' }, { context: 'zoho_push' }, { context: 'cv_download' }, {}]);
    assert.deepEqual(b.errorSummary, [
      { context: 'zoho_push', label: 'Zoho push', count: 2 }, { context: 'cv_download', label: 'CV download', count: 1 }, { context: 'unknown', label: 'unknown', count: 1 },
    ]);
  });

  test('zero-yield guard: reviewed candidates with no verdict at all is DEGRADED and points at the gateway, not the old CLI', () => {
    const a = run(results({ phase1: { candidateCount: 30, approved: 0, skippedReview: 0, skippedDb: 5, errors: 0 } }), []);
    assert.equal(a.verdict, 'DEGRADED');
    const r = a.regressions.find(x => x.metric === 'AI screening produced no verdicts');
    assert.equal(r.current, '25 candidate(s) reviewed, 0 approved and 0 rejected');
    const alert = a.observations.find(o => o.startsWith('ALERT:'));
    assert.ok(alert.includes('screening is likely down'));
    assert.ok(alert.includes('AI Gateway key or credits'));
    assert.ok(!new RegExp('open' + 'claw', 'i').test(alert));
    const fine = run(results({ phase1: { candidateCount: 30, approved: 0, skippedReview: 4, skippedDb: 5, errors: 0 } }), []);
    assert.ok(!fine.regressions.some(x => x.metric === 'AI screening produced no verdicts'));
  });

  test('bottleneck: the slowest phase when it takes 40 percent or more', () => {
    const a = run(results({ timing: { ...results().timing, sessionValidationSecs: 10, phase1ScrapingSecs: 800, phase2DownloadStepSecs: 100, phase2PushStepSecs: 100, handoffSecs: 5 } }), []);
    assert.deepEqual(a.bottleneck, { phase: 'Phase 1 scraping', secs: 800, pctOfTotal: 79 });
    const b = run(results({ timing: { sessionValidationSecs: 10, phase1ScrapingSecs: 10, phase2DownloadStepSecs: 10, phase2PushStepSecs: 10, handoffSecs: 10 } }), []);
    assert.equal(b.bottleneck, null);
  });

  test('reliability: a clean streak, a regression after a clean history, and disappearing error types', () => {
    const clean = hist(6);
    const a = run(results(), clean);
    assert.ok(a.observations.some(o => o.startsWith('\u{2705} Reliability streak: 7 consecutive error-free runs (100% error-free across last 6 runs)')));
    const b = run(results({ errors: 1 }), clean);
    assert.ok(b.regressions.some(r => r.metric === 'Reliability regression' && r.baseline === '100% error-free over last 6 runs'));
    const withErr = hist(6, { errorContexts: ['zoho_push'] });
    const c = run(results(), withErr);
    assert.ok(c.observations.some(o => o.includes('Zoho push failures') && o.includes('absent this run')));
    const d = run(results(), clean, [{ context: 'session' }]);
    assert.ok(d.observations.some(o => o.includes('New error type this run: session')));
  });

  test('CLI: prints the analysis JSON, appends exactly one performance line, and reads this run\'s errors', () => {
    fs.rmSync(perfLog, { force: true });
    fs.mkdirSync(path.dirname(errLog), { recursive: true });
    const t = (m) => new Date(Date.now() - m * 60000).toISOString();
    fs.writeFileSync(errLog, [
      { ts: t(5), context: 'zoho_push' }, { ts: t(4), context: 'zoho_push' }, { ts: '2020-01-01T00:00:00.000Z', context: 'old' },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const file = path.join(home, 'phase2-results.json');
    fs.writeFileSync(file, String.fromCharCode(0xFEFF) + JSON.stringify(results({ requestedAt: t(30), completedAt: t(0) })));
    const r = H.run('scripts/pipeline-optimiser.js', [file], { home });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['metrics', 'regressions', 'errorSummary', 'bottleneck', 'observations', 'verdict']);
    assert.deepEqual(out.errorSummary, [{ context: 'zoho_push', label: 'Zoho push', count: 2 }]);
    const lines = fs.readFileSync(perfLog, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.jobTitle, 'Chef');
    assert.equal(entry.totalWallClockSecs, 300);
    assert.equal(entry.approvedP1, 10);
    assert.deepEqual(entry.errorContexts, ['zoho_push']);
    H.run('scripts/pipeline-optimiser.js', [file], { home });
    assert.equal(fs.readFileSync(perfLog, 'utf8').split('\n').filter(Boolean).length, 2);
    assert.ok(!fs.existsSync(path.join(home, 'MEMORY.md')) && !fs.existsSync(path.join(home, 'memory')), 'nothing but the performance log is written');
  });

  test('CLI exit codes: no argument and a missing file exit 1, --help exits 0', () => {
    assert.equal(H.run('scripts/pipeline-optimiser.js', [], { home }).status, 1);
    const r = H.run('scripts/pipeline-optimiser.js', [path.join(home, 'nope.json')], { home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /File not found:/);
    assert.equal(H.run('scripts/pipeline-optimiser.js', ['--help'], { home }).status, 0);
  });
});

// ---------------------------------------------------------------- migrate-reed-schema
test.describe('migrate-reed-schema', () => {
  const { PRE_REED_CANDIDATES } = require('./helpers/schema');
  const mk = () => {
    const h = H.makeHome('migrate');
    const db = new (H.loadSqlite())(path.join(h, 'candidates.db'));
    db.exec(PRE_REED_CANDIDATES);
    db.prepare("INSERT INTO candidates (caterer_id, source, role, location, pulled_date, unlocked, zoho_id) VALUES (1, NULL, 'Chef', 'LS1', '2026-01-01', 1, 'Z1'), (2, 'caterer', NULL, NULL, NULL, 0, NULL)").run();
    db.prepare("INSERT INTO territory_searches (job_title, location, distance) VALUES ('Chef', 'LS1', 20)").run();
    db.close();
    return h;
  };

  test('migrates the candidates table, adds sources and the Reed tables, keeps every row, backs up first', () => {
    const h = mk();
    const r = H.run('scripts/migrate-reed-schema.js', [], { home: h });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Candidates before migration: 2/);
    assert.ok(r.stdout.includes('Row count verified: 2 rows \u{2713}'));
    assert.match(r.stdout, /=== Migration Complete ===/);
    assert.ok(fs.existsSync(path.join(h, 'candidates.db.bak-reed-migration')));
    const db = new (H.loadSqlite())(path.join(h, 'candidates.db'), { readonly: true });
    assert.ok(db.prepare('PRAGMA table_info(candidates)').all().some(c => c.name === 'reed_id'));
    const rows = db.prepare('SELECT id, caterer_id, reed_id, source, role, unlocked, zoho_id FROM candidates ORDER BY caterer_id').all();
    assert.deepEqual(rows, [
      { id: 1, caterer_id: 1, reed_id: null, source: 'caterer', role: 'Chef', unlocked: 1, zoho_id: 'Z1' },
      { id: 2, caterer_id: 2, reed_id: null, source: 'caterer', role: null, unlocked: 0, zoho_id: null },
    ]);
    assert.equal(db.prepare("SELECT sources FROM territory_searches").get().sources, 'caterer');
    for (const t of ['reed_daily_usage', 'reed_location_cache']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    assert.throws(() => db.prepare('SELECT candidates_old FROM candidates_old').get(), /no such table/);
    db.close();
    const backup = new (H.loadSqlite())(path.join(h, 'candidates.db.bak-reed-migration'), { readonly: true });
    assert.ok(!backup.prepare('PRAGMA table_info(candidates)').all().some(c => c.name === 'reed_id'), 'the backup is the pre-migration file');
    backup.close();
  });

  test('is idempotent: a second run skips the table migration', () => {
    const h = mk();
    H.run('scripts/migrate-reed-schema.js', [], { home: h });
    const r = H.run('scripts/migrate-reed-schema.js', [], { home: h });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Migration already done \(reed_id column exists\)/);
    assert.match(r.stdout, /All done\. Candidates table has 2 rows\./);
  });

  test('a missing database exits 1; --help exits 0', () => {
    const h = H.makeHome('migrate-none');
    const r = H.run('scripts/migrate-reed-schema.js', [], { home: h });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DB not found at: /);
    assert.equal(H.run('scripts/migrate-reed-schema.js', ['--help'], { home: h }).status, 0);
  });
});

// ---------------------------------------------------------------- data files
test.describe('data files are copied byte for byte', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  test('scripts/extract-js.b64 (read by the phase 1 port) is unchanged and still a valid JavaScript expression', () => {
    const f = path.join(H.RES, 'scripts', 'extract-js.b64');
    assert.equal(sha(f), '5506981c7038a164ef321ce385d70e6cc099a767e5e54251d7fe0e0790187e24');
    const src = Buffer.from(fs.readFileSync(f, 'utf8'), 'base64').toString('utf8');
    assert.doesNotThrow(() => new vm.Script(src));
    assert.ok(!fs.readFileSync(f, 'utf8').includes('\n'), 'a single line, no terminator');
  });
  test('config/postcode-cities.json and config/territory-defaults.json are unchanged', () => {
    assert.equal(sha(path.join(H.RES, 'config', 'postcode-cities.json')), '94471450132de16f25d5dda2a8fdb3fb66101972e3c34c00914d82b1601e83e0');
    assert.equal(sha(path.join(H.RES, 'config', 'territory-defaults.json')), 'c3d2065a1b8dbd5bc90f629d071d7ddd0b7aacc87f18721001a58484576b4d47');
  });
});
