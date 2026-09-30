'use strict';
// End-to-end tests of make-bundle / restore-bundle / verify-bundle against a fake legacy workspace.
// Every value is fake; no network; temp dirs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const H = require('./_helpers');
const MB = require('../../tools/make-bundle.js');

const { F, FAKE } = H;
process.env.BUNDLE_SCRYPT_LOG2N = '15';

const posix = process.platform !== 'win32';
const BS = String.fromCharCode(92);
const MIN = 60000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function dbHash(file) {
  const D = H.sqlite();
  const db = new D(file, { readonly: true });
  try {
    const h = crypto.createHash('sha256');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const t of tables) {
      h.update(t);
      for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).iterate()) h.update(JSON.stringify(row));
    }
    return h.digest('hex');
  } finally {
    db.close();
  }
}

function dbInfo(file) {
  const D = H.sqlite();
  return F.inspectDatabase(D, { file });
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

let shared;
test.before(() => {
  const root = H.mkTmp('tools-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'), { badPending: true });
  const before = H.snapshotTree(src);
  const out = path.join(root, 'bundle', 'b.enc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const made = H.make(src, out);
  assert.equal(made.status, 0, made.all);
  shared = { root, src, out, made, sourceBefore: before };
});
test.after(() => { if (shared) H.rmTmp(shared.root); });

function freshHome(t, name = 'home') {
  const d = H.mkTmp('home-');
  t.after(() => H.rmTmp(d));
  return path.join(d, name);
}

function tmpDir(t, prefix) {
  const d = H.mkTmp(prefix);
  t.after(() => H.rmTmp(d));
  return d;
}

// ---------------------------------------------------------------------------
// make-bundle

test('make: bundle holds exactly the allowlisted files and the manifest is complete', () => {
  const { manifest, contents } = H.readManifest(shared.out);
  const paths = manifest.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'candidates.db', 'config/postcode-cities.json', 'config/territory-defaults.json',
    'pending-searches/search-d.json', 'pending-searches/territory-a-20260929-0103.json',
    'pending-searches/territory-b-20260929-0103.json', 'pending-searches/territory-c-20260929-0103.json',
    'postcode-lookup-cache.json', 'postcode-to-city-cache.json', 'reed-location-cache.json',
    'scripts/extract-js.b64', 'secrets/caterer-credentials.json', 'secrets/reed-credentials.json', 'secrets/zoho-credentials.json',
  ]);
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.size, contents.get(f.path).length);
    assert.match(f.mode, /^0[0-7]{3}$/);
  }
  assert.equal(manifest.files.find((f) => f.path === 'candidates.db').mode, '0600');
  for (const f of manifest.files.filter((x) => x.path.startsWith('secrets/'))) assert.equal(f.mode, '0600');
  assert.deepEqual(manifest.dirs.map((d) => `${d.path}:${d.mode}`).sort(), ['config:0755', 'pending-searches:0755', 'scripts:0755', 'secrets:0700']);
  assert.equal(manifest.db.integrity, 'ok');
  assert.deepEqual(manifest.db.tables, { candidate_rejections: 80, candidates: 300, reed_daily_usage: 10, reed_location_cache: 3, territory_searches: 25 });
  assert.match(manifest.db.watermark, /^2026-09-28T/);
  assert.match(manifest.builtAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(manifest.sourceHost.length > 0);
  assert.ok(manifest.warnings.some((w) => /broken\.json/.test(w)));
  for (const w of manifest.warnings) assert.ok(!H.secretValues().some((v) => w.includes(v)), 'warnings must not carry secrets');
  for (const decoy of [FAKE.dashboardAuth, FAKE.sessionCookie, 'FAKE CV BYTES']) {
    for (const [p, buf] of contents) assert.ok(!buf.includes(decoy), `${p} carries decoy data`);
  }
});

test('make: secrets are opaque copies (caterer, zoho) and reed is built from the two source files', () => {
  const { contents } = H.readManifest(shared.out);
  assert.ok(contents.get('secrets/caterer-credentials.json').equals(fs.readFileSync(path.join(shared.src, 'caterer-credentials.json'))));
  assert.ok(contents.get('secrets/zoho-credentials.json').equals(fs.readFileSync(path.join(shared.src, 'zoho-credentials.json'))));
  const reed = JSON.parse(contents.get('secrets/reed-credentials.json').toString('utf8'));
  assert.deepEqual(reed, { email: FAKE.reedEmail, username: FAKE.reedEmail, password: FAKE.reedPass });
});

test('make: pending searches lose spawnedAt (and BOMs); config, caches and extract-js are byte copies', () => {
  const { contents } = H.readManifest(shared.out);
  const pend = (n) => JSON.parse(contents.get(`pending-searches/${n}`).toString('utf8'));
  assert.equal('spawnedAt' in pend('territory-a-20260929-0103.json'), false);
  assert.equal('spawnedAt' in pend('territory-c-20260929-0103.json'), false);
  assert.equal(pend('territory-a-20260929-0103.json').jobTitle, 'Fake Role 1');
  assert.equal(pend('territory-c-20260929-0103.json').keywords, '');
  assert.equal(pend('territory-b-20260929-0103.json').jobTitle, 'Fake Role 2');
  assert.notEqual(contents.get('pending-searches/territory-b-20260929-0103.json')[0], 0xEF, 'BOM must be gone');
  for (const p of ['config/postcode-cities.json', 'config/territory-defaults.json', 'postcode-lookup-cache.json', 'postcode-to-city-cache.json', 'reed-location-cache.json', 'scripts/extract-js.b64']) {
    assert.ok(contents.get(p).equals(fs.readFileSync(path.join(shared.src, ...p.split('/')))), p);
  }
  assert.match(readText(path.join(shared.src, 'pending-searches', 'territory-a-20260929-0103.json')), /spawnedAt/, 'the source must keep its original');
});

test('make: never modifies the source workspace, leaves no temp files, output is atomic and 0600', () => {
  assert.deepEqual(H.snapshotTree(shared.src), shared.sourceBefore);
  const names = fs.readdirSync(path.dirname(shared.out));
  assert.ok(!names.some((n) => n.includes('.tmp-')));
  if (posix) assert.equal(fs.statSync(shared.out).mode & 0o777, 0o600);
  assert.match(shared.made.stdout, /BUNDLE_OK out=.* size=\d+ sha256=[0-9a-f]{64} files=14/);
});

test('make: the same output path can be rebuilt (fresh bundle id, old file replaced atomically)', (t) => {
  const dir = tmpDir(t, 'rebuild-');
  const out = path.join(dir, 'b.enc');
  assert.equal(H.make(shared.src, out).status, 0);
  const a = H.readManifest(out).manifest.bundleId;
  assert.equal(H.make(shared.src, out).status, 0);
  const b = H.readManifest(out).manifest.bundleId;
  assert.notEqual(a, b);
});

