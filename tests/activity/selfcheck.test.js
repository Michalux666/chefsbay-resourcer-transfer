'use strict';
// The self-check of the applied search window inside a real phase 1 run (docs/ACTIVITY.md): after the first results page loads, the summary of
// the filters Caterer says it applied is read, compared with what was sent, logged in one ACTIVITY_FILTER line and stored in the status and the
// queue. A wrong or unreadable answer raises one WARN alert a day and never stops the run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('../phase1/harness');

const { card } = h;

const URL_ID = (id) => `${h.RESULTS_URL}&LastActivityId=${id}`;
const summary = (n, text, extra) => `Candidates ${n}\n${extra || ''}Search anything in CV or Profile: Chef. Exact match.${text === null ? '' : ` Active within last: ${text}.`} CV/Profile: Both\n`;
const scenarioOf = (page1) => ({ pages: { 1: Object.assign({ cards: [card(1)] }, page1), 2: { cards: [] } }, db: { candidates: { 1: { unlocked: 1 } } } });

async function run(t, page1, args, opts) {
  const o = Object.assign({ activity: true }, opts);
  const home = h.makeHome(scenarioOf(page1), o);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(args), o);
  const alertsFile = path.join(home, 'outbox', 'alerts.jsonl');
  const alerts = fs.existsSync(alertsFile) ? fs.readFileSync(alertsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { home, r, out: r.stdout, status: h.statusOf(home), queue: h.queueOf(home), alerts: alerts.filter((a) => a.key === 'caterer-activity-mismatch'), calls: r.calls };
}
const lineOf = (out) => (out.split('\n').find((l) => l.startsWith('ACTIVITY_FILTER ')) || '');
const activityEvals = (calls) => calls.filter((c) => c.tool === 'agent-browser' && c.activity).length;

test('a window that Caterer echoes as sent: match=yes, the applied text and the header count are stored in the status and the queue, no alert', async (t) => {
  const { r, out, status, queue, alerts, calls } = await run(t, { summaryText: summary(321, '12 months', 'Sam Sample Sous Chef, Ilkley LS29 8AB sam@example.invalid\n') }, ['--results-url', URL_ID(15), '--active-within', '12 months', '--cv-limit', '30']);
  assert.strictEqual(r.code, 0, out);
  assert.strictEqual(lineOf(out), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="12 months" match=yes');
  const want = { requestedActiveWithin: '12 months', requestedCvLimit: 30, sentLastActivityId: 15, appliedFilterText: '12 months', poolHeaderCount: 321, matched: 'yes' };
  assert.deepStrictEqual(status.activity, want);
  assert.deepStrictEqual(queue.activity, want);
  assert.deepStrictEqual(alerts, []);
  assert.strictEqual(activityEvals(calls), 1, 'the summary is read once per run');
  assert.ok(!/Sample|example\.invalid|Ilkley/.test(out + JSON.stringify(status) + JSON.stringify(queue.activity)), 'no card text reaches the log or the records');
});

test('a window that Caterer does not show as sent: match=no, one WARN alert caterer-activity-mismatch with the numbers, and the run goes on to a normal end', async (t) => {
  const { r, out, status, alerts } = await run(t, { summaryText: summary(900, '1 month') }, ['--results-url', URL_ID(15), '--active-within', '12 months']);
  assert.strictEqual(r.code, 0, out);
  assert.strictEqual(lineOf(out), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="1 month" match=no');
  assert.strictEqual(status.activity.matched, 'no');
  assert.strictEqual(status.activity.appliedFilterText, '1 month');
  assert.strictEqual(status.status, 'phase1_complete');
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].severity, 'warn');
  assert.match(alerts[0].text, /asked for "12 months" \(LastActivityId=15\) and the results page says "1 month"/);
  assert.match(alerts[0].text, /only the size of the pool differs/);
  assert.ok(out.includes('ALERT: Caterer did not show the search window that was sent'));
});

test('the mismatch alert is sent once a day: a second run on the same day logs the line and stores the result but raises nothing', async (t) => {
  const first = await run(t, { summaryText: summary(900, '1 month') }, ['--results-url', URL_ID(15), '--active-within', '12 months']);
  assert.strictEqual(first.alerts.length, 1);
  const again = await h.runPhase1(first.home, h.baseArgs(['--results-url', URL_ID(15), '--active-within', '12 months']));
  assert.strictEqual(again.code, 0, again.stdout);
  assert.strictEqual(lineOf(again.stdout), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="1 month" match=no');
  assert.ok(!again.stdout.includes('ALERT: Caterer did not show'));
  const file = path.join(first.home, 'outbox', 'alerts.jsonl');
  const n = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.key === 'caterer-activity-mismatch').length;
  assert.strictEqual(n, 1, 'one alert for the day');
  const day = JSON.parse(fs.readFileSync(path.join(first.home, 'runtime', 'activity-alert.json'), 'utf8')).day;
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
});

