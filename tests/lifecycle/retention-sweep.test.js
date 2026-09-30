'use strict';
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-sw');
require('./helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Database = require('./helpers/sqlite');
const { createLegacyDb } = require('./helpers/legacy-schema');
const { startFakeZoho } = require('./helpers/fake-zoho');
const { card, writeQueue, dbHelpers } = require('./helpers/fixtures');
const { captureConsole, seedDb, buildDeps } = require('./helpers/harness');
const sweepLib = require('../../resourcer/scripts/retention-sweep');
const pq = require('../../resourcer/scripts/process-approved-queue');
const R = require('../../resourcer/scripts/lib/cv-retention');

const SCRIPT = path.resolve(__dirname, '../../resourcer/scripts/retention-sweep.js');
const DAY = 86400000;
const NOW = Date.parse('2026-09-29T12:00:00Z');
const db = dbHelpers(ws.db);

test.after(() => ws.cleanup());

function put(dir, name, ageDays, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content === undefined ? `data-${name}` : content);
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return file;
}
const dl = (name, age, content) => put(ws.downloads, name, age, content);
const rn = (name, age, content) => put(ws.runs, name, age, content);
const lg = (name, age, content) => put(ws.logs, name, age, content);
const iso = ageDays => new Date(NOW - ageDays * DAY).toISOString();
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

function base(rows) {
  ws.reset();
  createLegacyDb(ws.db, { rows: rows || [{ caterer_id: 1, unlocked: 1, zoho_id: 'z-1' }, { caterer_id: 2, unlocked: 1 }, { reed_id: 3, source: 'reed', unlocked: 1, zoho_id: 'z-3' }] });
  const d = db.open();
  require('../../resourcer/scripts/migrate-schema').ensureRunResults(d);
  d.close();
}

function addRunResult(key, date, n) {
  const d = db.open();
  d.prepare('INSERT OR IGNORE INTO run_results (run_key, date, new_to_zoho) VALUES (?, ?, ?)').run(key, date || '2026-09-20', n || 1);
  d.close();
}

function results(extra) {
  return JSON.stringify({ date: '2026-09-20', completedAt: iso(4), jobTitle: 'Chef', location: 'LS1', new: 2, downloaded: 2, candidates: [{ id: '1', name: 'Test Person1' }], ...(extra || {}) });
}

// -------------------------------------------------------------------------------------------------

test('refuses to touch downloads/ until run_results is populated (missing table, empty table, missing DB); runs and logs still swept', async () => {
  for (const variant of ['no-table', 'empty', 'no-db']) {
    ws.reset();
    if (variant === 'no-table') createLegacyDb(ws.db, {});
    if (variant === 'empty') { base(); }
    dl('review-tmp-1.json', 0);
    dl('cv-9.pdf', 30);
    dl('phase2-results-merged-queue-a.json', 10, results());
    dl('merged-queue-a.json', 10, '{}');
    rn('phase1-2026-09-01-100000.json', 20, '{}');
    lg('old.log.gz', 200);
    const s = await sweepLib.sweep({ now: NOW });
    assert.equal(s.ok, true, variant);
    assert.equal(s.refused.length, 1, variant);
    assert.match(s.refused[0], /downloads:/);
    assert.equal(exists(ws.downloads, 'review-tmp-1.json'), true, `${variant}: even review-tmp stays`);
    assert.equal(exists(ws.downloads, 'cv-9.pdf'), true);
    assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-a.json'), true);
    assert.equal(exists(ws.runs, 'phase1-2026-09-01-100000.json'), false, 'runs/ pruning is independent');
    assert.equal(exists(ws.logs, 'old.log.gz'), false, 'logs/ pruning is independent');
    assert.ok(ws.alerts().some(a => a.key === 'retention-refused' && a.severity === 'warn'), variant);
  }
});

function buildTree() {
  base();
  addRunResult('merged-queue-A');
  addRunResult('merged-queue-B');
  // A: complete 4 days ago -> queue then results deleted; B: complete 1 day ago -> kept
  dl('merged-queue-A.json', 4, JSON.stringify({ candidates: [] }));
  dl('phase2-results-merged-queue-A.json', 4, results({ completedAt: iso(4) }));
  dl('merged-queue-B.json', 1, '{}');
  dl('phase2-results-merged-queue-B.json', 1, results({ completedAt: iso(1) }));
  // C: results without queue, 5 days -> deleted (row inserted by the sweep)
  dl('phase2-results-merged-queue-C.json', 5, results({ completedAt: iso(5), date: '2026-09-24' }));
  // D: caterer-only queue whose phase1 status is complete 5 days ago
  dl('approved-queue-2026-09-24-100000.json', 6, JSON.stringify({ candidates: [] }));
  rn('phase1-2026-09-24-100000.json', 6, JSON.stringify({ status: 'complete', phase2Complete: true, completedAt: iso(5) }));
  // E: stranded queue, 20 days, status never completed -> orphan + anomaly; F: 10 days, status missing -> kept
  dl('approved-queue-2026-09-09-100000.json', 20, JSON.stringify({ candidates: [{ id: '5' }, { id: '6' }] }));
  rn('phase1-2026-09-09-100000.json', 20, JSON.stringify({ status: 'phase1_complete', phase2Status: 'pending' }));
  dl('approved-queue-2026-09-19-100000.json', 10, JSON.stringify({ candidates: [{ id: '7' }] }));
  // orphans
  dl('cv-1.pdf', 15); dl('candidate-1.json', 15);            // pushed (zoho id in DB)
  dl('cv-2.pdf', 15); dl('candidate-2.json', 20);            // never pushed
  dl('cv-reed-3.docx', 16);                                  // reed, pushed
  dl('cv-4.pdf', 13); dl('candidate-4.json', 2);             // young: kept
  // always / misc
  dl('review-tmp-2026-09-29.json', 0); dl('review-tmp-2026-09-29.json.stdout', 0);
  dl('reed-empty-2026-09-20T10-00-00.json', 5); dl('reed-empty-2026-09-28T10-00-00.json', 1);
  dl('cv-3.pdf.111.222.tmp', 3);
  dl('screenshot-1.png', 90);
  // runs
  rn('phase1-2026-09-20-100000.json', 9); rn('phase1-2026-09-20-100000.json.run-lock', 9); rn('params-watchdog-2026-09-20.json', 8); rn('run-merged-queue-2026-09-20T10-00-00.json', 8.5);
  rn('phase1-2026-09-25-100000.json', 4); rn('pipeline-wake.flag', 30); rn('mystery.dat', 30);
  // logs
  lg('phase1-console-old.log', 15, 'x'.repeat(5000)); lg('phase1-console-new.log', 13, 'y'.repeat(100));
  lg('errors.jsonl', 1, '{"a":1}\n'); lg('errors-acknowledged.json', 100, '{}'); lg('pipeline-performance.jsonl', 100, '{}\n');
  lg('ancient.log.gz', 100); lg('recent.log.gz', 89);
}

