#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const HELP = [
  'gold-rows.js - joins recruiter labels with the answers the shadow log kept, for tools/screening-operating-point.js.',
  '',
  'Usage: node tools/gold-rows.js --labels <file.jsonl> [--dir <shadow dir>] [--since 180d|YYYY-MM-DD] [--out <rows.jsonl>]',
  '',
  '  --labels  JSON lines {"candidateId":"123","jobTitle":"Chef","label":"approve|reject"}: the file made by',
  '            tools/screening-report.js --export-sample and filled in by a recruiter (the same file --labels of the report reads);',
  '            a line with another label (a blank, "unsure") is skipped',
  '  --dir     the shadow log directory (default: shadow/ of the resourcer home)',
  '  --since   how far back to read the log (default 180d, the retention window)',
  '  --out     write the rows to this file (mode 0600); without it they go to standard output',
  '',
  'Each output row is {"answers":{...compact Jev answers and card facts...},"searchRole":"Chef","stage":1,"verdict":"approve|reject","source":"caterer"}:',
  'numbers and the search title only, never card text, name or id. Only rows written by the current question set are used (those with a',
  'role_level answer); a labelled row of an older set is counted and skipped. The verdict is the recruiter decision, never the system decision.',
  'Exit codes: 0 ok, 1 usage or input error.',
].join('\n');

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') o.help = true;
    else if (t.startsWith('--') && i + 1 < argv.length) { o[t.slice(2)] = argv[i + 1]; i++; } else throw new Error(`unknown or incomplete option ${t.slice(0, 20)}`);
  }
  return o;
}

function resolveShadow() {
  const marker = path.join('scripts', 'lib', 'screening', 'shadow.js');
  for (const home of [path.resolve(__dirname, '..', 'resourcer'), process.env.RESOURCER_HOME ? path.resolve(process.env.RESOURCER_HOME) : null].filter(Boolean)) {
    if (fs.existsSync(path.join(home, marker))) return require(path.join(home, 'scripts', 'lib', 'screening', 'shadow'));
  }
  throw new Error('cannot find the screening library');
}

function since(v) {
  const rel = /^(\d+)d$/.exec(v || '180d');
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86400000);
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error('--since is 14d or YYYY-MM-DD');
  return d;
}

function readLabels(file) {
  const labels = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const l = JSON.parse(line);
    if (!l || l.candidateId === undefined || l.candidateId === null) throw new Error('a label line needs a candidateId');
    labels.push({ id: String(l.candidateId), job: l.jobTitle === undefined || l.jobTitle === null ? '' : String(l.jobTitle), label: l.label });
  }
  return labels;
}

// the latest usable shadow row of every candidate and search title
function usableRows(rows) {
  const byKey = new Map();
  let old = 0;
  for (const r of rows) {
    if (!r.jev || r.jev.status !== 'ok' || !r.jev.answers) continue;
    if (!r.jev.answers.role_level) { old++; continue; }
    const key = `${r.candidateId}|${r.jobTitle}`;
    const prev = byKey.get(key);
    if (!prev || String(r.ts) >= String(prev.ts)) byKey.set(key, r);
  }
  return { byKey, old };
}

function build(labels, rows) {
  const { byKey, old } = usableRows(rows);
  const anyJob = new Map();
  for (const r of byKey.values()) if (!anyJob.has(r.candidateId)) anyJob.set(r.candidateId, r);
  const out = [];
  const stats = { labels: labels.length, unsure: 0, missing: 0, oldSet: old, used: 0 };
  for (const l of labels) {
    if (l.label !== 'approve' && l.label !== 'reject') { stats.unsure++; continue; }
    const r = l.job ? byKey.get(`${l.id}|${l.job}`) : anyJob.get(l.id);
    if (!r) { stats.missing++; continue; }
    out.push({ answers: r.jev.answers, searchRole: r.jobTitle, stage: r.jev.stage === 2 ? 2 : 1, verdict: l.label, source: r.source });
    stats.used++;
  }
  return { out, stats };
}

function main(argv, io) {
  const w = io || { out: s => process.stdout.write(s), err: s => process.stderr.write(s) };
  let o;
  try { o = parse(argv); } catch (e) { w.err(`${e.message}\n${HELP}\n`); return 1; }
  if (o.help) { w.out(`${HELP}\n`); return 0; }
  if (!o.labels) { w.err(`--labels is required\n${HELP}\n`); return 1; }
  try {
    const shadow = resolveShadow();
    const labels = readLabels(path.resolve(o.labels));
    const rows = shadow.readRows({ dir: o.dir ? path.resolve(o.dir) : undefined, since: since(o.since) });
    const { out, stats } = build(labels, rows);
    const text = out.map(r => JSON.stringify(r)).join('\n') + (out.length ? '\n' : '');
    if (o.out) fs.writeFileSync(path.resolve(o.out), text, { mode: 0o600 });
    else w.out(text);
    w.err(`${stats.used} labelled rows of ${stats.labels} labels (${stats.unsure} without an approve or reject verdict, ${stats.missing} with no answers in the log, ${stats.oldSet} log rows of an older question set skipped)\n`);
    return 0;
  } catch (e) {
    w.err(`${String(e && e.message).split('\n')[0].slice(0, 200)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parse, build, readLabels };
