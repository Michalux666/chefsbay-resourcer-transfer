#!/usr/bin/env node
/**
 * pipeline-halt-cli.js - thin CLI over lib/pipeline-halt.js so the phase1 runner (and an
 * operator) can raise/clear the halt too.
 *
 * Usage:
 *   node scripts/pipeline-halt-cli.js set "<reason>" "<detail>" ["<remedy>"]
 *   node scripts/pipeline-halt-cli.js clear
 *   node scripts/pipeline-halt-cli.js get          # prints JSON, exit 1 if halted
 *
 * Exit codes: set 0 (2 on missing reason), clear 0, get 1 if halted else 0.
 */
'use strict';

const { getHalt, setHalt, clearHalt } = require('./lib/pipeline-halt');

const USAGE = `Usage:
  node scripts/pipeline-halt-cli.js set "<reason>" "<detail>" ["<remedy>"]
  node scripts/pipeline-halt-cli.js clear
  node scripts/pipeline-halt-cli.js get          (prints JSON, exit 1 if halted)`;

function main(argv) {
  const [cmd, a, b, c] = argv;

  switch (cmd) {
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    case 'set': {
      if (!a) { console.error('Usage: pipeline-halt-cli.js set "<reason>" "<detail>" ["<remedy>"]'); return 2; }
      const s = setHalt(a, b || '', { remedy: c || null, blockedRun: true });
      console.log(`HALTED: ${s.reason}`);
      return 0;
    }
    case 'clear': {
      const prev = clearHalt();
      console.log(prev ? `CLEARED: ${prev.reason}` : 'NOT_HALTED');
      return 0;
    }
    case 'get':
    default: {
      const h = getHalt();
      console.log(JSON.stringify(h || { halted: false }));
      return h && h.halted ? 1 : 0;
    }
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
