/**
 * territory-utils.js
 * Shared helpers for territory_searches table operations.
 * Used by: process-approved-queue.js, territory-manager.js, territory-scheduler.js, query-territory.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');

const DEFAULTS_PATH  = path.join(paths.CONFIG, 'territory-defaults.json');

// -- Priority -> default re-run interval (days) ---------------------------------
// Loaded from config/territory-defaults.json -> priorityDays.
// Hardcoded fallback used only if config is missing/corrupt.
const PRIORITY_DAYS_FALLBACK = { high: 2, medium: 3, low: 7 };

// Module-level cache - loaded once per process, avoids repeated file reads.
let _priorityDaysCache = null;
function getPriorityDays() {
  if (!_priorityDaysCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      const pd  = raw.priorityDays || {};
      _priorityDaysCache = {
        high:   typeof pd.high   === 'number' ? pd.high   : PRIORITY_DAYS_FALLBACK.high,
        medium: typeof pd.medium === 'number' ? pd.medium : PRIORITY_DAYS_FALLBACK.medium,
        low:    typeof pd.low    === 'number' ? pd.low    : PRIORITY_DAYS_FALLBACK.low,
      };
    } catch {
      _priorityDaysCache = { ...PRIORITY_DAYS_FALLBACK };
    }
  }
  return _priorityDaysCache;
}

// Convenience export - same shape as before; populated on first access.
// External code should prefer getPriorityDays() for live values,
// but PRIORITY_DAYS is kept for backward compatibility.
const PRIORITY_DAYS = new Proxy({}, {
  get(_, key) { return getPriorityDays()[key]; },
  ownKeys()   { return Object.keys(getPriorityDays()); },
  getOwnPropertyDescriptor(_, key) {
    return { value: getPriorityDays()[key], enumerable: true, configurable: true };
  },
});

/**
 * Load territory defaults from config/territory-defaults.json.
 * Falls back to hardcoded values if file is missing/corrupt.
 * Returns a plain object - safe to mutate by caller.
 */
function loadDefaults() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
    const pd  = raw.priorityDays || {};
    return {
      distance:     raw.distance     ?? 20,
      activeWithin: raw.activeWithin ?? '1 month',
      cvLimit:      raw.cvLimit      ?? 20,
      priority:     raw.priority     ?? 'low',
      hideViewed:   raw.hideViewed   ?? 7,
      sources:      raw.sources      ?? 'caterer',
      priorityDays: {
        high:   typeof pd.high   === 'number' ? pd.high   : PRIORITY_DAYS_FALLBACK.high,
        medium: typeof pd.medium === 'number' ? pd.medium : PRIORITY_DAYS_FALLBACK.medium,
        low:    typeof pd.low    === 'number' ? pd.low    : PRIORITY_DAYS_FALLBACK.low,
      },
    };
  } catch {
    return {
      distance: 20, activeWithin: '1 month', cvLimit: 20, priority: 'low', hideViewed: 7,
      sources: 'caterer',
      priorityDays: { ...PRIORITY_DAYS_FALLBACK },
    };
  }
}

// -- Normalisation helpers -------------------------------------------------------

/**
 * Normalise a postcode / location string.
 * Uppercases and collapses whitespace.
 * e.g. "m1", "m 1", " M1 " -> "M1"   |   "l1 1aa" -> "L1 1AA"
 */
