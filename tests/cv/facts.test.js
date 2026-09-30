'use strict';
// Facts worked out by code: months, overlaps, dates that cannot be trusted, the 10-roles / 15-years rule, text cleaning.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-facts');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../resourcer/scripts/lib/cv/config');
const facts = require('../../resourcer/scripts/lib/cv/facts');
const { NOW, role, record } = require('./helpers/fixtures');

test.after(() => home.cleanup());
const cfg = config.load({ file: 'no-such-file.json' });
const build = (roles, extra) => facts.buildFacts(record(roles, extra), cfg, NOW);

test('months are inclusive, a present role runs to the current month, and overlapping roles count once', () => {
  const f = build([role('A', '2020-01', '2020-12'), role('B', '2020-06', '2021-05'), role('C', '2025-10', 'present')]);
  assert.equal(f.totalMonths, 17 + 12);
  const solo = build([role('A', '2026-09', 'present')]);
  assert.equal(solo.totalMonths, 1);
  assert.equal(solo.roles[0].endedAgo, 0);
  assert.equal(solo.roles[0].present, true);
});

test('months in the last five years are clipped to the window', () => {
  const f = build([role('A', '2019-01', 'present')]);
  assert.equal(f.monthsRecent, 60);
  assert.equal(f.recentYears, 5);
  assert.equal(build([role('A', '2010-01', '2011-01')]).monthsRecent, 0);
});

test('the months field of the parser is ignored: only the dates count (a lying months value changes nothing)', () => {
  const f = build([role('A', '2026-07', 'present', { months: 300 })]);
  assert.equal(f.totalMonths, 3);
});

test('dates that cannot be trusted give a role without months, and it is kept', () => {
  const reversed = build([role('A', '2024-03', '2023-01')]);
  assert.equal(reversed.roles[0].dated, false);
  assert.equal(reversed.totalMonths, 0);
  assert.equal(reversed.undatedRoles, 1);
  const epoch = build([role('A', '1970-01', '2020-05'), role('B', '2020-06', 'present')]);
  assert.equal(epoch.roles.find(r => r.title === 'A').dated, false);
  assert.equal(epoch.totalMonths, 76);
  assert.equal(build([role('A', null, null)]).undatedRoles, 1);
  assert.equal(build([role('A', '2020-13', '2021-01')]).undatedRoles, 1);
  assert.equal(build([role('A', '2020-01', null)]).undatedRoles, 1);
});

test('a role that starts in the future is dropped, an end date in the future is cut back to now', () => {
  const f = build([role('Future', '2027-01', '2031-01'), role('Typo', '2022-06', '2027-05')]);
  assert.equal(f.omitted.future, 1);
  assert.equal(f.roles.length, 1);
  assert.equal(f.roles[0].endedAgo, 0);
  assert.equal(f.totalMonths, 52);
});

test('exact duplicates are dropped', () => {
  const f = build([role('A', '2020-01', '2021-01'), role('A', '2020-01', '2021-01'), role('A', '2020-01', '2021-01')]);
  assert.equal(f.roles.length, 1);
  assert.equal(f.omitted.duplicates, 2);
});

test('most recent first, at most maxRoles roles, and roles that ended more than fifteen years ago are left out', () => {
  const roles = [];
  for (let i = 0; i < 14; i++) roles.push(role(`R${i}`, `${2011 + i}-01`, `${2011 + i}-06`));
  roles.push(role('Ancient', '1999-01', '2001-01'));
  const ten = config.load({ file: 'no-such-file.json', overrides: { input: { maxRoles: 10 } } });
  const f = facts.buildFacts(record(roles), ten, NOW);
  assert.equal(f.roles.length, 10);
  assert.equal(f.roles[0].title, 'R13');
  assert.equal(f.rolesParsed, 15);
  assert.equal(f.omitted.old, 2);
  assert.equal(f.omitted.capped, 3);
  assert.ok(f.roles.every(r => r.endIdx >= f.nowIdx - 15 * 12));
  assert.equal(f.oldOnly, false);
  // roles listed oldest first come out in the same order
  const reversed = facts.buildFacts(record(roles.slice().reverse()), ten, NOW);
  assert.deepEqual(reversed.roles.map(r => r.title), f.roles.map(r => r.title));
});

test('a history that ended entirely before the horizon is still judged: its newest roles are sent', () => {
  const f = build([role('Old A', '2001-01', '2004-01'), role('Old B', '1998-01', '2000-12')]);
  assert.equal(f.oldOnly, true);
  assert.equal(f.roles.length, 2);
  assert.equal(f.roles[0].title, 'Old A');
  assert.equal(f.omitted.old, 0);
});

test('undated roles come after dated ones and count against the cap', () => {
  const f = build([role('Undated', null, null), role('Dated', '2020-01', '2021-01')]);
  assert.deepEqual(f.roles.map(r => r.title), ['Dated', 'Undated']);
});

