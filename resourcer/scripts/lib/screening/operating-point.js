'use strict';

const { decide } = require('./decide');

const DEFAULT_VALUES = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

// the bar that minimises expected cost when P(mismatch) is a true probability: reject only when a wrong reject costs less than a wrong approve
function impliedBar(w) {
  return w.costLostCandidate / (w.costLostCandidate + w.costWastedCredit);
}

function costOf(counts, w) {
  return counts.wasted * w.costWastedCredit + counts.lost * w.costLostCandidate;
}

function withBar(criteria, stage, rejectAt) {
  const c = JSON.parse(JSON.stringify(criteria));
  c.decision.operatingPoint[stage === 2 ? 'stage2' : 'stage1'].rejectAt = rejectAt;
  return c;
}

// o: rows ({answers, searchRole, stage, verdict}), criteria, cfg, optional weights, values and stage; one result row per bar
function sweep(o) {
  const stage = o.stage === 2 ? 2 : 1;
  const w = o.weights || o.criteria.decision.operatingPoint[stage === 2 ? 'stage2' : 'stage1'];
  const rows = o.rows.filter(r => (r.stage === 2 ? 2 : 1) === stage);
  return (o.values || DEFAULT_VALUES).map(rejectAt => {
    const criteria = withBar(o.criteria, stage, rejectAt);
    const m = { rejectAt, n: rows.length, approve: 0, reject: 0, fallback: 0, lost: 0, wasted: 0, agree: 0, forced: 0, cost: 0 };
    for (const r of rows) {
      const d = decide({ answers: r.answers, searchRole: r.searchRole, stage, criteria }, o.cfg);
      if (d.lane === 'review') { m.fallback++; continue; }
      m[d.lane]++;
      if (d.lane === r.verdict) m.agree++;
      else if (d.lane === 'reject') m.lost++;
      else m.wasted++;
      if (d.flags.includes('forced')) m.forced++;
    }
    m.cost = costOf(m, w);
    return m;
  });
}

// the cheapest bar; among bars within tolerance of the cheapest, the one nearest the implied bar
function pick(table, w, tolerance) {
  const tol = tolerance === undefined ? 0 : tolerance;
  const best = Math.min(...table.map(t => t.cost));
  const near = table.filter(t => t.cost <= best + tol);
  const target = impliedBar(w);
  return near.reduce((a, b) => (Math.abs(b.rejectAt - target) < Math.abs(a.rejectAt - target) ? b : a));
}

module.exports = { DEFAULT_VALUES, impliedBar, costOf, withBar, sweep, pick };
