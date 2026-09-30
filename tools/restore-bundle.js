#!/usr/bin/env node
'use strict';
// Restore data/resourcer-bundle.enc into RESOURCER_HOME on the instance.
// Authenticates the whole bundle before writing anything, stages, verifies, then moves into place.
// Prints only file names, sizes and counts. See docs/parity/bundle.md.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const F = require('./lib/bundle-format');

const USAGE = `Usage: node tools/restore-bundle.js [options]

Options:
  --bundle <file>   bundle to restore (default: data/resourcer-bundle.enc in this repo)
  --home <dir>      target workspace (default: RESOURCER_HOME, else the resourcer/ directory of this repo)
  --dry-run         authenticate the bundle and print the plan; write nothing
  --force           overwrite a NEWER candidates.db, or restore while a run looks live (copies are kept)
  --no-overwrite    never replace an existing file that differs from the bundle
  --replace-secrets replace secrets/*-credentials.json even when they differ (default: an existing secret that
                    differs is kept, because credentials are rotated on the instance, not through the bundle)
  --skip-migrate    do not call scripts/migrate-schema.js afterwards
  --save-passphrase HUMAN ONLY, needs a real terminal: ask twice (hidden) and store the passphrase as
                    <home>/secrets/bundle-passphrase (mode 0600); overwrites only with --force; restores nothing
  -h, --help        show this text

A pending search restored earlier by this same bundle and consumed since is not recreated on a re-run
(delete state/bundle-restored.json to bring it back).

Passphrase sources, first match wins: BUNDLE_PASSPHRASE_FILE=<file>, BUNDLE_PASSPHRASE_FD=<n>,
<home>/secrets/bundle-passphrase (placed by the human; must be a regular file with mode 0600, refused otherwise;
never printed; remove it with rm once the restore succeeded), a hidden prompt on a real terminal.

Exit codes: 0 ok, 1 usage/unexpected error, 2 authentication failed, 3 bundle malformed or
truncated, 4 refused (newer database, live run, blocked destination), 5 verification mismatch,
6 migrate-schema failed, 7 passphrase problem.`;

function parseArgs(argv) {
  const opts = { bundle: null, home: null, dryRun: false, force: false, noOverwrite: false, replaceSecrets: false, savePassphrase: false, skipMigrate: false, help: false };
  const values = { '--bundle': 'bundle', '--home': 'home' };
  const flags = { '--dry-run': 'dryRun', '--force': 'force', '--no-overwrite': 'noOverwrite', '--replace-secrets': 'replaceSecrets', '--save-passphrase': 'savePassphrase', '--skip-migrate': 'skipMigrate', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('-')) throw F.usageError('unexpected argument (positional arguments are not accepted)');
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (/^--?pass/i.test(name)) {
      throw F.usageError('the passphrase is never accepted on the command line; use the prompt or BUNDLE_PASSPHRASE_FILE');
    }
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      if (eq > 0) throw F.usageError(`${name} takes no value`);
      opts[flags[name]] = true;
    } else if (Object.prototype.hasOwnProperty.call(values, name)) {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else { i += 1; v = argv[i]; }
      if (v === undefined || v === '') throw F.usageError(`${name} needs a value`);
      opts[values[name]] = v;
    } else {
      throw F.usageError(`unknown option ${name}`);
    }
  }
  return opts;
}

const isPosix = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// Planning (read-only)

// Directories under home that this tool writes through; a link there would redirect credentials elsewhere.
function checkAncestors(home, names, refusals) {
  const bad = new Set();
  for (const name of names) {
    let st = null;
    try { st = fs.lstatSync(path.join(home, name)); } catch (e) {
      if (e.code === 'ENOENT') continue;
      refusals.push(`${name}/: cannot inspect the directory (${e.code || 'error'})`);
      bad.add(name);
      continue;
    }
    if (st.isSymbolicLink()) { refusals.push(`${name}/: is a symbolic link; refusing to write through it`); bad.add(name); }
    else if (!st.isDirectory()) { refusals.push(`${name}: exists and is not a directory`); bad.add(name); }
  }
  return bad;
}

