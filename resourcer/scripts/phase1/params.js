'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonStrict, truthy, safeText } = require('./util');

// --kebab-case flag -> legacy parameter name
const FLAGS = {
  'results-url': 'RESULTS_URL',
  'search-id': 'SEARCH_ID',
  'job-title': 'JOB_TITLE',
  'location': 'LOCATION',
  'cv-limit': 'CV_LIMIT',
  'candidate-count': 'CANDIDATE_COUNT',
  'distance-miles': 'DISTANCE_MILES',
  'active-within': 'ACTIVE_WITHIN',
  'keywords': 'KEYWORDS',
  'requested-at': 'REQUESTED_AT',
  'init-status-file': 'INIT_STATUS_FILE',
  'priority': 'PRIORITY',
  'max-pages': 'MAX_PAGES',
  'sources': 'SOURCES',
  'params-file': 'PARAMS_FILE',
};
const INT_KEYS = ['CV_LIMIT', 'CANDIDATE_COUNT', 'DISTANCE_MILES', 'MAX_PAGES'];
const TRUTHY_STRING_KEYS = ['RESULTS_URL', 'SEARCH_ID', 'JOB_TITLE', 'LOCATION', 'ACTIVE_WITHIN', 'REQUESTED_AT', 'INIT_STATUS_FILE', 'PRIORITY', 'SOURCES'];

const USAGE = [
  'Usage: node scripts/phase1.js --results-url <url> --job-title <title> --location <loc> [options]',
  '   or: node scripts/phase1.js --params-file <json>',
  '',
  'Options (each is the kebab-case form of the legacy parameter):',
  '  --results-url --search-id --job-title --location --cv-limit (20) --candidate-count (0)',
  '  --distance-miles (20) --active-within ("1 month") --keywords --requested-at --init-status-file',
  '  --priority (low) --max-pages (50) --sources (caterer|reed|both) --params-file',
  '',
  'Exit codes: 0 ok, 1 fatal, 2 SESSION_STALE, 3 another pipeline active, 4 TERRITORY_MISMATCH,',
  '            5 missing/invalid params, 6 BAD_URL_ENCODING, 7 params file unreadable',
].join('\n');

function defaults() {
  return {
    RESULTS_URL: '', SEARCH_ID: '', JOB_TITLE: '', LOCATION: '', CV_LIMIT: 20, CANDIDATE_COUNT: 0,
    DISTANCE_MILES: 20, ACTIVE_WITHIN: '1 month', KEYWORDS: '', REQUESTED_AT: '', INIT_STATUS_FILE: '',
    PRIORITY: 'low', MAX_PAGES: 50, SOURCES: '', PARAMS_FILE: '',
  };
}

function toInt(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.round(Number(value));
  throw new Error(`${label} must be an integer, got '${safeText(value, 40)}'`);
}

// A value flag always consumes the next token, even one starting with '-' (the shifted KEYWORDS guard needs that).
function parseArgs(argv) {
  const values = {};
  const errors = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') { help = true; continue; }
    if (!tok.startsWith('--')) { errors.push(`unexpected argument '${tok}'`); continue; }
    let name = tok.slice(2);
    let val;
    const eq = name.indexOf('=');
    if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
    const key = FLAGS[name];
    if (!key) { errors.push(`unknown option '--${name}'`); continue; }
    if (val === undefined) {
      if (i + 1 >= argv.length) { errors.push(`option '--${name}' needs a value`); continue; }
      val = argv[++i];
    }
    values[key] = val;
  }
  return { values, errors, help };
}

function applyParamsFile(p, obj) {
  const byName = {};
  for (const k of Object.keys(obj)) byName[k.toUpperCase().replace(/-/g, '_')] = obj[k];
  for (const k of TRUTHY_STRING_KEYS) {
    if (truthy(byName[k])) p[k] = String(byName[k]);
  }
  if (Object.prototype.hasOwnProperty.call(byName, 'KEYWORDS')) {
    p.KEYWORDS = byName.KEYWORDS === null || byName.KEYWORDS === undefined ? '' : String(byName.KEYWORDS);
  }
  for (const k of INT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(byName, k) && byName[k] !== null && byName[k] !== undefined) {
      p[k] = toInt(byName[k], k);
    }
  }
}

