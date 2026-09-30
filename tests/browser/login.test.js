'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SEARCH = 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch';

function setup(t, o) {
  const sb = H.buildSandbox({ prefix: 'rb-login-' });
  sb.activate();
  if (!o || o.creds !== false) sb.writeCreds();
  t.after(() => sb.cleanup());
  const login = sb.load('caterer-login.js');
  const browser = sb.load('lib/browser.js');
  const alerts = () => {
    try { return fs.readFileSync(path.join(sb.home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const state = () => sb.readJson('runtime/caterer-login-state.json') || {};
  return { sb, login, browser, fake: sb.fake, alerts, state };
}

const cookies = (extra) => [
  { name: '_abck', value: 'fake-fingerprint-abck', domain: '.caterer.com', path: '/', expires: Date.now() / 1000 + 86400 },
  ...(extra || []),
];

test('already signed in (warm): one navigation and a DOM read, nothing else', async (t) => {
  const { sb, login, fake } = setup(t);
  sb.writeSession(cookies());
  fake.warmLoggedIn();
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok');
  assert.equal(r.reloggedIn, false);
  assert.deepEqual(fake.trail().map((x) => x.split(' ')[0]), ['get', 'open', 'wait', 'eval']);
  assert.equal(fake.calls('state').length, 0, 'never state load / save on a healthy warm session');
  assert.ok(!fake.trail().some((x) => x.includes('/login')));
});

test('fresh login from a cold browser with no saved session: fill, submit, verify, save', async (t) => {
  const { sb, login, fake } = setup(t);
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok');
  assert.equal(r.reloggedIn, true);
  const c = fake.counters();
  assert.equal(c.submits, 1);
  assert.equal(c.emptySubmits || 0, 0, 'the React-controlled form actually received the values');
  const saved = sb.readJson('state/caterer-session.json');
  assert.ok(saved.cookies.some((k) => k.name === 'AuthCookie' && k.value), 'session saved after a confirmed login');
  const trail = fake.trail();
  assert.ok(trail.indexOf('open https://recruiter.caterer.com/login') > trail.findIndex((x) => x.startsWith('open ' + SEARCH)), 'check first, then login');
  assert.equal(fake.calls('state').filter((x) => x.argv[3] === 'load').length, 0, 'no saved file, so nothing to load');
});

test('React regression guard: a raw .value= assignment would submit empty fields, the shipped fill script does not', async (t) => {
  const { login, browser, fake } = setup(t);
  await browser.open('https://recruiter.caterer.com/login');
  const raw = "(function(){var u=document.querySelector('[name=username]'),p=document.querySelector('[name=password]');u.value='x';p.value='y';u.dispatchEvent(new Event('input',{bubbles:true}));p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('button[type=submit]').click();return 'done';})()";
  await browser.evalJs(raw);
  assert.equal(fake.counters().emptySubmits, 1, 'the fake reproduces the 2026-07-04 failure mode');
  const r = await login.login({ save: false, restoreState: 'never' });
  assert.equal(r.status, 'ok');
  assert.equal(fake.counters().emptySubmits, 1, 'no further empty submit from the real script');
});

test('form without name attributes (email/password types) is still found', async (t) => {
  const { login, fake } = setup(t);
  fake.scenario({ site: { loginFormVariant: 'email-type' } });
  const r = await login.login({ save: false, restoreState: 'never' });
  assert.equal(r.status, 'ok');
});

test('cold browser + saved session: fingerprint cookies are loaded BEFORE the first navigation, so no safe-list block', async (t) => {
  const { sb, login, fake } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelistUnlessFingerprint' } } });
  sb.writeSession(cookies([{ name: 'AuthCookie', value: '', domain: '.caterer.com', path: '/', expires: 1 }]));
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok', JSON.stringify(r.notes));
  const trail = fake.trail();
  const iLoad = trail.findIndex((x) => x.startsWith('state load'));
  const iOpen = trail.findIndex((x) => x.startsWith('open '));
  assert.ok(iLoad >= 0 && iLoad < iOpen, 'state load precedes every navigation: ' + trail.join(' | '));
  assert.equal(fake.counters().safelistEmails || 0, 0);
});

test('control: cold browser and NO saved session lands on the safe-list (the fake models the 2026-07-01 finding)', async (t) => {
  const { login, fake, alerts } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelistUnlessFingerprint' } } });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'safelist');
  assert.equal(fake.counters().safelistEmails, 1);
  assert.equal(alerts().filter((a) => a.severity === 'critical').length, 1);
});

test('warm browser: the saved state is never loaded (Akamai invalidates a reloaded snapshot)', async (t) => {
  const { sb, login, fake } = setup(t);
  sb.writeSession(cookies());
  fake.browser({ alive: true, page: 'login', url: 'https://recruiter.caterer.com/login', hasFingerprint: true, loggedIn: false });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok');
  assert.equal(fake.calls('state').filter((x) => x.argv[3] === 'load').length, 0);
});

test('safe-list block: critical alert once, no retry, good session file untouched, then recovered with the emailed link', async (t) => {
  const { sb, login, browser, fake, alerts, state } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  const good = { cookies: [{ name: 'GOOD_MARKER', value: '1', domain: '.caterer.com', path: '/' }], origins: [] };
  fs.writeFileSync(sb.sessionFile(), JSON.stringify(good));
  let now = Date.now();
  const r1 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r1.state, 'safelist');
  assert.equal(fake.counters().safelistEmails, 1);
  const a1 = alerts();
  assert.equal(a1.length, 1);
  assert.equal(a1[0].severity, 'critical');
  assert.equal(a1[0].key, 'caterer-safelist');
  assert.match(a1[0].text, /NEWEST/);
  assert.match(a1[0].text, /--open-link/);
  assert.match(a1[0].text, /TwoFaAuthRedirect/);
  assert.deepEqual(sb.readJson('state/caterer-session.json').cookies.map((c) => c.name), ['GOOD_MARKER'], 'no save from the block page');

  // next ticks (runner back-off is 15 min): still blocked, no new login attempt, no alert spam
  now += 16 * 60 * 1000;
  const r2 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r2.state, 'safelist');
  assert.equal(fake.counters().safelistEmails, 1, 'no second sign-in attempt (each one emails a new link)');
  assert.equal(alerts().length, 1, 'deduped');
  // hours later (cooldown over) one more attempt is allowed and the alert is repeated
  now += 3.5 * 60 * 60 * 1000;
  await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(alerts().length, 2);
  assert.equal(fake.counters().safelistEmails, 2);

  // operator opens the newest link in the same session
  const link = 'https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-newest';
  const rr = await login.openVerificationLink(link);
  assert.equal(rr.status, 'ok', rr.message);
  assert.doesNotMatch(rr.message, /tok-newest/, 'the token is never echoed');
  assert.ok(sb.readJson('state/caterer-session.json').cookies.some((c) => c.name === 'AuthCookie'));
  assert.equal(state().safelist, null);
  assert.ok(alerts().some((a) => a.severity === 'info' && a.key === 'caterer-safelist-cleared'));
  assert.equal(await login.ensureLoggedIn(), 'ok');
  void browser;
});

test('a stale (older) link does not clear the block and reports it', async (t) => {
  const { login, fake } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  await login.ensureLoggedInDetailed();
  const rr = await login.openVerificationLink('https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-old');
  assert.equal(rr.status, 'safelist');
  assert.equal(rr.exitCode, 2);
  assert.equal(fake.counters().staleTokens, 1);
});

test('recovery link validation: wrong host, wrong path, not a URL never reach the browser', async (t) => {
  const { login, fake } = setup(t);
  for (const bad of ['https://evil.example/login/TwoFaAuthRedirect.aspx?token=1', 'https://recruiter.caterer.com/Home/1', 'http://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=1', 'nonsense', '']) {
    const r = await login.openVerificationLink(bad);
    assert.equal(r.status, 'badlink', bad);
    assert.equal(r.exitCode, 64);
  }
  assert.equal(fake.calls().length, 0);
});

test('safe-list cooldown: after the browser restarts, no fresh login attempt until the cooldown passed', async (t) => {
  const { login, fake, state } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  let now = Date.now();
  await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(fake.counters().safelistEmails, 1);
  await login.ensureLoggedInDetailed({ _now: () => now }); // browser closed/restarted below
  const cli = require('child_process');
  void cli;
  fake.browser({ alive: false });
  now += 20 * 60 * 1000;
  const r = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r.state, 'safelist');
  assert.equal(r.suppressed, 'safelist-cooldown');
  assert.equal(fake.counters().safelistEmails, 1);
  fake.browser({ alive: false });
  now += 50 * 60 * 1000;
  const r2 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r2.state, 'safelist');
  assert.equal(fake.counters().safelistEmails, 2, 'one more attempt after the cooldown');
  assert.equal(state().safelist.attempts, 2);
});

