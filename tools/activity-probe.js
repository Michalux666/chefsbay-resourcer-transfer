#!/usr/bin/env node
'use strict';
/**
 * activity-probe.js - what do the "active within" windows really do? READ-ONLY: search pages only. No unlock, no credit, no profile view,
 * no CV, no Zoho, no database. Run it once on the live instance (docs/ACTIVITY.md, docs/OPERATIONS.md): the owner reads the numbers.
 *
 *   node tools/activity-probe.js --job <title> --location <postcode area> --distance <miles> [--source caterer|reed|both] [--dry-run]
 *   node tools/activity-probe.js --recent [<n>]      the window of the last n runs (requested, sent, applied, match, Reed window and limit)
 *
 * Caterer: loads page 1 of the results for the URL the pipeline builds (no LastActivityId) and for every LastActivityId of
 *   config/caterer-activity.json, with the same browser helpers and the same URL normalisation as phase 1, and prints per variant
 *   the parameter, the filter text Caterer says it applied, and the pool count of the page header.
 * Reed: runs the search once for each activityTimeFrame value that reed-search.js knows and prints the total candidate count.
 *
 * It prints counts and fixed strings only: never a name, a card, a snippet or any other page text.
 * It refuses (exit 3) while a pipeline run is in flight or the browser lock is held, and it never signs in: a signed-out browser is reported (exit 4).
 *
 * Exit codes: 0 every variant was read (or --dry-run / --recent), 1 unexpected error, 2 usage or validation error,
 *             3 refused: a pipeline run is in flight or the browser lock is held, 4 not signed in (Caterer) or the Reed token could not be
 *             refreshed: nothing more of that source was probed, 5 some variants could not be read (the others are printed).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'resourcer', 'scripts');
const lib = (name) => require(path.join(SCRIPTS, name));
const search = require('./request-search');

const SOURCES = ['both', 'caterer', 'reed'];
const DEFAULT_RECENT = 5;
const RECENT_CAP = 30;

const USAGE = `Usage: node tools/activity-probe.js --job <title> --location <postcode area> --distance <miles> [options]
       node tools/activity-probe.js --recent [<n>]

Read-only: search pages only, no unlock, no credit, no profile view, no Zoho. Prints counts and fixed strings only.

Options:
  --job <title>        the search title (as the dashboard takes it)
  --location <area>    outward postcode, e.g. FY4
  --distance <miles>   ${search.VALID_DISTANCES ? search.VALID_DISTANCES.join(' | ') : '5 | 10 | 20 | 30 | 40 | 60 | 80'}
  --source <s>         both (default) | caterer | reed
  --dry-run            list the variants, make no request
  --recent [<n>]       print the window of the last n runs (default ${DEFAULT_RECENT}, at most ${RECENT_CAP}) from their results files and exit
  --help               show this text

Exit codes: 0 done, 1 unexpected error, 2 usage or validation error, 3 refused (a pipeline run is in flight or the browser lock is held),
            4 not signed in (Caterer) or Reed token not refreshed, 5 some variants could not be read.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { job: null, location: null, distance: null, source: 'both', dryRun: false, recent: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--job') o.job = val();
    else if (a === '--location') o.location = val();
    else if (a === '--distance') o.distance = val();
    else if (a === '--source') o.source = val();
    else if (a === '--recent') {
      const next = argv[i + 1];
      if (next !== undefined && /^[0-9]+$/.test(next)) { i += 1; o.recent = Math.min(RECENT_CAP, Math.max(1, parseInt(next, 10))); } else o.recent = DEFAULT_RECENT;
    } else throw new UsageError(`unknown option ${a}`);
  }
  return o;
}

// ------------------------------------------------------------------------------------------------ the variants

/** The Caterer pages to load: no parameter first, then every id of the config (in the order of the labels). */
function catererVariants(o) {
  const sa = lib('lib/search-activity');
  const build = lib('build-caterer-results-url');
  const { normaliseResultsUrl } = lib('phase1/url');
  const cfg = o.config || sa.loadCatererConfig();
  const mk = (extra) => normaliseResultsUrl(build.buildResultsUrl(Object.assign({ jobTitle: o.job, location: o.location, distance: o.distance, keywords: '' }, extra)).url).base;
  const out = [{ param: 'none', label: '(no parameter: what a scheduled search sends today)', url: mk({}) }];
  if (!cfg.ok) return { variants: out, configError: cfg.error };
  for (const label of sa.LABELS) {
    const e = cfg.labels[label];
    if (!e || e.id === null) continue;
    out.push({ param: `LastActivityId=${e.id}`, label, url: mk({ activeWithin: label, manual: true, activitySetting: 'manual', activityConfig: cfg }) });
  }
  return { variants: out, configError: null };
}

