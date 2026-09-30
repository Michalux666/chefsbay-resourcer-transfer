'use strict';
// runtime/caterer-status.json: caterer-login.js writes {state, updatedAt, detail} on every outcome of its sign-in and check paths, so the dashboard
// strip does not say "Unknown" until the first supervisor tick. Same shape and states as watchdog-runner.js (docs/parity/dashboard.md section 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const STATES = ['ok', 'stale', 'safelist_blocked', 'login_failed', 'relogin'];

function setup(t, o) {
  const sb = H.buildSandbox({ prefix: 'rb-lstatus-' });
  sb.activate();
  if (!o || o.creds !== false) sb.writeCreds();
  t.after(() => sb.cleanup());
  const login = sb.load('caterer-login.js');
  const status = () => sb.readJson('runtime/caterer-status.json');
  return { sb, login, fake: sb.fake, status };
}

function assertShape(s, now) {
  assert.deepEqual(Object.keys(s).sort(), ['detail', 'state', 'updatedAt']);
  assert.ok(STATES.includes(s.state), s.state);
  assert.equal(typeof s.detail, 'string');
  assert.ok(s.detail.length <= 200);
  assert.match(s.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (now !== undefined) assert.equal(s.updatedAt, new Date(now).toISOString());
}

test('a healthy warm session writes state ok at once (no waiting for a supervisor tick)', async (t) => {
  const { sb, login, fake, status } = setup(t);
  fake.warmLoggedIn();
  assert.equal(status(), null, 'nothing before the first check');
  const now = Date.now();
  const r = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r.state, 'ok');
  assertShape(status(), now);
  assert.equal(status().state, 'ok');
  assert.deepEqual(fs.readdirSync(path.join(sb.home, 'runtime')).filter((f) => f.endsWith('.tmp')), [], 'atomic write leaves no temp file');
});

test('a fresh sign-in writes relogin while it runs and ok ("signed in again") when it worked', async (t) => {
  const { login, status } = setup(t);
  const seen = [];
  const now = Date.now();
  const r = await login.ensureLoggedInDetailed({ _now: () => now, log: (l) => { if (/Starting Caterer fresh login/.test(l)) seen.push(status()); } });
  assert.equal(r.state, 'ok');
  assert.equal(r.reloggedIn, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'relogin');
  assertShape(seen[0]);
  assertShape(status(), now);
  assert.deepEqual([status().state, status().detail], ['ok', 'signed in again']);
});

test('safe-list block: safelist_blocked, and it stays that way on the next ticks', async (t) => {
  const { login, fake, status } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  let now = Date.now();
  const r = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r.state, 'safelist');
  assertShape(status(), now);
  assert.deepEqual([status().state, status().detail], ['safelist_blocked', 'SafeListLoginBlocked']);
  now += 16 * 60 * 1000;
  const r2 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r2.state, 'safelist');
  assertShape(status(), now);
  assert.equal(status().state, 'safelist_blocked');
});

test('the emailed link: a stale link keeps safelist_blocked, the newest link writes ok', async (t) => {
  const { login, fake, status } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  await login.ensureLoggedInDetailed();
  const old = await login.openVerificationLink('https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-old');
  assert.equal(old.status, 'safelist');
  assert.equal(status().state, 'safelist_blocked');
  assert.match(status().detail, /did not clear/);
  const good = await login.openVerificationLink('https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-newest');
  assert.equal(good.status, 'ok', good.message);
  assertShape(status());
  assert.equal(status().state, 'ok');
  assert.ok(!JSON.stringify(status()).includes('tok-'), 'a link token never reaches the status file');
});

test('a bad link (not the Caterer verification URL) never touches the status', async (t) => {
  const { login, status } = setup(t);
  const r = await login.openVerificationLink('https://evil.example/login/TwoFaAuthRedirect.aspx?token=1');
  assert.equal(r.status, 'badlink');
  assert.equal(status(), null);
});

