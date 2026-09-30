// Vendored from cv-corpus/lib/date-parse.js (source sha256 5c648a9ce31f) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// Date-range recognition for CV lines. Deterministic, no guessing.
//
// parseDateRanges(line, { asOf }) -> [{ start:{y,m,precision,...}, end:{y,m,precision}|'present'|null, flags:[..], index, length, text }]
//
//   precision: 'month' (month and year written), 'year' (only the year was written: month is NOT known),
//              'season' (Summer 2019 etc: the season's first/last month is used and flagged)
//   flags:     'year_only', 'season', 'year_inferred' (Mar - Jun 2019: the shared year is taken from the range end),
//              'two_digit_year', 'open_end' (a dash with nothing after it), 'reversed', 'future', 'single_date_since'
//
// A single date on its own (no range word, no "since/from") is NOT a range and is never returned.
// Nothing is invented: an end that is not written is not filled in, except the explicit words present/current/now/to date.

const { MONTHS, MONTH_RE_SRC, SEASONS, SEASON_RE_SRC, PRESENT_RE_SRC } = require('./cv-lexicon');

const Y4 = '(?:19[5-9]\u005cd|20[0-3]\u005cd)';
const SEP_SRC = '(?:-|to|until|till|through|thru|and|\u005c/|\u005c|)';
const PRESENT_RE = new RegExp('^\u005cs*(?:\u005c(|\u005c[)?\u005cs*' + PRESENT_RE_SRC + '\u005cb', 'i');

// one date token; alternatives ordered from most to least specific
const TOKEN_RES = [
  ['season', new RegExp('\u005cb(' + SEASON_RE_SRC + ')\u005cs+(?:of\u005cs+)?(' + Y4 + ')\u005cb', 'i')],
  // "Jan 2019", "January, 2019", "12 March 2019", also "Jan-2019" / "Jan/2019" / "Jan.2019" written without spaces
  ['dmy_month', new RegExp('\u005cb(?:\u005cd{1,2}(?:st|nd|rd|th)?\u005cs+)?(?:of\u005cs+)?(' + MONTH_RE_SRC + ')\u005c.?(?:[,\u005cs\u005c/\u005c-]{1,3}|\u005c.)(?:of\u005cs+)?(' + Y4 + ')\u005cb', 'i')],
  ['month_apos', new RegExp('\u005cb(' + MONTH_RE_SRC + ')\u005c.?\u005cs*[\'\u005cu2019`]\u005cs*(\u005cd\u005cd)\u005cb', 'i')],
  ['numeric_dmy', new RegExp('(?<![\u005cd/.-])(\u005cd{1,2})[/.-](0?[1-9]|1[0-2])[/.-](' + Y4 + ')(?![\u005cd])')],
  // dd.mm.yy (two-digit year): only accepted inside a range, flagged two_digit_year (see parseDateRanges)
  ['numeric_dmy2', new RegExp('(?<![\u005cd/.-])(0?[1-9]|[12]\u005cd|3[01])[/.-](0?[1-9]|1[0-2])[/.-](\u005cd\u005cd)(?![\u005cd])')],
  ['numeric_my', new RegExp('(?<![\u005cd/.-])(0?[1-9]|1[0-2])\u005cs*[/.-]\u005cs*(' + Y4 + ')(?![\u005cd])')],
  ['month_only', new RegExp('\u005cb(' + MONTH_RE_SRC + ')\u005cb\u005c.?(?!\u005cs*[\'\u005cu2019`]?\u005cs*\u005cd)', 'i')],
  ['year', new RegExp('(?<![\u005cd/.\u005cu00a3$])(' + Y4 + ')(?![\u005cd])')],
];

function monthNum(word) {
  const k = String(word).toLowerCase().replace(/\.$/, '');
  return MONTHS[k] || MONTHS[k.slice(0, 3)] || null;
}

