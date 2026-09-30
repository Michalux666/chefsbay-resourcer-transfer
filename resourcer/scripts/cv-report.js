#!/usr/bin/env node
/**
 * cv-report.js - reads shadow/cv-*.jsonl and prints the numbers the owner watches: who decided (the Jev-decided share must stay at
 * 99 percent or more, the fallback share at 1 percent or less), the reject rate and its reasons, the forced decisions (the ones to
 * audit each week), and what a different operating point would have done to the same CVs (every row keeps its pReject).
 *
 *   node scripts/cv-report.js [--days N] [--from YYYY-MM-DD] [--mode on|shadow|cli] [--forced] [--rejects] [--json]
 *   --days N       the last N days (default 7)      --from  start at a date (Europe/London day, overrides --days)
 *   --mode M       only rows written in that CV_SCREEN mode (on, shadow) or by the command line (cli)
 *   --forced       list every forced decision (candidate id, search, decision, confidence, reason codes), lowest confidence first
 *   --rejects      list every decision that rejects (in shadow mode: would reject), for the recruiter panel that checks them
 *   --json         one JSON object instead of the text report
 * The SWITCH-ON CHECK block compares the numbers with the acceptance for moving CV_SCREEN from shadow to on (docs/CV-SCREENING.md,
 * "Operating it"). Rows hold numbers and codes only (no CV text); the candidate id is the platform's pseudonymous number.
 * Exit 0, or 1 on a usage error.
 */
'use strict';

const shadow = require('./lib/cv/shadow');
const config = require('./lib/cv/config');
const { applyOperatingPoint } = require('./lib/cv/gate');

const pct = (k, n) => (n ? Math.round((k / n) * 1000) / 10 : 0);
const USAGE = 'Usage: node scripts/cv-report.js [--days N] [--from YYYY-MM-DD] [--mode on|shadow|cli] [--forced] [--rejects] [--json]\n';

// The acceptance for switching shadow to on. Advisory: the two recruiter-panel checks are done by people, not by this script.
const ACCEPT = { minCvs: 300, jevShare: 99, fallbackShare: 1, unreadableMax: 12, rejectMin: 1, rejectMax: 5 };

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    if (['forced', 'rejects', 'json', 'help'].includes(key)) a[key] = true;
    else { a[key] = argv[i + 1]; i++; }
  }
  return a;
}

/** @param {object[]} rows shadow rows  @param {{tau:number, forced:{low:number,high:number}}} o */
function summarize(rows, o) {
  const lanes = { jev: 0, facts: 0, fallback: 0, unreadable: 0 };
  const codes = {};
  const byJob = {};
  let rejected = 0;
  let forced = 0;
  let forcedRejected = 0;
  let noHistory = 0;
  for (const r of rows) {
    lanes[r.lane] = (lanes[r.lane] || 0) + 1;
    if (r.final === 'reject') rejected++;
    if (r.lane === 'unreadable' && (r.finalReasonCodes || []).includes('unreadable_no_work_history')) noHistory++;
    if (r.forced) { forced++; if (r.final === 'reject') forcedRejected++; }
    for (const c of r.finalReasonCodes || []) codes[c] = (codes[c] || 0) + 1;
    const j = (byJob[r.jobTitle || '?'] = byJob[r.jobTitle || '?'] || { n: 0, rejected: 0, forced: 0 });
    j.n++;
    if (r.final === 'reject') j.rejected++;
    if (r.forced) j.forced++;
  }
  const modelled = lanes.jev + lanes.facts + lanes.fallback;
  const sweep = [];
  const scored = rows.filter(r => (r.lane === 'jev' || r.lane === 'facts') && typeof r.pReject === 'number');
  for (let t = 5; t <= 95; t += 5) {
    const tau = t / 100;
    let rej = 0;
    for (const r of rows) {
      const act = (r.lane === 'jev' || r.lane === 'facts') && typeof r.pReject === 'number' ? (applyOperatingPoint(r.pReject, tau, o.forced).decision === 'reject' ? 'reject' : 'approve') : r.final;
      if (act === 'reject') rej++;
    }
    sweep.push({ tau, rejected: rej, rejectRate: pct(rej, rows.length) });
  }
  return {
    rows: rows.length, lanes, modelled, jevShare: pct(lanes.jev, modelled), fallbackShare: pct(lanes.fallback, modelled), factsShare: pct(lanes.facts, modelled),
    unreadableShare: pct(lanes.unreadable, rows.length), unreadableNoWorkHistory: noHistory, unreadableNotRead: lanes.unreadable - noHistory, jevShareAll: pct(lanes.jev, rows.length), rejected, rejectRate: pct(rejected, rows.length), forced, forcedShare: pct(forced, rows.length), forcedRejected,
    codes, byJob, sweep, scoredRows: scored.length, tau: o.tau,
  };
}

