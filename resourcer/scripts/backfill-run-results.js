#!/usr/bin/env node
'use strict';
/**
 * backfill-run-results.js - rebuild run_results from downloads/phase2-results-*.json.
 *
 * Read-only towards downloads/: this script never deletes, moves or edits a file and never issues
 * DELETE/DROP. It only inserts rows (INSERT OR IGNORE; --replace re-maps existing rows).
 * Run it BEFORE retention-sweep is allowed to touch downloads/ and compare the printed per-day sums.
 *
 * Exit: 0 ok, 1 error, 2 usage, 3 parity mismatch (only with --strict).
 */
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const retention = require('./lib/cv-retention');

const COLUMNS = [
  'run_key', 'date', 'started_at', 'completed_at', 'requested_at', 'phase1_started_at',
  'job_title', 'location', 'distance', 'keywords', 'sources', 'pool',
  'downloaded', 'new_to_zoho', 'duplicates', 'skipped', 'errors',
  'approved_p1', 'skipped_db', 'skipped_review', 'pages_scraped',
  'total_runtime_secs', 'phase2_runtime_secs', 'credits_remaining', 'screening_model',
  'caterer_json', 'reed_json',
];

const PREFIX = 'phase2-results-';

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function intOrZero(v) {
  const n = intOrNull(v);
  return n === null ? 0 : n;
}

