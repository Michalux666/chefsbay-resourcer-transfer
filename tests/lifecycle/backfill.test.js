'use strict';
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-bf');
require('./helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('./helpers/sqlite');
const { createLegacyDb } = require('./helpers/legacy-schema');
const { startFakeZoho } = require('./helpers/fake-zoho');
const { card, writeQueue, dbHelpers } = require('./helpers/fixtures');
const { captureConsole, seedDb, buildDeps } = require('./helpers/harness');
const bf = require('../../resourcer/scripts/backfill-run-results');
const pq = require('../../resourcer/scripts/process-approved-queue');

const SCRIPT = path.resolve(__dirname, '../../resourcer/scripts/backfill-run-results.js');
const db = dbHelpers(ws.db);

test.after(() => ws.cleanup());

function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: ws.home } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

function results(over) {
  return {
    date: '2026-09-29', requestedAt: '2026-09-29T08:59:00.000Z', phase1StartedAt: '2026-09-29T09:00:00.000Z',
    startedAt: '2026-09-29T09:05:00.000Z', completedAt: '2026-09-29T09:06:00.000Z', runtimeSecs: 60, totalRuntimeSecs: 420,
    jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month', keywords: '', cvLimit: 20, candidateCount: 40,
    creditsRemaining: '44463', screeningModel: 'm1', sources: 'both',
    phase1: { candidateCount: 40, pagesScraped: 3, approved: 5, skippedDb: 30, skippedReview: 5, errors: 0 },
    downloaded: 5, total: 5, new: 4, duplicates: 1, skipped: 0, errors: 0, downloadErrors: 0, pushErrors: 0,
    catererStats: { pool: 40, newToZoho: 4, downloaded: 5, duplicates: 1, errors: 0, phase1: { pagesScraped: 3, approved: 5, skippedDb: 30, skippedReview: 5 } },
    reedStats: { pool: 0, newToZoho: 0, downloaded: 0, duplicates: 0, errors: 0, authFailed: false, authFailureReason: null, phase1: {} },
    timing: {}, candidates: [{ id: '1', name: 'Test Person1', status: 'new', zohoId: '9', cvAttached: true }],
    ...(over || {}),
  };
}

function writeResults(name, obj, raw) {
  fs.mkdirSync(ws.downloads, { recursive: true });
  const file = path.join(ws.downloads, `phase2-results-${name}.json`);
  fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify(obj));
  return file;
}

function setup(withDb = true) {
  ws.reset();
  if (withDb) createLegacyDb(ws.db, { rows: [{ caterer_id: 1, unlocked: 1 }] });
}

function dirHash() {
  const h = crypto.createHash('sha256');
  for (const n of fs.readdirSync(ws.downloads).sort()) h.update(n).update(fs.readFileSync(path.join(ws.downloads, n)));
  return h.digest('hex');
}

test('maps a results file to a run_results row (values, types, no PII)', () => {
  const row = bf.buildRunResultRow(results(), 'merged-queue-2026-09-29T09-05-00', null);
  assert.equal(row.run_key, 'merged-queue-2026-09-29T09-05-00');
  assert.equal(row.date, '2026-09-29');
  assert.equal(row.pool, 40);
  assert.equal(row.downloaded, 5);
  assert.equal(row.new_to_zoho, 4);
  assert.equal(row.duplicates, 1);
  assert.equal(row.credits_remaining, 44463);
  assert.equal(row.approved_p1, 5);
  assert.equal(row.pages_scraped, 3);
  assert.equal(row.total_runtime_secs, 420);
  assert.equal(row.phase2_runtime_secs, 60);
  assert.equal(row.sources, 'both');
  assert.equal(JSON.parse(row.caterer_json).newToZoho, 4);
  assert.equal(JSON.parse(row.reed_json).authFailed, false);
  assert.doesNotMatch(JSON.stringify(row), /Test Person|zohoId|cvAttached/);
});

test('legacy dashboard defaults: downloaded falls back to total, counts to 0, sources to caterer, keywords blank to null', () => {
  const r = bf.buildRunResultRow({ date: '2026-08-01', total: 7, keywords: '   ', distance: '25' }, 'x', null);
  assert.equal(r.downloaded, 7);
  assert.equal(r.new_to_zoho, 0);
  assert.equal(r.duplicates, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.sources, 'caterer');
  assert.equal(r.keywords, null);
  assert.equal(r.distance, 25);
  assert.equal(r.credits_remaining, null);
  assert.equal(r.caterer_json, null);
  assert.equal(bf.buildRunResultRow({ new: 1 }, 'x', null), null, 'no date: skipped');
  assert.equal(bf.buildRunResultRow(null, 'x', null), null);
  assert.equal(bf.buildRunResultRow({ date: '2026-08-01' }, '', null), null);
  assert.equal(bf.intOrNull('44,463'), 44463);
  assert.equal(bf.intOrNull('abc'), null);
  assert.equal(bf.intOrNull(undefined), null);
});

