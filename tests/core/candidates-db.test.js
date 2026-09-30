'use strict';
// candidates-db.js: every CLI subcommand the pipeline uses (phase1: check-batch-scoped, check,
// add, seen, reject-title, get-zoho-id; others: check-reed, set-zoho-id, count, ...) and the
// library functions the Reed / Phase 2 code calls, against a temp DB with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');

const home = H.makeHome('cdb');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
process.env.RESOURCER_ENV_FILE = path.join(home, 'no-such.env');

const cli = (args, opts = {}) => H.run('candidates-db.js', args, { home, ...opts });

function seed() {
  const db = H.makeDb(home);
  const ins = db.prepare("INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, 'caterer', ?)");
  ins.run(1001, 1); // unlocked: CV already held
  ins.run(1002, 0); // rejected for Chef
  ins.run(1003, 0); // rejected under the '*' sentinel
  ins.run(1004, 0); // rejected for Kitchen Porter
  ins.run(1005, 0); // seen only, no rejection row
  const rej = db.prepare("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, ?, '2026-01-01', 'test')");
  rej.run(1002, 'Chef');
  rej.run(1003, '*');
  rej.run(1004, 'Kitchen Porter');
  db.close();
}

test.before(() => seed());
// Release the in-process connection before the temp directory is removed (Windows keeps it locked).
test.after(() => require(path.join(H.RES, 'candidates-db.js')).closeDb());

const parseIn = (r) => JSON.parse(r.stdout.trim()).inDb.map(Number).sort((a, b) => a - b);

test.describe('candidates-db CLI: existence checks', () => {
  test('check: NEW exits 1, SEEN and UNLOCKED exit 0, bad id exits 2', () => {
    let r = cli(['check', '999999']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), 'NEW: 999999');
    r = cli(['check', '1005']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'SEEN: 1005');
    r = cli(['check', '1001']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'UNLOCKED: 1001');
    r = cli(['check', 'abc']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: check <id>/);
  });

  test('check-batch (unscoped) returns every recorded id, accepts commas and whitespace', () => {
    let r = cli(['check-batch', '1001,1002, 1005,424242']);
    assert.equal(r.status, 0);
    assert.deepEqual(parseIn(r), [1001, 1002, 1005]);
    r = cli(['check-batch', '1001 1002\n1003']);
    assert.deepEqual(parseIn(r), [1001, 1002, 1003]);
    r = cli(['check-batch', '']);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { inDb: [] });
  });

  test('check-batch --file reads ids from a file', () => {
    const f = path.join(home, 'ids.txt');
    fs.writeFileSync(f, '1001\n1004\n555555\n');
    const r = cli(['check-batch', '--file', f]);
    assert.equal(r.status, 0);
    assert.deepEqual(parseIn(r), [1001, 1004]);
  });

  test('check-reed: NEW exits 1, SEEN/UNLOCKED exit 0, bad id exits 2', () => {
    let r = cli(['check-reed', '777']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), 'NEW (Reed): 777');
    const d = new (H.loadSqlite())(path.join(home, 'candidates.db'));
    d.prepare("INSERT INTO candidates (reed_id, source, unlocked) VALUES (5001, 'reed', 0)").run();
    d.prepare("INSERT INTO candidates (reed_id, source, unlocked) VALUES (5002, 'reed', 1)").run();
    d.close();
    r = cli(['check-reed', '5001']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'SEEN (Reed): 5001');
    r = cli(['check-reed', '5002']);
    assert.equal(r.stdout.trim(), 'UNLOCKED (Reed): 5002');
    assert.equal(cli(['check-reed', 'x']).status, 2);
  });
});

