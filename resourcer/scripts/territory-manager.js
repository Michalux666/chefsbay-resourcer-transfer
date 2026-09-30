#!/usr/bin/env node
/**
 * territory-manager.js
 * CLI for managing the territory_searches table.
 *
 * -- Core principle --------------------------------------------------------------
 * All territory entries share the same defaults (distance, activeWithin, cvLimit).
 * Defaults are stored in config/territory-defaults.json - change there to update globally.
 * Adding a territory only requires job title + location. Everything else is automatic.
 *
 * -- Commands --------------------------------------------------------------------
 *   defaults                           show current default values
 *   list [--priority h|m|l] [--due] [--all]
 *   add --title <job_title> --loc <location> [--kw <keywords>] [--priority high|medium|low]
 *         [--dist <miles>] [--active <period>] [--limit <n>]   <- override defaults (rare)
 *   set-priority <id> <high|medium|low>
 *   set-interval <id> <days>           override days between runs (0 = reset to priority default)
 *   enable <id>
 *   disable <id>
 *   delete <id>                        permanent - prefer disable
 *   due                                list territories due today
 *   recalc                             recompute all next_run_date values
 *   import-csv <file>                  bulk import (job_title + location required; rest = defaults)
 *
 * -- CSV import format -----------------------------------------------------------
 *   job_title,location[,keywords][,priority]
 *   Chef,M1
 *   Sous Chef,LS1,,high
 *   Kitchen Porter DBS,L1,dbs,medium
 *
 * Usage: node scripts/territory-manager.js <command> [options]
 */
'use strict';

const Database = require('better-sqlite3');
const fs       = require('fs');
const paths    = require('./lib/paths');
const {
  loadDefaults,
  normaliseInputs,
  computeNextRunDate,
  upsertTerritory,
  getDueTerritories,
  PRIORITY_DAYS,
} = require('./territory-utils');

const args = process.argv.slice(2);
const cmd  = args[0];

const DEFAULTS  = loadDefaults();

// Only the DB commands open the file, and never create it: territory_searches lives in the
// real candidates.db, so an empty file created here would only hide a missing restore.
const DB_COMMANDS = ['list', 'add', 'set-priority', 'set-interval', 'enable', 'disable', 'delete', 'due', 'recalc', 'import-csv'];
const db        = DB_COMMANDS.includes(cmd) ? new Database(paths.DB, { fileMustExist: true }) : null;

// Ensure DB is always closed, even on unhandled errors
process.on('exit', () => { try { if (db) db.close(); } catch {} });

// -- Helpers ---------------------------------------------------------------------
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
function hasFlag(name) { return args.includes(name); }

const EMOJI     = { high: '\u{1F534}', medium: '\u{1F7E1}', low: '\u{1F7E2}' };
const SRC_EMOJI = { caterer: '\u{1F373}', reed: '\u{1F4CB}', both: '\u{1F4E1}' };
const MIDDOT    = '\u{B7}';
const RULE      = '\u{2500}';

function printRow(r) {
  const status = r.enabled ? '' : ' [DISABLED]';
  const kw     = r.keywords ? ` [kw: ${r.keywords}]` : '';
  const ival   = r.interval_days ? ` (custom: ${r.interval_days}d)` : '';
  const due    = r.next_run_date && r.next_run_date <= new Date().toISOString().slice(0, 10) ? ' \u{26A1}DUE' : '';
  const src    = r.sources || 'caterer';
  const srcLabel = `${SRC_EMOJI[src] || '\u{1F4E1}'} ${src}`;
  console.log(`${EMOJI[r.priority] || '\u{26AA}'} [${r.id}] ${r.job_title} | ${r.location} | ${r.distance}mi | Source: ${srcLabel}${kw}${status}`);
  console.log(`     Priority: ${r.priority}${ival} | Active: ${r.active_within} | Limit: ${r.cv_limit}`);
  console.log(`     Last run: ${r.last_searched || 'never'} | Next run: ${r.next_run_date || 'unscheduled'}${due}`);
  if (r.new_to_zoho !== null && r.new_to_zoho !== undefined) {
    console.log(`     Results: ${r.new_to_zoho} new ${MIDDOT} ${r.duplicates} dupes ${MIDDOT} ${r.skipped} skipped ${MIDDOT} ${r.errors} errors (pool: ${r.candidate_count ?? '?'})`);
  }
  console.log('');
}

