'use strict';

// Update C, finding F9: after a Phase 2 HOLD (process-approved-queue.js exit 2: CV screening could not run, nothing was lost) run-pipeline used to take
// the newest OLD results file on disk for this run (a duplicate optimiser entry, a wrong RESULTS_FILE) and exit 0, so the supervisor recorded the held run as
// a success. Now: no results file for a held run, no optimiser, PIPELINE_HELD instead of PIPELINE_COMPLETE, exit 14. run-pipeline runs for real in a mirror;
// its Phase 2 step and the optimiser are recorders (every call goes to <home>/calls.jsonl).

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeMirror } = require('./helpers/mirror');
const { FAKE_REED, FAKE_OPT } = require('./helpers/fake-phases');

// Phase 2 as it behaves when held: it writes NO results file and exits 2 (or exits 0 and writes one, when it completes)
const PAQ = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.RESOURCER_HOME;
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ who: 'phase2', queue: path.basename(process.argv[2]) }) + String.fromCharCode(10));
if (process.env.FAKE_PAQ_EXIT === '2') process.exit(2);
fs.mkdirSync(path.join(home, 'downloads'), { recursive: true });
fs.writeFileSync(path.join(home, 'downloads', 'phase2-results-this-run.json'), '{}');
process.exit(0);
`;

function bothWorld(m) {
  m.write('scripts/process-approved-queue.js', PAQ);
  m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
  m.write('scripts/reed-phase1.js', FAKE_REED);
  // the results file of an EARLIER run: the one a held run used to report as its own
  m.write('downloads/phase2-results-an-older-run.json', '{}');
  const past = new Date(Date.now() - 3600000);
  require('fs').utimesSync(m.p('downloads', 'phase2-results-an-older-run.json'), past, past);
  m.write('downloads/approved-queue-2026-09-29-101010.json', {
    searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month', sources: 'both', screeningModel: 'test-model', candidateCount: 40,
    creditsRemaining: 44000, phase1Stats: { pagesScraped: 3, approved: 2, skippedDb: 30, skippedReview: 8, errors: 0, totalCandidatesSeen: 40 }, candidates: [{ id: 1 }, { id: 2 }],
  });
  return m.write('runs/phase1-2026-09-29-101010.json', {
    status: 'phase1_complete', sources: 'both', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', distance: 20, pool: 40, approved: 2, errors: 0, credits: '44000',
  });
}

const callsOf = (m, who) => m.readLines('calls.jsonl').filter((c) => c.who === who);
const line = (out, key) => (out.split('\n').find((l) => l.startsWith(`${key}:`)) || '').slice(key.length + 1).trim();

test('sources=both, Phase 2 HELD: exit 14, PIPELINE_HELD, no RESULTS_FILE (not the older run\'s), the optimiser is not run, phase2Status stays pending', async () => {
  const m = makeMirror();
  try {
    const statusFile = bothWorld(m);
    const r = await m.run('run-pipeline.js', ['--status-file', statusFile], { env: { RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'quiet', FAKE_PAQ_EXIT: '2' } });
    assert.equal(r.code, 14, r.stderr);
    assert.match(r.stdout, /^PIPELINE_HELD$/m);
    assert.ok(!/PIPELINE_COMPLETE/.test(r.stdout));
    assert.equal(line(r.stdout, 'RESULTS_FILE'), '', 'the newest results file on disk belongs to an older run');
    assert.ok(!/an-older-run/.test(r.stdout + r.stderr), 'the older results file is not named anywhere');
    assert.equal(callsOf(m, 'phase2').length, 1);
    assert.equal(callsOf(m, 'optimiser').length, 0, 'no duplicate optimiser entry');
    assert.match(r.stderr, /Phase 2 exit: 2 \(HELD: CV screening could not run, nothing was lost\), results: none/);
    assert.equal(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'pending', 'not marked done: the queue is retried by the recovery');
    assert.ok(!/VERDICT: (NOMINAL|ATTENTION)/.test(r.stdout), 'no verdict without results');
  } finally { m.cleanup(); }
});

test('sources=both, Phase 2 completes: exit 0, PIPELINE_COMPLETE, the results file of THIS run, the optimiser runs, phase2Status done (unchanged)', async () => {
  const m = makeMirror();
  try {
    const statusFile = bothWorld(m);
    const r = await m.run('run-pipeline.js', ['--status-file', statusFile], { env: { RESOURCER_SOURCES: 'both', FAKE_REED_MODE: 'quiet' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^PIPELINE_COMPLETE$/m);
    assert.match(line(r.stdout, 'RESULTS_FILE'), /phase2-results-this-run\.json$/);
    assert.equal(callsOf(m, 'optimiser').length, 1);
    assert.equal(m.readJson('runs/phase1-2026-09-29-101010.json').phase2Status, 'done');
  } finally { m.cleanup(); }
});

test('single-source recovery of a held run (status left in phase2_starting with phase2Hold): exit 14 and no results, but a completed or never-held run reports its results as before', async () => {
  const m = makeMirror();
  try {
    m.write('scripts/pipeline-optimiser.js', FAKE_OPT);
    m.write('downloads/phase2-results-an-older-run.json', '{}');
    const held = m.write('runs/phase1-2026-09-29-111111.json', {
      status: 'phase2_starting', sources: 'caterer', jobTitle: 'Chef', location: 'LS1', distance: 20, pool: 40, approved: 2, errors: 0, credits: '44000',
      phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() },
    });
    const a = await m.run('run-pipeline.js', ['--status-file', held], { env: { RESOURCER_SOURCES: 'caterer' } });
    assert.equal(a.code, 14, a.stderr);
    assert.match(a.stdout, /^PIPELINE_HELD$/m);
    assert.equal(line(a.stdout, 'RESULTS_FILE'), '');
    assert.equal(callsOf(m, 'optimiser').length, 0);
    assert.match(a.stderr, /Phase 2 was held \(CV screening could not run\); no results for this run/);

    // the same file once Phase 2 completed (a stale hold marker is ignored) and a run that was never held: the newest results file, as before
    const done = m.write('runs/phase1-2026-09-29-222222.json', {
      status: 'complete', phase2Complete: true, sources: 'caterer', jobTitle: 'Chef', location: 'LS1', distance: 20, pool: 40, approved: 2, errors: 0, credits: '44000',
      phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() },
    });
    const b = await m.run('run-pipeline.js', ['--status-file', done], { env: { RESOURCER_SOURCES: 'caterer' } });
    assert.equal(b.code, 0, b.stderr);
    assert.match(b.stdout, /^PIPELINE_COMPLETE$/m);
    assert.match(line(b.stdout, 'RESULTS_FILE'), /phase2-results-an-older-run\.json$/);
    const never = m.write('runs/phase1-2026-09-29-333333.json', { status: 'complete', sources: 'caterer', phase2Status: 'done', jobTitle: 'Chef', location: 'LS1', distance: 20 });
    const c = await m.run('run-pipeline.js', ['--status-file', never], { env: { RESOURCER_SOURCES: 'caterer' } });
    assert.equal(c.code, 0, c.stderr);
    assert.match(line(c.stdout, 'RESULTS_FILE'), /phase2-results-an-older-run\.json$/);
  } finally { m.cleanup(); }
});
