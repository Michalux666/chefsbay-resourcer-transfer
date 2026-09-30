'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const fsx = require('../lib/fsx');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');
const { dbWrite, idStr } = require('./db');
const { safeText } = require('./util');
const { writeStatus } = require('./queue');
const { KINDS, raiseAlert, markIncomplete } = require('./incomplete');

const API_TEXT_RE = /API_UNAVAILABLE|OAuth|Gateway HTTP 5/i;

// A value beginning with "--" would be swallowed as a flag by the reviewer's argument parser.
const argVal = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return s.startsWith('--') ? ` ${s}` : s;
};

const INPUT_DIR = () => path.join(paths.RUNTIME, 'screening-input');
const HALT_REASON = 'AI screening unavailable';
const HALT_REMEDY = 'Check the screening gateway key and credits (AI_GATEWAY_API_KEY in the profile .env) and the provider status page. The watchdog clears this halt itself once screening is healthy.';

// The reviewer only needs id and snippet (plus the first name for redaction); the unlock token stays out.
function reviewRecord(c) {
  return {
    id: c.id, snippet: c.snippet, unlockedPrev: c.unlockedPrev, neverUnlocked: c.neverUnlocked,
    postcode: c.postcode, cityRaw: c.cityRaw, experience: c.experience, name: c.name,
  };
}

// Snippets hold personal data. Default: piped to the reviewer on stdin, nothing touches the disk. 'file' mode (for a reviewer
// without stdin support) writes a 0600 file that lives only for the call and is removed on every exit path
// (ctx.tempFiles and the exit hook in run.js); the reviewer is also told to delete it as soon as it has read it.
function prepareInput(ctx, records) {
  const json = JSON.stringify(records);
  if (ctx.cfg.screenInputMode === 'stdin') return { args: ['--candidates-file', '-'], input: json, cleanup() {} };
  const dir = fsx.ensureDir(INPUT_DIR(), 0o700);
  const file = path.join(dir, `batch-${ctx.st.timestamp}-p${ctx.st.page}-${++ctx.st.screenSeq}.json`);
  fs.writeFileSync(file, json, { mode: 0o600 });
  ctx.tempFiles.add(file);
  return {
    args: ['--candidates-file', file, '--consume-input'],
    input: null,
    cleanup() {
      fsx.safeUnlink(file);
      ctx.tempFiles.delete(file);
    },
  };
}

// Removes leftovers of crashed runs (older than one hour) so no snippet file outlives its run.
function sweepStaleInput(maxAgeMs) {
  try {
    const dir = INPUT_DIR();
    const cutoff = Date.now() - (maxAgeMs || 3600000);
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try { if (fs.statSync(full).mtimeMs < cutoff) fsx.safeUnlink(full); } catch (e) { /* raced */ }
    }
  } catch (e) { /* no directory yet */ }
}

function screeningModelFrom(raw, current) {
  const lines = String(raw).split('\n').filter((l) => /^SCREENING_MODEL:/i.test(l));
  if (!lines.length) return current;
  return lines[lines.length - 1].replace(/^SCREENING_MODEL:\s*/i, '').trim();
}

function raiseHalt(ctx, detail) {
  const { out } = ctx;
  try {
    ctx.getHalt().setHalt(HALT_REASON, detail, { remedy: HALT_REMEDY, blockedRun: true });
    return true;
  } catch (e) {
    out(`WARN could not raise pipeline halt (${safeText(e.message, 200)}) - the watchdog will keep picking territories; investigate scripts/lib/pipeline-halt.js`);
    return false;
  }
}

// Every early stop caused by the reviewer keeps the territory (incomplete), whatever the halt did; a deterministic non-API fault is bounded.
function reviewerFailure(ctx, raw) {
  const { st, p, out } = ctx;
  st.errors++;
  st.stop = true;
  if (API_TEXT_RE.test(raw)) {
    out('CAUSE: AI screening API/auth failure (not a code bug). Check the screening gateway key and credits.');
    const haltOk = raiseHalt(ctx, `The screening reviewer reported an upstream API/auth failure during ${p.JOB_TITLE}/${p.LOCATION}. Every further run would fail the same way, so the queue is held.`);
    markIncomplete(ctx, KINDS.SCREENING_ERROR, { bounded: !haltOk });
    raiseAlert(ctx, 'critical', 'phase1-screening-auth',
      `Screening API/auth down during ${p.JOB_TITLE} ${p.LOCATION} run - no candidates can be reviewed. Pipeline stopped.`);
  } else {
    out('CAUSE: unrecognised reviewer output (possible code bug). Raw output logged above.');
    markIncomplete(ctx, KINDS.SCREENING_ERROR, { bounded: true });
  }
  out('Stopping Phase 1.');
  return { action: 'stop' };
}

