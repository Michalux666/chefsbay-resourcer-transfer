'use strict';
// Phase 1 against the REAL candidates-db.js CLI on a temp SQLite file: job-title-scoped dedupe and rejection bookkeeping.
// Needs better-sqlite3: resolved from the repo, or from P1_BETTER_SQLITE3_DIR (a node_modules directory). Skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;

function findSqliteDir() {
  const dirs = [];
  if (process.env.P1_BETTER_SQLITE3_DIR) dirs.push(process.env.P1_BETTER_SQLITE3_DIR);
  try {
    const p = require.resolve('better-sqlite3', { paths: [path.join(h.REPO, 'resourcer'), h.REPO] });
    dirs.push(path.resolve(path.dirname(p), '..', '..'));
  } catch (e) { /* not installed in the repo */ }
  for (const d of dirs) {
    try {
      const D = require(path.join(d, 'better-sqlite3'));
      new D(':memory:').close();
      return d;
    } catch (e) { /* try the next */ }
  }
  return null;
}

const SQLITE_DIR = findSqliteDir();
const skip = SQLITE_DIR ? false : 'better-sqlite3 is not available (set P1_BETTER_SQLITE3_DIR to a node_modules directory)';

function withDb(home, fn) {
  const D = require(path.join(SQLITE_DIR, 'better-sqlite3'));
  const db = new D(path.join(home, 'candidates.db'), { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

function realDbHome(t, scenario) {
  const home = h.makeHome(scenario, { real: ['run-lock'] });
  t.after(() => h.cleanup(home));
  fs.copyFileSync(path.join(h.SRC, 'candidates-db.js'), path.join(home, 'candidates-db.js'));
  return home;
}

const env = () => ({ NODE_PATH: SQLITE_DIR });

async function cli(home, args) {
  const { spawnSync } = require('child_process');
  return spawnSync(process.execPath, [path.join(home, 'candidates-db.js')].concat(args), { env: Object.assign({}, process.env, env(), { RESOURCER_HOME: home }), encoding: 'utf8', cwd: home });
}

test('real candidates-db: rejections are scoped to the job title, unlocked candidates are always skipped', { skip }, async (t) => {
  const sc = {
    pages: {
      1: { cards: [card(101), card(102, { unlockedPrev: true, neverUnlocked: false }), card(103), card(104)] },
      2: { cards: [] },
    },
    ai: { batch: [{ outcome: 'ok', overrides: { 102: { approved: false, reason: 'Too senior' }, 103: { approved: false, reason: 'Unrelated' } } }] },
  };
  const home = realDbHome(t, sc);
  // 104 is already held (unlocked) from an earlier run
  assert.strictEqual((await cli(home, ['add', '104'])).status, 0);

  const r = await h.runPhase1(home, h.baseArgs(), { env: env() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('    SKIP (in DB)'));
  assert.ok(r.stdout.includes('DB skips: 1'));

  withDb(home, (db) => {
    const row = (id) => db.prepare('SELECT unlocked, zoho_id FROM candidates WHERE caterer_id = ?').get(id);
    assert.strictEqual(row(101).unlocked, 1, 'approved and unlocked (neverUnlocked add after the single review)');
    assert.strictEqual(row(102).unlocked, 1, 'rejected but previously unlocked: recorded with add');
    assert.strictEqual(row(103).unlocked, 0, 'rejected, never unlocked: recorded with seen');
    assert.strictEqual(row(104).unlocked, 1);
    const rej = db.prepare('SELECT caterer_id, job_title, origin FROM candidate_rejections ORDER BY caterer_id').all();
    assert.deepStrictEqual(rej.map((x) => [x.caterer_id, x.job_title, x.origin]), [[102, 'Chef', 'pipeline'], [103, 'Chef', 'pipeline']]);
  });

  // Same search title again: the rejected candidates are now skipped; a different title reconsiders them.
  const again = await cli(home, ['check-batch-scoped', '101,102,103,104', 'Chef']);
  assert.deepStrictEqual(JSON.parse(again.stdout.trim()).inDb.sort(), [101, 102, 103, 104]);
  const other = await cli(home, ['check-batch-scoped', '101,102,103,104', 'Kitchen Porter']);
  assert.deepStrictEqual(JSON.parse(other.stdout.trim()).inDb.sort(), [101, 102, 104], 'only the unlocked ones stay skipped for another title; 103 is eligible again');
});

test('real candidates-db: the Zoho pre-check drops candidates whose zoho_id is set', { skip }, async (t) => {
  const home = realDbHome(t, { pages: { 1: { cards: [card(201), card(202)] }, 2: { cards: [] } } });
  assert.strictEqual((await cli(home, ['add', '201'])).status, 0);
  assert.strictEqual((await cli(home, ['set-zoho-id', '201', 'ZOHO-XYZ'])).status, 0);
  // 201 is unlocked in the DB so page 1 skips it; force it into the recovered checkpoint to reach the pre-check
  const ts = '2026-09-29-111100';
  const rec = { id: '201', name: 'Rec', firstName: 'Rec', lastName: 'One', email: 'r@example.invalid', phone: '', currentTitle: 'Chef', currentEmployer: '', city: 'Leeds', postcode: 'LS1 1AA', state: '', experience: 1, encId: 'e', auditId: 'a', cvUrl: '/cv' };
  fs.writeFileSync(path.join(home, 'downloads', `approved-queue-${ts}.json`), JSON.stringify({ searchDate: null, jobTitle: 'Chef', location: 'LS29', source: 'caterer', candidates: [rec] }));
  const r = await h.runPhase1(home, h.baseArgs(), { env: Object.assign({ PHASE1_RUN_TIMESTAMP: ts }, env()) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('[201] Already in Zoho (ZOHO-XYZ) - skip'));
  const q = h.readJson(path.join(home, 'downloads', `approved-queue-${ts}.json`));
  assert.deepStrictEqual(q.candidates.map((c) => c.id), ['202']);
});

test('real candidates-db: a corrupt database stops the run before any screening or unlock (exit 2 is never read as "new")', { skip }, async (t) => {
  const home = realDbHome(t, { pages: { 1: { cards: [card(301), card(302)] }, 2: { cards: [] } } });
  fs.writeFileSync(path.join(home, 'candidates.db'), Buffer.alloc(4096, 'this is not a sqlite database '));
  const r = await h.runPhase1(home, h.baseArgs(), { env: env() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('WARN check-batch exit'), 'the batched check fails first');
  assert.ok(r.stdout.includes('FATAL candidates.db check failed (exit 2)'), r.stdout);
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review').length, 0, 'nothing was screened');
  assert.strictEqual(r.calls.filter((c) => c.tool === 'caterer-unlock').length, 0, 'no credit was spent');
  assert.strictEqual(r.calls.filter((c) => c.tool === 'process-approved-queue').length, 0, 'the territory is kept');
  const status = h.statusOf(home);
  assert.strictEqual(status.incomplete, 'db-unavailable');
  assert.strictEqual(status.errors, 1);
});

test('real candidates-db: a genuinely new card (check exit 1 with the NEW line) is still screened when the batched query fails', { skip }, async (t) => {
  const home = realDbHome(t, { pages: { 1: { cards: [card(311)] }, 2: { cards: [] } } });
  const cliSrc = fs.readFileSync(path.join(home, 'candidates-db.js'), 'utf8');
  fs.writeFileSync(path.join(home, 'candidates-db.js'), cliSrc.replace("case 'check-batch-scoped': {", "case 'check-batch-scoped': { console.error('forced batch failure'); process.exit(1);"));
  const r = await h.runPhase1(home, h.baseArgs(), { env: env() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('WARN check-batch exit 1 - using per-card check'));
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 1);
  assert.ok(!h.statusOf(home).incomplete);
});
