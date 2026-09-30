'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);

async function run(t, scenario, args, opts) {
  const home = h.makeHome(scenario, opts);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, args || h.baseArgs(), opts);
  return { home, r, out: r.stdout, calls: r.calls };
}

const okPages = { pages: { 1: { cards: [card(1)] }, 2: { cards: [] } }, db: { candidates: { 1: { unlocked: 1 } } } };
const noSideEffects = (home) => {
  assert.deepStrictEqual(h.listRuns(home), [], 'no status file created');
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'downloads')), [], 'no queue file created');
};

// ---------------------------------------------------------------- exit 7 / 5 / 6 / 4

test('exit 7: params file malformed or missing', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, '{"RESULTS_URL": ');
  const r = await h.runPhase1(home, ['--params-file', bad]);
  assert.strictEqual(r.code, 7);
  assert.ok(r.stdout.includes('PARAMS_FILE_ERROR:'));
  const r2 = await h.runPhase1(home, ['--params-file', path.join(home, 'nope.json')]);
  assert.strictEqual(r2.code, 7);
  noSideEffects(home);
});

test('exit 5: each missing mandatory parameter and an invalid SOURCES', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const full = ['--results-url', h.RESULTS_URL, '--job-title', 'Chef', '--location', 'LS29'];
  for (const [drop, msg] of [['--results-url', 'RESULTS_URL'], ['--job-title', 'JOB_TITLE'], ['--location', 'LOCATION']]) {
    const args = [];
    for (let i = 0; i < full.length; i += 2) if (full[i] !== drop) args.push(full[i], full[i + 1]);
    const r = await h.runPhase1(home, args);
    assert.strictEqual(r.code, 5, drop);
    assert.ok(r.stdout.includes(`MISSING_PARAM: ${msg} is required.`));
  }
  const r = await h.runPhase1(home, full.concat(['--sources', 'nope']));
  assert.strictEqual(r.code, 5);
  assert.ok(r.stdout.includes("INVALID_SOURCES: 'nope' is not one of caterer|reed|both"));
  noSideEffects(home);
  assert.deepStrictEqual(h.readCalls(home), [], 'nothing external was touched');
});

test('exit 6: a URL with %26 in a parameter value', async (t) => {
  const { home, r, out } = await run(t, okPages, ['--results-url', 'https://recruiter.caterer.com/R?CurrentLocation=CW4%26SearchString=Sous+Chef%26Distance=30', '--job-title', 'Sous Chef', '--location', 'CW4']);
  assert.strictEqual(r.code, 6);
  assert.ok(out.includes('BAD_URL_ENCODING: RESULTS_URL has a parameter value containing %26 (URL-encoded &).'));
  assert.ok(out.includes('URL: https://recruiter.caterer.com/R?CurrentLocation=CW4%26SearchString=Sous+Chef%26Distance=30'));
  noSideEffects(home);
  assert.deepStrictEqual(h.readCalls(home), []);
});

test('exit 4: LOCATION differs from the URL CurrentLocation; a case difference does not', async (t) => {
  const { home, r, out } = await run(t, okPages, h.baseArgs().map((a) => (a === 'LS29' ? 'LS30' : a)));
  assert.strictEqual(r.code, 4);
  assert.ok(out.includes("TERRITORY_MISMATCH: LOCATION parameter is 'LS30' but RESULTS_URL has CurrentLocation='LS29'"));
  assert.ok(out.includes('Refuse to scrape the wrong territory.'));
  noSideEffects(home);
  assert.deepStrictEqual(h.readCalls(home), []);

  const ok = await run(t, okPages, h.baseArgs().map((a) => (a === 'LS29' ? 'ls29' : a)));
  assert.strictEqual(ok.r.code, 0, ok.out);
});

test('params file mode end to end (values from the file, exit 0)', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const f = path.join(home, 'runs', 'params-x.json');
  fs.writeFileSync(f, JSON.stringify({ RESULTS_URL: h.RESULTS_URL, JOB_TITLE: 'Chef', LOCATION: 'LS29', CV_LIMIT: 12, SOURCES: 'caterer', PRIORITY: 'high', REQUESTED_AT: '2026-09-29T09:00:00.000Z' }));
  const r = await h.runPhase1(home, ['--params-file', f]);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes(`PARAMS_FILE_LOADED: ${f}`));
  const q = h.queueOf(home);
  assert.strictEqual(q.cvLimit, 12);
  assert.strictEqual(q.priority, 'high');
  assert.strictEqual(q.requestedAt, '2026-09-29T09:00:00.000Z');
});

