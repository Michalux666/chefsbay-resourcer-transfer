'use strict';
// The Phase 1 side of the role-scoped second look (docs/RESURFACE.md): a candidate who was unlocked earlier and rejected by CV screening for
// ANOTHER role comes up in this search, or a person whose role was never recorded (ROLE_SCOPE_LEGACY, docs/ROLESCOPE.md: unlocked, never pushed, no usable record, old
// enough), whose one more look is claimed, measured and recorded in exactly the same way (the card carries `legacy: true` and is counted as such). dedupe.js flags the card (the rule is scripts/lib/resurface.js, read from candidates.db by
// candidates-db.js check-batch-scoped); the normal snippet screening decides for this role; and only when that approves, unlockPass calls
// begin() before it fetches the contact details and the CV link again, and end() after it.
//
//   gate():  the balance is read (the reserve). An unreadable balance or one below the reserve is LATCHED for the rest of the run: the later
//            resurfaced cards are held back without another read (a broken reader costs one read, not one per card), and dedupe stops flagging them,
//            so they are not even screened.
//   begin(): the claim is written to candidates.db BEFORE anything is fetched (a candidate_rejections row for this title, origin 'resurface:started'),
//            which also takes a slot of the daily cap. Any failure on this path (cap reached, claim refused, database error) leaves the candidate
//            skipped, nothing recorded.
//   end():   the balance is read again and the cost of the re-open is measured (before and after). A claim is taken back only when the unlock failed
//            and the measurement shows nothing was spent; in every other case it stays (a second charge for the same role is never allowed). A
//            re-open that failed without a charge is noted for the day, so the same person is not screened and tried again by every run.
//   Resurfaced cards are unlocked AFTER the normal cards of their page (orderForUnlock): the balance read navigates the shared browser to the
//   search page, and the normal unlocks of the page must not depend on where the browser is.
//
// The unlock endpoint is the only call of this system that returns a candidate's contact details and CV link, and it is the call the pipeline has
// always made for a card that shows "Unlocked previously"; it is the "re-open". Whether the platform charges for it is the platform's
// answer, and this module measures it.

const { dbRun, dbWrite, idStr } = require('./db');
const { creditsCheck } = require('./session');

function lib() {
  try { return require('../lib/resurface'); } catch (e) { return null; }
}

/** The counters of this run (created on first use, so a run that never meets a resurfaced card carries nothing). */
function stats(ctx) {
  const st = ctx.st;
  if (!st.resurface) st.resurface = { eligible: 0, claimed: 0, released: 0, capped: 0, reserve: 0, unreadable: 0, failed: 0, postRejected: 0, legacyScreened: 0, legacyRejectedSnippet: 0, legacyRejectedAfter: 0, counted: [] };
  return st.resurface;
}

const record = (ev) => { const rs = lib(); if (rs) rs.record(ev); };

/** The dedupe step found `n` eligible candidates held back by the daily cap. */
function noteCapped(ctx, n) {
  if (!n) return;
  stats(ctx).capped += n;
  record({ stop: 'capped', n });
  const rs = lib();
  if (rs && rs.alertStopped({ why: 'cap', detail: `${ctx.p.JOB_TITLE} ${ctx.p.LOCATION}.` })) ctx.out('ALERT: the daily cap of resurfaced candidates was reached');
}

/** A normal unlock may spend credits: the balance read before is no longer a starting point. */
function invalidate(ctx) {
  if (ctx.st.balance) ctx.st.balance.valid = false;
}

// The balance, read through the same script the run uses at its start and end (caterer-get-credits.js); null when it cannot be read.
// A reading taken right after a resurfaced unlock is the starting point of the next one as long as nothing else was unlocked in between.
async function readBalance(ctx, fresh) {
  const c = ctx.st.balance;
  if (!fresh && c && c.valid && c.value !== null) return c.value;
  let n = null;
  try {
    const r = await creditsCheck(ctx);
    n = r && r.credits !== null && /^\d{1,9}$/.test(String(r.credits)) ? Number(r.credits) : null;
  } catch (e) {
    n = null;
  }
  ctx.st.balance = { value: n, valid: n !== null };
  return n;
}

function parseJsonLine(r) {
  try {
    const line = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).find((l) => /^\{/.test(l));
    return line ? JSON.parse(line) : null;
  } catch (e) {
    return null;
  }
}

const HOLD_TEXT = {
  unreadable: 'the Caterer balance could not be read, so the reserve cannot be checked',
  reserve: 'the balance is below the reserve of credits kept for normal unlocks',
};

/**
 * The reserve check, once per run. Latches the first failure (unreadable balance, balance below the reserve) in ctx.st.
 * @returns {Promise<{go:true, before:number}|{go:false, why:'unreadable'|'reserve'|'disabled'}>}
 */
