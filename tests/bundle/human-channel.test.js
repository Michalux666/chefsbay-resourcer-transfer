'use strict';
// The human-only passphrase channel (<home>/secrets/bundle-passphrase), --save-passphrase, and the restore guards
// added after review: kept secrets, symlinked parents, private state directory. Fake data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const H = require('./_helpers');
const R = require('../../tools/restore-bundle.js');

const { F, FAKE } = H;
const posix = process.platform !== 'win32';

function fakeTty() {
  const tty = new EventEmitter();
  tty.isTTY = true;
  tty.setRawMode = () => {};
  tty.setEncoding = () => {};
  tty.resume = () => {};
  tty.pause = () => {};
  return tty;
}

function fakeOut() {
  return { text: '', write(s) { this.text += s; } };
}

const shared = {};
test.before(() => {
  shared.root = H.mkTmp('hc-');
  const src = H.buildFakeLegacy(path.join(shared.root, 'legacy'));
  shared.out = path.join(shared.root, 'bundle', 'b.enc');
  fs.mkdirSync(path.dirname(shared.out), { recursive: true });
  const m = H.make(src, shared.out);
  assert.equal(m.status, 0, m.all);
  shared.n = 0;
});
test.after(() => H.rmTmp(shared.root));

function freshHome() {
  shared.n += 1;
  return path.join(shared.root, `home${shared.n}`);
}

function placePassphrase(home, text = FAKE.passphrase, mode = 0o600) {
  const dir = path.join(home, 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) fs.chmodSync(dir, 0o700);
  const f = path.join(dir, 'bundle-passphrase');
  fs.writeFileSync(f, text, { mode });
  if (posix) fs.chmodSync(f, mode);
  return f;
}

// restore/verify with NO passphrase environment variable at all: the only source is the file the human placed
function restoreNoEnv(home, args = []) {
  return H.runTool('restore-bundle.js', ['--bundle', shared.out, '--home', home, ...args], { env: {} });
}

test('restore reads secrets/bundle-passphrase when no other source is given, never prints it, and says how to remove it', () => {
  const home = freshHome();
  const pf = placePassphrase(home, FAKE.passphrase + '\n');
  const r = restoreNoEnv(home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /RESTORE_OK/);
  assert.match(r.stdout, /passphrase came from secrets\/bundle-passphrase; remove it now: rm /);
  assert.ok(!r.all.includes(FAKE.passphrase), 'the passphrase must never be printed');
  assert.ok(fs.existsSync(pf), 'the tool does not delete the file; the operator removes it with a plain rm');
  H.assertNoSecrets(assert, r.all, 'restore output');
  assert.deepEqual(fs.readFileSync(pf, 'utf8'), FAKE.passphrase + '\n');
});

test('the file may carry a BOM and CRLF (a text editor or a file manager wrote it)', () => {
  const home = freshHome();
  placePassphrase(home, String.fromCharCode(0xFEFF) + FAKE.passphrase + '\r\n');
  const r = restoreNoEnv(home, ['--dry-run']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /DRY_RUN_OK/);
});

test('a group- or world-readable passphrase file is refused with a chmod hint and nothing is written', (t) => {
  if (!posix) return t.skip('POSIX permissions only');
  const home = freshHome();
  placePassphrase(home, FAKE.passphrase, 0o644);
  const r = restoreNoEnv(home);
  assert.equal(r.status, 7, r.all);
  assert.match(r.stderr, /readable by group or others; run chmod 600/);
  assert.ok(!r.all.includes(FAKE.passphrase));
  assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
  fs.chmodSync(path.join(home, 'secrets', 'bundle-passphrase'), 0o600);
  assert.equal(restoreNoEnv(home).status, 0);
});

test('a symlinked or non-regular passphrase file is refused', (t) => {
  const home = freshHome();
  const target = path.join(shared.root, 'elsewhere-pass.txt');
  fs.writeFileSync(target, FAKE.passphrase, { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 });
  try {
    fs.symlinkSync(target, path.join(home, 'secrets', 'bundle-passphrase'));
  } catch { return t.skip('symlinks need privileges on this host'); }
  const r = restoreNoEnv(home);
  assert.equal(r.status, 7, r.all);
  assert.match(r.stderr, /must be a regular file/);

  const home2 = freshHome();
  fs.mkdirSync(path.join(home2, 'secrets', 'bundle-passphrase'), { recursive: true });
  const r2 = restoreNoEnv(home2);
  assert.equal(r2.status, 7, r2.all);
});

