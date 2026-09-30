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

/**
 * Runs fn while holding a lock file (created exclusively, stolen when older than 10 s, waited for at most 3 s; after that fn runs without the
 * lock: a cache write must never block or fail a decision). Synchronous, so a put() is one step for its caller.
 */
function withFileLock(lockFile, fn) {
  let fd = null;
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const t0 = Date.now();
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      try { fs.writeSync(fd, token); } catch (e) { /* an unreadable token only means the lock is left for its age limit */ }
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') break; // cannot lock here (read-only folder): go on without
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 10000) { fs.unlinkSync(lockFile); continue; }
      } catch (e2) { /* the lock vanished or cannot be inspected: the wait bound below still applies */ }
      if (Date.now() - t0 > 3000) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { /* gone */ }
      // only our own lock: one that was stolen after 10 s now belongs to another writer
      try { if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile); } catch (e) { /* gone */ }
    }
  }
}

const titleKey = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

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

  // The file as it is on disk now (an empty store when it is absent, unreadable, of another version or written for another question wording).
  readFile() {
    const raw = fsx.readJson(this.file, null);
    return raw && raw.v === 1 && raw.qhash === this.qhash && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries) ? raw : { v: 1, qhash: this.qhash, entries: {} };
  }

  load() {
    if (this.data) return;
    this.data = this.readFile();
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

  /**
   * Remembers one title. Phase 2 runs up to four reviewer processes at once, and each of them used to write its whole in-memory copy, so the
   * processes erased each other's titles and asked Jev for the same level again (16 requests for 5 titles in the rehearsal). The file is
   * therefore read again under a short lock file, merged (the newer entry of a title wins) and only then written atomically.
   */
  put(title, entry) {
    this.load();
    const key = titleKey(title);
    this.data.entries[key] = { ...entry, at: new Date(this.now()).toISOString() };
    try {
      fsx.ensureDir(path.dirname(this.file), 0o700);
      withFileLock(`${this.file}.lock`, () => {
        // what this process knew, then what is on disk now (other processes' titles win for their own keys), then the title just asked
        const entries = { ...this.data.entries, ...this.readFile().entries, [key]: this.data.entries[key] };
        const keys = Object.keys(entries);
        if (keys.length > 500) {
          keys.sort((a, b) => String(entries[a].at).localeCompare(String(entries[b].at)));
          for (const k of keys.slice(0, keys.length - 500)) delete entries[k];
        }
        this.data = { v: 1, qhash: this.qhash, entries };
        fsx.writeJsonAtomic(this.file, this.data, 0o600);
      });
    } catch (e) { /* best effort: the next request asks again */ }
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

module.exports = { AnswersCache, SearchLevels, withFileLock, recordStreak, answersKey, titleKey, sha, answersFile, levelsFile, streakFile };
