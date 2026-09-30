'use strict';

const criteriaLib = require('./criteria');

// characters of real text on a card that has no title and no history before it counts as unreadable, not empty (thresholds.unreadableMinChars overrides it)
const UNREADABLE_MIN_CHARS = 300;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function need(x, name) {
  if (!isNum(x)) throw new Error(`unusable answer: ${name}`);
  return x;
}

function probs(a, name) {
  if (!a || !a.p || typeof a.p !== 'object') throw new Error(`unusable answer: ${name}`);
  return a.p;
}

// two readings that must both say it: the geometric mean is high only when both are, and a strong one can carry a moderate one
function agree(main, support) {
  return Math.sqrt(main * support);
}

function topOf(p) {
  let best = null;
  for (const [k, v] of Object.entries(p)) if (best === null || v > p[best]) best = k;
  return best;
}

// the only way out of decide() that is not approve or reject: the rare cases a second model settles
function fallback(reason, scores, flags) {
  return { lane: 'review', reasonCode: null, reviewReason: reason, confidence: null, scores: scores || null, flags: flags || [] };
}

function criteriaFor(input) {
  if (input.criteria) return input.criteria;
  const c = criteriaLib.get();
  return c.ok && !c.decisionErrors.length ? c.criteria : null;
}

// mass of the answers a rules row maps to approve and to reject; a doubt cell counts for neither and is left to the policy readings
function levelMasses(row, p) {
  const out = { approve: 0, reject: 0, worst: null, approveTop: null };
  for (const [opt, action] of Object.entries(row)) {
    const m = p[opt] || 0;
    if (action === 'approve') {
      out.approve += m;
      if (!out.approveTop || m > (p[out.approveTop] || 0)) out.approveTop = opt;
    } else if (action === 'reject') {
      out.reject += m;
      if (!out.worst || m > (p[out.worst] || 0)) out.worst = opt;
    }
  }
  return out;
}

// mass of the job kinds that fit the searched role (ok) and of those that do not (a reject code, by code)
function fieldMasses(row, p) {
  const out = { ok: 0, reject: 0, byCode: {}, worst: null };
  for (const [kind, verdict] of Object.entries(row)) {
    const m = p[kind] || 0;
    if (verdict === 'ok') out.ok += m;
    else if (verdict !== 'doubt') {
      out.reject += m;
      out.byCode[verdict] = (out.byCode[verdict] || 0) + m;
    }
  }
  for (const [code, m] of Object.entries(out.byCode)) if (m > 0 && (!out.worst || m > out.byCode[out.worst])) out.worst = code;
  return out;
}

// one reading per kind question (title and history together, first listed job): a reading with no information is skipped and the rest must agree
function fieldOf(D, row, a) {
  const readings = D.kindQuestions.map(q => {
    const p = probs(a[q], q);
    return { p, blank: (p.cannot_tell || 0) >= 0.5 };
  });
  const used = readings.filter(r => !r.blank);
  const each = (used.length ? used : readings).map(r => ({ m: fieldMasses(row, r.p), top: topOf(r.p) }));
  const lead = each.reduce((b, e) => (e.m.reject > b.m.reject ? e : b), each[0]);
  return { ok: Math.min(...each.map(e => e.m.ok)), reject: Math.min(...each.map(e => e.m.reject)), worst: lead.m.worst, tops: each.map(e => e.top) };
}

// a sign of life inside the window: the "Active" age of the card, or an application it shows (applicationsAreActivity, on unless the file says false)
function recentlyActive(s, a) {
  const seen = [a.x_active_days];
  if (s.applicationsAreActivity !== false) seen.push(a.x_apps_days);
  return seen.some(d => isNum(d) && d < s.activeDays);
}

// hard: out of date and no sign of life; soft: out of date but recently active, so the card may be old rather than the person
function staleness(D, stage, a) {
  const s = D.stale;
  if (!s || s.mode === 'off' || !(s.stages || [1]).includes(stage)) return null;
  const up = a.x_updated_days;
  const gap = a.x_role_gap_days;
  if (!((isNum(up) && up >= s.updatedDays) || (isNum(gap) && gap >= s.roleGapDays))) return null;
  return recentlyActive(s, a) ? 'soft' : 'hard';
}

// the whole-policy readings: each is a yes/no question, "fit" (yes = suitable) or "mismatch" (yes = clear mismatch); returns P(mismatch)
function policyMismatch(P, a) {
  let sum = 0;
  let w = 0;
  for (const r of P.readings) {
    const v = need(a[r.question], r.question);
    sum += (r.weight === undefined ? 1 : r.weight) * (r.sense === 'mismatch' ? v : 1 - v);
    w += r.weight === undefined ? 1 : r.weight;
  }
  return w > 0 ? sum / w : 0;
}

function operatingPoint(D, stage) {
  const op = D.operatingPoint || {};
  const s = (stage === 2 ? op.stage2 : op.stage1) || {};
  const f = op.forced || {};
  return { rejectAt: isNum(s.rejectAt) ? s.rejectAt : 0.75, forcedFrom: isNum(f.from) ? f.from : 0.3, forcedTo: isNum(f.to) ? f.to : 0.7 };
}