/**
 * The computed part of the switch-on acceptance (Jev-decided share of the CVs Jev received, fallback share, unreadable share, reject
 * rate, enough CVs). Nothing passes on an empty report.
 * @returns {{checks:{name:string, ok:boolean, value:string, want:string}[], numbersOk:boolean}}
 */
function acceptance(s) {
  const has = s.rows > 0;
  const one = (name, ok, value, want) => ({ name, ok: has && ok, value, want });
  const checks = [
    one('enough CVs', s.rows >= ACCEPT.minCvs, `${s.rows} screened`, `at least ${ACCEPT.minCvs}`),
    one('Jev-decided', s.modelled > 0 && s.jevShare >= ACCEPT.jevShare, `${s.jevShare}% of the ${s.modelled} CVs Jev received`, `${ACCEPT.jevShare}% or more`),
    one('fallback lane', s.modelled > 0 && s.fallbackShare <= ACCEPT.fallbackShare, `${s.fallbackShare}%`, `${ACCEPT.fallbackShare}% or less`),
    one('unreadable', s.unreadableShare <= ACCEPT.unreadableMax, `${s.unreadableShare}% of all CVs`, `about 5 to 8, at most ${ACCEPT.unreadableMax}`),
    one('reject rate', s.rejectRate >= ACCEPT.rejectMin && s.rejectRate <= ACCEPT.rejectMax, `${s.rejectRate}%`, `about 2 to 4, between ${ACCEPT.rejectMin} and ${ACCEPT.rejectMax}`),
  ];
  return { checks, numbersOk: checks.every(c => c.ok) };
}

const line = r => `  ${String(r.ts).slice(0, 10)} id ${String(r.candidateId)} ${String(r.jobTitle).padEnd(20)} ${String(r.final).padEnd(7)} confidence ${r.confidence} pReject ${r.pReject} ${(r.finalReasonCodes || []).join(',')}`;

