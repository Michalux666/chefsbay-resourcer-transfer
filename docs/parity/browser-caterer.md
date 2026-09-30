# Parity: browser-caterer (agent-browser wrapper and every Caterer browser-touching script)

Package owner files: `resourcer/scripts/lib/browser.js`, `resourcer/scripts/lib/browser-env.js` (added in the review round, shared with the Reed launcher), `resourcer/scripts/caterer-login.js`, `resourcer/scripts/caterer-preflight.js`, `resourcer/scripts/caterer-browser-fetch.js`, `caterer-check-session.js`, `caterer-cookie-jar.js`, `caterer-download-cv.js`, `caterer-get-credits.js`, `caterer-unlock.js`, `tests/browser/**` (fake agent-browser, fake chromium, smoke script), this file.
Contract: DESIGN 5.1 (wrapper), 5.2 (login), 7, 9, 10; research `agent-browser-linux.md` (call catalogue, D1-D8), `current-system-review.md` 1.4 and 4.1; the incident notes listed under "Incident lessons".

Caterer runs headless in an ephemeral Chrome profile driven by the pinned agent-browser 0.21.0. Nothing in this package needs a display server, `xvfb-run`, a shell, PowerShell or WSL.

## What ships

| File | Role |
|---|---|
| `lib/browser.js` | The only place the agent-browser CLI is spawned. `run(args,{session,timeoutMs,singleAttempt})` plus the six call forms (`open`, `waitNetworkIdle`, `evalB64`/`evalJs`, `getUrl`, `stateSave`, `stateLoad`) and `close`. Also `saveSession`, `isCold`, `verifyVersion`, `status`, `reset`, `countBackends`, the eval decoders, `SITE`, `SESSION_FILE`. |
| `lib/browser-env.js` | Environment decisions shared by `browser.js` (Caterer) and `ensure-chrome-cdp.js` (Reed): the short per-browser `TMPDIR` (`chooseTmpDir`), the Chromium lookup, the flag lists, the London locale, a usable `HOME`, and `diagnose()` (the self-check behind `caterer-preflight.js --check-env`). |
| `caterer-login.js` | The one sign-in implementation: `ensureLoggedIn({allowRelogin})`, `ensureLoggedInDetailed`, `checkLoggedIn`, `login`, `openVerificationLink`, and a CLI. Replaces `caterer-do-login.ps1` and `doInlineLogin()`/`ensureCatererSession()` in `watchdog-runner.js`. |
| `caterer-preflight.js` | Daily pre-flight (`node scripts/caterer-preflight.js`), overnight keep-alive (`--keepalive`), and the read-only browser-environment self-check (`--check-env [--launch]`). Both pre-flight modes stand aside while a pipeline run is in flight. |
| `caterer-get-credits.js` | Credits from the warm DOM, `credits-sync.json`, optional DB row. Same stdout/exit contract. |
| `caterer-browser-fetch.js`, `caterer-unlock.js`, `caterer-download-cv.js` | Unlock and CV download through the signed-in page (node fetch to Caterer stays blocked). |
| `caterer-cookie-jar.js`, `caterer-check-session.js` | HTTP-side helpers (sliding cookie renewal, quick session hint). |

### CLIs

```
node scripts/caterer-login.js [--check] [--force] [--restore-state|--no-restore-state] [--open-link <url>|-] [--json]
   exit 0 ok | 1 unexpected/unknown | 2 SAFELIST_BLOCKED | 3 CRED_* or LOGIN_FAILED | 4 CATERER_MODULE_ERROR | 64 usage
node scripts/caterer-preflight.js [--keepalive] [--reed|--no-reed] [--json]
   exit 0 | 1 error | 2 safe-list | 3 login failed | 4 module error | 5 Reed step failed | 64 usage
node scripts/caterer-preflight.js --check-env [--launch]          PASS/WARN/FAIL/INFO lines, then BROWSER_ENV_OK or BROWSER_ENV_FAIL; exit 0 | 1
   read-only: no sign-in, no agent-browser call, no network; --launch also starts the configured Chromium headless with the production TMPDIR and flags
node scripts/caterer-get-credits.js [--update-db] [--quiet]      stdout: integer or "unknown"; exit 0 or 2 (legacy)
node scripts/caterer-unlock.js <candidateId> <candidateDataValue>  one JSON line; exit 0/1 (legacy)
node scripts/caterer-download-cv.js <encId> <auditId> <outDir> [candidateId]   CV_FILE=<path>; exit 0/1 (legacy)
node scripts/caterer-check-session.js                              valid|expired|unknown; exit 0/1 (legacy)
```

`ensureLoggedIn` resolves to one of the legacy strings `'ok' | 'login' | 'safelist'` plus `'moduleerror' | 'unknown' | 'error'` (a string, like the legacy `ensureCatererSession()`); `ensureLoggedInDetailed` returns `{state, detail, reloggedIn, notes[], suppressed?, marker?}`.

Operator recovery for a safe-list block (also in the critical alert text): `node scripts/caterer-login.js --open-link "<newest emailed TwoFaAuthRedirect link>"` (or `echo "<link>" | ... --open-link -`). The link is validated (https, host `recruiter.caterer.com`, path contains `TwoFaAuthRedirect`), opened in the same warm session, the session is saved, the block state cleared. The token is never echoed.

