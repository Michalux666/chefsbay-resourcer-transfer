'use strict';
// Format-level tests: no SQLite involved. Small chunk sizes force multi-chunk bundles.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const H = require('./_helpers');
const { F } = H;

process.env.BUNDLE_SCRYPT_LOG2N = '15';

const PASS = 'a perfectly fine fake passphrase 123';
const CHUNK = 256;

function makeEntries() {
  const rnd = (n) => crypto.randomBytes(n);
  return [
    { path: 'config/empty.json', buffer: Buffer.alloc(0) },
    { path: 'config/one.json', buffer: Buffer.from('x') },
    { path: 'config/chunk-minus-1.json', buffer: rnd(CHUNK - 1) },
    { path: 'config/chunk.json', buffer: rnd(CHUNK) },
    { path: 'config/chunk-plus-1.json', buffer: rnd(CHUNK + 1) },
    { path: 'pending-searches/big.json', buffer: rnd(CHUNK * 9 + 17) },
    { path: 'secrets/caterer-credentials.json', buffer: Buffer.from('{"username":"FAKE-marker-secret-AAAA"}') },
  ];
}

function build(dir, entries = makeEntries(), extra = {}) {
  const out = path.join(dir, 'b.enc');
  const w = F.writeBundle(out, {
    passphrase: PASS, chunkSize: CHUNK, logN: 15, entries,
    manifestBase: F.newManifestBase({ sourceHost: 'test', warnings: [] }), ...extra,
  });
  return { out, ...w };
}

function extractAll(file, cred) {
  const got = new Map();
  const r = F.scanBundle(file, cred, {
    sink(entry) {
      const parts = [];
      return { write(b) { parts.push(Buffer.from(b)); }, end() { got.set(entry.path, Buffer.concat(parts)); }, abort() {} };
    },
  });
  return { got, r };
}

function parseFrames(buf, chunkSize = CHUNK) {
  const frames = [];
  let off = F.HEADER_LEN;
  while (off < buf.length) {
    const ctLen = buf.readUInt32BE(off + 1);
    const total = 5 + ctLen + 16;
    frames.push(buf.subarray(off, off + total));
    off += total;
  }
  void chunkSize;
  return { header: buf.subarray(0, F.HEADER_LEN), frames };
}

const assemble = (header, frames) => Buffer.concat([header, ...frames]);

function expectBundleError(fn, exitCodes) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof F.BundleError, `expected BundleError, got ${e && e.name}: ${e && e.message}`);
    if (exitCodes) assert.ok(exitCodes.includes(e.exitCode), `unexpected exit code ${e.exitCode} (${e.message})`);
    return true;
  });
}

test('round trip is byte exact across chunk boundaries', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const entries = makeEntries();
  const { out, manifest, chunks, key } = build(dir, entries);
  key.fill(0);
  assert.ok(chunks > 10, 'expected a multi-chunk bundle');
  assert.equal(manifest.files.length, entries.length);
  const { got, r } = extractAll(out, { passphrase: PASS });
  r.key.fill(0);
  for (const e of entries) assert.ok(got.get(e.path).equals(e.buffer), `content mismatch for ${e.path}`);
  for (const f of r.manifest.files) {
    const e = entries.find((x) => x.path === f.path);
    assert.equal(f.size, e.buffer.length);
    assert.equal(f.sha256, crypto.createHash('sha256').update(e.buffer).digest('hex'));
  }
  const secret = r.manifest.files.find((f) => f.path.startsWith('secrets/'));
  assert.equal(secret.mode, '0600');
  assert.equal(secret.secret, true);
});

test('round trip streaming from a source path', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const data = crypto.randomBytes(CHUNK * 5 + 3);
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, data);
  const { out, key } = build(dir, [{ path: 'config/streamed.json', sourcePath: src }]);
  key.fill(0);
  const { got, r } = extractAll(out, { passphrase: PASS });
  r.key.fill(0);
  assert.ok(got.get('config/streamed.json').equals(data));
});

test('ciphertext does not contain plaintext and the header is plain', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir);
  key.fill(0);
  const raw = fs.readFileSync(out);
  assert.equal(raw.subarray(0, 8).toString('ascii'), 'CBRBNDL1');
  assert.ok(!raw.includes(Buffer.from('FAKE-marker-secret-AAAA')));
  assert.ok(!raw.includes(Buffer.from('resourcer-bundle')), 'manifest must be inside the encrypted payload');
  assert.ok(!raw.includes(Buffer.from('caterer-credentials')));
});

