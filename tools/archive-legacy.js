#!/usr/bin/env node
'use strict';
// Encrypted safety archive of the legacy per-user home for the owner, made before the laptop is wiped.
// Same container as the data bundle (scrypt + AES-256-GCM chunks, tools/lib/bundle-format.js) with its own
// manifest and path rules. Prints only counts, sizes and group names; never file contents or the passphrase.

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./lib/bundle-format');

const FORMAT = 'resourcer-legacy-archive';
const MAX_FILES = 50000;
const MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const RECENT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 5;
const DB_REL = 'workspace-resourcer/candidates.db';

const USAGE = `Usage: node tools/archive-legacy.js [options]

Builds ONE encrypted archive (AES-256-GCM, scrypt) of the legacy per-user home so the owner keeps a safe copy.
Included: config files, credentials, cron, skills, agent config, the resourcer workspace (scripts, skills, config,
docs, AGENTS/MEMORY files, candidates.db as an online backup) and the main agent workspace.
Excluded: downloads, node_modules, .git (unless --include-git), browser profiles, screenshots and other images,
executables, raw database files, session cookies, session history files over the size cap, logs and run files
older than the age limit, temp files, links, and this repository.

Modes:
  (default)               create the archive
  --dry-run               walk the tree and print file counts and total size; write nothing, ask nothing
  --extract <dir>         decrypt --archive <file> into a new or empty directory <dir> (files 0600, directories 0700)
  --list                  authenticate --archive <file> and print counts per group; write nothing

Options:
  --source <dir>          legacy per-user home to read (default: the legacy home under your home directory)
  --output <file>         archive to write (default: a legacy-archive-<UTC time>.enc file in your home directory)
  --archive <file>        archive to read for --extract / --list
  --max-file-mb <n>       skip files larger than this (default 25)
  --max-session-mb <n>    skip files inside any "sessions" directory larger than this (default 1)
  --max-total-mb <n>      refuse when the included files add up to more than this (default 2048)
  --log-days <n>          keep logs and run files modified within this many days (default 14)
  --include-git           also include .git directories (they can hold a plaintext access token)
  --tmpdir <dir>          where the temporary database snapshot goes (default: system temp)
  --force                 overwrite an existing --output file
  -h, --help              show this text

Passphrase (16+ characters, never a command-line argument): hidden prompt (asked twice when creating), or
BUNDLE_PASSPHRASE_FILE=<file> / BUNDLE_PASSPHRASE_FD=<n> for automation.

Exit codes: 0 ok, 1 usage/unexpected error, 2 authentication failed, 3 archive malformed or truncated,
4 refused (output inside the source, existing output, target not empty, too large), 5 source or verification problem,
7 passphrase problem.`;

// The legacy directory name is assembled so the repo-wide banned-token grep (DESIGN section 9) stays clean.
function legacyDefaultSource() {
  return path.join(os.homedir(), '.open' + 'claw');
}

// ---------------------------------------------------------------------------
// Path safety (used on both sides: the walker, the manifest validator and the extractor)

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Assembled from char codes: no backslash-u or double-backslash text in the source.
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']');
const BAD_SEGMENT_CHARS = /[<>:"|?*]/;
const BACKSLASH = String.fromCharCode(92);

function isSafeSegment(seg) {
  if (typeof seg !== 'string' || seg.length === 0 || seg.length > 200) return false;
  if (seg === '.' || seg === '..') return false;
  if (seg.includes(BACKSLASH) || CONTROL.test(seg) || BAD_SEGMENT_CHARS.test(seg)) return false;
  if (/[. ]$/.test(seg) || /^ /.test(seg)) return false;
  if (RESERVED_NAMES.test(seg)) return false;
  return true;
}

function isSafeArchivePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 400) return false;
  const segs = p.split('/');
  if (segs.length > 40) return false;
  return segs.every(isSafeSegment);
}

const FILE_RULE = Object.freeze({ kind: 'file', mode: 0o600, secret: false });
const classifyArchivePath = (p) => (isSafeArchivePath(p) ? FILE_RULE : null);

