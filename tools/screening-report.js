#!/usr/bin/env node
'use strict';
/**
 * screening-report.js - the calibration report for AI screening.
 *
 * Reads the shadow log (shadow/screening-YYYY-MM-DD.jsonl) and answers one question: is Jev, with the
 * thresholds in config/screening.json, safe to promote from jev_shadow to jev? It prints
 *   1. volume and coverage
 *   2. agreement Jev vs the deciding LLM, by Jev confidence band, with a reliability table
 *   3. approve rate by role and by source (LLM vs the promoted system)
 *   4. false-approve / false-reject estimates against the LLM (a proxy, NOT ground truth)
 *   5. a threshold sweep that re-runs decide() offline on the stored answers
 *   6. per-rule agreement for the stage-1 rules and their promotion check
 *   7. the go / no-go verdict against the gate (config.gate; see docs/SCREENING.md)
 *
 * Usage:
 *   node tools/screening-report.js [--dir <shadow dir>] [--since 14d|YYYY-MM-DD] [--until YYYY-MM-DD]
 *        [--source caterer|reed] [--stage pre_unlock|post_unlock] [--config <screening.json>]
 *        [--labels <file.jsonl>] [--json] [--strict]
 *        [--export-sample N [--seed S] [--out <file.jsonl>]]
 *   --strict  exit 0 = GO, 1 = NO-GO, 2 = INSUFFICIENT DATA (default exit code is 0)
 *   --export-sample  write N redacted inputs (no model answers) for recruiters to label; fill in the label field
 *            (approve|reject) and feed the file back with --labels
 *   --labels  JSONL of human labels: {"candidateId":"123","jobTitle":"Chef","label":"approve|reject"}
 *
 * Neither engine is ground truth. The numbers compare Jev with the LLM that currently decides.
 */

const fs = require('fs');
const path = require('path');

function resolveLib() {
  const marker = path.join('scripts', 'lib', 'screening', 'index.js');
  const candidates = [
    path.resolve(__dirname, '..', 'resourcer'),
    process.env.RESOURCER_HOME ? path.resolve(process.env.RESOURCER_HOME) : null,
    path.resolve(__dirname, '..'),
  ].filter(Boolean);
  for (const home of candidates) {
    if (fs.existsSync(path.join(home, marker))) return require(path.join(home, 'scripts', 'lib', 'screening'));
  }
  throw new Error('cannot find the screening library (looked in: ' + candidates.join(', ') + ')');
}

// ---------- statistics ----------

function wilson(k, n, z) {
  if (!n) return { lo: null, hi: null };
  const zz = z || 1.96;
  const p = k / n;
  const d = 1 + (zz * zz) / n;
  const c = p + (zz * zz) / (2 * n);
  const m = zz * Math.sqrt((p * (1 - p)) / n + (zz * zz) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

const pct = (k, n) => (n ? k / n : null);
const fmtPct = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const fmtNum = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));

// ---------- row helpers ----------

function derive(r) {
  const llmOk = !!(r.llm && r.llm.status === 'ok' && typeof r.llm.approved === 'boolean');
  const jevOk = !!(r.jev && r.jev.status === 'ok' && ['approve', 'reject', 'review'].includes(r.jev.lane));
  const lane = jevOk ? r.jev.lane : null;
  const ref = llmOk ? r.llm.approved : null;
  return {
    llmOk, jevOk, pair: llmOk && jevOk, lane, ref,
    conf: jevOk && typeof r.jev.confidence === 'number' ? r.jev.confidence : null,
    system: !jevOk || !llmOk ? null : (lane === 'approve' ? true : lane === 'reject' ? false : ref),
  };
}

