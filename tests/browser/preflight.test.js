'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function setup(t) {
  const sb = H.buildSandbox({ prefix: 'rb-pre-' });
  sb.activate();
  sb.writeCreds();
  t.after(() => sb.cleanup());
  const alerts = () => {
    try { return fs.readFileSync(path.join(sb.home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const pre = (args, env) => sb.run('caterer-preflight.js', args || [], { env });
  return { sb, fake: sb.fake, alerts, pre };
}

test('warm valid session: CATERER_OK, exit 0, summary written, no sign-in', async (t) => {
  const { sb, fake, pre } = setup(t);
  fake.warmLoggedIn();
  const r = pre();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /=== Caterer daily pre-flight ===/);
  assert.match(r.stdout, /Browser: agent-browser 0\.21\.0 \(headless, no display needed\)/);
  assert.match(r.stdout, /CATERER_OK: session already valid, no login needed\./);
  assert.match(r.stdout, /=== Pre-flight complete ===/);
  const s = sb.readJson('runtime/caterer-preflight.json');
  assert.equal(s.caterer.state, 'ok');
  assert.equal(s.exitCode, 0);
  assert.equal(fake.counters().submits || 0, 0);
});

test('cold browser, logged out: fresh login succeeds', async (t) => {
  const { fake, pre } = setup(t);
  const r = pre();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CATERER_OK: fresh login succeeded\./);
  assert.equal(fake.counters().submits, 1);
});

test('safe-list block: marker, exit 2, critical alert', async (t) => {
  const { fake, pre, alerts } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  const r = pre();
  assert.equal(r.status, 2);
  assert.match(r.stdout, /CATERER_SAFELIST_BLOCKED: needs the newest verification link/);
  assert.match(r.stdout, /--open-link/);
  assert.ok(alerts().some((a) => a.severity === 'critical' && a.key === 'caterer-safelist'));
});

test('bad credentials: CATERER_LOGIN_FAILED, exit 3', async (t) => {
  const { fake, pre } = setup(t);
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  const r = pre();
  assert.equal(r.status, 3);
  assert.match(r.stdout, /CATERER_LOGIN_FAILED: LOGIN_FAILED/);
});

test('CV Database module error: CATERER_MODULE_ERROR, exit 4, no sign-in attempted', async (t) => {
  const { fake, pre } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { cvdbModuleError: true } });
  const r = pre();
  assert.equal(r.status, 4);
  assert.match(r.stdout, /CATERER_MODULE_ERROR/);
  assert.equal(fake.counters().submits || 0, 0);
});

test('browser tooling missing: CATERER_BROWSER_MISSING, exit 1, critical alert, nothing else attempted', async (t) => {
  const { sb, pre, alerts } = setup(t);
  const r = pre([], { RESOURCER_AB_BIN: path.join(sb.home, 'no-such-agent-browser') });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CATERER_BROWSER_MISSING/);
  assert.ok(alerts().some((a) => a.severity === 'critical' && a.key === 'caterer-browser-missing'));
});

test('a version other than the pinned build is reported but does not stop the pre-flight', async (t) => {
  const { fake, pre, alerts } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ version: '0.38.1' });
  const r = pre();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AB_VERSION_MISMATCH: found 0\.38\.1/);
  assert.ok(alerts().some((a) => a.key === 'ab-version'));
});

test('keep-alive: signed in => renewed cookies saved; lapsed => informational exit 0 and NO sign-in', async (t) => {
  const { sb, fake, pre } = setup(t);
  fake.warmLoggedIn();
  let r = pre(['--keepalive']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CATERER_KEPT_ALIVE: session signed in, renewed cookies saved/);
  assert.ok(sb.readJson('state/caterer-session.json').cookies.some((c) => c.name === 'AuthCookie'));

  fake.browser({ loggedIn: false, page: 'login', url: 'https://recruiter.caterer.com/login' });
  fake.scenario({ site: { login: { mode: 'success' } } });
  r = pre(['--keepalive']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CATERER_EXPIRED/);
  assert.equal(fake.counters().submits || 0, 0, 'overnight keep-alive never signs in (that would email safe-list links at 2am)');
});

test('Reed steps only run when enabled; success and failure markers and exit codes', async (t) => {
  const { sb, fake, pre, alerts } = setup(t);
  fake.warmLoggedIn();
  const cdp = path.join(sb.scripts, 'ensure-chrome-cdp.js');
  const tok = path.join(sb.scripts, 'reed-refresh-token.js');
  fs.rmSync(cdp, { force: true });
  fs.rmSync(tok, { force: true });
  let r = pre();
  assert.doesNotMatch(r.stdout, /REED_/, 'default RESOURCER_SOURCES=caterer: Reed untouched');

  r = pre(['--reed']);
  assert.equal(r.status, 5, 'enabled but launcher missing');
  assert.match(r.stdout, /REED_FAILED: scripts\/ensure-chrome-cdp\.js is not present/);

  fs.writeFileSync(cdp, "console.log('CDP_READY: up');");
  fs.writeFileSync(tok, "console.log('REED_TOKEN_REFRESHED eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop');");
  r = pre([], { RESOURCER_SOURCES: 'both' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /REED_OK: token refreshed/);
  assert.doesNotMatch(r.stdout, /eyJ/, 'no token material in the output');

  fs.writeFileSync(tok, "console.log('REED_RELOGIN_NEEDED eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop');");
  r = pre(['--reed']);
  assert.equal(r.status, 5);
  assert.match(r.stdout, /REED_FAILED: REED_RELOGIN_NEEDED \*\*\*/);
  assert.ok(alerts().some((a) => a.key === 'reed-preflight'));

  fs.writeFileSync(cdp, 'process.exit(1);');
  r = pre(['--reed']);
  assert.match(r.stdout, /REED_FAILED: browser launcher exit 1/);

  r = pre(['--no-reed'], { RESOURCER_SOURCES: 'both' });
  assert.doesNotMatch(r.stdout, /REED_/);
});

test('a Caterer failure keeps its own exit code even when Reed also fails', async (t) => {
  const { fake, pre } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  const r = pre(['--reed']);
  assert.equal(r.status, 2);
});

test('a session file override that constants.js does not know about is flagged loudly (the cookie helpers would split)', async (t) => {
  const { sb, fake, pre, alerts } = setup(t);
  fake.warmLoggedIn();
  const r = pre([], { CATERER_SESSION_FILE: path.join(sb.home, 'state', 'elsewhere.json') });
  assert.match(r.stdout, /SESSION_FILE_MISMATCH/);
  assert.ok(alerts().some((a) => a.severity === 'critical' && a.key === 'caterer-session-file'));
});

test('--json, --help and usage errors', async (t) => {
  const { fake, pre } = setup(t);
  fake.warmLoggedIn();
  const j = pre(['--json']);
  assert.equal(j.status, 0);
  const last = JSON.parse(j.stdout.trim().split('\n').pop());
  assert.equal(last.mode, 'preflight');
  assert.equal(last.caterer.state, 'ok');
  assert.equal(pre(['--help']).status, 0);
  assert.equal(pre(['--nope']).status, 64);
});