test('a page whose summary cannot be read: match=unreadable, a WARN alert when the page had cards, the run is not stopped', async (t) => {
  const broken = await run(t, { activityError: 'Error: page evaluation failed' }, ['--results-url', URL_ID(15), '--active-within', '12 months']);
  assert.strictEqual(broken.r.code, 0, broken.out);
  assert.strictEqual(lineOf(broken.out), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="" match=unreadable');
  assert.strictEqual(broken.status.activity.matched, 'unreadable');
  assert.strictEqual(broken.alerts.length, 1);
  assert.match(broken.alerts[0].text, /could not be read.*not confirmed/);
  // a results page that has no header and no summary line (the layout changed) reads the same way
  const changed = await run(t, { summaryText: 'Showing 1 candidates on this page' }, ['--results-url', URL_ID(8), '--active-within', '1 month']);
  assert.strictEqual(changed.status.activity.matched, 'unreadable');
  assert.strictEqual(changed.status.status, 'phase1_complete');
  // a sign-in page is not a results page either: unreadable (the run has its own session checks)
  // an empty search (no cards on page 1) that cannot be read raises no alert: there is nothing to confirm
  const empty = await run(t, { cards: [], text: '0 candidates match your search', activityError: 'Error: nothing here' }, ['--results-url', URL_ID(15), '--active-within', '12 months']);
  assert.strictEqual(empty.status.activity.matched, 'unreadable');
  assert.deepStrictEqual(empty.alerts, [], 'no cards: no alert');
});

test('a scheduled run (no id sent) logs what Caterer applied by default, match=n/a, and never alerts', async (t) => {
  const withText = await run(t, { summaryText: summary(412, '1 month') });
  assert.strictEqual(lineOf(withText.out), 'ACTIVITY_FILTER requested="1 month" sent="LastActivityId=none" applied="1 month" match=n/a');
  assert.deepStrictEqual(withText.status.activity, { requestedActiveWithin: '1 month', requestedCvLimit: 20, sentLastActivityId: 'none', appliedFilterText: '1 month', poolHeaderCount: 412, matched: 'n/a' });
  assert.deepStrictEqual(withText.alerts, []);
  const noText = await run(t, { summaryText: summary(412, null) });
  assert.strictEqual(lineOf(noText.out), 'ACTIVITY_FILTER requested="1 month" sent="LastActivityId=none" applied="" match=n/a', 'applied is empty when the page shows no window');
  assert.strictEqual(noText.status.activity.appliedFilterText, '');
  const unreadable = await run(t, { activityError: 'Error: boom' });
  assert.strictEqual(unreadable.status.activity.matched, 'n/a');
  assert.deepStrictEqual(unreadable.alerts, []);
});

test('All (id 0) may show no window text and still match; a window with an id the config no longer knows cannot be compared (n/a)', async (t) => {
  const all = await run(t, { summaryText: summary(5000, null) }, ['--results-url', URL_ID(0), '--active-within', 'All']);
  assert.strictEqual(lineOf(all.out), 'ACTIVITY_FILTER requested="All" sent="LastActivityId=0" applied="" match=yes');
  const gone = await run(t, { summaryText: summary(5000, '12 months') }, ['--results-url', URL_ID(15), '--active-within', '12 months'], { activity: { config: { labels: { '1 month': { id: 8, echo: ['1 month'] } } } } });
  assert.strictEqual(gone.status.activity.matched, 'n/a');
  assert.deepStrictEqual(gone.alerts, []);
  const broken = await run(t, { summaryText: summary(5000, '12 months') }, ['--results-url', URL_ID(15), '--active-within', '12 months'], { activity: { config: '{ nope' } });
  assert.strictEqual(broken.status.activity.matched, 'n/a');
});

test('the note of a window that could not be sent is printed and recorded (params file ACTIVITY_NOTE)', async (t) => {
  const home = h.makeHome(scenarioOf({ summaryText: summary(70, '1 month') }), { activity: true });
  t.after(() => h.cleanup(home));
  const params = path.join(home, 'params.json');
  fs.writeFileSync(params, JSON.stringify({ RESULTS_URL: h.RESULTS_URL, JOB_TITLE: 'Chef', LOCATION: 'LS29', SOURCES: 'caterer', ACTIVE_WITHIN: '18 months', CV_LIMIT: 25, ACTIVITY_NOTE: 'no Caterer LastActivityId is known for "18 months" (caterer-activity.json): no filter sent to Caterer' }));
  const r = await h.runPhase1(home, ['--params-file', params]);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('ACTIVITY_FILTER_NOTE no Caterer LastActivityId is known for "18 months"'));
  const status = h.statusOf(home);
  assert.match(status.activity.note, /18 months/);
  assert.strictEqual(status.activity.requestedActiveWithin, '18 months');
  assert.strictEqual(status.activity.requestedCvLimit, 25);
  assert.strictEqual(status.activity.sentLastActivityId, 'none');
  assert.strictEqual(lineOf(r.stdout), 'ACTIVITY_FILTER requested="18 months" sent="LastActivityId=none" applied="1 month" match=n/a');
});

test('the self-check costs no browser round-trip in the run statistics, and without the library nothing is read from the page', async (t) => {
  const withLib = await run(t, { summaryText: summary(10, '1 month') });
  const without = await run(t, { summaryText: summary(10, '1 month') }, [], { activity: false });
  const trips = (o) => /Browser round-trips: (\d+)/.exec(o)[1];
  assert.strictEqual(trips(withLib.out), trips(without.out));
  assert.strictEqual(activityEvals(withLib.calls), 1);
  assert.strictEqual(activityEvals(without.calls), 0);
  assert.ok(!lineOf(without.out), 'no line without the library');
  assert.strictEqual(without.status.activity.matched, 'not-checked');
  assert.strictEqual(without.status.activity.sentLastActivityId, 'none');
});

test('a page 1 that fails to load is not the one that is read: the first page that did load is', async (t) => {
  const home = h.makeHome({
    pages: { 1: { evalError: 'Error: page failed', cards: [] }, 2: { cards: [card(1)], summaryText: summary(33, '12 months') }, 3: { cards: [] } },
    db: { candidates: { 1: { unlocked: 1 } } },
  }, { activity: true });
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(['--results-url', URL_ID(15), '--active-within', '12 months']));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(lineOf(r.stdout), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="12 months" match=yes');
  assert.strictEqual(activityEvals(r.calls), 1);
});
