'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode: mode || 0o755 });
  return dir;
}

function writeFileAtomic(file, data, mode) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, obj, mode) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2), mode);
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const raw = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, String(line).replace(/\r?\n/g, ' ') + '\n');
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { ensureDir, writeFileAtomic, writeJsonAtomic, readJson, appendLine, safeUnlink, sha256File, sleep, pidAlive };