const EXPECT_GONE_DL = [
  'merged-queue-A.json', 'phase2-results-merged-queue-A.json', 'phase2-results-merged-queue-C.json',
  'approved-queue-2026-09-24-100000.json', 'approved-queue-2026-09-09-100000.json',
  'cv-1.pdf', 'candidate-1.json', 'cv-2.pdf', 'candidate-2.json', 'cv-reed-3.docx',
  'review-tmp-2026-09-29.json', 'review-tmp-2026-09-29.json.stdout', 'reed-empty-2026-09-20T10-00-00.json', 'cv-3.pdf.111.222.tmp',
];
const EXPECT_KEPT_DL = [
  'merged-queue-B.json', 'phase2-results-merged-queue-B.json', 'approved-queue-2026-09-19-100000.json',
  'cv-4.pdf', 'candidate-4.json', 'reed-empty-2026-09-28T10-00-00.json', 'screenshot-1.png',
];

test('a real sweep deletes exactly what the policy says and keeps everything else', async () => {
  buildTree();
  const s = await sweepLib.sweep({ now: NOW, list: true });
  assert.deepEqual(s.downloads.files.map(f => f.name).sort(), [...EXPECT_GONE_DL].sort());
  assert.equal(s.ok, true);
  assert.deepEqual(s.refused, []);
  for (const n of EXPECT_GONE_DL) assert.equal(exists(ws.downloads, n), false, `${n} should be deleted`);
  for (const n of EXPECT_KEPT_DL) assert.equal(exists(ws.downloads, n), true, `${n} should be kept`);
  // runs
  for (const n of ['phase1-2026-09-20-100000.json', 'phase1-2026-09-20-100000.json.run-lock', 'params-watchdog-2026-09-20.json', 'run-merged-queue-2026-09-20T10-00-00.json']) assert.equal(exists(ws.runs, n), false, n);
  for (const n of ['phase1-2026-09-25-100000.json', 'pipeline-wake.flag', 'mystery.dat']) assert.equal(exists(ws.runs, n), true, n);
  // logs
  assert.equal(exists(ws.logs, 'phase1-console-old.log'), false);
  assert.equal(exists(ws.logs, 'phase1-console-old.log.gz'), true);
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(ws.logs, 'phase1-console-old.log.gz'))).toString(), 'x'.repeat(5000));
  assert.equal(exists(ws.logs, 'phase1-console-new.log'), true);
  for (const n of ['errors.jsonl', 'errors-acknowledged.json', 'pipeline-performance.jsonl', 'recent.log.gz']) assert.equal(exists(ws.logs, n), true, n);
  assert.equal(exists(ws.logs, 'ancient.log.gz'), false);
  // summary
  assert.equal(s.downloads.deleted.queue, 4);           // A queue, D queue, E queue, reed-empty
  assert.equal(s.downloads.deleted.results, 2);         // A, C
  assert.equal(s.downloads.deleted.cv, 3);
  assert.equal(s.downloads.deleted.candidate, 2);
  assert.equal(s.downloads.deleted['review-tmp'], 2);
  assert.equal(s.downloads.deleted.tmp, 1);
  assert.equal(s.downloads.unpushedOrphans, 2, 'cv-2.pdf and candidate-2.json had no zoho id');
  assert.equal(s.downloads.runResultsRepaired, 1, 'C had no run_results row and was repaired before its file went');
  assert.equal(s.runs.deleted, 5, 'four aged run artefacts plus the stranded queue status file');
  assert.equal(exists(ws.runs, 'phase1-2026-09-09-100000.json'), false);
  assert.equal(exists(ws.runs, 'phase1-2026-09-24-100000.json'), true, 'six days old: kept');
  assert.equal(s.logs.compressed, 1);
  assert.equal(s.logs.deleted, 1);
  assert.equal(s.downloads.failures.length + s.runs.failures.length + s.logs.failures.length, 0);
  assert.ok(s.downloads.bytesFreed > 0);
  // run_results repaired for C, nothing lost
  assert.deepEqual(db.runResults().map(r => r.run_key).sort(), ['merged-queue-A', 'merged-queue-B', 'merged-queue-C']);
  assert.equal(db.runResults().find(r => r.run_key === 'merged-queue-C').date, '2026-09-24');
  // anomalies + alerts
  const codes = s.anomalies.map(a => a.code).sort();
  assert.deepEqual(codes, ['stranded-queue-deleted', 'unpushed-orphans-deleted']);
  const keys = ws.alerts().map(a => a.key);
  assert.ok(keys.includes('retention-unpushed-deleted'));
  assert.ok(keys.includes('retention-stranded-queue-deleted'));
  // ids only in the unpushed ledger
  const ledger = fs.readFileSync(path.join(ws.logs, 'retention-unpushed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(ledger.map(l => `${l.kind}:${l.id}`).sort(), ['candidate:2', 'cv:2']);
  assert.doesNotMatch(JSON.stringify(ledger), /Person|@/);
  // lock released
  assert.equal(exists(ws.logs, '.retention-sweep.lock'), false);
});

