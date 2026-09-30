'use strict';
// Library entry for AI screening. Requiring this module has no side effects (no I/O, no exit).
//
//   const screening = require('./lib/screening');
//   const cfg = screening.loadConfig();
//   const engine = screening.createEngine(cfg, { log });
//   const { decisions, modelLabel } = await engine.screenBatch({ job, location, distance }, candidates);
//
// Failures: ScreeningUnavailable (no engine could answer; callers map it to API_UNAVAILABLE / exit 3).

const config = require('./config');
const errors = require('./errors');
const { createEngine } = require('./engine');
const rubric = require('./rubric');
const tiers = require('./tiers');
const reasons = require('./reasons');
const redact = require('./redact');
const rules = require('./rules');
const decide = require('./decide');
const shadow = require('./shadow');
const jevQuestions = require('./jev-questions');

module.exports = {
  loadConfig: config.load,
  DEFAULTS: config.DEFAULTS,
  createEngine,
  ScreeningUnavailable: errors.ScreeningUnavailable,
  UsageError: errors.UsageError,
  rubric,
  tiers,
  reasons,
  redact,
  rules,
  decide,
  shadow,
  jevQuestions,
};
