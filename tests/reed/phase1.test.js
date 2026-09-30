'use strict';

// reed-phase1 end to end against the fake Reed world and a fake screening CLI: parity flow, D4 (no burn on outage), auth chain.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn } = require('child_process');
const { withWorld, validSession, writeCreds, isWin } = require('./helpers/world');
const { dep } = require('./helpers/mirror');
const { makeCard } = require('./helpers/fake-reed');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];

function dbRows(m) {
  const D = dep('better-sqlite3');
  if (!m.exists('candidates.db')) return [];
  const db = new D(m.p('candidates.db'), { readonly: true });
  try { return db.prepare('SELECT * FROM candidates ORDER BY reed_id').all(); } finally { db.close(); }
}
const queue = (m, id = 't1') => m.readJson(`downloads/reed-approved-queue-${id}.json`);
const summary = (stdout) => { const l = stdout.split('\n').find((x) => x.startsWith('REED_PHASE1_SUMMARY:')); return l ? JSON.parse(l.slice('REED_PHASE1_SUMMARY:'.length)) : null; };
const aiLog = (m) => m.readLines('ai-log.jsonl');
function filesContaining(dir, needle) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = require('path').join(dir, e.name);
    if (e.isDirectory()) { hits.push(...filesContaining(p, needle)); continue; }
    if (e.name === 'ai-state.json' || e.name.endsWith('.db') || e.name.includes('.db-')) continue;
    try { if (fs.readFileSync(p, 'latin1').includes(needle)) hits.push(p); } catch { /* unreadable */ }
  }
  return hits;
}
const alerts = (m) => m.readLines('outbox/alerts.jsonl');

test('happy path: 30 cards over 2 pages, screened with CV text, approvals queued in downloads/, every screened card marked seen, no names logged', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002,9013' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const q = queue(m);
  assert.strictEqual(q.source, 'reed');
  assert.strictEqual(q.candidates.length, 28);
  assert.strictEqual(q.phase1Stats.approved, 28);
  assert.strictEqual(q.phase1Stats.rejected, 2);
  assert.strictEqual(q.phase1Stats.pool, 30);
  assert.strictEqual(q.phase1Stats.pagesScraped, 2);
  assert.strictEqual(q.phase1Stats.errors, 0);
  assert.strictEqual(q.screeningModel, 'fake/model-1');
  assert.strictEqual(q.candidateCount, 30);
  assert.strictEqual(q.jobTitle, 'Chef');
  assert.strictEqual(q.location, 'LS1');
  assert.strictEqual(q.distance, 20);
  assert.strictEqual(q.activeWithin, 'month');
  const c = q.candidates[0];
  assert.deepStrictEqual(Object.keys(c).sort(), ['currentJobTitle', 'currentLocation', 'desiredJobTitle', 'desiredLocations', 'firstName', 'hasWorkPermit', 'id', 'jobType', 'keywords', 'lastLogin', 'name', 'noticePeriod', 'queryId', 'salary', 'screeningReason', 'source'].sort());
  assert.strictEqual(c.queryId, 'q-fake-0001');
  assert.strictEqual(c.keywords, 'Chef');
  assert.strictEqual(c.screeningReason, 'Good fit');
  const rows = dbRows(m);
  assert.strictEqual(rows.length, 30);
  assert.ok(rows.every((x) => x.source === 'reed' && x.unlocked === 0 && x.zoho_id === null));
  const calls = aiLog(m);
  assert.deepStrictEqual(calls.map((x) => x.ids.length), [25, 5], 'one screening call per page');
  assert.strictEqual(calls[0].withCv, 25, 'anonymized CV text is part of every snippet');
  assert.strictEqual(calls[0].job, 'Chef');
  assert.strictEqual(calls[0].distance, '20');
  assert.deepStrictEqual(calls[0].snippetKeys, ['id', 'snippet']);
  const s = summary(r.stdout);
  assert.strictEqual(s.approved, 28);
  assert.strictEqual(s.queuePath, m.p('downloads', 'reed-approved-queue-t1.json'));
  assert.ok(!/Test Person/.test(r.stdout + r.stderr), 'candidate names are not logged');
  assert.deepStrictEqual(filesContaining(m.home, 'AAA-CVTEXT-MARKER'), [], 'CV text and snippets never touch the disk (stdin hand-off to the screening CLI)');
  assert.ok(calls[0].withCv > 0);
  assert.strictEqual(m.exists('runtime/browser.lock'), false);
  assert.strictEqual(m.exists('runtime/reed-auth-failed.marker'), false);
  assert.strictEqual(m.exists('runtime/pipeline-halt.json'), false);
}));