test('the role line format is title | employer | start - end | duties, capped at 200 characters of duties', () => {
  const long = 'x '.repeat(400);
  const f = build([role('Sous Chef', '2020-01', 'present', { employer: 'Grand Hotel', duties: [long] }), role('Cook', '2015-03', '2019-12', { duties: 'grill, sauces' })]);
  const lines = f.roles.map(facts.roleLine);
  assert.match(lines[0], /^Sous Chef \| Grand Hotel \| 2020-01 - present \| x x/);
  assert.ok(f.roles[0].duties.length <= 200);
  assert.equal(lines[1], 'Cook | Test Kitchen Ltd | 2015-03 - 2019-12 | grill, sauces');
  const bare = facts.roleLine({ title: '', employer: '', duties: '', dated: false });
  assert.equal(bare, 'title not stated | employer not stated | dates not stated | duties not stated');
});

test('text cleaning: zero-width characters, fullwidth letters, pipes, backticks and control characters', () => {
  assert.equal(facts.cleanText('Head\u200bChef', 80), 'Head Chef');
  assert.equal(facts.cleanText('\uff33\uff4f\uff55\uff53 \uff23\uff48\uff45\uff46', 80), 'Sous Chef');
  assert.equal(facts.cleanText('a | b `c`\u0000\u0007', 80), "a / b 'c'");
  assert.equal(facts.cleanText('one two three four five six seven', 15), 'one two three');
  assert.equal(facts.cleanText(undefined, 10), '');
  assert.equal(facts.cleanText('\u202eevil\u202c', 80), 'evil');
});

test('a lone surrogate never survives: the gateway refuses invalid Unicode with a 400 that the stage would read as an outage', () => {
  assert.equal(facts.cleanText('Head Chef \ud800', 80), 'Head Chef');
  assert.equal(facts.cleanText('Head \udc00Chef', 80), 'Head Chef');
  assert.equal(facts.cleanText('ok \ud83c\udf73 fine', 80), 'ok \ud83c\udf73 fine', 'a whole emoji is kept');
  // a cut through the middle of an emoji at the length limit leaves nothing broken
  const cut = facts.cleanText(`${'a'.repeat(79)}\ud83c\udf73tail`, 80);
  assert.equal(cut.isWellFormed(), true);
  const f = build([role('Chef \ud800', '2020-01', 'present', { employer: 'Kitchen \udc00', duties: [`${'d'.repeat(199)}\ud83c\udf73`, '\ud83c'] })]);
  for (const r of f.roles) for (const v of [r.title, r.employer, r.duties]) assert.equal(v.isWellFormed(), true);
  assert.equal(facts.roleLine(f.roles[0]).isWellFormed(), true);
});

test('qualifications are cleaned, de-duplicated and capped', () => {
  const quals = ['Level 2 Food Safety', 'level 2 food safety', ' NVQ | 3 '].concat(Array.from({ length: 30 }, (_, i) => `Cert ${i}`));
  const f = build([role('A', '2020-01', 'present')], { qualifications: quals });
  assert.equal(f.qualifications.length, 12);
  assert.equal(f.qualifications[0], 'Level 2 Food Safety');
  assert.equal(f.qualifications[1], 'NVQ / 3');
});

test('malformed records give empty facts, never an exception', () => {
  for (const bad of [null, undefined, {}, { roles: 'x' }, { roles: [null, 5, 'a', {}] }]) {
    const f = facts.buildFacts(bad, cfg, NOW);
    assert.equal(f.roles.length, 0);
    assert.equal(f.totalMonths, 0);
  }
});

test('unionMonths handles adjacent, nested and clipped intervals', () => {
  assert.equal(facts.unionMonths([[1, 3], [4, 6]]), 6);
  assert.equal(facts.unionMonths([[1, 10], [3, 4]]), 10);
  assert.equal(facts.unionMonths([[1, 10]], 5, 7), 3);
  assert.equal(facts.unionMonths([]), 0);
  assert.equal(facts.ymText(facts.ymIndex('2024-3')), '2024-03');
  assert.equal(facts.ymIndex('2024-13'), null);
});

test('the reader confidence is understood as a number or as the words high, medium and low', () => {
  const n = facts.normalizeParseConfidence;
  assert.equal(n(0.7), 0.7);
  assert.equal(n(7), 1);
  assert.equal(n(-1), 0);
  assert.equal(n('high'), 0.9);
  assert.equal(n(' Medium '), 0.5);
  assert.equal(n('low'), 0.1);
  assert.equal(n('0.42'), 0.42);
  for (const bad of [undefined, null, '', 'certain', NaN, {}, []]) assert.equal(n(bad), null, String(bad));
  assert.equal(facts.buildFacts({ roles: [], parseConfidence: 'high' }, cfg, NOW).parseConfidence, 0.9);
});
