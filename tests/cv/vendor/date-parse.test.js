// Ported from cv-corpus/tests/date-parse.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateRanges, rangeMonths, fmtYm } = require('../../../resourcer/scripts/lib/cv/vendor/date-parse');

const ASOF = '2026-09';
const one = (line) => {
  const r = parseDateRanges(line, { asOf: ASOF });
  assert.equal(r.length, 1, `expected exactly one range in ${JSON.stringify(line)}, got ${r.length}`);
  return r[0];
};
const ym = (x) => (x === 'present' ? 'present' : x === null ? null : fmtYm(x));

test('month + year ranges with every separator and month spelling', () => {
  const cases = [
    ['Jan 2019 - Mar 2021', '2019-01', '2021-03'],
    ['January 2019 to March 2021', '2019-01', '2021-03'],
    ['Sept 2018 until Oct. 2019', '2018-09', '2019-10'],
    ['Sep 2018 \u2013 Dec 2018', '2018-09', '2018-12'],
    ['Feb, 2017 - Nov, 2017', '2017-02', '2017-11'],
    ['12 March 2019 - 3rd April 2020', '2019-03', '2020-04'],
    ['(Jun 2015 through Aug 2016)', '2015-06', '2016-08'],
    ['May 2010 - May 2011', '2010-05', '2011-05'],
  ];
  for (const [line, s, e] of cases) {
    const r = one(line.replace('\u2013', '-'));
    assert.equal(ym(r.start), s, line);
    assert.equal(ym(r.end), e, line);
    assert.deepEqual(r.flags, [], line);
  }
});

test('numeric ranges: MM/YYYY, MM-YYYY, MM.YYYY, DD/MM/YYYY (month is the second number)', () => {
  assert.deepEqual([ym(one('03/2019 - 11/2020').start), ym(one('03/2019 - 11/2020').end)], ['2019-03', '2020-11']);
  assert.deepEqual([ym(one('3-2019 to 4-2020').start), ym(one('3-2019 to 4-2020').end)], ['2019-03', '2020-04']);
  assert.deepEqual([ym(one('03.2019 - 11.2020').start), ym(one('03.2019 - 11.2020').end)], ['2019-03', '2020-11']);
  const dmy = one('14/05/2018 - 30/06/2019');
  assert.deepEqual([ym(dmy.start), ym(dmy.end)], ['2018-05', '2019-06']);
  const spaced = one('03 / 2019 - 04 / 2020');
  assert.deepEqual([ym(spaced.start), ym(spaced.end)], ['2019-03', '2020-04']);
});

test('year only: the month is NOT known, so the range is flagged year_only and months use the year difference', () => {
  const r = one('2015 - 2018');
  assert.deepEqual(r.flags, ['year_only']);
  assert.equal(r.start.precision, 'year');
  assert.equal(r.end.precision, 'year');
  assert.deepEqual([ym(r.start), ym(r.end)], ['2015-01', '2018-12']);
  const m = rangeMonths(r, ASOF);
  assert.deepEqual(m, { months: 36, approx: true });
  // a single year is at least half a year, never zero
  assert.equal(rangeMonths(one('2019 to 2019'), ASOF).months, 6);
  const mixed = one('Mar 2017 - 2019');
  assert.ok(mixed.flags.includes('year_only'));
  assert.equal(ym(mixed.start), '2017-03');
  const twoDigit = one('2015-18');
  assert.deepEqual([ym(twoDigit.start), ym(twoDigit.end)], ['2015-01', '2018-12']);
  assert.ok(twoDigit.flags.includes('two_digit_year'));
});

test('present / current / to date / ongoing / since / from ... onwards', () => {
  for (const line of ['Jan 2019 - Present', 'Jan 2019 to date', 'Jan 2019 - current', 'Jan 2019 (current)', 'Jan 2019 - Now', 'Jan 2019 - ongoing', 'Jan 2019 until present', 'Jan 2019 - till date', '01/2019 - present', 'Jan 2019 onwards']) {
    const r = one(line);
    assert.equal(ym(r.start), '2019-01', line);
    assert.equal(r.end, 'present', line);
  }
  const since = one('Since March 2020');
  assert.equal(ym(since.start), '2020-03');
  assert.equal(since.end, 'present');
  assert.ok(since.flags.includes('single_date_since'));
  assert.equal(one('From 2018').end, 'present');
  assert.equal(rangeMonths(one('Jan 2026 - present'), ASOF).months, 9);
  assert.equal(rangeMonths(one('Sep 2026 - present'), ASOF).months, 1);
});

test('seasons keep their first / last month and are flagged', () => {
  const r = one('Summer 2019 - Autumn 2019');
  assert.deepEqual([ym(r.start), ym(r.end)], ['2019-06', '2019-11']);
  assert.ok(r.flags.includes('season'));
  const w = one('Winter 2018 - Spring 2019');
  assert.equal(ym(w.start), '2018-12');
  assert.equal(ym(w.end), '2019-05');
  const winterEnd = one('Autumn 2018 - Winter 2018');
  assert.equal(ym(winterEnd.end), '2019-02', 'winter wraps into February of the next year');
});

