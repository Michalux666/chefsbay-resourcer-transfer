'use strict';

// Login/token flow: automatic login on the Chrome-153 surface, Turnstile block -> human-assisted login, credentials hygiene.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn } = require('child_process');
const { withWorld, writeCreds } = require('./helpers/world');

const EMAIL = 'reed.test.user@example.invalid';
const PASSWORD = 'Pw-SENTINEL-1234';

function everything(m, r) {
  let extra = '';
  for (const rel of ['outbox/alerts.jsonl', 'runtime/reed-login-block.json', 'state/reed-session.json']) {
    try { extra += fs.readFileSync(m.p(rel), 'utf8'); } catch { /* absent */ }
  }
  return `${r.stdout}\n${r.stderr}\n${extra}`;
}
function assertNoSecrets(m, r, token) {
  const all = everything(m, r);
  assert.ok(!all.includes(PASSWORD), 'password must never be printed or stored');
  if (token) {
    const noSession = `${r.stdout}\n${r.stderr}`;
    assert.ok(!noSession.includes(token), 'token must never be printed');
  }
}
const alerts = (m) => m.readLines('outbox/alerts.jsonl');
const loginTabs = (fake) => [...fake.tabs.values()].filter((t) => t.page.kind === 'login');

test('--check-credentials: missing file, placeholder values, alias field, valid file', () => withWorld(async ({ m, run }) => {
  let r = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.strictEqual(r.code, 3);
  assert.match(r.stdout, /^REED_CRED_MISSING: /);
  m.write('secrets/reed-credentials.json', { email: 'CHANGE_ME', password: 'x' });
  r = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.strictEqual(r.code, 3);
  assert.match(r.stdout, /^REED_CRED_INVALID: /);
  m.write('secrets/reed-credentials.json', { email: EMAIL });
  r = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.match(r.stdout, /^REED_CRED_MISSING: /);
  m.write('secrets/reed-credentials.json', '{ this is not json');
  r = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.match(r.stdout, /^REED_CRED_MISSING: /);
  m.write('secrets/reed-credentials.json', { username: EMAIL, password: PASSWORD });
  r = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^REED_CRED_OK$/m);
  assertNoSecrets(m, r);
}));

test('missing credentials: exit 3, no browser touched', () => withWorld(async ({ m, fake, run }) => {
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 3);
  assert.match(r.stdout, /REED_CRED_MISSING/);
  assert.strictEqual(fake.calls.length, 0);
  assertNoSecrets(m, r);
}));

test('automatic login (single-page form): token captured without request interception, session saved, tab left on the search page', () => withWorld(async ({ m, fake, run }) => {
  writeCreds(m);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /^REED_LOGIN_OK expires=\d{4}-/m);
  const s = m.readJson('state/reed-session.json');
  assert.ok(fake.site.tokens.has(s.accessToken));
  assert.ok(!fake.methods().includes('Network.setRequestInterception'));
  assert.strictEqual(fake.site.loggedIn, true);
  const search = [...fake.tabs.values()].filter((t) => t.page.kind === 'search');
  assert.strictEqual(search.length, 1, 'exactly one tab left on the search page');
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  assert.strictEqual(alerts(m).length, 0);
  assert.strictEqual(m.readJson('runtime/reed-status.json').state, 'ok');
  assertNoSecrets(m, r, s.accessToken);
}));

test('automatic login (two-step identifier-first form)', () => withWorld(async ({ m, fake, run }) => {
  fake.site.twoStep = true;
  writeCreds(m);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /REED_LOGIN_OK/);
  assert.strictEqual(fake.site.loggedIn, true);
  assertNoSecrets(m, r);
}));

test('a profile that is already logged in skips the form and just captures the token', () => withWorld(async ({ m, fake, run }) => {
  fake.site.loggedIn = true;
  writeCreds(m);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /Already logged in/);
  assertNoSecrets(m, r);
}));

test('stale secure-recruiter tabs are swept but the last page is never closed', () => withWorld(async ({ m, fake, run }) => {
  fake.addTab('https://secure-recruiter.reed.co.uk/login?old=1');
  fake.addTab('https://secure-recruiter.reed.co.uk/u/login?old=2');
  writeCreds(m);
  const before = fake.tabs.size;
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /Sweeping/);
  assert.ok(fake.tabs.size >= 1 && fake.tabs.size <= before, 'stale tabs removed, at least the new search tab remains');
}));

