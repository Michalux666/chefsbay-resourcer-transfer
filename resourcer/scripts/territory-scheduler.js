#!/usr/bin/env node
/**
 * territory-scheduler.js
 *
 * Checks the territory_searches table for territories that are due (next_run_date <= today,
 * enabled = 1) and reports them. Kept as a diagnostic/report tool: the queue is filled by
 * queue-due-territories.js, which is what the watchdog runs.
 *
 * Options:
 *   --dry-run    List due territories without emitting spawn instructions
 *   --max <n>    Max territories to queue in one run (default: 50)
 *   --json       Output JSON summary (for programmatic use)
 *
 * Exit codes:
 *   0 = success (ran or dry-run completed)
 *   1 = error
 *   3 = nothing due
 */
'use strict';

const Database = require('better-sqlite3');
const paths    = require('./lib/paths');
const { getDueTerritories } = require('./territory-utils');
const { getActiveRuns, checkRunLockAgainst } = require('./run-lock');

const args   = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: node scripts/territory-scheduler.js [--dry-run] [--max <n>] [--json]\nExit codes: 0 ok, 1 error, 3 nothing due.');
  process.exit(0);
}

const db = new Database(paths.DB, { readonly: true });

// -- Reed daily budget check -----------------------------------------------------
// Returns true if Reed has remaining budget for today; false if exhausted.
function reedBudgetAvailable() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const row   = db.prepare('SELECT profile_views, daily_limit FROM reed_daily_usage WHERE date = ?').get(today);
    if (!row) return true; // No usage row = budget available
    const used  = row.profile_views || 0;
    const limit = row.daily_limit   || 300;
    return used < limit;
  } catch {
    return true; // Table doesn't exist yet - assume available
  }
}

const dryRun = args.includes('--dry-run');
const jsonMode = args.includes('--json');
const maxRuns  = parseInt(args[args.indexOf('--max') + 1] || '50', 10) || 50;

// -- Main ------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);

const allDue = getDueTerritories(db);
const reedOk = reedBudgetAvailable();
db.close();

if (allDue.length === 0) {
  const msg = `\u{2705} Nothing due today (${today}) \u{2014} all territories are on schedule.`;
  if (jsonMode) { console.log(JSON.stringify({ status: 'nothing_due', date: today, territories: [] })); }
  else { console.log(msg); }
  process.exit(3);
}

// -- Active-run deduplication filter ---------------------------------------------
// Remove any territory that already has an active pipeline run in runs/.
// This prevents the scheduler from spawning a duplicate when a manual/pending
// run is already in-flight for the same job+location.
const activeRuns = getActiveRuns();
const alreadyRunning = [];
const dueClear = allDue.filter(r => {
  const lock = checkRunLockAgainst(activeRuns, r.job_title, r.location);
  if (lock.blocked) {
    alreadyRunning.push({ jobTitle: r.job_title, location: r.location, blockingRun: lock.blockingRun.id });
    return false;
  }
  return true;
});
// ---------------------------------------------------------------------------------

// -- Reed budget check -----------------------------------------------------------
if (!reedOk) {
  if (!jsonMode) console.log('  \u{26A0}\u{FE0F}  Reed daily budget exhausted \u{2014} territories set to "reed" will run Caterer only today.');
}

// For territories that include Reed, override to caterer-only if budget is exhausted
const dueFinal = reedOk ? dueClear : dueClear.map(r => {
  const src = r.sources || 'caterer';
  if (src === 'reed') return { ...r, sources: 'caterer', _reedBudgetSkipped: true };
  if (src === 'both') return { ...r, sources: 'caterer', _reedBudgetSkipped: true };
  return r;
});

// Cap to maxRuns (highest priority first - already sorted by getDueTerritories)
const toRun = dueFinal.slice(0, maxRuns);
const deferred = dueFinal.slice(maxRuns);

if (jsonMode) {
  console.log(JSON.stringify({
    status:   dryRun ? 'dry_run' : 'ready',
    date:     today,
    due:      allDue.length,
    queued:   toRun.length,
    deferred: deferred.length,
    skippedAlreadyRunning: alreadyRunning.length,
    alreadyRunning,
    territories: toRun.map(r => ({
      id:         r.id,
      jobTitle:   r.job_title,
      location:   r.location,
      distance:   r.distance,
      keywords:   r.keywords,
      activeWithin: r.active_within,
      cvLimit:    r.cv_limit,
      priority:   r.priority,
      sources:    r.sources || 'caterer',
      lastSearched: r.last_searched,
      nextRunDate: r.next_run_date,
    })),
  }));
  process.exit(0);
}

// Human-readable output
console.log(`\n\u{23F0} Territory Scheduler \u{2014} ${today}`);
console.log(`   ${allDue.length} territories due | running ${toRun.length} now${deferred.length ? ` | ${deferred.length} deferred` : ''}${alreadyRunning.length ? ` | ${alreadyRunning.length} skipped (already running)` : ''}\n`);
if (alreadyRunning.length > 0) {
  console.log('  Skipped (active run already in-flight):');
  alreadyRunning.forEach(r => console.log(`    \u{1F512} ${r.jobTitle} | ${r.location} \u{2014} run ${r.blockingRun}`));
  console.log('');
}

toRun.forEach((r, i) => {
  const kw = r.keywords ? ` + "${r.keywords}"` : '';
  console.log(`  ${i + 1}. [${r.priority.toUpperCase()}] ${r.job_title}${kw} | ${r.location} | ${r.distance}mi | ${r.active_within} | limit: ${r.cv_limit}`);
  console.log(`     Last: ${r.last_searched || 'never'} | Was due: ${r.next_run_date || 'unscheduled'}`);
});

if (deferred.length > 0) {
  console.log(`\n  Deferred (will run next session):`);
  deferred.forEach(r => {
    console.log(`    \u{2022} ${r.job_title} | ${r.location} | ${r.distance}mi [${r.priority}]`);
  });
}

if (dryRun) {
  console.log('\n  [DRY RUN \u{2014} no jobs spawned]\n');
  process.exit(0);
}

// Print run instructions (the legacy hand-off format, kept for anything that still reads it)
console.log('\n--- SPAWN_INSTRUCTIONS ---');
toRun.forEach((r, i) => {
  const payload = {
    JOB_TITLE:      r.job_title,
    LOCATION:       r.location,
    DISTANCE_MILES: r.distance,
    ACTIVE_WITHIN:  r.active_within,
    CV_LIMIT:       r.cv_limit,
    KEYWORDS:       r.keywords || '',
    HIDE_VIEWED:    7,
    SOURCES:        r.sources || 'caterer',
  };
  console.log(`SPAWN_${i + 1}: ${JSON.stringify(payload)}`);
});
console.log('--- END_SPAWN_INSTRUCTIONS ---\n');
