'use strict';

// Builds a throw-away RESOURCER_HOME that mirrors resourcer/scripts and overlays test doubles for things owned by other
// packages (candidates-db, the screening CLI, pipeline-halt when absent). Children run the mirrored scripts with fast timings.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'resourcer');
const NODE_MODULES = path.join(SRC, 'node_modules');

function dep(name) {
  try { return require(name); } catch { return require(require.resolve(name, { paths: [SRC, process.cwd()] })); }
}

const DB_STUB = `'use strict';
const Database = require('better-sqlite3');
const path = require('path');
let db = null;
function getDb() {
  if (db) return db;
  db = new Database(path.join(process.env.RESOURCER_HOME || __dirname, 'candidates.db'));
  db.exec(\`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER UNIQUE, reed_id INTEGER UNIQUE,
      source TEXT NOT NULL DEFAULT 'caterer', role TEXT, location TEXT, pulled_date TEXT, unlocked INTEGER DEFAULT 0, zoho_id TEXT);
    CREATE TABLE IF NOT EXISTS reed_daily_usage (
      date TEXT PRIMARY KEY, profile_views INTEGER DEFAULT 0, cv_downloads INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 300);
  \`);
  return db;
}
function closeDb() { if (db) { try { db.close(); } catch (e) { /* closed */ } db = null; } }
process.on('exit', closeDb);
module.exports = { getDb, closeDb };
`;

