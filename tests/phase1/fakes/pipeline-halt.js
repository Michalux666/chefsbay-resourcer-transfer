'use strict';
// Fake lib/pipeline-halt: records the call and writes the same state file shape as the real module.
const fs = require('fs');
const path = require('path');
const { logCall } = require('./common');

function setHalt(reason, detail, opts) {
  logCall('pipeline-halt', { reason, detail, opts });
  if (process.env.P1_HALT_THROWS === '1') throw new Error('halt module exploded');
  const home = process.env.P1_HOME;
  const file = path.join(home, 'runtime', 'pipeline-halt.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = { halted: true, reason, detail: String(detail || ''), since: new Date().toISOString(), blockedRuns: opts && opts.blockedRun ? 1 : 0, remedy: (opts && opts.remedy) || null };
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}

module.exports = { setHalt, getHalt: () => null, clearHalt: () => null };