test('bad password: one attempt, then a minimum gap; three failures pause automatic attempts and alert critically; --force bypasses', async (t) => {
  const { login, fake, alerts, state } = setup(t);
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  let now = Date.now();
  const r1 = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r1.state, 'login');
  assert.equal(r1.marker, 'LOGIN_FAILED');
  assert.equal(fake.counters().submits, 1);
  assert.equal(state().consecutiveFailures, 1);
  assert.equal(alerts()[0].severity, 'warn');

  now += 60 * 1000;
  const r1b = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(r1b.suppressed, 'min-gap');
  assert.equal(fake.counters().submits, 1, 'no second submit within 10 minutes');

  now += 11 * 60 * 1000;
  await login.ensureLoggedInDetailed({ _now: () => now });
  now += 11 * 60 * 1000;
  await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(fake.counters().submits, 3);
  assert.ok(state().holdUntil);
  assert.ok(alerts().some((a) => a.severity === 'critical' && a.key === 'caterer-login-failed'));

  now += 30 * 60 * 1000;
  const held = await login.ensureLoggedInDetailed({ _now: () => now });
  assert.equal(held.suppressed, 'hold');
  assert.equal(fake.counters().submits, 3, 'held: the account is protected');

  const forced = await login.ensureLoggedInDetailed({ _now: () => now, force: true });
  assert.equal(forced.state, 'login');
  assert.equal(fake.counters().submits, 4, '--force is the operator override');
});