/** The Reed windows: one search for each distinct activityTimeFrame value of reed-search.js, through the first key that maps to it. */
function reedVariants() {
  const map = lib('reed-search').ACTIVITY_TIMEFRAME_MAP;
  const seen = new Map();
  for (const key of Object.keys(map)) if (!seen.has(map[key])) seen.set(map[key], key);
  return [...seen.entries()].map(([value, key]) => ({ value, key }));
}

// ------------------------------------------------------------------------------------------------ the real adapters

function realDeps() {
  return {
    now: () => new Date(),
    busy() {
      const tick = lib('lib/tick');
      const paths = lib('lib/paths');
      const b = tick.busyState({ home: paths.HOME });
      return b.busy ? { busy: true, why: `a pipeline run is in flight (${b.kind || 'run'})` } : { busy: false };
    },
    acquireBrowser(owner) {
      const launcher = lib('ensure-chrome-cdp');
      const l = launcher.browserLock.acquire(owner, { purpose: 'activity-probe' });
      if (l.acquired) return { ok: true, release: l.release };
      const h = l.holder || {};
      return { ok: false, why: `browser.lock is held by ${h.owner || 'another process'}` };
    },
    caterer: {
      // -> { status: 'ok'|'logged-out'|'unreadable'|'error', applied, total }
      async readPage(url) {
        const sa = lib('lib/search-activity');
        const { createBrowser } = lib('phase1/browser-adapter');
        const { loadConfig } = lib('phase1/config');
        const cfg = loadConfig();
        const browser = createBrowser(lib('lib/browser'), () => {}, cfg);
        const opened = await browser.open(url, 'open probe page');
        if (opened.timedOut) return { status: 'error', applied: '', total: null };
        const waited = await browser.waitNetworkIdle('wait probe page');
        if (waited.timedOut) await new Promise((r) => setTimeout(r, cfg.settleMs));
        const r = await browser.evalB64(sa.SUMMARY_B64, 'read applied filters', cfg.browserMs.probe);
        if (r.timedOut || !r.ok) return { status: 'error', applied: '', total: null };
        const reading = sa.parseSummaryOutput(r.out);
        if (reading.loggedOut) return { status: 'logged-out', applied: '', total: null };
        return { status: reading.readable ? 'ok' : 'unreadable', applied: reading.applied, total: reading.total };
      },
    },
    reed: {
      // -> { ok, reason } ; the Reed browser is started if it is not up, and the token refreshed the way reed-phase1.js does before a run
      async prepare() {
        const launcher = lib('ensure-chrome-cdp');
        const paths = lib('lib/paths');
        const st = await launcher.ensureChrome({ ensureReedTab: true });
        this.started = !!st.launched;
        if (!st.ok) return { ok: false, reason: String(st.marker || 'browser') };
        try {
          const o = execFileSync(paths.NODE, [path.join(SCRIPTS, 'reed-refresh-token.js'), '--force'], { cwd: paths.HOME, timeout: 100000, encoding: 'utf8' });
          return o.includes('REED_TOKEN_REFRESHED') || o.includes('TOKEN_VALID') ? { ok: true } : { ok: false, reason: 'token not refreshed' };
        } catch (e) {
          return { ok: false, reason: /REED_RELOGIN_NEEDED/.test(String((e.stdout || '') + (e.stderr || ''))) ? 'sign-in needed' : 'token not refreshed' };
        }
      },
      // -> { ok, total } | { ok:false, code }
      async count(o, key) {
        try {
          const r = await lib('reed-search').search({ keywords: o.job, location: o.location, distance: o.distance, activeWithin: key, page: 1 });
          return { ok: true, total: Number.isInteger(r.totalCount) ? r.totalCount : null };
        } catch (e) {
          const m = /HTTP (\d{3})/.exec(String(e && e.message));
          return { ok: false, code: m ? `HTTP ${m[1]}` : 'error' };
        }
      },
      async finish() {
        if (this.started && lib('lib/env').get('REED_KEEP_CHROME', '0') !== '1') {
          try { await lib('ensure-chrome-cdp').stopChromeGraceful(); } catch { /* the next pipeline run stops it */ }
        }
      },
    },
  };
}

