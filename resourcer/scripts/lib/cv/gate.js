'use strict';
// The gate: CODE turns Jev's answers and the facts it computed into pass or reject. Pure, deterministic, no I/O, so the
// same answers can be re-run offline under other numbers (tools/eval.js does exactly that for the operating-point sweep).
//
// FORCED CHOICE. The gate never abstains: it always returns pass or reject. It computes pReject, the probability that this CV
// is a clear mismatch for the searched role, from Jev's probabilities and the facts, and applies ONE operating point:
//     reject  when  pReject >= tau      tau = config operatingPoint (0.75 for the default costs: a lost candidate costs 3, a
//                                       wasted credit 1, so a CV is only rejected when a mismatch is at least 3 times as
//                                       likely as not). Doubt therefore leans pass; a clear mismatch is rejected.
// A decision taken while pReject was between forced.low and forced.high is marked 'forced' and keeps its confidence.
//
// How pReject is built (all numbers are in config; there is no job-title table and no title regex in this file):
//   four clear-mismatch rules, each turned into a probability from the answers of Jev about the listed roles:
//     noRelevant  the relevant months fall short of minRelevantMonths (a straight line: next to none is a clear mismatch, a few months is
//                 doubt) AND the whole-history answers agree (overall match weak, or a change of career)
//     stale       the newest relevant work is old (a straight line from staleYears to staleFullYears)
//                 (both amount rules are asked of the same combination of "which roles are relevant", over the roles in real doubt)
//     over        the recent roles Jev could place are two or more steps above the searched role (levels that switch it on)
//     under       every same-field role whose level Jev could tell is clearly below the searched level
//     a job Jev could not place at all (a bare title) counts as possibly relevant (evidence.unclearRelevantP), never as unrelated
//   pReject = the largest of the rule groups, weighted by how much the evidence deserves to count: a badly read CV can never be rejected on
//   its own (parse weight), and a very short history weakens the amount rules (thin weight). The search level is a distribution
//   over levels, so an unsure level is a mixture of the levels' rules rather than a guess.

const { unionMonths } = require('./facts');

const CODE = { noRelevant: 'no_relevant_experience', careerChange: 'career_change', stale: 'stale_experience', over: 'over_qualified', under: 'under_qualified', empty: 'no_roles' };
const RULE_ORDER = ['noRelevant', 'stale', 'over', 'under', 'empty'];

const REASON_TEXT = {
  pass_relevant_history: 'the work history contains enough relevant, recent experience at a suitable level',
  pass_doubt: 'in doubt, so the CV goes on to a recruiter',
  forced: 'decided in real doubt by the operating point; audit this one',
  no_relevant_experience: 'too little relevant experience in the work history for the searched role',
  career_change: 'the work history is mostly in a different line of work (a change of career)',
  stale_experience: 'the relevant experience ended too long ago',
  over_qualified: 'the recent roles are two or more levels above the searched role',
  under_qualified: 'every role in the same field is clearly below the level of the searched role',
  no_roles: 'the CV was read well but lists no work history at all',
  thin_evidence: 'very little dated work history, so the amount rules counted for less',
  parse_low_confidence: 'the CV was read with low confidence, so the evidence counted for less',
  vague_roles: 'a job was described too vaguely to judge (a bare title), so it counted as possibly relevant',
  injection_signal: 'the CV text contains something that reads like an instruction to a reviewer',
  injection_flag: 'the CV text tries to instruct the reviewer',
  redaction_unverified: 'personal data could not be removed with certainty, so the CV was not sent to Jev',
  answers_invalid: 'Jev answered but the answers were not usable',
  policy_fallback_approve: 'the fallback policy sent the CV on to a recruiter',
  policy_fallback_reject: 'the fallback policy rejected the CV',
  policy_kept_reject: 'an injection attempt never turns a reject into an approval',
  unreadable: 'the CV could not be read, so the snippet decision stands',
};

const r3 = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
const clamp01 = x => Math.min(1, Math.max(0, x));

function sumKeys(p, keys) {
  let s = 0;
  for (const k of keys) s += Number((p && p[k]) || 0);
  return clamp01(s);
}