test('make: --host-label is sanitised into the manifest', (t) => {
  const dir = tmpDir(t, 'label-');
  const out = path.join(dir, 'b.enc');
  assert.equal(H.make(shared.src, out, ['--host-label', 'My Laptop!']).status, 0);
  assert.equal(H.readManifest(out).manifest.sourceHost, 'My-Laptop-');
});

test('make: --dry-run lists files, writes nothing and needs no passphrase', (t) => {
  const dir = tmpDir(t, 'dry-');
  const out = path.join(dir, 'never.enc');
  const before = H.snapshotTree(shared.src);
  const r = H.runTool('make-bundle.js', ['--source', shared.src, '--out', out, '--dry-run']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /DRY_RUN_OK/);
  assert.match(r.stdout, /candidates\.db/);
  assert.ok(!fs.existsSync(out));
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(H.snapshotTree(shared.src), before);
});

test('make: a WAL-mode source with uncheckpointed writes is captured consistently as a single file', (t) => {
  const root = tmpDir(t, 'wal-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'), { journal: 'wal' });
  const D = H.sqlite();
  const writer = new D(path.join(src, 'candidates.db'));
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    const ins = writer.prepare("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, 'Wal Role', '2026-09-29', 't')");
    for (let i = 0; i < 5; i += 1) ins.run(700000 + i);
    const out = path.join(root, 'b.enc');
    const r = H.make(src, out);
    assert.equal(r.status, 0, r.all);
    const { manifest } = H.readManifest(out);
    assert.equal(manifest.db.tables.candidate_rejections, 85);
    assert.equal(manifest.db.journalMode, 'delete');
    const home = path.join(root, 'home');
    assert.equal(H.restore(out, home).status, 0);
    assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.candidate_rejections, 85);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db-wal')));
  } finally {
    writer.close();
  }
});

test('make: a corrupt source database is refused (exit 5, no bundle)', (t) => {
  const root = tmpDir(t, 'corrupt-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'), { dbRows: { candidates: 4000, candidate_rejections: 800, territory_searches: 25, reed_daily_usage: 10, reed_location_cache: 3 } });
  const dbFile = path.join(src, 'candidates.db');
  const size = fs.statSync(dbFile).size;
  const fd = fs.openSync(dbFile, 'r+');
  fs.writeSync(fd, crypto.randomBytes(size - 12288), 0, size - 12288, 8192);
  fs.closeSync(fd);
  const out = path.join(root, 'b.enc');
  const r = H.make(src, out);
  assert.equal(r.status, 5, r.all);
  assert.ok(!fs.existsSync(out));
  H.assertNoSecrets(assert, r.all, 'corrupt-db output');
});

test('make: missing pieces are reported by name (exit 5) and never as content', (t) => {
  const cases = [
    ['no database', (src) => fs.rmSync(path.join(src, 'candidates.db')), /candidates\.db/],
    ['no caterer credentials', (src) => fs.rmSync(path.join(src, 'caterer-credentials.json')), /caterer-credentials\.json/],
    ['no zoho credentials', (src) => fs.rmSync(path.join(src, 'zoho-credentials.json')), /zoho-credentials\.json/],
    ['no extract-js', (src) => fs.rmSync(path.join(src, 'scripts', 'extract-js.b64')), /extract-js\.b64/],
    ['no territory defaults', (src) => fs.rmSync(path.join(src, 'config', 'territory-defaults.json')), /territory-defaults\.json/],
    ['zoho creds not JSON', (src) => fs.writeFileSync(path.join(src, 'zoho-credentials.json'), `{ oops ${FAKE.zohoAccess}`), /zoho-credentials\.json is not a valid JSON object/],
    ['caterer creds not an object', (src) => fs.writeFileSync(path.join(src, 'caterer-credentials.json'), `"${FAKE.catererPass}"`), /caterer-credentials\.json is not a valid JSON object/],
  ];
  for (const [name, mutate, re] of cases) {
    const root = tmpDir(t, 'miss-');
    const src = H.buildFakeLegacy(path.join(root, 'legacy'));
    mutate(src);
    const out = path.join(root, 'b.enc');
    const r = H.make(src, out);
    assert.equal(r.status, 5, `${name}: ${r.all}`);
    assert.match(r.stderr, re, name);
    assert.ok(!fs.existsSync(out), name);
    H.assertNoSecrets(assert, r.all, name);
  }
});

test('make: optional caches may be absent (warning only)', (t) => {
  const root = tmpDir(t, 'opt-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'));
  for (const n of ['postcode-lookup-cache.json', 'postcode-to-city-cache.json', 'reed-location-cache.json']) fs.rmSync(path.join(src, n));
  fs.rmSync(path.join(src, 'pending-searches'), { recursive: true });
  const out = path.join(root, 'b.enc');
  const r = H.make(src, out);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stderr, /reed-location-cache\.json: not present/);
  assert.equal(H.readManifest(out).manifest.files.length, 7);
});

// ---------------------------------------------------------------------------
// make-bundle: live pipeline refusal

function liveFixture(t) {
  const root = tmpDir(t, 'live-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'));
  return { root, src, out: path.join(root, 'b.enc') };
}

test('make: refuses while a run is live and writes nothing', (t) => {
  const { src, out } = liveFixture(t);
  H.write(path.join(src, 'runs', 'phase1-2026-09-29-100000.json'), JSON.stringify({ id: 'x', status: 'phase1_running', updatedAt: iso(10 * MIN) }));
  const r = H.make(src, out);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /phase1-2026-09-29-100000\.json status=phase1_running/);
  assert.match(r.stderr, /refusing to build a bundle while a pipeline run is live/);
  assert.ok(!fs.existsSync(out));
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((n) => n !== 'pass.txt' && n !== 'legacy'), []);
  H.assertNoSecrets(assert, r.all, 'live refusal');
});

test('make: live detection covers statuses, ages, lock files and unreadable files', (t) => {
  const { src, out } = liveFixture(t);
  const runs = path.join(src, 'runs');
  const dry = () => H.runTool('make-bundle.js', ['--source', src, '--out', out, '--dry-run']);
  const put = (name, v) => H.write(path.join(runs, name), typeof v === 'string' ? v : JSON.stringify(v));
  const clear = () => { for (const n of fs.readdirSync(runs)) if (!/^phase1-2026-01-0/.test(n)) fs.rmSync(path.join(runs, n)); };

  put('phase1-t1.json', { status: 'phase1_running', updatedAt: iso(120 * MIN) });
  put('phase1-t2.json', { status: 'complete', updatedAt: iso(1 * MIN) });
  put('phase1-t3.json', { status: 'phase1_abandoned', updatedAt: iso(1 * MIN) });
  assert.equal(dry().status, 0, 'old non-terminal and fresh terminal statuses are not live');
  clear();

  for (const status of ['phase1_initializing', 'phase1_searching', 'phase1_active', 'phase1_complete', 'phase2_starting', 'phase2_pushing']) {
    put('phase1-live.json', { status, updatedAt: iso(30 * MIN) });
    assert.equal(dry().status, 4, `status ${status} must count as live`);
  }
  clear();
  put('phase1-live.json', { status: 'phase1_running', updatedAt: iso(89 * MIN) });
  assert.equal(dry().status, 4);
  put('phase1-live.json', { status: 'phase1_running', updatedAt: iso(95 * MIN) });
  assert.equal(dry().status, 0);
  clear();

  put('phase1-live.json', '{ half written');
  assert.equal(dry().status, 4, 'a recently modified unreadable status file counts as live');
  clear();

  put('phase1-x.json.run-lock', { pid: process.pid, startedAt: Date.now() - 5 * MIN });
  assert.equal(dry().status, 4, 'a fresh run-lock held by a live pid is live');
  put('phase1-x.json.run-lock', { pid: 2 ** 22 + 4242, startedAt: Date.now() - 5 * MIN });
  const stale = dry();
  assert.equal(stale.status, 0, stale.all);
  assert.match(stale.stderr, /stale lock ignored/);
  clear();
  H.write(path.join(src, 'runtime', 'resourcer-tick.lock'), String(process.pid));
  assert.equal(dry().status, 4, 'a runtime lock file held by a live pid is live');
  fs.rmSync(path.join(src, 'runtime', 'resourcer-tick.lock'));
});