test('a repeat run skips everything already in the DB and never calls screening', () => world(async ({ m, run }) => {
  await run('reed-phase1.js', ARGS());
  const before = aiLog(m).length;
  const r = await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(aiLog(m).length, before);
  const q = queue(m, 't2');
  assert.strictEqual(q.phase1Stats.inDb, 30);
  assert.strictEqual(q.phase1Stats.approved, 0);
  assert.strictEqual(q.candidates.length, 0);
}));

test('--cv-limit stops at the limit: the rest of the page is neither approved nor marked seen', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(['--cv-limit', '3']));
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.strictEqual(q.candidates.length, 3);
  assert.strictEqual(dbRows(m).length, 3);
  assert.match(r.stdout, /limit reached/);
}));

test('cross-dedup against the Caterer queue by name + location, and no-work-permit cards, are skipped before screening and not marked seen', () => world(async ({ m, fake, run }) => {
  fake.api.candidates[3] = makeCard(4, { jobEligibility: { hasWorkPermit: false } });
  m.write('downloads/approved-queue-x.json', { candidates: [{ name: 'Test  PERSON 2!', currentLocation: 'town2' }] });
  const r = await run('reed-phase1.js', ARGS(['--caterer-queue', m.p('downloads', 'approved-queue-x.json')]));
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.strictEqual(q.phase1Stats.crossDedup, 1);
  assert.strictEqual(q.phase1Stats.noPermit, 1);
  const screened = aiLog(m).flatMap((x) => x.ids);
  assert.ok(!screened.includes(9002) && !screened.includes(9004));
  const seen = dbRows(m).map((x) => x.reed_id);
  assert.ok(!seen.includes(9002) && !seen.includes(9004));
  assert.strictEqual(q.candidates.length, 28);
  assert.match(r.stdout, /Caterer cross-dedup: 1 candidates loaded/);
}));

test('empty pool: exit 0, empty queue file, legacy quiet stdout (no summary line)', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.deepStrictEqual(q.candidates, []);
  assert.strictEqual(q.phase1Stats.pool, 0);
  assert.strictEqual(summary(r.stdout), null);
  assert.match(r.stdout, /No candidates found - exiting/);
}, { fake: { loggedIn: true, candidates: [] } }));

test('--skip-screening approves everyone without calling the screening CLI', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(['--skip-screening']));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(aiLog(m).length, 0);
  const q = queue(m);
  assert.strictEqual(q.candidates.length, 30);
  assert.ok(q.candidates.every((c) => c.screeningReason === 'Screening skipped'));
  assert.strictEqual(q.screeningModel, 'unknown');
}));

test('usage: --help exits 0, missing --location exits 1', () => world(async ({ run }) => {
  assert.strictEqual((await run('reed-phase1.js', ['--help'])).code, 0);
  const r = await run('reed-phase1.js', ['--job-title', 'Chef']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /Usage: node scripts\/reed-phase1\.js/);
}));

// ------------------------------------------------------------------ auth chain

test('pre-flight refresh unconfirmed but the saved token is still valid: proceed with it and skip the auto-login (2026-06-05 fix)', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  fake.site.captureMode = 'none';
  const r = await run('reed-phase1.js', ARGS(), { env: { REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Refresh unconfirmed but saved token still valid - proceeding with it \(skipping auto-login\)/);
  assert.doesNotMatch(r.stdout, /Attempting full auto-login/);
  assert.strictEqual(queue(m).phase1Stats.approved, 30);
}));

