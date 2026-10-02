'use strict';
// The run results carry the search window as it was requested, sent and applied (docs/ACTIVITY.md), so a report can state the filters that
// were really used without reading code. The block is copied from the queue: a queue without one gives the results it always gave.
const { makeWorkspace } = require('../lifecycle/helpers/workspace');
const ws = makeWorkspace('act-results');
require('../lifecycle/helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeZoho } = require('../lifecycle/helpers/fake-zoho');
const { card, writeQueue, writeCv } = require('../lifecycle/helpers/fixtures');
const { captureConsole, seedDb, buildDeps } = require('../lifecycle/helpers/harness');
const pq = require('../../resourcer/scripts/process-approved-queue');

let zoho;
test.before(async () => { zoho = await startFakeZoho(); });
test.after(async () => { await zoho.close(); ws.cleanup(); });

async function execute(queueExtra, name) {
  ws.reset();
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  seedDb(ws, ['6101'], {});
  writeCv(ws, '6101');
  const qf = writeQueue(ws, name, { candidates: [card('6101')], ...queueExtra });
  const built = buildDeps(ws, { zoho });
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
  const runKey = path.basename(qf).replace(/^approved-queue-/, '').replace(/\.json$/, '');
  const resultsFile = path.join(ws.downloads, `phase2-results-${runKey}.json`);
  return { res, results: fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null };
}

test('the activity block of the queue is in the run results, with the Reed half of a merged queue', async () => {
  const activity = {
    requestedActiveWithin: '12 months', requestedCvLimit: 30, sentLastActivityId: 15, appliedFilterText: '12 months', poolHeaderCount: 321, matched: 'yes',
    reed: { activeWithin: 'year', requestedActiveWithin: '12 months', cvLimit: 30, cvLimitRequested: 30, ran: true },
  };
  const { res, results } = await execute({ activeWithin: '12 months', cvLimit: 30, activity }, 'approved-queue-2026-10-02T10-00-00.json');
  assert.equal(res.code, 0);
  assert.deepEqual(results.activity, activity);
  assert.equal(results.activeWithin, '12 months', 'the existing fields are unchanged');
  assert.equal(results.cvLimit, 30);
});

test('a queue without the block (an older run) gives results without it, and a block that is not an object is not copied', async () => {
  const plain = await execute({}, 'approved-queue-2026-10-02T10-05-00.json');
  assert.equal(plain.res.code, 0);
  assert.equal('activity' in plain.results, false);
  const odd = await execute({ activity: 'yes' }, 'approved-queue-2026-10-02T10-10-00.json');
  assert.equal('activity' in odd.results, false);
});