test.describe('candidates-db CLI: check-batch-scoped (job-title-scoped skip rule)', () => {
  test('skips unlocked, rejected-for-this-title and sentinel rows; reconsiders the rest', () => {
    const all = '1001,1002,1003,1004,1005,1006';
    assert.deepEqual(parseIn(cli(['check-batch-scoped', all, 'Chef'])), [1001, 1002, 1003]);
    assert.deepEqual(parseIn(cli(['check-batch-scoped', all, 'Kitchen Porter'])), [1001, 1003, 1004]);
    // no title: only unlocked + the '*' sentinel
    assert.deepEqual(parseIn(cli(['check-batch-scoped', all])), [1001, 1003]);
  });

  test('title matching is exact and case-sensitive', () => {
    assert.deepEqual(parseIn(cli(['check-batch-scoped', '1002', 'chef'])), []);
    assert.deepEqual(parseIn(cli(['check-batch-scoped', '1002', 'Chef'])), [1002]);
  });

  test('--file form takes the title as the third argument', () => {
    const f = path.join(home, 'scoped-ids.txt');
    fs.writeFileSync(f, '1001\n1002\n1004\n1005\n');
    const r = cli(['check-batch-scoped', '--file', f, 'Kitchen Porter']);
    assert.equal(r.status, 0);
    assert.deepEqual(parseIn(r), [1001, 1004]);
  });

  test('empty id list gives an empty result', () => {
    assert.deepEqual(JSON.parse(cli(['check-batch-scoped', '', 'Chef']).stdout.trim()), { inDb: [] });
  });

  test('falls back to the unscoped rule when candidate_rejections does not exist', () => {
    const h2 = H.makeHome('cdb-nomig');
    const d = new (H.loadSqlite())(path.join(h2, 'candidates.db'));
    d.exec("CREATE TABLE candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER UNIQUE, reed_id INTEGER UNIQUE, source TEXT NOT NULL DEFAULT 'caterer', role TEXT, location TEXT, pulled_date TEXT, unlocked INTEGER DEFAULT 0, zoho_id TEXT)");
    d.exec("INSERT INTO candidates (caterer_id, source, unlocked) VALUES (1, 'caterer', 0), (2, 'caterer', 1)");
    d.close();
    const r = H.run('candidates-db.js', ['check-batch-scoped', '1,2,3', 'Chef'], { home: h2 });
    assert.equal(r.status, 0);
    assert.deepEqual(parseIn(r), [1, 2]);
  });
});

