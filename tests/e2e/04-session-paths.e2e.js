'use strict';
// SCENARIO 4 - Caterer session failures. Each path must end in the right exit-11 reason, the right alert (raised once,
// by its owner) and a persisted back-off - without a login loop, without a burnt territory - and the documented
// recovery must work: --open-link for a safe-list block, --clear-cooldown afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const tickOnce = (w, env) => w.cron('resourcer-tick', { env: Object.assign({ RESOURCER_MAX_TICK_MIN: '1' }, env) });
const counters = (w) => w.fakeBrowserState().counters || {};
const territoryRow = (w) => w.dbAll("select last_searched, next_run_date from territory_searches where location = 'LS29'")[0];
const events = (w) => w.jsonl('logs/watchdog-runner.jsonl').map((e) => e.event);
const LINK = 'https://recruiter.caterer.com/login/TwoFaAuthRedirect?token=tok-newest';

test('4a safe-list block: exit 11 "safelist", one critical alert from the login module, one e-mail asked for, no loop; --open-link + --clear-cooldown resume', async (t) => {
  const w = new World('s4a-safelist');
  await w.create({});
  t.after(() => w.close());
  w.svc.zoho.state.dupKeys.add('71000010');
  const before = territoryRow(w);
  w.setWorld({ login: { mode: 'safelist' } });
  const pending = w.dropPending({});

  await t.test('first tick', async () => {
    const r = await tickOnce(w);
    assert.deepEqual([r.code, r.stdout], [0, '']);
    const last = w.lastRun();
    assert.equal(last.exitCode, 11);
    assert.equal(last.reason, 'safelist');
    assert.equal(w.json('runtime/caterer-status.json').state, 'safelist_blocked');
    const crit = w.alerts().filter((a) => a.severity === 'critical');
    assert.deepEqual(crit.map((a) => a.key), ['caterer-safelist']);
    assert.match(crit[0].text, /--open-link/, 'the alert carries the exact recovery command');
    assert.doesNotMatch(JSON.stringify(crit), /tok-newest/);
    assert.equal(counters(w).submits, 1);
    assert.equal(counters(w).safelistEmails, 1);
  });

  await t.test('later ticks and a forced retry do not ask for another verification e-mail', async () => {
    for (let i = 0; i < 3; i += 1) await tickOnce(w);
    assert.equal(events(w).filter((e) => e === 'picked').length, 1, 'the 15 minute back-off holds the queue');
    w.node('pipeline-watchdog.js', ['--clear-cooldown']);
    await tickOnce(w);
    assert.equal(counters(w).safelistEmails, 1, 'the attempt limiter refuses a second sign-in (each attempt would mail a new link)');
    assert.equal(counters(w).submits, 1);
    assert.equal(w.lastRun().reason, 'safelist');
    assert.equal(w.alerts().filter((a) => a.key === 'caterer-safelist').length, 1, 'alerted once');
    assert.deepEqual(w.pendingFiles(), [pending]);
    assert.deepEqual(territoryRow(w), before, 'the territory is not consumed');
    assert.equal(w.exists('runtime/run.json'), false);
  });

  await t.test('the alert job delivers it once', async () => {
    const r = await w.cron('resourcer-alerts');
    assert.equal(r.stdout.split('\n').filter((l) => /safe-list/i.test(l)).length, 1, r.stdout);
  });

  await t.test('recovery: the newest link opens in the warm session, the cooldown is cleared and the run completes', async () => {
    w.setWorld({ login: { mode: 'success' } });
    const ol = w.node('caterer-login.js', ['--open-link', LINK]);
    assert.match(ol.stdout, /SAFELIST_CLEARED/);
    assert.ok(!(ol.stdout + ol.stderr).includes('tok-newest'), 'the token is never echoed');
    assert.ok(w.alerts().some((a) => a.key === 'caterer-safelist-cleared'));
    w.node('pipeline-watchdog.js', ['--clear-cooldown']);
    await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 8, tickMin: 1 });
    assert.equal(w.lastRun().exitCode, 0);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.equal(w.json('runtime/caterer-status.json').state, 'ok');
    assert.deepEqual(C.secretHits(w), []);
  });
});

test('4b wrong password: exit 11 "login", one warn, the limiter stops a login loop, the territory survives', async (t) => {
  const w = new World('s4b-login');
  await w.create({});
  t.after(() => w.close());
  const before = territoryRow(w);
  w.setWorld({ login: { mode: 'badpassword' } });
  const pending = w.dropPending({});
  await tickOnce(w);
  assert.equal(w.lastRun().exitCode, 11);
  assert.equal(w.lastRun().reason, 'login');
  assert.deepEqual(w.alerts().map((a) => `${a.severity}:${a.key}`), ['warn:caterer-login-failed']);
  assert.equal(w.json('runtime/caterer-status.json').state, 'login_failed');
  assert.equal(counters(w).submits, 1);
  // a forced retry inside the 10 minute gap is refused by the limiter, not sent to Caterer
  w.node('pipeline-watchdog.js', ['--clear-cooldown']);
  await tickOnce(w);
  assert.equal(counters(w).submits, 1, 'no second login attempt inside the gap (the account has been locked before)');
  assert.equal(w.alerts().filter((a) => a.key === 'caterer-login-failed').length, 1);
  assert.deepEqual(w.pendingFiles(), [pending]);
  assert.equal(w.json(`pending-searches/${pending}`).spawnedAt, undefined);
  assert.deepEqual(territoryRow(w), before);
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 0);
  assert.equal(w.svc.zoho.counts().create || 0, 0);
  const cred = path.join(w.home, 'secrets', 'caterer-credentials.json');
  assert.equal(C.modeOf(cred), 0o600);
  assert.deepEqual(C.secretHits(w), []);
});

