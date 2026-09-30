'use strict';
// Shared format, crypto, passphrase, SQLite and liveness helpers for make-bundle / restore-bundle / verify-bundle.
//
// Bundle file layout (all integers big endian):
//   header (56 bytes, plaintext, bound into every chunk as AAD):
//     0  magic 'CBRBNDL1' | 8 version u16 | 10 kdf u8 (1=scrypt) | 11 cipher u8 (1=AES-256-GCM)
//     12 log2(N) u8 | 13 r u8 (=8) | 14 p u8 (=1) | 15 reserved u8 (=0)
//     16 chunkSize u32 (plaintext bytes in every non-final chunk) | 20 salt[32] | 52 nonce prefix[4]
//   chunks: flags u8 (bit0 = final) | ctLen u32 | ciphertext | tag[16]
//     nonce = prefix || counter u64;  AAD = header || counter u64 || flags
//   decrypted stream: manifestLen u32 | manifest JSON | file bytes in manifest order (no framing)
// Reordering, dropping, duplicating or truncating chunks fails authentication or the final-flag check.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('CBRBNDL1', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_LEN = 56;
const TAG_LEN = 16;
const KEY_LEN = 32;
const KDF_SCRYPT = 1;
const CIPHER_AES256GCM = 1;
const DEFAULT_LOG2N = 17;
const MIN_LOG2N = 15;
const MAX_LOG2N = 18;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DEFAULT_CHUNK = 1024 * 1024;
const MIN_CHUNK = 64;
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_FILES = 50000;
const MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const IO_PIECE = 1024 * 1024;
const MIN_PASSPHRASE = 16;
const PAUSE_PHRASE = 'I PAUSED THE PIPELINE';

const EXIT = { OK: 0, ERROR: 1, AUTH: 2, FORMAT: 3, REFUSED: 4, VERIFY: 5, MIGRATE: 6, PASSPHRASE: 7 };

class BundleError extends Error {
  constructor(message, exitCode, code) {
    super(message);
    this.name = 'BundleError';
    this.exitCode = exitCode;
    this.code = code;
  }
}
const authError = () => new BundleError('authentication failed', EXIT.AUTH, 'EAUTH');
const formatError = (m) => new BundleError(m, EXIT.FORMAT, 'EFORMAT');
const verifyError = (m) => new BundleError(m, EXIT.VERIFY, 'EVERIFY');
const refusedError = (m) => new BundleError(m, EXIT.REFUSED, 'EREFUSED');
const sourceError = (m) => new BundleError(m, EXIT.VERIFY, 'ESOURCE');
const passphraseError = (m) => new BundleError(m, EXIT.PASSPHRASE, 'EPASSPHRASE');
const usageError = (m) => new BundleError(m, EXIT.ERROR, 'EUSAGE');

// ---------------------------------------------------------------------------
// Paths that may travel in a bundle (allowlist; anything else is refused on both sides)

const PATH_RULES = [
  { re: /^candidates\.db$/, kind: 'db', mode: 0o600, secret: false },
  { re: /^config\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/, kind: 'config', mode: 0o644, secret: false },
  { re: /^scripts\/extract-js\.b64$/, kind: 'data', mode: 0o644, secret: false },
  { re: /^(postcode-lookup-cache|postcode-to-city-cache|reed-location-cache)\.json$/, kind: 'cache', mode: 0o644, secret: false },
  { re: /^pending-searches\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/, kind: 'pending', mode: 0o644, secret: false },
  { re: /^secrets\/(caterer|zoho|reed)-credentials\.json$/, kind: 'secret', mode: 0o600, secret: true },
];
const DIR_MODES = { secrets: 0o700, config: 0o755, 'pending-searches': 0o755, scripts: 0o755 };
const DATA_TABLES = ['candidates', 'candidate_rejections', 'territory_searches', 'reed_daily_usage', 'run_results'];

function classifyPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return null;
  if (p.toLowerCase() === 'config/dashboard-auth.json') return null;
  for (const rule of PATH_RULES) if (rule.re.test(p)) return rule;
  return null;
}

const modeToString = (m) => '0' + (m & 0o777).toString(8).padStart(3, '0');
const stringToMode = (s) => parseInt(s, 8);

// ---------------------------------------------------------------------------
// Small helpers

function safeParseJson(input) {
  try {
    let s = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return { ok: true, value: JSON.parse(s) };
  } catch {
    // never surface e.message: JSON.parse errors quote a slice of the source text
    return { ok: false };
  }
}

function readJsonSafe(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return { ok: false, unreadable: true }; }
  return safeParseJson(raw);
}

function readFully(fd, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

function hashFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(IO_PIECE);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
    return { sha256: h.digest('hex'), size };
  } finally {
    fs.closeSync(fd);
  }
}

