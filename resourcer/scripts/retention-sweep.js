#!/usr/bin/env node
'use strict';
/**
 * retention-sweep.js - data lifecycle sweep (DESIGN 5.6).
 *
 * downloads/  (only once run_results is populated; queue before results; every result repaired into
 *              run_results before its file goes)
 *   review-tmp-*                          always
 *   phase2-results / queue JSON           completed + 3 days (queue first, results second)
 *   orphan queue (never completed)        14 days
 *   orphan cv-* / candidate-*.json        14 days (ids of never-pushed ones are logged, not the contents)
 *   orphan cv-reed-anon-*                 14 days (redacted Reed CVs; never pushed, so not counted as unpushed)
 *   *.tmp of a known file (hard kill)     1 hour; any other stale *.tmp 1 day
 * runs/       phase1-* / params-* / run-* files older than 7 days; their hard-kill *.tmp leftovers after 1 hour
 * logs/       *.log|err|out|txt older than 14 days gzipped; active logs above 50 MB rotated; .gz older than 90 days removed
 * runtime/screening-input/  every file older than 1 hour (snippets of a screening call that was hard-killed)
 * shadow/     screening-YYYY-MM-DD.jsonl older than 180 days, removed by lib/screening/shadow.pruneShadow when present
 * disk        notify critical above 85% used
 *
 * state/ and secrets/ are never touched, and shadow/ only through pruneShadow. Every other deletion goes through
 * cv-retention.jailedUnlink: plain basename, regular file (never a symlink), directory equal to paths.DOWNLOADS /
 * paths.RUNS / paths.LOGS / runtime/screening-input. --dry-run changes nothing at all.
 * stdout: one JSON summary. Exit: 0 (also when refusing to sweep downloads/), 1 unexpected failure, 2 usage.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { notify } = require('./lib/notify');
const retention = require('./lib/cv-retention');

const QUIET_MS = 10 * 60 * 1000;
const LOCK_NAME = '.retention-sweep.lock';

function readJsonLoose(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function listEntries(dir) {
  const out = [];
  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const d of dirents) {
    let type = 'other';
    let size = 0;
    let mtimeMs = 0;
    if (d.isSymbolicLink()) type = 'symlink';
    else if (d.isDirectory()) type = 'dir';
    else if (d.isFile()) {
      type = 'file';
      try { const st = fs.lstatSync(path.join(dir, d.name)); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    }
    out.push({ name: d.name, type, size, mtimeMs });
  }
  return out;
}

async function verifyGzip(gzFile, expectedBytes) {
  let n = 0;
  const sink = new Writable({ write(chunk, _enc, cb) { n += chunk.length; cb(); } });
  await pipeline(fs.createReadStream(gzFile), zlib.createGunzip(), sink);
  return n === expectedBytes;
}

async function gzipInPlace(jailRoots, dir, name) {
  const src = path.join(dir, name);
  const dst = `${src}.gz`;
  const tmp = `${dst}.tmp`;
  let st;
  try { st = fs.lstatSync(src); } catch { return { ok: false, reason: 'missing' }; }
  if (!st.isFile()) return { ok: false, reason: 'not-regular-file' };
  if (fs.existsSync(dst)) return { ok: false, reason: 'gz-exists' };
  try {
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }));
    if (!(await verifyGzip(tmp, st.size))) throw new Error('gzip verification failed');
    fs.renameSync(tmp, dst);
    try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* age accounting only */ }
  } catch (e) {
    retention.jailedUnlink(jailRoots, dir, `${name}.gz.tmp`);
    return { ok: false, reason: `gzip-failed:${String(e.message || e).slice(0, 80)}` };
  }
  const r = retention.jailedUnlink(jailRoots, dir, name);
  let gzBytes = 0;
  try { gzBytes = fs.statSync(dst).size; } catch { /* stats only */ }
  return r.ok ? { ok: true, saved: Math.max(0, st.size - gzBytes) } : { ok: false, reason: `original-not-removed:${r.reason}` };
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function acquireLock(logsDir, now) {
  const file = path.join(logsDir, LOCK_NAME);
  fsx.ensureDir(logsDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      fs.closeSync(fd);
      return { acquired: true, file };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: false, error: e.code || String(e) };
      const lock = readJsonLoose(file);
      let fresh = false;
      // a lock file that exists but is not yet readable belongs to a process that is still writing it
      if (!lock) { try { fresh = Date.now() - fs.statSync(file).mtimeMs < 60000; } catch { fresh = false; } }
      const stale = !fresh && (!lock || !fsx.pidAlive(lock.pid) || (now - (lock.startedAt || 0)) > 2 * 3600 * 1000);
      if (!stale) return { acquired: false, held: true, pid: lock ? lock.pid : null };
      retention.jailedUnlink([logsDir], logsDir, LOCK_NAME);
    }
  }
  return { acquired: false, error: 'lock-contention' };
}