test('a failed login never overwrites the last good session file', async (t) => {
  const { sb, login, fake } = setup(t);
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  const good = JSON.stringify({ cookies: [{ name: 'GOOD_MARKER' }], origins: [] });
  fs.writeFileSync(sb.sessionFile(), good);
  await login.ensureLoggedInDetailed();
  assert.equal(fs.readFileSync(sb.sessionFile(), 'utf8'), good);
});

test('credentials: missing / invalid / placeholder are refused before any login work', async (t) => {
  for (const [label, setupCreds, marker] of [
    ['missing', () => {}, 'CRED_MISSING'],
    ['invalid json', (sb) => { fs.mkdirSync(path.join(sb.home, 'secrets'), { recursive: true }); fs.writeFileSync(path.join(sb.home, 'secrets', 'caterer-credentials.json'), '{not json'); }, 'CRED_INVALID'],
    ['placeholder', (sb) => sb.writeCreds({ username: 'fake.user@example.invalid', password: '<new password here>' }), 'CRED_PLACEHOLDER'],
  ]) {
    const { sb, login, fake } = setup(t, { creds: false });
    setupCreds(sb);
    const r = await login.login({ restoreState: 'never' });
    assert.equal(r.status, 'cred', label);
    assert.equal(r.marker, marker, label);
    assert.equal(r.exitCode, 3);
    assert.equal(fake.calls().length, 0, label + ': the browser was never touched');
  }
});

test('an unusable credential file raises one critical alert and the ensure flow reports login', async (t) => {
  const { login, fake, alerts } = setup(t, { creds: false });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'login');
  assert.equal(r.marker, 'CRED_MISSING');
  assert.equal(alerts().filter((a) => a.key === 'caterer-cred' && a.severity === 'critical').length, 1);
  await login.ensureLoggedInDetailed();
  assert.equal(alerts().filter((a) => a.key === 'caterer-cred').length, 1, 'deduped');
  assert.equal(fake.counters().submits || 0, 0);
});