const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function relPathToFs(base, rel) {
  return path.join(base, ...rel.split('/'));
}

function defaultBundlePath() {
  return path.resolve(__dirname, '..', '..', 'data', 'resourcer-bundle.enc');
}

function defaultHome(env = process.env) {
  if (env.RESOURCER_HOME) return path.resolve(env.RESOURCER_HOME);
  try { return require('../../resourcer/scripts/lib/paths.js').HOME; } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..', 'resourcer');
}

// ---------------------------------------------------------------------------
// Output with a scrubber: any registered secret value is replaced before it can reach a terminal or log

function createOutput(streams) {
  const out = streams && streams.stdout ? streams.stdout : process.stdout;
  const err = streams && streams.stderr ? streams.stderr : process.stderr;
  const secrets = new Set();
  const scrub = (s) => {
    let text = String(s);
    for (const v of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(v).join('[redacted]');
    return text;
  };
  return {
    addSecret(v) { if (typeof v === 'string' && v.length >= 6) secrets.add(v); },
    addSecretsFromObject(o) {
      if (!o || typeof o !== 'object') return;
      for (const v of Object.values(o)) {
        if (typeof v === 'string') this.addSecret(v);
        else if (v && typeof v === 'object') this.addSecretsFromObject(v);
      }
    },
    log(m) { out.write(scrub(m) + '\n'); },
    warn(m) { err.write(scrub(m) + '\n'); },
    scrub,
  };
}

// ---------------------------------------------------------------------------
// Header and key derivation

function scryptLog2NFromEnv(env = process.env) {
  const v = env.BUNDLE_SCRYPT_LOG2N;
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_LOG2N || n > MAX_LOG2N) {
    throw usageError(`BUNDLE_SCRYPT_LOG2N must be an integer from ${MIN_LOG2N} to ${MAX_LOG2N}`);
  }
  return n;
}

const effectiveLog2N = (env = process.env) => scryptLog2NFromEnv(env) || DEFAULT_LOG2N;

function newHeader(opts = {}) {
  const logN = opts.logN || scryptLog2NFromEnv() || DEFAULT_LOG2N;
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  if (logN < MIN_LOG2N || logN > MAX_LOG2N) throw usageError('scrypt cost out of range');
  if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) throw usageError('chunk size out of range');
  return { version: FORMAT_VERSION, logN, r: SCRYPT_R, p: SCRYPT_P, chunkSize, salt: crypto.randomBytes(32), noncePrefix: crypto.randomBytes(4) };
}

function encodeHeader(h) {
  const b = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(b, 0);
  b.writeUInt16BE(FORMAT_VERSION, 8);
  b[10] = KDF_SCRYPT;
  b[11] = CIPHER_AES256GCM;
  b[12] = h.logN;
  b[13] = h.r;
  b[14] = h.p;
  b[15] = 0;
  b.writeUInt32BE(h.chunkSize, 16);
  h.salt.copy(b, 20);
  h.noncePrefix.copy(b, 52);
  return b;
}

function decodeHeader(b) {
  if (b.length < HEADER_LEN || !b.subarray(0, 8).equals(MAGIC)) throw formatError('not a resourcer bundle');
  const version = b.readUInt16BE(8);
  if (version !== FORMAT_VERSION) throw formatError('unsupported bundle version');
  if (b[10] !== KDF_SCRYPT || b[11] !== CIPHER_AES256GCM || b[15] !== 0) throw formatError('unsupported bundle parameters');
  const h = {
    version,
    logN: b[12],
    r: b[13],
    p: b[14],
    chunkSize: b.readUInt32BE(16),
    salt: Buffer.from(b.subarray(20, 52)),
    noncePrefix: Buffer.from(b.subarray(52, 56)),
  };
  if (h.logN < MIN_LOG2N || h.logN > MAX_LOG2N || h.r !== SCRYPT_R || h.p !== SCRYPT_P) throw formatError('unsupported bundle key-derivation parameters');
  if (h.chunkSize < MIN_CHUNK || h.chunkSize > MAX_CHUNK) throw formatError('unsupported bundle chunk size');
  return h;
}

function deriveKey(passphrase, h) {
  const N = 2 ** h.logN;
  const pw = Buffer.from(String(passphrase).normalize('NFKC'), 'utf8');
  try {
    return crypto.scryptSync(pw, h.salt, KEY_LEN, { N, r: h.r, p: h.p, maxmem: 256 * N * h.r });
  } finally {
    pw.fill(0);
  }
}

const nonceFor = (prefix, counter) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
};

const aadFor = (headerBytes, counter, flags) => {
  const a = Buffer.alloc(HEADER_LEN + 9);
  headerBytes.copy(a, 0);
  a.writeBigUInt64BE(BigInt(counter), HEADER_LEN);
  a[HEADER_LEN + 8] = flags;
  return a;
};

