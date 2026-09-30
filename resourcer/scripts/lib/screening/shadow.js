'use strict';
// The shadow log: one JSON line per screened candidate in shadow/screening-YYYY-MM-DD.jsonl
// (Europe/London date). It holds the platform candidate id (pseudonymous), a hash and length of the
// snippet, the REDACTED snippet text (first name, surname heuristic, postcode, e-mail, phone and URLs
// removed; switch it off with shadow.storeText) so a gold set can be labelled later, flags, engine
// outputs and Jev answers as numbers. It never holds a name, a reason sentence or the raw snippet.
// Treat it as personal data with the same retention as candidates.db; files are mode 0600 and are
// deleted after retentionDays (180 by default) by pruneShadow().

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const fsx = require('../fsx');
const time = require('../time');

const NAME_RE = /^screening-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY = 86400000;
// The run id of the install canaries (docs/UPDATE-B.md 7.1, docs/UPDATE-C.md): invented cards, never part of any number the owner reads.
const INSTALL_CANARY_RUN_ID = 'install-canary';

function fileFor(dir, date) {
  return path.join(dir, `screening-${time.londonParts(date || new Date()).ymd}.jsonl`);
}

class ShadowLog {
  /**
   * @param {{dir?:string, enabled?:boolean, now?:()=>Date}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || paths.SHADOW;
    this.enabled = o.enabled !== false;
    this.now = o.now || (() => new Date());
    this.failures = 0;
  }

  // Best effort: logging must never affect screening.
  append(row) {
    if (!this.enabled) return false;
    try {
      fsx.ensureDir(this.dir, 0o700);
      fs.appendFileSync(fileFor(this.dir, this.now()), JSON.stringify(row) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      this.failures++;
      return false;
    }
  }
}

// Delete daily files older than `days`. Returns the names removed.
function pruneShadow(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const days = o.days || 180;
  const now = (o.now ? o.now() : new Date());
  const cutoff = time.londonParts(new Date(now.getTime() - days * DAY)).ymd;
  const deleted = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { deleted, kept: 0 }; }
  let kept = 0;
  for (const n of names) {
    const m = NAME_RE.exec(n);
    if (!m) continue;
    if (m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dir, n)); deleted.push(n); } catch (e) { kept++; }
    } else kept++;
  }
  return { deleted, kept };
}

// Prune at most once a day (marker file), so every CLI start can call it cheaply.
function maybePrune(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const now = (o.now ? o.now() : new Date());
  const marker = path.join(dir, '.last-prune');
  try {
    const last = Date.parse(fs.readFileSync(marker, 'utf8'));
    if (Number.isFinite(last) && now.getTime() - last < DAY) return null;
  } catch (e) { /* no marker yet */ }
  try { fs.statSync(dir); } catch (e) { return null; }
  const res = pruneShadow({ dir, days: o.days, now: () => now });
  try { fs.writeFileSync(marker, now.toISOString(), { mode: 0o600 }); } catch (e) { /* best effort */ }
  return res;
}

// Read rows for the report. Bad lines are skipped. since/until are Date or null.
/** @param {{dir?:string, since?:Date, until?:Date, includeCanary?:boolean}} [opts] rows of run id install-canary are skipped unless includeCanary */
function readRows(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => NAME_RE.test(n)).sort(); } catch (e) { return rows; }
  const since = o.since ? o.since.getTime() : -Infinity;
  const until = o.until ? o.until.getTime() : Infinity;
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r = null;
      try { r = JSON.parse(line); } catch (e) { continue; }
      if (!r || typeof r !== 'object') continue;
      if (typeof r.runId === 'string' && r.runId.startsWith(INSTALL_CANARY_RUN_ID) && !o.includeCanary) continue; // rows written by an install canary (install-canary, install-canary-zdr; an instance at Update B has three or four)
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && (t < since || t > until)) continue;
      rows.push(r);
    }
  }
  return rows;
}

module.exports = { ShadowLog, pruneShadow, maybePrune, readRows, fileFor, NAME_RE, INSTALL_CANARY_RUN_ID };