function levelSum(p, from, to, skip) {
  let s = 0;
  for (let k = from; k <= to; k++) if (k !== skip) s += Number((p && p[String(k)]) || 0);
  return clamp01(s);
}

/** P(at least `need` of the independent events with these probabilities happen). */
function atLeast(probs, need) {
  let dist = [1];
  for (const p of probs) {
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  let s = 0;
  for (let k = Math.max(0, need); k < dist.length; k++) s += dist[k];
  return clamp01(s);
}

// How far the relevant months fall short of the minimum: 0 at the minimum or more, 1 at noneAt months or fewer, a straight line between
// (a stint of a few months is doubt, not "no relevant experience"; only next to no relevant work at all is a clear mismatch).
function shortfall(months, minMonths, noneAt) {
  if (months >= minMonths) return 0;
  const floor = Math.min(noneAt, minMonths - 1);
  return clamp01((minMonths - months) / (minMonths - floor));
}

// How stale the newest relevant work is: 0 up to startMonths ago, 1 from fullMonths ago, a straight line between.
function staleness(agoMonths, startMonths, fullMonths) {
  if (agoMonths <= startMonths) return 0;
  const full = Math.max(fullMonths, startMonths + 1);
  return clamp01((agoMonths - startMonths) / (full - startMonths));
}

// A role Jev is at least this sure about is treated as settled (relevant or not); only the roles in real doubt are enumerated, so a
// long history costs nothing extra and the number of roles is limited by what Jev is sent, not by the arithmetic.
const SETTLED = 0.005;
const MAX_UNSETTLED = 14;

/**
 * Probabilities over every combination of "which roles are relevant" (roles are independent, at most MAX_UNSETTLED of them in real
 * doubt): the shortfall of the relevant months against the minimum, and how stale the newest relevant work is.
 */
function relevanceOutcomes(per, opts) {
  const unsettled = per.map((x, i) => i).filter(i => per[i].pRel > SETTLED && per[i].pRel < 1 - SETTLED)
    .sort((a, b) => Math.min(per[b].pRel, 1 - per[b].pRel) - Math.min(per[a].pRel, 1 - per[a].pRel)).slice(0, MAX_UNSETTLED);
  const inDoubt = new Set(unsettled);
  const fixed = per.map((x, i) => i).filter(i => !inDoubt.has(i) && per[i].pRel >= 0.5);
  const n = unsettled.length;
  let short = 0;
  let stale = 0;
  let amount = 0;
  let expMonths = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let prob = 1;
    for (let j = 0; j < n && prob > 0; j++) prob *= (mask & (1 << j)) ? per[unsettled[j]].pRel : 1 - per[unsettled[j]].pRel;
    if (prob < 1e-12) continue;
    const iv = [];
    let undated = false;
    let anyDated = false;
    let newestEnd = -Infinity;
    const chosen = fixed.concat(unsettled.filter((i, j) => mask & (1 << j)));
    for (const i of chosen) {
      const r = per[i].r;
      if (!r.dated) { undated = true; continue; }
      anyDated = true;
      iv.push([r.startIdx, r.endIdx]);
      if (r.endIdx > newestEnd) newestEnd = r.endIdx;
    }
    const months = unionMonths(iv, opts.winLo, opts.nowIdx) + (undated ? opts.undatedCredit : 0);
    expMonths += prob * months;
    const sf = shortfall(months, opts.minMonths, opts.noneAtMonths);
    const st = opts.staleStart !== null && anyDated && !undated ? staleness(opts.nowIdx - newestEnd, opts.staleStart, opts.staleFull) : 0;
    short += prob * sf;
    stale += prob * st;
    // the two amount rules are asked of the SAME combination, so a role that is either not relevant (no experience) or relevant but old
    // (stale) is a reject on both sides, not half a reject on each
    amount += prob * Math.max(opts.noRelevantOn ? sf * opts.corroboration : 0, opts.staleOn ? st : 0);
  }
  return { short: clamp01(short), stale: clamp01(stale), amount: clamp01(amount), expMonths };
}

