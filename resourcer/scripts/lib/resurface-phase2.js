'use strict';
// The Phase 2 side of the role-scoped second look (docs/RESURFACE.md), used by scripts/process-approved-queue.js.
//
// Caterer: the claim was written and the cost measured in Phase 1 (the unlock is the re-open); the queue entry carries the result. Phase 2 downloads
// the CV like any other and the CV stage decides for this role.
// Reed: the profile view and the CV come from the same download call, so the claim is written here, immediately before it, and the cost is the change
// of the day's profile views around it. The download of a resurfaced Reed candidate runs alone (after the others), so the change is attributable.
//
// Everything degrades to the old skip: a candidate that cannot be counted is held (not downloaded, not pushed, nothing recorded), never pushed
// without its accounting.

const base = require('./resurface');

const lib = (deps) => {
  try { return deps && typeof deps.resurface === 'function' ? deps.resurface() : base; } catch (e) { return null; }
};

function readViews(deps) {
  try {
    const u = deps.reedUsage();
    const views = Number(u && u.profile_views);
    const limit = Number(u && u.daily_limit);
    return Number.isFinite(views) && Number.isFinite(limit) ? { date: String(u.date || ''), views, limit } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Gate, claim, download and measure one resurfaced Reed candidate.
 * @param {object} deps the Phase 2 dependencies  @param {object} cand the queue entry  @param {string} jobTitle
 * @param {(cand:object)=>Promise<{error?:string}|undefined>} run the normal download of one candidate
 * @returns {Promise<{held:string}|{measure:{kind:string,credits:number,views:number}|null, released?:boolean, failed?:boolean}>}
 */
async function reedResurfaced(deps, cand, jobTitle, run) {
  const rs = lib(deps);
  // each kind needs its own switch: the CV rule (CV_RESURFACE with CV_SCREEN on) or the role scope (ROLE_SCOPE_LEGACY); the claim checks the rule again
  if (!rs || !(cand.legacy === true ? rs.legacyActive() : rs.active())) return { held: 'disabled' };
  const before = readViews(deps);
  if (!before) { rs.record({ stop: 'unreadable' }); return { held: 'unreadable' }; }
  if (before.limit - before.views < 1) { rs.record({ stop: 'reserve' }); return { held: 'daily-limit' }; }
  let db;
  try { db = deps.candidateDb.getDb(); } catch (e) { return { held: 'database' }; }
  const c = rs.claim(db, { source: 'reed', id: cand.id, jobTitle });
  if (!c.claimed) {
    if (c.why === 'cap') {
      rs.record({ stop: 'capped' });
      rs.alertStopped({ why: 'cap', detail: `${jobTitle}.` });
    }
    return { held: c.why || 'error' };
  }
  const result = await run(cand);
  const after = readViews(deps);
  const sameDay = before && after && before.date === after.date;
  const m = rs.measure(sameDay ? before.views : null, sameDay ? after.views : null, 'views');
  // a failed download leaves no profile and no CV to push (the entry has only the card), so the candidate is held back whatever it cost
  const failed = !!(result && result.error);
  if (failed && m.kind === 'notCharged') {
    // the day's views did not move: nothing was spent, so the claim goes back and the candidate can be tried again
    const released = rs.release(db, { source: 'reed', id: cand.id, jobTitle, slot: c.slot });
    if (released && typeof rs.noteFailed === 'function') rs.noteFailed('reed', cand.id, jobTitle); // not screened again for this title by every run of the day
    return { measure: null, released, failed: true };
  }
  // a person whose role was never recorded (docs/ROLESCOPE.md) is also counted as one given their one more look: the claim stayed, so the look happened
  rs.record({ kind: m.kind, views: m.views, ...(cand.legacy ? { legacy: true, look: 'reed' } : {}) });
  return { measure: m, failed };
}

const count = (rows, f) => rows.filter(f).length;

/**
 * People whose role was never recorded (ROLE_SCOPE_LEGACY, docs/ROLESCOPE.md), given their one more look in this queue: Phase 1 says how many were screened
 * and rejected at the snippet stage (and, for Caterer, rejected after the unlock and what the unlocks cost), the rows say what became of the others.
 * `only` ('caterer' or 'reed') restricts it to one source (the blocks that travel in run_results.caterer_json and reed_json). null when no such person was met.
 */
function legacyBlock({ rows, c1, r1 }, only) {
  const lrows = rows.filter((r) => r.legacy === true && (!only || (r.source || 'caterer') === only));
  const sub = (s) => (s && s.legacy && typeof s.legacy === 'object' ? s.legacy : {});
  const cl = only === 'reed' ? {} : sub(c1);
  const rl = only === 'caterer' ? {} : sub(r1);
  const n = (x) => Number(x) || 0;
  const screened = n(cl.screened) + n(rl.screened);
  const rejectedAtSnippet = n(cl.rejectedAtSnippet) + n(rl.rejectedAtSnippet);
  if (!lrows.length && !screened && !rejectedAtSnippet) return null;
  const cat = lrows.filter((r) => (r.source || 'caterer') === 'caterer');
  const reed = lrows.filter((r) => r.source === 'reed');
  const catCharged = cl.charged !== undefined ? n(cl.charged) : count(cat, (r) => r.charge === 'charged');
  const catCredits = cl.credits !== undefined ? n(cl.credits) : cat.reduce((a, r) => a + n(r.credits), 0);
  return {
    screened: Math.max(screened, lrows.length + rejectedAtSnippet),
    rejectedAtSnippet,
    rejectedAfterUnlock: n(cl.rejectedAfterUnlock),
    candidates: lrows.length,
    caterer: cat.length,
    reed: reed.length,
    charged: catCharged + count(reed, (r) => r.charge === 'charged'),
    credits: catCredits,
    reedViews: reed.reduce((a, r) => a + n(r.views), 0),
    pushed: count(lrows, (r) => r.status === 'new'),
    cvRejected: count(lrows, (r) => r.status === 'cv_rejected'),
    held: count(lrows, (r) => !!r.held),
  };
}

/**
 * The results block of one queue: what the second look did. null when the queue holds no resurfaced candidate and no stop of the second look.
 * @param {{rows:object[], catererP1:object, reedP1:object, held:Map<string,string>}} o rows = the phaseResults of the queue
 */
function summary(o) {
  const rows = o.rows.filter((r) => r.resurfaced === true);
  const p1 = (s) => (s && s.resurfaced && typeof s.resurfaced === 'object' ? s.resurfaced : {});
  const c1 = p1(o.catererP1);
  const r1 = p1(o.reedP1);
  const held = [...o.held.values()];
  const stops = {
    capped: (Number(c1.capped) || 0) + (Number(r1.capped) || 0) + count(held, (w) => w === 'cap'),
    belowReserve: (Number(c1.belowReserve) || 0) + count(held, (w) => w === 'daily-limit'),
    balanceUnreadable: (Number(c1.balanceUnreadable) || 0) + count(held, (w) => w === 'unreadable'),
  };
  // Phase 1 also reports the re-opens it counted that never reached the queue (rejected by its own review after the unlock, or failed after a
  // charge): they were charged all the same, so they are part of the totals here
  const nq = c1.notQueued && typeof c1.notQueued === 'object' ? c1.notQueued : {};
  const nqn = (k) => Number(nq[k]) || 0;
  const notQueued = { charged: nqn('charged'), notCharged: nqn('notCharged'), chargedUnknown: nqn('chargedUnknown'), credits: nqn('credits'), rejectedAfterUnlock: nqn('rejectedAfterUnlock') };
  const nqAny = notQueued.charged + notQueued.notCharged + notQueued.chargedUnknown + notQueued.credits;
  const legacy = legacyBlock({ rows, c1, r1 });
  if (!rows.length && !stops.capped && !stops.belowReserve && !stops.balanceUnreadable && !held.length && !nqAny && !(Number(c1.failedNotCharged) > 0) && !legacy) return null;
  const sub = (src) => {
    const mine = rows.filter((r) => (r.source || 'caterer') === src);
    const lg = legacyBlock({ rows, c1, r1 }, src);
    return {
      candidates: mine.length,
      charged: count(mine, (r) => r.charge === 'charged'),
      notCharged: count(mine, (r) => r.charge === 'notCharged'),
      chargedUnknown: count(mine, (r) => r.charge === 'unknown'),
      credits: mine.reduce((a, r) => a + (Number(r.credits) || 0), 0),
      reedViews: mine.reduce((a, r) => a + (Number(r.views) || 0), 0),
      pushed: count(mine, (r) => r.status === 'new'),
      cvRejected: count(mine, (r) => r.status === 'cv_rejected'),
      held: count(mine, (r) => !!r.held),
      ...(lg ? { legacy: lg } : {}),
    };
  };
  const cat = sub('caterer');
  const reed = sub('reed');
  const sum = (k) => cat[k] + reed[k];
  return {
    block: {
      candidates: rows.length,
      caterer: cat.candidates,
      reed: reed.candidates,
      charged: sum('charged') + notQueued.charged,
      notCharged: sum('notCharged') + notQueued.notCharged,
      chargedUnknown: sum('chargedUnknown') + notQueued.chargedUnknown,
      credits: sum('credits') + notQueued.credits,
      chargedNotQueued: notQueued.charged + notQueued.chargedUnknown,
      rejectedAfterUnlock: notQueued.rejectedAfterUnlock,
      failedNotCharged: Number(c1.failedNotCharged) || 0,
      reedViews: sum('reedViews'),
      pushed: sum('pushed'),
      cvRejected: sum('cvRejected'),
      held: sum('held'),
      earlierAttempt: count(rows, (r) => r.charge === 'earlier'),
      ...stops,
      ...(legacy ? { legacy } : {}),
    },
    caterer: cat.candidates ? cat : null,
    reed: reed.candidates ? reed : null,
  };
}

/** The one line a run prints. */
function line(block) {
  return `Resurfaced (unlocked earlier, rejected for another role, screened again for this one): ${block.candidates} candidate(s), charged ${block.charged}, not charged ${block.notCharged}, charge unknown ${block.chargedUnknown}; credits spent ${block.credits} (${block.chargedNotQueued || 0} of the charges for people rejected right after the unlock), Reed views spent ${block.reedViews}; pushed ${block.pushed}, rejected again ${block.cvRejected}, held back ${block.held}; stopped by the cap ${block.capped}, by the reserve ${block.belowReserve}, balance unreadable ${block.balanceUnreadable}.`;
}

/** The line a run prints about the people whose role was never recorded. */
function legacyLine(l) {
  return `Role scope (people whose role was never recorded, one more look for this role): ${l.screened} screened, rejected at the snippet stage ${l.rejectedAtSnippet}, queued ${l.candidates} (Caterer ${l.caterer}, Reed ${l.reed}), rejected after the unlock ${l.rejectedAfterUnlock}; charged ${l.charged}, credits spent ${l.credits}, Reed views spent ${l.reedViews}; pushed ${l.pushed}, rejected by the CV stage ${l.cvRejected}, held back ${l.held}.`;
}

module.exports = { reedResurfaced, summary, line, legacyLine, legacyBlock, readViews };
