#!/usr/bin/env node
/**
 * pending-gate.js
 *
 * Lightweight pre-check run by the watchdog before it starts a run, with zero LLM tokens.
 *
 * Checks:
 *   1. Are there any JSON files in pending-searches/? (names starting with "." and directories are ignored)
 *   2. Is the global pipeline lock clear?
 *   3. Has the pending file already been claimed (spawnedAt field)?
 *   4. Is the pending file well formed (jobTitle and location non-empty strings, sources one of caterer|reed|both)?
 *      A malformed file is moved to pending-searches/.quarantine/ with a critical alert instead of being launched.
 *
 * Output:
 *   - If no work: prints "NO_WORK" and exits 0
 *   - If locked:  prints "LOCKED:<blocking-run-id>" and exits 0
 *   - If already spawned: prints "SPAWNED:<file>" and exits 0
 *   - If work:    prints JSON with pending file details and exits 0
 *   - If every pending file is unreadable: prints "ERROR:all_files_corrupt (<n> parse failures)" and exits 1
 *
 * After the runner claims a file, it should call:
 *   node scripts/pending-gate.js --mark-spawned <filename>
 * to stamp the pending file with spawnedAt, preventing a double start.
 * Files written by hand (or by the dashboard) must NOT carry spawnedAt: a recent spawnedAt
 * makes the gate skip the file for 10 minutes. A claim that is 10 minutes old with no run active is released by the
 * gate (the stale-spawn rotation): a failing territory therefore waits its turn instead of blocking the ones behind it.
 *
 * Usage:
 *   node scripts/pending-gate.js              # Check mode
 *   node scripts/pending-gate.js --mark-spawned search-123.json  # Stamp mode
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { checkGlobalLock } = require('./run-lock');

const PENDING_DIR = paths.PENDING;
const QUARANTINE_DIR = '.quarantine';
const SOURCES_OK = new Set(['caterer', 'reed', 'both']);
// Written by the watchdog when a territory fails; a released file starts again from zero.
const FAILURE_FIELDS = ['spawnedAt', 'failedRuns', 'lastFailure'];

const USAGE = `Usage:
  node scripts/pending-gate.js                          check mode (NO_WORK | LOCKED:<id> | SPAWNED:<file> | JSON)
  node scripts/pending-gate.js --mark-spawned <file>    stamp spawnedAt on a pending file`;

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// Returns null when the pending search can be launched, otherwise a short reason.
function validatePending(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'the file is not a JSON object';
  if (!nonEmpty(data.jobTitle)) return 'jobTitle is missing or not a non-empty string';
  if (!nonEmpty(data.location)) return 'location is missing or not a non-empty string';
  if (data.jobTitle.length > 120 || data.location.length > 80) return 'jobTitle or location is unreasonably long';
  for (const k of ['sources', 'sourcesRequested']) {
    if (data[k] === undefined) continue;
    if (typeof data[k] !== 'string' || !SOURCES_OK.has(data[k].trim().toLowerCase())) return `${k} is not one of caterer, reed or both`;
  }
  return null;
}

function listPending(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => !e.isDirectory() && !e.name.startsWith('.') && e.name.endsWith('.json')).map(e => e.name).sort();
}

function whyFile(dest) {
  return `${dest.replace(/\.json$/, '')}.why.txt`;
}

// Moves a pending file out of the queue without losing it; returns the name it now has inside .quarantine/.
function quarantineFile(dir, name, reason) {
  const qdir = path.join(dir, QUARANTINE_DIR);
  fsx.ensureDir(qdir);
  let dest = path.join(qdir, name);
  if (fs.existsSync(dest)) dest = path.join(qdir, `${name.replace(/\.json$/, '')}.${Date.now()}.json`);
  fs.renameSync(path.join(dir, name), dest);
  try { fsx.writeFileAtomic(whyFile(dest), `${new Date().toISOString()} ${String(reason).replace(/\s+/g, ' ').slice(0, 300)}\n`); } catch { /* the alert carries the reason too */ }
  return path.basename(dest);
}

function listQuarantined(dir) {
  return listPending(path.join(dir, QUARANTINE_DIR));
}

// Puts a quarantined file back in the queue with its claim and failure counters cleared (the operator fixed the cause).
function releaseQuarantined(dir, name) {
  if (typeof name !== 'string' || name !== path.basename(name) || !name.endsWith('.json') || name.startsWith('.')) return { ok: false, error: 'not a quarantined file name' };
  const src = path.join(dir, QUARANTINE_DIR, name);
  const dest = path.join(dir, name);
  if (!fs.existsSync(src)) return { ok: false, error: `${name} is not in ${QUARANTINE_DIR}/` };
  if (fs.existsSync(dest)) return { ok: false, error: `a pending file named ${name} already exists` };
  let cleared = false;
  try {
    const obj = JSON.parse(stripBom(fs.readFileSync(src, 'utf8')));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of FAILURE_FIELDS) delete obj[k];
      fsx.writeJsonAtomic(dest, obj);
      fs.unlinkSync(src);
      cleared = true;
    }
  } catch { /* not valid JSON: moved as it is, the gate quarantines it again if it is still unusable */ }
  if (!cleared) fs.renameSync(src, dest);
  fsx.safeUnlink(whyFile(src));
  return { ok: true, file: name };
}

