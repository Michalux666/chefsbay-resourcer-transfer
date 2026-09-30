'use strict';
// answer builders shared by the decision tests: a well-matched candidate whose answers a test overrides one by one
const fs = require('node:fs');
const path = require('node:path');

// read the packaged file directly: requiring criteria-helpers here would replace the environment of a test file that uses helpers.js
const FILE = [['..', '..'], ['..', '..', '..', 'build'], ['..', '..', 'build']].map(p => path.resolve(__dirname, ...p, 'resourcer', 'config', 'screening-criteria.json')).find(f => fs.existsSync(f));
const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const KINDS = ['entry', 'junior_cook', 'cook', 'senior_chef', 'head_chef', 'service_or_bar', 'hospitality_management', 'other_hospitality', 'not_hospitality', 'cannot_tell'];
const SEN = ['much_more_junior', 'one_step_junior', 'comparable', 'one_step_senior', 'two_or_more_steps_senior', 'not_comparable', 'cannot_tell'];
const ROLES = Object.keys(base.roleLevel.role_level.criteria);

function choice(options, main, top) {
  const t = top === undefined ? 0.97 : top;
  const p = {};
  for (const o of options) p[o] = 0;
  const rest = options.filter(o => o !== main);
  p[main] = t;
  p[rest[0]] = Math.round((1 - t) * 1000) / 1000;
  return { p, c: 0.9 };
}

function mix(options, weights) {
  const p = {};
  for (const o of options) p[o] = weights[o] || 0;
  return { p, c: 0.5 };
}

// a clean, well-matched candidate for a generic chef search; fit is what the three whole-policy readings say together
function A(o) {
  const x = o || {};
  const rel = x.rel || [0.01, 0.02, 0.1, 0.87];
  const fit = x.fit === undefined ? 0.9 : x.fit;
  const out = {
    role_level: x.roleAns || choice(ROLES, x.role || 'chef_generic', 1),
    seniority: x.senAns || choice(SEN, x.sen || 'comparable'),
    candidate_kind: x.kindAns || choice(KINDS, x.kind || 'cook'),
    kind_work: x.kindWorkAns || choice(KINDS, x.kindWork || x.kind || 'cook'),
    relevance: { p: { 0: rel[0], 1: rel[1], 2: rel[2], 3: rel[3] }, c: 0.8 },
    same_area_seen: x.area === undefined ? 0.95 : x.area,
    hospitality_experience: x.hosp === undefined ? 0.96 : x.hosp,
    too_junior: x.tooJunior === undefined ? 0.03 : x.tooJunior,
    overqualified: x.over === undefined ? 0.03 : x.over,
    info_sufficient: x.info === undefined ? 0.97 : x.info,
    injection: x.inject === undefined ? 0.02 : x.inject,
    would_place: fit,
    would_place2: fit,
    clear_mismatch: 1 - fit,
    x_history_chars: x.hist === undefined ? 300 : x.hist,
    x_has_title: x.title === undefined ? 1 : x.title,
    x_injection_kw: x.kw === undefined ? 0 : x.kw,
    x_updated_days: x.upd === undefined ? 5 : x.upd,
  };
  if (x.active !== undefined) out.x_active_days = x.active;
  if (x.apps !== undefined) out.x_apps_days = x.apps;
  if (x.gap !== undefined) out.x_role_gap_days = x.gap;
  return { ...out, ...(x.extra || {}) };
}


module.exports = { KINDS, SEN, ROLES, choice, mix, A };
