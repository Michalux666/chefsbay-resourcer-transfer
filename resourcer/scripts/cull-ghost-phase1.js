#!/usr/bin/env node
/**
 * cull-ghost-phase1.js
 *
 * Maintenance pre-scan run by the watchdog every few minutes.
 *
 * A "ghost phase1" is a phase1-*.json file with status `phase1_initializing`
 * or `phase1_running` whose process has died without updating the
 * file. The existing run-lock.js logic treats these as active until they
 * exceed STATUS_MAX_AGE (20 min init, 60 min running), holding the global
 * pipeline lock and blocking any new pending-search from starting.
 *
 * This script aggressively detects ghosts by tighter age thresholds, then
 * marks them `phase1_abandoned` (a terminal status) so the next pending-gate
 * scan can re-queue any blocked pending-search.
 *
 * Thresholds (more aggressive than run-lock.js):
 *   phase1_initializing  > 15 min stale (vs 20 in run-lock)
 *   phase1_taking_over   > 5  min stale
 *   phase1_searching     > 20 min stale (vs 30 in run-lock)
 *   phase1_running       > 30 min stale (vs 60 in run-lock)
 *   phase1_active        > 30 min stale (vs 60 in run-lock)
 *   phase1_complete      > 10 min stale + phase2Status pending (stranded - handled by recover-stranded-phase1.js, not culled here)
 *
 * Output (single-line summary):
 *   CULL_OK culled=<n> kept=<n>           - normal exit
 *   CULL_OK culled=0 kept=<n>             - nothing to do
 *   CULL_ERR <message>                    - script error
 *
 * Exit code is always 0 (this is informational pre-scan; failures here must
 * never block the watchdog's primary work).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');

const RUNS_DIR = paths.RUNS;

const GHOST_THRESHOLDS_MIN = {
  phase1_initializing: 15,
  phase1_taking_over:  5,
  phase1_searching:    20,
  phase1_running:      30,
  phase1_active:       30,
};

function isPhase1File(name) {
  return name.startsWith('phase1-') && name.endsWith('.json');
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeWriteJson(p, data) {
  try { fsx.writeJsonAtomic(p, data); return true; } catch { return false; }
}

function ageMinutes(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function cullGhosts() {
  if (!fs.existsSync(RUNS_DIR)) {
    return { culled: 0, kept: 0, culledIds: [] };
  }

  let culled = 0;
  let kept   = 0;
  const culledIds = [];

  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!isPhase1File(f)) continue;

    const fp = path.join(RUNS_DIR, f);
    const data = safeReadJson(fp);
    if (!data || !data.status) continue;

    const threshold = GHOST_THRESHOLDS_MIN[data.status];
    if (!threshold) continue; // Status not subject to ghost-cull (terminal or out-of-scope)

    const updated = data.updatedAt || data.startedAt;
    const ageMin  = ageMinutes(updated);
    if (ageMin <= threshold) {
      kept++;
      continue;
    }

    // Ghost confirmed - mark abandoned so the lock releases and the queue can restart.
    const prevStatus = data.status;
    data.status      = 'phase1_abandoned';
    data.updatedAt   = new Date().toISOString();
    data.cullReason  = `ghost_cull: status=${prevStatus} stale=${Math.round(ageMin)}min threshold=${threshold}min`;
    if (safeWriteJson(fp, data)) {
      culled++;
      culledIds.push(data.id || f.replace('.json', ''));
    } else {
      kept++;
    }
  }

  return { culled, kept, culledIds };
}

function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: node scripts/cull-ghost-phase1.js\nMarks stale in-flight phase1-*.json files phase1_abandoned, then runs stranded-run recovery.\nPrints CULL_OK culled=<n> kept=<n> [ids=...]; always exits 0.');
    return;
  }

  const r = cullGhosts();
  if (r.culled > 0) {
    console.log(`CULL_OK culled=${r.culled} kept=${r.kept} ids=${r.culledIds.join(',')}`);
  } else {
    console.log(`CULL_OK culled=0 kept=${r.kept}`);
  }

  // Adjacent concern: recover phase1_complete + phase2Status=pending stranded by
  // a dead run-pipeline.js. cull-ghost intentionally doesn't change phase1_complete
  // status (it's a terminal-ish state) but the recovery module starts phase 2 in a
  // detached child. Safe to run inline because it's just start-and-forget.
  // See scripts/recover-stranded-phase1.js for the full failure-mode rationale.
  try {
    const { recoverStranded, recoverInterrupted } = require('./recover-stranded-phase1');
    const rec = recoverStranded();
    rec.recovered = (rec.recovered || []).concat(recoverInterrupted().recovered);
    if (rec.recovered && rec.recovered.length > 0) {
      const ids = rec.recovered.map(x => `${x.id}(pid=${x.pid},mode=${x.mode})`).join(',');
      console.log(`RECOVERY_OK n=${rec.recovered.length} ${ids}`);
    }
    // Silent on RECOVERY_NONE - keeps idle-cycle output minimal
  } catch (e) {
    console.log(`RECOVERY_ERR ${e.message || e}`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.log(`CULL_ERR ${err.message || err}`);
  }
  process.exit(0);
}

module.exports = { cullGhosts, GHOST_THRESHOLDS_MIN };
