'use strict';
// Shared test helpers. Requiring this file FIRST in a test file sets up an isolated temp home and a
// fake environment (before any library reads paths or the environment) and installs the network
// guard, so no test can touch the internet, a real key, or the real workspace. Each `node --test`
// file runs in its own process, so each gets its own home.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'screening-test-'));
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* best effort: Windows may still hold a handle */ } });

for (const k of Object.keys(process.env)) if (/^SCREEN_|^AI_GATEWAY|^RESOURCER_|^HERMES_/.test(k)) delete process.env[k];
process.env.RESOURCER_HOME = HOME;
process.env.HERMES_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');
process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
process.env.SCREEN_BACKOFF_BASE_MS = '5';
process.env.SCREEN_CACHE_TTL_SEC = '0';
process.env.SCREEN_RETRY_AFTER_CAP_MS = '50';

const GUARD = path.join(REPO, 'tests', 'fake-gateway', 'fetch-guard.js');
require(GUARD);

const { startFakeGateway } = require('../fake-gateway/server');

const SCRIPTS = path.join(REPO, 'resourcer', 'scripts');
const CLI = path.join(SCRIPTS, 'ai-review.js');
const CLI_WRAPPER = path.join(SCRIPTS, 'caterer-ai-review.js');

const lib = name => path.join(SCRIPTS, 'lib', name);

async function newGateway() {
  const g = await startFakeGateway();
  process.env.SCREEN_GATEWAY_ORIGIN = g.origin;
  return g;
}

function resetHome() {
  for (const d of ['shadow', 'state', 'logs', 'runtime', 'downloads', 'config', 'outbox']) {
    fs.rmSync(path.join(HOME, d), { recursive: true, force: true });
  }
}

function baseEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^SCREEN_|^AI_GATEWAY|^RESOURCER_|^HERMES_|^NODE_OPTIONS$/.test(k)) env[k] = v;
  env.RESOURCER_HOME = HOME;
  env.HERMES_HOME = HOME;
  env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');
  env.AI_GATEWAY_API_KEY = 'fake-test-key';
  env.SCREEN_BACKOFF_BASE_MS = '5';
  env.SCREEN_CACHE_TTL_SEC = '0';
  env.SCREEN_RETRY_AFTER_CAP_MS = '50';
  env.NODE_OPTIONS = `--require ${GUARD}`;
  if (process.env.SCREEN_GATEWAY_ORIGIN) env.SCREEN_GATEWAY_ORIGIN = process.env.SCREEN_GATEWAY_ORIGIN;
  return { ...env, ...(extra || {}) };
}

// Run a script as a child process (async: the fake gateway lives in THIS process).
function runNode(script, args, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: baseEnv(o.env), cwd: o.cwd || HOME });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs || 60000);
    if (o.input !== undefined) child.stdin.end(o.input); else child.stdin.end();
    if (o.killAfterMs) setTimeout(() => child.kill('SIGKILL'), o.killAfterMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function writeCandidates(cands, name) {
  const f = path.join(HOME, name || `cands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(f, JSON.stringify(cands));
  return f;
}

async function runBatch(cands, opts) {
  const o = opts || {};
  const f = writeCandidates(cands);
  const args = ['--mode', 'batch', '--job', o.job || 'Chef', '--location', o.location || 'M1', '--distance', String(o.distance || 20), '--candidates-file', f, ...(o.extraArgs || [])];
  return runNode(o.script || CLI, args, o);
}

async function runSingle(snippet, opts) {
  const o = opts || {};
  const args = ['--mode', 'single', '--job', o.job || 'Chef', '--title', o.title === undefined ? 'Sous Chef' : o.title, '--snippet', snippet, ...(o.extraArgs || [])];
  return runNode(o.script || CLI, args, o);
}

function card(title, extra, opts) {
  const o = opts || {};
  return `${o.rank || 1}. ${o.name || 'ZZTESTNAME'} ${o.surname || 'Smithson'} ${title} | Leeds, ${o.postcode || 'ZZ1 1ZZ'} Unlock candidate 3 applications in last 30 days Updated 5 days ago Never unlocked Recent experience Other CV snippets ${title} Jan 2021 - Current Test Kitchen Ltd Key Responsibilities cooking prep service ${extra || ''}`.trim();
}

function readShadow() {
  const dir = path.join(HOME, 'shadow');
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^screening-.*\.jsonl$/.test(n)); } catch (e) { return rows; }
  for (const n of names) for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
  return rows;
}

function walk(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function writeConfig(obj) {
  const f = path.join(HOME, 'screening-test-config.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

// a tiny seeded PRNG for deterministic sampling tests
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

module.exports = {
  REPO, HOME, SCRIPTS, CLI, CLI_WRAPPER, GUARD, lib, newGateway, resetHome, baseEnv, runNode, runBatch, runSingle,
  writeCandidates, card, readShadow, walk, writeConfig, seeded,
};