function render(s, lists) {
  const L = lists || {};
  const out = [];
  out.push(`CV screening report: ${s.rows} screened CVs, operating point tau ${s.tau}`);
  out.push('');
  out.push('WHO DECIDED');
  out.push(`  Jev-decided     ${s.lanes.jev}   ${s.jevShare}% of the ${s.modelled} that needed a decision   ${s.modelled && s.jevShare < 99 ? 'BELOW the 99% the owner requires' : 'ok (99% or more)'}`);
  out.push(`  fallback lane   ${s.lanes.fallback}   ${s.fallbackShare}%   ${s.fallbackShare > 1 ? 'ABOVE the 1% the owner allows' : 'ok (1% or less)'}`);
  out.push(`  code only       ${s.lanes.facts}   ${s.factsShare}%   (a CV read with high confidence that lists no work history)`);
  out.push(`  unreadable      ${s.lanes.unreadable}   ${s.unreadableShare}% of all CVs (${s.unreadableNotRead} could not be read, ${s.unreadableNoWorkHistory} were read but no work history could be found); these pass through and are never counted against Jev`);
  out.push(`  Jev-decided of ALL ${s.rows} screened CVs: ${s.lanes.jev}, ${s.jevShareAll}% (the honest share if the CVs from which no work history could be found are counted too)`);
  out.push('');
  out.push('DECISIONS');
  out.push(`  rejected        ${s.rejected}   ${s.rejectRate}%   (in shadow mode: WOULD be rejected)`);
  out.push(`  forced          ${s.forced}   ${s.forcedShare}%   (decided in real doubt by the operating point; ${s.forcedRejected} of them rejected): audit these`);
  out.push('');
  const acc = acceptance(s);
  out.push('SWITCH-ON CHECK (shadow to on: the numbers are advisory, the two [people] lines are done by a recruiter panel)');
  for (const c of acc.checks) out.push(`  ${c.ok ? '[ok]      ' : '[NOT YET] '} ${c.name.padEnd(15)} ${c.value}   (want ${c.want})`);
  out.push(`  [people]   every decision that rejects (${s.rejected}) agreed by the panel: list them with --rejects`);
  out.push(`  [people]   the 30 lowest-confidence forced decisions (of ${s.forced}) agreed by the panel: the first 30 lines of --forced`);
  out.push(`  ${acc.numbersOk ? 'numbers OK: only the panel review is left' : 'numbers NOT YET OK: keep CV_SCREEN=shadow'}`);
  out.push('');
  out.push('REASON CODES');
  for (const [c, k] of Object.entries(s.codes).sort((a, b) => b[1] - a[1]).slice(0, 25)) out.push(`  ${c.padEnd(28)} ${k}`);
  out.push('');
  out.push('BY SEARCHED ROLE');
  for (const [j, v] of Object.entries(s.byJob).sort((a, b) => b[1].n - a[1].n).slice(0, 30)) out.push(`  ${j.padEnd(24)} ${String(v.n).padStart(4)} CVs  rejected ${String(v.rejected).padStart(3)} (${pct(v.rejected, v.n)}%)  forced ${v.forced}`);
  out.push('');
  out.push(`WHAT ANOTHER OPERATING POINT WOULD HAVE DONE (same CVs, stored numbers; * = the one in use; ${s.scoredRows} rows carry a pReject)`);
  for (const c of s.sweep) out.push(`  tau ${c.tau.toFixed(2)}${Math.abs(c.tau - s.tau) < 0.026 ? '*' : ' '} rejected ${String(c.rejected).padStart(5)}  ${String(c.rejectRate).padStart(5)}%`);
  if (L.forced) {
    out.push('');
    out.push('FORCED DECISIONS, LOWEST CONFIDENCE FIRST');
    for (const r of L.forced) out.push(line(r));
  }
  if (L.rejects) {
    out.push('');
    out.push('DECISIONS THAT REJECT (in shadow mode: WOULD reject), OLDEST FIRST');
    for (const r of L.rejects) out.push(line(r));
  }
  return `${out.join('\n')}\n`;
}

function main(argv, io) {
  const a = parseArgs(argv);
  const w = io || { out: s => process.stdout.write(s), err: s => process.stderr.write(s) };
  if (a.help) { w.err(USAGE); return 0; }
  const days = a.days === undefined ? 7 : Number(a.days);
  if (!Number.isFinite(days) || days <= 0 || (a.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.from))) || (a.mode !== undefined && !['on', 'shadow', 'cli'].includes(String(a.mode)))) {
    w.err(USAGE);
    return 1;
  }
  const since = a.from !== undefined ? Date.parse(`${a.from}T00:00:00Z`) : Date.now() - days * 86400000;
  let rows = shadow.readRows().filter(r => Date.parse(r.ts) >= since);
  if (a.mode !== undefined) rows = rows.filter(r => r.mode === a.mode);
  const cfg = config.load();
  const tau = rows.length && typeof rows[rows.length - 1].tau === 'number' ? rows[rows.length - 1].tau : cfg.tau;
  const s = summarize(rows, { tau, forced: cfg.forced });
  const forcedRows = rows.filter(r => r.forced).sort((x, y) => (x.confidence === null ? 1 : x.confidence) - (y.confidence === null ? 1 : y.confidence));
  const rejectRows = rows.filter(r => r.final === 'reject').sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  if (a.json) {
    const pick = r => ({ ts: r.ts, candidateId: r.candidateId, jobTitle: r.jobTitle, final: r.final, forced: !!r.forced, confidence: r.confidence, pReject: r.pReject, codes: r.finalReasonCodes });
    w.out(`${JSON.stringify({ ...s, acceptance: acceptance(s), forcedRows: a.forced ? forcedRows.map(pick) : undefined, rejectRows: a.rejects ? rejectRows.map(pick) : undefined })}\n`);
  } else {
    w.out(render(s, { forced: a.forced ? forcedRows : null, rejects: a.rejects ? rejectRows : null }));
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, summarize, render, parseArgs, acceptance, ACCEPT };