test('make: the halt file is a fence, not a live run; --require-fence insists on it', (t) => {
  const { src, out } = liveFixture(t);
  const r0 = H.runTool('make-bundle.js', ['--source', src, '--out', out, '--dry-run', '--require-fence']);
  assert.equal(r0.status, 4, r0.all);
  assert.match(r0.stderr, /require-fence/);
  H.write(path.join(src, 'runtime', 'pipeline-halt.json'), JSON.stringify({ halted: true, reason: 'migration', since: iso(MIN) }));
  const r1 = H.runTool('make-bundle.js', ['--source', src, '--out', out, '--dry-run', '--require-fence']);
  assert.equal(r1.status, 0, r1.all);
  assert.match(r1.stdout, /halt file present \(reason: migration\)/);
  assert.ok(!/no pipeline halt/.test(r1.stderr));
  const full = H.make(src, out);
  assert.equal(full.status, 0, full.all);
  assert.deepEqual([H.readManifest(out).manifest.source.haltPresent, H.readManifest(out).manifest.source.haltReason], [true, 'migration']);
});

test('make: --i-paused-the-pipeline needs a typed confirmation on a terminal', async (t) => {
  const { src, out } = liveFixture(t);
  H.write(path.join(src, 'runs', 'phase1-live.json'), JSON.stringify({ status: 'phase1_running', updatedAt: iso(5 * MIN) }));

  const nonTty = H.runTool('make-bundle.js', ['--source', src, '--out', out, '--i-paused-the-pipeline'], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(path.dirname(out)) } });
  assert.equal(nonTty.status, 4, nonTty.all);
  assert.match(nonTty.stderr, /typed confirmation not given/);
  assert.ok(!fs.existsSync(out));

  const fakeTty = () => {
    const tty = new EventEmitter();
    Object.assign(tty, { isTTY: true, setEncoding() {}, resume() {}, pause() {} });
    return tty;
  };
  const sink = { text: '', write(s) { this.text += s; } };
  const opts = { source: src, out, hostLabel: null, dryRun: true, paused: true, requireFence: false, tmpDir: null };
  const io = () => F.createOutput({ stdout: sink, stderr: sink });

  const wrong = fakeTty();
  const p1 = MB.makeBundle(opts, {}, io(), { stdin: wrong, stderr: sink });
  await new Promise((r) => setImmediate(r));
  wrong.emit('data', 'yes\n');
  await assert.rejects(p1, (e) => e instanceof F.BundleError && e.exitCode === F.EXIT.REFUSED);

  const right = fakeTty();
  const p2 = MB.makeBundle(opts, {}, io(), { stdin: right, stderr: sink });
  await new Promise((r) => setImmediate(r));
  right.emit('data', `${F.PAUSE_PHRASE}\n`);
  assert.equal(await p2, 0);
  assert.match(sink.text, /Type exactly "I PAUSED THE PIPELINE"/);
});

// ---------------------------------------------------------------------------
// Reed extraction

function reedSource(t, files) {
  const dir = tmpDir(t, 'reed-');
  for (const [name, text] of Object.entries(files)) H.write(path.join(dir, 'scripts', name), text);
  return dir;
}

test('reed extraction: literal forms', (t) => {
  const forms = [
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = 'pw-1';", 'a@b.invalid', 'pw-1'],
    ['const EMAIL = "a@b.invalid";\nconst PASSWORD = "pw-2";', 'a@b.invalid', 'pw-2'],
    ['let EMAIL = `a@b.invalid`;\nvar PASSWORD = `pw-3`;', 'a@b.invalid', 'pw-3'],
    [`  const EMAIL = 'a@b.invalid'; // note\nconst PASSWORD = 'it${BS}'s ${BS}${BS} fine ${BS}u0041${BS}x42';`, 'a@b.invalid', `it's ${BS} fine AB`],
    ["const EMAIL = 'a@b.invalid'\nconst PASSWORD = 'no-semicolon'\nconst X = 1;", 'a@b.invalid', 'no-semicolon'],
    ["// const EMAIL = 'commented-out@x.invalid';\nconst EMAIL = 'real@x.invalid';\nconst PASSWORD = 'pw';", 'real@x.invalid', 'pw'],
    ["const REED_EMAIL = 'alt@x.invalid';\nconst REED_PASSWORD = 'alt-pw';", 'alt@x.invalid', 'alt-pw'],
    ['const EMAIL = \'a"b@x.invalid\';\r\nconst PASSWORD = "p\'w";\r\n', 'a"b@x.invalid', "p'w"],
  ];
  for (const [text, email, pw] of forms) {
    const dir = reedSource(t, { 'cdp-reed-full-login.js': text });
    const r = MB.extractReedCredentials(dir);
    assert.equal(r.email, email);
    assert.equal(r.password, pw);
  }
});

test('reed extraction: anything that is not a plain literal fails, naming file and variable only', (t) => {
  const bad = [
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = 'abc' + 'def';", /PASSWORD not a plain string literal/],
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = 'abc'\n  + 'def';", /PASSWORD not a plain string literal/],
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = process.env.X || 'abc';", /PASSWORD declaration not found/],
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = `abc${x}`;", /PASSWORD template literal with interpolation/],
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = '';", /PASSWORD empty value/],
    ["const EMAIL = 'a@b.invalid';\nconst PASSWORD = 'unterminated;", /PASSWORD unterminated string/],
    ["const PASSWORD = 'abc';", /EMAIL declaration not found/],
    ["const EMAIL = 'a@b.invalid'.trim();\nconst PASSWORD = 'abc';", /EMAIL not a plain string literal/],
    [`const EMAIL = 'a@b.invalid';\nconst PASSWORD = 'a${BS}101b';`, /PASSWORD unsupported escape sequence/],
  ];
  for (const [text, re] of bad) {
    const dir = reedSource(t, { 'cdp-reed-full-login.js': text });
    assert.throws(() => MB.extractReedCredentials(dir), (e) => {
      assert.ok(e instanceof F.BundleError);
      assert.equal(e.exitCode, F.EXIT.VERIFY);
      assert.match(e.message, /cdp-reed-full-login\.js/);
      assert.match(e.message, /reed-clean-relogin\.js: file not found/);
      assert.match(e.message, re);
      assert.ok(!/a@b\.invalid|abc|def/.test(e.message), 'values must not be in the message');
      return true;
    });
  }
});

