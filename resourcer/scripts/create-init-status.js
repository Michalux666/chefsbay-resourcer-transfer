#!/usr/bin/env node
/**
 * create-init-status.js
 *
 * Generates a Phase 1 init status file with a deterministic, server-clock-based
 * timestamp ID - eliminates any model from timestamp generation.
 *
 * Background:
 *   The old LLM watcher was instructed to write an init file with
 *   id "phase1-<yyyy-MM-dd-HHmm>" and repeatedly hallucinated the HHmm portion,
 *   producing files named after wrong times. On 2026-05-21 at 20:35 BST this caused
 *   a real collision: a new init file overwrote the complete status of an earlier
 *   run (B25's 25-candidate run record was lost - data already in Zoho, but the run
 *   record gone). This helper removes any model from timestamp generation.
 *
 * Usage:
 *   node scripts/create-init-status.js <pending-search-file-path>
 *
 * Output (stdout, one line):
 *   INIT_FILE:<absolute path to init status file>
 *
 * On error: ERROR:<message> on stderr, exit code 1.
 *
 * Filename format: phase1-YYYY-MM-DD-HHMM.json using Europe/London local time
 *   (matching the convention phase1 uses for its run file).
 *
 * Collision avoidance: if a file already exists at the computed path (two ticks
 * fired within the same minute) the script appends a -<seconds><ms> suffix to
 * guarantee uniqueness, so it can never silently overwrite an existing status file.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { londonParts } = require('./lib/time');

const RUNS_DIR = paths.RUNS;

const two = n => String(n).padStart(2, '0');

function main(argv) {
  const pendingPath = argv[0];
  if (pendingPath === '--help' || pendingPath === '-h') {
    console.log('Usage: node scripts/create-init-status.js <pending-search-file-path>\nPrints INIT_FILE:<path>; on error prints ERROR:<message> to stderr and exits 1.');
    return 0;
  }
  if (!pendingPath) {
    console.error('ERROR:missing pending-search file path argument');
    return 1;
  }

  if (!fs.existsSync(pendingPath)) {
    console.error(`ERROR:pending file not found: ${pendingPath}`);
    return 1;
  }

  let pending;
  try {
    let raw = fs.readFileSync(pendingPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    pending = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR:cannot parse pending file: ${err.message}`);
    return 1;
  }

  if (!pending.jobTitle || !pending.location) {
    console.error('ERROR:pending file missing jobTitle or location');
    return 1;
  }

  fsx.ensureDir(RUNS_DIR);

  const nowUtc = new Date();
  const lp = londonParts(nowUtc);
  const stamp = `${lp.year}-${two(lp.month)}-${two(lp.day)}-${two(lp.hour)}${two(lp.minute)}`;

  let id      = `phase1-${stamp}`;
  let outPath = path.join(RUNS_DIR, `${id}.json`);
  if (fs.existsSync(outPath)) {
    const suffix = `${String(nowUtc.getUTCSeconds()).padStart(2, '0')}${String(nowUtc.getUTCMilliseconds()).padStart(3, '0')}`;
    id      = `phase1-${stamp}-${suffix}`;
    outPath = path.join(RUNS_DIR, `${id}.json`);
  }

  const payload = {
    id,
    status:      'phase1_initializing',
    jobTitle:    pending.jobTitle,
    location:    pending.location,
    distance:    pending.distance || 20,
    pool:        null,
    startedAt:   nowUtc.toISOString(),
    requestedAt: pending.requestedAt || nowUtc.toISOString(),
    page:        0,
    approved:    0,
    skippedDb:   null,
    errors:      null,
    sources:     pending.sources || 'caterer',
    updatedAt:   nowUtc.toISOString(),
  };

  fsx.writeJsonAtomic(outPath, payload);
  console.log(`INIT_FILE:${outPath}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR:${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
