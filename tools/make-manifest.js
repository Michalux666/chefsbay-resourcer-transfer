#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node tools/make-manifest.js [--repo <dir>] [--out <file>] [--dry-run] [--list] [-h]

Writes MANIFEST.sha256 (sha256sum format, one "<hex>  <path>" line per file, sorted) over the code the
resident operator must never edit: resourcer/ (candidates-db.js, package files, scripts/, config/),
plugin/, hermes/ and tools/. tools/check-manifest.js verifies it; tools/preflight.sh calls that.

  --repo <dir>   repository root (default: the parent of this tools directory)
  --out <file>   manifest to write (default: <repo>/MANIFEST.sha256)
  --dry-run      print the summary line and write nothing
  --list         also print the hash and path of every file
  -h, --help     show this text

Text files are hashed with CRLF folded to LF, so a checkout with Windows line endings gives the same
digest. Run it as the LAST step after any change to the covered files, then commit the manifest.
Symlinks and unusual file names inside the covered trees are refused.

Prints one line: MANIFEST_WRITTEN files=<n> code=<n> config=<n> manifest_sha256=<hex>
Exit codes: 0 ok, 1 error, 2 usage.`;

const ROOT_FILES = ['resourcer/candidates-db.js', 'resourcer/package.json', 'resourcer/package-lock.json'];
const ROOT_DIRS = ['resourcer/scripts', 'resourcer/config', 'plugin', 'hermes', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.pytest_cache', '.git']);
const SKIP_FILE_RE = /\.(pyc|tmp|log)$/;
const CONFIG_PREFIX = 'resourcer/config/';
const MANIFEST_NAME = 'MANIFEST.sha256';
const SAFE_NAME_RE = /^[A-Za-z0-9._@+=,\/-]+$/;

class ManifestError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode || 1;
  }
}

function isSkippedName(name) {
  if (name === MANIFEST_NAME) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  return SKIP_FILE_RE.test(name);
}

// Text is hashed with CRLF folded to LF; a NUL byte marks binary content, which is hashed as is.
function canonicalBytes(buf) {
  if (buf.includes(0)) return buf;
  if (!buf.includes(13)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function digestBuffer(buf) {
  return crypto.createHash('sha256').update(canonicalBytes(buf)).digest('hex');
}

function digestFile(file) {
  return digestBuffer(fs.readFileSync(file));
}

function walkDir(base, relDir, out, problems) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, ...relDir.split('/')), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw new ManifestError(`cannot read ${relDir}: ${e.code || 'error'}`);
  }
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isSymbolicLink()) {
      problems.push(`symlink not allowed: ${rel}`);
      continue;
    }
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkDir(base, rel, out, problems);
      continue;
    }
    if (!e.isFile() || isSkippedName(e.name)) continue;
    if (!SAFE_NAME_RE.test(rel)) {
      problems.push(`unusual file name: ${rel}`);
      continue;
    }
    out.push(rel);
  }
}

// Every covered file as a repository-relative POSIX path, sorted; problems lists what must be fixed first.
function collectFiles(repoRoot) {
  const out = [];
  const problems = [];
  for (const rel of ROOT_FILES) {
    let st = null;
    try { st = fs.lstatSync(path.join(repoRoot, ...rel.split('/'))); } catch { st = null; }
    if (!st) continue;
    if (st.isSymbolicLink()) problems.push(`symlink not allowed: ${rel}`);
    else if (st.isFile()) out.push(rel);
  }
  for (const dir of ROOT_DIRS) walkDir(repoRoot, dir, out, problems);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: out, problems };
}

function classOf(rel) {
  return rel.startsWith(CONFIG_PREFIX) ? 'config' : 'code';
}

function buildManifest(repoRoot) {
  const { files, problems } = collectFiles(repoRoot);
  if (problems.length) throw new ManifestError(`refusing to write a manifest: ${problems.join('; ')}`);
  if (!files.length) throw new ManifestError(`no covered files found under ${repoRoot} (is --repo the repository root?)`);
  const entries = files.map((rel) => ({ path: rel, sha256: digestFile(path.join(repoRoot, ...rel.split('/'))) }));
  const text = entries.map((e) => `${e.sha256}  ${e.path}\n`).join('');
  return { entries, text, manifestSha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
}

function parseArgs(argv) {
  const o = { repo: null, out: null, dryRun: false, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--list') o.list = true;
    else if (a === '--repo' || a === '--out') {
      i += 1;
      if (argv[i] === undefined || argv[i] === '') throw new ManifestError(`${a} needs a value`, 2);
      o[a.slice(2)] = argv[i];
    } else {
      throw new ManifestError(`unknown argument ${a}`, 2);
    }
  }
  return o;
}

function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(`${s}\n`));
  const err = (io && io.err) || ((s) => process.stderr.write(`${s}\n`));
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) { out(USAGE); return 0; }
    const repoRoot = path.resolve(o.repo || path.join(__dirname, '..'));
    const outFile = path.resolve(o.out || path.join(repoRoot, MANIFEST_NAME));
    const m = buildManifest(repoRoot);
    if (o.list) for (const e of m.entries) out(`${e.sha256}  ${e.path}`);
    if (!o.dryRun) writeAtomic(outFile, m.text);
    const config = m.entries.filter((e) => classOf(e.path) === 'config').length;
    out(`${o.dryRun ? 'MANIFEST_DRY_RUN' : 'MANIFEST_WRITTEN'} files=${m.entries.length} code=${m.entries.length - config} config=${config} manifest_sha256=${m.manifestSha256}`);
    return 0;
  } catch (e) {
    err(`make-manifest: ${e.message}`);
    if (e.exitCode === 2) err(USAGE);
    return e.exitCode || 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ROOT_FILES, ROOT_DIRS, SKIP_DIRS, CONFIG_PREFIX, MANIFEST_NAME, SAFE_NAME_RE, ManifestError,
  canonicalBytes, digestBuffer, digestFile, collectFiles, classOf, buildManifest, isSkippedName, walkDir, main,
};