test('refresh fails and no valid token: automatic login runs, the post-login verify refresh succeeds, the run continues', () => withWorld(async ({ m, fake, run }) => {
  writeCreds(m);
  fake.site.loggedIn = false;
  const r = await run('reed-phase1.js', ARGS(), { env: { REED_CAPTURE_TIMEOUT_MS: '500' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Attempting full auto-login/);
  assert.match(r.stdout, /Auto-login SUCCESS - token saved/);
  assert.match(r.stdout, /Token refreshed OK after auto-login/);
  assert.strictEqual(queue(m).phase1Stats.approved, 30);
  const tok = m.readJson('state/reed-session.json').accessToken;
  assert.ok(!(r.stdout + r.stderr).includes(tok), 'the JWT never crosses stdout/stderr');
  assert.ok(!(r.stdout + r.stderr).includes('Pw-SENTINEL-1234'));
}, { fake: { loggedIn: false } }));

test('auth failure with credentials missing: marker + REED_AUTH_FAILED + exit 1, no run', () => withWorld(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_AUTH_FAILED$/m);
  const mk = m.readJson('runtime/reed-auth-failed.marker');
  assert.strictEqual(mk.reason, 'reed_credentials_missing');
  assert.strictEqual(mk.jobTitle, 'Chef');
  assert.ok(mk.failedAt);
  assert.strictEqual(m.exists('downloads/reed-approved-queue-t1.json'), false);
  assert.strictEqual(m.exists('runtime/browser.lock'), false);
}, { fake: { loggedIn: false } }));

test('Turnstile block: REED_AUTH_FAILED with reason turnstile_blocked, one critical alert, and the next run does not retry the login', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  const env = { REED_CAPTURE_TIMEOUT_MS: '400' };
  let r = await run('reed-phase1.js', ARGS(), { env });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_AUTH_FAILED$/m);
  assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'turnstile_blocked');
  assert.strictEqual(alerts(m).filter((a) => a.key === 'reed-human-login').length, 1);
  const tabsCalls = fake.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  r = await run('reed-phase1.js', ARGS(), { env });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'turnstile_blocked');
  assert.strictEqual(alerts(m).filter((a) => a.key === 'reed-human-login').length, 1, 'no alert storm across runs');
  assert.ok(fake.calls.filter((c) => c.method === 'Runtime.evaluate').length === tabsCalls, 'the second run never drove the login page');
}, { fake: { loggedIn: false } }));

test('the pre-flight refresh has a 90 s kill timeout (2026-06-09) and a slow-but-valid capture is not killed', () => world(async ({ m, fake, run, drive }) => {
  const d = await drive("return require('./reed-phase1').REFRESH_KILL_TIMEOUT_MS();");
  assert.strictEqual(d.result, 90000);
  validSession(m, fake);
  // capture takes ~1.2s: killed at 300 ms, completed with a 20 s ceiling
  let r = await run('reed-phase1.js', ARGS(), { env: { REED_REFRESH_TIMEOUT_MS: '300' } });
  assert.match(r.stdout, /Refresh did not confirm success/, r.stdout);
  assert.strictEqual(r.code, 0, 'falls back to the still-valid saved token');
}, { fake: { loggedIn: true, delayMethods: { 'Network.enable': 1200 } } }));

test('a slow-but-valid capture completes when the kill timeout is generous', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { REED_REFRESH_TIMEOUT_MS: '20000' } });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Token refreshed OK/);
}, { fake: { loggedIn: true, delayMethods: { 'Network.enable': 1200 } } }));

// ------------------------------------------------------------------ API failures

test('HTTP 451 on the first search page: FATAL, marker reed_451_international, one critical alert, exit 1', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 451, path: '/candidate/search/boolean/', body: { error: 'InternationalCvSearchNotAllowedException' } }];
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /FATAL: Could not fetch first page: Reed API POST HTTP 451/);
  assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'reed_451_international');
  assert.ok(alerts(m).some((a) => a.key === 'reed-451' && a.severity === 'critical'));
}));

test('HTTP 451 raises ONE critical alert per episode; a run that gets past the first page closes the episode', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  const n451 = () => alerts(m).filter((a) => a.key === 'reed-451').length;
  fake.api.failNext = [{ status: 451, path: '/candidate/search/boolean/' }];
  await run('reed-phase1.js', ARGS());
  assert.strictEqual(n451(), 1);
  const a = alerts(m).find((x) => x.key === 'reed-451');
  assert.ok(a.text.includes(`cd ${m.home} && node scripts/cdp-reed-full-login.js --clean`), 'the alert carries the exact recovery command');
  fake.api.failNext = [{ status: 451, path: '/candidate/search/boolean/' }];
  await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.strictEqual(n451(), 1, 'the same episode does not alert again');
  const ok = await run('reed-phase1.js', ARGS(['--run-id', 't3', '--skip-screening']));
  assert.strictEqual(ok.code, 0, ok.stderr);
  fake.api.failNext = [{ status: 451, path: '/candidate/search/boolean/' }];
  await run('reed-phase1.js', ARGS(['--run-id', 't4']));
  assert.strictEqual(n451(), 2, 'a new episode after a good run alerts again');
}));

