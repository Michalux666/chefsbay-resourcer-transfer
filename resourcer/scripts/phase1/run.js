'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const fsx = require('../lib/fsx');
const { loadConfig } = require('./config');
const { resolveParams, USAGE } = require('./params');
const { normaliseResultsUrl, hasBadEncoding, checkTerritory, isCatererUrl } = require('./url');
const { createBrowser } = require('./browser-adapter');
const { clearForeignBridges, checkGlobalLock, removeOwnBridge } = require('./bridge');
const { validateSession, sessionFile } = require('./session');
const { loadPostcodeMaps } = require('./cities');
const { extractPage, probeEmpty, isExplicitEmpty, loadExtractB64 } = require('./extract');
const { dedupePage } = require('./dedupe');
const { screenPage, sweepStaleInput } = require('./screen');
const { unlockPass } = require('./unlock');
const { writeStatus, loadCheckpoint, writeCheckpoint } = require('./queue');
const { finalise } = require('./finalise');
const { handoff } = require('./handoff');
const { KINDS, markIncomplete, raiseAlert } = require('./incomplete');
const cvHold = require('./cv-hold');
const activity = require('./activity');
const { killAll } = require('./proc');
const { makeOut, clockLondon, runTimestamp, round1, safeText } = require('./util');

let activeCtx = null;

const TS_RE = /^\d{4}-\d{2}-\d{2}-\d{6}$/;

// The run id suffix. An explicit PHASE1_RUN_TIMESTAMP resumes that run (checkpoint recovery). Otherwise a run never
// adopts another run's files: if this second is taken (two starts in the same second) the next free one is used.
function chooseTimestamp(cfg, out) {
  if (cfg.runTimestamp && TS_RE.test(cfg.runTimestamp)) return cfg.runTimestamp;
  const base = Date.now();
  for (let i = 0; i < 60; i++) {
    const ts = runTimestamp(new Date(base + i * 1000));
    const taken = fs.existsSync(path.join(paths.RUNS, `phase1-${ts}.json`)) || fs.existsSync(path.join(paths.DOWNLOADS, `approved-queue-${ts}.json`));
    if (!taken) {
      if (i > 0 && out) out(`NOTE run id collision: using ${ts} instead of the current second`);
      return ts;
    }
  }
  return runTimestamp(new Date(base));
}

function makeState(cfg, out) {
  const timestamp = chooseTimestamp(cfg, out);
  return {
    timestamp,
    startedAt: new Date().toISOString(),
    statusFile: path.join(paths.RUNS, `phase1-${timestamp}.json`),
    queueFile: path.join(paths.DOWNLOADS, `approved-queue-${timestamp}.json`),
    skippedDb: 0,
    skippedReview: 0,
    errors: 0,
    page: 1,
    pagesScraped: 0,
    consecutiveRejections: 0,
    browserRoundtrips: 1,
    totalSeen: 0,
    approved: [],
    screeningModel: 'unknown',
    phase2Status: null,
    apiFailureCount: 0,
    screeningIncomplete: false,
    incompleteRuns: 0,
    incompleteGaveUp: null,
    dbFailStreak: 0,
    dbBroken: false,
    unlockFailStreak: 0,
    pageTimings: [],
    stop: false,
    screenSeq: 0,
    lastStatus: null,
    resultsUrlBase: '',
    scrapingStartedAt: null,
    scrapingStartMs: 0,
    sessionValidationTimeSecs: null,
  };
}

// Moves to the next page and applies the MAX_PAGES stop.
function advancePage(ctx) {
  const { st, p, out } = ctx;
  st.page++;
  if (st.page > p.MAX_PAGES) {
    out(`Reached max page limit (${p.MAX_PAGES})`);
    st.stop = true;
  }
}

// The database cannot be read or written: screening or unlocking on would spend credits on candidates it cannot record.
function stopForBrokenDb(ctx) {
  const { st, p, out } = ctx;
  out('STOPPING Phase 1: candidates.db is not usable - the territory and its pending search are kept');
  markIncomplete(ctx, KINDS.DB_UNAVAILABLE, { bounded: false });
  raiseAlert(ctx, 'critical', 'phase1-db-unavailable', `candidates.db could not be read or written during ${p.JOB_TITLE} ${p.LOCATION} run; Phase 1 stopped before spending more credits. Check the database file and run scripts/preflight-db.js.`);
  st.stop = true;
}