function perRole(roles, answers, L, T, nRel, cfg) {
  const skip = T.unclearLevel > 0 && T.unclearLevel < nRel ? T.unclearLevel : -1;
  const prior = cfg.evidence.unclearRelevantP;
  return roles.map((r, i) => {
    const rel = answers.relevance[i].p;
    const sen = answers.seniority[i].p;
    const pU = skip >= 0 ? Number(rel[String(skip)] || 0) : 0;
    const pSame = clamp01(levelSum(rel, T.sameFieldMinLevel, nRel - 1, skip) + prior * pU);
    return {
      r,
      pUnclear: pU,
      pRel: clamp01(levelSum(rel, L.relevantMinLevel, nRel - 1, skip) + prior * pU),
      pSame,
      pMeets: sumKeys(sen, L.seniority.comparableOrSenior),
      // the level rules only hear from jobs in the same line of work whose level Jev could tell (any answer but cannot_tell)
      pDefinite: clamp01(pSame * (1 - Number((sen && sen.cannot_tell) || 0))),
      pJunior: clamp01(pSame * sumKeys(sen, L.seniority.tooJunior)),
      pOver: clamp01(pSame * sumKeys(sen, L.seniority.tooSenior)),
    };
  });
}

// The four rule probabilities for one level of the searched role, before any evidence weight.
function ruleProbabilities(ctx, L) {
  const { facts, answers, cfg } = ctx;
  const T = cfg.thresholds;
  const nowIdx = facts.nowIdx;
  const per = perRole(facts.roles, answers, L, T, ctx.nRel, cfg);
  const winMonths = L.relevantWindowYears > 0 ? L.relevantWindowYears * 12 : Infinity;
  const winLo = Number.isFinite(winMonths) ? nowIdx - winMonths + 1 : undefined;
  const staleStart = L.staleYears > 0 ? L.staleYears * 12 : null;
  const staleFull = Math.max(L.staleFullYears || L.staleYears, L.staleYears) * 12;

  const out = { noRelevant: 0, stale: 0, over: 0, under: 0, amount: 0, corroboration: 0, ccOn: false, per, expRelevantMonths: 0 };

  const corr = L.rejects.careerChange ? Math.max(ctx.pWeak, ctx.pCareerChange) : ctx.pWeak;
  const rel = relevanceOutcomes(per, { winLo, nowIdx, staleStart, staleFull, minMonths: L.minRelevantMonths, noneAtMonths: cfg.evidence.noneAtMonths, undatedCredit: cfg.evidence.undatedCreditMonths, noRelevantOn: L.rejects.noRelevantExperience, staleOn: L.rejects.stale, corroboration: corr });
  out.expRelevantMonths = rel.expMonths;
  out.amount = rel.amount;
  if (L.rejects.noRelevantExperience) {
    out.corroboration = corr;
    out.ccOn = L.rejects.careerChange;
    out.noRelevant = rel.short * corr;
  }
  if (L.rejects.stale) out.stale = rel.stale;

  if (L.rejects.overQualified && L.seniority.tooSenior.length) {
    const recent = per.filter(x => x.r.dated && x.r.endedAgo <= L.recentYears * 12);
    if (recent.length && L.overRecentShare >= 1) {
      // every recent job Jev could place is two or more steps senior (a recent job it could not place, another line of work, does not dilute it)
      let allOver = 1;
      let noneTold = 1;
      for (const x of recent) {
        allOver *= 1 - x.pDefinite + x.pOver;
        noneTold *= 1 - x.pDefinite;
      }
      out.over = clamp01(allOver - noneTold);
    } else if (recent.length) {
      const need = Math.max(1, Math.ceil(L.overRecentShare * recent.length - 1e-9));
      out.over = atLeast(recent.map(x => x.pOver), need);
    }
  }

  if (L.requireComparableOrSenior && L.rejects.underQualified && L.seniority.tooJunior.length) {
    const C = per.filter(x => (x.r.dated ? x.r.endedAgo <= winMonths : true));
    if (C.length) {
      // a job whose level Jev could tell (any answer but cannot_tell) is evidence; a job that reaches the level (not clearly below) saves
      // the candidate; jobs Jev could not place (another line of work, a bare title) are neither
      let noSaver = 1;
      let noneTold = 1;
      for (const x of C) {
        noSaver *= 1 - Math.max(0, x.pDefinite - x.pJunior);
        noneTold *= 1 - x.pDefinite;
      }
      out.under = clamp01(noSaver - noneTold);
    }
  }
  return out;
}

