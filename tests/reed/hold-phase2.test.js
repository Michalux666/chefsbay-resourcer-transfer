'use strict';

// Contract between run-pipeline's Reed hold and the REAL Phase 2 (process-approved-queue.run, fake Zoho deps from the lifecycle
// harness): the queue a HELD run hands to Phase 2 completes the territory and removes its pending search WITHOUT spending a Reed
// retry, whereas a real Reed auth failure keeps the pending search and counts a retry. run-pipeline runs for real in a mirror; its
// Phase 2 step is replaced by a recorder that captures the exact queue file it was given.

const { makeWorkspace } = require('../lifecycle/helpers/workspace');
const ws = makeWorkspace('reed-hold-p2');
require('../lifecycle/helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { seedDb, buildDeps, captureConsole } = require('../lifecycle/helpers/harness');
const { makeMirror } = require('./helpers/mirror');
const { FAKE_REED, FAKE_OPT } = require('./helpers/fake-phases');
const pq = require('../../resourcer/scripts/process-approved-queue');

const CAPTURE_PAQ = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.RESOURCER_HOME;
fs.mkdirSync(path.join(home, 'capture'), { recursive: true });
fs.copyFileSync(process.argv[2], path.join(home, 'capture', 'queue.json'));
fs.mkdirSync(path.join(home, 'downloads'), { recursive: true });
fs.writeFileSync(path.join(home, 'downloads', 'phase2-results-fake.json'), '{}');
`;

test.after(() => ws.cleanup());

// Runs the real run-pipeline.js on a both-source status file with an EMPTY Caterer queue and returns the queue Phase 2 was handed.
async function queueHandedToPhase2(prepare, env) {
  const m = makeMirror();
  try {
    m.write('scripts/process-approved-queue.js', CAPTURE_PAQ);
    m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
    m.write('scripts/reed-phase1.js', FAKE_REED);
    m.write('downloads/approved-queue-2026-09-29-101010.json', {
      searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month', sources: 'both', screeningModel: 'test-model',
      candidateCount: 40, creditsRemaining: 44000, phase1StartedAt: '2026-09-29T09:00:00.000Z', requestedAt: '2026-09-29T08:59:00.000Z',
      phase1Stats: { pagesScraped: 3, approved: 0, skippedDb: 30, skippedReview: 8, errors: 0, totalCandidatesSeen: 40 }, candidates: [],
    });
    const statusFile = m.write('runs/phase1-2026-09-29-101010.json', {
      status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 20, pool: 40, approved: 0, errors: 0, credits: '44000',
    });
    prepare(m);
    const r = await m.run('run-pipeline.js', ['--status-file', statusFile], { env: { RESOURCER_SOURCES: 'both', ...env } });
    assert.equal(r.code, 0, r.stderr);
    const queue = m.readJson('capture/queue.json');
    assert.ok(queue, 'Phase 2 was called');
    return { queue, stderr: r.stderr };
  } finally { m.cleanup(); }
}

async function realPhase2(queue, queueName, pendingBody) {
  ws.reset();
  seedDb(ws, []);
  fs.mkdirSync(ws.pending, { recursive: true });
  const pendingFile = path.join(ws.pending, 'territory-5-20260929-1000.json');
  fs.writeFileSync(pendingFile, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', ...pendingBody }));
  fs.mkdirSync(ws.downloads, { recursive: true });
  const qf = path.join(ws.downloads, queueName);
  fs.writeFileSync(qf, JSON.stringify(queue));
  const built = buildDeps(ws, {});
  built.deps.allowedSources = () => 'both';
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
  const resultsFile = path.join(ws.downloads, `phase2-results-${queueName.replace(/^approved-queue-/, '').replace(/\.json$/, '')}.json`);
  return { res, out: cap.lines, pendingFile, results: fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null, calls: built.calls };
}

test('HELD Reed step: the real Phase 2 completes the territory and removes the pending search; no Reed retry is spent, no auth alert is raised', async () => {
  const { queue, stderr } = await queueHandedToPhase2((m) => {
    m.write('runtime/reed-login-block.json', { blockedAt: new Date().toISOString(), reason: 'turnstile_unsolved', attempts: 1 });
  });
  assert.match(stderr, /REED_HELD: human_login_pending/);
  assert.equal(queue.sources, 'both');
  assert.equal(queue.phase1Stats.reed, undefined, 'no Reed placeholder and no auth flag in the queue');

  const p2 = await realPhase2(queue, 'approved-queue-2026-09-29-101010.json', { sources: 'both', reedAuthRetries: 2 });
  assert.equal(p2.res.code, 0);
  assert.equal(p2.results.sources, 'both');
  assert.equal(p2.results.reedStats.authFailed, false);
  assert.equal(p2.results.reedStats.authFailureReason, null);
  assert.equal(fs.existsSync(p2.pendingFile), false, 'the pending search is complete, not queued for another Reed retry');
  assert.equal(p2.calls.upsert.length, 1, 'the territory map was updated (the Caterer half is done)');
  assert.deepEqual(ws.alerts().filter((a) => /^reed-auth/.test(a.key || '')), [], 'no reed-auth-failed / reed-auth-giveup alert');
  assert.ok(!p2.out.some((l) => /Reed AUTH FAILURE|giving up|disabled by RESOURCER_SOURCES/.test(l)));
  assert.ok(p2.out.some((l) => /Deleted pending search file: .* \(pipeline complete\)/.test(l)), 'removed because the pipeline is complete, not because Reed is off');
});

test('contrast, a REAL Reed auth failure in the same run: the pending search is kept and a retry is counted (bounded retries still work)', async () => {
  const { queue } = await queueHandedToPhase2(() => {}, { FAKE_REED_MODE: 'auth-marker' });
  assert.equal(queue.phase1Stats.reed.authFailed, true);
  const p2 = await realPhase2(queue, 'merged-queue-2026-09-29T10-00-00.json', { sources: 'both', reedAuthRetries: 1 });
  assert.equal(p2.res.code, 0);
  assert.equal(p2.results.reedStats.authFailed, true);
  const kept = ws.readJson(p2.pendingFile);
  assert.equal(kept.reedAuthRetries, 2, 'one retry spent');
  assert.equal(kept.spawnedAt, undefined);
  assert.ok(ws.alerts().some((a) => a.key === 'reed-auth-failed'));
});