test('backfill inserts one row per file; unparseable and date-less files are counted, BOM is stripped', () => {
  setup();
  writeResults('merged-queue-2026-09-27T10-00-00', results({ date: '2026-09-27', new: 3 }));
  writeResults('merged-queue-2026-09-28T10-00-00', results({ date: '2026-09-28', new: 5 }), '\uFEFF' + JSON.stringify(results({ date: '2026-09-28', new: 5 })));
  writeResults('merged-queue-2026-09-29T10-00-00', results({ new: 7 }));
  writeResults('broken', null, '{"date": "2026-09-29", ');
  writeResults('nodate', results({ date: undefined }));
  fs.writeFileSync(path.join(ws.downloads, 'phase2-results-notjson.txt'), 'x');
  const r = cli(['--json', '--days', '3']);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  assert.equal(j.files, 5);
  assert.equal(j.parsed, 3);
  assert.equal(j.unparseable, 1);
  assert.equal(j.noDate, 1);
  assert.equal(j.inserted, 3);
  assert.equal(db.runResults().length, 3);
  const byDay = Object.fromEntries(db.runResults().map(x => [x.date, x.new_to_zoho]));
  assert.deepEqual(byDay, { '2026-09-27': 3, '2026-09-28': 5, '2026-09-29': 7 });
});

test('idempotent and non-destructive: second run inserts nothing, existing rows are kept unless --replace', () => {
  setup();
  writeResults('merged-queue-a', results({ new: 2 }));
  const first = cli(['--json']).json();
  assert.equal(first.inserted, 1);
  const d = db.open();
  d.prepare("UPDATE run_results SET new_to_zoho = 99 WHERE run_key = 'merged-queue-a'").run();
  d.close();
  const second = cli(['--json']).json();
  assert.equal(second.inserted, 0);
  assert.equal(second.ignored, 1);
  assert.equal(db.runResults()[0].new_to_zoho, 99, 'existing row untouched');
  const third = cli(['--json', '--replace']).json();
  assert.equal(third.replaced, 1);
  assert.equal(db.runResults()[0].new_to_zoho, 2);
  assert.equal(db.runResults().length, 1);
});

test('prints per-day sums from both sources and a PARITY verdict; --strict turns a mismatch into exit 3', () => {
  setup();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  writeResults('merged-queue-t1', results({ date: today, new: 6 }));
  writeResults('merged-queue-t2', results({ date: today, new: 4 }));
  writeResults('merged-queue-y1', results({ date: yesterday, new: 3 }));
  const ok = cli(['--days', '3']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, new RegExp(`${today} +10 +10`));
  assert.match(ok.out, new RegExp(`${yesterday} +3 +3`));
  assert.match(ok.out, /PARITY OK/);
  // a run_results row without a file (e.g. results already swept) shows up as a mismatch
  const d = db.open();
  d.prepare("INSERT INTO run_results (run_key, date, new_to_zoho) VALUES ('ghost', ?, 50)").run(today);
  d.close();
  const bad = cli(['--days', '3']);
  assert.equal(bad.code, 0);
  assert.match(bad.out, /MISMATCH/);
  assert.equal(cli(['--days', '3', '--strict']).code, 3);
});

test('queue files fill fields a results file lacks (only when missing), --no-queues disables it', () => {
  setup();
  writeResults('merged-queue-q1', { date: '2026-09-29', new: 2, total: 2 });
  writeQueue(ws, 'merged-queue-q1.json', { sources: 'both', candidateCount: 55, screeningModel: 'qm', phase1Stats: { caterer: { pagesScraped: 4, approved: 6, skippedDb: 20, skippedReview: 3 }, reed: {} } });
  const r = cli(['--json']).json();
  assert.equal(r.fromQueue, 1);
  let row = db.runResults()[0];
  assert.equal(row.pages_scraped, 4);
  assert.equal(row.approved_p1, 6);
  assert.equal(row.pool, 55);
  assert.equal(row.sources, 'both');
  assert.equal(row.screening_model, 'qm');
  assert.equal(row.new_to_zoho, 2, 'outcome counts always come from the results file');
  setup();
  writeResults('merged-queue-q1', { date: '2026-09-29', new: 2, total: 2 });
  writeQueue(ws, 'merged-queue-q1.json', { sources: 'both', candidateCount: 55, phase1Stats: { caterer: { pagesScraped: 4 } } });
  cli(['--json', '--no-queues']);
  row = db.runResults()[0];
  assert.equal(row.pages_scraped, null);
  assert.equal(row.sources, 'caterer');
});