test('a successful pre-flight closes a recorded Turnstile block (the human logged in through the browser without the command)', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  m.write('runtime/reed-login-block.json', { blockedAt: new Date().toISOString(), reason: 'turnstile_unsolved', attempts: 1 });
  const r = await run('reed-phase1.js', ARGS(['--skip-screening']));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  assert.strictEqual(m.readJson('runtime/reed-status.json').state, 'ok');
}));

test('401 on the first search page: exit 1 and the login hint names the new command', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 401, path: '/candidate/search/boolean/' }];
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /FATAL: Could not fetch first page: REED_RELOGIN_NEEDED/);
  assert.match(r.stderr, /Run: node scripts\/cdp-reed-full-login\.js/);
}));

test('a non-auth failure on a later page (HTTP 429) skips that page after a pause and the run completes with what it has', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  // search calls: step 1, page 1 refetch, page 2 -> fail page 2
  fake.api.failNext = [{ status: 429, path: '/candidate/search/boolean/', skip: 2 }];
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /ERROR fetching page 2: Reed API POST HTTP 429/);
  assert.strictEqual(queue(m).candidates.length, 25);
  assert.strictEqual(queue(m).phase1Stats.pagesScraped, 1);
}));

test('legacy quirk kept: a 5xx falls back to a direct fetch which Cloudflare rejects (403), read as REED_RELOGIN_NEEDED, so paging stops but page 1 is kept', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  fake.api.blockDirect = true;
  fake.api.failNext = [{ status: 500, path: '/candidate/search/boolean/', skip: 2 }];
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /Browser proxy failed, trying direct/);
  assert.match(r.stderr, /ERROR fetching page 2: REED_RELOGIN_NEEDED: HTTP 403/);
  assert.strictEqual(queue(m).candidates.length, 25);
  assert.strictEqual(queue(m).phase1Stats.pagesScraped, 1);
}));

test('a relogin error (401) mid-run stops paging but keeps what was screened', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 401, path: '/candidate/search/boolean/', skip: 2 }];
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /ERROR fetching page 2: REED_RELOGIN_NEEDED/);
  assert.strictEqual(queue(m).candidates.length, 25);
}));

// ------------------------------------------------------------------ D4: screening down does not burn candidates

test('D4: one Unavailable answer -> nothing marked seen or rejected, the same page is retried and then screened; counters not double counted', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'unavailable,ok,ok' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const calls = aiLog(m);
  assert.deepStrictEqual(calls.map((c) => c.mode), ['unavailable', 'ok', 'ok']);
  assert.deepStrictEqual(calls[0].ids, calls[1].ids, 'the retry re-screens the same page');
  assert.match(r.stdout, /AI screening API unavailable \(1\/3\)/);
  const q = queue(m);
  assert.strictEqual(q.phase1Stats.approved, 30);
  assert.strictEqual(q.phase1Stats.pagesScraped, 2, 'a retried page is counted once');
  assert.strictEqual(q.phase1Stats.rejected, 0);
  assert.strictEqual(q.phase1Stats.errors, 0);
  assert.strictEqual(dbRows(m).length, 30);
  assert.strictEqual(m.exists('runtime/pipeline-halt.json'), false);
  assert.strictEqual(q.screeningModel, 'fake/model-1');
}));

test('D4: three consecutive Unavailable answers raise the shared halt, mark NOTHING, write a partial queue, exit 0', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'unavailable,unavailable,unavailable' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.strictEqual(dbRows(m).length, 0, 'not one candidate was burned');
  assert.strictEqual(aiLog(m).length, 3);
  const halt = m.readJson('runtime/pipeline-halt.json');
  assert.strictEqual(halt.halted, true);
  assert.strictEqual(halt.reason, 'AI screening unavailable');
  assert.match(halt.detail, /3 consecutive attempts during Reed Chef\/LS1/);
  assert.ok(halt.remedy);
  assert.ok(m.readLines('logs/errors.jsonl').some((e) => e.context === 'pipeline_halted'));
  const q = queue(m);
  assert.strictEqual(q.candidates.length, 0);
  assert.strictEqual(q.phase1Stats.screeningHalted, true);
  assert.strictEqual(q.phase1Stats.errors, 1);
  assert.strictEqual(q.screeningModel, 'unavailable');
  assert.strictEqual(q.phase1Stats.rejected, 0);
  assert.match(r.stdout, /^REED_SCREENING_HALT: pipeline halt raised$/m);
  assert.ok(alerts(m).some((a) => a.severity === 'critical' && a.key === 'pipeline-halt' && /AI screening unavailable/.test(a.text)), 'the shared halt lib alerts once');
  assert.ok(summary(r.stdout), 'the summary line is printed so run-pipeline merges the real queue');
}));