async function gate(ctx) {
  const { p, out } = ctx;
  const rs = lib();
  if (!rs || !(rs.active() || rs.legacyActive())) return { go: false, why: 'disabled' };
  if (ctx.st.resurfaceHold) return { go: false, why: ctx.st.resurfaceHold };
  const cfg = rs.settings();
  const before = await readBalance(ctx, false);
  if (before === null) {
    ctx.st.resurfaceHold = 'unreadable';
    out(`    RESURFACE held back for this run: ${HOLD_TEXT.unreadable} (nothing recorded)`);
    return { go: false, why: 'unreadable' };
  }
  if (before < cfg.minCredits) {
    ctx.st.resurfaceHold = 'reserve';
    out(`    RESURFACE held back for this run: the balance (${before}) is below the reserve of ${cfg.minCredits} credits (nothing recorded)`);
    if (rs.alertStopped({ why: 'reserve', detail: `${p.JOB_TITLE} ${p.LOCATION}.` })) out('ALERT: resurfaced candidates are held back by the credit reserve');
    return { go: false, why: 'reserve' };
  }
  return { go: true, before };
}

/** Counts `n` candidates held back by the reserve check (or the unreadable balance). */
function noteHeld(ctx, why, n) {
  const rs = lib();
  if (!rs || (why !== 'reserve' && why !== 'unreadable') || !(n > 0)) return;
  stats(ctx)[why] += n;
  rs.record({ stop: why, n });
}

/** Cards of a page in the order they are unlocked: the normal ones first, the resurfaced ones last (the order inside each group is kept). */
function orderForUnlock(cards) {
  if (!Array.isArray(cards) || !cards.some((c) => c && c.resurfaced)) return cards;
  return cards.filter((c) => !(c && c.resurfaced)).concat(cards.filter((c) => c && c.resurfaced));
}

/** Before the unlock of a resurfaced card. @returns {Promise<{go:boolean, before?:number}>} */
async function begin(ctx, card) {
  const { p, out } = ctx;
  const rs = lib();
  const s = stats(ctx);
  const g = await gate(ctx);
  if (!g.go) {
    if (g.why === 'disabled') out('    RESURFACE left skipped: the second look is switched off');
    else { out(`    RESURFACE left skipped: ${HOLD_TEXT[g.why]} (nothing recorded)`); noteHeld(ctx, g.why, 1); }
    return { go: false };
  }
  const before = g.before;
  const r = await dbRun(ctx, ['resurface-claim', 'caterer', idStr(card.id), p.JOB_TITLE]);
  const ans = !r.timedOut && !r.error && r.code === 0 ? parseJsonLine(r) : null;
  if (!ans || ans.claimed !== true) {
    const why = ans && ans.why ? String(ans.why).slice(0, 30) : 'database error';
    out(`    RESURFACE left skipped: the claim was not made (${why}; nothing recorded)`);
    if (why === 'cap') {
      s.capped++;
      rs.record({ stop: 'capped' });
      if (rs.alertStopped({ why: 'cap', detail: `${p.JOB_TITLE} ${p.LOCATION}.` })) out('ALERT: the daily cap of resurfaced candidates was reached');
    }
    return { go: false };
  }
  s.claimed++;
  out(`    RESURFACE claimed for this role (${card.unlockedPrev ? 'the platform shows: unlocked previously' : 'the platform shows: never unlocked'}); the unlock below is the second look`);
  return { go: true, before };
}

/**
 * After the unlock of a resurfaced card (whether it worked or not). Measures the cost and takes the claim back only when nothing was spent
 * and the unlock failed. @returns {Promise<{kind:string, credits:number}>}
 */
async function end(ctx, card, begun, unlockOk) {
  const { p, out } = ctx;
  const rs = lib();
  const after = await readBalance(ctx, true);
  const m = rs.measure(begun.before, after, 'credits');
  const s = stats(ctx);
  if (!unlockOk && m.kind === 'notCharged') {
    const r = await dbRun(ctx, ['resurface-release', 'caterer', idStr(card.id), p.JOB_TITLE]);
    const ans = !r.timedOut && !r.error && r.code === 0 ? parseJsonLine(r) : null;
    if (ans && ans.released === true) {
      s.released++;
      s.failed++;
      rs.noteFailed('caterer', card.id, p.JOB_TITLE);
      out('    RESURFACE claim taken back: the unlock failed and the balance did not move (not tried again today)');
    }
    return m;
  }
  // a person whose role was never recorded (docs/ROLESCOPE.md) is also counted as one given their one more look: the claim stayed, so the look happened
  rs.record({ kind: m.kind, credits: m.credits, ...(card.legacy ? { legacy: true, look: 'caterer' } : {}) });
  s.counted.push({ id: idStr(card.id), kind: m.kind, credits: m.credits, legacy: !!card.legacy });
  const word = m.kind === 'charged' ? `charged, ${m.credits} credit(s)` : (m.kind === 'notCharged' ? 'not charged' : 'charge unknown (the balance could not be compared)');
  out(`    RESURFACE re-opened: ${word}`);
  return m;
}