test('two bundles from the same input differ (fresh salt and nonce prefix)', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const a = build(dir);
  a.key.fill(0);
  const first = fs.readFileSync(a.out);
  const b = build(dir);
  b.key.fill(0);
  const second = fs.readFileSync(b.out);
  assert.ok(!first.subarray(20, 56).equals(second.subarray(20, 56)));
});

test('wrong passphrase fails with exactly "authentication failed" and never reaches a sink', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir);
  key.fill(0);
  let sinkCalls = 0;
  assert.throws(() => F.scanBundle(out, { passphrase: PASS + 'x' }, { sink() { sinkCalls += 1; return null; } }), (e) => {
    assert.ok(e instanceof F.BundleError);
    assert.equal(e.message, 'authentication failed');
    assert.equal(e.exitCode, F.EXIT.AUTH);
    return true;
  });
  assert.equal(sinkCalls, 0);
});

test('every truncation point is detected', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir, [{ path: 'config/a.json', buffer: crypto.randomBytes(CHUNK * 3 + 5) }]);
  const raw = fs.readFileSync(out);
  const cut = path.join(dir, 'cut.enc');
  for (let len = 0; len < raw.length; len += 1) {
    fs.writeFileSync(cut, raw.subarray(0, len));
    expectBundleError(() => F.scanBundle(cut, { key }), [F.EXIT.AUTH, F.EXIT.FORMAT]);
  }
  key.fill(0);
});

test('a single flipped bit anywhere is detected', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir, [{ path: 'config/a.json', buffer: crypto.randomBytes(CHUNK * 2 + 5) }]);
  const raw = fs.readFileSync(out);
  const bad = path.join(dir, 'bad.enc');
  for (let i = 0; i < raw.length; i += 1) {
    const copy = Buffer.from(raw);
    copy[i] ^= 0x01;
    fs.writeFileSync(bad, copy);
    expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.AUTH, F.EXIT.FORMAT, F.EXIT.VERIFY]);
  }
  key.fill(0);
});

test('reordered, duplicated, dropped and appended chunks are detected', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir, [{ path: 'config/a.json', buffer: crypto.randomBytes(CHUNK * 6 + 5) }]);
  const { header, frames } = parseFrames(fs.readFileSync(out));
  assert.ok(frames.length >= 6);
  const bad = path.join(dir, 'bad.enc');
  const cases = {
    swap: (f) => { const c = f.slice(); [c[1], c[2]] = [c[2], c[1]]; return c; },
    swapFirstLast: (f) => { const c = f.slice(); [c[0], c[c.length - 1]] = [c[c.length - 1], c[0]]; return c; },
    duplicate: (f) => [...f.slice(0, 3), f[2], ...f.slice(3)],
    dropMiddle: (f) => [...f.slice(0, 2), ...f.slice(3)],
    dropFirst: (f) => f.slice(1),
    dropFinal: (f) => f.slice(0, -1),
    repeatFinal: (f) => [...f, f[f.length - 1]],
    appendFrame: (f) => [...f, f[1]],
    reverse: (f) => f.slice().reverse(),
  };
  for (const [name, fn] of Object.entries(cases)) {
    fs.writeFileSync(bad, assemble(header, fn(frames)));
    assert.throws(() => F.scanBundle(bad, { key }), (e) => e instanceof F.BundleError, `case ${name} was not detected`);
  }
  key.fill(0);
});

test('trailing garbage after the final chunk is detected', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir);
  fs.appendFileSync(out, Buffer.from([0]));
  expectBundleError(() => F.scanBundle(out, { key }), [F.EXIT.FORMAT]);
  key.fill(0);
});

test('header downgrade and unknown versions are refused', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const { out, key } = build(dir);
  const raw = fs.readFileSync(out);
  const bad = path.join(dir, 'bad.enc');
  const tweak = (fn) => { const c = Buffer.from(raw); fn(c); fs.writeFileSync(bad, c); };
  tweak((c) => { c[12] = 10; });
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  tweak((c) => { c.writeUInt16BE(2, 8); });
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  tweak((c) => { c[13] = 1; });
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  tweak((c) => { c.write('NOTABNDL', 0, 'ascii'); });
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  fs.writeFileSync(bad, Buffer.from('tiny'));
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  fs.writeFileSync(bad, Buffer.alloc(0));
  expectBundleError(() => F.scanBundle(bad, { key }), [F.EXIT.FORMAT]);
  key.fill(0);
});

