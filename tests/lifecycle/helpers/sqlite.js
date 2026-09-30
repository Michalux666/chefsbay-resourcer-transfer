'use strict';
// The driver lives in resourcer/node_modules (npm install there); tests sit outside that tree, so a bare
// require only works when NODE_PATH or a repo-level node_modules provides it.
const path = require('path');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = require(path.join(__dirname, '..', '..', '..', 'resourcer', 'node_modules', 'better-sqlite3'));
}

module.exports = Database;
