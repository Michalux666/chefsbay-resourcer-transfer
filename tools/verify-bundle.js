#!/usr/bin/env node
'use strict';
// Decrypt and check a bundle without writing anything anywhere: prints a summary of names, sizes and counts.

const path = require('path');
const fs = require('fs');
const F = require('./lib/bundle-format');

const USAGE = `Usage: node tools/verify-bundle.js [--bundle <file>] [--home <dir>] [--skip-db-check] [-h]

Authenticates every chunk, re-checks every file's sha256 and size, opens the database in memory
(PRAGMA integrity_check plus row counts against the manifest) and prints a summary. Writes nothing.

  --bundle <file>    bundle to check (default: data/resourcer-bundle.enc in this repo)
  --home <dir>       workspace whose secrets/bundle-passphrase is used (default: RESOURCER_HOME, else the resourcer/ directory of this repo)
  --skip-db-check    do not open the database (use only where better-sqlite3 is not installed)
  -h, --help         show this text

Passphrase sources, first match wins: BUNDLE_PASSPHRASE_FILE=<file>, BUNDLE_PASSPHRASE_FD=<n>,
<home>/secrets/bundle-passphrase (placed by the human; regular file, mode 0600, never printed), a hidden prompt.

Exit codes: 0 ok, 1 usage/unexpected error, 2 authentication failed, 3 bundle malformed or
truncated, 5 verification mismatch, 7 passphrase problem.`;

function parseArgs(argv) {
  const opts = { bundle: null, home: null, skipDbCheck: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('-')) throw F.usageError('unexpected argument (positional arguments are not accepted)');
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (/^--?pass/i.test(name)) {
      throw F.usageError('the passphrase is never accepted on the command line; use the prompt or BUNDLE_PASSPHRASE_FILE');
    }
    if (name === '-h' || name === '--help') opts.help = true;
    else if (name === '--skip-db-check') opts.skipDbCheck = true;
    else if (name === '--bundle' || name === '--home') {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else { i += 1; v = argv[i]; }
      if (v === undefined || v === '') throw F.usageError(`${name} needs a value`);
      opts[name.slice(2)] = v;
    } else {
      throw F.usageError(`unknown option ${name}`);
    }
  }
  return opts;
}

async function verifyBundle(opts, env, io, deps = {}) {
  const bundle = path.resolve(opts.bundle || F.defaultBundlePath());
  let st;
  try { st = fs.statSync(bundle); } catch { throw F.usageError('bundle file not found'); }
  io.log(`verify-bundle: bundle=${bundle} (${st.size} bytes)`);
  const home = path.resolve(opts.home || F.defaultHome(env));
  const passphrase = await F.acquirePassphrase({ env, io, stdin: deps.stdin, stderr: deps.stderr, defaultFile: path.join(home, 'secrets', 'bundle-passphrase') });
  let Database = null;
  if (!opts.skipDbCheck) {
    try {
      Database = F.loadSqlite([home]);
    } catch (e) {
      throw new F.BundleError(`${e.message}; or pass --skip-db-check to skip the database check`, F.EXIT.ERROR, 'ESQLITE');
    }
  }
  const res = F.checkBundleFile(bundle, { passphrase }, { Database });
  res.key.fill(0);
  const m = res.manifest;
  io.log(`bundle authenticated: id=${m.bundleId} built=${m.builtAt} host=${m.sourceHost} format=${m.formatVersion} chunks=${res.chunks}`);
  for (const w of m.warnings || []) io.warn(`bundle warning: ${w}`);
  if (m.source) io.log(`source: halt ${m.source.haltPresent ? `present${m.source.haltReason ? ` (${m.source.haltReason})` : ''}` : 'absent'}${m.source.liveOverride ? '; built with the live-run override' : ''}`);

  const groups = { n: 0, bytes: 0 };
  let total = 0;
  io.log(`files (${m.files.length}):`);
  for (const f of m.files) {
    total += f.size;
    if (f.path.startsWith('pending-searches/')) { groups.n += 1; groups.bytes += f.size; continue; }
    io.log(`  ${f.path.padEnd(46)} ${F.fmtBytes(f.size).padStart(10)}  ${f.mode}${f.secret ? '  (secret)' : ''}`);
  }
  if (groups.n) io.log(`  ${('pending-searches/ (' + groups.n + ' files)').padEnd(46)} ${F.fmtBytes(groups.bytes).padStart(10)}  0644`);
  io.log(`total payload: ${F.fmtBytes(total)}`);
  if (res.dbInfo) io.log(`candidates.db: integrity ${res.dbInfo.integrity}; ${Object.entries(res.dbInfo.tables).map(([t, c]) => `${t}=${c}`).join(' ')}`);
  if (res.dbNote) io.warn(`warning: ${res.dbNote}`);
  if (res.problems.length) throw F.verifyError(`verification failed: ${res.problems.join('; ')}`);
  io.log(`VERIFY_OK files=${m.files.length}`);
  return F.EXIT.OK;
}

function describeError(e, io) {
  if (e instanceof F.BundleError) return io.scrub(e.message);
  if (e instanceof SyntaxError) return 'unexpected error (SyntaxError)';
  return io.scrub(`unexpected error (${(e && (e.code || e.name)) || 'unknown'}): ${(e && e.message) || ''}`);
}

async function run(argv, env = process.env, streams = {}) {
  const io = F.createOutput(streams);
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.log(USAGE); return F.EXIT.OK; }
    return await verifyBundle(opts, env, io, { stdin: streams.stdin || F.terminalStdin(), stderr: streams.stderr || process.stderr });
  } catch (e) {
    io.warn(`VERIFY_FAILED ${describeError(e, io)}`);
    return e instanceof F.BundleError ? e.exitCode : F.EXIT.ERROR;
  }
}

module.exports = { run, parseArgs, verifyBundle };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
