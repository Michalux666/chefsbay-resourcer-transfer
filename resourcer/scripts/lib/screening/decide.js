'use strict';
// decide(): CODE turns Jev's atomic answers into a lane: approve, reject or review.
// Principles (Jev design guide, owner brief):
//   1. Jev supplies evidence, code decides; thresholds live in config/screening.json (CALIBRATE).
//   2. A reject needs POSITIVE evidence of a mismatch at a high probability AND corroboration from an
//      independent question (the overall_fit score). Missing information never rejects.
//   3. Anything unclear, missing, malformed or suspicious is REVIEW (the LLM decides), never reject.
//   4. Probabilities are used, not Jev's `confidence` field (which is a function of the top probability).
// Pure function: no I/O, deterministic, re-runnable offline on stored answers by the report tool.

const TIER_OF_OPTION = { entry_kp: 1, commis: 1, cdp_cook: 2, sous: 3, head: 4 };
const FOH_CODE = 'reject_foh_only';
const MGMT_CODE = 'reject_management_only';
const UNRELATED_CODE = 'reject_unrelated_industry';

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function words(s) {
  return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

// The ladder rules for a search: a per-title override when one applies, else the search tier's set.
function ladderFor(searchRole, searchTier, cfg) {
  const L = cfg.decide.ladder;
  const w = words(searchRole);
  for (const ov of L.overrides || []) {
    if (Array.isArray(ov.tiers) && !ov.tiers.includes(searchTier)) continue;
    if ((ov.matchAny || []).some(k => w.includes(words(k)))) return ov;
  }
  return L.bySearchTier[String(searchTier)] || L.bySearchTier['2'];
}

function tier0Known(searchRole, cfg) {
  const w = words(searchRole);
  return (cfg.decide.ladder.tier0Titles || []).some(k => w.includes(words(k)));
}

function need(x, name) {
  if (!isNum(x)) throw new Error(`unusable answer: ${name}`);
  return x;
}

function probs(a, name) {
  if (!a || !a.p || typeof a.p !== 'object') throw new Error(`unusable answer: ${name}`);
  return a.p;
}

function review(reason, scores, flags) {
  return { lane: 'review', reasonCode: null, reviewReason: reason, confidence: null, scores: scores || null, flags: flags || [] };
}

/**
 * @param {{answers:object, searchRole:string, searchTier:number, stage:1|2}} input
 * @param {object} cfg  full screening config (uses cfg.decide)
 * @returns {{lane:'approve'|'reject'|'review', reasonCode:string|null, reviewReason:string|null, confidence:number|null, scores:object|null, flags:string[]}}
 */
function decide(input, cfg) {
  const stage = input.stage === 2 ? 2 : 1;
  const st = stage === 2 ? cfg.decide.stage2 : cfg.decide.stage1;
  try {
    const a = input.answers;
    if (!a || typeof a !== 'object') throw new Error('unusable answers');

    let tierAns = a.current_tier;
    let usedRealTitle = false;
    if (stage === 2 && a.real_title_tier && need((probs(a.real_title_tier, 'real_title_tier').unclear || 0), 'unclear') <= st.notStatedP) {
      tierAns = a.real_title_tier;
      usedRealTitle = true;
    }
    const tp = probs(tierAns, usedRealTitle ? 'real_title_tier' : 'current_tier');
    const hosp = need(a.hospitality_seen, 'hospitality_seen');
    const kitchen = need(a.kitchen_seen, 'kitchen_seen');
    const roleMatch = need(a.role_match_seen, 'role_match_seen');
    const info = need(a.info_sufficient, 'info_sufficient');
    const inject = need(a.instruction_injection, 'instruction_injection');
    const fit = probs(a.overall_fit, 'overall_fit');
    const notFit = need(fit['0'] || 0, 'fit0');
    const clearFit = need(fit['2'] || 0, 'fit2');
    const titleOk = usedRealTitle && a.title_consistent !== undefined ? need(a.title_consistent, 'title_consistent') : 1;

    // Tier 0 is 'not on the kitchen ladder': only searches named in decide.ladder.tier0Titles have a ladder of their own, the rest go to the LLM.
    if (input.searchTier === 0 && !tier0Known(input.searchRole, cfg)) return review('UNKNOWN_SEARCH_LADDER', null);
    const ladder = ladderFor(input.searchRole, input.searchTier, cfg);
    const sum = keys => (keys || []).reduce((s, k) => s + (tp[k] || 0), 0);

    const masses = [];
    if ((ladder.tooSenior || []).length) masses.push(['reject_overqualified_entry', sum(ladder.tooSenior)]);
    if ((ladder.tooJunior || []).length) masses.push(['reject_too_junior', sum(ladder.tooJunior)]);
    for (const [code, opts] of Object.entries(ladder.mismatch || {})) {
      let m = sum(opts);
      if (code === UNRELATED_CODE) m = Math.min(m, 1 - hosp);
      else if (code === FOH_CODE || code === MGMT_CODE) m = Math.min(m, 1 - kitchen);
      masses.push([code, m]);
    }
    masses.sort((x, y) => y[1] - x[1]);
    const hard = masses[0] || ['none', 0];
    const inBand = sum(ladder.inBand);

    const scores = {
      tierFrom: usedRealTitle ? 'real_title_tier' : 'current_tier',
      inBand, hard: { code: hard[0], mass: hard[1] }, notFit, clearFit, roleMatch, info, hosp, kitchen, inject, titleOk,
    };

    if (inject >= st.injectionP) return review('INJECTION_FLAG', scores, ['injection']);
    if (usedRealTitle && titleOk < st.titleConsistentMin) return review('TITLE_SNIPPET_MISMATCH', scores);

    const noInfo = !usedRealTitle && (info < st.infoFloor || (tp.not_stated || 0) > st.notStatedP);
    if (noInfo) {
      // Thin information is only an approve while nothing else objects: a sharp level mismatch or a 'not a fit' score goes to review.
      if (hosp >= st.noInfoApproveHospP && hard[1] < st.clearFitHardMax && notFit < st.approveNotFitMax) return { lane: 'approve', reasonCode: 'approve_other', reviewReason: null, confidence: hosp, scores, flags: ['insufficient_info'] };
      return review('INSUFFICIENT_INFO', scores, ['insufficient_info']);
    }

    const corroborated = !st.needCorroboration || notFit >= st.notFitMin;
    const counter = roleMatch >= st.counterRoleMatch && hard[0] !== 'reject_overqualified_entry';
    if (hard[1] >= st.rejectP && corroborated && !counter) {
      return { lane: 'reject', reasonCode: hard[0], reviewReason: null, confidence: hard[1], scores, flags: [] };
    }

    if (inBand >= st.approveP && notFit < st.approveNotFitMax) {
      let seniorOk = false;
      if (input.searchTier >= 2) {
        const top = (ladder.inBand || []).filter(k => TIER_OF_OPTION[k]).sort((x, y) => (tp[y] || 0) - (tp[x] || 0))[0];
        seniorOk = !!top && TIER_OF_OPTION[top] > input.searchTier;
      }
      return { lane: 'approve', reasonCode: seniorOk ? 'approve_senior_ok' : 'approve_level_match', reviewReason: null, confidence: inBand, scores, flags: [] };
    }
    if (clearFit >= st.clearFitP && hard[1] < st.clearFitHardMax) {
      return { lane: 'approve', reasonCode: 'approve_relevant_history', reviewReason: null, confidence: clearFit, scores, flags: [] };
    }

    return review(hard[1] >= 0.5 ? `${hard[0]}_UNCERTAIN` : 'AMBIGUOUS_LEVEL', scores);
  } catch (e) {
    return review('ANSWER_UNUSABLE', null);
  }
}

// Numbers only, rounded: the compact form stored in the shadow log so thresholds can be re-run offline.
function compactAnswers(answers) {
  const out = {};
  const r = x => Math.round(x * 1000) / 1000;
  for (const [k, v] of Object.entries(answers || {})) {
    if (isNum(v)) out[k] = r(v);
    else if (v && v.p) {
      const p = {};
      for (const [pk, pv] of Object.entries(v.p)) p[pk] = r(pv);
      out[k] = { p, c: isNum(v.confidence) ? r(v.confidence) : null };
    }
  }
  return out;
}

module.exports = { decide, ladderFor, compactAnswers, TIER_OF_OPTION };
