'use strict';
// Release integration (update C leftover 6): scripts/cv-report.js prints the share of queued CVs that the shadow stop left unscreened (phase2.shadowMaxSeconds
// or consecutive failures), so the sample bias of the shadow week toward small, fast queues is visible. The data are queue-stop lines in the daily CV shadow
// file (lib/cv/shadow.js buildQueueStopRow); they are never decision rows.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-report-cap');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const report = require('../../resourcer/scripts/cv-report');
const shadow = require('../../resourcer/scripts/lib/cv/shadow');

test.after(() => home.cleanup());
test.beforeEach(() => home.reset());

const day = () => new Date().toISOString().slice(0, 10);
const file = () => path.join(home.shadow, `cv-${day()}.jsonl`);
function append(lines) {
  fs.mkdirSync(home.shadow, { recursive: true });
  fs.appendFileSync(file(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const decision = () => ({ ts: new Date().toISOString(), mode: 'shadow', jobTitle: 'X', tau: 0.75, lane: 'jev', decision: 'pass', final: 'approve', pReject: 0, forced: false, confidence: 1, finalReasonCodes: ['pass_relevant_history'] });
const stop = (o) => shadow.buildQueueStopRow({ runId: 'r', screened: 5, skipped: 0, stoppedBy: 'time', ...o });

function run(args) {
  let out = '';
  const code = report.main(args, { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
}

test('the unscreened share: CVs skipped after the shadow time cap are counted against everything queued, printed, and never mixed into the decision numbers', () => {
  append(Array.from({ length: 90 }, decision));
  let r = run([]);
  assert.ok(r.out.includes('UNSCREENED BY THE SHADOW STOP\n  none: no queue was cut short by the time cap or by failures (0 of 90 queued CVs)'), r.out);
  append([stop({ skipped: 6 }), stop({ skipped: 4 }), stop({ skipped: 5, stoppedBy: 'failures' })]);
  r = run(['--json']);
  const s = JSON.parse(r.out);
  assert.equal(s.rows, 90, 'the decision numbers do not count the queue-stop lines');
  assert.deepEqual(s.shadowCap, { queued: 105, skippedByTime: 10, queuesStoppedByTime: 2, skippedByFailures: 5, queuesStoppedByFailures: 1, shareByTime: 9.5, shareByFailures: 4.8 });
  r = run([]);
  assert.ok(r.out.includes('10 of 105 queued CVs (9.5%) were skipped because the screening of their queue passed phase2.shadowMaxSeconds (2 queue(s)); 5 more (4.8%) after CVs in a row could not be screened (1 queue(s)).'), r.out);
  assert.ok(r.out.includes('favours small, fast queues'));
  assert.equal(JSON.parse(run(['--json', '--mode', 'on']).out).shadowCap.skippedByTime, 0, 'the time cap never applies in mode on');
});

test('a queue-stop row holds numbers and a fixed word only, is not a decision row, and is pruned with its daily file', () => {
  const row = stop({ skipped: 3, stoppedBy: 'something else', screened: 2.4 });
  assert.deepEqual(Object.keys(row).sort(), ['kind', 'mode', 'runId', 'screened', 'skipped', 'stoppedBy', 'ts', 'v']);
  assert.equal(row.stoppedBy, 'failures', 'only time or failures');
  assert.equal(row.screened, 2);
  append([decision(), row]);
  assert.equal(shadow.readRows().length, 1);
  assert.equal(shadow.readQueueStops().length, 1);
  const old = shadow.pruneShadow({ now: () => new Date(Date.now() + 400 * 86400000) });
  assert.equal(old.deleted.length, 1, 'the same daily file, so the same retention');
});

test('logShadowStop writes the queue-stop line only while the shadow log is switched on (config shadow.enabled)', () => {
  const stage = require('../../resourcer/scripts/lib/cv/phase2');
  assert.equal(stage.logShadowStop({ enabled: false, runId: 'r', stoppedBy: 'time', screened: 3, skipped: 4 }), false);
  assert.equal(fs.existsSync(file()), false, 'nothing is written when the shadow log is off');
  assert.ok(stage.logShadowStop({ enabled: true, runId: 'r', stoppedBy: 'time', screened: 3, skipped: 4 }));
  assert.ok(fs.existsSync(file()), 'written when it is on');
});
