#!/usr/bin/env node
/**
 * ai-review.js - AI screening for hospitality candidates (Caterer + Reed).
 *
 * The CLI contract of the legacy script is unchanged:
 *   node scripts/ai-review.js --mode batch  --job "Chef" --location "M1" --distance 20 --candidates-file <path>
 *   node scripts/ai-review.js --mode single --job "Chef" --title "Head Chef" --snippet "..."
 *   stdout   batch: [{"id":"...","approved":true,"reason":"..."}, ...] one line, input order
 *            single: {"approved":true,"reason":"..."}
 *            API failure: API_UNAVAILABLE:<detail>
 *   stderr   SCREENING_MODEL: <label>   (on success AND on API failure), API_UNAVAILABLE token on failure
 *   exit     0 ok, 1 usage/input/programming error, 3 API unavailable
 *
 * Engines, criteria and thresholds: docs/SCREENING.md and config/screening.json.
 * caterer-ai-review.js is a thin wrapper around this file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const env = require('./lib/env');
const screening = require('./lib/screening');
const { maybePrune } = require('./lib/screening/shadow');

const VALUE_FLAGS = new Set(['mode', 'job', 'location', 'distance', 'batch-size', 'candidates-file', 'candidates', 'title', 'snippet', 'name', 'source', 'run-id', 'single-file']);
const BOOL_FLAGS = new Set(['help', 'h', 'consume-input', 'with-codes']);

function usageLines() {
  return [
    'Usage:',
    '  node scripts/ai-review.js --mode batch --job "Chef" --location "M1" --distance 20 --candidates-file <path>',
    '  node scripts/ai-review.js --mode single --job "Chef" --title "Head Chef" --snippet "..."',
    '  node scripts/ai-review.js --help',
  ];
}

function helpText() {
  return [
    ...usageLines(),
    '',
    'Options:',
    '  --mode batch|single        Required. Batch screens many candidates; single screens one (post-unlock).',
    '  --job <title>              Job title being searched (default: Chef)',
    '  --location <postcode>      Location for context (default: empty)',
    '  --distance <miles>         Search radius in miles (default: 20)',
    '  --candidates-file <path>   JSON file with [{id, snippet, name?}, ...]; "-" reads stdin',
    '  --consume-input            Delete the candidates file right after reading it',
    '  --with-codes               Add reasonCode to every result object (default: output identical to the legacy shape)',
    '  --candidates <json>        Inline JSON (unsafe in shells; prefer --candidates-file)',
    '  --title <title>            [single mode] Candidate current job title',
    '  --snippet <text>           [single mode] Candidate snippet text',
    '  --name <first name>        Optional first name of the candidate (single mode), used only for redaction',
    '  --single-file <path|->     [single mode] JSON {"title","snippet","name"} read from a file or stdin (-) instead of the three flags above,',
    '                             so the candidate text never appears on the command line',
    '  --source caterer|reed      Optional source label for the shadow log (default: detected from the snippet)',
    '  --run-id <id>              Optional run id for the shadow log',
    '  --batch-size <n>           Accepted and ignored: every candidate is screened individually',
    '',
    'Environment: AI_GATEWAY_API_KEY (required), SCREEN_ENGINE jev_only|llm|jev_shadow|jev (default jev_only: Jev only, no LLM),',
    '  SCREEN_REVIEW_PRE reject|approve and SCREEN_REVIEW_POST approve|reject (what an uncertain Jev answer becomes),',
    '  SCREEN_TIER_MODE legacy|fixed, SCREEN_GATEWAY_ORIGIN. SCREEN_LLM_* apply to the other engines only. See docs/SCREENING.md.',
    '',
    'Exit codes:',
    '  0  Success',
    '  1  General error (usage, unreadable input)',
    '  3  API unavailable after retries',
    '',
  ].join('\n');
}

// Same shape as the legacy parser (--key value, or true when the value is missing), with two safe
// improvements: --key=value, and a value that merely starts with "--" is accepted for value flags
// unless it is itself a known flag.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h') { args.h = true; continue; }
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq > 2) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    const nextIsFlag = typeof next === 'string' && next.startsWith('--') && (VALUE_FLAGS.has(next.slice(2)) || BOOL_FLAGS.has(next.slice(2)));
    if (BOOL_FLAGS.has(key) || next === undefined || nextIsFlag || (!VALUE_FLAGS.has(key) && next.startsWith('--'))) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function trimOuterQuotes(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// Legacy fallback for inline candidates mangled by a shell that stripped the JSON quotes.
function parseMangledCandidates(raw) {
  const text = trimOuterQuotes(raw);
  const objMatches = text.match(/\{[^{}]*\}/g) || [];
  const out = [];
  for (const block of objMatches) {
    const idMatch = block.match(/id\s*:\s*([^,}\]]+)/i);
    const snMatch = block.match(/snippet\s*:\s*([\s\S]*?)\s*$/i);
    const id = idMatch ? trimOuterQuotes(idMatch[1]).trim() : '';
    let snippet = '';
    if (snMatch) {
      snippet = snMatch[1].replace(/[}\]]+\s*$/g, '');
      snippet = trimOuterQuotes(snippet).trim();
    }
    if (id) out.push({ id, snippet });
  }
  return out;
}

function readCandidates(args) {
  const f = args['candidates-file'];
  if (f !== undefined) {
    if (typeof f !== 'string' || !f) throw new screening.UsageError('--candidates-file needs a path');
    const raw = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
    if (args['consume-input'] && f !== '-') {
      try { fs.unlinkSync(path.resolve(f)); } catch (e) { /* already gone */ }
    }
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  }
  if (!args.candidates) return [];
  const raw = String(args.candidates);
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  try { return JSON.parse(trimOuterQuotes(raw)); } catch (e) { /* fall through */ }
  const parsed = parseMangledCandidates(raw);
  if (parsed.length) return parsed;
  throw new screening.UsageError('Unable to parse --candidates JSON; use --candidates-file');
}