test('--help exits 0 and prints the usage; an unknown flag exits 5', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const a = await h.runPhase1(home, ['--help']);
  assert.strictEqual(a.code, 0);
  assert.ok(a.stdout.includes('Usage: node scripts/phase1.js'));
  assert.ok(a.stdout.includes('Exit codes: 0 ok'));
  const b = await h.runPhase1(home, ['--wat']);
  assert.strictEqual(b.code, 5);
});

// ---------------------------------------------------------------- exit 3 (lock) and bridges

test('exit 3: another pipeline is active (run-lock exit 2)', async (t) => {
  const { home, r, out, calls } = await run(t, Object.assign({ lock: { exit: 2 } }, okPages));
  assert.strictEqual(r.code, 3);
  assert.ok(out.includes('PIPELINE_BLOCKED: Another pipeline is already active. Exiting to avoid concurrency issues.'));
  assert.ok(out.includes('Lock detail:') && out.includes('phase1-other'));
  assert.deepStrictEqual(callsOf(calls, 'run-lock')[0].args, ['--global']);
  assert.strictEqual(callsOf(calls, 'caterer-get-credits').length, 0, 'blocked before the session check');
  noSideEffects(home);
});

test('a broken run-lock (any exit other than 2) does not block the run, exactly like the legacy check', async (t) => {
  const { r, out } = await run(t, Object.assign({ lock: { crash: true } }, okPages));
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN run-lock check did not complete cleanly (exit 1) - continuing'));
  assert.ok(out.includes('Global pipeline lock: clear'));
});

test('a hung run-lock is killed by its timeout and the run continues', async (t) => {
  const { r, out } = await run(t, Object.assign({ lock: { hang: true } }, okPages), undefined, { env: { PHASE1_LOCK_TIMEOUT_SEC: '0.5', P1_HANG_MS: '20000' } });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN run-lock check did not complete cleanly (exit none, timeout) - continuing'));
});

test('bridge files: own bridge is skipped and later removed, foreign phase1_initializing bridges become phase1_taking_over', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const own = path.join(home, 'runs', 'phase1-2026-09-29-2100.json');
  const foreign = path.join(home, 'runs', 'phase1-2026-09-29-2050.json');
  const stale = path.join(home, 'runs', 'phase1-2026-09-01-0900.json');
  const bridge = (id) => JSON.stringify({ id, status: 'phase1_initializing', jobTitle: 'Chef', location: 'B1', distance: 20, pool: null, startedAt: '2026-09-29T20:00:00.000Z', page: 0, approved: 0, skippedDb: null, errors: null, sources: 'caterer', updatedAt: '2026-09-29T20:00:00.000Z' });
  fs.writeFileSync(own, bridge('phase1-2026-09-29-2100'));
  fs.writeFileSync(foreign, bridge('phase1-2026-09-29-2050'));
  fs.writeFileSync(stale, JSON.stringify({ id: 'x', status: 'complete' }));
  fs.writeFileSync(path.join(home, 'runs', 'phase1-garbage.json'), '{nope');
  const r = await h.runPhase1(home, h.baseArgs(['--init-status-file', own]));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('Bridge cleared: phase1-2026-09-29-2050.json -> phase1_taking_over'));
  assert.ok(!r.stdout.includes('Bridge cleared: phase1-2026-09-29-2100.json'), 'our own bridge is never flipped');
  assert.ok(r.stdout.includes('WARN failed to clear bridge phase1-garbage.json'));
  assert.ok(r.stdout.includes(`Bridge file removed (we own the run now): ${own}`));
  assert.ok(!fs.existsSync(own), 'own bridge deleted once the status file exists');
  const f = h.readJson(foreign);
  assert.strictEqual(f.status, 'phase1_taking_over');
  assert.strictEqual(f.updatedAt, '2026-09-29T20:00:00.000Z', 'updatedAt is kept so run-lock ages the leftover as before');
  assert.strictEqual(f.jobTitle, 'Chef', 'other fields are preserved');
  assert.strictEqual(h.readJson(stale).status, 'complete');
  assert.deepStrictEqual(callsOf(r.calls, 'run-lock')[0].args, ['--global', '--skip-file=phase1-2026-09-29-2100.json']);
  assert.ok(h.statusOf(home), 'our own status file exists');
});

// ---------------------------------------------------------------- exit 2 (session)

test('exit 2: stale session, one auto re-login that fails', async (t) => {
  const { home, r, out, calls } = await run(t, { session: { cookieValid: false }, login: { heals: false }, pages: okPages.pages });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('SESSION_STALE detected. Attempting one automatic Caterer re-login...'));
  assert.ok(out.includes('SESSION_STALE: Caterer session expired or invalid after retry. Re-login required.'));
  assert.ok(out.includes('Raw output: '));
  assert.strictEqual(callsOf(calls, 'caterer-login').length, 1);
  assert.deepStrictEqual(callsOf(calls, 'caterer-login')[0].opts, { allowRelogin: true });
  assert.strictEqual(callsOf(calls, 'caterer-get-credits').length, 2);
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 0, 'no scraping after a failed session check');
  noSideEffects(home);
});