test('the password never appears in output, notes, alerts or the state file', async (t) => {
  const { sb, login, fake, alerts } = setup(t);
  const lines = [];
  fake.scenario({ site: { login: { mode: 'badpassword' } } });
  const r = await login.ensureLoggedInDetailed({ log: (l) => lines.push(l) });
  const blob = JSON.stringify([lines, r, alerts(), sb.readJson('runtime/caterer-login-state.json')]);
  assert.ok(!blob.includes(H.FAKE_CRED.password));
  assert.ok(!blob.includes(H.FAKE_CRED.username));
  const fillScript = fake.calls('eval').map((c) => c.script).find((s) => s && s.includes('FILLED'));
  assert.ok(fillScript.includes(JSON.stringify(H.FAKE_CRED.password)), 'embedded as a JSON string literal');
});

test('credentials with quotes, backslashes and unicode survive the embedding', async (t) => {
  const { sb, login, fake } = setup(t);
  const odd = { username: "o'brien\\user@example.invalid", password: 'p"a\\ss\'w\u00e9$' + '`${x}' };
  sb.writeCreds(odd);
  const r = await login.login({ save: false, restoreState: 'never' });
  assert.equal(r.status, 'ok', 'a wrong embedding would submit different text and the fake would reject it');
  assert.equal(fake.counters().badLogins || 0, 0);
});

test('CV Database module failing while signed in: reported as moduleerror, never a re-login', async (t) => {
  const { login, fake, alerts } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { cvdbModuleError: true } });
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'moduleerror');
  assert.ok(!fake.trail().some((x) => x.startsWith('open https://recruiter.caterer.com/login')), 'no sign-in page visit');
  assert.equal(fake.counters().submits || 0, 0);
  assert.equal(alerts().filter((a) => a.key === 'caterer-cvdb-module').length, 1);
  await login.ensureLoggedInDetailed();
  assert.equal(alerts().filter((a) => a.key === 'caterer-cvdb-module').length, 1, 'deduped');
  assert.deepEqual(fake.trail().filter((x) => x.startsWith('open ')).slice(0, 2), ['open ' + SEARCH, 'open https://recruiter.caterer.com/Home']);
});

test('module error page reached with a logged-out session is a login problem, not a module problem', async (t) => {
  const { login, fake } = setup(t);
  fake.scenario({ site: { cvdbModuleError: true } });
  const r = await login.ensureLoggedInDetailed({ allowRelogin: false });
  assert.equal(r.state, 'login');
});

test('unknown probe answer still triggers the one self-heal (legacy 2026-06-07 rule)', async (t) => {
  const { login, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'eval', scriptIncludes: 'SAFELIST', nth: 1 }, do: { stdout: '"???"', code: 0 } }] });
  fake.warmLoggedIn();
  const r = await login.ensureLoggedInDetailed();
  assert.equal(r.state, 'ok');
  assert.equal(r.reloggedIn, true, 'attempted a sign-in on an unconfirmed session');
});

test('login page that redirects an already signed-in browser is recognised without filling anything', async (t) => {
  const { login, fake } = setup(t);
  fake.warmLoggedIn();
  const r = await login.login({ save: false, restoreState: 'never' });
  assert.equal(r.status, 'ok');
  assert.equal(fake.calls('eval').length, 0, 'no form eval at all');
});

test('check-only mode never signs in', async (t) => {
  const { login, fake } = setup(t);
  assert.equal(await login.ensureLoggedIn({ allowRelogin: false }), 'login');
  assert.equal(fake.counters().submits || 0, 0);
  assert.ok(!fake.trail().some((x) => x.startsWith('open https://recruiter.caterer.com/login')));
});