test('reed extraction: one good file is enough, differences and failures are warnings without values', (t) => {
  const good = "const EMAIL = 'first@x.invalid';\nconst PASSWORD = 'first-pw';";
  const other = "const EMAIL = 'first@x.invalid';\nconst PASSWORD = 'second-pw';";
  let r = MB.extractReedCredentials(reedSource(t, { 'cdp-reed-full-login.js': good, 'reed-clean-relogin.js': other }));
  assert.equal(r.password, 'first-pw');
  assert.equal(r.from, 'cdp-reed-full-login.js');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /PASSWORD differ between cdp-reed-full-login\.js and reed-clean-relogin\.js/);
  assert.ok(!/first-pw|second-pw|first@x/.test(r.warnings.join(' ')));

  r = MB.extractReedCredentials(reedSource(t, { 'cdp-reed-full-login.js': "const EMAIL = 'x@y.invalid';", 'reed-clean-relogin.js': other }));
  assert.equal(r.from, 'reed-clean-relogin.js');
  assert.match(r.warnings.join(' '), /cdp-reed-full-login\.js: PASSWORD declaration not found/);

  r = MB.extractReedCredentials(reedSource(t, { 'cdp-reed-full-login.js': good }));
  assert.equal(r.email, 'first@x.invalid');
  assert.match(r.warnings.join(' '), /reed-clean-relogin\.js: file not found/);
});

test('make: Reed extraction failure aborts with file and variable only (exit 5, no bundle)', (t) => {
  const { src, out } = liveFixture(t);
  fs.writeFileSync(path.join(src, 'scripts', 'cdp-reed-full-login.js'), `const EMAIL = '${FAKE.reedEmail}';\nconst PASSWORD = process.env.REED_PW || '${FAKE.reedPass}';\n`);
  fs.writeFileSync(path.join(src, 'scripts', 'reed-clean-relogin.js'), `const PASSWORD = '${FAKE.reedPass}';\n`);
  const r = H.make(src, out);
  assert.equal(r.status, 5, r.all);
  assert.match(r.stderr, /Reed credential extraction failed/);
  assert.match(r.stderr, /cdp-reed-full-login\.js: PASSWORD declaration not found/);
  assert.match(r.stderr, /reed-clean-relogin\.js: EMAIL declaration not found/);
  assert.ok(!fs.existsSync(out));
  H.assertNoSecrets(assert, r.all, 'reed failure');
});

// ---------------------------------------------------------------------------
// Passphrase handling on the command line

test('cli: passphrase policy and sources', (t) => {
  const { src, out } = liveFixture(t);
  const dir = path.dirname(out);

  const short = H.runTool('make-bundle.js', ['--source', src, '--out', out], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(dir, 'only-15-chars!!', 'short.txt') } });
  assert.equal(short.status, 7, short.all);
  assert.match(short.stderr, /at least 16 characters/);
  assert.ok(!fs.existsSync(out));
  assert.ok(!short.all.includes('only-15-chars!!'));

  const secretArg = 'my-cli-passphrase-value-123';
  for (const args of [['--passphrase', secretArg], [`--passphrase=${secretArg}`], ['-p', secretArg], [secretArg], ['--passphrase-file', secretArg]]) {
    const r = H.runTool('make-bundle.js', ['--source', src, '--out', out, ...args], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(dir) } });
    assert.equal(r.status, 1, `${args[0]}: ${r.all}`);
    assert.ok(!r.all.includes(secretArg), 'the argument value must never be echoed');
    assert.ok(!fs.existsSync(out));
  }
  for (const tool of ['restore-bundle.js', 'verify-bundle.js']) {
    const r = H.runTool(tool, ['--passphrase', secretArg]);
    assert.equal(r.status, 1);
    assert.ok(!r.all.includes(secretArg));
  }

  const none = H.runTool('make-bundle.js', ['--source', src, '--out', out]);
  assert.equal(none.status, 7, none.all);
  assert.match(none.stderr, /no passphrase source/);

  const both = H.runTool('make-bundle.js', ['--source', src, '--out', out], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(dir), BUNDLE_PASSPHRASE_FD: '3' } });
  assert.equal(both.status, 7);

  const viaFd = H.runTool('make-bundle.js', ['--source', src, '--out', out], { env: { BUNDLE_PASSPHRASE_FD: '3' }, fd3: H.passFile(dir, FAKE.passphrase, 'fd.txt') });
  assert.equal(viaFd.status, 0, viaFd.all);
  assert.equal(H.verify(out).status, 0);
  H.assertNoSecrets(assert, viaFd.all, 'fd source');
});

