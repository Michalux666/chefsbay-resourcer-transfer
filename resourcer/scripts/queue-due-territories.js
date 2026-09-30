#!/usr/bin/env node
/**
 * queue-due-territories.js
 *
 * Deterministic, zero-LLM safety net that queues any due territory (from
 * territory_searches) that isn't already sitting in pending-searches/ or
 * currently running.
 *
 * Why this exists (2026-07-23): the old daily 06:00 scheduler cron was
 * LLM-driven and depended on several services being up at that exact moment. If the
 * machine was asleep/down then, or the cron's agent turn failed partway through,
 * NOTHING got queued for the day until someone noticed and queued manually. This
 * recurred repeatedly (2026-07-13, 07-14, 07-16, 07-19, 07-20, 07-22).
 *
 * This script is idempotent and side-effect-free when there's nothing new to
 * do, so it's safe to run every few minutes as a backstop (piggybacking on
 * the watchdog's 5-min maintenance tick) with zero LLM tokens.
 *
 * Idempotency: a due territory is skipped if EITHER:
 *   - any file in pending-searches/ has a matching (jobTitle, location) pair
 *     - checked by reading file CONTENTS, not filenames, since not every
 *     pending file follows the territory-<id>-... naming convention; or
 *   - the run-lock reports it as actively running; or
 *   - it sits in pending-searches/.quarantine/ (the watchdog took it out of the queue after repeated failures):
 *     re-queueing it here would only start the same failing runs again. It comes back with
 *     pipeline-watchdog.js --release-quarantine.
 * Known minor limitation: a pending file that fails to parse (corrupt/BOM)
 * is skipped when building the "already queued" set, so in the rare case of
 * a corrupt file this could create a duplicate pending file for the same
 * territory. Existing corruption self-heal (pending-gate.js strips BOM on
 * read) means this self-corrects on the next tick either way.
 *
 * Usage:
 *   node scripts/queue-due-territories.js [--dry-run] [--json] [--quiet]
 *
 * Exit codes: 0 = ran (queued 0 or more), 1 = error
 */
'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { londonParts } = require('./lib/time');
const { getDueTerritories } = require('./territory-utils');
const { getActiveRuns, checkRunLockAgainst } = require('./run-lock');

const PENDING_DIR = paths.PENDING;
const QUARANTINE_DIR = path.join(PENDING_DIR, '.quarantine');

function normKey(jobTitle, location) {
  return `${(jobTitle || '').toLowerCase().trim()}|${(location || '').toLowerCase().trim()}`;
}

// Build the set of (jobTitle, location) pairs already sitting in
// pending-searches/, read from file CONTENTS (not filenames).
function loadKeysFrom(dir) {
  const keys = new Set();
  if (!fs.existsSync(dir)) return keys;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      let raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const d = JSON.parse(raw);
      keys.add(normKey(d.jobTitle, d.location));
    } catch { /* unreadable/corrupt - self-heals via pending-gate's BOM strip on read */ }
  }
  return keys;
}

function loadQueuedKeys() {
  return loadKeysFrom(PENDING_DIR);
}

function loadQuarantinedKeys() {
  return loadKeysFrom(QUARANTINE_DIR);
}

// Same Reed daily-budget check as territory-scheduler.js (kept in sync
// deliberately duplicated rather than shared, so this script has zero
// dependency on that file and can't be broken by changes to it).
function reedBudgetAvailable(db) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const row = db.prepare('SELECT profile_views, daily_limit FROM reed_daily_usage WHERE date = ?').get(today);
    if (!row) return true;
    const used = row.profile_views || 0;
    const limit = row.daily_limit || 300;
    return used < limit;
  } catch {
    return true;
  }
}

// The pending-search payload for one due territory (same shape as the legacy scheduler wrote).
function buildPayload(r, sources, reedBudgetSkipped, nowIso) {
  return {
    jobTitle: r.job_title,
    location: r.location,
    keywords: r.keywords || '',
    priority: r.priority,
    sources,
    distance: r.distance,
    activeWithin: r.active_within,
    cvLimit: parseInt(r.cv_limit, 10) || 20,
    overrides: [],
    requestedAt: nowIso,
    source: 'queue-due-territories-autocatchup',
    ...(reedBudgetSkipped ? { reedBudgetSkipped: true } : {}),
  };
}

