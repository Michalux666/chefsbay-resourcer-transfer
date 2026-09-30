'use strict';
// Cross-call counter of candidates whose answer was unusable while nothing else in the same call succeeded.
// One process per screening call cannot see a slow systemic fault on 1-candidate pages, so the count lives on disk.
const path = require('path');
const paths = require('../paths');
const fsx = require('../fsx');

const FILE = () => path.join(paths.RUNTIME, 'screening-invalid-streak.json');

/**
 * @param {{invalid:number, successes:number, max:number, ttlMs:number, now?:number}} o
 * @returns {{count:number, trip:boolean}} trip: the streak reached `max`, so screening must report itself unavailable
 */
function record(o) {
  const now = o.now || Date.now();
  let prev = fsx.readJson(FILE(), null);
  const t = prev && typeof prev.updatedAt === 'string' ? Date.parse(prev.updatedAt) : NaN;
  if (!Number.isFinite(t) || now - t > o.ttlMs || !Number.isInteger(prev.count) || prev.count < 0) prev = { count: 0 };
  if (o.successes > 0) {
    if (prev.count > 0) fsx.safeUnlink(FILE());
    return { count: 0, trip: false };
  }
  if (!(o.invalid > 0)) return { count: prev.count, trip: false };
  const count = prev.count + o.invalid;
  try {
    fsx.writeJsonAtomic(FILE(), { count, updatedAt: new Date(now).toISOString() }, 0o600);
  } catch (e) { /* best effort: the in-call guard still applies */ }
  return { count, trip: count >= o.max };
}

module.exports = { record, FILE };
