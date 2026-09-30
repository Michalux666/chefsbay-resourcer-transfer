'use strict';

// Coding-standard and secrets hygiene for everything the Reed package ships: banned tokens, ASCII/LF, no hard-coded credentials,
// no removed CDP methods, every CLI has --help, no stray process.exit in library code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeMirror } = require('./helpers/mirror');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(REPO, 'resourcer', 'scripts');
const OWNED = [
  'reed-api-client.js', 'reed-browser-fetch.js', 'reed-download.js', 'reed-refresh-token.js', 'reed-search.js', 'reed-phase1.js',
  'cdp-reed-full-login.js', 'ensure-chrome-cdp.js', 'run-pipeline.js',
];
const TESTS = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'hygiene.test.js').map((f) => path.join(__dirname, f))
  .concat(fs.readdirSync(path.join(__dirname, 'helpers')).map((f) => path.join(__dirname, 'helpers', f)));
const SHIPPED = OWNED.map((f) => path.join(SCRIPTS, f));
const BS = String.fromCharCode(92);

const BANNED = [
  `C:${BS}`, 'C:/Users', ['wsl', ' '].join(''), ['power', 'shell'].join(''), ['pw', 'sh'].join(''), ['open', 'claw'].join(''),
  ['pm', '2'].join(''), ['sch', 'tasks'].join(''), ['187', '89'].join(''), ['WHATS', 'APP'].join(''), ['ng', 'rok'].join(''), BS + BS,
];

test('no banned tokens in shipped code or in the Reed tests', () => {
  for (const f of [...SHIPPED, ...TESTS]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const tok of BANNED) assert.ok(!text.includes(tok), `${path.relative(REPO, f)} contains banned token ${JSON.stringify(tok)}`);
  }
});

test('ASCII only, LF line endings, no BOM', () => {
  for (const f of [...SHIPPED, ...TESTS]) {
    const buf = fs.readFileSync(f);
    assert.ok(![...buf].some((b) => b > 127), `${path.relative(REPO, f)} has non-ASCII bytes`);
    assert.ok(!buf.includes(13), `${path.relative(REPO, f)} has CR characters`);
  }
});

test('no hard-coded credentials, and the legacy account is gone from the code', () => {
  for (const f of SHIPPED) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/@chefsbay\./i.test(text), `${path.basename(f)} names a real mailbox`);
    assert.ok(!/\b(PASSWORD|EMAIL)\s*=\s*['"`]/.test(text), `${path.basename(f)} assigns a credential literal`);
    assert.ok(!/password['"]?\s*[:=]\s*['"][^'"]{4,}['"]/i.test(text), `${path.basename(f)} has a password literal`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(text), `${path.basename(f)} embeds a JWT`);
  }
  const login = fs.readFileSync(path.join(SCRIPTS, 'cdp-reed-full-login.js'), 'utf8');
  assert.ok(login.includes('CRED_FILE'), 'credentials come from the secrets file');
});

test('the removed CDP interception methods are never used', () => {
  for (const f of SHIPPED) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/setRequestInterception|requestIntercepted|continueInterceptedRequest/.test(text), `${path.basename(f)} uses request interception`);
  }
});

test('legacy launchers and the hard-coded relogin helper are not shipped', () => {
  for (const gone of ['start-reed-chrome.js', 'ensure-chrome-cdp.ps1', 'reed-clean-relogin.js', 'reed-login.js']) {
    assert.ok(!fs.existsSync(path.join(SCRIPTS, gone)), `${gone} must not exist`);
  }
});

test('process.exit only appears in CLI entry points and signal handlers, never in library code paths', () => {
  const allowed = /(cleanupAndExit|SIGINT|SIGTERM|require\.main === module)/;
  for (const f of SHIPPED) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const guard = lines.findIndex((l) => l.includes('require.main === module'));
    lines.forEach((l, i) => {
      if (!l.includes('process.exit(')) return;
      const inGuardBlock = guard >= 0 && i >= guard;
      assert.ok(inGuardBlock || allowed.test(l) || lines.slice(Math.max(0, i - 2), i + 1).some((x) => allowed.test(x)),
        `${path.basename(f)}:${i + 1} calls process.exit outside a CLI entry point`);
    });
  }
});

test('every CLI answers --help with exit 0 and mentions its usage', async () => {
  const m = makeMirror();
  try {
    for (const f of OWNED.filter((x) => x !== 'reed-browser-fetch.js')) { // a pure module, no CLI
      const r = await m.run(f, ['--help'], { env: { REED_CDP_PORT: '1' }, timeoutMs: 30000 });
      assert.strictEqual(r.code, 0, `${f} --help exited ${r.code}: ${r.stderr}`);
      assert.match(`${r.stdout}\n${r.stderr}`, /usage/i, `${f} prints usage`);
    }
  } finally { m.cleanup(); }
});

test('paths come from paths.js: no absolute path literals and no /tmp in shipped code', () => {
  for (const f of SHIPPED) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/['"`]\/(tmp|opt|home|var|usr\/local)\b/.test(text.replace(/\/usr\/bin\//g, '')), `${path.basename(f)} hard-codes an absolute path`);
    assert.ok(!text.includes('/tmp/'), `${path.basename(f)} mentions /tmp`);
  }
});

test('the direct CDP port is a config value with a documented default', () => {
  const launcher = fs.readFileSync(path.join(SCRIPTS, 'ensure-chrome-cdp.js'), 'utf8');
  assert.match(launcher, /REED_CDP_PORT', 9222/);
});