test('D4: outage after page 1 -> page 1 approvals are kept and marked, page 2 is untouched and retried on the next run', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'ok,unavailable,unavailable,unavailable' } });
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.strictEqual(q.candidates.length, 25);
  assert.strictEqual(q.phase1Stats.pagesScraped, 1);
  assert.strictEqual(dbRows(m).length, 25, 'only the screened page is marked');
  assert.strictEqual(m.readJson('runtime/pipeline-halt.json').halted, true);
}));

test('D4: failures that are not consecutive never reach the halt (counter resets on success)', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'unavailable,ok,unavailable,ok' } });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(aiLog(m).length, 4);
  assert.strictEqual(m.exists('runtime/pipeline-halt.json'), false);
  assert.strictEqual(queue(m).phase1Stats.approved, 30);
}));

test('D4: a run that starts while the pipeline is halted does no browser work and marks nothing', () => world(async ({ m, fake, run }) => {
  m.write('runtime/pipeline-halt.json', { halted: true, reason: 'gateway auth expired', detail: 'x', since: new Date().toISOString() });
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /REED_SCREENING_HALT: pipeline halted \(gateway auth expired\)/);
  assert.strictEqual(fake.calls.length, 0);
  assert.strictEqual(dbRows(m).length, 0);
  assert.strictEqual(queue(m).phase1Stats.screeningHalted, true);
  assert.ok(summary(r.stdout));
  // --skip-screening does not depend on the screening service
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't9', '--skip-screening']));
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual(queue(m, 't9').candidates.length, 30);
}));

// D4 extension (owner decision): ANY screening attempt that is not a successful parse is Unavailable, not a rejection.
const NOT_A_PARSE = [
  ['error', 'exit 1'],
  ['exit2', 'exit 2'],
  ['badjson', 'unparseable output'],
  ['notarray', 'output is not a JSON array'],
  ['partial', 'results missing for 1 of 25 candidates'],
  ['empty', 'results missing for 25 of 25 candidates'],
  ['stringbool', 'malformed result entry'],
  ['nullentry', 'malformed result entry'],
];
for (const [mode, why] of NOT_A_PARSE) {
  test(`D4 extension: screening answer "${mode}" (${why}) burns nothing: the same page is retried and then screened`, () => world(async ({ m, run }) => {
    const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: `${mode},ok,ok` } });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    const calls = aiLog(m);
    assert.deepStrictEqual(calls.map((c) => c.mode), [mode, 'ok', 'ok']);
    assert.deepStrictEqual(calls[0].ids, calls[1].ids, 'the retry re-screens the same page');
    assert.ok(r.stdout.includes(`AI screening API unavailable (1/3) [${why}]`), r.stdout);
    const q = queue(m);
    assert.strictEqual(q.phase1Stats.approved, 30);
    assert.strictEqual(q.phase1Stats.rejected, 0, 'not one candidate was rejected on a failed screening');
    assert.strictEqual(q.phase1Stats.errors, 0);
    assert.strictEqual(q.phase1Stats.pagesScraped, 2, 'the retried page is counted once');
    assert.strictEqual(q.screeningModel, 'fake/model-1');
    assert.strictEqual(dbRows(m).length, 30, 'candidates are marked seen only after a real decision');
    assert.strictEqual(m.exists('runtime/pipeline-halt.json'), false);
  }));
}

