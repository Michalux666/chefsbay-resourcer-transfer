#!/usr/bin/env node
/**
 * cv-review.js - CV screening after the unlock: does the candidate's WHOLE work history fit the role that was searched for?
 *
 *   node scripts/cv-review.js --job "<searched role>" --cv-file <path> [--file-type pdf|docx|doc|rtf|txt]
 *   node scripts/cv-review.js --job "<searched role>" --record-file <json>      (an already parsed, redacted record)
 *   node scripts/cv-review.js --self-test      (no network: the PDF and Word readers on two invented files; one line, CV_SELF_TEST_OK pdf docx)
 *   stdout   one JSON line: {decision, final, lane, forced, confidence, pReject, reasonCodes, finalReasonCodes, policy, evidence, searchLevel, model, ...}
 *            Jev unavailable: API_UNAVAILABLE:<detail>   (no newline, nothing before it: the same contract as ai-review.js)
 *   stderr   SCREENING_MODEL: <label>   (on success AND on failure), the token API_UNAVAILABLE on failure, and then
 *            SCREENING_REASON: unreachable|auth|credits|error|cvconfig   (which fixed halt reason applies; Phase 2 reads it; cvconfig = the criteria file is broken or missing)
 *   exit     0 a decision was made (any decision), 1 usage or internal error, 3 Jev unavailable (or a broken criteria file: nothing is decided)
 *
 * The CV is read from the file, personal data is removed, the work history is structured and only that structured, redacted
 * history goes to Jev. Nothing of the CV or the redacted text is ever written to disk. One aggregate row per decision is
 * appended to shadow/cv-<date>.jsonl (counts, months, codes, numbers, no text; deleted after 180 days).
 * The decision is FORCED CHOICE at one operating point (config operatingPoint): Jev decides pass or reject for practically every CV;
 * "forced" marks a decision taken in real doubt; "review" (lane fallback) is the very rare CV Jev could not settle; "unreadable" passes.
 * Criteria: config/cv-screening.json. Explained for the owner in docs/CV-SCREENING.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const cv = require('./lib/cv');
const { maybePrune } = require('./lib/cv/shadow');

const VALUE_FLAGS = new Set(['job', 'cv-file', 'file-type', 'record-file', 'known-file', 'candidate-id', 'source', 'run-id', 'mode', 'now', 'config']);
const BOOL_FLAGS = new Set(['help', 'h', 'no-shadow', 'prune', 'self-test']);
const FILE_TYPES = ['pdf', 'docx', 'doc', 'rtf', 'txt'];
const MAX_CV_BYTES = 12 * 1024 * 1024;

function usageLines() {
  return [
    'Usage:',
    '  node scripts/cv-review.js --job "<searched role>" --cv-file <path> [--file-type pdf|docx|doc|rtf|txt]',
    '  node scripts/cv-review.js --job "<searched role>" --record-file <json>',
    '  node scripts/cv-review.js --self-test',
    '  node scripts/cv-review.js --help',
  ];
}

function helpText() {
  return [
    ...usageLines(),
    '',
    'Options:',
    '  --job <role>               The role that was searched for (required). Jev works out its level once and remembers it.',
    '  --cv-file <path>           The downloaded CV (pdf, docx, rtf or txt). Read only; nothing about it is written to disk.',
    '  --file-type <type>         Hint only: the type is decided from the file itself.',
    '  --record-file <json>       A parsed, redacted record {roles:[{title,employer,start,end,duties}], qualifications, parseConfidence}.',
    '  --known-file <path|->      JSON {names, emails, phones, postcodes} of the candidate, so they are removed from the CV ("-" reads stdin).',
    '  --candidate-id <id>        Platform id, kept in the shadow row (a pseudonymous number).',
    '  --source caterer|reed      Label for the shadow row.',
    '  --run-id <id>              Run id for the shadow row.',
    '  --mode shadow|on|cli       CV_SCREEN mode to label the shadow row with (Phase 2 passes it; default: from CV_SCREEN, else cli).',
    '  --no-shadow                Do not write the shadow row.',
    '  --config <file>            Criteria file (default config/cv-screening.json).',
    '  --prune                    Only delete shadow rows older than the retention (180 days) and exit.',
    '  --self-test                No network, no key, no config: builds a tiny invented PDF and Word file in memory, runs the real readers on them and prints one line,',
    '                             CV_SELF_TEST_OK pdf docx (exit 0) or CV_SELF_TEST_FAILED <file type>:<reason code> (exit 1). Run it at install: a reader that cannot load',
    '                             (pdf-parse, mammoth) would otherwise turn every PDF into "unreadable", a pass, and only show after ten CVs.',
    '',
    'Environment: AI_GATEWAY_API_KEY (required, read from the profile .env), SCREEN_GATEWAY_ORIGIN, SCREEN_JEV_MODEL, SCREEN_JEV_TIMEOUT_MS,',
    '  SCREEN_MAX_ATTEMPTS, SCREEN_ZDR / SCREEN_JEV_ZDR (as for screening), CV_FALLBACK_POLICY (approve|reject), CV_REJECT_ABOVE (0 to 1),',
    '  CV_SCREEN_CONFIG_FILE, CV_SCREEN_CONCURRENCY. CV_SCREEN (off|shadow|on, default shadow) is read by Phase 2, not by this command.',
    '',
    'Decisions: pass or reject (Jev, forced choice; "forced" in the reason codes marks a decision taken in real doubt), review (the very rare',
    'CV Jev could not settle: lane fallback, settled by config fallback.policy), unreadable (the text could not be read: always passes).',
    '"final" is what happens: approve or reject.',
    '',
    'Exit codes:',
    '  0  a decision was made',
    '  1  usage or internal error',
    '  3  Jev unavailable (API_UNAVAILABLE), or the criteria file config/cv-screening.json is broken or missing (SCREENING_REASON: cvconfig): nothing is decided',
    '',
  ].join('\n');
}

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
    if (BOOL_FLAGS.has(key) || next === undefined || nextIsFlag) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function oneLine(s) {
  return env.redact(String(s === undefined || s === null ? '' : s)).replace(/\s+/g, ' ').trim();
}

function readJsonFile(f, what) {
  if (typeof f !== 'string' || !f) throw new cv.UsageError(`${what} needs a path`);
  const raw = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
  const j = JSON.parse(raw.replace(/^\ufeff/, ''));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new cv.UsageError(`${what} must hold a JSON object`);
  return j;
}

function fileTypeOf(args) {
  if (args['file-type'] === undefined) return undefined;
  const t = String(args['file-type']).toLowerCase();
  if (!FILE_TYPES.includes(t)) throw new cv.UsageError(`--file-type must be one of ${FILE_TYPES.join(', ')}`);
  return t;
}

/**
 * @param {string[]} argv
 * @param {{out:(s:string)=>Promise<void>|void, err:(s:string)=>void, ctx?:object}} [io]  ctx: extra screenCv context (tests: a fake Jev, a fixed clock)
 * @returns {Promise<number>} exit code
 */
