'use strict';
const { dbRun, idStr } = require('./db');
const { psBool, outwardCode, safeText } = require('./util');
const resurface = require('./resurface');

const show = (v) => (v === undefined || v === null ? '' : String(v));

// candidates-db.js check: exit 0 = found, exit 1 with "NEW: <id>" = not found, anything else = the database cannot answer.
function classifyCheck(r, cardId) {
  if (r.timedOut || r.error) return 'error';
  if (r.code === 0) return 'found';
  const wanted = `NEW: ${parseInt(cardId, 10)}`;
  if (r.code === 1 && String(r.stdout).split('\n').some((l) => l.trim() === wanted)) return 'new';
  return 'error';
}

// PASS 1: one batched, job-title-scoped DB query per page (falls back to a per-card check).
// A candidate is skipped only when we already hold the CV or were already judged for THIS job title.
// {dbFailed:true}: the database cannot answer, so the caller stops the run (screening blind would spend credits on known candidates).
async function dedupePage(ctx, cards) {
  const { st, p, out } = ctx;
  const inDbSet = new Set();
  const resurfaceSet = new Set();
  let batchOk = false;

  const pageIds = cards.map((c) => idStr(c && c.id)).join(',');
  if (pageIds) {
    const r = await dbRun(ctx, ['check-batch-scoped', pageIds, p.JOB_TITLE]);
    if (r.code === 0 && !r.timedOut && !r.error) {
      try {
        const line = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).find((l) => /^\{/.test(l));
        if (!line) throw new Error('no JSON line in output');
        const obj = JSON.parse(line);
        if (!Array.isArray(obj.inDb)) throw new Error('inDb is not an array');
        for (const bid of obj.inDb) inDbSet.add(String(bid));
        // the role-scoped second look (only present when it found something): unlocked, rejected for another role, never pushed
        if (Array.isArray(obj.resurface)) for (const rid of obj.resurface) resurfaceSet.add(String(rid));
        if (Number(obj.resurfaceCapped) > 0) resurface.noteCapped(ctx, Number(obj.resurfaceCapped));
        resurface.warnOnce(ctx);
        if (resurfaceSet.size) {
          // the reserve is checked BEFORE the screening: below it (or with the balance unreadable) the people are left skipped, not even screened
          const g = await resurface.gate(ctx);
          if (!g.go) {
            resurface.noteHeld(ctx, g.why, resurfaceSet.size);
            out(`    RESURFACE: ${resurfaceSet.size} candidate(s) left skipped (${g.why === 'unreadable' ? 'the balance could not be read' : 'the balance is below the reserve'}); not screened`);
            for (const rid of resurfaceSet) inDbSet.add(rid); // left skipped, exactly as before the second look existed
            resurfaceSet.clear();
          }
        }
        batchOk = true;
      } catch (e) {
        out(`WARN check-batch parse failed - using per-card check: ${safeText(e.message, 200)}`);
      }
    } else {
      out(`WARN check-batch exit ${r.code === null ? '' : r.code} - using per-card check`);
    }
  }

  const candidatesForReview = [];
  for (const card of cards) {
    const cardId = card.id;
    out(`  [${show(cardId)}] ${outwardCode(card.postcode)} | prev=${psBool(card.unlockedPrev)} never=${psBool(card.neverUnlocked)}`);

    let inDb;
    if (batchOk) {
      inDb = inDbSet.has(idStr(cardId));
    } else if (!parseInt(idStr(cardId), 10)) {
      inDb = false;
    } else {
      const r = await dbRun(ctx, ['check', idStr(cardId)]);
      const verdict = classifyCheck(r, idStr(cardId));
      if (verdict === 'error') {
        out(`FATAL candidates.db check failed (exit ${r.code === null ? 'none' : r.code}${r.timedOut ? ', timeout' : ''}): ${safeText(r.stderr || r.error, 200)}`);
        st.errors++;
        return { candidatesForReview: [], dbFailed: true };
      }
      inDb = verdict === 'found';
    }

    if (inDb) {
      out('    SKIP (in DB)');
      st.skippedDb++;
      continue;
    }

    const again = resurfaceSet.has(idStr(cardId));
    if (again) {
      out('    RESURFACE: unlocked earlier and rejected for another role - screened again for this role');
      resurface.stats(ctx).eligible++;
    }

    candidatesForReview.push({
      id: cardId,
      snippet: card.snippet,
      unlockedPrev: Boolean(card.unlockedPrev),
      neverUnlocked: Boolean(card.neverUnlocked),
      candidateDataValue: card.candidateDataValue,
      postcode: card.postcode,
      cityRaw: card.cityRaw,
      experience: card.experience,
      name: card.name,
      ...(again ? { resurfaced: true } : {}),
    });
  }
  return { candidatesForReview };
}

module.exports = { dedupePage, classifyCheck };
