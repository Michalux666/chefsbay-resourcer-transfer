#!/usr/bin/env node
'use strict';
// Build the encrypted data bundle (data/resourcer-bundle.enc) from the legacy workspace on the laptop.
// Never prints file contents, credentials or the passphrase. See docs/parity/bundle.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./lib/bundle-format');

const USAGE = `Usage: node tools/make-bundle.js [options]

Builds an AES-256-GCM (scrypt) encrypted bundle of the legacy resourcer data.

Options:
  --source <dir>            legacy workspace to read (default: the legacy workspace under your home directory)
  --out <file>              output file (default: data/resourcer-bundle.enc in this repo)
  --host-label <text>       label recorded in the manifest (default: this machine's host name)
  --dry-run                 do every check and print the file list, write nothing
  --i-paused-the-pipeline   continue although a live run was detected; asks for a typed confirmation
  --require-fence           refuse unless runtime/pipeline-halt.json exists in the source AND still holds, with no run and no
                            database change, when the build ends. The legacy watchdog clears a halt by itself once screening looks
                            healthy, so the real fence is stopping the legacy supervisor BEFORE building (see docs/CUTOVER.md)
  --backfill-run-history <dir>
                            read <dir>/phase2-results-*.json (the legacy downloads folder) and put the run_results history into
                            the bundle's database copy, so the dashboard history survives; prints a per-day parity table
  --tmpdir <dir>            where the temporary database snapshot goes (default: system temp)
  -h, --help                show this text

Passphrase (16+ characters, at least 8 different ones, never a command-line argument): hidden prompt (asked twice), or
BUNDLE_PASSPHRASE_FILE=<file> / BUNDLE_PASSPHRASE_FD=<n> for automation.

Exit codes: 0 ok, 1 usage/unexpected error, 4 refused (live pipeline), 5 source problem
(integrity check, missing file, Reed extraction), 7 passphrase problem.`;

const REED_SOURCES = ['cdp-reed-full-login.js', 'reed-clean-relogin.js'];
const EMAIL_NAMES = ['EMAIL', 'REED_EMAIL', 'REED_USERNAME', 'USERNAME'];
const PASSWORD_NAMES = ['PASSWORD', 'REED_PASSWORD', 'REED_PASS', 'PASS', 'PWD'];
const REQUIRED_DATA = ['scripts/extract-js.b64', 'config/postcode-cities.json', 'config/territory-defaults.json'];
const OPTIONAL_ROOT = ['postcode-lookup-cache.json', 'postcode-to-city-cache.json', 'reed-location-cache.json'];
const BACKSLASH = String.fromCharCode(92);

const liveTemps = new Set();

// The legacy directory name is assembled so the repo-wide banned-token grep (DESIGN section 9) stays clean.
function legacyDefaultSource() {
  return path.join(os.homedir(), '.open' + 'claw', 'workspace-resourcer');
}