// Snippets must never linger on disk: remove leftovers of the legacy temp-file flow (older than 1 h).
function sweepReviewTmp() {
  let n = 0;
  try {
    const cutoff = Date.now() - 3600 * 1000;
    for (const name of fs.readdirSync(paths.DOWNLOADS)) {
      if (!name.startsWith('review-tmp-')) continue;
      const f = path.join(paths.DOWNLOADS, name);
      try {
        const st = fs.statSync(f);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(f); n++; }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* no downloads dir */ }
  return n;
}

function oneLine(s) {
  return env.redact(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();
}

function sourceOf(args) {
  const s = String(args.source && args.source !== true ? args.source : env.get('SCREEN_SOURCE', '')).toLowerCase();
  return s === 'caterer' || s === 'reed' ? s : undefined;
}

function runIdOf(args) {
  const r = args['run-id'] && args['run-id'] !== true ? String(args['run-id']) : env.get('SCREEN_RUN_ID', '');
  return r ? String(r).slice(0, 80) : undefined;
}

function distanceOf(args) {
  const n = Number(args.distance || 20);
  return Number.isFinite(n) ? n : 20;
}

async function runBatch(args, io, cfg, engine) {
  const job = typeof args.job === 'string' && args.job ? args.job : 'Chef';
  const location = typeof args.location === 'string' ? args.location : '';
  const distance = distanceOf(args);
  const all = readCandidates(args);
  if (!Array.isArray(all)) throw new Error('Candidates must be an array');
  all.forEach((c, i) => {
    if (!c || typeof c !== 'object') throw new Error(`Candidate at index ${i} is not an object`);
  });

  io.log(`  [ai-review] Batch screening - engine: ${engine.engine} model: ${engine.engine === 'jev_only' ? cfg.jev.model : cfg.llm.model}`);
  const cands = all.map(c => ({ id: String(c.id || ''), snippet: c.snippet, name: c.name }));
  const { decisions, modelLabel, stats } = await engine.screenBatch({ job, location, distance, source: sourceOf(args), runId: runIdOf(args) }, cands);
  const results = decisions.map((d, i) => (args['with-codes']
    ? { id: cands[i].id, approved: d.approved, reason: d.reason, reasonCode: d.reasonCode }
    : { id: cands[i].id, approved: d.approved, reason: d.reason }));
  await io.out(JSON.stringify(results));
  const policy = stats.engine === 'jev_only' ? ` policy=${stats.policy.total} (reject=${stats.policy.reject} approve=${stats.policy.approve} share=${stats.policy.share}) why=${JSON.stringify(stats.policy.byWhy)}` : '';
  io.log(`  [ai-review] engine=${stats.engine} screened=${stats.total} by=${JSON.stringify(stats.bySource)} invalid=${stats.invalid}${policy}`);
  io.log(`SCREENING_MODEL: ${modelLabel}`);
}

function readSingleInput(args) {
  const f = args['single-file'];
  if (f === undefined) return {};
  if (typeof f !== 'string' || !f) throw new screening.UsageError('--single-file needs a path or -');
  const raw = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
  if (args['consume-input'] && f !== '-') {
    try { fs.unlinkSync(path.resolve(f)); } catch (e) { /* already gone */ }
  }
  const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new screening.UsageError('--single-file must hold a JSON object');
  return j;
}

async function runSingle(args, io, cfg, engine) {
  const job = typeof args.job === 'string' && args.job ? args.job : 'Chef';
  const inp = readSingleInput(args);
  const pick = (key) => (typeof inp[key] === 'string' ? inp[key] : (typeof args[key] === 'string' ? args[key] : undefined));
  const title = pick('title') || '';
  const snippet = pick('snippet') || '';
  const name = pick('name');
  const { decision, modelLabel } = await engine.screenOne(
    { job, location: '', distance: 20, source: sourceOf(args), runId: runIdOf(args) },
    { id: 'single', snippet, title, name },
  );
  await io.out(JSON.stringify(args['with-codes']
    ? { approved: decision.approved, reason: decision.reason, reasonCode: decision.reasonCode }
    : { approved: decision.approved, reason: decision.reason }));
  if (decision.source === 'policy') io.log(`  [ai-review] engine=${engine.engine} single decided by the review policy (${decision.reasonCode})`);
  io.log(`SCREENING_MODEL: ${modelLabel}`);
}

/**
 * @param {string[]} argv
 * @param {{out:(s:string)=>Promise<void>|void, err:(s:string)=>void}} [io]
 * @returns {Promise<number>} exit code
 */
async function main(argv, io) {
  const w = io || {
    out: s => new Promise(resolve => process.stdout.write(s, () => resolve())),
    err: s => { process.stderr.write(s); },
  };
  const lio = { out: w.out, log: m => w.err(`${m}\n`) };
  try {
    const args = parseArgs(argv);
    const mode = String(args.mode || '').toLowerCase();

    if (args.help || args.h) {
      w.err(helpText());
      return 0;
    }
    if (mode !== 'batch' && mode !== 'single') {
      usageLines().forEach(l => lio.log(l));
      return 1;
    }

    const cfg = screening.loadConfig();
    for (const warning of cfg.warnings) lio.log(`WARN screening config: ${warning}`);
    sweepReviewTmp();
    try { maybePrune({ days: cfg.shadow.retentionDays }); } catch (e) { /* best effort */ }

    const engine = screening.createEngine(cfg, { log: lio.log });
    if (mode === 'batch') await runBatch(args, lio, cfg, engine);
    else await runSingle(args, lio, cfg, engine);
    return 0;
  } catch (err) {
    if (err && err.name === 'ScreeningUnavailable') {
      const detail = oneLine(err.detail);
      lio.log(`API_UNAVAILABLE - gateway exhausted. Last error: ${detail}`);
      lio.log(`SCREENING_MODEL: ${err.label || 'none'}`);
      await lio.out(`API_UNAVAILABLE:${detail}`);
      return 3;
    }
    lio.log(`FATAL ${oneLine(err && err.message)}`);
    return 1;
  }
}

// Exit by letting the event loop drain (process.exit() while HTTP handles are still closing crashes
// libuv on Windows). A short unref'd timer forces the exit if something lingers.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

function run() {
  main(process.argv.slice(2)).then(finish, err => {
    process.stderr.write(`FATAL ${oneLine(err && err.message)}\n`);
    finish(1);
  });
}

if (require.main === module) run();

// Kept for callers that required the legacy module for its prompt builders.
module.exports = {
  main,
  run,
  parseArgs,
  readCandidates,
  runBatch,
  runSingle,
  buildBatchPrompt: screening.rubric.buildBatchPrompt,
  buildSinglePrompt: screening.rubric.buildSinglePrompt,
};