test('parseScreeningOutput accepts exactly a full boolean answer (string or number ids, a missing reason is filled in) and names why anything else is rejected', () => world(async ({ drive }) => {
  const r = await drive(`
    const { parseScreeningOutput: p } = require('./reed-phase1');
    const c = [{ id: 1 }, { id: '2' }];
    const ok = p(JSON.stringify([{ id: '1', approved: true, reason: 'Good' }, { id: 2, approved: false }]), c);
    const bad = [p('', c), p('{}', c), p('[]', c), p('null', c),
      p(JSON.stringify([{ id: '1', approved: 'true' }, { id: '2', approved: true }]), c),
      p(JSON.stringify([{ approved: true }, { id: '2', approved: true }]), c),
      p(JSON.stringify([{ id: '1', approved: true }]), c)].map((x) => x.why);
    const extra = p(JSON.stringify([{ id: '1', approved: true }, { id: '2', approved: true }, { id: '3', approved: true }]), c).ok;
    return { ok: ok.ok && ok.results.map((x) => [x.id, x.approved, x.reason]), bad, extra };
  `);
  assert.deepStrictEqual(r.result.ok, [['1', true, 'Good'], ['2', false, 'Rejected']]);
  assert.deepStrictEqual(r.result.bad, ['unparseable output', 'output is not a JSON array', 'results missing for 2 of 2 candidates', 'output is not a JSON array',
    'malformed result entry', 'malformed result entry', 'results missing for 1 of 2 candidates']);
  assert.strictEqual(r.result.extra, true, 'extra ids in the answer are ignored');
}));

test('D4 extension: three consecutive failures of different kinds raise the shared halt, name the last one, and mark NOTHING', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'error,badjson,exit2' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.strictEqual(dbRows(m).length, 0, 'not one candidate was burned');
  assert.strictEqual(aiLog(m).length, 3);
  const halt = m.readJson('runtime/pipeline-halt.json');
  assert.strictEqual(halt.halted, true);
  assert.strictEqual(halt.reason, 'AI screening unavailable');
  assert.match(halt.detail, /3 consecutive attempts during Reed Chef\/LS1 \(last failure: exit 2\)/);
  const q = queue(m);
  assert.strictEqual(q.candidates.length, 0);
  assert.strictEqual(q.phase1Stats.rejected, 0);
  assert.strictEqual(q.phase1Stats.screeningHalted, true);
  assert.strictEqual(q.phase1Stats.errors, 1);
  assert.match(r.stdout, /^REED_SCREENING_HALT: pipeline halt raised$/m);
  assert.ok(alerts(m).some((a) => a.key === 'pipeline-halt' && a.severity === 'critical'));
}));

test('D4 extension: a screening process that hangs is killed by the timeout and counts as unavailable', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'hang,ok,ok', REED_SCREEN_TIMEOUT_MS: '900' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(aiLog(m).map((c) => c.mode), ['hang', 'ok', 'ok']);
  assert.ok(r.stdout.includes('AI screening API unavailable (1/3) [timeout]'), r.stdout);
  assert.strictEqual(queue(m).phase1Stats.rejected, 0);
  assert.strictEqual(dbRows(m).length, 30);
}));

test('D4 extension: a fully successful parse still rejects and marks normally (only real decisions are final)', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9001,9002,9003' } });
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.strictEqual(q.phase1Stats.rejected, 3);
  assert.strictEqual(q.phase1Stats.approved, 27);
  assert.strictEqual(dbRows(m).length, 30);
  assert.doesNotMatch(r.stdout, /AI screening API unavailable/);
}));

test('a screening process killed by a signal counts as unavailable, not as a rejection', { skip: isWin }, () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'crash-signal,ok,ok' } });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(aiLog(m).map((c) => c.mode), ['crash-signal', 'ok', 'ok']);
  assert.strictEqual(queue(m).phase1Stats.approved, 30);
}));

// ------------------------------------------------------------------ locks

test('standalone run with a live Caterer browser lock: REED_BROWSER_BUSY, marker browser_lock_busy, REED_AUTH_FAILED, exit 1', () => world(async ({ m, fake, run }) => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    m.write('runtime/browser.lock', { owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() });
    const r = await run('reed-phase1.js', ARGS());
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /REED_BROWSER_BUSY: browser\.lock held by caterer/);
    assert.match(r.stdout, /^REED_AUTH_FAILED$/m);
    assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'browser_lock_busy');
    assert.strictEqual(fake.calls.length, 0);
    assert.ok(m.exists('runtime/browser.lock'), 'the foreign lock is left alone');
  } finally { holder.kill(); }
}));