test('stale credits check healed by the one auto re-login: the run proceeds', async (t) => {
  const { r, out, calls } = await run(t, { session: { cookieValid: false }, login: { heals: true }, pages: okPages.pages, db: okPages.db });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('SESSION_STALE detected. Attempting one automatic Caterer re-login...'));
  assert.ok(out.includes('Auto-login result: state=ok ok=true'));
  assert.ok(out.includes('Session OK - credits: 62185'));
  assert.strictEqual(callsOf(calls, 'caterer-login').length, 1);
});

test('browser on /login despite valid cookies: one re-login, exit 2 if it does not help', async (t) => {
  const { home, r, out, calls } = await run(t, { session: { cookieValid: true, browserOnLogin: true }, login: { heals: false }, pages: okPages.pages });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('SESSION_STALE: browser on /login despite valid cookies -- attempting one automatic Caterer re-login...'));
  assert.ok(out.includes('SESSION_STALE: still on /login after auto re-login -- re-login required.'));
  assert.strictEqual(callsOf(calls, 'caterer-login').length, 1);
  noSideEffects(home);
});

test('browser on /login healed by the re-login: credits are refreshed and the run proceeds', async (t) => {
  const { r, out, calls } = await run(t, { session: { cookieValid: true, browserOnLogin: true }, login: { heals: true }, pages: okPages.pages, db: okPages.db });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('Auto re-login succeeded -- browser now on: https://recruiter.caterer.com/'));
  assert.strictEqual(callsOf(calls, 'caterer-get-credits').length, 3, 'initial check, refresh after the re-login, final --update-db');
});

test('an empty browser URL after the re-login counts as still stale', async (t) => {
  const { r, out } = await run(t, { session: { cookieValid: true, loginFromGetUrlCall: 1, urlEmptyFromCall: 2 }, login: { heals: false }, pages: okPages.pages });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('still on /login after auto re-login'));
});

test('a login module that throws is reported and the stale session still exits 2', async (t) => {
  const { r, out } = await run(t, { session: { cookieValid: false }, login: { throws: true }, pages: okPages.pages });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('WARN auto-login attempt threw: login exploded'));
});

test('a missing login module is reported the same way', async (t) => {
  const { r, out } = await run(t, { session: { cookieValid: false }, pages: okPages.pages }, undefined, { noLoginModule: true });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('WARN auto-login attempt threw:'));
});

test('a hanging login is abandoned after its timeout', async (t) => {
  const { r, out } = await run(t, { session: { cookieValid: false }, login: { hang: true }, pages: okPages.pages }, undefined, { env: { PHASE1_LOGIN_TIMEOUT_SEC: '0.4' } });
  assert.strictEqual(r.code, 2);
  assert.ok(out.includes('WARN auto-login attempt threw: auto-login timed out after 0s'), out);
});

test('a hung browser get-url counts as "not on /login" for the first check (legacy timeout rule)', async (t) => {
  const { r, out } = await run(t, { session: { cookieValid: true, urlHang: true }, pages: okPages.pages, db: okPages.db });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('TIMEOUT: browser auth-check exceeded 20s') || out.includes('Session OK'));
});

// ---------------------------------------------------------------- exit 1 (fatal, deliberate)

test('exit 1 before any side effect when the extract script data file is missing', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  fs.unlinkSync(path.join(home, 'scripts', 'extract-js.b64'));
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 1);
  assert.ok(r.stdout.includes('EXTRACT_JS_MISSING:'));
  noSideEffects(home);
  assert.deepStrictEqual(h.readCalls(home), []);
});

test('exit 1 when the browser library cannot be loaded', async (t) => {
  const { home, r, out } = await run(t, okPages, undefined, { noBrowserLib: true });
  assert.strictEqual(r.code, 1);
  assert.ok(out.includes('FATAL browser library unavailable:'));
  noSideEffects(home);
});

test('exit 5: a RESULTS_URL outside caterer.com is refused before the signed-in browser is used', async (t) => {
  const home = h.makeHome(okPages);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, ['--results-url', 'https://evil.example/Results?FreeText=Chef&CurrentLocation=LS29', '--job-title', 'Chef', '--location', 'LS29', '--sources', 'caterer']);
  assert.strictEqual(r.code, 5, r.stdout);
  assert.ok(r.stdout.includes('BAD_RESULTS_URL'));
  assert.strictEqual(callsOf(r.calls, 'agent-browser').length, 0);
  assert.strictEqual(h.statusOf(home), null);
});