function bandOf(conf, bands) {
  for (let i = 0; i < bands.length - 1; i++) if (conf >= bands[i] && conf < bands[i + 1]) return i;
  return bands.length - 2;
}

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Core comparison numbers over a set of rows (each already derived: {r, d}).
function compare(items) {
  const pairs = items.filter(x => x.d.pair);
  const decided = pairs.filter(x => x.d.lane !== 'review');
  const agree = decided.filter(x => (x.d.lane === 'approve') === x.d.ref).length;
  const fa = decided.filter(x => x.d.lane === 'approve' && x.d.ref === false).length;
  const fr = decided.filter(x => x.d.lane === 'reject' && x.d.ref === true).length;
  const systemAgree = pairs.filter(x => x.d.system === x.d.ref).length;
  const llmApprove = pairs.filter(x => x.d.ref === true).length;
  const sysApprove = pairs.filter(x => x.d.system === true).length;
  const jevApprove = decided.filter(x => x.d.lane === 'approve').length;
  const review = pairs.length - decided.length;
  const w = wilson(agree, decided.length);
  // Coverage from the Jev lanes of ALL rows with a Jev answer: in engine jev only ~5% of Jev-decided rows carry an LLM answer (audit).
  const jevRows = items.filter(x => x.d.jevOk);
  const jevDecidedRows = jevRows.filter(x => x.d.lane !== 'review').length;
  return {
    rows: items.length, pairs: pairs.length, decided: decided.length, review,
    reviewShare: pct(review, pairs.length),
    coverage: pct(decided.length, pairs.length),
    laneAgreement: pct(agree, decided.length), laneAgreementLo: w.lo,
    systemAgreement: pct(systemAgree, pairs.length),
    falseApprove: fa, falseReject: fr,
    falseApproveRate: pct(fa, pairs.length), falseRejectRate: pct(fr, pairs.length),
    falseApproveOfDecided: pct(fa, decided.length), falseRejectOfDecided: pct(fr, decided.length),
    falseRejectOfLlmApproved: pct(fr, llmApprove),
    jevRows: jevRows.length, laneCoverage: pct(jevDecidedRows, jevRows.length),
    llmApproveRate: pct(llmApprove, pairs.length),
    systemApproveRate: pct(sysApprove, pairs.length),
    approveDeltaPts: pairs.length ? (sysApprove - llmApprove) / pairs.length * 100 : null,
    jevApproveRateOfDecided: pct(jevApprove, decided.length),
  };
}

// ---------- analysis ----------

function withDecideOverrides(cfg, stage, over) {
  const c = JSON.parse(JSON.stringify(cfg));
  const key = stage === 2 ? 'stage2' : 'stage1';
  Object.assign(c.decide[key], over);
  return c;
}

function sweep(items, cfg, decideFn, stage) {
  const rejectPs = [0.8, 0.85, 0.9, 0.95, 0.99];
  const approvePs = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const rows = items.filter(x => x.d.llmOk && x.r.jev && x.r.jev.status === 'ok' && x.r.jev.answers && (x.r.jev.stage === 2 ? 2 : 1) === stage);
  const out = [];
  for (const rejectP of rejectPs) {
    for (const approveP of approvePs) {
      const c = withDecideOverrides(cfg, stage, { rejectP, approveP });
      const re = rows.map(x => {
        const dec = decideFn({ answers: x.r.jev.answers, searchRole: x.r.jobTitle, searchTier: x.r.searchTier, stage }, c);
        return { r: x.r, d: { llmOk: true, jevOk: true, pair: true, lane: dec.lane, ref: x.d.ref, conf: dec.confidence, system: dec.lane === 'approve' ? true : dec.lane === 'reject' ? false : x.d.ref } };
      });
      out.push({ rejectP, approveP, ...compare(re) });
    }
  }
  return { stage, rows: rows.length, grid: out };
}

// A lost candidate (Jev rejects, LLM approves) and a wasted credit (the reverse) are capped separately; they never offset each other.
function recommend(grid, gate) {
  const ok = grid.filter(g => g.pairs > 0
    && g.systemAgreement >= gate.minAgreement
    && (g.falseApproveRate === null || g.falseApproveRate <= gate.maxJevApproveLlmReject)
    && (g.falseRejectRate === null || g.falseRejectRate <= gate.maxJevRejectLlmApprove)
    && (g.falseRejectOfLlmApproved === null || g.falseRejectOfLlmApproved <= gate.maxJevRejectOfLlmApproved)
    && (g.decided === 0 || g.laneAgreementLo >= gate.minLaneAgreementLo)
    && g.coverage >= gate.minLaneCoverage
    && Math.abs(g.approveDeltaPts) <= gate.maxApprovalDeltaPoints);
  if (!ok.length) return null;
  ok.sort((a, b) => (b.coverage - a.coverage) || (b.laneAgreement - a.laneAgreement));
  return ok[0];
}