test.describe('candidates-db CLI: writes', () => {
  test('add registers as unlocked, is idempotent, and upgrades a seen row', () => {
    let r = cli(['add', '2001']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'ADDED: 2001');
    assert.equal(cli(['check', '2001']).stdout.trim(), 'UNLOCKED: 2001');
    assert.equal(cli(['add', '2001']).status, 0);
    // seen first, then add -> unlocked
    cli(['seen', '2002']);
    assert.equal(cli(['check', '2002']).stdout.trim(), 'SEEN: 2002');
    cli(['add', '2002']);
    assert.equal(cli(['check', '2002']).stdout.trim(), 'UNLOCKED: 2002');
    assert.equal(cli(['add', 'nope']).status, 2);
  });

  test('seen never downgrades an unlocked row', () => {
    cli(['add', '2003']);
    const r = cli(['seen', '2003']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'SEEN: 2003');
    assert.equal(cli(['check', '2003']).stdout.trim(), 'UNLOCKED: 2003');
    assert.equal(cli(['seen', '']).status, 2);
  });

  test('reject-title records a rejection scoped to the title; missing title uses the * sentinel', () => {
    let r = cli(['reject-title', '3001', 'Sous Chef']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    // a second, identical rejection is a no-op (unique index in the migrated schema)
    cli(['reject-title', '3001', 'Sous Chef']);
    cli(['reject-title', '3002']);
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
    const rows = db.prepare('SELECT caterer_id, job_title, origin, rejected_at FROM candidate_rejections WHERE caterer_id IN (3001, 3002) ORDER BY caterer_id').all();
    db.close();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(x => x.job_title), ['Sous Chef', '*']);
    assert.ok(rows.every(x => x.origin === 'pipeline'));
    assert.match(rows[0].rejected_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(cli(['reject-title', 'x', 'Chef']).status, 2);
  });

  test('reject-title creates the table on a database that never had it', () => {
    const h2 = H.makeHome('cdb-rej');
    const d = new (H.loadSqlite())(path.join(h2, 'candidates.db'));
    d.close();
    const r = H.run('candidates-db.js', ['reject-title', '10', 'Chef'], { home: h2 });
    assert.equal(r.status, 0);
    const d2 = new (H.loadSqlite())(path.join(h2, 'candidates.db'), { readonly: true });
    assert.equal(d2.prepare('SELECT COUNT(*) n FROM candidate_rejections').get().n, 1);
    d2.close();
  });

  test('set-zoho-id / get-zoho-id round trip; get exits 1 when unset; bad args exit 2', () => {
    cli(['add', '4001']);
    let r = cli(['get-zoho-id', '4001']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    r = cli(['set-zoho-id', '4001', 'ZOHO-XYZ-1']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'ZOHO_ID_SET: 4001 \u{2192} ZOHO-XYZ-1');
    r = cli(['get-zoho-id', '4001']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'ZOHO-XYZ-1');
    assert.equal(cli(['get-zoho-id', '']).status, 2);
    assert.equal(cli(['set-zoho-id', '4001']).status, 2);
    // the trigger of the real schema stamps zoho_pushed_at the first time zoho_id is set
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
    const row = db.prepare('SELECT zoho_pushed_at FROM candidates WHERE caterer_id = 4001').get();
    db.close();
    assert.ok(row.zoho_pushed_at);
  });

  test('import-cvdb imports the activity report CSV and reports totals', () => {
    const csv = path.join(home, 'activity.csv');
    fs.writeFileSync(csv, [
      'Activity Report',
      'Candidate Id,Name,Credit Used',
      '"6001",Fake One,1',
      '6002,Fake Two,0',
      'abc,Fake Three,1',
      '6001,Fake One again,1',
      '',
    ].join('\n'));
    const r = cli(['import-cvdb', csv]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Import done: 2 new, 1 updated, 1 skipped/);
    assert.match(r.stdout, /DB totals: \d+ candidates \(\d+ unlocked, \d+ seen-only\)/);
    assert.equal(cli(['check', '6001']).stdout.trim(), 'UNLOCKED: 6001');
    assert.equal(cli(['check', '6002']).stdout.trim(), 'SEEN: 6002');
  });

  test('import-cvdb rejects a missing file and a CSV without the header row', () => {
    let r = cli(['import-cvdb', path.join(home, 'nope.csv')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: import-cvdb/);
    const bad = path.join(home, 'bad.csv');
    fs.writeFileSync(bad, 'foo,bar\n1,2\n');
    r = cli(['import-cvdb', bad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Could not find header row/);
  });
});

test.describe('candidates-db CLI: stats and help', () => {
  test('count and count-by-source print the documented formats', () => {
    let r = cli(['count']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Total: \d+ \| Unlocked \(credit spent\): \d+ \| Seen only: \d+$/m);
    r = cli(['count-by-source']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Candidates by source:$/m);
    assert.match(r.stdout, /^ {2}caterer: \d+ total \| \d+ unlocked \| \d+ in Zoho$/m);
    assert.match(r.stdout, /^ {2}TOTAL: \d+ \| \d+ unlocked \| \d+ in Zoho$/m);
    assert.ok(r.stdout.includes('\u{2500}'.repeat(37)));
  });

  test('count-by-source on an empty database', () => {
    const h2 = H.makeHome('cdb-empty');
    const r = H.run('candidates-db.js', ['count-by-source'], { home: h2 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'No candidates in DB');
    assert.match(H.run('candidates-db.js', ['count'], { home: h2 }).stdout, /Total: 0 \| Unlocked \(credit spent\): 0 \| Seen only: 0/);
  });

  test('--help and unknown commands print the command list and exit 0', () => {
    for (const args of [['--help'], ['bogus'], []]) {
      const r = cli(args);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Candidate DB \(Caterer \+ Reed\)/);
      for (const cmd of ['check-batch-scoped', 'reject-title', 'get-zoho-id', 'import-cvdb', 'count-by-source']) {
        assert.ok(r.stdout.includes(cmd), cmd);
      }
    }
  });
});

test.describe('candidates-db library', () => {
  const lib = require(path.join(H.RES, 'candidates-db.js'));

  test('DB_PATH comes from RESOURCER_HOME', () => {
    assert.equal(lib.DB_PATH, path.join(home, 'candidates.db'));
  });

  test('connection sets busy_timeout 5000, leaves the journal mode alone, and reopens after closeDb', () => {
    let db = lib.getDb();
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    lib.closeDb();
    db = lib.getDb();
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(lib.getDb(), db, 'singleton');
  });

  test('exports keep the legacy surface', () => {
    for (const name of [
      'DB_PATH', 'getDb', 'closeDb', 'checkCandidate', 'addCandidate', 'seenCandidate',
      'checkCandidatesBatchScoped', 'rejectCandidateForTitle', 'setZohoId', 'getZohoId', 'importCvdb',
      'countStats', 'checkByReedId', 'addReedCandidate', 'seenReedCandidate', 'setZohoIdByReedId',
      'getZohoIdByReedId', 'countStatsBySource', 'getCachedLocation', 'cacheLocation',
      'getReedDailyUsage', 'incrementReedUsage',
    ]) {
      assert.ok(name in lib, name);
    }
  });

  test('Caterer functions', () => {
    assert.equal(lib.checkCandidate(987001), null);
    lib.seenCandidate(987001);
    assert.deepEqual({ ...lib.checkCandidate(987001) }, { caterer_id: 987001, unlocked: 0 });
    lib.addCandidate(987001);
    assert.equal(lib.checkCandidate(987001).unlocked, 1);
    lib.seenCandidate(987001);
    assert.equal(lib.checkCandidate(987001).unlocked, 1);
    assert.equal(lib.getZohoId(987001), null);
    lib.setZohoId(987001, 'Z-1');
    assert.equal(lib.getZohoId(987001), 'Z-1');
    assert.deepEqual(lib.checkCandidatesBatchScoped(['987001', 'x', 0], 'Chef'), [987001]);
    assert.equal(lib.rejectCandidateForTitle(987002, 'Chef'), true);
    assert.deepEqual(lib.checkCandidatesBatchScoped([987002], 'Chef'), [987002]);
    assert.deepEqual(lib.checkCandidatesBatchScoped([987002], 'Bar'), []);
  });

  test('Reed functions', () => {
    assert.equal(lib.checkByReedId(880001), null);
    lib.seenReedCandidate(880001);
    assert.equal(lib.checkByReedId(880001).unlocked, 0);
    assert.equal(lib.checkByReedId(880001).source, 'reed');
    lib.addReedCandidate(880001);
    assert.equal(lib.checkByReedId(880001).unlocked, 1);
    lib.seenReedCandidate(880001);
    assert.equal(lib.checkByReedId(880001).unlocked, 1);
    assert.equal(lib.getZohoIdByReedId(880001), null);
    lib.setZohoIdByReedId(880001, 'RZ-9');
    assert.equal(lib.getZohoIdByReedId(880001), 'RZ-9');
  });

  test('stats functions', () => {
    const s = lib.countStats();
    assert.equal(s.total, s.unlocked + s.seenOnly);
    const by = lib.countStatsBySource();
    const sources = by.map(r => r.source);
    assert.ok(sources.includes('caterer') && sources.includes('reed'));
    assert.deepEqual([...sources].sort(), sources, 'ordered by source');
    assert.equal(by.reduce((a, r) => a + r.total, 0), s.total);
  });

  test('Reed location cache and daily usage', () => {
    assert.equal(lib.getCachedLocation('LS1'), null);
    lib.cacheLocation('LS1', 1234, 'Leeds');
    const c = lib.getCachedLocation('LS1');
    assert.equal(c.location_id, 1234);
    assert.equal(c.name, 'Leeds');
    assert.ok(c.fetched_at);
    lib.cacheLocation('LS1', 5678);
    assert.equal(lib.getCachedLocation('LS1').location_id, 5678);
    assert.equal(lib.getCachedLocation('LS1').name, null);

    assert.equal(lib.getReedDailyUsage('2026-09-29'), null);
    lib.incrementReedUsage('2026-09-29', 'profile_views');
    lib.incrementReedUsage('2026-09-29', 'profile_views');
    lib.incrementReedUsage('2026-09-29', 'cv_downloads');
    const u = lib.getReedDailyUsage('2026-09-29');
    assert.equal(u.profile_views, 2);
    assert.equal(u.cv_downloads, 1);
    assert.equal(u.daily_limit, 300);
    assert.throws(() => lib.incrementReedUsage('2026-09-29', 'bogus; DROP TABLE candidates'), /Invalid field/);
  });

  test('importCvdb throws for a missing file', () => {
    assert.throws(() => lib.importCvdb(path.join(home, 'absent.csv')), /Usage: import-cvdb/);
  });

  test('a second process can write while this one holds the connection open (busy_timeout)', () => {
    lib.getDb();
    const r = cli(['add', '2999001']);
    assert.equal(r.status, 0);
    assert.equal(lib.checkCandidate(2999001).unlocked, 1);
  });
});

test.describe('candidates-db CLI: a broken database is never reported as "not found"', () => {
  const brokenHome = (kind) => {
    const h2 = H.makeHome(`cdb-${kind}`);
    if (kind === 'corrupt') fs.writeFileSync(path.join(h2, 'candidates.db'), Buffer.alloc(4096, 'this is not a sqlite database '));
    if (kind === 'empty-schema') {
      const d = new (H.loadSqlite())(path.join(h2, 'candidates.db'));
      d.close();
    }
    return h2;
  };

  test('check exits 2 (not 1) on a corrupt database, with nothing on stdout and the reason on stderr', () => {
    const h2 = brokenHome('corrupt');
    const r = H.run('candidates-db.js', ['check', '123'], { home: h2 });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '', 'no NEW line: a caller can never read this as "not found"');
    assert.match(r.stderr, /check failed: .*(not a database|malformed|encrypted)/i);
  });

  test('check-reed exits 2 on a corrupt database too', () => {
    const h2 = brokenHome('corrupt');
    const r = H.run('candidates-db.js', ['check-reed', '123'], { home: h2 });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
  });

  test('check keeps its contract on a healthy database: 0 found, 1 not found (with the NEW line), 2 usage', () => {
    const h2 = brokenHome('empty-schema');
    assert.equal(H.run('candidates-db.js', ['add', '55'], { home: h2 }).status, 0);
    assert.equal(H.run('candidates-db.js', ['check', '55'], { home: h2 }).status, 0);
    const miss = H.run('candidates-db.js', ['check', '56'], { home: h2 });
    assert.equal(miss.status, 1);
    assert.equal(miss.stdout.trim(), 'NEW: 56');
    assert.equal(H.run('candidates-db.js', ['check', 'x'], { home: h2 }).status, 2);
  });

  test('every other subcommand keeps failing non-zero on a corrupt database (batch, add, seen, get-zoho-id)', () => {
    const h2 = brokenHome('corrupt');
    for (const args of [['check-batch', '1,2'], ['check-batch-scoped', '1,2', 'Chef'], ['add', '1'], ['seen', '1'], ['get-zoho-id', '1'], ['count']]) {
      const r = H.run('candidates-db.js', args, { home: h2 });
      assert.notEqual(r.status, 0, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
    }
  });

  test('reject-title exits 1 when the rejection could not be written (it used to exit 0 and lose the title scoping silently)', () => {
    const h2 = H.makeHome('cdb-rejfail');
    const d = H.makeDb(h2);
    d.exec('DROP TABLE candidate_rejections; CREATE VIEW candidate_rejections AS SELECT 1 AS id, 1 AS caterer_id, NULL AS reed_id, \'x\' AS job_title, \'x\' AS rejected_at, \'x\' AS origin;');
    d.close();
    const r = H.run('candidates-db.js', ['reject-title', '10', 'Chef'], { home: h2 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reject-title failed/);
    assert.equal(H.run('candidates-db.js', ['reject-title', 'x', 'Chef'], { home: h2 }).status, 2, 'usage errors keep exit 2');
  });

  test('a missing SQLite driver: the CLI reports check as exit 2 (not "new"); as a library it still fails at require', () => {
    const { spawnSync } = require('child_process');
    const x = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdb-nodriver-'));
    try {
      fs.mkdirSync(path.join(x, 'scripts', 'lib'), { recursive: true });
      fs.copyFileSync(path.join(H.RES, 'candidates-db.js'), path.join(x, 'candidates-db.js'));
      fs.copyFileSync(path.join(H.RES, 'scripts', 'lib', 'paths.js'), path.join(x, 'scripts', 'lib', 'paths.js'));
      const env = { ...H.childEnv(x), NODE_PATH: '' };
      const cliRun = (args) => spawnSync(process.execPath, [path.join(x, 'candidates-db.js'), ...args], { env, encoding: 'utf8' });
      const c = cliRun(['check', '1']);
      assert.equal(c.status, 2);
      assert.equal(c.stdout, '');
      assert.match(c.stderr, /check failed: .*better-sqlite3/);
      assert.notEqual(cliRun(['add', '1']).status, 0);
      const lib = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(x, 'candidates-db.js')], { env, encoding: 'utf8' });
      assert.notEqual(lib.status, 0);
      assert.match(lib.stderr, /better-sqlite3/);
    } finally {
      fs.rmSync(x, { recursive: true, force: true });
    }
  });
});