// ---------------------------------------------------------------------------
// Chunk writer / reader (synchronous, fixed buffers: memory does not grow with bundle size)

class ChunkWriter {
  constructor(fd, key, header) {
    this.fd = fd;
    this.key = key;
    this.header = header;
    this.headerBytes = encodeHeader(header);
    this.buf = Buffer.allocUnsafe(header.chunkSize);
    this.len = 0;
    this.counter = 0;
    this.bytesOut = 0;
    writeAll(fd, this.headerBytes);
    this.bytesOut += HEADER_LEN;
  }

  write(data) {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(this.buf.length - this.len, data.length - off);
      data.copy(this.buf, this.len, off, off + n);
      this.len += n;
      off += n;
      if (this.len === this.buf.length) this._emit(false);
    }
  }

  finish() {
    this._emit(true);
    return { bytes: this.bytesOut, chunks: this.counter };
  }

  _emit(final) {
    if (this.counter >= 0xFFFFFFFF) throw usageError('bundle too large');
    const flags = final ? 1 : 0;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonceFor(this.header.noncePrefix, this.counter), { authTagLength: TAG_LEN });
    cipher.setAAD(aadFor(this.headerBytes, this.counter, flags));
    const part = cipher.update(this.buf.subarray(0, this.len));
    const fin = cipher.final();
    const ct = fin.length ? Buffer.concat([part, fin]) : part;
    const head = Buffer.alloc(5);
    head[0] = flags;
    head.writeUInt32BE(ct.length, 1);
    writeAll(this.fd, head);
    writeAll(this.fd, ct);
    writeAll(this.fd, cipher.getAuthTag());
    this.bytesOut += 5 + ct.length + TAG_LEN;
    this.counter += 1;
    this.len = 0;
  }
}

class ChunkReader {
  constructor(fd, key, header, headerBytes) {
    this.fd = fd;
    this.key = key;
    this.header = header;
    this.headerBytes = headerBytes;
    this.pos = HEADER_LEN;
    this.counter = 0;
    this.done = false;
    this.body = Buffer.allocUnsafe(header.chunkSize + TAG_LEN);
  }

  next() {
    if (this.done) return null;
    const fh = Buffer.alloc(5);
    if (readFully(this.fd, fh, 5, this.pos) < 5) throw formatError('bundle is truncated');
    const flags = fh[0];
    const ctLen = fh.readUInt32BE(1);
    if (flags > 1) throw authError();
    const final = flags === 1;
    if (ctLen > this.header.chunkSize || (!final && ctLen !== this.header.chunkSize)) throw authError();
    const body = this.body.subarray(0, ctLen + TAG_LEN);
    if (readFully(this.fd, body, body.length, this.pos + 5) < body.length) throw formatError('bundle is truncated');
    let plain;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonceFor(this.header.noncePrefix, this.counter), { authTagLength: TAG_LEN });
      d.setAAD(aadFor(this.headerBytes, this.counter, flags));
      d.setAuthTag(body.subarray(ctLen));
      const part = d.update(body.subarray(0, ctLen));
      const fin = d.final();
      plain = fin.length ? Buffer.concat([part, fin]) : part;
    } catch {
      throw authError();
    }
    this.pos += 5 + body.length;
    this.counter += 1;
    if (final) {
      this.done = true;
      if (readFully(this.fd, Buffer.alloc(1), 1, this.pos) !== 0) throw formatError('bundle has trailing data after the final chunk');
    }
    return plain;
  }
}

class PlainStream {
  constructor(reader) {
    this.reader = reader;
    this.cur = Buffer.alloc(0);
    this.off = 0;
  }

  _fill() {
    while (this.off >= this.cur.length) {
      if (this.reader.done) return false;
      this.cur = this.reader.next();
      this.off = 0;
    }
    return true;
  }

