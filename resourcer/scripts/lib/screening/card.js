'use strict';

const { INJECTION_RE, foldForInjection } = require('./rules');

const DAY = { day: 1, days: 1, month: 30, months: 30, year: 365, years: 365 };
const MONTH_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/g;
const MASK_RE = /<(?:PC|EMAIL|URL|HANDLE|PHONE|ID|DOB|AGE)>/g;
const REED_DROP = /^(?:location|salary|type|work permit|notice|open to)\s*:/i;
const MONTH_NUM = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const RANGE_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\s*-\s*(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})|(Current|Present))/gi;
const APPLICATIONS = /(\d+)\s+applications?\s+in\s+last\s+(\d+)\s+days/i;
const AGE = {
  updated: /Updated\s+(today|(\d+)\s+(days?|months?|years?)\s+ago)/i,
  active: /Active\s+(today|(\d+)\s+(days?|months?|years?)\s+ago)/i,
};
const CV_TAG = '--- CV Work Experience ---';
const FURNITURE = [
  /Unlock candidate/gi, /\d+\s+applications?\s+in\s+last\s+\d+\s+days/gi, /No applications/gi, /Applications withheld/gi, /(?:Active|Updated)\s+(?:today|\d+\s+(?:days?|months?|years?)\s+ago)/gi,
  /Never unlocked/gi, /Recent experience/gi, /Other CV snippets/gi, /Not available/gi, /Location not available/gi,
];

// the window of the card's own "N applications in last M days", when N is at least 1; null when no application is shown
function appliedDays(text) {
  const m = APPLICATIONS.exec(text);
  return m && Number(m[1]) >= 1 ? Number(m[2]) : null;
}

function ageDays(text, label) {
  const m = AGE[label].exec(text);
  if (!m) return null;
  if (m[1].toLowerCase() === 'today') return 0;
  return Number(m[2]) * DAY[m[3].toLowerCase()];
}

// 0 when a job is current, null when no dated job is listed
function roleGapDays(work, asOf) {
  let newest = null;
  let current = false;
  for (const m of work.matchAll(RANGE_RE)) {
    if (m[5]) { current = true; continue; }
    const end = Date.UTC(Number(m[4]), MONTH_NUM[m[3].toLowerCase()], 1);
    if (newest === null || end > newest) newest = end;
  }
  if (current) return 0;
  if (newest === null) return null;
  return Math.max(0, Math.round((asOf - newest) / 86400000));
}

function clean(s) {
  return String(s || '').replace(MASK_RE, ' ').replace(/\s+/g, ' ').trim();
}

function detectSource(s) {
  return /(?:^|\s)(?:Current role:|Desired role:|Work permit:)|--- CV Work Experience ---/.test(s) ? 'reed' : 'caterer';
}

function parseCaterer(s) {
  const body = s.replace(/^\s*\d+\.\s+/, '');
  const marker = /Other CV snippets/i.exec(body);
  const unlock = body.search(/Unlock candidate/i);
  const pipe = body.indexOf(' | ');
  let headline = '';
  if (pipe > 0 && (unlock < 0 || pipe < unlock)) headline = clean(body.slice(0, pipe));
  if (headline.length > 120) headline = '';
  let history = '';
  if (marker) {
    history = body.slice(marker.index + marker[0].length).trim();
    if (/^Not\s+available/i.test(history)) history = '';
  } else if (unlock < 0) {
    history = body;
  }
  return { currentTitle: headline, recentWork: clean(history), desiredRole: '' };
}

// location, salary, contract type, work permit and notice never reach Jev: none of them may decide anything
function parseReed(raw) {
  const cvAt = raw.indexOf(CV_TAG);
  const head = cvAt >= 0 ? raw.slice(0, cvAt) : raw;
  const out = { currentTitle: '', recentWork: clean(cvAt >= 0 ? raw.slice(cvAt + CV_TAG.length) : ''), desiredRole: '' };
  for (const part of head.replace(/\s+/g, ' ').split(' | ')) {
    const p = part.trim();
    if (REED_DROP.test(p)) continue;
    const cur = /^current role\s*:\s*(.*)$/i.exec(p);
    const des = /^desired role\s*:\s*(.*)$/i.exec(p);
    if (cur) out.currentTitle = clean(cur[1]);
    else if (des) out.desiredRole = clean(des[1]);
  }
  return out;
}

// text that is neither page furniture nor a dropped Reed field: a card with a lot of it and no title and no history was not understood
function contentChars(raw, source) {
  let s = String(raw || '').replace(/\s+/g, ' ');
  if (source === 'reed') {
    const at = s.indexOf(CV_TAG);
    const head = at >= 0 ? s.slice(0, at) : s;
    s = `${head.split(' | ').filter(p => !REED_DROP.test(p.trim())).join(' ')} ${at >= 0 ? s.slice(at + CV_TAG.length) : ''}`;
  }
  for (const re of FURNITURE) s = s.replace(re, ' ');
  return s.replace(MASK_RE, ' ').replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim().length;
}

// the same keyword filter the engine runs on the card: a flag on its own never decides anything
function keywordInjection(raw) {
  const s = String(raw || '');
  return INJECTION_RE.test(s) || INJECTION_RE.test(foldForInjection(s));
}

function parseCard(snippet, asOf) {
  const raw = String(snippet || '');
  const s = raw.replace(/\s+/g, ' ').trim();
  const source = detectSource(s);
  const parts = source === 'reed' ? parseReed(raw) : parseCaterer(s);
  const dated = parts.recentWork.match(MONTH_RE);
  return {
    source,
    ...parts,
    updatedDays: source === 'caterer' ? ageDays(s, 'updated') : null,
    activeDays: source === 'caterer' ? ageDays(s, 'active') : null,
    appliedDays: source === 'caterer' ? appliedDays(s) : null,
    datedRoles: dated ? dated.length : 0,
    roleGapDays: roleGapDays(parts.recentWork, asOf === undefined ? Date.now() : asOf),
    historyChars: parts.recentWork.length,
    contentChars: contentChars(raw, source),
    injectionKw: keywordInjection(raw),
  };
}

// stored next to Jev's answers so the decision can be re-run offline
function cardFacts(card) {
  const x = { x_history_chars: card.historyChars, x_dated_roles: card.datedRoles, x_has_title: card.currentTitle ? 1 : 0, x_injection_kw: card.injectionKw ? 1 : 0, x_content_chars: card.contentChars };
  if (card.updatedDays !== null) x.x_updated_days = card.updatedDays;
  if (card.activeDays !== null) x.x_active_days = card.activeDays;
  if (card.appliedDays !== null) x.x_apps_days = card.appliedDays;
  if (card.roleGapDays !== null) x.x_role_gap_days = card.roleGapDays;
  return x;
}

module.exports = { parseCard, cardFacts, ageDays, appliedDays, roleGapDays, detectSource, keywordInjection, contentChars };