test('cli: --help and usage errors for every tool', () => {
  for (const tool of ['make-bundle.js', 'restore-bundle.js', 'verify-bundle.js']) {
    const help = H.runTool(tool, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: node tools\//);
    assert.match(help.stdout, /BUNDLE_PASSPHRASE_FILE/);
    const bad = H.runTool(tool, ['--no-such-option']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown option --no-such-option/);
    const pos = H.runTool(tool, ['positional']);
    assert.equal(pos.status, 1);
    assert.ok(!pos.all.includes('positional\n'.trim()) || /positional arguments are not accepted/.test(pos.stderr));
  }
  const missing = H.runTool('verify-bundle.js', ['--bundle', path.join(shared.root, 'nope.enc')], { env: { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root) } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /bundle file not found/);
});

// ---------------------------------------------------------------------------
// verify-bundle

test('verify: succeeds, prints names/sizes/counts only, writes nothing', (t) => {
  const cwd = tmpDir(t, 'vcwd-');
  const tmp = tmpDir(t, 'vtmp-');
  const before = { root: H.snapshotTree(path.dirname(shared.out)), cwd: H.snapshotTree(cwd), tmp: H.snapshotTree(tmp) };
  const r = H.runTool('verify-bundle.js', ['--bundle', shared.out], { cwd, env: { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt'), TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /VERIFY_OK files=14/);
  assert.match(r.stdout, /candidates\.db: integrity ok; candidate_rejections=80 candidates=300 reed_daily_usage=10 reed_location_cache=3 territory_searches=25/);
  assert.match(r.stdout, /secrets\/reed-credentials\.json\s+\S+ B\s+0600\s+\(secret\)/);
  assert.match(r.stdout, /pending-searches\/ \(4 files\)/);
  assert.deepEqual({ root: H.snapshotTree(path.dirname(shared.out)), cwd: H.snapshotTree(cwd), tmp: H.snapshotTree(tmp) }, before);
  assert.ok(!/[0-9a-f]{64}/.test(r.stdout), 'no hashes are printed');
  H.assertNoSecrets(assert, r.all, 'verify output');
});

function craftDbBundle(dir, dbBytes, claimedTables) {
  const out = path.join(dir, 'crafted.enc');
  const w = F.writeBundle(out, {
    passphrase: FAKE.passphrase, logN: 15,
    entries: [{ path: 'candidates.db', buffer: dbBytes }, { path: 'config/a.json', buffer: Buffer.from('{}') }],
    manifestBase: F.newManifestBase({
      sourceHost: 't', warnings: [],
      db: { path: 'candidates.db', integrity: 'ok', journalMode: 'delete', tables: claimedTables, watermark: null },
    }),
  });
  w.key.fill(0);
  return out;
}

test('verify and restore: a database that does not match its manifest is rejected before anything is moved', (t) => {
  const dir = tmpDir(t, 'baddb-');
  H.createFakeDb(path.join(dir, 'tiny.db'), { rows: { candidates: 3, candidate_rejections: 0, territory_searches: 0, reed_daily_usage: 0, reed_location_cache: 0 } });
  const tiny = fs.readFileSync(path.join(dir, 'tiny.db'));
  const cases = {
    'not a database': [crypto.randomBytes(8192), { candidates: 1 }, /could not be opened/],
    'row count lie': [tiny, { candidates: 4, candidate_rejections: 0, territory_searches: 0, reed_daily_usage: 0, reed_location_cache: 0 }, /table candidates has 3 rows, the manifest says 4/],
    'missing table': [tiny, { candidates: 3, candidate_rejections: 0, territory_searches: 0, reed_daily_usage: 0, reed_location_cache: 0, extra_table: 2 }, /table extra_table has 0 rows, the manifest says 2/],
  };
  for (const [name, [bytes, tables, re]] of Object.entries(cases)) {
    const out = craftDbBundle(dir, bytes, tables);
    const v = H.verify(out, { BUNDLE_PASSPHRASE_FILE: H.passFile(dir) });
    assert.equal(v.status, 5, `${name}: ${v.all}`);
    assert.match(v.stderr, re, name);
    const home = path.join(dir, `home-${name.replace(/\W/g, '')}`);
    const r = H.restore(out, home, [], { BUNDLE_PASSPHRASE_FILE: H.passFile(dir) });
    assert.equal(r.status, 5, `${name}: ${r.all}`);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')), `${name}: nothing may be moved into place`);
    assert.ok(!fs.existsSync(path.join(home, 'config')), `${name}: nothing may be moved into place`);
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.bundle-')), [], `${name}: staging must be cleaned up`);
  }
  const ok = H.verify(craftDbBundle(dir, tiny, { candidates: 3, candidate_rejections: 0, territory_searches: 0, reed_daily_usage: 0, reed_location_cache: 0 }), { BUNDLE_PASSPHRASE_FILE: H.passFile(dir) });
  assert.equal(ok.status, 0, ok.all);
});

test('verify: --skip-db-check does not need SQLite and says so', (t) => {
  const r = H.runTool('verify-bundle.js', ['--bundle', shared.out, '--skip-db-check'], { env: { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt'), BUNDLE_SQLITE_MODULE: path.join(shared.root, 'no-such-module') } });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stderr, /database check skipped/);
  assert.doesNotMatch(r.stdout, /integrity ok/);
  void t;
});

test('verify: wrong passphrase, tampering and truncation all fail cleanly', (t) => {
  const dir = tmpDir(t, 'vbad-');
  const good = fs.readFileSync(shared.out);
  const wrong = H.verify(shared.out, { BUNDLE_PASSPHRASE_FILE: H.passFile(dir, FAKE.passphrase + '!', 'wrong.txt') });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /VERIFY_FAILED authentication failed/);
  assert.ok(!/bundle authenticated/.test(wrong.stdout));

  const flipped = Buffer.from(good);
  flipped[flipped.length - 40] ^= 0x10;
  fs.writeFileSync(path.join(dir, 'flip.enc'), flipped);
  const r1 = H.verify(path.join(dir, 'flip.enc'), { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt') });
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /VERIFY_FAILED authentication failed/);

  fs.writeFileSync(path.join(dir, 'cut.enc'), good.subarray(0, good.length - 50));
  const r2 = H.verify(path.join(dir, 'cut.enc'), { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt') });
  assert.notEqual(r2.status, 0);
  assert.ok([2, 3].includes(r2.status));

  fs.writeFileSync(path.join(dir, 'junk.enc'), 'not a bundle at all');
  const r3 = H.verify(path.join(dir, 'junk.enc'), { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt') });
  assert.equal(r3.status, 3);
  assert.match(r3.stderr, /not a resourcer bundle/);
  for (const r of [wrong, r1, r2, r3]) H.assertNoSecrets(assert, r.all, 'verify failure output');
});

// ---------------------------------------------------------------------------
// restore-bundle: happy path

test('restore: round trip is byte exact, verified, modes applied, nothing left behind', (t) => {
  const home = freshHome(t);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /RESTORE_OK files=14 created=14 replaced=0 unchanged=0 kept=0/);
  assert.match(r.stdout, /candidates\.db: integrity ok; candidate_rejections=80 candidates=300 reed_daily_usage=10 reed_location_cache=3 territory_searches=25/);
  const { manifest, contents } = H.readManifest(shared.out);
  for (const f of manifest.files) {
    const dest = path.join(home, ...f.path.split('/'));
    assert.ok(fs.readFileSync(dest).equals(contents.get(f.path)), `${f.path} differs`);
    if (posix) assert.equal(fs.statSync(dest).mode & 0o777, parseInt(f.mode, 8), `${f.path} mode`);
  }
  if (posix) assert.equal(fs.statSync(path.join(home, 'secrets')).mode & 0o777, 0o700);
  assert.equal(dbHash(path.join(home, 'candidates.db')), dbHash(path.join(shared.src, 'candidates.db')), 'restored data must equal the source data row for row');
  assert.equal(dbInfo(path.join(home, 'candidates.db')).integrity, 'ok');
  const left = fs.readdirSync(home).filter((n) => n.startsWith('.bundle-'));
  assert.deepEqual(left, [], 'no staging directory or lock may remain');
  assert.ok(!fs.existsSync(path.join(home, 'backups')), 'nothing was replaced, so no copies');
  const record = JSON.parse(readText(path.join(home, 'state', 'bundle-restored.json')));
  assert.equal(record.bundleId, manifest.bundleId);
  assert.ok(!JSON.stringify(record).match(/[0-9a-f]{64}/), 'the record carries no hashes');
  H.assertNoSecrets(assert, r.all, 'restore output');
  assert.ok(!/password|token/i.test(r.stdout.replace(/credentials/g, '')), 'restore output should not mention credential fields');
});

test('restore: idempotent, a second run changes nothing and keeps no copies', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  const snap = H.snapshotTree(home);
  delete snap['state/bundle-restored.json'];
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /RESTORE_OK files=14 created=0 replaced=0 unchanged=14 kept=0/);
  const after = H.snapshotTree(home);
  delete after['state/bundle-restored.json'];
  assert.deepEqual(after, snap);
  assert.ok(!fs.existsSync(path.join(home, 'backups')));
});

test('restore: a pending search consumed since the last restore is not resurrected by a re-run', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  const consumed = path.join(home, 'pending-searches', 'search-d.json');
  fs.rmSync(consumed);
  for (let i = 0; i < 2; i += 1) {
    const r = H.restore(shared.out, home);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /skip\s+pending-searches\/ \(1 files\)/);
    assert.match(r.stdout, /skipped=1/);
    assert.ok(!fs.existsSync(consumed));
  }
  fs.rmSync(path.join(home, 'state', 'bundle-restored.json'));
  const back = H.restore(shared.out, home);
  assert.equal(back.status, 0, back.all);
  assert.ok(fs.existsSync(consumed), 'without the record the file is restored again');

  const newer = path.join(path.dirname(home), 'newer.enc');
  assert.equal(H.make(shared.src, newer).status, 0);
  fs.rmSync(consumed);
  const other = H.restore(newer, home);
  assert.equal(other.status, 0, other.all);
  assert.ok(fs.existsSync(consumed), 'a different bundle brings its own queue');
});

function fakeMigrate(home, { fail = false } = {}) {
  H.write(path.join(home, 'scripts', 'migrate-schema.js'), `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.RESOURCER_HOME;
fs.mkdirSync(path.join(home, 'state'), { recursive: true });
fs.writeFileSync(path.join(home, 'state', 'migrated.json'), JSON.stringify({ home, cwd: process.cwd(), bundleEnv: Object.keys(process.env).filter((k) => k.startsWith('BUNDLE_')) }));
${fail ? "console.error('boom from fake migrate'); process.exit(3);" : `
const Database = require(process.env.FAKE_SQLITE_PATH);
const db = new Database(path.join(home, 'candidates.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS run_results (run_key TEXT PRIMARY KEY, date TEXT)');
db.close();
console.log('fake migrate done');`}
`);
}

test('restore: calls scripts/migrate-schema.js with RESOURCER_HOME and without BUNDLE_* variables; a second restore still sees "unchanged"', (t) => {
  const home = freshHome(t);
  fakeMigrate(home);
  const env = { FAKE_SQLITE_PATH: H.sqliteModuleDir() };
  const r = H.restore(shared.out, home, [], env);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /migrate-schema: ok/);
  const rec = JSON.parse(readText(path.join(home, 'state', 'migrated.json')));
  assert.equal(path.resolve(rec.home), path.resolve(home));
  assert.deepEqual(rec.bundleEnv, [], 'the passphrase variables must not reach the child');
  assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.run_results, 0);
  assert.equal(dbInfo(path.join(home, 'candidates.db')).journalMode, 'wal');

  const again = H.restore(shared.out, home, [], env);
  assert.equal(again.status, 0, again.all);
  assert.match(again.stdout, /unchanged\s+candidates\.db.*\(data-equivalent to the bundle\)/);
  assert.match(again.stdout, /RESTORE_OK files=14 created=0 replaced=0 unchanged=14/);
  assert.ok(!fs.existsSync(path.join(home, 'backups')));
});

const REAL_MIGRATE = path.join(H.REPO, 'resourcer', 'scripts', 'migrate-schema.js');
test('restore: works with the real scripts/migrate-schema.js from this repo', { skip: !fs.existsSync(REAL_MIGRATE) && 'migrate-schema.js is not in this checkout' }, (t) => {
  const home = freshHome(t);
  fs.cpSync(path.join(H.REPO, 'resourcer', 'scripts'), path.join(home, 'scripts'), { recursive: true });
  const env = { NODE_PATH: path.dirname(H.sqliteModuleDir()) };
  const r = H.restore(shared.out, home, [], env);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /migrate-schema: ok/);
  const info = dbInfo(path.join(home, 'candidates.db'));
  assert.equal(info.integrity, 'ok');
  assert.equal(info.tables.candidates, 300);
  assert.equal(info.tables.candidate_rejections, 80);
  assert.equal(info.tables.run_results, 0, 'the migration adds run_results');
  // the fake bundle's extract-js.b64 differs from this repo's real one, so the first run keeps a copy of that file only
  const restoreCopies = () => fs.readdirSync(path.join(home, 'backups')).filter((n) => n.startsWith('bundle-restore-'));
  const copies = restoreCopies();
  assert.equal(copies.length, 1);
  assert.ok(!fs.existsSync(path.join(home, 'backups', copies[0], 'candidates.db')));
  const again = H.restore(shared.out, home, [], env);
  assert.equal(again.status, 0, again.all);
  assert.match(again.stdout, /unchanged\s+candidates\.db.*\(data-equivalent to the bundle\)/);
  assert.match(again.stdout, /unchanged=14/);
  assert.deepEqual(restoreCopies(), copies, 'a migrated database must not be replaced by a re-run');
});

test('restore: a failing migrate-schema exits 6; an absent one only warns', (t) => {
  const home = freshHome(t);
  fakeMigrate(home, { fail: true });
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 6, r.all);
  assert.match(r.stderr, /migrate-schema\.js failed \(exit 3\).*boom from fake migrate/);
  const home2 = freshHome(t);
  const r2 = H.restore(shared.out, home2);
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /migrate-schema\.js not found/);
  const home3 = freshHome(t);
  fakeMigrate(home3, { fail: true });
  assert.equal(H.restore(shared.out, home3, ['--skip-migrate']).status, 0);
});

// ---------------------------------------------------------------------------
// restore-bundle: refusals and safety

function seedNewer(home) {
  const D = H.sqlite();
  const db = new D(path.join(home, 'candidates.db'));
  try {
    db.prepare("INSERT INTO candidates (caterer_id, source, created_at) VALUES (999999, 'caterer', '2026-10-01 09:00:00')").run();
  } finally {
    db.close();
  }
}

test('restore: refuses to overwrite a newer database; --force overwrites and keeps a copy', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  seedNewer(home);
  const snap = H.snapshotTree(home);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /existing database is NEWER than the bundle/);
  assert.match(r.stderr, /candidates has 301 rows, the bundle has 300/);
  assert.match(r.stdout + r.stderr, /use --force/);
  assert.deepEqual(H.snapshotTree(home), snap, 'a refusal must not change anything');

  const forced = H.restore(shared.out, home, ['--force']);
  assert.equal(forced.status, 0, forced.all);
  assert.match(forced.stdout, /replace\s+candidates\.db.*FORCED over newer data/);
  assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.candidates, 300);
  const backups = fs.readdirSync(path.join(home, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^bundle-restore-\d{8}T\d{6}Z$/);
  const kept = path.join(home, 'backups', backups[0], 'candidates.db');
  assert.equal(dbInfo(kept).tables.candidates, 301, 'the copy must hold the data that was replaced');
  if (posix) assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
});

