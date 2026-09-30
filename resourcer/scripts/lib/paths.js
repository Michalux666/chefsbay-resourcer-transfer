'use strict';
const path = require('path');

const HOME = process.env.RESOURCER_HOME
  ? path.resolve(process.env.RESOURCER_HOME)
  : path.resolve(__dirname, '..', '..');

const p = (...parts) => path.join(HOME, ...parts);

module.exports = {
  HOME,
  p,
  DB: p('candidates.db'),
  SCRIPTS: p('scripts'),
  RUNS: p('runs'),
  DOWNLOADS: p('downloads'),
  LOGS: p('logs'),
  RUNTIME: p('runtime'),
  PENDING: p('pending-searches'),
  CONFIG: p('config'),
  SECRETS: p('secrets'),
  OUTBOX: p('outbox'),
  SHADOW: p('shadow'),
  STATE: p('state'),
  BACKUPS: p('backups'),
  NODE: process.execPath,
};