test('a start month without a year borrows the year of the end (flagged) and wraps over a year end', () => {
  const r = one('Mar - Jun 2019');
  assert.deepEqual([ym(r.start), ym(r.end)], ['2019-03', '2019-06']);
  assert.ok(r.flags.includes('year_inferred'));
  const w = one('Nov - Feb 2019');
  assert.equal(ym(w.start), '2018-11');
  assert.equal(ym(w.end), '2019-02');
});

test('an open ending ("Jan 2019 -") is not filled in; reversed and future ranges are flagged', () => {
  const open = one('Jan 2019 -');
  assert.equal(open.end, null);
  assert.ok(open.flags.includes('open_end'));
  assert.deepEqual(rangeMonths(open, ASOF), { months: null, approx: false });
  const rev = one('Mar 2021 - Jan 2019');
  assert.ok(rev.flags.includes('reversed'));
  assert.equal(rangeMonths(rev, ASOF).months, null);
  const fut = one('Jan 2030 - Mar 2031');
  assert.ok(fut.flags.includes('future'));
});

test('two-digit years only with an apostrophe form, flagged', () => {
  const r = one("Jan '19 - Mar '21");
  assert.deepEqual([ym(r.start), ym(r.end)], ['2019-01', '2021-03']);
  assert.ok(r.flags.includes('two_digit_year'));
});

test('inclusive month counting', () => {
  assert.equal(rangeMonths(one('Jan 2019 - Mar 2019'), ASOF).months, 3);
  assert.equal(rangeMonths(one('Sep 2018 - Sep 2018'), ASOF).months, 1);
  assert.equal(rangeMonths(one('Jan 2019 - Jan 2020'), ASOF).months, 13);
});

test('things that are NOT ranges: a lone date, phone-like numbers, salaries, prose', () => {
  for (const line of ['Food Hygiene Level 2 (2019)', 'Born 1985', 'Total 07700 900123', '\u00a325000-30000 per year', 'The date of the event', 'Level 3 NVQ 2018', 'Ran 120 covers', 'Jan 2019', '2019', 'Chef since', 'May include lifting']) {
    assert.deepEqual(parseDateRanges(line, { asOf: ASOF }), [], line);
  }
});

test('several ranges on a line are all found, left to right', () => {
  const rs = parseDateRanges('Chef Jan 2019 - Mar 2020, Cook 2015 - 2018', { asOf: ASOF });
  assert.equal(rs.length, 2);
  assert.ok(rs[0].index < rs[1].index);
});

test('pathological input is linear and does not throw', () => {
  const t0 = Date.now();
  parseDateRanges('1'.repeat(100000), { asOf: ASOF });
  parseDateRanges('Jan '.repeat(20000), { asOf: ASOF });
  parseDateRanges('2019 - '.repeat(20000), { asOf: ASOF });
  assert.ok(Date.now() - t0 < 5000);
});

test('month-year written without spaces: Jan-2019, Mar/2019, Jan.2019 (never mistaken for a bare year)', () => {
  const a = one('Nov-2016 - present');
  assert.deepEqual([ym(a.start), a.end, a.flags], ['2016-11', 'present', []]);
  const b = one('Mar/2019 - Jun/2020');
  assert.deepEqual([ym(b.start), ym(b.end), b.flags], ['2019-03', '2020-06', []]);
  const c = one('Jan.2019 - Mar.2021');
  assert.deepEqual([ym(c.start), ym(c.end)], ['2019-01', '2021-03']);
  const d = one('Mar-2019 to Jun-2020');
  assert.deepEqual([d.start.precision, d.end.precision], ['month', 'month']);
});

test('dd.mm.yy is accepted only inside a two-date range and flagged; a lone one is not a date', () => {
  const r = one('01.06.19 - 30.09.19');
  assert.deepEqual([ym(r.start), ym(r.end)], ['2019-06', '2019-09']);
  assert.ok(r.flags.includes('two_digit_year'));
  assert.deepEqual(parseDateRanges('born 12.03.85', { asOf: ASOF }), []);
  assert.deepEqual(parseDateRanges('01.06.19', { asOf: ASOF }), []);
});

test('start and end in separate table cells (whitespace only between two full dates) form a flagged range', () => {
  const r = one('01/06/2019\t30/09/2019\tline cook');
  assert.deepEqual([ym(r.start), ym(r.end)], ['2019-06', '2019-09']);
  assert.ok(r.flags.includes('implicit_range'));
  assert.deepEqual(parseDateRanges('Jan 2019 Mar 2021', { asOf: ASOF }), [], 'a single space is not enough');
  assert.deepEqual(parseDateRanges('Mar 2021\tJan 2019', { asOf: ASOF }), [], 'end before start is not implied');
});
