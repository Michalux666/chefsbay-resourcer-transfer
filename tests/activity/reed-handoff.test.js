'use strict';
// What run-pipeline.js hands to Reed (docs/ACTIVITY.md): the window and the CV limit of the request or territory, not the literals "month" and 20.
// A scheduled territory with the stored defaults (1 month, 20) gets exactly the argument list it always had. The merged queue records the window
// that was asked, sent and applied for Caterer, and what Reed was given.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeMirror } = require('../reed/helpers/mirror');
const { FAKE_REED, FAKE_PAQ, FAKE_OPT } = require('../reed/helpers/fake-phases');

// the stock fake Reed, plus the line reed-phase1.js prints when the daily view budget lowers the limit
const REED = FAKE_REED.replace('const mode =', "if (process.env.FAKE_REED_LOWERED) console.log('  CV limit lowered from ' + process.env.FAKE_REED_LOWERED + ': that is all the Reed profile views left today');\nconst mode =");

const CATERER_ACTIVITY = { requestedActiveWithin: '12 months', requestedCvLimit: 30, sentLastActivityId: 15, appliedFilterText: '12 months', poolHeaderCount: 321, matched: 'yes' };

function setup(activity, opts = {}) {
  const m = makeMirror();
  m.write('scripts/process-approved-queue.js', FAKE_PAQ);
  m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
  m.write('scripts/reed-phase1.js', REED);
  m.write('downloads/approved-queue-2026-09-29-101010.json', {
    searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 15, activeWithin: opts.queueWindow || '1 month', sources: 'both', screeningModel: 'unknown',
    candidateCount: 10, phase1Stats: { pool: 10, approved: 1 }, candidates: [{ id: 'c1' }], ...(opts.queueActivity ? { activity: opts.queueActivity } : {}),
  });
  const status = { status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 15, pool: 10, approved: 1, errors: 0, credits: '1234', ...(activity ? { activity } : {}) };
  const statusFile = m.write('runs/phase1-2026-09-29-101010.json', status);
  const calls = () => m.readLines('calls.jsonl');
  const queuePath = m.p('downloads', 'approved-queue-2026-09-29-101010.json');
  return { m, statusFile, calls, queuePath, run: (env) => m.run('run-pipeline.js', ['--status-file', statusFile], { env: Object.assign({ RESOURCER_SOURCES: 'both' }, env) }) };
}
const OLD_ARGV = (queue) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '15', '--active-within', 'month', '--cv-limit', '20', '--caterer-queue', queue];
const mergedOf = (m, calls) => m.readJson(`downloads/${calls.find((c) => c.who === 'phase2').queue}`);

test('a request for 12 months and 30 CVs reaches Reed as year and 30, and the merged queue records it next to what Caterer was asked and showed', async () => {
  const { m, calls, queuePath, run } = setup({ requestedActiveWithin: '12 months', requestedCvLimit: 30 }, { queueActivity: CATERER_ACTIVITY });
  try {
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    const c = calls();
    assert.deepStrictEqual(c[0].argv, ['--job-title', 'Chef', '--location', 'LS1', '--distance', '15', '--active-within', 'year', '--cv-limit', '30', '--caterer-queue', queuePath]);
    assert.match(r.stderr, /REED_ACTIVITY requested="12 months" sent="year" cvLimit=30/);
    assert.ok(!/WARN: /.test(r.stderr.split('\n').filter((l) => /window|Reed has no/.test(l)).join('\n')), 'an exact window has no warning');
    const merged = mergedOf(m, c);
    assert.deepStrictEqual(merged.activity, { ...CATERER_ACTIVITY, reed: { activeWithin: 'year', requestedActiveWithin: '12 months', cvLimit: 30, cvLimitRequested: 30, ran: true } });
  } finally { m.cleanup(); }
});

test('a scheduled territory with the stored defaults (1 month, 20) gets exactly the Reed arguments it always had, with or without the recorded window', async () => {
  for (const activity of [undefined, { requestedActiveWithin: '1 month', requestedCvLimit: 20 }, {}, { requestedActiveWithin: null, requestedCvLimit: null }]) {
    const { m, calls, queuePath, run } = setup(activity);
    try {
      const r = await run();
      assert.strictEqual(r.code, 0, r.stderr);
      assert.deepStrictEqual(calls()[0].argv, OLD_ARGV(queuePath), JSON.stringify(activity));
      assert.match(r.stderr, /REED_ACTIVITY requested="1 month" sent="month" cvLimit=20/);
    } finally { m.cleanup(); }
  }
});

