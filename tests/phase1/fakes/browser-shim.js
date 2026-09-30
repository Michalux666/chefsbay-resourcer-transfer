'use strict';
// Stand-in for scripts/lib/browser.js (DESIGN 5.1) that drives the fake agent-browser executable.
// It reproduces the wrapper contract: argv array, no shell, stderr+stdout merged, kill on timeout.
const { spawn } = require('child_process');

const FAKE = process.env.P1_FAKE_AB;
const CAP = Number(process.env.P1_SHIM_TIMEOUT_MS || 0);

function run(args, opts) {
  const o = Object.assign({ session: 'caterer', timeoutMs: 120000 }, opts || {});
  const limit = CAP > 0 ? Math.min(CAP, o.timeoutMs) : o.timeoutMs;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(process.execPath, [FAKE, '--session', o.session].concat(args), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      finish({ ok: false, code: -1, out: `Error: TIMEOUT after ${Math.round(o.timeoutMs / 1000)}s`, timedOut: true });
    }, limit);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, code: null, out: `Error: spawn failed: ${e.message}`, timedOut: false }));
    child.on('close', (code) => finish({ ok: code === 0, code, out: (err + out).trimEnd(), timedOut: false }));
  });
}

async function getUrl(opts) {
  const r = await run(['get', 'url'], opts);
  if (process.env.P1_SHIM_GETURL_OBJECT === '1') return r;
  if (r.timedOut || !r.ok) return '';
  const lines = r.out.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : '';
}

module.exports = {
  run,
  open: (url, o) => run(['open', url], o),
  waitNetworkIdle: (o) => run(['wait', '--load', 'networkidle'], o),
  evalB64: (b64, o) => run(['eval', '-b', b64], o),
  getUrl,
  stateSave: (file, o) => run(['state', 'save', file], o),
  stateLoad: (file, o) => run(['state', 'load', file], o),
  close: (o) => run(['close'], o),
};
