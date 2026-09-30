'use strict';
// Best-effort redaction of personal data BEFORE anything leaves the process (LLM, Jev) and before
// the shadow log. Removes: the card first name, the surname (heuristic: the capitalised token right
// after it, unless it is a role word), full UK postcodes, e-mail addresses, phone numbers, URLs.
// Keeps everything the decision needs: titles, employers, dates, duties, city.
//
// Known limits (documented in docs/SCREENING.md): a surname that is also a role word ('Alex Cook
// Sous Chef') stays; a name that appears again in the body is only replaced when it is a first name
// of 4+ letters that is not a month or role word.

const crypto = require('crypto');

const ROLE_WORD = new RegExp('^(' + [
  'chef', 'cook', 'head', 'sous', 'commis', 'kitchen', 'porter', 'assistant', 'manager', 'supervisor', 'waiter',
  'waitress', 'server', 'bartender', 'barista', 'catering', 'general', 'senior', 'junior', 'executive', 'second',
  'line', 'pastry', 'breakfast', 'pot', 'kp', 'cdp', 'food', 'restaurant', 'hotel', 'front', 'house', 'banqueting',
  'demi', 'de', 'partie', 'production', 'operations', 'team', 'lead', 'owner', 'director', 'patron', 'dish',
  'washer', 'cleaner', 'driver', 'sales', 'retail', 'store', 'warehouse', 'student', 'unemployed', 'self',
  'freelance', 'relief', 'temp', 'bar', 'foh', 'hospitality', 'event', 'events', 'mobile', 'part', 'full', 'time',
  'trainee', 'apprentice', 'independent', 'private', 'sushi', 'grill', 'larder', 'sauce', 'baker', 'butcher',
  'multi', 'skilled', 'professional', 'experienced', 'qualified', 'working', 'looking', 'available', 'seeking',
  'open', 'to', 'the', 'and', 'of', 'for', 'at', 'in', 'a', 'an', 'unlock', 'recent', 'experience', 'admin',
  'office', 'care', 'carer', 'nurse', 'teacher', 'security', 'housekeeper', 'housekeeping', 'receptionist',
  'reception', 'host', 'hostess', 'concierge', 'butler', 'steward', 'stewardess', 'mixologist', 'sommelier',
  'cashier', 'labourer', 'operative', 'technician', 'engineer', 'consultant', 'coordinator', 'co-ordinator',
  'administrator', 'executive', 'officer', 'specialist', 'analyst', 'developer', 'designer', 'accountant',
  'pizza', 'banquet', 'bakery', 'pub', 'pantry', 'prep', 'carvery', 'delivery', 'customer', 'service', 'cleaning',
  'personal', 'trainer', 'shop', 'floor', 'wine', 'cocktail', 'coffee', 'cafe', 'deli', 'casual', 'gastro', 'regional', 'area',
].join('|') + ')$', 'i');