// Returns {exit} to stop the run, {help:true}, or {params}.
function resolveParams(argv, out) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true };
  if (parsed.errors.length) {
    out(`USAGE_ERROR: ${parsed.errors.join('; ')}`);
    out(USAGE);
    return { exit: 5 };
  }
  const p = defaults();
  try {
    for (const k of Object.keys(parsed.values)) {
      p[k] = INT_KEYS.includes(k) ? toInt(parsed.values[k], k) : String(parsed.values[k]);
    }
  } catch (e) {
    out(`INVALID_PARAM: ${e.message}`);
    return { exit: 5 };
  }

  // Params-file mode: the JSON wins over CLI for the parameters it provides.
  if (p.PARAMS_FILE) {
    try {
      const obj = readJsonStrict(p.PARAMS_FILE);
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('top-level JSON value is not an object');
      applyParamsFile(p, obj);
      out(`PARAMS_FILE_LOADED: ${p.PARAMS_FILE}`);
    } catch (e) {
      out(`PARAMS_FILE_ERROR: ${p.PARAMS_FILE} unreadable or malformed: ${safeText(e.message, 300)}`);
      return { exit: 7 };
    }
  }

  // Mandatory parameters: no silent M1/Chef fallback (2026-04-17 territory mislabelling).
  for (const k of ['RESULTS_URL', 'JOB_TITLE', 'LOCATION']) {
    if (!p[k] || !String(p[k]).trim()) {
      out(`MISSING_PARAM: ${k} is required.`);
      return { exit: 5 };
    }
  }

  // SOURCES: an argument dropped by a caller is recovered from the init status file (2026-05-21).
  if (!p.SOURCES || !p.SOURCES.trim()) {
    p.SOURCES = '';
    if (p.INIT_STATUS_FILE && fs.existsSync(p.INIT_STATUS_FILE)) {
      try {
        const init = readJsonStrict(p.INIT_STATUS_FILE);
        if (init && init.sources) {
          p.SOURCES = String(init.sources);
          out(`SOURCES_RECOVERED: read from INIT_STATUS_FILE -> '${p.SOURCES}' (caller did not pass --sources)`);
        }
      } catch (e) {
        out(`SOURCES_RECOVERY_FAILED: INIT_STATUS_FILE unreadable (${safeText(e.message, 200)})`);
      }
    }
    if (!p.SOURCES.trim()) {
      p.SOURCES = 'caterer';
      out("SOURCES_FALLBACK: defaulting to 'caterer' (no arg, no usable INIT_STATUS_FILE)");
    }
  }
  p.SOURCES = p.SOURCES.trim().toLowerCase();
  if (!['caterer', 'reed', 'both'].includes(p.SOURCES)) {
    out(`INVALID_SOURCES: '${safeText(p.SOURCES, 40)}' is not one of caterer|reed|both`);
    return { exit: 5 };
  }

  if (/^(none|\(none\)|n\/a|null|undefined|-)$/i.test(p.KEYWORDS)) {
    out(`KEYWORDS sanitised: '${p.KEYWORDS}' -> ''`);
    p.KEYWORDS = '';
  }
  // An empty KEYWORDS can swallow the next named argument in a nested shell call.
  const shifted = p.KEYWORDS.match(/^-LOCATION(?:[:=]|\s+)\s*(.+)$/i);
  if (shifted) {
    const recovered = shifted[1].trim();
    if (recovered) {
      out(`WARN detected shifted KEYWORDS arg ('${p.KEYWORDS}') - recovering LOCATION='${recovered}'`);
      p.LOCATION = recovered;
      p.KEYWORDS = '';
    }
  }
  if (p.INIT_STATUS_FILE) p.INIT_STATUS_FILE = path.resolve(p.INIT_STATUS_FILE);
  return { params: p };
}

module.exports = { resolveParams, parseArgs, applyParamsFile, USAGE, FLAGS, defaults };
