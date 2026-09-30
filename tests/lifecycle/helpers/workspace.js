'use strict';
// Temp RESOURCER_HOME per test file. Must be required BEFORE any resourcer script.
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeWorkspace(prefix) {
  const base = process.env.LIFECYCLE_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `${prefix || 'lc'}-`));
  const home = path.join(root, 'resourcer');
  fs.mkdirSync(home, { recursive: true });
  process.env.RESOURCER_HOME = home;
  process.env.RESOURCER_ENV_FILE = path.join(root, 'no-such.env');
  const ws = {
    root,
    home,
    dir: name => path.join(home, name),
    downloads: path.join(home, 'downloads'),
    runs: path.join(home, 'runs'),
    logs: path.join(home, 'logs'),
    pending: path.join(home, 'pending-searches'),
    outbox: path.join(home, 'outbox'),
    db: path.join(home, 'candidates.db'),
    reset() {
      for (const d of ['downloads', 'runs', 'logs', 'pending-searches', 'outbox', 'backups']) {
        fs.rmSync(path.join(home, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        fs.mkdirSync(path.join(home, d), { recursive: true });
      }
      for (const f of ['candidates.db', 'candidates.db-wal', 'candidates.db-shm', 'candidates.db-journal', 'credits-sync.json']) {
        fs.rmSync(path.join(home, f), { force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
    alerts() {
      try {
        return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      } catch { return []; }
    },
    readJson(file) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
  };
  ws.reset();
  return ws;
}

module.exports = { makeWorkspace };
