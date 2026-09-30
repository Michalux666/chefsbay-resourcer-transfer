#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./make-manifest');

const USAGE = `Usage: node tools/check-manifest.js [--repo <dir>] [--manifest <file>] [--map <prefix>=<dir>]...
                                    [--profile <dir>] [--plugin-dir <dir>] [--installed auto|off]
                                    [--expect <sha256>] [--strict-config] [--json] [--quiet] [-h]

Verifies the code lockdown: every file listed in MANIFEST.sha256 (see tools/make-manifest.js) still has the
recorded sha256, no file is missing, and no unlisted file was added under the covered trees.

  --repo <dir>          repository root (default: the parent of this tools directory)
  --manifest <file>     manifest to read (default: <repo>/MANIFEST.sha256)
  --map <prefix>=<dir>  read files under a manifest path prefix from another directory, e.g.
                        --map resourcer=/opt/data/profiles/resourcer/workspace/resourcer
                        (default: resourcer/ is read from RESOURCER_HOME when that variable is set)
  --profile <dir>       Hermes profile home whose scripts/ holds the installed cron wrappers
                        (default: HERMES_HOME, else the parent of the repository when it has scripts/resourcer-tick.sh)
  --plugin-dir <dir>    installed dashboard plugin (default: <profile>/../../plugins/resourcer, else /opt/data/plugins/resourcer)
  --installed auto|off  also compare the installed cron wrappers, dashboard plugin, SOUL.md, AGENTS.md and the resourcer-ops skill
                        with hermes/ and plugin/resourcer (auto, the default, skips whatever cannot be found and says so)
  --expect <sha256>     the pinned digest of the manifest file itself (printed at install time); a mismatch fails
  --strict-config       count changes under resourcer/config/ as failures (they are advisory by default)
  --json                print one JSON object instead of lines
  --quiet               print problems and the final line only
  -h, --help            show this text

A missing installed copy is reported as INSTALLED_MISSING and is only a warning; a differing one fails.
Lines: CHANGED, MISSING, UNLISTED, CONFIG_CHANGED, CONFIG_MISSING, CONFIG_UNLISTED, INSTALLED_CHANGED,
INSTALLED_MISSING, INSTALLED_UNLISTED, NOTE, then MANIFEST_OK or MANIFEST_FAILED with counts and
MANIFEST_SHA256=<digest of the manifest file>.
Exit codes: 0 verified, 1 mismatch, 2 usage, 3 manifest missing or malformed.`;

const LINE_RE = /^([0-9a-f]{64}) {2}(\S+)$/;
const PLUGIN_PREFIX = 'plugin/resourcer/';
const WRAPPER_PREFIX = 'hermes/scripts/';
const PLUGIN_LOCAL_FILES = new Set(['dashboard/plugin_config.json']);

function parseArgs(argv) {
  const o = { repo: null, manifest: null, maps: [], profile: null, pluginDir: null, installed: 'auto', expect: null, strictConfig: false, json: false, quiet: false, help: false };
  const needs = (i, a) => {
    if (argv[i] === undefined || argv[i] === '') throw new M.ManifestError(`${a} needs a value`, 2);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--strict-config') o.strictConfig = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--repo') { i += 1; o.repo = needs(i, a); }
    else if (a === '--manifest') { i += 1; o.manifest = needs(i, a); }
    else if (a === '--profile') { i += 1; o.profile = needs(i, a); }
    else if (a === '--plugin-dir') { i += 1; o.pluginDir = needs(i, a); }
    else if (a === '--expect') { i += 1; o.expect = needs(i, a).toLowerCase(); }
    else if (a === '--installed') {
      i += 1;
      o.installed = needs(i, a);
      if (o.installed !== 'auto' && o.installed !== 'off') throw new M.ManifestError('--installed must be auto or off', 2);
    } else if (a === '--map') {
      i += 1;
      const v = needs(i, a);
      const eq = v.indexOf('=');
      if (eq < 1 || eq === v.length - 1) throw new M.ManifestError('--map needs <prefix>=<dir>', 2);
      o.maps.push({ prefix: v.slice(0, eq).replace(/^\/+|\/+$/g, ''), dir: path.resolve(v.slice(eq + 1)) });
    } else {
      throw new M.ManifestError(`unknown argument ${a}`, 2);
    }
  }
  if (o.expect !== null && !/^[0-9a-f]{64}$/.test(o.expect)) throw new M.ManifestError('--expect needs a 64 character hex digest', 2);
  return o;
}