test('KDF cost below 2^15 cannot be requested and the default is at least 2^15', () => {
  assert.ok(F.MIN_LOG2N >= 15);
  assert.ok(F.DEFAULT_LOG2N >= 15);
  assert.throws(() => F.newHeader({ logN: 14 }), F.BundleError);
  const saved = process.env.BUNDLE_SCRYPT_LOG2N;
  process.env.BUNDLE_SCRYPT_LOG2N = '12';
  try { assert.throws(() => F.newHeader(), F.BundleError); } finally { process.env.BUNDLE_SCRYPT_LOG2N = saved; }
  delete process.env.BUNDLE_SCRYPT_LOG2N;
  try { assert.equal(F.newHeader().logN, F.DEFAULT_LOG2N); } finally { process.env.BUNDLE_SCRYPT_LOG2N = saved; }
});

// Build a bundle with an arbitrary manifest and payload to prove the reader does not trust the manifest.
function craft(file, manifest, payload, key, header) {
  const fd = fs.openSync(file, 'w');
  try {
    const w = new F.ChunkWriter(fd, key, header);
    const m = Buffer.from(JSON.stringify(manifest));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(m.length, 0);
    w.write(len);
    w.write(m);
    w.write(payload);
    w.finish();
  } finally {
    fs.closeSync(fd);
  }
}

function craftedManifest(files) {
  return Object.assign(F.newManifestBase({ sourceHost: 't', warnings: [] }), { files });
}

test('the reader does not trust the manifest (paths, sizes, hashes, trailing payload)', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const header = F.newHeader({ logN: 15, chunkSize: CHUNK });
  const key = F.deriveKey(PASS, header);
  const body = Buffer.from('hello');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const good = { path: 'config/a.json', size: body.length, sha256: sha, mode: '0644' };
  const file = path.join(dir, 'c.enc');

  craft(file, craftedManifest([good]), body, key, header);
  F.scanBundle(file, { key });

  const bads = {
    traversal: [{ ...good, path: '../evil.json' }],
    nested: [{ ...good, path: 'config/../../evil.json' }],
    absolute: [{ ...good, path: '/etc/passwd' }],
    backslash: [{ ...good, path: `config${String.fromCharCode(92)}a.json` }],
    dashboardAuth: [{ ...good, path: 'config/dashboard-auth.json' }],
    dashboardAuthCase: [{ ...good, path: 'config/Dashboard-Auth.JSON' }],
    unknownTop: [{ ...good, path: 'runs/x.json' }],
    session: [{ ...good, path: 'caterer-session.json' }],
    hiddenFile: [{ ...good, path: 'config/.hidden.json' }],
    duplicate: [good, good],
    duplicateCase: [good, { ...good, path: 'config/A.json' }],
    badSha: [{ ...good, sha256: 'zz' }],
    badMode: [{ ...good, mode: '4755' }],
    badSize: [{ ...good, size: -1 }],
    secretOpenMode: [{ ...good, path: 'secrets/reed-credentials.json', mode: '0644' }],
  };
  for (const [name, files] of Object.entries(bads)) {
    craft(file, craftedManifest(files), body, key, header);
    assert.throws(() => F.scanBundle(file, { key }), (e) => e instanceof F.BundleError && e.exitCode === F.EXIT.FORMAT, `manifest case ${name} was not rejected`);
  }
  craft(file, craftedManifest([{ ...good, sha256: crypto.createHash('sha256').update('other').digest('hex') }]), body, key, header);
  expectBundleError(() => F.scanBundle(file, { key }), [F.EXIT.VERIFY]);
  craft(file, craftedManifest([{ ...good, size: body.length + 3 }]), body, key, header);
  expectBundleError(() => F.scanBundle(file, { key }), [F.EXIT.FORMAT]);
  craft(file, craftedManifest([good]), Buffer.concat([body, Buffer.from('extra')]), key, header);
  expectBundleError(() => F.scanBundle(file, { key }), [F.EXIT.FORMAT]);
  key.fill(0);
});