// PASS 2: batch AI review of the unseen cards of one page.
// Returns {action:'ok', cardsForUnlock} | {action:'retry'} (same page again) | {action:'stop'} (break the page loop).
async function screenPage(ctx, cands) {
  const { st, p, cfg, out } = ctx;
  const prep = prepareInput(ctx, cands.map(reviewRecord));
  const args = [
    '--mode', 'batch', '--job', argVal(p.JOB_TITLE), '--location', argVal(p.LOCATION),
    '--distance', String(p.DISTANCE_MILES), '--source', 'caterer', '--run-id', `phase1-${st.timestamp}`, '--with-codes',
  ].concat(prep.args);

  out(`HEARTBEAT: AI batch start page ${st.page} (${cands.length} candidates)`);
  const startMs = Date.now();
  const hb = setInterval(() => {
    out(`HEARTBEAT: AI batch in progress (page ${st.page}, ${Math.round((Date.now() - startMs) / 1000)}s elapsed)`);
    writeStatus(ctx, 'phase1_running', st.page);
  }, cfg.heartbeatMs);
  let res;
  try {
    res = await runNode(scriptPath('ai-review'), args, { cwd: paths.HOME, timeoutMs: cfg.timeoutMs.screenBatch, input: prep.input });
  } finally {
    clearInterval(hb);
    prep.cleanup();
  }

  const raw = `${res.stderr}\n${res.stdout}`;
  let aiExit = res.code;
  if (res.timedOut) {
    out(`WARN AI batch timed out after ${Math.round(cfg.timeoutMs.screenBatch / 1000)}s on page ${st.page} - treating as API unavailable`);
    aiExit = 3;
  } else if (aiExit === null || aiExit === undefined) {
    if (/API_UNAVAILABLE/i.test(raw)) aiExit = 3;
  }
  const secs = Math.round((Date.now() - startMs) / 1000);
  out(`HEARTBEAT: AI batch end page ${st.page} (exit=${aiExit === null || aiExit === undefined ? '' : aiExit}, ${secs}s)`);
  st.screeningModel = screeningModelFrom(raw, st.screeningModel);

  if (aiExit === 3) {
    st.apiFailureCount++;
    out(`WARN AI screening API unavailable (page ${st.page}, failure ${st.apiFailureCount}/3)`);
    if (st.apiFailureCount >= 3) {
      out('STOPPING Phase 1: AI screening API down for 3 consecutive pages');
      const haltOk = raiseHalt(ctx, `Screening API failed on 3 consecutive pages during ${p.JOB_TITLE}/${p.LOCATION}. Every further run would fail the same way, so the queue is held.`);
      // Held whether or not the halt could be written; without a halt the hold is bounded so it cannot repeat for ever.
      markIncomplete(ctx, KINDS.SCREENING_UNAVAILABLE, { bounded: !haltOk });
      st.errors++;
      raiseAlert(ctx, haltOk ? 'warn' : 'critical', 'phase1-screening-down',
        `Screening API down during ${p.JOB_TITLE} ${p.LOCATION} run: ${cands.length} candidates on page ${st.page} could not be reviewed. Phase 1 stopped early and the pipeline is halted until screening recovers.`);
      st.stop = true;
      return { action: 'stop' };
    }
    out(`Pausing ${Math.round(cfg.pageRetryPauseMs / 1000)} seconds before retrying page ${st.page}...`);
    await fsx.sleep(cfg.pageRetryPauseMs);
    return { action: 'retry' };
  }

  const reviewMap = new Map();
  let parseError = null;
  try {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    // Log lines start with "[ai-review]"; a result line is "[" followed by "{" or "]".
    const jsonLine = lines.find((l) => /^\[\s*[{\]]/.test(l));
    if (!jsonLine) throw new Error(`AI reviewer returned no JSON output. Raw: ${lines.join(' | ')}`);
    const results = JSON.parse(jsonLine);
    if (!Array.isArray(results)) throw new Error('AI reviewer output is not a JSON array');
    for (const r of results) {
      if (r && typeof r === 'object') reviewMap.set(idStr(r.id), r);
    }
  } catch (e) {
    parseError = e;
  }
  if (parseError) {
    out(`FATAL AI review parse error on page ${st.page}: ${safeText(parseError.message, 800)}`);
    return reviewerFailure(ctx, raw);
  }
  if (aiExit !== 0 && aiExit !== null && aiExit !== undefined) {
    out(`FATAL AI reviewer exited with code ${aiExit} on page ${st.page} although it printed a result`);
    return reviewerFailure(ctx, raw);
  }
  st.apiFailureCount = 0;

  // A missing or system-invalid answer is not a verdict on the candidate: it is neither rejected nor recorded, so it is screened again.
  const isUndecided = (d) => !d || d.reasonCode === 'sys_invalid_result';
  const undecided = cands.filter((c) => isUndecided(reviewMap.get(idStr(c.id))));
  if (reviewMap.size === 0 || (cands.length >= 2 && undecided.length === cands.length)) {
    out(`FATAL AI reviewer gave no usable decision for any of the ${cands.length} candidates on page ${st.page}`);
    return reviewerFailure(ctx, raw);
  }

  const cardsForUnlock = [];
  for (const cand of cands) {
    const decision = reviewMap.get(idStr(cand.id));
    if (isUndecided(decision)) {
      out('    NOT DECIDED: the reviewer result was missing or unusable - not recorded, screened again next time');
      st.errors++;
      continue;
    }
    const approved = Boolean(decision.approved);
    const reason = decision.reason ? decision.reason : 'No review result';
    if (!approved) {
      out(`    REJECTED pre-unlock: ${reason}`);
      await dbWrite(ctx, [cand.unlockedPrev ? 'add' : 'seen', idStr(cand.id)]);
      // Scoped to THIS job title so the candidate stays eligible for other roles (2026-08-03).
      await dbWrite(ctx, ['reject-title', idStr(cand.id), p.JOB_TITLE]);
      st.skippedReview++;
      st.consecutiveRejections++;
      continue;
    }
    out('    APPROVED pre-unlock');
    st.consecutiveRejections = 0;
    cardsForUnlock.push(cand);
  }
  return { action: 'ok', cardsForUnlock };
}

module.exports = { screenPage, sweepStaleInput, screeningModelFrom, argVal, prepareInput, INPUT_DIR, HALT_REASON };
