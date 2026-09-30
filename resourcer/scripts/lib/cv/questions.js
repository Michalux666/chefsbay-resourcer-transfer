'use strict';
// The Jev question builder. Every question is about the SEARCHED ROLE, so the same wording works for any role: the
// searched title is part of the state (`search.role`) and the questions point at it and at the listed roles by path.
// The wording itself lives in config (questions.*), the option names below are the contract with gate.js.
//   per role i:   relevance_i  (score, descriptive levels)   how close is that job to the searched role
//                 seniority_i  (choice)                      its level relative to the searched role
//   whole history: overall_match (score), progression (choice), career_change (noul), injection (noul)
//   the search:   search_level (choice, asked once per distinct title in its own request, see levels.js)
// Rules of the Jev docs applied: state = content, questions = judgments; a Choice always has an escape option; every
// score level is a self-contained situation; a noul is phrased so that yes means the thing is present.

const crypto = require('crypto');
const { roleLine } = require('./facts');

const MAX_REQUEST_TOKENS = 60000;
const MAX_STATE_QUESTION_TOKENS = 30000;

function fill(text, vars) {
  let s = String(text);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

function roleVars(cfg, i) {
  return {
    ladder: cfg.questions.ladder,
    role: `\`candidate.roles[${i}]\``,
    search: '`search.role`',
    roles: '`candidate.roles`',
  };
}

function mapFill(map, vars) {
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = fill(v, vars);
  return out;
}

/**
 * @param {object} cfg  effective configuration
 * @param {number} roleCount  how many roles are listed in the state
 * @returns {Object<string, object>} the question map for POST /typesafe/v1/systemone
 */
function buildQuestions(cfg, roleCount) {
  const Q = cfg.questions;
  const all = roleVars(cfg, 0);
  const q = {};
  for (let i = 0; i < roleCount; i++) {
    const v = roleVars(cfg, i);
    q[`relevance_${i}`] = { type: 'score', instructions: fill(Q.roleRelevance.instructions, v), criteria: Q.roleRelevance.levels.map(t => fill(t, v)) };
    q[`seniority_${i}`] = { type: 'choice', instructions: fill(Q.roleSeniority.instructions, v), criteria: mapFill(Q.roleSeniority.options, v) };
  }
  q.overall_match = { type: 'score', instructions: fill(Q.overallMatch.instructions, all), criteria: Q.overallMatch.levels.map(t => fill(t, all)) };
  q.progression = { type: 'choice', instructions: fill(Q.progression.instructions, all), criteria: mapFill(Q.progression.options, all) };
  q.career_change = { type: 'noul', instructions: fill(Q.careerChange.instructions, all), criteria: mapFill(Q.careerChange.criteria, all) };
  q.injection = { type: 'noul', instructions: fill(Q.injection.instructions, all) };
  return q;
}

/** The one question about the searched role itself, with the state that goes with it (nothing about any candidate). */
function buildSearchLevelRequest(cfg, searchRole) {
  const Q = cfg.questions;
  const v = { ladder: Q.ladder, role: '', search: '`search.role`', roles: '' };
  return {
    state: { agency_context: Q.agencyContext, search: { role: searchRole } },
    questions: { search_level: { type: 'choice', instructions: fill(Q.searchLevel.instructions, v), criteria: mapFill(Q.searchLevel.options, v) } },
  };
}

/**
 * The state: the searched role, the redacted structured role list (most recent first) and the facts code computed.
 * No raw CV text, name, contact detail, address or referee ever gets here: only parsed fields that already went through the redactor.
 */
function buildState(cfg, searchRole, facts) {
  const n = facts.recentYears;
  const computed = {
    total_career_months: facts.totalMonths,
    [`months_in_last_${n}_years`]: facts.monthsRecent,
    roles_listed: facts.rolesSent,
    roles_not_listed: facts.rolesParsed - facts.rolesSent,
  };
  return {
    agency_context: cfg.questions.agencyContext,
    data_note: cfg.questions.dataNote,
    search: { role: searchRole },
    candidate: {
      roles: facts.roles.map(roleLine),
      qualifications: facts.qualifications,
      computed_facts: computed,
    },
  };
}

// What each question must return, used to validate the answers (same shape the production Jev client validates).
function expectedShape(questions) {
  const out = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'choice') out[k] = { type: 'choice', options: Object.keys(q.criteria) };
    else if (q.type === 'score') out[k] = { type: 'score', levels: q.criteria.length };
    else out[k] = { type: 'noul' };
  }
  return out;
}

function questionSetHash(cfg, questions) {
  return crypto.createHash('sha256').update(cfg.questions.version + JSON.stringify(questions)).digest('hex').slice(0, 12);
}

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') / 3.5);
}

/** Jev limits: 64k tokens in total, 32k for the state plus the longest single question. */
function sizeCheck(state, questions) {
  const stateTokens = estimateTokens(JSON.stringify(state));
  let longest = 0;
  let total = stateTokens;
  for (const q of Object.values(questions)) {
    const t = estimateTokens(JSON.stringify(q));
    total += t;
    if (t > longest) longest = t;
  }
  return { ok: total <= MAX_REQUEST_TOKENS && stateTokens + longest <= MAX_STATE_QUESTION_TOKENS, totalTokens: total, stateTokens, longestQuestionTokens: longest };
}

module.exports = {
  buildQuestions, buildSearchLevelRequest, buildState, expectedShape, questionSetHash, sizeCheck, estimateTokens, fill,
  MAX_REQUEST_TOKENS, MAX_STATE_QUESTION_TOKENS,
};
