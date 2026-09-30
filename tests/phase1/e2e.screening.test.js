'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);

async function run(t, scenario, args, opts) {
  const home = h.makeHome(scenario, opts);
  t.after(() => h.cleanup(home));
  const r = await h.runPhase1(home, h.baseArgs(args), opts);
  return { home, r, out: r.stdout, calls: r.calls, status: h.statusOf(home), queue: h.queueOf(home) };
}

const alerts = (home) => {
  try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
};
const inputDirClean = (home) => {
  const dir = path.join(home, 'runtime', 'screening-input');
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
};
// NTFS mounts (drvfs) do not keep POSIX modes; the 0600 check only means something where chmod works.
function modesWork() {
  if (process.platform === 'win32') return false;
  const dir = fs.mkdtempSync(path.join(process.env.P1_TEST_TMP || require('os').tmpdir(), 'p1m-'));
  try {
    const f = path.join(dir, 'x');
    fs.writeFileSync(f, '', { mode: 0o600 });
    return (fs.statSync(f).mode & 0o777) === 0o600;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const db = (calls) => callsOf(calls, 'candidates-db').map((c) => [c.cmd].concat(c.args).join(' '));

// ------------------------------------------------------------------ screening down: 3 strikes

test('screening API down on 3 consecutive attempts: pauses, halts the pipeline, alerts, errors++, keeps the pending file, exit 0', async (t) => {
  const home = h.makeHome({
    pages: { 1: { cards: [card(201), card(202)] }, 2: { cards: [card(203)] } },
    ai: { batch: [{ outcome: 'api_down' }] },
  });
  t.after(() => h.cleanup(home));
  const pending = path.join(home, 'pending-searches', 'territory-chef-ls29.json');
  fs.writeFileSync(pending, JSON.stringify({ jobTitle: 'Chef', location: 'LS29', sources: 'caterer' }));

  const r = await h.runPhase1(home, h.baseArgs());
  const out = r.stdout;
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN AI screening API unavailable (page 1, failure 1/3)'));
  assert.ok(out.includes('WARN AI screening API unavailable (page 1, failure 2/3)'));
  assert.ok(out.includes('WARN AI screening API unavailable (page 1, failure 3/3)'));
  assert.strictEqual((out.match(/Pausing 0 seconds before retrying page 1\.\.\./g) || []).length, 2, 'two pauses, none after the third failure');
  assert.ok(out.includes('STOPPING Phase 1: AI screening API down for 3 consecutive pages'));
  assert.strictEqual(callsOf(r.calls, 'ai-review').filter((c) => c.mode === 'batch').length, 3);
  assert.strictEqual(callsOf(r.calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 3, 'the same page is re-navigated for every attempt');
  assert.strictEqual(callsOf(r.calls, 'agent-browser').filter((c) => c.cmd === 'open').every((c) => c.page === 1), true);

  // halt raised through lib/pipeline-halt with the reason string other tools key on
  const halts = callsOf(r.calls, 'pipeline-halt');
  assert.strictEqual(halts.length, 1);
  assert.strictEqual(halts[0].reason, 'AI screening unavailable');
  assert.ok(halts[0].detail.includes('Chef/LS29'));
  assert.strictEqual(halts[0].opts.blockedRun, true);
  assert.ok(halts[0].opts.remedy && !halts[0].opts.remedy.toLowerCase().includes('open' + 'claw'));
  const haltState = h.readJson(path.join(home, 'runtime', 'pipeline-halt.json'));
  assert.strictEqual(haltState.halted, true);

  // alert through notify(), not a console-only line
  const a = alerts(home);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].key, 'phase1-screening-down');
  assert.strictEqual(a[0].severity, 'warn');
  assert.ok(a[0].text.includes('2 candidates on page 1 could not be reviewed'));
  assert.ok(out.includes('ALERT: Screening API down during Chef LS29 run'));

  // the run is recorded as errored, the model label is the failure sentinel, candidates are not marked
  const status = h.statusOf(home);
  const queue = h.queueOf(home);
  assert.strictEqual(status.errors, 1);
  assert.strictEqual(status.approved, 0);
  assert.strictEqual(queue.phase1Stats.errors, 1);
  assert.strictEqual(queue.screeningModel, 'none');
  assert.strictEqual(queue.phase1Stats.pageTimings.length, 3, 'two retries and the halt each record a page timing');
  assert.ok(!db(r.calls).some((l) => /^(seen|add|reject-title) /.test(l)), 'unscreened candidates are never marked seen or rejected');
  assert.strictEqual(callsOf(r.calls, 'caterer-unlock').length, 0);

  // nothing was approved and screening is down: Phase 2 must not run (it would mark the territory searched and delete the pending search)
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);
  assert.ok(out.includes('PHASE2_SKIPPED'));
  assert.strictEqual(status.status, 'phase1_abandoned', 'a terminal status, so the global lock is free');
  assert.strictEqual(status.incomplete, 'screening-unavailable');
  assert.strictEqual(queue.phase1Stats.incomplete, 'screening-unavailable');
  assert.ok(fs.existsSync(pending), 'pending search file kept');
  assert.ok(inputDirClean(home));
});