test('restore: newer means newer activity as well as more rows', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  const D = H.sqlite();
  const db = new D(path.join(home, 'candidates.db'));
  db.prepare("UPDATE candidates SET created_at = '2026-11-01 00:00:00' WHERE id = 1").run();
  db.close();
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /latest activity 2026-11-01T00:00:00 is after the bundle's 2026-09-28T23:47:00/);

  const home2 = freshHome(t);
  assert.equal(H.restore(shared.out, home2).status, 0);
  const db2 = new D(path.join(home2, 'candidates.db'));
  db2.exec("CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT); INSERT INTO run_results VALUES ('k', '2026-09-01')");
  db2.close();
  assert.equal(H.restore(shared.out, home2).status, 4, 'run_results rows the bundle lacks count as newer data');
});

test('restore: an older database is replaced without --force and a copy is kept', (t) => {
  const home = freshHome(t);
  fs.mkdirSync(home, { recursive: true });
  H.createFakeDb(path.join(home, 'candidates.db'), { rows: { candidates: 40, candidate_rejections: 10, territory_searches: 5, reed_daily_usage: 2, reed_location_cache: 0 } });
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /replace\s+candidates\.db.*older than the bundle/);
  assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.candidates, 300);
  const [b] = fs.readdirSync(path.join(home, 'backups'));
  assert.equal(dbInfo(path.join(home, 'backups', b, 'candidates.db')).tables.candidates, 40);
});

