'use strict';
// territory-manager.js, query-territory.js, territory-scheduler.js and queue-due-territories.js
// as child processes against a temp DB with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');

const iso = (offsetDays) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/** A home with a DB holding some territories. */
function fixture(prefix) {
  const home = H.makeHome(prefix);
  const db = H.makeDb(home);
  const ins = db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, enabled, next_run_date, sources, cv_limit, active_within, interval_days) VALUES (@t, @l, @d, @k, @p, @e, @n, @s, @c, '1 month', @i)");
  const rows = [
    { t: 'Chef', l: 'LS1', d: 20, k: '', p: 'high', e: 1, n: iso(-1), s: 'caterer', c: '20', i: null },
    { t: 'Sous Chef', l: 'M1', d: 30, k: 'nvq', p: 'medium', e: 1, n: iso(0), s: 'both', c: '15', i: 4 },
    { t: 'Kitchen Porter', l: 'B1', d: 20, k: '', p: 'low', e: 1, n: iso(5), s: 'reed', c: '20', i: null },
    { t: 'Bar Staff', l: 'E1', d: 20, k: '', p: 'high', e: 0, n: iso(-3), s: 'caterer', c: '20', i: null },
    { t: 'Waiter', l: 'N1', d: 20, k: '', p: 'low', e: 1, n: null, s: 'reed', c: 'x', i: null },
  ];
  for (const r of rows) ins.run(r);
  db.close();
  return home;
}

