'use strict';
// Structured facts about a parsed CV, worked out by CODE (Jev is not asked to count months or compare dates):
// which roles are sent (most recent first, at most input.maxRoles that ended within input.maxYears), the months worked,
// the months in the last few years, and the cleaned text of each role. Pure functions, no I/O.
// A role whose dates cannot be trusted (missing, reversed, before input.minYear) is kept but has no months; a role that
// starts in the future is dropped; an end date in the future is cut back to now.

const YM = /^(\d{4})-(\d{1,2})$/;

// Characters that never belong in a job title: controls, zero-width and bidi marks, line and paragraph separators.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

// A lone surrogate (broken PDF font map, or a cut through an emoji) makes the gateway answer 400 "invalid Unicode text": the stage would call that an outage of the whole queue.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function cleanText(input, max) {
  let s = String(input === undefined || input === null ? '' : input);
  try { s = s.normalize('NFKC'); } catch (e) { /* keep as is */ }
  s = s.replace(LONE_SURROGATE, ' ').replace(INVISIBLE, ' ').replace(/[|`]/g, m => (m === '|' ? '/' : "'")).replace(/\s+/g, ' ').trim();
  if (max > 0 && s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    s = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(LONE_SURROGATE, '').trim();
  }
  return s;
}

function ymIndex(v) {
  const m = YM.exec(String(v === undefined || v === null ? '' : v).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 && y >= 1000 && y <= 9999 ? y * 12 + (mo - 1) : null;
}

function ymText(idx) {
  const y = Math.floor(idx / 12);
  return `${y}-${String(idx - y * 12 + 1).padStart(2, '0')}`;
}

function nowIndex(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

// Union length of inclusive month intervals [a, b], optionally clipped to [lo, hi]. Overlaps and duplicates count once.
function unionMonths(intervals, lo, hi) {
  const iv = [];
  for (const [a0, b0] of intervals) {
    const a = lo === undefined ? a0 : Math.max(a0, lo);
    const b = hi === undefined ? b0 : Math.min(b0, hi);
    if (b >= a) iv.push([a, b]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = null;
  let curB = null;
  for (const [a, b] of iv) {
    if (curA === null) { curA = a; curB = b; continue; }
    if (a <= curB + 1) { if (b > curB) curB = b; continue; }
    total += curB - curA + 1;
    curA = a;
    curB = b;
  }
  if (curA !== null) total += curB - curA + 1;
  return total;
}

const CONFIDENCE_WORDS = { high: 0.9, medium: 0.5, low: 0.1 };

// The reader's confidence as a number from 0 to 1: a number, a word (high, medium, low) or nothing (null = unknown).
function normalizeParseConfidence(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  if (typeof v === 'string') {
    const w = v.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CONFIDENCE_WORDS, w)) return CONFIDENCE_WORDS[w];
    const n = Number(w);
    if (w !== '' && Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  return null;
}

function dutiesText(d) {
  if (Array.isArray(d)) return d.filter(x => typeof x === 'string').join(', ');
  return typeof d === 'string' ? d : '';
}

/**
 * @param {{roles?:Array, qualifications?:Array, parseConfidence?:number}} record  a parsed, redacted CV
 * @param {object} cfg  effective configuration (input, facts)
 * @param {Date|number|string} [now]
 * @returns {{roles:Array, qualifications:string[], nowIdx:number, totalMonths:number, monthsRecent:number, recentYears:number,
 *           rolesParsed:number, rolesSent:number, undatedRoles:number, omitted:{old:number, capped:number, future:number, duplicates:number}, oldOnly:boolean,
 *           parseConfidence:number|null}}
 */
function buildFacts(record, cfg, now) {
  const inp = cfg.input;
  const nowIdx = nowIndex(now);
  const minIdx = inp.minYear * 12;
  const omitted = { old: 0, capped: 0, future: 0, duplicates: 0 };
  const rawRoles = Array.isArray(record && record.roles) ? record.roles : [];
  const seen = new Set();
  const parsed = [];

  for (const r of rawRoles) {
    if (!r || typeof r !== 'object') continue;
    const title = cleanText(r.title, inp.maxTitleChars);
    const employer = cleanText(r.employer, inp.maxEmployerChars);
    const duties = cleanText(dutiesText(r.duties), inp.maxDutiesChars);
    if (!title && !employer && !duties) continue;
    let start = ymIndex(r.start);
    let end = String(r.end === undefined || r.end === null ? '' : r.end).trim().toLowerCase() === 'present' ? nowIdx : ymIndex(r.end);
    let dated = start !== null && end !== null && start >= minIdx && end >= start;
    if (dated && start > nowIdx) { omitted.future++; continue; }
    if (dated && end > nowIdx) end = nowIdx;
    if (!dated) { start = null; end = null; }
    const key = [title, employer, start, end].join('\u0001').toLowerCase();
    if (seen.has(key)) { omitted.duplicates++; continue; }
    seen.add(key);
    dated = start !== null;
    parsed.push({
      title, employer, duties, startIdx: start, endIdx: end, dated,
      present: dated && r.end !== undefined && String(r.end).trim().toLowerCase() === 'present',
      months: dated ? end - start + 1 : null,
      endedAgo: dated ? nowIdx - end : null,
    });
  }

  const totalMonths = unionMonths(parsed.filter(r => r.dated).map(r => [r.startIdx, r.endIdx]));
  const recentYears = cfg.facts.recentYears;
  const monthsRecent = unionMonths(parsed.filter(r => r.dated).map(r => [r.startIdx, r.endIdx]), nowIdx - recentYears * 12 + 1, nowIdx);

  const horizon = nowIdx - inp.maxYears * 12;
  let within = [];
  for (const r of parsed) {
    if (r.dated && r.endIdx < horizon) omitted.old++;
    else within.push(r);
  }
  // A history that ended entirely before the horizon is still judged (it is how a stale CV is recognised): its newest roles are sent.
  let oldOnly = false;
  if (!within.length && parsed.length) { within = parsed.slice(); omitted.old = 0; oldOnly = true; }
  const dated = within.filter(r => r.dated).sort((a, b) => (b.endIdx - a.endIdx) || (b.startIdx - a.startIdx));
  const undated = within.filter(r => !r.dated);
  let ordered = dated.concat(undated);
  if (ordered.length > inp.maxRoles) { omitted.capped = ordered.length - inp.maxRoles; ordered = ordered.slice(0, inp.maxRoles); }

  const quals = [];
  for (const q of Array.isArray(record && record.qualifications) ? record.qualifications : []) {
    const t = cleanText(q, inp.maxQualificationChars);
    if (t && !quals.some(x => x.toLowerCase() === t.toLowerCase())) quals.push(t);
    if (quals.length >= inp.maxQualifications) break;
  }

  const pc = normalizeParseConfidence(record && record.parseConfidence);
  return {
    roles: ordered,
    qualifications: quals,
    nowIdx,
    totalMonths,
    monthsRecent,
    recentYears,
    rolesParsed: parsed.length,
    rolesSent: ordered.length,
    undatedRoles: ordered.filter(r => !r.dated).length,
    omitted,
    oldOnly,
    parseConfidence: pc,
  };
}

/** 'title | employer | start - end | duties' for one role. */
function roleLine(r) {
  const dates = r.dated ? `${ymText(r.startIdx)} - ${r.present ? 'present' : ymText(r.endIdx)}` : 'dates not stated';
  return [r.title || 'title not stated', r.employer || 'employer not stated', dates, r.duties || 'duties not stated'].join(' | ');
}

module.exports = { buildFacts, roleLine, cleanText, ymIndex, ymText, nowIndex, unionMonths, normalizeParseConfidence };