test('dry run reports the same counts as the real run and changes nothing (files, DB, alerts, lock)', async () => {
  buildTree();
  const snap = () => ({
    dl: fs.readdirSync(ws.downloads).sort(), runs: fs.readdirSync(ws.runs).sort(), logs: fs.readdirSync(ws.logs).sort(),
    rows: db.runResults().length, alerts: ws.alerts().length,
  });
  const before = snap();
  const dry = await sweepLib.sweep({ now: NOW, dryRun: true });
  assert.deepEqual(snap(), before);
  assert.equal(dry.dryRun, true);
  assert.equal(exists(ws.logs, '.retention-sweep.lock'), false);
  const real = await sweepLib.sweep({ now: NOW });
  assert.deepEqual(dry.downloads.deleted, real.downloads.deleted);
  assert.equal(dry.downloads.unpushedOrphans, real.downloads.unpushedOrphans);
  assert.equal(dry.downloads.runResultsRepaired, real.downloads.runResultsRepaired);
  assert.equal(dry.runs.deleted, real.runs.deleted);
  assert.equal(dry.logs.compressed, real.logs.compressed);
  assert.equal(dry.logs.deleted, real.logs.deleted);
  assert.notDeepEqual(snap(), before);
});

test('queue is deleted before results, and results are kept when the queue cannot be deleted', async () => {
  base();
  addRunResult('merged-queue-A');
  dl('merged-queue-A.json', 4, '{}');
  dl('phase2-results-merged-queue-A.json', 4, results({ completedAt: iso(4) }));
  const order = [];
  const failQueue = (dir, name) => {
    order.push(name);
    if (name === 'merged-queue-A.json') return { ok: false, reason: 'unlink-failed:EBUSY' };
    return R.jailedUnlink([ws.downloads, ws.runs, ws.logs], dir, name);
  };
  const s1 = await sweepLib.sweep({ now: NOW, unlink: failQueue });
  assert.deepEqual(order, ['merged-queue-A.json'], 'results deletion is not even attempted after a queue failure');
  assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-A.json'), true, 'the reprocess guard file survives');
  assert.equal(exists(ws.downloads, 'merged-queue-A.json'), true);
  assert.equal(s1.downloads.failures.length, 1);
  assert.ok(ws.alerts().some(a => a.key === 'retention-delete-errors'));
  // the guard still works while both exist
  const cap = captureConsole();
  let res;
  try { res = await pq.run(path.join(ws.downloads, 'merged-queue-A.json'), buildDeps(ws, {}).deps); } finally { cap.restore(); }
  assert.equal(res.reason, 'already-processed');
  // next sweep with a healthy filesystem
  order.length = 0;
  const ok = (dir, name) => { order.push(name); return R.jailedUnlink([ws.downloads, ws.runs, ws.logs], dir, name); };
  await sweepLib.sweep({ now: NOW, unlink: ok });
  assert.deepEqual(order, ['merged-queue-A.json', 'phase2-results-merged-queue-A.json']);
});

test('a crash between the queue delete and the results delete leaves results that the next sweep removes', async () => {
  base();
  addRunResult('merged-queue-A');
  dl('phase2-results-merged-queue-A.json', 4, results({ completedAt: iso(4) }));
  const s = await sweepLib.sweep({ now: NOW });
  assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-A.json'), false);
  assert.equal(s.downloads.deleted.results, 1);
});

test('undated results cannot be recorded: kept until they are orphan-old, then removed with their queue', async () => {
  base();
  addRunResult('merged-queue-Z');
  dl('merged-queue-A.json', 6, '{}');
  dl('phase2-results-merged-queue-A.json', 6, JSON.stringify({ completedAt: iso(6), new: 3 }));
  let s = await sweepLib.sweep({ now: NOW });
  assert.equal(exists(ws.downloads, 'merged-queue-A.json'), true);
  assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-A.json'), true);
  assert.deepEqual(s.anomalies, []);
  s = await sweepLib.sweep({ now: NOW + 9 * DAY });
  assert.equal(exists(ws.downloads, 'merged-queue-A.json'), false);
  assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-A.json'), false);
  assert.deepEqual(s.anomalies.map(a => a.code), ['undated-results-deleted']);
});

test('a dated results file whose run_results row cannot be written keeps queue and results, and raises an alert', async () => {
  base();
  addRunResult('merged-queue-Z');
  dl('merged-queue-A.json', 4, '{}');
  dl('phase2-results-merged-queue-A.json', 4, results({ completedAt: iso(4) }));
  const d = db.open();
  d.exec("CREATE TRIGGER block_insert BEFORE INSERT ON run_results BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  d.close();
  const s = await sweepLib.sweep({ now: NOW });
  assert.equal(exists(ws.downloads, 'merged-queue-A.json'), true);
  assert.equal(exists(ws.downloads, 'phase2-results-merged-queue-A.json'), true);
  assert.deepEqual(s.anomalies.map(a => a.code), ['run-results-missing-kept']);
  assert.ok(ws.alerts().some(a => a.key === 'retention-run-results-missing'));
  assert.equal(s.downloads.failures.length, 1);
});

test('boundaries: 2.9 days keeps, 3.1 days deletes; 13.9 days keeps orphans, 14.1 deletes', async () => {
  base();
  addRunResult('merged-queue-Y'); addRunResult('merged-queue-X');
  dl('merged-queue-Y.json', 2.9, '{}'); dl('phase2-results-merged-queue-Y.json', 2.9, results({ completedAt: iso(2.9) }));
  dl('merged-queue-X.json', 3.1, '{}'); dl('phase2-results-merged-queue-X.json', 3.1, results({ completedAt: iso(3.1) }));
  dl('cv-70.pdf', 13.9); dl('cv-71.pdf', 14.1);
  await sweepLib.sweep({ now: NOW });
  assert.equal(exists(ws.downloads, 'merged-queue-Y.json'), true);
  assert.equal(exists(ws.downloads, 'merged-queue-X.json'), false);
  assert.equal(exists(ws.downloads, 'cv-70.pdf'), true);
  assert.equal(exists(ws.downloads, 'cv-71.pdf'), false);
});

test('runs/: 6.9 days kept, 7.1 days deleted; only whitelisted patterns are ever removed', async () => {
  base();
  rn('phase1-a.json', 6.9); rn('phase1-b.json', 7.1); rn('params-x.json', 7.1); rn('run-x.json', 7.1);
  rn('watchdog.lock', 100); rn('heartbeat.json', 100); rn('pipeline-wake.flag', 100); rn('cv-1.pdf', 100);
  rn('x.tmp', 2);
  const s = await sweepLib.sweep({ now: NOW });
  assert.deepEqual(fs.readdirSync(ws.runs).sort(), ['cv-1.pdf', 'heartbeat.json', 'phase1-a.json', 'pipeline-wake.flag', 'watchdog.lock']);
  assert.equal(s.runs.unknown, 4);
});

test('logs/: gzip keeps content and mtime, refuses to overwrite an existing .gz, rotates only quiet oversize files, protects live names', async () => {
  base();
  const body = 'line\n'.repeat(400);
  lg('a.log', 20, body);
  lg('b.log', 20, body); lg('b.log.gz', 20, 'existing');
  lg('big.jsonl', 1, 'j\n'.repeat(3000));                 // > 1 KB threshold below, but older than 10 minutes
  const fresh = lg('fresh-big.log', 0, 'k'.repeat(5000));
  fs.utimesSync(fresh, new Date(NOW - 60000), new Date(NOW - 60000));
  lg('errors-acknowledged.json', 400, '{}');
  const s = await sweepLib.sweep({ now: NOW, config: { jsonlRotateMB: 1 / 1024 } });
  assert.equal(exists(ws.logs, 'a.log'), false);
  const gz = path.join(ws.logs, 'a.log.gz');
  assert.equal(zlib.gunzipSync(fs.readFileSync(gz)).toString(), body);
  assert.ok(Math.abs(fs.statSync(gz).mtimeMs - (NOW - 20 * DAY)) < 2000, 'mtime preserved for the 90 day clock');
  assert.equal(exists(ws.logs, 'b.log'), true, 'original kept when the gz already exists');
  assert.equal(fs.readFileSync(path.join(ws.logs, 'b.log.gz'), 'utf8'), 'existing');
  assert.ok(s.logs.failures.some(f => f.name === 'b.log' && f.reason === 'gz-exists'));
  assert.equal(exists(ws.logs, 'big.jsonl'), false, 'oversize quiet jsonl rotated');
  const rotated = fs.readdirSync(ws.logs).filter(n => /^big\.jsonl\..+\.gz$/.test(n));
  assert.equal(rotated.length, 1);
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(ws.logs, rotated[0]))).toString(), 'j\n'.repeat(3000));
  assert.equal(exists(ws.logs, 'fresh-big.log'), true, 'file written in the last 10 minutes is never rotated');
  assert.equal(exists(ws.logs, 'errors-acknowledged.json'), true);
  assert.equal(s.logs.rotated, 1);
});