test.describe('territory-manager', () => {
  const tm = (home, args) => H.run('scripts/territory-manager.js', args, { home });

  test('defaults prints the config values and the priority intervals', () => {
    const home = H.makeHome('tm-def');
    const r = tm(home, ['defaults']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Territory Defaults \(config\/territory-defaults\.json\)/);
    assert.match(r.stdout, /distance:\s+20 miles/);
    assert.match(r.stdout, /sources:\s+both/);
    assert.match(r.stdout, /high\s+\S+ every\s+2 days/);
    assert.match(r.stdout, /low\s+\S+ every 7 days/);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')), 'defaults must not create a database');
  });

  test('help (no command, --help) prints the command list without touching the DB', () => {
    const home = H.makeHome('tm-help');
    for (const args of [[], ['--help'], ['nonsense']]) {
      const r = tm(home, args);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Territory Manager/);
      assert.match(r.stdout, /import-csv <file>/);
      assert.match(r.stdout, /Priority intervals:\s+high=2d\s+medium=3d\s+low=7d/);
    }
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
  });

  test('a DB command on a machine without candidates.db fails and does not create an empty one', () => {
    const home = H.makeHome('tm-nodb');
    const r = tm(home, ['list']);
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
  });

  test('list shows enabled territories high priority first; --priority, --due and --all filter', () => {
    const home = fixture('tm-list');
    let r = tm(home, ['list']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Territory Map \(4\)/);
    assert.ok(r.stdout.indexOf('Chef | LS1') < r.stdout.indexOf('Sous Chef | M1'));
    assert.ok(!r.stdout.includes('Bar Staff'), 'disabled hidden by default');
    assert.match(r.stdout, /Source: \S+ caterer/);
    r = tm(home, ['list', '--all']);
    assert.match(r.stdout, /Territory Map \(5\)/);
    assert.match(r.stdout, /Bar Staff \| E1 \| 20mi.*\[DISABLED\]/);
    r = tm(home, ['list', '--priority', 'low']);
    assert.match(r.stdout, /Territory Map \(2\)/);
    r = tm(home, ['list', '--due']);
    assert.match(r.stdout, /Due territories \(3\)/);
    assert.ok(!r.stdout.includes('Kitchen Porter'));
  });

  test('add creates a normalised territory with the requested priority and source', () => {
    const home = fixture('tm-add');
    const r = tm(home, ['add', '--title', 'catering assistant', '--loc', 'wf1', '--priority', 'medium', '--sources', 'caterer', '--kw', 'DBS']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Territory: Catering Assistant \| WF1 \| 20mi \| medium \| \S+ caterer \| next: \d{4}-\d{2}-\d{2}/);
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
    const row = db.prepare("SELECT * FROM territory_searches WHERE job_title = 'Catering Assistant'").get();
    db.close();
    assert.equal(row.location, 'WF1');
    assert.equal(row.keywords, 'dbs');
    assert.equal(row.priority, 'medium');
    assert.equal(row.sources, 'caterer');
    assert.equal(row.enabled, 1);
    assert.match(row.next_run_date, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('add: biggest distance wins, and overrides are applied', () => {
    const home = fixture('tm-add2');
    let r = tm(home, ['add', '--title', 'Chef', '--loc', 'LS1', '--dist', '10']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Existing distance \(20mi\) is larger than requested \(10mi\)/);
    r = tm(home, ['add', '--title', 'Chef', '--loc', 'LS1', '--dist', '40', '--active', '1 week', '--limit', '35']);
    assert.match(r.stdout, /Distance set to 40mi \(biggest wins\)/);
    assert.match(r.stdout, /Active override: 1 week/);
    assert.match(r.stdout, /Limit override: 35/);
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
    const rows = db.prepare("SELECT * FROM territory_searches WHERE job_title = 'Chef' AND location = 'LS1'").all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].distance, 40);
    assert.equal(rows[0].active_within, '1 week');
    assert.equal(rows[0].cv_limit, '35');
  });

  test('add validates its arguments (exit 1)', () => {
    const home = fixture('tm-add3');
    assert.equal(tm(home, ['add', '--title', 'Chef']).status, 1);
    let r = tm(home, ['add', '--title', 'Chef', '--loc', 'M9', '--priority', 'urgent']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid priority "urgent"/);
    r = tm(home, ['add', '--title', 'Chef', '--loc', 'M9', '--sources', 'linkedin']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid sources "linkedin"/);
  });

  test('set-priority, set-interval, enable, disable and delete update the row', () => {
    const home = fixture('tm-mut');
    const q = (sql) => {
      const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
      const x = db.prepare(sql).get();
      db.close();
      return x;
    };
    const id = q("SELECT id FROM territory_searches WHERE location = 'LS1'").id;
    let r = tm(home, ['set-priority', String(id), 'low']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /priority: low \| next: \d{4}-\d{2}-\d{2}/);
    assert.equal(q(`SELECT priority p FROM territory_searches WHERE id = ${id}`).p, 'low');
    r = tm(home, ['set-interval', String(id), '5']);
    assert.match(r.stdout, /interval: 5 days \(custom\)/);
    assert.equal(q(`SELECT interval_days i FROM territory_searches WHERE id = ${id}`).i, 5);
    r = tm(home, ['set-interval', String(id), '0']);
    assert.match(r.stdout, /interval: 7 days \(priority default\)/);
    assert.equal(q(`SELECT interval_days i FROM territory_searches WHERE id = ${id}`).i, null);
    r = tm(home, ['disable', String(id)]);
    assert.match(r.stdout, /DISABLED/);
    assert.equal(q(`SELECT enabled e FROM territory_searches WHERE id = ${id}`).e, 0);
    r = tm(home, ['enable', String(id)]);
    assert.match(r.stdout, /ENABLED/);
    assert.equal(q(`SELECT enabled e FROM territory_searches WHERE id = ${id}`).e, 1);
    r = tm(home, ['delete', String(id)]);
    assert.match(r.stdout, /DELETED/);
    assert.equal(q(`SELECT COUNT(*) n FROM territory_searches WHERE id = ${id}`).n, 0);
  });

  test('mutations on an unknown id or with bad arguments exit 1', () => {
    const home = fixture('tm-bad');
    for (const args of [
      ['set-priority', '99999', 'high'], ['set-priority', '1', 'urgent'], ['set-priority'],
      ['set-interval', '99999', '3'], ['set-interval', '1'], ['enable', '99999'], ['disable'], ['delete', '99999'], ['delete'],
    ]) {
      assert.equal(tm(home, args).status, 1, args.join(' '));
    }
  });

  test('due lists the territories due today; recalc rewrites next_run_date', () => {
    const home = fixture('tm-due');
    let r = tm(home, ['due']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Due territories \(\d{4}-\d{2}-\d{2}\) \S+ 3 found/);
    r = tm(home, ['recalc']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /5 rows recalculated\./);
    assert.match(r.stdout, /Recalculating next_run_date for all rows\.\.\./);
  });

  test('import-csv adds, updates and skips rows and applies the CSV priority', () => {
    const home = fixture('tm-csv');
    const csv = path.join(home, 'territories.csv');
    fs.writeFileSync(csv, [
      'job_title,location,keywords,priority',
      'Chef,LS1,,high',                // existing -> updated
      'Pastry Chef,SW1,,medium',       // new
      'Kitchen Porter DBS,L1,dbs,low', // new
      ',M1,,low',                      // skipped (no title)
      '"Bar Manager","E2",,',          // new, default priority
      '',
    ].join('\n'));
    const r = tm(home, ['import-csv', csv]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Import complete: 3 added, 1 updated, 1 skipped/);
    assert.match(r.stdout, /Defaults applied: 20mi \| 1 month \| 20 CVs\/run/);
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'), { readonly: true });
    assert.equal(db.prepare("SELECT priority p FROM territory_searches WHERE job_title = 'Pastry Chef'").get().p, 'medium');
    assert.equal(db.prepare("SELECT keywords k FROM territory_searches WHERE job_title = 'Kitchen Porter DBS'").get().k, 'dbs');
    assert.equal(db.prepare("SELECT priority p FROM territory_searches WHERE job_title = 'Bar Manager'").get().p, 'low');
    db.close();
  });

  test('import-csv rejects a missing file and a CSV without the required columns', () => {
    const home = fixture('tm-csv2');
    let r = tm(home, ['import-csv', path.join(home, 'none.csv')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Minimum CSV format/);
    const bad = path.join(home, 'bad.csv');
    fs.writeFileSync(bad, 'foo,bar\n1,2\n');
    r = tm(home, ['import-csv', bad]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CSV must have at least: job_title, location/);
  });
});

test.describe('query-territory', () => {
  const qt = (home, args) => H.run('scripts/query-territory.js', args, { home });

  test('--json prints rows, high priority first; filters work', () => {
    const home = fixture('qt');
    let r = qt(home, ['--json']);
    assert.equal(r.status, 0);
    let rows = JSON.parse(r.stdout);
    assert.deepEqual(rows.map(x => x.location), ['LS1', 'M1', 'N1', 'B1']);
    rows = JSON.parse(qt(home, ['--json', '--all']).stdout);
    assert.equal(rows.length, 5);
    rows = JSON.parse(qt(home, ['--json', '--priority', 'low']).stdout);
    assert.deepEqual(rows.map(x => x.location).sort(), ['B1', 'N1']);
    rows = JSON.parse(qt(home, ['--json', '--due']).stdout);
    assert.deepEqual(rows.map(x => x.location).sort(), ['LS1', 'M1', 'N1']);
  });

  test('text mode prints the map with the due flag and result line', () => {
    const home = fixture('qt-text');
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'));
    db.prepare("UPDATE territory_searches SET new_to_zoho = 7, duplicates = 2, skipped = 5, errors = 0, candidate_count = 40 WHERE location = 'LS1'").run();
    db.close();
    const r = qt(home, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Territory Map \(4 territories\)/);
    assert.match(r.stdout, /\[HIGH  \] Chef \| LS1 \| 20mi/);
    assert.match(r.stdout, /Next run: \d{4}-\d{2}-\d{2}.*DUE/);
    assert.match(r.stdout, /Results: 7 new \S+ 2 dupes \S+ 5 skipped \S+ 0 errors \(pool: 40\)/);
    assert.match(r.stdout, /\(4d override\)/);
    assert.match(r.stdout, /Next run: unscheduled/);
  });

  test('missing database is an error and is not created', () => {
    const home = H.makeHome('qt-nodb');
    const r = qt(home, ['--json']);
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(home, 'candidates.db')));
    assert.equal(qt(home, ['--help']).status, 0);
  });
});