test('Turnstile block: critical notify with the exact human-login command, block file, exit 1, tab closed, credentials never leak', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_LOGIN_BLOCKED_TURNSTILE: /m);
  assert.strictEqual(fake.site.loggedIn, false);
  assert.strictEqual(fake.methods().includes('Network.setRequestInterception'), false);
  const a = alerts(m);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.strictEqual(a[0].key, 'reed-human-login');
  assert.match(a[0].text, /^Reed needs a one-time human login\./);
  assert.ok(a[0].text.includes(`cd ${m.home} && node scripts/cdp-reed-full-login.js --human`), a[0].text);
  const block = m.readJson('runtime/reed-login-block.json');
  assert.ok(block && block.blockedAt && block.reason);
  const st = m.readJson('runtime/reed-status.json');
  assert.strictEqual(st.state, 'auth_failed');
  assert.match(st.detail, /human login required/);
  assert.strictEqual(loginTabs(fake).filter((t) => t.url.includes('login')).length <= 1, true);
  assertNoSecrets(m, r);
}));

test('never loops: a second automatic attempt is refused from the block file (no browser calls, no second alert), --ignore-block retries', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  await run('cdp-reed-full-login.js', []);
  const callsAfterFirst = fake.calls.length;
  const t0 = Date.now();
  const r2 = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r2.code, 1);
  assert.match(r2.stdout, /^REED_LOGIN_BLOCKED_TURNSTILE: human login pending/m);
  assert.strictEqual(fake.calls.length, callsAfterFirst, 'no CDP traffic on a blocked retry');
  assert.strictEqual(alerts(m).length, 1, 'no alert storm');
  assert.ok(Date.now() - t0 < 5000);
  const r3 = await run('cdp-reed-full-login.js', ['--ignore-block']);
  assert.strictEqual(r3.code, 1);
  assert.ok(fake.calls.length > callsAfterFirst);
  assert.strictEqual(m.readJson('runtime/reed-login-block.json').attempts, 2);
}));

test('the human-login alert is once per EPISODE: not again after the retry window expires or with --ignore-block, again only after a login succeeded', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  const n = () => alerts(m).filter((a) => a.key === 'reed-human-login' && a.severity === 'critical').length;
  await run('cdp-reed-full-login.js', []);
  assert.strictEqual(n(), 1);
  // the 12 h retry window passes, the automatic attempt is blocked again: same episode, no second page to the operator
  const b = m.readJson('runtime/reed-login-block.json');
  m.write('runtime/reed-login-block.json', { ...b, blockedAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString() });
  const again = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(again.code, 1);
  assert.match(again.stdout, /REED_LOGIN_BLOCKED_TURNSTILE: turnstile_/);
  assert.doesNotMatch(again.stdout, /human login pending/, 'the window had expired, so a real attempt was made');
  assert.strictEqual(n(), 1, 'the block was re-recorded without a new alert');
  assert.ok(Date.now() - Date.parse(m.readJson('runtime/reed-login-block.json').blockedAt) < 60000, 'the retry window restarted');
  await run('cdp-reed-full-login.js', ['--ignore-block']);
  assert.strictEqual(n(), 1);
  // a successful login ends the episode ...
  fake.site.mode = 'ok';
  const ok = await run('cdp-reed-full-login.js', ['--ignore-block']);
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  // ... so the next block is a new episode
  fake.site.mode = 'turnstile';
  await run('cdp-reed-full-login.js', ['--clean']);
  assert.strictEqual(n(), 2);
}));

test('a forgotten episode is reminded after REED_ALERT_REMIND_HOURS (72 h by default), never when the reminder is switched off', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  const n = () => alerts(m).filter((a) => a.key === 'reed-human-login').length;
  const old = { 'reed-human-login': { at: new Date(Date.now() - 100 * 3600 * 1000).toISOString() } };
  m.write('runtime/reed-alert-episodes.json', old);
  await run('cdp-reed-full-login.js', [], { env: { REED_ALERT_REMIND_HOURS: '0' } });
  assert.strictEqual(n(), 0, 'reminders off: an old episode stays silent');
  fs.unlinkSync(m.p('runtime/reed-login-block.json'));
  await run('cdp-reed-full-login.js', []);
  assert.strictEqual(n(), 1, 'reminder after 100 h');
  const eps = m.readJson('runtime/reed-alert-episodes.json');
  assert.ok(Date.now() - Date.parse(eps['reed-human-login'].at) < 60000, 'the reminder restarts the clock');
}));