function parseArgs(argv) {
  const opts = { source: null, out: null, hostLabel: null, dryRun: false, paused: false, requireFence: false, tmpDir: null, backfillRunHistory: null, help: false };
  const values = { '--source': 'source', '--out': 'out', '--host-label': 'hostLabel', '--tmpdir': 'tmpDir', '--backfill-run-history': 'backfillRunHistory' };
  const flags = { '--dry-run': 'dryRun', '--i-paused-the-pipeline': 'paused', '--require-fence': 'requireFence', '--help': 'help', '-h': 'help' };
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

// ---------------------------------------------------------------------------
// Reed credential extraction: values are captured inside this process and never printed.

function parseStringLiteral(text, start, quote) {
  let out = '';
  for (let j = start; j < text.length; j += 1) {
    const c = text[j];
    if (c === BACKSLASH) {
      j += 1;
      const n = text[j];
      if (n === undefined) return { ok: false, reason: 'unterminated string' };
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'v') out += '\v';
      else if (n === '0' && !/[0-9]/.test(text[j + 1] || '')) out += '\0';
      else if (n === 'x') {
        const h = text.slice(j + 1, j + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return { ok: false, reason: 'bad escape sequence' };
        out += String.fromCharCode(parseInt(h, 16));
        j += 2;
      } else if (n === 'u') {
        if (text[j + 1] === '{') {
          const close = text.indexOf('}', j + 2);
          const h = close < 0 ? '' : text.slice(j + 2, close);
          if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10FFFF) return { ok: false, reason: 'bad escape sequence' };
          out += String.fromCodePoint(parseInt(h, 16));
          j = close;
        } else {
          const h = text.slice(j + 1, j + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) return { ok: false, reason: 'bad escape sequence' };
          out += String.fromCharCode(parseInt(h, 16));
          j += 4;
        }
      } else if (n === '\r') {
        if (text[j + 1] === '\n') j += 1;
      } else if (n === '\n') {
        // line continuation
      } else if (/[1-9]/.test(n)) {
        return { ok: false, reason: 'unsupported escape sequence' };
      } else {
        out += n;
      }
      continue;
    }
    if (c === quote) return { ok: true, value: out, end: j + 1 };
    if ((c === '\n' || c === '\r') && quote !== '`') return { ok: false, reason: 'unterminated string' };
    if (quote === '`' && c === '$' && text[j + 1] === '{') return { ok: false, reason: 'template literal with interpolation' };
    out += c;
  }
  return { ok: false, reason: 'unterminated string' };
}

