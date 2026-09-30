'use strict';
// Configuration: DEFAULTS (this file) <- config/screening.json <- environment. Keys starting with an
// underscore are documentation and are ignored. config/screening.json is the owner-facing copy of
// DEFAULTS; a test asserts they agree, so the two cannot drift.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const env = require('../env');

const ENGINES = ['llm', 'jev_shadow', 'jev'];
const TIER_MODES = ['legacy', 'fixed'];

const CAL = 'CALIBRATE: placeholder from the Jev design guide, not fitted to Chefs Bay data. Tune with tools/screening-report.js (threshold sweep) before trusting it.';

const DEFAULTS = {
  version: 1,
  engine: 'jev_shadow',
  tierMode: 'legacy',
  gateway: { origin: 'https://ai-gateway.vercel.sh' },
  rubric: { staleProfileClause: false, insufficientEvidence: 'legacy' },
  redact: { enabled: true, maxSnippetChars: 4000 },
  llm: {
    model: 'anthropic/claude-sonnet-5.5',
    backupModel: 'anthropic/claude-sonnet-5',
    timeoutMs: 60000,
    maxAttempts: 3,
    maxInvalidAttempts: 2,
    maxTokens: 1500,
    concurrency: 4,
    reasoningEffort: null,
    zeroDataRetention: false,
  },
  jev: {
    model: 'typesafe-ai/jev',
    timeoutMs: 15000,
    maxAttempts: 3,
    concurrency: 6,
    maxInvalidAttempts: 2,
    maxSnippetChars: 1500,
    zeroDataRetention: false,
  },
  retry: { baseMs: 1000, capMs: 20000, maxRetryAfterMs: 30000 },
  batch: { breakerConsecutive: 3, invalidMassMin: 5, invalidMassShare: 0.5, invalidStreakMax: 3, invalidStreakTtlSec: 1800, deadlineMs: 600000, onInvalid: 'reject' },
  cache: { ttlSec: 3600, maxEntries: 5000 },
  shadow: { enabled: true, storeText: true, rate: 1, graceMs: 5000, jevMaxAttempts: 2, auditRate: 0.05, auditTimeoutMs: 30000, retentionDays: 180 },
  stage1: {
    rules: {
      'S1-NA-NONHOSP': 'shadow',
      'T-ENTRY-OVERQUAL-HEAD': 'shadow',
      'T-ENTRY-OVERQUAL-SOUS': 'shadow',
      'T-UNDER-GAP': 'shadow',
    },
  },
  decide: {
    calibration: { calibrated: false, reportId: null, date: null },
    stage1: {
      _CALIBRATE: CAL,
      rejectP: 0.9,
      approveP: 0.6,
      needCorroboration: true,
      notFitMin: 0.6,
      counterRoleMatch: 0.6,
      injectionP: 0.5,
      infoFloor: 0.5,
      notStatedP: 0.5,
      noInfoApproveHospP: 0.5,
      clearFitP: 0.6,
      clearFitHardMax: 0.5,
      approveNotFitMax: 0.5,
      titleConsistentMin: 0.3,
    },
    stage2: {
      _CALIBRATE: CAL + ' Stage 2 is after the credit is spent, so the reject bar is higher and the approve bar lower.',
      rejectP: 0.95,
      approveP: 0.5,
      needCorroboration: true,
      notFitMin: 0.6,
      counterRoleMatch: 0.6,
      injectionP: 0.5,
      infoFloor: 0.5,
      notStatedP: 0.5,
      noInfoApproveHospP: 0.5,
      clearFitP: 0.6,
      clearFitHardMax: 0.5,
      approveNotFitMax: 0.5,
      titleConsistentMin: 0.3,
    },
    ladder: {
      tier0Titles: ['catering assistant', 'kitchen hand', 'food production'],
      _note: 'Candidate title options the Jev tier question can return, grouped per search tier. inBand = acceptable. tooSenior and tooJunior = clear level mismatches. mismatch = other clear mismatches, by reason code. Anything not listed is an uncertain level and goes to review. A search tier is the legacy role tier of the search title (0 unknown/non-kitchen, 1 entry, 2 mid, 3 senior, 4 head).',
      bySearchTier: {
        '0': {
          inBand: ['entry_kp', 'commis', 'cdp_cook', 'front_of_house'],
          tooSenior: ['sous', 'head', 'management_non_kitchen'],
          tooJunior: [],
          mismatch: { reject_unrelated_industry: ['unrelated'] },
        },
        '1': {
          inBand: ['entry_kp', 'commis', 'cdp_cook'],
          tooSenior: ['sous', 'head', 'management_non_kitchen'],
          tooJunior: [],
          mismatch: { reject_unrelated_industry: ['unrelated'], reject_foh_only: ['front_of_house'] },
        },
        '2': {
          inBand: ['commis', 'cdp_cook', 'sous', 'head'],
          tooSenior: [],
          tooJunior: ['entry_kp'],
          mismatch: { reject_unrelated_industry: ['unrelated'], reject_foh_only: ['front_of_house'], reject_management_only: ['management_non_kitchen'] },
        },
        '3': {
          inBand: ['sous', 'head'],
          tooSenior: [],
          tooJunior: ['entry_kp', 'commis'],
          mismatch: { reject_unrelated_industry: ['unrelated'], reject_foh_only: ['front_of_house'], reject_management_only: ['management_non_kitchen'] },
        },
        '4': {
          inBand: ['head'],
          tooSenior: [],
          tooJunior: ['entry_kp', 'commis', 'cdp_cook'],
          mismatch: { reject_unrelated_industry: ['unrelated'], reject_foh_only: ['front_of_house'], reject_management_only: ['management_non_kitchen'] },
        },
      },
      overrides: [
        {
          name: 'cdp-specific',
          tiers: [2],
          matchAny: ['chef de partie', 'cdp', 'line cook'],
          inBand: ['cdp_cook', 'sous', 'head'],
          tooSenior: [],
          tooJunior: ['entry_kp', 'commis'],
          mismatch: { reject_unrelated_industry: ['unrelated'], reject_foh_only: ['front_of_house'], reject_management_only: ['management_non_kitchen'] },
        },
      ],
    },
  },
  gate: {
    _note: 'The promotion gate for switching engine from jev_shadow to jev. See docs/SCREENING.md.',
    minAgreement: 0.9,
    maxApprovalDeltaPoints: 3,
    minRowsPerSource: 500,
    minRowsPerRole: 50,
    maxJevApproveLlmReject: 0.05,
    maxJevRejectLlmApprove: 0.015,
    maxJevRejectOfLlmApproved: 0.05,
    minLaneAgreementLo: 0.93,
    minLaneCoverage: 0.25,
    requiredSources: ['caterer', 'reed'],
    windowDays: 21,
    confidenceBands: [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001],
    ruleMinHits: 200,
    ruleMinAgreement: 0.98,
  },
  health: { probeTimeoutMs: 3000, canaryTimeoutMs: 25000, creditsPath: '/v1/credits' },
  pageRetryPauseSec: 120,
};