function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: node scripts/queue-due-territories.js [--dry-run] [--json] [--quiet]\nQueues every due territory that is not already in pending-searches/ or running. Exit 0 = ran, 1 = error.');
    return 0;
  }
  const dryRun = argv.includes('--dry-run');
  const jsonMode = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const log = (msg) => { if (!quiet) console.log(msg); };

  const db = new Database(paths.DB, { readonly: true });
  let allDue;
  let reedOk;
  try {
    allDue = getDueTerritories(db);
    reedOk = reedBudgetAvailable(db);
  } finally {
    db.close();
  }

  const queuedKeys = loadQueuedKeys();
  const quarantinedKeys = loadQuarantinedKeys();
  // One scan of runs/ for the whole batch, and only if something needs it (the legacy code
  // scanned once per due territory, which hung the scheduler when runs/ was large).
  let activeRuns = null;

  const toQueue = [];
  const skippedQueued = [];
  const skippedRunning = [];
  const skippedQuarantined = [];

  for (const r of allDue) {
    const key = normKey(r.job_title, r.location);
    if (queuedKeys.has(key)) { skippedQueued.push(r); continue; }
    if (quarantinedKeys.has(key)) { skippedQuarantined.push(r); continue; }
    if (activeRuns === null) activeRuns = getActiveRuns();
    const lock = checkRunLockAgainst(activeRuns, r.job_title, r.location);
    if (lock.blocked) { skippedRunning.push(r); continue; }
    toQueue.push(r);
  }

  if (toQueue.length === 0) {
    const summary = {
      status: 'nothing_to_queue',
      due: allDue.length,
      alreadyQueued: skippedQueued.length,
      alreadyRunning: skippedRunning.length,
      queued: 0,
    };
    if (skippedQuarantined.length) summary.alreadyQuarantined = skippedQuarantined.length;
    if (jsonMode) console.log(JSON.stringify(summary));
    else log(`queue-due-territories: nothing to queue (${allDue.length} due, ${skippedQueued.length} already queued, ${skippedRunning.length} running)`);
    return 0;
  }

  let created = 0;
  const createdFiles = [];
  if (!dryRun) {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const lp = londonParts(now);
    const timePart = `${String(lp.hour).padStart(2, '0')}${String(lp.minute).padStart(2, '0')}`;
    for (const r of toQueue) {
      let sources = r.sources || 'caterer';
      let reedBudgetSkipped = false;
      if (!reedOk && (sources === 'reed' || sources === 'both')) {
        sources = 'caterer';
        reedBudgetSkipped = true;
      }
      const filename = `territory-${r.id}-${datePart}-${timePart}.json`;
      const filePath = path.join(PENDING_DIR, filename);
      const payload = buildPayload(r, sources, reedBudgetSkipped, now.toISOString());
      fsx.writeJsonAtomic(filePath, payload);
      created++;
      createdFiles.push(filename);
    }
  }

  const summary = {
    status: dryRun ? 'dry_run' : 'queued',
    due: allDue.length,
    queued: dryRun ? toQueue.length : created,
    alreadyQueued: skippedQueued.length,
    alreadyRunning: skippedRunning.length,
    reedBudgetExhausted: !reedOk,
    files: createdFiles,
  };
  if (skippedQuarantined.length) summary.alreadyQuarantined = skippedQuarantined.length;

  if (jsonMode) {
    console.log(JSON.stringify(summary));
  } else {
    log(`queue-due-territories: ${dryRun ? 'would queue' : 'queued'} ${dryRun ? toQueue.length : created}/${allDue.length} due territories (${skippedQueued.length} already queued, ${skippedRunning.length} running)${!reedOk ? ' [Reed budget exhausted -- reed/both downgraded to caterer]' : ''}`);
    toQueue.forEach(r => log(`  + ${r.job_title} | ${r.location} | ${r.distance}mi [${r.priority}]`));
  }

  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`queue-due-territories: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

module.exports = { main, normKey, loadQueuedKeys, loadQuarantinedKeys, reedBudgetAvailable, buildPayload };