function planRestore(manifest, home, Database, opts, prior) {
  const items = [];
  const priorPaths = prior && prior.bundleId === manifest.bundleId && Array.isArray(prior.files) ? new Set(prior.files.map((f) => f && f.path)) : new Set();
  const refusals = [];
  const tops = new Set(['state', 'backups']);
  for (const entry of manifest.files) if (entry.path.includes('/')) tops.add(entry.path.split('/')[0]);
  const badTops = checkAncestors(home, [...tops], refusals);
  for (const entry of manifest.files) {
    const dest = F.relPathToFs(home, entry.path);
    const item = { entry, dest, action: 'create', note: '', equivalent: false };
    let st = null;
    if (entry.path.includes('/') && badTops.has(entry.path.split('/')[0])) {
      item.action = 'blocked';
      items.push(item);
      continue;
    }
    try {
      st = fs.lstatSync(dest);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        refusals.push(`${entry.path}: cannot inspect the destination (${e.code || 'error'})`);
        item.action = 'blocked';
      }
    }
    if (!st && item.action !== 'blocked' && entry.kind === 'pending' && priorPaths.has(entry.path)) {
      item.action = 'skip';
      item.note = 'restored earlier, since consumed';
    }
    if (st && item.action !== 'blocked') {
      if (!st.isFile()) {
        refusals.push(`${entry.path}: the destination exists and is not a regular file`);
        item.action = 'blocked';
      } else {
        const cur = F.hashFile(dest);
        if (cur.sha256 === entry.sha256 && cur.size === entry.size) {
          item.action = 'unchanged';
        } else if (opts.noOverwrite) {
          item.action = 'keep';
          item.note = 'existing file kept (--no-overwrite)';
        } else if (entry.kind === 'secret' && !opts.replaceSecrets) {
          item.action = 'keep';
          item.note = 'existing secret differs; kept (rotate on the instance, or use --replace-secrets)';
        } else if (entry.kind === 'pending') {
          item.action = 'keep';
          item.note = 'existing pending search differs; kept (it may already be claimed)';
        } else if (entry.kind !== 'db') {
          item.action = 'replace';
        } else {
          let info = null;
          try { info = F.inspectDatabase(Database, { file: dest }); } catch { info = null; }
          if (!info) {
            item.action = 'replace';
            item.note = 'existing database could not be read';
            if (!opts.force) {
              refusals.push('candidates.db: the existing database cannot be read; use --force to replace it (a copy is kept)');
              item.action = 'blocked';
            }
          } else {
            const cmp = F.compareDatabases(info, manifest.db);
            if (cmp.newer && !opts.force) {
              refusals.push(`candidates.db: the existing database is NEWER than the bundle (${cmp.reasons.join('; ')}); use --force to overwrite it (a copy is kept)`);
              item.action = 'blocked';
            } else if (cmp.equivalent && !opts.force) {
              item.action = 'unchanged';
              item.equivalent = true;
              item.note = 'data-equivalent to the bundle';
            } else {
              item.action = 'replace';
              item.note = cmp.newer ? 'FORCED over newer data' : 'older than the bundle';
            }
          }
        }
      }
    }
    items.push(item);
  }
  return { items, refusals };
}

function printPlan(io, items, home) {
  io.log(`plan for ${home}:`);
  const groups = new Map();
  for (const it of items) {
    if (it.entry.path.startsWith('pending-searches/')) {
      const key = it.action;
      const g = groups.get(key) || { n: 0, bytes: 0 };
      g.n += 1;
      g.bytes += it.entry.size;
      groups.set(key, g);
      continue;
    }
    io.log(`  ${it.action.padEnd(9)} ${it.entry.path.padEnd(46)} ${F.fmtBytes(it.entry.size).padStart(10)}${it.note ? `  (${it.note})` : ''}`);
  }
  for (const [action, g] of groups) io.log(`  ${action.padEnd(9)} ${('pending-searches/ (' + g.n + ' files)').padEnd(46)} ${F.fmtBytes(g.bytes).padStart(10)}`);
}

