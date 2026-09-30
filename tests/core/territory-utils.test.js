'use strict';
// territory-utils.js: pure normalisers, schedule arithmetic (timezone independent), the
// capacity-aware next_run_date, upsertTerritory (biggest distance wins, auto-downgrade) and
// getDueTerritories, against the real territory_searches schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/home');

const home = H.makeHome('terr');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;

const tu = require(path.join(H.SCRIPTS, 'territory-utils.js'));

function today() { return new Date().toISOString().slice(0, 10); }
function plusDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test.describe('normalisers', () => {
  test('normaliseLocation trims, upper-cases and collapses whitespace', () => {
    assert.equal(tu.normaliseLocation('m1'), 'M1');
    assert.equal(tu.normaliseLocation(' m   1 '), 'M 1');
    assert.equal(tu.normaliseLocation('l1   1aa'), 'L1 1AA');
    assert.equal(tu.normaliseLocation(null), '');
  });

  test('normaliseJobTitle title-cases and keeps the known acronyms upper-case', () => {
    assert.equal(tu.normaliseJobTitle('kitchen assistant dbs'), 'Kitchen Assistant DBS');
    assert.equal(tu.normaliseJobTitle('  SOUS   chef '), 'Sous Chef');
    assert.equal(tu.normaliseJobTitle('cdp nvq HND uk'), 'CDP NVQ HND UK');
    assert.equal(tu.normaliseJobTitle(''), '');
    assert.equal(tu.normaliseJobTitle(undefined), '');
  });

  test('normaliseKeywords lower-cases, de-duplicates, sorts, and drops sentinels and location tokens', () => {
    assert.equal(tu.normaliseKeywords('DBS food hygiene, DBS'), 'dbs food hygiene');
    assert.equal(tu.normaliseKeywords('  '), '');
    assert.equal(tu.normaliseKeywords(undefined), '');
    for (const s of ['none', '(none)', 'N/A', 'null', 'undefined', '-', ' NONE ']) assert.equal(tu.normaliseKeywords(s), '', s);
    assert.equal(tu.normaliseKeywords('location:LS1 chef currentlocation:M1 -location:X1'), 'chef');
    assert.equal(tu.normaliseKeywords('location:LS1'), '');
    assert.equal(tu.normaliseKeywords('b a,c  a'), 'a b c');
  });

  test('normaliseInputs applies defaults for distance and sources', () => {
    const n = tu.normaliseInputs({ jobTitle: 'chef', location: 'ls1', keywords: 'NVQ', distance: 0, sources: 'bogus' });
    assert.deepEqual(n, { jobTitle: 'Chef', location: 'LS1', distance: 20, keywords: 'nvq', sources: 'both' });
    const m = tu.normaliseInputs({ jobTitle: 'Bar', location: 'M1', distance: 40, sources: 'reed' });
    assert.equal(m.distance, 40);
    assert.equal(m.sources, 'reed');
    assert.equal(m.keywords, '');
  });
});

test.describe('config', () => {
  test('defaults and priority intervals come from config/territory-defaults.json', () => {
    const d = tu.loadDefaults();
    assert.equal(d.distance, 20);
    assert.equal(d.activeWithin, '1 month');
    assert.equal(d.cvLimit, 20);
    assert.equal(d.priority, 'low');
    assert.equal(d.hideViewed, 7);
    assert.equal(d.sources, 'both');
    assert.deepEqual(d.priorityDays, { high: 2, medium: 3, low: 7 });
    assert.deepEqual({ ...tu.getPriorityDays() }, { high: 2, medium: 3, low: 7 });
    assert.equal(tu.PRIORITY_DAYS.high, 2);
    assert.deepEqual(Object.keys(tu.PRIORITY_DAYS).sort(), ['high', 'low', 'medium']);
  });

  test('a missing or corrupt config falls back to the built-in defaults', () => {
    for (const setup of ['missing', 'corrupt']) {
      const h2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'terr-cfg-'));
      if (setup === 'corrupt') {
        fs.mkdirSync(path.join(h2, 'config'));
        fs.writeFileSync(path.join(h2, 'config', 'territory-defaults.json'), '{oops');
      }
      const code = `const t=require(${JSON.stringify(path.join(H.SCRIPTS, 'territory-utils.js'))});console.log(JSON.stringify({d:t.loadDefaults(),p:t.getPriorityDays()}))`;
      const r = spawnSync(process.execPath, ['-e', code], { env: H.childEnv(h2), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.d.sources, 'caterer');
      assert.equal(out.d.distance, 20);
      assert.deepEqual(out.p, { high: 2, medium: 3, low: 7 });
      fs.rmSync(h2, { recursive: true, force: true });
    }
  });
});

