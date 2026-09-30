'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helpers');

const POSIX = !H.IS_WIN;

function setup(t, envExtra) {
  const sb = H.buildSandbox({ prefix: 'rb-br-' });
  sb.activate(envExtra);
  t.after(() => sb.cleanup());
  const browser = sb.load('lib/browser.js');
  return { sb, browser, fake: sb.fake };
}

test('the six call forms produce exactly the legacy argv on session caterer', async (t) => {
  const { browser, fake } = setup(t);
  await browser.open('https://recruiter.caterer.com/login');
  await browser.waitNetworkIdle();
  await browser.evalB64(Buffer.from('1+1').toString('base64'));
  await browser.getUrl();
  const f = path.join(path.dirname(fake.dir), 'sess.json');
  await browser.stateSave(f);
  await browser.stateLoad(f);
  const argvs = fake.calls().map((c) => c.argv.map((a, i) => (c.cmd === 'eval' && i === 4 ? '<b64>' : a)));
  assert.deepEqual(argvs[0], ['--session', 'caterer', 'open', 'https://recruiter.caterer.com/login']);
  assert.deepEqual(argvs[1], ['--session', 'caterer', 'wait', '--load', 'networkidle']);
  assert.deepEqual(argvs[2], ['--session', 'caterer', 'eval', '-b', '<b64>']);
  assert.deepEqual(argvs[3], ['--session', 'caterer', 'get', 'url']);
  assert.equal(argvs[4].slice(0, 4).join(' '), '--session caterer state save');
  assert.match(argvs[4][4], /sess\.json\.tmp-\d+$/);
  assert.deepEqual(argvs[5], ['--session', 'caterer', 'state', 'load', path.resolve(f)]);
});

test('result shape and stderr-then-stdout merge order', async (t) => {
  const { browser, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { stdout: 'OUT-LINE', stderr: 'ERR-LINE', code: 0 } }] });
  const r = await browser.run(['get', 'url']);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.out, 'ERR-LINE\nOUT-LINE');
  assert.equal(r.stdout.trim(), 'OUT-LINE');
  assert.equal(r.stderr.trim(), 'ERR-LINE');
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { stderr: '\u2717 boom', code: 1 } }] });
  const bad = await browser.run(['get', 'url']);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 1);
  assert.ok(browser.looksLikeError(bad.out));
});

test('environment is forced: one socket dir, no inherited agent-browser settings, state dirs under STATE', async (t) => {
  const { sb, browser, fake } = setup(t, {
    AGENT_BROWSER_SOCKET_DIR: '/somewhere/else', AGENT_BROWSER_NATIVE: '0', AGENT_BROWSER_ENCRYPTION_KEY: 'k',
    AGENT_BROWSER_SESSION_NAME: 'x', AGENT_BROWSER_PROFILE: '/p', DISPLAY: ':0', CHROMIUM_PATH: '/opt/fake/chromium',
  });
  await browser.getUrl();
  const seen = fake.calls()[0].env;
  const stateDir = path.join(sb.home, 'state');
  assert.ok(seen.socketDir.startsWith(stateDir) || /rab-[0-9a-f]{8}$/.test(seen.socketDir), 'socket dir under STATE (or the short fallback): ' + seen.socketDir);
  assert.notEqual(seen.socketDir, '/somewhere/else');
  assert.equal(seen.noColor, '1');
  assert.equal(seen.tmpdir, path.join(stateDir, 't'));
  assert.equal(seen.hasNative, false);
  assert.equal(seen.hasEnc, false);
  assert.equal(seen.hasSessionName, false);
  assert.equal(seen.hasProfile, false);
  assert.equal(seen.display, null, 'headless: DISPLAY not passed on');
  assert.equal(seen.exe, '/opt/fake/chromium');
  assert.equal(seen.args, '--no-sandbox,--disable-dev-shm-usage,--lang=en-GB');
  assert.equal(seen.tz, 'Europe/London', 'browser process runs on UK time, whatever the OS zone is');
  assert.equal(seen.language, 'en_GB:en');
  assert.equal(seen.headed, null);
  assert.equal(seen.idle, null, 'idle timeout left at the 0.21.0 default (disabled)');
});