test('a lock held by the parent (run-pipeline hand-off) is borrowed and left in place', () => world(async ({ m, env }) => {
  m.write('runtime/browser.lock', { owner: 'reed', pid: process.pid, startedAt: new Date().toISOString() });
  const child = spawn(process.execPath, [m.p('scripts', 'reed-phase1.js'), ...ARGS(['--skip-screening'])], { cwd: m.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  assert.strictEqual(code, 0, out);
  assert.strictEqual(JSON.parse(fs.readFileSync(m.p('runtime', 'browser.lock'), 'utf8')).pid, process.pid);
}));

test('anonymized CV that is HTML or missing degrades to card-only snippets (no CV text, still screened)', () => world(async ({ m, fake, run }) => {
  fake.api.cvKind = 'html';
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(aiLog(m)[0].withCv, 0);
  assert.strictEqual(queue(m).candidates.length, 30);
}));

// ------------------------------------------------------------------ runtime/reed-status.json (dashboard indicator)

test('runtime/reed-status.json follows the auth outcome: ok after a good pre-flight, auth_failed with the reason on failure, untouched on a lock conflict', () => world(async ({ m, fake, run }) => {
  let r = await run('reed-phase1.js', ARGS(['--skip-screening']));
  assert.strictEqual(r.code, 0, r.stderr);
  let st = m.readJson('runtime/reed-status.json');
  assert.strictEqual(st.state, 'ok');
  assert.ok(Date.parse(st.updatedAt) > Date.now() - 60000);
  // now a browser that is logged out and has no credentials
  fake.site.loggedIn = false;
  for (const t of fake.tabs.values()) { t.url = 'https://secure-recruiter.reed.co.uk/login'; t.page = { kind: 'login', emailEl: {}, passEl: {}, hasEmail: true, hasPass: true }; t.ctx = null; }
  m.write('state/reed-session.json', { accessToken: 'x', expiresAt: 1 });
  r = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: { REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.strictEqual(r.code, 1);
  st = m.readJson('runtime/reed-status.json');
  assert.strictEqual(st.state, 'auth_failed');
  assert.match(st.detail, /reed_credentials_missing/);
  // a lock conflict is not an auth failure: the status stays as it was
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    m.write('runtime/browser.lock', { owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() });
    const before = m.readJson('runtime/reed-status.json');
    r = await run('reed-phase1.js', ARGS(['--run-id', 't3']));
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(m.readJson('runtime/reed-status.json'), before);
  } finally { holder.kill(); }
}));

// ------------------------------------------------------------------ CV text extraction from memory (no files written)

for (const kind of ['pdf', 'docx']) {
  const resolvable = (() => { try { dep(kind === 'pdf' ? 'pdf-parse' : 'mammoth'); return true; } catch { return false; } })();
  test(`anonymized ${kind} CVs are text-extracted from memory and reach the screening snippet`, { skip: resolvable ? false : `${kind === 'pdf' ? 'pdf-parse' : 'mammoth'} is not installed` }, () => world(async ({ m, fake, run }) => {
    fake.api.cvKind = kind;
    fake.api.cvText = 'Head Chef at The Test Kitchen 2018 to 2024, ran a brigade of ten in fine dining';
    const r = await run('reed-phase1.js', ARGS(['--cv-limit', '3']), { env: { FAKE_AI_MARK: 'Head Chef at The Test Kitchen' } });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.ok(aiLog(m)[0].marks >= 1, 'CV text made it into the snippet: ' + JSON.stringify(aiLog(m)[0]));
    assert.deepStrictEqual(fs.readdirSync(m.p('downloads')).filter((f) => f.startsWith('cv-') || f.startsWith('anon-')), []);
    assert.ok(!fs.existsSync(m.p('.reed-anon-cvs')));
  }));
}

test('a missing screening script is treated as unavailable (nothing burned, halt after 3), not as a rejection', () => world(async ({ m, run }) => {
  fs.unlinkSync(m.p('scripts', 'ai-review.js'));
  try { fs.unlinkSync(m.p('scripts', 'caterer-ai-review.js')); } catch { /* not present */ }
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /AI screening could not run for page 1: AI review script not found/);
  assert.strictEqual(dbRows(m).length, 0);
  assert.strictEqual(m.readJson('runtime/pipeline-halt.json').reason, 'AI screening unavailable');
}));
