'use strict';
// Exit codes that say "Phase 2 was HELD, not failed and not done": process-approved-queue.js exits 2 when CV screening (CV_SCREEN=on) could not reach
// Jev or its criteria file is not usable; nothing was lost (every CV and queue entry is kept) and the queue is retried once the halt clears.
//   process-approved-queue.js   exit PHASE2_HELD (2)
//   run-pipeline.js, phase1.js  exit PHASE2_HELD_EXIT (14), so the supervisor can record the run as held (neither a success nor a failure)
//   watchdog-runner.js          exit 14 as well (EXIT.HELD)
module.exports = { PHASE2_HELD: 2, PHASE2_HELD_EXIT: 14 };
