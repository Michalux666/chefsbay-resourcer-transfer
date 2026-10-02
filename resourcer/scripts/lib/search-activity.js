'use strict';
/*
 * The "active within" window of a search, for both sources (docs/ACTIVITY.md).
 *
 *   labels        the eight windows tools/request-search.js accepts (VALID_ACTIVE_WITHIN there, LABELS here)
 *   Caterer       config/caterer-activity.json maps a label to the LastActivityId of the results URL and to the text the results
 *                 page echoes when it applies it. The setting CATERER_ACTIVITY_FILTER decides which searches send it:
 *                 manual (default: one-off requests only), all (every territory too), off (never: the behaviour before this change).
 *   Reed          the label is mapped to a key that reed-search.js turns into an activityTimeFrame value.
 *   self-check    a tiny page evaluation reads the filters Caterer says it applied (the legacy search probe read the same page:
 *                 the "Candidates <N>" header and the "Active within last: <text>" part of the summary line). Only a header count and one
 *                 short sanitised text leave the page: never a name, a card or any other page text.
 *
 * Nothing here runs at require time. Every function that reads the environment or a file takes it as an argument, so the tests inject both.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const env = require('./env');

// The windows a request can name, in the order the owner thinks of them (the same list as VALID_ACTIVE_WITHIN in tools/request-search.js).
const LABELS = Object.freeze(['14 days', '1 month', '2 months', '3 months', '6 months', '12 months', '18 months', 'All']);
// The pending-file sources that are a person asking for a search (the same list as MANUAL_SOURCES in tools/request-search.js; a test compares them).
const MANUAL_SOURCES = Object.freeze(['dashboard', 'request-search-cli']);
const SETTINGS = Object.freeze(['manual', 'all', 'off']);
const DEFAULT_SETTING = 'manual';
const SETTING_NAME = 'CATERER_ACTIVITY_FILTER';
const ALERT_KEY = 'caterer-activity-mismatch';
const DEFAULT_LABEL = '1 month';
const DEFAULT_CV_LIMIT = 20;
const CONFIG_NAME = 'caterer-activity.json';
const MATCH = Object.freeze({ YES: 'yes', NO: 'no', UNREADABLE: 'unreadable', NA: 'n/a', NOT_CHECKED: 'not-checked' });

const configFile = () => path.join(paths.CONFIG, CONFIG_NAME);

/** 'Active within' text of a request or a territory -> one of LABELS, or null when it is none of them. */
function normaliseLabel(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  return LABELS.find((l) => l.toLowerCase() === t) || null;
}

/** The window text of a request as it may be logged and stored: plain characters only, at most 20 (a label is 9 at most; a hand-written file may hold anything). */
function plainLabel(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/[^A-Za-z0-9 ]/g, '?').slice(0, 20);
}

/** A pending file is a manual request when its source is one of MANUAL_SOURCES (a scheduled territory or the catch-up is not). */
function isManualSource(source) {
  return MANUAL_SOURCES.includes(String(source === undefined || source === null ? '' : source));
}

// ----------------------------------------------------------------------------------------------- the setting

/** @returns {{value:'manual'|'all'|'off', warn:string|null}} an unknown value falls back to the default and says so. */
function readSetting(getEnv) {
  const get = getEnv || ((name, dflt) => env.get(name, dflt));
  const raw = get('CATERER_ACTIVITY_FILTER', DEFAULT_SETTING);
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (SETTINGS.includes(v)) return { value: v, warn: null };
  if (v === '') return { value: DEFAULT_SETTING, warn: null };
  return { value: DEFAULT_SETTING, warn: `${SETTING_NAME} is not manual, all or off: using ${DEFAULT_SETTING}` };
}

// ----------------------------------------------------------------------------------------------- the Caterer table

const ECHO_RE = /^[A-Za-z0-9 ,.\/&()-]{0,40}$/;

/**
 * Validates the owner-editable file. Never throws, never returns file text: an invalid file gives a fixed reason.
 * @returns {{ok:true, labels:Object}|{ok:false, error:string}}
 */
function validateCatererConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'the file is not a JSON object' };
  const labels = obj.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return { ok: false, error: 'no "labels" object' };
  const out = {};
  const seen = new Map();
  for (const key of Object.keys(labels)) {
    const label = LABELS.includes(key) ? key : null;
    if (!label) return { ok: false, error: `"${String(key).slice(0, 20).replace(/[^A-Za-z0-9 ]/g, '?')}" is not one of the eight labels` };
    const e = labels[key];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: `"${label}" is not an object` };
    let id = null;
    if (e.id !== null && e.id !== undefined) {
      if (!Number.isInteger(e.id) || e.id < 0 || e.id > 999) return { ok: false, error: `"${label}": id must be a whole number from 0 to 999, or null` };
      id = e.id;
      if (seen.has(id)) return { ok: false, error: `"${label}" and "${seen.get(id)}" share the id ${id}` };
      seen.set(id, label);
    }
    let echo = [];
    if (e.echo !== undefined) {
      if (!Array.isArray(e.echo) || e.echo.length > 6 || !e.echo.every((x) => typeof x === 'string' && ECHO_RE.test(x))) {
        return { ok: false, error: `"${label}": echo must be a short list of short plain texts` };
      }
      echo = e.echo.map((x) => x.trim());
    }
    if (id !== null && echo.length === 0) return { ok: false, error: `"${label}" has an id but no echo text (the self-check needs it)` };
    out[label] = { id, echo };
  }
  return { ok: true, labels: out };
}

/** Reads and validates config/caterer-activity.json. Missing, unreadable or invalid -> {ok:false, error}: the caller sends no filter. */
function loadCatererConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file || configFile(), 'utf8');
  } catch (e) {
    return { ok: false, error: e && e.code === 'ENOENT' ? 'the file is missing' : 'the file cannot be read' };
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let obj;
  try { obj = JSON.parse(raw); } catch { return { ok: false, error: 'the file is not valid JSON' }; }
  return validateCatererConfig(obj);
}

/**
 * What a search sends to Caterer for its window.
 * @param {{activeWithin:string, manual:boolean, setting?:string, config?:object, getEnv?:Function, file?:string}} o
 * @returns {{requested:string, label:string|null, setting:string, id:number|null, echo:string[], note:string, warn:boolean}}
 *   id is the LastActivityId to put in the URL, or null for no parameter. note is a fixed sentence, empty in the plain cases; warn means
 *   "the request asked for a window that was not sent for a reason that is not the setting".
 */
function catererFilterFor(o) {
  const requested = o.activeWithin === undefined || o.activeWithin === null ? '' : String(o.activeWithin);
  const sett = o.setting && SETTINGS.includes(o.setting) ? { value: o.setting, warn: null } : readSetting(o.getEnv);
  const base = { requested: plainLabel(requested), label: normaliseLabel(requested), setting: sett.value, id: null, echo: [], note: '', warn: false };
  if (sett.warn) { base.note = sett.warn; base.warn = true; }
  const manual = !!o.manual;
  if (sett.value === 'off') {
    if (manual) base.note = `${SETTING_NAME}=off: the requested window is not sent to Caterer`;
    return base;
  }
  if (sett.value === 'manual' && !manual) return base; // a scheduled territory: exactly as before this change
  if (!base.label) {
    base.note = `the window "${base.requested}" is not one of the eight labels: no filter sent to Caterer`;
    base.warn = true;
    return base;
  }
  const cfg = o.config || loadCatererConfig(o.file);
  if (!cfg.ok) {
    base.note = `${CONFIG_NAME} is not usable (${cfg.error}): no filter sent to Caterer`;
    base.warn = true;
    return base;
  }
  const entry = cfg.labels[base.label];
  if (!entry || entry.id === null) {
    base.note = `no Caterer LastActivityId is known for "${base.label}" (${CONFIG_NAME}): no filter sent to Caterer, the search runs with Caterer's own default window`;
    base.warn = true;
    return base;
  }
  base.id = entry.id;
  base.echo = entry.echo.slice();
  return base;
}

