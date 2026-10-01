'use strict';
// Small fakes selected by name: run-lock, caterer-get-credits, process-approved-queue, run-pipeline.
const fs = require('fs');
const { scenario, readState, writeState, logCall, sleepMs, stateFile } = require('./common');

function readMaybe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

async function runLock(sc) {
  const args = process.argv.slice(2);
  const cfg = sc.lock || {};
  logCall('run-lock', { args });
  if (cfg.hang) await sleepMs(Number(process.env.P1_HANG_MS || 15000));
  if (cfg.crash) { process.stderr.write('TypeError: boom\n'); process.exit(1); }
  if (cfg.exit === 2) {
    console.log(JSON.stringify({ blocked: true, activeCount: 1, blockingRun: { id: 'phase1-other', status: 'phase1_running' } }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify({ blocked: false, activeCount: 0 }, null, 2));
  process.exit(0);
}

// What the unlocks charged so far, from the call log: sc.charge = { default: {first, repeat}, byId: { <id>: {first, repeat} }, failCharges }.
// The first unlock of an id costs `first`, every later one `repeat` (default: the same); a failed unlock is free unless failCharges is set.
function unlockCharges(sc) {
  let lines = [];
  try { lines = fs.readFileSync(stateFile('calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { /* no calls yet */ }
  const cfg = sc.charge || {};
  const seen = {};
  let spent = 0;
  for (const c of lines.filter((l) => l.tool === 'caterer-unlock')) {
    const per = (cfg.byId || {})[String(c.id)] || cfg.default || { first: 1, repeat: 1 };
    const n = (seen[c.id] = (seen[c.id] || 0) + 1);
    if (c.success === false && !cfg.failCharges) continue;
    spent += n === 1 ? per.first : (per.repeat === undefined ? per.first : per.repeat);
  }
  return spent;
}

function credits(sc) {
  const args = process.argv.slice(2);
  const sess = readState('session.json', sc.session || { cookieValid: true, browserOnLogin: false });
  const counters = readState('credits.json', { calls: 0 });
  counters.calls++;
  writeState('credits.json', counters);
  logCall('caterer-get-credits', { args, cookieValid: sess.cookieValid });
  process.stderr.write('[credits] reading credits via warm caterer browser session (DOM)...\n');
  // the balance model of the second-look tests (sc.creditsStart): the start balance minus what the unlocks charged; sc.creditsFail lists the numbers
  // of the calls (1 = the session check at the start of the run) that cannot read the balance; sc.creditsFailFrom: every call from that number on cannot
  if (sc.creditsStart !== undefined) {
    if ((sc.creditsFail || []).includes(counters.calls) || (sc.creditsFailFrom && counters.calls >= sc.creditsFailFrom)) {
      process.stderr.write('[credits] warm-DOM path failed - signalling session-stale (exit 2)\n');
      process.stdout.write('unknown\n');
      process.exit(2);
    }
    process.stderr.write('[credits] Credits remaining (via warm DOM)\n');
    process.stdout.write(`${sc.creditsStart - unlockCharges(sc)}\n`);
    process.exit(0);
  }
  if (sess.cookieValid) {
    process.stderr.write('[credits] Credits remaining: 62185 (via warm DOM)\n');
    process.stdout.write(`${sess.credits || 62185}\n`);
    process.exit(0);
  }
  process.stderr.write('[credits] warm-DOM path failed - signalling session-stale (exit 2)\n');
  process.stdout.write('unknown\n');
  process.exit(2);
}

function phase2Like(name, sc) {
  const args = process.argv.slice(2);
  const cfg = sc[name === 'process-approved-queue' ? 'pap' : 'pipeline'] || {};
  const rec = { args };
  if (name === 'process-approved-queue') rec.queue = readMaybe(args[0]);
  if (name === 'run-pipeline') {
    const i = args.indexOf('--status-file');
    rec.status = i >= 0 ? readMaybe(args[i + 1]) : null;
  }
  logCall(name, rec);
  console.log(`[${name}] fake run`);
  return cfg;
}

async function main() {
  const name = process.env.P1_FAKE_NAME;
  const sc = scenario();
  if (name === 'run-lock') return runLock(sc);
  if (name === 'caterer-get-credits') return credits(sc);
  const cfg = phase2Like(name, sc);
  if (cfg.hang) await sleepMs(Number(process.env.P1_HANG_MS || 15000));
  process.exit(cfg.exit === undefined ? 0 : cfg.exit);
}

main();
