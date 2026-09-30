'use strict';
const path = require('path');
const paths = require('../lib/paths');
const fsx = require('../lib/fsx');

const TTL_MS = 24 * 3600 * 1000;

const file = () => path.join(paths.RUNTIME, 'phase1-incomplete-runs.json');

// One counter per search, outside the pending file (owned by supervision); mirrored into the status file as incompleteRuns.
function keyOf(p) {
  return [p.JOB_TITLE, p.LOCATION, p.DISTANCE_MILES].map((x) => String(x === undefined || x === null ? '' : x).trim().toLowerCase()).join('|');
}

function readAll() {
  const o = fsx.readJson(file(), {});
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

function fresh(entry, now) {
  const t = entry && typeof entry.lastAt === 'string' ? Date.parse(entry.lastAt) : NaN;
  return Number.isFinite(t) && now - t < TTL_MS;
}

// Entries untouched for 24 h are dropped so an old streak never counts against a fresh problem.
function bump(ctx, kind) {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const all = readAll();
  for (const k of Object.keys(all)) if (!fresh(all[k], now)) delete all[k];
  const key = keyOf(ctx.p);
  const prev = all[key];
  const runs = (prev && Number.isInteger(prev.count) && prev.count > 0 ? prev.count : 0) + 1;
  all[key] = { count: runs, kind, firstAt: prev && prev.firstAt ? prev.firstAt : iso, lastAt: iso };
  try {
    fsx.writeJsonAtomic(file(), all, 0o600);
    return { runs, persisted: true };
  } catch (e) {
    return { runs, persisted: false };
  }
}

function clear(ctx) {
  try {
    const all = readAll();
    const key = keyOf(ctx.p);
    if (!(key in all)) return;
    delete all[key];
    fsx.writeJsonAtomic(file(), all, 0o600);
  } catch (e) { /* best effort */ }
}

module.exports = { bump, clear, keyOf, file };