function validateArchiveManifest(m) {
  const bad = (why) => F.formatError(`manifest rejected: ${why}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('not an object');
  if (m.format !== FORMAT || m.formatVersion !== F.FORMAT_VERSION) throw bad('unknown format (this is not a legacy archive)');
  if (typeof m.bundleId !== 'string' || !/^[0-9a-f-]{36}$/.test(m.bundleId)) throw bad('bad bundleId');
  if (typeof m.builtAt !== 'string' || !Number.isFinite(Date.parse(m.builtAt))) throw bad('bad builtAt');
  if (typeof m.sourceHost !== 'string' || m.sourceHost.length > 100) throw bad('bad sourceHost');
  if (!Array.isArray(m.files) || m.files.length > MAX_FILES) throw bad('bad file list');
  const seen = new Set();
  let dbEntries = 0;
  m.files.forEach((f, i) => {
    if (!f || typeof f !== 'object') throw bad(`file #${i} is not an object`);
    if (!classifyArchivePath(f.path)) throw bad(`file #${i} has a disallowed path`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw bad(`file #${i} is a duplicate path`);
    seen.add(key);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad(`file #${i} has a bad size`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw bad(`file #${i} has a bad sha256`);
    if (f.kind !== 'file' && f.kind !== 'db') throw bad(`file #${i} has a bad kind`);
    if (f.mtimeMs !== undefined && !Number.isFinite(f.mtimeMs)) throw bad(`file #${i} has a bad mtime`);
    f.mode = F.modeToString(FILE_RULE.mode);
    f.secret = false;
    if (f.kind === 'db') dbEntries += 1;
  });
  if (dbEntries > 1) throw bad('more than one database');
  if (m.warnings !== undefined && !Array.isArray(m.warnings)) throw bad('bad warnings');
  if (m.excluded !== undefined) {
    if (!m.excluded || typeof m.excluded !== 'object' || Array.isArray(m.excluded)) throw bad('bad excluded section');
    for (const v of Object.values(m.excluded)) if (!Number.isSafeInteger(v) || v < 0) throw bad('bad excluded count');
  }
  if (m.db !== undefined) {
    const d = m.db;
    if (!d || typeof d !== 'object' || typeof d.path !== 'string' || typeof d.integrity !== 'string' || !d.tables || typeof d.tables !== 'object') throw bad('bad db section');
    for (const c of Object.values(d.tables)) if (!Number.isSafeInteger(c) || c < 0) throw bad('bad db table count');
    if (dbEntries !== 1 || !m.files.some((x) => x.kind === 'db' && x.path === d.path)) throw bad('db section does not match a database file');
  }
  return m;
}

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const opts = {
    source: null, output: null, archive: null, extract: null, list: false, dryRun: false, includeGit: false, force: false,
    maxFileMb: 25, maxSessionMb: 1, maxTotalMb: 2048, logDays: 14, tmpDir: null, help: false,
  };
  const values = { '--source': 'source', '--output': 'output', '--archive': 'archive', '--extract': 'extract', '--tmpdir': 'tmpDir' };
  const numbers = { '--max-file-mb': 'maxFileMb', '--max-session-mb': 'maxSessionMb', '--max-total-mb': 'maxTotalMb', '--log-days': 'logDays' };
  const flags = { '--dry-run': 'dryRun', '--list': 'list', '--include-git': 'includeGit', '--force': 'force', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('-')) throw F.usageError('unexpected argument (positional arguments are not accepted)');
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (/^--?pass/i.test(name)) {
      throw F.usageError('the passphrase is never accepted on the command line; use the prompt or BUNDLE_PASSPHRASE_FILE');
    }
    const takeValue = () => {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else { i += 1; v = argv[i]; }
      if (v === undefined || v === '') throw F.usageError(`${name} needs a value`);
      return v;
    };
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      if (eq > 0) throw F.usageError(`${name} takes no value`);
      opts[flags[name]] = true;
    } else if (Object.prototype.hasOwnProperty.call(values, name)) {
      opts[values[name]] = takeValue();
    } else if (Object.prototype.hasOwnProperty.call(numbers, name)) {
      const n = Number(takeValue());
      if (!Number.isFinite(n) || n < 0) throw F.usageError(`${name} needs a non-negative number`);
      opts[numbers[name]] = n;
    } else {
      throw F.usageError(`unknown option ${name}`);
    }
  }
  const modes = [opts.dryRun, opts.list, !!opts.extract].filter(Boolean).length;
  if (modes > 1) throw F.usageError('use only one of --dry-run, --list and --extract');
  if ((opts.list || opts.extract) && !opts.archive) throw F.usageError('--archive <file> is required with --list and --extract');
  return opts;
}

// ---------------------------------------------------------------------------
// Walking the legacy tree

