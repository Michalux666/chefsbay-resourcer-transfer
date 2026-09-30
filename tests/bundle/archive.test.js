'use strict';
// tools/archive-legacy.js: encrypted safety archive of a fake legacy home (fake tree, fake secrets, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_helpers');
const A = require('../../tools/archive-legacy.js');

const F = H.F;
const isPosix = process.platform !== 'win32';
const DAY = 86400000;
const BAD = ['ng', 'rok'].join('');

function age(file, days) {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, t, t);
}

function put(root, rel, content) {
  const f = path.join(root, ...rel.split('/'));
  H.write(f, content);
  return f;
}

// Layout mirrors the real per-user home (names only; every value is fake).
function buildHome(root) {
  put(root, 'app.json', JSON.stringify({ gateway: { token: H.FAKE.zohoAccess } }));
  put(root, 'CLAUDE.md', '# notes\n');
  put(root, 'credentials/auth.json', JSON.stringify({ token: H.FAKE.zohoRefresh }));
  put(root, 'cron/jobs.json', '{"jobs":[]}');
  age(put(root, 'cron/runs/old-run.jsonl', 'old run'), 30);
  put(root, 'cron/runs/new-run.jsonl', 'new run');
  put(root, 'agents/main/agent/auth-profiles.json', JSON.stringify({ key: H.FAKE.catererPass }));
  age(put(root, 'agents/main/sessions/small.jsonl', 'small session'), 40);
  age(put(root, 'agents/main/sessions/big.jsonl', Buffer.alloc(2 * 1024 * 1024, 65)), 40);
  age(put(root, 'agents/main/sessions/gone.jsonl.deleted.2026-09-02T10-18-38.051Z', 'tombstone'), 40);
  age(put(root, 'agents/main/qmd/xdg-cache/x.bin', 'cache'), 40);
  put(root, 'skills/agent-browser/SKILL.md', 'skill text');
  put(root, 'workspace/AGENTS.md', 'main agent');
  put(root, 'workspace/notes.txt', 'small note');
  put(root, 'workspace/huge.dat', Buffer.alloc(1536 * 1024, 66));
  put(root, 'hermes-port/repo/tools/x.js', 'must not travel');
  put(root, 'npm/lib/x.js', 'must not travel');
  put(root, 'browser/x.js', 'must not travel');
  put(root, 'media/x.dat', 'must not travel');
  const wr = path.join(root, 'workspace-resourcer');
  put(wr, 'AGENTS.md', 'resourcer agent');
  put(wr, 'MEMORY.md', 'memory');
  put(wr, 'scripts/a.js', 'console.log(1)');
  put(wr, 'scripts/cdp-list-cookies.js', 'console.log("code with cookies in its name")');
  put(wr, 'skills/x/SKILL.md', 'skill');
  put(wr, 'config/c.json', '{"a":1}');
  put(wr, 'docs/d.md', 'doc');
  put(wr, 'caterer-credentials.json', JSON.stringify({ username: H.FAKE.catererUser, password: H.FAKE.catererPass }));
  put(wr, 'caterer-session.json', JSON.stringify({ cookie: H.FAKE.sessionCookie }));
  put(wr, 'caterer-cookies.txt', H.FAKE.sessionCookie);
  put(wr, 'downloads/cv-1.pdf', 'FAKE CV');
  put(wr, 'node_modules/m/index.js', 'module');
  put(wr, 'chrome-reed-cdp/Local State', '{}');
  put(wr, 'chrome-reed-cdp/Default/Preferences', '{}');
  put(wr, 'some-profile/Local State', '{}');
  put(wr, 'some-profile/note.txt', 'inside a browser profile');
  put(wr, 'screenshots/s.png', 'png');
  put(wr, 'search.png', 'png');
  put(wr, 'tools/helper.exe', 'binary');
  put(wr, `${BAD}/notes.txt`, 'excluded by name');
  put(wr, '.git/config', `[remote "origin"]\n\turl = https://${H.FAKE.zohoClientSecret}@example.invalid/repo.git\n`);
  age(put(wr, 'logs/old.log', 'old log'), 30);
  put(wr, 'logs/new.log', 'new log');
  put(wr, 'candidates.db.bak.pre-test', 'raw copy of a database');
  H.createFakeDb(path.join(wr, 'candidates.db'), { rows: { candidates: 40, candidate_rejections: 10, territory_searches: 5, reed_daily_usage: 2, reed_location_cache: 1 } });
  age(path.join(root, 'credentials', 'auth.json'), 5);
  age(path.join(wr, 'scripts', 'a.js'), 5);
  age(path.join(wr, 'candidates.db'), 5);
  return root;
}

