'use strict';

// reed-phase1 when the first search page cannot be fetched (docs/parity/reed-first-page.md, R3): a FAILURE with a fixed marker, exit 1 and a
// counted, deduplicated alert; a genuine empty pool stays a normal empty result; auth problems keep their own handling.

const test = require('node:test');
const assert = require('node:assert');
const { withWorld } = require('./helpers/world');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];
const FAST = { REED_RETRY_BACKOFF_MS: '30', REED_TAB_SETTLE_MS: '0' };
const alerts = (m) => m.readLines('outbox/alerts.jsonl').filter((a) => a.key === 'reed-first-page-failed');
const MARKER = /^REED_FIRST_PAGE_FAILED: (.*)$/m;

test('R3: a persistent 400 / 50010 on the first page is a FAILURE: exit 1, the fixed marker with reason, attempts and streak, no queue, one warn alert', () => world(async ({ m, fake, run }) => {
  fake.api.alwaysHeaderMissing = true;
  const r = await run('reed-phase1.js', ARGS(), { env: FAST });
  assert.strictEqual(r.code, 1, r.stderr + r.stdout);
  assert.match(r.stdout, MARKER);
  assert.strictEqual(MARKER.exec(r.stdout)[1], 'HTTP 400 code 50010 attempts=3 streak=1');
  assert.match(r.stderr, /FATAL: Could not fetch first page: Reed API POST HTTP 400/);
  assert.strictEqual((r.stderr.match(/REED_REQUEST_FORENSIC/g) || []).length, 3, 'one forensic line per failed attempt');
  assert.strictEqual(m.exists('downloads/reed-approved-queue-t1.json'), false, 'no queue: nothing was searched');
  assert.strictEqual(m.exists('runtime/reed-auth-failed.marker'), false, 'it is not an auth failure');
  assert.strictEqual(m.readJson('runtime/reed-first-page-streak.json').count, 1);
  const a = alerts(m);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'warn');
  assert.match(a[0].text, /could not fetch the first search page for Chef\/LS1 \(HTTP 400 code 50010, 3 attempt\(s\)\)/);
  assert.ok(!/Bearer|eyJ/.test(a[0].text + r.stdout + r.stderr), 'no token anywhere');
  const st = m.readJson('runtime/reed-status.json');
  assert.deepStrictEqual(Object.keys(st).sort(), ['detail', 'state', 'updatedAt'], 'the dashboard status shape is unchanged');
  assert.strictEqual(st.state, 'ok');
  assert.match(st.detail, /first search page failed \(1 in a row\)/);
}));

test('R3: the alert is one per episode (warn), becomes critical exactly once after 5 failed attempts in a row, and a good first page ends the episode', () => world(async ({ m, fake, run }) => {
  fake.api.alwaysHeaderMissing = true;
  const sevs = [];
  for (let i = 1; i <= 6; i++) {
    const r = await run('reed-phase1.js', ARGS(['--run-id', `t${i}`]), { env: FAST });
    assert.strictEqual(r.code, 1);
    assert.match(MARKER.exec(r.stdout)[1], new RegExp(`streak=${i}$`));
    sevs.push(alerts(m).map((x) => x.severity).join(','));
  }
  assert.deepStrictEqual(sevs, ['warn', 'warn', 'warn', 'warn', 'warn,critical', 'warn,critical'], 'warn once, critical once at the fifth, silent otherwise');
  assert.strictEqual(alerts(m)[1].meta.count, 5);
  // a run that gets past the first page closes the streak and the episode
  fake.api.alwaysHeaderMissing = false;
  const ok = await run('reed-phase1.js', ARGS(['--run-id', 'good']), { env: FAST });
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.strictEqual(m.exists('runtime/reed-first-page-streak.json'), false);
  fake.api.alwaysHeaderMissing = true;
  const again = await run('reed-phase1.js', ARGS(['--run-id', 'bad2']), { env: FAST });
  assert.match(MARKER.exec(again.stdout)[1], /streak=1$/);
  assert.strictEqual(alerts(m).length, 3, 'a new episode alerts again');
  assert.strictEqual(alerts(m)[2].severity, 'warn');
}));

test('R3: transient 400s within the retries are not failures: the run completes, no marker, no alert, no streak', () => world(async ({ m, fake, run }) => {
  const { HEADER_MISSING_BODY } = require('./helpers/fake-reed');
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }, { status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }];
  const r = await run('reed-phase1.js', ARGS(), { env: FAST });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!MARKER.test(r.stdout));
  assert.strictEqual(alerts(m).length, 0);
  assert.strictEqual(m.readJson('downloads/reed-approved-queue-t1.json').phase1Stats.pool, 30);
}));

test('R3: a genuine empty pool stays a normal empty result (exit 0, empty queue, no failure marker, no alert) and ends an open streak', () => world(async ({ m, fake, run }) => {
  fake.api.alwaysHeaderMissing = true;
  await run('reed-phase1.js', ARGS(['--run-id', 'bad']), { env: FAST });
  assert.strictEqual(m.readJson('runtime/reed-first-page-streak.json').count, 1);
  fake.api.alwaysHeaderMissing = false;
  fake.api.candidates.length = 0;
  const r = await run('reed-phase1.js', ARGS(), { env: FAST });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Total pool: 0 candidates/);
  assert.ok(!MARKER.test(r.stdout));
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  assert.deepStrictEqual([q.phase1Stats.pool, q.phase1Stats.errors || 0, q.candidates.length], [0, 0, 0]);
  assert.strictEqual(m.exists('runtime/reed-first-page-streak.json'), false, 'a search that works, even with no results, is not a failure');
}));

