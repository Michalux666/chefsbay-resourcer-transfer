'use strict';
// Runs that end early for a reason the territory is not responsible for (reviewer fault, scrape fault, unlock endpoint,
// broken database) keep the territory and its pending search; a fault that repeats identically is bounded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const { card } = h;
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool);
const db = (calls) => callsOf(calls, 'candidates-db').map((c) => [c.cmd].concat(c.args).join(' '));

const alerts = (home) => {
  try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
};
const counterFile = (home) => path.join(home, 'runtime', 'phase1-incomplete-runs.json');

function newHome(t, scenario, opts) {
  const home = h.makeHome(scenario, opts);
  t.after(() => h.cleanup(home));
  return home;
}

// The newest phase-1 status file of a home (several runs in one home leave several).
function latestStatus(home) {
  const files = fs.readdirSync(path.join(home, 'runs')).filter((f) => /^phase1-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(f)).sort();
  return files.length ? h.readJson(path.join(home, 'runs', files[files.length - 1])) : null;
}

const okPages = { 1: { cards: [card(1)] }, 2: { cards: [] } };

// ------------------------------------------------------------ reviewer failures other than exit 3

test('reviewer exits 1 with no JSON: the run is incomplete, Phase 2 is not run, the pending search is kept', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'exit1' }] } });
  const pending = path.join(home, 'pending-searches', 'territory-chef-ls29.json');
  fs.writeFileSync(pending, JSON.stringify({ jobTitle: 'Chef', location: 'LS29', sources: 'caterer' }));
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0, r.stdout);
  const status = latestStatus(home);
  assert.strictEqual(status.status, 'phase1_abandoned');
  assert.strictEqual(status.incomplete, 'screening-error');
  assert.strictEqual(status.incompleteRuns, 1);
  assert.strictEqual(status.incompleteLimit, 3);
  assert.strictEqual(status.errors, 1);
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0, 'Phase 2 would mark the territory searched and delete the pending search');
  assert.ok(r.stdout.includes('PHASE2_SKIPPED'));
  assert.ok(fs.existsSync(pending));
  assert.strictEqual(callsOf(r.calls, 'pipeline-halt').length, 0, 'a non-API fault does not halt the pipeline');
  assert.strictEqual(h.readJson(counterFile(home))['chef|ls29|20'].count, 1);
  assert.strictEqual(h.queueOf(home).phase1Stats.incomplete, 'screening-error');
});

test('a deterministic reviewer fault is bounded: the third run in a row completes normally and raises a critical alert', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'exit1' }] } });
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await h.runPhase1(home, h.baseArgs());
    assert.strictEqual(r.code, 0, r.stdout);
    statuses.push(latestStatus(home));
    if (i < 2) assert.ok(r.stdout.includes(`early-end ${i + 1} of 3`), r.stdout);
  }
  assert.deepStrictEqual(statuses.slice(0, 2).map((s) => [s.status, s.incomplete]), [['phase1_abandoned', 'screening-error'], ['phase1_abandoned', 'screening-error']]);
  assert.ok(!statuses[2].incomplete, 'the giving-up run is not marked incomplete');
  assert.strictEqual(statuses[2].incompleteGaveUp, 'screening-error');
  const a = alerts(home).filter((x) => x.key === 'phase1-incomplete-giveup');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.ok(!fs.existsSync(counterFile(home)) || !('chef|ls29|20' in h.readJson(counterFile(home))), 'the counter starts again after giving up');
});

test('a run that completes normally clears the counter of its search', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'exit1' }, { outcome: 'ok' }] } });
  await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(h.readJson(counterFile(home))['chef|ls29|20'].count, 1);
  fs.writeFileSync(path.join(home, '_state', 'ai.json'), JSON.stringify({ batch: 1, single: 0 }));
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(!latestStatus(home).incomplete);
  assert.ok(!('chef|ls29|20' in h.readJson(counterFile(home))));
});

test('reviewer text showing an API/auth failure raises the halt, is incomplete and is never given up', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'garbage', text: 'Gateway HTTP 500 for the gateway' }] } });
  for (let i = 0; i < 4; i++) {
    const r = await h.runPhase1(home, h.baseArgs());
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(latestStatus(home).incomplete, 'screening-error', `run ${i + 1}`);
  }
  assert.strictEqual(callsOf(h_calls(home), 'pipeline-halt').length, 4, 'the halt is raised on every run');
  assert.ok(!fs.existsSync(counterFile(home)), 'the halt governs the re-runs, so nothing is counted');
  assert.strictEqual(alerts(home).filter((x) => x.key === 'phase1-incomplete-giveup').length, 0);
});

