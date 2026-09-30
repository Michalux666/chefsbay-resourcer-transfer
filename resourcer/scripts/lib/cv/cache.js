'use strict';
// Three small stores, all holding numbers only (never a CV, a role, a name or any text of a candidate):
//   AnswersCache   state/cv-answers.jsonl       Jev's numeric answers for one request, keyed by a hash of (model, questions, state).
//                                               A retry after an outage or a change of thresholds costs no new request and a
//                                               re-run gives the same answers (the gate runs again on them every time).
//   SearchLevels   state/cv-search-levels.json  the level Jev gave to one searched title (one request per new title, reused for
//                                               ttlSec, 30 days by default, then asked again).
//   streak         runtime/cv-invalid-streak.json  how many CVs in a row got an unusable answer (a systemic fault must not become
//                                               a run of policy decisions).
// Files are private (mode 0600) and written atomically or by append.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const fsx = require('../fsx');

const sha = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n || 32);

const answersFile = () => path.join(paths.STATE, 'cv-answers.jsonl');
const levelsFile = () => path.join(paths.STATE, 'cv-search-levels.json');
const streakFile = () => path.join(paths.RUNTIME, 'cv-invalid-streak.json');

function answersKey(model, qhash, state) {
  return sha([model, qhash, JSON.stringify(state)].join('\n'), 32);
}

class AnswersCache {
  /**
   * @param {{file?:string, ttlSec:number, maxEntries:number, now?:()=>number}} o
   */
  constructor(o) {
    this.file = o.file || answersFile();
    this.ttlMs = Math.max(0, Number(o.ttlSec) || 0) * 1000;
    this.max = o.maxEntries || 2000;
    this.now = o.now || Date.now;
    this.map = null;
  }

  get enabled() { return this.ttlMs > 0; }

  load() {
    if (this.map) return;
    this.map = new Map();
    if (!this.enabled) return;
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { return; }
    const t = this.now();
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      lines++;
      let row = null;
      try { row = JSON.parse(line); } catch (e) { continue; }
      if (row && typeof row.k === 'string' && typeof row.t === 'number' && row.a && t - row.t < this.ttlMs) this.map.set(row.k, row);
    }
    if (lines > this.max * 1.5) this.compact();
  }

  get(key) {
    if (!this.enabled) return null;
    this.load();
    const row = this.map.get(key);
    return row ? row.a : null;
  }

  put(key, answers) {
    if (!this.enabled) return;
    this.load();
    const row = { k: key, t: this.now(), a: answers };
    this.map.set(key, row);
    try {
      fsx.ensureDir(path.dirname(this.file), 0o700);
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e) { /* the cache is an optimisation only */ }
  }

  compact() {
    const rows = Array.from(this.map.values()).sort((a, b) => a.t - b.t).slice(-this.max);
    this.map = new Map(rows.map(r => [r.k, r]));
    try { fsx.writeFileAtomic(this.file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 0o600); } catch (e) { /* best effort */ }
  }
}

const titleKey = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

class SearchLevels {
  /**
   * @param {{file?:string, qhash:string, ttlSec?:number, now?:()=>number}} o  qhash = hash of the search-level question; another wording
   *   means a fresh cache. ttlSec: how long an entry is reused (undefined = forever, 0 = never).
   */
  constructor(o) {
    this.file = o.file || levelsFile();
    this.qhash = o.qhash;
    this.ttlMs = o.ttlSec === undefined || o.ttlSec === null ? Infinity : Math.max(0, Number(o.ttlSec) || 0) * 1000;
    this.now = o.now || Date.now;
    this.data = null;
  }

  load() {
    if (this.data) return;
    const raw = fsx.readJson(this.file, null);
    this.data = raw && raw.v === 1 && raw.qhash === this.qhash && raw.entries && typeof raw.entries === 'object' ? raw : { v: 1, qhash: this.qhash, entries: {} };
  }

  get(title) {
    if (this.ttlMs <= 0) return null;
    this.load();
    const entry = this.data.entries[titleKey(title)];
    if (!entry) return null;
    if (this.ttlMs === Infinity) return entry;
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && this.now() - at < this.ttlMs ? entry : null;
  }

  put(title, entry) {
    this.load();
    this.data.entries[titleKey(title)] = { ...entry, at: new Date(this.now()).toISOString() };
    const keys = Object.keys(this.data.entries);
    if (keys.length > 500) {
      keys.sort((a, b) => String(this.data.entries[a].at).localeCompare(String(this.data.entries[b].at)));
      for (const k of keys.slice(0, keys.length - 500)) delete this.data.entries[k];
    }
    try { fsx.writeJsonAtomic(this.file, this.data, 0o600); } catch (e) { /* best effort */ }
  }
}

/**
 * Counts CVs whose answers were unusable while nothing else worked; a success resets it.
 * @param {{invalid:number, successes:number, max:number, ttlMs:number, now?:number, file?:string}} o
 * @returns {{count:number, trip:boolean}}
 */
function recordStreak(o) {
  const file = o.file || streakFile();
  const now = o.now || Date.now();
  let prev = fsx.readJson(file, null);
  const t = prev && typeof prev.updatedAt === 'string' ? Date.parse(prev.updatedAt) : NaN;
  if (!Number.isFinite(t) || now - t > o.ttlMs || !Number.isInteger(prev.count) || prev.count < 0) prev = { count: 0 };
  if (o.successes > 0) {
    if (prev.count > 0) fsx.safeUnlink(file);
    return { count: 0, trip: false };
  }
  if (!(o.invalid > 0)) return { count: prev.count, trip: false };
  const count = prev.count + o.invalid;
  try { fsx.writeJsonAtomic(file, { count, updatedAt: new Date(now).toISOString() }, 0o600); } catch (e) { /* best effort */ }
  return { count, trip: count >= o.max };
}

module.exports = { AnswersCache, SearchLevels, recordStreak, answersKey, titleKey, sha, answersFile, levelsFile, streakFile };