function readManifest(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new M.ManifestError(`manifest not readable (${e.code || 'error'}): ${file}`, 3);
  }
  text = text.replace(/\r\n/g, '\n');
  const entries = [];
  const seen = new Set();
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const m = LINE_RE.exec(raw);
    if (!m) throw new M.ManifestError('manifest is malformed (expected "<sha256>  <path>" lines)', 3);
    const rel = m[2];
    const rooted = M.ROOT_FILES.includes(rel) || M.ROOT_DIRS.some((d) => rel.startsWith(`${d}/`));
    if (!rooted || rel.includes('..') || rel.startsWith('/') || seen.has(rel)) throw new M.ManifestError(`manifest lists an unexpected path: ${rel.slice(0, 80)}`, 3);
    seen.add(rel);
    entries.push({ path: rel, sha256: m[1] });
  }
  if (!entries.length) throw new M.ManifestError('manifest is empty', 3);
  return { entries, digest: crypto.createHash('sha256').update(text).digest('hex') };
}

function makeLocator(repoRoot, maps) {
  const sorted = maps.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  return (rel) => {
    for (const m of sorted) {
      if (rel === m.prefix) return m.dir;
      if (rel.startsWith(`${m.prefix}/`)) return path.join(m.dir, ...rel.slice(m.prefix.length + 1).split('/'));
    }
    return path.join(repoRoot, ...rel.split('/'));
  };
}

function walkLocated(rel, locate, out) {
  let entries;
  try {
    entries = fs.readdirSync(locate(rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!M.SKIP_DIRS.has(e.name)) walkLocated(child, locate, out);
    } else if ((e.isFile() || e.isSymbolicLink()) && !M.isSkippedName(e.name)) {
      out.push(child);
    }
  }
}

function digestOf(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return { missing: true }; }
  if (!st.isFile()) return { odd: true };
  try { return { sha256: M.digestFile(file) }; } catch { return { missing: true }; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function discoverProfile(o, repoRoot, env) {
  const cands = [];
  if (o.profile) cands.push(path.resolve(o.profile));
  if (env.HERMES_HOME) cands.push(path.resolve(env.HERMES_HOME));
  cands.push(path.resolve(repoRoot, '..'));
  return cands.find((c) => fs.existsSync(path.join(c, 'scripts', 'resourcer-tick.sh'))) || null;
}

function discoverPlugin(o, profile) {
  const cands = [];
  if (o.pluginDir) cands.push(path.resolve(o.pluginDir));
  if (profile) cands.push(path.resolve(profile, '..', '..', 'plugins', 'resourcer'));
  cands.push('/opt/data/plugins/resourcer');
  return cands.find((c) => fs.existsSync(path.join(c, 'dashboard', 'manifest.json'))) || null;
}

function findSkillDir(profile) {
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'resourcer-ops' && fs.existsSync(path.join(p, 'SKILL.md'))) return p;
      if (depth < 3) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(path.join(profile, 'skills'), 1);
}

