'use strict';
// tools/gold-rows.js: recruiter labels + the answers of the shadow log -> the rows of tools/screening-operating-point.js.
// The chain is tested end to end on a log the real engine wrote against the fake gateway.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const gold = require(path.join(h.REPO, 'tools', 'gold-rows.js'));
const GOLD = path.join(h.REPO, 'tools', 'gold-rows.js');
const OP = path.join(h.REPO, 'tools', 'screening-operating-point.js');

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); gw.setMode({ llm: 'restricted' }); });

const C = (snippet, id) => ({ id, name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}` });

async function writeLog() {
  const engine = screening.createEngine(screening.loadConfig({ overrides: { engine: 'jev_only', cache: { ttlSec: 0 } } }), { log: () => {} });
  await engine.screenBatch({ job: 'Chef', location: 'M1', distance: 20, source: 'caterer' }, [C('[[APPROVE]]', '101'), C('[[REJECT]]', '102'), C('[[LOWCONF]]', '103'), C('[[APPROVE]]', '104')]);
  await engine.screenBatch({ job: 'Sous Chef', location: 'M1', distance: 20, source: 'caterer' }, [C('[[APPROVE]]', '201'), C('[[REJECT]]', '202')]);
  return path.join(h.HOME, 'shadow');
}

function labelsFile(labels) {
  const f = path.join(h.HOME, `labels-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  fs.writeFileSync(f, labels.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('labelled cards become rows of numbers and the search title only; unsure, missing and older-set labels are counted, not used', async () => {
  const dir = await writeLog();
  const labels = labelsFile([
    { candidateId: '101', jobTitle: 'Chef', label: 'approve' },
    { candidateId: '102', jobTitle: 'Chef', label: 'reject' },
    { candidateId: '103', jobTitle: 'Chef', label: 'approve' },
    { candidateId: '104', jobTitle: 'Chef', label: 'unsure' },
    { candidateId: '201', jobTitle: 'Sous Chef', label: 'reject' },
    { candidateId: '999', jobTitle: 'Chef', label: 'approve' },
    { candidateId: '202', label: 'reject' },
    { candidateId: '105', jobTitle: 'Chef', label: null },
  ]);
  const out = path.join(h.HOME, 'gold.jsonl');
  const r = await h.runNode(GOLD, ['--labels', labels, '--dir', dir, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^5 labelled rows of 8 labels \(2 without an approve or reject verdict, 1 with no answers in the log, 0 log rows of an older question set skipped\)$/m);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(x => [x.searchRole, x.stage, x.verdict, x.source]), [['Chef', 1, 'approve', 'caterer'], ['Chef', 1, 'reject', 'caterer'], ['Chef', 1, 'approve', 'caterer'], ['Sous Chef', 1, 'reject', 'caterer'], ['Sous Chef', 1, 'reject', 'caterer']]);
  for (const x of rows) {
    assert.deepEqual(Object.keys(x).sort(), ['answers', 'searchRole', 'source', 'stage', 'verdict']);
    assert.ok(x.answers.role_level && x.answers.seniority && typeof x.answers.x_history_chars === 'number');
  }
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(!/Zed|Smith|Leeds|LS1|Test Kitchen|candidateId|"input"/.test(text), 'no card text, name or id in the rows');
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('the rows feed the operating-point tool: the curve is printed for the labelled cards and no file is written', async () => {
  const dir = await writeLog();
  const labels = labelsFile([
    { candidateId: '101', jobTitle: 'Chef', label: 'approve' }, { candidateId: '102', jobTitle: 'Chef', label: 'reject' },
    { candidateId: '103', jobTitle: 'Chef', label: 'approve' }, { candidateId: '104', jobTitle: 'Chef', label: 'approve' },
    { candidateId: '201', jobTitle: 'Sous Chef', label: 'approve' }, { candidateId: '202', jobTitle: 'Sous Chef', label: 'reject' },
  ]);
  const rowsFile = path.join(h.HOME, 'gold2.jsonl');
  assert.equal((await h.runNode(GOLD, ['--labels', labels, '--dir', dir, '--out', rowsFile])).code, 0);
  const before = fs.readdirSync(h.HOME).sort();
  const op = await h.runNode(OP, ['--rows', rowsFile]);
  assert.equal(op.code, 0, op.stderr);
  assert.match(op.stdout, /^stage 1: 6 labelled cards; a wasted credit costs 1, a lost candidate 3/m);
  assert.match(op.stdout, /rejectAt \| approve \| reject \| fallback \| forced \| lost \| wasted \| cost \| agree/);
  assert.match(op.stdout, /cheapest bar/);
  assert.deepEqual(fs.readdirSync(h.HOME).sort(), before, 'the tool writes nothing');
  const js = JSON.parse((await h.runNode(OP, ['--rows', rowsFile, '--json'])).stdout);
  assert.equal(js.table.length, 10);
  assert.equal(js.current, 0.7);
  assert.ok(js.table.every(t => t.fallback === 0), 'the forced choice: no card is left to a fallback at any bar');
});

test('the latest log row of a candidate and title wins, and rows of the older question set are counted and skipped', () => {
  const mk = (ts, role, extra) => ({ ts, candidateId: '7', jobTitle: 'Chef', source: 'caterer', jev: { status: 'ok', stage: 1, answers: { role_level: role, seniority: {} , ...(extra || {}) } } });
  const { out, stats } = gold.build([{ id: '7', job: 'Chef', label: 'reject' }], [
    mk('2026-09-01T10:00:00Z', { p: { chef_generic: 1 } }, { marker: 1 }),
    mk('2026-09-02T10:00:00Z', { p: { chef_generic: 1 } }, { marker: 2 }),
    { ts: '2026-09-03T10:00:00Z', candidateId: '7', jobTitle: 'Chef', source: 'caterer', jev: { status: 'ok', stage: 1, answers: { current_tier: { p: {} } } } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].answers.marker, 2);
  assert.equal(stats.oldSet, 1);
  const post = gold.build([{ id: '7', job: 'Chef', label: 'approve' }], [{ ts: 't', candidateId: '7', jobTitle: 'Chef', source: 'reed', jev: { status: 'ok', stage: 2, answers: { role_level: {} } } }]);
  assert.equal(post.out[0].stage, 2, 'a post-unlock row keeps its stage');
});

test('CLI contract: --help exits 0, a missing --labels or a bad file exits 1, standard output stays empty on failure', async () => {
  assert.equal((await h.runNode(GOLD, ['--help'])).code, 0);
  const none = await h.runNode(GOLD, []);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /--labels is required/);
  assert.equal(none.stdout, '');
  const bad = path.join(h.HOME, 'bad-labels.jsonl');
  fs.writeFileSync(bad, '{ not json\n');
  const b = await h.runNode(GOLD, ['--labels', bad]);
  assert.equal(b.code, 1);
  assert.equal(b.stdout, '');
  const noId = labelsFile([{ label: 'approve' }]);
  const n = await h.runNode(GOLD, ['--labels', noId]);
  assert.equal(n.code, 1);
  assert.match(n.stderr, /candidateId/);
  assert.equal((await h.runNode(GOLD, ['--labels', path.join(h.HOME, 'not-there.jsonl')])).code, 1);
  assert.equal((await h.runNode(GOLD, ['--bogus'])).code, 1);
  assert.equal((await h.runNode(GOLD, ['--labels', noId, '--since', 'lately'])).code, 1);
});
