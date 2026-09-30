'use strict';
// Adapter over the role parser. Interface: parseRoles(text | {variants:[{name,text}]}, {asOf}) -> {roles, qualifications, skills,
// parseConfidence, source}, where a role is {title, employer, start:'YYYY-MM'|null, end:'YYYY-MM'|'present'|null, duties} and
// parseConfidence is a number from 0 to 1. Uses ./vendor/role-parser.js (parseCv, and parseBest for the two readings of a
// two-column PDF) when installed, else ./stubs/parse-stub.js. Only these fields are passed on: whatever else a parser returns (the
// source line numbers, its own flags) is dropped here, so raw CV text cannot travel further than this function.

let vendored = null;
try { vendored = require('./vendor/role-parser'); } catch (e) { vendored = null; }
const stub = require('./stubs/parse-stub');

const CONFIDENCE = { high: 0.9, medium: 0.5, low: 0.1 };
const str = v => (typeof v === 'string' ? v : '');
const ym = v => (typeof v === 'string' && /^(?:\d{4}-\d{1,2}|present)$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

function confidenceOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  return Object.prototype.hasOwnProperty.call(CONFIDENCE, v) ? CONFIDENCE[v] : null;
}

function run(input, opts) {
  const asOf = opts && /^\d{4}-\d{2}$/.test(String(opts.asOf || '')) ? opts.asOf : undefined;
  if (!vendored) return stub.parseRoles(typeof input === 'string' ? input : (input && input.variants && input.variants[0] && input.variants[0].text) || '');
  if (input && typeof input === 'object' && Array.isArray(input.variants) && input.variants.length > 1) {
    const best = vendored.parseBest(input.variants, { asOf });
    if (best && best.parsed) return best.parsed;
  }
  const text = typeof input === 'string' ? input : (input && input.variants && input.variants[0] && input.variants[0].text) || '';
  return vendored.parseCv(text, { asOf });
}

async function parseRoles(input, opts) {
  let raw;
  try { raw = run(input, opts); } catch (e) { raw = null; }
  const r = raw && typeof raw === 'object' ? raw : {};
  const roles = (Array.isArray(r.roles) ? r.roles : []).filter(x => x && typeof x === 'object').map(x => ({
    title: str(x.title),
    employer: str(x.employer),
    start: ym(x.start),
    end: ym(x.end),
    duties: Array.isArray(x.duties) ? x.duties.filter(d => typeof d === 'string') : str(x.duties),
  }));
  return {
    roles,
    qualifications: (Array.isArray(r.qualifications) ? r.qualifications : []).filter(q => typeof q === 'string'),
    skills: (Array.isArray(r.skills) ? r.skills : []).filter(q => typeof q === 'string'),
    parseConfidence: confidenceOf(r.parseConfidence),
    source: vendored ? 'vendor' : 'stub',
  };
}

module.exports = { parseRoles, isVendored: () => !!vendored };
