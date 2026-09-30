'use strict';

// OFFLINE acceptance test against a REAL Chromium under the real xvfb-run. Nothing leaves the machine: the browser resolves only
// *.reed.co.uk (to 127.0.0.1, a local stand-in site with real HTML forms) and fails every other host name.
//
//   REED_REAL_CHROMIUM=/usr/bin/chromium node --test tests/reed/real-chromium.test.js
//
// Skipped unless REED_REAL_CHROMIUM points at a chromium/chrome binary on Linux with xvfb-run. It exercises what the fake CDP cannot:
// the real Network.requestWillBeSent shapes of this Chromium build, real DOM form filling, cookies, the CORS-bound in-page fetch,
// the real process title in /proc, and whole-tree shutdown.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeMirror } = require('./helpers/mirror');
const { startFakeReed } = require('./helpers/fake-reed');
const { startLocalReedSite } = require('./helpers/local-reed-site');

const REAL = process.env.REED_REAL_CHROMIUM || '';
const hasXvfb = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run && command -v Xvfb && command -v xauth']).status === 0;
const SKIP = REAL && hasXvfb && fs.existsSync(REAL) ? false : 'set REED_REAL_CHROMIUM=<chromium binary> (Linux with xvfb-run) to run the real-browser acceptance test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { xvfbOrphans } = require('./helpers/procs');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function reedProcs(profile) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try { if (`${fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').join(' ')} `.includes(`--user-data-dir=${profile} `)) out.push(Number(n)); } catch { /* gone */ }
  }
  return out;
}

async function world(mode, extraEnv, siteOpts) {
  const m = makeMirror();
  const fake = await startFakeReed({ initialTab: false });
  const site = await startLocalReedSite({ fake, mode, ...(siteOpts || {}) });
  const wrapper = m.write('chromium-wrapper', `#!/bin/sh\nexec "${REAL}" "$@" --host-resolver-rules="MAP *.reed.co.uk 127.0.0.1, MAP * ~NOTFOUND" --disable-background-networking --disable-component-update --disable-sync\n`, 0o755);
  const port = await freePort();
  const env = {
    CHROMIUM_PATH: wrapper, REED_CDP_PORT: String(port), REED_CDP_TRUST_EXISTING: '0', REED_CDP_WAIT_S: '60', REED_CDP_POLL_MS: '250',
    REED_TARGET_URL: site.targetUrl, REED_LOGIN_URL: site.loginUrl, REED_API_BASE: site.apiBase, REED_AUTO_RELAUNCH: '1',
    REED_LOGIN_TIME_SCALE: '0.5', REED_CAPTURE_TIMEOUT_MS: '20000', REED_CDP_COMMAND_TIMEOUT_MS: '20000', REED_LAUNCH_TIMEOUT_MS: '90000',
    ...(extraEnv || {}),
  };
  const profile = m.p('state', 'chrome-reed');
  const run = (script, args, o) => m.run(script, args, { ...(o || {}), env: { ...env, ...((o && o.env) || {}) }, timeoutMs: 180000 });
  const drive = async (code) => {
    const name = `_drv-${Math.random().toString(36).slice(2)}.js`;
    m.write(`scripts/${name}`, `'use strict';\n(async () => {\n${code}\n})().then((r) => { process.stdout.write(String.fromCharCode(10) + 'RESULT:' + JSON.stringify(r === undefined ? null : r) + String.fromCharCode(10)); process.exit(0); }).catch((e) => { process.stdout.write(String.fromCharCode(10) + 'ERROR:' + JSON.stringify({ message: e.message }) + String.fromCharCode(10)); process.exit(1); });\n`);
    const r = await run(name, []);
    const rm = r.stdout.match(/^RESULT:(.*)$/m);
    return { ok: !!rm, result: rm ? JSON.parse(rm[1]) : undefined, stdout: r.stdout, stderr: r.stderr };
  };
  const stop = () => spawnSync(process.execPath, [m.p('scripts', 'ensure-chrome-cdp.js'), '--stop', '--force'], { env: m.env(env) });
  const cleanup = async () => { stop(); await site.close(); await fake.close(); m.cleanup(); };
  return { m, fake, site, env, profile, run, drive, stop, cleanup };
}
const creds = (w) => w.m.write('secrets/reed-credentials.json', w.fake.site.creds, 0o600);

test('real Chromium: launch, logged-out refresh fails cleanly, automatic login works on real form markup (plain, two-step, state-driven)', { skip: SKIP }, async () => {
  for (const mode of ['ok', 'twostep', 'react']) {
    const w = await world(mode, { REED_CAPTURE_TIMEOUT_MS: '6000' });
    try {
      creds(w);
      const before = await w.run('reed-refresh-token.js', ['--force']);
      assert.strictEqual(before.code, 1, before.stderr);
      assert.match(before.stdout, /REED_RELOGIN_NEEDED/);
      assert.ok(reedProcs(w.profile).length > 0, 'the launcher started a real browser');
      const login = await w.run('cdp-reed-full-login.js', []);
      assert.strictEqual(login.code, 0, `${mode}: ${login.stdout}${login.stderr}`);
      assert.match(login.stdout, /^REED_LOGIN_OK /m);
      const s = w.m.readJson('state/reed-session.json');
      assert.ok(w.fake.site.tokens.has(s.accessToken), 'the token was captured from the real page request');
      assert.ok(!(login.stdout + login.stderr).includes(s.accessToken));
      assert.ok(!(login.stdout + login.stderr).includes(w.fake.site.creds.password));
      const after = await w.run('reed-refresh-token.js', ['--force']);
      assert.strictEqual(after.code, 0, `${mode}: ${after.stdout}${after.stderr}`);
      assert.match(after.stdout, /REED_TOKEN_REFRESHED/);
      assert.notStrictEqual(w.m.readJson('state/reed-session.json').accessToken, s.accessToken, 'a fresh token was captured');
    } finally { await w.cleanup(); }
  }
});