// ---------------------------------------------------------------------------
// Execution helpers

function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = F.readJsonSafe(file);
      const pid = cur.ok && cur.value ? cur.value.pid : null;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone */ }
      if (F.pidAlive(pid) && age < 2 * 3600 * 1000) throw F.refusedError('another restore-bundle run is in progress (lock file present)');
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
  throw F.refusedError('could not take the restore lock');
}

function removeStaleStaging(home) {
  let names = [];
  try { names = fs.readdirSync(home); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.bundle-staging-')) {
      try { fs.rmSync(path.join(home, n), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function stagingSink(staging, entry) {
  const dest = F.relPathToFs(staging, entry.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const mode = F.stringToMode(entry.mode);
  const fd = fs.openSync(dest, 'wx', mode);
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* ignore */ } } };
  return {
    write(buf) { F.writeAll(fd, buf); },
    end() {
      fs.fsyncSync(fd);
      if (isPosix) fs.fchmodSync(fd, mode);
      close();
    },
    abort() {
      close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    },
  };
}

async function backupExisting(Database, dest, backupDest, isDb) {
  fs.mkdirSync(path.dirname(backupDest), { recursive: true, mode: 0o700 });
  if (isDb && Database) {
    try {
      const src = new Database(dest, { readonly: true, fileMustExist: true, timeout: 30000 });
      try { await src.backup(backupDest); } finally { src.close(); }
      if (isPosix) fs.chmodSync(backupDest, 0o600);
      return;
    } catch {
      try { fs.rmSync(backupDest, { force: true }); } catch { /* ignore */ }
    }
  }
  fs.copyFileSync(dest, backupDest);
  if (isPosix) fs.chmodSync(backupDest, 0o600);
  if (isDb) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(dest + suffix)) fs.copyFileSync(dest + suffix, backupDest + suffix);
    }
  }
}

function ensureDirFor(home, rel) {
  const top = rel.includes('/') ? rel.split('/')[0] : null;
  if (!top) return;
  const dir = path.join(home, top);
  const mode = F.DIR_MODES[top] === undefined ? 0o755 : F.DIR_MODES[top];
  fs.mkdirSync(dir, { recursive: true, mode });
  if (isPosix && top === 'secrets') fs.chmodSync(dir, 0o700);
}

