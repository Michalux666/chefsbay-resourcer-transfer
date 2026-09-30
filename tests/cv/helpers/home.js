'use strict';
// A temporary RESOURCER_HOME for one test file, with the gateway settings pointing at a fake. Must be required BEFORE any
// resourcer script (paths.js reads RESOURCER_HOME once).
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeHome(prefix) {
  const base = process.env.LIFECYCLE_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `${prefix || 'cv'}-`));
  const home = path.join(root, 'resourcer');
  fs.mkdirSync(home, { recursive: true });
  process.env.RESOURCER_HOME = home;
  process.env.HERMES_HOME = root;
  process.env.RESOURCER_ENV_FILE = path.join(root, 'no-such.env');
  process.env.SCREEN_BACKOFF_BASE_MS = '1';
  process.env.SCREEN_MAX_ATTEMPTS = '3';
  delete process.env.CV_SCREEN;
  delete process.env.CV_POLICY_REVIEW;
  delete process.env.CV_POLICY_UNREADABLE;
  delete process.env.CV_SCREEN_CONFIG_FILE;
  const h = {
    root,
    home,
    dir: name => path.join(home, name),
    downloads: path.join(home, 'downloads'),
    shadow: path.join(home, 'shadow'),
    state: path.join(home, 'state'),
    runtime: path.join(home, 'runtime'),
    config: path.join(home, 'config'),
    point(gateway) {
      process.env.SCREEN_GATEWAY_ORIGIN = gateway.origin;
      process.env.AI_GATEWAY_API_KEY = gateway.key;
    },
    reset() {
      for (const d of ['downloads', 'runs', 'logs', 'pending-searches', 'outbox', 'shadow', 'state', 'runtime', 'config']) {
        fs.rmSync(path.join(home, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        fs.mkdirSync(path.join(home, d), { recursive: true });
      }
      for (const f of ['candidates.db', 'candidates.db-wal', 'candidates.db-shm']) fs.rmSync(path.join(home, f), { force: true });
    },
    writeConfig(obj) {
      fs.mkdirSync(path.join(home, 'config'), { recursive: true });
      fs.writeFileSync(path.join(home, 'config', 'cv-screening.json'), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
    alerts() {
      try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; }
    },
    shadowRows() {
      const rows = [];
      try {
        for (const n of fs.readdirSync(path.join(home, 'shadow'))) {
          if (!/^cv-.*\.jsonl$/.test(n)) continue;
          for (const l of fs.readFileSync(path.join(home, 'shadow', n), 'utf8').split('\n').filter(Boolean)) rows.push(JSON.parse(l));
        }
      } catch (e) { /* none */ }
      return rows;
    },
    // every file under the home (relative names), so a test can prove that nothing unexpected was written
    listFiles() {
      const out = [];
      const walk = (d) => {
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(home, p).split(path.sep).join('/'));
        }
      };
      walk(home);
      return out;
    },
  };
  h.reset();
  return h;
}

module.exports = { makeHome };