function normaliseLocation(loc) {
  return (loc || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Known acronyms that should stay ALL-CAPS in job titles.
 */
const ACRONYMS = new Set(['DBS', 'NVQ', 'CDP', 'HND', 'HNC', 'UK', 'EU', 'TV', 'CV', 'HR', 'IT']);

/**
 * Normalise a job title string.
 * Smart title case - preserves known acronyms (DBS, NVQ etc).
 * e.g. "kitchen assistant dbs" -> "Kitchen Assistant DBS"
 */
function normaliseJobTitle(title) {
  return (title || '').trim().replace(/\s+/g, ' ')
    .split(' ')
    .map(word => {
      const up = word.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Normalise keywords.
 * Lowercases, deduplicates, sorts alphabetically.
 * "DBS food hygiene, DBS" -> "dbs food hygiene"
 * Returns '' if empty.
 */
function normaliseKeywords(kw) {
  if (!kw || !kw.trim()) return '';
  // Treat common "no keywords" sentinel values as empty
  if (/^(none|\(none\)|n\/a|null|undefined|-)$/i.test(kw.trim())) return '';

  const blacklist = [
    /^-?location:[a-z0-9]+$/i,
    /^currentlocation:[a-z0-9]+$/i,
  ];

  const tokens = kw.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
    .filter(t => !blacklist.some(rx => rx.test(t)));

  if (!tokens.length) return '';
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Compute next_run_date from last_searched + priority/interval.
 * All date arithmetic is in UTC so the result never depends on the machine's timezone
 * (the old local-time setDate shifted the result by a day across a clock change).
 * @param {string|null} lastSearched  ISO date string (null -> use today)
 * @param {string}      priority      'high' | 'medium' | 'low'
 * @param {number|null} intervalDays  override (null -> use priority default)
 * @returns {string} ISO date YYYY-MM-DD
 */
function computeNextRunDate(lastSearched, priority, intervalDays) {
  const pd   = getPriorityDays();
  const days = intervalDays || pd[priority] || pd.low || 7;
  const base = lastSearched ? new Date(lastSearched) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Fixed-cadence next_run_date (2026-08-03).
 *
 * Anchors the next run to the date the territory was DUE, not the date it
 * actually ran. computeNextRunDate() above rolls from the execution date, so a
 * backlog processed in a single catch-up day all lands on the SAME date
 * (due-3d, due-2d, due-1d -> all today+interval). That produces one huge spike
 * and two empty days, which is exactly the 95/95/51-then-nothing pattern seen
 * on 2026-08-02/03 after the machine was offline.
 *
 * Anchoring to the due date preserves each territory's original phase, so a
 * backlog naturally re-spreads itself across the week as it is worked through
 * and the schedule self-heals after any outage.
 *
 * Advances in WHOLE intervals until strictly in the future, so a territory that
 * is many intervals overdue keeps its original day-of-cycle rather than being
 * re-based onto the catch-up day.
 *
 * @param {string|null} dueDate  the territory's current next_run_date (its scheduled slot)
 * @param {string}      today    ISO date of this run
 * @param {string}      priority 'high' | 'medium' | 'low'
 * @param {number|null} intervalDays override (null -> priority default)
 * @returns {string} ISO date YYYY-MM-DD, always > today
 */
function computeNextRunDateFixed(dueDate, today, priority, intervalDays) {
  const pd   = getPriorityDays();
  const days = intervalDays || pd[priority] || pd.low || 7;
  // No prior schedule (first-ever run) -> fall back to rolling from today.
  if (!dueDate) return computeNextRunDate(today, priority, intervalDays);
  const t = new Date(`${today}T00:00:00Z`);
  const d = new Date(`${dueDate}T00:00:00Z`);
  if (isNaN(d.getTime()) || isNaN(t.getTime())) {
    return computeNextRunDate(today, priority, intervalDays);
  }
  // UTC arithmetic throughout - avoids a BST/GMT boundary shifting the date by one.
  do { d.setUTCDate(d.getUTCDate() + days); } while (d <= t);
  return d.toISOString().slice(0, 10);
}

/**
 * Daily territory cap (2026-08-06).
 *
 * Two competing constraints set this number:
 *  1. UPPER BOUND - Caterer/Reed can flag high-volume automation. 88-98/day was judged
 *     too risky; this is an account-protection limit, NOT a throughput knob.
 *  2. LOWER BOUND - the full sweep must finish INSIDE the ~30-day "active within
 *     1 month" search window. Cycle = total territories / cap. If the cycle exceeds
 *     30 days, a candidate can become active and lapse back out of the window between
 *     two visits to their territory, and we never see them at all.
 *
 * At 1,707 territories: 50/day gives a 34.1-day cycle (a ~4-day blind spot), so the cap
 * is 57 -> 29.9 days, just inside the window with all territories retained.
 *
 * IMPORTANT: this is derived, not arbitrary. If the territory count changes, re-check
 * that total/cap stays under 30 - adding territories without revisiting this silently
 * re-opens the coverage gap.
 */
const DAILY_TERRITORY_CAP = 57;

/**
 * Capacity-aware next_run_date.
 *
 * Takes the fixed-cadence target (due date + interval, which preserves each
 * territory's phase) and then walks FORWARD to the first date that has fewer than
 * DAILY_TERRITORY_CAP territories already allocated. Never walks backwards - moving a
 * territory earlier would re-run it before its interval has elapsed.
 *
 * Because total territories (1,707) far exceed cap x interval, intervals stretch
 * naturally: the effective cycle becomes ceil(total / cap) days rather than the
 * nominal 7/28. That is the intended trade - a predictable, flat daily load beats hitting
 * the cadence and getting the account flagged.
 *
 * @param {object} db        open better-sqlite3 handle (already inside the caller's tx)
 * @param {string|null} dueDate  territory's current next_run_date
 * @param {string} today     ISO date of this run
 * @param {string} priority
 * @param {number|null} intervalDays
 * @param {number} [cap]
 * @returns {string} ISO date with free capacity, always > today
 */
function computeNextRunDateCapped(db, dueDate, today, priority, intervalDays, cap = DAILY_TERRITORY_CAP) {
  let d = computeNextRunDateFixed(dueDate, today, priority, intervalDays);
  let count;
  try {
    count = db.prepare('SELECT COUNT(*) c FROM territory_searches WHERE enabled=1 AND next_run_date=?');
  } catch {
    return d; // capacity check unavailable - fall back to plain fixed cadence
  }
  // Bounded walk: a full year is far beyond any legitimate backlog, and stops a bad
  // cap value (0/negative) turning this into an infinite loop.
  for (let i = 0; i < 365; i++) {
    let n;
    try { n = count.get(d).c; } catch { return d; }
    if (n < cap) return d;
    const nd = new Date(`${d}T00:00:00Z`);
    nd.setUTCDate(nd.getUTCDate() + 1);
    d = nd.toISOString().slice(0, 10);
  }
  return d;
}

/**
 * Build a normalised territory key object.
 * Always call this before any DB lookup or insert.
 * Distance defaults to config default but can be overridden.
 */
function normaliseInputs({ jobTitle, location, keywords, distance, sources }) {
  const defaults = loadDefaults();
  const VALID_SOURCES = ['caterer', 'reed', 'both'];
  return {
    jobTitle:  normaliseJobTitle(jobTitle),
    location:  normaliseLocation(location),
    distance:  (typeof distance === 'number' && distance > 0) ? distance : defaults.distance,
    keywords:  normaliseKeywords(keywords),
    sources:   VALID_SOURCES.includes(sources) ? sources : defaults.sources,
  };
}

/**
 * Upsert a territory into territory_searches.
 *
 * -- Distance policy: "biggest wins" ---------------------------------------------
 * The territory map stores the LARGEST distance ever seen for a (jobTitle, location, keywords)
 * combo. If a search runs with 20mi but the map already has 30mi, the map keeps 30mi.
 * If a search runs with 40mi, the map upgrades to 40mi. This ensures the territory
 * always uses the widest known search radius.
 *
 * -- What this writes ------------------------------------------------------------
 * Identity (unique key): jobTitle, location, distance (biggest wins), keywords
 * Schedule config:       activeWithin=DEFAULT, cvLimit=DEFAULT - from config, not search
 * Results:               candidateCount, newToZoho, duplicates, skipped, errors, creditsRemaining
 * Timestamps:            last_searched, next_run_date (computed from priority + interval)
 *
 * -- What this NEVER overwrites --------------------------------------------------
 * enabled       - only changed via territory-manager enable/disable
 *
 * -- Auto-downgrade --------------------------------------------------------------
 * If newToZoho < 5 (and not null) the territory steps down one tier:
 *   high -> medium -> low  (low stays low - never disabled automatically)
 * interval_days is cleared on downgrade so the new tier's natural interval kicks in.
 * Manual adds (newToZoho: null) bypass the trigger entirely.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params  - jobTitle, location, keywords required; searchDistance optional
 */
function upsertTerritory(db, params) {
  const {
    jobTitle, location, keywords,
    searchDistance,    // the distance used in THIS search (optional - biggest-wins vs existing/default)
    initialPriority,  // used for first-insert ONLY - if the territory already exists, this is ignored
    sources,          // data source: 'caterer' | 'reed' | 'both' (optional - defaults from config)
    candidateCount, newToZoho, duplicates, skipped, errors,
    creditsRemaining, lastSearched,
  } = params;

  const defaults  = loadDefaults();
  const normTitle = normaliseJobTitle(jobTitle);
  const normLoc   = normaliseLocation(location);
  const normKw    = normaliseKeywords(keywords || '');
  const today     = lastSearched || new Date().toISOString().slice(0, 10);
  const VALID_SOURCES = ['caterer', 'reed', 'both'];
  const normSources = VALID_SOURCES.includes(sources) ? sources : defaults.sources;

  // -- Step 0: "Biggest distance wins" consolidation ------------------------------
  // Find ALL existing rows for this (job_title, location, keywords) - any distance.
  // Determine the winning distance = max(all existing, searchDistance, config default).
  // Consolidate to a single row if duplicates exist.
  const existingRows = db.prepare(`
    SELECT * FROM territory_searches
    WHERE job_title = ? AND location = ? AND keywords = ?
    ORDER BY distance DESC
  `).all(normTitle, normLoc, normKw);

  const distanceCandidates = [defaults.distance];
  if (typeof searchDistance === 'number' && searchDistance > 0) distanceCandidates.push(searchDistance);
  existingRows.forEach(r => distanceCandidates.push(r.distance));
  const winningDistance = Math.max(...distanceCandidates);

  if (existingRows.length > 1) {
    // Multiple rows exist - merge into one with winning distance.
    // Keeper = row with highest non-default priority, or oldest row as tiebreaker.
    const priorityRank = { high: 1, medium: 2, low: 3 };
    const keeper = existingRows.slice().sort((a, b) => {
      const pa = priorityRank[a.priority] ?? 99;
      const pb = priorityRank[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;     // highest priority first
      return a.id - b.id;               // oldest first as tiebreak
    })[0];
    const toDelete = existingRows.filter(r => r.id !== keeper.id);

    // Take the most recent last_searched from any row
    const bestLastSearched = existingRows
      .map(r => r.last_searched).filter(Boolean).sort().pop() || null;

    // Delete duplicates first (avoids unique constraint conflicts)
    for (const r of toDelete) {
      db.prepare('DELETE FROM territory_searches WHERE id = ?').run(r.id);
    }

    // Update keeper to winning distance + best last_searched
    db.prepare(`
      UPDATE territory_searches SET distance = ?, last_searched = COALESCE(?, last_searched)
      WHERE id = ?
    `).run(winningDistance, bestLastSearched, keeper.id);

  } else if (existingRows.length === 1 && existingRows[0].distance !== winningDistance) {
    // Single row but distance needs upgrading (never downgraded - winningDistance is always max)
    db.prepare('UPDATE territory_searches SET distance = ? WHERE id = ?')
      .run(winningDistance, existingRows[0].id);
  }

  // -- Step 1: Insert if new ------------------------------------------------------
  const insertPriority = (initialPriority && ['high', 'medium', 'low'].includes(initialPriority))
    ? initialPriority
    : defaults.priority;

  db.prepare(`
    INSERT INTO territory_searches
      (job_title, location, distance, keywords, active_within, cv_limit, priority, enabled, sources)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(job_title, location, distance, keywords) DO NOTHING
  `).run(
    normTitle, normLoc, winningDistance, normKw,
    defaults.activeWithin, String(defaults.cvLimit), insertPriority, normSources
  );

  // -- Step 2: Read back priority + interval_days ---------------------------------
  const existing = db.prepare(
    'SELECT priority, interval_days, next_run_date FROM territory_searches WHERE job_title=? AND location=? AND distance=? AND keywords=?'
  ).get(normTitle, normLoc, winningDistance, normKw);

  const effectivePriority = existing?.priority  || defaults.priority;
  const effectiveInterval = existing?.interval_days || null;

  // -- Auto-downgrade: step down one priority tier if run produced 0 new CVs ------
  // Trigger: newToZoho < 5 (typeof guard excludes null/undefined from manual adds).
  // high -> medium -> low. Low stays low. Clears any custom interval_days on downgrade.
  const PRIORITY_LADDER = ['high', 'medium', 'low'];
  let finalPriority    = effectivePriority;
  let autoDowngraded   = false;
  let previousPriority = null;
  if (typeof newToZoho === 'number' && newToZoho < 5) {
    const idx = PRIORITY_LADDER.indexOf(effectivePriority);
    if (idx >= 0 && idx < PRIORITY_LADDER.length - 1) {
      previousPriority = effectivePriority;
      finalPriority    = PRIORITY_LADDER[idx + 1];
      autoDowngraded   = true;
    }
  }

  // Use finalPriority for scheduling. If downgraded, reset to new tier's natural interval.
  // Fixed-cadence (2026-08-03): anchor to the slot this territory was DUE in, not the day
  // it happened to run, so a catch-up day doesn't collapse a spread-out backlog onto one
  // future date. Falls back to rolling-from-today on a first-ever run (no prior slot).
  // Capacity-aware (2026-08-06): fixed cadence gives the target date, then we slide
  // forward to the first day under the daily cap so no day can be overloaded.
  // A run ahead of its slot (a one-off or catch-up search on a territory that is not due yet, for example tools/reed-catchup.js) leaves the slot
  // where it is: rolling it on by a whole interval would push the next regular sweep a full interval past its due date and open a gap in the
  // 30-day window. A priority downgrade is the exception: it re-bases the cadence as before.
  const notYetDue = !!existing?.next_run_date && existing.next_run_date > today && !autoDowngraded;
  const nextRunDate = notYetDue ? existing.next_run_date : computeNextRunDateCapped(
    db,
    existing?.next_run_date || null,
    today,
    finalPriority,
    autoDowngraded ? null : effectiveInterval
  );

  // -- Step 3: Stamp results + scheduling -----------------------------------------
  db.prepare(`
    UPDATE territory_searches SET
      active_within     = ?,
      cv_limit          = ?,
      candidate_count   = ?,
      new_to_zoho       = ?,
      duplicates        = ?,
      skipped           = ?,
      errors            = ?,
      credits_remaining = ?,
      last_searched     = ?,
      next_run_date     = ?
    WHERE job_title=? AND location=? AND distance=? AND keywords=?
  `).run(
    defaults.activeWithin, String(defaults.cvLimit),
    candidateCount ?? null, newToZoho ?? null, duplicates ?? null,
    skipped ?? null, errors ?? null, creditsRemaining ?? null,
    today, nextRunDate,
    normTitle, normLoc, winningDistance, normKw
  );

  // Apply priority downgrade + clear custom interval if triggered
  if (autoDowngraded) {
    db.prepare(
      'UPDATE territory_searches SET priority = ?, interval_days = NULL WHERE job_title=? AND location=? AND distance=? AND keywords=?'
    ).run(finalPriority, normTitle, normLoc, winningDistance, normKw);
  }

  return { jobTitle: normTitle, location: normLoc, distance: winningDistance, keywords: normKw, nextRunDate, effectivePriority: finalPriority, autoDowngraded, previousPriority };
}

/**
 * Reed half bookkeeping (docs/parity/reed-first-page.md, rule R4).
 *
 * territory_searches is marked "searched" after every run because the Caterer half happened and spent its credits. That says nothing about
 * the Reed half, so a run whose Reed half did not happen must not make the territory look fully done. The rule, in one place:
 *
 *   reed_pending_since (nullable TEXT date, added here when missing) is set to today when a run records reed status 'failed' (the first search
 *   page could not be fetched) or 'auth_failed', keeping the OLDEST date of an open episode; it is cleared by a run that records 'ok' or 'empty'
 *   (Reed was searched; a genuine empty pool counts). Any other status (Reed off, held, daily limit, screening halt) leaves it as it was.
 *   The FIRST failure of an episode (mark was empty) and only status 'failed' also pulls next_run_date forward to the first day from tomorrow
 *   (UTC) with free daily capacity, when it is later than that: one automatic retry through the normal queue-due path. A second failure keeps
 *   the normal cadence and the mark stays; tools/reed-catchup.js lists every marked territory and every run without a good Reed half.
 *
 * Never throws into the caller's run: a missing table or a locked database returns {error}.
 */
function ensureReedPendingColumn(db) {
  const cols = db.prepare('PRAGMA table_info(territory_searches)').all().map((c) => c.name);
  if (!cols.includes('reed_pending_since')) db.exec('ALTER TABLE territory_searches ADD COLUMN reed_pending_since TEXT');
}

function markReedHalf(db, { jobTitle, location, keywords, distance, status, today, cap = DAILY_TERRITORY_CAP }) {
  try {
    const open = status === 'failed' || status === 'auth_failed';
    const close = status === 'ok' || status === 'empty';
    if (!open && !close) return { changed: false };
    ensureReedPendingColumn(db);
    const key = [normaliseJobTitle(jobTitle), normaliseLocation(location), distance, normaliseKeywords(keywords || '')];
    const row = db.prepare('SELECT id, reed_pending_since, next_run_date FROM territory_searches WHERE job_title=? AND location=? AND distance=? AND keywords=?').get(...key);
    if (!row) return { changed: false, missing: true };
    const day = today || new Date().toISOString().slice(0, 10);
    if (close) {
      if (!row.reed_pending_since) return { changed: false };
      db.prepare('UPDATE territory_searches SET reed_pending_since = NULL WHERE id = ?').run(row.id);
      return { changed: true, cleared: true };
    }
    const first = !row.reed_pending_since;
    if (first) db.prepare('UPDATE territory_searches SET reed_pending_since = ? WHERE id = ?').run(day, row.id);
    let retryDate = null;
    if (first && status === 'failed') {
      const t = new Date(`${day}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 1);
      let d = t.toISOString().slice(0, 10);
      const count = db.prepare('SELECT COUNT(*) c FROM territory_searches WHERE enabled=1 AND next_run_date=?');
      for (let i = 0; i < 365 && count.get(d).c >= cap; i++) {
        t.setUTCDate(t.getUTCDate() + 1);
        d = t.toISOString().slice(0, 10);
      }
      if (!row.next_run_date || row.next_run_date > d) {
        db.prepare('UPDATE territory_searches SET next_run_date = ? WHERE id = ?').run(d, row.id);
        retryDate = d;
      }
    }
    return { changed: true, pending: true, first, retryDate };
  } catch (e) {
    return { changed: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/**
 * Return all due territories (enabled=1, next_run_date <= today, or NULL).
 * Sorted: high priority first, then by next_run_date ascending.
 * Includes sources field (defaults to 'caterer' if NULL).
 */
function getDueTerritories(db) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT *, COALESCE(sources, 'caterer') as sources FROM territory_searches
    WHERE enabled = 1
      AND (next_run_date IS NULL OR next_run_date <= ?)
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      next_run_date ASC
  `).all(today);
}

module.exports = {
  PRIORITY_DAYS,
  getPriorityDays,
  loadDefaults,
  normaliseLocation,
  normaliseJobTitle,
  normaliseKeywords,
  computeNextRunDate,
  computeNextRunDateFixed,
  computeNextRunDateCapped,
  DAILY_TERRITORY_CAP,
  normaliseInputs,
  upsertTerritory,
  markReedHalf,
  getDueTerritories,
};