test('stale backend after an outage: browser cannot resolve names but this host can => reset once, then recover', async (t) => {
  const { login, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { dnsBroken: true, dnsBrokenUntilClose: true } });
  const r = await login.ensureLoggedInDetailed({ _dns: async () => true });
  assert.ok(fake.calls('close').length === 1, 'browser reset');
  assert.equal(r.state, 'ok');
  assert.ok(r.reloggedIn, 'reset browser is cold and signed out, so it signs in again');
});

test('real network outage (name resolution fails here too): report error, do not touch the browser backend', async (t) => {
  const { login, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { dnsBroken: true } });
  const r = await login.ensureLoggedInDetailed({ _dns: async () => false });
  assert.equal(r.state, 'error');
  assert.match(r.detail, /network unreachable/);
  assert.equal(fake.calls('close').length, 0);
});

test('browser reset is rate limited (once per 30 minutes)', async (t) => {
  const { login, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { dnsBroken: true } });
  let now = Date.now();
  await login.ensureLoggedInDetailed({ _dns: async () => true, _now: () => now });
  assert.equal(fake.calls('close').length, 1);
  await login.ensureLoggedInDetailed({ _dns: async () => true, _now: () => now + 60000 });
  assert.equal(fake.calls('close').length, 1, 'second reset suppressed');
  await login.ensureLoggedInDetailed({ _dns: async () => true, _now: () => now + 31 * 60000 });
  assert.equal(fake.calls('close').length, 2);
});

test('landing on an unexpected page after submit is a failure, not a success', async (t) => {
  const { sb, login, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { stdout: 'about:blank', code: 0 } }] });
  fake.warmLoggedIn();
  fake.browser({ loggedIn: false, page: 'blank', url: 'about:blank' });
  const before = fs.existsSync(sb.sessionFile());
  const r = await login.login({ save: true, restoreState: 'never' });
  assert.equal(r.status, 'failed');
  assert.equal(fs.existsSync(sb.sessionFile()), before);
});

// ---------------------------------------------------------------- CLI

function cli(sb, args, opts) { return sb.run('caterer-login.js', args, opts); }

test('CLI: --help, bad option, exit codes and markers', async (t) => {
  const { sb, fake } = setup(t);
  let r = cli(sb, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node scripts\/caterer-login\.js/);
  r = cli(sb, ['--bogus']);
  assert.equal(r.status, 64);
  fake.warmLoggedIn();
  r = cli(sb, ['--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SESSION_OK/);
  fake.browser({ loggedIn: false, page: 'login', url: 'https://recruiter.caterer.com/login' });
  r = cli(sb, ['--check']);
  assert.equal(r.status, 3);
  r = cli(sb, ['--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Login complete/);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(j.state, 'ok');
  assert.ok(!r.stdout.includes(H.FAKE_CRED.password) && !r.stderr.includes(H.FAKE_CRED.password));
});

test('CLI: safe-list exit 2 with marker; module error exit 4; open-link exit codes', async (t) => {
  const { sb, fake } = setup(t);
  fake.scenario({ site: { login: { mode: 'safelist' } } });
  let r = cli(sb, []);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /SAFELIST_BLOCKED/);
  r = cli(sb, ['--open-link', 'https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-newest']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SAFELIST_CLEARED/);
  assert.ok(!r.stdout.includes('tok-newest'));
  r = cli(sb, ['--open-link', '-'], { input: 'https://recruiter.caterer.com/login/TwoFaAuthRedirect.aspx?token=tok-old\n' });
  assert.equal(r.status, 2);
  r = cli(sb, ['--open-link', 'https://x.invalid/']);
  assert.equal(r.status, 64);
  fake.scenario({ site: { cvdbModuleError: true } });
  fake.warmLoggedIn();
  r = cli(sb, []);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /CATERER_MODULE_ERROR/);
});

test('CLI: credentials problems print the legacy markers and exit 3 without opening a browser', async (t) => {
  const { sb, fake } = setup(t, { creds: false });
  const r = cli(sb, ['--force']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /CRED_MISSING/);
  assert.equal(fake.calls().filter((c) => c.cmd !== 'get').length, 0, 'only the cold-probe at most, no navigation');
});