test('restore: an unreadable existing database is refused unless --force', (t) => {
  const home = freshHome(t);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'candidates.db'), crypto.randomBytes(9000));
  const snap = H.snapshotTree(home);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /cannot be read; use --force/);
  assert.deepEqual(H.snapshotTree(home), snap);
  const f = H.restore(shared.out, home, ['--force']);
  assert.equal(f.status, 0, f.all);
  assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.candidates, 300);
  const [b] = fs.readdirSync(path.join(home, 'backups'));
  assert.equal(fs.statSync(path.join(home, 'backups', b, 'candidates.db')).size, 9000);
});

test('restore: replaced non-database files are copied first; --no-overwrite keeps them', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  const edited = path.join(home, 'config', 'territory-defaults.json');
  fs.writeFileSync(edited, '{"edited":true}');
  fs.writeFileSync(path.join(home, 'secrets', 'reed-credentials.json'), '{"rotated":"FAKE-rotated-value"}', { mode: 0o600 });

  const keep = H.restore(shared.out, home, ['--no-overwrite']);
  assert.equal(keep.status, 0, keep.all);
  assert.match(keep.stdout, /keep\s+config\/territory-defaults\.json/);
  assert.equal(readText(edited), '{"edited":true}');
  assert.ok(!fs.existsSync(path.join(home, 'backups')));

  const d = H.restore(shared.out, home);
  assert.equal(d.status, 0, d.all);
  assert.match(d.stdout, /replaced=1/, 'config is replaced, the rotated secret is not (a re-run must not revert rotated credentials)');
  assert.match(d.stdout, /keep\s+secrets\/reed-credentials\.json.*existing secret differs; kept/);
  assert.equal(readText(path.join(home, 'secrets', 'reed-credentials.json')), '{"rotated":"FAKE-rotated-value"}');
  assert.ok(readText(edited).includes('"cvLimit"'));
  fs.writeFileSync(edited, '{"edited":true}');

  const r = H.restore(shared.out, home, ['--replace-secrets']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /replaced=2/);
  assert.ok(readText(edited).includes('"cvLimit"'));
  assert.ok(!readText(path.join(home, 'secrets', 'reed-credentials.json')).includes('FAKE-rotated-value'));
  const b = fs.readdirSync(path.join(home, 'backups')).sort().pop();
  assert.equal(readText(path.join(home, 'backups', b, 'config', 'territory-defaults.json')), '{"edited":true}');
  assert.equal(readText(path.join(home, 'backups', b, 'secrets', 'reed-credentials.json')), '{"rotated":"FAKE-rotated-value"}');
  if (posix) {
    assert.equal(fs.statSync(path.join(home, 'backups', b, 'secrets', 'reed-credentials.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'backups', b)).mode & 0o777, 0o700);
  }
  assert.ok(!/FAKE-rotated-value/.test(r.all), 'replaced secret content must never be printed');
});

test('restore: refuses while a run looks live in the target (unless --force)', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  H.write(path.join(home, 'runs', 'phase1-2026-09-29-100000.json'), JSON.stringify({ status: 'phase1_running', updatedAt: iso(3 * MIN) }));
  const snap = H.snapshotTree(home);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /a pipeline run looks live in the target workspace/);
  assert.deepEqual(H.snapshotTree(home), snap);
  assert.equal(H.restore(shared.out, home, ['--force']).status, 0);
});

test('restore: --dry-run writes nothing (fresh, populated and refused targets)', (t) => {
  const fresh = freshHome(t);
  const r = H.restore(shared.out, fresh, ['--dry-run']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /create\s+candidates\.db/);
  assert.match(r.stdout, /DRY_RUN_OK nothing was written/);
  assert.ok(!fs.existsSync(fresh), 'the target directory must not even be created');
  assert.deepEqual(fs.readdirSync(path.dirname(fresh)), []);

  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  fs.writeFileSync(path.join(home, 'config', 'territory-defaults.json'), '{"edited":true}');
  fs.rmSync(path.join(home, 'reed-location-cache.json'));
  const snap = H.snapshotTree(home);
  const d = H.restore(shared.out, home, ['--dry-run']);
  assert.equal(d.status, 0, d.all);
  assert.match(d.stdout, /replace\s+config\/territory-defaults\.json/);
  assert.match(d.stdout, /create\s+reed-location-cache\.json/);
  assert.deepEqual(H.snapshotTree(home), snap);

  seedNewer(home);
  const snap2 = H.snapshotTree(home);
  const refused = H.restore(shared.out, home, ['--dry-run']);
  assert.equal(refused.status, 4, 'a dry run reports the same refusal a real run would');
  assert.deepEqual(H.snapshotTree(home), snap2);
});

