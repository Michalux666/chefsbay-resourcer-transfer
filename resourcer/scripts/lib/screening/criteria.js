'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const env = require('../env');

const FILE_NAME = 'screening-criteria.json';
const PACKAGED = path.join(__dirname, '..', '..', '..', 'config', FILE_NAME);
const ACTIONS = ['approve', 'reject', 'doubt'];
const TYPES = ['noul', 'choice', 'score'];
const REJECT_CODES = ['reject_too_junior', 'reject_overqualified_entry', 'reject_foh_only', 'reject_management_only', 'reject_unrelated_industry', 'reject_wrong_specialism', 'reject_no_history', 'reject_stale_profile', 'reject_other'];
const APPROVE_CODES = ['approve_level_match', 'approve_relevant_history', 'approve_senior_ok', 'approve_other'];

function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return typeof v === 'string' && v.trim().length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function checkQuestion(key, q, errors) {
  const at = `question ${key}`;
  if (!isPlain(q) || !TYPES.includes(q.type)) return errors.push(`${at}: type must be noul, choice or score`);
  if (!text(q.instructions)) errors.push(`${at}: instructions are missing`);
  if (q.type === 'choice') {
    if (!isPlain(q.criteria) || Object.keys(q.criteria).length < 2) errors.push(`${at}: a choice needs at least two options`);
    else for (const [o, d] of Object.entries(q.criteria)) if (!text(d)) errors.push(`${at}: option ${o} has no description`);
  } else if (q.type === 'score') {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) errors.push(`${at}: a score needs 2 to 10 levels`);
    else if (!q.criteria.every(text)) errors.push(`${at}: every score level needs a description`);
  } else if (q.criteria !== undefined && !(isPlain(q.criteria) && Object.keys(q.criteria).every(k => k === 'true' || k === 'false'))) {
    errors.push(`${at}: a yes/no criteria block may only hold true and false`);
  }
  return undefined;
}

function sameOptions(a, b) {
  return Object.keys(a.criteria).join('|') === Object.keys(b.criteria).join('|');
}

function checkTables(d, obj, errors) {
  const cand = obj.questions.candidate;
  const roleQ = obj.roleLevel.role_level;
  const levelQ = cand[d.levelQuestion];
  if (!levelQ || levelQ.type !== 'choice') errors.push('decision.levelQuestion must name a choice question');
  if (!Array.isArray(d.kindQuestions) || !d.kindQuestions.length) return errors.push('decision.kindQuestions must list at least one choice question');
  const kindQ = cand[d.kindQuestions[0]];
  if (!kindQ || kindQ.type !== 'choice') return errors.push(`decision.kindQuestions: ${d.kindQuestions[0]} must be a choice question`);
  for (const q of d.kindQuestions) {
    if (!cand[q] || cand[q].type !== 'choice' || !sameOptions(cand[q], kindQ)) errors.push(`decision.kindQuestions: ${q} must be a choice with the same options as ${d.kindQuestions[0]}`);
  }
  if (!isPlain(d.rules)) errors.push('decision.rules is missing');
  if (!isPlain(d.fieldRules)) errors.push('decision.fieldRules is missing');
  if (!isPlain(d.rules) || !isPlain(d.fieldRules) || !levelQ || levelQ.type !== 'choice') return undefined;
  for (const level of Object.keys(roleQ.criteria)) {
    const row = d.rules[level];
    if (!isPlain(row)) errors.push(`decision.rules has no row for role level ${level}`);
    else for (const opt of Object.keys(levelQ.criteria)) if (!ACTIONS.includes(row[opt])) errors.push(`decision.rules.${level}.${opt} must be approve, reject or doubt`);
    const frow = d.fieldRules[level];
    if (!isPlain(frow)) errors.push(`decision.fieldRules has no row for role level ${level}`);
    else for (const kind of Object.keys(kindQ.criteria)) if (!(frow[kind] === 'ok' || frow[kind] === 'doubt' || REJECT_CODES.includes(frow[kind]))) errors.push(`decision.fieldRules.${level}.${kind} must be ok, doubt or a reject reason code`);
  }
  return undefined;
}

const THRESHOLDS = ['roleLevelMinP', 'fieldOkMin', 'levelApproveMin', 'reasonMin'];

function checkOperatingPoint(op, errors) {
  if (!isPlain(op)) return errors.push('decision.operatingPoint is missing');
  for (const stage of ['stage1', 'stage2']) {
    const s = op[stage];
    if (!isPlain(s) || !isNum(s.costWastedCredit) || s.costWastedCredit < 0 || !isNum(s.costLostCandidate) || s.costLostCandidate <= 0) errors.push(`decision.operatingPoint.${stage} needs costWastedCredit (0 or more) and costLostCandidate (above 0)`);
    else if (!isNum(s.rejectAt) || s.rejectAt <= 0 || s.rejectAt > 1) errors.push(`decision.operatingPoint.${stage}.rejectAt must be a number above 0 and up to 1`);
  }
  const f = op.forced;
  if (!isPlain(f) || !isNum(f.from) || !isNum(f.to) || f.from >= f.to) errors.push('decision.operatingPoint.forced needs from and to, with from below to');
  return undefined;
}

