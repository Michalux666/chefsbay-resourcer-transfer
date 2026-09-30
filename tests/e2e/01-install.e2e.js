'use strict';
// SCENARIO 1 - install path: npm install, bundle round trip, migrate, backfill, preflight-db, and the eight
// cron wrappers run with a scrubbed environment (they must find node, the workspace and the profile .env on their own).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { World, REPO } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const legacy = require('./lib/legacy');

const w = new World('main');

test.before(async () => { await w.create({ install: false }); });
test.after(async () => { await w.close(); });

const noSecrets = (text, what) => {
  for (const [name, v] of Object.entries(C.SECRET_VALUES)) assert.ok(!text.includes(v), `${what} printed the planted secret ${name}`);
  assert.ok(!text.includes(D.SECRETS.catererUser) && !text.includes(D.SECRETS.reedEmail), `${what} printed a planted user name`);
};

test('1.1 npm install works and the eight wrappers are installed byte for byte and executable', () => {
  w.installCode();
  assert.equal(w.npmInstall.status, 0, w.npmInstall.tail);
  const Sqlite = require(path.join(w.home, 'node_modules', 'better-sqlite3'));
  const mem = new Sqlite(':memory:');
  assert.equal(mem.prepare('select 1 as x').get().x, 1);
  mem.close();
  for (const m of ['mammoth', 'pdf-parse', 'ws']) assert.ok(fs.existsSync(path.join(w.home, 'node_modules', m)), `${m} installed`);

  const spec = JSON.parse(fs.readFileSync(path.join(REPO, 'hermes', 'cron', 'jobs.json'), 'utf8'));
  assert.equal(spec.jobs.length, 8);
  for (const job of spec.jobs) {
    const installed = path.join(w.scriptsDir, job.script);
    assert.ok(fs.existsSync(installed), `${job.script} installed`);
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(REPO, 'hermes', 'scripts', job.script), 'utf8'));
    assert.ok((fs.statSync(installed).mode & 0o111) !== 0, `${job.script} is executable`);
    assert.equal(spawnSync('sh', ['-n', installed]).status, 0, `${job.script} parses under sh`);
    assert.ok(fs.lstatSync(installed).isFile(), 'a real file, not a symlink (Hermes rejects symlinks that leave the scripts directory)');
  }
  assert.ok(fs.existsSync(path.join(w.binDir, 'agent-browser')));
  assert.equal(C.modeOf(path.join(w.profile, '.env')), 0o600);
});

test('1.2 bundle: build on the "laptop", verify, restore on the "instance" (no secret is ever printed)', () => {
  legacy.build(w.legacyDir, {});
  const dry = w.tool('make-bundle.js', ['--source', w.legacyDir, '--out', w.bundle, '--dry-run']);
  assert.match(dry.stdout, /DRY_RUN_OK/);
  assert.ok(!fs.existsSync(w.bundle), 'a dry run writes nothing');
  const made = w.makeBundle();
  assert.match(made.stdout, /BUNDLE_OK/);
  noSecrets(made.stdout + made.stderr, 'make-bundle');
  assert.ok(fs.statSync(w.bundle).size > 1000);
  assert.ok(!fs.readFileSync(w.bundle).includes(Buffer.from(D.SECRETS.catererPass)), 'the bundle is encrypted');

  const ver = w.tool('verify-bundle.js', ['--bundle', w.bundle]);
  assert.match(ver.stdout, /VERIFY_OK/);
  noSecrets(ver.stdout + ver.stderr, 'verify-bundle');

  const bad = w.tool('restore-bundle.js', ['--bundle', w.bundle, '--home', w.home], { env: { BUNDLE_PASSPHRASE_FILE: path.join(w.privateDir, 'no-such-file') }, allowFail: true });
  assert.notEqual(bad.code, 0, 'no passphrase, no restore');

  const restored = w.restoreBundle(['--skip-migrate']);
  assert.match(restored.stdout, /RESTORE_OK/);
  noSecrets(restored.stdout + restored.stderr, 'restore-bundle');

  assert.equal(C.modeOf(path.join(w.home, 'secrets')), 0o700);
  for (const f of ['caterer-credentials.json', 'zoho-credentials.json', 'reed-credentials.json']) assert.equal(C.modeOf(path.join(w.home, 'secrets', f)), 0o600, f);
  for (const f of ['candidates.db', 'scripts/extract-js.b64', 'config/postcode-cities.json', 'config/territory-defaults.json', 'postcode-lookup-cache.json', 'reed-location-cache.json']) {
    assert.ok(fs.existsSync(path.join(w.home, f)), `${f} restored`);
  }
  for (const never of ['caterer-session.json', 'reed-session.json', 'config/dashboard-auth.json', 'review-tmp-1.json']) assert.ok(!fs.existsSync(path.join(w.home, never)), `${never} must not travel`);
  assert.ok(!fs.existsSync(path.join(w.home, 'downloads')), 'no CVs travel');
  const cred = JSON.parse(fs.readFileSync(path.join(w.home, 'secrets', 'reed-credentials.json'), 'utf8'));
  assert.equal(cred.email, D.SECRETS.reedEmail);

  // idempotent: a second restore changes nothing
  const again = w.restoreBundle(['--skip-migrate']);
  assert.match(again.stdout, /RESTORE_OK/);
  assert.match(again.stdout, /unchanged/i);
});