function writeJsonAtomicLocal(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function verifyDatabase(Database, file, manifestDb, onlyDataTables) {
  const problems = [];
  let info;
  try {
    info = F.inspectDatabase(Database, { file });
  } catch (e) {
    throw F.verifyError(`candidates.db could not be opened for verification (${(e && e.code) || 'error'})`);
  }
  if (info.integrity !== 'ok') problems.push(`candidates.db: PRAGMA integrity_check ${info.integrity}`);
  const expected = manifestDb.tables;
  const names = onlyDataTables ? F.DATA_TABLES.filter((t) => t in expected || t in info.tables) : Object.keys(expected);
  for (const t of names) {
    const want = expected[t] || 0;
    const got = info.tables[t] || 0;
    if (want !== got) problems.push(`candidates.db: table ${t} has ${got} rows, the manifest says ${want}`);
  }
  return { info, problems };
}

function runMigrate(home, env, io) {
  const script = path.join(home, 'scripts', 'migrate-schema.js');
  if (!fs.existsSync(script)) {
    io.warn('warning: scripts/migrate-schema.js not found; schema migration skipped (run it before starting the pipeline)');
    return;
  }
  const childEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('BUNDLE_')) childEnv[k] = v;
  childEnv.RESOURCER_HOME = home;
  const r = childProcess.spawnSync(process.execPath, [script], { cwd: home, env: childEnv, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    const tail = `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).filter(Boolean).slice(-8).join(' | ').slice(0, 800);
    throw new F.BundleError(`scripts/migrate-schema.js failed (exit ${r.status === null ? 'none' : r.status}${r.error ? `, ${r.error.code || 'spawn error'}` : ''})${tail ? `: ${tail}` : ''}`, F.EXIT.MIGRATE, 'EMIGRATE');
  }
  io.log('migrate-schema: ok');
}

// ---------------------------------------------------------------------------

async function restoreBundle(opts, env, io, deps = {}) {
  const bundle = path.resolve(opts.bundle || F.defaultBundlePath());
  const home = path.resolve(opts.home || F.defaultHome(env));
  let st;
  try { st = fs.statSync(bundle); } catch { throw F.usageError('bundle file not found'); }
  io.log(`restore-bundle: bundle=${bundle} (${st.size} bytes) home=${home}${opts.dryRun ? ' [dry-run]' : ''}`);

  let passphraseSource = null;
  const passphrase = await F.acquirePassphrase({
    env, io, stdin: deps.stdin, stderr: deps.stderr,
    defaultFile: path.join(home, 'secrets', 'bundle-passphrase'),
    onSource: (kind) => { passphraseSource = kind; },
  });
  const key = F.bundleKey(bundle, passphrase);
  let staging = null;
  let lockFile = null;
  try {
    // Pass 1: authenticate every chunk and check every file hash. Nothing is written anywhere.
    const p1 = F.scanBundle(bundle, { key });
    const manifest = p1.manifest;
    const dbFiles = manifest.files.filter((f) => f.kind === 'db');
    io.log(`bundle authenticated: id=${manifest.bundleId} built=${manifest.builtAt} host=${manifest.sourceHost} files=${manifest.files.length} chunks=${p1.chunks}`);
    for (const w of manifest.warnings || []) io.warn(`bundle warning: ${w}`);

    const Database = dbFiles.length ? F.loadSqlite([home]) : null;
    const prior = F.readJsonSafe(path.join(home, 'state', 'bundle-restored.json'));
    const { items, refusals } = planRestore(manifest, home, Database, opts, prior.ok ? prior.value : null);
    printPlan(io, items, home);

    const live = F.checkPipelineLive(home);
    io.log(`pipeline check on target: ${live.live ? 'LIVE' : 'no live run'}`);
    if (live.live) {
      for (const r of live.reasons) io.warn(`  live: ${r}`);
      if (!opts.force) refusals.push('a pipeline run looks live in the target workspace; stop it first (or use --force)');
    }
    if (refusals.length) {
      for (const r of refusals) io.warn(`refused: ${r}`);
      throw F.refusedError(`restore refused (${refusals.length} problem(s)); nothing was written`);
    }
    if (opts.dryRun) {
      io.log('DRY_RUN_OK nothing was written');
      return F.EXIT.OK;
    }

    fs.mkdirSync(home, { recursive: true });
    const wantedLock = path.join(home, '.bundle-restore.lock');
    acquireLock(wantedLock);
    lockFile = wantedLock;
    removeStaleStaging(home);
    staging = path.join(home, `.bundle-staging-${process.pid}`);
    fs.mkdirSync(staging, { mode: 0o700 });

    // Pass 2: extract the files that need to change into the staging directory.
    const byPath = new Map(items.map((i) => [i.entry.path, i]));
    const needs = (i) => i.action === 'create' || i.action === 'replace';
    F.scanBundle(bundle, { key }, {
      onManifest(m) {
        if (m.bundleId !== manifest.bundleId || JSON.stringify(m.files) !== JSON.stringify(manifest.files)) {
          throw F.verifyError('the bundle changed while it was being restored');
        }
      },
      sink(entry) {
        const it = byPath.get(entry.path);
        return it && needs(it) ? stagingSink(staging, entry) : null;
      },
    });

    const stagedDb = items.find((i) => i.entry.kind === 'db' && needs(i));
    if (stagedDb) {
      const { problems } = verifyDatabase(Database, F.relPathToFs(staging, 'candidates.db'), manifest.db, false);
      if (problems.length) throw F.verifyError(`staged database failed verification (${problems.join('; ')}); nothing was moved`);
    }

    // Keep a timestamped copy of everything that is about to be replaced.
    const stamp = F.utcStamp();
    const backupRoot = path.join(home, 'backups', `bundle-restore-${stamp}`);
    const replaced = items.filter((i) => i.action === 'replace');
    for (const it of replaced) {
      await backupExisting(Database, it.dest, F.relPathToFs(backupRoot, it.entry.path), it.entry.kind === 'db');
    }
    if (replaced.length) io.log(`copies of ${replaced.length} replaced file(s) kept in ${path.join('backups', `bundle-restore-${stamp}`)}`);

    // Move into place; the database goes last so an interrupted run leaves the old one intact.
    const order = items.slice().sort((a, b) => (a.entry.kind === 'db') - (b.entry.kind === 'db') || (a.entry.path < b.entry.path ? -1 : 1));
    for (const it of order) {
      if (it.action === 'skip') continue;
      ensureDirFor(home, it.entry.path);
      if (needs(it)) {
        if (it.entry.kind === 'db') {
          for (const suffix of ['-wal', '-shm', '-journal']) { try { fs.unlinkSync(it.dest + suffix); } catch { /* absent */ } }
        }
        fs.renameSync(F.relPathToFs(staging, it.entry.path), it.dest);
      } else if ((it.action === 'unchanged' || (it.action === 'keep' && it.entry.kind === 'secret')) && isPosix && it.entry.kind !== 'db') {
        const want = F.stringToMode(it.entry.mode);
        if ((fs.statSync(it.dest).mode & 0o777) !== want) fs.chmodSync(it.dest, want);
      }
    }
    for (const d of manifest.dirs || []) {
      if (isPosix && d.path === 'secrets' && fs.existsSync(path.join(home, 'secrets'))) fs.chmodSync(path.join(home, 'secrets'), 0o700);
    }

    // Verify what is now on disk, not what was staged.
    const problems = [];
    for (const it of items) {
      if (it.action === 'keep' || it.action === 'skip') continue;
      if (it.entry.kind === 'db') {
        const equivalentOnly = it.equivalent;
        if (!equivalentOnly) {
          const cur = F.hashFile(it.dest);
          if (cur.sha256 !== it.entry.sha256 || cur.size !== it.entry.size) problems.push('candidates.db: sha256 does not match the manifest');
        }
        for (const p of verifyDatabase(Database, it.dest, manifest.db, equivalentOnly).problems) problems.push(p);
        if (isPosix && !equivalentOnly && (fs.statSync(it.dest).mode & 0o777) !== F.stringToMode(it.entry.mode)) problems.push('candidates.db: file mode differs from the manifest');
        continue;
      }
      const cur = F.hashFile(it.dest);
      if (cur.sha256 !== it.entry.sha256 || cur.size !== it.entry.size) problems.push(`${it.entry.path}: sha256 does not match the manifest`);
      if (isPosix && (fs.statSync(it.dest).mode & 0o777) !== F.stringToMode(it.entry.mode)) problems.push(`${it.entry.path}: file mode differs from the manifest`);
    }
    if (isPosix && fs.existsSync(path.join(home, 'secrets')) && (fs.statSync(path.join(home, 'secrets')).mode & 0o777) !== 0o700) problems.push('secrets/: directory mode is not 0700');
    if (problems.length) throw F.verifyError(`verification failed: ${problems.join('; ')}`);
    io.log(`verified: ${items.filter((i) => i.action !== 'keep').length} file(s) match the manifest${isPosix ? ' (sha256, modes)' : ' (sha256; modes not checked on this platform)'}`);
    if (dbFiles.length) {
      const info = F.inspectDatabase(Database, { file: path.join(home, 'candidates.db') });
      io.log(`candidates.db: integrity ${info.integrity}; ${Object.entries(info.tables).map(([t, c]) => `${t}=${c}`).join(' ')}`);
    }

    if (!opts.skipMigrate) {
      runMigrate(home, env, io);
      const dbItem = items.find((i) => i.entry.kind === 'db');
      if (dbItem && dbItem.action !== 'keep') {
        const after = verifyDatabase(Database, path.join(home, 'candidates.db'), manifest.db, dbItem.equivalent);
        if (after.problems.length) throw F.verifyError(`the database changed unexpectedly during migration (${after.problems.join('; ')})`);
      }
    }

    writeJsonAtomicLocal(path.join(home, 'state', 'bundle-restored.json'), {
      bundleId: manifest.bundleId,
      builtAt: manifest.builtAt,
      sourceHost: manifest.sourceHost,
      restoredAt: new Date().toISOString(),
      files: items.map((i) => ({ path: i.entry.path, size: i.entry.size, action: i.action })),
      db: manifest.db || null,
    });

    const count = (a) => items.filter((i) => i.action === a).length;
    if (passphraseSource === 'default-file') io.log(`passphrase came from ${F.DEFAULT_PASSPHRASE_REL}; remove it now: rm ${path.join(home, 'secrets', 'bundle-passphrase')}`);
    io.log(`RESTORE_OK files=${items.length} created=${count('create')} replaced=${count('replace')} unchanged=${count('unchanged')} kept=${count('keep')} skipped=${count('skip')}`);
    return F.EXIT.OK;
  } finally {
    key.fill(0);
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (lockFile) { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } }
  }
}

function describeError(e, io) {
  if (e instanceof F.BundleError) return io.scrub(e.message);
  if (e instanceof SyntaxError) return 'unexpected error (SyntaxError)';
  return io.scrub(`unexpected error (${(e && (e.code || e.name)) || 'unknown'}): ${(e && e.message) || ''}`);
}

// The one place a person types the passphrase for the instance. It needs a real terminal, so a tool-driven
// operator (no terminal) cannot run it and never sees the value.
async function savePassphrase(opts, env, io, deps) {
  const home = path.resolve(opts.home || F.defaultHome(env));
  const dir = path.join(home, 'secrets');
  const file = path.join(dir, 'bundle-passphrase');
  if (!deps.stdin || !deps.stdin.isTTY) {
    throw F.passphraseError('--save-passphrase needs a real terminal: a person types the passphrase, it is never taken from a file or the command line');
  }
  let existing = null;
  try { existing = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing && !opts.force) throw F.refusedError(`${F.DEFAULT_PASSPHRASE_REL} already exists; use --force to replace it`);
  if (existing && !existing.isFile()) throw F.refusedError(`${F.DEFAULT_PASSPHRASE_REL} is not a regular file`);
  let dst = null;
  try { dst = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (dst && (dst.isSymbolicLink() || !dst.isDirectory())) throw F.refusedError('secrets/ must be a real directory');
  const pass = await F.acquirePassphrase({ env: {}, io, confirm: true, minLength: F.MIN_PASSPHRASE, stdin: deps.stdin, stderr: deps.stderr });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isPosix) fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pass + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  io.log(`PASSPHRASE_SAVED ${F.DEFAULT_PASSPHRASE_REL} (mode 0600); restore-bundle reads it automatically, remove it with rm after the restore`);
  return F.EXIT.OK;
}

async function run(argv, env = process.env, streams = {}) {
  const io = F.createOutput(streams);
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.log(USAGE); return F.EXIT.OK; }
    if (opts.savePassphrase) return await savePassphrase(opts, env, io, { stdin: streams.stdin || F.terminalStdin(), stderr: streams.stderr || process.stderr });
    return await restoreBundle(opts, env, io, { stdin: streams.stdin || F.terminalStdin(), stderr: streams.stderr || process.stderr });
  } catch (e) {
    io.warn(`RESTORE_FAILED ${describeError(e, io)}`);
    return e instanceof F.BundleError ? e.exitCode : F.EXIT.ERROR;
  }
}

module.exports = { run, parseArgs, restoreBundle, planRestore };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