test('explicit sources win over the file; a wrong file fails authentication and writes nothing', () => {
  const home = freshHome();
  placePassphrase(home, 'a different passphrase, and a wrong one');
  const wrongFile = restoreNoEnv(home);
  assert.equal(wrongFile.status, 2, wrongFile.all);
  assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
  const viaEnv = H.runTool('restore-bundle.js', ['--bundle', shared.out, '--home', home, '--dry-run'], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root, FAKE.passphrase, 'env-pass.txt') } });
  assert.equal(viaEnv.status, 0, viaEnv.all);
  assert.doesNotMatch(viaEnv.stdout, /passphrase came from/);
});

test('no source at all: exit 7 and the message names the human-placed file', () => {
  const home = freshHome();
  const r = restoreNoEnv(home);
  assert.equal(r.status, 7, r.all);
  assert.match(r.stderr, /secrets\/bundle-passphrase/);
  assert.ok(!fs.existsSync(home), 'nothing is created');
});

test('verify-bundle uses the same channel through --home', () => {
  const home = freshHome();
  placePassphrase(home);
  const r = H.runTool('verify-bundle.js', ['--bundle', shared.out, '--home', home], { env: {} });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /VERIFY_OK/);
  assert.ok(!r.all.includes(FAKE.passphrase));
  const none = H.runTool('verify-bundle.js', ['--bundle', shared.out, '--home', freshHome()], { env: {} });
  assert.equal(none.status, 7, none.all);
});

test('--save-passphrase needs a real terminal, asks twice, stores 0600 in a 0700 directory, and never echoes it', async (t) => {
  const noTty = H.runTool('restore-bundle.js', ['--save-passphrase', '--home', freshHome()], { env: {} });
  assert.equal(noTty.status, 7, noTty.all);
  assert.match(noTty.stderr, /needs a real terminal/);

  const home = freshHome();
  const tty = fakeTty();
  const err = fakeOut();
  const out = fakeOut();
  const done = R.run(['--save-passphrase', '--home', home], {}, { stdin: tty, stderr: err, stdout: out });
  for (const line of [FAKE.passphrase, FAKE.passphrase]) {
    await new Promise((r) => setImmediate(r));
    tty.emit('data', `${line}\r`);
  }
  assert.equal(await done, 0, err.text);
  assert.match(out.text, /PASSPHRASE_SAVED secrets\/bundle-passphrase/);
  assert.ok(!out.text.includes(FAKE.passphrase) && !err.text.includes(FAKE.passphrase));
  const f = path.join(home, 'secrets', 'bundle-passphrase');
  assert.equal(fs.readFileSync(f, 'utf8'), FAKE.passphrase + '\n');
  if (posix) {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'secrets')).mode & 0o777, 0o700);
  } else t.diagnostic('modes not checked on this platform');
  assert.equal(restoreNoEnv(home, ['--dry-run']).status, 0);

  const again = fakeTty();
  const e2 = fakeOut();
  assert.equal(await R.run(['--save-passphrase', '--home', home], {}, { stdin: again, stderr: e2, stdout: fakeOut() }), 4, 'an existing file is not replaced without --force');
  assert.match(e2.text, /already exists/);
});

test('--save-passphrase: mismatch and short passphrases store nothing', async () => {
  const home = freshHome();
  const tty = fakeTty();
  const err = fakeOut();
  const done = R.run(['--save-passphrase', '--home', home], {}, { stdin: tty, stderr: err, stdout: fakeOut() });
  await new Promise((r) => setImmediate(r));
  tty.emit('data', `${FAKE.passphrase}\r`);
  await new Promise((r) => setImmediate(r));
  tty.emit('data', `${FAKE.passphrase} nope\r`);
  assert.equal(await done, 7);
  assert.match(err.text, /do not match/);
  assert.ok(!fs.existsSync(path.join(home, 'secrets', 'bundle-passphrase')));

  const t2 = fakeTty();
  const e2 = fakeOut();
  const d2 = R.run(['--save-passphrase', '--home', home], {}, { stdin: t2, stderr: e2, stdout: fakeOut() });
  await new Promise((r) => setImmediate(r));
  t2.emit('data', 'too short\r');
  await new Promise((r) => setImmediate(r));
  t2.emit('data', 'too short\r');
  assert.equal(await d2, 7);
  assert.match(e2.text, /at least 16/);
  assert.ok(!fs.existsSync(path.join(home, 'secrets', 'bundle-passphrase')));
});

