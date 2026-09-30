'use strict';
// candidates-db.js openDb() must not decide the journal mode: migrate-schema.js probes the volume and is
// the single decision point. A DB in rollback-journal mode stays there; a DB already in WAL stays in WAL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/home');

const LIB = path.join(H.RES, 'candidates-db.js');
const MIGRATE = path.join(H.SCRIPTS, 'migrate-schema.js');

function modeOf(file) {
  const d = new (H.loadSqlite())(file);
  try { return String(d.pragma('journal_mode', { simple: true })); } finally { d.close(); }
}

// Opens the DB through the library in a child process and reports mode and busy timeout.
function openViaLibrary(home) {
  const code = `
    const l = require(${JSON.stringify(LIB)});
    const db = l.getDb();
    l.checkCandidate(1);
    process.stdout.write(JSON.stringify({ mode: db.pragma('journal_mode', { simple: true }), busy: db.pragma('busy_timeout', { simple: true }) }));
    l.closeDb();
  `;
  const r = spawnSync(process.execPath, ['--require', H.NETGUARD, '-e', code], { env: H.childEnv(home), encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test.describe('candidates-db openDb journal mode', () => {
  test('a rollback-journal DB is not switched to WAL by opening it', () => {
    const home = H.makeHome('jrnl-del');
    const file = path.join(home, 'candidates.db');
    H.makeDb(home).close();
    assert.equal(modeOf(file), 'delete');
    const out = openViaLibrary(home);
    assert.equal(out.mode, 'delete');
    assert.equal(out.busy, 5000);
    assert.equal(modeOf(file), 'delete');
    assert.ok(!fs.existsSync(`${file}-wal`), 'no wal file appeared');
  });

  test('opening the DB twice still never switches it', () => {
    const home = H.makeHome('jrnl-twice');
    const file = path.join(home, 'candidates.db');
    H.makeDb(home).close();
    openViaLibrary(home);
    openViaLibrary(home);
    assert.equal(modeOf(file), 'delete');
  });

  test('a DB that is already in WAL stays in WAL and keeps busy_timeout 5000', () => {
    const home = H.makeHome('jrnl-wal');
    const file = path.join(home, 'candidates.db');
    const d = H.makeDb(home);
    d.pragma('journal_mode = WAL');
    d.close();
    assert.equal(modeOf(file), 'wal');
    const out = openViaLibrary(home);
    assert.equal(out.mode, 'wal');
    assert.equal(out.busy, 5000);
    assert.equal(modeOf(file), 'wal');
  });

  test('a brand new file created by the library starts in rollback-journal mode', () => {
    const home = H.makeHome('jrnl-new');
    const out = openViaLibrary(home);
    assert.equal(out.mode, 'delete');
    assert.equal(modeOf(path.join(home, 'candidates.db')), 'delete');
  });

  test('migrate-schema decides: keep and delete leave rollback mode, wal is only set by it', () => {
    const home = H.makeHome('jrnl-mig');
    const file = path.join(home, 'candidates.db');
    H.makeDb(home).close();
    const env = H.childEnv(home);
    let r = spawnSync(process.execPath, [MIGRATE, '--db', file, '--journal-mode', 'delete', '--no-backup'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(openViaLibrary(home).mode, 'delete');
    assert.equal(modeOf(file), 'delete');

    r = spawnSync(process.execPath, [MIGRATE, '--db', file, '--journal-mode', 'wal', '--no-backup'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const afterMigrate = modeOf(file);
    // WAL is refused on some volumes (9p, network shares); either way the library must report what the DB holds.
    assert.equal(openViaLibrary(home).mode, afterMigrate);
    assert.equal(modeOf(file), afterMigrate);
  });

  test('the source never issues an unconditional journal_mode = WAL', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const lines = src.split('\n').filter(l => /journal_mode\s*=\s*WAL/i.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /=== 'wal'/, 'the only WAL assertion is guarded by a mode check');
  });
});