test('every call from every process sees the same socket dir (single backend)', async (t) => {
  const { sb, browser, fake } = setup(t);
  await browser.getUrl();
  const d1 = fake.calls()[0].env.socketDir;
  const child = require('child_process').spawnSync(process.execPath, ['-e', `
    const b = require(${JSON.stringify(path.join(sb.scripts, 'lib', 'browser.js'))});
    b.getUrl().then(() => process.exit(0));`], { env: sb.env({ AGENT_BROWSER_SOCKET_DIR: '/tmp/login-shell-dir' }), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const calls = fake.calls();
  assert.equal(calls[calls.length - 1].env.socketDir, d1);
});

test('headed fallback switch passes HEADED and DISPLAY', async (t) => {
  const { browser, fake } = setup(t, { RESOURCER_AB_HEADED: '1', RESOURCER_AB_DISPLAY: ':99' });
  await browser.getUrl();
  const seen = fake.calls()[0].env;
  assert.equal(seen.headed, '1');
  assert.equal(seen.display, ':99');
});

test('timeout kills the CLI and its children and returns the legacy text promptly', async (t) => {
  const { browser, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'eval', scriptIncludes: 'HANG' }, do: { spawnChild: true, hangMs: 60000 } }] });
  const t0 = Date.now();
  const r = await browser.evalJs('"HANG"', { timeoutMs: 1500, label: 'slow-test' });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.out, 'Error: TIMEOUT after 2s (slow-test)');
  assert.ok(Date.now() - t0 < 5000, 'returned promptly');
  const childPid = Number(fs.readFileSync(path.join(fake.dir, 'child.pid'), 'utf8'));
  assert.ok(await H.waitFor(() => !H.pidAlive(childPid), 4000), 'child of the CLI was killed with the process group / tree');
});

test('a grandchild holding the stdio pipes does not stall the wrapper', async (t) => {
  const { browser, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { spawnGrandchildMs: 6000, stdout: 'https://recruiter.caterer.com/Home/1' } }] });
  const t0 = Date.now();
  const r = await browser.run(['get', 'url'], { timeoutMs: 20000 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 4000, 'returned within the pipe grace period, not after the grandchild exits: ' + (Date.now() - t0));
  try { process.kill(Number(fs.readFileSync(path.join(fake.dir, 'grandchild.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
});

test('slow state-changing eval is sent exactly once with singleAttempt; a plain call can be re-sent by the CLI', async (t) => {
  const { browser, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { fetch: [{ match: 'UnlockCandidate', status: 200, body: '{}', delayMs: 2200 }] } });
  const js = "(async function(){var r=await fetch('https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/UnlockCandidate?a=1');return JSON.stringify({status:r.status});})()";
  const single = await browser.evalJs(js, { timeoutMs: 40000, singleAttempt: true });
  assert.equal(single.timedOut, true, 'clamped below the CLI read timeout');
  assert.equal(single.clamped, true);
  assert.equal(fake.counters()['fetch:UnlockCandidate'], 1, 'daemon executed the unlock once');
  assert.equal(fake.events('resend').length, 0);
  fake.clearCalls();
  const plain = await browser.evalJs(js, { timeoutMs: 40000 });
  assert.equal(plain.ok, true);
  assert.ok(fake.events('resend').length >= 1, 'control: without singleAttempt the (emulated) CLI re-sends');
  assert.ok(fake.counters()['fetch:UnlockCandidate'] >= 2);
  assert.equal(plain.retryRisk, true);
});

test('never rejects: bad args, bad session name, missing binary', async (t) => {
  const { browser, fake, sb } = setup(t);
  for (const bad of [null, [], ['open', 5], ['a\0b']]) {
    const r = await browser.run(bad);
    assert.equal(r.ok, false);
    assert.match(r.out, /^Error:/);
  }
  const r2 = await browser.run(['get', 'url'], { session: 'bad name!' });
  assert.equal(r2.ok, false);
  assert.equal(fake.calls().length, 0, 'nothing was spawned');
  assert.equal((await browser.open('file:///etc/passwd')).ok, false);
  assert.equal((await browser.evalB64('not base64!')).ok, false);
  process.env.RESOURCER_AB_BIN = path.join(sb.home, 'no-such-binary');
  const r3 = await browser.run(['get', 'url']);
  assert.equal(r3.ok, false);
  assert.match(r3.out, /spawn failed|Error/);
  process.env.RESOURCER_AB_BIN = fake.bin;
});

test('calls are serialised within a process', async (t) => {
  const { browser, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { delayMs: 400, stdout: 'https://x.invalid/', code: 0 } }] });
  await Promise.all([browser.getUrl(), browser.getUrl()]);
  const c = fake.calls();
  assert.equal(c.length, 2);
  assert.ok(c[1].t >= c[0].t + 380, `second started after the first finished (${c[1].t - c[0].t}ms apart)`);
});

