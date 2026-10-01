'use strict';
// scripts/cv-report.js and the role scope for people whose role was never recorded (docs/ROLESCOPE.md R-C8): the same block RESURFACED shows how many such
// people were given their one more look (Caterer, Reed), how many were rejected again and pushed, and what the looks cost; the settings and their typos are shown.
const { makeHome } = require('../cv/helpers/home');
const home = makeHome('rsl-report');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const report = require('../../resourcer/scripts/cv-report');
const rs = require('../../resourcer/scripts/lib/resurface');

test.after(() => home.cleanup());
test.beforeEach(() => { home.reset(); for (const k of ['CV_RESURFACE', 'CV_RESURFACE_MAX_PER_DAY', 'CV_RESURFACE_MIN_CREDITS', 'ROLE_SCOPE_LEGACY', 'ROLE_SCOPE_MIN_AGE_DAYS', 'CV_SCREEN']) delete process.env[k]; });

function run(args) {
  let out = '';
  let err = '';
  const code = report.main(args, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}
const writeState = (st) => { fs.mkdirSync(home.runtime, { recursive: true }); fs.writeFileSync(path.join(home.runtime, 'cv-resurface.json'), JSON.stringify(st)); };
const day = (d, over) => Object.assign({ day: d, started: 0, caterer: 0, reed: 0, charged: 0, notCharged: 0, unknown: 0, credits: 0, reedViews: 0, capped: 0, reserve: 0, unreadable: 0, pushed: 0, rejected: 0 }, over || {});

test('RL8 the report shows the role scope: looks given (Caterer, Reed), rejected again, pushed, charged, credits, views, and the day with its number', () => {
  const today = rs.londonDay();
  writeState({ version: 1, today: day(today, { started: 3, caterer: 3, charged: 3, credits: 3, pushed: 2, rejected: 1, legacyCaterer: 4, legacyReed: 6, legacyRejected: 5, legacyPushed: 3, legacyCharged: 5, legacyCredits: 3, legacyViews: 2 }), history: [] });
  const r = run(['--days', '7']);
  assert.equal(r.code, 0);
  assert.match(r.out, /ROLE_SCOPE_LEGACY on, minimum age 14 days\)/);
  assert.match(r.out, /role scope: one more look  given to 10 people whose role was never recorded \(Caterer 4, Reed 6\); rejected again 5, pushed to Zoho 3; charged 5, Caterer credits spent 3, Reed profile views spent 2/);
  assert.match(r.out, new RegExp(`${today}  started 3 [^\\n]*role scope 10`));
  const j = JSON.parse(run(['--days', '7', '--json']).out);
  assert.deepEqual([j.resurfaced.totals.legacyCaterer, j.resurfaced.totals.legacyReed, j.resurfaced.totals.legacyRejected, j.resurfaced.totals.legacyPushed, j.resurfaced.totals.legacyCharged, j.resurfaced.totals.legacyCredits, j.resurfaced.totals.legacyViews], [4, 6, 5, 3, 5, 3, 2]);
});

test('RL8 a day with only role scope people (snippet rejections cost nothing) is not "none in this period"; the history inside the period is added', () => {
  const today = rs.londonDay();
  writeState({ version: 1, today: day(today, { legacyReed: 2, legacyRejected: 2 }), history: [day(rs.londonDay(Date.now() - 2 * 86400000), { legacyCaterer: 1, legacyRejected: 1 }), day('2000-01-01', { legacyCaterer: 99 })] });
  const r = run(['--days', '7']);
  assert.doesNotMatch(r.out, /none in this period/);
  assert.match(r.out, /given to 3 people whose role was never recorded \(Caterer 1, Reed 2\); rejected again 3, pushed to Zoho 0; charged 0/);
});

test('RL8 a ROLE_SCOPE_LEGACY or ROLE_SCOPE_MIN_AGE_DAYS that is not understood is a WARNING in the report, and the switch shows as it is', () => {
  process.env.ROLE_SCOPE_LEGACY = 'nope';
  process.env.ROLE_SCOPE_MIN_AGE_DAYS = 'soon';
  let text = run(['--days', '1']).out;
  assert.match(text, /ROLE_SCOPE_LEGACY off, minimum age 14 days/);
  assert.match(text, /WARNING: ROLE_SCOPE_LEGACY='nope' is neither on nor off: treated as off/);
  assert.match(text, /WARNING: ROLE_SCOPE_MIN_AGE_DAYS='soon' is not a whole number: using 14/);
  process.env.ROLE_SCOPE_LEGACY = 'off';
  process.env.ROLE_SCOPE_MIN_AGE_DAYS = '30';
  text = run(['--days', '1']).out;
  assert.match(text, /ROLE_SCOPE_LEGACY off, minimum age 30 days/);
  assert.doesNotMatch(text, /WARNING/);
});