test('4c CV Database module error while signed in: exit 11 "cvdb-module", never read as a logout, no re-login', async (t) => {
  const w = new World('s4c-module');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  w.setWorld({ cvdbModuleError: true });
  const pending = w.dropPending({});
  await tickOnce(w);
  assert.equal(w.lastRun().exitCode, 11);
  assert.equal(w.lastRun().reason, 'cvdb-module');
  assert.deepEqual(w.alerts().map((a) => `${a.severity}:${a.key}`), ['warn:caterer-cvdb-module']);
  assert.equal(counters(w).submits, undefined, 'the session was fine: nobody signed in again');
  assert.ok(!events(w).includes('phase1-start'), 'phase 1 never started');
  for (let i = 0; i < 2; i += 1) await tickOnce(w);
  assert.equal(events(w).filter((e) => e === 'picked').length, 1);
  assert.deepEqual(w.pendingFiles(), [pending]);
  // the module heals: after the back-off is cleared the run goes through
  w.setWorld({ cvdbModuleError: false });
  w.svc.zoho.state.dupKeys.add('71000010');
  w.node('pipeline-watchdog.js', ['--clear-cooldown']);
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 8, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.svc.zoho.created().length, 5);
});

test('4d the session dies between the runner check and phase 1: phase 1 exit 2 becomes exit 11 "phase1-session-stale" with a critical tick alert', async (t) => {
  const w = new World('s4d-phase1-stale');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  const pending = w.dropPending({});
  // widen the settle gap after the runner's session check so the browser can be logged out inside it
  const tick = tickOnce(w, { RESOURCER_SETTLE_MS: '4000' });
  await U.waitFor(() => events(w).includes('session-loaded'), { timeoutMs: 30000, pollMs: 50, what: 'the runner session check' });
  w.setWorld({ login: { mode: 'badpassword' } });
  w.setFakeBrowserState({ loggedIn: false, page: 'login', url: 'https://recruiter.caterer.com/login?ReturnUrl=%2F' });
  const r = await tick;
  assert.deepEqual([r.code, r.stdout], [0, '']);
  const last = w.lastRun();
  assert.equal(last.exitCode, 11);
  assert.equal(last.reason, 'phase1-session-stale');
  assert.equal(last.phase1Code, 2);
  assert.ok(w.alerts().some((a) => a.severity === 'critical' && a.key === 'caterer-session'), JSON.stringify(w.alerts().map((a) => a.key)));
  assert.equal(w.json('runtime/caterer-status.json').state, 'stale');
  assert.match(w.text(`logs/${w.list('logs', /^phase1-console-/)[0]}`), /SESSION_STALE/);
  assert.deepEqual(w.pendingFiles(), [pending]);
  assert.equal(w.json(`pending-searches/${pending}`).spawnedAt, undefined);
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 0);
  const st = w.json('runtime/watchdog-state.json');
  assert.ok(st.staleCooldownUntil > Date.now() + 13 * 60000, 'the 15 minute back-off is persisted');
  const orphan = w.list('runs', /^phase1-.*\.json$/).map((f) => w.json(`runs/${f}`).status);
  assert.ok(orphan.every((s) => ['phase1_abandoned', 'complete'].includes(s)), `no in-flight status is left behind: ${orphan}`);
});

test('4e the 05:50 pre-flight against a safe-list block: one line and a non-zero exit for Hermes, one alert, a second pre-flight does not mail again', async (t) => {
  const w = new World('s4e-preflight');
  await w.create({});
  t.after(() => w.close());
  w.setWorld({ login: { mode: 'safelist' } });
  const a = await w.cron('resourcer-preflight');
  assert.equal(a.code, 2);
  assert.equal(a.stdout.trim().split('\n').length, 1);
  assert.match(a.stdout, /^resourcer-preflight failed rc=2:/);
  assert.deepEqual(w.alerts().filter((x) => x.severity === 'critical').map((x) => x.key), ['caterer-safelist']);
  assert.equal(counters(w).safelistEmails, 1);
  const b = await w.cron('resourcer-preflight');
  assert.equal(b.code, 2);
  assert.equal(counters(w).safelistEmails, 1, 'the limiter holds across separate cron jobs');
  assert.equal(w.alerts().filter((x) => x.key === 'caterer-safelist').length, 1, 'alerted once, not per pre-flight');
  // the overnight keep-alive never signs in
  const k = await w.cron('resourcer-keepalive');
  assert.equal(k.code, 0);
  assert.equal(counters(w).safelistEmails, 1);
});

test('4f the everyday case: Caterer logged the session out overnight; the runner signs in again once, silently, and the run completes', async (t) => {
  const w = new World('s4f-relogin');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  w.setFakeBrowserState({ loggedIn: false });
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 10, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(counters(w).submits, 1, 'one sign-in, not a loop');
  assert.ok(events(w).includes('session-relogin'));
  assert.equal(w.json('runtime/caterer-status.json').state, 'ok');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), [], 'a routine re-login raises nothing');
  assert.equal(w.svc.zoho.created().length, 5);
  assert.deepEqual(C.secretHits(w), []);
});