function ruleTable(rows, gate) {
  const by = new Map();
  for (const r of rows) {
    if (!r.rules || !r.rules.length) continue;
    const ref = r.llm && r.llm.status === 'ok' ? r.llm.approved : null;
    for (const h of r.rules) {
      if (!by.has(h.id)) by.set(h.id, { id: h.id, mode: h.mode, hits: 0, compared: 0, agree: 0, ruleRejectsLlmApproves: 0, hiConf: 0 });
      const t = by.get(h.id);
      t.mode = h.mode;
      t.hits++;
      if (ref === null) continue;
      t.compared++;
      const ruleApprove = h.decision === 'approve';
      if (ruleApprove === ref) t.agree++;
      if (!ruleApprove && ref === true) {
        t.ruleRejectsLlmApproves++;
        const jevHi = r.jev && r.jev.status === 'ok' && r.jev.lane === 'approve' && r.jev.confidence >= 0.8;
        const llmHi = typeof r.llm.confidence === 'number' && r.llm.confidence >= 0.8;
        if (jevHi || llmHi) t.hiConf++;
      }
    }
  }
  return [...by.values()].map(t => ({
    ...t,
    agreement: pct(t.agree, t.compared),
    promote: t.mode !== 'enforce' && t.compared >= gate.ruleMinHits && pct(t.agree, t.compared) >= gate.ruleMinAgreement && t.hiConf === 0,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function labelStats(rows, labels) {
  if (!labels || !labels.length) return null;
  const key = (id, job) => `${id}|${job || ''}`;
  const m = new Map();
  for (const l of labels) {
    m.set(key(l.candidateId, l.jobTitle), l.label);
    if (!l.jobTitle) m.set(key(l.candidateId, ''), l.label);
  }
  let n = 0; let jevRight = 0; let jevDecided = 0; let llmRight = 0; let llmN = 0; let sysRight = 0;
  for (const r of rows) {
    const lab = m.get(key(r.candidateId, r.jobTitle)) || m.get(key(r.candidateId, ''));
    if (!lab) continue;
    const d = derive(r);
    const truth = lab === 'approve';
    n++;
    if (d.llmOk) { llmN++; if (d.ref === truth) llmRight++; }
    if (d.jevOk && d.lane !== 'review') { jevDecided++; if ((d.lane === 'approve') === truth) jevRight++; }
    if (d.pair && d.system === truth) sysRight++;
  }
  return { matched: n, llmAccuracy: pct(llmRight, llmN), llmN, jevLaneAccuracy: pct(jevRight, jevDecided), jevDecided, systemAccuracy: pct(sysRight, n) };
}

/**
 * @param {object[]} rows shadow-log rows
 * @param {object} cfg    screening config (needs cfg.gate, cfg.decide)
 * @param {{decide:Function, labels?:object[]}} deps
 */
function analyze(rows, cfg, deps) {
  const gate = cfg.gate;
  const items = rows.map(r => ({ r, d: derive(r) }));
  const bands = gate.confidenceBands;

  const volume = {
    rows: rows.length,
    byMode: count(rows, r => r.mode),
    bySource: count(rows, r => r.source),
    byStage: count(rows, r => r.stage),
    byUsed: count(rows, r => (r.used ? r.used.engine : 'none')),
    llmModels: count(rows.filter(r => r.llm && r.llm.model), r => r.llm.model),
    jevModels: count(rows.filter(r => r.jev && r.jev.model), r => r.jev.model),
    jevStatus: count(rows.filter(r => r.jev), r => r.jev.status),
    llmStatus: count(rows.filter(r => r.llm), r => r.llm.status),
    withFlags: count(rows.flatMap(r => r.flags || []), f => f),
    rubricVersions: count(rows, r => r.rv),
    questionVersions: count(rows, r => r.qv),
    first: rows.length ? rows.map(r => r.ts).sort()[0] : null,
    last: rows.length ? rows.map(r => r.ts).sort().slice(-1)[0] : null,
  };

  const overall = compare(items);

  const confusion = { 'jev approve': { 'llm approve': 0, 'llm reject': 0 }, 'jev reject': { 'llm approve': 0, 'llm reject': 0 }, 'jev review': { 'llm approve': 0, 'llm reject': 0 } };
  for (const x of items.filter(i => i.d.pair)) confusion[`jev ${x.d.lane}`][x.d.ref ? 'llm approve' : 'llm reject']++;

  const byBand = [];
  const decided = items.filter(x => x.d.pair && x.d.lane !== 'review' && x.d.conf !== null);
  for (let i = 0; i < bands.length - 1; i++) {
    const inBand = decided.filter(x => bandOf(x.d.conf, bands) === i);
    if (!inBand.length) { byBand.push({ band: `${bands[i]}-${Math.min(1, bands[i + 1])}`, n: 0 }); continue; }
    const agree = inBand.filter(x => (x.d.lane === 'approve') === x.d.ref).length;
    const meanConf = inBand.reduce((s, x) => s + x.d.conf, 0) / inBand.length;
    const w = wilson(agree, inBand.length);
    byBand.push({ band: `${bands[i]}-${Math.min(1, bands[i + 1])}`, n: inBand.length, meanConfidence: meanConf, agreement: agree / inBand.length, agreementLo: w.lo, gap: agree / inBand.length - meanConf });
  }

  const cmpBy = keyFn => [...group(items, x => keyFn(x.r)).entries()].map(([k, v]) => ({ key: k, ...compare(v) })).sort((a, b) => b.pairs - a.pairs || String(a.key).localeCompare(String(b.key)));
  const bySource = cmpBy(r => r.source);
  const byStage = cmpBy(r => r.stage);
  const byRole = cmpBy(r => r.jobTitle);
  const byTier = cmpBy(r => `tier ${r.searchTier}`);

  const reasonPairs = new Map();
  for (const x of items.filter(i => i.d.pair && i.d.lane !== 'review' && (i.d.lane === 'approve') !== i.d.ref)) {
    const k = `${x.r.jev.reasonCode} (jev) vs ${x.r.llm.reasonCode} (llm)`;
    reasonPairs.set(k, (reasonPairs.get(k) || 0) + 1);
  }
  const topDisagreements = [...reasonPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ pair: k, n }));

  const sweeps = [];
  for (const stage of [1, 2]) {
    const s = sweep(items, cfg, deps.decide, stage);
    if (s.rows > 0) { s.recommended = recommend(s.grid, gate); sweeps.push(s); }
  }

  const rules = ruleTable(rows, gate);
  const labels = labelStats(rows, deps.labels);
  const verdict = verdictOf(bySource, byRole, cfg, overall);

  return { volume, overall, confusion, byBand, bySource, byStage, byRole, byTier, topDisagreements, sweeps, rules, labels, verdict, gate };
}

function count(arr, fn) {
  const o = {};
  for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

function verdictOf(bySource, byRole, cfg, overall) {
  const g = cfg.gate;
  const checks = [];
  const missing = [];
  let fail = false;

  const sources = bySource.filter(s => s.key === 'caterer' || s.key === 'reed');
  if (!sources.length) missing.push('no rows with both a Jev and an LLM answer');
  // The engine flip is global, so every required source must have been observed (gate.requiredSources scopes this on purpose).
  for (const want of g.requiredSources || []) {
    if (!sources.some(s => s.key === want)) {
      missing.push(`${want}: no compared rows at all, and the engine flip applies to ${want} too (scope it with gate.requiredSources if that is intended)`);
      checks.push({ name: `agreement (${want})`, status: 'insufficient', detail: 'no rows' });
    }
  }
  for (const s of sources) {
    if (s.pairs < g.minRowsPerSource) {
      missing.push(`${s.key}: ${s.pairs} compared rows, need ${g.minRowsPerSource}`);
      checks.push({ name: `agreement (${s.key})`, status: 'insufficient', detail: `${s.pairs} of ${g.minRowsPerSource} rows` });
      continue;
    }
    const okA = s.systemAgreement >= g.minAgreement;
    checks.push({ name: `agreement (${s.key})`, status: okA ? 'pass' : 'fail', detail: `${fmtPct(s.systemAgreement)} (gate >= ${fmtPct(g.minAgreement)}), Jev-lane agreement ${fmtPct(s.laneAgreement)}, review share ${fmtPct(s.reviewShare)}` });
    if (!okA) fail = true;
    const okF = s.falseApproveRate <= g.maxJevApproveLlmReject;
    checks.push({ name: `Jev approves / LLM rejects (${s.key})`, status: okF ? 'pass' : 'fail', detail: `${fmtPct(s.falseApproveRate)} (gate <= ${fmtPct(g.maxJevApproveLlmReject)})` });
    if (!okF) fail = true;
    const okR = s.falseRejectRate <= g.maxJevRejectLlmApprove;
    checks.push({ name: `Jev rejects / LLM approves (${s.key})`, status: okR ? 'pass' : 'fail', detail: `${fmtPct(s.falseRejectRate)} of compared cards (gate <= ${fmtPct(g.maxJevRejectLlmApprove)})` });
    if (!okR) fail = true;
    const okRA = s.falseRejectOfLlmApproved === null || s.falseRejectOfLlmApproved <= g.maxJevRejectOfLlmApproved;
    checks.push({ name: `lost share of LLM-approved cards (${s.key})`, status: okRA ? 'pass' : 'fail', detail: `${fmtPct(s.falseRejectOfLlmApproved)} (gate <= ${fmtPct(g.maxJevRejectOfLlmApproved)})` });
    if (!okRA) fail = true;
    if (s.decided === 0) {
      missing.push(`${s.key}: Jev decided no card outright, so its lanes cannot be judged`);
    } else {
      const okL = s.laneAgreementLo >= g.minLaneAgreementLo;
      checks.push({ name: `Jev-lane agreement lower bound (${s.key})`, status: okL ? 'pass' : 'fail', detail: `${fmtPct(s.laneAgreementLo)} at 95% confidence, n=${s.decided} (gate >= ${fmtPct(g.minLaneAgreementLo)})` });
      if (!okL) fail = true;
    }
    const okC = s.laneCoverage !== null && s.laneCoverage >= g.minLaneCoverage;
    checks.push({ name: `Jev decides on its own (${s.key})`, status: okC ? 'pass' : 'fail', detail: `${fmtPct(s.laneCoverage)} of Jev answers are approve/reject rather than review (gate >= ${fmtPct(g.minLaneCoverage)})` });
    if (!okC) fail = true;
  }
  const bigRoles = byRole.filter(r => r.pairs >= g.minRowsPerRole);
  const smallRoles = byRole.filter(r => r.pairs > 0 && r.pairs < g.minRowsPerRole);
  for (const r of bigRoles) {
    const ok = Math.abs(r.approveDeltaPts) <= g.maxApprovalDeltaPoints;
    checks.push({ name: `approval rate delta (${r.key})`, status: ok ? 'pass' : 'fail', detail: `${r.approveDeltaPts >= 0 ? '+' : ''}${r.approveDeltaPts.toFixed(1)} points (gate <= ${g.maxApprovalDeltaPoints}), n=${r.pairs}` });
    if (!ok) fail = true;
  }
  if (!bigRoles.length && sources.length) missing.push(`no role has ${g.minRowsPerRole}+ compared rows`);

  let status = 'GO';
  if (fail) status = 'NO-GO';
  else if (missing.length) status = 'INSUFFICIENT DATA';
  return { status, checks, missing, smallRoles: smallRoles.map(r => `${r.key} (n=${r.pairs})`), calibratedFlag: !!cfg.decide.calibration.calibrated, overallSystemAgreement: overall.systemAgreement };
}

// ---------- rendering ----------

function table(headers, rows) {
  const all = [headers, ...rows.map(r => r.map(c => (c === null || c === undefined ? '-' : String(c))))];
  const w = headers.map((_, i) => Math.max(...all.map(r => r[i].length)));
  return all.map((r, i) => r.map((c, j) => (j === 0 ? c.padEnd(w[j]) : c.padStart(w[j]))).join('  ') + (i === 0 ? '\n' + w.map(x => '-'.repeat(x)).join('  ') : '')).join('\n');
}

function render(a) {
  const out = [];
  const v = a.volume;
  out.push('SCREENING CALIBRATION REPORT');
  out.push(`rows: ${v.rows}   window: ${v.first || '-'} .. ${v.last || '-'}`);
  out.push(`modes: ${JSON.stringify(v.byMode)}   sources: ${JSON.stringify(v.bySource)}   stages: ${JSON.stringify(v.byStage)}`);
  out.push(`decided by: ${JSON.stringify(v.byUsed)}   llm: ${JSON.stringify(v.llmModels)}   jev: ${JSON.stringify(v.jevModels)}`);
  out.push(`jev status: ${JSON.stringify(v.jevStatus)}   llm status: ${JSON.stringify(v.llmStatus)}   flags: ${JSON.stringify(v.withFlags)}`);
  out.push(`rubric: ${JSON.stringify(v.rubricVersions)}   jev questions: ${JSON.stringify(v.questionVersions)}`);
  out.push('NOTE: the LLM is the reference, not the truth. Agreement means "same as today", not "correct".');
  const o = a.overall;
  out.push('');
  out.push('1. AGREEMENT JEV vs LLM');
  out.push(`compared rows: ${o.pairs}   Jev decided (approve/reject): ${o.decided} (coverage ${fmtPct(o.coverage)})   review lane (goes to the LLM): ${o.review} (${fmtPct(o.reviewShare)})`);
  out.push(`Jev-lane agreement: ${fmtPct(o.laneAgreement)} (95% CI low ${fmtPct(o.laneAgreementLo)})   system agreement (Jev lanes + LLM for review): ${fmtPct(o.systemAgreement)}`);
  out.push(table(['', 'llm approve', 'llm reject'], Object.entries(a.confusion).map(([k, x]) => [k, x['llm approve'], x['llm reject']])));
  out.push('');
  out.push('2. RELIABILITY: agreement by Jev confidence band (decided lanes only)');
  out.push(table(['band', 'n', 'mean conf', 'agreement', '95% low', 'gap'], a.byBand.map(b => [b.band, b.n, fmtNum(b.meanConfidence), fmtPct(b.agreement), fmtPct(b.agreementLo), b.gap === undefined ? '-' : (b.gap >= 0 ? '+' : '') + b.gap.toFixed(2)])));
  out.push('gap = agreement - mean stated confidence; a negative gap means Jev is over-confident in that band.');
  const cmpTable = (title, list) => {
    out.push('');
    out.push(title);
    out.push(table(['key', 'pairs', 'llm approve', 'system approve', 'delta pts', 'jev decided', 'review', 'lane agree', 'system agree', 'J-app/L-rej', 'J-rej/L-app'],
      list.map(x => [x.key, x.pairs, fmtPct(x.llmApproveRate), fmtPct(x.systemApproveRate), x.approveDeltaPts === null ? '-' : x.approveDeltaPts.toFixed(1), fmtPct(x.coverage), fmtPct(x.reviewShare), fmtPct(x.laneAgreement), fmtPct(x.systemAgreement), fmtPct(x.falseApproveRate), fmtPct(x.falseRejectRate)])));
  };
  cmpTable('3. BY SOURCE', a.bySource);
  cmpTable('   BY STAGE', a.byStage);
  cmpTable('   BY ROLE (search job title)', a.byRole);
  cmpTable('   BY SEARCH TIER', a.byTier);
  out.push('');
  out.push('4. FALSE-APPROVE / FALSE-REJECT against the LLM (proxy)');
  out.push(`Jev approves, LLM rejects (wasted unlock credit): ${o.falseApprove} = ${fmtPct(o.falseApproveRate)} of compared rows (${fmtPct(o.falseApproveOfDecided)} of Jev decisions)`);
  out.push(`Jev rejects, LLM approves (lost candidate):        ${o.falseReject} = ${fmtPct(o.falseRejectRate)} of compared rows (${fmtPct(o.falseRejectOfDecided)} of Jev decisions, ${fmtPct(o.falseRejectOfLlmApproved)} of the cards the LLM approved)`);
  out.push(`Jev lanes decide ${fmtPct(o.laneCoverage)} of the ${o.jevRows} rows that have a Jev answer (review lane goes to the LLM)`);
  if (a.topDisagreements.length) {
    out.push('top disagreeing reason pairs:');
    for (const t of a.topDisagreements) out.push(`  ${String(t.n).padStart(4)}  ${t.pair}`);
  }
  if (a.labels) {
    out.push('');
    out.push(`human labels matched: ${a.labels.matched}   LLM accuracy ${fmtPct(a.labels.llmAccuracy)} (n=${a.labels.llmN})   Jev-lane accuracy ${fmtPct(a.labels.jevLaneAccuracy)} (n=${a.labels.jevDecided})   system accuracy ${fmtPct(a.labels.systemAccuracy)}`);
  }
  out.push('');
  out.push('5. THRESHOLD SWEEP (decide() re-run offline on the stored answers)');
  if (!a.sweeps.length) out.push('no rows with stored Jev answers yet');
  for (const s of a.sweeps) {
    out.push(`stage ${s.stage} (${s.rows} rows): rows are rejectP, columns approveP; cell = coverage / system agreement / Jev-approve-LLM-reject rate`);
    const aps = [...new Set(s.grid.map(g => g.approveP))];
    const rps = [...new Set(s.grid.map(g => g.rejectP))];
    out.push(table(['rejectP / approveP', ...aps.map(String)], rps.map(rp => [String(rp), ...aps.map(ap => { const g = s.grid.find(x => x.rejectP === rp && x.approveP === ap); return `${fmtPct(g.coverage)}/${fmtPct(g.systemAgreement)}/${fmtPct(g.falseApproveRate)}`; })])));
    out.push(s.recommended
      ? `recommended (max coverage within the gate): rejectP ${s.recommended.rejectP}, approveP ${s.recommended.approveP} -> coverage ${fmtPct(s.recommended.coverage)}, system agreement ${fmtPct(s.recommended.systemAgreement)}, Jev-approve-LLM-reject ${fmtPct(s.recommended.falseApproveRate)}, approve delta ${s.recommended.approveDeltaPts.toFixed(1)} pts`
      : 'no grid point satisfies the gate yet');
  }
  out.push('');
  out.push('6. STAGE-1 RULES');
  if (!a.rules.length) out.push('no rule hits in the window');
  else {
    out.push(table(['rule', 'mode', 'hits', 'compared', 'agreement', 'rule rejects / LLM approves', 'of which high-confidence', 'promote?'],
      a.rules.map(t => [t.id, t.mode, t.hits, t.compared, fmtPct(t.agreement), t.ruleRejectsLlmApproves, t.hiConf, t.mode === 'enforce' ? 'enforced' : (t.promote ? 'YES' : 'no')])));
    out.push(`promotion needs >= ${a.gate.ruleMinHits} compared hits, >= ${fmtPct(a.gate.ruleMinAgreement)} agreement and zero high-confidence disagreements.`);
  }
  out.push('');
  out.push('7. VERDICT');
  out.push(`engine promotion (jev_shadow -> jev): ${a.verdict.status}`);
  for (const c of a.verdict.checks) out.push(`  [${c.status.toUpperCase().padEnd(12)}] ${c.name}: ${c.detail}`);
  for (const m of a.verdict.missing) out.push(`  [MISSING     ] ${m}`);
  if (a.verdict.smallRoles.length) out.push(`  (roles below the per-role minimum, not judged: ${a.verdict.smallRoles.join(', ')})`);
  out.push(`  config decide.calibration.calibrated = ${a.verdict.calibratedFlag}; the jev engine only decides when this is true.`);
  out.push('  Gate: per source agreement >= gate.minAgreement, Jev-approve/LLM-reject <= gate.maxJevApproveLlmReject, Jev-reject/LLM-approve <= gate.maxJevRejectLlmApprove (of compared cards) and <= gate.maxJevRejectOfLlmApproved (of LLM-approved cards),');
  out.push('  Jev-lane agreement lower bound >= gate.minLaneAgreementLo, Jev decides >= gate.minLaneCoverage of its answers; per role |approval-rate delta| <= gate.maxApprovalDeltaPoints; every source in gate.requiredSources must be present.');
  out.push('  The two error types are capped separately: a lost candidate is never offset by a wasted credit.');
  return out.join('\n') + '\n';
}

// ---------- gold-set sample ----------

function lcg(seed) {
  let x = (Number(seed) || 1) >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/**
 * A stratified sample for recruiters to label, WITHOUT the model answers (independent labels): a third
 * disagreements between Jev and the LLM, a third uncertain (review lane or Jev confidence < 0.8), the
 * rest random. Only rows that kept their redacted input (shadow.storeText) can be exported.
 */
function exportSample(rows, n, seed) {
  const rnd = lcg(seed);
  const withText = rows.filter(r => typeof r.input === 'string' && r.input);
  const seen = new Set();
  const key = r => r.candidateId + '|' + r.jobTitle;
  const items = withText.map(r => ({ r, d: derive(r) }));
  const disagree = items.filter(x => x.d.pair && x.d.lane !== 'review' && (x.d.lane === 'approve') !== x.d.ref);
  const uncertain = items.filter(x => x.d.jevOk && (x.d.lane === 'review' || (x.d.conf !== null && x.d.conf < 0.8)));
  const per = Math.max(1, Math.floor(n / 3));
  const pick = [];
  const take = (list, k) => {
    for (const x of shuffle(list, rnd)) {
      if (pick.length >= n || k <= 0) break;
      if (seen.has(key(x.r))) continue;
      seen.add(key(x.r));
      pick.push(x.r);
      k--;
    }
  };
  take(disagree, per);
  take(uncertain, per);
  take(items, n - pick.length);
  return shuffle(pick, rnd).map(r => {
    const o = { candidateId: r.candidateId, jobTitle: r.jobTitle, stage: r.stage, searchTier: r.searchTier, source: r.source, input: r.input };
    if (r.inputTitle) o.inputTitle = r.inputTitle;
    o.label = null;
    return o;
  });
}

// ---------- CLI ----------

function parseWhen(v, endOfDay) {
  if (!v) return null;
  const rel = /^(\d+)d$/.exec(v);
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86400000);
  const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseArgs(argv) {
  const a = { json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--strict') a.strict = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t.startsWith('--')) { a[t.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

const HELP = `Usage: node tools/screening-report.js [--dir <shadow dir>] [--since 14d|YYYY-MM-DD] [--until YYYY-MM-DD]
       [--source caterer|reed] [--stage pre_unlock|post_unlock] [--config <screening.json>]
       [--labels <file.jsonl>] [--json] [--strict]
       [--export-sample N [--seed S] [--out <file.jsonl>]]
Reads the shadow log and prints the calibration report. --strict: exit 0 GO, 1 NO-GO, 2 INSUFFICIENT DATA.
`;

function main(argv, io) {
  const w = io || { out: s => process.stdout.write(s), err: s => process.stderr.write(s) };
  const args = parseArgs(argv);
  if (args.help) { w.out(HELP); return 0; }
  const lib = resolveLib();
  const cfgOpts = args.config ? { file: path.resolve(args.config) } : {};
  if (args.config && !fs.existsSync(cfgOpts.file)) {
    w.err(`FATAL --config file not found: ${args.config}\n`);
    return 1;
  }
  const cfg = lib.loadConfig(cfgOpts);
  const dir = args.dir ? path.resolve(args.dir) : undefined;
  const since = parseWhen(args.since, false) || new Date(Date.now() - cfg.gate.windowDays * 86400000);
  const until = parseWhen(args.until, true);
  let rows = lib.shadow.readRows({ dir, since, until });
  if (args.source) rows = rows.filter(r => r.source === args.source);
  if (args.stage) rows = rows.filter(r => r.stage === args.stage);
  if (args['export-sample']) {
    const sample = exportSample(rows, Number(args['export-sample']) || 100, args.seed);
    const text = sample.map(x => JSON.stringify(x)).join('\n') + (sample.length ? '\n' : '');
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), text, { mode: 0o600 });
      w.err(`wrote ${sample.length} rows to ${args.out}\n`);
    } else w.out(text);
    return 0;
  }
  let labels = null;
  if (args.labels) {
    try {
      labels = fs.readFileSync(path.resolve(args.labels), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (e) { w.err(`WARN could not read labels file: ${e.message}\n`); }
  }
  const result = analyze(rows, cfg, { decide: lib.decide.decide, labels });
  w.out(args.json ? JSON.stringify(result, null, 2) + '\n' : render(result));
  if (args.strict) return result.verdict.status === 'GO' ? 0 : result.verdict.status === 'NO-GO' ? 1 : 2;
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { analyze, render, main, wilson, derive, compare, sweep, recommend, ruleTable, verdictOf, parseArgs, exportSample };
