'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const op = require(h.lib('screening/operating-point'));
const criteriaLib = require(h.lib('screening/criteria'));
const { A } = require('./criteria-answers');

const cfg = h.loadConfig('http://127.0.0.1:1');
const base = h.packaged();
const TOOL = path.join(h.ROOT, 'tools', 'screening-operating-point.js');

// a synthetic labelled set: strong fits the recruiters approve, clear mismatches they reject, and a doubtful middle that splits
function rows() {
  const out = [];
  const add = (n, fit, verdict) => { for (let i = 0; i < n; i++) out.push({ answers: A({ fit }), searchRole: 'Chef', stage: 1, verdict }); };
  add(30, 0.95, 'approve');
  add(20, 0.05, 'reject');
  add(12, 0.45, 'approve');
  add(4, 0.45, 'reject');
  add(6, 0.62, 'approve');
  add(6, 0.62, 'reject');
  add(2, 0.8, 'approve');
  add(6, 0.8, 'reject');
  return out;
}

test('the implied bar is costLost / (costLost + costWasted) and the cost is the weighted count of the two mistakes', () => {
  assert.equal(op.impliedBar({ costWastedCredit: 1, costLostCandidate: 3 }), 0.75);
  assert.equal(op.impliedBar({ costWastedCredit: 1, costLostCandidate: 1 }), 0.5);
  assert.equal(op.costOf({ wasted: 4, lost: 2 }, { costWastedCredit: 1, costLostCandidate: 3 }), 10);
});

test('the sweep re-decides every card at every bar: a higher bar approves more, never fewer, and counts the two mistakes', () => {
  const table = op.sweep({ rows: rows(), criteria: base, cfg, values: [0.3, 0.5, 0.7, 0.9, 1] });
  assert.equal(table.length, 5);
  for (let i = 1; i < table.length; i++) {
    assert.ok(table[i].approve >= table[i - 1].approve);
    assert.equal(table[i].approve + table[i].reject + table[i].fallback, table[i].n);
    assert.equal(table[i].agree + table[i].lost + table[i].wasted, table[i].n - table[i].fallback);
  }
  assert.ok(table[0].lost > table[4].lost, 'a low bar loses candidates');
  assert.ok(table[4].wasted > table[0].wasted, 'a high bar wastes credits');
  assert.ok(table[0].forced > 0);
});

test('the cheapest bar moves with the cost weights: dear lost candidates push the bar up', () => {
  const lowLost = op.sweep({ rows: rows(), criteria: base, cfg, weights: { costWastedCredit: 1, costLostCandidate: 1 } });
  const highLost = op.sweep({ rows: rows(), criteria: base, cfg, weights: { costWastedCredit: 1, costLostCandidate: 6 } });
  const a = op.pick(lowLost, { costWastedCredit: 1, costLostCandidate: 1 });
  const b = op.pick(highLost, { costWastedCredit: 1, costLostCandidate: 6 });
  assert.ok(b.rejectAt >= a.rejectAt, `${a.rejectAt} then ${b.rejectAt}`);
});

test('a tie between bars goes to the one nearest the implied bar', () => {
  const table = [{ rejectAt: 0.5, cost: 10 }, { rejectAt: 0.6, cost: 10 }, { rejectAt: 0.9, cost: 10 }, { rejectAt: 0.4, cost: 12 }];
  assert.equal(op.pick(table, { costWastedCredit: 1, costLostCandidate: 3 }).rejectAt, 0.6);
  assert.equal(op.pick(table, { costWastedCredit: 1, costLostCandidate: 3 }, 2).rejectAt, 0.6);
  assert.equal(op.pick([{ rejectAt: 0.4, cost: 9 }, { rejectAt: 0.75, cost: 10 }], { costWastedCredit: 1, costLostCandidate: 3 }).rejectAt, 0.4);
});

test('the sweep never changes the criteria object it was given', () => {
  const before = JSON.stringify(base);
  op.sweep({ rows: rows(), criteria: base, cfg });
  assert.equal(JSON.stringify(base), before);
});

test('the packaged bars agree with the weights they were fitted with', () => {
  for (const s of ['stage1', 'stage2']) {
    const o = base.decision.operatingPoint[s];
    assert.ok(o.rejectAt > 0 && o.rejectAt <= 1);
    assert.ok(o.costLostCandidate > o.costWastedCredit, `${s}: a lost candidate costs more than a wasted credit`);
  }
  assert.deepEqual(criteriaLib.validate(base).decisionErrors, []);
});

function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, RESOURCER_HOME: h.HOME } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('the tool: --help, a missing argument and a bad row are usage errors, a good file prints the curve and the cheapest bar', () => {
  assert.equal(cli(['--help']).code, 0);
  assert.match(cli(['--help']).out, /rejectAt/);
  assert.equal(cli([]).code, 1);
  assert.equal(cli(['--bogus']).code, 1);
  const bad = path.join(h.HOME, 'op-bad.jsonl');
  fs.writeFileSync(bad, '{"answers":{}}\n');
  const b = cli(['--rows', bad]);
  assert.equal(b.code, 1);
  assert.match(b.out, /needs answers, searchRole and a verdict/);
  const good = path.join(h.HOME, 'op-good.jsonl');
  fs.writeFileSync(good, rows().map(r => JSON.stringify(r)).join('\n') + '\n');
  const g = cli(['--rows', good, '--values', '0.5,0.7,0.9']);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /cheapest bar/);
  assert.match(g.out, /0\.7\s+\|/);
  const j = cli(['--rows', good, '--json']);
  const parsed = JSON.parse(j.out);
  assert.ok(Array.isArray(parsed.table) && typeof parsed.suggested === 'number' && parsed.current === base.decision.operatingPoint.stage1.rejectAt);
});

test('the tool refuses criteria that are unusable and writes nothing', () => {
  const f = path.join(h.HOME, 'op-badcrit.json');
  fs.writeFileSync(f, JSON.stringify({ version: 'x' }));
  const good = path.join(h.HOME, 'op-good2.jsonl');
  fs.writeFileSync(good, rows().map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = cli(['--rows', good, '--criteria', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /criteria unusable/);
});
