#!/usr/bin/env node
/**
 * run-lock.js
 *
 * Filesystem-based pipeline concurrency guard.
 *
 * TWO MODES:
 *   --global        Block if ANY pipeline is active (prevents all concurrency bugs:
 *                   shared browser session, shared cookie file, session drift).
 *   --check         Legacy per-job+location check (kept for backward compat).
 *
 * Active = status is one of the in-flight states AND the run file was updated
 * within the per-status MAX_AGE threshold.
 *
 * Exit codes:
 *   0 = clear (no active run)
 *   2 = blocked (active run found - JSON details on stdout)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { RUNS_DIR, RUN_STATUS } = require('./constants');

// Per-status max age (minutes) before a run is considered stale/crashed.
// INITIALIZING is intentionally short so failed startups retry quickly.
// Longer window for active scraping/phase2 phases in case the network is slow.
// If a run file hasn't been updated within these thresholds, the run
// is considered dead and the lock is automatically released.
// phase1_running: the scraper updates the file on every page (~15-30s per page).
// If no update in 30 min, the run has definitely crashed.
// phase2 statuses: process-approved-queue.js runs fast (<5 min total).
const STATUS_MAX_AGE = {
  [RUN_STATUS.INITIALIZING]: 20,  // 20 min - session setup (browser restore, login, search) takes 10-15 min under load
  'phase1_taking_over':      5,  // transient bridge state - should transition to phase1_running within minutes
  // phase1_stale is terminal - not listed here, so it's automatically ignored by the lock
  [RUN_STATUS.SEARCHING]:    30,  // search navigating Caterer search form - can take minutes under load
  [RUN_STATUS.ACTIVE]:       60,  // phase1_active - pipeline actively scraping (variant of running)
  [RUN_STATUS.RUNNING]:      60,  // 60 min - AI screening batches can take 10+ min between page updates
  [RUN_STATUS.PHASE2_START]: 30,
  [RUN_STATUS.PHASE2_PUSH]:  30,
  [RUN_STATUS.COMPLETE]:     10,  // Phase 1 -> Phase 2 handoff takes <10s normally; 10min is generous
};

/**
 * Normalise a job title / location for comparison (lowercase, trimmed).
 */
function normalise(s) {
  return (s || '').toLowerCase().trim();
}

/**
 * Return all active runs from runs/*.json
 * @param {string} [runsDir]
 * @returns {{ id, jobTitle, location, status, updatedAt, file }[]}
 */
function getActiveRuns(runsDir) {
  const dir = runsDir || RUNS_DIR;
  if (!fs.existsSync(dir)) return [];

  const names = fs.readdirSync(dir);

  // Pre-scan: collect all completed run-*.json files so we can cross-reference.
  // A phase1_complete file is NOT active if a matching run-*.json already shows "complete".
  const completedRunTimestamps = new Set();
  for (const file of names) {
    if (!file.startsWith('run-') || !file.endsWith('.json')) continue;
    try {
      const raw  = fs.readFileSync(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw);
      if (data.status === 'complete') {
        // Extract timestamp portion: run-2026-03-17-15-51.json -> 2026-03-17-15-51
        const ts = file.replace(/^run-/, '').replace(/\.json$/, '');
        completedRunTimestamps.add(ts);
      }
    } catch { /* skip */ }
  }

  const active = [];

  for (const file of names) {
    if (!file.endsWith('.json')) continue;

    try {
      const raw  = fs.readFileSync(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw);

      // Only track known in-flight statuses
      const maxAgeMins = STATUS_MAX_AGE[data.status];
      if (!maxAgeMins) continue;

      // If this is a phase1_complete file, check if Phase 2 already finished.
      // A matching run-*.json with status "complete" means the pipeline is done -
      // the phase1 file just wasn't updated to a terminal status.
      if (data.status === RUN_STATUS.COMPLETE) {
        const ts = file.replace(/^phase1-/, '').replace(/\.json$/, '');
        if (completedRunTimestamps.has(ts)) continue; // Pipeline done - not blocking
      }

      // Age check - use per-status threshold
      const updated = data.updatedAt || data.startedAt || null;
      const cutoff  = Date.now() - maxAgeMins * 60 * 1000;
      if (updated && new Date(updated).getTime() < cutoff) continue;

      active.push({
        id:        data.id || file.replace('.json', ''),
        jobTitle:  data.jobTitle  || data.job_title || '',
        location:  data.location  || '',
        status:    data.status,
        updatedAt: updated,
        file,
      });
    } catch {
      // Unreadable/corrupt file - skip
    }
  }

  return active;
}

