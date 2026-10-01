'use strict';
// Shared by the tests of the role-scoped second look (docs/RESURFACE.md): a temporary RESOURCER_HOME with a real SQLite candidates.db in the
// legacy schema (candidate_rejections with its unique indexes, zoho_pushed_at and its trigger), and the settings the rule reads.
// Requiring this file creates the workspace first, before any resourcer script is loaded (paths.js reads RESOURCER_HOME once).
const { makeWorkspace } = require('../lifecycle/helpers/workspace');
const ws = makeWorkspace('rsv');
process.env.HERMES_HOME = ws.root;
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('../lifecycle/helpers/sqlite');
const { createLegacyDb } = require('../lifecycle/helpers/legacy-schema');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'resourcer', 'candidates-db.js');

const KEYS = ['CV_SCREEN', 'CV_RESURFACE', 'CV_RESURFACE_MAX_PER_DAY', 'CV_RESURFACE_MIN_CREDITS', 'ROLE_SCOPE_LEGACY', 'ROLE_SCOPE_MIN_AGE_DAYS'];

/**
 * Sets the switches (undefined deletes one); by default the second look is fully on: CV_SCREEN=on, the rest at their defaults, EXCEPT the role scope for
 * people whose role was never recorded (ROLE_SCOPE_LEGACY, on in production), which these tests of the CV rule switch off so that they keep proving the CV rule
 * alone. The tests of the role scope (tests/resurface/rolescope-*.test.js) set it themselves.
 */
function settings(over) {
  const o = Object.assign({ CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: 'off' }, over || {});
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(o)) if (v !== undefined) process.env[k] = String(v);
}

/**
 * A fresh database. spec: { cands: [{caterer_id|reed_id, unlocked, zoho_id, pushed_at}], rows: [[id, title, origin, source?]] }.
 * (createLegacyDb always adds one row for candidate 1, title Chef: tests use ids from 100 up.)
 */
function build(spec) {
  const s = spec || {};
  ws.reset();
  fs.rmSync(path.join(ws.home, 'runtime'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ws.home, 'runtime'), { recursive: true });
  createLegacyDb(ws.db, { rows: [] });
  const db = new Database(ws.db, { timeout: 5000 });
  try {
    const ins = db.prepare('INSERT INTO candidates (caterer_id, reed_id, source, unlocked, zoho_id, zoho_pushed_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of s.cands || []) {
      ins.run(c.caterer_id ?? null, c.reed_id ?? null, c.reed_id ? 'reed' : 'caterer', c.unlocked ?? 0, c.zoho_id ?? null, c.pushed_at ?? null);
      // the insert trigger stamps created_at with now: `created` (a date string, or null for the legacy rows that never had one) overrides it afterwards
      if ('created' in c) db.prepare(`UPDATE candidates SET created_at = ? WHERE ${c.reed_id ? 'reed_id' : 'caterer_id'} = ?`).run(c.created, c.reed_id ?? c.caterer_id);
    }
    for (const r of s.rows || []) {
      const reed = r[3] === 'reed';
      db.prepare(`INSERT INTO candidate_rejections (${reed ? 'reed_id' : 'caterer_id'}, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-01', ?)`).run(r[0], r[1], r[2]);
    }
  } finally { db.close(); }
  return ws.db;
}

const open = () => new Database(ws.db, { timeout: 5000 });
function withDb(fn) { const db = open(); try { return fn(db); } finally { db.close(); } }
const rows = (id, source) => withDb((db) => db.prepare(`SELECT job_title AS title, origin FROM candidate_rejections WHERE ${source === 'reed' ? 'reed_id' : 'caterer_id'} = ? ORDER BY id`).all(id));
const candidate = (id, source) => withDb((db) => db.prepare(`SELECT unlocked, zoho_id FROM candidates WHERE ${source === 'reed' ? 'reed_id' : 'caterer_id'} = ?`).get(id));

/** Runs candidates-db.js like the pipeline does (a child process), with the settings of this process. */
function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI].concat(args), { env: Object.assign({}, process.env, env || {}), cwd: ws.home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), json() { try { return JSON.parse(stdout.trim().split('\n').pop()); } catch (e) { return null; } } }));
  });
}

const stateFile = () => path.join(ws.home, 'runtime', 'cv-resurface.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return null; } };

/** Puts a file into downloads/ (the "in flight" signals of the guard). */
function download(name, content) {
  fs.mkdirSync(ws.downloads, { recursive: true });
  fs.writeFileSync(path.join(ws.downloads, name), typeof content === 'string' ? content : JSON.stringify(content));
}

module.exports = { ws, REPO, CLI, settings, build, open, withDb, rows, candidate, cli, stateFile, readState, download, Database };
