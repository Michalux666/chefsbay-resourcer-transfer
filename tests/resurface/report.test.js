'use strict';
// scripts/cv-report.js and the role-scoped second look (docs/RESURFACE.md): the block RESURFACED, from runtime/cv-resurface.json, one entry per London day.
const { makeHome } = require('../cv/helpers/home');
const home = makeHome('rsv-report');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const report = require('../../resourcer/scripts/cv-report');
const rs = require('../../resourcer/scripts/lib/resurface');

test.after(() => home.cleanup());
test.beforeEach(() => { home.reset(); delete process.env.CV_RESURFACE; delete process.env.CV_RESURFACE_MAX_PER_DAY; delete process.env.CV_RESURFACE_MIN_CREDITS; });

function run(args) {
  let out = '';
  let err = '';
  const code = report.main(args, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

const writeState = (st) => { fs.mkdirSync(home.runtime, { recursive: true }); fs.writeFileSync(path.join(home.runtime, 'cv-resurface.json'), JSON.stringify(st)); };
const day = (d, over) => Object.assign({ day: d, started: 0, caterer: 0, reed: 0, charged: 0, notCharged: 0, unknown: 0, credits: 0, reedViews: 0, capped: 0, reserve: 0, unreadable: 0, pushed: 0, rejected: 0 }, over || {});

test('C7 the report shows what the second look did and what it cost: claims, charged, not charged, unknown, credits, Reed views, pushed, rejected again, held back', () => {
  const today = rs.londonDay();
  writeState({ version: 1, today: day(today, { started: 9, caterer: 7, reed: 2, charged: 5, notCharged: 3, unknown: 1, credits: 5, reedViews: 1, pushed: 4, rejected: 3, capped: 2, reserve: 1, unreadable: 1 }), history: [] });
  const r = run(['--days', '7']);
  assert.equal(r.code, 0);
  assert.match(r.out, /RESURFACED \(unlocked earlier, rejected for another role, screened again for this one; docs\/RESURFACE\.md; CV_RESURFACE on, CV_SCREEN shadow \(the second look is not active\), cap 40 a day, reserve 1000 credits; role scope for people whose role was never recorded, docs\/ROLESCOPE\.md: ROLE_SCOPE_LEGACY on, minimum age 14 days\)/);
  process.env.CV_SCREEN = 'on';
  assert.match(run(['--days', '7']).out, /CV_RESURFACE on, CV_SCREEN on \(the second look is active\), cap 40 a day/);
  delete process.env.CV_SCREEN;
  assert.match(r.out, /re-opened \(claims made\)   9/);
  assert.match(r.out, /charged 5, not charged 3, charge unknown 1; Caterer credits spent 5, Reed profile views spent 1/);
  assert.match(r.out, /pushed to Zoho 4, rejected again 3/);
  assert.match(r.out, /by the daily cap 2, by the reserve 1, balance unreadable 1/);
  assert.match(r.out, new RegExp(`${today}  started 9 \\(Caterer 7, Reed 2\\)  charged 5  not charged 3  unknown 1  credits 5  Reed views 1`));
});

test('C7 the report adds the days of the history inside the period and none outside it; the setting is shown as it is', () => {
  const today = rs.londonDay();
  const old = '2000-01-01';
  const recent = rs.londonDay(Date.now() - 2 * 86400000);
  writeState({ version: 1, today: day(today, { started: 1, charged: 1, credits: 1 }), history: [day(old, { started: 50, charged: 50 }), day(recent, { started: 3, charged: 2, notCharged: 1, credits: 2 })] });
  process.env.CV_RESURFACE = 'off';
  process.env.CV_RESURFACE_MAX_PER_DAY = '5';
  process.env.CV_RESURFACE_MIN_CREDITS = '250';
  const r = run(['--days', '7', '--json']);
  const s = JSON.parse(r.out);
  assert.deepEqual([s.resurfaced.totals.started, s.resurfaced.totals.charged, s.resurfaced.totals.notCharged, s.resurfaced.totals.credits], [4, 3, 1, 3]);
  assert.equal(s.resurfaced.days.length, 2);
  const text = run(['--days', '7']).out;
  assert.match(text, /CV_RESURFACE off, CV_SCREEN shadow \(the second look is not active\), cap 5 a day, reserve 250 credits/);
});

test('C7 with nothing to report the block says so, and an unreadable counter file is a new day, never an error', () => {
  const r = run(['--days', '1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /RESURFACED \(/);
  assert.match(r.out, /none in this period/);
  fs.mkdirSync(home.runtime, { recursive: true });
  fs.writeFileSync(path.join(home.runtime, 'cv-resurface.json'), '{ not json');
  const again = run(['--days', '1']);
  assert.equal(again.code, 0);
  assert.match(again.out, /none in this period/);
});

test('C6 a CV_RESURFACE typo is shown by the report as a WARNING (the second look is then off), and so is a number setting that is not a whole number', () => {
  process.env.CV_RESURFACE = 'nope';
  process.env.CV_RESURFACE_MAX_PER_DAY = 'forty';
  const text = run(['--days', '1']).out;
  assert.match(text, /CV_RESURFACE off, CV_SCREEN shadow/);
  assert.match(text, /WARNING: CV_RESURFACE='nope' is neither on nor off: treated as off/);
  assert.match(text, /WARNING: CV_RESURFACE_MAX_PER_DAY='forty' is not a whole number: using 40/);
  delete process.env.CV_RESURFACE;
  delete process.env.CV_RESURFACE_MAX_PER_DAY;
  assert.doesNotMatch(run(['--days', '1']).out, /WARNING/);
});