function textOrNull(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// Same defaults as the legacy dashboard reader (stats.js getPhase2Results): downloaded ?? total,
// new/duplicates/skipped/errors ?? 0, sources || 'caterer'. sources is coerced to the dashboard enum
// (caterer | reed | both); an unknown value falls back like an absent one.
function buildRunResultRow(results, runKey, queue) {
  if (!results || typeof results !== 'object' || !runKey) return null;
  if (typeof results.date !== 'string' || !results.date) return null;
  const p1 = results.phase1 && typeof results.phase1 === 'object' ? results.phase1 : {};
  const q = queue && typeof queue === 'object' ? queue : null;
  const qStats = q && q.phase1Stats && typeof q.phase1Stats === 'object'
    ? (q.phase1Stats.caterer && typeof q.phase1Stats.caterer === 'object' ? q.phase1Stats.caterer : q.phase1Stats)
    : {};
  const fromQ = (a, b) => (a !== undefined && a !== null ? a : b);
  const kw = typeof results.keywords === 'string' ? results.keywords.trim() : '';
  return {
    run_key: runKey,
    date: results.date,
    started_at: textOrNull(results.startedAt),
    completed_at: textOrNull(results.completedAt),
    requested_at: textOrNull(fromQ(results.requestedAt, q && q.requestedAt)),
    phase1_started_at: textOrNull(fromQ(results.phase1StartedAt, q && q.phase1StartedAt)),
    job_title: textOrNull(results.jobTitle),
    location: textOrNull(results.location),
    distance: intOrNull(results.distance),
    keywords: kw || null,
    sources: retention.normalizeSources(results.sources) || retention.normalizeSources(q && q.sources) || 'caterer',
    pool: intOrNull(fromQ(results.candidateCount, q && q.candidateCount)),
    downloaded: intOrNull(fromQ(results.downloaded, results.total)),
    new_to_zoho: intOrZero(results.new),
    duplicates: intOrZero(results.duplicates),
    // skipped = already in Zoho (pre-check) plus the candidates CV screening rejected (results.cvRejected, absent when the stage was off):
    // the dashboard funnel then explains every candidate of the queue (downloaded = new + duplicates + skipped + errors).
    skipped: intOrZero(results.skipped) + intOrZero(results.cvRejected),
    errors: intOrZero(results.errors),
    approved_p1: intOrNull(fromQ(p1.approved, fromQ(qStats.approved, qStats.approvedQueue))),
    skipped_db: intOrNull(fromQ(p1.skippedDb, qStats.skippedDb)),
    skipped_review: intOrNull(fromQ(p1.skippedReview, fromQ(qStats.skippedReview, qStats.rejectedScreening))),
    pages_scraped: intOrNull(fromQ(p1.pagesScraped, qStats.pagesScraped)),
    total_runtime_secs: intOrNull(results.totalRuntimeSecs),
    phase2_runtime_secs: intOrNull(results.runtimeSecs),
    credits_remaining: intOrNull(fromQ(results.creditsRemaining, q && q.creditsRemaining)),
    screening_model: textOrNull(fromQ(results.screeningModel, q && q.screeningModel)),
    caterer_json: results.catererStats ? JSON.stringify(results.catererStats) : null,
    reed_json: results.reedStats ? JSON.stringify(results.reedStats) : null,
  };
}

function statementFor(db, replace) {
  const verb = replace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
  return db.prepare(`${verb} INTO run_results (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => `@${c}`).join(', ')})`);
}

function writeRunResultRow(db, row, opts) {
  return statementFor(db, !!(opts && opts.replace)).run(row);
}

function readJsonFile(file) {
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.toString('utf8', 3) : buf.toString('utf8');
  return JSON.parse(text);
}

function utcDaysBack(n, todayIso) {
  const out = [];
  const base = new Date(`${todayIso}T00:00:00Z`).getTime();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

async function backfill(opts = {}) {
  const dir = path.resolve(opts.dir || paths.DOWNLOADS);
  const days = opts.days || 14;
  const dryRun = !!opts.dryRun;
  const useQueues = opts.useQueues !== false;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const summary = {
    ok: true, dir, dryRun, files: 0, parsed: 0, unparseable: 0, noDate: 0, inserted: 0, ignored: 0, replaced: 0,
    fromQueue: 0, perDay: [], parity: { ok: true, mismatches: 0 }, errors: [],
  };

  let names;
  try {
    names = fs.readdirSync(dir).filter(f => f.startsWith(PREFIX) && f.endsWith('.json'));
  } catch (e) {
    // A fresh install has no downloads/ yet (the bundle never carries it): that is zero files, not a failure.
    if (e.code === 'ENOENT' && !opts.dir) {
      names = [];
    } else {
      summary.ok = false;
      summary.errors.push(`cannot read ${dir}: ${e.code || e.message}`);
      return summary;
    }
  }
  summary.files = names.length;

  const rows = [];
  const fileSumByDay = new Map();
  for (const name of names.sort()) {
    const runKey = name.slice(PREFIX.length, -'.json'.length);
    let results;
    try { results = readJsonFile(path.join(dir, name)); } catch { summary.unparseable++; continue; }
    let queue = null;
    let row = buildRunResultRow(results, runKey, null);
    if (!row) { summary.noDate++; continue; }
    if (useQueues) {
      const missing = row.pages_scraped === null || row.approved_p1 === null || row.pool === null || !retention.normalizeSources(results.sources) || !results.screeningModel;
      if (missing) {
        try {
          queue = readJsonFile(path.join(dir, retention.queueNameForRunKey(runKey)));
          const filled = buildRunResultRow(results, runKey, queue);
          if (JSON.stringify(filled) !== JSON.stringify(row)) summary.fromQueue++;
          row = filled;
        } catch { /* queue already swept or unreadable: keep the results-only row */ }
      }
    }
    summary.parsed++;
    rows.push(row);
    fileSumByDay.set(row.date, (fileSumByDay.get(row.date) || 0) + row.new_to_zoho);
  }

  if (dryRun) {
    summary.inserted = rows.length;
    summary.perDay = utcDaysBack(days, today).map(d => ({ date: d, files: fileSumByDay.get(d) || 0, db: null }));
    return summary;
  }

  const Database = opts.Database || require('better-sqlite3');
  const dbPath = path.resolve(opts.db || paths.DB);
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 15000 });
    db.pragma('busy_timeout = 15000');
    require('./migrate-schema').ensureRunResults(db);
    const stmt = statementFor(db, !!opts.replace);
    const run = db.transaction(list => {
      for (const r of list) {
        const info = stmt.run(r);
        if (info.changes > 0) { if (opts.replace) summary.replaced++; else summary.inserted++; } else summary.ignored++;
      }
    });
    run.immediate(rows);
    for (const d of utcDaysBack(days, today)) {
      const dbSum = db.prepare('SELECT COALESCE(SUM(new_to_zoho),0) AS n FROM run_results WHERE date = ?').get(d).n;
      const fileSum = fileSumByDay.get(d) || 0;
      const match = dbSum === fileSum;
      if (!match) { summary.parity.ok = false; summary.parity.mismatches++; }
      summary.perDay.push({ date: d, files: fileSum, db: dbSum, match });
    }
    summary.totalRows = db.prepare('SELECT COUNT(*) AS n FROM run_results').get().n;
  } catch (e) {
    summary.ok = false;
    summary.errors.push(String(e.message || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
  return summary;
}

const HELP = `Usage: node scripts/backfill-run-results.js [options]
  --dir <path>      folder holding phase2-results-*.json (default: RESOURCER_HOME/downloads)
  --db <file>       database (default: RESOURCER_HOME/candidates.db)
  --days <n>        days shown in the parity table (default 14)
  --dry-run         parse and print; touch nothing
  --replace         re-map rows that already exist (default: keep existing rows)
  --no-queues       do not read queue files to fill fields missing from a results file
  --strict          exit 3 when the per-day sums differ between files and run_results
  --json            print one JSON object
  --help
Never deletes files. Exit: 0 ok, 1 error, 2 usage, 3 parity mismatch with --strict.`;

function parseArgs(argv) {
  const o = {};
  const value = (flag, i) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--no-queues') o.useQueues = false;
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--dir') o.dir = value(a, ++i);
    else if (a === '--db') o.db = value(a, ++i);
    else if (a === '--days') o.days = Number(value(a, ++i));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.days !== undefined && !(o.days >= 1 && o.days <= 400)) throw new Error('--days must be between 1 and 400');
  return o;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(`${HELP}\n`); return 0; }
  const s = await backfill(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(s)}\n`);
  } else {
    process.stdout.write(`[backfill-run-results] ${s.dryRun ? 'DRY RUN ' : ''}${s.dir}\n`);
    process.stdout.write(`  files=${s.files} parsed=${s.parsed} unparseable=${s.unparseable} no_date=${s.noDate} from_queue=${s.fromQueue}\n`);
    process.stdout.write(`  inserted=${s.inserted} ignored(existing)=${s.ignored} replaced=${s.replaced}${s.totalRows !== undefined ? ` total_rows=${s.totalRows}` : ''}\n`);
    process.stdout.write('  date        files(new)  run_results(new)\n');
    for (const d of s.perDay) process.stdout.write(`  ${d.date}  ${String(d.files).padStart(9)}  ${d.db === null ? '        -' : String(d.db).padStart(15)}${d.match === false ? '   MISMATCH' : ''}\n`);
    if (!s.dryRun) process.stdout.write(`  PARITY ${s.parity.ok ? 'OK' : `MISMATCH (${s.parity.mismatches} day(s))`}\n`);
    for (const e of s.errors) process.stderr.write(`  ERROR ${e}\n`);
  }
  if (!s.ok) return 1;
  if (opts.strict && !s.parity.ok) return 3;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`FATAL: ${err && err.message}\n`);
    process.exit(1);
  });
}

module.exports = { buildRunResultRow, writeRunResultRow, statementFor, backfill, COLUMNS, intOrNull };
