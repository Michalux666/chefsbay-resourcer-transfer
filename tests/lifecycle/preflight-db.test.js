'use strict';
// scripts/preflight-db.js: exit 0 only for a database that is fit to run the pipeline on.
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-pf');
require('./helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('./helpers/sqlite');
const { createLegacyDb } = require('./helpers/legacy-schema');
const pf = require('../../resourcer/scripts/preflight-db');

const SCRIPT = path.resolve(__dirname, '../../resourcer/scripts/preflight-db.js');
const ROWS = [{ caterer_id: 1, unlocked: 1, zoho_id: 'z-1' }, { caterer_id: 2, unlocked: 0 }, { reed_id: 3, source: 'reed', unlocked: 1 }];

test.after(() => ws.cleanup());

function cli(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: ws.home, ...(env || {}) } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const healthy = rows => { ws.reset(); createLegacyDb(ws.db, { rows: rows || ROWS }); };

test('a healthy database: exit 0, one OK line with counts only', () => {
  healthy();
  const r = cli([]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '[preflight-db] OK candidates=3 journal=delete');
  assert.equal(r.err, '');
});

test('--quiet prints nothing on success, --json prints one object', () => {
  healthy();
  const q = cli(['--quiet']);
  assert.equal(q.code, 0);
  assert.equal(q.out, '');
  const j = cli(['--json']);
  assert.equal(j.code, 0);
  const o = JSON.parse(j.out);
  assert.equal(o.ok, true);
  assert.equal(o.candidates, 3);
  assert.equal(o.journalMode, 'delete');
  assert.deepEqual(o.checks.map(c => c.name), ['exists', 'integrity_check', 'candidates']);
  assert.equal(o.reason, null);
});

test('a missing database is not fit, and the check never creates one', () => {
  ws.reset();
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /NOT FIT \(missing\)/);
  assert.match(r.err, /restore the data bundle/);
  assert.equal(fs.existsSync(ws.db), false, 'no empty candidates.db left behind');
  assert.equal(cli(['--allow-empty']).code, 1, 'even --allow-empty needs the file to exist');
  assert.equal(fs.existsSync(ws.db), false);
});

test('a 0 byte file: not fit, unless --allow-empty says this is a fresh install', () => {
  ws.reset();
  fs.writeFileSync(ws.db, '');
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /empty-file/);
  const ok = cli(['--allow-empty']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /candidates=0/);
});