test.describe('territory-scheduler', () => {
  const ts = (home, args) => H.run('scripts/territory-scheduler.js', args, { home });

  test('--json lists due territories (highest priority first) and exits 0', () => {
    const home = fixture('ts-json');
    const r = ts(home, ['--json']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'ready');
    assert.equal(out.due, 3);
    assert.equal(out.queued, 3);
    assert.equal(out.deferred, 0);
    assert.deepEqual(out.territories.map(t => t.location), ['LS1', 'M1', 'N1']);
    assert.equal(out.territories[0].sources, 'caterer');
    assert.equal(ts(home, ['--json', '--dry-run']).stdout.includes('"dry_run"'), true);
  });

  test('--max defers the rest', () => {
    const home = fixture('ts-max');
    const out = JSON.parse(ts(home, ['--json', '--max', '1']).stdout);
    assert.equal(out.queued, 1);
    assert.equal(out.deferred, 2);
  });

  test('exit 3 when nothing is due', () => {
    const home = H.makeHome('ts-none');
    H.makeDb(home).close();
    let r = ts(home, ['--json']);
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).status, 'nothing_due');
    r = ts(home, []);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /Nothing due today/);
  });

  test('a territory with an in-flight run is skipped', () => {
    const home = fixture('ts-run');
    H.writeJson(path.join(home, 'runs', 'phase1-x.json'), { id: 'phase1-x', status: 'phase1_running', jobTitle: 'chef', location: 'ls1', updatedAt: new Date().toISOString() });
    const out = JSON.parse(ts(home, ['--json']).stdout);
    assert.equal(out.skippedAlreadyRunning, 1);
    assert.equal(out.alreadyRunning[0].blockingRun, 'phase1-x');
    assert.deepEqual(out.territories.map(t => t.location), ['M1', 'N1']);
  });

  test('an exhausted Reed budget downgrades reed and both territories to caterer', () => {
    const home = fixture('ts-reed');
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'));
    db.prepare('INSERT INTO reed_daily_usage (date, profile_views, daily_limit) VALUES (?, 300, 300)').run(new Date().toISOString().slice(0, 10));
    db.close();
    const out = JSON.parse(ts(home, ['--json']).stdout);
    assert.deepEqual(out.territories.map(t => t.sources), ['caterer', 'caterer', 'caterer']);
    const text = ts(home, []).stdout;
    assert.match(text, /Reed daily budget exhausted/);
  });

  test('human-readable output ends with the spawn instructions; --dry-run does not', () => {
    const home = fixture('ts-text');
    let r = ts(home, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Territory Scheduler/);
    assert.match(r.stdout, /3 territories due \| running 3 now/);
    assert.match(r.stdout, /--- SPAWN_INSTRUCTIONS ---/);
    const line = r.stdout.split('\n').find(l => l.startsWith('SPAWN_1: '));
    const payload = JSON.parse(line.slice('SPAWN_1: '.length));
    assert.deepEqual(Object.keys(payload), ['JOB_TITLE', 'LOCATION', 'DISTANCE_MILES', 'ACTIVE_WITHIN', 'CV_LIMIT', 'KEYWORDS', 'HIDE_VIEWED', 'SOURCES']);
    assert.equal(payload.JOB_TITLE, 'Chef');
    r = ts(home, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /DRY RUN/);
    assert.ok(!r.stdout.includes('SPAWN_INSTRUCTIONS'));
  });
});

