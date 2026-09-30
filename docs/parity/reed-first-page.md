# Parity: the Reed first-page failure (HTTP 400, RequiredHeaderMissingException, code 50010)

Update D, written 2026-09-30. Owner files: `resourcer/scripts/{reed-browser-fetch,reed-refresh-token,reed-api-client,reed-phase1,run-pipeline,process-approved-queue,territory-utils,reed-download}.js`, `plugin/resourcer/dashboard/{plugin_api.py,dist/index.js}` (`dist/style.css` is not changed: the failure badge reuses an existing class), `tools/reed-catchup.js`, `tests/reed/{first-page,first-page-phase1,first-page-phase2,catchup}.test.js`, `tests/e2e/16-reed-first-page.e2e.js`, this file. The changed contract is R29 to R33 in `docs/parity/reed.md`; the operator side is `docs/OPERATIONS.md` section 8.1.

Nothing in this file was measured on the live Reed site. Everything marked PROVEN was shown against the repository fakes (a fake Reed API and a fake Chromium speaking CDP). Everything marked INFERENCE is reasoning from the operator's log audit. Everything marked UNVERIFIED-LIVE needs the real site.

## 1. What was observed (operator audit, live instance, 2026-09-30 17:50 to 18:28 London, `RESOURCER_SOURCES=both`)

- 33 Reed attempts in 38 minutes: 20 with a real pool, 1 genuine "Total pool: 0 candidates", 12 that failed on the FIRST search page with `Reed API POST HTTP 400: ... RequiredHeaderMissingException, code 50010, Required header is missing or unavailable`.
- Every attempt launched a fresh Chromium (`CDP_LAUNCHING` 33 of 33, no reuse).
- In 11 of the 12 failures the log said `Token seeded from reed-session.json` (the saved token was valid); in 1 it said `Session file token expired or missing`, then `Token refreshed and seeded into browser`. No `Token refresh failed`, no `WARNING: No valid token available`, no "no Reed tab". `Using tab` and `Navigating to trigger Auth0 token` (the forced refresh that opens every Reed run) appear in failures and successes alike.
- No separation by the gap since the previous attempt (failures 27 to 120 s, successes 20 to 332 s), by overlap with Phase 2, or by token age. Login is healthy (`runtime/reed-status.json` ok; an earlier canary pushed 9 Reed candidates). One saved session had about 4.5 minutes of life (obtained 18:43:50, expires 18:48:24); the code treats a token with less than 5 minutes left as not valid.
- The 12 failures were then logged as "Reed produced no queue - merging with empty Reed to record both-source attempt" and stored as Reed errors 0, shown on the dashboard as OK with pool 0: a failed attempt could not be told from an empty search, and the territory silently lost its Reed half.

## 2. The old request path, and where it could lose the token

`reed-refresh-token.js --force` (run first by every Reed run) navigates the tab to the search page and captures the bearer from the page's own first API request, then exits, leaving the page still loading. `reed-phase1.js` then runs the search in a NEW process. Before this update that process (1) checked `window.__capturedReedToken` (always missing in a fresh document), (2) seeded the variable from the session file in one `Runtime.evaluate` (or, when the file token had less than 5 minutes left, ran a second navigate-capture first), and (3) in another `Runtime.evaluate` sent the request with `'Bearer ' + (window.__capturedReedToken || '')`. Nothing tied step 2 to step 3; a missing token only logged a WARNING and the request was sent with an empty bearer.

## 3. The hypotheses, ranked

| | Hypothesis | My ranking and reason |
|---|---|---|
| H1 | A navigation or SPA reload replaces the document after the seed and before the POST, so the variable is gone and the bearer is empty. | MOST LIKELY (inference), in its timing variant "the tab has only just loaded". Every attempt runs in a fresh browser whose tab navigated seconds before (33 of 33), which is the window in which a page redirects or reloads itself; failures and successes differ only in whether the page settled before or after the seed, which fits 12 and 20 with no correlation to gap, overlap or token age. The 12th failure navigated the tab a second time immediately before the seed. The message "required header is missing" is what an empty bearer would produce, but that is the one thing the logs cannot show (see 6). |
| H2 | The POST fires before the page has finished something the real app adds (a header, a cookie, a Cloudflare token), so the API sees a header missing although the bearer is non-empty. | SECOND. Same timing signature as H1, so the logs cannot separate them. Nothing contradicts it. |
| H3 | A real non-token header the app sends is absent from the in-page fetch for some request shapes. | UNLIKELY. The same request shape succeeds 20 times out of 33 and every failure was the first page; a shape problem would fail every time. |
| H4 | Another CDP client on the same tab interferes (the refresh step and the search share one tab). | UNLIKELY. The refresh child has exited before the search process starts (`execFileSync`), and several CDP clients on one tab are allowed. |