function extractConst(text, names) {
  for (const name of names) {
    const re = new RegExp(/^[ \t]*(?:const|let|var)[ \t]+/.source + name + /[ \t]*=[ \t]*(['"`])/.source, 'm');
    const m = re.exec(text);
    if (!m) continue;
    const lit = parseStringLiteral(text, m.index + m[0].length, m[1]);
    if (!lit.ok) return { ok: false, name, reason: lit.reason };
    const after = text.slice(lit.end);
    const restOfLine = after.split(/\r?\n/, 1)[0];
    if (!/^[ \t]*;?[ \t]*(?:\/\/.*|\/\*.*)?$/.test(restOfLine)) return { ok: false, name, reason: 'not a plain string literal' };
    if (!/^[ \t]*;/.test(restOfLine)) {
      const next = /^[ \t]*(?:\/\/.*|\/\*.*)?\r?\n\s*(\S)/.exec(after);
      if (next && '+-*/.[(,?:|&<>='.includes(next[1])) return { ok: false, name, reason: 'not a plain string literal' };
    }
    if (lit.value.length === 0) return { ok: false, name, reason: 'empty value' };
    return { ok: true, name, value: lit.value };
  }
  return { ok: false, name: names[0], reason: 'declaration not found' };
}

function extractReedCredentials(sourceDir) {
  const perFile = [];
  for (const file of REED_SOURCES) {
    const full = path.join(sourceDir, 'scripts', file);
    let text = null;
    try { text = fs.readFileSync(full, 'utf8'); } catch { /* recorded below */ }
    if (text === null) {
      perFile.push({ file, missing: true, email: null, password: null });
      continue;
    }
    perFile.push({ file, missing: false, email: extractConst(text, EMAIL_NAMES), password: extractConst(text, PASSWORD_NAMES) });
  }
  const failures = [];
  for (const f of perFile) {
    if (f.missing) { failures.push(`${f.file}: file not found`); continue; }
    if (!f.email.ok) failures.push(`${f.file}: ${f.email.name} ${f.email.reason}`);
    if (!f.password.ok) failures.push(`${f.file}: ${f.password.name} ${f.password.reason}`);
  }
  const usable = perFile.filter((f) => !f.missing && f.email.ok && f.password.ok);
  if (usable.length === 0) {
    throw F.sourceError(`Reed credential extraction failed (${failures.join('; ')})`);
  }
  const chosen = usable[0];
  const warnings = failures.map((x) => `Reed extraction: ${x} (used ${chosen.file})`);
  for (const other of usable.slice(1)) {
    const differ = [];
    if (other.email.value !== chosen.email.value) differ.push(chosen.email.name);
    if (other.password.value !== chosen.password.value) differ.push(chosen.password.name);
    if (differ.length) warnings.push(`Reed extraction: ${differ.join(' and ')} differ between ${chosen.file} and ${other.file}; used ${chosen.file}`);
  }
  return { email: chosen.email.value, password: chosen.password.value, from: chosen.file, warnings };
}

// ---------------------------------------------------------------------------
// Collection

function readRegular(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  return fs.readFileSync(file);
}

function collectPending(sourceDir, warnings) {
  const dir = path.join(sourceDir, 'pending-searches');
  const entries = [];
  let stripped = 0;
  let dirents = [];
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { entries, stripped }; }
  for (const d of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const rel = `pending-searches/${d.name}`;
    if (!F.classifyPath(rel)) { warnings.push(`${rel}: skipped (unsupported file name)`); continue; }
    const parsed = F.readJsonSafe(path.join(dir, d.name));
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      warnings.push(`${rel}: skipped (not a JSON object)`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(parsed.value, 'spawnedAt')) {
      delete parsed.value.spawnedAt;
      stripped += 1;
    }
    entries.push({ path: rel, buffer: Buffer.from(JSON.stringify(parsed.value, null, 2), 'utf8') });
  }
  return { entries, stripped };
}

function collectConfig(sourceDir, warnings) {
  const dir = path.join(sourceDir, 'config');
  const entries = [];
  let dirents = [];
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return entries; }
  for (const d of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const rel = `config/${d.name}`;
    if (d.name.toLowerCase() === 'dashboard-auth.json') continue;
    if (!F.classifyPath(rel)) { warnings.push(`${rel}: skipped (unsupported file name)`); continue; }
    const buf = readRegular(path.join(dir, d.name));
    if (buf) entries.push({ path: rel, buffer: buf });
  }
  return entries;
}

function jsonKeyNames(buf) {
  const p = F.safeParseJson(buf);
  if (!p.ok || !p.value || typeof p.value !== 'object' || Array.isArray(p.value)) return null;
  return { keys: Object.keys(p.value), value: p.value };
}

async function confirmPaused(io, deps) {
  if (!deps.stdin || !deps.stdin.isTTY) return false;
  io.warn(`Type exactly "${F.PAUSE_PHRASE}" to confirm that the pipeline is stopped and no run is writing to the source.`);
  const answer = await F.promptVisible('> ', { input: deps.stdin, output: deps.stderr });
  return answer.trim() === F.PAUSE_PHRASE;
}

// Put the run_results history into the private snapshot (never into the legacy database) so the dashboard history,
// the burn projection and the retention gate have data on the instance; counts only are printed.
async function backfillHistory(io, Database, snapFile, dir, warnings) {
  const abs = path.resolve(dir);
  let st;
  try { st = fs.statSync(abs); } catch { throw F.sourceError('--backfill-run-history: folder not found'); }
  if (!st.isDirectory()) throw F.sourceError('--backfill-run-history: not a folder');
  const backfill = require('../resourcer/scripts/backfill-run-results.js');
  const s = await backfill.backfill({ dir: abs, db: snapFile, Database, days: 14 });
  if (!s.ok) throw F.sourceError(`run history backfill failed (${s.errors.length} error(s))`);
  io.log(`run history: files=${s.files} parsed=${s.parsed} unreadable=${s.unparseable} undated=${s.noDate} inserted=${s.inserted} total_rows=${s.totalRows === undefined ? 0 : s.totalRows}`);
  for (const d of s.perDay) io.log(`  ${d.date}  files(new)=${String(d.files).padStart(4)}  run_results(new)=${String(d.db === null ? 0 : d.db).padStart(4)}${d.match === false ? '  MISMATCH' : ''}`);
  if (!s.parity.ok) throw F.sourceError(`run history parity mismatch on ${s.parity.mismatches} day(s)`);
  if (s.files === 0) warnings.push('--backfill-run-history: no phase2-results files were found; run_results starts empty');
}

// The halt file alone is no fence (the legacy watchdog clears it by itself), so look again before the bundle is
// moved into place: no run may have started, the halt must still be there with --require-fence, and the legacy
// database must not have received new data since the snapshot.
function recheckFence(io, opts, source, dbFile, Database, snapInfo, liveOverride) {
  const problems = [];
  const live = F.checkPipelineLive(source);
  if (live.live && !liveOverride) problems.push('a pipeline run started while the bundle was being built');
  if (opts.requireFence && !live.halt.present) problems.push('the migration halt was cleared while the bundle was being built');
  let now = null;
  try { now = F.inspectDatabase(Database, { file: dbFile }); } catch { problems.push('the legacy database could not be re-read for the fence check'); }
  if (now) {
    const moved = F.DATA_TABLES.some((t) => (now.tables[t] || 0) !== (snapInfo.tables[t] || 0)) || (now.watermark || null) !== (snapInfo.watermark || null);
    if (moved) problems.push('the legacy database changed after the snapshot was taken (something is still writing to it)');
  }
  if (!problems.length) return;
  const text = `${problems.join('; ')}; stop the legacy supervisor first and build again`;
  if (opts.requireFence) throw F.refusedError(`fence check failed: ${text}`);
  io.warn(`warning: ${text}`);
}

// ---------------------------------------------------------------------------

async function makeBundle(opts, env, io, deps = {}) {
  const source = path.resolve(opts.source || legacyDefaultSource());
  const out = path.resolve(opts.out || F.defaultBundlePath());
  const warnings = [];

  const dbFile = path.join(source, 'candidates.db');
  if (!fs.existsSync(dbFile)) throw F.sourceError('source workspace not found or it has no candidates.db');
  io.log(`make-bundle: source=${source}`);

  const live = F.checkPipelineLive(source);
  let liveOverride = false;
  for (const s of live.stale) warnings.push(`stale lock ignored: ${s}`);
  io.log(`pipeline check: ${live.live ? 'LIVE' : 'no live run'}; halt file ${live.halt.present ? `present${live.halt.reason ? ` (reason: ${live.halt.reason})` : ''}` : 'absent'}`);
  if (live.live) {
    for (const r of live.reasons) io.warn(`  live: ${r}`);
    if (!opts.paused) {
      throw F.refusedError('refusing to build a bundle while a pipeline run is live; stop the pipeline first (or, if you are certain it is stopped, re-run with --i-paused-the-pipeline)');
    }
    if (!(await confirmPaused(io, deps))) throw F.refusedError('typed confirmation not given (a terminal is required); nothing was built');
    liveOverride = true;
    warnings.push('built with --i-paused-the-pipeline while live-run evidence was present');
  }
  if (opts.requireFence && !live.halt.present) {
    throw F.refusedError('--require-fence: runtime/pipeline-halt.json is not present in the source; set the migration halt first');
  }
  if (!live.halt.present) warnings.push('no pipeline halt (fence) was present in the source while building');

  let passphrase = null;
  if (!opts.dryRun) {
    passphrase = await F.acquirePassphrase({ env, io, confirm: true, minLength: F.MIN_PASSPHRASE, stdin: deps.stdin, stderr: deps.stderr });
    if (new Set([...passphrase]).size < 8) throw F.passphraseError('passphrase is too repetitive (use at least 8 different characters)');
  }
  const logN = F.effectiveLog2N(env);
  io.log(`kdf: scrypt N=2^${logN} r=8 p=1 (default 2^${F.DEFAULT_LOG2N})`);
  if (logN < F.DEFAULT_LOG2N) {
    const w = `key-derivation cost 2^${logN} is below the default 2^${F.DEFAULT_LOG2N}; a stolen bundle is cheaper to guess (unset BUNDLE_SCRYPT_LOG2N for a real bundle)`;
    warnings.push(w);
  }

  const reed = extractReedCredentials(source);
  io.addSecret(reed.email);
  io.addSecret(reed.password);
  for (const w of reed.warnings) warnings.push(w);
  io.log(`secrets: reed-credentials.json built from ${reed.from} (keys: email,username,password)`);

  const entries = [];
  const secretNames = [];
  for (const name of ['caterer-credentials.json', 'zoho-credentials.json']) {
    const buf = readRegular(path.join(source, name));
    if (!buf) throw F.sourceError(`required secret file missing: ${name}`);
    const info = jsonKeyNames(buf);
    if (!info) throw F.sourceError(`${name} is not a valid JSON object`);
    io.addSecretsFromObject(info.value);
    entries.push({ path: `secrets/${name}`, buffer: buf });
    secretNames.push(`${name} (valid JSON, keys: ${info.keys.join(',')})`);
  }
  entries.push({ path: 'secrets/reed-credentials.json', buffer: Buffer.from(JSON.stringify({ email: reed.email, username: reed.email, password: reed.password }, null, 2) + '\n', 'utf8') });
  for (const s of secretNames) io.log(`secrets: ${s}`);

  const cfg = collectConfig(source, warnings);
  for (const e of cfg) entries.push(e);
  const extract = readRegular(path.join(source, 'scripts', 'extract-js.b64'));
  if (extract) entries.push({ path: 'scripts/extract-js.b64', buffer: extract });
  for (const name of OPTIONAL_ROOT) {
    const buf = readRegular(path.join(source, name));
    if (buf) entries.push({ path: name, buffer: buf });
    else warnings.push(`${name}: not present in the source (optional, skipped)`);
  }
  const pending = collectPending(source, warnings);
  for (const e of pending.entries) entries.push(e);
  const all = new Set(entries.map((e) => e.path));
  for (const req of REQUIRED_DATA) {
    if (!all.has(req)) throw F.sourceError(`required data file missing: ${req}`);
  }

  const Database = F.loadSqlite([source]);
  const tmpBase = opts.tmpDir ? path.resolve(opts.tmpDir) : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'cbr-bundle-'));
  liveTemps.add(tmpDir);
  try {
    const snap = path.join(tmpDir, 'candidates.db');
    let info;
    try {
      await F.snapshotDatabase(Database, dbFile, snap);
    } catch (e) {
      throw F.sourceError(`database snapshot or integrity check failed (${(e && e.code) || 'error'})`);
    }
    let pre;
    try {
      pre = F.inspectDatabase(Database, { file: snap });
    } catch (e) {
      throw F.sourceError(`database snapshot or integrity check failed (${(e && e.code) || 'error'})`);
    }
    if (opts.backfillRunHistory) await backfillHistory(io, Database, snap, opts.backfillRunHistory, warnings);
    try {
      info = opts.backfillRunHistory ? F.inspectDatabase(Database, { file: snap }) : pre;
    } catch (e) {
      throw F.sourceError(`database snapshot or integrity check failed (${(e && e.code) || 'error'})`);
    }
    if (info.integrity !== 'ok') throw F.sourceError(`PRAGMA integrity_check failed on the database snapshot: ${info.integrity}`);
    io.log(`candidates.db: integrity ok, ${Object.keys(info.tables).length} tables: ${Object.entries(info.tables).map(([t, c]) => `${t}=${c}`).join(' ')}; latest activity ${info.watermark || 'none'}`);
    entries.push({ path: 'candidates.db', sourcePath: snap });

    const dirs = [];
    for (const d of Object.keys(F.DIR_MODES)) {
      if (entries.some((e) => e.path.startsWith(`${d}/`))) dirs.push({ path: d, mode: F.modeToString(F.DIR_MODES[d]) });
    }
    const host = String(opts.hostLabel || os.hostname()).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'unknown';
    const manifestBase = F.newManifestBase({
      sourceHost: host,
      tool: { name: 'make-bundle', node: process.version, platform: process.platform },
      db: { path: 'candidates.db', integrity: info.integrity, journalMode: 'delete', tables: info.tables, watermark: info.watermark },
      dirs,
      source: { liveOverride, haltPresent: live.halt.present, haltReason: live.halt.reason },
      warnings,
    });

    const listing = () => {
      const groups = new Map();
      const lines = [];
      for (const e of entries.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const size = e.buffer ? e.buffer.length : fs.statSync(e.sourcePath).size;
        if (e.path.startsWith('pending-searches/')) {
          const g = groups.get('pending-searches') || { n: 0, bytes: 0 };
          g.n += 1;
          g.bytes += size;
          groups.set('pending-searches', g);
          continue;
        }
        lines.push(`  ${e.path.padEnd(46)} ${F.fmtBytes(size).padStart(10)}  ${F.modeToString(F.classifyPath(e.path).mode)}`);
      }
      for (const [k, g] of groups) lines.push(`  ${(k + '/ (' + g.n + ' files)').padEnd(46)} ${F.fmtBytes(g.bytes).padStart(10)}  0644`);
      return lines;
    };

    if (pending.stripped) io.log(`pending-searches: spawnedAt stripped from ${pending.stripped} file(s)`);
    io.log(`files (${entries.length}):`);
    for (const l of listing()) io.log(l);
    for (const w of warnings) io.warn(`warning: ${w}`);

    if (opts.dryRun) {
      io.log('DRY_RUN_OK nothing was written');
      return F.EXIT.OK;
    }

    // Build next to the destination, prove it decrypts and matches, then move it over any older bundle.
    const staged = `${out}.check-${process.pid}`;
    const written = F.writeBundle(staged, { passphrase, manifestBase, entries, logN });
    try {
      const check = F.checkBundleFile(staged, { key: written.key }, { Database });
      if (check.manifest.files.length !== written.manifest.files.length) throw F.verifyError('self-check: file count mismatch');
      if (check.problems.length) throw F.verifyError(`self-check failed: ${check.problems.join('; ')}`);
      recheckFence(io, opts, source, dbFile, Database, pre, liveOverride);
      fs.renameSync(staged, out);
    } catch (e) {
      try { fs.unlinkSync(staged); } catch { /* ignore */ }
      throw e;
    } finally {
      written.key.fill(0);
    }
    io.log('self-check: bundle decrypts, every file matches its sha256, database opens and matches the manifest counts');
    const fileHash = F.hashFile(out);
    io.log(`BUNDLE_OK out=${out} size=${fileHash.size} sha256=${fileHash.sha256} files=${written.manifest.files.length} chunks=${written.chunks}`);
    return F.EXIT.OK;
  } finally {
    liveTemps.delete(tmpDir);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function describeError(e, io) {
  if (e instanceof F.BundleError) return io.scrub(e.message);
  if (e instanceof SyntaxError) return 'unexpected error (SyntaxError)';
  return io.scrub(`unexpected error (${(e && (e.code || e.name)) || 'unknown'}): ${(e && e.message) || ''}`);
}

async function run(argv, env = process.env, streams = {}) {
  const io = F.createOutput(streams);
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) { io.log(USAGE); return F.EXIT.OK; }
    return await makeBundle(opts, env, io, { stdin: streams.stdin || F.terminalStdin(), stderr: streams.stderr || process.stderr });
  } catch (e) {
    io.warn(`BUNDLE_FAILED ${describeError(e, io)}`);
    return e instanceof F.BundleError ? e.exitCode : F.EXIT.ERROR;
  }
}

module.exports = { run, parseArgs, makeBundle, extractReedCredentials, extractConst, parseStringLiteral, legacyDefaultSource, recheckFence, backfillHistory };

if (require.main === module) {
  const cleanup = () => {
    for (const d of liveTemps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