test('every label reaches Reed as the key reed-search.js maps: 14 days 2 weeks, 1 month month, 2 months 2months, 3 months 3months, 6 months 6months, 12 months year, 18 months 2 years (wider, with a WARN and a note), All all', async () => {
  const want = { '14 days': '2 weeks', '1 month': 'month', '2 months': '2months', '3 months': '3months', '6 months': '6months', '12 months': 'year', '18 months': '2 years', All: 'all' };
  for (const [label, arg] of Object.entries(want)) {
    const { m, calls, run } = setup({ requestedActiveWithin: label, requestedCvLimit: 25 });
    try {
      const r = await run();
      assert.strictEqual(r.code, 0, r.stderr);
      const argv = calls()[0].argv;
      assert.strictEqual(argv[argv.indexOf('--active-within') + 1], arg, label);
      assert.strictEqual(argv[argv.indexOf('--cv-limit') + 1], '25', label);
      const reed = mergedOf(m, calls()).activity.reed;
      if (label === '18 months') {
        assert.match(r.stderr, /WARN: Reed has no 18 months window: the next wider one \(2 years\) was used/);
        assert.match(reed.note, /no 18 months window/);
      } else {
        assert.ok(!/WARN: Reed has no/.test(r.stderr), label);
        assert.strictEqual(reed.note, undefined, label);
      }
      assert.strictEqual(reed.activeWithin, arg);
      assert.strictEqual(reed.requestedActiveWithin, label);
    } finally { m.cleanup(); }
  }
});

test('a window that is none of the eight labels is searched as before (a month) with a WARN, never as something the request did not ask for', async () => {
  const { m, calls, queuePath, run } = setup({ requestedActiveWithin: 'last fortnight', requestedCvLimit: 20 });
  try {
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(calls()[0].argv, OLD_ARGV(queuePath));
    assert.match(r.stderr, /WARN: the window "last fortnight" is not one of the eight labels: Reed searched the last month, as before/);
  } finally { m.cleanup(); }
});

test('a CV limit that is not a positive whole number falls back to 20; the limit lowered by the daily view budget is the one the record states', async () => {
  const bad = setup({ requestedActiveWithin: '1 month', requestedCvLimit: 'lots' });
  try {
    await bad.run();
    assert.strictEqual(bad.calls()[0].argv[bad.calls()[0].argv.indexOf('--cv-limit') + 1], '20');
  } finally { bad.m.cleanup(); }
  const { m, calls, run } = setup({ requestedActiveWithin: '12 months', requestedCvLimit: 30 });
  try {
    const r = await run({ FAKE_REED_LOWERED: '30 to 12' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(calls()[0].argv[calls()[0].argv.indexOf('--cv-limit') + 1], '30', 'the request is passed on; reed-phase1.js lowers it');
    const reed = mergedOf(m, calls()).activity.reed;
    assert.deepStrictEqual([reed.cvLimitRequested, reed.cvLimit], [30, 12]);
  } finally { m.cleanup(); }
});

test('when Reed fails the placeholder merge still records what it was given (ran: true), and when Reed is off by config no Reed step and no activity of Reed is recorded', async () => {
  const failed = setup({ requestedActiveWithin: '6 months', requestedCvLimit: 40 });
  try {
    const r = await failed.run({ FAKE_REED_MODE: 'boom' });
    assert.strictEqual(r.code, 0, r.stderr);
    const merged = mergedOf(failed.m, failed.calls());
    assert.strictEqual(merged.activity.reed.activeWithin, '6months');
    assert.strictEqual(merged.activity.reed.cvLimit, 40);
    assert.strictEqual(merged.activity.requestedActiveWithin, '6 months');
  } finally { failed.m.cleanup(); }
  const off = setup({ requestedActiveWithin: '12 months', requestedCvLimit: 30 }, { queueActivity: CATERER_ACTIVITY });
  try {
    const r = await off.run({ RESOURCER_SOURCES: 'caterer' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(off.calls().map((x) => x.who), ['phase2', 'optimiser']);
    assert.ok(!/REED_ACTIVITY/.test(r.stderr), 'Reed was not asked for anything');
    assert.strictEqual(off.calls()[0].queue, path.basename(off.queuePath), 'Phase 2 runs on the Caterer queue, which carries its own activity block');
  } finally { off.m.cleanup(); }
});

test('the helpers: a status without a recorded window asks for nothing, and a run with no activity anywhere has no block to merge', () => {
  const rp = require('../../resourcer/scripts/run-pipeline');
  assert.deepStrictEqual(rp.requestedWindow({}), { activeWithin: undefined, cvLimit: undefined });
  assert.deepStrictEqual(rp.requestedWindow({ activity: { requestedActiveWithin: '2 months', requestedCvLimit: 12 } }), { activeWithin: '2 months', cvLimit: 12 });
  assert.strictEqual(rp.activityBlock({}, null, null), null);
  assert.deepStrictEqual(rp.activityBlock({ activity: { matched: 'yes' } }, null, { activeWithin: 'month' }), { matched: 'yes', reed: { activeWithin: 'month' } });
});