/**
 * GLOBAL lock - block if ANY pipeline is currently active.
 * This is the primary guard: only one pipeline at a time.
 *
 * @param {string} [runsDir]
 * @returns {{ blocked: boolean, activeCount: number, blockingRun?: object, activeRuns?: object[] }}
 */
function checkGlobalLock(runsDir, opts = {}) {
  const { skipFileBasename } = opts; // caller passes its own bridge basename to avoid self-block
  let active = getActiveRuns(runsDir);
  if (skipFileBasename) {
    active = active.filter(r => r.file !== skipFileBasename);
  }
  if (active.length > 0) {
    return {
      blocked:     true,
      activeCount: active.length,
      blockingRun: active[0],          // primary blocker (most useful for logging)
      activeRuns:  active,             // all active runs for diagnostics
    };
  }
  return { blocked: false, activeCount: 0 };
}

/**
 * Match a territory against an already-computed list of active runs.
 * Lets callers that test many territories scan runs/ once instead of once per territory.
 *
 * @param {object[]} active  result of getActiveRuns()
 * @param {string} jobTitle
 * @param {string} location
 * @returns {{ blocked: boolean, blockingRun?: object }}
 */
function checkRunLockAgainst(active, jobTitle, location) {
  const normTitle    = normalise(jobTitle);
  const normLocation = normalise(location);

  const blocking = active.find(
    r => normalise(r.jobTitle) === normTitle && normalise(r.location) === normLocation
  );

  if (blocking) {
    return { blocked: true, blockingRun: blocking };
  }
  return { blocked: false };
}

/**
 * Per-job+location lock (legacy) - block only if same territory is active.
 *
 * @param {string} jobTitle
 * @param {string} location
 * @param {string} [runsDir]
 * @returns {{ blocked: boolean, blockingRun?: object }}
 */
function checkRunLock(jobTitle, location, runsDir) {
  return checkRunLockAgainst(getActiveRuns(runsDir), jobTitle, location);
}

const USAGE = `Usage:
  node scripts/run-lock.js --global [--skip-file=<basename>]
      exits 0 if no pipeline is active, exits 2 if any is (prints JSON)
  node scripts/run-lock.js --check JOB_TITLE=<title> LOCATION=<loc>
      exits 0 if free, exits 2 if blocked for that territory, exits 1 on bad usage
  node scripts/run-lock.js
      lists all active runs (diagnostic)`;

/**
 * CLI mode: see USAGE.
 */
if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (argv.includes('--global')) {
    // --skip-file=<basename> lets the caller exclude its own bridge file from the
    // lock check, preventing a self-block right after bridge-clear flips its status.
    const skipArg = argv.find(a => a.startsWith('--skip-file='));
    const skipFileBasename = skipArg ? skipArg.slice('--skip-file='.length) : undefined;
    const result = checkGlobalLock(undefined, { skipFileBasename });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.blocked ? 2 : 0);
  }

  if (argv.includes('--check')) {
    const getArg = (key) => {
      const a = argv.find(a => a.startsWith(`${key}=`));
      return a ? a.slice(key.length + 1) : '';
    };
    const jobTitle = getArg('JOB_TITLE');
    const location = getArg('LOCATION');

    if (!jobTitle || !location) {
      console.error('Usage: node run-lock.js --check JOB_TITLE=<title> LOCATION=<loc>');
      process.exit(1);
    }

    const result = checkRunLock(jobTitle, location);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.blocked ? 2 : 0);
  }

  // Default: list all active runs
  const runs = getActiveRuns();
  console.log(JSON.stringify({ activeRuns: runs }, null, 2));
}

module.exports = { checkRunLock, checkRunLockAgainst, checkGlobalLock, getActiveRuns, STATUS_MAX_AGE };
