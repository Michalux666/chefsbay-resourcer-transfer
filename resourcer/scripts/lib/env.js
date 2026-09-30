'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|COOKIE)/i;

function candidateEnvFiles() {
  const files = [];
  if (process.env.RESOURCER_ENV_FILE) files.push(process.env.RESOURCER_ENV_FILE);
  const profileHome = process.env.HERMES_HOME || path.resolve(paths.HOME, '..', '..');
  files.push(path.join(profileHome, '.env'));
  files.push(path.join(paths.HOME, '.env'));
  return files;
}

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

const fileVars = {};
let loadedFrom = [];
for (const f of candidateEnvFiles().reverse()) {
  try {
    Object.assign(fileVars, parseEnv(fs.readFileSync(f, 'utf8')));
    loadedFrom.push(f);
  } catch {}
}

function get(name, fallback) {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  if (fileVars[name] !== undefined && fileVars[name] !== '') return fileVars[name];
  return fallback;
}

function has(name) {
  return get(name) !== undefined;
}

function require_(name) {
  const v = get(name);
  if (v === undefined) throw new Error(`Missing required setting ${name}`);
  return v;
}

// The credential files in secrets/ (Caterer, Zoho, Reed) hold secrets the environment does not know about; a server that
// echoes a request back in an error must not get them into a log. Read lazily, at most every 30 s (tokens are rotated).
let credCache = { at: 0, key: null, vals: [] };
function credentialFileValues() {
  const now = Date.now();
  let key = null;
  try { key = fs.statSync(paths.SECRETS).mtimeMs; } catch { key = null; }
  if (now - credCache.at < 30000 && key === credCache.key) return credCache.vals;
  const vals = [];
  try {
    for (const f of fs.readdirSync(paths.SECRETS)) {
      if (!f.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(paths.SECRETS, f), 'utf8')); } catch { continue; }
      for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
        if (SECRET_NAME_RE.test(k) && typeof v === 'string' && v.length >= 6) vals.push(v);
      }
    }
  } catch { /* no secrets directory yet */ }
  credCache = { at: now, key, vals };
  return vals;
}

function secretValues() {
  const vals = new Set();
  for (const src of [process.env, fileVars]) {
    for (const [k, v] of Object.entries(src)) {
      if (SECRET_NAME_RE.test(k) && typeof v === 'string' && v.length >= 6) vals.add(v);
    }
  }
  for (const v of credentialFileValues()) vals.add(v);
  return [...vals];
}

function redact(text) {
  let s = String(text);
  for (const v of secretValues()) s = s.split(v).join('***');
  return s;
}

module.exports = { get, has, require: require_, redact, secretValues, parseEnv, loadedFrom: () => loadedFrom.slice() };