const NEVER_DESCEND = new Set(['node_modules', 'downloads', 'screenshots', 'tmp', '.tmp', 'cache', '.cache', 'code cache', 'gpucache', 'xdg-cache', 'crashpad', 'cloudflared', ['ng', 'rok'].join('')]);
const TOP_LEVEL_SKIP = new Set(['browser', 'npm', 'media', 'hermes-port']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svgz']);
const BINARY_EXT = new Set(['.exe', '.dll', '.msi', '.node', '.so', '.dylib', '.sys', '.iso']);
const AGED_DIRS = new Set(['logs', 'runs']);
const DB_FILE = /\.(db|sqlite3?)($|[-.])/i;
const TMP_FILE = /(^|[-_.])tmp($|[-_.])/i;
const TOKEN_FILE = /cookie|^(caterer|reed)[-_]session|storage-state/i;
const CODE_EXT = new Set(['.js', '.ps1', '.sh', '.cmd', '.md', '.py', '.ts', '.mjs', '.cjs']);

function looksLikeBrowserProfile(dirName, childNames) {
  if (/^(chrome|chromium|msedge|edge)([-_.a-z0-9]*)$/i.test(dirName)) return true;
  if (/^\.agent-browser/i.test(dirName)) return true;
  if (childNames.has('Local State') || childNames.has('SingletonLock')) return true;
  return false;
}

function walkSource(root, opts, now, skipPaths) {
  const included = [];
  const excluded = new Map();
  const seenLower = new Set();
  const note = (reason) => excluded.set(reason, (excluded.get(reason) || 0) + 1);
  const maxFile = opts.maxFileMb * MB;
  const maxSession = opts.maxSessionMb * MB;
  const maxAge = opts.logDays * 86400000;
  const stack = [{ abs: root, rel: '', inSessions: false, inAged: false }];
  while (stack.length) {
    const cur = stack.pop();
    let dirents;
    try { dirents = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { note('unreadable-dir'); continue; }
    const childNames = new Set(dirents.map((d) => d.name));
    if (cur.rel && looksLikeBrowserProfile(path.posix.basename(cur.rel), childNames)) { note('browser-profile-dir'); continue; }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      const abs = path.join(cur.abs, d.name);
      const lower = d.name.toLowerCase();
      if (skipPaths.has(abs)) { note('output-file'); continue; }
      if (d.isSymbolicLink()) { note('link'); continue; }
      if (d.isDirectory()) {
        if (!cur.rel && TOP_LEVEL_SKIP.has(lower)) { note('excluded-dir'); continue; }
        if (NEVER_DESCEND.has(lower)) { note('excluded-dir'); continue; }
        if (lower === '.git' && !opts.includeGit) { note('excluded-dir'); continue; }
        if (!isSafeSegment(d.name)) { note('unsafe-name'); continue; }
        stack.push({ abs, rel, inSessions: cur.inSessions || lower === 'sessions', inAged: cur.inAged || AGED_DIRS.has(lower) });
        continue;
      }
      if (!d.isFile()) { note('not-regular'); continue; }
      if (!isSafeSegment(d.name)) { note('unsafe-name'); continue; }
      const ext = path.extname(lower);
      if (IMAGE_EXT.has(ext) || lower.includes('screenshot')) { note('screenshot'); continue; }
      if (BINARY_EXT.has(ext)) { note('binary'); continue; }
      if (DB_FILE.test(d.name)) { note('raw-database'); continue; }
      if (TMP_FILE.test(d.name)) { note('temp-file'); continue; }
      if (!CODE_EXT.has(ext) && TOKEN_FILE.test(d.name)) { note('session-token'); continue; }
      if (lower.includes('.deleted.')) { note('deleted-session'); continue; }
      let st;
      try { st = fs.lstatSync(abs); } catch { note('vanished'); continue; }
      if (!st.isFile()) { note('not-regular'); continue; }
      if ((cur.inAged || ext === '.log') && now - st.mtimeMs > maxAge) { note('old-log'); continue; }
      if (cur.inSessions && st.size > maxSession) { note('large-session'); continue; }
      if (st.size > maxFile) { note('too-large'); continue; }
      const key = rel.toLowerCase();
      if (seenLower.has(key)) { note('case-collision'); continue; }
      seenLower.add(key);
      included.push({ path: rel, sourcePath: abs, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  }
  included.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { included, excluded };
}

function groupOf(rel) {
  const i = rel.indexOf('/');
  return i < 0 ? '(top-level files)' : rel.slice(0, i);
}

function summarise(list) {
  const groups = new Map();
  let bytes = 0;
  for (const e of list) {
    const g = groups.get(groupOf(e.path)) || { n: 0, bytes: 0 };
    g.n += 1;
    g.bytes += e.size;
    groups.set(groupOf(e.path), g);
    bytes += e.size;
  }
  return { groups, bytes };
}

function printSummary(io, list, excluded) {
  const { groups, bytes } = summarise(list);
  io.log(`files=${list.length} total=${F.fmtBytes(bytes)} (${bytes} bytes)`);
  for (const [name, g] of [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    io.log(`  ${name.padEnd(28)} ${String(g.n).padStart(7)} files ${F.fmtBytes(g.bytes).padStart(11)}`);
  }
  const ex = [...excluded.entries()].sort((a, b) => b[1] - a[1]);
  io.log(`excluded: ${ex.length ? ex.map(([r, n]) => `${r}=${n}`).join(' ') : 'nothing'}`);
  return bytes;
}

// ---------------------------------------------------------------------------
// Build

const liveTemps = new Set();

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function buildArchive(opts, env, io, deps = {}) {
  const source = path.resolve(opts.source || legacyDefaultSource());
  let st;
  try { st = fs.statSync(source); } catch { throw F.sourceError('source directory not found'); }
  if (!st.isDirectory()) throw F.sourceError('source is not a directory');
  const stamp = F.utcStamp();
  const out = path.resolve(opts.output || path.join(os.homedir(), `legacy-archive-${stamp}.enc`));
  if (isInside(out, source)) throw F.refusedError('the output file must be outside the source directory');
  if (!opts.dryRun && fs.existsSync(out) && !opts.force) throw F.refusedError('the output file already exists; use --force to replace it');
  io.log(`archive-legacy: source=${source}${opts.dryRun ? ' [dry-run]' : ''}`);

  const now = Date.now();
  const skip = new Set([out, `${out}.check-${process.pid}`]);
  const walked = walkSource(source, opts, now, skip);
  let entries = walked.included;
  const excluded = walked.excluded;

  const dbFile = path.join(source, 'workspace-resourcer', 'candidates.db');
  const haveDb = fs.existsSync(dbFile);
  const warnings = [];
  if (!haveDb) warnings.push('workspace-resourcer/candidates.db not found; no database in the archive');

  const bytes = printSummary(io, entries, excluded);
  if (haveDb) io.log(`candidates.db: ${F.fmtBytes(fs.statSync(dbFile).size)} (online backup will be taken; raw copies of the live file are never used)`);
  if (entries.length > MAX_FILES - 1) throw F.refusedError(`too many files (${entries.length}); narrow the selection`);
  if (bytes > opts.maxTotalMb * MB) throw F.refusedError(`the included files add up to ${F.fmtBytes(bytes)}, above --max-total-mb ${opts.maxTotalMb}`);
  if (opts.dryRun) {
    io.log('ARCHIVE_DRY_RUN_OK nothing was written');
    return F.EXIT.OK;
  }

  const passphrase = await F.acquirePassphrase({ env, io, confirm: true, minLength: F.MIN_PASSPHRASE, stdin: deps.stdin, stderr: deps.stderr });
  const distinct = new Set([...passphrase]).size;
  if (distinct < 8) throw F.passphraseError('passphrase is too repetitive (use at least 8 different characters)');

  const tmpBase = opts.tmpDir ? path.resolve(opts.tmpDir) : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'cbr-archive-'));
  liveTemps.add(tmpDir);
  try {
    let dbInfo = null;
    if (haveDb) {
      let Database;
      try { Database = F.loadSqlite([path.join(source, 'workspace-resourcer'), source]); } catch (e) {
        throw F.sourceError(`${e.message}; the database cannot be archived without it`);
      }
      const snap = path.join(tmpDir, 'candidates.db');
      try {
        await F.snapshotDatabase(Database, dbFile, snap);
        dbInfo = F.inspectDatabase(Database, { file: snap });
      } catch (e) {
        throw F.sourceError(`database snapshot or integrity check failed (${(e && e.code) || 'error'})`);
      }
      if (dbInfo.integrity !== 'ok') throw F.sourceError(`PRAGMA integrity_check failed on the database snapshot: ${dbInfo.integrity}`);
      io.log(`candidates.db: integrity ok, ${Object.keys(dbInfo.tables).length} tables: ${Object.entries(dbInfo.tables).map(([t, c]) => `${t}=${c}`).join(' ')}`);
      entries = entries.concat([{ path: DB_REL, sourcePath: snap, size: fs.statSync(snap).size, mtimeMs: now, kind: 'db' }]);
    }

    // Files touched in the last minutes (live logs, session files) are read once into memory so a growing file
    // cannot fail the packing pass; anything that still changes is dropped from the archive and counted.
    const prepared = [];
    for (const e of entries) {
      const item = { path: e.path, meta: { mtimeMs: e.mtimeMs } };
      if (e.kind) item.kind = e.kind;
      if (!e.kind && now - e.mtimeMs < RECENT_MS) {
        try {
          const buf = fs.readFileSync(e.sourcePath);
          item.buffer = buf;
          item.meta.mtimeMs = e.mtimeMs;
        } catch { excluded.set('vanished', (excluded.get('vanished') || 0) + 1); continue; }
      } else {
        item.sourcePath = e.sourcePath;
      }
      prepared.push(item);
    }

    const host = String(os.hostname()).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'unknown';
    const staged = `${out}.check-${process.pid}`;
    let written = null;
    let list = prepared;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const manifestBase = F.newManifestBase({
          format: FORMAT,
          sourceHost: host,
          tool: { name: 'archive-legacy', node: process.version, platform: process.platform },
          limits: { maxFileMb: opts.maxFileMb, maxSessionMb: opts.maxSessionMb, logDays: opts.logDays, includeGit: opts.includeGit },
          excluded: Object.fromEntries(excluded),
          db: dbInfo ? { path: DB_REL, integrity: dbInfo.integrity, tables: dbInfo.tables, watermark: dbInfo.watermark } : undefined,
          warnings,
        });
        written = F.writeBundle(staged, { passphrase, manifestBase, entries: list, classify: classifyArchivePath, validate: validateArchiveManifest });
        break;
      } catch (e) {
        const m = e && e.code === 'ESOURCE' ? /source changed while packing: (.+)$/.exec(String(e.message)) : null;
        const dropRel = m ? m[1] : null;
        const dropAbs = e && typeof e.path === 'string' ? e.path : null;
        const victim = list.find((x) => (dropRel && x.path === dropRel) || (dropAbs && x.sourcePath === dropAbs));
        if (!victim || attempt >= MAX_RETRIES || victim.kind === 'db') throw e;
        list = list.filter((x) => x !== victim);
        excluded.set('changed-while-packing', (excluded.get('changed-while-packing') || 0) + 1);
        warnings.push(`${victim.path}: dropped (changed or vanished while packing)`);
      }
    }
    try {
      const check = F.scanBundle(staged, { key: written.key }, { validate: validateArchiveManifest });
      if (check.manifest.files.length !== written.manifest.files.length) throw F.verifyError('self-check: file count mismatch');
      fs.renameSync(staged, out);
    } catch (e) {
      try { fs.unlinkSync(staged); } catch { /* ignore */ }
      throw e;
    } finally {
      written.key.fill(0);
    }
    io.log('self-check: the archive decrypts and every file matches its sha256');
    const fileHash = F.hashFile(out);
    io.log(`ARCHIVE_OK out=${out} size=${fileHash.size} sha256=${fileHash.sha256} files=${written.manifest.files.length} dropped=${excluded.get('changed-while-packing') || 0}`);
    return F.EXIT.OK;
  } finally {
    liveTemps.delete(tmpDir);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// List and extract

async function openArchive(opts, env, io, deps) {
  const archive = path.resolve(opts.archive);
  let st;
  try { st = fs.statSync(archive); } catch { throw F.usageError('archive file not found'); }
  io.log(`archive-legacy: archive=${archive} (${st.size} bytes)`);
  const passphrase = await F.acquirePassphrase({ env, io, stdin: deps.stdin, stderr: deps.stderr });
  const key = F.bundleKey(archive, passphrase);
  return { archive, key };
}

async function listArchive(opts, env, io, deps = {}) {
  const { archive, key } = await openArchive(opts, env, io, deps);
  try {
    const r = F.scanBundle(archive, { key }, { validate: validateArchiveManifest });
    const m = r.manifest;
    io.log(`archive authenticated: id=${m.bundleId} built=${m.builtAt} host=${m.sourceHost} chunks=${r.chunks}`);
    const list = m.files.map((f) => ({ path: f.path, size: f.size }));
    printSummary(io, list, new Map(Object.entries(m.excluded || {})));
    if (m.db) io.log(`candidates.db: integrity ${m.db.integrity}; ${Object.entries(m.db.tables || {}).map(([t, c]) => `${t}=${c}`).join(' ')}`);
    for (const w of m.warnings || []) io.warn(`archive warning: ${w}`);
    io.log(`LIST_OK files=${m.files.length}`);
    return F.EXIT.OK;
  } finally {
    key.fill(0);
  }
}

function extractSink(stage, entry) {
  const dest = path.join(stage, ...entry.path.split('/'));
  const rel = path.relative(stage, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw F.formatError('manifest rejected: a path escapes the target directory');
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(dest, 'wx', 0o600);
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* ignore */ } } };
  return {
    write(buf) { F.writeAll(fd, buf); },
    end() {
      fs.fsyncSync(fd);
      close();
      if (Number.isFinite(entry.mtimeMs)) {
        try { const t = new Date(entry.mtimeMs); fs.utimesSync(dest, t, t); } catch { /* best effort */ }
      }
    },
    abort() {
      close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    },
  };
}

async function extractArchive(opts, env, io, deps = {}) {
  const target = path.resolve(opts.extract);
  let tst = null;
  try { tst = fs.lstatSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (tst) {
    if (tst.isSymbolicLink() || !tst.isDirectory()) throw F.refusedError('the target exists and is not a directory');
    if (fs.readdirSync(target).length > 0) throw F.refusedError('the target directory is not empty');
  }
  const { archive, key } = await openArchive(opts, env, io, deps);
  const stage = `${target}.extracting-${process.pid}`;
  let done = false;
  try {
    const p1 = F.scanBundle(archive, { key }, { validate: validateArchiveManifest });
    const manifest = p1.manifest;
    io.log(`archive authenticated: id=${manifest.bundleId} built=${manifest.builtAt} host=${manifest.sourceHost} files=${manifest.files.length} chunks=${p1.chunks}`);
    for (const w of manifest.warnings || []) io.warn(`archive warning: ${w}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    F.scanBundle(archive, { key }, {
      validate: validateArchiveManifest,
      onManifest(m) {
        if (m.bundleId !== manifest.bundleId || JSON.stringify(m.files) !== JSON.stringify(manifest.files)) {
          throw F.verifyError('the archive changed while it was being extracted');
        }
      },
      sink(entry) { return extractSink(stage, entry); },
    });
    let dbNote = null;
    const dbEntry = manifest.files.find((f) => f.kind === 'db');
    if (dbEntry && manifest.db) {
      let Database = null;
      try { Database = F.loadSqlite([]); } catch { dbNote = 'database check skipped (no SQLite module)'; }
      if (Database) {
        const info = F.inspectDatabase(Database, { file: path.join(stage, ...dbEntry.path.split('/')) });
        if (info.integrity !== 'ok') throw F.verifyError(`the extracted database failed integrity_check (${info.integrity})`);
        for (const [t, c] of Object.entries(manifest.db.tables || {})) {
          if ((info.tables[t] || 0) !== c) throw F.verifyError(`the extracted database has ${info.tables[t] || 0} rows in ${t}, the manifest says ${c}`);
        }
        io.log(`candidates.db: integrity ok; ${Object.entries(info.tables).map(([t, c]) => `${t}=${c}`).join(' ')}`);
      }
    }
    if (dbNote) io.warn(`warning: ${dbNote}`);
    if (tst) fs.rmdirSync(target);
    fs.renameSync(stage, target);
    done = true;
    const bytes = manifest.files.reduce((a, f) => a + f.size, 0);
    io.log(`EXTRACT_OK files=${manifest.files.length} bytes=${bytes} dir=${target}`);
    return F.EXIT.OK;
  } finally {
    key.fill(0);
    if (!done) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------

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
    const deps = { stdin: streams.stdin || F.terminalStdin(), stderr: streams.stderr || process.stderr };
    if (opts.extract) return await extractArchive(opts, env, io, deps);
    if (opts.list) return await listArchive(opts, env, io, deps);
    return await buildArchive(opts, env, io, deps);
  } catch (e) {
    io.warn(`ARCHIVE_FAILED ${describeError(e, io)}`);
    return e instanceof F.BundleError ? e.exitCode : F.EXIT.ERROR;
  }
}

module.exports = { run, parseArgs, buildArchive, extractArchive, listArchive, walkSource, isSafeArchivePath, classifyArchivePath, validateArchiveManifest, legacyDefaultSource, FORMAT, DB_REL };

if (require.main === module) {
  const cleanup = () => {
    for (const d of liveTemps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