The fix does not rely on one of them: it makes H1 impossible by construction, makes H2 unlikely by waiting for an idle tab and retrying, and leaves one log line per failed attempt that separates the rest (section 5).

## 4. What changed (R29 to R33 in `docs/parity/reed.md`)

1. No page variable. The token is resolved in Node and embedded (`JSON.stringify`) in the same evaluation as the request. A token that is not a JWT is never sent (`REED_TOKEN_MISSING`). A re-capture that cannot finish does not throw a good token away: the retry is sent with the token still held (this process, else the saved session token when it is a JWT), so a transient 400 is always tried again with a token known to be good.
2. Before a request the tab must be loaded, quiet for `REED_TAB_SETTLE_MS` (1.5 s) and unchanged between two polls, at most `REED_TAB_READY_WAIT_MS` (10 s).
3. HTTP 400 that names RequiredHeaderMissing or 50010 (and a missing token, and a page replaced during the request) is retried: 3 attempts in all, pauses of 1.5 s and 3 s, at most `REED_RETRY_CAP_MS` (45 s) in total, the token captured once more before the second attempt. 401, 403, 429, 451 and everything else are not retried. The cap is checked before each pause, not during an attempt. A persistent 400 answers at once, and 50 back-to-back runs of that case in the fakes took about 8.5 s each (tab wait, three attempts, two pauses, one capture); that is the normal cost of a failed first page. The hard ceiling is looser and is NOT 45 s: each attempt can wait up to 10 s for the tab and up to 30 s for the page to answer (a timeout is not retried), a first token capture can take up to `REED_CAPTURE_TIMEOUT_MS` (45 s) and the re-capture at most what is left of the cap, so a page that hangs can cost on the order of two minutes once, for that page only. Nothing multiplies it by the number of territories, the cost is per Reed page, and the tick's launch and drain rules (docs/OPERATIONS.md section 2) are unchanged.
4. One forensic line per failed attempt (section 5).
5. A first page that still cannot be fetched is a FAILURE (as is a run whose step 2 fetched no search page at all: the same marker with `(no search page could be fetched)`, exit 0, `failed: true` in the queue's stats; some pages failing while others were scraped only raises `errors`): `REED_FIRST_PAGE_FAILED` and exit 1, placeholder queue with `failed: true` and `errors: 1`, results and `run_results` status `failed`, dashboard "Reed failed", alert `reed-first-page-failed` (WARN once per episode, CRITICAL after 5 in a row), streak file. The Caterer half completes and is recorded as before.
6. The territory rule (R31): searched for the Caterer half, marked `reed_pending_since`, one automatic retry the next day, cleared by a good Reed half.
7. `tools/reed-catchup.js` to find and re-queue the territories that lost their Reed half, a few a day, inside Reed's daily view budget. It refuses to queue while Reed is off or held, and two copies started together queue each territory once.
8. Three classifications so that failures are neither hidden nor invented: a place Reed's location lookup cannot find (`No locations found`) is an empty search (`REED_LOCATION_NOT_FOUND`), not a failure; no usable token is a login problem (`token_missing`, the auth path), not a first-page failure; a destroyed page context is never matched against a server answer's text, and after its retries (like `REED_TOKEN_MISSING`) it is not turned into a direct fetch, which would be misread as a relogin.
9. A territory run ahead of its slot keeps its next regular date (before: pushed a whole interval).

The numbers in 2 and 3 (1.5 s, 10 s, 3 attempts, 1.5 s and 3 s, 45 s, 5 in a row) are design defaults chosen for this update. They are not owner decisions and are all settings except the attempt count and the streak.

## 5. The forensic line, and how to read it next time

```
REED_REQUEST_FORENSIC attempt=1/3 status=400 code=50010 headers=Authorization,Content-Type,Accept token=yes len=600-999 path=/recruiter/v2/candidates/search/results sinceNavMs=812 sinceTokenMs=40 navDuringRequest=no readyState=complete
```

| Field | Meaning |
|---|---|
| `attempt=N/3` | which try; `status` the HTTP status or `none`; `code` the API's `errorCode`, `none`, `REED_TOKEN_MISSING`, `REED_NAV_DURING_REQUEST` or `BROWSER_ERROR` |
| `headers` | the NAMES of the request headers sent (never values) |
| `token`, `len` | whether a token was in the request and a coarse size bucket (`<100`, `100-299`, `300-599`, `600-999`, `1000+`) |
| `path` | the tab's URL path (no query string) |
| `sinceNavMs` | milliseconds since the tab's last document load (`performance.now()` in the page) |
| `sinceTokenMs` | milliseconds since this process obtained the token |
| `navDuringRequest` | whether `performance.timeOrigin` changed while the request was in flight (a new document) |
| `readyState` | `document.readyState` when the request finished |

How the next occurrence separates the hypotheses: `token=no` (or `REED_TOKEN_MISSING`) points at the token step; `navDuringRequest=yes` or `REED_NAV_DURING_REQUEST` at H1 in the form "the page was replaced under the request"; `token=yes` with a small `sinceNavMs` (well under the settle time) at H2 (page not ready); `token=yes`, a large `sinceNavMs`, `navDuringRequest=no` and all three header names at H3 or at Reed itself; a failure on attempt 1 that succeeds on attempt 2 or 3 after the pause supports H2. Lines are in `logs/phase1-console-*.log` (each appears once live and once more in the "diagnostic output" tail that `run-pipeline.js` prints for a failed Reed child).

## 6. What was proven in the fakes, and what was not

PROVEN in the fakes (`tests/reed/first-page*.test.js`, `tests/e2e/16-reed-first-page.e2e.js`):

- The harness reproduces the live signature: the fake API answers an absent or empty bearer with 400 and the code 50010 body; a document replacement between the seed and the POST (`wipeTokenAfterSeed`, or a reload after the 1st or 2nd evaluation) made the UNMODIFIED code fail with exactly `Reed API POST HTTP 400: {"errorCode":50010,...}` and the log lines `CDP connected`, `Token seeded from reed-session.json` (the new request-path tests were run first against the unmodified code: 11 of 13 failed, the 2 that passed are the harness check and the 4xx-handling test; that run is recorded in the implementer result, not in the repository).
- With the change the same faults succeed: the token cannot be emptied by a navigation, a still-loading page and a page that answers 400 for its first moments are waited for, an SPA-style second document shortly after load is waited out, transient 400s are retried and succeed on the third attempt with one re-capture, a persistent 400 fails after exactly three attempts and inside the cap, 401/403/429 are sent once, a non-JWT token is never sent, and no token value or part of one is ever logged. Added after review: a re-capture that cannot finish keeps the good token and the retry reaches the API (2 requests instead of 1, and the real 400 after three requests when it never works); a destroyed page context is retried twice and recovers, and after three is `REED_NAV_DURING_REQUEST` with no direct fetch; a 500 whose body mentions a destroyed context is sent once.
- A first page that never works is a failure end to end: marker, exit 1, placeholder, results file, `run_results`, dashboard JSON and page text, alert (warn, critical on the fifth, one per episode, ended by a good first page), streak, territory rule, catch-up listing; a genuine empty pool stays a normal result; 401/403/451 keep their handling; the Caterer half and Zoho counts are unchanged. Also shown: an unsearchable place is an empty search without streak or alert; every search page failing is a failure; some pages failing is not; no usable token is the auth path; two catch-up processes at once queue each territory once; catch-up refuses while Reed is off; an open mark survives a halted or limit run and is still listed; an early run leaves the next regular date.

NOT proven (INFERENCE): that the live failure had an empty bearer (H1); that the live 400 can also occur with a non-empty token (H2); that a page which is `readyState` complete and quiet for 1.5 s is ready for Reed's API; that 3 attempts and 45 s are enough.

UNVERIFIED-LIVE (become acceptance checks, ACCEPTANCE RE08):

- Whether the failure rate after the update is under 2 percent of attempts over a day (target), and whether every failure shows on the dashboard.
- How the real single-page app behaves: a route change inside the page is not a new document and is not seen by `performance.timeOrigin`; `readyState` does not see requests the app makes after load.
- The real API's exact meaning of "required header is missing" (which header), and whether the re-capture navigation (which restarts the page's own start-up) helps or hurts on retry 2.
- That the retry and wait times keep Reed attempts inside the tick on a slow instance.
- The `empty_with_log_failure` category of the catch-up tool reads log text; on the live logs its recall is unknown (rotated logs are invisible).

## 7. Honest limits of the territory rule and the catch-up

- A Reed half that failed is tracked on the territory (`reed_pending_since`) and in `run_results.reed_json`; it is retried once automatically (next day) and otherwise only by `tools/reed-catchup.js --queue N`, which the owner must direct. A catch-up re-runs the whole territory (there is no Reed-only run), so its Caterer half runs again (mostly skipped as known, but it can unlock new candidates and spend credits like any search).
- A run halted by a screening outage, or stopped by Reed's daily view limit, neither sets nor clears the mark (it is not a Reed failure); a territory whose mark is open stays listed by the catch-up through such a run, but a territory without a mark that only ever had such runs is not.
- The dashboard's header Reed chip reads the login state (`runtime/reed-status.json`), which stays `ok` during a first-page outage: it shows the failure count as a hint only. The per-run "Reed failed" badge, the alert and the 18:00 digest line carry the failure.
- The bound on the retries is the one in section 4 (normal cost, and a looser ceiling for a page that hangs).
- `not_run` (Reed held or off) is now visible in `run_results` for runs recorded after the update, and it neither sets nor clears the mark.
- Runs recorded before the update have no status. Caterer-only runs are found through `run_results.sources`; first-page failures recorded as empty searches only through the logs.
