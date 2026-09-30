'use strict';
// Test fixtures for the core package: a throw-away RESOURCER_HOME, a DB with the real
// schema, and a runner that starts the scripts as child processes with the network guard.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { REAL_SCHEMA } = require('./schema');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RES = path.join(REPO, 'resourcer');
const SCRIPTS = path.join(RES, 'scripts');
const NETGUARD = path.join(__dirname, 'netguard.js');

function loadSqlite() {
  try {
    return require('better-sqlite3');
  } catch (e) {
    return require(path.join(RES, 'node_modules', 'better-sqlite3'));
  }
}

const roots = [];

function cleanup() {
  for (const d of roots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on('exit', cleanup);

/** A fresh RESOURCER_HOME with config/ copied from the repo. */
function makeHome(prefix = 'core') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  for (const f of fs.readdirSync(path.join(RES, 'config'))) {
    fs.copyFileSync(path.join(RES, 'config', f), path.join(dir, 'config', f));
  }
  return dir;
}

/** Environment for a child process (no real .env, no inherited RESOURCER_* settings). */
function childEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RESOURCER_') || k.startsWith('SCREEN_')) delete env[k];
  return {
    ...env,
    RESOURCER_HOME: home,
    HERMES_HOME: home,
    RESOURCER_ENV_FILE: path.join(home, 'no-such.env'),
    ...extra,
  };
}

/**
 * Run a script under resourcer/ (path relative to resourcer/) as a child process.
 * Returns { status, stdout, stderr }.
 */
function run(rel, args, { home, env, input, timeout = 60000, preload = [] } = {}) {
  const requires = [NETGUARD, ...preload].flatMap(f => ['--require', f]);
  const r = spawnSync(process.execPath, [...requires, path.join(RES, rel), ...args], {
    env: childEnv(home, env),
    input,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, error: r.error };
}

/** Create home/candidates.db with the real schema; returns the open handle (caller closes). */
function makeDb(home, { schema = REAL_SCHEMA } = {}) {
  const Database = loadSqlite();
  const db = new Database(path.join(home, 'candidates.db'));
  db.exec(schema);
  return db;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** ISO timestamp `min` minutes in the past. */
function minsAgo(min) {
  return new Date(Date.now() - min * 60000).toISOString();
}

module.exports = { REPO, RES, SCRIPTS, NETGUARD, loadSqlite, makeHome, childEnv, run, makeDb, writeJson, readJson, minsAgo, cleanup };
