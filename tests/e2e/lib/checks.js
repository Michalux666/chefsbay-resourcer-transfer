'use strict';
// Checks every scenario ends with: planted secrets must not leak, planted personal data must stay in its home.
const fs = require('fs');
const path = require('path');
const U = require('./util');
const D = require('./data');

// Where a secret may legitimately live on disk (relative to the profile).
const SECRET_HOMES = [/^\.env$/, /^workspace\/resourcer\/secrets\//];

const SECRET_VALUES = {
  aiKey: D.SECRETS.aiKey,
  catererPass: D.SECRETS.catererPass,
  zohoClientSecret: D.SECRETS.zohoClientSecret,
  zohoRefresh: D.SECRETS.zohoRefresh,
  zohoAccess: D.SECRETS.zohoAccess,
  zohoFreshAccess: D.SECRETS.zohoFreshAccess,
  reedPass: D.SECRETS.reedPass,
  bundlePassphrase: D.SECRETS.bundlePassphrase,
  backupPassphrase: D.SECRETS.backupPassphrase,
  deadman: 'e2e-deadman-secret-token',
};

function profileFiles(world, extraSkip) {
  return U.walk(world.profile, {
    skipDir: (p) => /\/node_modules$/.test(p) || /\/workspace\/resourcer\/scripts$/.test(p) || (extraSkip && extraSkip(p)),
  });
}

// A .gz (a rotated log) is scanned by its decompressed content too: compression must not hide personal data.
function contentOf(file) {
  const buf = fs.readFileSync(file);
  if (/\.gz$/.test(file)) {
    try { return Buffer.concat([buf, require('zlib').gunzipSync(buf)]); } catch { return buf; }
  }
  return buf;
}

// Every place a planted secret value appears outside its home.
function secretHits(world, opts) {
  const o = opts || {};
  const hits = [];
  for (const f of profileFiles(world)) {
    const rel = path.relative(world.profile, f).split(path.sep).join('/');
    if (SECRET_HOMES.some((re) => re.test(rel))) continue;
    if (o.skip && o.skip.test(rel)) continue;
    let buf;
    try { buf = contentOf(f); } catch { continue; }
    for (const [name, value] of Object.entries(SECRET_VALUES)) {
      if (buf.includes(value)) hits.push({ file: rel, secret: name });
      // JSON-escaped and base64 forms count too
      const b64 = Buffer.from(value).toString('base64');
      if (b64.length > 12 && buf.includes(b64)) hits.push({ file: rel, secret: `${name} (base64)` });
    }
  }
  return hits;
}

// The markers of person n: kind -> string
function markers(n) {
  const p = D.person(n);
  return { name: p.first, surname: p.last, email: p.email, phone: p.phone, cv: p.cvMarker, snippet: p.snippetMarker };
}

// Personal data of the 11 synthetic people found anywhere under the profile, minus the allowed homes.
// allow: array of { kinds: ['name',...], re: /relative path/ }
function personHits(world, allow) {
  const hits = [];
  const a = allow || [];
  const all = [];
  for (const c of D.CANDIDATES) for (const [kind, value] of Object.entries(markers(c.n))) all.push({ n: c.n, kind, value });
  for (const f of profileFiles(world)) {
    const rel = path.relative(world.profile, f).split(path.sep).join('/');
    let buf;
    try { buf = contentOf(f); } catch { continue; }
    for (const m of all) {
      if (!buf.includes(m.value)) continue;
      if (a.some((x) => x.re.test(rel) && (!x.kinds || x.kinds.includes(m.kind)))) continue;
      hits.push({ file: rel, n: m.n, kind: m.kind });
    }
  }
  return hits;
}

const fmtHits = (h) => h.slice(0, 12).map((x) => `${x.file} (${x.secret || `${x.kind} #${x.n}`})`).join('; ') + (h.length > 12 ? ` ... ${h.length} in all` : '');

function modeOf(p) { try { return fs.statSync(p).mode & 0o777; } catch { return null; } }

// Files that must not exist at all after a run + sweep
function strayFiles(world) {
  const out = [];
  for (const f of profileFiles(world)) {
    const rel = path.relative(world.profile, f).split(path.sep).join('/');
    if (/(^|\/)review-tmp-/.test(rel)) out.push(rel);
    if (/workspace\/resourcer\/downloads\/(cv-|candidate-)/.test(rel)) out.push(rel);
    if (/workspace\/resourcer\/runtime\/screening-input\//.test(rel)) out.push(rel);
    if (/\.(tmp|partial)$/.test(rel) && /workspace\/resourcer\/(downloads|runs|runtime|state|shadow)\//.test(rel)) out.push(rel);
  }
  return out;
}

module.exports = { SECRET_VALUES, secretHits, personHits, markers, fmtHits, modeOf, strayFiles, profileFiles };