function h_calls(home) { return h.readCalls(home); }

test('API text and a halt that cannot be written: incomplete anyway, and now bounded', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'garbage', text: 'OAuth session expired' }] } });
  const env = { P1_HALT_THROWS: '1' };
  const r1 = await h.runPhase1(home, h.baseArgs(), { env });
  assert.strictEqual(latestStatus(home).incomplete, 'screening-error');
  assert.ok(r1.stdout.includes('WARN could not raise pipeline halt'));
  assert.strictEqual(callsOf(r1.calls, 'process-approved-queue').length, 0);
  await h.runPhase1(home, h.baseArgs(), { env });
  const r3 = await h.runPhase1(home, h.baseArgs(), { env });
  assert.ok(r3.stdout.includes('GIVING UP holding Chef/LS29'));
});

test('exit 3 three times with a halt that cannot be written is still incomplete (independent of the halt)', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'api_down' }] } });
  const r = await h.runPhase1(home, h.baseArgs(), { env: { P1_HALT_THROWS: '1' } });
  assert.strictEqual(r.code, 0, r.stdout);
  const status = latestStatus(home);
  assert.strictEqual(status.incomplete, 'screening-unavailable');
  assert.strictEqual(status.status, 'phase1_abandoned');
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);
  assert.strictEqual(alerts(home)[0].severity, 'critical');
});