/** The id a results URL carries (null when it carries none). */
function sentIdFromUrl(url) {
  const m = /[?&]LastActivityId=(\d{1,4})(?=&|#|$)/i.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

/** The label (and its echo texts) the config maps to an id, for the self-check of an id that is already in a URL. */
function entryForId(config, id) {
  if (!config || !config.ok || id === null || id === undefined) return null;
  for (const label of Object.keys(config.labels)) if (config.labels[label].id === id) return { label, echo: config.labels[label].echo };
  return null;
}

// ----------------------------------------------------------------------------------------------- the self-check page evaluation

// Reads the page the browser is on. Returns a JSON string with: the "Candidates <N>" header count, whether the summary line is there, and
// the text after "Active within last:" up to the next full stop, and whether the page is the sign-in form. Nothing else of the page leaves it. The leading boundary and the String.raw
// keep the backslashes (the legacy copy of the empty-result probe lost them once: docs/KNOWN-LIMITS.md).
const SUMMARY_JS = String.raw`(function(){/*ACTIVITY-READ*/var t=document.body?document.body.innerText:'';var h=t.match(/Candidates\s+([0-9,]+)/i);var s=t.match(/Search anything in CV or Profile:[^\n]*/i);var a=s?s[0].match(/Active within last:\s*([^.\n]+)/i):null;return JSON.stringify({total:h?parseInt(h[1].replace(/,/g,''),10):null,summary:!!s,active:a?a[1]:null,login:typeof document.querySelector==='function'&&!!document.querySelector('[name=password]')});})()`;
const SUMMARY_B64 = Buffer.from(SUMMARY_JS, 'utf8').toString('base64');

/** Cleans the text Caterer echoed: short, plain, single-spaced. null when it is not plain text (then it is never logged). */
function sanitiseEcho(text) {
  if (text === null || text === undefined) return '';
  const t = String(text).replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '').trim();
  return ECHO_RE.test(t) ? t : null;
}

/**
 * The output of the evaluation as agent-browser prints it (a JSON string, quoted, possibly after noise) -> a reading.
 * @returns {{readable:boolean, total:number|null, summary:boolean, applied:string, loggedOut:boolean}} readable is false when the page gave nothing usable.
 */
function parseSummaryOutput(out) {
  const none = { readable: false, total: null, summary: false, applied: '', loggedOut: false };
  const lines = String(out === undefined || out === null ? '' : out).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let v = lines[i];
    try {
      if (v[0] === '"') v = JSON.parse(v);
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (!o || typeof o !== 'object' || !('summary' in o)) continue;
      const total = Number.isInteger(o.total) && o.total >= 0 && o.total < 1e9 ? o.total : null;
      const applied = sanitiseEcho(o.active);
      const loggedOut = o.login === true;
      // a header or a summary line proves the page is a results page; text that is not plain is dropped as unreadable
      if (applied === null) return Object.assign({}, none, { total, summary: !!o.summary, loggedOut });
      return { readable: !loggedOut && (total !== null || !!o.summary), total, summary: !!o.summary, applied, loggedOut };
    } catch { /* not the line: try the one before */ }
  }
  return none;
}

const fold = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Compares what Caterer echoed with what the config expects for the id that was sent.
 * @param {{sentId:number|null, expected:{label:string, echo:string[]}|null, reading:{readable:boolean, total:number|null, applied:string}}} o
 * @returns {{matched:'yes'|'no'|'unreadable'|'n/a', applied:string, poolHeaderCount:number|null}}
 */
function evaluateApplied(o) {
  const r = o.reading || { readable: false, total: null, applied: '' };
  const out = { matched: MATCH.NA, applied: r.applied || '', poolHeaderCount: r.total === undefined ? null : r.total };
  if (o.sentId === null || o.sentId === undefined) {
    if (!r.readable) out.matched = MATCH.NA; // nothing was sent and the page was not readable: nothing to compare
    return out;
  }
  if (!o.expected) return out; // an id of the URL that the config does not know any more: nothing to compare with
  // a results page whose summary line is missing says nothing about the window (a layout that changed, or a page with no results): never a verdict
  if (!r.readable || r.summary === false) { out.matched = MATCH.UNREADABLE; return out; }
  out.matched = o.expected.echo.some((e) => fold(e) === fold(r.applied)) ? MATCH.YES : MATCH.NO;
  return out;
}

/** The one run-log line (the format is part of the contract: docs/ACTIVITY.md). The applied text is sanitised plain text. */
function activityLine(requested, sentId, applied, matched) {
  const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/[^A-Za-z0-9 ,.\/&()-]/g, '?').slice(0, 40);
  return `ACTIVITY_FILTER requested="${clean(requested)}" sent="LastActivityId=${sentId === null || sentId === undefined ? 'none' : sentId}" applied="${clean(applied)}" match=${matched}`;
}

// ----------------------------------------------------------------------------------------------- the Reed window

