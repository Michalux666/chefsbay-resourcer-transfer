// Vendored from cv-corpus/lib/cv-redact.js (source sha256 951043ce2b8c) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// CV-specific redaction. Pure functions, no I/O, safe to reuse from production code.
//
//   redactCv(text, ctx) -> { text, counts, guessedNames }
//   verifyRedaction(text, ctx) -> { ok, leaks }        (count-only; never returns matched values)
//   scanResidual(text) -> counts                       (independent, deliberately looser detectors)
//
// ctx (all optional): { names: [string], emails: [string], phones: [string], postcodes: [string], guessName: bool }
//   names may hold a full name ("First Last") or single parts; every token is derived from them.
//
// Placeholders: [EMAIL] [PHONE] [URL] [HANDLE] [POSTCODE] [ADDRESS] [DOB] [AGE] [NAME] [ID] [REDACTED]
// Referee blocks and "references available" lines are removed. Line count is preserved except for removed
// referee blocks and lines that carry only contact placeholders.

const { classifyHeading, COMMON_NAME_WORDS, TITLE_WORDS, EMPLOYER_WORDS, MONTH_RE_SRC } = require('./cv-lexicon');

const PH = {
  email: '[EMAIL]', phone: '[PHONE]', url: '[URL]', handle: '[HANDLE]', postcode: '[POSTCODE]', address: '[ADDRESS]',
  dob: '[DOB]', age: '[AGE]', name: '[NAME]', id: '[ID]', redacted: '[REDACTED]',
};

const newCounts = () => ({
  email: 0, phone: 0, url: 0, handle: 0, postcode: 0, address: 0, dob: 0, age: 0, name: 0, id: 0, sensitive: 0,
  refereeBlocks: 0, refereeLines: 0, contactLines: 0,
});

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\u005c]/g, '\u005c$&');
const stripMarks = (s) => String(s).normalize('NFD').replace(/\p{M}+/gu, '');

// ---------------------------------------------------------------------------
// Letter-spaced lines ("W O R K   E X P E R I E N C E") are collapsed so headings and names can be matched

function collapseLetterSpacing(line) {
  const t = String(line);
  if (t.length < 5 || t.length > 120) return t;
  const parts = t.trim().split(/ {1,}/);
  // letter-spaced text: EVERY token is a single letter ("W O R K"); digits and punctuation never count
  if (parts.length >= 4 && parts.every((p) => /^\p{L}$/u.test(p))) {
    // words are separated by 2+ spaces in the source; when the extractor collapsed them keep a single space
    const groups = t.trim().split(/ {2,}/);
    if (groups.length > 1 && groups.every((g) => g.split(' ').every((c) => c.length === 1))) {
      return groups.map((g) => g.replace(/ /g, '')).join(' ');
    }
    return parts.join('');
  }
  return t;
}

// ---------------------------------------------------------------------------
// Detectors