test('missing credentials raise ONE critical alert with the file schema and the check command; a valid file ends the episode and lifts its marker', () => withWorld(async ({ m, run }) => {
  const n = () => alerts(m).filter((a) => a.key === 'reed-credentials').length;
  for (let i = 0; i < 3; i++) assert.strictEqual((await run('cdp-reed-full-login.js', [])).code, 3);
  assert.strictEqual(n(), 1);
  const a = alerts(m).find((x) => x.key === 'reed-credentials');
  assert.strictEqual(a.severity, 'critical');
  assert.ok(a.text.includes(require('path').join('secrets', 'reed-credentials.json')));
  assert.ok(a.text.includes(`cd ${m.home} && node scripts/cdp-reed-full-login.js --check-credentials`));
  assert.ok(!a.text.includes(PASSWORD));
  assert.strictEqual(m.readJson('runtime/reed-status.json').state, 'auth_failed');
  m.write('runtime/reed-auth-failed.marker', { reason: 'reed_credentials_missing', failedAt: new Date().toISOString() });
  writeCreds(m);
  const chk = await run('cdp-reed-full-login.js', ['--check-credentials']);
  assert.strictEqual(chk.code, 0);
  assert.strictEqual(m.exists('runtime/reed-auth-failed.marker'), false, 'the credentials marker is lifted by a valid check');
  fs.unlinkSync(m.p('secrets/reed-credentials.json'));
  await run('cdp-reed-full-login.js', []);
  assert.strictEqual(n(), 2, 'after the fix a new problem is a new episode');
}));

test('an expired block window allows a new automatic attempt', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'ok';
  writeCreds(m);
  m.write('runtime/reed-login-block.json', { blockedAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString(), reason: 'turnstile_unsolved', attempts: 1 });
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false, 'success clears the block');
}));

test('Turnstile that only appears after submit, and a Cloudflare interstitial without a form, are both blocks', () => withWorld(async ({ m, fake, run }) => {
  writeCreds(m);
  fake.site.mode = 'turnstile-after-submit';
  let r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /BLOCKED_TURNSTILE: turnstile_after_submit/);
  fs.unlinkSync(m.p('runtime/reed-login-block.json'));
  fake.site.mode = 'interstitial';
  r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /BLOCKED_TURNSTILE: turnstile_challenge_before_form/);
}));

test('rejected credentials: REED_LOGIN_FAILED, no block, no alert, exit 1', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'reject';
  writeCreds(m);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_LOGIN_FAILED: /m);
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  assert.strictEqual(alerts(m).length, 0);
  assertNoSecrets(m, r);
}));

test('a live Caterer browser run blocks the login (exit 4), the browser is not touched', () => withWorld(async ({ m, fake, run }) => {
  writeCreds(m);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    m.write('runtime/browser.lock', { owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() });
    const r = await run('cdp-reed-full-login.js', []);
    assert.strictEqual(r.code, 4);
    assert.match(r.stdout, /REED_LOGIN_FAILED: browser\.lock held by caterer/);
    assert.strictEqual(fake.calls.length, 0);
  } finally { holder.kill(); }
}));

