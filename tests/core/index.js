'use strict';
// `node --test tests/core` hands this directory to Node as a module (a directory is not a test
// file). Run the real suite from here so that documented command works on Node 22 and later.
// Equivalent explicit form: node --test tests/core/*.test.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(__dirname, f));
// The outer runner marks its children; without clearing the marker the inner run is skipped.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exitCode = r.status === null ? 1 : r.status;