test('1.3 migrate-schema: adds run_results and the timestamp columns, sets the journal mode, is idempotent', () => {
  const Db = require(path.join(w.home, 'node_modules', 'better-sqlite3'));
  const raw = new Db(w.p('candidates.db'), { readonly: true });
  assert.equal(raw.pragma('journal_mode', { simple: true }), 'delete', 'the bundle restores a plain single-file database');
  assert.ok(!raw.prepare("select 1 from sqlite_master where name='run_results'").get());
  raw.close();

  const first = w.node('migrate-schema.js', ['--json']);
  const j1 = JSON.parse(first.stdout.trim().split('\n').pop());
  assert.ok(j1.ok !== false, first.stdout);
  const db = w.db();
  assert.ok(db.prepare("select 1 from sqlite_master where name='run_results'").get(), 'run_results created');
  const cols = db.prepare('pragma table_info(candidates)').all().map((c) => c.name);
  assert.ok(cols.includes('created_at') && cols.includes('zoho_pushed_at'));
  const jm = db.pragma('journal_mode', { simple: true });
  assert.ok(['wal', 'delete'].includes(jm), `journal mode ${jm}`);
  if (jm === 'delete') assert.match(first.stdout + first.stderr, /journal|wal/i, 'a volume that cannot do WAL says so');
  db.close();
  assert.ok(w.list('backups', /^candidates\.db\.pre-migrate-/).length >= 1, 'one online copy before the structural change');

  const second = w.node('migrate-schema.js', ['--json']);
  assert.equal(second.code, 0);
  const db2 = w.db();
  assert.equal(db2.prepare('select count(*) n from candidates').get().n, 1501, 'no rows lost');
  db2.close();
});

test('1.4 preflight-db and backfill-run-results --strict pass on the restored database', () => {
  const pf = w.node('preflight-db.js', ['--json']);
  const r = JSON.parse(pf.stdout);
  assert.equal(r.ok, true);
  assert.equal(r.candidates, 1501);
  const bf = w.node('backfill-run-results.js', ['--strict']);
  assert.match(bf.stdout + bf.stderr, /PARITY OK|nothing to|0 file|no phase2/i, bf.stdout + bf.stderr);
  // preflight-db refuses what is not fit: a missing database, an empty file
  const missing = w.node('preflight-db.js', ['--db', w.p('nope.db')], { allowFail: true });
  assert.equal(missing.code, 1);
  fs.writeFileSync(w.p('empty.db'), '');
  const empty = w.node('preflight-db.js', ['--db', w.p('empty.db')], { allowFail: true });
  assert.equal(empty.code, 1);
  fs.unlinkSync(w.p('empty.db'));
});