function checkDecision(d, obj) {
  const errors = [];
  const cand = obj.questions.candidate;
  checkTables(d, obj, errors);
  for (const [k, v] of Object.entries(d.reasons || {})) if (!REJECT_CODES.includes(v)) errors.push(`decision.reasons.${k} is not a reject reason code`);
  for (const [k, v] of Object.entries(d.approveReasons || {})) if (!APPROVE_CODES.includes(v)) errors.push(`decision.approveReasons.${k} is not an approve reason code`);
  for (const [code, c] of Object.entries(d.corroborate || {})) {
    if (!REJECT_CODES.includes(code) || !isPlain(c) || !(cand[c.question] && cand[c.question].type === 'noul')) errors.push(`decision.corroborate.${code} needs a yes/no question`);
  }
  if (!(cand[d.hospitalityQuestion] && cand[d.hospitalityQuestion].type === 'noul')) errors.push('decision.hospitalityQuestion must name a yes/no question');
  if (!isPlain(d.thresholds)) errors.push('decision.thresholds is missing');
  else for (const k of THRESHOLDS) if (!isNum(d.thresholds[k])) errors.push(`decision.thresholds.${k} must be a number`);
  if (isPlain(d.thresholds) && d.thresholds.unreadableMinChars !== undefined && !(isNum(d.thresholds.unreadableMinChars) && d.thresholds.unreadableMinChars > 0)) errors.push('decision.thresholds.unreadableMinChars must be a number above 0');
  const s = d.stale;
  if (!isPlain(s) || !['reject', 'doubt', 'off'].includes(s.mode) || !['ignore', 'doubt'].includes(s.recentlyActive) || !isNum(s.updatedDays) || !isNum(s.roleGapDays) || !isNum(s.activeDays) || !isNum(s.doubtWeight)) errors.push('decision.stale needs mode (reject, doubt or off), recentlyActive (ignore or doubt), updatedDays, roleGapDays, activeDays and doubtWeight');
  else if (s.applicationsAreActivity !== undefined && typeof s.applicationsAreActivity !== 'boolean') errors.push('decision.stale.applicationsAreActivity must be true or false');
  const p = d.policy;
  if (!isPlain(p) || !Array.isArray(p.readings) || !p.readings.length) errors.push('decision.policy.readings must list at least one yes/no question');
  else {
    for (const r of p.readings) {
      if (!isPlain(r) || !(cand[r.question] && cand[r.question].type === 'noul') || !['fit', 'mismatch'].includes(r.sense) || (r.weight !== undefined && !(isNum(r.weight) && r.weight > 0))) errors.push('decision.policy.readings: each needs a yes/no question, a sense (fit or mismatch) and, optionally, a weight above 0');
    }
  }
  checkOperatingPoint(d.operatingPoint, errors);
  return errors;
}

// errors stop the questions being asked; decisionErrors stop the decision being made
function validate(obj) {
  const errors = [];
  if (!isPlain(obj)) return { errors: ['the criteria file must hold a JSON object'], decisionErrors: [] };
  if (!text(obj.version)) errors.push('version is missing');
  if (!text(obj.context)) errors.push('context is missing');
  const roleQ = obj.roleLevel && obj.roleLevel.role_level;
  if (!roleQ || roleQ.type !== 'choice') errors.push('roleLevel.role_level must be a choice question');
  else checkQuestion('role_level', roleQ, errors);
  const cand = obj.questions && obj.questions.candidate;
  if (!isPlain(cand) || !Object.keys(cand).length) errors.push('questions.candidate is missing');
  else for (const [k, q] of Object.entries(cand)) if (!k.startsWith('_')) checkQuestion(k, q, errors);
  const st2 = obj.questions && obj.questions.stage2;
  if (st2 !== undefined) {
    if (!isPlain(st2)) errors.push('questions.stage2 must be an object');
    else for (const [k, q] of Object.entries(st2)) if (!k.startsWith('_')) checkQuestion(k, q, errors);
  }
  if (errors.length) return { errors, decisionErrors: [] };
  return { errors, decisionErrors: isPlain(obj.decision) ? checkDecision(obj.decision, obj) : ['decision is missing'] };
}

// the whole file, so that a change of a rule or a number also invalidates cached decisions
function contentHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

function candidates(opts) {
  const o = opts || {};
  const list = [];
  if (o.file) list.push(o.file);
  const fromEnv = (o.getEnv || (n => env.get(n)))('SCREEN_CRITERIA_FILE');
  if (fromEnv) list.push(fromEnv);
  list.push(path.join(paths.CONFIG, FILE_NAME), PACKAGED);
  return list;
}

function load(opts) {
  for (const file of candidates(opts)) {
    let raw;
    let mtimeMs = 0;
    try {
      raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) { continue; }
    let obj;
    try { obj = JSON.parse(raw); } catch (e) {
      return { ok: false, criteria: null, file, hash: null, errors: [`${path.basename(file)} is not valid JSON`], decisionErrors: [], mtimeMs };
    }
    const v = validate(obj);
    if (v.errors.length) return { ok: false, criteria: null, file, hash: null, errors: v.errors, decisionErrors: v.decisionErrors, mtimeMs };
    return { ok: true, criteria: obj, file, hash: contentHash(obj), errors: [], decisionErrors: v.decisionErrors, mtimeMs };
  }
  return { ok: false, criteria: null, file: null, hash: null, errors: [`${FILE_NAME} was not found`], decisionErrors: [], mtimeMs: 0 };
}

const memo = new Map();

// re-read only when the file changed, so an owner edit is picked up without a restart
function get(opts) {
  const key = candidates(opts).join('|');
  const hit = memo.get(key);
  if (hit && hit.file) {
    try { if (fs.statSync(hit.file).mtimeMs === hit.mtimeMs) return hit; } catch (e) { /* the file went away: load again */ }
  }
  const res = load(opts);
  memo.set(key, res);
  return res;
}

module.exports = { FILE_NAME, PACKAGED, ACTIONS, REJECT_CODES, APPROVE_CODES, validate, load, get, contentHash };
