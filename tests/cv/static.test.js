'use strict';
// Code standards (docs/DESIGN.md section 9) for the shipped files of the CV stage, and the two rules of the brief that a test can
// check: no job-title table or regular expression in code, and no model but Jev.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CV_DIR = path.join(ROOT, 'resourcer', 'scripts', 'lib', 'cv');

function walk(dir, out, filter) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, out, filter);
    else if (!filter || filter(p)) out.push(p);
  }
  return out;
}

const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const cvFiles = walk(CV_DIR, [], f => /\.(js|json)$/.test(f) && !/[\\/]vendor[\\/]/.test(f));
// The vendored corpus modules are the reader, redactor and parser used in production. They are exempt from ONE rule only: the job-title
// rule below (their lexicon is a list of occupation words by design; it never decides anything). Every other rule applies to them.
const vendored = walk(path.join(CV_DIR, 'vendor'), [], f => f.endsWith('.js'));
const stubs = walk(path.join(CV_DIR, 'stubs'), [], f => f.endsWith('.js'));
const shipped = [...cvFiles, path.join(ROOT, 'resourcer', 'scripts', 'cv-review.js'), path.join(ROOT, 'resourcer', 'scripts', 'cv-report.js'), path.join(ROOT, 'resourcer', 'config', 'cv-screening.json')];
const jsShipped = shipped.filter(f => f.endsWith('.js'));
const jsAll = [...jsShipped, ...vendored];
const allOwn = walk(path.join(ROOT, 'tests', 'cv'), [...shipped, ...vendored, path.join(ROOT, 'resourcer', 'scripts', 'process-approved-queue.js')], f => f.endsWith('.js'));

const BS = String.fromCharCode(92);
const BANNED = [
  ['C', ':', BS].join(''), ['C', ':/Users'].join(''), ['w', 'sl '].join(''), ['power', 'shell'].join(''), ['pw', 'sh'].join(''),
  ['open', 'claw'].join(''), ['pm', '2'].join(''), ['sch', 'tasks'].join(''), ['187', '89'].join(''), ['WHATS', 'APP'].join(''), ['ng', 'rok'].join(''),
];

test('the stage ships its six vendored modules and three stubs', () => {
  assert.deepEqual(vendored.map(f => path.basename(f)).sort(), ['cv-lexicon.js', 'cv-redact.js', 'date-parse.js', 'pdf-layout.js', 'role-parser.js', 'text-extract.js']);
  assert.deepEqual(stubs.map(f => path.basename(f)).sort(), ['extract-stub.js', 'parse-stub.js', 'redact-stub.js']);
});

test('the shipped source is ASCII only with LF line endings, in every file of the stage (vendored modules included) and its tests', () => {
  const bad = [];
  for (const f of allOwn) {
    const text = fs.readFileSync(f, 'utf8');
    if (/[^\x00-\x7f]/.test(text)) bad.push(`${rel(f)}: not ASCII`);
    if (text.includes('\r')) bad.push(`${rel(f)}: CR`);
  }
  assert.deepEqual(bad, []);
});

test('no banned token (Windows paths, the old platform, chat delivery, tunnels) anywhere in the stage or its tests', () => {
  const bad = [];
  for (const f of allOwn) {
    const s = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const t of BANNED) if (s.includes(t.toLowerCase())) bad.push(`${rel(f)}: ${t}`);
  }
  assert.deepEqual(bad, []);
});

test('no double-backslash literal in the shipped stage (patterns are built from String.raw or the character code)', () => {
  const pair = String.fromCharCode(92, 92);
  assert.deepEqual([...shipped, ...vendored].filter(f => fs.readFileSync(f, 'utf8').includes(pair)).map(rel), []);
});

test('no job-title table or regular expression in code: the shipped JavaScript names no job, level word or industry word', () => {
  const words = /\b(chef|chefs|cook|cooks|porter|commis|sous|waiter|waitress|barista|bartender|baker|pastry|partie|cdp|catering|kitchen|hotel|restaurant|banquet|larder|hospitality)\b/i;
  const found = [];
  for (const f of jsShipped) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (words.test(line)) found.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(found, []);
});