test('1.5 the eight cron wrappers run silently under a scrubbed environment and read the profile .env themselves', async () => {
  const env = w.cronEnv();
  for (const k of ['HERMES_HOME', 'RESOURCER_HOME', 'AI_GATEWAY_API_KEY', 'BACKUP_PASSPHRASE', 'RESOURCER_SOURCES']) assert.ok(!(k in env), `${k} is not passed to the job`);

  // alerts: the once-a-day alive line is the only thing a healthy first run may say
  const a1 = await w.cron('resourcer-alerts');
  assert.equal(a1.code, 0);
  assert.match(a1.stdout.trim(), /^\[INFO \d\d:\d\d\] Resourcer alive /);
  assert.equal(a1.stdout.trim().split('\n').length, 1);
  const a2 = await w.cron('resourcer-alerts');
  assert.deepEqual([a2.code, a2.stdout, a2.stderr], [0, '', '']);

  for (const job of ['resourcer-queue-due', 'resourcer-tick', 'resourcer-maintenance', 'resourcer-retention']) {
    const r = await w.cron(job);
    assert.deepEqual([job, r.code, r.stdout, r.stderr], [job, 0, '', ''], `${job}: ${r.stdout}${r.stderr}`);
  }
  // backup needs BACKUP_PASSPHRASE, which only the .env file carries
  const b = await w.cron('resourcer-backup');
  assert.deepEqual([b.code, b.stdout, b.stderr], [0, '', ''], b.stdout);
  const enc = w.list('backups', /^candidates-\d{8}-\d{6}\.db\.gz\.enc$/);
  assert.equal(enc.length, 1);
  assert.ok(fs.statSync(w.p('backups', enc[0])).size > 1000);
  assert.ok(!fs.readFileSync(w.p('backups', enc[0])).includes(Buffer.from('SQLite format 3')), 'the backup is encrypted');

  // the two Caterer jobs sign in through the fake site with the restored credentials
  const pre = await w.cron('resourcer-preflight');
  assert.deepEqual([pre.code, pre.stdout, pre.stderr], [0, '', ''], pre.stdout);
  assert.match(w.text(`logs/preflight-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`), /CATERER_OK/);
  const ka = await w.cron('resourcer-keepalive');
  assert.deepEqual([ka.code, ka.stdout, ka.stderr], [0, '', ''], ka.stdout);
  assert.ok(fs.existsSync(w.p('state', 'caterer-session.json')), 'a saved session after the pre-flight signed in');

  for (const f of ['alerts', 'queue-due', 'tick', 'backup', 'maintenance', 'retention', 'preflight', 'keepalive']) {
    assert.ok(w.list('logs', new RegExp(`^${f}-\\d{8}\\.log$`)).length >= 1, `logs/${f}-<date>.log written`);
  }
  assert.deepEqual(w.netBlocked(), [], 'nothing tried to reach the internet');
  const hits = C.secretHits(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
});

test('1.6 a wrapper fails loudly and in one line when its preconditions are missing', async () => {
  const broken = path.join(w.profile, 'workspace', 'resourcer', 'scripts', 'pipeline-watchdog.js');
  const saved = fs.readFileSync(broken);
  fs.unlinkSync(broken);
  try {
    const r = await w.cron('resourcer-tick');
    assert.equal(r.code, 90);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stdout, /not found/);
  } finally {
    fs.writeFileSync(broken, saved);
  }
  // a PATH that has the coreutils the wrapper uses but not node (node may live outside the cron PATH on the instance)
  const bare = path.join(w.privateDir, 'bin-without-node');
  fs.mkdirSync(bare, { recursive: true });
  for (const t of ['dirname', 'mkdir', 'date', 'timeout', 'tail', 'grep', 'cut', 'sh', 'cat']) {
    const src = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((p) => fs.existsSync(p));
    if (src) fs.symlinkSync(src, path.join(bare, t));
  }
  const nonode = await w.spawnProc('/usr/bin/env', ['-i', `PATH=${bare}`, `HOME=${w.profile}`, path.join(w.scriptsDir, 'resourcer-tick.sh')], { cwd: w.home, env: {}, timeoutMs: 20000 });
  assert.equal(nonode.code, 91);
  assert.match(nonode.stdout, /node is not on PATH/);
});