test('classifyPath allowlist', () => {
  const ok = ['candidates.db', 'config/postcode-cities.json', 'scripts/extract-js.b64', 'postcode-lookup-cache.json', 'reed-location-cache.json',
    'pending-searches/territory-1-2.json', 'secrets/caterer-credentials.json', 'secrets/zoho-credentials.json', 'secrets/reed-credentials.json'];
  for (const p of ok) assert.ok(F.classifyPath(p), p);
  const bad = ['', 'candidates.db-wal', 'config/dashboard-auth.json', 'config/sub/x.json', 'config/x.txt', 'caterer-session.json', 'reed-session.json',
    'secrets/other.json', 'secrets/caterer-credentials.json.bak', 'downloads/cv-1.pdf', 'runs/phase1-1.json', 'logs/x.log', 'pending-searches/../x.json',
    'pending-searches/.dup/x.json', 'scripts/other.js', 'review-tmp-1.json', '.env', 'C:/x.json'];
  for (const p of bad) assert.equal(F.classifyPath(p), null, p);
  assert.equal(F.classifyPath('secrets/caterer-credentials.json').secret, true);
  assert.equal(F.classifyPath('candidates.db').mode, 0o600);
  assert.equal(F.classifyPath('config/x.json').mode, 0o644);
});

test('writeBundle refuses paths outside the allowlist', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  assert.throws(() => build(dir, [{ path: 'caterer-session.json', buffer: Buffer.from('x') }]), F.BundleError);
  assert.throws(() => build(dir, [{ path: 'config/dashboard-auth.json', buffer: Buffer.from('x') }]), F.BundleError);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0, 'no temp file may be left behind');
});

test('a source that changes while packing is detected and leaves no output', (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, crypto.randomBytes(CHUNK * 2));
  const out = path.join(dir, 'b.enc');
  const realRead = fs.readSync;
  let reads = 0;
  fs.readSync = function patched(fd, ...rest) {
    const n = realRead.call(fs, fd, ...rest);
    reads += 1;
    if (reads === 2) fs.writeFileSync(src, crypto.randomBytes(CHUNK * 2));
    return n;
  };
  try {
    assert.throws(() => F.writeBundle(out, {
      passphrase: PASS, chunkSize: CHUNK, logN: 15, entries: [{ path: 'config/b.json', sourcePath: src }],
      manifestBase: F.newManifestBase({ sourceHost: 't', warnings: [] }),
    }), (e) => e instanceof F.BundleError && /source changed while packing/.test(e.message));
  } finally {
    fs.readSync = realRead;
  }
  assert.ok(!fs.existsSync(out), 'no output may remain');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0);
});

// ---------------------------------------------------------------------------
// Passphrase handling

function fakeTty() {
  const tty = new EventEmitter();
  tty.isTTY = true;
  tty.raw = false;
  tty.setRawMode = (v) => { tty.raw = v; };
  tty.setEncoding = () => {};
  tty.resume = () => {};
  tty.pause = () => {};
  return tty;
}

function fakeOut() {
  return { text: '', write(s) { this.text += s; } };
}

test('hidden prompt does not echo, handles backspace, and restores the terminal', async () => {
  const tty = fakeTty();
  const out = fakeOut();
  const p = F.promptHidden('Pass: ', { input: tty, output: out });
  assert.equal(tty.raw, true);
  tty.emit('data', 'abcd');
  tty.emit('data', '\u007fXY');
  tty.emit('data', 'Z\r');
  const got = await p;
  assert.equal(got, 'abcXYZ');
  assert.equal(tty.raw, false);
  assert.ok(out.text.startsWith('Pass: '));
  assert.ok(!out.text.includes('abc') && !out.text.includes('XYZ'), 'typed characters must not be echoed');
});

test('hidden prompt: Ctrl-C aborts, non-TTY input is refused', async () => {
  const tty = fakeTty();
  const p = F.promptHidden('P: ', { input: tty, output: fakeOut() });
  tty.emit('data', 'ab\u0003');
  await assert.rejects(p, (e) => e instanceof F.BundleError && e.exitCode === F.EXIT.PASSPHRASE);
  assert.equal(tty.raw, false);
  await assert.rejects(F.promptHidden('P: ', { input: { isTTY: false }, output: fakeOut() }), (e) => e.exitCode === F.EXIT.PASSPHRASE);
});