// every quantifier below is bounded so that a 200 KB "word" cannot make a regex quadratic
const EMAIL_RE = /[A-Za-z0-9._%+'\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63}){1,6}/g;
const EMAIL_SPACED_RE = /[A-Za-z0-9._%+\-]{2,64}[ \t]?@[ \t]?[A-Za-z0-9\-]{1,63}(?:[ \t]?\.[ \t]?[A-Za-z]{2,24}){1,3}/g;
const EMAIL_OBFUSCATED_RE = /[A-Za-z0-9._%+\-]{2,64}\s{0,3}(?:\[\s{0,2}at\s{0,2}\]|\(\s{0,2}at\s{0,2}\)|\{\s{0,2}at\s{0,2}\})\s{0,3}[A-Za-z0-9\-]{1,63}(?:\s{0,3}(?:\[\s{0,2}dot\s{0,2}\]|\(\s{0,2}dot\s{0,2}\)|\.)\s{0,3}[A-Za-z]{2,24}){1,3}/gi;
const TLDS = 'com|co\u005c.uk|uk|org|org\u005c.uk|net|io|info|biz|london|eu|uk\u005c.com|gov\u005c.uk|ac\u005c.uk|nhs\u005c.uk|sch\u005c.uk';
// scheme / www forms (case-insensitive) and bare domains (lower-case TLD only, so "food.In charge" is left alone)
const URL_SCHEME_RE = /(?:https?:\/\/|www\.)[^\s<>"\)\]]+/gi;
const URL_BARE_RE = new RegExp('(?<![\u005cw@.-])(?:[A-Za-z0-9-]{1,63}\u005c.){1,6}(?:' + TLDS + ')(?:\u005c/[^\u005cs<>"\u005c)\u005c]]{0,300})?(?![\u005cw@-])', 'g');
const HANDLE_LABEL_RE = /\b(linkedin|instagram|facebook|twitter|tiktok|snapchat|skype|whats[a]pp|telegram|github|insta|fb)\s*[:\-]\s*[^\s,;|]+/gi;
const HANDLE_RE = /(?<![\w@])@[A-Za-z0-9_.]{3,30}/g;

// long runs of digits with phone-ish separators; validated afterwards
const PHONE_RUN_RE = /(?<![\d\u00a3$\u20ac])(?:\+|00)?\(?\d[\d\s().\-]{6,24}\d(?!\d)/g;
const YEAR_TOKEN_RE = /^(?:19|20)\d\d$/;

function isDateLikeNumberRun(raw) {
  const tokens = raw.split(/[^\d]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  if (tokens.every((t) => YEAR_TOKEN_RE.test(t))) return true;                       // "2015 - 2018"
  const hasYear = tokens.some((t) => YEAR_TOKEN_RE.test(t));
  if (hasYear && tokens.every((t) => t.length <= 2 || YEAR_TOKEN_RE.test(t))) return true; // "01.2019 - 03.2021"
  if (tokens.every((t) => t.length <= 2) && tokens.length >= 2 && tokens.length <= 6 && /[./-]/.test(raw) && !/^\s*[+(0]/.test(raw)) return true; // "12.03.19"
  return false;
}

function redactPhones(line, counts, knownTails) {
  return line.replace(PHONE_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    const known = knownTails && digits.length >= 7 && knownTails.some((t) => digits.endsWith(t));
    if (!known) {
      if (digits.length < 9 || digits.length > 16) return m;
      if (isDateLikeNumberRun(m)) return m;
    }
    counts.phone += 1;
    // keep the trailing separator characters that were swallowed by the run
    const trail = /[\s.\-]+$/.exec(m);
    return PH.phone + (trail ? trail[0] : '');
  });
}

const POSTCODE_RE = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d[A-Za-z\d]?[ \t]?\d[A-Za-z]{2}(?![A-Za-z0-9])/g;
const POSTCODE_LABEL_RE = /\b(post\s?code|zip(?:\s?code)?)\s*[:\-]\s*[A-Za-z]{1,2}\d[A-Za-z\d]?(?:\s?\d[A-Za-z]{2})?\b/gi;

// Street-type words that are unlikely to be part of an employer or job title ("park", "green", "end", "view", "hill" are
// left out on purpose: "2018 Park Hotel" must not become an address). House numbers are 1-3 digits and never a year.
const STREET_SUFFIX = '(?:road|rd|street|st|avenue|ave|lane|ln|close|drive|dr|way|court|ct|crescent|cres|gardens|gdns|grove|place|pl|terrace|square|sq|mews|parade|boulevard|villas|quay|wharf|meadow|meadows|cottages|vale|croft|orchard|chase|approach|broadway|highway|circus|embankment)';
const ADDRESS_NUM_RE = new RegExp(
  '(?<![\u005cw\u005c/])(?:(?:flat|apt|apartment|unit|room|suite|house|no)\u005c.?[ \u005ct]*\u005cd{1,3}[a-z]?[ \u005ct]*[,\u005c-]?[ \u005ct]*)?(?!(?:19|20)\u005cd\u005cd\u005cb)\u005cd{1,3}[a-z]?(?:[ \u005ct]*[-\u005c/][ \u005ct]*\u005cd{1,3}[a-z]?)?[ \u005ct]+(?:[A-Za-z\'.-]+[ \u005ct]+){0,3}?' + STREET_SUFFIX + '\u005cb\u005c.?',
  'gi',
);
const ADDRESS_FLAT_RE = /(?<![\w])(?:flat|apt|apartment|unit|room|suite)\.?\s*\d+[a-z]?\b[^\n]{0,60}/gi;
const ADDRESS_LABEL_RE = /^(\s*(?:home\s+|current\s+|permanent\s+|postal\s+|correspondence\s+)?(?:address|addr|location\s+address|residence)\s*[:\-]?\s*)(.*)$/i;
const PO_BOX_RE = /\bP\.?\s?O\.?\s+box\s+\d+\b/gi;

const DOB_LABEL_RE = /\b(d\.?\s?o\.?\s?b\.?|date\s+of\s+birth|birth\s?date|birth\s+day|birthday|year\s+of\s+birth|born(?:\s+on|\s+in)?|d\/o\/b)\b\s*[:\-]?\s*/i;
const AGE_LABEL_RE = /\b(age|aged)\s*[:\-]?\s*\d{2}\b/gi;
const YEARS_OLD_RE = /\b(?:1[6-9]|[2-7]\d)\s*[-\s]?(?:years?|yrs?)[-\s]?old\b/gi;
const SENSITIVE_LABEL_RE = /^(\s*(?:nationality|marital\s+status|gender|sex|religion|ethnicity|ethnic\s+origin|place\s+of\s+birth|country\s+of\s+birth|birth\s?place|maiden\s+name|children|dependants|dependents|health|disabilit(?:y|ies)|next\s+of\s+kin|emergency\s+contact|father'?s?\s+name|mother'?s?\s+name|spouse|husband|wife)\s*[:\-]\s*)(.+)$/i;
const ID_LABEL_RE = /^(\s*(?:n\.?i\.?\s*(?:no\.?|number)?|nino|national\s+insurance(?:\s+(?:no\.?|number))?|passport(?:\s+(?:no\.?|number))?|driving\s+licen[cs]e\s+(?:no\.?|number)|licen[cs]e\s+(?:no\.?|number)|share\s+code|brp(?:\s+(?:no\.?|number))?|visa\s+(?:no\.?|number)|utr|unique\s+taxpayer\s+reference)\s*[:\-]?\s*)([A-Za-z0-9 \-]{5,})$/i;
const NINO_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const DRIVING_NO_RE = /\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/g;
const FULL_DATE_RE = new RegExp('\u005cb(?:\u005cd{1,2}(?:st|nd|rd|th)?[\u005cs./\u005c-]+(?:of\u005cs+)?(?:' + MONTH_RE_SRC + '|\u005cd{1,2})[\u005cs.,/\u005c-]+(?:19|20)?\u005cd{2})\u005cb', 'gi');

const HONORIFIC_RE = /\b(?:Mr|MR|Mrs|MRS|Ms|MS|Miss|MISS|Mx|Dr|DR|Prof|Sir|Madam)\.?\s+(?:[A-Z][\p{L}'-]+)(?:\s+[A-Z][\p{L}'-]+)?/gu;
const REPORTING_RE = /\b(reporting\s+to|reported\s+to|report(?:s)?\s+to|line\s+manager|supervised\s+by|managed\s+by|mentor(?:ed)?\s+by)\s*:?\s+(?:the\s+)?([A-Z][\p{L}'-]+\s+[A-Z][\p{L}'-]+)\b/gu;

// ---------------------------------------------------------------------------
// Referee sections

const REFEREE_HEADING_RE = /^(?:professional\s+|character\s+|work\s+|personal\s+)?(?:referees?|references?)(?:\s+(?:details|contacts?))?\s*:?$/i;
const REFEREE_INLINE_RE = /^\s*(?:references?|referees?)\b[^\n]{0,80}\b(?:available|on\s+request|upon\s+request|can\s+be\s+(?:provided|supplied)|furnished|provided)\b[^\n]{0,60}$/i;
const REFEREE_LABEL_RE = /^\s*(?:referee|reference)\s*(?:#?\s*\d|one|two|1|2)?\s*[:\-]/i;
const REFEREE_MAX_LINES = 45;

function removeRefereeBlocks(lines, counts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/[\u2022*#_=|~>]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped && stripped.length <= 60 && REFEREE_HEADING_RE.test(stripped) && classifyHeading(line) === 'references') {
      // drop the heading and the block that follows until another known section heading (or a cap)
      let j = i + 1;
      let removed = 1;
      while (j < lines.length && removed < REFEREE_MAX_LINES) {
        const h = classifyHeading(lines[j]);
        if (h && h !== 'references') break;
        j += 1;
        removed += 1;
      }
      counts.refereeBlocks += 1;
      counts.refereeLines += removed;
      i = j;
      continue;
    }
    if (REFEREE_INLINE_RE.test(line) && line.length <= 160) {
      counts.refereeLines += 1;
      i += 1;
      continue;
    }
    if (REFEREE_LABEL_RE.test(line)) {
      // "Referee 1: name, role, contact ..." plus continuation lines up to a blank line
      let j = i + 1;
      let removed = 1;
      while (j < lines.length && lines[j].trim() !== '' && !classifyHeading(lines[j]) && removed < 12) { j += 1; removed += 1; }
      counts.refereeBlocks += 1;
      counts.refereeLines += removed;
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// E-mail handling on the whole text (addresses wrapped over lines, known addresses, known user names)

// local part, optional line wrap, '@', domain that may itself be wrapped ("...@g" newline "mail.com", "...@gmail" newline ".com")
const EMAIL_WRAPPED_RE = /[A-Za-z0-9._%+'-]{1,64}(?:[ \t]{0,4}\n[ \t]{0,4}(?:[A-Za-z0-9._%+'-]{1,64})?)?[ \t]?@\n?[A-Za-z0-9-]{1,63}(?:\n[A-Za-z0-9-]{1,63})?(?:\n?\.[A-Za-z0-9-]{1,63}){0,5}\n?\.[A-Za-z]{2,24}/g;

function redactEmailsText(text, knownEmails, counts) {
  let t = text;
  for (const e of knownEmails) {
    // every character may be followed by whitespace / a line break (PDF wrapping)
    const body = [...e.trim()].map((c) => escapeRe(c)).join('[ \u005ct]*\u005cn?[ \u005ct]*');
    t = t.replace(new RegExp(body, 'gi'), () => { counts.email += 1; return PH.email; });
    const local = e.split('@')[0];
    if (local && local.length >= 6 && /^[A-Za-z0-9._-]+$/.test(local)) {
      // the user name also shows up on its own (social handles, header lines)
      t = t.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(local)}(?![A-Za-z])`, 'gi'), () => { counts.handle += 1; return PH.handle; });
    }
  }
  t = t.replace(EMAIL_WRAPPED_RE, () => { counts.email += 1; return PH.email; });
  return t;
}

// ---------------------------------------------------------------------------
// Own-name handling

function nameTokensFrom(values) {
  const tokens = new Set();
  const full = [];
  for (const v of values || []) {
    if (typeof v !== 'string') continue;
    const clean = stripMarks(v).replace(/[^A-Za-z'\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    full.push(clean);
    for (const t of clean.split(/[\s\-]+/)) {
      const tt = t.replace(/^'+|'+$/g, '');
      if (tt.length >= 2) tokens.add(tt.toLowerCase());
    }
  }
  return { tokens: [...tokens], full };
}

function tokenRegex(tok) {
  // diacritics-tolerant, case-insensitive, letter boundaries, optional possessive is left to the text
  const letters = [...tok].map((c) => escapeRe(c) + '\u005cp{M}*').join('');
  return `(?<![\u005cp{L}\u005cp{N}])${letters}(?![\u005cp{L}\u005cp{N}])`;
}

function headerLikeName(lines) {
  // production fallback when the caller does not know the name: a short 2-3 word capitalised line near the top
  const look = lines.slice(0, 8);
  for (const raw of look) {
    const l = raw.trim();
    if (!l || l.length > 40 || /[\d@:/\u005c|\[\]]/.test(l)) continue;
    const words = l.replace(/[^\p{L}'\- ]/gu, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Z][\p{L}'-]+$/u.test(w) || /^[A-Z]{2,}$/.test(w) || /^[A-Z]$/.test(w))) continue;
    if (words.filter((w) => w.length > 1).length < 2) continue;
    if (classifyHeading(l)) continue;
    const lower = words.map((w) => w.toLowerCase());
    if (lower.some((w) => TITLE_WORDS.has(w) || EMPLOYER_WORDS.has(w) || (COMMON_NAME_WORDS.has(w) && words.length > 2))) continue;
    if (/curriculum|vitae|resume|page|profile|contact/i.test(l)) continue;
    return words;
  }
  return [];
}

function redactNames(text, ctx, counts, guessed) {
  const values = [...(ctx.names || [])];
  if (guessed && guessed.length) values.push(guessed.join(' '));
  const { tokens } = nameTokensFrom(values);
  if (tokens.length === 0) return text;
  const strong = tokens.filter((t) => t.length >= 3 && !COMMON_NAME_WORDS.has(t) && !TITLE_WORDS.has(t) && !EMPLOYER_WORDS.has(t));
  const weak = tokens.filter((t) => !strong.includes(t));
  let t = text.normalize('NFD');
  const count = (n) => { counts.name += n; };
  // runs of 2-4 name tokens, also glued or dot/underscore separated ("JOHNSMITH", "john.smith", "JoseMariaGarcia"), on one line
  const chainTokens = tokens.slice().sort((x, y) => y.length - x.length).slice(0, 8);
  if (chainTokens.length >= 2) {
    const T = '(?:' + chainTokens.map((a) => [...a].map((c) => escapeRe(c) + '\u005cp{M}*').join('')).join('|') + ')';
    const chain = new RegExp(`(?<![\u005cp{L}\u005cp{N}])${T}(?:[ \u005ct._'\u005c-]{0,3}${T}){1,3}(?![\u005cp{L}])`, 'giu');
    t = t.replace(chain, () => { count(1); return PH.name; });
  }
  if (strong.length) {
    const re = new RegExp(strong.map(tokenRegex).join('|'), 'giu');
    t = t.replace(re, () => { count(1); return PH.name; });
  }
  if (weak.length) {
    // weak tokens (common words, 2-letter tokens) only when glued to an already found name token
    const wre = weak.map(tokenRegex).join('|');
    const after = new RegExp(`(\u005c[NAME\u005c](?:[ \u005ct,.'\u005c-]+))(?:${wre})`, 'giu');
    const before = new RegExp(`(?:${wre})((?:[ \u005ct,.'\u005c-]+)\u005c[NAME\u005c])`, 'giu');
    for (let k = 0; k < 3; k += 1) {
      const prev = t;
      t = t.replace(after, (m, a) => { count(1); return a + PH.name; });
      t = t.replace(before, (m, b) => { count(1); return PH.name + b; });
      if (t === prev) break;
    }
    // a name alone on an early line or fully upper-cased header line is the candidate's own header
    const lines = t.split('\n');
    for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
      const ln = lines[i].trim();
      if (!ln || ln.length > 40) continue;
      const words = ln.split(/[\s,]+/).filter(Boolean);
      if (words.length >= 1 && words.length <= 4 && words.every((w) => weak.includes(stripMarks(w).toLowerCase().replace(/[^a-z'\-]/g, '')))) {
        lines[i] = PH.name;
        count(1);
      }
    }
    t = lines.join('\n');
  }
  // middle names / initials between two name placeholders, initial + surname, glued placeholders
  // (same-line separators only: a name at the end of one line must never swallow the next line)
  t = t.replace(/\[NAME\](?:[ \t.,'-]+(?:[A-Z][\p{L}'-]*\.?|[A-Z]\.?)){1,2}[ \t.,'-]+\[NAME\]/gu, PH.name);
  t = t.replace(/(?<![\p{L}])[A-Z]\.[ \t]*\[NAME\]/gu, PH.name);
  t = t.replace(/\[NAME\][ \t]+[A-Z]\.(?![\p{L}])/gu, PH.name);
  t = t.replace(/\[NAME\](?:[ \t,.'-]*\[NAME\])+/g, PH.name);
  return t.normalize('NFC');
}

// ---------------------------------------------------------------------------
// Main entry

function isPlaceholderOnlyLine(line) {
  const t = line.replace(/\[(?:EMAIL|PHONE|URL|HANDLE|ADDRESS|POSTCODE|NAME)\]/g, ' ').replace(/[\s,;|:\/\-]+/g, ' ').trim();
  if (t.length === 0) return /\[/.test(line);
  return /^(?:e-?mail|email|tel(?:ephone)?|phone|mobile|mob|cell|contact|contact\s+(?:number|no)|address|website|web|linkedin|url|home|work|m|t|e|a|w|skype|twitter|facebook|instagram)$/i.test(t);
}

function redactCv(input, ctx = {}) {
  const counts = newCounts();
  let text = String(input || '').replace(/\r\n?/g, '\n');
  let lines = text.split('\n').map(collapseLetterSpacing);

  // 1. referee blocks and "references available" lines
  lines = removeRefereeBlocks(lines, counts);

  // the header-name guess is taken from the pristine lines (before any placeholder is inserted)
  let guessed = [];
  if ((!ctx.names || ctx.names.length === 0) && ctx.guessName !== false) guessed = headerLikeName(lines);

  // e-mail addresses first, on the whole text: PDF extraction often wraps an address over two or three lines
  const knownEmailsEarly = (ctx.emails || []).filter((e) => typeof e === 'string' && e.trim());
  lines = redactEmailsText(lines.join('\n'), knownEmailsEarly, counts).split('\n');

  // 2. line-oriented sensitive labels
  let inPersonal = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const h = classifyHeading(line);
    if (h) inPersonal = h === 'personal';

    const mAddr = ADDRESS_LABEL_RE.exec(line);
    if (mAddr && mAddr[2] && mAddr[2].trim().length > 0) {
      lines[i] = mAddr[1] + PH.address;
      counts.address += 1;
      // an address continued on the next lines (town, county, postcode)
      let k = i + 1;
      while (k < lines.length && k <= i + 3 && lines[k].trim() && lines[k].trim().length < 40 && !classifyHeading(lines[k]) && !/[:@]/.test(lines[k]) && /^[\p{L}0-9 ,.'-]+$/u.test(lines[k].trim()) && !/\d{4}/.test(lines[k])) {
        // continuation only if it looks like place text and not a job line
        if (/(?:chef|cook|manager|assistant|porter|waiter|supervisor|kitchen|hotel|restaurant|ltd)/i.test(lines[k])) break;
        lines[k] = PH.address;
        counts.address += 1;
        k += 1;
      }
      continue;
    }
    const mSens = SENSITIVE_LABEL_RE.exec(line);
    if (mSens) { lines[i] = mSens[1] + PH.redacted; counts.sensitive += 1; continue; }
    const mId = ID_LABEL_RE.exec(line);
    if (mId) { lines[i] = mId[1] + PH.id; counts.id += 1; continue; }

    const mDob = DOB_LABEL_RE.exec(line);
    if (mDob) {
      const idx = mDob.index + mDob[0].length;
      const rest = line.slice(idx);
      if (rest.trim() === '') {
        // label alone; value may sit on the next line
        const nxt = lines[i + 1];
        if (nxt !== undefined && /^\s*(?:\d|(?:1st|2nd|3rd|\w+)\b)/.test(nxt) && nxt.length < 40) { lines[i + 1] = PH.dob; counts.dob += 1; }
        lines[i] = line.slice(0, idx) + PH.dob;
      } else {
        // value runs up to a separator that starts another field, else end of line
        const cut = rest.search(/\s{3,}|\t|\s\|\s|\s{2,}(?:[A-Z][a-z]+\s*:)/);
        const tail = cut >= 0 ? rest.slice(cut) : '';
        lines[i] = line.slice(0, idx) + PH.dob + tail;
      }
      counts.dob += 1;
      line = lines[i];
    }
    line = line.replace(AGE_LABEL_RE, (m, a) => { counts.age += 1; return a + ' ' + PH.age; });
    line = line.replace(YEARS_OLD_RE, () => { counts.age += 1; return PH.age; });
    line = line.replace(NINO_RE, () => { counts.id += 1; return PH.id; });
    line = line.replace(DRIVING_NO_RE, () => { counts.id += 1; return PH.id; });
    lines[i] = line;
    // unlabelled full dates (day month year) inside a personal-details block or the first lines of the CV
    if (inPersonal || i < 25) {
      const hasRange = /(?:\bto\b|-|\u2013|until|till)\s*(?:\d{1,2}[\s./-]+)?(?:\d{1,2}[\s./-]+)?(?:19|20)\d\d|(?:19|20)\d\d\s*(?:\bto\b|-|until|till)/i.test(line);
      if (!hasRange) {
        line = line.replace(FULL_DATE_RE, (m) => {
          const y = /(19|20)\d\d\s*$/.exec(m);
          const yy = /[./\s-](\d{2})\s*$/.exec(m);
          const yr = y ? parseInt(y[0], 10) : (yy && parseInt(yy[1], 10) >= 40 ? 1900 + parseInt(yy[1], 10) : null);
          if (yr !== null && yr >= 1940 && yr <= 2010) { counts.dob += 1; return PH.dob; }
          return m;
        });
        lines[i] = line;
      }
    }
  }

  // 3. token-level classes
  const knownEmails = (ctx.emails || []).filter(Boolean);
  const knownPhones = (ctx.phones || []).filter(Boolean);
  const knownTails = knownPhones.map((p) => String(p).replace(/\D/g, '')).filter((d) => d.length >= 7).map((d) => d.slice(-9));
  const knownPostcodes = (ctx.postcodes || []).filter((p) => typeof p === 'string' && p.replace(/\s/g, '').length >= 5);

  lines = lines.map((line) => {
    let l = line;
    l = l.replace(EMAIL_OBFUSCATED_RE, () => { counts.email += 1; return PH.email; });
    l = l.replace(EMAIL_RE, () => { counts.email += 1; return PH.email; });
    l = l.replace(EMAIL_SPACED_RE, () => { counts.email += 1; return PH.email; });
    l = l.replace(HANDLE_LABEL_RE, (m, label) => { counts.handle += 1; return `${label}: ${PH.handle}`; });
    l = l.replace(URL_SCHEME_RE, () => { counts.url += 1; return PH.url; });
    l = l.replace(URL_BARE_RE, () => { counts.url += 1; return PH.url; });
    l = l.replace(HANDLE_RE, () => { counts.handle += 1; return PH.handle; });
    l = redactPhones(l, counts, knownTails);
    for (const pc of knownPostcodes) {
      const compact = pc.replace(/\s+/g, '');
      const re = new RegExp([...compact].map(escapeRe).join('[ \u005ct]*'), 'gi');
      l = l.replace(re, () => { counts.postcode += 1; return PH.postcode; });
    }
    l = l.replace(POSTCODE_LABEL_RE, (m, lab) => { counts.postcode += 1; return `${lab}: ${PH.postcode}`; });
    l = l.replace(POSTCODE_RE, () => { counts.postcode += 1; return PH.postcode; });
    l = l.replace(PO_BOX_RE, () => { counts.address += 1; return PH.address; });
    return l;
  });

  // 4. street addresses (after postcode so "12 High Street, Leeds, [POSTCODE]" is visible as a unit)
  lines = lines.map((line) => {
    let l = line;
    ADDRESS_NUM_RE.lastIndex = 0;
    const m = ADDRESS_NUM_RE.exec(l);
    if (m) {
      const restStart = m.index + m[0].length;
      const rest = l.slice(restStart);
      // "12 High Street, Leeds, [POSTCODE]" -> the town/county tail on the same line goes too when it is short
      const tailShort = /^(?:\s*[,;]\s*(?:[\p{L}' .-]{2,30}|\[POSTCODE\])){1,4}\s*$/u.test(rest);
      counts.address += 1;
      l = l.slice(0, m.index) + PH.address + (tailShort ? '' : rest);
      l = l.replace(ADDRESS_NUM_RE, () => { counts.address += 1; return PH.address; });
    } else if (ADDRESS_FLAT_RE.test(l)) {
      ADDRESS_FLAT_RE.lastIndex = 0;
      l = l.replace(ADDRESS_FLAT_RE, () => { counts.address += 1; return PH.address; });
    }
    ADDRESS_FLAT_RE.lastIndex = 0;
    return l;
  });

  text = lines.join('\n');

  // 5. own name (known + optional guess), honorific names, "reporting to X Y"
  text = redactNames(text, ctx, counts, guessed);
  text = text.replace(HONORIFIC_RE, () => { counts.name += 1; return PH.name; });
  text = text.replace(REPORTING_RE, (m, lead, nm) => {
    const low = nm.toLowerCase().split(/\s+/);
    if (low.some((w) => TITLE_WORDS.has(w) || EMPLOYER_WORDS.has(w) || COMMON_NAME_WORDS.has(w))) return m;
    counts.name += 1;
    return `${lead} ${PH.name}`;
  });

  // 6. tidy: drop lines that carry only contact placeholders, squeeze blanks
  const outLines = [];
  let blank = 0;
  for (const l of text.split('\n')) {
    if (isPlaceholderOnlyLine(l)) { counts.contactLines += 1; continue; }
    const cleaned = l.replace(/[ \t]+$/g, '');
    if (cleaned.trim() === '') { blank += 1; if (blank <= 1) outLines.push(''); } else { blank = 0; outLines.push(cleaned); }
  }
  return { text: outLines.join('\n').trim(), counts, guessedNames: guessed.length > 0 };
}

// ---------------------------------------------------------------------------
// Verification (independent of the redaction regexes above: looser detectors + known-value search)

function scanResidual(input) {
  const text = String(input || '');
  const c = { email: 0, url: 0, phone: 0, postcode: 0, dob: 0, nino: 0, handle: 0 };
  c.email = (text.match(/@/g) || []).length;
  c.url = (text.match(/https?:|www\.|\.(?:com|co\.uk|org\.uk|net|org)\b|linkedin|facebook|instagram/gi) || []).length;
  for (const run of text.match(/\d[\d\s().+\-]{7,}\d/g) || []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 9 && !isDateLikeNumberRun(run)) c.phone += 1;
  }
  c.postcode = (text.match(/(?<![A-Za-z0-9])[A-Za-z]{1,2}\d{1,2}[A-Za-z]?\s?\d[A-Za-z]{2}(?![A-Za-z0-9])/g) || []).length;
  c.dob = (text.match(/\b(?:d\.?o\.?b\.?|date\s+of\s+birth|born)\b[^\n]{0,20}\d/gi) || []).length;
  c.nino = (text.match(/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g) || []).length;
  c.handle = (text.match(/(?<![\w@])@\w{3,}/g) || []).length;
  return c;
}

function verifyRedaction(input, ctx = {}) {
  const text = String(input || '');
  const lower = stripMarks(text).toLowerCase();
  const leaks = { email: 0, phone: 0, name: 0, postcode: 0 };
  for (const e of ctx.emails || []) {
    if (!e || typeof e !== 'string') continue;
    const el = e.toLowerCase().trim();
    if (el.length >= 5 && lower.includes(el)) leaks.email += 1;
    const local = el.split('@')[0];
    if (local.length >= 6 && new RegExp(`(?<![a-z0-9])${escapeRe(local)}(?![a-z])`).test(lower)) leaks.email += 1;
  }
  const digitLines = text.split('\n').map((l) => l.replace(/\D/g, ''));
  const flat = digitLines.join('|');
  for (const p of ctx.phones || []) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length < 7) continue;
    if (flat.includes(d.slice(-9))) leaks.phone += 1;
  }
  const { tokens, full } = nameTokensFrom(ctx.names || []);
  for (const f of full) {
    const parts = f.toLowerCase().split(/\s+/).filter((x) => x.length >= 2);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      const short = first.length < 3 || last.length < 3;
      // adjacent (optionally with one middle word), either order; short tokens only when directly adjacent
      const fwd = new RegExp(`(?<![a-z])${escapeRe(first)}(?![a-z])[^a-z\u005cn]{0,3}${short ? '' : '(?:[a-z]+[^a-z\u005cn]{1,3}){0,2}'}${escapeRe(last)}(?![a-z])`);
      const rev = new RegExp(`(?<![a-z])${escapeRe(last)}(?![a-z])[^a-z\u005cn]{0,3}${escapeRe(first)}(?![a-z])`);
      if (fwd.test(lower) || rev.test(lower)) leaks.name += 1;
      if (!short && (first + last).length >= 7) {
        const cat = new RegExp(`(?<![a-z])(?:${escapeRe(first)}[._]?${escapeRe(last)}|${escapeRe(last)}[._]?${escapeRe(first)})(?![a-z])`);
        if (cat.test(lower)) leaks.name += 1;
      }
    }
  }
  for (const t of tokens) {
    if (t.length < 4 || COMMON_NAME_WORDS.has(t) || TITLE_WORDS.has(t) || EMPLOYER_WORDS.has(t)) continue;
    if (new RegExp(`(?<![a-z])${escapeRe(t)}(?![a-z])`).test(lower)) leaks.name += 1;
  }
  // postcodes: per line and per adjacent line pair (a wrapped postcode), whitespace-insensitive
  const lowLines = lower.split('\n').map((l) => l.replace(/\s+/g, ''));
  for (const pc of ctx.postcodes || []) {
    const c = String(pc || '').replace(/\s+/g, '').toLowerCase();
    if (c.length < 5) continue;
    let hit = false;
    for (let i = 0; i < lowLines.length && !hit; i += 1) {
      if (lowLines[i].includes(c) || (i + 1 < lowLines.length && lowLines[i].length > 0 && lowLines[i].length < 12 && (lowLines[i] + lowLines[i + 1]).includes(c))) hit = true;
    }
    if (hit) leaks.postcode += 1;
  }
  const total = leaks.email + leaks.phone + leaks.name + leaks.postcode;
  return { ok: total === 0, leaks };
}

// ---------------------------------------------------------------------------
// Other people's names: scrub any adjacent word pair that is the full name of ANY known person (all candidates in the
// workspace), or a glued "firstlast" form. Pairs made only of job / employer vocabulary are ignored (a candidate named
// "Chef Kitchen" must not blank out a title). Same-line only; the line count never changes.
//   nameSets: { pairs:Set<'first last'>, glued:Set<'firstlast'> } (lower-case letters, marks stripped)

const NAME_TOKEN_RE = /[\p{L}][\p{L}'-]*/gu;
const FUNCTION_WORDS = new Set(['the', 'of', 'and', 'at', 'in', 'for', 'to', 'a', 'an', 'de', 'la', 'le']);
function isVocabularyPair(a, b) {
  const v = (w) => TITLE_WORDS.has(w) || EMPLOYER_WORDS.has(w) || FUNCTION_WORDS.has(w);
  return v(a) && v(b);
}

function scrubNamePairs(text, nameSets) {
  const src = String(text || '');
  if (!nameSets || (!nameSets.pairs.size && !nameSets.glued.size)) return { text: src, count: 0 };
  const toks = [];
  let m;
  NAME_TOKEN_RE.lastIndex = 0;
  while ((m = NAME_TOKEN_RE.exec(src)) !== null) {
    toks.push({ s: m.index, e: m.index + m[0].length, w: stripMarks(m[0]).toLowerCase().replace(/^['-]+|['-]+$/g, '') });
  }
  const spans = [];
  for (let i = 0; i < toks.length; i += 1) {
    const a = toks[i];
    if (a.w.length >= 7 && nameSets.glued.has(a.w)) { spans.push([a.s, a.e]); continue; }
    const b = toks[i + 1];
    if (!b || a.w.length < 2 || b.w.length < 2) continue;
    const between = src.slice(a.e, b.s);
    // up to six non-letter characters on the same line (punctuation, digits, brackets): the same adjacency the privacy scan uses
    if (!/^[^\p{L}\n]{0,6}$/u.test(between)) continue;
    if (nameSets.pairs.has(`${a.w} ${b.w}`) && !isVocabularyPair(a.w, b.w)) { spans.push([a.s, b.e]); i += 1; }
  }
  if (!spans.length) return { text: src, count: 0 };
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) { out += src.slice(pos, s) + PH.name; pos = e; }
  out += src.slice(pos);
  return { text: out, count: spans.length };
}

// Tokens that equal a known e-mail user name ("chef.person99") become [HANDLE]. userNames: Set of lower-case user names.
function scrubUserNames(text, userNames) {
  const src = String(text || '');
  if (!userNames || !userNames.size) return { text: src, count: 0 };
  let count = 0;
  const out = src.replace(/[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]/g, (m) => (userNames.has(m.toLowerCase()) ? (count += 1, PH.handle) : m));
  return { text: out, count };
}

module.exports = {
  redactCv, verifyRedaction, scanResidual, scrubNamePairs, scrubUserNames, isVocabularyPair, collapseLetterSpacing, nameTokensFrom, isDateLikeNumberRun, PLACEHOLDERS: PH,
};
