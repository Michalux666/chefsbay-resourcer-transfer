'use strict';
// Shared helpers for the phase-1 fakes: scenario loading, per-tool state and a call log.
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.P1_STATE_DIR || path.join(__dirname, '_state');

function scenario() {
  try { return JSON.parse(fs.readFileSync(process.env.P1_SCENARIO, 'utf8')); } catch (e) { return {}; }
}

function stateFile(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, name);
}

function readState(name, init) {
  try { return JSON.parse(fs.readFileSync(stateFile(name), 'utf8')); } catch (e) { return init; }
}

function writeState(name, obj) {
  fs.writeFileSync(stateFile(name), JSON.stringify(obj));
}

function logCall(tool, rec) {
  fs.appendFileSync(stateFile('calls.jsonl'), JSON.stringify(Object.assign({ tool, at: Date.now() }, rec)) + '\n');
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ai-review style parser: --key value, or true when the value is missing or starts with "--".
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

module.exports = { scenario, readState, writeState, logCall, sleepMs, parseFlags, STATE_DIR, stateFile };