/** The fields a queue entry of a resurfaced candidate carries (numbers and codes only). */
function entryFields(m, card) {
  const f = { resurfaced: true, resurfaceCharge: m.kind };
  if (m.credits) f.resurfaceCredits = m.credits;
  if (card && card.legacy) f.legacy = true;
  return f;
}

/**
 * A card rejected by Phase 1's own review AFTER its unlock. Counted when it was a resurfaced one (the charge itself was counted by end()), and, while the
 * second look is active, the rejection is recorded for this role (origin resurface:postunlock), so the person is not screened or charged again for it.
 * With the second look off nothing is written, exactly as before.
 */
async function postUnlockRejected(ctx, card) {
  if (card && card.resurfaced) stats(ctx).postRejected++;
  const rs = lib();
  if (card && card.legacy) {
    stats(ctx).legacyRejectedAfter++;
    if (rs) rs.record({ legacyRejected: true });
  }
  if (!rs || !rs.active()) return;
  await dbRun(ctx, ['resurface-reject', 'caterer', idStr(card.id), ctx.p.JOB_TITLE, 'postunlock']);
}

/**
 * A person whose role was never recorded (ROLE_SCOPE_LEGACY, docs/ROLESCOPE.md), screened once more for this role, was rejected by the snippet screening:
 * the rejection is recorded for this role (origin resurface:snippet, the form the role scope reads: a person looked at once stays eligible for any other
 * role and is never screened for this one again), and the look is counted. A failed write is a database failure like any other bookkeeping write.
 */
async function legacyRejected(ctx, card) {
  stats(ctx).legacyRejectedSnippet++;
  await dbWrite(ctx, ['resurface-reject', 'caterer', idStr(card.id), ctx.p.JOB_TITLE, 'legacy']);
}

/**
 * The block phase1Stats.resurfaced of the queue. The entries give what was queued (and survive a resumed run); what this process counted and did not
 * queue (rejected after the unlock, failed after a charge) goes into notQueued, so the block holds every charge. null when there is nothing to say.
 */
function queueStats(ctx) {
  const { st } = ctx;
  const mine = (st.approved || []).filter((c) => c && c.resurfaced === true);
  const s = st.resurface || {};
  const queuedIds = new Set(mine.map((c) => idStr(c.id)));
  const lost = (s.counted || []).filter((c) => !queuedIds.has(c.id));
  if (!mine.length && !lost.length && !s.eligible && !s.capped && !s.reserve && !s.unreadable && !s.failed) return null;
  const count = (kind) => mine.filter((c) => c.resurfaceCharge === kind).length;
  const lostCount = (kind) => lost.filter((c) => c.kind === kind).length;
  const mineLegacy = mine.filter((c) => c.legacy === true);
  const legacy = (s.legacyScreened || mineLegacy.length || lost.some((c) => c.legacy))
    ? {
      screened: s.legacyScreened || 0,
      rejectedAtSnippet: s.legacyRejectedSnippet || 0,
      rejectedAfterUnlock: s.legacyRejectedAfter || 0,
      candidates: mineLegacy.length,
      charged: mineLegacy.filter((c) => c.resurfaceCharge === 'charged').length + lost.filter((c) => c.legacy && c.kind === 'charged').length,
      credits: mineLegacy.reduce((a, c) => a + (Number(c.resurfaceCredits) || 0), 0) + lost.filter((c) => c.legacy).reduce((a, c) => a + (Number(c.credits) || 0), 0),
    }
    : null;
  return {
    candidates: mine.length,
    charged: count('charged'),
    notCharged: count('notCharged'),
    chargedUnknown: count('unknown'),
    credits: mine.reduce((a, c) => a + (Number(c.resurfaceCredits) || 0), 0),
    notQueued: {
      charged: lostCount('charged'),
      notCharged: lostCount('notCharged'),
      chargedUnknown: lostCount('unknown'),
      credits: lost.reduce((a, c) => a + (Number(c.credits) || 0), 0),
      rejectedAfterUnlock: s.postRejected || 0,
    },
    failedNotCharged: s.failed || 0,
    capped: s.capped || 0,
    belowReserve: s.reserve || 0,
    balanceUnreadable: s.unreadable || 0,
    ...(legacy ? { legacy } : {}),
  };
}

/** One line per run when CV_RESURFACE or a number setting is not understood (the setting is then not what the owner meant). */
function warnOnce(ctx) {
  if (ctx.st.resurfaceWarned) return;
  ctx.st.resurfaceWarned = true;
  const rs = lib();
  if (!rs) return;
  try { for (const w of rs.allWarnings()) ctx.out(`WARN ${w}`); } catch (e) { /* settings are advisory here */ }
}

module.exports = { stats, noteCapped, invalidate, readBalance, gate, noteHeld, orderForUnlock, begin, end, entryFields, queueStats, postUnlockRejected, legacyRejected, warnOnce };