// The profile files the resident agent loads (identity, instructions, skill) are copies of hermes/; a differing copy fails.
function compareProfileFiles(entries, profile, repoRoot, res) {
  const one = (manifestPath, dests) => {
    const e = entries.find((x) => x.path === manifestPath);
    if (!e) return;
    const found = dests.filter((d) => fs.existsSync(d));
    if (!found.length) { res.installedMissing.push(dests[0]); return; }
    for (const d of found) {
      const r = digestOf(d);
      if (r.odd || r.sha256 !== e.sha256) res.installedChanged.push(d);
    }
  };
  one('hermes/SOUL.md', [path.join(profile, 'SOUL.md')]);
  one('hermes/AGENTS.md', [path.join(profile, 'workspace', 'AGENTS.md'), path.join(repoRoot, 'AGENTS.md')]);
  const skill = findSkillDir(profile);
  const prefix = 'hermes/skills/resourcer-ops/';
  const skillEntries = entries.filter((x) => x.path.startsWith(prefix));
  if (!skill) {
    if (skillEntries.length) res.installedMissing.push(path.join(profile, 'skills', '<category>', 'resourcer-ops'));
    return;
  }
  res.notes.push(`installed skill compared in ${skill}`);
  for (const e of skillEntries) {
    const dest = path.join(skill, ...e.path.slice(prefix.length).split('/'));
    const d = digestOf(dest);
    if (d.missing) res.installedMissing.push(dest);
    else if (d.odd || d.sha256 !== e.sha256) res.installedChanged.push(dest);
  }
}

