'use strict';
// STUB redactor: removes contact details, web addresses, postcodes, identifiers, the candidate's known names and the
// referee section. redact.js prefers ./vendor/cv-redact.js when it exists. Pure functions, no I/O.

const PATTERNS = [
  ['email', /[A-Za-z0-9._%+'-]+\s?@\s?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[EMAIL]'],
  ['url', /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{1,63}\.(?:com|co\.uk|org|net|uk|io)\b\S*/gi, '[URL]'],
  ['handle', /(?<![\w@])@\w{3,}/g, '[HANDLE]'],
  ['postcode', /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi, '[POSTCODE]'],
  ['id', /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, '[ID]'],
  ['phone', /(?<![\w.])(?:\+|00)?\(?\d(?:[\s().-]?\d){8,}(?![\w])/g, '[PHONE]'],
];

const REFEREE_HEADING = /^\W*(?:professional\s+|character\s+)?(?:referees?|references?)\b.{0,40}$/i;

const BS = String.fromCharCode(92);
function escapeRe(s) {
  let out = '';
  for (const ch of String(s)) out += ('.*+?^${}()|[]'.includes(ch) || ch === BS) ? BS + ch : ch;
  return out;
}

function nameTokens(names) {
  const out = new Set();
  for (const n of names || []) for (const t of String(n || '').split(/[\s,.-]+/)) if (t.length >= 3) out.add(t);
  return Array.from(out);
}

function tokenRe(t, flags) {
  return new RegExp(String.raw`(?<![\p{L}])` + escapeRe(t) + String.raw`(?![\p{L}])`, flags);
}

// The patterns are quadratic on a long unbroken run of letters, so no text longer than MAX_RUN is ever matched in one piece.
const MAX_RUN = 3000;

function mask(text, counts) {
  let s = String(text).length > MAX_RUN ? String(text).slice(0, MAX_RUN) : String(text);
  for (const [name, re, ph] of PATTERNS) s = s.replace(re, () => { counts[name] = (counts[name] || 0) + 1; return ph; });
  return s;
}

/** @returns {{text:string, counts:object}} */
function redactCv(text, known) {
  const k = known || {};
  const counts = {};
  let lines = String(text || '').split('\n');
  const cut = lines.findIndex(l => l.length < 60 && REFEREE_HEADING.test(l.trim()));
  if (cut >= 0) { counts.refereeLines = lines.length - cut; lines = lines.slice(0, cut); }
  let s = lines.join('\n');
  for (const e of k.emails || []) if (e) s = s.split(String(e)).join('[EMAIL]');
  for (const t of nameTokens(k.names)) s = s.replace(tokenRe(t, 'giu'), () => { counts.name = (counts.name || 0) + 1; return '[NAME]'; });
  return { text: mask(s, counts), counts };
}

/** @returns {{ok:boolean, leaks:number}} true when no known name, e-mail, phone tail or pattern is left */
function verifyRedaction(text, known) {
  const k = known || {};
  const s = String(text || '');
  let leaks = 0;
  for (const t of nameTokens(k.names)) if (tokenRe(t, 'iu').test(s)) leaks++;
  for (const e of k.emails || []) if (e && s.toLowerCase().includes(String(e).toLowerCase())) leaks++;
  const digits = s.replace(/\D/g, '');
  for (const p of k.phones || []) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length >= 7 && digits.includes(d.slice(-9))) leaks++;
  }
  const squashed = s.replace(/\s+/g, '').toLowerCase();
  for (const pc of k.postcodes || []) {
    const c = String(pc || '').replace(/\s+/g, '').toLowerCase();
    if (c.length >= 5 && squashed.includes(c)) leaks++;
  }
  for (const line of s.split('\n')) {
    const piece = line.length > MAX_RUN ? line.slice(0, MAX_RUN) : line;
    for (const [, re] of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(piece)) leaks++;
      re.lastIndex = 0;
    }
  }
  return { ok: leaks === 0, leaks };
}

module.exports = { redactCv, verifyRedaction, mask, PATTERNS };
