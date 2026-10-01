'use strict';
// Configuration of the CV screening stage: defaults.json (built in) <- config/cv-screening.json (the owner's file)
// <- environment. A key the code does not know is ignored (with a warning, so a typo is noticed). Anything the owner's file
// asked for and the code cannot apply (not JSON, a wrong type, out of range, a blanked option, a missing required file) is a
// FAULT (cfg.fault): the values then fall back to the defaults for display only and whoever decides must fail closed.
// Nothing here throws.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const env = require('../env');
const DEFAULTS_RAW = require('./defaults.json');

const SIDES = ['approve', 'reject'];
const MODES = ['off', 'shadow', 'on'];
const DEFAULT_MODE = 'shadow';
const LEVEL_NAMES = ['entry', 'mid', 'senior', 'head', 'not_a_kitchen_role', 'unknown'];
const SEARCH_LEVEL_ANSWERS = ['entry', 'mid', 'senior', 'head', 'not_a_kitchen_role', 'unclear'];
const SENIORITY_OPTIONS = ['much_more_junior', 'one_step_junior', 'comparable', 'one_step_senior', 'two_or_more_steps_senior', 'cannot_tell'];
const PROGRESSION_OPTIONS = ['rising', 'stable', 'declining', 'unclear'];
const REJECT_SWITCHES = ['noRelevantExperience', 'careerChange', 'stale', 'overQualified', 'underQualified'];
const FREE_MAPS = new Set(['searchLevelOverrides']);
const NULLABLE = new Set(['rejectAbove']);

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function stripUnderscore(o) {
  if (Array.isArray(o)) return o.map(stripUnderscore);
  if (!isPlain(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = stripUnderscore(v);
  return out;
}

const DEFAULTS = Object.freeze(stripUnderscore(DEFAULTS_RAW));

// Range of a numeric setting, from its name: shares and probabilities 0..1, months, years, milliseconds, counts.
function rangeOf(key) {
  if (/(?:P|Share|Ceiling|Rate|Confidence|Above|Parse|Floor|Full)$/.test(key) && !/Months$/.test(key)) return [0, 1];
  if (/^(?:low|high|probability)$/.test(key)) return [0, 1];
  if (/^(?:costWasted|costLost)$/.test(key)) return [0.001, 1000];
  if (/Months$/.test(key)) return [0, 1200];
  if (/Years$/.test(key)) return [0, 60];
  if (/Ms$/.test(key)) return [0, 3600000];
  if (key === 'shadowMaxSeconds') return [1, 3600];
  if (/Sec$/.test(key)) return [0, 86400 * 30];
  if (/Level$/.test(key)) return [0, 9];
  if (/Chars$/.test(key)) return [1, 20000];
  if (key === 'maxRoles') return [1, 20];
  if (/^(?:maxQualifications|maxEntries|maxAttempts|maxInvalidAttempts|concurrency|invalidStreakMax|retentionDays|rejectRateMinCandidates|fallbackMinCandidates|shadowStopAfterFailures|minYear|version)$/.test(key)) return [0, 100000];
  return [-Infinity, Infinity];
}

// Recursive merge of `over` into a copy of `base`, keeping the shape and types of base. Anything else is dropped with a warning.
function mergeKnown(base, over, where, warnings) {
  const out = clone(base);
  if (!isPlain(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;
    const here = where ? `${where}.${k}` : k;
    if (FREE_MAPS.has(k) && isPlain(base[k])) {
      const map = {};
      if (!isPlain(v)) warnings.push(`${here} must be an object; ignored`);
      else for (const [title, lvl] of Object.entries(v)) {
        if (title.startsWith('_')) continue;
        if (SEARCH_LEVEL_ANSWERS.includes(lvl) && lvl !== 'unclear') map[String(title).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100)] = lvl;
        else warnings.push(`${here}: the level of one title is not one of entry, mid, senior, head, not_a_kitchen_role; ignored`);
      }
      out[k] = map;
      continue;
    }
    if (!(k in base)) { warnings.push(`unknown setting ${here} ignored`); continue; }
    const def = base[k];
    if (v === null && NULLABLE.has(k)) { out[k] = null; continue; }
    if (isPlain(def)) {
      if (!isPlain(v)) { warnings.push(`${here} must be an object; using the default`); continue; }
      out[k] = mergeKnown(def, v, here, warnings);
    } else if (Array.isArray(def)) {
      if (Array.isArray(v) && v.every(x => typeof x === 'string')) out[k] = v.slice(0, 60);
      else if (Array.isArray(v) && def.every(x => typeof x === 'string')) warnings.push(`${here} must be a list of words; using the default`);
      else if (Array.isArray(v)) out[k] = v.slice(0, 10);
      else warnings.push(`${here} must be a list; using the default`);
    } else if (typeof def === 'number') {
      const n = typeof v === 'number' ? v : NaN;
      const [lo, hi] = rangeOf(k);
      if (!Number.isFinite(n) || n < lo || n > hi) warnings.push(`${here} must be a number from ${lo} to ${hi}; using ${def}`);
      else out[k] = n;
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else warnings.push(`${here} must be true or false; using ${def}`);
    } else if (typeof def === 'string') {
      if (typeof v === 'string' && v.trim() && v.length <= 2000) out[k] = v;
      else warnings.push(`${here} must be a text; using the default`);
    }
  }
  return out;
}

function originOk(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

function numEnv(v, def, lo, hi) {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? def : Math.min(hi, Math.max(lo, n));
}

function boolEnv(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(s)) return false;
  return def;
}

function goodText(s) { return typeof s === 'string' && s.trim().length > 0 && s.length <= 2000; }

// The question wording must give the code every option it reads; otherwise the whole section is replaced.
function questionsProblem(q) {
  if (!isPlain(q)) return 'is not an object';
  for (const k of ['agencyContext', 'dataNote', 'ladder', 'version']) if (!goodText(q[k])) return `${k} is empty`;
  for (const k of ['roleRelevance', 'overallMatch']) {
    const L = q[k] && q[k].levels;
    if (!goodText(q[k] && q[k].instructions)) return `${k}.instructions is empty`;
    if (!Array.isArray(L) || L.length < 2 || L.length > 10 || !L.every(goodText)) return `${k}.levels needs 2 to 10 texts`;
  }
  const opts = [['roleSeniority', SENIORITY_OPTIONS], ['progression', PROGRESSION_OPTIONS], ['searchLevel', SEARCH_LEVEL_ANSWERS]];
  for (const [k, names] of opts) {
    if (!goodText(q[k] && q[k].instructions)) return `${k}.instructions is empty`;
    const o = q[k] && q[k].options;
    if (!isPlain(o)) return `${k}.options is missing`;
    for (const n of names) if (!goodText(o[n])) return `${k}.options.${n} is empty`;
  }
  if (!goodText(q.careerChange && q.careerChange.instructions)) return 'careerChange.instructions is empty';
  const c = q.careerChange.criteria;
  if (!isPlain(c) || !goodText(c.true) || !goodText(c.false)) return 'careerChange.criteria needs true and false';
  if (!goodText(q.injection && q.injection.instructions)) return 'injection.instructions is empty';
  return null;
}

// The injection patterns are compiled once; a pattern that does not compile, or that could match the empty text, is dropped with a warning.
function compilePatterns(list, warnings) {
  const out = [];
  for (const src of list) {
    try {
      const re = new RegExp(src, 'iu');
      if (re.test('')) { warnings.push('injection.patterns: a pattern that matches the empty text was dropped'); continue; }
      out.push(re);
    } catch (e) {
      warnings.push('injection.patterns: a pattern that is not a valid regular expression was dropped');
    }
  }
  return out;
}

function signatureOf(cfg) {
  const material = JSON.stringify([
    cfg.thresholds, cfg.levels, cfg.searchLevelOverrides, cfg.input, cfg.facts, cfg.questions, cfg.jev.model,
    cfg.operatingPoint, cfg.tau, cfg.forced, cfg.evidence, cfg.injection, cfg.fallback,
  ]);
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function configFile(getEnv) {
  return getEnv('CV_SCREEN_CONFIG_FILE') || path.join(paths.CONFIG, 'cv-screening.json');
}

/**
 * The screening mode: off (a strict no-op), shadow (the default: evaluate and log, never block), on (the decision is applied).
 * Unset or empty is shadow. Anything unrecognised is shadow too, with a warning, so a typo can never switch blocking on.
 * @returns {{mode:string, warning:string|null}}
 */
function screenMode(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (s === '') return { mode: DEFAULT_MODE, warning: null };
  if (MODES.includes(s)) return { mode: s, warning: null };
  if (['0', 'false', 'no', 'none', 'disabled'].includes(s)) return { mode: 'off', warning: null };
  return { mode: DEFAULT_MODE, warning: `CV_SCREEN='${s.slice(0, 20)}' is not off, shadow or on; CV screening runs in ${DEFAULT_MODE} mode (it never blocks)` };
}

/** The reject threshold: rejectAbove when set, else costLost / (costLost + costWasted). */
function operatingTau(op) {
  if (typeof op.rejectAbove === 'number' && Number.isFinite(op.rejectAbove)) return op.rejectAbove;
  return op.costLost / (op.costLost + op.costWasted);
}

// A correction that is only an unknown key stays a warning (a note or a typo must not stop the pipeline); anything else that the
// owner's file asked for and the code could not apply is a fault.
const isFault = w => !/^unknown setting /.test(w);

const FAULT_KEY = 'cvconfig';

/**
 * Builds the effective configuration from the parsed file (or null), the test overrides and the environment, recording every
 * correction in `warnings`. Pure: the same inputs give the same result.
 */
function assemble(fromFile, overrides, getEnv, warnings) {
  let cfg = clone(DEFAULTS);
  if (fromFile) cfg = mergeKnown(cfg, fromFile, '', warnings);
  if (overrides) cfg = mergeKnown(cfg, overrides, '', warnings);

  const E = n => getEnv(n);
  if (E('SCREEN_GATEWAY_ORIGIN')) cfg.gateway.origin = String(E('SCREEN_GATEWAY_ORIGIN')).trim();
  if (E('SCREEN_JEV_MODEL')) cfg.jev.model = String(E('SCREEN_JEV_MODEL')).trim();
  cfg.jev.timeoutMs = numEnv(E('SCREEN_JEV_TIMEOUT_MS'), cfg.jev.timeoutMs, 100, 120000);
  cfg.jev.maxAttempts = Math.round(numEnv(E('SCREEN_MAX_ATTEMPTS'), cfg.jev.maxAttempts, 1, 6));
  cfg.jev.concurrency = Math.round(numEnv(E('CV_SCREEN_CONCURRENCY'), cfg.jev.concurrency, 1, 8));
  cfg.retry.baseMs = numEnv(E('SCREEN_BACKOFF_BASE_MS'), cfg.retry.baseMs, 0, 60000);
  cfg.retry.maxRetryAfterMs = numEnv(E('SCREEN_RETRY_AFTER_CAP_MS'), cfg.retry.maxRetryAfterMs, 0, 300000);
  for (const name of ['SCREEN_ZDR', 'SCREEN_JEV_ZDR']) if (E(name) !== undefined && E(name) !== '') cfg.jev.zeroDataRetention = boolEnv(E(name), cfg.jev.zeroDataRetention);
  if (E('CV_FALLBACK_POLICY')) cfg.fallback.policy = String(E('CV_FALLBACK_POLICY')).trim().toLowerCase();
  if (E('CV_REJECT_ABOVE') !== undefined && E('CV_REJECT_ABOVE') !== '') {
    const n = Number(E('CV_REJECT_ABOVE'));
    if (Number.isFinite(n) && n >= 0 && n <= 1) cfg.operatingPoint.rejectAbove = n;
    else warnings.push('CV_REJECT_ABOVE must be a number from 0 to 1; ignored');
  }

  cfg.gateway.origin = String(cfg.gateway.origin || '').trim().replace(/\/+$/, '');
  if (!originOk(cfg.gateway.origin)) {
    warnings.push('gateway.origin must be https (plain http only for this machine); using the default gateway');
    cfg.gateway.origin = DEFAULTS.gateway.origin;
  }
  // The gateway carries Jev only: a model name that is not Jev's must never reach it.
  if (typeof cfg.jev.model !== 'string' || !/jev/i.test(cfg.jev.model)) {
    warnings.push(`jev.model '${String(cfg.jev.model).slice(0, 40)}' is not a Jev model; the stage calls ${DEFAULTS.jev.model} only`);
    cfg.jev.model = DEFAULTS.jev.model;
  }
  cfg.jev.model = cfg.jev.model.trim();
  cfg.jev.zeroDataRetention = boolEnv(cfg.jev.zeroDataRetention, false);
  cfg.jev.timeoutMs = Math.max(100, cfg.jev.timeoutMs);
  cfg.jev.concurrency = Math.max(1, Math.round(cfg.jev.concurrency));
  cfg.jev.maxAttempts = Math.max(1, Math.round(cfg.jev.maxAttempts));
  cfg.jev.maxInvalidAttempts = Math.max(1, Math.round(cfg.jev.maxInvalidAttempts));

  const pol = String(cfg.fallback.policy === undefined ? '' : cfg.fallback.policy).trim().toLowerCase();
  if (SIDES.includes(pol)) cfg.fallback.policy = pol;
  else {
    warnings.push(`fallback.policy must be approve or reject; using ${DEFAULTS.fallback.policy}`);
    cfg.fallback.policy = DEFAULTS.fallback.policy;
  }
  cfg.fallback.keepJevReject = cfg.fallback.keepJevReject === true;

  const ev = cfg.evidence;
  if (!(ev.parseFloor < ev.parseFull)) {
    warnings.push('evidence.parseFloor must be lower than evidence.parseFull; using the defaults');
    ev.parseFloor = DEFAULTS.evidence.parseFloor;
    ev.parseFull = DEFAULTS.evidence.parseFull;
  }
  if (!(ev.thinFloorMonths < ev.thinFullMonths)) {
    warnings.push('evidence.thinFloorMonths must be lower than evidence.thinFullMonths; using the defaults');
    ev.thinFloorMonths = DEFAULTS.evidence.thinFloorMonths;
    ev.thinFullMonths = DEFAULTS.evidence.thinFullMonths;
  }
  if (!(cfg.forced.low < cfg.forced.high)) {
    warnings.push('forced.low must be lower than forced.high; using the defaults');
    cfg.forced.low = DEFAULTS.forced.low;
    cfg.forced.high = DEFAULTS.forced.high;
  }
  cfg.tau = operatingTau(cfg.operatingPoint);
  cfg.injectionRes = compilePatterns(cfg.injection.patterns, warnings);

  const bad = questionsProblem(cfg.questions);
  if (bad) {
    warnings.push(`questions ${bad}; using the built-in wording`);
    cfg.questions = clone(DEFAULTS.questions);
  }
  const nRel = cfg.questions.roleRelevance.levels.length;
  const nOverall = cfg.questions.overallMatch.levels.length;
  const T = cfg.thresholds;
  if (!Number.isInteger(T.sameFieldMinLevel) || T.sameFieldMinLevel < 1 || T.sameFieldMinLevel > nRel - 1) {
    warnings.push(`thresholds.sameFieldMinLevel must be a whole number from 1 to ${nRel - 1}; using 1`);
    T.sameFieldMinLevel = 1;
  }
  if (!Number.isInteger(T.unclearLevel) || T.unclearLevel < 0 || T.unclearLevel > nRel - 1) {
    warnings.push(`thresholds.unclearLevel must be a whole number from 0 to ${nRel - 1}; using 0 (no answer means "cannot place")`);
    T.unclearLevel = 0;
  }
  if (!Number.isInteger(T.overallWeakMaxLevel) || T.overallWeakMaxLevel < 0 || T.overallWeakMaxLevel > nOverall - 2) {
    warnings.push(`thresholds.overallWeakMaxLevel must be a whole number from 0 to ${nOverall - 2}; using ${Math.min(DEFAULTS.thresholds.overallWeakMaxLevel, nOverall - 2)}`);
    T.overallWeakMaxLevel = Math.min(DEFAULTS.thresholds.overallWeakMaxLevel, nOverall - 2);
  }

  for (const name of LEVEL_NAMES) {
    const L = cfg.levels[name];
    for (const k of ['comparableOrSenior', 'tooJunior', 'tooSenior']) {
      const keep = (L.seniority[k] || []).filter(x => SENIORITY_OPTIONS.includes(x) && x !== 'cannot_tell');
      if (keep.length !== (L.seniority[k] || []).length) warnings.push(`levels.${name}.seniority.${k} holds an answer the code does not know; those were dropped`);
      L.seniority[k] = Array.from(new Set(keep));
    }
    if (!L.seniority.comparableOrSenior.length) {
      warnings.push(`levels.${name}.seniority.comparableOrSenior is empty; using the default`);
      L.seniority.comparableOrSenior = clone(DEFAULTS.levels[name].seniority.comparableOrSenior);
    }
    for (const k of REJECT_SWITCHES) L.rejects[k] = L.rejects[k] === true;
    if (!Number.isInteger(L.relevantMinLevel) || L.relevantMinLevel < 1 || L.relevantMinLevel > nRel - 1) {
      warnings.push(`levels.${name}.relevantMinLevel must be a whole number from 1 to ${nRel - 1}; using ${Math.min(DEFAULTS.levels[name].relevantMinLevel, nRel - 1)}`);
      L.relevantMinLevel = Math.min(DEFAULTS.levels[name].relevantMinLevel, nRel - 1);
    }
    L.requireComparableOrSenior = L.requireComparableOrSenior === true;
    L.recentYears = Math.max(0, L.recentYears);
  }
  cfg.searchLevelOverrides = cfg.searchLevelOverrides || {};

  cfg.cache.answersTtlSec = Math.max(0, cfg.cache.answersTtlSec);
  cfg.cache.searchLevelTtlSec = Math.max(0, cfg.cache.searchLevelTtlSec);
  cfg.phase2.shadowStopAfterFailures = Math.max(1, Math.round(cfg.phase2.shadowStopAfterFailures));
  cfg.phase2.shadowMaxSeconds = Math.max(1, Number(cfg.phase2.shadowMaxSeconds) || DEFAULTS.phase2.shadowMaxSeconds);
  cfg.cache.maxEntries = Math.max(10, Math.round(cfg.cache.maxEntries));
  cfg.shadow.enabled = cfg.shadow.enabled === true;
  cfg.shadow.storeAnswers = cfg.shadow.storeAnswers === true;
  cfg.shadow.retentionDays = Math.max(1, Math.round(cfg.shadow.retentionDays));

  cfg.signature = signatureOf(cfg);
  cfg.warnings = warnings;
  return cfg;
}

/**
 * @param {{getEnv?:(name:string)=>string|undefined, file?:string, overrides?:object, fileRequired?:boolean}} [opts]
 *   file: use this criteria file instead of the default one (a test seam and the --config flag); it may be absent unless fileRequired.
 * @returns {object} effective, validated configuration; cfg.warnings lists everything that was corrected, cfg.tau is the reject threshold.
 *   cfg.fault is null, or {kind:'config', key:'cvconfig', detail} when the owner's file is broken (not JSON, not an object, a value of
 *   the wrong type or outside its range, a question section without every option the code reads, a rule the code cannot apply) or
 *   missing where it must exist (the default path, a file CV_SCREEN_CONFIG_FILE names, --config). The values of such a configuration are
 *   the built-in defaults, for display only: whoever DECIDES must check cfg.fault and never decide on it (fail closed, like the snippet criteria).
 */
function load(opts) {
  const o = opts || {};
  const getEnv = o.getEnv || (n => env.get(n));
  const warnings = [];

  const file = o.file || configFile(getEnv);
  const explicit = !o.file && !!getEnv('CV_SCREEN_CONFIG_FILE');
  const mustExist = !o.file || explicit || o.fileRequired === true;
  const name = path.basename(file);
  let fromFile = null;
  let fileProblem = null;
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
    if (!isPlain(fromFile)) { warnings.push(`config file ${name} does not hold an object; the built-in numbers are shown for display only, nothing is decided on them (fail closed)`); fromFile = null; fileProblem = 'it does not hold a JSON object'; }
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      warnings.push(`config file ${name} is unreadable (${String(e.message).slice(0, 80)}); the built-in numbers are shown for display only, nothing is decided on them (fail closed)`);
      fileProblem = 'it cannot be read as JSON';
    } else {
      if (explicit) warnings.push(`config file ${name} was named explicitly but does not exist; the built-in numbers are shown for display only, nothing is decided on them (fail closed)`);
      if (mustExist) fileProblem = 'the file does not exist';
    }
  }

  const cfg = assemble(fromFile, o.overrides, getEnv, warnings);

  // What is wrong with the FILE itself: the same assembly on the file alone (no test overrides, no environment), so a value from the
  // environment can never make a good file a fault and a bad value in the file always does.
  const problems = fileProblem ? [fileProblem] : (fromFile ? assemble(fromFile, null, () => undefined, []).warnings.filter(isFault) : []);
  cfg.fault = problems.length ? { kind: 'config', key: FAULT_KEY, detail: `${name} is not usable: ${problems.slice(0, 3).join('; ').slice(0, 240)}` } : null;
  cfg.configFile = file;
  cfg.configLoaded = !!fromFile;
  return cfg;
}

module.exports = {
  DEFAULTS, MODES, DEFAULT_MODE, SIDES, LEVEL_NAMES, SEARCH_LEVEL_ANSWERS, SENIORITY_OPTIONS, PROGRESSION_OPTIONS, REJECT_SWITCHES,
  FAULT_KEY, load, screenMode, mergeKnown, stripUnderscore, questionsProblem, operatingTau,
};