function verify(o, env) {
  const repoRoot = path.resolve(o.repo || path.join(__dirname, '..'));
  const manifestFile = path.resolve(o.manifest || path.join(repoRoot, M.MANIFEST_NAME));
  const { entries, digest } = readManifest(manifestFile);
  const res = { changed: [], missing: [], unlisted: [], configChanged: [], configMissing: [], configUnlisted: [], installedChanged: [], installedMissing: [], installedUnlisted: [], notes: [], pinMismatch: false, manifestSha256: digest, files: entries.length };

  if (o.expect !== null && o.expect !== digest) res.pinMismatch = true;

  const maps = o.maps.slice();
  if (env.RESOURCER_HOME && isDir(env.RESOURCER_HOME) && !maps.some((m) => m.prefix === 'resourcer')) {
    maps.push({ prefix: 'resourcer', dir: path.resolve(env.RESOURCER_HOME) });
  }
  const locate = makeLocator(repoRoot, maps);
  res.notes.push(`resourcer/ read from ${locate('resourcer')}`);
  res.notes.push(`everything else read from ${repoRoot}`);

  const listed = new Set(entries.map((e) => e.path));
  for (const e of entries) {
    const cfg = M.classOf(e.path) === 'config';
    const d = digestOf(locate(e.path));
    if (d.missing || d.odd) (cfg ? res.configMissing : res.missing).push(e.path);
    else if (d.sha256 !== e.sha256) (cfg ? res.configChanged : res.changed).push(e.path);
  }

  const found = [];
  for (const r of M.ROOT_FILES) if (fs.existsSync(locate(r))) found.push(r);
  for (const d of M.ROOT_DIRS) walkLocated(d, locate, found);
  for (const rel of found) {
    if (listed.has(rel)) continue;
    (M.classOf(rel) === 'config' ? res.configUnlisted : res.unlisted).push(rel);
  }

  if (o.installed === 'auto') {
    const profile = discoverProfile(o, repoRoot, env);
    if (profile) {
      res.notes.push(`installed wrappers compared in ${path.join(profile, 'scripts')}`);
      for (const e of entries.filter((x) => x.path.startsWith(WRAPPER_PREFIX))) {
        const dest = path.join(profile, 'scripts', e.path.slice(WRAPPER_PREFIX.length));
        const d = digestOf(dest);
        if (d.missing) res.installedMissing.push(dest);
        else if (d.odd || d.sha256 !== e.sha256) res.installedChanged.push(dest);
      }
      const listedWrappers = new Set(entries.filter((x) => x.path.startsWith(WRAPPER_PREFIX)).map((x) => x.path.slice(WRAPPER_PREFIX.length)));
      try {
        for (const n of fs.readdirSync(path.join(profile, 'scripts'))) {
          if (/^resourcer-.*\.sh$/.test(n) && !listedWrappers.has(n)) res.installedUnlisted.push(path.join(profile, 'scripts', n));
        }
      } catch { /* the directory was checked above */ }
      compareProfileFiles(entries, profile, repoRoot, res);
    } else {
      res.notes.push('installed wrappers not compared (no profile found; pass --profile <dir>)');
    }
    const plugin = discoverPlugin(o, profile);
    if (plugin) {
      res.notes.push(`installed plugin compared in ${plugin}`);
      const pluginEntries = entries.filter((x) => x.path.startsWith(PLUGIN_PREFIX));
      const pluginListed = new Set(pluginEntries.map((x) => x.path.slice(PLUGIN_PREFIX.length)));
      for (const e of pluginEntries) {
        const dest = path.join(plugin, ...e.path.slice(PLUGIN_PREFIX.length).split('/'));
        const d = digestOf(dest);
        if (d.missing) res.installedMissing.push(dest);
        else if (d.odd || d.sha256 !== e.sha256) res.installedChanged.push(dest);
      }
      const inPlugin = [];
      walkLocated('.', (rel) => path.join(plugin, ...rel.split('/').filter((s) => s && s !== '.')), inPlugin);
      for (const rel of inPlugin) {
        const r = rel.replace(/^\.\//, '');
        if (!pluginListed.has(r) && !PLUGIN_LOCAL_FILES.has(r)) res.installedUnlisted.push(path.join(plugin, ...r.split('/')));
      }
    } else {
      res.notes.push('installed plugin not compared (not found; pass --plugin-dir <dir>)');
    }
  } else {
    res.notes.push('installed copies not compared (--installed off)');
  }

  for (const k of ['changed', 'missing', 'unlisted', 'configChanged', 'configMissing', 'configUnlisted', 'installedChanged', 'installedMissing', 'installedUnlisted']) res[k].sort();
  const configProblems = res.configChanged.length + res.configMissing.length + res.configUnlisted.length;
  res.ok = !res.pinMismatch && !res.changed.length && !res.missing.length && !res.unlisted.length
    && !res.installedChanged.length && !res.installedUnlisted.length && (!o.strictConfig || configProblems === 0);
  return res;
}

function render(res, o) {
  const lines = [];
  if (res.pinMismatch) lines.push('PIN_MISMATCH the manifest file does not have the pinned digest (--expect)');
  for (const p of res.changed) lines.push(`CHANGED ${p}`);
  for (const p of res.missing) lines.push(`MISSING ${p}`);
  for (const p of res.unlisted) lines.push(`UNLISTED ${p}`);
  for (const p of res.configChanged) lines.push(`CONFIG_CHANGED ${p}`);
  for (const p of res.configMissing) lines.push(`CONFIG_MISSING ${p}`);
  for (const p of res.configUnlisted) lines.push(`CONFIG_UNLISTED ${p}`);
  for (const p of res.installedChanged) lines.push(`INSTALLED_CHANGED ${p}`);
  for (const p of res.installedMissing) lines.push(`INSTALLED_MISSING ${p}`);
  for (const p of res.installedUnlisted) lines.push(`INSTALLED_UNLISTED ${p}`);
  if (!o.quiet) for (const n of res.notes) lines.push(`NOTE ${n}`);
  const drift = res.configChanged.length + res.configMissing.length + res.configUnlisted.length;
  const counts = `files=${res.files} changed=${res.changed.length} missing=${res.missing.length} unlisted=${res.unlisted.length} installed_changed=${res.installedChanged.length} installed_missing=${res.installedMissing.length} installed_unlisted=${res.installedUnlisted.length} config_drift=${drift}`;
  lines.push(`${res.ok ? 'MANIFEST_OK' : 'MANIFEST_FAILED'} ${counts} MANIFEST_SHA256=${res.manifestSha256}`);
  return lines;
}

function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(`${s}\n`));
  const err = (io && io.err) || ((s) => process.stderr.write(`${s}\n`));
  const env = (io && io.env) || process.env;
  try {
    const o = parseArgs(argv);
    if (o.help) { out(USAGE); return 0; }
    const res = verify(o, env);
    if (o.json) out(JSON.stringify(res));
    else for (const l of render(res, o)) out(l);
    return res.ok ? 0 : 1;
  } catch (e) {
    err(`check-manifest: ${e.message}`);
    if (e.exitCode === 2) err(USAGE);
    if (e.exitCode === 3) out('MANIFEST_MISSING');
    return e.exitCode || 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, readManifest, makeLocator, verify, render, main, USAGE };
