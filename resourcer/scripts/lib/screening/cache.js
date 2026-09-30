'use strict';
// Decision cache: sha256(signature | job | stage | title | redacted snippet) -> the DECISION only
// (approve/reject, reason code, confidence, engine model). No snippet, no title, no reason text is
// ever stored. Purpose: when a page fails half way (one candidate unavailable) the caller's retry
// re-asks only the candidates that never got an answer, and repeat screens of the same card within
// the TTL agree with each other. The signature covers engine, models, rubric and thresholds, so any
// change to how screening decides invalidates every entry.

const crypto = require('crypto');
const path = require('path');
const paths = require('../paths');
const fsx = require('../fsx');

const FILE = path.join(paths.STATE, 'screening-cache.json');

class DecisionCache {
  /**
   * @param {{file?:string, ttlSec:number, maxEntries:number, now?:()=>number}} opts
   */
  constructor(opts) {
    this.file = opts.file || FILE;
    this.ttlMs = Math.max(0, Number(opts.ttlSec) || 0) * 1000;
    this.max = opts.maxEntries || 5000;
    this.now = opts.now || Date.now;
    this.entries = null;
    this.dirty = false;
  }

  get enabled() { return this.ttlMs > 0; }

  static key(parts) {
    const h = crypto.createHash('sha256');
    h.update([parts.sig, parts.job, parts.stage, parts.title || '', parts.text].join('\n'));
    return h.digest('hex').slice(0, 32);
  }

  load() {
    if (this.entries) return;
    this.entries = {};
    if (!this.enabled) return;
    const raw = fsx.readJson(this.file, null);
    const t = this.now();
    if (raw && raw.v === 1 && raw.entries && typeof raw.entries === 'object') {
      for (const [k, e] of Object.entries(raw.entries)) {
        if (e && typeof e.t === 'number' && t - e.t < this.ttlMs) this.entries[k] = e;
      }
    }
  }

  get(key) {
    if (!this.enabled) return null;
    this.load();
    const e = this.entries[key];
    if (!e) return null;
    if (this.now() - e.t >= this.ttlMs) { delete this.entries[key]; this.dirty = true; return null; }
    return e;
  }

  set(key, entry) {
    if (!this.enabled) return;
    this.load();
    this.entries[key] = { ...entry, t: this.now() };
    this.dirty = true;
  }

  save() {
    if (!this.enabled || !this.dirty || !this.entries) return false;
    let keys = Object.keys(this.entries);
    if (keys.length > this.max) {
      keys.sort((a, b) => this.entries[a].t - this.entries[b].t);
      for (const k of keys.slice(0, keys.length - this.max)) delete this.entries[k];
    }
    try {
      fsx.writeJsonAtomic(this.file, { v: 1, entries: this.entries }, 0o600);
      this.dirty = false;
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = { DecisionCache, FILE };