test('Jev only: no other model, no chat-completions route, and nothing that reaches a network except through the screening HTTP helper', () => {
  const found = [];
  for (const f of [...shipped, ...vendored, ...stubs]) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of [/anthropic/i, /claude/i, /\bgpt/i, /openai/i, /gemini/i, /chat\/completions/i, /api\.typesafe\.ai/i, /\bfetch\(/, /require\('(?:https?|net|dns|tls)'\)/]) if (re.test(s)) found.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(found, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CV_DIR, 'defaults.json'), 'utf8')).jev.model, 'typesafe-ai/jev');
});

test('no new dependency: every require is a Node built-in, a relative module, or a package the pipeline already has (pdf-parse, mammoth)', () => {
  const builtin = new Set(['fs', 'path', 'crypto', 'child_process', 'http', 'os', 'zlib', 'worker_threads']);
  const allowed = new Set(['pdf-parse', 'mammoth', 'better-sqlite3']);
  const bad = [];
  for (const f of jsAll) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/require\('([^']+)'\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || builtin.has(name) || allowed.has(name)) continue;
      bad.push(`${rel(f)}: ${name}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('libraries never exit the process and never build a shell string; the only child process is spawned with an argument array', () => {
  const libs = [...cvFiles.filter(f => f.endsWith('.js')), ...vendored];
  const users = [];
  for (const f of libs) {
    const s = fs.readFileSync(f, 'utf8');
    assert.equal(/process\.exit\(/.test(s), false, rel(f) + ' exits the process');
    assert.equal(/shell\s*:\s*true/.test(s), false, rel(f) + ' uses a shell');
    if (s.includes("require('child_process')")) users.push(rel(f));
  }
  assert.deepEqual(users, ['resourcer/scripts/lib/cv/phase2.js']);
  const p2 = fs.readFileSync(path.join(CV_DIR, 'phase2.js'), 'utf8');
  assert.ok(p2.includes("const { spawn } = require('child_process');"));
  assert.ok(p2.includes('spawn(process.execPath, args,'));
});

test('every shipped JavaScript file parses (node --check)', () => {
  for (const f of [...jsAll, path.join(ROOT, 'resourcer', 'scripts', 'process-approved-queue.js')]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel(f)}: ${r.stderr}`);
  }
});

test('no secret or personal data pattern in the shipped files', () => {
  for (const f of [...shipped, ...vendored, ...walk(path.join(ROOT, 'tests', 'cv'), [], x => x.endsWith('.js') && !/(?:fixtures|stage|cli|phase2|adapters|questions|facts|shadow|jev|static)\.test\.js$|helpers/.test(x))]) {
    const s = fs.readFileSync(f, 'utf8');
    assert.equal(/\b(?:vck_|sk-ant-|sk-)[A-Za-z0-9_-]{8,}/.test(s), false, `${rel(f)} looks like it holds a key`);
    assert.equal(/Bearer [A-Za-z0-9._~+/=-]{16,}/.test(s), false, `${rel(f)} holds a bearer token`);
  }
});

test('the shipped config file is the same JSON as the built-in defaults, byte for byte in content', () => {
  const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'resourcer', 'config', 'cv-screening.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(CV_DIR, 'defaults.json'), 'utf8'));
  assert.deepEqual(a, b);
});

test('the merge helper apply-docs.js of the patch is not part of the shipped tree (the shared documents are edited by the release, not by a script)', () => {
  const found = [];
  const skip = new Set(['node_modules', '.git']);
  (function scan(dir) {
    for (const n of fs.readdirSync(dir)) {
      if (skip.has(n)) continue;
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) scan(p);
      else if (n === 'apply-docs.js') found.push(rel(p));
    }
  })(ROOT);
  assert.deepEqual(found, []);
});
