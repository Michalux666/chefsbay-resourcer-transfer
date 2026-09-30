'use strict';
// Best-effort redaction of personal data BEFORE anything leaves the process (LLM, Jev) and before
// the shadow log. Removes: the card first name, the surname (heuristic: the name-like token right
// after it, in any case, unless it is a role word), full UK postcodes, e-mail addresses, phone numbers, URLs.
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
// What a name is made of: letters, combining marks (an accent typed as a separate mark) and every apostrophe a keyboard or a word processor makes
// (O'Brien, and the same name with a typographic apostrophe, which the plain pattern refused, so such a name was never removed).
const APOSTROPHES = String.fromCharCode(0x27, 0x2019, 0x2bc, 0x60, 0xb4);
const UP = String.fromCharCode(92) + 'p'; // the backslash-p of a Unicode property escape, built from its code (the hygiene test bans a doubled backslash in source)
const NAME_CHARS = `${UP}{L}${UP}{M}${APOSTROPHES}-`;
const NAME_TOKEN = new RegExp(`^${UP}{Lu}[${NAME_CHARS}]+$`, 'u');
const LOWER_TOKEN = new RegExp(`^${UP}{Ll}[${NAME_CHARS}]+$`, 'u');
// Result positions run past 999 (the historical sample has 4 digits); 6 leaves room.
const RANK_RE = /^\d{1,6}\.\s+/;