function parseWeight(pc, ev) {
  if (pc === null || pc === undefined) return 1;
  return clamp01((pc - ev.parseFloor) / (ev.parseFull - ev.parseFloor));
}

function thinWeight(totalMonths, ev) {
  return clamp01((totalMonths - ev.thinFloorMonths) / (ev.thinFullMonths - ev.thinFloorMonths));
}

/**
 * Turns the one number into a decision. Exposed so the sweep can move the operating point without recomputing anything else.
 * @returns {{decision:'pass'|'reject', forced:boolean, confidence:number}}
 */
function applyOperatingPoint(pReject, tau, forced) {
  const decision = pReject >= tau - 1e-9 ? 'reject' : 'pass';
  return {
    decision,
    forced: pReject >= forced.low - 1e-9 && pReject <= forced.high + 1e-9,
    confidence: r3(decision === 'reject' ? pReject : 1 - pReject),
  };
}

/**
 * @param {{facts:object, level:string, levelDist?:Object<string,number>, levelP?:number, answers:{relevance:object[], seniority:object[], overall:object, progression:object, careerChange:number, injection:number}, cfg:object, tau?:number}} input
 *   levelDist: probability of each level of the searched role (a level the config does not know counts as 'unknown'); level: its most likely one
 * @returns {{decision:'pass'|'reject', forced:boolean, confidence:number, pReject:number, pRejectRaw:number, tau:number, reasonCodes:string[], evidence:object<string,number>, level:string, rules:object<string,number>}}
 */