test.describe('schedule arithmetic', () => {
  test('computeNextRunDate adds the priority interval or an override', () => {
    assert.equal(tu.computeNextRunDate('2026-09-29', 'high'), '2026-10-01');
    assert.equal(tu.computeNextRunDate('2026-09-29', 'medium'), '2026-10-02');
    assert.equal(tu.computeNextRunDate('2026-09-29', 'low'), '2026-10-06');
    assert.equal(tu.computeNextRunDate('2026-09-29', 'high', 10), '2026-10-09');
    assert.equal(tu.computeNextRunDate('2026-09-29', 'unknown'), '2026-10-06', 'unknown priority uses the low interval');
    assert.equal(tu.computeNextRunDate(null, 'high'), plusDays(today(), 2));
  });

  test('computeNextRunDate does not depend on the machine timezone (no DST day shift)', () => {
    const code = `const t=require(${JSON.stringify(path.join(H.SCRIPTS, 'territory-utils.js'))});
      console.log(JSON.stringify([t.computeNextRunDate('2027-03-25','low'), t.computeNextRunDate('2026-10-20','low'), t.computeNextRunDate('2027-03-27','medium'), t.computeNextRunDateFixed('2027-03-20','2027-03-25','low')]))`;
    const seen = new Set();
    for (const tz of ['UTC', 'Europe/London', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const r = spawnSync(process.execPath, ['-e', code], { env: H.childEnv(home, { TZ: tz }), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      seen.add(r.stdout.trim());
    }
    assert.equal(seen.size, 1, [...seen].join(' | '));
    assert.deepEqual(JSON.parse([...seen][0]), ['2027-04-01', '2026-10-27', '2027-03-30', '2027-03-27']);
  });

  test('computeNextRunDateFixed anchors to the due date in whole intervals until after today', () => {
    assert.equal(tu.computeNextRunDateFixed('2026-09-20', '2026-09-29', 'high'), '2026-09-30');
    assert.equal(tu.computeNextRunDateFixed('2026-09-20', '2026-09-29', 'medium'), '2026-10-02');
    assert.equal(tu.computeNextRunDateFixed('2026-09-20', '2026-09-29', 'low'), '2026-10-04');
    // due date today: strictly after today
    assert.equal(tu.computeNextRunDateFixed('2026-09-29', '2026-09-29', 'low'), '2026-10-06');
    // due in the future: still advances one interval
    assert.equal(tu.computeNextRunDateFixed('2026-10-05', '2026-09-29', 'low', 5), '2026-10-10');
    // never on or before today
    for (let off = -40; off <= 5; off++) {
      const due = plusDays('2026-09-29', off);
      assert.ok(tu.computeNextRunDateFixed(due, '2026-09-29', 'medium') > '2026-09-29', due);
    }
  });

  test('computeNextRunDateFixed falls back to rolling from today without a usable due date', () => {
    assert.equal(tu.computeNextRunDateFixed(null, '2026-09-29', 'high'), '2026-10-01');
    assert.equal(tu.computeNextRunDateFixed('garbage', '2026-09-29', 'low'), '2026-10-06');
  });

  test('computeNextRunDateCapped walks forward to the first day under the cap', () => {
    const db = H.makeDb(H.makeHome('terr-cap'));
    const ins = db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, enabled, next_run_date) VALUES (?, ?, 20, '', 'low', ?, ?)");
    // target for due 2026-09-20 / today 2026-09-29 / low(7d) is 2026-10-04
    for (let i = 0; i < 3; i++) ins.run('Chef', `A${i}`, 1, '2026-10-04');
    for (let i = 0; i < 2; i++) ins.run('Chef', `B${i}`, 1, '2026-10-05');
    ins.run('Chef', 'DISABLED', 0, '2026-10-06'); // disabled rows do not count
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null, 2), '2026-10-06');
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null, 3), '2026-10-05');
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null, 4), '2026-10-04');
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null), '2026-10-04', 'default cap is 57');
    assert.equal(tu.DAILY_TERRITORY_CAP, 57);
    // a bad cap cannot loop forever: bounded walk of 365 days
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null, 0), plusDays('2026-10-04', 365));
    db.close();
  });

  test('computeNextRunDateCapped falls back to the plain fixed cadence without the table', () => {
    const Database = H.loadSqlite();
    const db = new Database(':memory:');
    assert.equal(tu.computeNextRunDateCapped(db, '2026-09-20', '2026-09-29', 'low', null, 1), '2026-10-04');
    db.close();
  });
});