function alertQuarantine(name, reason) {
  try {
    require('./lib/notify').notify({
      severity: 'critical',
      key: `territory-quarantined:${name}`,
      text: `Pending search ${name} was moved to pending-searches/.quarantine/ and will not run: ${reason}. Fix it, then: node scripts/pipeline-watchdog.js --release-quarantine ${name} (docs/OPERATIONS.md).`,
      meta: { file: name, reason: String(reason).slice(0, 200) },
    });
  } catch { /* alerting never blocks the gate */ }
}

function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return 0;
  }

  // --- Mark-spawned mode ---
  if (argv[0] === '--mark-spawned' && argv[1]) {
    const target = path.join(PENDING_DIR, argv[1]);
    if (fs.existsSync(target)) {
      try {
        const data = JSON.parse(stripBom(fs.readFileSync(target, 'utf8')));
        data.spawnedAt = new Date().toISOString();
        fsx.writeJsonAtomic(target, data);
        console.log(`MARKED: ${argv[1]}`);
      } catch (e) {
        console.error(`Failed to mark: ${e.message}`);
      }
    }
    return 0;
  }

  // --- Check mode ---

  // 1. Check for pending files
  if (!fs.existsSync(PENDING_DIR)) {
    console.log('NO_WORK');
    return 0;
  }

  const files = listPending(PENDING_DIR); // oldest first (alphabetical = chronological for our naming)

  if (files.length === 0) {
    console.log('NO_WORK');
    return 0;
  }

  // 2. Check global lock. This also covers unclaimed files: a pipeline can be running while
  // its pending file carries no spawnedAt (cleared by a stale-spawn check or never stamped).
  const lock = checkGlobalLock();
  if (lock.blocked) {
    const blockId = lock.blockingRun?.id || 'unknown';
    console.log(`LOCKED:${blockId}`);
    return 0;
  }

  // 3. Find the oldest UNSPAWNED pending file
  // GUARD: Process at most 1 pending file per tick, even if multiple are
  // queued. This prevents concurrent run storms when users queue 5+ searches
  // at once. The loop breaks after the first READY match (natural serialization).
  let ready = null;
  let parseErrors = 0;
  let quarantined = 0;
  for (const f of files) {
    const filePath = path.join(PENDING_DIR, f);
    try {
      // Strip UTF-8 BOM if present - some writers add it and JSON.parse chokes on it
      let raw = fs.readFileSync(filePath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) {
        raw = raw.slice(1);
        fsx.writeFileAtomic(filePath, raw); // rewrite without BOM so future reads are clean
        console.error(`WARN: Stripped UTF-8 BOM from ${f}`);
      }
      const data = JSON.parse(raw);
      const bad = validatePending(data);
      if (bad) {
        // A valid-JSON file of the wrong shape would fail in the runner on every attempt; take it out of the queue now.
        try {
          quarantineFile(PENDING_DIR, f, bad);
          quarantined++;
          console.error(`WARN: ${f} quarantined: ${bad}`);
          alertQuarantine(f, bad);
        } catch (qe) {
          parseErrors++;
          console.error(`Failed to quarantine ${f}: ${qe.message}`);
        }
        continue;
      }
      // NOTE: source field is informational but does not gate processing.
      // Dashboard searches are processed the same as territory-scheduler searches.
      if (data.spawnedAt) {
        // Already spawned - check if it's been more than 10 minutes (stale spawn recovery).
        // 10 min is enough: a live run sets the global lock within ~2 min of spawning.
        // If there's no lock after 10 min, the spawn definitely failed.
        const spawnAge = Date.now() - new Date(data.spawnedAt).getTime();
        if (spawnAge < 10 * 60 * 1000) {
          continue; // Skip - the run should still be starting up
        }
        // Stale spawn (>10 min) - but only re-queue if no pipeline is actively running.
        // Without this check, the runner re-spawns while a slow run is still in flight
        // (the spawn timestamp is stale, but the pipeline is alive with an active phase file).
        const staleLock = checkGlobalLock();
        if (staleLock.blocked) {
          console.error(`WARN: Stale spawn for ${f} (${Math.round(spawnAge / 60000)}m old) but pipeline still active (${staleLock.blockingRun?.status}) - skipping re-queue`);
          continue;
        }
        console.error(`WARN: Stale spawn detected for ${f} (${Math.round(spawnAge / 60000)}m old) - re-queuing`);
        delete data.spawnedAt;
        fsx.writeJsonAtomic(filePath, data);
      }
      ready = { file: f, filePath, data };
      break;
    } catch (err) {
      parseErrors++;
      console.error(`Failed to read ${f}: ${err.message}`);
    }
  }

  const live = files.length - quarantined;
  if (!ready) {
    if (live === 0) {
      console.log('NO_WORK');
      return 0;
    }
    if (parseErrors > 0 && parseErrors === live) {
      // Every file failed to parse - encoding corruption, not a spawned state
      console.log(`ERROR:all_files_corrupt (${parseErrors} parse failures)`);
      return 1;
    }
    // All pending files are legitimately spawned (and not stale)
    const spawned = files.find(f => fs.existsSync(path.join(PENDING_DIR, f))) || files[0];
    console.log(`SPAWNED:${spawned}`);
    return 0;
  }

  // Ensure sources field is present (default 'both' for new searches from dashboard)
  if (!ready.data.sources) {
    ready.data.sources = ready.data.source === 'territory-scheduler' ? 'caterer' : 'both';
  }

  console.log(JSON.stringify({
    status:     'READY',
    file:       ready.file,
    filePath:   ready.filePath,
    pending:    ready.data,
    queueDepth: live,
  }));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, PENDING_DIR, QUARANTINE_DIR, validatePending, listPending, quarantineFile, listQuarantined, releaseQuarantined, FAILURE_FIELDS };
