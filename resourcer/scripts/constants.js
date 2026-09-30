'use strict';

const path = require('path');
const paths = require('./lib/paths');

const WORKSPACE = paths.HOME;
const DOWNLOADS = paths.DOWNLOADS;
const RUNS_DIR = paths.RUNS;
const LOGS_DIR = paths.LOGS;
const DB_PATH = paths.DB;
// Browser session cookies are runtime state (never bundled), so they live under state/.
const SESSION_PATH = path.join(paths.STATE, 'caterer-session.json');
const CREDS_PATH = path.join(paths.SECRETS, 'zoho-credentials.json');

const BASE_CATERER = 'https://recruiter.caterer.com';
const RECRUIT_BASE = 'https://recruit.zoho.eu';

const CREDITS_TOTAL = 62475;
const CREDITS_EXPIRY = '2027-03-11';
const DAILY_QUOTA = 248;

// Pipeline run statuses - used by run-lock, dashboard, process-approved-queue
const RUN_STATUS = {
  INITIALIZING:  'phase1_initializing',
  SEARCHING:     'phase1_searching',
  ACTIVE:        'phase1_active',
  RUNNING:       'phase1_running',
  COMPLETE:      'phase1_complete',
  ABANDONED:     'phase1_abandoned',
  PHASE2_START:  'phase2_starting',
  PHASE2_PUSH:   'phase2_pushing',
  DONE:          'complete',
  ERROR:         'error',
};

// In-flight statuses (pipeline actively running - used by run-lock)
const IN_FLIGHT_STATUSES = [
  RUN_STATUS.INITIALIZING,
  RUN_STATUS.SEARCHING,
  RUN_STATUS.ACTIVE,
  RUN_STATUS.RUNNING,
  RUN_STATUS.COMPLETE,
  RUN_STATUS.PHASE2_START,
  RUN_STATUS.PHASE2_PUSH,
];

// Terminal statuses (pipeline finished)
const TERMINAL_STATUSES = [
  RUN_STATUS.ABANDONED,
  RUN_STATUS.DONE,
  RUN_STATUS.ERROR,
  'phase1_stale',     // agent-written cleanup status
];

module.exports = {
  WORKSPACE,
  DOWNLOADS,
  RUNS_DIR,
  LOGS_DIR,
  DB_PATH,
  SESSION_PATH,
  CREDS_PATH,
  BASE_CATERER,
  RECRUIT_BASE,
  CREDITS_TOTAL,
  CREDITS_EXPIRY,
  DAILY_QUOTA,
  RUN_STATUS,
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
};
