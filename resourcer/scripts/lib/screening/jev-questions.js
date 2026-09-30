'use strict';

const crypto = require('crypto');
const criteriaLib = require('./criteria');
const { parseCard } = require('./card');

const STATE_VERSION = 's2';
const NONE = '(not provided)';

function currentCriteria(p) {
  if (p && p.criteria) return p.criteria;
  const res = criteriaLib.get();
  if (!res.ok) throw new Error(`screening criteria unusable: ${res.errors.join('; ')}`);
  return res.criteria;
}

// Jev reads only type, instructions and criteria: notes and every other key stay out of the request
function pick(q) {
  const out = { type: q.type, instructions: q.instructions };
  if (q.criteria !== undefined) out.criteria = q.criteria;
  return out;
}

function pickAll(map) {
  const out = {};
  for (const [k, q] of Object.entries(map || {})) if (!k.startsWith('_')) out[k] = pick(q);
  return out;
}

function buildRoleQuestions(criteria) {
  return pickAll(criteria.roleLevel);
}

function buildRoleState(searchRole, criteria) {
  return { context: criteria.context, search: { role: String(searchRole || '') } };
}

// the search role sits in the state and every question points at it by field path, so the questions stay constant
function buildState(p) {
  const criteria = currentCriteria(p);
  const card = p.card || parseCard(p.snippet);
  const work = card.recentWork.slice(0, p.maxChars || 1500);
  const candidate = { current_title: card.currentTitle || NONE, recent_work: work || NONE };
  if (card.desiredRole) candidate.desired_role = card.desiredRole;
  if (p.realJobTitle) candidate.confirmed_job_title = String(p.realJobTitle);
  return { context: criteria.context, search: { role: String(p.searchRole || '') }, candidate };
}

function buildQuestions(p) {
  const criteria = currentCriteria(p);
  const q = pickAll(criteria.questions.candidate);
  if (p.stage === 2 && p.hasRealTitle) Object.assign(q, pickAll(criteria.questions.stage2));
  return q;
}

function expectedShape(questions) {
  const out = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'choice') out[k] = { type: 'choice', options: Object.keys(q.criteria) };
    else if (q.type === 'score') out[k] = { type: 'score', levels: q.criteria.length };
    else out[k] = { type: 'noul' };
  }
  return out;
}

function questionSetHash(questions, roleQuestions) {
  return crypto.createHash('sha256').update(STATE_VERSION + JSON.stringify(questions) + JSON.stringify(roleQuestions || {})).digest('hex').slice(0, 12);
}

function buildRequest(p) {
  const criteria = currentCriteria(p);
  const card = parseCard(p.snippet, p.asOf);
  const hasRealTitle = !!(p.stage === 2 && p.realJobTitle);
  const questions = buildQuestions({ stage: p.stage, hasRealTitle, criteria });
  const state = buildState({ searchRole: p.searchRole, card, realJobTitle: hasRealTitle ? p.realJobTitle : '', criteria, maxChars: p.maxChars });
  const body = { model: p.model, state, questions };
  if (p.zdr) body.providerOptions = { gateway: { zeroDataRetention: true } };
  return { body, card, questions, hasRealTitle, qh: questionSetHash(questions, buildRoleQuestions(criteria)) };
}

const api = { STATE_VERSION, buildState, buildQuestions, buildRoleQuestions, buildRoleState, buildRequest, expectedShape, questionSetHash };

// the criteria hash is part of the version so that editing the criteria invalidates cached decisions and labels the shadow log
Object.defineProperty(api, 'QUESTIONS_VERSION', {
  enumerable: true,
  get() {
    const c = criteriaLib.get();
    return `${STATE_VERSION}-${c.ok ? c.hash : 'invalid'}`;
  },
});

module.exports = api;
