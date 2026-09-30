// Ported from cv-corpus/tests/parser-benchmark.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
// Objective accuracy of the role parser on SYNTHETIC CVs with known ground truth (many layouts x date formats), in a clean
// mode and a hard mode (employer names containing title words, cities, "(Full Time)" brackets, short duty fragments).
// This is a regression guard and a measurement, not a claim about real CVs: real CVs are messier (see the report).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCv } = require('../../../resourcer/scripts/lib/cv/vendor/role-parser');
const { makeCv, LAYOUT_FNS, DATE_FORMATS } = require('./synthetic-cv-gen');

const ASOF = '2026-09';
const ymStr = (o) => (o === 'present' ? 'present' : `${o.y}-${String(o.m).padStart(2, '0')}`);

function evaluate(nPerCell, hard) {
  const perLayout = {};
  let total = 0;
  for (const layout of Object.keys(LAYOUT_FNS)) {
    const agg = perLayout[layout] = { cvs: 0, roles: 0, found: 0, titleOk: 0, employerOk: 0, extraRoles: 0, highWrong: 0, highTotal: 0 };
    for (const dateFmt of Object.keys(DATE_FORMATS)) {
      for (let i = 0; i < nPerCell; i += 1) {
        const cv = makeCv(`${hard ? 'h' : 'c'}:${layout}:${dateFmt}:${i}`, { layout, dateFmt, hard });
        const parsed = parseCv(cv.text, { asOf: ASOF });
        agg.cvs += 1;
        total += 1;
        const yearOnly = dateFmt === 'year';
        const gotByKey = new Map();
        for (const r of parsed.roles) gotByKey.set(`${r.start}|${r.end}`, r);
        for (const gt of cv.roles) {
          agg.roles += 1;
          const s = yearOnly ? `${gt.start.y}-01` : ymStr(gt.start);
          const e = yearOnly ? (gt.end === 'present' ? 'present' : `${gt.end.y}-12`) : ymStr(gt.end);
          const got = gotByKey.get(`${s}|${e}`);
          if (!got) continue;
          agg.found += 1;
          const tOk = got.title === gt.title;
          const eOk = got.employer === gt.employer;
          if (tOk) agg.titleOk += 1;
          if (eOk) agg.employerOk += 1;
          if (got.confidence === 'high') { agg.highTotal += 1; if (!tOk || !eOk) agg.highWrong += 1; }
        }
        agg.extraRoles += Math.max(0, parsed.roles.length - cv.roles.length);
      }
    }
  }
  return { perLayout, total };
}

function summarise(label, { perLayout, total }) {
  const rows = [];
  const sum = { roles: 0, found: 0, titleOk: 0, employerOk: 0, extra: 0, highWrong: 0, highTotal: 0 };
  for (const [layout, a] of Object.entries(perLayout)) {
    sum.roles += a.roles; sum.found += a.found; sum.titleOk += a.titleOk; sum.employerOk += a.employerOk; sum.extra += a.extraRoles; sum.highWrong += a.highWrong; sum.highTotal += a.highTotal;
    rows.push(`${layout.padEnd(28)} recall ${(100 * a.found / a.roles).toFixed(1)}%  title ${(100 * a.titleOk / a.roles).toFixed(1)}%  employer ${(100 * a.employerOk / a.roles).toFixed(1)}%  extra ${a.extraRoles}`);
  }
  console.log(`  [${label}] synthetic CVs: ${total}, ground-truth roles: ${sum.roles}\n  ${rows.join('\n  ')}`);
  console.log(`  [${label}] overall recall ${(100 * sum.found / sum.roles).toFixed(1)}%, title ${(100 * sum.titleOk / sum.roles).toFixed(1)}%, employer ${(100 * sum.employerOk / sum.roles).toFixed(1)}%, spurious roles ${sum.extra}, high-confidence wrong ${sum.highWrong}/${sum.highTotal}`);
  return sum;
}

test('synthetic benchmark (clean): role recall, title and employer accuracy per layout', () => {
  const r = evaluate(12, false);
  const s = summarise('clean', r);
  assert.ok(s.found / s.roles >= 0.97, `overall role recall ${(s.found / s.roles).toFixed(3)}`);
  assert.ok(s.titleOk / s.roles >= 0.95, `overall title accuracy ${(s.titleOk / s.roles).toFixed(3)}`);
  assert.ok(s.employerOk / s.roles >= 0.93, `overall employer accuracy ${(s.employerOk / s.roles).toFixed(3)}`);
  assert.ok(s.extra / r.total <= 0.05, 'spurious roles are rare');
  for (const [layout, a] of Object.entries(r.perLayout)) {
    assert.ok(a.found / a.roles >= 0.9, `${layout}: recall ${(a.found / a.roles).toFixed(3)}`);
    assert.ok(a.titleOk / a.roles >= 0.85, `${layout}: title accuracy ${(a.titleOk / a.roles).toFixed(3)}`);
  }
});

test('synthetic benchmark (hard mode): still finds every dated role and most titles', () => {
  const r = evaluate(12, true);
  const s = summarise('hard', r);
  assert.ok(s.found / s.roles >= 0.95, `hard role recall ${(s.found / s.roles).toFixed(3)}`);
  assert.ok(s.titleOk / s.roles >= 0.80, `hard title accuracy ${(s.titleOk / s.roles).toFixed(3)}`);
  assert.ok(s.employerOk / s.roles >= 0.70, `hard employer accuracy ${(s.employerOk / s.roles).toFixed(3)}`);
  assert.ok(s.highWrong / Math.max(1, s.highTotal) <= 0.10, `high-confidence but wrong: ${s.highWrong}/${s.highTotal}`);
});

test('synthetic benchmark: a high-confidence role is almost never wrong in clean mode', () => {
  const r = evaluate(8, false);
  const s = summarise('clean-high', r);
  assert.ok(s.highWrong / Math.max(1, s.highTotal) <= 0.02, `high-confidence but wrong: ${s.highWrong}/${s.highTotal}`);
});
