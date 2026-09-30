#!/usr/bin/env node
/**
 * recover-stranded-phase1.js
 *
 * Auto-recovery for the "stranded phase1_complete" failure mode.
 *
 * Failure pattern (observed 2026-05-15 on CH65):
 *   run-pipeline.js dies after Phase 1 finishes but before
 *   Phase 2 (Zoho push) completes. Result:
 *     phase1-*.json     status="phase1_complete" phase2Status="pending"
 *     phase1-*.json.run-lock  contains a now-dead pid
 *     downloads/approved-queue-<ts>.json  candidates ready to push
 *
 * cull-ghost-phase1.js does NOT cover this case (its ghost thresholds only
 * apply to in-flight statuses like phase1_initializing / phase1_running).
 * The run-lock's pid-alive check would let a fresh run-pipeline.js take over
 * - but nothing re-invokes it on its own, so the queue file sits forever.
 *
 * This script:
 *   1. Finds phase1-*.json with status=phase1_complete, phase2Status=pending.
 *   2. Confirms it's stale (>15 min since updatedAt) AND that the .run-lock
 *      (if present) holds a dead pid.
 *   3. Locates the matching approved-queue file by timestamp.
 *   4. Starts a detached recovery:
 *        sources=both    -> run-pipeline.js --status-file <fp>  (handles Reed+merge+phase2)
 *        sources=caterer -> process-approved-queue.js <queueFile>
 *   5. Removes the dead run-lock so the new child can acquire a fresh one.
 *
 * A second failure mode is recovered the same way (recoverInterrupted): a phase 1 or a Phase 2
 * that was killed mid-run (instance restart, OOM, kill -9) leaves its status file phase1_abandoned
 * (or phase2_starting) and an approved-queue file whose candidates are already unlocked in the
 * database - so no later run would ever push them. Phase 2 is started for that queue; a checkpoint
 * queue (written after every page, no phase1Stats) is marked incomplete so Phase 2 pushes what was
 * unlocked but keeps the territory and its pending search for a full re-run.
 *
 * A both-source run pushes a merged queue (Caterer plus Reed candidates, downloads/merged-queue-<ts>.json) that never
 * maps to phase1-<ts>. When such a run was killed in Phase 2, the newest merged queue of the same job title and location
 * written since the run started is recovered instead of the Caterer-only approved queue, and its own results file
 * (phase2-results-merged-queue-<ts>.json) tells whether Phase 2 had already finished.
 *
 * Hard age guard: never recover a phase1 older than 7 days (avoid resurrecting
 * ancient orphans from before this script existed).
 *
 * The child's stdout/stderr go to logs/recover-<id>-<ts>.log (never to the parent's pipes,
 * so a supervising cron job cannot stall on them).
 *
 * Output:
 *   RECOVERY_OK n=<n> <id1>(pid=<x>),<id2>(pid=<y>)
 *   RECOVERY_NONE
 *   RECOVERY_ERR <message>
 *
 * Exit always 0. This is a best-effort helper invoked by cull-ghost-phase1.js;
 * its failures must never block the watchdog.
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');

const WORKSPACE = paths.HOME;
const RUNS_DIR  = paths.RUNS;
const DOWNLOADS = paths.DOWNLOADS;
const SCRIPTS   = paths.SCRIPTS;
const LOGS      = paths.LOGS;

const STALE_MIN     = 15;
const MAX_AGE_DAYS  = 7;
const LOCK_MAX_MIN  = 60;
const INTERRUPTED_STATUSES = new Set(['phase1_abandoned', 'phase2_starting']);
const INTERRUPTED_MIN_AGE_MIN = 3;
const MAX_RECOVERY_ATTEMPTS = 3;

function isPhase1File(name) {
  return name.startsWith('phase1-') && name.endsWith('.json');
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function ageMinutes(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function findApprovedQueueFor(statusFile) {
  // phase1-<ts>.json -> downloads/approved-queue-<ts>.json
  const base = path.basename(statusFile, '.json');
  const m = base.match(/^phase1-(.+)$/);
  if (!m) return null;
  const direct = path.join(DOWNLOADS, `approved-queue-${m[1]}.json`);
  return fs.existsSync(direct) ? direct : null;
}

const norm = (v) => String(v || '').trim().toLowerCase();

// The merged queue a both-source Phase 2 was working on: same title and location, written after the run began.
function findMergedQueueFor(data) {
  if (data.sources !== 'both') return null;
  const since = Date.parse(data.startedAt || '');
  if (!Number.isFinite(since)) return null;
  let names;
  try { names = fs.readdirSync(DOWNLOADS); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!/^merged-queue-.*\.json$/.test(name)) continue;
    const file = path.join(DOWNLOADS, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < since || (best && st.mtimeMs <= best.mtimeMs)) continue;
    const q = safeReadJson(file);
    if (!q || q.sources !== 'both' || !Array.isArray(q.candidates)) continue;
    if (norm(q.jobTitle) !== norm(data.jobTitle) || norm(q.location) !== norm(data.location)) continue;
    best = { file, queue: q, mtimeMs: st.mtimeMs };
  }
  return best;
}

// Start `node <args>` detached, with stdout/stderr appended to a log file.
function startDetached(args, logName) {
  let fd;
  try {
    fsx.ensureDir(LOGS);
    fd = fs.openSync(path.join(LOGS, logName), 'a');
  } catch {
    fd = 'ignore';
  }
  try {
    const child = spawn(paths.NODE, args, {
      detached: true,
      stdio:    ['ignore', fd, fd],
      cwd:      WORKSPACE,
      windowsHide: true,
    });
    child.on('error', () => { /* start failures are picked up again on the next pass */ });
    child.unref();
    return child;
  } finally {
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function recoverStranded() {
  if (!fs.existsSync(RUNS_DIR)) return { recovered: [] };

  const recovered = [];
  const ageDayCutoffMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!isPhase1File(f)) continue;
    const fp = path.join(RUNS_DIR, f);
    const data = safeReadJson(fp);
    if (!data || data.status !== 'phase1_complete') continue;
    if (data.phase2Status !== 'pending') continue;

    // Age guard: never resurrect anything older than 7 days
    const refTs = data.startedAt || data.updatedAt;
    if (refTs && (now - new Date(refTs).getTime()) > ageDayCutoffMs) continue;

    // Staleness: status hasn't moved in STALE_MIN min
    if (ageMinutes(data.updatedAt || data.startedAt) < STALE_MIN) continue;

    // Run-lock check: present + alive pid -> real run is still active, skip.
    // Otherwise remove the stale lock so the new child can acquire fresh.
    // A lock older than LOCK_MAX_MIN is stale even if its pid answers: after an instance
    // restart the pid may have been reused by an unrelated process. This is the same rule
    // run-pipeline.js applies when it takes over a lock.
    const lockPath = fp + '.run-lock';
    if (fs.existsSync(lockPath)) {
      const lock = safeReadJson(lockPath);
      if (lock && fsx.pidAlive(lock.pid) && ((now - (lock.startedAt || 0)) / 60000) < LOCK_MAX_MIN) continue;
      fsx.safeUnlink(lockPath);
    }

    // For sources=caterer the queue file is required (direct phase 2).
    // For sources=both, run-pipeline.js will discover the queue itself.
    const queueFile = findApprovedQueueFor(fp);
    const useRunPipeline = (data.sources === 'both');
    if (!useRunPipeline && !queueFile) continue; // nothing to push, nothing to do

    const args = useRunPipeline
      ? [path.join(SCRIPTS, 'run-pipeline.js'), '--status-file', fp]
      : [path.join(SCRIPTS, 'process-approved-queue.js'), queueFile];

    const id = data.id || f.replace('.json', '');
    let child;
    try {
      child = startDetached(args, `recover-${id}-${Date.now()}.log`);
    } catch (e) {
      continue; // start failed - leave it for next pass
    }

    recovered.push({
      id,
      sources:  data.sources || 'caterer',
      pid:      child.pid,
      queue:    queueFile ? path.basename(queueFile) : null,
      mode:     useRunPipeline ? 'run-pipeline' : 'process-approved-queue',
    });
  }

  return { recovered };
}

