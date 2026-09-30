/**
 * query-territory.js
 * Prints the territory_searches table in a readable format.
 *
 * Usage:
 *   node scripts/query-territory.js [--json] [--priority high|medium|low] [--due] [--all]
 *
 * --json         Output raw JSON
 * --priority     Filter by priority
 * --due          Only show territories due for re-run today
 * --all          Include disabled territories (default: active only)
 */
'use strict';

const Database = require('better-sqlite3');
const paths    = require('./lib/paths');

const args = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: node scripts/query-territory.js [--json] [--priority high|medium|low] [--due] [--all]');
  process.exit(0);
}

const db             = new Database(paths.DB, { readonly: true });
const jsonMode       = args.includes('--json');
const dueOnly        = args.includes('--due');
const showAll        = args.includes('--all');
const priorityFilter = (() => {
  const i = args.indexOf('--priority');
  return i !== -1 ? args[i + 1] : null;
})();

const today = new Date().toISOString().slice(0, 10);
let query  = 'SELECT * FROM territory_searches WHERE 1=1';
const params = [];

if (!showAll) { query += ' AND enabled = 1'; }
if (priorityFilter) { query += ' AND priority = ?'; params.push(priorityFilter); }
if (dueOnly) { query += ' AND (next_run_date IS NULL OR next_run_date <= ?)'; params.push(today); }

query += ' ORDER BY CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END ASC, next_run_date ASC';

const rows = db.prepare(query).all(...params);
db.close();

if (jsonMode) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const label = dueOnly ? 'Due territories' : 'Territory Map';
console.log(`\n\u{1F4CD} ${label} (${rows.length} territories)\n`);
console.log('\u{2500}'.repeat(90));

const priorityEmoji = { high: '\u{1F534}', medium: '\u{1F7E1}', low: '\u{1F7E2}' };

rows.forEach(r => {
  const p      = priorityEmoji[r.priority] || '\u{26AA}';
  const kw     = r.keywords ? ` [kw: ${r.keywords}]` : '';
  const ival   = r.interval_days ? ` (${r.interval_days}d override)` : '';
  const status = r.enabled ? '' : ' \u{23F8}\u{FE0F} DISABLED';
  const due    = r.next_run_date && r.next_run_date <= today ? ' \u{26A1}DUE' : '';

  console.log(`${p} [${r.priority.toUpperCase().padEnd(6)}] ${r.job_title} | ${r.location} | ${r.distance}mi${kw}${status}`);
  console.log(`         Active: ${r.active_within} | CV limit: ${r.cv_limit} | Last: ${r.last_searched || 'never'}`);
  console.log(`         Next run: ${r.next_run_date || 'unscheduled'}${ival}${due}`);
  if (r.new_to_zoho !== null && r.new_to_zoho !== undefined) {
    console.log(`         Results: ${r.new_to_zoho} new \u{B7} ${r.duplicates} dupes \u{B7} ${r.skipped} skipped \u{B7} ${r.errors} errors (pool: ${r.candidate_count ?? '?'})`);
  }
  console.log('');
});
