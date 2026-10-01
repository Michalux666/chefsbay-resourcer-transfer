'use strict';
// R4 (Caterer): the PROOF that clearing the rejection rows makes a candidate come up for screening again, and that a candidate whose row was NOT cleared is still
// skipped. The real phase 1 (scripts/phase1.js, dedupePage -> candidates-db.js check-batch-scoped) runs twice against the real candidates-db.js CLI on a real
// SQLite file; only the Caterer site, the unlock and the screening call are fakes (tests/phase1/fakes). The tool runs between the two runs.
//
// What the Caterer path skips on, traced in resourcer/scripts/phase1/dedupe.js and candidates-db.js checkCandidatesBatchScoped: a candidate with candidates.unlocked = 1
// (never re-pay) and a candidate with a candidate_rejections row for THIS job title or the '*' sentinel. NOTHING else: a seen-only candidates row (unlocked 0) does not skip.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ph = require('../phase1/harness');
const H = require('./helpers');

function findSqliteDir() {
  const dirs = [];
  if (process.env.P1_BETTER_SQLITE3_DIR) dirs.push(process.env.P1_BETTER_SQLITE3_DIR);
  try {
    const p = require.resolve('better-sqlite3', { paths: [path.join(ph.REPO, 'resourcer'), ph.REPO] });
    dirs.push(path.resolve(path.dirname(p), '..', '..'));
  } catch (e) { /* not installed in the repo */ }
  for (const d of dirs) {
    try { const D = require(path.join(d, 'better-sqlite3')); new D(':memory:').close(); return d; } catch (e) { /* try the next */ }
  }
  return null;
}
const SQLITE_DIR = findSqliteDir();
const skip = SQLITE_DIR ? false : 'better-sqlite3 is not available (set P1_BETTER_SQLITE3_DIR to a node_modules directory)';
const env = () => ({ NODE_PATH: SQLITE_DIR });
const { card } = ph;

async function cli(home, args) {
  const { spawnSync } = require('child_process');
  return spawnSync(process.execPath, [path.join(home, 'candidates-db.js')].concat(args), { env: Object.assign({}, process.env, env(), { RESOURCER_HOME: home }), encoding: 'utf8', cwd: home });
}
const skipped = async (home, ids, title) => JSON.parse((await cli(home, ['check-batch-scoped', ids.join(','), title])).stdout.trim()).inDb.sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// phase 2 of the run is over: the status file of a finished run no longer holds the pipeline lock (a phase1_complete file keeps it until phase 2 has marked it done)
const finishRuns = (home) => {
  for (const f of fs.readdirSync(path.join(home, 'runs')).filter((n) => /^phase1-.*.json$/.test(n))) {
    const file = path.join(home, 'runs', f);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...d, status: 'complete', phase2Status: 'done' }));
  }
};
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

