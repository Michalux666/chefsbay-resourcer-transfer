// Vendored from cv-corpus/lib/role-parser.js (source sha256 65d20647eb43) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// Deterministic work-history parser for REDACTED CV text.
//
//   parseCv(text, { asOf: 'YYYY-MM' }) -> {
//     roles: [{ title, employer, start, end, months, duties, evidence:[firstLine,lastLine], confidence, flags, datePrecision }],
//     qualifications: [keyword], skills: [keyword], parseConfidence, diagnostics }
//
// Guarantees (enforced by tests):
//  - NEVER invents a date or a title. Every date comes from a date expression found in the evidence lines; title and
//    employer are made only of words found in the evidence lines (surrounding punctuation, employment-type brackets such as
//    "(Full Time)", redaction placeholders and trailing town names may be trimmed; nothing is added or reworded).
//    When the parser is unsure the entry is marked confidence 'low' with flags, or omitted (education-like entries).
//  - start / end are 'YYYY-MM'. end is 'present' only for the written words present/current/now/to date/since... .
//  - Date precision is explicit (datePrecision):
//      'month'  both ends written with a month (Jan 2019 - Mar 2021): months = inclusive month count.
//      'year'   an end was written as a bare year (2015 - 2018): the month is NOT known. start is YYYY-01 and end is
//               YYYY-12 (the widest reading of the written years) and months is the DIFFERENCE OF THE WRITTEN YEARS x 12
//               (mid-year convention), flagged 'year_only' and 'months_approx'. Confidence is at most 'medium'.
//      'season' Summer 2019: first / last month of the season, flagged 'season', at most 'medium'.
//  - Undated entries (a job title line with no dates anywhere near it) have start/end/months = null, confidence 'low',
//    flag 'undated'. They are only produced when the CV contains no dated role at all.
//  - end null with flag 'open_end' means the CV wrote "Jan 2019 -" and nothing after the dash.
//
// Layout handling: date ranges are found line by line (including inside tab-separated table cells); each range becomes
// an anchor. The header lines (title / employer / location) belong to the anchor as the lines just before it, the
// text on the anchor line itself, and the lines just after it. How many belong before vs after is learned per document
// from the anchors that are bounded by duty text (so "title / employer / dates", "dates / title / employer",
// "title / dates / employer" and "title | employer | dates" on one line all work). Lines between two anchors with no
// duty text between them are split at a blank line if there is one, otherwise by the learned pattern.

const lex = require('./cv-lexicon');
const { parseDateRanges, rangeMonths, fmtYm, asOfYm, findTokens } = require('./date-parse');

const MAX_ROLES = 40;
const DUTIES_MAX = 240;

// ---------------------------------------------------------------------------
// Line analysis

const BULLET_LEAD_RE = /^(?:[\u2022\u25aa\u25ab\u25cf\u25e6\u2023\u00b7\u2219*>]+|-(?=\s*[A-Za-z(])|o(?=\s+[A-Za-z]))\s*/;
const WORD_RE = /[A-Za-z][A-Za-z'&.]*/g;
const DUTY_LEAD_RE = /^(?:responsible|responsibilities|duties|prepar(?:ed|ing)|manag(?:ed|ing)|work(?:ed|ing)|assist(?:ed|ing)|ensur(?:ed|ing)|maintain(?:ed|ing)|handl(?:ed|ing)|ran|running|led|leading|supervis(?:ed|ing)|train(?:ed|ing)|cook(?:ed|ing)|serv(?:ed|ing)|clean(?:ed|ing)|creat(?:ed|ing)|develop(?:ed|ing)|organis(?:ed|ing)|organiz(?:ed|ing)|coordinat(?:ed|ing)|deliver(?:ed|ing)|help(?:ed|ing)|provid(?:ed|ing)|carr(?:ied|ying)|took|taking|dealt|dealing|involved|including|include|includes|experience|skills|i|responsible|worked|also|as|was|were|have|had|has|being|been|able|good|excellent)\b/i;
const EDU_WORDS_RE = /\b(?:college|university|school|academy|gcse|a[\s-]?levels?|nvq|btec|diploma|degree|hnd|hnc|certificate|course|training|qualification|bachelor|master|sixth\s+form|city\s*&\s*guilds|city\s+and\s+guilds|level\s*[1-7])\b/i;
const EMP_TYPE_PAREN_RE = /\s*[(\[](?:full[\s-]?time|part[\s-]?time|temp(?:orary)?|casual|contract(?:or)?|seasonal|permanent|freelance|zero[\s-]?hours?|agency|volunteer|internship|apprenticeship|self[\s-]?employed|locum|relief|bank)[^)\]]*[)\]]\s*/gi;
const TITLE_LABEL_RE = /^(?:job\s+title|position(?:\s+held)?|role|title|post|designation|occupation)\s*[:\-]\s*(.+)$/i;
const EMPLOYER_LABEL_RE = /^(?:employer|company(?:\s+name)?|organi[sz]ation|workplace|business|establishment|hotel|restaurant|worked\s+(?:at|for))\s*[:\-]\s*(.+)$/i;
const IGNORE_LABEL_RE = /^(?:location|address|place|town|city|country|duration|dates?|period|from|to|tenure|reference|salary|reason\s+for\s+leaving|hours|type)\s*[:\-]/i;

function tokenize(s) { return (String(s).toLowerCase().match(WORD_RE) || []).map((w) => w.replace(/^[^a-z]+|[^a-z]+$/g, '')).filter(Boolean); }

const STRONG_EMPLOYER = new Set((
  'ltd limited plc llp inc corp co company group holdings restaurant restaurants hotel hotels pub pubs inn inns cafe cafes bistro ' +
  'brasserie grill lodge club clubs golf resort spa hospital hospitals school schools nursery college university council nhs trust ' +
  'foundation manor castle hall estate arms tavern gastropub theatre theater stadium arena airport bakery bakeries deli takeaway ' +
  'cafeteria canteen brewery distillery winery vineyard farm supermarket pizzeria trattoria ristorante osteria taverna sodexo ' +
  'compass aramark bidfood wetherspoon wetherspoons mcdonalds kfc subway nandos pret costa starbucks greggs tesco asda ' +
  'sainsburys morrisons waitrose lidl aldi travelodge hilton marriott hyatt radisson whitbread premier restaurateurs cruise'
).split(/\s+/).filter(Boolean));
const WEAK_EMPLOYER = new Set('kitchen kitchens catering services service events venue bar bars leisure entertainment contract hospitality house home care shop store market'.split(' '));

// Title evidence: a strong occupation word counts 2. Ambiguous words that also occur in employer names or are only a
// level ("kitchen", "head", "senior", "food") count 0.5 each, so a single one is NOT evidence (TITLE_EVIDENCE = 1).
const TITLE_EVIDENCE = 1;

