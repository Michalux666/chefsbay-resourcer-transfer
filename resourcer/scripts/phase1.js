#!/usr/bin/env node
'use strict';
// Phase 1 of the Caterer pipeline: scrape results, dedupe, screen, unlock, queue, hand off.
// Node port of the legacy phase-1 script; see docs/parity/phase1.md.
const { main, installSignalHandlers } = require('./phase1/run');

if (require.main === module) {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  installSignalHandlers();
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Safety net: an unref'd timer cannot keep the process alive, but forces exit if a stray handle would.
    setTimeout(() => process.exit(code), 3000).unref();
  });
}

module.exports = { main };