test.describe('upsertTerritory', () => {
  const base = { candidateCount: null, newToZoho: null, duplicates: null, skipped: null, errors: null, creditsRemaining: null };
  const rowsOf = (db, title, loc) => db.prepare('SELECT * FROM territory_searches WHERE job_title = ? AND location = ? ORDER BY distance').all(title, loc);

  test('inserts a new territory with the config defaults and normalised key', () => {
    const db = H.makeDb(H.makeHome('terr-ins'));
    const r = tu.upsertTerritory(db, { ...base, jobTitle: 'sous chef', location: 'ls1', keywords: 'NVQ', lastSearched: '2026-09-29' });
    assert.equal(r.jobTitle, 'Sous Chef');
    assert.equal(r.location, 'LS1');
    assert.equal(r.distance, 20);
    assert.equal(r.keywords, 'nvq');
    assert.equal(r.effectivePriority, 'low');
    assert.equal(r.autoDowngraded, false);
    const row = rowsOf(db, 'Sous Chef', 'LS1')[0];
    assert.equal(row.active_within, '1 month');
    assert.equal(row.cv_limit, '20');
    assert.equal(row.priority, 'low');
    assert.equal(row.sources, 'both');
    assert.equal(row.enabled, 1);
    assert.equal(row.last_searched, '2026-09-29');
    assert.equal(row.next_run_date, '2026-10-06', 'first run rolls from today by the priority interval');
    db.close();
  });

  test('initialPriority and sources apply on first insert only', () => {
    const db = H.makeDb(H.makeHome('terr-ip'));
    tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'M1', initialPriority: 'high', sources: 'reed', lastSearched: '2026-09-29' });
    let row = rowsOf(db, 'Chef', 'M1')[0];
    assert.equal(row.priority, 'high');
    assert.equal(row.sources, 'reed');
    tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'M1', initialPriority: 'low', sources: 'caterer', lastSearched: '2026-09-30' });
    row = rowsOf(db, 'Chef', 'M1')[0];
    assert.equal(row.priority, 'high');
    assert.equal(row.sources, 'reed');
    db.close();
  });

  test('biggest distance wins: never downgraded, upgraded when a wider search runs', () => {
    const db = H.makeDb(H.makeHome('terr-dist'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords) VALUES ('Chef', 'LS1', 30, '')").run();
    assert.equal(tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', searchDistance: 20, lastSearched: '2026-09-29' }).distance, 30);
    assert.equal(tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', searchDistance: 40, lastSearched: '2026-09-29' }).distance, 40);
    const rows = rowsOf(db, 'Chef', 'LS1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].distance, 40);
    db.close();
  });

  test('duplicate rows of one territory are merged into one (best priority, latest last_searched)', () => {
    const db = H.makeDb(H.makeHome('terr-merge'));
    const ins = db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, last_searched) VALUES ('Chef', 'LS1', ?, '', ?, ?)");
    ins.run(20, 'low', '2026-09-01');
    ins.run(30, 'high', '2026-09-10');
    ins.run(40, 'medium', '2026-08-01');
    const r = tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', lastSearched: '2026-09-29' });
    assert.equal(r.distance, 40);
    const rows = rowsOf(db, 'Chef', 'LS1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priority, 'high', 'the keeper is the highest-priority row');
    assert.equal(rows[0].distance, 40);
    db.close();
  });

  test('auto-downgrade: fewer than 5 new steps down one tier and clears a custom interval', () => {
    const db = H.makeDb(H.makeHome('terr-down'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, interval_days, next_run_date) VALUES ('Chef', 'LS1', 20, '', 'high', 9, '2026-09-25')").run();
    let r = tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', newToZoho: 2, lastSearched: '2026-09-29' });
    assert.equal(r.autoDowngraded, true);
    assert.equal(r.previousPriority, 'high');
    assert.equal(r.effectivePriority, 'medium');
    let row = rowsOf(db, 'Chef', 'LS1')[0];
    assert.equal(row.priority, 'medium');
    assert.equal(row.interval_days, null);
    assert.equal(row.new_to_zoho, 2);
    // medium -> low, then low stays low
    r = tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', newToZoho: 0, lastSearched: '2026-09-29' });
    assert.equal(r.effectivePriority, 'low');
    r = tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', newToZoho: 0, lastSearched: '2026-09-29' });
    assert.equal(r.effectivePriority, 'low');
    assert.equal(r.autoDowngraded, false);
    db.close();
  });

  test('5 or more new, and manual adds (null), never downgrade', () => {
    const db = H.makeDb(H.makeHome('terr-nodown'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority) VALUES ('Chef', 'LS1', 20, '', 'high')").run();
    assert.equal(tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', newToZoho: 5, lastSearched: '2026-09-29' }).effectivePriority, 'high');
    assert.equal(tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', newToZoho: null, lastSearched: '2026-09-29' }).effectivePriority, 'high');
    db.close();
  });

  test('stamps run results and never changes enabled', () => {
    const db = H.makeDb(H.makeHome('terr-stamp'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, enabled) VALUES ('Chef', 'LS1', 20, '', 'medium', 0)").run();
    tu.upsertTerritory(db, { jobTitle: 'Chef', location: 'LS1', candidateCount: 50, newToZoho: 12, duplicates: 3, skipped: 30, errors: 1, creditsRemaining: 4242, lastSearched: '2026-09-29' });
    const row = rowsOf(db, 'Chef', 'LS1')[0];
    assert.deepEqual(
      [row.candidate_count, row.new_to_zoho, row.duplicates, row.skipped, row.errors, row.credits_remaining, row.enabled],
      [50, 12, 3, 30, 1, 4242, 0]
    );
    db.close();
  });

  test('next_run_date keeps the due-date phase (fixed cadence) rather than the run date', () => {
    const db = H.makeDb(H.makeHome('terr-phase'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, next_run_date) VALUES ('Chef', 'LS1', 20, '', 'low', '2026-09-20')").run();
    const r = tu.upsertTerritory(db, { ...base, jobTitle: 'Chef', location: 'LS1', lastSearched: '2026-09-29' });
    assert.equal(r.nextRunDate, '2026-10-04');
    db.close();
  });
});

test.describe('getDueTerritories', () => {
  test('returns enabled territories due today or unscheduled, high priority first', () => {
    const db = H.makeDb(H.makeHome('terr-due'));
    const ins = db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, priority, enabled, next_run_date, sources) VALUES (?, ?, 20, '', ?, ?, ?, ?)");
    const t = today();
    ins.run('Chef', 'A1', 'low', 1, plusDays(t, -1), 'caterer');
    ins.run('Chef', 'A2', 'high', 1, t, 'both');
    ins.run('Chef', 'A3', 'medium', 1, null, 'reed');
    ins.run('Chef', 'A4', 'high', 1, plusDays(t, 1), 'caterer');
    ins.run('Chef', 'A5', 'high', 0, plusDays(t, -3), 'caterer');
    ins.run('Chef', 'A6', 'low', 1, plusDays(t, -5), 'caterer');
    const due = tu.getDueTerritories(db).map(r => r.location);
    assert.deepEqual(due, ['A2', 'A3', 'A6', 'A1']);
    db.close();
  });

  test('a territory row without an explicit sources value reads as caterer (column default)', () => {
    const db = H.makeDb(H.makeHome('terr-null'));
    db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, next_run_date) VALUES ('Chef', 'A1', 20, '', NULL)").run();
    assert.equal(tu.getDueTerritories(db)[0].sources, 'caterer');
    db.close();
  });
});