test('two API failures followed by a success reset the counter and the run goes on (legacy counters kept)', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(211)] }, 2: { cards: [] } },
    ai: { batch: [{ outcome: 'api_down' }, { outcome: 'api_down' }, { outcome: 'ok' }] },
  };
  const { r, out, queue, home } = await run(t, sc);
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('failure 2/3'));
  assert.ok(!out.includes('STOPPING Phase 1'));
  assert.strictEqual(callsOf(r.calls, 'pipeline-halt').length, 0);
  assert.strictEqual(queue.candidates.length, 1);
  assert.strictEqual(queue.phase1Stats.errors, 0);
  // legacy quirk kept: every re-parse of the retried page increments the counters again
  assert.strictEqual(queue.phase1Stats.pagesScraped, 4);
  assert.ok(out.includes('WARN repeated page payload detected (streak=1)'));
  assert.ok(out.includes('WARN repeated page payload detected (streak=2)'));
  assert.deepStrictEqual(alerts(home), []);
});

test('a failure counter reset needs a success: failure, success, failure, failure does not halt', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(221)] }, 2: { cards: [card(222)] }, 3: { cards: [] } },
    ai: { batch: [{ outcome: 'api_down' }, { outcome: 'ok' }, { outcome: 'api_down' }, { outcome: 'api_down' }, { outcome: 'ok' }] },
  };
  const { r, out } = await run(t, sc);
  assert.strictEqual(r.code, 0, out);
  assert.strictEqual(callsOf(r.calls, 'pipeline-halt').length, 0);
});

test('if the halt cannot be raised the run still stops, says so, and the alert becomes critical', async (t) => {
  const { r, out, home, status } = await run(t, { pages: { 1: { cards: [card(231)] } }, ai: { batch: [{ outcome: 'api_down' }] } }, undefined, { env: { P1_HALT_THROWS: '1' } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('WARN could not raise pipeline halt (halt module exploded) - the watchdog will keep picking territories'));
  assert.strictEqual(alerts(home)[0].severity, 'critical');
  assert.strictEqual(status.errors, 1);
});

test('a hung screening call is killed after its timeout and counted as unavailable (3 strikes then halt)', async (t) => {
  const { r, out, calls } = await run(t, { pages: { 1: { cards: [card(241)] } }, ai: { batch: [{ outcome: 'hang' }] } }, undefined, { env: { PHASE1_SCREEN_TIMEOUT_SEC: '0.5', P1_HANG_MS: '30000' }, timeoutMs: 90000 });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('WARN AI batch timed out after 1s on page 1 - treating as API unavailable'));
  assert.ok(out.includes('STOPPING Phase 1: AI screening API down for 3 consecutive pages'));
  assert.strictEqual(callsOf(calls, 'pipeline-halt').length, 1);
});