// label -> the key reed-search.js maps to an activityTimeFrame (its ACTIVITY_TIMEFRAME_MAP), and whether Reed's window is exactly the label's.
// 18 months has no Reed value: the closest one that is NOT narrower is used (two years) and the run record says so.
const REED_WINDOWS = Object.freeze({
  '14 days': { arg: '2 weeks', exact: true },
  '1 month': { arg: 'month', exact: true },
  '2 months': { arg: '2months', exact: true },
  '3 months': { arg: '3months', exact: true },
  '6 months': { arg: '6months', exact: true },
  '12 months': { arg: 'year', exact: true },
  '18 months': { arg: '2 years', exact: false, note: 'Reed has no 18 months window: the next wider one (2 years) was used' },
  All: { arg: 'all', exact: true },
});

/**
 * The --active-within value run-pipeline hands to reed-phase1.js.
 * The stored default (1 month) gives exactly the value used before this change ("month"). A text that is none of the eight labels gives the
 * same value and a WARN: nothing the request did not ask for is ever sent.
 * @returns {{requested:string, arg:string, exact:boolean, note:string, warn:boolean}}
 */
function reedWindowFor(activeWithin) {
  const asked = activeWithin === undefined || activeWithin === null || activeWithin === '' ? DEFAULT_LABEL : String(activeWithin);
  const label = normaliseLabel(asked);
  if (!label) {
    const requested = plainLabel(asked);
    return { requested, arg: REED_WINDOWS[DEFAULT_LABEL].arg, exact: false, warn: true,
      note: `the window "${requested}" is not one of the eight labels: Reed searched the last month, as before` };
  }
  const w = REED_WINDOWS[label];
  return { requested: label, arg: w.arg, exact: w.exact, note: w.note || '', warn: !w.exact };
}

/** The CV limit reed-phase1.js gets: the request's own, or the stored default when it is missing or not a positive whole number. */
function reedCvLimitFor(cvLimit) {
  const n = Number(cvLimit);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CV_LIMIT;
}

// ----------------------------------------------------------------------------------------------- the alert, once a day

/**
 * One WARN alert caterer-activity-mismatch per London day and per cause (a window that does not match and a summary that cannot be read are
 * two causes: one must not hide the other). The cause is marked BEFORE the alert is sent and taken back if sending throws. A state file of the
 * earlier form ({day} with no list) counts as "everything sent today".
 * @param {{text:string, meta?:object, now?:Date, notify?:Function, file?:string, cause?:string}} o
 * @returns {boolean} true when the alert was sent now.
 */
function alertOncePerDay(o) {
  const fsx = require('./fsx');
  const { londonParts } = require('./time');
  const file = o.file || path.join(paths.RUNTIME, 'activity-alert.json');
  const day = londonParts(o.now || new Date()).ymd;
  const cause = o.cause ? String(o.cause).slice(0, 20) : 'any';
  const state = fsx.readJson(file, null);
  let sent = [];
  if (state && state.day === day) {
    if (!Array.isArray(state.sent)) return false;
    sent = state.sent.filter((x) => typeof x === 'string').slice(0, 10);
    if (sent.includes(cause)) return false;
  }
  try { fsx.writeJsonAtomic(file, { day, sent: sent.concat(cause) }, 0o600); } catch { return false; }
  const send = o.notify || require('./notify').notify;
  try {
    send({ severity: 'warn', key: ALERT_KEY, text: o.text, meta: o.meta });
  } catch {
    try { if (sent.length) fsx.writeJsonAtomic(file, { day, sent }, 0o600); else fsx.safeUnlink(file); } catch { /* nothing more to do */ }
    return false;
  }
  return true;
}

module.exports = {
  LABELS, MANUAL_SOURCES, SETTINGS, DEFAULT_SETTING, SETTING_NAME, ALERT_KEY, CONFIG_NAME, DEFAULT_LABEL, DEFAULT_CV_LIMIT, MATCH, REED_WINDOWS,
  SUMMARY_JS, SUMMARY_B64, configFile, normaliseLabel, plainLabel, isManualSource, readSetting, validateCatererConfig, loadCatererConfig, catererFilterFor,
  sentIdFromUrl, entryForId, sanitiseEcho, parseSummaryOutput, evaluateApplied, activityLine, reedWindowFor, reedCvLimitFor, alertOncePerDay,
};