function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// Deep merge into a fresh copy: neither argument is ever mutated.
function merge(base, over) {
  const out = clone(base);
  if (!isPlain(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;
    if (isPlain(v) && isPlain(out[k])) out[k] = merge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

function stripUnderscore(o) {
  if (Array.isArray(o)) return o.map(stripUnderscore);
  if (!isPlain(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = stripUnderscore(v);
  return out;
}

function num(v, def, min, max) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return def;
  return Math.min(max === undefined ? Infinity : max, Math.max(min === undefined ? -Infinity : min, n));
}

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(s)) return false;
  return def;
}

// Plain http is only accepted for this machine (tests, a local proxy): the gateway key and candidate text must not travel in clear.
function originOk(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

// A section of the wrong type (null, array, string) would crash later code; it is replaced by the default section.
function repairSections(cfg, defaults, prefix, warnings) {
  for (const [k, def] of Object.entries(defaults)) {
    if (k.startsWith('_') || k === 'ladder' || k === 'rules') continue;
    if (!isPlain(def)) continue;
    if (!isPlain(cfg[k])) {
      warnings.push(`section ${prefix}${k} has the wrong type; using the defaults`);
      cfg[k] = clone(def);
    } else {
      repairSections(cfg[k], def, `${prefix}${k}.`, warnings);
    }
  }
}

function configFile(getEnv) {
  return getEnv('SCREEN_CONFIG_FILE') || path.join(paths.CONFIG, 'screening.json');
}

/**
 * @param {{getEnv?:(name:string)=>string|undefined, file?:string, overrides?:object}} [opts]
 * @returns {object} effective, validated configuration; cfg.warnings lists anything corrected
 */
function load(opts) {
  const o = opts || {};
  const getEnv = o.getEnv || (n => env.get(n));
  const warnings = [];
  let cfg = merge(DEFAULTS, {});

  const file = o.file || configFile(getEnv);
  const explicitFile = !o.file && !!getEnv('SCREEN_CONFIG_FILE');
  let fromFile = null;
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e && e.code !== 'ENOENT') warnings.push(`config file ${path.basename(file)} unreadable (${String(e.message).slice(0, 80)}); using built-in defaults`);
    else if (explicitFile) warnings.push(`config file ${path.basename(file)} was named explicitly but does not exist; using built-in defaults`);
  }
  if (fromFile) cfg = merge(cfg, fromFile);
  if (o.overrides) cfg = merge(cfg, o.overrides);
  // Before the environment is applied: an override on a section that is null in the file would otherwise throw.
  repairSections(cfg, DEFAULTS, '', warnings);

  const E = n => getEnv(n);
  if (E('SCREEN_ENGINE')) cfg.engine = String(E('SCREEN_ENGINE')).trim().toLowerCase();
  if (E('SCREEN_TIER_MODE')) cfg.tierMode = String(E('SCREEN_TIER_MODE')).trim().toLowerCase();
  if (E('SCREEN_GATEWAY_ORIGIN')) cfg.gateway.origin = String(E('SCREEN_GATEWAY_ORIGIN')).trim();
  if (E('SCREEN_LLM_MODEL')) cfg.llm.model = String(E('SCREEN_LLM_MODEL')).trim();
  if (E('SCREEN_LLM_BACKUP_MODEL')) cfg.llm.backupModel = String(E('SCREEN_LLM_BACKUP_MODEL')).trim();
  if (E('SCREEN_JEV_MODEL')) cfg.jev.model = String(E('SCREEN_JEV_MODEL')).trim();
  if (E('SCREEN_CONCURRENCY')) cfg.jev.concurrency = E('SCREEN_CONCURRENCY');
  if (E('SCREEN_LLM_CONCURRENCY')) cfg.llm.concurrency = E('SCREEN_LLM_CONCURRENCY');
  if (E('SCREEN_JEV_TIMEOUT_MS')) cfg.jev.timeoutMs = E('SCREEN_JEV_TIMEOUT_MS');
  if (E('SCREEN_LLM_TIMEOUT_MS')) cfg.llm.timeoutMs = E('SCREEN_LLM_TIMEOUT_MS');
  if (E('SCREEN_MAX_ATTEMPTS')) { cfg.llm.maxAttempts = E('SCREEN_MAX_ATTEMPTS'); cfg.jev.maxAttempts = E('SCREEN_MAX_ATTEMPTS'); }
  if (E('SCREEN_BACKOFF_BASE_MS')) cfg.retry.baseMs = E('SCREEN_BACKOFF_BASE_MS');
  if (E('SCREEN_RETRY_AFTER_CAP_MS')) cfg.retry.maxRetryAfterMs = E('SCREEN_RETRY_AFTER_CAP_MS');
  if (E('SCREEN_SHADOW')) cfg.shadow.enabled = E('SCREEN_SHADOW');
  if (E('SCREEN_SHADOW_RATE')) cfg.shadow.rate = E('SCREEN_SHADOW_RATE');
  if (E('SCREEN_SHADOW_TEXT')) cfg.shadow.storeText = E('SCREEN_SHADOW_TEXT');
  if (E('SCREEN_REDACT')) cfg.redact.enabled = E('SCREEN_REDACT');
  if (E('SCREEN_STALE_RULE')) cfg.rubric.staleProfileClause = E('SCREEN_STALE_RULE');
  if (E('SCREEN_INSUFFICIENT')) cfg.rubric.insufficientEvidence = String(E('SCREEN_INSUFFICIENT')).trim().toLowerCase();
  if (E('SCREEN_CACHE_TTL_SEC')) cfg.cache.ttlSec = E('SCREEN_CACHE_TTL_SEC');
  if (E('SCREEN_PAGE_RETRY_PAUSE_SEC')) cfg.pageRetryPauseSec = E('SCREEN_PAGE_RETRY_PAUSE_SEC');
  if (E('SCREEN_ZDR')) { cfg.jev.zeroDataRetention = E('SCREEN_ZDR'); cfg.llm.zeroDataRetention = E('SCREEN_ZDR'); }
  if (E('SCREEN_LLM_ZDR')) cfg.llm.zeroDataRetention = E('SCREEN_LLM_ZDR');
  if (E('SCREEN_JEV_ZDR')) cfg.jev.zeroDataRetention = E('SCREEN_JEV_ZDR');
  if (E('SCREEN_CALIBRATED')) cfg.decide.calibration.calibrated = E('SCREEN_CALIBRATED');

  // validation and coercion: a bad value never crashes screening, it falls back to a safe default
  cfg.engine = String(cfg.engine === undefined || cfg.engine === null ? '' : cfg.engine).trim().toLowerCase();
  cfg.tierMode = String(cfg.tierMode === undefined || cfg.tierMode === null ? '' : cfg.tierMode).trim().toLowerCase();
  if (!ENGINES.includes(cfg.engine)) {
    warnings.push(`unknown engine '${String(cfg.engine).slice(0, 30)}'; using ${DEFAULTS.engine}`);
    cfg.engine = DEFAULTS.engine;
  }
  if (!TIER_MODES.includes(cfg.tierMode)) {
    warnings.push(`unknown tierMode '${String(cfg.tierMode).slice(0, 30)}'; using ${DEFAULTS.tierMode}`);
    cfg.tierMode = DEFAULTS.tierMode;
  }
  cfg.gateway.origin = String(cfg.gateway.origin || DEFAULTS.gateway.origin).trim().replace(/\/+$/, '');
  if (!originOk(cfg.gateway.origin)) {
    warnings.push('gateway.origin must be https (plain http only for this machine); using the default gateway');
    cfg.gateway.origin = DEFAULTS.gateway.origin;
  }
  cfg.rubric.staleProfileClause = bool(cfg.rubric.staleProfileClause, false);
  if (!['legacy', 'lenient'].includes(cfg.rubric.insufficientEvidence)) {
    warnings.push('rubric.insufficientEvidence must be legacy or lenient; using legacy');
    cfg.rubric.insufficientEvidence = 'legacy';
  }
  cfg.redact.enabled = bool(cfg.redact.enabled, true);
  cfg.redact.maxSnippetChars = num(cfg.redact.maxSnippetChars, 4000, 200, 20000);
  if (!cfg.redact.enabled && bool(cfg.shadow.storeText, true)) {
    warnings.push('redaction is off, so the shadow log will not store snippet text (shadow.storeText forced off)');
    cfg.shadow.storeText = false;
  }

  const L = cfg.llm;
  L.timeoutMs = num(L.timeoutMs, 60000, 100, 600000);
  L.maxAttempts = Math.round(num(L.maxAttempts, 3, 1, 6));
  L.maxInvalidAttempts = Math.round(num(L.maxInvalidAttempts, 2, 1, 4));
  L.maxTokens = Math.round(num(L.maxTokens, 1500, 50, 8000));
  L.concurrency = Math.round(num(L.concurrency, 4, 1, 16));
  L.zeroDataRetention = bool(L.zeroDataRetention, false);
  if (typeof L.model !== 'string' || !L.model.trim()) {
    warnings.push('llm.model is empty; using the default model');
    L.model = DEFAULTS.llm.model;
  }
  L.model = L.model.trim();
  if (typeof L.backupModel !== 'string' || !L.backupModel.trim() || L.backupModel.trim() === L.model) L.backupModel = null;
  else L.backupModel = L.backupModel.trim();
  if (L.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(L.reasoningEffort))) L.reasoningEffort = null;

  const J = cfg.jev;
  J.timeoutMs = num(J.timeoutMs, 15000, 100, 120000);
  J.maxAttempts = Math.round(num(J.maxAttempts, 3, 1, 6));
  J.concurrency = Math.round(num(J.concurrency, 6, 1, 16));
  J.maxInvalidAttempts = Math.round(num(J.maxInvalidAttempts, 2, 1, 4));
  J.maxSnippetChars = Math.round(num(J.maxSnippetChars, 1500, 200, 8000));
  J.zeroDataRetention = bool(J.zeroDataRetention, false);
  if (typeof J.model !== 'string' || !J.model.trim()) {
    warnings.push('jev.model is empty; using the default model');
    J.model = DEFAULTS.jev.model;
  }
  J.model = J.model.trim();

  const R = cfg.retry;
  R.baseMs = num(R.baseMs, 1000, 0, 60000);
  R.capMs = num(R.capMs, 20000, 0, 300000);
  R.maxRetryAfterMs = num(R.maxRetryAfterMs, 30000, 0, 300000);

  const B = cfg.batch;
  B.breakerConsecutive = Math.round(num(B.breakerConsecutive, 3, 1, 50));
  B.invalidMassMin = Math.round(num(B.invalidMassMin, 5, 1, 1000));
  B.invalidMassShare = num(B.invalidMassShare, 0.5, 0, 1);
  B.invalidStreakMax = Math.round(num(B.invalidStreakMax, 3, 1, 50));
  B.invalidStreakTtlSec = Math.round(num(B.invalidStreakTtlSec, 1800, 60, 86400));
  B.deadlineMs = num(B.deadlineMs, 600000, 1000, 3600000);
  if (!['reject', 'approve'].includes(B.onInvalid)) {
    warnings.push('batch.onInvalid must be reject or approve; using reject');
    B.onInvalid = 'reject';
  }

  cfg.cache.ttlSec = num(cfg.cache.ttlSec, 3600, 0, 86400 * 7);
  cfg.cache.maxEntries = Math.round(num(cfg.cache.maxEntries, 5000, 10, 100000));

  const S = cfg.shadow;
  S.enabled = bool(S.enabled, true);
  S.storeText = bool(S.storeText, true);
  S.rate = num(S.rate, 1, 0, 1);
  S.graceMs = num(S.graceMs, 5000, 0, 60000);
  S.jevMaxAttempts = Math.round(num(S.jevMaxAttempts, 2, 1, 6));
  S.auditRate = num(S.auditRate, 0.05, 0, 1);
  S.auditTimeoutMs = num(S.auditTimeoutMs, 30000, 1000, 300000);
  S.retentionDays = Math.round(num(S.retentionDays, 180, 1, 3650));

  cfg.decide.calibration.calibrated = bool(cfg.decide.calibration.calibrated, false);
  for (const stage of ['stage1', 'stage2']) {
    const D = cfg.decide[stage];
    for (const [k, def] of Object.entries(DEFAULTS.decide[stage])) {
      if (k.startsWith('_')) continue;
      if (typeof def === 'boolean') { D[k] = bool(D[k], def); continue; }
      const n = Number(D[k]);
      if (D[k] === null || D[k] === '' || typeof D[k] === 'boolean' || !Number.isFinite(n) || n < 0 || n > 1) {
        warnings.push(`decide.${stage}.${k} must be a number from 0 to 1; using ${def}`);
        D[k] = def;
      } else D[k] = n;
    }
  }
  const G = cfg.gate;
  for (const k of ['maxJevApproveLlmReject', 'maxJevRejectLlmApprove', 'maxJevRejectOfLlmApproved', 'minLaneAgreementLo', 'minLaneCoverage', 'minAgreement']) G[k] = num(G[k], DEFAULTS.gate[k], 0, 1);
  G.requiredSources = Array.isArray(G.requiredSources) ? G.requiredSources.filter(x => x === 'caterer' || x === 'reed') : [];
  if (!G.requiredSources.length) {
    warnings.push('gate.requiredSources must list caterer and/or reed; requiring both');
    G.requiredSources = DEFAULTS.gate.requiredSources.slice();
  }
  cfg.pageRetryPauseSec = num(cfg.pageRetryPauseSec, 120, 0, 3600);

  for (const [rule, mode] of Object.entries(cfg.stage1.rules)) {
    if (!['off', 'shadow', 'enforce'].includes(mode)) {
      warnings.push(`stage1 rule ${rule} has unknown mode '${String(mode).slice(0, 20)}'; using shadow`);
      cfg.stage1.rules[rule] = 'shadow';
    }
  }

  // Safety: the Jev-first engine only decides once the thresholds are marked calibrated.
  cfg.engineRequested = cfg.engine;
  cfg.engineEffective = cfg.engine;
  if (cfg.engine === 'jev' && !cfg.decide.calibration.calibrated) {
    cfg.engineEffective = 'jev_shadow';
    warnings.push('engine=jev requested but decide.calibration.calibrated is false; running jev_shadow (the LLM decides). Calibrate, then set decide.calibration.calibrated to true (see docs/SCREENING.md).');
  }

  cfg.warnings = warnings;
  cfg.configFile = file;
  cfg.configLoaded = !!fromFile;
  return cfg;
}

module.exports = { DEFAULTS, ENGINES, TIER_MODES, load, merge, stripUnderscore, num, bool };