test('a path that is a directory is not fit', () => {
  ws.reset();
  fs.mkdirSync(ws.db);
  const r = cli(['--json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).reason, 'not-a-file');
  fs.rmdirSync(ws.db);
});

test('a file that is not a database is not fit', () => {
  ws.reset();
  fs.writeFileSync(ws.db, 'this is definitely not a sqlite database, just some text. '.repeat(40));
  const r = cli(['--json']);
  assert.equal(r.code, 1);
  const o = JSON.parse(r.out);
  assert.equal(o.ok, false);
  assert.equal(o.reason, 'open-failed');
  assert.match(o.detail, /not a database|malformed/i);
});

test('a truncated or damaged database is not fit', () => {
  ws.reset();
  const rows = [];
  for (let i = 1; i <= 3000; i++) rows.push({ caterer_id: i, unlocked: i % 2, zoho_id: i % 3 ? null : `z-${i}` });
  createLegacyDb(ws.db, { rows });
  const size = fs.statSync(ws.db).size;
  assert.ok(size > 40000, 'fixture is big enough to span many pages');
  const good = cli(['--json']);
  assert.equal(JSON.parse(good.out).candidates, 3000);
  const copy = path.join(ws.home, 'damaged.db');
  // cut the file in the middle of a page
  fs.copyFileSync(ws.db, copy);
  fs.truncateSync(copy, Math.floor(size * 0.6) + 17);
  let o = JSON.parse(cli(['--db', copy, '--json']).out);
  assert.equal(o.ok, false, `truncated: ${o.reason}`);
  // overwrite a run of pages with garbage
  fs.copyFileSync(ws.db, copy);
  const fd = fs.openSync(copy, 'r+');
  fs.writeSync(fd, Buffer.alloc(12000, 0xa5), 0, 12000, 8192);
  fs.closeSync(fd);
  const r = cli(['--db', copy, '--json']);
  o = JSON.parse(r.out);
  assert.equal(r.code, 1);
  assert.equal(o.ok, false);
  assert.ok(['integrity-failed', 'open-failed'].includes(o.reason), o.reason);
  assert.ok(o.detail && o.detail.length > 0);
  assert.doesNotMatch(r.out, /Person|@/);
});

test('integrity_check findings are caught even when the file opens and every query still works', () => {
  healthy();
  // drop an index from the schema without freeing its pages: SQLite reports an orphan page, reads keep working
  const d = new Database(ws.db);
  d.unsafeMode(true);
  d.pragma('writable_schema = ON');
  d.exec("DELETE FROM sqlite_master WHERE type = 'index' AND name = 'idx_territory_enabled'");
  d.pragma('writable_schema = OFF');
  d.close();
  const probe = new Database(ws.db);
  assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM candidates').get().n, 3, 'the fixture is readable');
  assert.notEqual(probe.pragma('integrity_check', { simple: true }), 'ok', 'and damaged');
  probe.close();
  const r = cli(['--json']);
  const o = JSON.parse(r.out);
  assert.equal(r.code, 1);
  assert.equal(o.ok, false);
  assert.equal(o.reason, 'integrity-failed');
  assert.match(o.detail, /never used/);
});

test('an empty candidates table is not fit unless --allow-empty; a missing candidates table likewise', () => {
  healthy([]);
  let r = cli(['--json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).reason, 'no-candidates');
  r = cli(['--allow-empty', '--json']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).candidates, 0);

  ws.reset();
  const d = new Database(ws.db);
  d.exec('CREATE TABLE something_else (x INTEGER)');
  d.close();
  r = cli(['--json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).reason, 'no-candidates-table');
  r = cli(['--allow-empty', '--json']);
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).checks.find(c => c.name === 'candidates').detail, /table absent/);
});

test('it changes nothing: the file hash, the journal mode and the directory listing stay as they were', () => {
  healthy();
  const before = { hash: sha(ws.db), files: fs.readdirSync(ws.home).sort() };
  assert.equal(cli([]).code, 0);
  assert.equal(sha(ws.db), before.hash);
  assert.deepEqual(fs.readdirSync(ws.home).sort(), before.files, 'no journal, wal or shm file left behind');
  const d = new Database(ws.db);
  assert.equal(d.pragma('journal_mode', { simple: true }), 'delete');
  d.close();
});

test('a WAL database is checked as it is and stays in WAL', () => {
  healthy();
  const w = new Database(ws.db);
  w.pragma('journal_mode = WAL');
  w.prepare('INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, ?, ?)').run(4, 'caterer', 0);
  const r = cli(['--json']);
  const o = JSON.parse(r.out);
  assert.equal(r.code, 0, r.err);
  assert.equal(o.journalMode, 'wal');
  assert.equal(o.candidates, 4, 'rows still in the WAL are counted');
  assert.equal(w.pragma('journal_mode', { simple: true }), 'wal');
  w.close();
});

test('a writer holding the database makes the check fail fast with reason locked, and it passes once the writer is done', () => {
  healthy();
  const w = new Database(ws.db);
  w.exec('BEGIN EXCLUSIVE');
  const t0 = Date.now();
  const r = cli(['--busy-timeout-ms', '300', '--json']);
  const took = Date.now() - t0;
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).reason, 'locked');
  assert.ok(took < 10000, `gave up after the busy timeout, not after ${took} ms`);
  w.exec('ROLLBACK');
  w.close();
  assert.equal(cli([]).code, 0);
});

test('a hot journal left by a killed writer is rolled back by the check instead of failing it', (t) => {
  ws.reset();
  createLegacyDb(ws.db, { rows: Array.from({ length: 600 }, (_, i) => ({ caterer_id: i + 1, unlocked: 1 })) });
  const before = sha(ws.db);
  const child = `
    const D = require(${JSON.stringify(path.resolve(__dirname, 'helpers', 'sqlite.js'))});
    const d = new D(${JSON.stringify(ws.db)});
    d.pragma('cache_size = 8');
    d.exec('BEGIN');
    d.exec("UPDATE candidates SET role = 'x' || hex(randomblob(200)), location = hex(randomblob(200))");
    process.kill(process.pid, 'SIGKILL');
  `;
  spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' });
  if (!fs.existsSync(`${ws.db}-journal`)) return t.skip('the killed writer left no hot journal on this platform');
  const r = cli(['--json']);
  const o = JSON.parse(r.out);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(o.candidates, 600);
  assert.equal(fs.existsSync(`${ws.db}-journal`), false, 'the journal was rolled back and removed');
  assert.equal(sha(ws.db), before, 'and the file is back to its committed content');
});

test('usage: unknown flags and bad numbers exit 2, --help exits 0 and lists every flag', () => {
  assert.equal(cli(['--nonsense']).code, 2);
  assert.equal(cli(['--busy-timeout-ms', '0']).code, 2);
  assert.equal(cli(['--busy-timeout-ms', 'x']).code, 2);
  assert.equal(cli(['--db']).code, 2);
  const h = cli(['--help']);
  assert.equal(h.code, 0);
  for (const flag of ['--db', '--allow-empty', '--json', '--quiet', '--busy-timeout-ms']) assert.ok(h.out.includes(flag), flag);
});

test('library use: checkDb and main are pure functions of their arguments', () => {
  healthy();
  const res = pf.checkDb({ db: ws.db });
  assert.equal(res.ok, true);
  assert.equal(res.candidates, 3);
  assert.equal(pf.checkDb({ db: path.join(ws.home, 'nope.db') }).reason, 'missing');
  const lines = { out: [], err: [] };
  const code = pf.main(['--db', path.join(ws.home, 'nope.db')], { out: s => lines.out.push(s), err: s => lines.err.push(s) });
  assert.equal(code, 1);
  assert.equal(lines.out.length, 0);
  assert.match(lines.err.join(''), /NOT FIT \(missing\)/);
});

test('the script only reads: no write statement, no journal mode change, no process.exit call', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /\b(INSERT|DELETE|ALTER|DROP|VACUUM|REINDEX)\s/);
  assert.doesNotMatch(src, /journal_mode\s*=/);
  assert.doesNotMatch(src, /process\.exit\(/);
  assert.match(src, /query_only = ON/);
  assert.match(src, /require\.main === module/);
});