test('cold-daemon detection and warm detection', async (t) => {
  const { browser, fake } = setup(t);
  const cold = await browser.isCold();
  assert.equal(cold.cold, true);
  await browser.open('https://recruiter.caterer.com/login');
  assert.equal((await browser.isCold()).cold, false);
  fake.scenario({ rules: [{ when: { cmd: 'get' }, do: { stderr: '\u2717 no daemon', code: 1 } }] });
  assert.equal((await browser.isCold()).cold, null, 'unknown when the query itself fails');
});

test('stateSave: temp file, validated, renamed, mode 600; garbage or failure leaves the good file alone', async (t) => {
  const { sb, browser, fake } = setup(t);
  fake.warmLoggedIn();
  const f = sb.sessionFile();
  fs.writeFileSync(f, JSON.stringify({ cookies: [{ name: 'GOOD' }], origins: [] }));
  const r = await browser.stateSave(f);
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Array.isArray(saved.cookies) && Array.isArray(saved.origins));
  assert.ok(saved.cookies.some((c) => c.name === 'AuthCookie'));
  assert.deepEqual(fs.readdirSync(sb.home).filter((n) => n.includes('.tmp-')), []);
  if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const before = fs.readFileSync(f, 'utf8');
  fake.scenario({ stateSaveGarbage: true });
  const g = await browser.stateSave(f);
  assert.equal(g.ok, false);
  fake.scenario({ stateSaveGarbage: false, stateSaveFails: true });
  const h = await browser.stateSave(f);
  assert.equal(h.ok, false);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'last good file untouched');
  assert.deepEqual(fs.readdirSync(sb.home).filter((n) => n.includes('.tmp-')), []);
});

test('saveSession never overwrites the good file from a login or safe-list page', async (t) => {
  const { sb, browser, fake } = setup(t);
  const f = sb.sessionFile();
  fs.writeFileSync(f, JSON.stringify({ cookies: [{ name: 'GOOD' }], origins: [] }));
  fake.browser({ alive: true, page: 'login', url: 'https://recruiter.caterer.com/login' });
  let r = await browser.saveSession();
  assert.deepEqual([r.saved, r.skipped], [false, 'login']);
  fake.browser({ alive: true, page: 'safelist', url: 'https://recruiter.caterer.com/Account/Unauthenticated/SafeListLoginBlocked' });
  r = await browser.saveSession();
  assert.deepEqual([r.saved, r.skipped], [false, 'safelist']);
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).cookies.some((c) => c.name === 'GOOD'));
  assert.equal(fake.calls('state').length, 0, 'no state save was even attempted');
  fake.warmLoggedIn();
  r = await browser.saveSession();
  assert.equal(r.saved, true);
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).cookies.some((c) => c.name === 'AuthCookie'));
});

test('stateLoad of a missing file does not spawn anything', async (t) => {
  const { sb, browser, fake } = setup(t);
  const r = await browser.stateLoad(path.join(sb.home, 'nope.json'));
  assert.equal(r.ok, false);
  assert.equal(fake.calls().length, 0);
});

test('eval output decoders', () => {
  const b = require(path.join(H.SRC_SCRIPTS, 'lib', 'browser.js'));
  assert.equal(b.unwrapEval('"abc\\n"'), 'abc\n');
  assert.equal(b.unwrapEval('42'), '42');
  assert.deepEqual(b.parseEvalJson('"{\\"status\\":200,\\"body\\":\\"hi\\"}"'), { status: 200, body: 'hi' });
  assert.deepEqual(b.parseEvalJson('noise before {"status":1}'), { status: 1 });
  assert.match(b.parseEvalJson('nothing here').error, /^empty browser output/);
  assert.match(b.parseEvalJson('"not json"').error, /^unparseable inner payload/);
  assert.match(b.parseEvalJson('{bad').error, /^unparseable browser output/);
  assert.equal(b.isLoginUrl('https://x/Login?a'), true);
  assert.equal(b.isLoginUrl('https://x/Account/Unauthenticated/SafeListLoginBlocked'), false, 'safe-list URL has no slash before Login');
  assert.equal(b.isSafeListBlocked('https://x/Account/Unauthenticated/SafeListLoginBlocked'), true);
  assert.equal(b.isModuleErrorUrl('https://x/Error?aspxerrorpath=/a'), true);
  assert.equal(b.isModuleErrorUrl('https://x/Home/1'), false);
  assert.equal(b.looksLikeError('\u2717 bad'), true);
  assert.equal(b.looksLikeError('Error: TIMEOUT after 5s (x)'), true);
  assert.equal(b.looksLikeError('{"a":1}'), false);
});