async function main(argv, io) {
  const w = io || {
    out: s => new Promise(resolve => process.stdout.write(s, () => resolve())),
    err: s => { process.stderr.write(s); },
  };
  const log = m => w.err(`${m}\n`);
  try {
    const args = parseArgs(argv);
    if (args.help || args.h) { w.err(helpText()); return 0; }
    if (args['self-test']) {
      const selftest = require('./lib/cv/selftest');
      const st = await selftest.run();
      await w.out(`${selftest.line(st)}\n`);
      return st.ok ? 0 : 1;
    }

    const cfg = cv.loadConfig(args.config && args.config !== true ? { file: String(args.config), fileRequired: true } : undefined);
    for (const warning of cfg.warnings) log(`WARN cv config: ${warning}`);
    try { maybePrune({ days: cfg.shadow.retentionDays }); } catch (e) { /* best effort */ }
    if (args.prune) return 0;

    const job = typeof args.job === 'string' ? args.job : '';
    if (!job.trim()) { usageLines().forEach(log); return 1; }
    const cvFile = typeof args['cv-file'] === 'string' ? args['cv-file'] : '';
    const recordFile = typeof args['record-file'] === 'string' ? args['record-file'] : '';
    if ((!cvFile && !recordFile) || (cvFile && recordFile)) { usageLines().forEach(log); return 1; }

    const known = args['known-file'] ? readJsonFile(args['known-file'], '--known-file') : {};
    const ctx = {
      cfg,
      known,
      log,
      candidateId: typeof args['candidate-id'] === 'string' ? args['candidate-id'] : undefined,
      source: args.source === 'caterer' || args.source === 'reed' ? args.source : undefined,
      runId: typeof args['run-id'] === 'string' ? args['run-id'].slice(0, 80) : undefined,
      mode: ['shadow', 'on', 'cli'].includes(args.mode) ? args.mode : undefined,
      ...(io && io.ctx ? io.ctx : {}),
    };
    if (args['no-shadow']) ctx.shadow = null;
    if (typeof args.now === 'string' && Number.isFinite(Date.parse(args.now))) ctx.now = new Date(args.now);

    const req = { searchRole: job, ctx };
    if (recordFile) req.record = readJsonFile(recordFile, '--record-file');
    else {
      const st = fs.statSync(path.resolve(cvFile));
      if (!st.isFile() || st.size > MAX_CV_BYTES) throw new cv.UsageError('--cv-file must be a regular file of at most 12 MB');
      req.fileBuffer = fs.readFileSync(path.resolve(cvFile));
      req.fileType = fileTypeOf(args);
    }

    const r = await cv.screenCv(req);
    const { answers, ...printable } = r;
    await w.out(`${JSON.stringify(printable)}\n`);
    log(`  [cv-review] decision=${r.decision} final=${r.final} lane=${r.lane}${r.forced ? ' forced' : ''}${typeof r.pReject === 'number' ? ` pReject=${r.pReject}` : ''} codes=${r.finalReasonCodes.join(',')} jevCalls=${r.jevCalls}${r.cached ? ' cached' : ''}`);
    log(`SCREENING_MODEL: ${r.model || (r.jevCalls ? cfg.jev.model : 'none')}`);
    return 0;
  } catch (err) {
    if (err && err.name === 'ScreeningUnavailable') {
      const detail = oneLine(err.detail || err.message);
      log(`API_UNAVAILABLE - gateway exhausted. Last error: ${detail}`);
      log('SCREENING_MODEL: none');
      log(`SCREENING_REASON: ${/^[a-z]{2,20}$/.test(String(err.reasonKey)) ? err.reasonKey : 'error'}`);
      await w.out(`API_UNAVAILABLE:${detail}`);
      return 3;
    }
    log(`FATAL ${oneLine(err && err.message)}`);
    return 1;
  }
}

// Exit by letting the event loop drain (process.exit() while HTTP handles are still closing crashes libuv on Windows);
// a short unref'd timer forces the exit if something lingers.
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

module.exports = { main, run, parseArgs };