// Phase 1 / Phase 2 killed mid-run: push the candidates that were already unlocked (see the header).
function recoverInterrupted(opts) {
  const o = opts || {};
  const recovered = [];
  if (!fs.existsSync(RUNS_DIR)) return { recovered };
  const now = Date.now();
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!isPhase1File(f)) continue;
    const fp = path.join(RUNS_DIR, f);
    const data = safeReadJson(fp);
    if (!data || !INTERRUPTED_STATUSES.has(data.status) || data.phase2Complete) continue;
    if ((now - new Date(data.startedAt || data.updatedAt).getTime()) > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) continue;
    if (ageMinutes(data.updatedAt || data.startedAt) < (o.minAgeMin === undefined ? INTERRUPTED_MIN_AGE_MIN : o.minAgeMin)) continue;

    const merged = data.status === 'phase2_starting' ? findMergedQueueFor(data) : null;
    const queueFile = merged ? merged.file : findApprovedQueueFor(fp);
    if (!queueFile) continue;
    const queue = merged ? merged.queue : safeReadJson(queueFile);
    if (!queue || !Array.isArray(queue.candidates) || queue.candidates.length === 0) continue;

    const ts = path.basename(fp, '.json').slice('phase1-'.length);
    const resultsName = merged ? `phase2-results-${path.basename(queueFile, '.json')}.json` : `phase2-results-${ts}.json`;
    const results = safeReadJson(path.join(DOWNLOADS, resultsName));
    if (results && results.completedAt) {
      // Phase 2 finished; only the status file was left behind.
      Object.assign(data, { status: 'complete', phase2Complete: true, updatedAt: new Date().toISOString() });
      try { fsx.writeJsonAtomic(fp, data); } catch { /* next pass */ }
      continue;
    }

    const rec = data.phase2Recovery && typeof data.phase2Recovery === 'object' ? data.phase2Recovery : { attempts: 0 };
    if (rec.pid && fsx.pidAlive(rec.pid) && ageMinutes(rec.at) < LOCK_MAX_MIN) continue;
    if (rec.attempts >= MAX_RECOVERY_ATTEMPTS) {
      if (!rec.gaveUp) {
        rec.gaveUp = true;
        data.phase2Recovery = rec;
        try { fsx.writeJsonAtomic(fp, data); } catch { /* next pass */ }
        try {
          require('./lib/notify').notify({ severity: 'warn', key: 'stranded-unrecoverable', text: `${queue.candidates.length} unlocked candidate(s) of ${data.jobTitle || 'a run'} in ${data.location || '?'} could not be pushed after ${rec.attempts} recovery attempts (queue file ${path.basename(queueFile)}). Run: node scripts/process-approved-queue.js downloads/${path.basename(queueFile)} (docs/OPERATIONS.md).` });
        } catch { /* alerting never throws */ }
      }
      continue;
    }

    if (!queue.phase1Stats) {
      queue.phase1Stats = { incomplete: 'run-interrupted' };
      try { fsx.writeJsonAtomic(queueFile, queue, 0o600); } catch { continue; }
    }
    let child;
    try {
      child = startDetached([path.join(SCRIPTS, 'process-approved-queue.js'), queueFile], `recover-${data.id || ts}-${Date.now()}.log`);
    } catch { continue; }
    data.phase2Recovery = { attempts: rec.attempts + 1, pid: child.pid, at: new Date().toISOString(), mode: 'process-approved-queue' };
    try { fsx.writeJsonAtomic(fp, data); } catch { /* the pid guard is best effort */ }
    try {
      require('./lib/notify').notify({ severity: 'info', key: 'stranded-recovered', text: `A run for ${data.jobTitle || '?'} in ${data.location || '?'} was interrupted; pushing its ${queue.candidates.length} already-unlocked candidate(s) now (attempt ${rec.attempts + 1}).` });
    } catch { /* alerting never throws */ }
    recovered.push({ id: data.id || ts, sources: data.sources || 'caterer', pid: child.pid, queue: path.basename(queueFile), mode: 'process-approved-queue' });
  }
  return { recovered };
}

function main() {
  let result;
  try {
    result = recoverStranded();
    const more = recoverInterrupted();
    result.recovered = result.recovered.concat(more.recovered);
  } catch (err) {
    console.log(`RECOVERY_ERR ${err.message || err}`);
    return;
  }

  if (result.recovered.length === 0) {
    console.log('RECOVERY_NONE');
    return;
  }

  const summary = result.recovered
    .map(r => `${r.id}(pid=${r.pid},mode=${r.mode})`)
    .join(',');
  console.log(`RECOVERY_OK n=${result.recovered.length} ${summary}`);
}

if (require.main === module) {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    console.log('Usage: node scripts/recover-stranded-phase1.js\nRestarts Phase 2 for stale phase1_complete runs whose run-lock owner is dead.\nPrints RECOVERY_OK n=<n> ... | RECOVERY_NONE | RECOVERY_ERR <msg>; always exits 0.');
    process.exit(0);
  }
  try { main(); } catch (err) { console.log(`RECOVERY_ERR ${err.message || err}`); }
  process.exit(0);
}

module.exports = { recoverStranded, recoverInterrupted, findMergedQueueFor };
