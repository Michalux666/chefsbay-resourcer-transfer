'use strict';
// R4 (Reed): the PROOF for the Reed path, with the real reed-phase1.js against the fake Reed site and the real candidates-db.js (tests/reed/helpers).
//
// What the Reed path skips on, traced in resourcer/scripts/reed-phase1.js (the page loop, checkByReedId): a candidate with ANY row in candidates for that reed_id
// (seen or unlocked, any job title: there is no title scoping on Reed), nothing else. It never reads candidate_rejections, and it books a rejected card only as a
// seen row (seenReedCandidate). So clearing a Reed candidate means deleting that seen-only candidates row: the one place where the tool touches the candidates table,
// restricted to reed_id rows with unlocked 0, no Zoho id and source reed, ledgered and undoable, and only with --reed-seen.

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { withWorld } = require('../reed/helpers/world');
const { dep } = require('../reed/helpers/mirror');
const H = require('./helpers');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];
const aiLog = (m) => m.readLines('ai-log.jsonl');
const queue = (m, id) => m.readJson(`downloads/reed-approved-queue-${id}.json`);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function dbAll(m, sql, ...a) {
  const D = dep('better-sqlite3');
  const db = new D(m.p('candidates.db'), { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
}

test('R4 Reed: a rejected Reed card is skipped on a seen row only; after --reed-seen clears it the real reed-phase1 screens it again, and every other card is still skipped', () => world(async ({ m, run }) => {
  // run 1 under "Update A": 9002 policy-rejected as uncertain, 9013 an injection card, 9020 uncertain but unlocked since; all 30 cards end up seen
  const r1 = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002,9013,9020' } });
  assert.equal(r1.code, 0, r1.stderr + r1.stdout);
  assert.equal(aiLog(m).length, 2, 'run 1 screened the two pages of 30 cards in two calls');
  const seen = dbAll(m, 'SELECT reed_id, source, unlocked, zoho_id FROM candidates ORDER BY reed_id');
  assert.equal(seen.length, 30);
  assert.ok(seen.every((x) => x.source === 'reed' && x.unlocked === 0 && x.zoho_id === null));
  assert.equal(dbAll(m, "SELECT name FROM sqlite_master WHERE name = 'candidate_rejections'").length, 0, 'the Reed path books no candidate_rejections row at all');
  // 9020 was unlocked in the meantime
  const D = dep('better-sqlite3');
  const w = new D(m.p('candidates.db'));
  w.prepare('UPDATE candidates SET unlocked = 1 WHERE reed_id = 9020').run();
  w.close();
  const t0 = new Date().toISOString();
  fs.mkdirSync(m.p('shadow'), { recursive: true });
  const rows = [
    H.row('update-a', 'reed_uncertain', { candidateId: '9002', ts: t0, jobTitle: 'Chef' }),
    H.row('update-a', 'injection_keyword', { candidateId: '9013', ts: t0, jobTitle: 'Chef', source: 'reed', runId: null }),
    H.row('update-a', 'reed_uncertain', { candidateId: '9020', ts: t0, jobTitle: 'Chef' }),
  ];
  fs.writeFileSync(m.p('shadow', `screening-${day()}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });

  // run 2 BEFORE the clear: every card is in the DB, so nothing is screened
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(aiLog(m).length, 2, 'no further screening call: all 30 are skipped as already in the DB');
  assert.equal(queue(m, 't2').phase1Stats.inDb, 30);

  // the tool: without --reed-seen the Reed candidate is only counted
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { RESOURCER_HOME: m.home, RESOURCER_SOURCES: 'both' }, backup: { log2n: 12 } };
  assert.equal(await H.tool.main(['--home', m.home, '--since', yesterday(), '--json'], io), 0, lines.join('\n'));
  let dry = JSON.parse(lines.join('\n')).dryRun;
  assert.equal(dry.eligible.rowsToDelete, 0);
  assert.equal(dry.reedHeldBack, 1);
  assert.equal(dry.excluded.unlocked, 1, '9020 is unlocked now');
  lines.length = 0;
  assert.equal(await H.tool.main(['--home', m.home, '--since', yesterday(), '--reed-seen', '--json'], io), 0);
  dry = JSON.parse(lines.join('\n')).dryRun;
  assert.equal(dry.eligible.rowsToDelete, 1);
  assert.deepEqual(dry.eligible.bySource, { reed: { candidates: 1, rows: 1 } });
  lines.length = 0;
  assert.equal(await H.tool.main(['--home', m.home, '--since', yesterday(), '--reed-seen', '--apply', '--confirm', '1'], io), 0, lines.join('\n'));
  assert.deepEqual(dbAll(m, 'SELECT COUNT(*) c FROM candidates')[0], { c: 29 });
  assert.equal(dbAll(m, 'SELECT 1 FROM candidates WHERE reed_id = 9002').length, 0);

  // run 3 AFTER the clear (the new criteria approve whoever is screened): the real reed-phase1 passes exactly 9002 to screening
  await sleep(1100);
  const r3 = await run('reed-phase1.js', ARGS(['--run-id', 't3']));
  assert.equal(r3.code, 0, r3.stderr + r3.stdout);
  const calls = aiLog(m);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].ids.map(String), ['9002'], 'the cleared candidate is screened again, nobody else');
  assert.match(r3.stderr, /\[9013\] SKIP \(already in DB\)/, 'the injection card is still skipped');
  assert.match(r3.stderr, /\[9020\] SKIP \(already in DB\)/, 'the unlocked candidate is still skipped');
  assert.ok(!/\[9002\] SKIP/.test(r3.stderr));
  const q3 = queue(m, 't3');
  assert.equal(q3.phase1Stats.inDb, 29);
  assert.deepEqual(q3.candidates.map((c) => c.id), [9002], 'approved by the new answers and queued for the unlock');
  // the seen row is back (written by the run), so an undo of the ledger leaves it alone: the newer row wins
  const ledger = fs.readdirSync(m.p('runtime')).find((n) => /^rescreen-ledger-/.test(n));
  assert.ok(ledger);
  lines.length = 0;
  assert.equal(await H.tool.main(['--home', m.home, '--undo', ledger], io), 0, lines.join('\n'));
  assert.match(lines.join('\n'), /restored 0, already present 0, left alone because a newer row for the same candidate and job title exists 1/);
  assert.equal(dbAll(m, 'SELECT COUNT(*) c FROM candidates WHERE reed_id = 9002')[0].c, 1, 'one row, never a duplicate');
}));

test('R4 Reed: an undo before the next run puts the seen row back exactly, so the candidate is skipped again (nothing was lost)', () => world(async ({ m, run }) => {
  const r1 = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  assert.equal(r1.code, 0, r1.stderr);
  const before = dbAll(m, 'SELECT * FROM candidates ORDER BY id');
  fs.mkdirSync(m.p('shadow'), { recursive: true });
  fs.writeFileSync(m.p('shadow', `screening-${day()}.jsonl`), `${JSON.stringify(H.row('update-a', 'reed_uncertain', { candidateId: '9002', ts: new Date().toISOString(), jobTitle: 'Chef' }))}\n`, { mode: 0o600 });
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { RESOURCER_HOME: m.home, RESOURCER_SOURCES: 'both' }, backup: { log2n: 12 } };
  assert.equal(await H.tool.main(['--home', m.home, '--since', yesterday(), '--reed-seen', '--apply', '--confirm', '1'], io), 0, lines.join('\n'));
  const ledger = fs.readdirSync(m.p('runtime')).find((n) => /^rescreen-ledger-/.test(n));
  assert.equal(await H.tool.main(['--home', m.home, '--undo', ledger], io), 0, lines.join('\n'));
  assert.deepEqual(dbAll(m, 'SELECT * FROM candidates ORDER BY id'), before, 'every column of every row as before');
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.equal(r2.code, 0, r2.stderr);
  const callsAfterRun1 = 2;
  assert.equal(aiLog(m).length, callsAfterRun1, 'skipped again: no further screening call');
}));