test('version check: pinned build passes, anything else is reported', async (t) => {
  const { browser, fake } = setup(t);
  let v = await browser.verifyVersion();
  assert.deepEqual([v.ok, v.version], [true, '0.21.0']);
  fake.scenario({ version: '0.38.1' });
  v = await browser.verifyVersion();
  assert.deepEqual([v.ok, v.version], [false, '0.38.1']);
});

test('cross-process navigation gap: only a different process than the previous navigation waits', async (t) => {
  const { sb, browser } = setup(t, { RESOURCER_AB_NAV_GAP_MS: '700' });
  fs.mkdirSync(path.join(sb.home, 'state', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'state', 'ab', 'nav.json'), JSON.stringify({ pid: process.pid + 100000, at: Date.now() }));
  let t0 = Date.now();
  await browser.open('https://recruiter.caterer.com/login');
  assert.ok(Date.now() - t0 >= 550, 'waited for the other process navigation to settle: ' + (Date.now() - t0));
  t0 = Date.now();
  await browser.open('https://recruiter.caterer.com/login');
  assert.ok(Date.now() - t0 < 500, 'same process: no gap: ' + (Date.now() - t0));
});

test('stale Chrome profiles of a dead daemon are swept, fresh ones are kept', async (t) => {
  const { sb, browser } = setup(t);
  const tmp = path.join(sb.home, 'state', 't');
  fs.mkdirSync(path.join(tmp, 'agent-browser-chrome-old'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'agent-browser-chrome-new'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'org.chromium.Chromium.abc123'), { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(tmp, 'agent-browser-chrome-old'), old, old);
  fs.utimesSync(path.join(tmp, 'org.chromium.Chromium.abc123'), old, old);
  await browser.getUrl();
  assert.ok(!fs.existsSync(path.join(tmp, 'agent-browser-chrome-old')));
  assert.ok(!fs.existsSync(path.join(tmp, 'org.chromium.Chromium.abc123')), 'leftover Chrome temp dir goes too');
  assert.ok(fs.existsSync(path.join(tmp, 'agent-browser-chrome-new')));
});

test('reset clears sockets and profiles and kills only Chrome processes of our profile dir', { skip: !POSIX && 'process scan is Linux only' }, async (t) => {
  const { sb, browser } = setup(t);
  await browser.getUrl();
  const st = await browser.status();
  const tmp = st.tmpDir;
  fs.mkdirSync(path.join(tmp, 'agent-browser-chrome-abc'), { recursive: true });
  fs.writeFileSync(path.join(st.sockDir, 'caterer.sock'), '');
  fs.writeFileSync(path.join(st.sockDir, 'caterer.pid'), '999999');
  const mine = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', '--', `--user-data-dir=${path.join(tmp, 'agent-browser-chrome-abc')}`], { stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', '--', '--user-data-dir=/elsewhere/agent-browser-chrome-zzz-other'], { stdio: 'ignore' });
  // real Chrome shows its whole command line as ONE argv element: a renderer of ours in that shape
  const joined = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', '--', `--type=renderer --noerrdialogs --user-data-dir=${path.join(tmp, 'agent-browser-chrome-abc')} --change-stack-guard-on-fork=enable`], { stdio: 'ignore' });
  t.after(() => { for (const p of [other, mine, joined]) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
  await H.sleep(200);
  const seen = browser.countBackends();
  assert.ok(seen.dirs.includes(path.join(tmp, 'agent-browser-chrome-abc')), 'a profile flag inside one joined argv element is still found: ' + JSON.stringify(seen.dirs));
  const rep = await browser.reset();
  assert.ok(rep.killed >= 1);
  assert.ok(await H.waitFor(() => !H.pidAlive(mine.pid), 3000), 'our Chrome was killed');
  assert.ok(await H.waitFor(() => !H.pidAlive(joined.pid), 3000), 'our Chrome with a joined cmdline was killed');
  assert.ok(H.pidAlive(other.pid), 'a Chrome with a different profile dir is left alone');
  assert.ok(!fs.existsSync(path.join(st.sockDir, 'caterer.sock')));
  assert.ok(!fs.existsSync(path.join(tmp, 'agent-browser-chrome-abc')));
  const be = browser.countBackends();
  assert.ok(be.dirs.every((d) => !d.includes(tmp)), 'no backend of ours remains');
  void sb;
});

test('a very long home falls back to a short deterministic socket dir', { skip: !POSIX && 'unix sockets' }, async (t) => {
  const { sb } = setup(t);
  const deep = path.join(sb.home, 'x'.repeat(40), 'y'.repeat(40));
  fs.mkdirSync(deep, { recursive: true });
  const r = require('child_process').spawnSync(process.execPath, ['-e', `
    const b = require(${JSON.stringify(path.join(sb.scripts, 'lib', 'browser.js'))});
    b._internal.chooseSockDir().then((d) => { console.log(d); process.exit(0); });`], { env: sb.env({ RESOURCER_HOME: deep }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = r.stdout.trim();
  assert.match(d, /^\/tmp\/rab-[0-9a-f]{8}$/);
  assert.ok((d + '/caterer.sock').length <= 103);
  const r2 = require('child_process').spawnSync(process.execPath, ['-e', `
    const b = require(${JSON.stringify(path.join(sb.scripts, 'lib', 'browser.js'))});
    b._internal.chooseSockDir().then((d) => { console.log(d); process.exit(0); });`], { env: sb.env({ RESOURCER_HOME: deep, TMPDIR: '/var/tmp' }), encoding: 'utf8' });
  assert.equal(r2.stdout.trim(), d, 'independent of TMPDIR: every process agrees');
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the wrapper does nothing at require time', () => {
  const b = require(path.join(H.SRC_SCRIPTS, 'lib', 'browser.js'));
  assert.equal(typeof b.run, 'function');
});

test('an empty state from a cold browser never replaces a session file that has cookies', async (t) => {
  const { sb, browser, fake } = setup(t);
  const f = sb.sessionFile();
  const good = JSON.stringify({ cookies: [{ name: 'GOOD' }], origins: [] });
  fs.writeFileSync(f, good);
  const r = await browser.stateSave(f);
  assert.equal(fake.calls('state').length, 1, 'the CLI was asked (cold fake browser has no cookies)');
  assert.equal(r.ok, false);
  assert.match(r.out, /refusing to replace/);
  assert.equal(fs.readFileSync(f, 'utf8'), good);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')), []);
  fs.unlinkSync(f);
  const r2 = await browser.stateSave(f);
  assert.equal(r2.ok, true, 'with no previous file an empty first save is allowed');
});

test('a stale-looking profile dir that a live process still names is never swept', { skip: !POSIX && 'process scan is Linux only' }, async (t) => {
  const { sb, browser } = setup(t);
  const tmp = path.join(sb.home, 'state', 't');
  const dir = path.join(tmp, 'agent-browser-chrome-live');
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  const live = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', '--', `--type=renderer --user-data-dir=${dir} --x`], { stdio: 'ignore' });
  t.after(() => { try { live.kill('SIGKILL'); } catch { /* gone */ } });
  await H.sleep(200);
  await browser.getUrl();
  assert.ok(fs.existsSync(dir), 'kept: a running process names it');
});

test('a save temp file abandoned by a killed process is removed later; a recent one is left alone', async (t) => {
  const { sb, browser, fake } = setup(t);
  fake.warmLoggedIn();
  const f = sb.sessionFile();
  const stale = `${f}.tmp-424242`, recent = `${f}.tmp-434343`;
  fs.writeFileSync(stale, '{"cookies":[{"name":"SECRET_COOKIE"}]}');
  fs.writeFileSync(recent, '{}');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const r = await browser.stateSave(f);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(stale), 'stale temp (it holds cookies) removed');
  assert.ok(fs.existsSync(recent), 'a temp that may belong to a live process stays');
});