// ------------------------------------------------------------------ screening output problems

test('unparseable reviewer output stops the run with an error but does not halt the pipeline', async (t) => {
  const { r, out, status, calls, home } = await run(t, { pages: { 1: { cards: [card(251)] }, 2: { cards: [card(252)] } }, ai: { batch: [{ outcome: 'garbage', text: 'the model rambled' }] } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('FATAL AI review parse error on page 1: AI reviewer returned no JSON output. Raw:'));
  assert.ok(out.includes('CAUSE: unrecognised reviewer output (possible code bug). Raw output logged above.'));
  assert.ok(out.includes('Stopping Phase 1.'));
  assert.strictEqual(status.errors, 1);
  assert.strictEqual(callsOf(calls, 'pipeline-halt').length, 0);
  assert.strictEqual(callsOf(calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 1, 'page 2 is not attempted');
  assert.deepStrictEqual(alerts(home), []);
  assert.ok(inputDirClean(home));
});

test('reviewer output that shows an upstream auth/API failure is named as such, alerts, and redacts secrets', async (t) => {
  const text = `Gateway HTTP 500 for key ${h.SECRET}`;
  const { r, out, home, status } = await run(t, { pages: { 1: { cards: [card(261)] } }, ai: { batch: [{ outcome: 'garbage', text }] } });
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('CAUSE: AI screening API/auth failure (not a code bug).'));
  assert.ok(!out.includes(h.SECRET), 'the secret never reaches the console');
  assert.ok(out.includes('***'));
  const a = alerts(home);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].key, 'phase1-screening-auth');
  assert.strictEqual(a[0].severity, 'critical');
  assert.ok(!JSON.stringify(a).includes(h.SECRET));
  assert.strictEqual(status.errors, 1);
});

test('a reviewer that exits 1 with no JSON is the same parse-error stop', async (t) => {
  const { out, status } = await run(t, { pages: { 1: { cards: [card(271)] } }, ai: { batch: [{ outcome: 'exit1' }] } });
  assert.ok(out.includes('FATAL AI review parse error on page 1'));
  assert.strictEqual(status.errors, 1);
});

test('a candidate missing from the reviewer answer is not decided: never rejected or recorded, so it is screened again next time', async (t) => {
  const { out, calls, status } = await run(t, { pages: { 1: { cards: [card(281), card(282)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'missing_id' }] } });
  assert.ok(out.includes('    NOT DECIDED: the reviewer result was missing or unusable'));
  assert.ok(!db(calls).some((l) => /(seen|reject-title) 282/.test(l)), 'no permanent record for an undecided candidate');
  assert.strictEqual(callsOf(calls, 'caterer-unlock').length, 1);
  assert.strictEqual(status.errors, 1);
});

test('rejected candidates that were unlocked before are recorded with add, others with seen; both get reject-title', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(291, { unlockedPrev: true, neverUnlocked: false }), card(292)] }, 2: { cards: [] } },
    ai: { batch: [{ outcome: 'ok', overrides: { 291: { approved: false, reason: 'Unrelated background' }, 292: { approved: false, reason: 'Too senior' } } }] },
  };
  const { out, calls, queue, status } = await run(t, sc);
  const l = db(calls);
  assert.ok(l.includes('add 291') && !l.includes('seen 291'));
  assert.ok(l.includes('seen 292') && !l.includes('add 292'));
  assert.ok(l.includes('reject-title 291 Chef') && l.includes('reject-title 292 Chef'));
  assert.ok(out.includes('    REJECTED pre-unlock: Unrelated background'));
  assert.strictEqual(queue.phase1Stats.skippedReview, 2);
  assert.strictEqual(status.pool, 2);
  assert.strictEqual(callsOf(calls, 'caterer-unlock').length, 0);
});

