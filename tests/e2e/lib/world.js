'use strict';
/*
 * The simulated Hermes profile and its fake outside world (see tests/e2e-linux.sh for the overview).
 *
 *   <root>/opt-data/profiles/resourcer            HERMES_HOME (profile): .env, scripts/, bin/agent-browser, home/
 *   <root>/opt-data/profiles/resourcer/workspace/resourcer   RESOURCER_HOME
 *   <root>/legacy, <root>/private                 the laptop side: legacy workspace, bundle and passphrase files
 *
 * Cron jobs are run the way Hermes runs a no-agent script job: the installed wrapper executed directly,
 * cwd = the job's workdir, with a scrubbed environment (env -i). Besides PATH and HOME the only things
 * that reach the children are the test injections listed in cronEnv().
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const U = require('./util');
const D = require('./data');
const legacy = require('./legacy');
const { startServices } = require('./services');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SIM = process.env.E2E_ROOT || path.join(os.homedir(), 'hermes-sim');
const NODE = process.execPath;

function londonInstantAt(hour, minute) {
  const parts = (d) => {
    const o = {};
    for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d)) o[p.type] = p.value;
    return o;
  };
  const now = parts(new Date());
  for (const shift of [0, -1, 1]) {
    const d = new Date(Date.UTC(+now.year, +now.month - 1, +now.day, hour + shift, minute));
    const p = parts(d);
    if (+p.hour === hour && +p.day === +now.day) return d.toISOString();
  }
  return new Date().toISOString();
}

class World {
  constructor(name) {
    this.name = name;
    this.root = name === 'main' ? SIM : path.join(SIM, 'worlds', name);
    this.profile = path.join(this.root, 'opt-data', 'profiles', 'resourcer');
    this.home = path.join(this.profile, 'workspace', 'resourcer');
    this.scriptsDir = path.join(this.profile, 'scripts');
    this.binDir = path.join(this.profile, 'bin');
    this.legacyDir = path.join(this.root, 'legacy');
    this.privateDir = path.join(this.root, 'private');
    this.abDir = path.join(this.root, 'fake-ab');
    this.servicesFile = path.join(this.root, 'services.json');
    this.netlog = path.join(this.root, 'netlog.jsonl');
    this.clockFile = path.join(this.root, 'clock.json');
    this.bundle = path.join(this.privateDir, 'resourcer-bundle.enc');
    this.passFile = path.join(this.privateDir, 'bundle-passphrase');
    this.svc = null;
    this.spawned = new Set();
    this.testNow = londonInstantAt(10, 30);
    this.knobs = {};
    this.envFile = {};
  }

  p(...rel) { return path.join(this.home, ...rel); }

  // ------------------------------------------------------------------ build

  async create(opts) {
    const o = Object.assign({ sources: 'caterer', install: true }, opts);
    if (this.name === 'main') {
      // the main world IS $E2E_ROOT, which also holds worlds/ and logs/: remove only what this world owns
      for (const n of ['opt-data', 'legacy', 'private', 'fake-ab', 'services.json', 'netlog.jsonl', 'clock.json']) U.rmrf(path.join(this.root, n));
    } else {
      U.rmrf(this.root);
    }
    fs.mkdirSync(path.join(this.profile, 'home'), { recursive: true });
    fs.mkdirSync(this.privateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.abDir, { recursive: true });
    this.svc = await startServices(this.root, o.services);
    // Scenarios 01 to 12 were written for the LLM-decides engine, so the world pins it (and opts in to it: the shipped code refuses every engine but jev_only
    // otherwise); scenario 13 passes engine: null to run on the shipped default (jev_only), or allowLlm: false to keep a leftover engine without the opt-in.
    this.envFile = {
      AI_GATEWAY_API_KEY: D.SECRETS.aiKey,
      SCREEN_GATEWAY_ORIGIN: this.svc.gateway.origin,
      BACKUP_PASSPHRASE: D.SECRETS.backupPassphrase,
      RESOURCER_SOURCES: o.sources,
      SCREEN_ENGINE: o.engine === undefined ? 'jev_shadow' : o.engine,
      SCREEN_ALLOW_LLM: o.engine === null || o.allowLlm === false ? null : '1',
    };
    this.writeEnv();
    fs.writeFileSync(this.passFile, D.SECRETS.bundlePassphrase, { mode: 0o600 });
    fs.writeFileSync(this.clockFile, '[]');
    this.installWrappers();
    this.installFakeBrowser();
    this.setWorld(Object.assign({ credentials: { username: D.SECRETS.catererUser, password: D.SECRETS.catererPass } }, D.siteWorld(D.CANDIDATES)));
    if (o.install) {
      this.installCode();
      legacy.build(this.legacyDir, o.legacy);
      this.makeBundle();
      this.restoreBundle();
      this.migrate();
    }
    return this;
  }

  writeEnv(extra) {
    Object.assign(this.envFile, extra || {});
    for (const k of Object.keys(this.envFile)) if (this.envFile[k] === null) delete this.envFile[k];
    const text = Object.entries(this.envFile).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(path.join(this.profile, '.env'), text, { mode: 0o600 });
    fs.chmodSync(path.join(this.profile, '.env'), 0o600);
  }

  installWrappers() {
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, 'hermes', 'scripts'))) {
      if (!/^resourcer-.*\.sh$/.test(f)) continue;
      const dest = path.join(this.scriptsDir, f);
      fs.copyFileSync(path.join(REPO, 'hermes', 'scripts', f), dest);
      fs.chmodSync(dest, 0o755);
    }
  }

  installFakeBrowser() {
    fs.mkdirSync(this.binDir, { recursive: true });
    const bin = path.join(this.binDir, 'agent-browser');
    fs.writeFileSync(bin, `#!/bin/sh\nFAKE_AB_DIR='${this.abDir}' exec '${NODE}' '${path.join(REPO, 'tests', 'e2e', 'lib', 'fake-ab.js')}' "$@"\n`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
  }

  // scenario.json for the fake browser: deep-merge patch
  setWorld(patch, replace) {
    const file = path.join(this.abDir, 'scenario.json');
    const cur = replace ? {} : U.readJson(file, {});
    const merged = deepMerge(cur, { site: patch });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  }

  setBrowserScenario(patch) {
    const file = path.join(this.abDir, 'scenario.json');
    fs.writeFileSync(file, JSON.stringify(deepMerge(U.readJson(file, {}), patch), null, 2));
  }

  fakeBrowserState() { return U.readJson(path.join(this.abDir, 'browser.json'), {}); }
  setFakeBrowserState(patch) {
    const file = path.join(this.abDir, 'browser.json');
    fs.writeFileSync(file, JSON.stringify(deepMerge(U.readJson(file, { alive: false, url: 'about:blank', page: 'blank', loggedIn: false, hasFingerprint: false, bannerDismissed: false, counters: {}, ruleHits: {} }), patch)));
  }
  browserCalls() { return U.readJsonl(path.join(this.abDir, 'calls.jsonl')).filter((l) => l.event === 'call'); }
  warmLoggedIn() {
    this.setFakeBrowserState({ alive: true, loggedIn: true, hasFingerprint: true, knownDevice: true, page: 'home', url: 'https://recruiter.caterer.com/Home/1368655' });
  }

  // Reed on: the operator's canary has passed. The launcher starts our chromium stand-in under the real xvfb-run; it serves the
  // fake Reed site (CDP) and the fake Reed API on loopback ports chosen here. cards: optional overrides of the 30 default cards.
  async enableReed(cards) {
    const cdp = await U.freePort();
    const api = await U.freePort();
    const bin = path.join(this.binDir, 'chromium');
    fs.writeFileSync(bin, `#!/bin/sh
exec '${NODE}' '${path.join(REPO, 'tests', 'e2e', 'lib', 'fake-chromium.js')}' "$@"
`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    if (cards) {
      const f = path.join(this.privateDir, 'reed-cards.json');
      fs.writeFileSync(f, JSON.stringify(cards));
      this.knobs.E2E_REED_CANDIDATES_FILE = f;
    }
    this.writeEnv({ RESOURCER_SOURCES: 'both', CHROMIUM_PATH: bin });
    Object.assign(this.knobs, {
      REED_CDP_PORT: String(cdp), FAKE_API_PORT: String(api), REED_API_BASE: `http://127.0.0.1:${api}/api-bff-recruiter-candidates`,
      REED_CDP_WAIT_S: '30', REED_AUTO_RELAUNCH: '0', E2E_REED_CV_TEXT: D.REED_CV_TEXT,
    });
    this.reed = { cdp, api, bin };
    return this.reed;
  }

  installCode() {
    fs.mkdirSync(this.home, { recursive: true });
    const r = spawnSync('rsync', ['-a', '--exclude', 'node_modules', `${path.join(REPO, 'resourcer')}/`, `${this.home}/`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr}`);
    const n = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: this.home, encoding: 'utf8', env: Object.assign({}, process.env, { NODE_OPTIONS: '' }) });
    this.npmInstall = { status: n.status, tail: String(n.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ') };
    if (n.status !== 0) throw new Error(`npm install failed: ${n.stderr}`);
  }

  toolEnv(extra) {
    const base = {
      PATH: `${path.dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: path.join(this.profile, 'home'),
      BUNDLE_PASSPHRASE_FILE: this.passFile,
      BUNDLE_SCRYPT_LOG2N: '15',
      BUNDLE_SQLITE_MODULE: path.join(this.home, 'node_modules', 'better-sqlite3'),
    };
    return Object.assign(base, extra || {});
  }

  makeBundle(extraArgs) {
    return this.tool('make-bundle.js', ['--source', this.legacyDir, '--out', this.bundle].concat(extraArgs || []));
  }

  restoreBundle(extraArgs) {
    return this.tool('restore-bundle.js', ['--bundle', this.bundle, '--home', this.home].concat(extraArgs || []));
  }

  // a repo tool (laptop / operator side): runs from the repo, not from RESOURCER_HOME
  tool(script, args, opts) {
    const o = opts || {};
    const r = spawnSync(NODE, [path.join(REPO, 'tools', script)].concat(args || []), {
      cwd: REPO, encoding: 'utf8', env: this.toolEnv(o.env), timeout: o.timeoutMs || 120000,
    });
    const res = { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    if (!o.allowFail && res.code !== 0) throw new Error(`tools/${script} exited ${res.code}: ${(res.stdout + res.stderr).slice(-600)}`);
    return res;
  }

  // a script under RESOURCER_HOME/scripts run synchronously with the cron environment (install steps)
  node(script, args, opts) {
    const o = opts || {};
    const r = spawnSync(NODE, [path.join(this.home, 'scripts', script)].concat(args || []), {
      cwd: this.home, encoding: 'utf8', env: this.cronEnv(o.env), timeout: o.timeoutMs || 120000,
    });
    const res = { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    if (!o.allowFail && res.code !== 0) throw new Error(`${script} exited ${res.code}: ${(res.stdout + res.stderr).slice(-600)}`);
    return res;
  }

  migrate() { return this.node('migrate-schema.js', []); }

  // ------------------------------------------------------------------ running things

  cronEnv(extra) {
    const env = {
      PATH: `${path.dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: path.join(this.profile, 'home'),
      NODE_OPTIONS: `--require ${path.join(REPO, 'tests', 'e2e', 'lib', 'preload.js')}`,
      E2E_SERVICES_FILE: this.servicesFile,
      E2E_NETLOG: this.netlog,
      E2E_CLOCK_FILE: this.clockFile,
      RESOURCER_TEST_NOW: this.testNow,
      // speed knobs (documented in docs/ENV.md as test-only)
      RESOURCER_AB_NAV_GAP_MS: '0',
      RESOURCER_SLEEP_SCALE: '0',
      RESOURCER_SETTLE_MS: '200',
      PHASE1_SETTLE_MS: '200',
      PHASE1_UNLOCK_PAUSE_MS: '50',
      SCREEN_PAGE_RETRY_PAUSE_SEC: '1',
      SCREEN_BACKOFF_BASE_MS: '20',
      PHASE1_HEARTBEAT_SEC: '5',
    };
    return Object.assign(env, this.knobs, extra || {});
  }

  spawnProc(file, args, { cwd, env, timeoutMs }) {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.spawned.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t0 = Date.now();
    const done = new Promise((resolve) => {
      let timer = null;
      let timedOut = false;
      if (timeoutMs) timer = setTimeout(() => { timedOut = true; U.killGroup(child.pid, 'SIGKILL'); }, timeoutMs);
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        this.spawned.delete(child.pid);
        resolve({ code, signal, stdout, stderr, ms: Date.now() - t0, timedOut, pid: child.pid });
      });
    });
    done.pid = child.pid;
    return done;
  }

  // One Hermes cron fire of a wrapper. Returns a promise with .pid.
  cron(job, opts) {
    const o = opts || {};
    const script = path.join(this.scriptsDir, `${job}.sh`);
    const env = this.cronEnv(o.env);
    return this.spawnProc('/usr/bin/env', ['-i'].concat(Object.entries(env).map(([k, v]) => `${k}=${v}`), [script]), {
      cwd: this.home, env: {}, timeoutMs: o.timeoutMs || 300000,
    });
  }

  // Any script under RESOURCER_HOME/scripts, asynchronously, with the cron environment.
  nodeAsync(script, args, opts) {
    const o = opts || {};
    return this.spawnProc(NODE, [path.join(this.home, 'scripts', script)].concat(args || []), { cwd: this.home, env: this.cronEnv(o.env), timeoutMs: o.timeoutMs || 300000 });
  }

  // Fire the tick like the every-minute cron does until cond() holds. Returns the list of tick results.
  async tickUntil(cond, opts) {
    const o = Object.assign({ maxTicks: 40, tickMin: 1, gapMs: 300, timeoutMs: 600000 }, opts);
    const results = [];
    const t0 = Date.now();
    for (let i = 0; i < o.maxTicks; i += 1) {
      const r = await this.cron('resourcer-tick', { env: Object.assign({ RESOURCER_MAX_TICK_MIN: String(o.tickMin) }, o.env), timeoutMs: 240000 });
      results.push(r);
      if (o.onTick) await o.onTick(r, i);
      if (await cond(r, i)) return results;
      if (Date.now() - t0 > o.timeoutMs) break;
      await U.sleep(o.gapMs);
    }
    throw new Error(`condition not reached after ${results.length} ticks; tick tails: ${results.slice(-3).map((r) => `rc=${r.code} ${(r.stdout || '').trim().slice(-120)}`).join(' / ')}`);
  }

  // ------------------------------------------------------------------ state readers

  json(rel, fb) { return U.readJson(this.p(rel), fb === undefined ? null : fb); }
  jsonl(rel) { return U.readJsonl(this.p(rel)); }
  list(rel, re) { return U.listFiles(this.p(rel), re); }
  text(rel) { try { return fs.readFileSync(this.p(rel), 'utf8'); } catch { return ''; } }
  exists(rel) { return fs.existsSync(this.p(rel)); }

  db() {
    const Database = require(path.join(this.home, 'node_modules', 'better-sqlite3'));
    return new Database(this.p('candidates.db'), { readonly: true, fileMustExist: true, timeout: 5000 });
  }

  dbAll(sql, ...params) {
    const db = this.db();
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  }

  alerts() { return this.jsonl('outbox/alerts.jsonl'); }

  runFiles(prefix) { return this.list('runs', new RegExp(`^${prefix}.*\\.json$`)); }

  lastRun() { return this.json('runtime/last-run.json'); }

  // Write a pending search the way the dashboard / tools/request-search.js does (no spawnedAt).
  dropPending(over, name) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const payload = Object.assign({
      jobTitle: D.TERRITORY.jobTitle, location: D.TERRITORY.location, distance: D.TERRITORY.distance, keywords: '',
      priority: 'low', sources: 'caterer', activeWithin: '1 month', cvLimit: 20, requestedAt: new Date().toISOString(), source: 'e2e-dashboard',
    }, over);
    const file = name || `search-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.mkdirSync(this.p('pending-searches'), { recursive: true });
    fs.writeFileSync(this.p('pending-searches', file), JSON.stringify(payload, null, 2));
    return file;
  }

  pendingFiles() { return this.list('pending-searches', /\.json$/); }

  // processes whose command line mentions this world's home
  worldProcs(re) {
    return U.procs(re || /./).filter((x) => x.cmd.includes(this.home) || x.cmd.includes(this.profile) || x.cwd.startsWith(this.home));
  }

  pipelineProcs() {
    return U.procs(/(phase1|watchdog-runner|process-approved-queue|ai-review|run-pipeline|reed-phase1)\.js/).filter((x) => x.cmd.includes(this.home));
  }

  netBlocked() { return U.readJsonl(this.netlog).filter((x) => x.blocked); }

  jump(addMs) {
    const j = U.readJson(this.clockFile, []);
    j.push({ atRealMs: Date.now(), addMs });
    fs.writeFileSync(this.clockFile, JSON.stringify(j));
  }

  // Persisted timestamps moved back as if minutes had passed: abandoned / interrupted status files become old enough for
  // recovery, and the supervisor's maintenance and launch back-off stamps expire. Nothing else is touched.
  fastForward(minutes) {
    const ms = (minutes || 10) * 60000;
    for (const f of this.list('runs', /^phase1-.*\.json$/)) {
      const d = this.json(`runs/${f}`);
      if (d && /^(phase1_abandoned|phase2_starting)$/.test(d.status)) {
        d.updatedAt = new Date(Date.now() - ms).toISOString();
        fs.writeFileSync(this.p('runs', f), JSON.stringify(d));
      }
    }
    const st = this.json('runtime/watchdog-state.json');
    if (st) {
      st.lastMaintenanceAt = 0;
      st.launchNotBefore = 0;
      fs.writeFileSync(this.p('runtime/watchdog-state.json'), JSON.stringify(st));
    }
  }

  // Locks and records that would block or confuse the next run: anything left behind, plus live statuses.
  lockProblems() {
    const out = [];
    for (const f of ['runtime/run.json', 'runtime/tick.lock', 'runtime/browser.lock']) {
      const rec = this.json(f);
      if (rec === null) continue;
      out.push(`${f} still exists (pid ${rec.pid}, alive=${U.pidAlive(rec.pid)})`);
    }
    for (const f of this.list('runs', /\.run-lock$/)) out.push(`runs/${f}`);
    for (const f of this.list('runs', /^phase1-.*\.json$/)) {
      const d = this.json(`runs/${f}`);
      if (d && /^(phase1_initializing|phase1_running|phase1_taking_over|phase1_searching|phase1_active|phase2_starting|phase2_push|phase2_pushing)$/.test(d.status)) out.push(`runs/${f} is still ${d.status}`);
    }
    return out;
  }

  // ------------------------------------------------------------------ teardown

  async close(opts) {
    const o = opts || {};
    for (const p of U.procs(/./)) {
      if (p.pid === process.pid) continue;
      if (p.cmd.includes(this.root) && !/node --test|e2e-linux/.test(p.cmd)) U.kill(p.pid, 'SIGKILL');
    }
    for (const pid of this.spawned) U.killGroup(pid, 'SIGKILL');
    if (this.svc) { try { await this.svc.close(); } catch { /* already closed */ } }
    if (!o.keep && process.env.E2E_KEEP !== '1') U.rmrf(path.join(this.root, 'worlds', this.name));
  }
}

function deepMerge(a, b) {
  if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
  const out = Object.assign({}, a && typeof a === 'object' && !Array.isArray(a) ? a : {});
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

module.exports = { World, SIM, REPO, NODE, londonInstantAt, deepMerge };
