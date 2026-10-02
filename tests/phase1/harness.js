'use strict';
// Builds a throwaway resourcer home: the real phase-1 code and shared libs, plus fakes for every neighbour.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'resourcer');
const FAKES = path.join(__dirname, 'fakes');
const SECRET = 'sk-fake-test-key-0123456789abcdef';

const RESULTS_URL = 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results?FreeText=Chef&CurrentLocation=LS29&Radius=32187&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function writeStub(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const req = (p) => `require(${JSON.stringify(p)});\n`;
const reqExport = (p) => `module.exports = require(${JSON.stringify(p)});\n`;

function card(id, over) {
  return Object.assign({
    id: String(id), name: 'Alex', postcode: 'LS29 8AB', cityRaw: 'Ilkley', experience: 5,
    neverUnlocked: true, unlockedPrev: false,
    snippet: `1. Alex Sample Sous Chef | Ilkley, LS29 8AB Unlock candidate Never unlocked Recent experience Other CV snippets Sous Chef Jan 2021 - Current Test Kitchen Ltd`,
    candidateDataValue: `TOKEN-${id}`,
  }, over || {});
}

function makeHome(scenario, opts) {
  const o = opts || {};
  const base = process.env.P1_TEST_TMP || os.tmpdir();
  const home = fs.mkdtempSync(path.join(base, 'p1-'));
  const sc = Object.assign({}, scenario);

  // Real code under test
  fs.mkdirSync(path.join(home, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'scripts', 'phase1.js'), path.join(home, 'scripts', 'phase1.js'));
  copyDir(path.join(SRC, 'scripts', 'phase1'), path.join(home, 'scripts', 'phase1'));
  for (const lib of ['paths', 'env', 'fsx', 'notify', 'time', 'phase2-exit']) {
    fs.copyFileSync(path.join(SRC, 'scripts', 'lib', `${lib}.js`), path.join(home, 'scripts', 'lib', `${lib}.js`));
  }

  // The role-scoped second look (docs/RESURFACE.md): its library and the CV_SCREEN reader it asks. Without them (every older test) the feature reads as off.
  if (o.resurface) {
    fs.copyFileSync(path.join(SRC, 'scripts', 'lib', 'resurface.js'), path.join(home, 'scripts', 'lib', 'resurface.js'));
    fs.mkdirSync(path.join(home, 'scripts', 'lib', 'cv'), { recursive: true });
    for (const f of ['config.js', 'defaults.json']) fs.copyFileSync(path.join(SRC, 'scripts', 'lib', 'cv', f), path.join(home, 'scripts', 'lib', 'cv', f));
  }

  // Fakes, reached through tiny stubs at the paths phase 1 expects
  const fakesDir = path.join(home, '_fakes');
  copyDir(FAKES, fakesDir);
  const F = (name) => path.join(fakesDir, name);
  writeStub(path.join(home, 'candidates-db.js'), req(F('candidates-db.js')));
  writeStub(path.join(home, 'scripts', 'ai-review.js'), req(F('ai-review.js')));
  writeStub(path.join(home, 'scripts', 'caterer-unlock.js'), req(F('caterer-unlock.js')));
  for (const n of ['run-lock', 'caterer-get-credits', 'process-approved-queue', 'run-pipeline']) {
    if (n === 'run-lock' && (o.real || []).includes('run-lock')) continue;
    writeStub(path.join(home, 'scripts', `${n}.js`), `process.env.P1_FAKE_NAME=${JSON.stringify(n)};\n${req(F('misc-scripts.js'))}`);
  }
  // Optional real neighbours (copied from the repo) to check the interfaces against the real files
  const real = o.real || [];
  if (real.includes('run-lock')) {
    fs.copyFileSync(path.join(SRC, 'scripts', 'run-lock.js'), path.join(home, 'scripts', 'run-lock.js'));
    fs.copyFileSync(path.join(SRC, 'scripts', 'constants.js'), path.join(home, 'scripts', 'constants.js'));
  }
  if (!o.noLoginModule) writeStub(path.join(home, 'scripts', 'caterer-login.js'), reqExport(F('caterer-login.js')));
  if (real.includes('pipeline-halt')) fs.copyFileSync(path.join(SRC, 'scripts', 'lib', 'pipeline-halt.js'), path.join(home, 'scripts', 'lib', 'pipeline-halt.js'));
  else writeStub(path.join(home, 'scripts', 'lib', 'pipeline-halt.js'), reqExport(F('pipeline-halt.js')));
  if (real.includes('browser')) {
    for (const f of ['browser.js', 'browser-env.js']) {
      if (fs.existsSync(path.join(SRC, 'scripts', 'lib', f))) fs.copyFileSync(path.join(SRC, 'scripts', 'lib', f), path.join(home, 'scripts', 'lib', f));
    }
  }
  else if (!o.noBrowserLib) writeStub(path.join(home, 'scripts', 'lib', 'browser.js'), reqExport(F('browser-shim.js')));
  if (real.includes('ai-review')) {
    fs.copyFileSync(path.join(SRC, 'scripts', 'ai-review.js'), path.join(home, 'scripts', 'ai-review.js'));
    copyDir(path.join(SRC, 'scripts', 'lib', 'screening'), path.join(home, 'scripts', 'lib', 'screening'));
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'config', 'screening.json'), path.join(home, 'config', 'screening.json'));
    if (fs.existsSync(path.join(SRC, 'config', 'screening-criteria.json'))) fs.copyFileSync(path.join(SRC, 'config', 'screening-criteria.json'), path.join(home, 'config', 'screening-criteria.json'));
  }

  // Data files
  fs.writeFileSync(path.join(home, 'scripts', 'extract-js.b64'), Buffer.from('/*FAKE-EXTRACT*/ (function(){return "[]"})()', 'utf8').toString('base64') + '\n');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  // The self-check of the applied search window (docs/ACTIVITY.md): its library and the config it reads. Without them (every older test) the feature reads as off.
  if (o.activity) {
    fs.copyFileSync(path.join(SRC, 'scripts', 'lib', 'search-activity.js'), path.join(home, 'scripts', 'lib', 'search-activity.js'));
    if (typeof o.activity === 'object' && o.activity.config !== undefined) fs.writeFileSync(path.join(home, 'config', 'caterer-activity.json'), typeof o.activity.config === 'string' ? o.activity.config : JSON.stringify(o.activity.config));
    else fs.copyFileSync(path.join(SRC, 'config', 'caterer-activity.json'), path.join(home, 'config', 'caterer-activity.json'));
  }
  fs.writeFileSync(path.join(home, 'config', 'postcode-cities.json'), JSON.stringify({
    LS: { city: 'Leeds', county: 'West Yorkshire' },
    M: { city: 'Manchester', county: 'Greater Manchester' },
    BD: { city: 'Bradford', county: 'West Yorkshire' },
  }));
  for (const d of ['runs', 'downloads', 'logs', 'pending-searches', '_state']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'scenario.json'), JSON.stringify(sc));
  return home;
}