### Environment variables introduced (for `docs/ENV.md`)

`RESOURCER_AB_BIN` (agent-browser binary; default `<profile>/bin/agent-browser` with the profile derived from the install layout (`RESOURCER_HOME/../..`), then the same under `HERMES_HOME` when that differs, then `<RESOURCER_HOME>/bin/agent-browser`, then `agent-browser` on PATH; a `*.js` path is run through node, which is how the fake works on every OS), `RESOURCER_AB_CHROME_ARGS` (comma separated, replaces the whole list; default `--no-sandbox,--disable-dev-shm-usage,--lang=en-GB`), `RESOURCER_BROWSER_TZ` (default `Europe/London`) and `RESOURCER_BROWSER_LANG` (default `en-GB`; `off` disables either; also used by the Reed launcher), `RESOURCER_FETCH_CACHE` (`no-store` default, `default` restores the plain in-page fetch), `RESOURCER_AB_HEADED` and `RESOURCER_AB_DISPLAY` (documented fallback only: headed mode needs a persistent display), `RESOURCER_AB_IPC_READ_MS` (30000, the CLI's read timeout; tests shrink it), `RESOURCER_AB_NAV_GAP_MS` (5000), `RESOURCER_SLEEP_SCALE` (1; tests set 0), `CATERER_SAFELIST_COOLDOWN_MIN` (60). Read but owned elsewhere: `CHROMIUM_PATH`, `CATERER_SESSION_FILE` (same override `phase1/session.js` honours), `RESOURCER_SOURCES`.
Test-only (fake): `FAKE_AB_DIR`, `FAKE_AB_READ_TIMEOUT_MS`, `FAKE_CHROMIUM_LOG`, `FAKE_CHROMIUM_START_MS`, `FAKE_NO_CDP`.

### Files and directories

`state/ab/` (0700): agent-browser sockets/pids and `nav.json`; `state/t/` (0700, was `state/ab-tmp/`): `TMPDIR` of the daemon, so Chrome's ephemeral profile (`agent-browser-chrome-<uuid>`) lives on the persistent volume, not in `/tmp`. The name is short on purpose: Chromium binds its singleton socket at `$TMPDIR/.org.chromium.Chromium.XXXXXX/SingletonSocket` (46 characters after `TMPDIR`; a Chromium abort with SIGTRAP and no message past 107 in total). With the DESIGN layout (`/opt/data/profiles/resourcer/workspace/resourcer`) `state/t` is 56 characters, so the path is 102 and there are 5 spare. When `TMPDIR + 46 > 107`, or the directory cannot be created, `browser-env.js:chooseTmpDir` moves it to the ephemeral `/tmp/rab-<8 hex of sha256(RESOURCER_HOME)>/t` (the same directory for every process of one install; the only place this package writes outside `state/`, and harmless because the profile is per daemon and never reused). `browser.status().singleton` and `caterer-preflight.js --check-env` report `{pathLen, limit, margin, relocated, reason}`. The Reed browser has its own `state/rt/` (or `/tmp/rab-<hash>/rt`) so the Caterer stale-profile sweep can never remove its socket directory. If `state/ab/<session>.sock` would exceed the 103-byte unix socket limit, or the filesystem cannot bind a socket there (probed once per process with a real bind), the socket dir becomes `/tmp/rab-<8 hex of sha256(RESOURCER_HOME)>` (independent of `TMPDIR`, so every process agrees). `state/caterer-session.json` (0600, same path as `constants.js` `SESSION_PATH`, resolved by env `CATERER_SESSION_FILE`, then `constants.js`, then `state/`), `runtime/caterer-login-state.json` (attempt limiter, alert dedupe; no secrets), `runtime/caterer-preflight.json`, `credits-sync.json` (workspace root, dashboard reads it there).

## `lib/browser.js` (DESIGN 5.1)

- `run(args,{session='caterer',timeoutMs=120000})` -> `{ok, code, out, timedOut}` plus `stdout`, `stderr`, `signal`, `elapsedMs`, `label`, `clamped`, `retryRisk`. Never rejects. `out` is stderr then stdout, trimmed: the legacy `"$err$out".TrimEnd()` of `Invoke-AgentBrowserCmd` (callers that used `execFileSync` parsed stdout only and now read `stdout`).
- Spawn with an argv array, no shell, `stdio ['ignore','pipe','pipe']`, own process group on POSIX. On timeout the whole CLI group is `SIGKILL`ed (`taskkill /T` on Windows) and the promise resolves at once with `Error: TIMEOUT after <n>s (<label>)`. The daemon is never touched: the CLI `setsid()`s it. Verified on the real binary: the daemon and Chrome survive, the next call queues behind the abandoned command.
- Output pipes held open by a grandchild cannot stall the wrapper (resolves 1 s after the CLI exits).
- Environment is rebuilt on every spawn: every inherited `AGENT_BROWSER_*` is removed (this drops `_NATIVE`, `_ENCRYPTION_KEY`, `_SESSION_NAME`, `_STATE`, `_PROFILE` and anything a login profile or Hermes exported), then `AGENT_BROWSER_SOCKET_DIR` (forced), `NO_COLOR=1`, `TMPDIR=state/t` (or the relocated directory), `HOME` (kept when it is a writable directory, else `state/`), `TZ=Europe/London` and `LANGUAGE=en_GB:en`, `AGENT_BROWSER_EXECUTABLE_PATH` (`CHROMIUM_PATH`, else `/usr/bin/chromium`, `/usr/bin/chromium-browser`, else the first line of `/etc/hermes/agent-browser-executable-path` when that file names an existing binary), `AGENT_BROWSER_ARGS`, and `DISPLAY` removed (headless). `AGENT_BROWSER_IDLE_TIMEOUT_MS=0` only if a PATH binary newer than 0.33.1 is found. A PATH binary that is not 0.21.0 raises `AB_VERSION_MISMATCH` on stderr and a warn alert; the pinned copy is preferred by lookup order.
- Calls in one process are serialised (FIFO). A navigation issued by a different process than the previous one waits until 5 s after that process's last `open`/`wait` (2026-07-10 double-navigation incident; `state/ab/nav.json`).
- `singleAttempt:true` (state-changing commands: unlock, login submit) clamps the wrapper timeout to `RESOURCER_AB_IPC_READ_MS - 3000` (27 s) so the CLI's own 30 s read timeout can never fire and re-send the command.
- `stateSave(file)`: temp file, must parse as `{cookies:[]}`, an empty state never replaces a file that has cookies, `chmod 600`, rename. `stateLoad` refuses a missing file without spawning. `saveSession()` is the legacy `Save-CatererSession`: skips when the browser is on `/login` or `SafeListLoginBlocked`.
- `open` only accepts `http(s)://` and `about:blank`. Eval payloads must be base64 and under 120000 characters (Linux limits one argv element to 128 KiB).
- Hygiene helpers: `isCold()`, `status()`, `reset()` (close, then SIGKILL only processes whose command line contains `--user-data-dir=<our state/t>/` or our pid file's daemon, then remove sockets and profiles), `countBackends()` (distinct `agent-browser-chrome-*` profile dirs; more than 1 is the split-backend signature), stale-profile sweep (dirs older than 15 minutes when no daemon socket answers).

## Legacy map

| Legacy | New |
|---|---|
| `phase1-scrape.ps1:133-180` `Invoke-AgentBrowserCmd` (Start-Process, WaitForExit, kill the wsl.exe, `Error: TIMEOUT after Ns (label)`, `$err$out`) | `browser.js:run`, `execCli`, `killTree` |
| `phase1-scrape.ps1:187-197` `Save-CatererSession` | `browser.js:saveSession` (+ `/login` guard, plus safe-list guard, plus empty-state guard) |
| `phase1-scrape.ps1:318-374` session pre-validation (credits, one re-login, browser URL check) | stays in phase 1 (`phase1/session.js`), which calls `ensureLoggedIn` and the CLIs here |
| `caterer-do-login.ps1:20-52` credentials load, `CRED_MISSING/CRED_INVALID/CRED_PLACEHOLDER` exit 3 | `caterer-login.js:loadCredentials` (+ `login` markers), same three markers, same exit 3, before any browser call |
| `caterer-do-login.ps1:57-66` state load of the saved fingerprint cookies | `caterer-login.js:prepareBrowser` (cold-daemon rule, see deviations) |
| `caterer-do-login.ps1:68-78` open `/login`, networkidle, dismiss the banner | `login()`, `DISMISS_JS` |
| `caterer-do-login.ps1:80-103` React-safe fill and submit | `buildFillJs`, `SUBMIT_JS` (native value setter, real `input`/`change` events, JSON string literals) |
| `caterer-do-login.ps1:105-119` post-submit URL, `SAFELIST_BLOCKED` exit 2, `LOGIN_FAILED` exit 3 | `login()` (same markers and exits; settle poll added) |
| `caterer-do-login.ps1:121-125` `state save`, "Login complete", exit 0 | `login()` save through `saveSession`, marker `Login complete`, exit 0 |
| `watchdog-runner.js:214-323` `ensureCatererSession`/`checkLoggedIn`/`doInlineLogin`, results `'ok'|'login'|'safelist'|'error'`, self-heal on anything not `'ok'` | `caterer-login.js:checkLoggedIn`, `ensureLoggedInDetailed` (same strings; `'unknown'` after a heal still means proceed) |
| `watchdog-runner.js:263-275` credential load with placeholder guard | `loadCredentials` (through `lib/caterer-credentials.js` `.load()` plus a local placeholder guard) |
| `watchdog-runner.js:456` 5 s settle gap after the session check | kept by the runner (`settleMs`) and enforced again in `browser.js` (cross-process navigation gap) |
| `caterer-daily-preflight.ps1:11-45` | `caterer-preflight.js` (no Xvfb step; Reed steps optional) |
| `caterer-keepalive.js:25-71` (HTTP GET, 23:00/02:00/05:00) | still shipped by the KEEP package; `caterer-preflight.js --keepalive` is the browser-side equivalent that also persists the renewed cookies |
| `caterer-get-credits.js:25-47, 133-200` `fetchCreditsViaWarmDom`, main | `caterer-get-credits.js:fetchCreditsViaWarmDom`, `main`. Dead code 202-321 (`fetchCreditsViaHttp`, `bash -lc` paths) not ported (research D5) |
| `caterer-browser-fetch.js:24-130` | `caterer-browser-fetch.js` (same exports, now async, in-page abort timers, `singleAttempt`) |
| `caterer-unlock.js:20-137` | `caterer-unlock.js` (same parsing regexes, same JSON line, same exit codes) |
| `caterer-download-cv.js:26-105` | `caterer-download-cv.js` (same URL, extension rules incl. the legacy quirk that a wordprocessingml type is matched by the `doc` branch first, `cv-<id>.<ext>`, `CV_FILE=`) |
| `caterer-check-session.js:30-88` | `caterer-check-session.js:checkSession` (function plus CLI) |
| `caterer-cookie-jar.js:55-164` | `caterer-cookie-jar.js` (identical logic, atomic 0600 write, `isClearCookie` exported) |

## Incident lessons and where each lives

| Note | Lesson | Code | Test |
|---|---|---|---|
| bash -lc backend split 2026-08-02 | one backend per session; the socket dir must not depend on the parent shell | `browser.js:buildEnv/chooseSockDir` force one dir; `countBackends` and the pre-flight backend warning | `browser.test.js` env forcing, login-shell case; `smoke-linux.sh` 13 |
| React-form login 2026-07-01, duplicate copies 2026-07-04 | native setter plus real events; one implementation | `buildFillJs`; the only login code in the tree | `login.test.js` React regression guard (the fake reproduces the failure), `probes.test.js` |
| Fingerprint cookies 2026-07-01, `state load` on a warm session 2026-06-04 | load the saved state before the first navigation of a cold browser, never into a warm one | `prepareBrowser`, `browser.isCold` | `login.test.js` cold+file, control, warm |
| Poisoned session file 2026-06-03, 2026-07-04 | save only from a confirmed signed-in page; clear-cookie directives never merge | `saveSession`, `stateSave`, `isClearCookie`, only-non-redirected-200 rule | `browser.test.js`, `cookiejar-checksession.test.js`, `login.test.js` failed login keeps the file |
| Safe-list 2026-06-11, 08-02..08-04, 09-22 | detect by URL and DOM, never retry (each attempt emails a new link), alert once, recover with the newest link | `finishSafelist`, `attemptGate`, `openVerificationLink`, `SAFELIST_ALERT` | `login.test.js` safe-list, cooldown, stale link, link validation |
| Bad/placeholder credentials 2026-04-12, 2026-08-24 | fail locally before any browser work; do not hammer the account | `loadCredentials`, 10 minute gap, 3 failures pause automatic attempts for 3 hours | `login.test.js` credentials, bad password |
| DNS cache after an outage 2026-08-03 | a stale backend fails name resolution while the host resolves: reset the browser once | `ensureLoggedInDetailed` network branch, `browser.reset` | `login.test.js` stale backend, real outage, rate limit |
| CV Database module error 2026-08-23 | never read a module 500 as "logged out"; do not burn re-logins | `classifyModuleError`, state `moduleerror`, credits stderr `CVDB_MODULE_ERROR` | `login.test.js`, `credits.test.js` |
| Warm-DOM credits 2026-06-04, false negative after re-auth 2026-06-30 | navigate, read `.litCandidatesViewed`, never state load; read again before condemning | `fetchCreditsViaWarmDom` (one 5 s settle re-read) | `credits.test.js` |
| Unlock burst / WAF 2026-06-01 | unlock and CV download go through the browser | `caterer-browser-fetch.js` | `fetch-unlock-cv.test.js` |
| Double navigation 2026-07-10 | 5 s gap between processes | `browser.js:navGap` | `browser.test.js` |
| Empty-result probe lost its backslashes 2026-09-04 (phase 1) | page scripts are unit tested as strings | all page scripts run against the fake DOM | `probes.test.js`, `credits.test.js` regex check |
| Password in ~35 files and transcripts 2026-08-23 | never hard-code, never log | credentials only via `caterer-credentials.js`; `scrubber` removes raw and JSON-escaped forms; embedded with `JSON.stringify` | `login.test.js` password never appears, hostile characters; `hygiene.test.js` |

## Preserved behaviours

- Session name `caterer`, one warm daemon shared by login, credits, scrape, unlock, CV download.
- Exit codes: `caterer-login` 0/2/3 as `caterer-do-login.ps1` (plus 4 and 64); credits 0 or 2 with an integer or `unknown` on stdout; unlock one JSON line and 0/1; CV download `CV_FILE=` and 0/1; check-session `valid|expired|unknown`.
- Markers `SAFELIST_BLOCKED`, `LOGIN_FAILED`, `CRED_MISSING`, `CRED_INVALID`, `CRED_PLACEHOLDER`, `Login complete`, `Starting Caterer fresh login...`, `CATERER_OK`, `CATERER_SAFELIST_BLOCKED`, `CATERER_LOGIN_FAILED`, `REED_OK`, `REED_FAILED`.
- Timeouts of the legacy call sites (search page open/wait 40 s, probe 20 s, state save 60 s, login steps 40/40/20/20/40 s, CV fetch 60 s + 5 s).
- Cookie-jar rules (auth family only, existing names only, no clear-cookie, non-redirected 200 only), `credits-sync.json` fields `{credits, syncedAt, source:'warm-dom'}`, bounds `0 < credits <= 200000`, DB update of the latest `territory_searches` row only when the table exists.
- Unlock/CV parsing regexes and error strings (only the em dash became a hyphen; nothing matches on those strings).

## Deviations (all listed in the result too)

1. **Cold-daemon rule** replaces "always `state load` first" (`caterer-do-login.ps1`) and "never `state load`" (`doInlineLogin`): the saved state is loaded only when `get url` shows a browser with no page (empty or `about:blank`), before its first navigation; never into a warm session; skipped when the state file is unusable. This is research decision 6 and the DESIGN brief.
2. **Browser session check is the authority in the pre-flight.** The legacy pre-flight asked the HTTP `caterer-check-session.js` first and re-logged in whenever it said not valid, although Caterer's bot manager can bounce that request for a healthy session. `caterer-check-session.js` remains as a CLI hint only.
3. **Session saved only after a confirmed sign-in** (legacy `doInlineLogin` saved unconditionally, even when the login had failed). Also never from the safe-list page (legacy guard only covered `/login`) and never an empty state over a non-empty file.
4. **Login result is verified by URL and by the search-page DOM**, and a URL that is blank, on another host, an error page or `/Account/Unauthenticated` is `LOGIN_FAILED` (legacy exited 0 on `about:blank`). A settle poll (up to 6 x 2 s) waits for a slow redirect to leave `/login` before declaring failure.
5. **Attempt limiter** (new): 10 minutes between attempts after a failure, 60 minutes after a safe-list block (`CATERER_SAFELIST_COOLDOWN_MIN`), 3 consecutive failures pause automatic attempts for 3 hours; `--force` overrides. Suppressed attempts return the same state as before (`safelist` or `login`).
6. **New states**: `moduleerror` (session fine, CV Database failing; exit 4, warn alert, no re-login) and a network branch (reset once per 30 minutes).
7. **State probe** extended: `ERRORPAGE` and `[?&]ReturnUrl=` (Caterer's real expired redirect goes to the site root with ReturnUrl and may have no password field) now count as error page / logged out.
8. **Unlock timeout**: reported as `browser-fetch: unlock timed out (not re-sent, to avoid a duplicate unlock)`; the in-page fetch is aborted after `min(timeout, 27 s - 3 s)`. Every in-page fetch has an abort timer (legacy could leave a hung fetch occupying the single daemon).
9. **Credits**: one 5 s re-read before returning "stale" (false negative right after a re-login); a redirect-loop search page prints `CVDB_MODULE_ERROR` on stderr (exit still 2 so phase 1 is unchanged). DB update sets `busy_timeout`. `credits-sync.json` is written atomically.
10. **CV files** are written with mode 0600 through a hidden temp name that does not start with `cv-` (so a reader globbing `cv-<id>.*` never sees a partial file).
11. **Session file location**: `state/caterer-session.json` (matches `constants.js`); legacy was the workspace root. Not bundled, recreated on the target.
12. **Alerts** replace the WhatsApp text for a safe-list block, unusable credentials, repeated login failures, module error, missing browser, session-file mismatch: `notify()` with keys `caterer-safelist` (critical, repeated every 3 h while blocked), `caterer-safelist-cleared`, `caterer-login-failed`, `caterer-cred`, `caterer-cvdb-module`, `caterer-browser-missing`, `caterer-session-file`, `ab-version`, `ab-backends`.
13. **`check-session` treats a redirect to a `ReturnUrl` as expired** (legacy reported `unknown`; both exit 1).
14. **Fill and submit are two evals** with a 300 ms gap (the production inline path did this; `caterer-do-login.ps1` used one). Both carry the `NOFORM` guard and the fallback selectors (`input[type=email]`, first non-hidden input) of the PowerShell script; both run `singleAttempt`.
15. **CV file names** keep only `[A-Za-z0-9_-]` from the candidate id argument (no path separators can reach the file name).
16. **Preflight Reed steps** only run when `RESOURCER_SOURCES` is `reed`/`both` or `--reed`, by calling the Reed package's `ensure-chrome-cdp.js` and `reed-refresh-token.js --force` as child processes.

## Review round 2026-09-30 (container hardening; findings hermes-fit 79/81/83/84/90/91, security-pii 70/74, phase2-reed 20/21)

17. **Chromium singleton socket (hermes-fit 79, HIGH).** Measured with Chrome for Testing 145: `TMPDIR` of 62 characters starts, 63 aborts with SIGTRAP ("Trace/breakpoint trap", no message). The daemon `TMPDIR` was `state/ab-tmp` (61 characters under the DESIGN layout, no slack). It is now `state/t` (56, 5 spare) and `browser-env.js:chooseTmpDir` moves it to `/tmp/rab-<hash>/t` whenever `TMPDIR + 46 > 107` (the 46 is the conservative figure with the leading dot older builds use; 145 has none) or the directory cannot be created. `browser.status().singleton` and `caterer-preflight.js --check-env` show the margin. `smoke-linux.sh` step 18b proves a workspace root far too long for the socket path still starts the real browser.
18. **Chromium flags in a container/microVM (hermes-fit 82/84/85).** Exactly what runs, and why:

| Browser | Flags | Why |
|---|---|---|
| Caterer (agent-browser, headless) | `AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--lang=en-GB` (replace with `RESOURCER_AB_CHROME_ARGS`) plus what agent-browser adds itself (`--headless=new`, `--use-angle=swiftshader-webgl`, `--ozone-platform=headless`, `--password-store=basic`, ...) | `--no-sandbox`: the Chromium sandbox needs unprivileged user namespaces or a setuid helper, which a non-root user in a microVM/container usually lacks, and agent-browser only adds the flag itself when it sees root or Docker markers that Hermes may not show. Accepted risk: a renderer exploit runs as the profile user (docs/SECURITY.md). `--disable-dev-shm-usage`: the size of `/dev/shm` on the instance is unknown; shared memory goes to files under `TMPDIR` instead. `--lang=en-GB`: a UK address with an en-US browser is an avoidable bot signal. No `--disable-gpu`: headless already renders in software. |
| Reed (headed, `xvfb-run -a -s "-screen 0 1920x1080x24"`) | `REED_CHROME_ARGS` (default `--no-sandbox,--disable-dev-shm-usage,--lang=en-GB`) plus the fixed set in reed.md R6 | Same reasons. `--disable-gpu` is NOT in the default: without a GPU device the GPU process falls back to software rendering (measured: 4 real-Chromium acceptance tests pass with the production flag set), while `--disable-gpu` would remove WebGL from the page the Cloudflare/Turnstile check looks at; if a crash loop shows in `logs/reed-chrome.log`, add it with `REED_CHROME_ARGS=--no-sandbox,--disable-dev-shm-usage,--lang=en-GB,--disable-gpu`. |

    Both browsers also get: `TZ=Europe/London` and `LANGUAGE=en_GB:en` (`RESOURCER_BROWSER_TZ`, `RESOURCER_BROWSER_LANG`, `off` disables; measured: the page then reports `Europe/London|en-GB`), a `HOME` that is a writable directory (the inherited one, else `state/`), and their own `TMPDIR` (`state/t`, `state/rt`) instead of Hermes's scratch directory, because `xvfb-run` exits 1 when `TMPDIR` is missing or read-only (measured). The Chromium binary is `CHROMIUM_PATH`, else `/usr/bin/chromium`, `/usr/bin/chromium-browser`, else the path on the first line of `/etc/hermes/agent-browser-executable-path` (Reed also accepts `google-chrome`); `caterer-preflight.js` and `ensure-chrome-cdp.js --status` print which one was chosen.
19. **`HERMES_HOME` no longer decides which `agent-browser` is used (hermes-fit 81).** `browser.js:resolveBin` looks in the profile derived from the install layout first, then in `HERMES_HOME` when that is a different directory. (`lib/env.js` still reads the profile `.env` from `HERMES_HOME` first: core package, reported.)
20. **In-page fetches use `cache: 'no-store'` (phase2-reed 20).** Measured with the real agent-browser 0.21.0 and Chrome 145: a CV fetched with the plain option (server sends `Cache-Control: private`) was found in `Default/Cache/Cache_Data/sqldb0-wal` of the live profile; agent-browser deletes the profile only when the daemon closes, and this daemon stays warm all day. With `no-store` nothing is left (`smoke-linux.sh` 18c checks both, with the plain fetch as control). Side effect to watch on the first live unlock: the browser adds `Cache-Control: no-cache` and `Pragma: no-cache` to those requests; `RESOURCER_FETCH_CACHE=default` restores the plain request.
21. **CV extensions (phase2-reed 21, security-pii 74).** `caterer-download-cv.js` accepts a filename extension only from Phase 2's list (`.pdf .docx .doc .rtf .txt`), otherwise it falls back to the content type and then `.pdf` (exactly the rule of `process-approved-queue.js:guessExtension`); a CV labelled `.odt` used to be written as `cv-<id>.odt`, never found, never attached. The legacy quirk that a wordprocessingml content type is matched by the `doc` branch first is kept (a test pins it).
22. **The daily pre-flight no longer signs in underneath a run (supervision 41, second half).** Both modes stand aside while `lib/tick.js:busyState` reports a run in flight: `CATERER_PREFLIGHT_SKIPPED` / `CATERER_KEEPALIVE_SKIPPED`, exit 0, summary state `skipped`.
23. **`caterer-preflight.js --check-env [--launch]` (hermes-fit 91).** The probes that belong in this package: state directory and `HOME`/`TMPDIR` writable, singleton budgets of both browsers, the Chromium found and its version, `xvfb-run`/`Xvfb`/`xauth` on PATH, and with `--launch` a headless start with the production `TMPDIR` and flags (it waits for `DevToolsActivePort`; `--dump-dom` never exits with `--headless=new` on Chrome for Testing 145). Read-only, no network, no sign-in. The shell probes (memory, disk, shm, Hermes settings, reachability) stay with `tools/preflight.sh`.
24. **`smoke-linux.sh`** now uses a short `/tmp/rsmoke.XXXXXX` directory, needs no `ps` or `pgrep` (a `/proc` scan), looks for `agent-browser` in the layout-derived profile first, accepts the Hermes image's Chromium path file, and adds steps 18b (singleton budget, London locale, long workspace root) and 18c (no cache copy of a fetched CV). Run in WSL with the real pinned binary and Chrome for Testing 145: 29 pass, 0 fail, 2 skip, 3 warn.

## Findings from the real binary (WSL, agent-browser 0.21.0, Chrome for Testing 145, local page only)

- **D7 measured.** A 31 s in-page promise sent with the default (non-single) path returned `CDP command timed out: Runtime.evaluate` after 30.2 s and the page executed it once: the daemon's own CDP evaluate timeout answered before a re-send. So on 0.21.0 a slow `eval` fails rather than being re-sent in the case tried. The race with the CLI's 30 s read timeout is not excluded, which is why state-changing commands still use `singleAttempt` (killed at 27 s, executed exactly once, also verified live).
- A command sent after a timed-out one waits for it in the daemon (measured 9 s behind a 12 s eval) instead of failing.
- **Chrome rewrites its whole command line into one space-joined `/proc/<pid>/cmdline` element** for the main process and every child (1 NUL-separated part). Any process scan must match flags against the joined string. `browser.js` does; see "needs from others" for the Reed launcher.
- The login-shell `AGENT_BROWSER_SOCKET_DIR=/tmp/ab-sockets` on this laptop is overridden by the wrapper (`/tmp/ab-sockets` untouched, one backend of ours).
- Eval output forms, state schema (`cookies`, `origins`), `state load` on a cold daemon restoring cookie and localStorage, exit 1 with a line starting with the cross mark on an eval error, hostile characters in the embedded credentials: all as documented.

## Test tools for other packages

```js
const fake = require('<repo>/tests/browser/fake').create(dir);        // dir: any temp dir
Object.assign(process.env, fake.env({ RESOURCER_HOME: home }));        // RESOURCER_AB_BIN=fake, FAKE_AB_DIR, gap 0, sleep scale 0, IPC 1800
fake.scenario({ site: { login: { mode: 'safelist' } } });              // deep merge into scenario.json
fake.warmLoggedIn();  fake.browser({ loggedIn: false });                // edit the fake browser (daemon) state
fake.calls('eval');  fake.trail();  fake.counters();  fake.events('resend');
```

`site` keys: `credentials`, `login.mode` (`success|badpassword|safelist|safelistUnlessFingerprint|stay`), `loginFormVariant` (`email-type`), `cookieBanner`, `expiredRedirect` (`root|login`), `cvdbModuleError`, `dnsBroken`, `dnsBrokenUntilClose`, `networkidleTimeout`, `credits`, `creditsWidget`, `validToken`, `acceptAnyToken`, `stateLoadLogsOutWarm`, `acceptLoadedAuth`, `fetch[]` (`match`, `status`, `body`/`bodyBase64`, `headers`, `delayMs`, `reject`). Top level: `version`, `stateSaveFails`, `stateSaveGarbage`, `rules[]` (`when:{cmd,argIncludes,scriptIncludes,nth}` `do:{stdout,stderr,code,delayMs,hangMs,spawnChild,spawnGrandchildMs}`).

The fake runs eval scripts in a `vm` against a small DOM with a React-style controlled input (a raw `.value =` assignment is not seen by the form), so the shipped page scripts are exercised, not mocked. `tests/browser/fake/chromium.js` stands in for `/usr/bin/chromium` (CDP HTTP endpoints only, `/json/protocol` without `setRequestInterception`). `tests/browser/helpers.js:buildSandbox` copies the scripts into a throw-away `RESOURCER_HOME` and supplies stand-ins for `constants.js`, `caterer-session-utils.js`, `fetch-with-timeout.js` and `lib/caterer-credentials.js` only when the repo does not have them yet.

## Verification record

- `node --test tests/browser/*.test.js` (a glob: Node 22 does not recurse into a directory argument): 136 tests after the 2026-09-30 review round (19 new in `tmpdir`, `hardening`, `preflight-env`). Windows Node v25.6.1: 128 pass, 8 POSIX-only skipped, 0 fail. WSL Ubuntu 24.04, Node 22.22.1, repo copied to the WSL home: 136 pass, 0 skipped, including real process-group kill, `/proc` scans, unix sockets, the long-path socket fallback. The suite leaves nothing behind (no processes, no `/tmp/rab-*` dirs).
- `tests/browser/smoke-linux.sh` run in WSL against the pinned agent-browser binary (sha256 verified) and Chrome for Testing 145 with a local page: 30 pass, 0 fail, 2 skips (long idle, egress), 2 warnings (this host's login profile sets `AGENT_BROWSER_SOCKET_DIR`; Chrome 145 still has `setRequestInterception`). Run with `bash` in the foreground of ONE shell command: a background job of a shell that has already returned loses its test server to SIGHUP and fails steps 9-17 for that reason only. Without chromium it prints a SKIP line and exits 0 (verified).
- `browser.js` against the real binary and a local page (isolated home, socket dir and `TMPDIR`; the production daemon on that machine was not touched): version pin, cold detection, all six call forms, quoted-string eval form, async fetch, 5000-byte binary round trip, hostile-character fill, state save schema and mode, close then state load, timeout kill, daemon survival, single-attempt clamp, reset.
- Not run anywhere: Caterer or Reed live, Chromium 153 on Debian, the Hermes host (see below).

## Unverified live (acceptance checks)

1. `smoke-linux.sh` on the instance (pinned binary sha, Chromium 153, `xauth`, Reed launcher, `CDP surface` line 21 must read `false true`).
2. Caterer's bot manager with Chromium 153 headless from the datacenter IP (fingerprint differs from Chrome for Testing 145); fallback is `RESOURCER_AB_HEADED=1` with a persistent Xvfb.
3. First real sign-in on the instance: expect a safe-list block once; the alert must arrive and `--open-link` must clear it. Whether the saved fingerprint state avoids the block after a container restart.
4. Hermes reaper/cgroup behaviour toward a `setsid` daemon (`SMOKE_LONG=1` step 19); if the daemon is killed, every tick starts cold and relies on `state load`.
5. `RESOURCER_AB_IPC_READ_MS` default (30000) still matches the CLI read timeout of the installed build.
6. The label text real Chromium 153 prints for name-resolution failures (`ERR_NAME_NOT_RESOLVED` family) and for the search-page redirect loop (`ERR_TOO_MANY_REDIRECTS`), which the login module keys on.
7. The safe-list alert delivery end to end (outbox, delivery cron, quiet hours do not suppress critical).
8. The credential base64 is visible in the CLI's argv for about a second (`eval -b`); acceptable on a single-user container, `eval --stdin` exists in 0.21.0 but is an untested call form.
9. Review round (2026-09-30), none of it observable without the live sites or the instance: whether Chromium 153 from Debian shares the singleton-socket length rule measured on Chrome for Testing 145 (`caterer-preflight.js --check-env --launch` on the instance answers it); whether the browser adding `Cache-Control: no-cache` and `Pragma: no-cache` to the unlock and CV requests (`cache: 'no-store'`) is accepted by Caterer's bot manager (first live unlock and CV download; `RESOURCER_FETCH_CACHE=default` undoes it); whether `TZ=Europe/London` and `--lang=en-GB` help or change the Caterer fingerprint; the `/dev/shm` size and user-namespace availability on the instance (both are covered by `--disable-dev-shm-usage` and `--no-sandbox`, but nothing was run there).

## Needs from others / open issues

- (Done in the Reed package: `ensure-chrome-cdp.js` matches on the joined command line.)
- `lib/env.js:candidateEnvFiles` and the `hermes/scripts/*.sh` wrappers still prefer `HERMES_HOME` over the layout-derived profile (hermes-fit 81): a `HERMES_HOME` that names another profile loads that profile's `.env`. Core/supervision owners.
- `tools/preflight.sh` D6 starts Chromium with `--dump-dom about:blank`, which never exits with `--headless=new` on Chrome for Testing 145 (timeout after 40 s in WSL); use the `DevToolsActivePort` wait (`browser-env.js:launchProbe`) or call `node scripts/caterer-preflight.js --check-env --launch`.
- `docs/SECURITY.md` still names `state/ab-tmp`; the directory is `state/t` (and `state/rt` for Reed).
- `hermes/scripts/resourcer-preflight.sh` prints the last log line, which is always the `BROWSER_STOP_IDLE` line; print the last line matching `^(CATERER_|REED_|AB_|BROWSER_ENV)` instead (supervision 41).
- `watchdog-runner.js:normaliseSession`: map `'moduleerror'` explicitly (exit 11 with reason `cvdb-module`, do not start phase 1); today it falls through to `'unknown'` and the run proceeds until phase 1's credits check fails.
- (Done, supervision package: `resourcer-preflight` at 05:50 and `resourcer-keepalive` at 23:00, 02:00, 05:00 Europe/London are in `hermes/cron/jobs.json`. The integration rehearsal added: the keep-alive stands aside while a pipeline run is in flight, and every pre-flight refreshes `runtime/reed-status.json` through `reed-api-client.js --sync-status`.)
- `docs/INSTALL.md` / `tools/preflight.sh`: install the pinned binary to `<HERMES_HOME>/bin/agent-browser` (sha256 `c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff`), run `tests/browser/smoke-linux.sh`, never export `AGENT_BROWSER_*` in `/etc`.
- `docs/OPERATIONS.md`: the safe-list recovery command above; the meaning of exit 4 / `CATERER_MODULE_ERROR`.
- `scripts/lib/caterer-credentials.js` still exports `buildFillJs()` and `jsLit()` (hand-escaped single-quoted literals). Nothing here uses them (the login module embeds credentials with `JSON.stringify`); leaving a second fill-script builder in the tree recreates the two-copies hazard, so delete them or make them delegate.
- `package.json` `scripts.test` is `node --test ../tests/`; on Node 22 a directory argument is not searched, use a glob such as `../tests/**/*.test.js`.
- `scripts/lib/fsx.js` and other shared files contain an invisible literal byte order mark inside a regex (`/^<BOM>/`, for example `fsx.js` line 24), which breaks the ASCII-only rule; write it with the escape sequence backslash, u, F, E, F, F.
- DESIGN 7 says the Chrome tree is killed between runs and the Caterer and Reed browsers never run at the same time. Killing the Caterer browser costs a safe-list round trip (every incident note says so), so this package keeps the Caterer daemon warm between runs and only idles it; `browser.reset()` exists for the recovery cases. If the memory budget demands otherwise, that is a decision for the owner.
- `runtime/browser.lock` (Reed package) is not taken by `browser.js` or `caterer-login.js`; the runner or phase 1 holds it for a run. The pre-flight runs Caterer then Reed sequentially.
