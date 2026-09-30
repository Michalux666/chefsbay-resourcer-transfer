'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const fsx = require('../lib/fsx');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');
const { readJsonStrict, safeText } = require('./util');

const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}

// Bridge files are phase1_initializing status files created for a spawn, not real locks. Every foreign one
// is flipped to phase1_taking_over so run-lock only blocks on truly active scrapers (NE24 incident, 2026-04-17).
// Our own bridge is skipped: flipping it would make the next lock check block on ourselves.
function clearForeignBridges(ctx) {
  const { p, out } = ctx;
  const runsDir = paths.RUNS;
  const own = p.INIT_STATUS_FILE && fs.existsSync(p.INIT_STATUS_FILE) ? realOrResolved(p.INIT_STATUS_FILE) : null;
  if (!fs.existsSync(runsDir)) return { ownBridge: own };
  let names = [];
  try { names = fs.readdirSync(runsDir).filter((n) => /^phase1-.*\.json$/i.test(n)); } catch (e) { names = []; }
  for (const name of names) {
    const full = path.join(runsDir, name);
    if (own && realOrResolved(full).toLowerCase() === own.toLowerCase()) continue;
    try {
      const obj = readJsonStrict(full);
      if (obj && String(obj.status).toLowerCase() === 'phase1_initializing') {
        // updatedAt is kept: refreshing it revived leftovers that run-lock had already stopped honouring (exit 3 on the next run).
        obj.status = 'phase1_taking_over';
        fsx.writeJsonAtomic(full, obj);
        out(`Bridge cleared: ${name} -> phase1_taking_over`);
      }
    } catch (e) {
      out(`WARN failed to clear bridge ${name}: ${safeText(e.message, 200)}`);
    }
  }
  return { ownBridge: own };
}

// Only ONE pipeline may run at a time (shared browser session). run-lock exits 2 when another is active;
// any other outcome (including a broken run-lock) lets the run proceed, exactly like the legacy script.
async function checkGlobalLock(ctx, ownBridge) {
  const { out, cfg } = ctx;
  const args = ['--global'];
  if (ownBridge) args.push(`--skip-file=${path.basename(ownBridge)}`);
  const r = await runNode(scriptPath('run-lock'), args, { cwd: paths.HOME, timeoutMs: cfg.timeoutMs.lock });
  if (r.code === 2) {
    out('PIPELINE_BLOCKED: Another pipeline is already active. Exiting to avoid concurrency issues.');
    out(`Lock detail: ${safeText(`${r.stdout} ${r.stderr}`, 600)}`);
    return { blocked: true };
  }
  if (r.timedOut || r.error || (r.code !== 0 && r.code !== null)) {
    out(`WARN run-lock check did not complete cleanly (exit ${r.code === null ? 'none' : r.code}${r.timedOut ? ', timeout' : ''}) - continuing`);
  }
  out('Global pipeline lock: clear -- no other pipelines active');
  return { blocked: false };
}

// Our own status file replaces the bridge, so the bridge is deleted (never the status file itself).
function removeOwnBridge(ctx) {
  const { p, st, out } = ctx;
  if (!p.INIT_STATUS_FILE || !fs.existsSync(p.INIT_STATUS_FILE)) return;
  if (sameFile(p.INIT_STATUS_FILE, st.statusFile)) return;
  try {
    fs.unlinkSync(p.INIT_STATUS_FILE);
    out(`Bridge file removed (we own the run now): ${p.INIT_STATUS_FILE}`);
  } catch (e) {
    out(`WARN failed to remove bridge file: ${safeText(e.message, 200)}`);
  }
}

module.exports = { clearForeignBridges, checkGlobalLock, removeOwnBridge };