function baseArgs(extra) {
  return ['--results-url', RESULTS_URL, '--job-title', 'Chef', '--location', 'LS29', '--cv-limit', '20', '--sources', 'caterer'].concat(extra || []);
}

function readCalls(home) {
  try {
    return fs.readFileSync(path.join(home, '_state', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}

function runPhase1(home, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, {
    P1_SCENARIO: path.join(home, 'scenario.json'),
    P1_STATE_DIR: path.join(home, '_state'),
    P1_FAKE_AB: path.join(home, '_fakes', 'agent-browser.js'),
    P1_HOME: home,
    HERMES_HOME: path.join(home, '_hermes'),
    RESOURCER_ENV_FILE: path.join(home, '_none.env'),
    AI_GATEWAY_API_KEY: SECRET,
    PHASE1_SETTLE_MS: '10',
    PHASE1_UNLOCK_PAUSE_MS: '0',
    SCREEN_PAGE_RETRY_PAUSE_SEC: '0.05',
    P1_SHIM_TIMEOUT_MS: '1500',
    NODE_OPTIONS: `--require ${path.join(FAKES, 'fetch-guard.js')}`,
  }, o.env || {});
  delete env.RESOURCER_HOME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(home, 'scripts', 'phase1.js')].concat(args), { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, o.timeoutMs || 60000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, calls: readCalls(home), home });
    });
  });
}

function listRuns(home) {
  return fs.readdirSync(path.join(home, 'runs')).filter((f) => /^phase1-.*\.json$/.test(f));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function statusOf(home) {
  const files = listRuns(home).filter((f) => !f.startsWith('phase1-bridge'));
  const owned = files.find((f) => /^phase1-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(f));
  return owned ? readJson(path.join(home, 'runs', owned)) : null;
}

function queueOf(home) {
  const files = fs.readdirSync(path.join(home, 'downloads')).filter((f) => /^approved-queue-.*\.json$/.test(f));
  return files.length ? readJson(path.join(home, 'downloads', files[0])) : null;
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

module.exports = { makeHome, baseArgs, runPhase1, readCalls, statusOf, queueOf, listRuns, readJson, cleanup, card, RESULTS_URL, SECRET, REPO, SRC };