test('rejected credentials: login_failed, and login_failed (suppressed) inside the minimum gap', async (t) => {
  const { login, fake, status } = setup(t);
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  let now = Date.now();
  const r = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r.state, 'login');
  assertShape(status(), now);
  assert.deepEqual([status().state, status().detail], ['login_failed', 'LOGIN_FAILED']);
  now += 60 * 1000;
  const r2 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r2.suppressed, 'min-gap');
  assertShape(status(), now);
  assert.deepEqual([status().state, status().detail], ['login_failed', 'sign-in suppressed (min-gap)']);
});

test('unusable credential file: login_failed with the marker, before any browser work', async (t) => {
  const { login, fake, status } = setup(t, { creds: false });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.marker, 'CRED_MISSING');
  assert.deepEqual([status().state, status().detail], ['login_failed', 'CRED_MISSING']);
  assert.equal(fake.counters().submits || 0, 0);
});

test('CV Database module failing while signed in: stale with the module detail (same as the watchdog)', async (t) => {
  const { login, fake, status } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { cvdbModuleError: true } });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'moduleerror');
  assertShape(status());
  assert.deepEqual([status().state, status().detail], ['stale', 'CV Database module error']);
});

test('check only: a signed-out browser is stale (nothing is signed in), a signed-in one is ok', async (t) => {
  const { login, fake, status } = setup(t);
  assert.equal(await login.ensureLoggedIn({ allowRelogin: false }), 'login');
  assertShape(status());
  assert.equal(status().state, 'stale');
  assert.match(status().detail, /check only/);
  assert.equal(fake.counters().submits || 0, 0);
  fake.warmLoggedIn();
  assert.equal(await login.ensureLoggedIn({ allowRelogin: false }), 'ok');
  assert.equal(status().state, 'ok');
});

test('an inconclusive check (real network outage) keeps the last known state instead of guessing', async (t) => {
  const { login, fake, status } = setup(t);
  fake.warmLoggedIn();
  const earlier = Date.now() - 3600 * 1000;
  await login.ensureLoggedInDetailed({ _now: () => earlier });
  const before = status();
  assert.equal(before.state, 'ok');
  fake.scenario({ site: { dnsBroken: true } });
  const r = await login.ensureLoggedInDetailed({ _dns: async () => false });
  assert.equal(r.state, 'error');
  assert.deepEqual(status(), before);
});

test('no credential, username or link token ever reaches the status file', async (t) => {
  const { sb, login, fake } = setup(t);
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  await login.ensureLoggedInDetailed();
  const text = fs.readFileSync(path.join(sb.home, 'runtime', 'caterer-status.json'), 'utf8');
  assert.ok(!text.includes(H.FAKE_CRED.password) && !text.includes(H.FAKE_CRED.username));
});

test('a status file that cannot be written never changes the result or throws', async (t) => {
  const { sb, login, fake } = setup(t);
  fake.warmLoggedIn();
  fs.writeFileSync(path.join(sb.home, 'runtime'), 'not a directory');
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok');
});

test('CLI: the status file appears, and the exit codes and output lines are exactly as before', async (t) => {
  const { sb, fake, status } = setup(t);
  fake.warmLoggedIn();
  let r = sb.run('caterer-login.js', ['--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'SESSION_OK: already signed in');
  assertShape(status());
  assert.equal(status().state, 'ok');

  fake.browser({ loggedIn: false, page: 'login', url: 'https://recruiter.caterer.com/login' });
  r = sb.run('caterer-login.js', ['--check']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^LOGIN_FAILED: not signed in/m);
  assert.equal(status().state, 'stale');

  r = sb.run('caterer-login.js', ['--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(status().state, 'ok');
  assert.equal(status().detail, 'signed in again');
});

test('CLI: safe-list exit 2 writes safelist_blocked, --open-link then writes ok', async (t) => {
  const { sb, fake, status } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  let r = sb.run('caterer-login.js', []);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(status().state, 'safelist_blocked');
  r = sb.run('caterer-login.js', ['--open-link', 'https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-newest']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(status().state, 'ok');
});