const PARTICLE = /^(de|van|von|der|den|di|da|del|della|le|la|el|al|bin|ibn|mac|mc|o'|dos|das|do|du|des|ter|ten|y|zu|af|ap|ben|bint)$/i;
const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i;
// Unicode-aware so accented names (Jose with an acute, Muller with an umlaut) are handled too.
const NAME_TOKEN = /^\p{Lu}[\p{L}'-]+$/u;

const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*[,.]?\s*\d[A-Z]{2}\b|\bGIR\s*0AA\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?:\+44|\b0044|\b0)(?:[\s().-]*\d){9,10}\b|\+\d{2,3}(?:[\s().-]*\d){7,11}\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin|instagram|facebook|twitter|tiktok|indeed)\.com\S*/gi;
const HANDLE_RE = /(^|[\s(])@[A-Za-z0-9_.]{3,30}\b/g;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const DOB_RE = /\b(?:date of birth|d\.?o\.?b\.?|born)(?:\s+on|\s+in)?[:\s]+(?:\d{1,2}[\s/.-]+)?(?:\d{1,2}|[A-Za-z]{3,9})?[\s/.-]*\d{2,4}\b/gi;
const AGE_RE = /\b(?:aged?|age:)\s*\d{2}\b/gi;

function stripEdge(tok) {
  return String(tok || '').replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

const BS = String.fromCharCode(92);
function escapeRe(s) {
  let out = '';
  for (const ch of String(s)) out += ('.*+?^${}()|[]'.includes(ch) || ch === BS) ? BS + ch : ch;
  return out;
}

function maskPatterns(s, notes) {
  s = s.replace(EMAIL_RE, () => { notes.emails++; return '<EMAIL>'; });
  s = s.replace(URL_RE, () => { notes.urls++; return '<URL>'; });
  s = s.replace(HANDLE_RE, (m, lead) => { notes.urls++; return lead + '<HANDLE>'; });
  s = s.replace(POSTCODE_RE, () => { notes.postcodes++; return '<PC>'; });
  s = s.replace(NI_RE, () => { notes.phones++; return '<ID>'; });
  s = s.replace(DOB_RE, () => { notes.phones++; return '<DOB>'; });
  s = s.replace(AGE_RE, () => { notes.phones++; return '<AGE>'; });
  s = s.replace(PHONE_RE, () => { notes.phones++; return '<PHONE>'; });
  return s;
}

/**
 * @param {string} input   snippet text
 * @param {{firstName?:string, enabled?:boolean, maxChars?:number}} [opts]
 * @returns {{text:string, notes:{name:boolean, surname:boolean, postcodes:number, emails:number, phones:number, urls:number}}}
 */
function redactSnippet(input, opts) {
  const o = opts || {};
  const notes = { name: false, surname: false, postcodes: 0, emails: 0, phones: 0, urls: 0 };
  // Bounded before any pattern runs: the e-mail pattern is quadratic on a long run of local-part characters.
  let s = String(input == null ? '' : input).slice(0, inputLimit(o.maxChars)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.enabled === false) return { text: cap(s, o.maxChars), notes };

  const hadRank = /^\d{1,3}\.\s+/.test(s);
  s = s.replace(/^\d{1,3}\.\s+/, '');

  const firstName = stripEdge(o.firstName);
  const fnTokens = firstName ? firstName.split(/\s+/).map(stripEdge).filter(Boolean) : [];
  let removedFirst = null;
  let removedSurname = null;

  if (fnTokens.length || hadRank) {
    let toks = s.split(' ');
    let i = 0;
    if (fnTokens.length) {
      let k = 0;
      while (k < fnTokens.length && i < toks.length && stripEdge(toks[i]).toLowerCase() === fnTokens[k].toLowerCase()) { i++; k++; }
      if (k === fnTokens.length) removedFirst = fnTokens.join(' ');
      else i = 0;
    }
    if (removedFirst === null && hadRank) {
      const t0 = stripEdge(toks[0]);
      if (NAME_TOKEN.test(t0) && !ROLE_WORD.test(t0)) { removedFirst = t0; i = 1; }
    }
    if (removedFirst !== null) {
      // surname: next capitalised token (optionally after a particle) that is not a role word
      let j = i;
      const parts = [];
      while (j < toks.length && parts.length < 3 && PARTICLE.test(stripEdge(toks[j]))) { parts.push(stripEdge(toks[j])); j++; }
      const t1 = stripEdge(toks[j]);
      if (t1 && NAME_TOKEN.test(t1) && !ROLE_WORD.test(t1)) {
        removedSurname = parts.concat(t1).join(' ');
        j += 1;
      } else {
        j = i;
      }
      notes.name = true;
      notes.surname = removedSurname !== null;
      toks = toks.slice(j);
      s = toks.join(' ');
    }
  }

  if (removedFirst) {
    for (const t of removedFirst.split(/\s+/)) {
      if (t.length >= 4 && !MONTH.test(t) && !ROLE_WORD.test(t)) {
        const edge = BS + 'p{L}' + BS + 'p{N}';
        s = s.replace(new RegExp('(^|[^' + edge + '])' + escapeRe(t) + '(?![' + edge + '])', 'giu'), '$1<NAME>');
      }
    }
  }

  s = maskPatterns(s, notes).replace(/\s+/g, ' ').trim();
  return { text: cap(s, o.maxChars), notes };
}

// Titles get the pattern masks only (a job title has no name), so a postcode-shaped title is masked.
function redactTitle(input, opts) {
  const o = opts || {};
  const notes = { name: false, surname: false, postcodes: 0, emails: 0, phones: 0, urls: 0 };
  let s = String(input == null ? '' : input).slice(0, 2000).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.enabled !== false) s = maskPatterns(s, notes).replace(/\s+/g, ' ').trim();
  return { text: cap(s, o.maxChars || 200), notes };
}

function inputLimit(maxChars) {
  const n = Number(maxChars) > 0 ? Number(maxChars) : 4000;
  return Math.max(2000, n * 3);
}

function cap(s, maxChars) {
  const n = Number(maxChars) > 0 ? Number(maxChars) : 4000;
  return s.length > n ? s.slice(0, n) : s;
}

function sha16(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

module.exports = { redactSnippet, redactTitle, sha16, ROLE_WORD };