function diskUsage(dir, statfs) {
  try {
    const s = (statfs || fs.statfsSync)(dir);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const used = (Number(s.blocks) - Number(s.bfree)) * bsize;
    const avail = Number(s.bavail) * bsize;
    if (!(total > 0)) return { error: 'no-size' };
    const pct = (used + avail) > 0 ? (100 * used) / (used + avail) : 0;
    return { usedPct: Math.round(pct * 10) / 10, freeMb: Math.round(avail / 1048576), totalMb: Math.round(total / 1048576) };
  } catch (e) {
    return { error: e.code || String(e.message || e) };
  }
}

// shadow/ belongs to the screening package: only its pruneShadow may remove from it; a dry run counts with the same name and date rule.
function pruneShadowLog({ dir, days, now, dryRun, lib }) {
  let shadow = lib;
  if (!shadow) {
    try { shadow = require('./lib/screening/shadow'); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && /screening.shadow/.test(String(e.message))) return { skipped: 'screening shadow module not present' };
      return { error: `cannot load the shadow module: ${String(e && e.message || e).slice(0, 100)}` };
    }
  }
  if (!shadow || typeof shadow.pruneShadow !== 'function') return { skipped: 'pruneShadow not available' };
  try {
    if (dryRun) {
      const cutoff = require('./lib/time').londonParts(new Date(now - days * retention.DAY_MS)).ymd;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return { wouldDelete: 0, kept: 0 }; }
      let wouldDelete = 0;
      let kept = 0;
      for (const n of names) {
        const m = shadow.NAME_RE ? shadow.NAME_RE.exec(n) : null;
        if (!m) continue;
        if (m[1] < cutoff) wouldDelete++; else kept++;
      }
      return { wouldDelete, kept };
    }
    const r = shadow.pruneShadow({ dir, days, now: () => new Date(now) });
    return { deleted: r.deleted.length, kept: r.kept };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 100) };
  }
}

