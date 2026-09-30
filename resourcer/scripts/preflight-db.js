#!/usr/bin/env node
'use strict';
/**
 * preflight-db.js - is candidates.db fit to run the pipeline on? (docs/parity/lifecycle.md 9.4)
 * Exit 0 only when the file exists, is not empty, opens, passes PRAGMA integrity_check and holds a candidate
 * (--allow-empty: a fresh install may hold none). A missing or empty database makes every card look new. Exit 1 not fit, 2 usage.
 * Opened normally, not read-only, so a hot journal from a killed writer is rolled back; query_only keeps it read-only in effect.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');

const DEFAULT_BUSY_MS = 15000;

function checkDb(opts = {}) {
  const dbPath = path.resolve(opts.db || paths.DB);
  const busyMs = opts.busyTimeoutMs || DEFAULT_BUSY_MS;
  const res = { ok: false, dbPath, reason: null, detail: null, candidates: null, journalMode: null, checks: [] };
  const pass = (name, detail) => res.checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  const fail = (reason, detail) => {
    res.reason = reason;
    res.detail = detail || null;
    res.checks.push({ name: reason, ok: false, ...(detail ? { detail } : {}) });
    return res;
  };

  let st;
  try { st = fs.statSync(dbPath); } catch (e) {
    return fail('missing', e.code === 'ENOENT' ? 'no such file (restore the data bundle first)' : (e.code || 'stat failed'));
  }
  if (!st.isFile()) return fail('not-a-file', 'the database path is not a regular file');
  if (st.size === 0 && !opts.allowEmpty) return fail('empty-file', 'the database file is 0 bytes');
  pass('exists', `${st.size} bytes`);

  let Database;
  try { Database = opts.Database || require('better-sqlite3'); } catch (e) {
    return fail('driver-missing', String(e && e.message || e).split('\n')[0].slice(0, 120));
  }
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: busyMs });
    db.pragma(`busy_timeout = ${busyMs}`);
    db.pragma('query_only = ON');
    res.journalMode = String(db.pragma('journal_mode', { simple: true }));

    const rows = db.pragma('integrity_check');
    const verdict = rows.length === 1 && rows[0].integrity_check === 'ok' ? 'ok' : rows.map(r => r.integrity_check).slice(0, 3).join('; ');
    if (verdict !== 'ok') return fail('integrity-failed', String(verdict).slice(0, 200));
    pass('integrity_check', 'ok');

    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidates'").get();
    if (!hasTable) {
      if (!opts.allowEmpty) return fail('no-candidates-table', 'the candidates table does not exist');
      res.candidates = 0;
      pass('candidates', 'table absent (allowed: fresh install)');
    } else {
      res.candidates = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
      if (res.candidates === 0 && !opts.allowEmpty) return fail('no-candidates', 'the candidates table is empty (pass --allow-empty for a fresh install)');
      pass('candidates', String(res.candidates));
    }
    res.ok = true;
    return res;
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 160);
    return fail(/locked|busy/i.test(msg) ? 'locked' : 'open-failed', msg);
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

const HELP = `Usage: node scripts/preflight-db.js [options]
  --db <file>             database (default: RESOURCER_HOME/candidates.db)
  --allow-empty           accept a database with no candidates (fresh install)
  --busy-timeout-ms <n>   default ${DEFAULT_BUSY_MS}
  --json                  print one JSON object on stdout
  --quiet                 print nothing when the database is fit
  --help
Exit codes: 0 fit to run, 1 not fit (reason on stderr), 2 usage.`;

function parseArgs(argv) {
  const o = {};
  const value = (flag, i) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--allow-empty') o.allowEmpty = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--db') o.db = value(a, ++i);
    else if (a === '--busy-timeout-ms') o.busyTimeoutMs = Number(value(a, ++i));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.busyTimeoutMs !== undefined && !(o.busyTimeoutMs > 0)) throw new Error('--busy-timeout-ms must be a positive number');
  return o;
}

function main(argv, io) {
  const out = (io && io.out) || (s => process.stdout.write(s));
  const err = (io && io.err) || (s => process.stderr.write(s));
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    err(`${e.message}\n${HELP}\n`);
    return 2;
  }
  if (opts.help) { out(`${HELP}\n`); return 0; }
  const res = checkDb(opts);
  if (opts.json) {
    out(`${JSON.stringify(res)}\n`);
  } else if (res.ok) {
    if (!opts.quiet) out(`[preflight-db] OK candidates=${res.candidates} journal=${res.journalMode}\n`);
  } else {
    err(`[preflight-db] NOT FIT (${res.reason}): ${res.detail || 'no detail'}\n`);
  }
  return res.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { checkDb, main, parseArgs };
