#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const HELP = [
  'screening-operating-point.js - the trade-off curve of the one screening operating point (decision.operatingPoint.rejectAt).',
  '',
  'Usage: node tools/screening-operating-point.js --rows <file.jsonl> [--stage 1|2] [--criteria <file>] [--values 0.5,0.6,...]',
  '                                              [--cost-wasted N] [--cost-lost N] [--tolerance N] [--json]',
  '',
  '  --rows       JSON lines, one per labelled card: {"answers":{...compact Jev answers...},"searchRole":"Chef","stage":1,"verdict":"approve|reject"}',
  '               the answers are the ones the shadow log stores; the verdict is a recruiter decision (the adjudication sheet), never Jev\'s own',
  '  --criteria   the criteria file to decide with (default: the packaged config/screening-criteria.json)',
  '  --cost-*     what a wasted credit and a lost candidate cost (default: the values in the criteria file)',
  '  --tolerance  bars whose cost is within this of the cheapest count as tied; the tie goes to the bar nearest costLost / (costLost + costWasted)',
  '',
  'It prints, for every bar, how many cards are approved, rejected, sent to the fallback lane, carry the forced marker, and how many wrong',
  'rejects (lost) and wrong approves (wasted) there are, with the weighted cost. It never writes a file: set the chosen number yourself.',
  'Exit codes: 0 ok, 1 usage or input error.',
].join('\n');

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') o.help = true;
    else if (t === '--json') o.json = true;
    else if (t.startsWith('--') && i + 1 < argv.length) { o[t.slice(2)] = argv[i + 1]; i++; } else throw new Error(`unknown or incomplete option ${t.slice(0, 20)}`);
  }
  return o;
}

function loadLib() {
  const home = path.resolve(__dirname, '..', 'resourcer');
  const dir = path.join(home, 'scripts', 'lib', 'screening');
  return { op: require(path.join(dir, 'operating-point')), criteria: require(path.join(dir, 'criteria')), config: require(path.join(dir, 'config')) };
}

function readRows(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r || typeof r.answers !== 'object' || !['approve', 'reject'].includes(r.verdict) || typeof r.searchRole !== 'string') throw new Error('a row needs answers, searchRole and a verdict of approve or reject');
    rows.push(r);
  }
  return rows;
}

function pct(a, b) { return b ? `${(100 * a / b).toFixed(1)}%` : 'n/a'; }

function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`${e.message}\n${HELP}\n`); return 1; }
  if (o.help) { process.stdout.write(`${HELP}\n`); return 0; }
  if (!o.rows) { process.stderr.write(`--rows is required\n${HELP}\n`); return 1; }
  try {
    const lib = loadLib();
    const loaded = lib.criteria.load(o.criteria ? { file: path.resolve(o.criteria) } : {});
    if (!loaded.ok || loaded.decisionErrors.length) throw new Error(`criteria unusable: ${(loaded.ok ? loaded.decisionErrors : loaded.errors).join('; ')}`);
    const cfg = lib.config.load({ getEnv: () => undefined, file: 'none.json' });
    const stage = o.stage === '2' ? 2 : 1;
    const own = loaded.criteria.decision.operatingPoint[stage === 2 ? 'stage2' : 'stage1'];
    const weights = { costWastedCredit: o['cost-wasted'] === undefined ? own.costWastedCredit : Number(o['cost-wasted']), costLostCandidate: o['cost-lost'] === undefined ? own.costLostCandidate : Number(o['cost-lost']) };
    const values = o.values ? o.values.split(',').map(Number) : undefined;
    const rows = readRows(path.resolve(o.rows));
    const table = lib.op.sweep({ rows, criteria: loaded.criteria, cfg, weights, values, stage });
    const best = lib.op.pick(table, weights, o.tolerance === undefined ? 0 : Number(o.tolerance));
    if (o.json) { process.stdout.write(`${JSON.stringify({ stage, weights, table, suggested: best.rejectAt, current: own.rejectAt })}\n`); return 0; }
    const out = [`stage ${stage}: ${table[0] ? table[0].n : 0} labelled cards; a wasted credit costs ${weights.costWastedCredit}, a lost candidate ${weights.costLostCandidate}; implied bar ${lib.op.impliedBar(weights).toFixed(2)}; current rejectAt ${own.rejectAt}`];
    out.push('rejectAt | approve | reject | fallback | forced | lost | wasted | cost | agree');
    for (const t of table) out.push(`${String(t.rejectAt).padEnd(8)} | ${String(t.approve).padStart(7)} | ${String(t.reject).padStart(6)} | ${String(t.fallback).padStart(8)} | ${String(t.forced).padStart(6)} | ${String(t.lost).padStart(4)} | ${String(t.wasted).padStart(6)} | ${String(t.cost).padStart(4)} | ${pct(t.agree, t.n - t.fallback)}`);
    out.push(`cheapest bar (ties go to the bar nearest the implied one): ${best.rejectAt}`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${String(e && e.message).split('\n')[0].slice(0, 200)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parse, readRows };