function decide(input, cfg) {
  const stage = input.stage === 2 ? 2 : 1;
  const st = stage === 2 ? cfg.decide.stage2 : cfg.decide.stage1;
  try {
    const cr = criteriaFor(input);
    if (!cr) return fallback('ANSWER_UNUSABLE');
    const D = cr.decision;
    const S = D.thresholds;
    const OP = operatingPoint(D, stage);
    const a = input.answers;
    if (!a || typeof a !== 'object') throw new Error('unusable answers');

    const inject = need(a.injection, 'injection');
    const info = need(a.info_sufficient, 'info_sufficient');
    const area = need(a.same_area_seen, 'same_area_seen');
    const hosp = need(a[D.hospitalityQuestion || 'hospitality_experience'], 'hospitality question');
    const rel = probs(a.relevance, 'relevance');
    const role = probs(a.role_level, 'role_level');
    const roleTop = topOf(role);
    const relNot = need(rel['0'], 'relevance0') + need(rel['1'], 'relevance1');
    const rel3 = need(rel['3'], 'relevance3');
    const mPolicy = policyMismatch(D.policy, a);
    const hasHistory = !isNum(a.x_history_chars) || a.x_history_chars > 0;
    const hasTitle = !isNum(a.x_has_title) || a.x_has_title > 0;
    const scores = { roleLevel: roleTop, rolePMax: role[roleTop], area, relNot, rel3, hosp, info, inject, mPolicy, rejectAt: OP.rejectAt };

    // a keyword filter that fires alone is not enough: Jev keeps deciding unless it also finds an instruction (a missing fact counts as fired)
    const keyword = !isNum(a.x_injection_kw) || a.x_injection_kw > 0;
    if (inject >= st.injectionP && keyword) return fallback('INJECTION_FLAG', scores, ['injection']);

    const done = (lane, code, r, extra) => {
      const flags = [...(extra || [])];
      if (r >= OP.forcedFrom && r < OP.forcedTo) flags.push('forced');
      scores.R = r;
      return { lane, reasonCode: code, reviewReason: null, confidence: lane === 'reject' ? r : 1 - r, scores, flags };
    };

    const realTitle = stage === 2 && a.title_seniority !== undefined;
    const unreadable = isNum(S.unreadableMinChars) ? S.unreadableMinChars : UNREADABLE_MIN_CHARS;
    // plenty of text but neither a title nor a history: the card parser did not understand the format, a fault for the run guards and never an empty profile
    if (!realTitle && !hasHistory && !hasTitle && isNum(a.x_content_chars) && a.x_content_chars >= unreadable) return fallback('ANSWER_UNUSABLE', scores, ['card_unreadable']);
    if (!realTitle && !hasHistory && (!hasTitle || info < st.infoFloor)) return done('reject', 'reject_no_history', 1, ['empty_profile']);

    const stale = staleness(D, stage, a);
    if (stale === 'hard' && D.stale.mode === 'reject') return done('reject', 'reject_stale_profile', 1, ['stale_profile']);
    const aged = stale === 'soft' ? ['stale_but_active'] : [];

    let lvlAns = a[D.levelQuestion];
    let contradicted = false;
    if (stage === 2 && a.title_seniority && a.title_consistent !== undefined) {
      const tc = need(a.title_consistent, 'title_consistent');
      const ts = probs(a.title_seniority, 'title_seniority');
      if ((ts.cannot_tell || 0) <= st.notStatedP) { lvlAns = a.title_seniority; contradicted = tc < st.titleConsistentMin; }
    }
    const lvl = probs(lvlAns, D.levelQuestion);
    const roleClear = role[roleTop] >= S.roleLevelMinP;
    const level = roleClear ? levelMasses(D.rules[roleTop], lvl) : { approve: 0, reject: 0, worst: null, approveTop: null };
    const field = roleClear ? fieldOf(D, D.fieldRules[roleTop], a) : { ok: 0, reject: 0, worst: null, tops: [] };
    Object.assign(scores, { lvlTop: topOf(lvl), kindTops: field.tops, approveMass: level.approve, rejectMass: level.reject, fieldOk: field.ok, fieldReject: field.reject });

    const levelCode = D.reasons[level.worst] || 'reject_other';
    const c = D.corroborate && D.corroborate[levelCode];
    const levelCorr = c ? need(a[c.question], c.question) : 1;
    const counter = levelCode === 'reject_too_junior' ? 1 - rel3 : 1;
    const levelPart = agree(level.reject, Math.min(levelCorr, counter));
    const hospGate = field.worst === 'reject_unrelated_industry' ? 1 - hosp : 1;
    const fieldPart = contradicted ? 0 : agree(field.reject, Math.min(relNot, 1 - area, hospGate));
    const fieldCode = field.worst || 'reject_other';
    const mStruct = Math.max(fieldPart, levelPart);
    Object.assign(scores, { mStruct, fieldPart, levelPart });

    let r = Math.max(mStruct, contradicted ? 0 : mPolicy);
    if (stale === 'hard' && D.stale.mode === 'doubt') r = 1 - (1 - r) * (1 - D.stale.doubtWeight);
    if (stale === 'soft' && D.stale.recentlyActive === 'doubt') r = 1 - (1 - r) * (1 - D.stale.doubtWeight);

    if (r >= OP.rejectAt) {
      const unresolved = Math.max(field.reject, level.reject);
      const open = field.reject >= level.reject ? fieldCode : levelCode;
      const code = mStruct >= mPolicy && mStruct > 0 ? (fieldPart >= levelPart ? fieldCode : levelCode) : (unresolved >= S.reasonMin ? open : 'reject_other');
      return done('reject', code, r, [...aged, ...(roleClear ? [] : ['role_unclear'])]);
    }
    const clearFit = field.ok >= S.fieldOkMin && level.approve >= S.levelApproveMin;
    const code = clearFit ? (D.approveReasons && D.approveReasons[level.approveTop]) || 'approve_level_match' : 'approve_other';
    const notes = [...aged];
    if (contradicted) notes.push('title_contradiction');
    if (!roleClear) notes.push('role_unclear');
    return done('approve', code, r, notes);
  } catch (e) {
    return fallback('ANSWER_UNUSABLE');
  }
}

// numbers only, rounded: the compact form stored in the shadow log so the decision can be re-run offline
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

module.exports = { decide, compactAnswers, operatingPoint };
