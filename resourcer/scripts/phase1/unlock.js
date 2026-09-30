'use strict';
const paths = require('../lib/paths');
const fsx = require('../lib/fsx');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');
const { dbWrite, idStr } = require('./db');
const { writeCheckpoint, writeStatus } = require('./queue');
const { argVal, screeningModelFrom } = require('./screen');
const { KINDS, markIncomplete, raiseAlert } = require('./incomplete');
const cvHold = require('./cv-hold');
const cities = require('./cities');
const { safeText, maskEmail, parseFailure } = require('./util');

const ASSERT_TAIL = '} Assertion failed:';
// Unlock output that parsed as a candidate carries name, email and phone: it never goes to a log.
const CANDIDATE_KEYS_RE = /"(email|phone|firstName|lastName|name|cvUrl)"/i;

// caterer-unlock.js prints one JSON line; a runtime shutdown assertion can trail it (Windows-era artefact, harmless).
function extractUnlockJson(rawStr) {
  const lines = rawStr.split('\n').filter((l) => /^\{/.test(l) && /"success"/.test(l));
  const cut = (s) => {
    const ai = s.indexOf(ASSERT_TAIL);
    return ai > 0 ? s.substring(0, ai + 1) : s;
  };
  if (lines.length) return cut(lines[0].trim());
  return cut(rawStr);
}

async function unlockOne(ctx, card) {
  const res = await runNode(scriptPath('caterer-unlock'), [idStr(card.id), String(card.candidateDataValue)], {
    cwd: paths.HOME, timeoutMs: ctx.cfg.timeoutMs.unlock,
  });
  const rawStr = res.stdout + (res.stderr ? `\n${res.stderr}` : '');
  if (res.timedOut || res.error) return { parseError: res.timedOut ? `timeout after ${Math.round(ctx.cfg.timeoutMs.unlock / 1000)}s` : res.error, raw: '' };
  let uData;
  try {
    uData = JSON.parse(extractUnlockJson(rawStr));
    if (uData === null || typeof uData !== 'object') throw new Error('not an object');
  } catch (e) {
    return { parseError: parseFailure(e), raw: rawStr };
  }
  return { uData };
}

function unlockErrorText(u) {
  const raw = String(u.raw || '');
  if (!raw) return safeText(u.parseError, 400);
  if (CANDIDATE_KEYS_RE.test(raw)) return `${u.parseError} (${raw.length} chars of output not logged)`;
  return safeText(raw, 400);
}

// Post-unlock second opinion on the same snippet. The credit is already spent, so every failure approves.
async function reviewSingle(ctx, card, titleStr) {
  const { st, p, cfg, out } = ctx;
  const args = ['--mode', 'single', '--job', argVal(p.JOB_TITLE), '--source', 'caterer', '--run-id', `phase1-${st.timestamp}`, '--single-file', '-'];
  // Snippet, title and first name travel on stdin, never on the command line (visible to other processes of the same user).
  // The card name is the first name only; the reviewer strips it from the snippet before anything leaves the process.
  const payload = { title: String(titleStr === undefined || titleStr === null ? '' : titleStr), snippet: String(card.snippet === undefined || card.snippet === null ? '' : card.snippet) };
  if (card.name && String(card.name).trim()) payload.name = String(card.name).trim();
  const res = await runNode(scriptPath('ai-review'), args, { cwd: paths.HOME, timeoutMs: cfg.timeoutMs.screenSingle, input: JSON.stringify(payload) });

  const raw = `${res.stderr}\n${res.stdout}`;
  st.screeningModel = screeningModelFrom(raw, st.screeningModel);

  let exitCode = res.code;
  if (res.timedOut) exitCode = 3;
  else if ((exitCode === null || exitCode === undefined) && /API_UNAVAILABLE/i.test(raw)) exitCode = 3;

  if (exitCode === 3) {
    out('    WARN post-unlock AI review API unavailable - approving (credit already spent)');
    return { approved: true, reason: 'API unavailable post-unlock - approved conservatively (credit spent)' };
  }
  try {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const jsonLine = lines.find((l) => l.startsWith('{'));
    if (!jsonLine) throw new Error(`Single AI reviewer returned no JSON. Raw: ${lines.join(' | ')}`);
    const result = JSON.parse(jsonLine);
    return { approved: Boolean(result.approved), reason: result.reason ? result.reason : 'Approved' };
  } catch (e) {
    out(`    WARN post-unlock AI review parse error: ${safeText(e.message, 300)} -- approving (credit spent)`);
    return { approved: true, reason: 'Post-unlock parse error -- approved conservatively (credit spent)' };
  }
}

// A run of consecutive unlock failures means the endpoint is blocked or the daily ceiling is reached (2026-06-01, 2026-08-03).
function unlockFailed(ctx) {
  const { st, cfg, p, out } = ctx;
  st.unlockFailStreak = (st.unlockFailStreak || 0) + 1;
  st.errors++;
  if (st.unlockFailStreak < cfg.unlockFailLimit) return false;
  out(`STOPPING Phase 1: ${st.unlockFailStreak} consecutive unlock failures - the unlock endpoint looks blocked or the daily ceiling was reached`);
  markIncomplete(ctx, KINDS.UNLOCK_FAILING, { bounded: true });
  raiseAlert(ctx, 'warn', 'phase1-unlock-failing', `Unlock failed ${st.unlockFailStreak} times in a row during ${p.JOB_TITLE} ${p.LOCATION} run; Phase 1 stopped and the search is kept. Check Caterer credits and the unlock endpoint.`);
  st.stop = true;
  return true;
}

// PASS 3: unlock the approved cards, screen them again, and queue the survivors.
async function unlockPass(ctx, cardsForUnlock) {
  const { st, p, cfg, out } = ctx;
  for (const card of cardsForUnlock) {
    if (st.dbBroken) {
      out('STOPPING unlocks: candidates.db is not usable');
      break;
    }
    // the halt may have been raised by a Phase 2 of another run while this loop was running: no credit is spent after it
    if (cvHold.stopIfBlocked(ctx, 'before an unlock')) break;
    const cardId = idStr(card.id);
    const cardPc = card.postcode;

    // Keeps status.updatedAt moving through a long unlock loop, so the ghost cull never mistakes a live run for a dead one.
    writeStatus(ctx, 'phase1_running', st.page);

    if (st.approved.some((c) => idStr(c.id) === cardId)) {
      out('    SKIP unlock: already in the queue (resumed run)');
      await dbWrite(ctx, ['add', cardId]);
      continue;
    }

    if (!card.candidateDataValue) {
      out('    WARN no candidateDataValue - skip unlock');
      st.errors++;
      continue;
    }

    const u = await unlockOne(ctx, card);
    if (u.parseError) {
      out(`    UNLOCK PARSE ERROR: ${unlockErrorText(u)}`);
      if (unlockFailed(ctx)) break;
      continue;
    }
    const uData = u.uData;
    if (!uData.success) {
      out(`    UNLOCK FAILED: ${safeText(uData.error, 300)}`);
      if (unlockFailed(ctx)) break;
      continue;
    }
    st.unlockFailStreak = 0;
    out(`    UNLOCKED: ${cardId} | ${maskEmail(uData.email)}`);

    // Post-unlock title normalisation: a postcode or empty title is not a role, so derive one for the reviewer.
    let titleStr = uData.jobTitle ? String(uData.jobTitle).trim() : '';
    if (cities.isPostcodeTitle(titleStr) || titleStr === '') {
      let derived = cities.getTitleFromSnippet(card.snippet, uData.name);
      if (!derived) derived = p.JOB_TITLE;
      if (!derived) derived = 'Unknown role (title missing from unlock)';
      out(`    WARN post-unlock title '${safeText(titleStr, 60)}' unusable -> using '${safeText(derived, 80)}' for AI suitability check`);
      titleStr = derived;
      uData.jobTitle = derived;
    }

    const single = await reviewSingle(ctx, card, titleStr);
    if (!single.approved) {
      out(`    REJECTED post-unlock AI: ${single.reason}`);
      st.skippedReview++;
      st.consecutiveRejections++;
      await dbWrite(ctx, ['add', cardId]);
      continue;
    }
    st.consecutiveRejections = 0;

    await fsx.sleep(cfg.unlockPauseMs);

    const city = cities.resolveCity(ctx.maps, uData.jobTitle, cardPc, card.cityRaw);
    const state = cities.getStateFromCity(ctx.maps, city);

    st.approved.push({
      id: card.id,
      name: uData.name,
      firstName: uData.firstName,
      lastName: uData.lastName,
      email: uData.email,
      phone: String(uData.phone === undefined || uData.phone === null ? '' : uData.phone).replace(/\s/g, ''),
      currentTitle: titleStr,
      currentEmployer: '',
      city,
      postcode: cardPc,
      state,
      experience: card.experience,
      encId: uData.encId,
      auditId: uData.auditId,
      cvUrl: uData.cvUrl,
    });
    out(`    QUEUED (${st.approved.length} total)`);
    // The credit is spent: the candidate is durable in the checkpoint BEFORE the database marks it unlocked, so a kill
    // between the two can only cost a repeat unlock (free), never a candidate nobody would push.
    writeCheckpoint(ctx, { quiet: true });
    await dbWrite(ctx, ['add', cardId]);

    if (st.approved.length >= p.CV_LIMIT + 5) {
      out(`Queue size ${st.approved.length} exceeds CV_LIMIT+5 - stopping Phase 1`);
      st.stop = true;
      break;
    }
  }
}

module.exports = { unlockPass, extractUnlockJson, reviewSingle };