// -- Commands --------------------------------------------------------------------
switch (cmd) {

  // -- defaults --------------------------------------------------------------
  case 'defaults': {
    console.log('\n\u{2699}\u{FE0F}  Territory Defaults (config/territory-defaults.json)\n');
    console.log(`  distance:    ${DEFAULTS.distance} miles`);
    console.log(`  activeWithin: ${DEFAULTS.activeWithin}`);
    console.log(`  cvLimit:     ${DEFAULTS.cvLimit} CVs per run`);
    console.log(`  priority:    ${DEFAULTS.priority}`);
    console.log(`  hideViewed:  ${DEFAULTS.hideViewed} days`);
    console.log(`  sources:     ${DEFAULTS.sources || 'caterer'}`);
    console.log(`\nPriority intervals:`);
    console.log(`  ${EMOJI.high} high   \u{2192} every  ${PRIORITY_DAYS.high} days`);
    console.log(`  ${EMOJI.medium} medium \u{2192} every ${PRIORITY_DAYS.medium} days`);
    console.log(`  ${EMOJI.low} low    \u{2192} every ${PRIORITY_DAYS.low} days`);
    console.log('');
    break;
  }

  // -- list ------------------------------------------------------------------
  case 'list': {
    const priorityFilter = flag('--priority');
    const dueOnly        = hasFlag('--due');
    const showAll        = hasFlag('--all');
    const today          = new Date().toISOString().slice(0, 10);

    let query  = 'SELECT * FROM territory_searches WHERE 1=1';
    const params = [];
    if (!showAll) { query += ' AND enabled = 1'; }
    if (priorityFilter) { query += ' AND priority = ?'; params.push(priorityFilter); }
    if (dueOnly) { query += ' AND (next_run_date IS NULL OR next_run_date <= ?)'; params.push(today); }
    query += ' ORDER BY CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, next_run_date ASC';

    const rows  = db.prepare(query).all(...params);
    const label = dueOnly ? 'Due territories' : 'Territory Map';
    console.log(`\n\u{1F4CD} ${label} (${rows.length})\n${RULE.repeat(80)}\n`);
    if (rows.length === 0) { console.log('  (none)\n'); break; }
    rows.forEach(printRow);
    break;
  }

  // -- add -------------------------------------------------------------------
  case 'add': {
    const jobTitle = flag('--title');
    const location = flag('--loc');
    if (!jobTitle || !location) {
      console.error('Required: --title <job_title> --loc <location>');
      console.error('Optional overrides: --kw <keywords> --priority high|medium|low --dist <miles> --active <period> --limit <n>');
      process.exit(1);
    }

    const keywords   = flag('--kw') || '';
    const priority   = flag('--priority') || DEFAULTS.priority;
    const sourcesArg = flag('--sources') || DEFAULTS.sources || 'caterer';
    // Rare overrides - only used when this territory genuinely needs non-default values
    const distOverride   = flag('--dist')   ? parseInt(flag('--dist'), 10)   : null;
    const activeOverride = flag('--active') || null;
    const limitOverride  = flag('--limit')  ? parseInt(flag('--limit'), 10)  : null;

    const valid = ['high', 'medium', 'low'];
    if (!valid.includes(priority)) {
      console.error(`Invalid priority "${priority}" \u{2014} must be: high, medium, low`);
      process.exit(1);
    }

    const validSources = ['caterer', 'reed', 'both'];
    if (!validSources.includes(sourcesArg)) {
      console.error(`Invalid sources "${sourcesArg}" \u{2014} must be: caterer, reed, both`);
      process.exit(1);
    }

    // All adds go through upsertTerritory for "biggest distance wins" consolidation.
    // --dist override is passed as searchDistance - upsertTerritory keeps max(existing, search, default).
    const result = upsertTerritory(db, {
      jobTitle, location, keywords,
      searchDistance:    distOverride || null,  // biggest wins - won't downgrade existing
      initialPriority:  priority,
      sources:          sourcesArg,
      candidateCount: null, newToZoho: null, duplicates: null,
      skipped: null, errors: null, creditsRemaining: null, lastSearched: null,
    });

    // Apply activeWithin / cvLimit overrides directly on the row if provided
    if (activeOverride || limitOverride) {
      const updates = [];
      const vals    = [];
      if (activeOverride) { updates.push('active_within = ?'); vals.push(activeOverride); }
      if (limitOverride)  { updates.push('cv_limit = ?');      vals.push(String(limitOverride)); }
      vals.push(result.jobTitle, result.location, result.distance, result.keywords);
      db.prepare(`UPDATE territory_searches SET ${updates.join(', ')} WHERE job_title=? AND location=? AND distance=? AND keywords=?`).run(...vals);
    }

    // Set the requested priority (upsertTerritory preserves existing on UPDATE, so force it here for add)
    {
      const norm = normaliseInputs({ jobTitle, location, keywords, distance: result.distance });
      const row = db.prepare(
        'SELECT id, last_searched, interval_days FROM territory_searches WHERE job_title=? AND location=? AND distance=? AND keywords=?'
      ).get(norm.jobTitle, norm.location, result.distance, norm.keywords);

      if (row) {
        const nextRunDate = computeNextRunDate(row.last_searched, priority, row.interval_days);
        db.prepare('UPDATE territory_searches SET priority=?, next_run_date=?, sources=? WHERE id=?').run(priority, nextRunDate, sourcesArg, row.id);
        console.log(`\u{2705} Territory: ${result.jobTitle} | ${result.location} | ${result.distance}mi | ${priority} | ${SRC_EMOJI[sourcesArg] || '\u{1F4E1}'} ${sourcesArg} | next: ${nextRunDate}`);
        if (distOverride && result.distance > distOverride) {
          console.log(`   \u{2139}\u{FE0F}  Existing distance (${result.distance}mi) is larger than requested (${distOverride}mi) \u{2014} kept larger`);
        } else if (distOverride) {
          console.log(`   \u{1F4CF} Distance set to ${result.distance}mi (biggest wins)`);
        }
        if (activeOverride) console.log(`   \u{26A0}\u{FE0F}  Active override: ${activeOverride} (default is ${DEFAULTS.activeWithin})`);
        if (limitOverride)  console.log(`   \u{26A0}\u{FE0F}  Limit override: ${limitOverride} (default is ${DEFAULTS.cvLimit})`);
      }
    }
    break;
  }

  // -- set-priority ----------------------------------------------------------
  case 'set-priority': {
    const id       = parseInt(args[1], 10);
    const priority = args[2];
    if (!id || !priority) { console.error('Usage: set-priority <id> <high|medium|low>'); process.exit(1); }
    if (!['high','medium','low'].includes(priority)) { console.error(`Invalid priority: ${priority}`); process.exit(1); }

    const row = db.prepare('SELECT * FROM territory_searches WHERE id=?').get(id);
    if (!row) { console.error(`No territory with id ${id}`); process.exit(1); }

    const nextRunDate = computeNextRunDate(row.last_searched, priority, row.interval_days);
    db.prepare('UPDATE territory_searches SET priority=?, next_run_date=? WHERE id=?').run(priority, nextRunDate, id);
    console.log(`\u{2705} [${id}] ${row.job_title} | ${row.location} \u{2192} priority: ${priority} | next: ${nextRunDate}`);
    break;
  }

  // -- set-interval ----------------------------------------------------------
  case 'set-interval': {
    const id   = parseInt(args[1], 10);
    const days = parseInt(args[2], 10);
    if (!id || isNaN(days)) { console.error('Usage: set-interval <id> <days>  (0 = reset to priority default)'); process.exit(1); }

    const row = db.prepare('SELECT * FROM territory_searches WHERE id=?').get(id);
    if (!row) { console.error(`No territory with id ${id}`); process.exit(1); }

    const effectiveDays = days > 0 ? days : null;
    const nextRunDate   = computeNextRunDate(row.last_searched, row.priority, effectiveDays);
    db.prepare('UPDATE territory_searches SET interval_days=?, next_run_date=? WHERE id=?').run(effectiveDays, nextRunDate, id);

    const label = effectiveDays ? `${effectiveDays} days (custom)` : `${PRIORITY_DAYS[row.priority]} days (priority default)`;
    console.log(`\u{2705} [${id}] ${row.job_title} | ${row.location} \u{2192} interval: ${label} | next: ${nextRunDate}`);
    break;
  }

  // -- enable / disable ------------------------------------------------------
  case 'enable':
  case 'disable': {
    const id  = parseInt(args[1], 10);
    const val = cmd === 'enable' ? 1 : 0;
    if (!id) { console.error(`Usage: ${cmd} <id>`); process.exit(1); }

    const row = db.prepare('SELECT * FROM territory_searches WHERE id=?').get(id);
    if (!row) { console.error(`No territory with id ${id}`); process.exit(1); }

    db.prepare('UPDATE territory_searches SET enabled=? WHERE id=?').run(val, id);
    const icon = val ? '\u{2705}' : '\u{23F8}\u{FE0F} ';
    console.log(`${icon} [${id}] ${row.job_title} | ${row.location} \u{2192} ${cmd.toUpperCase()}D`);
    break;
  }

  // -- delete ----------------------------------------------------------------
  case 'delete': {
    const id = parseInt(args[1], 10);
    if (!id) { console.error('Usage: delete <id>'); process.exit(1); }

    const row = db.prepare('SELECT * FROM territory_searches WHERE id=?').get(id);
    if (!row) { console.error(`No territory with id ${id}`); process.exit(1); }

    db.prepare('DELETE FROM territory_searches WHERE id=?').run(id);
    console.log(`\u{1F5D1}\u{FE0F}  [${id}] ${row.job_title} | ${row.location} \u{2192} DELETED`);
    break;
  }

  // -- due -------------------------------------------------------------------
  case 'due': {
    const rows  = getDueTerritories(db);
    const today = new Date().toISOString().slice(0, 10);
    console.log(`\n\u{23F0} Due territories (${today}) \u{2014} ${rows.length} found\n${RULE.repeat(80)}\n`);
    if (rows.length === 0) { console.log('  Nothing due today \u{1F389}\n'); break; }
    rows.forEach(printRow);
    break;
  }

  // -- recalc ----------------------------------------------------------------
  case 'recalc': {
    console.log('Recalculating next_run_date for all rows...');
    const rows   = db.prepare('SELECT * FROM territory_searches').all();
    const update = db.prepare('UPDATE territory_searches SET next_run_date=? WHERE id=?');
    const recalcAll = db.transaction(rows => {
      for (const r of rows) {
        const nrd = computeNextRunDate(r.last_searched, r.priority, r.interval_days);
        update.run(nrd, r.id);
        console.log(`  [${r.id}] ${r.job_title} | ${r.location} \u{2192} ${nrd}`);
      }
    });
    recalcAll(rows);
    console.log(`\n\u{2705} ${rows.length} rows recalculated.`);
    break;
  }

  // -- import-csv ------------------------------------------------------------
  case 'import-csv': {
    const csvPath = args[1];
    if (!csvPath || !fs.existsSync(csvPath)) {
      console.error('Usage: import-csv <path/to/file.csv>');
      console.error('\nMinimum CSV format (header required):');
      console.error('  job_title,location');
      console.error('  Chef,M1');
      console.error('\nOptional columns: keywords, priority');
      console.error('  Chef,M1,,high');
      console.error('  Kitchen Porter DBS,L1,dbs,medium');
      process.exit(1);
    }

    const raw     = fs.readFileSync(csvPath, 'utf8');
    const lines   = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/[^a-z_]/g, ''));

    const COL = {
      jobTitle:  headers.indexOf('job_title'),
      location:  headers.indexOf('location'),
      keywords:  headers.indexOf('keywords'),
      priority:  headers.indexOf('priority'),
    };

    if (COL.jobTitle === -1 || COL.location === -1) {
      console.error('CSV must have at least: job_title, location columns');
      process.exit(1);
    }

    let added = 0, updated = 0, skipped = 0;

    for (const line of lines.slice(1)) {
      const cols     = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const jobTitle = cols[COL.jobTitle] || '';
      const location = cols[COL.location] || '';
      if (!jobTitle || !location) { skipped++; continue; }

      const keywords = COL.keywords >= 0 ? (cols[COL.keywords] || '') : '';
      const priority = COL.priority >= 0 ? (cols[COL.priority] || DEFAULTS.priority) : DEFAULTS.priority;

      const norm     = normaliseInputs({ jobTitle, location, keywords });
      // Check existence by job+location+keywords (any distance) - upsertTerritory may consolidate
      const existing = db.prepare(
        'SELECT id FROM territory_searches WHERE job_title=? AND location=? AND keywords=?'
      ).get(norm.jobTitle, norm.location, norm.keywords);

      const result = upsertTerritory(db, {
        jobTitle, location, keywords,
        candidateCount: null, newToZoho: null, duplicates: null,
        skipped: null, errors: null, creditsRemaining: null, lastSearched: null,
      });

      // Set the priority from CSV
      const row = db.prepare(
        'SELECT id, last_searched, interval_days FROM territory_searches WHERE job_title=? AND location=? AND distance=? AND keywords=?'
      ).get(norm.jobTitle, norm.location, result.distance, norm.keywords);
      if (row) {
        const nextRunDate = computeNextRunDate(row.last_searched, priority, row.interval_days);
        db.prepare('UPDATE territory_searches SET priority=?, next_run_date=? WHERE id=?').run(priority, nextRunDate, row.id);
      }

      if (existing) { updated++; console.log(`  ~ Updated: ${norm.jobTitle} | ${norm.location} | ${result.distance}mi [${priority}]`); }
      else          { added++;   console.log(`  + Added:   ${norm.jobTitle} | ${norm.location} | ${result.distance}mi [${priority}]`); }
    }

    console.log(`\n\u{2705} Import complete: ${added} added, ${updated} updated, ${skipped} skipped`);
    console.log(`   Defaults applied: ${DEFAULTS.distance}mi | ${DEFAULTS.activeWithin} | ${DEFAULTS.cvLimit} CVs/run`);
    break;
  }

  // -- help ------------------------------------------------------------------
  default: {
    const d = DEFAULTS;
    console.log(`
Territory Manager

Current defaults (config/territory-defaults.json):
  distance: ${d.distance}mi | active: ${d.activeWithin} | limit: ${d.cvLimit} CVs | priority: ${d.priority}

Commands:
  defaults                           show defaults
  list [--priority h|m|l] [--due] [--all]
  add --title <title> --loc <postcode>
      [--kw <keywords>]                  e.g. dbs, nvq
      [--priority high|medium|low]       default: ${d.priority}
      [--sources caterer|reed|both]      default: ${d.sources || 'caterer'}
      [--dist <miles>]                   override (default: ${d.distance}mi)
      [--active <period>]                override (default: ${d.activeWithin})
      [--limit <n>]                      override (default: ${d.cvLimit})
  set-priority <id> <high|medium|low>
  set-interval <id> <days>           0 = reset to priority default
  enable <id> | disable <id>
  delete <id>                        permanent - prefer disable
  due                                list overdue territories
  recalc                             recompute all next_run_date values
  import-csv <file>                  columns: job_title,location[,keywords][,priority]

Priority intervals:  high=${PRIORITY_DAYS.high}d  medium=${PRIORITY_DAYS.medium}d  low=${PRIORITY_DAYS.low}d
`);
  }
}

// db.close() handled by process.on('exit') handler