// Collect every date token in a line with its span. Overlapping matches are resolved in favour of the earlier alternative.
function findTokens(line) {
  const found = [];
  const mask = new Uint8Array(line.length + 1);
  const overlaps = (a, b) => { for (let i = a; i < b; i += 1) if (mask[i]) return true; return false; };
  for (const [kind, re] of TOKEN_RES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(line)) !== null) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (m[0].length === 0) { g.lastIndex += 1; continue; }
      if (overlaps(s, e)) continue;
      let tok = null;
      if (kind === 'season') {
        const sea = SEASONS[m[1].toLowerCase()];
        tok = { kind, y: parseInt(m[2], 10), m: sea[0], mEnd: sea[1], season: m[1].toLowerCase(), precision: 'season' };
      } else if (kind === 'dmy_month') {
        tok = { kind, y: parseInt(m[2], 10), m: monthNum(m[1]), precision: 'month' };
      } else if (kind === 'month_apos') {
        const yy = parseInt(m[2], 10);
        tok = { kind, y: yy <= 30 ? 2000 + yy : 1900 + yy, m: monthNum(m[1]), precision: 'month', twoDigit: true };
      } else if (kind === 'numeric_dmy2') {
        const yy = parseInt(m[3], 10);
        tok = { kind, y: yy <= 30 ? 2000 + yy : 1900 + yy, m: parseInt(m[2], 10), precision: 'month', twoDigit: true, needsPartner: true };
      } else if (kind === 'numeric_dmy') {
        tok = { kind, y: parseInt(m[3], 10), m: parseInt(m[2], 10), precision: 'month' };
      } else if (kind === 'numeric_my') {
        tok = { kind, y: parseInt(m[2], 10), m: parseInt(m[1], 10), precision: 'month' };
      } else if (kind === 'month_only') {
        tok = { kind, y: null, m: monthNum(m[1]), precision: 'month_noyear' };
      } else if (kind === 'year') {
        tok = { kind, y: parseInt(m[1], 10), m: null, precision: 'year' };
      }
      if (!tok || (tok.m !== null && (tok.m < 1 || tok.m > 12))) continue;
      tok.s = s;
      tok.e = e;
      found.push(tok);
      for (let i = s; i < e; i += 1) mask[i] = 1;
    }
  }
  return found.sort((a, b) => a.s - b.s);
}