test('R4 Caterer: after the clear, a cleared candidate is screened again (and approved by the new answers); an injection card, a Jev reject and an unlocked candidate keep being skipped', { skip }, async (t) => {
  const sc = {
    pages: { 1: { cards: [card(101), card(102), card(103), card(104), card(105), card(106)] }, 2: { cards: [] } },
    ai: { batch: [
      { outcome: 'ok', overrides: { 102: { approved: false, reason: 'Uncertain' }, 103: { approved: false, reason: 'Uncertain' }, 105: { approved: false, reason: 'Instruction' }, 106: { approved: false, reason: 'Jev reject' } } },
      { outcome: 'ok' }, // the second run: the new criteria approve whoever is screened
    ] },
  };
  const home = ph.makeHome(sc, { real: ['run-lock'] });
  t.after(() => ph.cleanup(home));
  fs.copyFileSync(path.join(ph.SRC, 'candidates-db.js'), path.join(home, 'candidates-db.js'));

  // run 1 under "Update A": 102 and 103 policy-rejected as uncertain, 105 an injection card, 106 rejected by Jev itself; 101 and 104 approved and unlocked
  const r1 = await ph.runPhase1(home, ph.baseArgs(), { env: env() });
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  const runId = r1.calls.find((c) => c.tool === 'ai-review' && c.mode === 'batch').runId;
  assert.match(runId, /^phase1-\d{4}-\d{2}-\d{2}-\d{6}$/);
  const inDb = (sql, ...a) => { const D = require(path.join(SQLITE_DIR, 'better-sqlite3')); const db = new D(path.join(home, 'candidates.db'), { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
  assert.deepEqual(inDb("SELECT caterer_id FROM candidate_rejections WHERE job_title = 'Chef' AND origin = 'pipeline' ORDER BY 1").map((x) => x.caterer_id), [102, 103, 105, 106]);
  const t0 = new Date().toISOString();
  const rows = [
    H.row('update-a', 'uncertain_ambiguous', { candidateId: '102', ts: t0, runId, jobTitle: 'Chef' }),
    H.row('update-a', 'uncertain_x', { candidateId: '103', ts: t0, runId, jobTitle: 'Chef' }),
    H.row('update-a', 'injection_keyword', { candidateId: '105', ts: t0, runId, jobTitle: 'Chef' }),
    H.row('update-a', 'jev_reject', { candidateId: '106', ts: t0, runId, jobTitle: 'Chef' }),
    H.row('update-a', 'jev_approve', { candidateId: '101', ts: t0, runId, jobTitle: 'Chef' }),
    H.row('update-a', 'jev_approve', { candidateId: '104', ts: t0, runId, jobTitle: 'Chef' }),
  ];
  fs.mkdirSync(path.join(home, 'shadow'), { recursive: true });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  fs.writeFileSync(path.join(home, 'shadow', `screening-${day}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });

  // BEFORE: everything the pipeline touched is skipped for this title (the unlocked ones, and every rejected one)
  assert.deepEqual(await skipped(home, [101, 102, 103, 104, 105, 106], 'Chef'), [101, 102, 103, 104, 105, 106]);
  // the seen-only candidates row of 102 and 103 does NOT skip them (candidates.unlocked = 0): only the rejection rows do
  assert.deepEqual(inDb('SELECT caterer_id, unlocked FROM candidates WHERE caterer_id IN (102, 103) ORDER BY 1'), [{ caterer_id: 102, unlocked: 0 }, { caterer_id: 103, unlocked: 0 }]);

  // the tool (the real busy predicate, a real backup, the real candidates-db.js file)
  const io = (lines) => ({ out: (s) => lines.push(s), err: (s) => lines.push(s), env: { RESOURCER_HOME: home, RESOURCER_SOURCES: 'caterer' }, backup: { log2n: 12 } });
  const lines = [];
  assert.equal(await H.tool.main(['--home', home, '--since', yesterday(), '--json'], io(lines)), 0, lines.join('\n'));
  const dry = JSON.parse(lines.join('\n')).dryRun;
  assert.equal(dry.eligible.rowsToDelete, 2, 'only 102 and 103: not the injection card, not the Jev reject, not the unlocked ones');
  assert.equal(dry.preUnlockByKind.policy_injection_reject, 1);
  const lines2 = [];
  assert.equal(await H.tool.main(['--home', home, '--since', yesterday(), '--apply', '--confirm', '2'], io(lines2)), 0, lines2.join('\n'));
  assert.match(lines2.join('\n'), /deleted 2 rows in one transaction/);

  // AFTER: the cleared ones are no longer skipped; the injection card, the Jev reject and the unlocked ones still are
  assert.deepEqual(await skipped(home, [101, 102, 103, 104, 105, 106], 'Chef'), [101, 104, 105, 106]);
  assert.deepEqual(await skipped(home, [102, 103], 'Chef'), [], 'nothing else skips them');

  // run 2: the real phase 1 passes exactly the cleared candidates to screening
  finishRuns(home);
  await sleep(1200); // a new run stamp
  const before = r1.calls.length;
  const r2 = await ph.runPhase1(home, ph.baseArgs(), { env: env() });
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  const batches = r2.calls.slice(before).filter((c) => c.tool === 'ai-review' && c.mode === 'batch');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].ids.slice().sort(), ['102', '103'], 'the cleared candidates are screened again, nobody else');
  assert.equal((r2.stdout.match(/SKIP \(in DB\)/g) || []).length, 4, '101, 104 (unlocked), 105 (injection) and 106 (Jev reject) are still skipped');
  assert.deepEqual(inDb('SELECT caterer_id, unlocked FROM candidates WHERE caterer_id IN (102, 103) ORDER BY 1'), [{ caterer_id: 102, unlocked: 1 }, { caterer_id: 103, unlocked: 1 }], 'the new criteria approved and unlocked them');
  assert.deepEqual(inDb("SELECT caterer_id FROM candidate_rejections WHERE job_title = 'Chef' ORDER BY 1").map((x) => x.caterer_id), [105, 106], 'no new rejection was booked for them');
});

test('R4 Caterer: a candidate that Jev REJECTS when it is screened again is rejected afresh (a new row), never lost, and never screened a third time', { skip }, async (t) => {
  const sc = { pages: { 1: { cards: [card(201), card(202)] }, 2: { cards: [] } }, ai: { batch: [
    { outcome: 'ok', overrides: { 201: { approved: false, reason: 'Uncertain' }, 202: { approved: false, reason: 'Uncertain' } } },
    { outcome: 'ok', overrides: { 201: { approved: false, reason: 'Clear mismatch' } } }, // the new criteria reject 201 for real and approve 202
    { outcome: 'ok' },
  ] } };
  const home = ph.makeHome(sc, { real: ['run-lock'] });
  t.after(() => ph.cleanup(home));
  fs.copyFileSync(path.join(ph.SRC, 'candidates-db.js'), path.join(home, 'candidates-db.js'));
  const r1 = await ph.runPhase1(home, ph.baseArgs(), { env: env() });
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  const runId = r1.calls.find((c) => c.tool === 'ai-review' && c.mode === 'batch').runId;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  fs.mkdirSync(path.join(home, 'shadow'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(home, 'shadow', `screening-${day}.jsonl`), `${['201', '202'].map((id) => JSON.stringify(H.row('update-a', 'uncertain_ambiguous', { candidateId: id, ts, runId, jobTitle: 'Chef' }))).join('\n')}\n`, { mode: 0o600 });
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { RESOURCER_HOME: home, RESOURCER_SOURCES: 'caterer' }, backup: { log2n: 12 } };
  assert.equal(await H.tool.main(['--home', home, '--since', yesterday(), '--apply', '--confirm', '2'], io), 0, lines.join('\n'));
  finishRuns(home);
  await sleep(1200);
  const before = r1.calls.length;
  const r2 = await ph.runPhase1(home, ph.baseArgs(), { env: env() });
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.deepEqual(r2.calls.slice(before).filter((c) => c.mode === 'batch')[0].ids.slice().sort(), ['201', '202']);
  const D = require(path.join(SQLITE_DIR, 'better-sqlite3'));
  const db = new D(path.join(home, 'candidates.db'), { readonly: true });
  try {
    assert.deepEqual(db.prepare("SELECT caterer_id, origin FROM candidate_rejections WHERE job_title = 'Chef' ORDER BY 1").all(), [{ caterer_id: 201, origin: 'pipeline' }], '201 was rejected again, by the new criteria');
  } finally { db.close(); }
  finishRuns(home);
  await sleep(1200);
  const mid = r2.calls.length;
  const r3 = await ph.runPhase1(home, ph.baseArgs(), { env: env() });
  assert.equal(r3.code, 0, r3.stdout + r3.stderr);
  assert.equal(r3.calls.slice(mid).filter((c) => c.mode === 'batch').length, 0, 'everyone is skipped now: nobody is screened a third time');
});