const AI_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const file = get('--candidates-file');
const list = JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'));
if (argv.includes('--consume-input')) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
const stateFile = process.env.FAKE_AI_STATE;
const plan = (process.env.FAKE_AI_PLAN || '').split(',').filter(Boolean);
let n = 0;
try { n = JSON.parse(fs.readFileSync(stateFile, 'utf8')).n; } catch (e) { /* first call */ }
fs.writeFileSync(stateFile, JSON.stringify({ n: n + 1 }));
const mode = plan[n] || 'ok';
if (process.env.FAKE_AI_LOG) {
  fs.appendFileSync(process.env.FAKE_AI_LOG, JSON.stringify({
    n, mode, job: get('--job'), location: get('--location'), distance: get('--distance'),
    marks: process.env.FAKE_AI_MARK ? list.filter((c) => c.snippet.includes(process.env.FAKE_AI_MARK)).length : 0,
    ids: list.map((c) => c.id), withCv: list.filter((c) => /CV Work Experience/.test(c.snippet)).length,
    snippetKeys: Object.keys(list[0] || {}),
  }) + '' + String.fromCharCode(10) + '');
}
if (mode === 'unavailable') {
  process.stderr.write('API_UNAVAILABLE - fake gateway down' + String.fromCharCode(10) + 'SCREENING_MODEL: none' + String.fromCharCode(10) + '');
  process.stdout.write('API_UNAVAILABLE:fake gateway down');
  process.exit(3);
}
if (mode === 'error') { process.stderr.write('FATAL fake parse error' + String.fromCharCode(10) + ''); process.exit(1); }
if (mode === 'exit2') { process.exit(2); }
if (mode === 'badjson') { process.stdout.write('this is not json'); process.exit(0); }
if (mode === 'crash-signal') { process.kill(process.pid, 'SIGKILL'); }
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
const reject = new Set((process.env.FAKE_AI_REJECT_IDS || '').split(',').filter(Boolean));
const answer = (c) => ({ id: String(c.id), approved: !reject.has(String(c.id)), reason: reject.has(String(c.id)) ? 'Too junior' : 'Good fit' });
let body = list.map(answer);
if (mode === 'notarray') body = { results: body };
if (mode === 'partial') body = body.slice(1);
if (mode === 'empty') body = [];
if (mode === 'stringbool') body = body.map((r) => ({ ...r, approved: String(r.approved) }));
if (mode === 'nullentry') body = [null].concat(body);
process.stdout.write(JSON.stringify(body));
process.stderr.write('SCREENING_MODEL: fake/model-1' + String.fromCharCode(10) + '');
}
`;

const HALT_STUB = `'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const STATE_FILE = path.join(paths.RUNTIME, 'pipeline-halt.json');
const ERRORS_LOG = path.join(paths.LOGS, 'errors.jsonl');
function appendError(entry) { try { fs.mkdirSync(path.dirname(ERRORS_LOG), { recursive: true }); fs.appendFileSync(ERRORS_LOG, JSON.stringify(entry) + '' + String.fromCharCode(10) + ''); } catch (e) { /* never throw */ } }
function getHalt() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; } }
function setHalt(reason, detail, opts = {}) {
  const prev = getHalt();
  const now = new Date().toISOString();
  if (prev && prev.reason === reason) {
    const next = { ...prev, lastCheckedAt: now, blockedRuns: (prev.blockedRuns || 0) + (opts.blockedRun ? 1 : 0) };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  const state = { halted: true, reason, detail: String(detail || ''), since: now, lastCheckedAt: now, blockedRuns: opts.blockedRun ? 1 : 0, remedy: opts.remedy || null };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  appendError({ ts: now, context: 'pipeline_halted', severity: 'critical', error: 'PIPELINE HALTED - ' + reason, detail: String(detail || ''), remedy: opts.remedy || null });
  return state;
}
function clearHalt() {
  const prev = getHalt();
  if (!prev || !prev.halted) return null;
  appendError({ ts: new Date().toISOString(), context: 'pipeline_resumed', severity: 'info', error: 'Pipeline resumed - ' + prev.reason + ' cleared' });
  try { fs.unlinkSync(STATE_FILE); } catch (e) { /* gone */ }
  return prev;
}
module.exports = { getHalt, setHalt, clearHalt, STATE_FILE };
`;

const ROLE_MAP_STUB = "'use strict';\nmodule.exports = { mapToApplyingForRole: () => 'Chef' };\n";

function baseEnv(home, extra) {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(RESOURCER_|REED_|SCREEN_|CHROMIUM_PATH|FAKE_|HERMES_)/.test(k)) continue;
    clean[k] = v;
  }
  const nodePath = [NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return {
    ...clean,
    NODE_PATH: nodePath,
    RESOURCER_HOME: home,
    HERMES_HOME: path.join(home, 'hermes-home'),
    RESOURCER_ENV_FILE: path.join(home, 'none.env'),
    REED_CDP_TRUST_EXISTING: '1',
    REED_CDP_POLL_MS: '100',
    REED_CDP_CLOSE_WAIT_MS: '400',
    REED_LOGIN_TIME_SCALE: '0.02',
    SCREEN_PAGE_RETRY_PAUSE_SEC: '0.05',
    REED_CV_DELAY_MS: '0',
    REED_CAPTURE_TIMEOUT_MS: '3000',
    REED_CDP_COMMAND_TIMEOUT_MS: '5000',
    REED_LAUNCH_TIMEOUT_MS: '20000',
    FAKE_AI_STATE: path.join(home, 'ai-state.json'),
    FAKE_AI_LOG: path.join(home, 'ai-log.jsonl'),
    ...(extra || {}),
  };
}

// opts.realAi: keep the real screening CLI (and its config) instead of the fake one
function makeMirror(opts = {}) {
  const base = process.env.REED_TEST_TMP || os.tmpdir();
  const home = fs.mkdtempSync(path.join(base, 'reedtest-'));
  fs.cpSync(path.join(SRC, 'scripts'), path.join(home, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 'mirror', private: true }));
  // The real candidates-db module (owned by another package) is used when present; the stub keeps this package testable alone.
  const realDb = path.join(SRC, 'candidates-db.js');
  if (fs.existsSync(realDb)) fs.copyFileSync(realDb, path.join(home, 'candidates-db.js')); else fs.writeFileSync(path.join(home, 'candidates-db.js'), DB_STUB);
  if (opts.realAi) {
    if (fs.existsSync(path.join(SRC, 'config'))) fs.cpSync(path.join(SRC, 'config'), path.join(home, 'config'), { recursive: true });
  } else {
    fs.writeFileSync(path.join(home, 'scripts', 'ai-review.js'), AI_STUB);
  }
  const haltFile = path.join(home, 'scripts', 'lib', 'pipeline-halt.js');
  if (!fs.existsSync(haltFile)) fs.writeFileSync(haltFile, HALT_STUB);
  const roleMap = path.join(home, 'scripts', 'applying-for-role-map.js');
  if (!fs.existsSync(roleMap)) fs.writeFileSync(roleMap, ROLE_MAP_STUB);
  fs.mkdirSync(path.join(home, 'hermes-home'), { recursive: true });

  const m = {
    home,
    p: (...parts) => path.join(home, ...parts),
    env: (extra) => baseEnv(home, extra),
    write(rel, content, mode) {
      const f = path.join(home, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2), mode ? { mode } : undefined);
      return f;
    },
    readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')); } catch { return null; } },
    readLines(rel) { try { return fs.readFileSync(path.join(home, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    exists: (rel) => fs.existsSync(path.join(home, rel)),
    // runs a mirrored script; resolves {code, signal, stdout, stderr}
    run(script, args = [], opts = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(home, 'scripts', script), ...args], {
          cwd: home, env: baseEnv(home, opts.env), stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs || 60000);
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      });
    },
    cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
  return m;
}

module.exports = { makeMirror, dep, REPO, SRC, baseEnv };