test('R3: HTTP 401, 403 and 451 on the first page keep their own handling and never produce the first-page marker or its alert', () => world(async ({ m, fake, run }) => {
  for (const status of [401, 403, 451]) {
    fake.api.failNext = [{ status, path: '/candidate/search/', body: status === 451 ? { error: 'InternationalCvSearchNotAllowedException' } : undefined }];
    const r = await run('reed-phase1.js', ARGS(['--run-id', `s${status}`]), { env: FAST });
    assert.strictEqual(r.code, 1, `${status}: ${r.stderr}`);
    assert.ok(!MARKER.test(r.stdout), `${status} is not a first-page failure`);
    assert.match(r.stderr, status === 451 ? /HTTP 451/ : /REED_RELOGIN_NEEDED/);
  }
  assert.strictEqual(alerts(m).length, 0);
  assert.strictEqual(m.exists('runtime/reed-first-page-streak.json'), false);
}));

// ---------------------------------------------------------------- finalizer additions (review findings)

test('R3: a place Reed cannot look up is an EMPTY search, not a failure: exit 0, empty queue, no failure marker, no streak, no alert', () => world(async ({ m, fake, run }) => {
  fake.api.noLocations = true;
  const r = await run('reed-phase1.js', ARGS(['--location', 'ZZ99']), { env: FAST });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /REED_LOCATION_NOT_FOUND/);
  assert.ok(!MARKER.test(r.stdout));
  assert.ok(!/Could not fetch first page/.test(r.stderr), 'the log does not read like a first-page failure');
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  assert.deepStrictEqual([q.phase1Stats.pool, q.phase1Stats.errors || 0, q.candidates.length], [0, 0, 0]);
  assert.strictEqual(q.phase1Stats.locationNotFound, true);
  assert.strictEqual(alerts(m).length, 0);
  assert.strictEqual(m.exists('runtime/reed-first-page-streak.json'), false);
}));

test('R3: an unsearchable place neither ends nor adds to a real streak of failures', () => world(async ({ m, fake, run }) => {
  fake.api.alwaysHeaderMissing = true;
  await run('reed-phase1.js', ARGS(['--run-id', 'bad']), { env: FAST });
  assert.strictEqual(m.readJson('runtime/reed-first-page-streak.json').count, 1);
  fake.api.alwaysHeaderMissing = false;
  fake.api.noLocations = true;
  const r = await run('reed-phase1.js', ARGS(['--location', 'ZZ98', '--run-id', 'nl']), { env: FAST });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(alerts(m).length, 1, 'still the one alert of the real failure');
  assert.strictEqual(m.readJson('runtime/reed-first-page-streak.json').count, 1, 'the streak is neither closed nor raised');
}));

test('R3: a pool whose search pages can NONE be fetched is a FAILURE: marker, failed stats with errors 1, streak and alert (not a quiet ok)', () => world(async ({ m, fake, run }) => {
  const { HEADER_MISSING_BODY } = require('./helpers/fake-reed');
  // request 1 (the first page of step 1) works; every request after it, for all pages of step 2 and all their attempts, answers 400 / 50010
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/', skip: 1 }];
  for (let i = 0; i < 11; i++) fake.api.failNext.push({ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' });
  const r = await run('reed-phase1.js', ARGS(), { env: FAST });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /REED_FIRST_PAGE_FAILED: HTTP 400 code 50010 attempts=3 streak=1 \(no search page could be fetched\)/);
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  assert.strictEqual(q.phase1Stats.failed, true);
  assert.strictEqual(q.phase1Stats.failureReason, 'HTTP 400 code 50010');
  assert.ok(q.phase1Stats.errors >= 1);
  assert.strictEqual(q.phase1Stats.pagesScraped, 0);
  assert.strictEqual(alerts(m).length, 1);
  assert.strictEqual(m.readJson('runtime/reed-first-page-streak.json').count, 1);
}));

test('R3: a first page that works and later pages that partly fail is NOT a failure (pages were scraped); the streak is closed', () => world(async ({ m, fake, run }) => {
  fake.api.alwaysHeaderMissing = true;
  await run('reed-phase1.js', ARGS(['--run-id', 'bad']), { env: FAST });
  fake.api.alwaysHeaderMissing = false;
  const { HEADER_MISSING_BODY } = require('./helpers/fake-reed');
  // page 1 of step 1 works; page 1 of step 2 works; page 2 fails all three attempts
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/', skip: 2 }, { status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }, { status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }];
  const r = await run('reed-phase1.js', ARGS(['--run-id', 'part']), { env: FAST });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.ok(!MARKER.test(r.stdout));
  const q = m.readJson('downloads/reed-approved-queue-part.json');
  assert.ok(!q.phase1Stats.failed);
  assert.ok(q.phase1Stats.pagesScraped >= 1);
  assert.ok(q.phase1Stats.errors >= 1, 'the failed page is counted');
  assert.strictEqual(m.exists('runtime/reed-first-page-streak.json'), false);
}));

test('R3: no usable token (saved session and browser capture both fail) is a login problem: auth marker, REED_AUTH_FAILED, no first-page marker or alert', () => world(async ({ m, fake, run }) => {
  const { writeSession } = require('./helpers/world');
  // the pre-flight refresh is bypassed by a saved token that is valid by date but not a JWT, and a browser that shows no token
  writeSession(m, { token: 'not-a-jwt-'.padEnd(90, 'x'), expiresAtSecs: Math.floor(Date.now() / 1000) + 3000 });
  fake.site.captureMode = 'none';
  const r = await run('reed-phase1.js', ARGS(), { env: { ...FAST, REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.strictEqual(r.code, 1, r.stderr + r.stdout);
  assert.ok(!MARKER.test(r.stdout));
  assert.strictEqual(alerts(m).length, 0);
  assert.ok(/REED_AUTH_FAILED/.test(r.stdout), r.stdout.slice(-400));
  assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'token_missing');
}));