// Things that are a business name even when they contain a job word ("The Porter House", "Catering Assistant Agency Ltd",
// "Chef & Brewer"): a legal-form marker, a leading "The" before a capitalised word, or a well-known chain.
const LEGAL_FORM_RE = /\b(?:ltd|limited|plc|llp|inc|group|holdings|company)\b\.?/i;
const CHAIN_RE = /\b(?:chef\s*&\s*brewer|pizza\s+(?:express|hut)|harvester|toby\s+carvery|beefeater|brewers\s+fayre|table\s+table|wagamama|yo!?\s+sushi|pret\s+a\s+manger|wetherspoons?|marston'?s|greene\s+king|premier\s+inn|travelodge|nando'?s)\b/i;
function isBusinessName(s) {
  const t = String(s).trim();
  return LEGAL_FORM_RE.test(t) || CHAIN_RE.test(t) || /^The\s+[A-Z]/.test(t);
}

function titleScore(s) {
  if (isBusinessName(s)) return 0;
  const w = tokenize(s);
  let strong = 0;
  let weak = 0;
  for (const x of w) {
    if (lex.STRONG_TITLE_WORDS.has(x)) strong += 2;
    else if (lex.TITLE_WORDS.has(x)) weak += 0.5;
  }
  let sc = strong + Math.min(weak, 1.5);
  if (/\bchef\s+de\s+partie\b|\bcdp\b|\bsous\s+chef\b|\bcommis\b|\bkitchen\s+porter\b|\bhead\s+chef\b/i.test(s)) sc += 1.5;
  return Math.min(sc, 8);
}
function strongTitleHit(s) { return !isBusinessName(s) && tokenize(s).some((x) => lex.STRONG_TITLE_WORDS.has(x)); }
function employerScore(s) {
  const w = tokenize(s);
  // "Restaurant Manager", "Hotel Receptionist": venue words used as a modifier of a job word are not employer evidence
  const titleWithModifier = !isBusinessName(s) && w.some((x) => lex.STRONG_TITLE_WORDS.has(x));
  let sc = 0;
  for (const x of w) {
    if (titleWithModifier) break;
    if (STRONG_EMPLOYER.has(x)) sc += 2;
    else if (WEAK_EMPLOYER.has(x)) sc += 0.5;
  }
  if (LEGAL_FORM_RE.test(s)) sc += 1.5;
  if (CHAIN_RE.test(s)) sc += 2;
  if (/^The\s+[A-Z]/.test(String(s).trim())) sc += 1;
  return Math.min(sc, 6);
}

function stripBullet(t) { return t.replace(BULLET_LEAD_RE, '').trim(); }

function analyzeLines(lines, asOf) {
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();
    const it = { i, no: i + 1, raw, t, blank: t === '', bullet: false, heading: null, subheading: false, ranges: [], residual: '', dateOnly: false, len: t.length, cells: t.split(/\t+/).map((c) => c.trim()).filter(Boolean) };
    if (!it.blank) {
      it.bullet = BULLET_LEAD_RE.test(t) && !/^-\s*(?:\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|present|to|current)\b)/i.test(t);
      // headings are recognised per cell so that "SKILLS <tab> WORK EXPERIENCE" (two columns) is seen
      // a lower-case word alone on a line inside running text ("training" wrapped onto its own line) is not a heading
      const wrapped = /^[a-z]/.test(t) && i > 0 && lines[i - 1].trim() !== '';
      const keys = wrapped ? [] : it.cells.map((c) => lex.classifyHeading(c)).filter(Boolean);
      if (keys.length > 0 && keys.length === it.cells.length) it.heading = keys.includes('experience') ? 'experience' : keys[0];
      else if (it.cells.length === 1 && !wrapped) it.heading = lex.classifyHeading(t);
      it.subheading = !it.heading && lex.isSubheading(t);
      if (!it.heading) {
        it.ranges = parseDateRanges(t, { asOf });
        if (it.ranges.length) {
          let res = t;
          for (const r of [...it.ranges].sort((a, b) => b.index - a.index)) res = res.slice(0, r.index) + ' ' + res.slice(r.index + r.length);
          it.residual = cleanPiece(res.replace(/\t+/g, ' | ').replace(/[(\[]\s*[)\]]/g, ' ').replace(/\b(?:since|from|starting|started|joined|commenced)\s*$/i, ''));
          it.dateOnly = it.residual.replace(/[^A-Za-z]/g, '').length < 2;
        }
      }
    }
    items.push(it);
  }
  return items;
}

function cleanPiece(s) {
  let t = String(s)
    .replace(/\t+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:|\-\/]+|[\s,;:|\-\/]+$/g, '')
    .trim();
  // brackets are only trimmed when unmatched: "Head Chef (Kitchen)" keeps its brackets, "Head Chef)" loses one
  for (let k = 0; k < 4; k += 1) {
    const opens = (t.match(/[(\[]/g) || []).length;
    const closes = (t.match(/[)\]]/g) || []).length;
    let changed = false;
    if (closes > opens && /[)\]]$/.test(t)) { t = t.slice(0, -1).replace(/[\s,;:|\-\/]+$/g, ''); changed = true; }
    if (opens > closes && /^[(\[]/.test(t)) { t = t.slice(1).replace(/^[\s,;:|\-\/]+/g, ''); changed = true; }
    if (!changed) break;
  }
  return t.trim();
}