test('real Chromium: the API proxy runs in the page (CORS, Authorization, binary via btoa) and the whole browser tree is gone after --stop', { skip: SKIP }, async () => {
  const orphansBefore = new Set(xvfbOrphans());
  const w = await world('ok');
  try {
    creds(w);
    assert.strictEqual((await w.run('cdp-reed-full-login.js', [])).code, 0);
    const r = await w.drive(`
      const bf = require('./reed-browser-fetch');
      const usage = await bf.reedBrowserFetch('/monetization/daily-usage/');
      const cv = await bf.reedBrowserFetchBinary('/candidate/cv/download/', { candidateId: 9001 });
      const search = await require('./reed-search').search({ keywords: 'Chef', location: 'LS1' });
      return { limit: usage.result.dailyLimit, cd: cv.contentDisposition, text: cv.buffer.toString('utf8').slice(0, 12), total: search.totalCount, n: search.candidates.length };
    `);
    assert.ok(r.ok, r.stdout + r.stderr);
    assert.deepStrictEqual(r.result.limit, 600);
    assert.match(r.result.cd, /cv\.txt/);
    assert.strictEqual(r.result.text, 'Head Chef at');
    assert.strictEqual(r.result.total, 30);
    assert.strictEqual(r.result.n, 25);
    const before = reedProcs(w.profile);
    assert.ok(before.length >= 3, 'wrapper, browser and helper processes');
    // real Chromium rewrites its process title: one joined argument in /proc
    const main = before.find((pid) => !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=') && !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('xvfb-run'));
    assert.ok(main, 'found the browser main process by the joined command line');
    const st = spawnSync(process.execPath, [w.m.p('scripts', 'ensure-chrome-cdp.js'), '--stop'], { env: w.m.env(w.env) });
    assert.match(st.stdout.toString(), /CDP_STOPPED/);
    await sleep(500);
    assert.deepStrictEqual(reedProcs(w.profile), [], 'nothing left behind');
    assert.deepStrictEqual(xvfbOrphans().filter((p) => !orphansBefore.has(p)), [], 'no orphaned Xvfb');
  } finally { await w.cleanup(); }
});

test('real Chromium: a Turnstile-style block raises the human-login alert once; --clean removes the real session cookie', { skip: SKIP }, async () => {
  const w = await world('turnstile');
  try {
    creds(w);
    const r = await w.run('cdp-reed-full-login.js', []);
    assert.strictEqual(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /REED_LOGIN_BLOCKED_TURNSTILE/);
    assert.strictEqual(w.m.readLines('outbox/alerts.jsonl').filter((a) => a.key === 'reed-human-login').length, 1);
    const again = await w.run('cdp-reed-full-login.js', []);
    assert.match(again.stdout, /human login pending/);
    // switch the stand-in to a working login, log in, then verify --clean really deletes the cookie in the browser
    w.site.site.mode = 'ok';
    const ok = await w.run('cdp-reed-full-login.js', ['--ignore-block']);
    assert.strictEqual(ok.code, 0, ok.stdout + ok.stderr);
    assert.strictEqual(w.m.exists('runtime/reed-login-block.json'), false);
    const clean = await w.run('cdp-reed-full-login.js', ['--clean']);
    assert.strictEqual(clean.code, 0, clean.stdout + clean.stderr);
    assert.match(clean.stderr, /Cleared [1-9]\d* Reed\/Auth0 cookies/);
  } finally { await w.cleanup(); }
});

test('real Chromium: the login survives stop and start (Browser.close flushes the cookie database) for session and persistent cookies', { skip: SKIP }, async () => {
  for (const persistentCookie of [false, true]) {
    const w = await world('ok', { REED_CAPTURE_TIMEOUT_MS: '8000' }, { persistentCookie });
    try {
      creds(w);
      assert.strictEqual((await w.run('cdp-reed-full-login.js', [])).code, 0);
      const st = await w.run('ensure-chrome-cdp.js', ['--stop']);
      assert.match(st.stdout, /quit through CDP/);
      await sleep(500);
      assert.deepStrictEqual(reedProcs(w.profile), []);
      // a brand-new browser process must still be logged in: no login script is run here
      const r = await w.run('reed-refresh-token.js', ['--force']);
      assert.strictEqual(r.code, 0, `persistent=${persistentCookie}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /REED_TOKEN_REFRESHED/);
    } finally { await w.cleanup(); }
  }
});
