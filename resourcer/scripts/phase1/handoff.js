'use strict';
const paths = require('../lib/paths');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');
const { writeStatus } = require('./queue');
const { saveCatererSession } = require('./session');
const { reasonOf } = require('./incomplete');
const { PHASE2_HELD, PHASE2_HELD_EXIT } = require('../lib/phase2-exit');

// Child output goes straight to our stdout/stderr (the run log), unbuffered.
function runInherit(ctx, name, args) {
  return runNode(scriptPath(name), args, { cwd: paths.HOME, inherit: true, timeoutMs: ctx.cfg.timeoutMs.handoff });
}

function describe(r) {
  if (r.timedOut) return 'timeout';
  if (r.error) return `spawn error: ${r.error}`;
  return r.code === null ? 'none' : String(r.code);
}

// Phase 2 for a caterer-only run: process-approved-queue.js. Its own exit code never failed the run (legacy); only a hang, which the legacy
// script could not detect, does. The one exit that is not "done" is 2, HELD: CV screening (CV_SCREEN=on) could not reach Jev, everything is kept
// and the queue is retried once the halt clears. The run then ends with PHASE2_HELD_EXIT so the supervisor records it as held, not as a success.
async function runPhase2Inline(ctx) {
  const r = await runInherit(ctx, 'process-approved-queue', [ctx.st.queueFile]);
  if (r.code === PHASE2_HELD) {
    ctx.out('PHASE2_HELD: CV screening could not run, so nothing was pushed; every CV and the queue are kept and the queue is retried once the screening halt clears');
    r.held = true;
  } else if (r.timedOut || r.error || (r.code !== 0 && r.code !== null)) {
    ctx.out(`WARN process-approved-queue.js did not finish cleanly (${describe(r)})`);
  }
  return r;
}

// Returns the process exit code.
async function handoff(ctx, fin) {
  const { st, p, out } = ctx;
  const credits = fin.creditsRemaining;

  if (st.screeningIncomplete && st.approved.length === 0) {
    // Phase 2 would mark the territory searched and delete its pending search although the run did not do its work.
    out(`PHASE2_SKIPPED: the run ended early (${reasonOf(st)}) and nothing was approved - the territory and its pending search are kept for the next run`);
    out(`CREDITS: ${credits}`);
    st.phase2Status = 'skipped';
    writeStatus(ctx, 'phase1_abandoned');
    return 0;
  }

  if (st.approved.length === 0) {
    out(`QUEUE_FILE: ${st.queueFile}`);
    if (p.SOURCES === 'both') {
      // Caterer found nothing but Reed may: fall through to the run-pipeline hand-off below.
      out('No Caterer candidates - will check Reed next.');
      out('PHASE2_DEFERRED: true');
      st.phase2Status = 'pending';
      out(`CREDITS: ${credits}`);
      writeStatus(ctx, 'phase1_complete');
    } else {
      // Single source: run Phase 2 now so the territory map, pending file and cleanup are handled.
      out('No candidates to process - calling Phase 2 inline to guarantee cleanup.');
      const r = await runPhase2Inline(ctx);
      st.phase2Status = 'done';
      if (r.held) { out(`CREDITS: ${credits}`); return PHASE2_HELD_EXIT; }
      out('PHASE2_DONE: true');
      out(`CREDITS: ${credits}`);
      return r.timedOut ? 1 : 0;
    }
  }

  out(`PROGRESS_MESSAGE: Phase 1 complete - ${st.approved.length} candidates queued for ${p.JOB_TITLE} in ${p.LOCATION}. Starting downloads + Zoho push now.`);

  await saveCatererSession(ctx, 'post-Phase1');

  out(`QUEUE_FILE: ${st.queueFile}`);
  out(`SCREENING_MODEL: ${st.screeningModel}`);
  out(`CREDITS: ${credits}`);

  if (p.SOURCES === 'both') {
    st.phase2Status = 'pending';
    out('PHASE2_DEFERRED: true');
    writeStatus(ctx, 'phase1_complete');

    await saveCatererSession(ctx, 'pre-Reed handoff');

    out('Calling run-pipeline.js to continue Reed Phase 1 + Phase 2...');
    // Pass the status file we own: without it run-pipeline guessed one from runs/ (2026-05-06).
    const r = await runInherit(ctx, 'run-pipeline', ['--status-file', st.statusFile]);
    const code = r.timedOut || r.error || r.code === null ? 1 : r.code;
    out(`run-pipeline.js exited with code: ${r.timedOut ? 'timeout' : (r.error ? `spawn error (${r.error})` : code)}`);
    return code;
  }

  st.phase2Status = 'done';
  const r = await runPhase2Inline(ctx);
  if (r.held) { st.phase2Status = 'pending'; return PHASE2_HELD_EXIT; }
  out('PHASE2_DONE: true');
  return r.timedOut ? 1 : 0;
}

module.exports = { handoff };