test('restore: wrong passphrase and damaged bundles write nothing at all', (t) => {
  const dir = tmpDir(t, 'dmg-');
  const root = tmpDir(t, 'dmgsrc-');
  const src = H.buildFakeLegacy(path.join(root, 'legacy'), { bigConfigBytes: 2 * F.DEFAULT_CHUNK });
  const out = path.join(dir, 'big.enc');
  assert.equal(H.make(src, out).status, 0);
  const raw = fs.readFileSync(out);
  assert.ok(raw.length > 3 * F.DEFAULT_CHUNK, 'need several chunks for this test');
  const passEnv = { BUNDLE_PASSPHRASE_FILE: path.join(dir, 'pass.txt') };

  const wrongPass = H.passFile(dir, 'a different passphrase entirely', 'wrong.txt');
  const variants = {
    wrongPassphrase: [out, { BUNDLE_PASSPHRASE_FILE: wrongPass }, [2]],
  };
  const put = (name, buf) => { const f = path.join(dir, `${name}.enc`); fs.writeFileSync(f, buf); return f; };
  const flipLast = Buffer.from(raw); flipLast[raw.length - 20] ^= 0x01;
  variants.flippedInLastChunk = [put('flip', flipLast), passEnv, [2]];
  variants.truncatedLastChunk = [put('cut1', raw.subarray(0, raw.length - 300)), passEnv, [2, 3]];
  variants.truncatedAtChunkBoundary = [put('cut2', raw.subarray(0, F.HEADER_LEN + 5 + F.DEFAULT_CHUNK + 16)), passEnv, [2, 3]];
  const frames = [];
  for (let off = F.HEADER_LEN; off < raw.length;) { const n = 5 + raw.readUInt32BE(off + 1) + 16; frames.push(raw.subarray(off, off + n)); off += n; }
  const swapped = frames.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  variants.reorderedChunks = [put('swap', Buffer.concat([raw.subarray(0, F.HEADER_LEN), ...swapped])), passEnv, [2]];
  variants.droppedChunk = [put('drop', Buffer.concat([raw.subarray(0, F.HEADER_LEN), frames[0], ...frames.slice(2)])), passEnv, [2]];
  variants.trailingGarbage = [put('tail', Buffer.concat([raw, Buffer.from('x')])), passEnv, [3]];

  const messages = new Set();
  for (const [name, [file, env, codes]] of Object.entries(variants)) {
    const fresh = path.join(tmpDir(t, 'dmgh-'), 'home');
    const r = H.restore(file, fresh, [], env);
    assert.ok(codes.includes(r.status), `${name}: exit ${r.status}\n${r.all}`);
    assert.ok(!fs.existsSync(fresh), `${name}: the target directory must not exist`);
    assert.doesNotMatch(r.stdout, /plan for/, `${name}: must fail before planning`);
    H.assertNoSecrets(assert, r.all, name);
    if (r.status === 2) messages.add(r.stderr.split('\n').find((l) => l.startsWith('RESTORE_FAILED')));

    const populated = path.join(tmpDir(t, 'dmgp-'), 'home');
    assert.equal(H.restore(shared.out, populated).status, 0);
    const snap = H.snapshotTree(populated);
    const r2 = H.restore(file, populated, ['--force'], env);
    assert.notEqual(r2.status, 0, name);
    assert.deepEqual(H.snapshotTree(populated), snap, `${name}: an existing workspace must be untouched`);
  }
  assert.deepEqual([...messages], ['RESTORE_FAILED authentication failed'], 'authentication failures must be indistinguishable');
});

test('restore: leftovers of an interrupted run (stale staging, dead lock, partial files) are healed', (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  fs.rmSync(path.join(home, 'candidates.db'));
  fs.rmSync(path.join(home, 'secrets', 'zoho-credentials.json'));
  fs.mkdirSync(path.join(home, '.bundle-staging-777', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.bundle-staging-777', 'secrets', 'x.json'), 'half');
  fs.writeFileSync(path.join(home, '.bundle-restore.lock'), JSON.stringify({ pid: 2 ** 22 + 999, at: iso(3 * 3600000) }));
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /create\s+candidates\.db/);
  assert.match(r.stdout, /create\s+secrets\/zoho-credentials\.json/);
  assert.match(r.stdout, /unchanged=12/);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.bundle-')), []);
  assert.equal(dbInfo(path.join(home, 'candidates.db')).tables.candidates, 300);
});

test('restore: a live lock from another restore is respected', (t) => {
  const home = freshHome(t);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bundle-restore.lock'), JSON.stringify({ pid: process.pid, at: iso(MIN) }));
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /another restore-bundle run is in progress/);
  assert.deepEqual(fs.readdirSync(home), ['.bundle-restore.lock']);
});

test('restore: a destination that is a symlink or a directory is refused', { skip: !posix && 'symlinks need privileges on Windows' }, (t) => {
  const home = freshHome(t);
  assert.equal(H.restore(shared.out, home).status, 0);
  const target = path.join(path.dirname(home), 'elsewhere.json');
  fs.writeFileSync(target, '{}');
  const link = path.join(home, 'config', 'postcode-cities.json');
  fs.rmSync(link);
  fs.symlinkSync(target, link);
  let r = H.restore(shared.out, home);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /the destination exists and is not a regular file/);
  assert.equal(readText(target), '{}');
  fs.rmSync(link);
  fs.mkdirSync(link);
  r = H.restore(shared.out, home);
  assert.equal(r.status, 4);
});

test('restore: modes are enforced on POSIX (secrets 0600 inside a 0700 directory), even over loose existing modes', { skip: !posix && 'POSIX permissions only' }, (t) => {
  const home = freshHome(t);
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(home, 'secrets'), 0o755);
  const loose = path.join(home, 'secrets', 'caterer-credentials.json');
  const { contents } = H.readManifest(shared.out);
  fs.writeFileSync(loose, contents.get('secrets/caterer-credentials.json'), { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  const r = H.restore(shared.out, home);
  assert.equal(r.status, 0, r.all);
  assert.equal(fs.statSync(path.join(home, 'secrets')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(loose).mode & 0o777, 0o600);
  for (const n of ['zoho', 'reed']) assert.equal(fs.statSync(path.join(home, 'secrets', `${n}-credentials.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, 'candidates.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, 'config', 'postcode-cities.json')).mode & 0o777, 0o644);
});

// ---------------------------------------------------------------------------
// Secrets and PII never reach stdout/stderr

test('no secret value ever appears in the output of any tool, success or failure', (t) => {
  const dir = tmpDir(t, 'leak-');
  const outputs = [shared.made.all];
  const passEnv = { BUNDLE_PASSPHRASE_FILE: path.join(path.dirname(shared.out), 'pass.txt') };
  outputs.push(H.verify(shared.out, passEnv).all);
  outputs.push(H.restore(shared.out, path.join(dir, 'h1'), ['--dry-run'], passEnv).all);
  outputs.push(H.restore(shared.out, path.join(dir, 'h2'), [], passEnv).all);
  outputs.push(H.restore(shared.out, path.join(dir, 'h2'), [], passEnv).all);
  outputs.push(H.restore(shared.out, path.join(dir, 'h2'), ['--force', '--no-overwrite'], passEnv).all);
  outputs.push(H.restore(shared.out, path.join(dir, 'h3'), [], { BUNDLE_PASSPHRASE_FILE: H.passFile(dir, 'wrong wrong wrong wrong', 'w.txt') }).all);
  outputs.push(H.runTool('make-bundle.js', ['--source', shared.src, '--out', path.join(dir, 'x.enc'), '--dry-run']).all);
  outputs.push(H.runTool('make-bundle.js', ['--source', path.join(dir, 'missing'), '--out', path.join(dir, 'x.enc')], { env: passEnv }).all);
  outputs.push(H.runTool('make-bundle.js', ['--bogus'], { env: passEnv }).all);
  for (const [i, o] of outputs.entries()) H.assertNoSecrets(assert, o, `output #${i}`);
  assert.ok(outputs.every((o) => !/FAKE-/.test(o)), 'not even the fake marker prefix may appear');
});