function tool(args, env = {}, opts = {}) {
  return H.runTool('archive-legacy.js', args, { env, ...opts });
}

const shared = {};
test.before(() => {
  shared.root = H.mkTmp('arc-');
  shared.home = buildHome(path.join(shared.root, 'home'));
  shared.pass = H.passFile(shared.root);
  shared.out = path.join(shared.root, 'out', 'legacy.enc');
  shared.before = H.snapshotTree(shared.home);
  const r = tool(['--source', shared.home, '--output', shared.out, '--max-file-mb', '1'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  shared.create = r;
});
test.after(() => H.rmTmp(shared.root));

test('create: succeeds, prints counts and sizes only, the source tree is untouched, no temp files are left', () => {
  const r = shared.create;
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /ARCHIVE_OK out=.*files=\d+/);
  assert.match(r.stdout, /files=\d+ total=/);
  assert.match(r.stdout, /candidates\.db: integrity ok/);
  assert.match(r.stdout, /excluded: .*screenshot=/);
  H.assertNoSecrets(assert, r.all, 'archive output');
  for (const marker of ['must not travel', 'FAKE CV', 'inside a browser profile']) assert.ok(!r.all.includes(marker));
  assert.deepEqual(H.snapshotTree(shared.home), shared.before, 'the source is read-only');
  assert.deepEqual(fs.readdirSync(path.dirname(shared.out)).filter((n) => n.includes('.check-') || n.includes('.tmp-')), []);
});

test('the archive is opaque: no fake secret, no file name and no file text appear in the .enc file', () => {
  const raw = fs.readFileSync(shared.out);
  for (const v of [...H.secretValues(), 'AGENTS.md', 'MEMORY.md', 'auth-profiles', 'small session', 'console.log(1)', 'workspace-resourcer']) {
    assert.equal(raw.indexOf(Buffer.from(v)), -1, `plaintext found: ${v.slice(0, 16)}`);
  }
  if (isPosix) assert.equal(fs.statSync(shared.out).mode & 0o077, 0, 'owner-only');
});

test('list: authenticates and prints group counts, sizes and the database table counts, never names of files', () => {
  const r = tool(['--list', '--archive', shared.out], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /LIST_OK files=\d+/);
  assert.match(r.stdout, /workspace-resourcer +\d+ files/);
  assert.match(r.stdout, /candidates\.db: integrity ok; .*candidates=40/);
  H.assertNoSecrets(assert, r.all, 'list output');
  assert.ok(!r.stdout.includes('AGENTS.md'));
});

test('extract: round trip is byte exact for included files; excluded files are absent; database matches', () => {
  const dir = path.join(shared.root, 'ex1');
  const r = tool(['--extract', dir, '--archive', shared.out], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /EXTRACT_OK files=\d+ bytes=\d+/);
  assert.match(r.stdout, /candidates\.db: integrity ok; .*candidates=40/);
  H.assertNoSecrets(assert, r.all, 'extract output');
  const got = H.snapshotTree(dir);
  const present = (rel) => Object.prototype.hasOwnProperty.call(got, rel);
  const must = [
    'app.json', 'CLAUDE.md', 'credentials/auth.json', 'cron/jobs.json', 'cron/runs/new-run.jsonl', 'agents/main/agent/auth-profiles.json',
    'agents/main/sessions/small.jsonl', 'skills/agent-browser/SKILL.md', 'workspace/AGENTS.md', 'workspace/notes.txt',
    'workspace-resourcer/AGENTS.md', 'workspace-resourcer/MEMORY.md', 'workspace-resourcer/scripts/a.js',
    'workspace-resourcer/scripts/cdp-list-cookies.js', 'workspace-resourcer/skills/x/SKILL.md', 'workspace-resourcer/config/c.json',
    'workspace-resourcer/docs/d.md', 'workspace-resourcer/caterer-credentials.json', 'workspace-resourcer/logs/new.log',
    'workspace-resourcer/candidates.db',
  ];
  for (const rel of must) assert.ok(present(rel), `missing from the archive: ${rel}`);
  const mustNot = [
    'cron/runs/old-run.jsonl', 'agents/main/sessions/big.jsonl', 'agents/main/sessions/gone.jsonl.deleted.2026-09-02T10-18-38.051Z',
    'agents/main/qmd/xdg-cache/x.bin', 'workspace/huge.dat', 'hermes-port/repo/tools/x.js', 'npm/lib/x.js', 'browser/x.js', 'media/x.dat',
    'workspace-resourcer/caterer-session.json', 'workspace-resourcer/caterer-cookies.txt', 'workspace-resourcer/downloads/cv-1.pdf',
    'workspace-resourcer/node_modules/m/index.js', 'workspace-resourcer/chrome-reed-cdp/Local State',
    'workspace-resourcer/some-profile/note.txt', 'workspace-resourcer/screenshots/s.png', 'workspace-resourcer/search.png',
    'workspace-resourcer/tools/helper.exe', `workspace-resourcer/${BAD}/notes.txt`, 'workspace-resourcer/.git/config',
    'workspace-resourcer/logs/old.log', 'workspace-resourcer/candidates.db.bak.pre-test',
  ];
  for (const rel of mustNot) assert.ok(!present(rel), `must not be archived: ${rel}`);
  for (const rel of must.filter((x) => x !== 'workspace-resourcer/candidates.db')) {
    assert.deepEqual(fs.readFileSync(path.join(dir, ...rel.split('/'))), fs.readFileSync(path.join(shared.home, ...rel.split('/'))), rel);
  }
  const Database = H.sqlite();
  const db = new Database(path.join(dir, 'workspace-resourcer', 'candidates.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS c FROM candidates').get().c, 40);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
  if (isPosix) {
    assert.equal(fs.statSync(path.join(dir, 'credentials', 'auth.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'credentials')).mode & 0o777, 0o700);
  }
  const mt = fs.statSync(path.join(dir, 'workspace-resourcer', 'scripts', 'a.js')).mtimeMs;
  assert.ok(Math.abs(mt - fs.statSync(path.join(shared.home, 'workspace-resourcer', 'scripts', 'a.js')).mtimeMs) < 2000, 'mtime restored');
});

test('extract: a non-empty target, a wrong passphrase, and a damaged archive write nothing', () => {
  const busy = path.join(shared.root, 'busy');
  H.write(path.join(busy, 'keep.txt'), 'x');
  const r1 = tool(['--extract', busy, '--archive', shared.out], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r1.status, 4, r1.all);
  assert.deepEqual(fs.readdirSync(busy), ['keep.txt']);

  const wrong = H.passFile(shared.root, 'a completely different passphrase', 'wrong.txt');
  const t2 = path.join(shared.root, 'ex-wrong');
  const r2 = tool(['--extract', t2, '--archive', shared.out], { BUNDLE_PASSPHRASE_FILE: wrong });
  assert.equal(r2.status, 2, r2.all);
  assert.ok(!fs.existsSync(t2));
  assert.deepEqual(fs.readdirSync(shared.root).filter((n) => n.includes('extracting')), []);

  const buf = fs.readFileSync(shared.out);
  const flipped = Buffer.from(buf);
  flipped[Math.floor(buf.length / 2)] ^= 0x01;
  const fl = path.join(shared.root, 'flip.enc');
  fs.writeFileSync(fl, flipped);
  const t3 = path.join(shared.root, 'ex-flip');
  const r3 = tool(['--extract', t3, '--archive', fl], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r3.status, 2, r3.all);
  assert.ok(!fs.existsSync(t3));
  assert.deepEqual(fs.readdirSync(shared.root).filter((n) => n.includes('extracting')), []);

  const cut = path.join(shared.root, 'cut.enc');
  fs.writeFileSync(cut, buf.subarray(0, buf.length - 100));
  const t4 = path.join(shared.root, 'ex-cut');
  const r4 = tool(['--extract', t4, '--archive', cut], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.ok([2, 3].includes(r4.status), r4.all);
  assert.ok(!fs.existsSync(t4));
});

test('a data bundle is not an archive and an archive is not a data bundle', () => {
  const src = H.buildFakeLegacy(path.join(shared.root, 'legacy'));
  const bundle = path.join(shared.root, 'b.enc');
  const m = H.make(src, bundle);
  assert.equal(m.status, 0, m.all);
  const r = tool(['--list', '--archive', bundle], { BUNDLE_PASSPHRASE_FILE: path.join(shared.root, 'pass.txt') });
  assert.equal(r.status, 3, r.all);
  assert.match(r.stderr, /not a legacy archive/);
  const v = H.verify(shared.out, { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(v.status, 3, v.all);
});

test('dry run: counts and sizes, no passphrase needed, nothing written anywhere', () => {
  const out = path.join(shared.root, 'dry', 'never.enc');
  const before = H.snapshotTree(shared.root);
  const r = tool(['--source', shared.home, '--output', out, '--dry-run', '--max-file-mb', '1'], {});
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /files=\d+ total=/);
  assert.match(r.stdout, /ARCHIVE_DRY_RUN_OK nothing was written/);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(path.dirname(out)));
  assert.deepEqual(H.snapshotTree(shared.root), before);
  H.assertNoSecrets(assert, r.all, 'dry-run output');
});

test('refusals: output inside the source, existing output without --force, bad options, passphrase on the command line', () => {
  const inside = tool(['--source', shared.home, '--output', path.join(shared.home, 'a.enc')], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(inside.status, 4, inside.all);
  assert.ok(!fs.existsSync(path.join(shared.home, 'a.enc')));

  const again = tool(['--source', shared.home, '--output', shared.out, '--max-file-mb', '1'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(again.status, 4, again.all);
  assert.match(again.stderr, /already exists/);

  const forced = path.join(shared.root, 'forced.enc');
  fs.writeFileSync(forced, 'old');
  const f = tool(['--source', shared.home, '--output', forced, '--force', '--max-file-mb', '1'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(f.status, 0, f.all);
  assert.ok(fs.statSync(forced).size > 1000);

  const pw = tool(['--passphrase', 'topsecretvalue1234'], {});
  assert.equal(pw.status, 1);
  assert.ok(!pw.all.includes('topsecretvalue1234'));
  for (const bad of [['--bogus'], ['positional'], ['--extract'], ['--list'], ['--dry-run', '--list', '--archive', 'x'], ['--max-file-mb', 'abc']]) {
    assert.equal(tool(bad, {}).status, 1, bad.join(' '));
  }
  assert.equal(tool(['--source', path.join(shared.root, 'nope'), '--dry-run'], {}).status, 5);
});

test('limits: --max-total-mb refuses, --max-file-mb keeps large files out, --include-git brings .git in', () => {
  const small = tool(['--source', shared.home, '--output', path.join(shared.root, 'small.enc'), '--max-total-mb', '0'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(small.status, 4, small.all);
  assert.match(small.stderr, /max-total-mb/);

  const big = path.join(shared.root, 'big-limits.enc');
  const r = tool(['--source', shared.home, '--output', big, '--max-file-mb', '5', '--max-session-mb', '5', '--include-git'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r.status, 0, r.all);
  const dir = path.join(shared.root, 'ex-limits');
  const x = tool(['--extract', dir, '--archive', big], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(x.status, 0, x.all);
  for (const rel of ['workspace/huge.dat', 'agents/main/sessions/big.jsonl', 'workspace-resourcer/.git/config']) {
    assert.ok(fs.existsSync(path.join(dir, ...rel.split('/'))), rel);
  }
});

test('passphrase policy: 16+ characters, not repetitive, and never from the command line or a missing terminal', () => {
  const out = path.join(shared.root, 'pp.enc');
  const args = ['--source', shared.home, '--output', out, '--max-file-mb', '1'];
  const short = tool(args, { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root, 'only-15-chars!!', 'short.txt') });
  assert.equal(short.status, 7, short.all);
  const rep = tool(args, { BUNDLE_PASSPHRASE_FILE: H.passFile(shared.root, 'aaaaaaaaaaaaaaaaaaaa', 'rep.txt') });
  assert.equal(rep.status, 7, rep.all);
  const none = tool(args, {});
  assert.equal(none.status, 7, none.all);
  assert.match(none.stderr, /no passphrase source/);
  assert.ok(!fs.existsSync(out));
});

test('the temporary database snapshot is removed', () => {
  const tmp = path.join(shared.root, 'tmpdir');
  fs.mkdirSync(tmp);
  const r = tool(['--source', shared.home, '--output', path.join(shared.root, 'tmpcheck.enc'), '--tmpdir', tmp, '--max-file-mb', '1'], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('a source without candidates.db still archives (with a warning) and a corrupt one is refused', () => {
  const home = path.join(shared.root, 'nodb');
  put(home, 'workspace-resourcer/AGENTS.md', 'x');
  put(home, 'app.json', '{}');
  const out = path.join(shared.root, 'nodb.enc');
  const r = tool(['--source', home, '--output', out], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r.status, 0, r.all);
  const bad = path.join(shared.root, 'baddb');
  put(bad, 'workspace-resourcer/candidates.db', 'this is not a sqlite database at all, just text that is long enough');
  const r2 = tool(['--source', bad, '--output', path.join(shared.root, 'baddb.enc')], { BUNDLE_PASSPHRASE_FILE: shared.pass });
  assert.equal(r2.status, 5, r2.all);
  assert.ok(!fs.existsSync(path.join(shared.root, 'baddb.enc')));
});

test('path safety: traversal, absolute, drive, device and control names are rejected by the validator', () => {
  const ok = ['a', 'a/b.txt', 'workspace-resourcer/scripts/x.js', 'dir with space/file (1).txt', '.claude/settings.json'];
  const bad = ['', '/abs', '../x', 'a/../x', 'a/./b', 'a//b', `a${String.fromCharCode(92)}b`, 'C:evil', 'a/C:x', 'nul', 'a/CON.txt', 'a/aux', 'trailing.', 'a/x ', 'star*', 'q?', 'a|b', 'a<b', `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(10)}b`, 'x'.repeat(401), Array(41).fill('d').join('/'), 5, null];
  for (const p of ok) assert.ok(A.isSafeArchivePath(p), p);
  for (const p of bad) assert.ok(!A.isSafeArchivePath(p), JSON.stringify(p));
});

test('a hand-made archive with a hostile manifest is rejected before anything is written', () => {
  const hostile = [
    ['../escape.txt', 'traversal'],
    ['ok/../../escape.txt', 'nested traversal'],
    ['/tmp/escape.txt', 'absolute'],
    ['C:escape.txt', 'drive'],
    [`a${String.fromCharCode(92)}b.txt`, 'backslash'],
  ];
  for (const [p, why] of hostile) {
    const out = path.join(shared.root, `hostile-${why.replace(/ /g, '-')}.enc`);
    F.writeBundle(out, {
      passphrase: fs.readFileSync(shared.pass, 'utf8').trim(),
      manifestBase: F.newManifestBase({ format: A.FORMAT, sourceHost: 'test' }),
      entries: [{ path: p, buffer: Buffer.from('payload') }],
      classify: () => ({ kind: 'file', mode: 0o600, secret: false }),
      validate: (m) => m,
      logN: 15,
    });
    const target = path.join(shared.root, `hx-${why.replace(/ /g, '-')}`);
    const r = tool(['--extract', target, '--archive', out], { BUNDLE_PASSPHRASE_FILE: shared.pass });
    assert.equal(r.status, 3, `${why}: ${r.all}`);
    assert.match(r.stderr, /disallowed path/);
    assert.ok(!fs.existsSync(target));
    assert.ok(!fs.existsSync(path.join(shared.root, 'escape.txt')));
    assert.ok(!fs.existsSync(path.join(path.dirname(shared.root), 'escape.txt')));
  }
});

test('the walker skips links and never follows them', (t) => {
  const home = path.join(shared.root, 'links');
  put(home, 'real/a.txt', 'a');
  let linked = false;
  try { fs.symlinkSync(path.join(home, 'real'), path.join(home, 'link-dir'), 'dir'); linked = true; } catch { /* needs privileges on Windows */ }
  const w = A.walkSource(home, { maxFileMb: 25, maxSessionMb: 1, logDays: 14, includeGit: false }, Date.now(), new Set());
  const names = w.included.map((e) => e.path);
  assert.ok(names.includes('real/a.txt'));
  assert.ok(!names.some((n) => n.startsWith('link-dir')));
  if (linked) assert.equal(w.excluded.get('link'), 1);
  else t.diagnostic('symlinks need privileges on this host; link part skipped');
});