// ------------------------------------------------------------------------------------------------ --recent

const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/[^A-Za-z0-9 ,.\/&()=:_-]/g, '?').slice(0, 40);

function recentRuns(n, home) {
  const dir = path.join(home || lib('lib/paths').HOME, 'downloads');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^phase2-results-.*\.json$/.test(f)); } catch { names = []; }
  const rows = names.map((f) => { try { return { f, m: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.m - a.m).slice(0, n);
  const lines = [];
  for (const { f } of rows) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { d = null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const a = d.activity;
    const head = `RUN date=${clean(d.date)} location=${clean(d.location)} sources=${clean(d.sources)}`;
    if (!a || typeof a !== 'object') { lines.push(`${head} activity=not-recorded (a run from before the window was recorded)`); continue; }
    const reed = a.reed && typeof a.reed === 'object' ? ` reed_window=${clean(a.reed.activeWithin)} reed_cv_limit=${clean(a.reed.cvLimit)}${a.reed.ran === false ? ' reed_ran=no' : ''}` : '';
    lines.push(`${head} requested="${clean(a.requestedActiveWithin)}" cv_limit=${clean(a.requestedCvLimit)} sent="LastActivityId=${clean(a.sentLastActivityId)}" applied="${clean(a.appliedFilterText)}" match=${clean(a.matched)} pool=${a.poolHeaderCount === null || a.poolHeaderCount === undefined ? '?' : clean(a.poolHeaderCount)}${reed}`);
  }
  return lines;
}

// ------------------------------------------------------------------------------------------------ main

async function main(argv, io, deps) {
  const out = (io && io.out) || ((s) => process.stdout.write(`${s}\n`));
  const err = (io && io.err) || ((s) => process.stderr.write(`${s}\n`));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`ERROR: ${e.message}`);
    err(USAGE);
    return 2;
  }
  if (o.help) { out(USAGE); return 0; }

  if (o.recent !== null) {
    const lines = recentRuns(o.recent, io && io.home);
    out(`# recent runs: ${lines.length}`);
    for (const l of lines) out(l);
    return 0;
  }

  if (!SOURCES.includes(o.source)) { err(`ERROR: --source must be one of ${SOURCES.join(', ')}`); return 2; }
  const checked = search.validateSearch({ jobTitle: o.job, location: o.location, distance: o.distance }, { distance: 20, activeWithin: '1 month', cvLimit: 20, priority: 'low', sources: 'both' }, 'outward');
  if (!checked.ok || o.distance === null || o.distance === undefined) {
    err(`ERROR: ${checked.ok ? 'distance: --distance is required' : `${checked.field}: ${checked.detail}`}`);
    err(USAGE);
    return 2;
  }
  const req = { job: checked.value.jobTitle, location: checked.value.location, distance: checked.value.distance };
  const wantCaterer = o.source === 'both' || o.source === 'caterer';
  const wantReed = o.source === 'both' || o.source === 'reed';

  let cat = null;
  if (wantCaterer) {
    try { cat = catererVariants({ ...req, config: io && io.config }); } catch (e) { err(`ERROR: could not build the Caterer variants: ${String(e.message).slice(0, 120)}`); return 1; }
  }
  const reedList = wantReed ? reedVariants() : [];

  out(`# activity-probe source=${o.source} location=${req.location} distance=${req.distance}mi${o.dryRun ? ' DRY RUN (no request is made)' : ''}`);
  if (cat && cat.configError) out(`NOTE caterer-activity.json is not usable (${cat.configError}): only the no-parameter page is probed`);
  if (o.dryRun) {
    if (cat) for (const v of cat.variants) out(`CATERER variant param=${v.param} label="${v.label}"`);
    for (const v of reedList) out(`REED variant activityTimeFrame=${v.value} key="${v.key}"`);
    out(`# ${cat ? cat.variants.length : 0} Caterer and ${reedList.length} Reed variants; nothing was requested`);
    return 0;
  }

  const d = deps || realDeps();
  const b = d.busy();
  if (b.busy) { err(`REFUSED: ${b.why}. Try again when the pipeline is idle.`); return 3; }

  let failed = 0;
  let notSignedIn = false;

  if (cat) {
    const lock = d.acquireBrowser('caterer');
    if (!lock.ok) { err(`REFUSED: ${lock.why}. Try again when the pipeline is idle.`); return 3; }
    try {
      for (const v of cat.variants) {
        let r;
        try { r = await d.caterer.readPage(v.url); } catch { r = { status: 'error', applied: '', total: null }; }
        if (r.status === 'logged-out') {
          out(`CATERER param=${v.param} label="${v.label}" status=logged-out`);
          out('NOTE the Caterer browser is not signed in: nothing more is probed. The probe never signs in; let the pipeline (or the owner) restore the session first.');
          notSignedIn = true;
          break;
        }
        if (r.status !== 'ok') failed += 1;
        out(`CATERER param=${v.param} label="${v.label}" applied="${clean(r.applied)}" pool=${r.total === null || r.total === undefined ? '?' : r.total} status=${r.status}`);
      }
    } finally { lock.release(); }
  }

  if (reedList.length && !notSignedIn) {
    const lock = d.acquireBrowser('reed');
    if (!lock.ok) { err(`REFUSED: ${lock.why}. Try again when the pipeline is idle.`); return failed ? 5 : 3; }
    try {
      const prep = await d.reed.prepare();
      if (!prep.ok) {
        out(`REED status=not-ready reason="${clean(prep.reason)}"`);
        out('NOTE Reed is not ready: nothing was probed for it. The probe never signs in.');
        notSignedIn = true;
      } else {
        for (const v of reedList) {
          let r;
          try { r = await d.reed.count(req, v.key); } catch { r = { ok: false, code: 'error' }; }
          if (!r.ok) { failed += 1; out(`REED activityTimeFrame=${v.value} key="${v.key}" status=${clean(r.code || 'error')}`); continue; }
          out(`REED activityTimeFrame=${v.value} key="${v.key}" total=${r.total === null || r.total === undefined ? '?' : r.total} status=ok`);
        }
      }
    } finally {
      try { await d.reed.finish(); } catch { /* the next pipeline run stops the browser */ }
      lock.release();
    }
  }

  out(`# done: ${failed} variant(s) could not be read${notSignedIn ? '; a source was not signed in' : ''}`);
  if (notSignedIn) return 4;
  return failed ? 5 : 0;
}

module.exports = { main, parseArgs, catererVariants, reedVariants, recentRuns, realDeps, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ERROR: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