test('acquirePassphrase: interactive twice, mismatch, length policy, sources', async (t) => {
  const dir = H.mkTmp('fmt-');
  t.after(() => H.rmTmp(dir));
  const io = F.createOutput({ stdout: fakeOut(), stderr: fakeOut() });

  const tty = fakeTty();
  const err = fakeOut();
  const pw = F.acquirePassphrase({ env: {}, io, confirm: true, minLength: 16, stdin: tty, stderr: err });
  tty.emit('data', 'sixteen chars ok!\r');
  await new Promise((r) => setImmediate(r));
  tty.emit('data', 'sixteen chars ok!\r');
  assert.equal(await pw, 'sixteen chars ok!');

  const tty2 = fakeTty();
  const pw2 = F.acquirePassphrase({ env: {}, io, confirm: true, minLength: 16, stdin: tty2, stderr: fakeOut() });
  tty2.emit('data', 'sixteen chars ok!\r');
  await new Promise((r) => setImmediate(r));
  tty2.emit('data', 'sixteen chars nope\r');
  await assert.rejects(pw2, /do not match/);

  const short = H.passFile(dir, 'fifteen chars!!', 'short.txt');
  await assert.rejects(F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: short }, io, minLength: 16 }), (e) => e.exitCode === F.EXIT.PASSPHRASE && /at least 16/.test(e.message));
  const exact = H.passFile(dir, 'exactly sixteen!!', 'exact.txt');
  assert.equal(await F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: exact }, io, minLength: 16 }), 'exactly sixteen!!');
  const crlf = path.join(dir, 'crlf.txt');
  fs.writeFileSync(crlf, 'windows line ending ok\r\n');
  assert.equal(await F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: crlf }, io, minLength: 16 }), 'windows line ending ok');
  const empty = path.join(dir, 'empty.txt');
  fs.writeFileSync(empty, '\n');
  await assert.rejects(F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: empty }, io }), /empty/);
  await assert.rejects(F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: path.join(dir, 'missing.txt') }, io }), (e) => e.exitCode === F.EXIT.PASSPHRASE);
  await assert.rejects(F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FILE: exact, BUNDLE_PASSPHRASE_FD: '3' }, io }), /only one/);
  await assert.rejects(F.acquirePassphrase({ env: {}, io, stdin: { isTTY: false } }), /no passphrase source/);
  await assert.rejects(F.acquirePassphrase({ env: { BUNDLE_PASSPHRASE_FD: 'abc' }, io }), (e) => e.exitCode === F.EXIT.PASSPHRASE);
});

test('passphrase is NFKC-normalised before key derivation', () => {
  const header = F.newHeader({ logN: 15, chunkSize: CHUNK });
  const a = F.deriveKey('caf\u00e9 caf\u00e9 caf\u00e9 caf\u00e9', header);
  const b = F.deriveKey('cafe\u0301 cafe\u0301 cafe\u0301 cafe\u0301', header);
  assert.ok(a.equals(b));
});

test('output scrubber replaces registered secrets everywhere', () => {
  const out = fakeOut();
  const err = fakeOut();
  const io = F.createOutput({ stdout: out, stderr: err });
  io.addSecret('super-secret-value');
  io.addSecretsFromObject({ a: 'another-secret', nested: { b: 'nested-secret-1' }, short: 'abc' });
  io.log('x super-secret-value y another-secret z nested-secret-1 abc');
  io.warn('super-secret-value');
  assert.equal(out.text, 'x [redacted] y [redacted] z [redacted] abc\n');
  assert.equal(err.text, '[redacted]\n');
});

// ---------------------------------------------------------------------------
// Liveness detection (pure file logic)