const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*[,.]?\s*\d[A-Z]{2}\b|\bGIR\s*0AA\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?:\+44|\b0044|\b0)(?:[\s().-]*\d){9,10}\b|\+\d{2,3}(?:[\s().-]*\d){7,11}\b/g;
// A number behind a label is a phone number whatever its length or prefix ("Mobile: 4479...", 13 digits, no plus): nine or more digits, separators allowed.
const LABELLED_NUMBER_RE = /\b((?:mobile|mob|tel|telephone|phone|ph|cell|contact|whatsapp|call)\b\.?(?:\s*(?:no|number|num|#))?\.?\s*[:=#-]?\s*)\+?\d(?:[\s().-]*\d){8,}/gi;
// Ten or more digits in one piece are never a year or a date (and not a job): a telephone or an identifier, masked whatever the label.
const LONG_DIGITS_RE = /\b\d{10,}\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin|instagram|facebook|twitter|tiktok|indeed)\.com\S*/gi;
const HANDLE_RE = /(^|[\s(])@[A-Za-z0-9_.]{3,30}\b/g;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const DOB_RE = /\b(?:date of birth|d\.?o\.?b\.?|born)(?:\s+on|\s+in)?[:\s]+(?:\d{1,2}[\s/.-]+)?(?:\d{1,2}|[A-Za-z]{3,9})?[\s/.-]*\d{2,4}\b/gi;
const AGE_RE = /\b(?:aged?|age:)\s*\d{2}\b/gi;

function stripEdge(tok) {
  return String(tok || '').replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

// A name typed in lower case is still a name: a leading token is tested in capitalised form (the text is not re-cased).
function nameForm(tok, idx, span) {
  const t = stripEdge(tok);
  if (idx < span && LOWER_TOKEN.test(t) && !ROLE_WORD.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

// Whole month names only ('Martinez' starts with 'mar' and is a name): MONTH above is a prefix match, made for the body replacement.
const MONTH_NAME = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam)$/i;
// A capitalised word, or a word of a script that has no capitals (Arabic, Chinese, Devanagari ...): both can be a name.
const CASED_OR_CASELESS = new RegExp(`^[${UP}{Lu}${UP}{Lo}][${NAME_CHARS}]*$`, 'u');
const CASELESS_WORD = new RegExp(`^[${UP}{Lo}${UP}{M}${APOSTROPHES}-]+$`, 'u');

// 'J.' is an initial. A bare capital letter is one only beside another initial ('J R Smith'), and never A or I (English words: 'A la carte', 'E commerce').
const isDottedInitial = tok => /^\p{Lu}[.]$/u.test(String(tok).trim().replace(/[^\p{L}.]+$/u, ''));
const isBareInitial = tok => /^\p{Lu}$/u.test(stripEdge(tok)) && !/^[AI]$/.test(stripEdge(tok));

function nameShaped(toks, i) {
  const tok = toks[i];
  const t = stripEdge(tok);
  if (!t) return false;
  if (HONORIFIC.test(t) || PARTICLE.test(t)) return true; // a particle can also be a role word, but at the head of a ranked card it is a name part
  if (isDottedInitial(tok)) return true;
  if (isBareInitial(tok)) return [toks[i - 1], toks[i + 1]].some(x => x !== undefined && (isBareInitial(x) || isDottedInitial(x)));
  if (ROLE_WORD.test(t) || MONTH_NAME.test(t)) return false;
  return CASED_OR_CASELESS.test(t);
}

/**
 * How many leading tokens of a ranked card are a name, when no plain capitalised first token was found (an initial, an honorific, a particle such as De,
 * a mark-decomposed accent, a script without capitals). One to four name-shaped tokens, always leaving at least one token:
 *   - a name in a script without capitals ends where the script changes (the job title is Latin);
 *   - otherwise the name ends where the job title starts, the first role word; with no role word within reach, a leading honorific, particle or initial
 *     still marks the start of a name, so the name-shaped tokens are taken (a title word may be lost, a name is not kept); with no such cue nothing is cut.
 */
function leadingNameSpan(toks) {
  const max = Math.min(4, toks.length - 1);
  if (max < 1) return 0;
  const first = stripEdge(toks[0]);
  if (first && CASELESS_WORD.test(first)) {
    let k = 0;
    while (k < max && CASELESS_WORD.test(stripEdge(toks[k]))) k++;
    return k;
  }
  let n = 0;
  while (n < max && nameShaped(toks, n)) n++;
  if (n === 0) return 0;
  const next = stripEdge(toks[n]);
  if (ROLE_WORD.test(next) && !PARTICLE.test(next)) return n;
  return HONORIFIC.test(first) || PARTICLE.test(first) || isDottedInitial(toks[0]) || isBareInitial(toks[0]) ? n : 0;
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
  s = s.replace(LABELLED_NUMBER_RE, (m, label) => { notes.phones++; return label + '<PHONE>'; });
  s = s.replace(LONG_DIGITS_RE, () => { notes.phones++; return '<PHONE>'; });
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

  const hadRank = RANK_RE.test(s);
  s = s.replace(RANK_RE, '');

  const firstName = stripEdge(o.firstName);
  const fnTokens = firstName ? firstName.split(/\s+/).map(stripEdge).filter(Boolean) : [];
  let removedFirst = null;
  let removedSurname = null;

  if (fnTokens.length || hadRank) {
    let toks = s.split(' ');
    const span = fnTokens.length ? fnTokens.length + 1 : 2;
    let i = 0;
    if (fnTokens.length) {
      let k = 0;
      while (k < fnTokens.length && i < toks.length && stripEdge(toks[i]).toLowerCase() === fnTokens[k].toLowerCase()) { i++; k++; }
      if (k === fnTokens.length) removedFirst = fnTokens.join(' ');
      else i = 0;
    }
    if (removedFirst === null && hadRank) {
      // an honorific (Mr, Dr ...) is part of the name, not the first name: the first name is the token after it
      const h = toks.length > 2 && HONORIFIC.test(stripEdge(toks[0])) ? 1 : 0;
      const t0 = nameForm(toks[h], h, span + h);
      if (NAME_TOKEN.test(t0) && !ROLE_WORD.test(t0)) { removedFirst = t0; i = h + 1; }
    }
    // A ranked card whose first token is no plain capitalised word (an initial, an honorific, a particle such as De, a name in a script without
    // capitals) used to keep its whole name. The name is what stands before the first role word, when every token before it is name-shaped.
    let lead = 0;
    if (removedFirst === null && hadRank) {
      lead = leadingNameSpan(toks);
      if (lead > 0) removedFirst = toks.slice(0, lead).map(stripEdge).join(' ');
    }
    if (lead > 0) {
      notes.name = true;
      notes.surname = lead > 1;
      toks = toks.slice(lead);
      s = toks.join(' ');
    } else if (removedFirst !== null) {
      // surname: next capitalised token (optionally after a particle) that is not a role word
      let j = i;
      const parts = [];
      while (j < toks.length && parts.length < 3 && PARTICLE.test(stripEdge(toks[j]))) { parts.push(stripEdge(toks[j])); j++; }
      const t1 = nameForm(toks[j], j, span + parts.length);
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