test('logs/: .gz older than 90 days and stale tmp files are removed, 89 days kept', async () => {
  base();
  lg('old.gz', 91); lg('young.gz', 89); lg('x.gz.tmp', 2);
  await sweepLib.sweep({ now: NOW });
  assert.deepEqual(fs.readdirSync(ws.logs).sort(), ['young.gz']);
});

test('disk guard: critical alert above the threshold, none at or below it, statfs failure is reported not fatal', async () => {
  base();
  const stat = pct => () => ({ bsize: 4096, blocks: 1000000, bfree: Math.round(1000000 * (100 - pct) / 100), bavail: Math.round(1000000 * (100 - pct) / 100) });
  let s = await sweepLib.sweep({ now: NOW, statfs: stat(50) });
  assert.equal(s.disk.alert, false);
  assert.equal(ws.alerts().filter(a => a.key === 'disk-usage').length, 0);
  s = await sweepLib.sweep({ now: NOW, statfs: stat(85) });
  assert.equal(s.disk.alert, false, 'exactly at the threshold is not above it');
  s = await sweepLib.sweep({ now: NOW, statfs: stat(85.2) });
  assert.equal(s.disk.alert, true);
  assert.ok(s.disk.usedPct > 85);
  const a = ws.alerts().find(x => x.key === 'disk-usage');
  assert.equal(a.severity, 'critical');
  s = await sweepLib.sweep({ now: NOW, statfs: () => { throw Object.assign(new Error('nope'), { code: 'ENOSYS' }); } });
  assert.equal(s.ok, true);
  assert.equal(s.disk.error, 'ENOSYS');
  const d = await sweepLib.sweep({ now: NOW, dryRun: true, statfs: stat(99) });
  assert.equal(d.disk.alert, true);
  assert.equal(ws.alerts().filter(x => x.key === 'disk-usage').length, 1, 'dry run raises no alert');
});

test('deletion budget: --max-delete caps a run and the next run continues', async () => {
  base();
  addRunResult('merged-queue-A');
  for (let i = 0; i < 30; i++) dl(`cv-${1000 + i}.pdf`, 20);
  const s1 = await sweepLib.sweep({ now: NOW, config: { maxDeletes: 12 } });
  assert.equal(s1.downloads.truncated, true);
  assert.equal(fs.readdirSync(ws.downloads).length, 18);
  const s2 = await sweepLib.sweep({ now: NOW, config: { maxDeletes: 100 } });
  assert.equal(s2.downloads.truncated, false);
  assert.equal(fs.readdirSync(ws.downloads).length, 0);
});

test('lock: a live holder makes the sweep skip; a dead or stale holder is taken over; lock is always released', async () => {
  base();
  addRunResult('merged-queue-A');
  dl('cv-1.pdf', 20);
  fs.mkdirSync(ws.logs, { recursive: true });
  const lock = path.join(ws.logs, '.retention-sweep.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: NOW }));
  let s = await sweepLib.sweep({ now: NOW });
  assert.match(s.skipped[0], /another sweep is running/);
  assert.equal(exists(ws.downloads, 'cv-1.pdf'), true);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: NOW }));
  s = await sweepLib.sweep({ now: NOW });
  assert.equal(s.skipped.length, 0);
  assert.equal(exists(ws.downloads, 'cv-1.pdf'), false);
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: NOW - 3 * 3600 * 1000 }));
  s = await sweepLib.sweep({ now: NOW });
  assert.equal(s.skipped.length, 0, 'a lock older than 2 hours is stale even if the pid is alive');
});

// ------------------------------------ jail -------------------------------------------------------

