'use strict';
// While the CV screening stage holds the pipeline (CV_SCREEN is on and the screening halt is up) no more candidates are unlocked: a candidate
// unlocked now would be held in Phase 2 and never pushed, which is how credits were spent for nothing while the CV route was refusing requests.
// The supervisor already starts no run while the halt is up (lib/screening-health.js deep check, CV canary); this is the same rule inside
// the run, for a run that started before the halt was raised and for one started by hand.
const { KINDS, markIncomplete } = require('./incomplete');

function blocked(ctx) {
  try {
    return ctx.cvHold ? !!ctx.cvHold() : require('../lib/cv/phase2').unlockBlocked();
  } catch (e) {
    return false;
  }
}

/** True (and the run is ended early, its territory and pending search kept) when no more unlocks may start. */
function stopIfBlocked(ctx, where) {
  if (!blocked(ctx)) return false;
  ctx.out(`STOPPING Phase 1 (${where}): the CV screening stage holds the pipeline (CV_SCREEN is on and the screening halt is up), so nothing more is unlocked; the territory and its pending search are kept`);
  markIncomplete(ctx, KINDS.SCREENING_UNAVAILABLE, { bounded: false });
  ctx.st.stop = true;
  return true;
}

module.exports = { blocked, stopIfBlocked };