async function sweep(opts = {}) {
  const now = opts.now !== undefined ? opts.now : Date.now();
  const dryRun = !!opts.dryRun;
  const cfg = { ...retention.DEFAULTS, ...(opts.config || {}) };
  const dirs = {
    downloads: opts.downloads || paths.DOWNLOADS,
    runs: opts.runs || paths.RUNS,
    logs: opts.logs || paths.LOGS,
    screening: opts.screeningInput || path.join(paths.RUNTIME, 'screening-input'),
  };
  const jailRoots = [dirs.downloads, dirs.runs, dirs.logs, dirs.screening];
  const summary = {
    ok: true, dryRun, startedAt: new Date(now).toISOString(), refused: [], skipped: [],
    downloads: { scanned: 0, deleted: {}, bytesFreed: 0, kept: null, unpushedOrphans: 0, runResultsRepaired: 0, failures: [], truncated: false, files: [] },
    runs: { scanned: 0, deleted: 0, bytesFreed: 0, unknown: 0, failures: [] },
    logs: { scanned: 0, compressed: 0, rotated: 0, deleted: 0, bytesSaved: 0, failures: [] },
    screening: { scanned: 0, deleted: 0, bytesFreed: 0, kept: 0, failures: [] },
    shadow: null,
    disk: null, anomalies: [], errors: [],
  };
  let deleteBudget = cfg.maxDeletes;

  const unlink = (dir, name) => {
    if (opts.unlink) return opts.unlink(dir, name);
    return retention.jailedUnlink(jailRoots, dir, name);
  };
  const del = (dir, name, size) => {
    if (dryRun) return { ok: true, size, dry: true };
    return unlink(dir, name);
  };

  let lock = null;
  if (!dryRun) {
    lock = acquireLock(dirs.logs, now);
    if (!lock.acquired) {
      summary.skipped.push(lock.held ? `another sweep is running (pid ${lock.pid})` : `lock unavailable: ${lock.error}`);
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
  }

  try {
    // ---------------- downloads ----------------
    let db = null;
    let rowKeys = new Set();
    let allow = false;
    if (fs.existsSync(dirs.downloads)) {
      try {
        const Database = opts.Database || require('better-sqlite3');
        const dbPath = path.resolve(opts.db || paths.DB);
        db = new Database(dbPath, { readonly: dryRun, fileMustExist: true, timeout: 15000 });
        db.pragma('busy_timeout = 15000');
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_results'").get();
        if (!has) summary.refused.push('downloads: run_results table missing (run migrate-schema.js and backfill-run-results.js first)');
        else {
          const n = db.prepare('SELECT COUNT(*) AS n FROM run_results').get().n;
          if (n === 0) summary.refused.push('downloads: run_results is empty (run backfill-run-results.js first)');
          else {
            allow = true;
            rowKeys = new Set(db.prepare('SELECT run_key FROM run_results').all().map(r => r.run_key));
          }
        }
      } catch (e) {
        summary.refused.push(`downloads: cannot read run_results (${String(e.message || e).slice(0, 100)})`);
      }
    } else {
      summary.skipped.push('downloads: directory absent');
    }

    if (allow) {
      const entries = listEntries(dirs.downloads) || [];
      summary.downloads.scanned = entries.length;
      const resultsCache = new Map();
      const plan = retention.planDownloadsSweep({
        now, config: cfg, entries,
        readResults: name => {
          if (!resultsCache.has(name)) resultsCache.set(name, readJsonLoose(path.join(dirs.downloads, name)));
          return resultsCache.get(name);
        },
        readStatus: name => {
          const s = readJsonLoose(path.join(dirs.runs, name));
          return s && typeof s === 'object' ? s : null;
        },
        queueInfo: name => {
          const q = readJsonLoose(path.join(dirs.downloads, name));
          return q && Array.isArray(q.candidates) ? { candidates: q.candidates.length, jobTitle: q.jobTitle, location: q.location } : null;
        },
      });
      summary.downloads.kept = plan.kept;
      for (const an of plan.anomalies) summary.anomalies.push(an);

      const pushedStmt = { caterer: null, reed: null };
      const lookupPushed = (id, source) => {
        try {
          const key = source === 'reed' ? 'reed' : 'caterer';
          if (!pushedStmt[key]) pushedStmt[key] = db.prepare(key === 'reed' ? 'SELECT zoho_id FROM candidates WHERE reed_id = ?' : 'SELECT zoho_id FROM candidates WHERE caterer_id = ?');
          const row = pushedStmt[key].get(Number(id));
          return !!(row && row.zoho_id);
        } catch { return null; }
      };
      const repairMemo = new Map();
      const ensureRow = runKey => {
        if (repairMemo.has(runKey)) return repairMemo.get(runKey);
        let ok = false;
        if (rowKeys.has(runKey)) ok = true;
        else {
          const results = resultsCache.get(`phase2-results-${runKey}.json`);
          const row = results && typeof results === 'object' ? require('./backfill-run-results').buildRunResultRow(results, runKey, null) : null;
          if (row) {
            if (dryRun) { summary.downloads.runResultsRepaired++; ok = true; } else {
              try {
                require('./backfill-run-results').writeRunResultRow(db, row, { replace: false });
                rowKeys.add(runKey);
                summary.downloads.runResultsRepaired++;
                ok = true;
              } catch (e) { summary.downloads.failures.push({ name: `run_results:${runKey}`, reason: String(e.message || e).slice(0, 80) }); }
            }
          }
        }
        if (!ok) summary.anomalies.push({ code: 'run-results-missing-kept', runKey });
        repairMemo.set(runKey, ok);
        return ok;
      };

      const failed = new Set();
      const unpushed = [];
      for (const a of plan.actions) {
        if (deleteBudget <= 0) { summary.downloads.truncated = true; break; }
        if (a.dependsOn && failed.has(a.dependsOn)) { failed.add(a.name); continue; }
        if (a.requiresRunResult && !ensureRow(a.requiresRunResult)) { failed.add(a.name); continue; }
        let pushed = null;
        if ((a.kind === 'cv' || a.kind === 'candidate') && a.id) pushed = lookupPushed(a.id, a.source);
        const r = del(dirs.downloads, a.name, a.size);
        if (r.ok || r.reason === 'missing') {
          if (r.ok) {
            deleteBudget--;
            if (opts.list && summary.downloads.files.length < 500) summary.downloads.files.push({ name: a.name, kind: a.kind, reason: a.reason });
            summary.downloads.deleted[a.kind] = (summary.downloads.deleted[a.kind] || 0) + 1;
            summary.downloads.bytesFreed += r.size || 0;
            if ((a.kind === 'cv' || a.kind === 'candidate') && pushed !== true) unpushed.push({ kind: a.kind, id: a.id, source: a.source, dbKnown: pushed !== null });
          }
        } else {
          failed.add(a.name);
          summary.downloads.failures.push({ name: a.name, reason: r.reason });
        }
      }
      summary.downloads.unpushedOrphans = unpushed.length;
      if (unpushed.length) {
        summary.anomalies.push({ code: 'unpushed-orphans-deleted', count: unpushed.length, sampleIds: unpushed.slice(0, 20).map(u => u.id) });
        if (!dryRun) {
          for (const u of unpushed) fsx.appendLine(path.join(dirs.logs, 'retention-unpushed.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), ...u }));
        }
      }
    }
    if (db) { try { db.close(); } catch { /* ignore */ } }

    // ---------------- runs ----------------
    if (fs.existsSync(dirs.runs)) {
      const entries = listEntries(dirs.runs) || [];
      summary.runs.scanned = entries.length;
      for (const e of entries) {
        if (e.type !== 'file') continue;
        const kind = retention.classifyRunsName(e.name);
        if (kind === 'other') { summary.runs.unknown++; continue; }
        const limit = kind === 'tmp' ? (retention.isHardKillTmp('runs', e.name) ? cfg.hardKillTmpHours / 24 : cfg.tmpDays) : cfg.runsDays;
        if (retention.ageDays(now, e.mtimeMs) < limit) continue;
        if (deleteBudget <= 0) { summary.runs.truncated = true; break; }
        const r = del(dirs.runs, e.name, e.size);
        if (r.ok) { deleteBudget--; summary.runs.deleted++; summary.runs.bytesFreed += r.size || 0; }
        else if (r.reason !== 'missing') summary.runs.failures.push({ name: e.name, reason: r.reason });
      }
    }

    // ---------------- logs ----------------
    if (fs.existsSync(dirs.logs)) {
      const entries = listEntries(dirs.logs) || [];
      summary.logs.scanned = entries.length;
      const rotateBytes = cfg.jsonlRotateMB * 1048576;
      for (const e of entries) {
        if (e.type !== 'file' || e.name === LOCK_NAME) continue;
        const age = retention.ageDays(now, e.mtimeMs);
        if (e.name.endsWith('.gz')) {
          if (age >= cfg.logDeleteDays) {
            const r = del(dirs.logs, e.name, e.size);
            if (r.ok) summary.logs.deleted++; else if (r.reason !== 'missing') summary.logs.failures.push({ name: e.name, reason: r.reason });
          }
          continue;
        }
        if (e.name.endsWith('.tmp')) {
          if (age >= cfg.tmpDays) {
            const r = del(dirs.logs, e.name, e.size);
            if (r.ok) summary.logs.deleted++; else if (r.reason !== 'missing') summary.logs.failures.push({ name: e.name, reason: r.reason });
          }
          continue;
        }
        const textLog = /\.(log|err|out|txt)$/i.test(e.name);
        const rotatedJsonl = /\.jsonl\.[A-Za-z0-9_-]+$/.test(e.name);
        const activeJsonl = /\.jsonl$/.test(e.name);
        if ((textLog || rotatedJsonl) && age >= cfg.logCompressDays) {
          if (dryRun) { summary.logs.compressed++; continue; }
          const r = await gzipInPlace(jailRoots, dirs.logs, e.name);
          if (r.ok) { summary.logs.compressed++; summary.logs.bytesSaved += r.saved; }
          else summary.logs.failures.push({ name: e.name, reason: r.reason });
          continue;
        }
        if ((textLog || activeJsonl) && e.size > rotateBytes && (now - e.mtimeMs) >= QUIET_MS) {
          if (dryRun) { summary.logs.rotated++; continue; }
          const rotated = `${e.name}.${stamp(now)}`;
          try {
            fs.renameSync(path.join(dirs.logs, e.name), path.join(dirs.logs, rotated));
            summary.logs.rotated++;
            const r = await gzipInPlace(jailRoots, dirs.logs, rotated);
            if (r.ok) { summary.logs.compressed++; summary.logs.bytesSaved += r.saved; } else summary.logs.failures.push({ name: rotated, reason: r.reason });
          } catch (err) {
            summary.logs.failures.push({ name: e.name, reason: `rotate-failed:${err.code || 'ERR'}` });
          }
        }
      }
    }

    // ---------------- screening input (snippets of a hard-killed screening call) ----------------
    if (fs.existsSync(dirs.screening)) {
      const entries = listEntries(dirs.screening) || [];
      summary.screening.scanned = entries.length;
      for (const e of entries) {
        if (e.type !== 'file') continue;
        if (retention.ageDays(now, e.mtimeMs) < cfg.screeningInputHours / 24) { summary.screening.kept++; continue; }
        if (deleteBudget <= 0) { summary.screening.truncated = true; break; }
        const r = del(dirs.screening, e.name, e.size);
        if (r.ok) { deleteBudget--; summary.screening.deleted++; summary.screening.bytesFreed += r.size || 0; }
        else if (r.reason !== 'missing') summary.screening.failures.push({ name: e.name, reason: r.reason });
      }
    }

    // ---------------- shadow log (owned by the screening package) ----------------
    summary.shadow = pruneShadowLog({ dir: opts.shadow || paths.SHADOW, days: cfg.shadowDays, now, dryRun, lib: opts.shadowLib });

    // ---------------- disk ----------------
    const usage = diskUsage(path.dirname(path.resolve(dirs.downloads)), opts.statfs);
    summary.disk = { ...usage, thresholdPct: cfg.diskThresholdPct, alert: false };
    if (usage.usedPct !== undefined && usage.usedPct > cfg.diskThresholdPct) {
      summary.disk.alert = true;
      if (!dryRun) notify({ severity: 'critical', key: 'disk-usage', text: `Disk ${usage.usedPct}% used (${usage.freeMb} MB free); threshold ${cfg.diskThresholdPct}%.`, meta: usage });
    }

    // ---------------- alerts ----------------
    if (!dryRun) {
      if (summary.refused.length) notify({ severity: 'warn', key: 'retention-refused', text: `Retention sweep did not touch downloads/: ${summary.refused[0]}` });
      const un = summary.anomalies.find(a => a.code === 'unpushed-orphans-deleted');
      if (un) notify({ severity: 'warn', key: 'retention-unpushed-deleted', text: `${un.count} CV/candidate file(s) older than ${cfg.orphanDays} days were deleted without a Zoho id (ids in logs/retention-unpushed.jsonl).`, meta: { count: un.count } });
      const stranded = summary.anomalies.filter(a => a.code === 'stranded-queue-deleted');
      if (stranded.length) notify({ severity: 'warn', key: 'retention-stranded-queue-deleted', text: `${stranded.length} queue file(s) that never completed Phase 2 were deleted after ${cfg.orphanDays} days (${stranded.reduce((n, a) => n + a.candidates, 0)} candidates).`, meta: { count: stranded.length } });
      const kept = summary.anomalies.filter(a => a.code === 'run-results-missing-kept');
      if (kept.length) notify({ severity: 'warn', key: 'retention-run-results-missing', text: `${kept.length} results file(s) kept because their run_results row could not be written.`, meta: { count: kept.length } });
      const nFail = summary.downloads.failures.length + summary.runs.failures.length + summary.logs.failures.length
        + summary.screening.failures.length + (summary.shadow && summary.shadow.error ? 1 : 0);
      if (nFail) notify({ severity: 'warn', key: 'retention-delete-errors', text: `Retention sweep: ${nFail} file operation(s) failed (see summary).`, meta: { count: nFail } });
    }
  } catch (e) {
    summary.ok = false;
    summary.errors.push(String(e && e.message || e));
  } finally {
    if (lock && lock.acquired) retention.jailedUnlink([dirs.logs], dirs.logs, LOCK_NAME);
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

const HELP = `Usage: node scripts/retention-sweep.js [options]
  --dry-run                 report only; change nothing (no deletes, no gzip, no DB writes)
  --pretty                  indent the JSON summary
  --list                    include the names of deleted downloads/ files (first 500) in the summary
  --now <iso>               treat this instant as "now" (tests)
  --max-delete <n>          per-run deletion budget (default ${retention.DEFAULTS.maxDeletes})
  --queue-days <n>          queue/results retention after Phase 2 completed (default ${retention.DEFAULTS.queueAfterCompleteDays})
  --orphan-days <n>         orphan CV / candidate JSON / stranded queue age (default ${retention.DEFAULTS.orphanDays})
  --runs-days <n>           runs/ file age (default ${retention.DEFAULTS.runsDays})
  --log-compress-days <n>   (default ${retention.DEFAULTS.logCompressDays})   --log-delete-days <n> (default ${retention.DEFAULTS.logDeleteDays})
  --disk-threshold <pct>    critical alert above this usage (default ${retention.DEFAULTS.diskThresholdPct})
  --tmp-hours <n>           hard-kill *.tmp leftovers of known files in downloads/ and runs/ (default ${retention.DEFAULTS.hardKillTmpHours})
  --screening-input-hours <n>  runtime/screening-input/ files (default ${retention.DEFAULTS.screeningInputHours})
  --shadow-days <n>         shadow/ daily screening logs, at least 1 (default ${retention.DEFAULTS.shadowDays})
Directories come from RESOURCER_HOME (paths.js); nothing outside downloads/, runs/, logs/, runtime/screening-input/ and the
shadow/ daily files is ever deleted; state/ and secrets/ are never touched.
Exit: 0 ok, 1 unexpected failure, 2 usage.`;

function parseArgs(argv) {
  const o = { config: {} };
  const num = (flag, v) => { const n = Number(v); if (!(n >= 0)) throw new Error(`${flag} needs a non-negative number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--pretty') o.pretty = true;
    else if (a === '--list') o.list = true;
    else if (a === '--now') { const t = new Date(argv[++i]).getTime(); if (Number.isNaN(t)) throw new Error('--now needs an ISO time'); o.now = t; }
    else if (a === '--max-delete') o.config.maxDeletes = num(a, argv[++i]);
    else if (a === '--queue-days') o.config.queueAfterCompleteDays = num(a, argv[++i]);
    else if (a === '--orphan-days') o.config.orphanDays = num(a, argv[++i]);
    else if (a === '--runs-days') o.config.runsDays = num(a, argv[++i]);
    else if (a === '--log-compress-days') o.config.logCompressDays = num(a, argv[++i]);
    else if (a === '--log-delete-days') o.config.logDeleteDays = num(a, argv[++i]);
    else if (a === '--disk-threshold') o.config.diskThresholdPct = num(a, argv[++i]);
    else if (a === '--tmp-hours') o.config.hardKillTmpHours = num(a, argv[++i]);
    else if (a === '--screening-input-hours') o.config.screeningInputHours = num(a, argv[++i]);
    else if (a === '--shadow-days') { o.config.shadowDays = num(a, argv[++i]); if (o.config.shadowDays < 1) throw new Error('--shadow-days needs a number of at least 1'); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(`${HELP}\n`); return 0; }
  const summary = await sweep(opts);
  process.stdout.write(`${JSON.stringify(summary, null, opts.pretty ? 2 : 0)}\n`);
  return summary.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`FATAL: ${err && err.message}\n`);
    process.exit(1);
  });
}

module.exports = { sweep, main, parseArgs, gzipInPlace, diskUsage, pruneShadowLog };
