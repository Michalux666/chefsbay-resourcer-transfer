'use strict';
// Small helpers shared by the end-to-end rehearsal (Linux only: it reads /proc).
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 30000, pollMs = 100, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(pollMs);
  }
}

function readJson(file, fallback) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
  } catch { return fallback; }
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

function listFiles(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => !re || re.test(f)).sort();
  } catch { return []; }
}

function walk(dir, opts, out) {
  const o = opts || {};
  const acc = out || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (o.skipDir && o.skipDir(p, e)) continue;
    if (e.isDirectory()) walk(p, o, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

// Every process whose command line matches re, from /proc (the same view a person gets from ps).
function procs(re) {
  const out = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { continue; }
    if (!cmd) continue;
    let cwd = '';
    try { cwd = fs.readlinkSync('/proc/' + n + '/cwd'); } catch { /* not ours to read */ }
    if (re.test(cmd)) out.push({ pid: Number(n), cmd, cwd });
  }
  return out;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) { return e.code === 'EPERM'; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z';
  } catch { return false; }
}

function kill(pid, sig) {
  try { process.kill(pid, sig || 'SIGKILL'); return true; } catch { return false; }
}

function killGroup(pgid, sig) {
  try { process.kill(-pgid, sig || 'SIGKILL'); return true; } catch { return false; }
}

// Pids in the process tree below rootPid (including it).
function tree(rootPid) {
  const kids = new Map();
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return [rootPid]; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(n));
    } catch { /* exited */ }
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    for (const k of kids.get(p) || []) stack.push(k);
  }
  return out;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function freePort() {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

module.exports = { freePort, sleep, waitFor, readJson, readJsonl, listFiles, walk, procs, pidAlive, kill, killGroup, tree, rmrf };