// The page loop: navigate, extract, DB dedupe (PASS 1), AI batch review (PASS 2), unlock + single review (PASS 3).
async function pageLoop(ctx) {
  const { st, p, cfg, out } = ctx;
  let prevSignature = '';
  let sameStreak = 0;
  let consecutiveSkips = 0;

  while (!st.stop) {
    if (cvHold.stopIfBlocked(ctx, `before page ${st.page}`)) break;
    out('');
    out(`--- Page ${st.page} ---`);
    const pageStartMs = Date.now();
    const pageSecs = () => round1((Date.now() - pageStartMs) / 1000);

    const ex = await extractPage(ctx, st.page);
    if (ex.kind === 'skip') {
      st.errors++;
      consecutiveSkips++;
      advancePage(ctx);
      if (!st.stop && consecutiveSkips >= cfg.maxConsecutivePageErrors) {
        out(`STOPPING Phase 1: ${consecutiveSkips} consecutive page failures - browser or page appears broken`);
        markIncomplete(ctx, KINDS.SCRAPE_FAILURE, { bounded: true });
        st.stop = true;
      }
      continue;
    }
    consecutiveSkips = 0;
    const cards = ex.cards;
    // The first results page that loaded shows which filters Caterer applied (docs/ACTIVITY.md): read once, never fails the run.
    await activity.selfCheck(ctx, cards.length);

    out(`Cards on page ${st.page} : ${cards.length}`);
    st.pagesScraped++;
    writeStatus(ctx, 'phase1_running', st.page);

    if (cards.length === 0) {
      // Page 1 with 0 cards is only legitimate exhaustion when the page says so explicitly (remote territories).
      if (st.pagesScraped <= 1) {
        const probe = await probeEmpty(ctx);
        if (isExplicitEmpty(probe)) {
          out(`No cards on page ${st.page} - page explicitly reports 0 candidates: genuine exhaustion for ${p.JOB_TITLE}/${p.LOCATION} (not an error)`);
          st.stop = true;
          break;
        }
        const cause = ex.networkidleTimedOut ? 'networkidle timeout' : 'page returned empty result set despite successful networkidle';
        out(`ERROR no cards on page ${st.page} (${cause}) AND page did not confirm an explicit zero (probe='${safeText(probe, 60)}') - aborting (likely browser session degraded, page failed to load, or selector mismatch)`);
        st.errors++;
        markIncomplete(ctx, KINDS.SCRAPE_FAILURE, { bounded: true });
        st.stop = true;
        break;
      }
      out('No cards - results exhausted');
      st.stop = true;
      break;
    }

    // Pagination safety: the same candidate ids on consecutive pages means the pagination is broken.
    const signature = cards.map((c) => (c && c.id !== undefined && c.id !== null ? String(c.id) : '')).join(',');
    if (signature === prevSignature) {
      sameStreak++;
      out(`WARN repeated page payload detected (streak=${sameStreak})`);
      if (sameStreak >= 3) {
        out('Stopping Phase 1: same candidate set repeated across pages - likely pagination/query issue');
        st.stop = true;
        break;
      }
    } else {
      sameStreak = 0;
      prevSignature = signature;
    }

    st.totalSeen += cards.length;

    const { candidatesForReview, dbFailed } = await dedupePage(ctx, cards);
    if (dbFailed) {
      stopForBrokenDb(ctx);
      break;
    }

    let cardsForUnlock = [];
    if (candidatesForReview.length > 0) {
      const r = await screenPage(ctx, candidatesForReview);
      if (r.action === 'stop') {
        st.pageTimings.push(pageSecs());
        break;
      }
      if (r.action === 'retry') {
        st.pageTimings.push(pageSecs());
        continue;
      }
      cardsForUnlock = r.cardsForUnlock;
    }

    await unlockPass(ctx, cardsForUnlock);

    writeCheckpoint(ctx);

    if (st.dbBroken) {
      stopForBrokenDb(ctx);
      st.pageTimings.push(pageSecs());
      break;
    }

    if (st.stop) {
      st.pageTimings.push(pageSecs());
      break;
    }

    // Short pages are not exhaustion: Caterer can return short pages before later ones still have candidates.
    st.pageTimings.push(pageSecs());
    advancePage(ctx);
  }
}

// Marks a run that died mid-flight as abandoned so the global lock releases at once instead of after 30-60 min.
function markAbandoned(ctx) {
  try {
    if (!ctx || !ctx.st || ctx.st.lastStatus !== 'phase1_running') return;
    writeStatus(ctx, 'phase1_abandoned', ctx.st.page);
  } catch (e) { /* best effort */ }
}

function removeTempFiles(ctx) {
  if (!ctx || !ctx.tempFiles) return;
  for (const f of ctx.tempFiles) fsx.safeUnlink(f);
  ctx.tempFiles.clear();
}

