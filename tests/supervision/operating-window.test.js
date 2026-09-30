'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'window');
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const alerts = require(path.join(H.SRC_SCRIPTS, 'alerts-deliver.js'));

const inWin = (iso) => wd.inOperatingHours(new Date(iso));

test('window is 06:00 inclusive to 22:00 exclusive in Europe/London (winter, GMT)', () => {
  assert.equal(inWin('2026-01-15T05:59:00Z'), false);
  assert.equal(inWin('2026-01-15T06:00:00Z'), true);
  assert.equal(inWin('2026-01-15T21:59:59Z'), true);
  assert.equal(inWin('2026-01-15T22:00:00Z'), false);
});

test('window follows BST in summer (UTC+1)', () => {
  assert.equal(inWin('2026-07-15T04:59:00Z'), false, '05:59 BST');
  assert.equal(inWin('2026-07-15T05:00:00Z'), true, '06:00 BST');
  assert.equal(inWin('2026-07-15T20:59:59Z'), true, '21:59 BST');
  assert.equal(inWin('2026-07-15T21:00:00Z'), false, '22:00 BST');
});

test('spring forward (2026-03-29 01:00 UTC): the day before is GMT, the day of is BST', () => {
  assert.equal(inWin('2026-03-28T05:59:00Z'), false);
  assert.equal(inWin('2026-03-28T06:00:00Z'), true);
  assert.equal(inWin('2026-03-28T21:59:00Z'), true);
  assert.equal(inWin('2026-03-28T22:00:00Z'), false);
  assert.equal(inWin('2026-03-29T04:59:00Z'), false, '05:59 BST after the change');
  assert.equal(inWin('2026-03-29T05:00:00Z'), true, '06:00 BST after the change');
  assert.equal(inWin('2026-03-29T20:59:00Z'), true);
  assert.equal(inWin('2026-03-29T21:00:00Z'), false);
});

test('fall back (2026-10-25 01:00 UTC): the day before is BST, the day of is GMT', () => {
  assert.equal(inWin('2026-10-24T04:59:00Z'), false);
  assert.equal(inWin('2026-10-24T05:00:00Z'), true);
  assert.equal(inWin('2026-10-24T20:59:00Z'), true);
  assert.equal(inWin('2026-10-24T21:00:00Z'), false);
  assert.equal(inWin('2026-10-25T05:00:00Z'), false, '05:00 GMT');
  assert.equal(inWin('2026-10-25T06:00:00Z'), true, '06:00 GMT');
  assert.equal(inWin('2026-10-25T21:59:00Z'), true);
  assert.equal(inWin('2026-10-25T22:00:00Z'), false);
});

test('the window never depends on the OS timezone', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      assert.equal(inWin('2026-07-15T05:00:00Z'), true, `TZ=${tz}`);
      assert.equal(inWin('2026-07-15T04:59:00Z'), false, `TZ=${tz}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('cron hour range 5-23 (any tz) is a superset of the London window in every season', () => {
  // The schedule fires hours 5..23 in the Hermes timezone; whether that is London or UTC, every
  // instant inside the London window must fall on a fired hour.
  for (const day of ['2026-01-15', '2026-03-28', '2026-03-29', '2026-07-15', '2026-10-24', '2026-10-25']) {
    for (let m = 0; m < 24 * 60; m += 15) {
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCMinutes(m);
      if (!wd.inOperatingHours(d)) continue;
      const utcH = d.getUTCHours();
      const londonH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit' }).format(d));
      assert.ok(utcH >= 5 && utcH <= 23, `UTC hour ${utcH} on ${day}`);
      assert.ok(londonH >= 5 && londonH <= 23, `London hour ${londonH} on ${day}`);
    }
  }
});

test('alert quiet hours use London time across the changes', () => {
  assert.equal(alerts.inQuietHours(new Date('2026-07-15T20:59:00Z')), false, '21:59 BST');
  assert.equal(alerts.inQuietHours(new Date('2026-07-15T21:00:00Z')), true, '22:00 BST');
  assert.equal(alerts.inQuietHours(new Date('2026-07-15T04:59:00Z')), true, '05:59 BST');
  assert.equal(alerts.inQuietHours(new Date('2026-07-15T05:00:00Z')), false, '06:00 BST');
  assert.equal(alerts.inQuietHours(new Date('2026-01-15T22:00:00Z')), true);
  assert.equal(alerts.inQuietHours(new Date('2026-01-15T06:00:00Z')), false);
});
