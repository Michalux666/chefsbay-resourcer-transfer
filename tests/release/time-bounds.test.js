'use strict';
// Release integration (STEP 2 e): the time the two updates add to ONE run stays inside the tick drain window. The constants are read from the code
// itself (a changed default fails here), the arithmetic is the one written in docs/OPERATIONS.md section 2 ("What the tick allows a run to add").
//
//   Reed request (update D): a further attempt starts only when the time spent plus its pause is within REED_RETRY_CAP_MS, so the LAST attempt starts at
//   about the cap at the latest; the attempt itself is at most the re-capture budget (2 s once the cap is used up) + the tab wait + one browser
//   evaluation (30 s: the page itself cuts the request off after ANSWER_MS with an AbortController, the CDP timeout is the same value). One Reed request therefore takes at most CAP + 2 s + TAB_WAIT + 30 s = 87 s with the defaults; a first page that cannot be
//   fetched ends the Reed half right there (exit 1). A Reed that hangs on every further page (the page loop goes on after a failed page, 2 s pause
//   each, at most ceil(cvLimit * 10 / 25) pages, 8 for the default 20 CVs) adds at most 7 more requests.
//   Shadow time cap (update C): phase2.shadowMaxSeconds, default 120, once per queue.
//   Tick drain: the launch cutoff (minute 38) and the hard cap (minute 56) leave 18 minutes to finish a run that was launched last.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const num = (src, re, what) => { const m = re.exec(src); assert.ok(m, `${what}: the constant was not found (the code changed: update this test and the docs)`); return Number(m[1]); };

const fetchSrc = read('reed-browser-fetch.js');
const REQUEST_ATTEMPTS = num(fetchSrc, /const REQUEST_ATTEMPTS = (\d+);/, 'REQUEST_ATTEMPTS');
const RETRY_CAP_S = num(fetchSrc, /numEnv\('REED_RETRY_CAP_MS', (\d+)\)/, 'REED_RETRY_CAP_MS') / 1000;
const BACKOFF_S = num(fetchSrc, /numEnv\('REED_RETRY_BACKOFF_MS', (\d+)\)/, 'REED_RETRY_BACKOFF_MS') / 1000;
const TAB_WAIT_S = num(fetchSrc, /numEnv\('REED_TAB_READY_WAIT_MS', (\d+)\)/, 'REED_TAB_READY_WAIT_MS') / 1000;
const EVAL_S = num(fetchSrc, /const ANSWER_MS = (\d+);/, 'ANSWER_MS') / 1000;
const RECAPTURE_MIN_S = num(fetchSrc, /Math\.max\((\d+), cap - \(Date\.now\(\) - start\)\)/, 'the re-capture floor') / 1000;
const PAGE_SIZE = num(read('reed-phase1.js'), /const PAGE_SIZE = (\d+);/, 'PAGE_SIZE');
const PAGE_PAUSE_S = num(read('reed-phase1.js'), /pageFetchFailures\+\+;[\s\S]{0,400}?await sleep\((\d+)\)/, 'the pause after a failed page') / 1000;
const SHADOW_S = JSON.parse(read('lib/cv/defaults.json')).phase2.shadowMaxSeconds;
const { tickLimits } = require(path.join(SRC, 'pipeline-watchdog.js'));

const limits = tickLimits(55, {});
const WINDOW_S = (limits.hardCapMs - limits.cutoffMs) / 1000;
const DEFAULT_CV_LIMIT = 20;

test('one Reed request is bounded by the retry cap plus one last attempt, not by attempts times the answer timeout', () => {
  assert.equal(REQUEST_ATTEMPTS, 3);
  const lastAttemptS = RECAPTURE_MIN_S + TAB_WAIT_S + EVAL_S;
  const oneRequestS = RETRY_CAP_S + lastAttemptS;
  assert.equal(oneRequestS, 87, 'the figure in docs/OPERATIONS.md section 2');
  assert.ok(oneRequestS < REQUEST_ATTEMPTS * (TAB_WAIT_S + EVAL_S) + RETRY_CAP_S, 'the cap really cuts the three-attempt worst case');
  assert.ok(BACKOFF_S * (1 + 2) < RETRY_CAP_S, 'the two pauses fit inside the cap');
});

test('the added worst case of a run (first-page failure, a Reed that hangs on every page, the shadow cap) fits in the window between the launch cutoff and the hard cap', () => {
  assert.equal(limits.cutoffMs, 38 * 60000);
  assert.equal(limits.hardCapMs, 56 * 60000);
  assert.equal(WINDOW_S, 18 * 60);
  const requestS = RETRY_CAP_S + RECAPTURE_MIN_S + TAB_WAIT_S + EVAL_S;
  const pages = Math.ceil(DEFAULT_CV_LIMIT * 10 / PAGE_SIZE);
  assert.equal(pages, 8);
  const firstPageFailureS = requestS; // ends the Reed half
  const everyPageHangsS = requestS + (pages - 1) * (requestS + PAGE_PAUSE_S);
  assert.equal(SHADOW_S, 120);
  assert.equal(firstPageFailureS + SHADOW_S, 207, 'the usual bad case: about 3.5 minutes');
  assert.equal(everyPageHangsS + SHADOW_S, 87 + 7 * 89 + 120, 'the absolute worst case: about 13.8 minutes');
  assert.ok(everyPageHangsS + SHADOW_S < WINDOW_S, `${everyPageHangsS + SHADOW_S} s must stay under the ${WINDOW_S} s drain window`);
});

test('the shipped shadow cap is far below the drain window (a configured value above it is the owner\'s to keep under it)', () => {
  assert.ok(SHADOW_S <= WINDOW_S / 4);
  const cfg = require(path.join(SRC, 'lib/cv/config.js'));
  const big = cfg.load({ file: 'none.json', getEnv: () => undefined, overrides: { phase2: { shadowMaxSeconds: 3600 } } });
  assert.equal(big.phase2.shadowMaxSeconds, 3600, 'accepted: the validated range is 1 to 3600, documented next to the window');
});

test('the page cuts a request that never answers off after the answer bound (the 30 s in the arithmetic above is real, not a hope about the CDP timeout)', async () => {
  assert.match(fetchSrc, /returnByValue: true, awaitPromise: true, timeout: ANSWER_MS/);
  const { buildExpression } = require(path.join(SRC, 'reed-browser-fetch.js'));
  const vm = require('node:vm');
  for (const binary of [false, true]) {
    // a page whose fetch never settles on its own and only rejects when it is aborted (like the browser's)
    const sandbox = {
      performance: { now: () => 5, timeOrigin: 1 }, location: { pathname: '/candidates/search' }, document: { readyState: 'complete' },
      AbortController, setTimeout, clearTimeout, JSON, Math, btoa: (x) => x, Uint8Array, String,
      fetch: (_url, opts) => new Promise((_res, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('The operation was aborted'))); }),
    };
    const started = Date.now();
    const raw = await vm.runInNewContext(buildExpression({ url: 'https://api.example.invalid/x', method: 'POST', headers: { A: 'b' }, bodyStr: '{}', binary, answerMs: 60 }), sandbox);
    const parsed = JSON.parse(raw);
    assert.match(parsed.error, /aborted/);
    assert.ok(Date.now() - started < 5000, 'cut off by the page, not left to the 60 s of the CDP send');
  }
});
