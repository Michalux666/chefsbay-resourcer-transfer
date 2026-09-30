'use strict';
const fs = require('fs');
const env = require('../lib/env');
const { londonParts } = require('../lib/time');

const pad2 = (n) => String(n).padStart(2, '0');

function makeOut(write) {
  const w = write || ((s) => { try { process.stdout.write(s); } catch (e) { /* closed pipe */ } });
  return (line) => w(String(line === undefined ? '' : line) + '\n');
}

// London wall clock HH:mm:ss for banners.
function clockLondon(date) {
  const p = londonParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

// yyyy-MM-dd-HHmmss in Europe/London: the run id suffix shared by status, queue and results files.
function runTimestamp(date) {
  const p = londonParts(date);
  return `${p.ymd}-${pad2(p.hour)}${pad2(p.minute)}${pad2(p.second)}`;
}

function todayLondon(date) {
  return londonParts(date).ymd;
}

const round1 = (x) => Math.round(x * 10) / 10;

// Trimmed, single-line, secret-redacted text for log lines built from child output or errors.
function safeText(text, max) {
  return env.redact(String(text === undefined || text === null ? '' : text)).replace(/\s+/g, ' ').trim().slice(0, max || 500);
}

// The legacy script printed booleans as True/False; keep the console lines identical.
function psBool(v) {
  return v ? 'True' : 'False';
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return `${s[0]}***${s.slice(at)}`;
}

// Outward code only (LS29 8AB -> LS29): enough to debug, not enough to identify.
function outwardCode(postcode) {
  const s = String(postcode || '').trim();
  const m = s.match(/^([A-Za-z]{1,2}\d{1,2}[A-Za-z]?)\s*\d[A-Za-z]{2}$/);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

function readJsonStrict(file) {
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

// JSON.parse messages quote the text they choked on, which here can be a candidate; keep only the kind and the position.
function parseFailure(e) {
  const at = String(e && e.message).match(/position (\d+)/);
  return `${(e && e.name) || 'Error'}${at ? ` at position ${at[1]}` : ''}`;
}

function splitLines(text) {
  return String(text || '').split('\n');
}

const truthy = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== false;

module.exports = {
  pad2, makeOut, clockLondon, runTimestamp, todayLondon, round1, safeText, psBool, maskEmail, outwardCode,
  readJsonStrict, splitLines, truthy, parseFailure,
};