// A single date on one line and "- date"/"present" on the next one is one range. The second line is blanked
// so that every later line number still refers to the original text.
function mergeSplitDates(lines, asOf) {
  const out = lines.slice();
  const isDateFragment = (t) => {
    const toks = findTokens(t);
    if (toks.length !== 1) return null;
    const tk = toks[0];
    const rest = (t.slice(0, tk.s) + ' ' + t.slice(tk.e)).replace(/[\s()\[\]]/g, '');
    if (rest === '' || /^(?:-|to|until|since|from)+$/i.test(rest)) return tk;
    return null;
  };
  for (let i = 0; i < out.length - 1; i += 1) {
    const a = out[i].trim();
    if (!a || a.length > 40) continue;
    if (parseDateRanges(a, { asOf }).length > 0) continue;
    const ta = isDateFragment(a);
    if (!ta) continue;
    const j = out[i + 1].trim() === '' && i + 2 < out.length ? i + 2 : i + 1;
    const b = out[j].trim();
    if (!b || b.length > 40) continue;
    const lead = /^(?:-|to|until|till)\s*(.*)$/i.exec(b);
    const aEndsWithSep = /(?:-|to|until)\s*$/i.test(a);
    if (!lead && !aEndsWithSep) continue;
    const tail = lead ? lead[1] : b;
    if (!isDateFragment(tail) && !/^(?:present|current|now|to\s+date|ongoing)\b/i.test(tail)) continue;
    const merged = `${a.replace(/\s*(?:-|to|until)\s*$/i, '')} - ${tail}`;
    if (parseDateRanges(merged, { asOf }).length === 0) continue;
    out[i] = merged;
    out[j] = '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sections

function computeSections(items) {
  const secOf = new Array(items.length).fill('top');
  let cur = 'top';
  let seenExperience = false;
  for (const it of items) {
    if (it.heading) {
      cur = it.heading;
      if (cur === 'experience') seenExperience = true;
      secOf[it.i] = 'heading:' + cur;
      continue;
    }
    secOf[it.i] = cur;
  }
  return { secOf, hasExperienceHeading: seenExperience };
}

const NON_EXPERIENCE = new Set(['references', 'personal']);

// ---------------------------------------------------------------------------
// Header line selection

function isHeaderLike(it) {
  if (it.blank || it.bullet || it.heading || it.subheading) return false;
  if (it.ranges.length) return false;
  const t = it.t;
  if (t.length < 2 || t.length > 130) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  const words = t.split(/\s+/).length;
  const evidence = titleScore(t) >= 2 || employerScore(t) >= 2;
  const cellMax = Math.max(...it.cells.map((c) => c.length));
  if (cellMax > (evidence ? 110 : 80) || t.length > (evidence ? 130 : 90)) return false;
  if (words > (evidence ? 20 : 12)) return false;
  if (/^[a-z]/.test(t) && !/^(?:the|de|la|le|el|van|von)\b/i.test(t) && !(evidence && words <= 12)) return false;
  if (/[a-z]{3}[.!?]$/.test(t) && words > 2) return false;   // a sentence
  if (DUTY_LEAD_RE.test(t) && words >= 3 && strongTitleHit(t) === false) return false;
  return true;
}

function classifyGapLine(it) {
  if (it.blank) return 'B';
  if (it.subheading) return 'S';
  if (it.heading) return 'X';
  if (isHeaderLike(it)) return 'H';
  return 'D';
}

// ---------------------------------------------------------------------------
// Role field extraction from header pieces

// "Sous Chef, Hotel du Vin" / "Hotel du Vin, Sous Chef" split at the comma; "Sous Chef, Banqueting" and
// "The Ivy, London" stay whole (same kind on both sides).
function splitComma(p) {
  const segs = p.split(/,\s+/);
  if (segs.length < 2) return [p];
  const out = [];
  let cur = segs[0];
  for (let i = 1; i < segs.length; i += 1) {
    const right = segs[i];
    const lt = titleScore(cur);
    const le = employerScore(cur);
    const rt = titleScore(right);
    const re = employerScore(right);
    const leftTitle = lt >= TITLE_EVIDENCE && le < 1;
    const rightTitle = rt >= TITLE_EVIDENCE;
    const rightWords = right.trim().split(/\s+/).length;
    const rightProper = /^[A-Z0-9\[]/.test(right) && !strongTitleHit(right) && (re >= 1 || rt < TITLE_EVIDENCE) && (re >= 1 || rightWords >= 2 || rt === 0);
    const split = (leftTitle && re >= 1 && rt <= re) ||                                 // "Accountant, Sample LLP"
      (leftTitle && strongTitleHit(cur) && !rightTitle && rightProper) ||              // "Head Chef, The Ivy" (not "Sous Chef, Banqueting")
      (le >= 1 && lt <= le && rightTitle && re < 1) ||                                 // "Hotel du Vin, Sous Chef"
      (lt < TITLE_EVIDENCE && le === 0 && rightTitle && strongTitleHit(right));        // "The Ivy, Head Chef"
    if (split) { out.push(cur); cur = right; } else { cur = `${cur}, ${right}`; }
  }
  out.push(cur);
  return out;
}

// Drops trailing single-word comma segments (towns, countries) from an employer string: "The Ivy, London, UK" -> "The Ivy"
function trimLocation(s) {
  let segs = String(s).split(/,\s+/);
  while (segs.length > 1 && /^[A-Z][A-Za-z.'-]{1,20}$/.test(segs[segs.length - 1].trim()) && (segs.slice(0, -1).join(' ').split(/\s+/).length >= 2 || employerScore(segs.slice(0, -1).join(' ')) > 0)) {
    segs = segs.slice(0, -1);
  }
  return segs.join(', ');
}

// "head chef in a restaurant in Leeds" / "chef at the Old Inn": the title, then where. Only when the left side is clearly a
// title and the right side looks like a place of work (capitalised, or a venue word), never for "in charge of ...".
const LOCATIVE_RE = /\s+(?:at|in|for|with)\s+(?!charge\b|the\s+(?:kitchen|team|pass|section|absence|role)\b|a\s+(?:busy|fast|high|team|large|small|variety)\b|our\b|house\b|all\b|busy\b|different\b)/i;
const VENUE_WORD_RE = /\b(?:restaurants?|hotels?|pubs?|inns?|bars?|caf[e\u00e9]s?|bistros?|brasseries?|clubs?|schools?|hospitals?|care\s+homes?|canteens?|kitchens?|resorts?|catering|takeaway)\b/i;
function splitLocative(q) {
  const m = LOCATIVE_RE.exec(q);
  if (!m) return [q];
  const left = q.slice(0, m.index);
  const rest = q.slice(m.index + m[0].length);
  const probe = rest.replace(/^(?:an?|the)\s+/i, '').trim();     // the words after an article decide whether it names a workplace
  if (!(titleScore(left) >= TITLE_EVIDENCE && strongTitleHit(left) && probe.length >= 2)) return [q];
  const ok = /^[A-Z0-9\[]/.test(probe) || VENUE_WORD_RE.test(probe);
  return ok ? [left, rest] : [q];
}

// "Pizza Chef & Kitchen Porter Pizza Express": a well-known chain name inside a longer piece is split off from the title
function splitChain(q) {
  const s = String(q);
  const m = CHAIN_RE.exec(s);
  if (!m) return [s];
  const left = s.slice(0, m.index).trim();
  const right = s.slice(m.index + m[0].length).trim();
  if (left && titleScore(left) >= TITLE_EVIDENCE) return [left, s.slice(m.index).trim()];
  if (!left && right && titleScore(right) >= TITLE_EVIDENCE) return [m[0], right];
  return [s];
}

// "The Bell Arms Head Chef" / "Head Chef Sample Hotel": a proper name and a title run together with no separator.
// Split only when one side is a strong title with no employer evidence and the other side contains a proper-noun word
// that is not vocabulary ("Hotel Bar Manager" is a title and stays whole).
const KNOWN_WORDS = new Set([...lex.TITLE_WORDS, ...lex.STRONG_TITLE_WORDS, ...lex.EMPLOYER_WORDS, ...STRONG_EMPLOYER, ...WEAK_EMPLOYER, 'the', 'of', 'and', 'de', 'la', 'le', 'at', 'in', 'for', 'a', 'an', 'to', 'with', '&', 'partie', 'commis', 'sous', 'demi', 'junior', 'senior', 'head', 'executive', 'deputy', 'assistant', 'lead', 'second', 'first', 'general', 'part', 'time', 'full', 'temporary', 'casual', 'seasonal', 'permanent', 'freelance', 'contract', 'private', 'professional', 'independent', 'employed', 'self']);
function hasProperName(s) {
  return String(s).split(/\s+/).some((w) => /^[A-Z][a-z]{2,}$|^[A-Z]{3,}$/.test(w) && !KNOWN_WORDS.has(w.toLowerCase()));
}
function splitNameTitle(q) {
  const words = String(q).trim().split(/\s+/);
  if (words.length < 3 || words.length > 9) return [q];
  if (LEGAL_FORM_RE.test(q) || CHAIN_RE.test(q)) return [q];      // "Catering Assistant Agency Ltd" is one business name
  const isTitleWord = (w) => { const x = w.toLowerCase().replace(/[^a-z]/g, ''); return lex.TITLE_WORDS.has(x) || lex.STRONG_TITLE_WORDS.has(x) || x === 'de' || x === 'partie' || x === 'of'; };
  // trailing title: the longest run of title words at the end ("The Bell Arms | Head Chef")
  let j = words.length;
  while (j > 0 && isTitleWord(words[j - 1])) j -= 1;
  if (j > 0 && j < words.length) {
    const left = words.slice(0, j).join(' ');
    const right = words.slice(j).join(' ');
    if (titleScore(right) >= 2 && strongTitleHit(right) && employerScore(right) < 1 && (hasProperName(left) || isBusinessName(left)) && !strongTitleHit(left.replace(/\b(?:the|of|and)\b/gi, ''))) return [left, right];
  }
  // leading title: the shortest strong-title prefix followed by a proper name ("Head Chef | Sample Hotel")
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    if (titleScore(left) >= 2 && strongTitleHit(left) && employerScore(left) < 1 && (hasProperName(right) || employerScore(right) >= 1) && !strongTitleHit(right) && !/^(?:in|at|for|with|and|of|a|an|the)\b/.test(right)) return [left, right];
  }
  return [q];
}

// "Bell Hotel-Head Chef": a hyphen with no spaces splits only where one side is clearly a title and the other clearly is not
// ("Sous-Chef", "Co-op" stay whole).
function splitHyphen(q) {
  const s = String(q);
  for (let i = s.indexOf('-'); i > 0 && i < s.length - 1; i = s.indexOf('-', i + 1)) {
    if (!/[A-Za-z]/.test(s[i - 1]) || !/[A-Za-z]/.test(s[i + 1])) continue;
    const left = s.slice(0, i);
    const right = s.slice(i + 1);
    const leftTitle = titleScore(left) >= TITLE_EVIDENCE;
    const rightTitle = titleScore(right) >= TITLE_EVIDENCE;
    if (rightTitle && strongTitleHit(right) && !leftTitle && left.trim().split(/\s+/).length >= 2) return [left, right];
    if (leftTitle && strongTitleHit(left) && !rightTitle && right.trim().split(/\s+/).length >= 2) return [left, right];
  }
  return [s];
}

// Returns [{ text, cell }] : the pieces of a header line, with the tab-separated cell each came from.
function splitPartsDetailed(line) {
  const parts = [];
  let cellNo = 0;
  for (const cell of String(line).replace(EMP_TYPE_PAREN_RE, ' ').split(/\t+/)) {
    cellNo += 1;
    // "chef / cook" (title / title) stays one piece; other separators split
    // separators: pipes and bullets, a dash with a space on at least one side ("Head Chef - The Ivy", "Head Chef- The Ivy"),
    // "@", " at ", and a slash (with spaces, or between two words: "Hilton/Head Chef"). "Sous-Chef" and "24/7" stay whole.
    const rawParts = cell.split(/(\s+\|\s+|\s+\u2022\s+|\s+-\s*|\s*-\s+|\s+@\s+|\s+at\s+(?=[A-Z0-9\[])|\s+\/{1,3}\s*|\s*\/{1,3}\s+|(?<=[A-Za-z]{3})\/(?=[A-Za-z]{3})|\s*[|]\s*)/);
    const merged = [];
    for (let i = 0; i < rawParts.length; i += 2) {
      const text = rawParts[i];
      const sep = i > 0 ? rawParts[i - 1] : null;
      const prev = merged.length ? merged[merged.length - 1] : null;
      // "chef / cook" (title / title) stays one piece and keeps its original separator characters
      if (prev && /\//.test(sep || '') && titleScore(prev) >= TITLE_EVIDENCE && titleScore(text) >= TITLE_EVIDENCE && employerScore(prev) < 1 && employerScore(text) < 1) {
        merged[merged.length - 1] = `${prev}${sep}${text}`;
      } else merged.push(text);
    }
    for (const p of merged) {
      const q = cleanPiece(p);
      if (!q) continue;
      for (const piece of splitComma(q)) {
        const c2 = cleanPiece(piece);
        if (!c2) continue;
        for (const loc of splitLocative(c2)) {
          for (const hy of splitHyphen(loc)) {
            for (const ch of splitChain(hy)) {
              for (const nt of splitNameTitle(ch)) { const c3 = cleanPiece(nt); if (c3) parts.push({ text: c3, cell: cellNo }); }
            }
          }
        }
      }
    }
  }
  return parts;
}
function splitParts(line) { return splitPartsDetailed(line).map((p) => p.text); }

// education / certificate fragments that share a line with a job (two-column layouts) are not part of a title or employer
const EDU_PIECE_RE = /\b(?:level\s*\d|nvq|gcse|btec|diploma|certificate|qualification|hygiene|haccp|coshh|city\s*&\s*guilds)\b/i;

// employment-type words at the start of an employer / title piece ("Part time Sample Bistro") are not part of the name
const EMP_TYPE_LEAD_RE = /^(?:part[\s-]?time|full[\s-]?time|permanent|temporary|casual|seasonal|freelance|zero[\s-]?hours?)\b[\s:,-]*/i;
function stripTypeBrackets(s) {
  const t = cleanPiece(s.replace(EMP_TYPE_PAREN_RE, ' '));
  const u = t.replace(EMP_TYPE_LEAD_RE, '');
  return u.length >= 2 && /[A-Za-z]/.test(u) ? cleanPiece(u) : t;
}

function locationLike(s) {
  const w = s.trim().split(/[\s,]+/).filter(Boolean);
  if (w.length === 0) return true;
  if (/^(?:uk|u\.k\.|united kingdom|england|scotland|wales|london|ireland)$/i.test(s.trim())) return true;
  if (w.length <= 2 && /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/.test(s.trim()) && titleScore(s) < TITLE_EVIDENCE && employerScore(s) === 0) return false; // could be an employer
  return false;
}

function placeholderOnly(s) { return s.replace(/\[[A-Z]+\]/g, '').replace(/[^A-Za-z]/g, '').length < 2; }

// a piece that is only a date fragment ("Mar 2021", "2019", "present") is never a title or an employer
const DATE_WORDS_RE = new RegExp('\u005cb(?:' + lex.MONTH_RE_SRC + '|' + lex.SEASON_RE_SRC + '|' + lex.PRESENT_RE_SRC + '|to|until|since|from|till)\u005cb', 'gi');
function dateOnlyPiece(s) { return s.replace(DATE_WORDS_RE, ' ').replace(/[^A-Za-z]/g, '').length < 2; }

// contact placeholders left by the redactor (an employer's address or phone) are not part of a name
function stripContact(s) {
  const segs = String(s).split(/,\s+/).filter((x) => !/\[(?:POSTCODE|ADDRESS|PHONE|EMAIL|URL|HANDLE|ID)\]/.test(x));
  return segs.join(', ').replace(/\[(?:POSTCODE|ADDRESS|PHONE|EMAIL|URL|HANDLE|ID)\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function extractFields(headerLines) {
  // labelled fields first
  let labelTitle = null;
  let labelEmployer = null;
  const free = [];
  for (const h of headerLines) {
    const h1 = stripBullet(h);
    if (IGNORE_LABEL_RE.test(h1)) continue;
    const mt = TITLE_LABEL_RE.exec(h1);
    if (mt) { labelTitle = cleanPiece(mt[1]); continue; }
    const me = EMPLOYER_LABEL_RE.exec(h1);
    if (me) { labelEmployer = cleanPiece(me[1]); continue; }
    free.push(h1);
  }
  const cands = [];
  free.forEach((h0, li) => {
    // prose: "worked as a head chef at the Old Inn" -> "head chef at the Old Inn"
    let h = h0;
    const asM = /\b(?:worked|working|employed|position|role)?\s*\bas\s+(?:an?|the)\s+(.+)$/i.exec(h);
    if (asM && titleScore(asM[1]) >= TITLE_EVIDENCE && !/[.;]\s/.test(asM[1])) h = asM[1];
    const parts = splitPartsDetailed(h);
    parts.forEach((p, pi) => {
      const clean = stripTypeBrackets(p.text);
      if (!clean || placeholderOnly(clean) || dateOnlyPiece(clean) || EDU_PIECE_RE.test(clean)) return;
      cands.push({ text: clean, ts: titleScore(clean), es: employerScore(clean), line: li, part: pi, cell: p.cell, nParts: parts.length });
    });
  });
  let title = null;
  let employer = null;
  let titleFlag = null;
  if (labelTitle) { title = { text: stripTypeBrackets(labelTitle), ts: titleScore(labelTitle), es: 0 }; }
  if (labelEmployer) { employer = { text: labelEmployer }; }
  if (!title) {
    let best = null;
    for (const c of cands) {
      const sc = c.ts - 0.6 * c.es;
      if (c.ts >= TITLE_EVIDENCE && (best === null || sc > best.sc)) best = { c, sc };
    }
    if (best) {
      title = best.c;
      // a whole line made only of title parts ("Chef de Partie - Pastry Chef") stays together
      const sameLine = cands.filter((c) => c.line === title.line);
      if (sameLine.length > 1 && sameLine.every((c) => c.ts >= TITLE_EVIDENCE && c.es === 0 && strongTitleHit(c.text) && c.cell === title.cell)) {
        const lineText = stripTypeBrackets(free[title.line]);
        if (lineText.length <= 80) title = { text: cleanPiece(lineText), ts: titleScore(lineText), es: 0, line: title.line, whole: true };
      }
    } else {
      // no title evidence anywhere. Only when another piece is clearly an employer is the remaining short capitalised piece
      // reported as the title, flagged 'title_unverified'; a lone unknown piece is never promoted to a title.
      const hasEmp = cands.some((c) => c.es >= 1);
      const first = hasEmp ? cands.find((c) => c.es === 0 && /^[A-Z]/.test(c.text) && c.text.split(/\s+/).length <= 6 && c.text.length <= 60) : null;
      if (first) { title = first; titleFlag = 'title_unverified'; }
    }
  }
  if (!employer) {
    const rest = cands.filter((c) => !title || c.text !== title.text || c.line !== title.line || c.part !== title.part).filter((c) => !(title && title.whole && c.line === title.line));
    // 1. clear employer evidence (Ltd, Hotel, Restaurant ...), 2. a proper-noun piece (same line as the title first),
    // 3. weak evidence only (a bare "kitchen", "catering")
    let bestE = null;
    for (const c of rest) {
      if (c.es >= 1 && c.ts <= c.es + 0.5 && (bestE === null || c.es > bestE.es)) bestE = c;
    }
    if (!bestE) {
      const proper = rest.filter((c) => c.ts < TITLE_EVIDENCE && c.es < 1 && /^[A-Z0-9\[]/.test(c.text) && !locationLike(c.text) && c.text.length <= 70 && !/[a-z]{3}[.!?]$/.test(c.text));
      const sameLine = title ? proper.find((c) => c.line === title.line) : null;
      bestE = sameLine || proper[0] || null;
    }
    if (!bestE) bestE = rest.find((c) => c.es > 0 && c.ts <= c.es + 0.5) || null;
    if (bestE) employer = { text: bestE.text };
  }
  const titleText = title ? cleanPiece(stripContact(title.text)) : null;
  let employerText = employer ? cleanPiece(trimLocation(stripContact(employer.text))) : null;
  // narrative CVs ("from March 2016 until May 2018 worked as a chef at ...") produce sentence fragments: flag the title, drop
  // an employer that starts mid-sentence
  const fnWords = (s) => (String(s).match(/\b(?:from|until|with|for|the|and|in|of|to|at|as|on|by|an?)\b/g) || []).length;
  const titleProse = !!(titleText && titleText.split(/\s+/).length >= 6 && fnWords(titleText) >= 3);
  let employerProse = false;
  if (employerText && (/^(?:from|until|since|for|with|as|and|at|in|to)\s/.test(employerText) || (employerText.split(/\s+/).length >= 8 && fnWords(employerText) >= 4))) { employerText = null; employerProse = true; }
  return {
    title: titleText || null,
    titleStrong: !!(titleText && strongTitleHit(titleText)),
    titleFlag: titleText ? titleFlag : null,
    titleLong: !!(titleText && (titleText.split(/\s+/).length > 6 || titleText.length > 50)),
    titleProse,
    employerProse,
    employer: employerText && !placeholderOnly(employerText) ? employerText : null,
    labelled: !!(labelTitle || labelEmployer),
  };
}

// ---------------------------------------------------------------------------
// Qualifications / skills

function extractKeywords(text) {
  const quals = [];
  for (const [kw, re] of lex.QUALIFICATION_PATTERNS) if (re.test(text)) quals.push(kw);
  // a specific hygiene level makes the generic keyword redundant
  const q = quals.filter((k) => !(k === 'food-hygiene' && quals.some((x) => /^food-hygiene-l\d$/.test(x))) && !(k === 'nvq' && quals.some((x) => /^nvq-l\d$/.test(x))));
  const skills = [];
  for (const [kw, re] of lex.SKILL_PATTERNS) if (re.test(text)) skills.push(kw);
  return { qualifications: q, skills };
}

// ---------------------------------------------------------------------------
// Main

function unionMonths(intervals) {
  const list = intervals.filter((x) => x && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] >= x[0]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of list) {
    if (curS === null) { curS = s; curE = e; continue; }
    if (s <= curE + 1) { curE = Math.max(curE, e); continue; }
    total += curE - curS + 1;
    curS = s; curE = e;
  }
  if (curS !== null) total += curE - curS + 1;
  return total;
}

const ymIdx = (ym) => ym.y * 12 + (ym.m - 1);

function joinDuties(items) {
  const parts = [];
  for (const it of items) {
    const s = stripBullet(it.t).replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (s) parts.push(s);
  }
  let d = parts.join(' ');
  if (d.length > DUTIES_MAX) {
    d = d.slice(0, DUTIES_MAX);
    const sp = d.lastIndexOf(' ');
    if (sp > DUTIES_MAX - 40) d = d.slice(0, sp);
  }
  return d.trim();
}

function parseCv(input, opts = {}) {
  const asOf = opts.asOf && /^\d{4}-\d{2}$/.test(opts.asOf) ? opts.asOf : fmtYm(asOfYm(null));
  const text = String(input || '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n');
  const rawLines = text.split('\n');
  const lines = mergeSplitDates(rawLines, asOf);
  const items = analyzeLines(lines, asOf);
  const { secOf, hasExperienceHeading } = computeSections(items);
  const kw = extractKeywords(text);

  const diag = {
    lines: items.length,
    hasExperienceHeading,
    dateLines: items.filter((x) => x.ranges.length).length,
    anchors: 0, rolesBuilt: 0, skippedEducationLike: 0, skippedNotRole: 0, dateOnlyRuns: 0,
    tabLineShare: 0, pattern: null, layoutFlags: [],
  };
  const nonBlank = items.filter((x) => !x.blank);
  const multiCell = (x) => x.cells.filter((c) => !/^[\u2022\u25aa\u25cf\u25e6\u2023\u00b7*o-]$/.test(c)).length >= 2;
  diag.tabLineShare = nonBlank.length ? nonBlank.filter(multiCell).length / nonBlank.length : 0;
  if (diag.tabLineShare > 0.3) diag.layoutFlags.push('table_or_columns');

  // --- experience region
  const inRegion = new Array(items.length).fill(false);
  let usedFallbackRegion = false;
  if (hasExperienceHeading) {
    for (const it of items) inRegion[it.i] = secOf[it.i] === 'experience';
  }
  const anchorFilter = (it) => it.ranges.length > 0 && !it.heading && !(it.bullet && it.len > 100) && it.len <= 200;
  let anchorIdx = items.filter((it) => inRegion[it.i] && anchorFilter(it)).map((it) => it.i);
  if (anchorIdx.length === 0) {
    // no experience heading, or headed section without dates: use every dated line outside the non-experience sections
    usedFallbackRegion = true;
    for (const it of items) inRegion[it.i] = !NON_EXPERIENCE.has(secOf[it.i].replace(/^heading:/, '')) && !secOf[it.i].startsWith('heading:');
    anchorIdx = items.filter((it) => inRegion[it.i] && anchorFilter(it)).map((it) => it.i);
    if (!hasExperienceHeading) diag.layoutFlags.push('no_experience_heading');
    if (hasExperienceHeading && anchorIdx.length === 0) {
      // the experience section is there but holds no dates; education-heavy CVs may still date jobs elsewhere
      for (const it of items) inRegion[it.i] = secOf[it.i] === 'experience';
    }
  }
  diag.anchors = anchorIdx.length;

  // --- gap classification
  const cls = items.map((it) => classifyGapLine(it));
  const anchorSet = new Set(anchorIdx);
  const regionStart = items.findIndex((it, idx) => inRegion[idx]);
  let regionEnd = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) if (inRegion[i]) { regionEnd = i; break; }

  // Lines strictly between two positions that belong to the region (a heading or a non-region line ends the gap)
  function gapLines(fromExcl, toExcl) {
    const out = [];
    for (let i = fromExcl + 1; i < toExcl && i < items.length; i += 1) {
      if (i < 0) continue;
      if (!inRegion[i]) { if (out.length) break; continue; }
      out.push(i);
    }
    return out;
  }
  // run of H lines at the start of the gap (at most one blank/subheading may precede the first)
  function startRun(L, limit) {
    const out = [];
    let skipped = 0;
    for (const i of L) {
      const c = cls[i];
      if (c === 'S') continue;
      if (c === 'B') { if (out.length === 0 && skipped < 1) { skipped += 1; continue; } break; }
      if (c !== 'H' || out.length >= limit) break;
      out.push(i);
    }
    return out;
  }
  function endRun(L, limit) {
    const out = [];
    let skipped = 0;
    for (let x = L.length - 1; x >= 0; x -= 1) {
      const i = L[x];
      const c = cls[i];
      if (c === 'S') continue;
      if (c === 'B') { if (out.length === 0 && skipped < 1) { skipped += 1; continue; } break; }
      if (c !== 'H' || out.length >= limit) break;
      out.unshift(i);
    }
    return out;
  }

  // --- gaps: gaps[g] is the run of region lines BEFORE anchor g; gaps[n] is the run after the last anchor
  const nAnch = anchorIdx.length;
  const gaps = [];
  for (let k = 0; k <= nAnch; k += 1) {
    const from = k === 0 ? (regionStart >= 0 ? regionStart - 1 : -1) : anchorIdx[k - 1];
    const to = k === nAnch ? (regionEnd >= 0 ? regionEnd + 1 : items.length) : anchorIdx[k];
    gaps.push(gapLines(from, to));
  }
  const hasD = (L) => L.some((i) => cls[i] === 'D');

  // --- learn (nb, na): how many header lines sit before / after the date line, from anchors bounded by duty text
  const bVotes = {};
  const aVotes = {};
  let sameLineCount = 0;
  anchorIdx.forEach((a, k) => {
    if (!items[a].dateOnly) sameLineCount += 1;
    const before = gaps[k];
    const after = gaps[k + 1];
    if (hasD(before) || k === 0) { const n = endRun(before, 3).length; bVotes[n] = (bVotes[n] || 0) + 1; }
    if (hasD(after)) { const n = startRun(after, 3).length; aVotes[n] = (aVotes[n] || 0) + 1; }
  });
  const mode = (votes) => {
    let best = null;
    for (const [key, v] of Object.entries(votes)) if (best === null || v > best.v || (v === best.v && Number(key) > best.k)) best = { k: Number(key), v };
    return best ? best.k : null;
  };
  const patternKnown = Object.keys(bVotes).length > 0 || Object.keys(aVotes).length > 0;
  let nb = mode(bVotes);
  let na = mode(aVotes);
  if (nb === null) nb = 0;
  if (na === null) na = 0;
  diag.pattern = { nb, na, sameLine: sameLineCount, known: patternKnown };
  if (opts.debug) { diag.cls = cls.join(''); diag.sec = secOf.slice(); diag.inRegion = inRegion.map((x) => (x ? '1' : '0')).join(''); }

  // --- choose, for every gap, which lines are the trailing headers of the anchor above and the leading headers of the anchor below.
  // Dynamic programme over the anchors: each role scores its header block (title evidence, employer evidence, one title per
  // role, small prior towards the learned pattern); adjacent roles share the lines of an all-header gap.
  const lineEv = new Map();
  function evOf(text) {
    if (lineEv.has(text)) return lineEv.get(text);
    const parts = splitParts(stripBullet(text));
    let ts = 0;
    let es = 0;
    let cap = false;
    for (const p of parts) { ts = Math.max(ts, titleScore(p)); es = Math.max(es, employerScore(p)); if (/^[A-Z0-9\[]/.test(p) && titleScore(p) < TITLE_EVIDENCE) cap = true; }
    const ev = { ts, es, strong: strongTitleHit(text), cap, nParts: parts.length };
    lineEv.set(text, ev);
    return ev;
  }
  function roleScore(k, lLines, tLines) {
    const texts = [];
    for (const i of lLines) texts.push(items[i].t);
    if (items[anchorIdx[k]].residual) texts.push(items[anchorIdx[k]].residual);
    for (const i of tLines) texts.push(items[i].t);
    let bt = 0;
    let be = 0;
    let strongLines = 0;
    let cap = false;
    for (const t of texts) {
      const ev = evOf(t);
      bt = Math.max(bt, ev.ts);
      be = Math.max(be, ev.es);
      if (ev.strong) strongLines += 1;
      if (ev.cap || ev.nParts > 1) cap = true;
    }
    let s = (strongLines > 0 ? 3 : bt >= TITLE_EVIDENCE ? 1.5 : 0) + (be >= 1 ? 1.2 : (cap && texts.length > 1 ? 0.6 : 0)) + (texts.length > 0 ? 0.25 : 0);
    s -= 0.8 * Math.max(0, strongLines - 1);
    s -= 0.5 * Math.max(0, texts.length - 3);
    s -= 0.02 * (lLines.length + tLines.length);
    if (patternKnown) s -= 0.2 * (Math.abs(lLines.length - nb) + Math.abs(tLines.length - na));
    return s;
  }
  const options = gaps.map((L, g) => {
    const prevK = g - 1;
    const nextK = g < nAnch ? g : -1;
    const opts2 = [];
    if (hasD(L)) {
      const sr = prevK >= 0 ? startRun(L, 3) : [];
      const er = nextK >= 0 ? endRun(L, 3) : [];
      for (let t = 0; t <= sr.length; t += 1) {
        for (let l = 0; l <= er.length; l += 1) opts2.push({ t: sr.slice(0, t), l: er.slice(er.length - l), bonus: 0 });
      }
      return opts2;
    }
    const hs = L.filter((i) => cls[i] === 'H');
    if (prevK < 0 && nextK >= 0) {
      for (let l = 0; l <= Math.min(3, hs.length); l += 1) opts2.push({ t: [], l: hs.slice(hs.length - l), bonus: 0 });
    } else if (prevK >= 0 && nextK < 0) {
      for (let t = 0; t <= Math.min(3, hs.length); t += 1) opts2.push({ t: hs.slice(0, t), l: [], bonus: 0 });
    } else {
      const blankAt = L.findIndex((i, x) => cls[i] === 'B' && L.slice(0, x).some((j) => cls[j] === 'H') && L.slice(x + 1).some((j) => cls[j] === 'H'));
      const before = blankAt >= 0 ? L.slice(0, blankAt).filter((i) => cls[i] === 'H').length : -1;
      for (let s = Math.max(0, hs.length - 3); s <= Math.min(3, hs.length); s += 1) {
        opts2.push({ t: hs.slice(0, s), l: hs.slice(s), bonus: before === s ? 1.0 : 0 });
      }
      if (opts2.length === 0) opts2.push({ t: [], l: [], bonus: 0 });
    }
    if (opts2.length === 0) opts2.push({ t: [], l: [], bonus: 0 });
    return opts2;
  });
  const leadOf = anchorIdx.map(() => []);
  const trailOf = anchorIdx.map(() => []);
  const dutyOf = anchorIdx.map(() => []);
  if (nAnch > 0) {
    const dp = [options[0].map((o) => ({ score: o.bonus, back: -1 }))];
    for (let g = 0; g < nAnch; g += 1) {
      const cur = options[g];
      const nxt = options[g + 1];
      const row = nxt.map(() => ({ score: -Infinity, back: -1 }));
      for (let oi = 0; oi < cur.length; oi += 1) {
        for (let ni = 0; ni < nxt.length; ni += 1) {
          const sc = dp[g][oi].score + roleScore(g, cur[oi].l, nxt[ni].t) + nxt[ni].bonus;
          if (sc > row[ni].score) row[ni] = { score: sc, back: oi };
        }
      }
      dp.push(row);
    }
    let bestI = 0;
    dp[nAnch].forEach((c, i) => { if (c.score > dp[nAnch][bestI].score) bestI = i; });
    const pick = new Array(nAnch + 1);
    pick[nAnch] = bestI;
    for (let g = nAnch; g > 0; g -= 1) pick[g - 1] = dp[g][pick[g]].back;
    for (let g = 0; g <= nAnch; g += 1) {
      const o = options[g][pick[g]];
      const L = gaps[g];
      const taken = new Set([...o.t, ...o.l]);
      if (g < nAnch) leadOf[g] = o.l;
      if (g > 0) {
        trailOf[g - 1] = o.t;
        dutyOf[g - 1] = L.filter((i) => !taken.has(i) && (cls[i] === 'D' || cls[i] === 'H'));
      }
    }
  }

  // --- build roles
  const roles = [];
  for (let k = 0; k < anchorIdx.length && roles.length < MAX_ROLES; k += 1) {
    const a = anchorIdx[k];
    const it = items[a];
    const lead = leadOf[k];
    const trail = trailOf[k];
    const dutyItems = dutyOf[k].map((i) => items[i]);

    const headerTexts = [];
    for (const i of lead) headerTexts.push(items[i].t);
    if (it.residual) headerTexts.push(it.residual);
    for (const i of trail) headerTexts.push(items[i].t);

    let firstLine = a;
    let lastLine = a;
    for (const i of [...lead, ...trail, ...dutyOf[k]]) { firstLine = Math.min(firstLine, i); lastLine = Math.max(lastLine, i); }

    const fields = extractFields(headerTexts);
    const range = it.ranges[0];
    const educationLike = headerTexts.some((h) => EDU_WORDS_RE.test(h)) && !fields.titleStrong;
    if (educationLike) { diag.skippedEducationLike += 1; continue; }
    // outside an experience heading a dated line must show a title or an employer to count as a job
    if (usedFallbackRegion && !fields.title && !fields.employer) { diag.skippedNotRole += 1; continue; }
    const st = range.start;
    const en = range.end;
    const rm = rangeMonths(range, asOf);
    const flags = [...range.flags];
    if (usedFallbackRegion) flags.push('no_experience_heading');
    if (rm.approx) flags.push('months_approx');
    let precision = 'month';
    if (range.flags.includes('year_only')) precision = 'year';
    else if (range.flags.includes('season')) precision = 'season';
    if (fields.titleFlag) flags.push(fields.titleFlag);
    if (fields.titleLong) flags.push('title_long');
    if (fields.titleProse) flags.push('title_prose');
    if (fields.employerProse) flags.push('employer_prose');
    if (!fields.title) flags.push('no_title');
    const noHeader = !lead.length && !trail.length && !it.residual;
    if (noHeader) flags.push('no_header_lines');

    let confidence = 'high';
    const lower = (c) => { if (confidence === 'high') confidence = c; else if (confidence === 'medium' && c === 'low') confidence = 'low'; };
    if (!fields.title) lower('low');
    else if (fields.titleFlag === 'title_unverified') lower('low');
    else if (fields.titleProse) lower('low');
    else if (!fields.titleStrong || fields.titleLong) lower('medium');
    if (fields.employerProse) lower('low');
    if (precision !== 'month') lower('medium');
    if (range.flags.includes('open_end') || range.flags.includes('reversed') || range.flags.includes('future') || range.flags.includes('two_digit_year')) lower('low');
    if (range.flags.includes('year_inferred')) lower('medium');
    if (diag.tabLineShare > 0.3) lower('medium');
    if (noHeader) lower('low');
    if (usedFallbackRegion) lower('medium');
    if (!fields.employer) lower('medium');

    let months = rm.months;
    if (months !== null && months > 600) { flags.push('implausible_duration'); months = null; lower('low'); }

    roles.push({
      title: fields.title,
      employer: fields.employer,
      start: fmtYm(st),
      end: en === 'present' ? 'present' : (en === null ? null : fmtYm(en)),
      months,
      duties: joinDuties(dutyItems),
      evidence: [firstLine + 1, lastLine + 1],
      confidence,
      flags,
      datePrecision: precision,
      _dbg: opts.debug ? { headers: headerTexts, lead: lead.length, trail: trail.length, anchorLine: a + 1, residual: it.residual, sec: secOf[a] } : undefined,
      _ym: en === null || range.flags.includes('reversed') ? null : [ymIdx(st), en === 'present' ? ymIdx(asOfYm(asOf)) : ymIdx(en)],
    });
  }
  diag.rolesBuilt = roles.length;

  // date-only runs: consecutive anchors with no header lines at all (column-separated tables)
  let run = 0;
  for (const r of roles) {
    if (r.flags.includes('no_header_lines')) { run += 1; if (run === 2) diag.dateOnlyRuns += 1; } else run = 0;
  }
  if (diag.dateOnlyRuns > 0) diag.layoutFlags.push('date_column_run');

  // --- undated fallback: only when nothing dated was found
  if (roles.length === 0 && hasExperienceHeading) {
    const start = items.findIndex((it) => secOf[it.i] === 'experience');
    const und = [];
    for (let i = start; i >= 0 && i < items.length && und.length < 12; i += 1) {
      if (secOf[i] !== 'experience') continue;
      const it = items[i];
      if (cls[i] !== 'H') continue;
      if (!strongTitleHit(it.t) || it.len > 70) continue;
      const fields = extractFields([it.t]);
      if (!fields.title) continue;
      const dutyItems = [];
      let j = i + 1;
      let last = i;
      while (j < items.length && secOf[j] === 'experience' && dutyItems.length < 8) {
        if (cls[j] === 'H' && strongTitleHit(items[j].t) && items[j].len <= 70) break;
        if (cls[j] === 'D') { dutyItems.push(items[j]); last = j; }
        j += 1;
      }
      und.push({
        title: fields.title, employer: fields.employer, start: null, end: null, months: null, duties: joinDuties(dutyItems),
        evidence: [i + 1, last + 1], confidence: 'low', flags: ['undated'], datePrecision: null, _ym: null,
      });
    }
    for (const r of und) roles.push(r);
    if (und.length) diag.layoutFlags.push('undated_fallback');
  }

  // --- document level
  const dated = roles.filter((r) => r.start);
  const anchorIntervals = [];
  for (const a of anchorIdx) {
    const r0 = items[a].ranges[0];
    if (r0.end === null || r0.flags.includes('reversed')) continue;
    const s = ymIdx(r0.start);
    const e = r0.end === 'present' ? ymIdx(asOfYm(asOf)) : ymIdx(r0.end);
    anchorIntervals.push([s, e]);
  }
  diag.anchorMonths = unionMonths(anchorIntervals);
  diag.roleMonths = unionMonths(roles.map((r) => r._ym));
  const spans = roles.map((r) => r._ym).filter(Boolean);
  diag.spanMonths = spans.length ? Math.max(...spans.map((x) => x[1])) - Math.min(...spans.map((x) => x[0])) + 1 : 0;
  diag.titledRoleMonths = unionMonths(roles.filter((r) => r.title && r.confidence !== 'low').map((r) => r._ym));

  let parseConfidence = 'low';
  const hi = roles.filter((r) => r.confidence === 'high').length;
  const ok = roles.filter((r) => r.confidence !== 'low').length;
  if (dated.length > 0 && hi >= 1 && ok >= Math.ceil(dated.length * 0.6) && !diag.layoutFlags.includes('date_column_run')) parseConfidence = 'high';
  else if (ok >= 1) parseConfidence = 'medium';
  if (roles.length === 0) parseConfidence = 'low';

  for (const r of roles) { delete r._ym; if (r._dbg === undefined) delete r._dbg; }
  return { roles, qualifications: kw.qualifications, skills: kw.skills, parseConfidence, diagnostics: diag };
}

// How good a parse looks: confident, titled, dated roles count; date columns that lost their titles cost points.
function scoreParse(p) {
  let s = 0;
  for (const r of p.roles) {
    s += r.confidence === 'high' ? 3 : r.confidence === 'medium' ? 2 : 0.6;
    if (r.title) s += 0.5;
    if (r.employer) s += 0.3;
    if (r.flags.includes('no_header_lines')) s -= 1;
    if (r.flags.includes('undated')) s -= 1.5;
  }
  if (p.diagnostics.layoutFlags.includes('date_column_run')) s -= 3;
  return s;
}

// Parses each text variant of the same CV (row order / column order of a two-column PDF) and keeps the best one.
// variants: [{ name, text }] with the preferred (row order) first: it wins ties.
function parseBest(variants, opts = {}) {
  let best = null;
  for (const v of variants) {
    if (!v || typeof v.text !== 'string') continue;
    const parsed = parseCv(v.text, opts);
    const score = scoreParse(parsed);
    if (best === null || score > best.score + 0.5) best = { variant: v.name, parsed, score, text: v.text };
  }
  return best;
}

module.exports = { parseCv, parseBest, scoreParse, extractFields, titleScore, employerScore, splitParts, mergeSplitDates, MAX_ROLES, DUTIES_MAX };