function evaluate(input) {
  const { facts, answers, cfg } = input;
  const tau = typeof input.tau === 'number' ? input.tau : cfg.tau;
  const level = cfg.levels[input.level] ? input.level : 'unknown';
  const n = facts.roles.length;
  const ev = cfg.evidence;
  const pw = parseWeight(facts.parseConfidence, ev);
  const tw = thinWeight(facts.totalMonths, ev);

  const evidenceBase = {
    roles: n,
    rolesParsed: facts.rolesParsed,
    rolesOmitted: facts.rolesParsed - facts.rolesSent,
    undatedRoles: facts.undatedRoles,
    totalMonths: facts.totalMonths,
    monthsRecent: facts.monthsRecent,
    parseWeight: r3(pw),
    thinWeight: r3(tw),
    levelP: r3(input.levelP === undefined ? 0 : input.levelP),
    tau: r3(tau),
  };

  // An empty profile: nothing to ask Jev. The caller only gets here when the reader was sure (config evidence.emptyProfileMinParse).
  if (n === 0) {
    const pRaw = 1;
    const pReject = pw * pRaw;
    const d = applyOperatingPoint(pReject, tau, cfg.forced);
    const codes = d.decision === 'reject' ? [CODE.empty] : ['pass_doubt', 'parse_low_confidence'];
    if (d.forced) codes.unshift('forced');
    return { ...d, pReject: r3(pReject), pRejectRaw: pRaw, tau, reasonCodes: codes, level, rules: { noRelevant: 0, stale: 0, over: 0, under: 0, empty: r3(pReject) }, evidence: { ...evidenceBase, pRejectRaw: pRaw, pReject: r3(pReject) } };
  }

  if (!answers || !Array.isArray(answers.relevance) || answers.relevance.length !== n || !Array.isArray(answers.seniority) || answers.seniority.length !== n) {
    throw new Error('answers do not match the listed roles');
  }
  const nRel = cfg.questions.roleRelevance.levels.length;
  const nOv = cfg.questions.overallMatch.levels.length;
  const pWeak = levelSum(answers.overall.p, 0, cfg.thresholds.overallWeakMaxLevel);
  const pCC = clamp01(answers.careerChange);
  const ctx = { facts, answers, cfg, nRel, pWeak, pCareerChange: pCC };

  let dist = input.levelDist && Object.keys(input.levelDist).length ? input.levelDist : { [level]: 1 };
  const mixed = {};
  for (const [k, p] of Object.entries(dist)) {
    const key = cfg.levels[k] ? k : 'unknown';
    mixed[key] = (mixed[key] || 0) + p;
  }
  const total = Object.values(mixed).reduce((a, b) => a + b, 0) || 1;
  dist = Object.fromEntries(Object.entries(mixed).map(([k, p]) => [k, p / total]).filter(([, p]) => p >= 0.005));

  let pRaw = 0;
  const agg = { noRelevant: 0, stale: 0, over: 0, under: 0 };
  let amountRaw = 0;
  let lead = null;
  let detail = null;
  let sumP = 0;
  for (const [lv, p] of Object.entries(dist)) {
    const rp = ruleProbabilities(ctx, cfg.levels[lv]);
    const weighted = { noRelevant: rp.noRelevant * tw, stale: rp.stale * tw, over: rp.over, under: rp.under };
    const top = Math.max(rp.amount * tw, weighted.over, weighted.under);
    pRaw += p * top;
    amountRaw += p * rp.amount;
    sumP += p;
    for (const k of Object.keys(agg)) agg[k] += p * weighted[k];
    if (!lead || p > lead.p) { lead = { p, lv }; detail = rp; }
  }
  pRaw = clamp01(pRaw / (sumP || 1));
  for (const k of Object.keys(agg)) agg[k] = clamp01(agg[k] / (sumP || 1));
  const pReject = clamp01(pRaw * pw);
  const d = applyOperatingPoint(pReject, tau, cfg.forced);

  // reason codes: the rules that carried the probability, strongest first, then what weakened it
  const ranked = RULE_ORDER.filter(k => k !== 'empty').map(k => ({ k, p: agg[k] * pw })).sort((a, b) => b.p - a.p);
  let carried = ranked.filter(x => x.p >= cfg.forced.low - 1e-9);
  if (!carried.length && pReject >= cfg.forced.low - 1e-9) carried = ranked.slice(0, 1);
  // a doubt that only the reader-confidence weight took away is still a doubt: the rules that would have carried it are named
  if (!carried.length && pw < 1 && pRaw >= cfg.forced.low - 1e-9) carried = RULE_ORDER.filter(k => k !== 'empty').map(k => ({ k, p: agg[k] })).filter(x => x.p >= cfg.forced.low - 1e-9).sort((x, y) => y.p - x.p);
  const codes = [];
  const codeOf = x => {
    if (x.k === 'noRelevant') return detail && detail.ccOn && pCC >= 0.5 ? [CODE.noRelevant, CODE.careerChange] : [CODE.noRelevant];
    return [CODE[x.k]];
  };
  if (d.decision === 'reject') {
    for (const x of (carried.length ? carried : ranked.slice(0, 1))) for (const c of codeOf(x)) if (!codes.includes(c)) codes.push(c);
  } else if (!carried.length) {
    codes.push('pass_relevant_history');
  } else {
    codes.push('pass_doubt');
    for (const x of carried) for (const c of codeOf(x)) if (!codes.includes(c)) codes.push(c);
  }
  if (d.forced) codes.unshift('forced');
  if (tw < 1 && (amountRaw / (sumP || 1)) * pw >= cfg.forced.low - 1e-9) codes.push('thin_evidence');
  if (pw < 1 && pRaw >= cfg.forced.low - 1e-9) codes.push('parse_low_confidence');
  if (d.decision === 'pass' && carried.length && Math.max(0, ...detail.per.map(x => x.pUnclear)) >= 0.5) codes.push('vague_roles');

  const per = detail.per;
  const firm = per.filter(x => x.pRel >= 0.5 && x.r.dated);
  const winMonths = cfg.levels[lead.lv].relevantWindowYears > 0 ? cfg.levels[lead.lv].relevantWindowYears * 12 : Infinity;
  const relFirm = unionMonths(firm.map(x => [x.r.startIdx, x.r.endIdx]), Number.isFinite(winMonths) ? facts.nowIdx - winMonths + 1 : undefined, facts.nowIdx);
  const ends = firm.map(x => x.r.endedAgo);
  const evidence = {
    ...evidenceBase,
    relevantRoles: per.filter(x => x.pRel >= 0.5).length,
    relevantMonths: relFirm,
    relevantMonthsExpected: r3(detail.expRelevantMonths),
    monthsSinceRelevant: ends.length ? Math.min(...ends) : -1,
    maxMeetsP: r3(Math.max(0, ...per.map(x => x.pMeets))),
    maxUnclearP: r3(Math.max(0, ...per.map(x => x.pUnclear))),
    pNoRelevant: r3(agg.noRelevant),
    pStale: r3(agg.stale),
    pOver: r3(agg.over),
    pUnder: r3(agg.under),
    overallWeakP: r3(pWeak),
    overallStrongP: r3(levelSum(answers.overall.p, nOv - 1, nOv - 1)),
    careerChangeP: r3(pCC),
    injectionP: r3(answers.injection),
    progressionRisingP: r3(answers.progression.p.rising),
    progressionDecliningP: r3(answers.progression.p.declining),
    pRejectRaw: r3(pRaw),
    pReject: r3(pReject),
  };
  return {
    ...d,
    pReject: r3(pReject),
    pRejectRaw: r3(pRaw),
    tau,
    reasonCodes: codes,
    evidence,
    level: lead.lv,
    rules: { noRelevant: r3(agg.noRelevant), stale: r3(agg.stale), over: r3(agg.over), under: r3(agg.under), empty: 0 },
  };
}