async function run(argv, opts) {
  activeCtx = null;
  const out = opts.out || makeOut();
  const cfg = loadConfig();

  const resolved = resolveParams(argv, out);
  if (resolved.help) { out(USAGE); return 0; }
  if (resolved.exit !== undefined) return resolved.exit;
  const p = resolved.params;

  const norm = normaliseResultsUrl(p.RESULTS_URL);
  for (const n of norm.notes) out(n);

  if (!isCatererUrl(norm.base)) {
    out('BAD_RESULTS_URL: RESULTS_URL must be an https address on caterer.com; the signed-in browser is not sent anywhere else.');
    return 5;
  }

  // A literal %26 in a value: the URL was hand-built with an encoded '&' and Caterer silently returns 0 candidates.
  if (hasBadEncoding(norm.base)) {
    out('BAD_URL_ENCODING: RESULTS_URL has a parameter value containing %26 (URL-encoded &).');
    out('The URL was likely hand-constructed instead of built by build-caterer-results-url.js.');
    out(`URL: ${norm.base}`);
    return 6;
  }

  // LOCATION must match the URL's CurrentLocation or the wrong territory would be scraped (2026-04-17).
  const terr = checkTerritory(norm.base, p.LOCATION);
  if (!terr.ok) {
    out(`TERRITORY_MISMATCH: LOCATION parameter is '${p.LOCATION}' but RESULTS_URL has CurrentLocation='${terr.urlLoc}'`);
    out('Watcher or caller built an inconsistent search. Refuse to scrape the wrong territory.');
    return 4;
  }

  let extractB64;
  try {
    extractB64 = loadExtractB64(path.join(paths.SCRIPTS, 'extract-js.b64'));
    if (!extractB64) throw new Error('file is empty');
  } catch (e) {
    out(`EXTRACT_JS_MISSING: scripts/extract-js.b64 is unreadable (${safeText(e.message, 120)}); restore it from the data bundle`);
    return 1;
  }

  let browserLib = opts.browserLib;
  if (!browserLib) {
    try {
      browserLib = require('../lib/browser');
    } catch (e) {
      out(`FATAL browser library unavailable: ${safeText(e.message, 200)}`);
      return 1;
    }
  }

  const st = makeState(cfg, out);
  const ctx = {
    p, cfg, out, st,
    browser: createBrowser(browserLib, out, cfg),
    extractB64,
    maps: { postcodeMap: new Map(), cityToCounty: new Map() },
    sessionFile: sessionFile(),
    tempFiles: new Set(),
    getHalt: () => require('../lib/pipeline-halt'),
    getLogin: () => require('../caterer-login'),
  };
  activeCtx = ctx;
  st.resultsUrlBase = norm.base;
  st.activity = activity.initial(p, norm.base);

  out(`=== PHASE 1 START: ${clockLondon()} ===`);
  out(`JOB: ${p.JOB_TITLE} in ${p.LOCATION} | ${p.CANDIDATE_COUNT} candidates | CV_LIMIT=${p.CV_LIMIT}`);
  activity.announce(ctx);
  sweepStaleInput();

  const { ownBridge } = clearForeignBridges(ctx);
  const lock = await checkGlobalLock(ctx, ownBridge);
  if (lock.blocked) return 3;

  const sess = await validateSession(ctx);
  if (sess.exit !== undefined) return sess.exit;
  st.sessionValidationTimeSecs = sess.secs;

  fsx.ensureDir(paths.DOWNLOADS);
  fsx.ensureDir(paths.RUNS);

  writeStatus(ctx, 'phase1_running', 0);
  removeOwnBridge(ctx);

  st.approved = loadCheckpoint(ctx);

  st.scrapingStartedAt = new Date().toISOString();
  st.scrapingStartMs = Date.now();

  try {
    ctx.maps = loadPostcodeMaps(path.join(paths.CONFIG, 'postcode-cities.json'));
  } catch (e) {
    out(`WARN postcode-cities.json load failed: ${safeText(e.message, 200)}`);
  }

  try {
    await pageLoop(ctx);
  } catch (e) {
    // The legacy host kept going after non-terminating errors; keep the candidates already unlocked (credits spent).
    out(`FATAL unexpected error in page loop: ${safeText(e && e.stack ? e.stack : e, 900)}`);
    st.errors++;
    markIncomplete(ctx, KINDS.RUN_ERROR, { bounded: true });
  }
  if (!st.screeningIncomplete && !st.incompleteGaveUp && st.pagesScraped === 0 && st.errors > 0) {
    out('NOTE no page was scraped at all - treating the run as ended early, not as a finished territory');
    markIncomplete(ctx, KINDS.SCRAPE_FAILURE, { bounded: true });
  }

  const fin = await finalise(ctx);
  return handoff(ctx, fin);
}

// Runs one phase-1 scrape. Resolves with the process exit code; never rejects.
async function main(argv, opts) {
  const o = opts || {};
  const out = o.out || makeOut();
  try {
    return await run(argv, Object.assign({}, o, { out }));
  } catch (e) {
    out(`FATAL ${safeText(e && e.stack ? e.stack : e, 1200)}`);
    markAbandoned(activeCtx);
    return 1;
  } finally {
    removeTempFiles(activeCtx);
  }
}

function installSignalHandlers() {
  const stop = (sig, code) => () => {
    try { killAll(); } catch (e) { /* best effort */ }
    removeTempFiles(activeCtx);
    markAbandoned(activeCtx);
    process.exit(code);
  };
  process.on('SIGTERM', stop('SIGTERM', 143));
  process.on('SIGINT', stop('SIGINT', 130));
  process.on('SIGHUP', stop('SIGHUP', 129));
  process.on('exit', () => removeTempFiles(activeCtx));
}

module.exports = { main, run, pageLoop, installSignalHandlers, makeState, chooseTimestamp, advancePage, getActiveCtx: () => activeCtx };