test('jail: every unlink is inside downloads/, runs/ or logs/; files with the same names elsewhere are never touched', async () => {
  buildTree();
  const outside = [];
  for (const n of ['cv-1.pdf', 'candidate-2.json', 'phase1-2026-09-01-100000.json', 'old.log', 'review-tmp-1.json']) {
    const f = path.join(ws.home, n);
    fs.writeFileSync(f, 'keep');
    const t = new Date(NOW - 400 * DAY);
    fs.utimesSync(f, t, t);
    outside.push(f);
  }
  const otherDir = path.join(ws.home, 'pending-searches');
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'cv-9.pdf'), 'keep');
  const roots = [ws.downloads, ws.runs, ws.logs].map(d => fs.realpathSync(d));
  const seen = [];
  await sweepLib.sweep({ now: NOW, unlink: (dir, name) => { seen.push([fs.realpathSync(dir), name]); return R.jailedUnlink([ws.downloads, ws.runs, ws.logs], dir, name); } });
  assert.ok(seen.length > 10);
  for (const [dir] of seen) assert.ok(roots.includes(dir), `unlink outside jail: ${dir}`);
  for (const f of outside) assert.equal(fs.readFileSync(f, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(otherDir, 'cv-9.pdf'), 'utf8'), 'keep');
});

test('jail: symlinks (file and directory) inside the swept directories are reported, never followed or removed', async (t) => {
  base();
  const target = path.join(ws.home, 'precious.pdf');
  fs.writeFileSync(target, 'keep');
  const precious = path.join(ws.home, 'precious-dir');
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, 'cv-1.pdf'), 'keep');
  try {
    fs.symlinkSync(target, path.join(ws.downloads, 'cv-77.pdf'));
    fs.symlinkSync(precious, path.join(ws.downloads, 'linked-dir'), 'dir');
    fs.symlinkSync(target, path.join(ws.runs, 'phase1-link.json'));
    fs.symlinkSync(target, path.join(ws.logs, 'link.log'));
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlinks need privileges on this host');
    throw e;
  }
  // make the links look old (lutimes not needed: lstat mtime of a link is the link's own)
  for (const p of [path.join(ws.downloads, 'cv-77.pdf'), path.join(ws.runs, 'phase1-link.json'), path.join(ws.logs, 'link.log')]) {
    try { fs.lutimesSync(p, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY)); } catch { /* best effort */ }
  }
  addRunResult('merged-queue-Q');
  const s = await sweepLib.sweep({ now: NOW });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(precious, 'cv-1.pdf'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(ws.downloads, 'cv-77.pdf')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(ws.runs, 'phase1-link.json')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(ws.logs, 'link.log')).isSymbolicLink());
  assert.ok(s.anomalies.some(a => a.code === 'symlink-skipped' && a.name === 'cv-77.pdf'));
});

test('jail: a directory named like a CV and a swept directory that is a symlink are not deleted', async (t) => {
  base();
  fs.mkdirSync(path.join(ws.downloads, 'cv-5.pdf'));
  fs.writeFileSync(path.join(ws.downloads, 'cv-5.pdf', 'inner.txt'), 'keep');
  const t0 = new Date(NOW - 400 * DAY);
  fs.utimesSync(path.join(ws.downloads, 'cv-5.pdf'), t0, t0);
  await sweepLib.sweep({ now: NOW });
  assert.equal(fs.readFileSync(path.join(ws.downloads, 'cv-5.pdf', 'inner.txt'), 'utf8'), 'keep');
  // downloads/ replaced by a symlink to an outside directory holding old files: the sweep works on the
  // resolved directory only if it IS one of the configured roots (it is), never on siblings of it
  const outsideDir = path.join(ws.root, 'outside-root');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'cv-8.pdf'), 'x');
  fs.utimesSync(path.join(outsideDir, 'cv-8.pdf'), t0, t0);
  try { fs.symlinkSync(outsideDir, path.join(ws.home, 'downloads-alias'), 'dir'); } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlinks need privileges on this host');
    throw e;
  }
  const unrelated = path.join(ws.home, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'cv-8.pdf'), 'keep');
  fs.utimesSync(path.join(unrelated, 'cv-8.pdf'), t0, t0);
  await sweepLib.sweep({ now: NOW });
  assert.equal(fs.readFileSync(path.join(unrelated, 'cv-8.pdf'), 'utf8'), 'keep');
});

test('static: every unlink in the lifecycle scripts goes through jailedUnlink', () => {
  const dir = path.resolve(__dirname, '../../resourcer/scripts');
  for (const f of ['process-approved-queue.js', 'retention-sweep.js', 'migrate-schema.js', 'backfill-run-results.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /\bunlinkSync\b|\brmSync\b|\brmdirSync\b|\bfs\.promises\.(unlink|rm)\b|\bfs\.(unlink|rm)\(/, `${f} must not call unlink/rm directly`);
  }
  const lib = fs.readFileSync(path.join(dir, 'lib/cv-retention.js'), 'utf8');
  assert.equal((lib.match(/unlinkSync/g) || []).length, 1, 'exactly one unlink primitive');
});

// ------------------------------------ CLI ---------------------------------------------------------

function cli(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: ws.home, ...(env || {}) } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: prints one JSON summary on stdout, --dry-run changes nothing, real run deletes, exit 0', () => {
  base();
  addRunResult('merged-queue-A');
  put(ws.downloads, 'cv-1.pdf', 30);
  const realNow = Date.now();
  fs.utimesSync(path.join(ws.downloads, 'cv-1.pdf'), new Date(realNow - 30 * DAY), new Date(realNow - 30 * DAY));
  const dry = cli(['--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  const dj = JSON.parse(dry.out);
  assert.equal(dj.dryRun, true);
  assert.equal(dj.downloads.deleted.cv, 1);
  assert.equal(exists(ws.downloads, 'cv-1.pdf'), true);
  const real = cli(['--pretty']);
  assert.equal(real.code, 0, real.err);
  const rj = JSON.parse(real.out);
  assert.equal(rj.ok, true);
  assert.equal(rj.downloads.deleted.cv, 1);
  assert.equal(exists(ws.downloads, 'cv-1.pdf'), false);
  assert.match(real.out, /\n {2}"ok": true/);
});

test('CLI: --list names the deleted downloads/ files (names only)', () => {
  base();
  addRunResult('merged-queue-A');
  put(ws.downloads, 'cv-1.pdf', 30);
  put(ws.downloads, 'review-tmp-x.json', 0);
  const realNow = Date.now();
  fs.utimesSync(path.join(ws.downloads, 'cv-1.pdf'), new Date(realNow - 30 * DAY), new Date(realNow - 30 * DAY));
  const r = cli(['--list']);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.downloads.files.map(f => f.name).sort(), ['cv-1.pdf', 'review-tmp-x.json']);
  assert.deepEqual(Object.keys(j.downloads.files[0]).sort(), ['kind', 'name', 'reason']);
});