/**
 * The action for a CV the gate did not decide with Jev's answers. unreadable always passes (the snippet decision stands, the
 * recruiter makes the call); review (the very rare fallback lane) follows config fallback.policy, except that a reject Jev had
 * already reached is kept for an injection attempt (fallback.keepJevReject), so an attempt to steer the reviewer never gains a pass.
 * @param {'pass'|'reject'|'review'|'unreadable'} decision
 * @param {string[]} reasonCodes
 * @param {object} cfg
 * @param {{jevDecision?:'pass'|'reject'|null, injection?:boolean}} [extra]
 * @returns {{final:'approve'|'reject', lane:'jev'|'fallback'|'unreadable', policy:null|{applied:string, side:string, code:string}, finalReasonCodes:string[]}}
 */
function resolve(decision, reasonCodes, cfg, extra) {
  const x = extra || {};
  if (decision === 'pass') return { final: 'approve', lane: 'jev', policy: null, finalReasonCodes: reasonCodes.slice() };
  if (decision === 'reject') return { final: 'reject', lane: 'jev', policy: null, finalReasonCodes: reasonCodes.slice() };
  if (decision === 'unreadable') return { final: 'approve', lane: 'unreadable', policy: null, finalReasonCodes: reasonCodes.slice() };
  if (x.injection && x.jevDecision === 'reject' && cfg.fallback.keepJevReject) {
    return { final: 'reject', lane: 'fallback', policy: { applied: 'review', side: 'reject', code: 'policy_kept_reject' }, finalReasonCodes: ['policy_kept_reject'].concat(reasonCodes) };
  }
  const side = cfg.fallback.policy === 'reject' ? 'reject' : 'approve';
  const code = `policy_fallback_${side}`;
  return { final: side, lane: 'fallback', policy: { applied: 'review', side, code }, finalReasonCodes: [code].concat(reasonCodes) };
}

/** The numbers Jev gave, rounded, for the shadow log: enough to re-run the gate offline, no text. */
function compactAnswers(answers) {
  const round = p => {
    const out = {};
    for (const [k, v] of Object.entries(p || {})) out[k] = r3(v);
    return out;
  };
  return {
    relevance: answers.relevance.map(a => round(a.p)),
    seniority: answers.seniority.map(a => round(a.p)),
    overall: round(answers.overall.p),
    progression: round(answers.progression.p),
    careerChange: r3(answers.careerChange),
    injection: r3(answers.injection),
  };
}

module.exports = { evaluate, resolve, applyOperatingPoint, compactAnswers, parseWeight, thinWeight, atLeast, REASON_TEXT, CODE };