function liveHome(t) {
  const home = H.mkTmp('live-');
  t.after(() => H.rmTmp(home));
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  return home;
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60000;

test('checkPipelineLive: statuses and ages', (t) => {
  const home = liveHome(t);
  const put = (name, obj) => fs.writeFileSync(path.join(home, 'runs', name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  put('phase1-a.json', { status: 'complete', updatedAt: iso(1 * MIN) });
  put('phase1-b.json', { status: 'phase1_abandoned', updatedAt: iso(1 * MIN) });
  put('phase1-c.json', { status: 'error', updatedAt: iso(1 * MIN) });
  put('phase1-d.json', { status: 'phase1_stale', updatedAt: iso(1 * MIN) });
  put('phase1-e.json', { status: 'phase1_running', updatedAt: iso(120 * MIN) });
  put('run-merged-queue-x.json', { status: 'complete', updatedAt: iso(1 * MIN) });
  put('run-merged-queue-y.json', { totals: 1 });
  put('params-watchdog-z.json', { status: 'phase1_running', updatedAt: iso(1 * MIN) });
  assert.equal(F.checkPipelineLive(home).live, false);
  put('run-merged-queue-w.json', { status: 'phase2_pushing', updatedAt: iso(1 * MIN) });
  assert.equal(F.checkPipelineLive(home).live, true, 'a fresh in-flight run-*.json counts as live');
  fs.unlinkSync(path.join(home, 'runs', 'run-merged-queue-w.json'));

  put('phase1-f.json', { status: 'phase1_running', updatedAt: iso(89 * MIN) });
  let r = F.checkPipelineLive(home);
  assert.equal(r.live, true);
  assert.match(r.reasons[0], /phase1-f\.json status=phase1_running/);
  fs.unlinkSync(path.join(home, 'runs', 'phase1-f.json'));

  put('phase1-g.json', { status: 'phase1_running', updatedAt: iso(91 * MIN) });
  assert.equal(F.checkPipelineLive(home).live, false);
  put('phase1-h.json', { status: 'phase1_complete', phase2Status: 'pending', updatedAt: iso(5 * MIN) });
  assert.equal(F.checkPipelineLive(home).live, true);
  fs.unlinkSync(path.join(home, 'runs', 'phase1-h.json'));
  put('phase1-i.json', { status: 'phase2_pushing', startedAt: iso(3 * MIN) });
  assert.equal(F.checkPipelineLive(home).live, true);
  fs.unlinkSync(path.join(home, 'runs', 'phase1-i.json'));
  put('phase1-j.json', '{ not json');
  r = F.checkPipelineLive(home);
  assert.equal(r.live, true, 'a freshly modified unreadable status file counts as live');
  assert.match(r.reasons[0], /unreadable/);
});

test('checkPipelineLive: lock files and the halt file', (t) => {
  const home = liveHome(t);
  const lock = path.join(home, 'runs', 'phase1-x.json.run-lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5 * MIN }));
  let r = F.checkPipelineLive(home);
  assert.equal(r.live, true);
  assert.match(r.reasons[0], /run-lock/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now() - 5 * MIN }));
  r = F.checkPipelineLive(home);
  assert.equal(r.live, false);
  assert.equal(r.stale.length, 1);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 61 * MIN }));
  assert.equal(F.checkPipelineLive(home).live, false);
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(home, 'runtime', 'tick.lock'), String(process.pid));
  assert.equal(F.checkPipelineLive(home).live, true);
  fs.unlinkSync(path.join(home, 'runtime', 'tick.lock'));
  assert.equal(F.checkPipelineLive(home).halt.present, false);
  fs.writeFileSync(path.join(home, 'runtime', 'pipeline-halt.json'), JSON.stringify({ halted: true, reason: 'migration', since: iso(MIN) }));
  r = F.checkPipelineLive(home);
  assert.equal(r.live, false, 'a halt is a fence, not a live run');
  assert.deepEqual([r.halt.present, r.halt.reason], [true, 'migration']);
});

test('compareDatabases: newer, older, equivalent', () => {
  const bundle = { tables: { candidates: 10, candidate_rejections: 5, territory_searches: 3, reed_daily_usage: 2 }, watermark: '2026-09-01T10:00:00' };
  const same = { tables: { ...bundle.tables, reed_location_cache: 99, run_results: 0 }, watermark: bundle.watermark };
  assert.deepEqual(F.compareDatabases(same, bundle), { newer: false, reasons: [], equivalent: true });
  const moreRows = { tables: { ...bundle.tables, candidates: 11 }, watermark: bundle.watermark };
  assert.equal(F.compareDatabases(moreRows, bundle).newer, true);
  const later = { tables: bundle.tables, watermark: '2026-09-02T00:00:00' };
  assert.equal(F.compareDatabases(later, bundle).newer, true);
  const older = { tables: { ...bundle.tables, candidates: 4 }, watermark: '2026-08-01T00:00:00' };
  const c = F.compareDatabases(older, bundle);
  assert.equal(c.newer, false);
  assert.equal(c.equivalent, false);
  const withRunResults = { tables: { ...bundle.tables, run_results: 7 }, watermark: bundle.watermark };
  assert.equal(F.compareDatabases(withRunResults, bundle).newer, true);
  const empty = { tables: {}, watermark: null };
  assert.equal(F.compareDatabases(empty, bundle).newer, false);
});