test('a rotated secret survives a re-run of the same bundle; --replace-secrets is the explicit override; a kept secret is tightened to 0600', () => {
  const home = freshHome();
  assert.equal(H.restore(shared.out, home).status, 0);
  const secret = path.join(home, 'secrets', 'caterer-credentials.json');
  fs.writeFileSync(secret, '{"password":"FAKE-rotated-on-the-instance"}', { mode: 0o644 });
  if (posix) fs.chmodSync(secret, 0o644);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /keep\s+secrets\/caterer-credentials\.json.*existing secret differs; kept/);
  assert.equal(fs.readFileSync(secret, 'utf8'), '{"password":"FAKE-rotated-on-the-instance"}');
  if (posix) assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(home, 'backups')), 'nothing replaced, nothing to back up');
  const forced = H.restore(shared.out, home, ['--replace-secrets']);
  assert.equal(forced.status, 0, forced.all);
  assert.ok(fs.readFileSync(secret, 'utf8').includes(FAKE.catererPass));
  assert.ok(fs.existsSync(path.join(home, 'backups')));
});

test('a pending search that differs from the bundle (already claimed on the instance) is kept', () => {
  const home = freshHome();
  assert.equal(H.restore(shared.out, home).status, 0);
  const pend = path.join(home, 'pending-searches', 'search-d.json');
  fs.writeFileSync(pend, JSON.stringify({ jobTitle: 'Fake Role 4', location: 'ZZ4', distance: 20, spawnedAt: '2026-09-29T02:00:00.000Z' }));
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(fs.readFileSync(pend, 'utf8'), /spawnedAt/);
  assert.match(r.stdout, /kept=1/);
});

test('a symlinked secrets/, config/ or state/ directory is refused before anything is written through it', (t) => {
  for (const name of ['secrets', 'state']) {
    const home = freshHome();
    const target = path.join(shared.root, `redirect-${name}-${shared.n}`);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    try {
      fs.symlinkSync(target, path.join(home, name), 'dir');
    } catch { return t.skip('symlinks need privileges on this host'); }
    const r = H.restore(shared.out, home);
    assert.equal(r.status, 4, `${name}: ${r.all}`);
    assert.match(r.stderr, new RegExp(`${name}/: is a symbolic link`));
    assert.deepEqual(fs.readdirSync(target), [], `${name}: nothing may land in the link target`);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
  }
});

test('state/ is private: directory 0700 and bundle-restored.json 0600', (t) => {
  if (!posix) return t.skip('POSIX permissions only');
  const home = freshHome();
  assert.equal(H.restore(shared.out, home).status, 0);
  assert.equal(fs.statSync(path.join(home, 'state')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, 'state', 'bundle-restored.json')).mode & 0o777, 0o600);
});

test('the manifest cannot loosen file modes: a config entry is restored with the canonical mode', () => {
  const m = F.validateManifest({
    format: 'resourcer-bundle', formatVersion: 1, bundleId: '00000000-0000-4000-8000-000000000000', builtAt: new Date().toISOString(), sourceHost: 'x',
    files: [{ path: 'config/a.json', size: 1, sha256: 'a'.repeat(64), mode: '0777' }],
  });
  assert.equal(m.files[0].mode, '0644');
});

test('make-bundle states the key-derivation cost and warns when it is below the default', () => {
  const src = path.join(shared.root, 'legacy');
  const out = path.join(shared.root, 'kdf', 'k.enc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const low = H.make(src, out);
  assert.equal(low.status, 0, low.all);
  assert.match(low.stdout, /kdf: scrypt N=2\^15/);
  assert.match(low.stderr, /warning: key-derivation cost 2\^15 is below the default 2\^17/);
  const { manifest } = H.readManifest(out);
  assert.ok((manifest.warnings || []).some((w) => /key-derivation cost 2\^15/.test(w)));
  const full = H.runTool('make-bundle.js', ['--source', src, '--out', path.join(shared.root, 'kdf', 'k2.enc')], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root, FAKE.passphrase, 'k.txt'), BUNDLE_SCRYPT_LOG2N: '' } });
  assert.equal(full.status, 0, full.all);
  assert.match(full.stdout, /kdf: scrypt N=2\^17/);
  assert.doesNotMatch(full.stderr, /below the default/);
});

test('make-bundle refuses a repetitive passphrase', () => {
  const src = path.join(shared.root, 'legacy');
  const r = H.runTool('make-bundle.js', ['--source', src, '--out', path.join(shared.root, 'rep', 'r.enc')], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root, 'aaaaaaaaaaaaaaaaaaaa', 'rep.txt') } });
  assert.equal(r.status, 7, r.all);
  assert.match(r.stderr, /too repetitive/);
});