test('reviewer exits 1 although it printed results: treated as a failure, not as decisions', async (t) => {
  const home = newHome(t, { pages: okPages, ai: { batch: [{ outcome: 'exit1_with_json' }] } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('FATAL AI reviewer exited with code 1'));
  assert.strictEqual(callsOf(r.calls, 'caterer-unlock').length, 0);
  assert.strictEqual(latestStatus(home).incomplete, 'screening-error');
});

test('reviewer answers [] for a non-empty page: no decision at all is a reviewer failure, not a page of rejections', async (t) => {
  const home = newHome(t, { pages: { 1: { cards: [card(11), card(12)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'empty_array' }] } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('FATAL AI reviewer gave no usable decision for any of the 2 candidates'));
  assert.ok(!db(r.calls).some((l) => /^(seen|add|reject-title) /.test(l)), 'nothing was booked as rejected');
  assert.strictEqual(latestStatus(home).incomplete, 'screening-error');
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);
});

// ------------------------------------------------------------ system-invalid results are not verdicts

test('the reviewer is asked for reason codes, and a system-invalid answer is neither rejected nor recorded', async (t) => {
  const sc = {
    pages: { 1: { cards: [card(21), card(22, { unlockedPrev: true, neverUnlocked: false }), card(23)] }, 2: { cards: [] } },
    ai: { batch: [{ outcome: 'ok', overrides: { 21: { approved: false, reason: 'Screening result invalid - rejected conservatively', code: 'sys_invalid_result' }, 22: { approved: false, reason: 'Screening result invalid - rejected conservatively', code: 'sys_invalid_result' }, 23: { approved: false, reason: 'Too junior' } } }] },
  };
  const home = newHome(t, sc);
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(callsOf(r.calls, 'ai-review').find((c) => c.mode === 'batch').withCodes, true);
  const l = db(r.calls);
  assert.ok(!l.some((x) => /^(seen|add|reject-title) 2[12]$/.test(x) || x.startsWith('reject-title 21') || x.startsWith('reject-title 22')), l.join('\n'));
  assert.ok(l.includes('seen 23') && l.includes('reject-title 23 Chef'), 'a real rejection is still recorded');
  assert.strictEqual(latestStatus(home).errors, 2, 'each undecided candidate is counted');
  assert.ok(r.stdout.includes('NOT DECIDED'));
});

test('every candidate of a page of two or more system-invalid: reviewer failure, nothing recorded', async (t) => {
  const bad = { approved: false, reason: 'Screening result invalid - rejected conservatively', code: 'sys_invalid_result' };
  const home = newHome(t, { pages: { 1: { cards: [card(31), card(32)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', overrides: { 31: bad, 32: bad } }] } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('FATAL AI reviewer gave no usable decision for any of the 2 candidates'));
  assert.ok(!db(r.calls).some((x) => /^(seen|add|reject-title) /.test(x)));
  assert.strictEqual(latestStatus(home).incomplete, 'screening-error');
});

test('a lone system-invalid candidate on a one-candidate page is skipped and the run goes on (the engine trips the streak)', async (t) => {
  const bad = { approved: false, reason: 'Screening result invalid - rejected conservatively', code: 'sys_invalid_result' };
  const home = newHome(t, { pages: { 1: { cards: [card(41)] }, 2: { cards: [card(42)] }, 3: { cards: [] } }, ai: { batch: [{ outcome: 'ok', overrides: { 41: bad } }, { outcome: 'ok' }] } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(!db(r.calls).some((x) => /(seen|add|reject-title) 41/.test(x)));
  assert.deepStrictEqual(h.queueOf(home).candidates.map((c) => c.id), ['42']);
  assert.ok(!latestStatus(home).incomplete);
});

// ------------------------------------------------------------ a broken database must not look like "everything is new"

test('exit 2 from candidates-db check stops the page before any screening or unlock (never fails open)', async (t) => {
  const pending = { jobTitle: 'Chef', location: 'LS29', sources: 'caterer' };
  const home = newHome(t, { pages: { 1: { cards: [card(51), card(52)] }, 2: { cards: [] } }, db: { batchFail: true, checkExit2: true } });
  fs.writeFileSync(path.join(home, 'pending-searches', 'territory-chef-ls29.json'), JSON.stringify(pending));
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes('FATAL candidates.db check failed (exit 2)'));
  assert.strictEqual(callsOf(r.calls, 'ai-review').length, 0, 'nothing was screened');
  assert.strictEqual(callsOf(r.calls, 'caterer-unlock').length, 0, 'no credit was spent');
  const status = latestStatus(home);
  assert.strictEqual(status.incomplete, 'db-unavailable');
  assert.strictEqual(status.status, 'phase1_abandoned');
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);
  assert.ok(fs.existsSync(path.join(home, 'pending-searches', 'territory-chef-ls29.json')));
  const a = alerts(home).filter((x) => x.key === 'phase1-db-unavailable');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.ok(!fs.existsSync(counterFile(home)), 'a broken database is never given up on: Phase 2 needs it too');
});

test('exit 1 without a NEW line (a crash) is a database failure too; a genuine NEW still means new', async (t) => {
  const crash = newHome(t, { pages: { 1: { cards: [card(61)] }, 2: { cards: [] } }, db: { batchFail: true, checkCrash: true } });
  const r = await h.runPhase1(crash, h.baseArgs());
  assert.ok(r.stdout.includes('FATAL candidates.db check failed (exit 1)'));
  assert.strictEqual(callsOf(r.calls, 'ai-review').length, 0);
  const fresh = newHome(t, { pages: { 1: { cards: [card(62)] }, 2: { cards: [] } }, db: { batchFail: true } });
  const r2 = await h.runPhase1(fresh, h.baseArgs());
  assert.strictEqual(callsOf(r2.calls, 'ai-review').filter((c) => c.mode === 'batch').length, 1, 'a real NEW exit 1 is screened');
  assert.ok(!latestStatus(fresh).incomplete);
});

test('three bookkeeping writes in a row failing marks the database broken and stops the run', async (t) => {
  const cards = [card(71), card(72), card(73)];
  const rej = { approved: false, reason: 'No' };
  const home = newHome(t, { pages: { 1: { cards }, 2: { cards: [card(74)] }, 3: { cards: [] } }, db: { writeFail: true }, ai: { batch: [{ outcome: 'ok', overrides: { 71: rej, 72: rej, 73: rej } }] } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('STOPPING Phase 1: candidates.db is not usable'));
  assert.strictEqual(latestStatus(home).incomplete, 'db-unavailable');
  assert.ok(latestStatus(home).errors >= 3, 'each failed write is counted as an error');
  assert.strictEqual(callsOf(r.calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 1, 'page 2 is not fetched');
});

// ------------------------------------------------------------ a run that scraped nothing keeps the territory

test('silent zero on page 1 (no explicit zero) keeps the territory; an explicit zero is genuine exhaustion', async (t) => {
  const silent = newHome(t, { pages: { 1: { cards: [], text: 'Some unrelated shell text' } } });
  const r = await h.runPhase1(silent, h.baseArgs());
  assert.ok(r.stdout.includes('ERROR no cards on page 1'));
  assert.strictEqual(latestStatus(silent).incomplete, 'scrape-failure');
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);

  const zero = newHome(t, { pages: { 1: { cards: [], text: '0 candidates' } } });
  const r2 = await h.runPhase1(zero, h.baseArgs());
  assert.ok(!latestStatus(zero).incomplete);
  assert.strictEqual(callsOf(r2.calls, 'process-approved-queue').length, 1, 'a genuinely empty territory is consumed as before');
});

test('a scrape fault repeated three times in a row is finally consumed, with a critical alert', async (t) => {
  const pages = {};
  for (let p = 1; p <= 12; p++) pages[p] = { rawEval: 'garbage' };
  const home = newHome(t, { pages });
  const last = [];
  for (let i = 0; i < 3; i++) last.push(await h.runPhase1(home, h.baseArgs(['--max-pages', '50'])));
  assert.strictEqual(callsOf(last[0].calls, 'process-approved-queue').length, 0);
  assert.strictEqual(callsOf(last[2].calls, 'process-approved-queue').length, 1, 'the third run hands over to Phase 2');
  assert.strictEqual(alerts(home).filter((x) => x.key === 'phase1-incomplete-giveup').length, 1);
});

test('empty eval output reads as zero cards (legacy): page 2 ends the run cleanly, page 1 goes to the probe', async (t) => {
  const later = newHome(t, { pages: { 1: { cards: [card(81)] }, 2: { rawEval: '' } } });
  const r = await h.runPhase1(later, h.baseArgs());
  assert.ok(r.stdout.includes('No cards - results exhausted'));
  assert.strictEqual(latestStatus(later).errors, 0);
  const first = newHome(t, { pages: { 1: { rawEval: '""', text: '0 candidates' } } });
  const r2 = await h.runPhase1(first, h.baseArgs());
  assert.ok(r2.stdout.includes('page explicitly reports 0 candidates'));
  assert.strictEqual(callsOf(r2.calls, 'agent-browser').filter((c) => c.probe).length, 1);
});

// ------------------------------------------------------------ unlock

test('a failed unlock leaves an approved unlockedPrev candidate unrecorded so it is screened again', async (t) => {
  const home = newHome(t, { pages: { 1: { cards: [card(91, { unlockedPrev: true, neverUnlocked: false })] }, 2: { cards: [] } }, unlock: { 91: { success: false, error: 'HTTP 403' } } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('UNLOCK FAILED: HTTP 403'));
  assert.ok(!db(r.calls).some((x) => /^add 91$/.test(x)), db(r.calls).join('\n'));
});

test('a queued candidate is recorded even when its card had neither unlock flag', async (t) => {
  const home = newHome(t, { pages: { 1: { cards: [card(92, { unlockedPrev: false, neverUnlocked: false })] }, 2: { cards: [] } } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(db(r.calls).includes('add 92'));
  assert.strictEqual(h.queueOf(home).candidates.length, 1);
});

test('five unlock failures in a row stop the run as incomplete with a warning alert; a success resets the streak', async (t) => {
  const cards = [93, 94, 95, 96, 97, 98].map((i) => card(i));
  const fail = { success: false, error: 'HTTP 429' };
  const unlock = { 93: fail, 94: fail, 95: fail, 96: fail, 97: fail };
  const home = newHome(t, { pages: { 1: { cards }, 2: { cards: [] } }, unlock });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.ok(r.stdout.includes('STOPPING Phase 1: 5 consecutive unlock failures'));
  assert.deepStrictEqual(callsOf(r.calls, 'caterer-unlock').map((c) => c.id), ['93', '94', '95', '96', '97'], 'the sixth card is not tried');
  const status = latestStatus(home);
  assert.strictEqual(status.incomplete, 'unlock-failing');
  assert.strictEqual(status.errors, 5);
  assert.strictEqual(alerts(home).filter((x) => x.key === 'phase1-unlock-failing').length, 1);
  assert.strictEqual(callsOf(r.calls, 'process-approved-queue').length, 0);

  const mixed = newHome(t, { pages: { 1: { cards: [93, 94, 95, 96, 97, 98].map((i) => card(i)) }, 2: { cards: [] } }, unlock: { 93: fail, 94: fail, 95: fail, 96: fail, 98: fail } });
  const r2 = await h.runPhase1(mixed, h.baseArgs());
  assert.ok(!r2.stdout.includes('STOPPING Phase 1: 5 consecutive unlock failures'));
  assert.ok(!latestStatus(mixed).incomplete);
});

test('the same candidate is never queued or unlocked twice after a resume', async (t) => {
  const home = newHome(t, { pages: { 1: { cards: [card(801), card(802)] }, 2: { cards: [] } } });
  const ts = '2026-09-29-111100';
  const rec = { id: '801', name: 'Rec One', firstName: 'Rec', lastName: 'One', email: 'r@example.invalid', phone: '', currentTitle: 'Chef', currentEmployer: '', city: 'Leeds', postcode: 'LS1 1AA', state: '', experience: 1, encId: 'e', auditId: 'a', cvUrl: '/cv' };
  fs.writeFileSync(path.join(home, 'downloads', `approved-queue-${ts}.json`), JSON.stringify({ searchDate: null, jobTitle: 'Chef', location: 'LS29', source: 'caterer', candidates: [rec, Object.assign({}, rec)] }));
  const r = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_RUN_TIMESTAMP: ts } });
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(h.queueOf(home).candidates.map((c) => c.id), ['801', '802']);
  assert.deepStrictEqual(callsOf(r.calls, 'caterer-unlock').map((c) => c.id), ['802'], 'the checkpointed candidate is not unlocked again');
  assert.ok(db(r.calls).includes('add 801'), 'the database catches up for the checkpointed candidate');
});

// ------------------------------------------------------------ status heartbeat, session, privacy

test('the status file keeps moving through a long unlock loop (so the ghost cull never mistakes it for a dead run)', async (t) => {
  const cards = [201, 202, 203].map((i) => card(i));
  const home = newHome(t, { pages: { 1: { cards }, 2: { cards: [] } } });
  const seen = new Set();
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      const s = fs.existsSync(path.join(home, 'runs')) ? fs.readdirSync(path.join(home, 'runs')).filter((f) => /^phase1-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(f)) : [];
      for (const f of s) {
        try { const d = h.readJson(path.join(home, 'runs', f)); if (d.status === 'phase1_running') seen.add(d.updatedAt); } catch (e) { /* mid-write */ }
      }
      await new Promise((res) => setTimeout(res, 15));
    }
  })();
  const r = await h.runPhase1(home, h.baseArgs(), { env: { PHASE1_UNLOCK_PAUSE_MS: '400' } });
  stop = true;
  await poll;
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(seen.size >= 4, `updatedAt changed ${seen.size} times while phase1_running`);
});

test('the device-verification page counts as a logged-out browser: exit 2 after the one re-login', async (t) => {
  const home = newHome(t, { pages: okPages, session: { cookieValid: true, browserOnLogin: false, urlFromCall: { 1: 'https://recruiter.caterer.com/Account/Unauthenticated/SafeListLoginBlocked', 2: 'https://recruiter.caterer.com/Account/Unauthenticated/SafeListLoginBlocked' } } });
  const r = await h.runPhase1(home, h.baseArgs());
  assert.strictEqual(r.code, 2, r.stdout);
  assert.ok(r.stdout.includes('SESSION_STALE'));
  assert.strictEqual(callsOf(r.calls, 'agent-browser').filter((c) => c.cmd === 'open').length, 0);
});

test('post-unlock review sends snippet, title and first name on stdin, never on the command line', async (t) => {
  const home = newHome(t, { pages: { 1: { cards: [card(301, { name: 'Zoltan' })] }, 2: { cards: [] } } });
  const r = await h.runPhase1(home, h.baseArgs());
  const single = callsOf(r.calls, 'ai-review').find((c) => c.mode === 'single');
  assert.strictEqual(single.viaStdin, true);
  assert.strictEqual(single.argvHasSnippet, false);
  assert.strictEqual(single.name, 'Zoltan');
  assert.ok(single.snippet.includes('Sous Chef'));
});

test('logs never carry card JSON or unlocked-candidate output when a parse fails', async (t) => {
  const card1 = JSON.stringify([{ id: '9', name: 'Zed', snippet: 'Secret Snippet Text Here' }]).slice(0, -3);
  const a = newHome(t, { pages: { 1: { rawEval: card1 } } });
  const r = await h.runPhase1(a, h.baseArgs(['--max-pages', '1']));
  assert.ok(!r.stdout.includes('Secret Snippet'), 'card text stays out of the console');
  assert.ok(r.stdout.includes('card-like JSON not logged'));
  const b = newHome(t, { pages: { 1: { cards: [card(401)] }, 2: { cards: [] } }, unlock: { 401: { __raw: '{"success": true, "email": "leak@example.invalid", "name": "Leak Person"', __exit: 0 } } });
  const r2 = await h.runPhase1(b, h.baseArgs());
  assert.ok(r2.stdout.includes('UNLOCK PARSE ERROR:'));
  assert.ok(!r2.stdout.includes('leak@example.invalid') && !r2.stdout.includes('Leak Person'));
});