test.describe('queue-due-territories', () => {
  const qd = (home, args) => H.run('scripts/queue-due-territories.js', args, { home });
  const pendingFiles = (home) => {
    const d = path.join(home, 'pending-searches');
    return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
  };

  test('queues every due territory as a pending-search file with the legacy payload', () => {
    const home = fixture('qd-basic');
    const r = qd(home, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.status, 'queued');
    assert.equal(s.due, 3);
    assert.equal(s.queued, 3);
    assert.equal(s.alreadyQueued, 0);
    assert.equal(s.reedBudgetExhausted, false);
    const files = pendingFiles(home);
    assert.equal(files.length, 3);
    assert.deepEqual(files, [...s.files].sort());
    for (const f of files) assert.match(f, /^territory-\d+-\d{8}-\d{4}\.json$/);
    const chef = H.readJson(path.join(home, 'pending-searches', files.find(f => H.readJson(path.join(home, 'pending-searches', f)).jobTitle === 'Chef')));
    assert.deepEqual(Object.keys(chef), ['jobTitle', 'location', 'keywords', 'priority', 'sources', 'distance', 'activeWithin', 'cvLimit', 'overrides', 'requestedAt', 'source']);
    assert.equal(chef.location, 'LS1');
    assert.equal(chef.priority, 'high');
    assert.equal(chef.sources, 'caterer');
    assert.equal(chef.distance, 20);
    assert.equal(chef.activeWithin, '1 month');
    assert.equal(chef.cvLimit, 20);
    assert.deepEqual(chef.overrides, []);
    assert.equal(chef.source, 'queue-due-territories-autocatchup');
    assert.ok(!('spawnedAt' in chef), 'a queued file must never carry spawnedAt');
    const sous = files.map(f => H.readJson(path.join(home, 'pending-searches', f))).find(p => p.jobTitle === 'Sous Chef');
    assert.equal(sous.keywords, 'nvq');
    assert.equal(sous.cvLimit, 15);
    assert.equal(sous.sources, 'both');
    const waiter = files.map(f => H.readJson(path.join(home, 'pending-searches', f))).find(p => p.jobTitle === 'Waiter');
    assert.equal(waiter.cvLimit, 20, 'unparseable cv_limit falls back to 20');
  });

  test('is idempotent: a second run queues nothing', () => {
    const home = fixture('qd-idem');
    qd(home, ['--json']);
    const before = pendingFiles(home);
    const r = qd(home, ['--json']);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { status: 'nothing_to_queue', due: 3, alreadyQueued: 3, alreadyRunning: 0, queued: 0 });
    assert.deepEqual(pendingFiles(home), before);
    assert.match(qd(home, []).stdout, /nothing to queue \(3 due, 3 already queued, 0 running\)/);
  });

  test('--dry-run writes nothing; --quiet prints nothing', () => {
    const home = fixture('qd-dry');
    let r = qd(home, ['--dry-run', '--json']);
    const s = JSON.parse(r.stdout);
    assert.equal(s.status, 'dry_run');
    assert.equal(s.queued, 3);
    assert.deepEqual(s.files, []);
    assert.equal(pendingFiles(home).length, 0);
    r = qd(home, ['--dry-run']);
    assert.match(r.stdout, /would queue 3\/3 due territories/);
    assert.match(r.stdout, /\+ Chef \| LS1 \| 20mi \[high\]/);
    r = qd(home, ['--quiet']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(pendingFiles(home).length, 3);
  });

  test('an existing pending file with the same title and location (any name, BOM ok) counts as queued', () => {
    const home = fixture('qd-key');
    const dir = path.join(home, 'pending-searches');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'search-1.json'), String.fromCharCode(0xFEFF) + JSON.stringify({ jobTitle: 'CHEF', location: 'ls1' }));
    fs.writeFileSync(path.join(dir, 'search-2.json'), '{corrupt');
    const s = JSON.parse(qd(home, ['--json']).stdout);
    assert.equal(s.alreadyQueued, 1);
    assert.equal(s.queued, 2);
  });

  test('a territory quarantined by the watchdog (pending-searches/.quarantine/) is not queued again while it sits there', () => {
    const home = fixture('qd-quarantine');
    const dir = path.join(home, 'pending-searches');
    fs.mkdirSync(path.join(dir, '.quarantine'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.quarantine', 'territory-9-20260929-1000.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS1', failedRuns: 3 }));
    fs.writeFileSync(path.join(dir, '.quarantine', 'territory-9-20260929-1000.why.txt'), 'x');
    const s = JSON.parse(qd(home, ['--json']).stdout);
    assert.equal(s.alreadyQuarantined, 1);
    assert.equal(s.queued, 2, 'the other two due territories are queued as usual');
    const queued = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => H.readJson(path.join(dir, f)).location).sort();
    assert.ok(!queued.includes('LS1'), 'Chef in LS1 stays out of the queue');
    fs.rmSync(path.join(dir, '.quarantine', 'territory-9-20260929-1000.json'));
    const again = JSON.parse(qd(home, ['--json']).stdout);
    assert.equal(again.queued, 1, 'released (file gone from quarantine): it is due and queued again');
  });

  test('a territory with an in-flight run is not queued', () => {
    const home = fixture('qd-run');
    H.writeJson(path.join(home, 'runs', 'phase1-x.json'), { id: 'phase1-x', status: 'phase1_searching', jobTitle: 'Sous Chef', location: 'M1', updatedAt: new Date().toISOString() });
    const s = JSON.parse(qd(home, ['--json']).stdout);
    assert.equal(s.alreadyRunning, 1);
    assert.equal(s.queued, 2);
    const jobs = pendingFiles(home).map(f => H.readJson(path.join(home, 'pending-searches', f)).jobTitle).sort();
    assert.deepEqual(jobs, ['Chef', 'Waiter']);
  });

  test('a stale run does not block queueing', () => {
    const home = fixture('qd-stale');
    H.writeJson(path.join(home, 'runs', 'phase1-old.json'), { id: 'phase1-old', status: 'phase1_running', jobTitle: 'Chef', location: 'LS1', updatedAt: H.minsAgo(120) });
    assert.equal(JSON.parse(qd(home, ['--json']).stdout).queued, 3);
  });

  test('an exhausted Reed budget downgrades reed/both to caterer and flags the file', () => {
    const home = fixture('qd-reed');
    const db = new (H.loadSqlite())(path.join(home, 'candidates.db'));
    db.prepare('INSERT INTO reed_daily_usage (date, profile_views, daily_limit) VALUES (?, 250, 200)').run(new Date().toISOString().slice(0, 10));
    db.close();
    const s = JSON.parse(qd(home, ['--json']).stdout);
    assert.equal(s.reedBudgetExhausted, true);
    const pend = pendingFiles(home).map(f => H.readJson(path.join(home, 'pending-searches', f)));
    assert.ok(pend.every(p => p.sources === 'caterer'));
    assert.equal(pend.filter(p => p.reedBudgetSkipped === true).length, 2, 'the both and reed territories are flagged');
    assert.ok(!('reedBudgetSkipped' in pend.find(p => p.jobTitle === 'Chef')));
    assert.match(qd(home, ['--dry-run']).stdout, /nothing to queue|Reed budget exhausted/);
  });

  test('nothing due exits 0; a missing database exits 1', () => {
    const home = H.makeHome('qd-none');
    H.makeDb(home).close();
    const r = qd(home, ['--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).due, 0);
    const home2 = H.makeHome('qd-nodb');
    const r2 = qd(home2, ['--json']);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /queue-due-territories:/);
    assert.equal(qd(home2, ['--help']).status, 0);
  });
});
