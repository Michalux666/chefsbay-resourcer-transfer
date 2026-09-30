'use strict';
const { spawn } = require('child_process');

const MAX_CAPTURE = 16 * 1024 * 1024;
const active = new Set();

function killAll() {
  for (const child of active) {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }
}

// Runs a node script with an argument array (never a shell string) and a hard timeout.
// Resolves, never rejects: {code, signal, stdout, stderr, timedOut, error, ms}.
function runNode(script, args, opts) {
  const o = Object.assign({ cwd: undefined, timeoutMs: 120000, input: null, inherit: false, env: null, graceMs: 5000 }, opts || {});
  return new Promise((resolve) => {
    const startedMs = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let timer = null;
    let child;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (child) active.delete(child);
      resolve(Object.assign({ code: null, signal: null, stdout, stderr, timedOut, error: null, ms: Date.now() - startedMs }, r));
    };

    const stdio = o.inherit
      ? ['ignore', 'inherit', 'inherit']
      : [o.input !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    try {
      child = spawn(process.execPath, [script].concat(args || []), {
        cwd: o.cwd,
        env: o.env ? Object.assign({}, process.env, o.env) : process.env,
        stdio,
        windowsHide: true,
      });
    } catch (e) {
      finish({ error: e.message });
      return;
    }
    active.add(child);

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, o.graceMs);
    }, o.timeoutMs);

    if (!o.inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
      if (o.input !== null) {
        child.stdin.on('error', () => {});
        child.stdin.end(o.input);
      }
    }
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

module.exports = { runNode, killAll, active };