test('CLI: refusal exits 0 with the reason in the summary; usage errors exit 2; --help exits 0', () => {
  ws.reset();
  createLegacyDb(ws.db, {});
  const r = cli([]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).refused.length, 1);
  assert.equal(cli(['--nonsense']).code, 2);
  assert.equal(cli(['--max-delete', '-1']).code, 2);
  assert.equal(cli(['--now', 'not-a-date']).code, 2);
  assert.equal(cli(['--help']).code, 0);
});

test('CLI: --now and thresholds are honoured', () => {
  base();
  addRunResult('merged-queue-A');
  put(ws.downloads, 'cv-1.pdf', 1);
  const future = new Date(Date.now() + 20 * DAY).toISOString();
  const r = cli(['--now', future, '--orphan-days', '14']);
  assert.equal(JSON.parse(r.out).downloads.deleted.cv, 1);
});

test('CLI: two concurrent sweeps do not double-process (second one skips or finds nothing)', async () => {
  base();
  addRunResult('merged-queue-A');
  for (let i = 0; i < 200; i++) put(ws.downloads, `cv-${2000 + i}.pdf`, 30);
  const realNow = Date.now();
  for (const n of fs.readdirSync(ws.downloads)) fs.utimesSync(path.join(ws.downloads, n), new Date(realNow - 30 * DAY), new Date(realNow - 30 * DAY));
  const run = () => new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT], { env: { ...process.env, RESOURCER_HOME: ws.home } });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', code => res({ code, out }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  const total = [a, b].map(x => JSON.parse(x.out)).reduce((n, j) => n + (j.downloads.deleted.cv || 0), 0);
  assert.equal(total, 200);
  assert.equal(fs.readdirSync(ws.downloads).length, 0);
});

// ------------------------------------ end to end ---------------------------------------------------