test('file mode: the screening input file is private, contains no unlock token, is consumed by the reviewer and gone afterwards', async (t) => {
  const { calls, home } = await run(t, { pages: { 1: { cards: [card(301)] }, 2: { cards: [] } } }, undefined, { env: { SCREEN_INPUT_MODE: 'file' } });
  const b = callsOf(calls, 'ai-review').find((c) => c.mode === 'batch');
  assert.strictEqual(b.fileFacts.exists, true);
  assert.strictEqual(b.fileFacts.dir, 'screening-input');
  if (modesWork()) assert.strictEqual(b.fileFacts.mode, 0o600);
  assert.strictEqual(b.hasToken, false);
  assert.strictEqual(b.consume, true);
  assert.ok(b.fields.includes('id') && b.fields.includes('snippet') && b.fields.includes('name'));
  assert.ok(inputDirClean(home));
});

test('default mode: the candidates go to the reviewer on stdin and no file is written at all', async (t) => {
  const { r, calls, home } = await run(t, { pages: { 1: { cards: [card(311)] }, 2: { cards: [] } } });
  assert.strictEqual(r.code, 0, r.stdout);
  const b = callsOf(calls, 'ai-review').find((c) => c.mode === 'batch');
  assert.strictEqual(b.fileMode, 'stdin');
  assert.deepStrictEqual(b.ids, ['311']);
  assert.strictEqual(b.hasToken, false);
  assert.ok(b.fields.includes('name'));
  assert.ok(!fs.existsSync(path.join(home, 'runtime', 'screening-input')));
});

test('leftover screening input files of crashed runs are swept at startup; fresh ones are kept', async (t) => {
  const home = h.makeHome({ pages: { 1: { cards: [] , text: '0 candidates' } } });
  t.after(() => h.cleanup(home));
  const dir = path.join(home, 'runtime', 'screening-input');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'batch-old.json');
  const fresh = path.join(dir, 'batch-fresh.json');
  fs.writeFileSync(old, '[]');
  fs.writeFileSync(fresh, '[]');
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});

test('a 20-second-style heartbeat is printed while the screener runs, and the end line carries the real exit code', async (t) => {
  const { out } = await run(t, { pages: { 1: { cards: [card(321)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'slow', ms: 900 }] } }, undefined, { env: { PHASE1_HEARTBEAT_SEC: '0.2' } });
  assert.ok((out.match(/HEARTBEAT: AI batch in progress \(page 1, \d+s elapsed\)/g) || []).length >= 2, out);
  assert.ok(out.includes('HEARTBEAT: AI batch start page 1 (1 candidates)'));
  assert.match(out, /HEARTBEAT: AI batch end page 1 \(exit=0, \d+s\)/);
});

