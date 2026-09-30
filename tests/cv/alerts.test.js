'use strict';
// The alert ceilings of a Phase 2 run (config alerts.*): reject rate 0.10 (at least 10 CVs), forced 0.35, unreadable 0.30, fallback 0.05
// (at least 20 CVs decided by the model or the facts), and the one warning when a shadow queue was cut short. The check is "above", never "at".
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-alerts');
const test = require('node:test');
const assert = require('node:assert/strict');
const cv = require('../../resourcer/scripts/lib/cv');
const cvStage = require('../../resourcer/scripts/lib/cv/phase2');

test.after(() => home.cleanup());

const cfg = cv.loadConfig({ file: 'no-such-file.json' });
const stats = over => ({ mode: 'on', screened: 20, rejected: 0, jev: 20, facts: 0, fallback: 0, forced: 0, unreadable: 0, unscreened: 0, shadowStopped: false, jevShare: 1, ...over });
const keys = s => cvStage.alertsFor(s, cfg, 'Chef', 'LS1').map(a => a.key);

test('the shipped ceilings are the owner decision', () => {
  assert.deepEqual(cfg.alerts, { rejectRateCeiling: 0.1, rejectRateMinCandidates: 10, fallbackRateCeiling: 0.05, fallbackMinCandidates: 20, forcedRateCeiling: 0.35, unreadableRateCeiling: 0.3 });
});

test('reject rate: above 10 percent of at least 10 CVs warns; 10 percent exactly, or fewer than 10 CVs, does not', () => {
  assert.deepEqual(keys(stats({ rejected: 2 })), [], '2 of 20 is exactly 10 percent');
  assert.deepEqual(keys(stats({ rejected: 3 })), ['cv-reject-rate-high']);
  assert.deepEqual(keys(stats({ screened: 10, jev: 10, rejected: 1 })), [], '1 of 10 is exactly 10 percent');
  assert.deepEqual(keys(stats({ screened: 10, jev: 10, rejected: 2 })), ['cv-reject-rate-high']);
  assert.deepEqual(keys(stats({ screened: 9, jev: 9, rejected: 9 })), [], 'fewer than 10 CVs never alert');
  const a = cvStage.alertsFor(stats({ rejected: 3 }), cfg, 'Chef', 'LS1')[0];
  assert.equal(a.severity, 'warn');
  assert.match(a.text, /rejected 3 of 20 CVs \(15 percent, ceiling 10\) for Chef in LS1/);
  assert.doesNotMatch(a.text, /would have|nothing was blocked/);
});

test('reject rate in shadow mode says what the stage WOULD have done and that nothing was blocked', () => {
  const a = cvStage.alertsFor(stats({ mode: 'shadow', rejected: 6 }), cfg, 'Chef', 'LS1')[0];
  assert.equal(a.key, 'cv-reject-rate-high');
  assert.match(a.text, /would have rejected 6 of 20 CVs \(30 percent, ceiling 10\)/);
  assert.match(a.text, /nothing was blocked/);
  assert.equal(a.meta.mode, 'shadow');
});

test('forced rate: above 35 percent warns', () => {
  assert.deepEqual(keys(stats({ forced: 7 })), [], '7 of 20 is exactly 35 percent');
  assert.deepEqual(keys(stats({ forced: 8 })), ['cv-forced-rate-high']);
});

test('unreadable rate: above 30 percent warns', () => {
  assert.deepEqual(keys(stats({ unreadable: 6, jev: 14 })), [], '6 of 20 is exactly 30 percent');
  assert.deepEqual(keys(stats({ unreadable: 7, jev: 13 })), ['cv-unreadable-rate-high']);
});

test('fallback rate: above 5 percent of at least 20 modelled CVs warns', () => {
  assert.deepEqual(keys(stats({ fallback: 1, jev: 19 })), [], '1 of 20 is exactly 5 percent');
  assert.deepEqual(keys(stats({ fallback: 2, jev: 18 })), ['cv-fallback-rate-high']);
  assert.deepEqual(keys(stats({ screened: 19, fallback: 5, jev: 14 })), [], 'fewer than 20 modelled CVs never raise it');
  const a = cvStage.alertsFor(stats({ fallback: 2, jev: 18, jevShare: 0.9 }), cfg, 'Chef', 'LS1')[0];
  assert.match(a.text, /2 of 20 CVs for Chef in LS1 were not decided by Jev \(fallback lane, ceiling 5 percent/);
  assert.equal(a.meta.jevShare, 0.9);
});

test('a normal run raises nothing: 3 percent rejected, 6 percent forced, 6 percent unreadable, no fallback', () => {
  assert.deepEqual(keys(stats({ screened: 100, jev: 94, unreadable: 6, rejected: 3, forced: 6 })), []);
});

test('a shadow queue that was cut short raises one warning, whatever the counts', () => {
  const list = cvStage.alertsFor(stats({ mode: 'shadow', screened: 0, jev: 0, unscreened: 14, shadowStopped: true }), cfg, 'Chef', 'LS1');
  assert.deepEqual(list.map(a => a.key), ['cv-shadow-stopped']);
  assert.equal(list[0].severity, 'warn');
  assert.match(list[0].text, /CV screening \(shadow\) stopped early for Chef in LS1: 5 CVs in a row could not be screened, so 14 CV\(s\) of this queue were not screened/);
  assert.match(list[0].text, /Nothing was blocked and nothing was lost/);
  const tighter = cv.loadConfig({ file: 'no-such-file.json', overrides: { phase2: { shadowStopAfterFailures: 2 } } });
  assert.match(cvStage.alertsFor(stats({ mode: 'shadow', unscreened: 3, shadowStopped: true }), tighter, 'Chef', 'LS1')[0].text, /2 CVs in a row/);
});

test('every alert names only numbers and the searched role: no candidate detail', () => {
  const list = cvStage.alertsFor(stats({ mode: 'shadow', rejected: 8, forced: 12, unreadable: 9, fallback: 3, jev: 17, unscreened: 2, shadowStopped: true }), cfg, 'Chef', 'LS1');
  assert.deepEqual(list.map(a => a.key).sort(), ['cv-fallback-rate-high', 'cv-forced-rate-high', 'cv-reject-rate-high', 'cv-shadow-stopped', 'cv-unreadable-rate-high']);
  for (const a of list) assert.ok(a.severity === 'warn' && a.text.length < 500 && a.meta && typeof a.meta === 'object');
});