const SEP_ONLY_RE = new RegExp('^\u005cs*' + SEP_SRC + '\u005cs*$', 'i');
const SINCE_RE = /(?:^|[\s(,;:|])(since|from|starting|started|joined|commenced|beginning)\s*$/i;
// "- present", "to date", "(current)", or a bare strong word such as "present" / "ongoing"
const PRESENT_STRICT_SRC = '(?:present|ongoing|on-going|to\u005cs+date|todate|till\u005cs+date|onwards?|currently|current)';
const PRESENT_TAILS = [
  new RegExp('^\u005cs*(?:-|to|until|till|through|thru|\u005c/)\u005cs*(?:\u005c(|\u005c[)?\u005cs*(' + PRESENT_RE_SRC + ')\u005cb', 'i'),
  new RegExp('^\u005cs*(?:\u005c(|\u005c[)\u005cs*(' + PRESENT_RE_SRC + ')\u005cb', 'i'),
  new RegExp('^\u005cs*(' + PRESENT_STRICT_SRC + ')\u005cb', 'i'),
];
function presentTail(tail) {
  for (const re of PRESENT_TAILS) { const m = re.exec(tail); if (m) return m; }
  return null;
}

function ymOf(tok, edge) {
  // edge: 'start' or 'end' (seasons and year-only tokens use the first or last month of what was written)
  if (tok.precision === 'year') return { y: tok.y, m: edge === 'start' ? 1 : 12, precision: 'year' };
  if (tok.precision === 'season') {
    if (edge === 'start') return { y: tok.y, m: tok.m, precision: 'season' };
    // winter wraps: Dec of this year .. Feb of next
    const wrap = tok.season === 'winter';
    return { y: wrap ? tok.y + 1 : tok.y, m: tok.mEnd, precision: 'season' };
  }
  return { y: tok.y, m: tok.m, precision: 'month' };
}

function ymIndex(ym) { return ym.y * 12 + (ym.m - 1); }

function asOfYm(asOf) {
  if (typeof asOf === 'string' && /^\d{4}-\d{2}$/.test(asOf)) return { y: parseInt(asOf.slice(0, 4), 10), m: parseInt(asOf.slice(5), 10) };
  const d = new Date();
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

const fmtYm = (ym) => `${String(ym.y).padStart(4, '0')}-${String(ym.m).padStart(2, '0')}`;

// Returns ranges found in one line (left to right, non-overlapping).
function parseDateRanges(line, opts = {}) {
  const now = asOfYm(opts.asOf);
  const toks = findTokens(String(line));
  const out = [];
  const used = new Set();
  const flagsFor = (a, b) => {
    const f = [];
    if (a.precision === 'year' || (b && b !== 'present' && b.precision === 'year')) f.push('year_only');
    if (a.precision === 'season' || (b && b !== 'present' && b.precision === 'season')) f.push('season');
    if (a.twoDigit || (b && b !== 'present' && b.twoDigit)) f.push('two_digit_year');
    return f;
  };
  for (let i = 0; i < toks.length; i += 1) {
    if (used.has(i)) continue;
    const a = toks[i];
    const before = line.slice(Math.max(0, a.s - 24), a.s);
    const sinceLead = SINCE_RE.test(before);
    const next = toks[i + 1];

    // (1) a range with an end token
    if (next && !used.has(i + 1)) {
      const gap = line.slice(a.e, next.s);
      // start and end in separate table cells: two complete dates with only whitespace (a tab or 2+ spaces) between them
      const implicit = /^[ \t]+$/.test(gap) && (gap.includes('\t') || gap.length >= 2) && a.precision === 'month' && next.precision === 'month' && !SINCE_RE.test(line.slice(Math.max(0, a.s - 24), a.s)) &&
        (next.y * 12 + next.m) >= (a.y * 12 + a.m);
      if (SEP_ONLY_RE.test(gap.replace(/[()\[\]]/g, ' ')) || implicit) {
        let s = a;
        let e = next;
        const flags = implicit ? ['implicit_range'] : [];
        // "Mar - Jun 2019": the start carries no year, take it from the end
        if (s.precision === 'month_noyear') {
          if (e.y === null || e.precision === 'month_noyear') { i += 0; continue; }
          const sy = s.m > (e.m || 12) ? e.y - 1 : e.y;
          s = Object.assign({}, s, { y: sy, precision: 'month' });
          flags.push('year_inferred');
        }
        if (e.precision === 'month_noyear') continue;      // "Jan 2019 - Mar" (no year on the end): not a usable range
        // "2015-18": end year written with two digits right after the separator
        const sy = ymOf(s, 'start');
        const ey = ymOf(e, 'end');
        const range = { start: sy, end: ey, flags: flags.concat(flagsFor(s, e)) };
        range.index = a.s;
        range.length = next.e - a.s;
        range.text = line.slice(a.s, next.e);
        if (ymIndex(ey) < ymIndex(sy)) range.flags.push('reversed');
        if (ymIndex(ey) > ymIndex(now) + 1) range.flags.push('future');
        out.push(range);
        used.add(i); used.add(i + 1);
        continue;
      }
    }
    if (a.precision === 'month_noyear') continue;
    if (a.needsPartner) continue;      // dd.mm.yy only counts inside a two-date range

    // (2) start ... present
    const tail = line.slice(a.e);
    const pm = presentTail(tail);
    if (pm) {
      const sy = ymOf(a, 'start');
      const range = { start: sy, end: 'present', flags: flagsFor(a, null) };
      range.index = a.s;
      range.length = a.e - a.s + pm[0].length;
      range.text = line.slice(a.s, a.s + range.length);
      if (ymIndex(sy) > ymIndex(now) + 1) range.flags.push('future');
      out.push(range);
      used.add(i);
      continue;
    }
    // (3) "since Mar 2019" / "from Mar 2019" / "Mar 2019 onwards"
    if (sinceLead && (a.precision === 'month' || a.precision === 'season' || a.precision === 'year')) {
      const sy = ymOf(a, 'start');
      const range = { start: sy, end: 'present', flags: flagsFor(a, null).concat(['single_date_since']) };
      range.index = a.s;
      range.length = a.e - a.s;
      range.text = line.slice(a.s, a.e);
      out.push(range);
      used.add(i);
      continue;
    }
    // (4) "Jan 2019 -" (dash, nothing after): the end is not written
    if (/^\s*(?:-|to|until|till|through|thru|\u2013)\s*$/i.test(tail) && (a.precision === 'month' || a.precision === 'season')) {
      const sy = ymOf(a, 'start');
      const range = { start: sy, end: null, flags: flagsFor(a, null).concat(['open_end']) };
      range.index = a.s;
      range.length = line.length - a.s;
      range.text = line.slice(a.s);
      out.push(range);
      used.add(i);
    }
  }
  // two-digit end year right after a four-digit year: "2015-18"
  // (not when a month name or an ordinal follows: "1 Jan 2025 to 31 Dec" ends on a day, not in a year)
  const twoDigit = new RegExp('(?<![\u005cd/.-])(' + Y4 + ')\u005cs*(?:-|\u005cu2013|to)\u005cs*(\u005cd\u005cd)(?![\u005cd])(?!\u005cs*(?:st|nd|rd|th)?\u005cs*(?:' + MONTH_RE_SRC + ')\u005cb)(?!\u005cs*(?:st|nd|rd|th)\u005cb)', 'gi');
  const covered = new Uint8Array(line.length + 1);
  for (const r of out) for (let i = r.index; i < r.index + r.length && i < covered.length; i += 1) covered[i] = 1;
  let m;
  while ((m = twoDigit.exec(line)) !== null) {
    const startIdx = m.index;
    if (covered[startIdx]) continue;
    const sy = parseInt(m[1], 10);
    let ey = Math.floor(sy / 100) * 100 + parseInt(m[2], 10);
    if (ey < sy) ey += 100;
    const range = { start: { y: sy, m: 1, precision: 'year' }, end: { y: ey, m: 12, precision: 'year' }, flags: ['year_only', 'two_digit_year'] };
    range.index = startIdx;
    range.length = m[0].length;
    range.text = m[0];
    if (ey - sy > 40) continue;
    out.push(range);
  }
  return out.sort((x, y) => x.index - y.index);
}

// Elapsed months, counted inclusively (Jan-Mar = 3). Year-only ranges use the year difference (see role-parser notes).
function rangeMonths(range, asOf) {
  if (!range || !range.start || range.end === null) return { months: null, approx: false };
  const now = asOfYm(asOf);
  const s = range.start;
  const yearOnly = range.flags.includes('year_only');
  let e = range.end === 'present' ? { y: now.y, m: now.m, precision: 'month' } : range.end;
  if (range.flags.includes('reversed')) return { months: null, approx: false };
  if (yearOnly) {
    // both ends written as bare years, or one bare year and one month: use the difference of the written values
    const sIdx = s.precision === 'year' ? s.y * 12 + 6 : ymIndex(s);
    const eIdx = e.precision === 'year' ? e.y * 12 + 6 : ymIndex(e);
    const diff = eIdx - sIdx;
    return { months: diff > 0 ? diff : 6, approx: true };
  }
  const months = ymIndex(e) - ymIndex(s) + 1;
  return { months: months > 0 ? months : null, approx: range.flags.includes('season') };
}

module.exports = { parseDateRanges, rangeMonths, findTokens, fmtYm, ymIndex, asOfYm, monthNum };