test('the once-per-run "WARN screening:" line of the reviewer (jev_only, uncalibrated thresholds) is copied to the phase 1 console; other stderr is not', async (t) => {
  const warn = 'WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds (test line)';
  const { out } = await run(t, { pages: { 1: { cards: [card(341)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', warn }] } });
  assert.strictEqual((out.match(/WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds \(test line\)/g) || []).length, 1, out);
  assert.ok(!out.includes('[ai-review] Batch screening - model: fake'), 'ordinary reviewer log lines stay out of the console');
});

test('a snippet that starts with two dashes reaches the reviewer as a value, not as a flag', async (t) => {
  const { calls } = await run(t, { pages: { 1: { cards: [card(331, { snippet: '--weird snippet' })] }, 2: { cards: [] } } });
  const single = callsOf(calls, 'ai-review').find((c) => c.mode === 'single');
  assert.strictEqual(single.snippet.trim(), '--weird snippet');
});

// ------------------------------------------------------------------ unlock paths

test('unlock failure paths: failed, unparseable, missing token, timeout, and the assertion trailer', async (t) => {
  const cards = [card(401), card(402), card(403, { candidateDataValue: '' }), card(404), card(405)];
  const good = { success: true, name: 'Ok Person', firstName: 'Ok', lastName: 'Person', email: 'ok@example.invalid', phone: '', cvUrl: '/cv', encId: 'e', auditId: 'a', jobTitle: 'Chef' };
  const sc = {
    pages: { 1: { cards }, 2: { cards: [] } },
    unlock: {
      401: { success: false, error: 'HTTP 401' },
      402: { __raw: 'garbage output', __exit: 1 },
      404: Object.assign({ __assertTail: true }, good),
      405: { __hang: true },
    },
  };
  const { r, out, calls, queue, status } = await run(t, sc, undefined, { env: { PHASE1_UNLOCK_TIMEOUT_SEC: '1', P1_HANG_MS: '30000' }, timeoutMs: 90000 });
  assert.strictEqual(r.code, 0, out);
  assert.ok(out.includes('    UNLOCK FAILED: HTTP 401'));
  assert.ok(out.includes('    UNLOCK PARSE ERROR: garbage output'));
  assert.ok(out.includes('    WARN no candidateDataValue - skip unlock'));
  assert.ok(out.includes('    UNLOCK PARSE ERROR: timeout after 1s'));
  assert.ok(out.includes('    QUEUED (1 total)'));
  assert.strictEqual(status.errors, 4);
  assert.strictEqual(queue.phase1Stats.errors, 4);
  assert.deepStrictEqual(queue.candidates.map((c) => c.id), ['404']);
  assert.deepStrictEqual(callsOf(calls, 'caterer-unlock').map((c) => c.id), ['401', '402', '404', '405'], 'no unlock call without a token');
  assert.ok(callsOf(calls, 'caterer-unlock').every((c) => c.tokenPresent));
  assert.strictEqual(callsOf(calls, 'ai-review').filter((c) => c.mode === 'single').length, 1, 'only unlocked candidates get the second review');
});

test('the unlock output is scrubbed of personal data in the console', async (t) => {
  const { out } = await run(t, { pages: { 1: { cards: [card(411)] }, 2: { cards: [] } } });
  assert.ok(out.includes('    UNLOCKED: 411 | p***@example.invalid'));
  const lines = out.split('\n');
  assert.ok(!lines.some((l) => l.includes('UNLOCKED') && /Test/.test(l)), 'no first name on the UNLOCKED line');
  assert.ok(!lines.some((l) => l.includes('[411]') && /Test/.test(l)), 'the card line carries no name either');
  assert.ok(!out.includes('person411@example.invalid') && !out.includes('Test Person 411'));
});

test('an unlocked candidate is in the queue checkpoint before the database marks it unlocked (a kill in between must not strand a spent credit)', async (t) => {
  const { calls } = await run(t, { pages: { 1: { cards: [card(421), card(422)] }, 2: { cards: [] } } });
  const adds = callsOf(calls, 'candidates-db-add');
  assert.ok(adds.length >= 2);
  for (const a of adds) assert.ok(a.queueIds.includes(a.id), 'the queue file already held ' + a.id + ' when the database marked it (held: ' + a.queueIds.join(',') + ')');
});

// ------------------------------------------------------------------ post-unlock single review

test('post-unlock review: a clean reject is not queued, is marked unlocked, and gets no reject-title', async (t) => {
  const sc = { pages: { 1: { cards: [card(501)] }, 2: { cards: [] } }, ai: { single: [{ outcome: 'ok', approved: false, reason: 'Too junior for the role' }] } };
  const { out, calls, queue, status } = await run(t, sc);
  assert.ok(out.includes('    REJECTED post-unlock AI: Too junior for the role'));
  const l = db(calls);
  assert.ok(l.includes('add 501'));
  assert.ok(!l.includes('reject-title 501 Chef'));
  assert.strictEqual(queue.candidates.length, 0);
  assert.strictEqual(queue.phase1Stats.skippedReview, 1);
  assert.strictEqual(status.pool, 1);
  assert.ok(!out.includes('QUEUED'));
});

test('post-unlock review fails open: API down, unparseable answer and exit 1 all approve (credit already spent)', async (t) => {
  const cards = [card(511), card(512), card(513), card(514)];
  const sc = {
    pages: { 1: { cards }, 2: { cards: [] } },
    ai: { single: [{ outcome: 'api_down' }, { outcome: 'garbage' }, { outcome: 'exit1' }, { outcome: 'ok', approved: true }] },
  };
  const { out, queue, status } = await run(t, sc);
  assert.ok(out.includes('    WARN post-unlock AI review API unavailable - approving (credit already spent)'));
  assert.ok(out.includes('WARN post-unlock AI review parse error:'));
  assert.deepStrictEqual(queue.candidates.map((c) => c.id), ['511', '512', '513', '514']);
  assert.strictEqual(status.errors, 0);
});

test('post-unlock review timeout is treated as API unavailable (approve)', async (t) => {
  const sc = { pages: { 1: { cards: [card(521)] }, 2: { cards: [] } }, ai: { single: [{ outcome: 'hang' }] } };
  const { queue } = await run(t, sc, undefined, { env: { PHASE1_SINGLE_TIMEOUT_SEC: '0.5', P1_HANG_MS: '30000' } });
  assert.strictEqual(queue.candidates.length, 1);
});

test('the last SCREENING_MODEL marker wins, including markers from single reviews', async (t) => {
  const sc = { pages: { 1: { cards: [card(531), card(532)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', model: 'batch/model' }], single: [{ outcome: 'ok', model: 'single/one' }, { outcome: 'ok', model: 'single/two' }] } };
  const { queue, out } = await run(t, sc);
  assert.strictEqual(queue.screeningModel, 'single/two');
  assert.ok(out.includes('SCREENING_MODEL: single/two'));
});

test('a run with only a batch marker reports it; a run with no screening reports unknown', async (t) => {
  const a = await run(t, { pages: { 1: { cards: [card(541)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', model: 'batch/model' }], single: [{ outcome: 'api_down', model: 'none' }] } });
  assert.strictEqual(a.queue.screeningModel, 'none');
  const b = await run(t, { pages: { 1: { cards: [card(542)] }, 2: { cards: [] } }, db: { candidates: { 542: { unlocked: 1 } } } });
  assert.strictEqual(b.queue.screeningModel, 'unknown');
});

// ------------------------------------------------------------------ Zoho pre-check

test('candidates already in Zoho are dropped from the final queue; stats keep the pre-filter approved count', async (t) => {
  const sc = { pages: { 1: { cards: [card(601), card(602)] }, 2: { cards: [] } }, db: { zoho: { 601: 'ZOHO-1' } } };
  const { out, queue, calls } = await run(t, sc);
  assert.ok(out.includes('[601] Already in Zoho (ZOHO-1) - skip'));
  assert.ok(out.includes('After Zoho pre-check: 1 remain (was 2)'));
  assert.deepStrictEqual(queue.candidates.map((c) => c.id), ['602']);
  assert.strictEqual(queue.phase1Stats.approved, 2);
  assert.strictEqual(callsOf(calls, 'process-approved-queue')[0].queue.candidates.length, 1);
});

test('everything already in Zoho leaves zero to process: caterer-only runs Phase 2 inline without a session save', async (t) => {
  const sc = { pages: { 1: { cards: [card(611)] }, 2: { cards: [] } }, db: { zoho: { 611: 'ZOHO-2' } } };
  const { r, out, calls } = await run(t, sc);
  assert.strictEqual(r.code, 0);
  assert.ok(out.includes('No candidates to process - calling Phase 2 inline to guarantee cleanup.'));
  assert.ok(!callsOf(calls, 'agent-browser').some((c) => c.cmd === 'state save'));
});