test('end to end: Phase 2 run, age the files, sweep, and the guard/dashboard data behave', async () => {
  const zoho = await startFakeZoho();
  try {
    ws.reset();
    seedDb(ws, ['6001', '6002']);
    zoho.scenario('6002', { attach: 'fail' });
    const qf = writeQueue(ws, 'merged-queue-2026-09-29T10-00-00.json', { candidates: [card('6001'), card('6002')] });
    const built = buildDeps(ws, { zoho });
    const cap = captureConsole();
    try { await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
    // 6001 attached and cleaned; 6002 attach failed: CV + JSON kept
    assert.deepEqual(fs.readdirSync(ws.downloads).filter(n => /^(cv|candidate)-/.test(n)).sort(), ['candidate-6002.json', 'cv-6002.pdf']);
    assert.equal(db.runResults().length, 1);
    const stats = db.runResults()[0];
    // simulate time passing: 4 days -> queue+results go; the failed-attach files stay until 14 days
    const t4 = new Date(Date.now() - 4 * DAY);
    for (const n of fs.readdirSync(ws.downloads)) fs.utimesSync(path.join(ws.downloads, n), t4, t4);
    // completedAt inside results is "now", so age it through --now instead
    const s4 = await sweepLib.sweep({ now: Date.now() + 4 * DAY });
    assert.deepEqual(fs.readdirSync(ws.downloads).sort(), ['candidate-6002.json', 'cv-6002.pdf']);
    assert.equal(s4.downloads.deleted.queue, 1);
    assert.equal(s4.downloads.deleted.results, 1);
    const s15 = await sweepLib.sweep({ now: Date.now() + 15 * DAY });
    assert.deepEqual(fs.readdirSync(ws.downloads), []);
    assert.equal(s15.downloads.unpushedOrphans, 0, 'the candidate has a zoho id in the DB, so this is not a lost candidate');
    assert.deepEqual(db.runResults(), [stats], 'dashboard numbers survive the sweep');
    // the queue is gone: a stuck sub-agent re-invoking Phase 2 gets a clean failure, not a duplicate push
    const before = zoho.calls.length;
    const cap2 = captureConsole();
    let res;
    try { res = await pq.run(qf, buildDeps(ws, { zoho }).deps); } finally { cap2.restore(); }
    assert.equal(res.code, 1);
    assert.equal(zoho.calls.length, before);
  } finally { await zoho.close(); }
});

test('sweep without a downloads directory or runs/logs directories is a clean no-op', async () => {
  ws.reset();
  createLegacyDb(ws.db, {});
  fs.rmSync(ws.downloads, { recursive: true, force: true });
  fs.rmSync(ws.runs, { recursive: true, force: true });
  fs.rmSync(ws.logs, { recursive: true, force: true });
  const s = await sweepLib.sweep({ now: NOW, dryRun: true });
  assert.equal(s.ok, true);
  assert.ok(s.skipped.some(x => /downloads: directory absent/.test(x)));
});

// ------------------------------------ 2026-09-29 integration fixes ---------------------------------

const screeningDir = path.join(ws.home, 'runtime', 'screening-input');
const shadowDir = path.join(ws.home, 'shadow');
const stateDir = path.join(ws.home, 'state');
const secretsDir = path.join(ws.home, 'secrets');

function resetExtra() {
  for (const d of [screeningDir, shadowDir, stateDir, secretsDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
const inHours = (dir, name, hours, content) => put(dir, name, hours / 24, content);

function snapshotTree(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${Math.round(fs.statSync(p).mtimeMs)}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test('runtime/screening-input: files older than an hour go, younger stay, independent of the downloads gate; dry run changes nothing', async () => {
  base();
  resetExtra();
  inHours(screeningDir, 'batch-old.json', 2);
  inHours(screeningDir, 'batch-just-old.json', 1.01);
  inHours(screeningDir, 'batch-just-young.json', 0.99);
  inHours(screeningDir, 'batch-young.json', 0.1);
  fs.mkdirSync(path.join(screeningDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(screeningDir, 'sub', 'inner.json'), 'keep');
  const before = fs.readdirSync(screeningDir).sort();
  const dry = await sweepLib.sweep({ now: NOW, dryRun: true });
  assert.deepEqual(fs.readdirSync(screeningDir).sort(), before, 'dry run deletes nothing');
  assert.equal(dry.screening.deleted, 2);
  const real = await sweepLib.sweep({ now: NOW });
  assert.equal(real.refused.length, 1, 'downloads/ is refused (run_results empty) yet the screening folder is still swept');
  assert.deepEqual(fs.readdirSync(screeningDir).sort(), ['batch-just-young.json', 'batch-young.json', 'sub']);
  assert.equal(fs.readFileSync(path.join(screeningDir, 'sub', 'inner.json'), 'utf8'), 'keep', 'sub-directories are never entered');
  assert.equal(real.screening.deleted, 2);
  assert.equal(real.screening.kept, 2);
  assert.equal(real.screening.scanned, 5);
  assert.ok(real.screening.bytesFreed > 0);
  assert.deepEqual(real.screening.failures, []);
  assert.equal(dry.screening.deleted, real.screening.deleted);
  assert.doesNotMatch(JSON.stringify(real), /data-batch/, 'the summary carries counts, never file contents');
});

test('runtime/screening-input: a missing folder is fine, symlinks are never followed, the age can be tuned', async (t) => {
  base();
  resetExtra();
  let s = await sweepLib.sweep({ now: NOW });
  assert.equal(s.ok, true);
  assert.equal(s.screening.scanned, 0);
  const target = path.join(ws.home, 'precious-input.json');
  fs.writeFileSync(target, 'keep');
  fs.mkdirSync(screeningDir, { recursive: true });
  try { fs.symlinkSync(target, path.join(screeningDir, 'batch-link.json')); } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') t.diagnostic('symlinks need privileges on this host; symlink part skipped');
    else throw e;
  }
  inHours(screeningDir, 'batch-3h.json', 3);
  s = await sweepLib.sweep({ now: NOW, config: { screeningInputHours: 6 } });
  assert.equal(exists(screeningDir, 'batch-3h.json'), true, '6 hour setting keeps a 3 hour old file');
  s = await sweepLib.sweep({ now: NOW });
  assert.equal(exists(screeningDir, 'batch-3h.json'), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  if (fs.readdirSync(screeningDir).includes('batch-link.json')) assert.ok(fs.lstatSync(path.join(screeningDir, 'batch-link.json')).isSymbolicLink());
});

test('hard-kill leftovers: runs/phase1-*.tmp after an hour even while downloads/ is refused; downloads/approved-queue-*.tmp after an hour once run_results exists', async () => {
  base();
  const q = 'approved-queue-2026-09-29-100000.json';
  const st = 'phase1-2026-09-29-100000.json';
  inHours(ws.runs, `${st}.4242.1790000000000.tmp`, 2);
  inHours(ws.runs, `${st}.4243.1790000000001.tmp`, 0.5);
  inHours(ws.runs, 'mystery.tmp', 12);
  inHours(ws.downloads, `${q}.4242.1790000000000.tmp`, 2);
  inHours(ws.downloads, `${q}.4243.1790000000001.tmp`, 0.5);
  inHours(ws.downloads, 'mystery.tmp', 12);
  let s = await sweepLib.sweep({ now: NOW });
  assert.equal(s.refused.length, 1);
  assert.deepEqual(fs.readdirSync(ws.runs).sort(), ['mystery.tmp', `${st}.4243.1790000000001.tmp`]);
  assert.equal(fs.readdirSync(ws.downloads).length, 3, 'downloads/ is untouched until run_results has rows');
  addRunResult('merged-queue-Q');
  s = await sweepLib.sweep({ now: NOW });
  assert.deepEqual(fs.readdirSync(ws.downloads).sort(), [`${q}.4243.1790000000001.tmp`, 'mystery.tmp'].sort());
  assert.equal(s.downloads.deleted.tmp, 1);
  s = await sweepLib.sweep({ now: NOW + 2 * DAY });
  assert.deepEqual(fs.readdirSync(ws.downloads), [], 'an unknown *.tmp still goes after tmpDays');
  assert.deepEqual(fs.readdirSync(ws.runs), []);
});

test('hard-kill leftovers: a real interrupted atomic write leaves exactly the name the sweep recognises', () => {
  const fsx = require('../../resourcer/scripts/lib/fsx');
  ws.reset();
  const target = path.join(ws.downloads, 'approved-queue-2026-09-29-100000.json');
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('killed between write and rename'); };
  try { assert.throws(() => fsx.writeJsonAtomic(target, { candidates: [] })); } finally { fs.renameSync = realRename; }
  const left = fs.readdirSync(ws.downloads).filter(n => n.endsWith('.tmp'));
  assert.equal(left.length, 1);
  assert.equal(R.isHardKillTmp('downloads', left[0]), true, left[0]);
  assert.match(left[0], /^approved-queue-2026-09-29-100000\.json\.\d+\.\d+\.tmp$/);
});

test('cv-reed-anon-*: swept as orphans after 14 days, not counted as unpushed, no ledger entry', async () => {
  base();
  addRunResult('merged-queue-Q');
  dl('cv-reed-anon-9007.txt', 15); dl('cv-reed-anon-9008.pdf', 13); dl('cv-9.pdf', 15);
  const s = await sweepLib.sweep({ now: NOW });
  assert.equal(exists(ws.downloads, 'cv-reed-anon-9007.txt'), false);
  assert.equal(exists(ws.downloads, 'cv-reed-anon-9008.pdf'), true, '13 days: kept');
  assert.equal(exists(ws.downloads, 'cv-9.pdf'), false);
  assert.equal(s.downloads.deleted['cv-anon'], 1);
  assert.equal(s.downloads.deleted.cv, 1);
  assert.equal(s.downloads.unpushedOrphans, 1, 'only the real candidate CV counts as never pushed');
  const ledger = fs.readFileSync(path.join(ws.logs, 'retention-unpushed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(ledger.map(l => `${l.kind}:${l.id}`), ['cv:9']);
});

test('shadow/: only screening-YYYY-MM-DD.jsonl older than 180 days go, through pruneShadow; every other file, state/ and secrets/ stay byte for byte', async () => {
  base();
  resetExtra();
  const sh = (name, age) => put(shadowDir, name, age, '{"row":1}\n');
  // 2026-09-29 minus 180 days is 2026-04-02: a date before it is old, the cutoff date itself is kept
  sh('screening-2026-01-15.jsonl', 250); sh('screening-2026-03-01.jsonl', 212); sh('screening-2026-04-01.jsonl', 181);
  sh('screening-2026-04-02.jsonl', 180); sh('screening-2026-09-28.jsonl', 1);
  sh('notes.txt', 400); sh('.last-prune', 400); sh('screening-2026-01-15.jsonl.bak', 400); sh('screening-2026-01-15.json', 400);
  put(stateDir, 'agent-browser.sock.json', 400, 'state-a');
  put(path.join(stateDir, 'chrome-profile', 'Default'), 'Cookies', 400, 'state-b');
  put(secretsDir, 'zoho-credentials.json', 400, 'secret-a');
  put(secretsDir, 'reed-credentials.json', 400, 'secret-b');
  const stateBefore = snapshotTree(stateDir);
  const secretsBefore = snapshotTree(secretsDir);
  const shadowKept = ['.last-prune', 'notes.txt', 'screening-2026-01-15.json', 'screening-2026-01-15.jsonl.bak', 'screening-2026-04-02.jsonl', 'screening-2026-09-28.jsonl'];

  const dry = await sweepLib.sweep({ now: NOW, dryRun: true });
  assert.deepEqual(dry.shadow, { wouldDelete: 3, kept: 2 });
  assert.equal(fs.readdirSync(shadowDir).length, 9, 'dry run removes nothing');

  const s = await sweepLib.sweep({ now: NOW });
  assert.deepEqual(s.shadow, { deleted: 3, kept: 2 });
  assert.deepEqual(fs.readdirSync(shadowDir).sort(), shadowKept);
  assert.deepEqual(snapshotTree(stateDir), stateBefore, 'state/ untouched');
  assert.deepEqual(snapshotTree(secretsDir), secretsBefore, 'secrets/ untouched');
  assert.equal(s.ok, true);
});

test('shadow/: the number of days is configurable (at least 1); a missing folder is fine', async () => {
  base();
  resetExtra();
  put(shadowDir, 'screening-2026-09-20.jsonl', 9, 'x\n');
  put(shadowDir, 'screening-2026-09-28.jsonl', 1, 'x\n');
  let s = await sweepLib.sweep({ now: NOW, config: { shadowDays: 5 } });
  assert.deepEqual(s.shadow, { deleted: 1, kept: 1 });
  assert.deepEqual(fs.readdirSync(shadowDir), ['screening-2026-09-28.jsonl']);
  resetExtra();
  s = await sweepLib.sweep({ now: NOW });
  assert.deepEqual(s.shadow, { deleted: 0, kept: 0 });
  assert.equal(sweepLib.parseArgs(['--shadow-days', '30']).config.shadowDays, 30);
  assert.throws(() => sweepLib.parseArgs(['--shadow-days', '0']), /at least 1/);
  assert.throws(() => sweepLib.parseArgs(['--shadow-days', 'x']), /non-negative/);
});

test('shadow/: a screening package without pruneShadow is skipped, a throwing one is reported without failing the sweep', async () => {
  base();
  resetExtra();
  const none = sweepLib.pruneShadowLog({ dir: shadowDir, days: 180, now: NOW, dryRun: false, lib: {} });
  assert.deepEqual(none, { skipped: 'pruneShadow not available' });
  const s = await sweepLib.sweep({ now: NOW, shadowLib: { pruneShadow() { throw new Error('disk on fire'); } } });
  assert.equal(s.ok, true);
  assert.equal(s.shadow.error, 'disk on fire');
  assert.ok(ws.alerts().some(a => a.key === 'retention-delete-errors'));
  const dry = await sweepLib.sweep({ now: NOW, dryRun: true, shadowLib: { pruneShadow() { throw new Error('must not run in a dry run'); }, NAME_RE: /^screening-(\d{4}-\d{2}-\d{2})\.jsonl$/ } });
  assert.deepEqual(dry.shadow, { wouldDelete: 0, kept: 0 });
});

test('CLI: the new thresholds parse and show in --help', () => {
  const o = sweepLib.parseArgs(['--tmp-hours', '2', '--screening-input-hours', '3']);
  assert.equal(o.config.hardKillTmpHours, 2);
  assert.equal(o.config.screeningInputHours, 3);
  const h = cli(['--help']);
  assert.equal(h.code, 0);
  for (const flag of ['--tmp-hours', '--screening-input-hours', '--shadow-days']) assert.ok(h.out.includes(flag), flag);
  assert.match(h.out, /state\/ and secrets\/ are never touched/);
});

test('CLI: a real run through the shipped script prunes shadow/ and screening-input and leaves state/ alone', () => {
  base();
  resetExtra();
  addRunResult('merged-queue-A');
  const realNow = Date.now();
  const old = (dir, name, days) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(realNow - days * DAY), new Date(realNow - days * DAY));
  };
  old(screeningDir, 'batch-crashed.json', 1);
  old(shadowDir, 'screening-2020-01-01.jsonl', 2000);
  old(stateDir, 'keep.bin', 2000);
  const r = cli([]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.screening.deleted, 1);
  assert.equal(j.shadow.deleted, 1);
  assert.deepEqual(fs.readdirSync(screeningDir), []);
  assert.deepEqual(fs.readdirSync(shadowDir), []);
  assert.deepEqual(fs.readdirSync(stateDir), ['keep.bin']);
});

test('static: the sweep names no path outside downloads, runs, logs, runtime/screening-input and shadow (through pruneShadow)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../resourcer/scripts/retention-sweep.js'), 'utf8');
  assert.doesNotMatch(src, /paths\.(STATE|SECRETS|BACKUPS|OUTBOX|PENDING|CONFIG)\b/);
  assert.match(src, /pruneShadow\(/);
  assert.doesNotMatch(src, /\bunlinkSync\b|\brmSync\b/);
});