test('never touches downloads/: identical bytes after, no unlink/DELETE/DROP in the source', () => {
  setup();
  for (let i = 0; i < 20; i++) writeResults(`merged-queue-n${i}`, results({ date: `2026-09-${String(10 + (i % 10))}`, new: i }));
  fs.writeFileSync(path.join(ws.downloads, 'cv-1.pdf'), 'cv');
  fs.writeFileSync(path.join(ws.downloads, 'candidate-1.json'), '{}');
  const before = dirHash();
  cli(['--json']);
  cli(['--json', '--replace']);
  cli(['--dry-run', '--json']);
  assert.equal(dirHash(), before);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /unlink|rmSync|rmdir|writeFileSync|renameSync|DELETE\s+FROM|DROP\s+(TABLE|INDEX)/i);
});

test('--dry-run parses and prints but writes nothing, not even the table', () => {
  setup();
  writeResults('merged-queue-d1', results());
  const j = cli(['--dry-run', '--json']).json();
  assert.equal(j.dryRun, true);
  assert.equal(j.parsed, 1);
  const chk = new Database(ws.db, { readonly: true });
  assert.equal(chk.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='run_results'").get().n, 0);
  chk.close();
});

test('errors: missing directory or database exit 1; usage errors exit 2', () => {
  setup();
  assert.equal(cli(['--dir', path.join(ws.home, 'nope')]).code, 1);
  writeResults('merged-queue-e1', results());
  assert.equal(cli(['--db', path.join(ws.home, 'missing.db')]).code, 1);
  assert.equal(cli(['--days', '0']).code, 2);
  assert.equal(cli(['--bogus']).code, 2);
  assert.equal(cli(['--db']).code, 2, 'a flag without its value must not silently fall back to the default database');
  assert.equal(cli(['--dir', '--dry-run']).code, 2);
  assert.equal(cli(['--help']).code, 0);
});

test('a fresh install has no downloads/ directory: the default directory being absent is zero files and exit 0; an explicit missing --dir stays an error', () => {
  setup();
  fs.rmSync(ws.downloads, { recursive: true, force: true });
  const r = cli(['--strict', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().files, 0);
  assert.equal(cli(['--dir', path.join(ws.home, 'nope')]).code, 1);
});

test('performance: 2500 results files backfill in a few seconds', () => {
  setup();
  const t0 = Date.now();
  for (let i = 0; i < 2500; i++) writeResults(`merged-queue-p${i}`, results({ date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, new: i % 9 }));
  const r = cli(['--json', '--days', '14']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().inserted, 2500);
  assert.ok(Date.now() - t0 < 30000);
});

test('parity: the row the live writer produces equals the row a backfill of the same results file produces', async () => {
  const zoho = await startFakeZoho();
  try {
    ws.reset();
    seedDb(ws, ['4001', '4002', '4003']);
    zoho.scenario('4002', { create: 'duplicate' });
    zoho.scenario('4003', { create: 'http500' });
    const qf = writeQueue(ws, 'merged-queue-2026-09-29T10-00-00.json', {
      sources: 'both', candidates: [card('4001'), card('4002'), card('4003')],
      phase1Stats: { caterer: { pagesScraped: 2, approved: 3, skippedDb: 9, skippedReview: 4, totalCandidatesSeen: 16 }, reed: { pool: 12, pagesScraped: 1, approved: 0, rejected: 5 } },
    });
    const built = buildDeps(ws, { zoho });
    const cap = captureConsole();
    let res;
    try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
    assert.equal(res.code, 0);
    const live = db.runResults()[0];
    assert.equal(live.new_to_zoho, 1);
    assert.equal(live.duplicates, 1);
    assert.equal(live.errors, 1);
    const d = db.open();
    d.prepare('DELETE FROM run_results').run();
    d.close();
    const j = cli(['--json']).json();
    assert.equal(j.inserted, 1);
    assert.equal(j.parity.ok, true);
    const back = db.runResults()[0];
    const strip = r => { const { created_at, ...rest } = r; return rest; };
    assert.deepEqual(strip(back), strip(live));
  } finally { await zoho.close(); }
});