  pull(max) {
    if (!this._fill()) return null;
    const n = Math.min(max, this.cur.length - this.off);
    const out = this.cur.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  readExact(n) {
    const parts = [];
    let need = n;
    while (need > 0) {
      const p = this.pull(need);
      if (!p) throw formatError('bundle payload ended early');
      parts.push(Buffer.from(p));
      need -= p.length;
    }
    return Buffer.concat(parts);
  }

  expectEnd() {
    if (this._fill()) throw formatError('bundle has unexpected data after the last file');
  }
}

function readHeaderFromFd(fd) {
  const bytes = Buffer.alloc(HEADER_LEN);
  const n = readFully(fd, bytes, HEADER_LEN, 0);
  if (n < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw formatError('not a resourcer bundle');
  if (n < HEADER_LEN) throw formatError('bundle is truncated');
  return { header: decodeHeader(bytes), bytes };
}

function bundleKey(file, passphrase) {
  const fd = fs.openSync(file, 'r');
  try {
    const { header } = readHeaderFromFd(fd);
    return deriveKey(passphrase, header);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Manifest

function validateManifest(m) {
  const bad = (why) => formatError(`manifest rejected: ${why}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('not an object');
  if (m.format !== 'resourcer-bundle' || m.formatVersion !== FORMAT_VERSION) throw bad('unknown format');
  if (typeof m.bundleId !== 'string' || !/^[0-9a-f-]{36}$/.test(m.bundleId)) throw bad('bad bundleId');
  if (typeof m.builtAt !== 'string' || !Number.isFinite(Date.parse(m.builtAt))) throw bad('bad builtAt');
  if (typeof m.sourceHost !== 'string' || m.sourceHost.length > 100) throw bad('bad sourceHost');
  if (!Array.isArray(m.files) || m.files.length > MAX_FILES) throw bad('bad file list');
  const seen = new Set();
  let dbEntries = 0;
  m.files.forEach((f, i) => {
    if (!f || typeof f !== 'object') throw bad(`file #${i} is not an object`);
    const rule = classifyPath(f.path);
    if (!rule) throw bad(`file #${i} has a disallowed path`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw bad(`file #${i} is a duplicate path`);
    seen.add(key);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad(`file #${i} has a bad size`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw bad(`file #${i} has a bad sha256`);
    if (typeof f.mode !== 'string' || !/^0[0-7]{3}$/.test(f.mode)) throw bad(`file #${i} has a bad mode`);
    if (rule.secret && (stringToMode(f.mode) & 0o077) !== 0) throw bad(`file #${i} is a secret with group/other access`);
    f.kind = rule.kind;
    f.secret = rule.secret;
    f.mode = modeToString(rule.mode);
    if (rule.kind === 'db') dbEntries += 1;
  });
  if (dbEntries > 1) throw bad('more than one database');
  if (dbEntries === 1) {
    const d = m.db;
    if (!d || typeof d !== 'object' || d.path !== 'candidates.db' || typeof d.integrity !== 'string') throw bad('bad db section');
    if (!d.tables || typeof d.tables !== 'object') throw bad('bad db tables');
    for (const [name, count] of Object.entries(d.tables)) {
      if (typeof name !== 'string' || !Number.isSafeInteger(count) || count < 0) throw bad('bad db table count');
    }
    if (d.watermark !== null && d.watermark !== undefined && typeof d.watermark !== 'string') throw bad('bad db watermark');
  }
  if (m.dirs !== undefined) {
    if (!Array.isArray(m.dirs)) throw bad('bad dirs');
    for (const d of m.dirs) {
      if (!d || DIR_MODES[d.path] === undefined || typeof d.mode !== 'string' || !/^0[0-7]{3}$/.test(d.mode)) throw bad('bad dir entry');
    }
  }
  if (m.warnings !== undefined && !Array.isArray(m.warnings)) throw bad('bad warnings');
  return m;
}

function newManifestBase(fields) {
  return Object.assign({
    format: 'resourcer-bundle',
    formatVersion: FORMAT_VERSION,
    bundleId: crypto.randomUUID(),
    builtAt: new Date().toISOString(),
  }, fields);
}

// ---------------------------------------------------------------------------
// Writing and scanning bundles

function hashSource(entry) {
  if (entry.buffer) return { sha256: sha256Buffer(entry.buffer), size: entry.buffer.length };
  return hashFile(entry.sourcePath);
}

// entries: [{ path, buffer | sourcePath }]; manifestBase supplies everything except `files`.
function writeBundle(outPath, opts) {
  const { passphrase, manifestBase, entries } = opts;
  const classify = opts.classify || classifyPath;
  const validate = opts.validate || validateManifest;
  const header = opts.header || newHeader({ logN: opts.logN, chunkSize: opts.chunkSize });
  const key = opts.key || deriveKey(passphrase, header);
  const files = [];
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rule = classify(e.path);
    if (!rule) throw usageError('refusing to bundle a path outside the allowlist');
    const { sha256, size } = hashSource(e);
    files.push(Object.assign({}, e.meta, { path: e.path, kind: e.kind || rule.kind, mode: modeToString(rule.mode), secret: rule.secret, size, sha256, source: e }));
  }
  const manifest = Object.assign({}, manifestBase, {
    files: files.map(({ source, ...rest }) => rest),
  });
  validate(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
  if (manifestBytes.length > MAX_MANIFEST) throw usageError('manifest too large');

  const tmp = `${outPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(tmp, 'wx', 0o600);
  let closed = false;
  try {
    const w = new ChunkWriter(fd, key, header);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(manifestBytes.length, 0);
    w.write(lenBuf);
    w.write(manifestBytes);
    for (const f of files) {
      const src = f.source;
      const h = crypto.createHash('sha256');
      let size = 0;
      if (src.buffer) {
        h.update(src.buffer);
        size = src.buffer.length;
        w.write(src.buffer);
      } else {
        const rfd = fs.openSync(src.sourcePath, 'r');
        try {
          const piece = Buffer.allocUnsafe(IO_PIECE);
          for (;;) {
            const n = fs.readSync(rfd, piece, 0, piece.length, null);
            if (n === 0) break;
            h.update(piece.subarray(0, n));
            size += n;
            w.write(piece.subarray(0, n));
          }
        } finally {
          fs.closeSync(rfd);
        }
      }
      if (size !== f.size || h.digest('hex') !== f.sha256) throw sourceError(`source changed while packing: ${f.path}`);
    }
    const stats = w.finish();
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
    fs.renameSync(tmp, outPath);
    return { manifest, header, key, bytes: stats.bytes, chunks: stats.chunks };
  } catch (e) {
    if (!closed) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (!opts.key) key.fill(0);
    throw e;
  }
}

// cred: { passphrase } or { key }. opts.onManifest(manifest) may throw to stop before any sink is created.
// opts.sink(entry) returns null (discard) or { write(buf), end(), abort() }.
function scanBundle(file, cred, opts = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const { header, bytes } = readHeaderFromFd(fd);
    const key = cred.key || deriveKey(cred.passphrase, header);
    const reader = new ChunkReader(fd, key, header, bytes);
    const plain = new PlainStream(reader);
    const mlen = plain.readExact(4).readUInt32BE(0);
    if (mlen === 0 || mlen > MAX_MANIFEST) throw formatError('manifest length out of range');
    const parsed = safeParseJson(plain.readExact(mlen));
    if (!parsed.ok) throw formatError('manifest is not valid JSON');
    const manifest = (opts.validate || validateManifest)(parsed.value);
    if (opts.onManifest) opts.onManifest(manifest);
    for (const entry of manifest.files) {
      const sink = opts.sink ? opts.sink(entry) : null;
      const h = crypto.createHash('sha256');
      let remaining = entry.size;
      try {
        while (remaining > 0) {
          const piece = plain.pull(Math.min(remaining, IO_PIECE));
          if (!piece) throw formatError('bundle payload ended early');
          h.update(piece);
          if (sink) sink.write(piece);
          remaining -= piece.length;
        }
        if (h.digest('hex') !== entry.sha256) throw verifyError(`sha256 mismatch: ${entry.path}`);
        if (sink) sink.end();
      } catch (e) {
        if (sink && sink.abort) sink.abort();
        throw e;
      }
    }
    plain.expectEnd();
    return { manifest, header, key: cred.key ? null : key, chunks: reader.counter };
  } finally {
    fs.closeSync(fd);
  }
}

// Full read-only check of a bundle: authenticates everything, re-hashes every file and, when a SQLite
// module is supplied, opens the database in memory (integrity_check plus row counts against the manifest).
const MAX_DB_IN_MEMORY = 512 * 1024 * 1024;

function checkBundleFile(file, cred, { Database = null } = {}) {
  const dbParts = [];
  let dbBytes = 0;
  const result = scanBundle(file, cred, {
    sink(entry) {
      if (entry.kind !== 'db' || !Database || entry.size > MAX_DB_IN_MEMORY) return null;
      return {
        write(buf) { dbParts.push(Buffer.from(buf)); dbBytes += buf.length; },
        end() { /* collected */ },
        abort() { dbParts.length = 0; dbBytes = 0; },
      };
    },
  });
  const m = result.manifest;
  const out = { manifest: m, chunks: result.chunks, key: result.key, dbInfo: null, dbNote: null, problems: [] };
  if (!m.db) return out;
  const dbEntry = m.files.find((f) => f.path === 'candidates.db');
  if (!Database) { out.dbNote = 'database check skipped (no SQLite module)'; return out; }
  if (dbEntry.size > MAX_DB_IN_MEMORY) { out.dbNote = 'database too large to open in memory; sha256 verified, integrity_check not re-run'; return out; }
  try {
    out.dbInfo = inspectDatabase(Database, { buffer: Buffer.concat(dbParts, dbBytes) });
  } catch (e) {
    out.problems.push(`the database inside the bundle could not be opened (${(e && e.code) || 'error'})`);
    return out;
  }
  if (out.dbInfo.integrity !== 'ok') out.problems.push(`PRAGMA integrity_check ${out.dbInfo.integrity}`);
  for (const t of new Set([...Object.keys(out.dbInfo.tables), ...Object.keys(m.db.tables)])) {
    if ((out.dbInfo.tables[t] || 0) !== (m.db.tables[t] || 0)) {
      out.problems.push(`table ${t} has ${out.dbInfo.tables[t] || 0} rows, the manifest says ${m.db.tables[t] || 0}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passphrase input

// Only a real terminal is ever used for prompts; touching process.stdin is skipped otherwise.
function terminalStdin() {
  try { return process.stdin && process.stdin.isTTY ? process.stdin : null; } catch { return null; }
}

function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input || !input.isTTY || typeof input.setRawMode !== 'function') {
      reject(passphraseError('no terminal available for a hidden prompt'));
      return;
    }
    output.write(question);
    let text = '';
    const finish = (fn, val) => {
      input.removeListener('data', onData);
      try { input.setRawMode(false); } catch { /* ignore */ }
      input.pause();
      output.write('\n');
      fn(val);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { finish(resolve, text); return; }
        if (ch === '\u0003') { finish(reject, passphraseError('interrupted')); return; }
        if (ch === '\u007f' || ch === '\b') { text = [...text].slice(0, -1).join(''); continue; }
        if (ch < ' ') continue;
        text += ch;
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

function promptVisible(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input || !input.isTTY) { reject(refusedError('no terminal available for confirmation')); return; }
    output.write(question);
    let text = '';
    const onData = (chunk) => {
      text += String(chunk);
      const nl = text.search(/[\r\n]/);
      if (nl >= 0) {
        input.removeListener('data', onData);
        input.pause();
        resolve(text.slice(0, nl));
      }
    };
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

const DEFAULT_PASSPHRASE_REL = 'secrets/bundle-passphrase';

// The human-only channel: <home>/secrets/bundle-passphrase, placed by the human, regular file, owner-only.
// Returns null when absent; every other problem is a refusal that never quotes the content.
function readDefaultPassphraseFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw passphraseError(`cannot inspect ${DEFAULT_PASSPHRASE_REL} (${e.code || 'error'})`);
  }
  if (!st.isFile()) throw passphraseError(`${DEFAULT_PASSPHRASE_REL} must be a regular file (not a link or directory)`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw passphraseError(`${DEFAULT_PASSPHRASE_REL} is readable by group or others; run chmod 600 on it and retry`);
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw passphraseError(`cannot read ${DEFAULT_PASSPHRASE_REL} (${e.code || 'error'})`);
  }
}

// Order: BUNDLE_PASSPHRASE_FILE, BUNDLE_PASSPHRASE_FD, the human-placed defaultFile (when the caller names one),
// a hidden prompt on a real terminal. onSource(kind) tells the caller which one answered (never the value).
async function acquirePassphrase({ env = process.env, io, confirm = false, minLength = 0, stdin = process.stdin, stderr = process.stderr, label = 'Bundle passphrase', defaultFile = null, onSource = null }) {
  const fileVar = env.BUNDLE_PASSPHRASE_FILE;
  const fdVar = env.BUNDLE_PASSPHRASE_FD;
  let raw;
  let fromDefault = null;
  if (fileVar && fdVar) throw passphraseError('set only one of BUNDLE_PASSPHRASE_FILE and BUNDLE_PASSPHRASE_FD');
  if (!fileVar && !fdVar && defaultFile) fromDefault = readDefaultPassphraseFile(defaultFile);
  if (fromDefault !== null) {
    raw = fromDefault;
    if (onSource) onSource('default-file');
  } else if (fileVar) {
    try {
      raw = fs.readFileSync(fileVar, 'utf8');
    } catch (e) {
      throw passphraseError(`cannot read BUNDLE_PASSPHRASE_FILE (${e.code || 'error'})`);
    }
    if (process.platform !== 'win32') {
      try {
        if ((fs.statSync(fileVar).mode & 0o077) !== 0 && io) io.warn('warning: BUNDLE_PASSPHRASE_FILE is accessible by group or others');
      } catch { /* ignore */ }
    }
  } else if (fdVar) {
    const fd = Number(fdVar);
    if (!Number.isInteger(fd) || fd < 0) throw passphraseError('BUNDLE_PASSPHRASE_FD must be a file descriptor number');
    try {
      raw = fs.readFileSync(fd, 'utf8');
    } catch (e) {
      throw passphraseError(`cannot read BUNDLE_PASSPHRASE_FD (${e.code || 'error'})`);
    }
  } else if (stdin && stdin.isTTY) {
    raw = await promptHidden(`${label}: `, { input: stdin, output: stderr });
    if (confirm) {
      const again = await promptHidden(`${label} (again): `, { input: stdin, output: stderr });
      if (again !== raw) throw passphraseError('passphrases do not match');
    }
  } else {
    throw passphraseError(defaultFile
      ? `no passphrase source: set BUNDLE_PASSPHRASE_FILE, run in a terminal, or have the human place ${DEFAULT_PASSPHRASE_REL} (mode 0600)`
      : 'no passphrase source: run in a terminal or set BUNDLE_PASSPHRASE_FILE');
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  raw = raw.replace(/\r?\n$/, '').normalize('NFKC');
  if (raw.length === 0) throw passphraseError('passphrase is empty');
  if (minLength && [...raw].length < minLength) throw passphraseError(`passphrase must be at least ${minLength} characters`);
  if (io) io.addSecret(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// SQLite helpers (better-sqlite3 is loaded lazily so the format code has no native dependency)

function loadSqlite(hintDirs = []) {
  const candidates = [];
  if (process.env.BUNDLE_SQLITE_MODULE) {
    candidates.push(process.env.BUNDLE_SQLITE_MODULE);
    candidates.push(path.join(process.env.BUNDLE_SQLITE_MODULE, 'better-sqlite3'));
  }
  candidates.push('better-sqlite3');
  candidates.push(path.resolve(__dirname, '..', '..', 'resourcer', 'node_modules', 'better-sqlite3'));
  for (const d of hintDirs) if (d) candidates.push(path.join(d, 'node_modules', 'better-sqlite3'));
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new BundleError('better-sqlite3 is not available (run npm install in resourcer/, or set BUNDLE_SQLITE_MODULE to its directory)', EXIT.ERROR, 'ESQLITE');
}

const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const WATERMARK_COLUMNS = {
  candidates: ['created_at', 'zoho_pushed_at', 'pulled_date'],
  candidate_rejections: ['rejected_at'],
  territory_searches: ['last_searched'],
  reed_daily_usage: ['date'],
  run_results: ['completed_at', 'started_at', 'date', 'created_at'],
};

function normaliseStamp(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/.exec(String(s || ''));
  return m ? `${m[1]}T${m[2] || '00:00:00'}` : null;
}

// Returns { integrity, journalMode, tables:{name:count}, watermark } for a file or an in-memory buffer.
function inspectDatabase(Database, source) {
  const db = source.buffer
    ? new Database(source.buffer)
    : new Database(source.file, { readonly: true, fileMustExist: true, timeout: 30000 });
  try {
    const rows = db.pragma('integrity_check');
    const integrity = rows.length === 1 && rows[0].integrity_check === 'ok' ? 'ok' : `failed (${rows.length} problem(s) reported)`;
    const journalMode = String(db.pragma('journal_mode', { simple: true }));
    const tables = {};
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const name of names) tables[name] = db.prepare(`SELECT count(*) AS c FROM ${quoteIdent(name)}`).get().c;
    let watermark = null;
    for (const [table, cols] of Object.entries(WATERMARK_COLUMNS)) {
      if (!(table in tables)) continue;
      const have = new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name));
      for (const col of cols) {
        if (!have.has(col)) continue;
        const r = db.prepare(`SELECT max(replace(substr(${quoteIdent(col)}, 1, 19), 'T', ' ')) AS m FROM ${quoteIdent(table)}`).get();
        const norm = normaliseStamp(r.m);
        if (norm && (!watermark || norm > watermark)) watermark = norm;
      }
    }
    return { integrity, journalMode, tables, watermark };
  } finally {
    db.close();
  }
}

// Online, consistent copy of a live database into destFile, normalised to a single self-contained file.
async function snapshotDatabase(Database, srcFile, destFile) {
  const src = new Database(srcFile, { readonly: true, fileMustExist: true, timeout: 30000 });
  try {
    await src.backup(destFile);
  } finally {
    src.close();
  }
  const dst = new Database(destFile, { fileMustExist: true });
  try {
    dst.pragma('journal_mode = DELETE');
  } finally {
    dst.close();
  }
}

// existing/bundle are inspectDatabase results. "Newer" means the existing DB holds data the bundle lacks.
function compareDatabases(existing, bundle) {
  const reasons = [];
  for (const t of DATA_TABLES) {
    const e = existing.tables[t] || 0;
    const b = (bundle.tables && bundle.tables[t]) || 0;
    if (e > b) reasons.push(`${t} has ${e} rows, the bundle has ${b}`);
  }
  const bw = bundle.watermark || null;
  if (existing.watermark && (!bw || existing.watermark > bw)) {
    reasons.push(`latest activity ${existing.watermark} is after the bundle's ${bw || 'none'}`);
  }
  let equivalent = reasons.length === 0 && (existing.watermark || null) === bw;
  if (equivalent) {
    for (const t of DATA_TABLES) {
      if ((existing.tables[t] || 0) !== ((bundle.tables && bundle.tables[t]) || 0)) equivalent = false;
    }
  }
  return { newer: reasons.length > 0, reasons, equivalent };
}

// ---------------------------------------------------------------------------
// Is a pipeline run live in this workspace? Used on the source side (make) and the target side (restore).

const TERMINAL_STATUSES = new Set(['phase1_abandoned', 'complete', 'error', 'phase1_stale']);
const LOCK_LIKE = /\.(run-lock|lock|pid)$/;

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function checkPipelineLive(home, opts = {}) {
  const now = opts.now || Date.now();
  const windowMs = (opts.windowMinutes || 90) * 60000;
  const lockMs = (opts.lockMinutes || 60) * 60000;
  const res = { live: false, reasons: [], stale: [], halt: { present: false, reason: null, since: null } };
  const mins = (ms) => Math.round(ms / 60000);

  const runsDir = path.join(home, 'runs');
  for (const name of safeReaddir(runsDir)) {
    if (!/^(phase1|run)-.*\.json$/.test(name)) continue;
    const file = path.join(runsDir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    // a file untouched for longer than the window plus slack cannot carry a fresh status (keeps a 12k-file runs/ fast)
    if (now - st.mtimeMs > windowMs + 30 * 60000) continue;
    const parsed = readJsonSafe(file);
    let status = null;
    let ts = NaN;
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
      status = String(parsed.value.status || '');
      ts = Date.parse(parsed.value.updatedAt || parsed.value.startedAt || '');
    }
    if (!Number.isFinite(ts)) ts = st.mtimeMs;
    if (parsed.ok && status && TERMINAL_STATUSES.has(status)) continue;
    if (parsed.ok && !status && !name.startsWith('phase1-')) continue;
    const age = now - ts;
    if (age <= windowMs) {
      res.reasons.push(`runs/${name} status=${status || (parsed.ok ? 'none' : 'unreadable')} age=${mins(age)}m`);
    }
  }

  for (const dirName of ['runs', 'runtime']) {
    const dir = path.join(home, dirName);
    for (const name of safeReaddir(dir)) {
      if (!LOCK_LIKE.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const parsed = readJsonSafe(file);
      let pid = null;
      let started = NaN;
      if (parsed.ok) {
        const v = parsed.value;
        if (typeof v === 'number') pid = v;
        else if (v && typeof v === 'object') {
          pid = Number.isInteger(v.pid) ? v.pid : null;
          started = typeof v.startedAt === 'number' ? v.startedAt : Date.parse(v.startedAt || '');
        }
      }
      if (!Number.isFinite(started)) started = st.mtimeMs;
      const age = now - started;
      const alive = pid !== null && pidAlive(pid);
      const label = `${dirName}/${name} pid=${pid === null ? 'unknown' : pid} age=${mins(age)}m`;
      if (age < lockMs && (alive || pid === null)) res.reasons.push(label);
      else res.stale.push(`${label} (stale, ignored)`);
    }
  }

  const haltFile = path.join(home, 'runtime', 'pipeline-halt.json');
  if (fs.existsSync(haltFile)) {
    const h = readJsonSafe(haltFile);
    res.halt.present = true;
    if (h.ok && h.value && typeof h.value === 'object') {
      res.halt.reason = typeof h.value.reason === 'string' ? h.value.reason.slice(0, 120) : null;
      res.halt.since = typeof h.value.since === 'string' ? h.value.since : null;
    }
  }
  res.live = res.reasons.length > 0;
  return res;
}

module.exports = {
  EXIT, BundleError, authError, formatError, verifyError, refusedError, sourceError, passphraseError, usageError,
  FORMAT_VERSION, HEADER_LEN, DEFAULT_CHUNK, DEFAULT_LOG2N, MIN_LOG2N, MAX_LOG2N, MIN_PASSPHRASE, PAUSE_PHRASE,
  DATA_TABLES, DIR_MODES, TERMINAL_STATUSES,
  classifyPath, modeToString, stringToMode,
  safeParseJson, readJsonSafe, hashFile, sha256Buffer, writeAll, pidAlive, utcStamp, fmtBytes, relPathToFs, defaultBundlePath, defaultHome,
  createOutput,
  newHeader, encodeHeader, decodeHeader, deriveKey, bundleKey, effectiveLog2N,
  ChunkWriter, ChunkReader, PlainStream, validateManifest, newManifestBase, writeBundle, scanBundle, checkBundleFile,
  terminalStdin, promptHidden, promptVisible, acquirePassphrase, readDefaultPassphraseFile, DEFAULT_PASSPHRASE_REL,
  loadSqlite, inspectDatabase, snapshotDatabase, compareDatabases,
  checkPipelineLive,
};