test('human mode: prints the operator instructions, waits, captures the token after the human logs in, clears the block, notifies', () => withWorld(async ({ m, fake, env }) => {
  fake.site.mode = 'turnstile';
  writeCreds(m);
  m.write('runtime/reed-login-block.json', { blockedAt: new Date().toISOString(), reason: 'turnstile_unsolved', attempts: 1 });
  const child = spawn(process.execPath, [m.p('scripts', 'cdp-reed-full-login.js'), '--human', '--wait-min', '1'], { cwd: m.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !loginTabs(fake).some((t) => t.url.startsWith('https://secure-recruiter.reed.co.uk/login'))) await new Promise((r) => setTimeout(r, 50));
  assert.ok(loginTabs(fake).length >= 1, 'human mode opens the login page in the Reed browser');
  await new Promise((r) => setTimeout(r, 300));
  fake.humanLogin();
  const code = await done;
  assert.strictEqual(code, 0, stderr);
  assert.match(stdout, /^REED_LOGIN_OK expires=/m);
  assert.ok(stdout.includes(`cd ${m.home} && node scripts/cdp-reed-full-login.js --human`));
  assert.ok(stdout.includes(`ssh -N -L ${fake.cdpPort}:127.0.0.1:${fake.cdpPort}`));
  assert.ok(stdout.includes('chrome://inspect'));
  assert.ok(fake.site.tokens.has(m.readJson('state/reed-session.json').accessToken));
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  assert.ok(alerts(m).some((a) => a.severity === 'info' && /human login completed/i.test(a.text)));
  assert.strictEqual(m.exists('runtime/browser.lock'), false, 'lock released');
  assert.ok(![...stdout].join('').includes(PASSWORD));
}));

test('human mode times out cleanly (exit 1, no loop)', () => withWorld(async ({ m, fake, run }) => {
  fake.site.mode = 'turnstile';
  const r = await run('cdp-reed-full-login.js', ['--human', '--wait-min', '0.03'], { timeoutMs: 30000 });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /REED_LOGIN_FAILED: human_login_timeout/);
  assert.strictEqual(m.exists('runtime/browser.lock'), false);
}));

test('the page-side scripts embed credentials as JSON string literals (quotes and script-breaking characters survive)', () => withWorld(async ({ m, fake, run }) => {
  fake.site.creds = { email: 'o\'brien"x@example.invalid', password: `pa${String.fromCharCode(92)}ss"'</script>\${x}` + '`' };
  m.write('secrets/reed-credentials.json', fake.site.creds, 0o600);
  const r = await run('cdp-reed-full-login.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(fake.site.loggedIn, true);
}));

test('--clean clears the Reed/Auth0 cookies and storage first (HTTP 451 recovery), then logs in again and prints the token ip claim', () => withWorld(async ({ m, fake, run }) => {
  fake.site.loggedIn = true;
  fake.site.tokenClaims = { 'https://www.reed.co.uk/api/auth/ip': '203.0.113.7' };
  writeCreds(m);
  const oldTok = fake.site.issueToken();
  m.write('state/reed-session.json', { accessToken: oldTok, refreshToken: null, expiresAt: Math.floor(Date.now() / 1000) + 1500 });
  const r = await run('cdp-reed-full-login.js', ['--clean']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /^REED_LOGIN_OK expires=\S+ ip=203\.0\.113\.7$/m);
  assert.strictEqual(fake.methods().filter((x) => x === 'Network.getCookies').length, 1);
  assert.strictEqual(fake.methods().filter((x) => x === 'Network.deleteCookies').length, 3);
  assert.match(r.stderr, /Cleared 3 Reed\/Auth0 cookies/);
  assert.strictEqual(fake.site.loggedIn, true, 'logged in again through the form');
  assert.notStrictEqual(m.readJson('state/reed-session.json').accessToken, oldTok);
  assertNoSecrets(m, r);
}));

test('--clean on a Turnstile-blocked login leaves no stale session behind and still raises the human-login alert', () => withWorld(async ({ m, fake, run }) => {
  fake.site.loggedIn = true;
  fake.site.mode = 'turnstile';
  writeCreds(m);
  m.write('state/reed-session.json', { accessToken: fake.site.issueToken(), refreshToken: null, expiresAt: Math.floor(Date.now() / 1000) + 1500 });
  const r = await run('cdp-reed-full-login.js', ['--clean']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(m.exists('state/reed-session.json'), false);
  assert.strictEqual(alerts(m).filter((a) => a.key === 'reed-human-login').length, 1);
}));

test('human mode with --clean clears the session before waiting for the human', () => withWorld(async ({ m, fake, env }) => {
  fake.site.mode = 'turnstile';
  const child = spawn(process.execPath, [m.p('scripts', 'cdp-reed-full-login.js'), '--human', '--clean', '--wait-min', '1'], { cwd: m.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(fake.site.loggedIn === false && loginTabs(fake).some((t) => t.url === 'https://secure-recruiter.reed.co.uk/login'))) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fake.site.loggedIn, false, 'cookies were cleared before the login page opened');
  await new Promise((r) => setTimeout(r, 300));
  fake.humanLogin();
  assert.strictEqual(await done, 0, stdout);
  assert.match(stdout, /^REED_LOGIN_OK /m);
}), { fake: { loggedIn: true } });
