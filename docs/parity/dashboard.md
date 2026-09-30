# Parity: dashboard (work package "dashboard")

Owner files: `plugin/resourcer/**` (`plugin.yaml`, `__init__.py`, `dashboard/manifest.json`, `dashboard/plugin_api.py`,
`dashboard/dist/index.js`, `dashboard/dist/style.css`, `README.md`), `tools/request-search.js`, `tests/dashboard/**`, this file.
Legacy: `workspace-resourcer/dashboard/server.js`, `dashboard/routes/{stats,territories,schedule,search}.js`,
`dashboard/public/index.html`, plus the halt and queue protocol in `scripts/lib/pipeline-halt.js` and `scripts/pending-gate.js`.
Specs followed: `research/dashboard-parity.md`, `research/hermes-dashboard-plugin.md`, `docs/DESIGN.md` 5.8, `research/current-system-review.md` 5.2.

## 1. Endpoint map (legacy file:line -> new file:function)

All new routes live in `plugin_api.py` and are mounted at `/api/plugins/resourcer/`. Plain `def` handlers except the three POSTs
(which read the body asynchronously and hand the blocking work to a thread pool).

| Legacy | New | Notes |
|---|---|---|
| `server.js:162-182` login, logout | none | Hermes dashboard gate replaces it. No auth, session or CSRF code in the plugin. POSTs additionally require `Content-Type: application/json` (415 otherwise) and a body of at most 4 KB. |
| `server.js:187-239` SSE `/api/events` + `fs.watch` | polling in `index.js` (`usePoll`) | `/status` every 5 s, `/stats` every 30 s, lists every 60 s; paused while `document.hidden`; back off to 30 s after a failure. |
| `server.js:290-404` `collectActiveRuns`, `/api/runs/active`, `/api/runs/active-all` | `plugin_api.py:scan_runs`, `_run_record`, route `GET /status` (`activeRuns`, `queue`) | see 2.4. |
| `server.js:418` `GET /api/runs` (unused by the UI) | dropped | history comes from `run_results` via `GET /runs`. |
| `server.js:441` `GET /api/logs/errors` | `GET /errors` | last N lines of `logs/errors.jsonl` (tail 256 KB), newest first; PII redacted. |
| `server.js:456` `POST /api/logs/errors/acknowledge` | `POST /errors/ack` | same file and shape (`logs/errors-acknowledged.json` `{acknowledgedAt}`), now written atomically. |
| `server.js:474` `GET /api/health` (public) | `GET /health` (behind the gate) | install smoke test, richer, never raises. |
| `server.js:479-489` `GET /api/pipeline-status` | `GET /halt` and the `halt` block of `GET /status` | same fields plus `haltedForMinutes`. |
| (new) | `POST /halt/clear` | new feature (legacy was CLI only). |
| `routes/stats.js:253-340` `GET /api/stats` | `GET /stats` | numbers from `run_results`, see 2.5. |
| `routes/stats.js:344` `/history` | `GET /runs` | paged, from `run_results`. |
| `routes/stats.js:352` `/by-source` | `zoho` block of `GET /stats` | dead `today` field dropped. |
| `routes/stats.js:405` `/reed-daily` | `reed` block of `GET /stats` | |
| `routes/territories.js:14` `GET /api/territories` | `GET /territories` | paged and filtered server-side (was a 600 KB dump). |
| `routes/territories.js:43,76,134` POST, PATCH, DELETE | dropped | territory editing stays in `territory-manager.js`; `research/dashboard-parity.md` 2.10. The old UI never called POST. |
| `routes/schedule.js:84` `GET /api/schedule` | `GET /schedule` | bucket counts plus a capped sample per bucket (was 300 KB). |
| `routes/search.js:38-118` `POST /api/search` | `POST /search` and `tools/request-search.js` | see 2.6. |
| `server.js:247-288` `cleanupStaleRuns` (mutates `runs/`) | not ported | `cull-ghost-phase1.js` owns that job; the plugin never writes to `runs/`. |
| `public/index.html` (SPA, 1553 lines) | `dist/index.js` + `dist/style.css` | panels in 3. |

## 2. Behaviour preserved, and how it was checked

Everything below is exercised offline by `tests/dashboard` (section 6).

### 2.1 Read-only database
`ro_connect()` opens `file:<path>?mode=ro` with `PRAGMA query_only=ON`, `busy_timeout` 5 s and a probe query. A locked or missing
database gives `503 {"error":"db_unavailable","retryAfterSecs":5}` with `Retry-After: 5`, never a 500; `/status` degrades (`db.ok:false`)
instead of failing. Missing optional tables (`run_results`, `reed_daily_usage`) or columns degrade with a `warnings[]` entry.
Checked: INSERT and CREATE through the plugin's connection fail; all GET routes leave the file's SHA-256 unchanged for both
`journal_mode=delete` and `wal`; POST routes leave it unchanged; an EXCLUSIVE writer gives 503 quickly; concurrent reads while a
writer commits never give a 5xx other than 503.

### 2.2 Path jail
One function, `jail_path(*parts)`, is the only way the module turns a name into a path. Root = `RESOURCER_HOME`, else
`plugin_config.json {"resourcerHome"}` next to the plugin, else `/opt/data/profiles/resourcer/workspace/resourcer`. It rejects absolute
paths (POSIX, backslash and drive forms), `..` segments, NUL, symlinks that resolve outside the root, and (before and after
resolution) `secrets/`, `state/`, `.ssh/`, `.git/`, `.env*`, `auth.json`, `state.db`, `*credentials*`, `*session*.json`, `*.pem`, `*.key`,
`id_rsa*`. The `?profile=` query that Hermes adds to plugin routes is ignored. `tools/request-search.js` has the same function in JS.
Checked with parametrised escape attempts, symlinked directories and files, a symlink into `secrets/`, and route-level tests
(`/status` does not read through an escaping `runs/` symlink; `POST /search` refuses to write through an escaping `pending-searches/`).
One reader is outside `jail_path()` on purpose: `reed_source_setting()` opens `<profile>/.env` (and `RESOURCER_ENV_FILE`, `<RESOURCER_HOME>/.env`) to read the
single key `RESOURCER_SOURCES`; it has its own fence (section 5, "Status strip fixes 2026-09-30") and never returns or stores another line.

### 2.3 Halt clear = the halt library's protocol
Legacy `lib/pipeline-halt.js:77-91` (repo copy `resourcer/scripts/lib/pipeline-halt.js:90-113`) `clearHalt()`; new
`plugin_api.py:clear_halt`. Same sequence and content: read `runtime/pipeline-halt.json`; do nothing unless `halted` is true; append
`{ts, context:"pipeline_resumed", severity:"info", error:"Pipeline resumed <em dash> <reason> cleared", detail:"was halted for N min; K run(s)
held back (their territories were NOT consumed)"}` to `logs/errors.jsonl` (single `O_APPEND` write); append the `notify()` record
`{severity:"info", key:"pipeline-halt", text:"Pipeline resumed - <reason> cleared. <detail>", meta:{event:"resumed", reason}}` to
`outbox/alerts.jsonl` so the alert cron closes the episode; then unlink the state file. An unreadable file is left untouched and reported.
Additions: `by` (opaque session user id or `dashboard-user`) and `via:"dashboard"` on the errors line, `via` in the alert meta. Duration
uses half-up rounding like `Math.round`. Checked against the real Node library in both directions (Node `setHalt` -> plugin sees it ->
plugin clear -> Node `getHalt()` is `null`, and the two error lines and two alerts have the documented shape).
Residual race, same as legacy: if the pipeline re-halts between the read and the unlink, the fresh halt file is removed.

### 2.4 Live progress
Derivation from `runs/` files only, following `collectActiveRuns` and `run-lock.js`: `phase1-*` and `run-*` names newer than two days
(name date prefilter, no `stat` of the whole folder), at most 300 of each prefix; statuses `phase1_initializing|taking_over|searching|active|running|complete`
and `phase2_starting|pushing`; a `phase1-*` file is hidden when a terminal `run-*` for the same lower-cased title+location finished at or
after its mtime, when a phase-2 entry for the same key exists, or when `phase1_complete` has `phase2Status:"done"`; entries idle for more
than two hours are dropped; `stale:true` when idle longer than the run-lock max age (20/5/30/60/60/30/30 min; `phase1_complete` is 10 min,
widened to 60 for `sources` both or reed because the Reed stage runs long). Queue: exactly the gate's view, names ending `.json`, sorted, a
claim is fresh for 10 minutes (`pending-gate.js:96-131`), `.held` files, dotfiles and `.tmp` files are ignored. The shared cases in
`tests/dashboard/fixtures/duplicate-cases.json` run against both the Python and the Node implementation.

### 2.5 Stats
Numbers follow `routes/stats.js` with the changes in section 4: credits from `credits-sync.json` (then DB, then the constant), territory
counts (`due` includes `next_run_date IS NULL`), UTC dates, `projectedRunout = today + floor(remaining / burn)`, burn = 7-day new-to-Zoho
divided by 7 rounded half up. SQL from `research/dashboard-parity.md` 4.4.3. Checked against hand-computed values on a synthetic database.

### 2.6 Search request file and the gate
File schema exactly as `search.js:73-98` and the other producers: `{jobTitle, location, keywords, priority, sources, distance, activeWithin,
cvLimit, overrides, requestedAt, source}` (key order kept), `requestedAt` ISO with milliseconds and `Z`, UTF-8 without BOM, `source:"dashboard"`
(`"request-search-cli"` from the tool; nothing in the pipeline branches on it). Never `spawnedAt`: a client-supplied `spawnedAt`, `source`,
`requestedAt` or `overrides` is discarded. Name `search-<epoch ms>-<6 hex>.json` so it sorts ahead of every `territory-*` file and is picked
next. Normalisation is `territory-utils.js` `normaliseJobTitle` (acronym list included, so `F&B` becomes `F&b` exactly as before), `normaliseLocation`,
`normaliseKeywords`. The queued file is read back and removed again if it does not parse or carries `spawnedAt`. Checked with the repo's real
`resourcer/scripts/pending-gate.js`: it reports `READY` naming the new file first, `sources` intact, no `spawnedAt`, `queueDepth` counting it.

## 3. UI panels (legacy `index.html` -> `dist/index.js`)

| Legacy panel | New | Data |
|---|---|---|
| halt banner (327, 662-679) | `HaltBanner` on the page and `BannerSlot` in the `header-banner` slot (no button there) | `/status.halt`, `/halt` every 30 s |
| static "live" dot | status strip: Caterer session, Reed auth, last push, queue, activity/stall, operating window, backup, disk | `/status` |
| cards 1-4 (credits, active territories, Zoho totals, CVs to goal) | "Targets and totals": today and 7-day pulled vs 181/day and 1,269/week, new/dupes/errors/runs, Zoho total vs goal, credits, Reed usage, territory counts, 14-day bars | `/stats` |
| In Progress (413-421, 896-986) | "Live progress": run cards, elapsed from the start time, Phase 2 bar, queue and up-next | `/status` |
| History tab | "Recent runs" (10 per page) with Caterer and Reed rows | `/runs` |
| Territories tab, Upcoming Schedule | "Territories and schedule": filters (role, postcode, priority, due), paged table, "Run now" prefills the form, bucketed schedule | `/territories`, `/schedule` |
| New Search modal (504-596) | inline "Request a search" card, per-field server messages, 409 shows the existing request | `POST /search` |
| Errors tab | "Alerts and errors" (alerts tail plus error log, mark all read) | `/status.alerts`, `/errors` |
| ETA estimator, city blocklist modal, territory edit/delete, Google Fonts, sign out | dropped (blocklist moved server-side; fonts replaced by theme) | |

Rendering rules verified by tests: every API value is a React text child; no `innerHTML` family, no `href`/`src`, no handler built from data,
`style` only with numeric percentages, no external URLs, ASCII and LF only, classic script (no `import`/`export`), nothing outside the
`rsr-` class prefix. Feature detection: needs only `SDK.React` and `SDK.hooks`; uses `SDK.fetchJSON`, else `SDK.authedFetch`, else reports
that no fetch helper exists; `registerSlot` and `useRef` are optional; it does not use `Checkbox`, `Dialog`, `Select`, `Toast` or Tailwind
classes (own markup on theme variables), so a missing component cannot break it.

## 4. Deviations (all deliberate, all listed)

| # | Deviation | Reason |
|---|---|---|
| 1 | Express, login, session, CSRF, rate limits, helmet, SSE, ngrok removed; polling instead of SSE | DESIGN 7; Hermes gate. |
| 2 | Territory create/edit/delete routes and UI dropped | research 2.10; single DB writer language; not in the brief. |
| 3 | History/today/week numbers come from `run_results`, not `downloads/phase2-results-*.json`; week is 7 days (was 8 calendar days divided by 7); legacy caterer+reed pair merging not ported (about 60 legacy pairs will show as two rows) | research 2.8; results files hold candidate names and are deleted by the retention sweep. |
| 4 | Missing `run_results`: fallback to DB link counts, labelled `db-fallback` (they include duplicates) | degrade instead of failing. |
| 5 | Search validation is server-authoritative and stricter: title 2-60 chars from `[A-Za-z0-9 &'./()+-]`; location must be an outward code (`YO2`); `sources`, `priority` validated (legacy coerced or passed through); `distance` only 5,10,20,30,40,60,80 (15 and 50 were silently snapped by Caterer); `activeWithin` from the eight offered values; `cvLimit` 10-50; keywords 60 chars normalised | research 2.5; 308 of 309 territories already match. |
| 6 | Full postcode or place name only when `config/dashboard-settings.json` has `location_mode:"any"` (default `outward`); the 34 city names stay blocked in both modes | the brief asks for "postcode/outward code or place"; the legacy UI warned that city names resolve ambiguously and the DB holds outward codes. One setting flips it. |
| 7 | `409 already_queued` when the same lower-cased title+location is pending OR in flight (legacy queued both; the first finished run deleted both files, silently dropping the second request's distance/keywords) | brief; research 2.5. |
| 8 | Atomic, no-clobber, uniquely named drop (temp dotfile, fsync, hard link, directory fsync); advisory `.request-search.lock` shared with the CLI, ownership token, 30 s stale takeover; name has a random suffix (legacy `search-<ms>.json` could collide) | brief; DESIGN 9. |
| 9 | The PowerShell wake of the LLM watcher is gone | DESIGN 7; the tick polls the gate. |
| 10 | Response shape of `POST /search`: `{ok, file, queueDepthAfter, position, pipelineHalted, inOperatingHours, note, request}` instead of `{ok, message, details}` | the new UI is the only consumer. |
| 11 | `GET /health` sits behind the gate (was public) | plugin routes are never public. |
| 12 | "Next auto-run 08:00" countdown replaced by the operating window and a supervisor note; schedule shows buckets, not 1,724 rows | the 08:00 cron is gone; payload size. |
| 13 | Business constants (`CREDITS_TOTAL`, expiry dates, 100k goal, Reed limit) moved to `config/dashboard-settings.json` with the same defaults; `DAILY_QUOTA` 248 dropped (never displayed); targets 181/day and 1,269/week added | research 4.3.2; brief. The target basis is unlocked (downloaded) CVs, as in `cv-pull-report.js`. |
| 14 | Operating window evaluated in Europe/London through `zoneinfo`, with a built-in BST fallback when tz data is absent (verified equal to `zoneinfo` across 2020-2031 transitions) | DESIGN 7. Dates for stats and due-ness stay UTC as in the legacy writers. |
| 15 | Errors feed redacts `name`/`candidateId`, removes the entry's own candidate name (and its parts) from message text, replaces emails and phone-like numbers | research 4.3.10. Residual: a name that appears only in free text of an entry with no `name` field is not detectable. |
| 16 | New read-only status blocks (Caterer/Reed state, last push, backup age, disk, stall detection, alerts tail) | `research/current-system-review.md` 5.2. |
| 17 | Files ending `.held` stay ignored; `runs/` is never modified | as legacy gate; research 0.6. |

## 5. Contract with the other packages (files and fields the plugin reads)

Every read is tolerant: missing, unreadable or over-size (2 MB) files degrade one field and add a warning; nothing raises. Please check
your package against this table.

| File | Written by | What the plugin relies on | Used for |
|---|---|---|---|
| `candidates.db` | pipeline (WP6 migration) | `candidates(source, zoho_id, unlocked, zoho_pushed_at)`; `territory_searches(id, job_title, location, distance, keywords, priority, enabled, sources, candidate_count, new_to_zoho, duplicates, skipped, errors, credits_remaining, last_searched, next_run_date)`; `reed_daily_usage(date, profile_views, cv_downloads, daily_limit)`; `run_results` as in research 4.5, required subset `date, new_to_zoho, downloaded, duplicates, errors` (stats), `completed_at` (last push, Reed state), and for `/runs`: `run_key, started_at, phase1_started_at, job_title, location, distance, keywords, sources, pool, skipped, approved_p1, skipped_db, skipped_review, pages_scraped, phase2_runtime_secs, screening_model, caterer_json, reed_json` (any subset works). `date` is the UTC day. `caterer_json`/`reed_json` hold counts only, keys `pool,newToZoho,downloaded,duplicates,skipped,errors,phase1{pagesScraped,approved,skippedDb,skippedReview},authFailed,authFailureReason`; other keys are ignored. | everything numeric |
| `runtime/pipeline-halt.json` | `lib/pipeline-halt.js` | `{halted:true, reason, detail, since, lastCheckedAt, blockedRuns, remedy}`; the plugin also removes it (2.3). If the halt library changes the schema or protocol, `clear_halt` must change with it. | banner, clear |
| `logs/errors.jsonl` | pipeline, halt library, plugin | one JSON object per line `{ts, context, severity?, error, detail?, jobTitle?, location?, name?, candidateId?}`; contexts `pipeline_halted`, `pipeline_resumed`, `cv_download`, `zoho_push`, `cv_attach`, `phase2_fatal` are shown raw | errors feed |
| `logs/errors-acknowledged.json` | plugin | `{acknowledgedAt: ISO}` | unread flags |
| `outbox/alerts.jsonl` | `notify()` | `{ts, severity: info|warn|critical, key, text, meta?}` | alerts tail, 24 h critical count; the plugin appends the resume record (2.3) |
| `runs/phase1-<ts>.json` | phase 1 | `{id, status, jobTitle, location, distance, sources, startedAt, updatedAt, page, pool, approved, skippedDb, errors, phase2Status}`; must be rewritten (mtime) on every page so `idleSecs` is meaningful | live progress |
| `runs/run-<id>.json` | phase 2 | `{id, status: phase2_starting|phase2_pushing|complete|error, jobTitle, location, distance, sources, startedAt, phase1StartedAt, updatedAt, completedAt, phase2{total,pushed,duplicates,errors}}`; the `candidates[]` array, if present, is never read | live progress |
| `pending-searches/*.json` | scheduler, catch-up queue, plugin, CLI | `{jobTitle, location, distance, keywords, sources, source, requestedAt, spawnedAt?}`; names must end `.json` to count | queue, duplicates |
| `credits-sync.json` (root, else `runtime/`) | `caterer-get-credits`, phase 2 | `{credits: number > 0, syncedAt: ISO}` | credits |
| `logs/watchdog-runner.jsonl` | watchdog runner | lines `{ts, event, note?}`; state mapping `session-safelist-blocked` -> safe-list blocked, `session-dead` (note containing "safelist" -> safe-list blocked) and `session-stale` -> stale, `session-relogin` -> re-login attempted, `session-loaded`, `phase1-start`, `done` -> OK; newest wins; also its last `ts` counts as activity | Caterer state, activity |
| `runtime/caterer-status.json` | `watchdog-runner.js` and `caterer-login.js` (every check and sign-in outcome, see "Status strip fixes" below) | `{state: ok|stale|safelist_blocked|login_failed|relogin, updatedAt: ISO, detail?}`; wins over the log-derived state when newer. The legacy file of that name was an unrelated run record and is ignored when it has no string `state`. | Caterer state |
| `reed-auth-failed.marker` (`runtime/` first, then root) | Reed phase 1 | `{reason, failedAt}`; present means failed unless a newer OK run exists | Reed state |
| `runtime/reed-status.json` | `reed-api-client.js` (`writeReedStatus`, `--sync-status`) | `{state: ok|auth_failed|disabled, updatedAt, detail?}`; a `disabled` file is ignored while `RESOURCER_SOURCES` says Reed is on; an `ok` file is the proof of a login | Reed state |
| `RESOURCER_SOURCES` (process environment, then `RESOURCER_ENV_FILE` when it lies inside the profile or workspace, then `<profile>/.env`, then `<RESOURCER_HOME>/.env`; the order of `lib/env.js`) | operator (profile `.env`) | ONE key. Only its value, normalised to `caterer|reed|both`, is ever kept or returned; no other line of any `.env` is retained. The profile is `<RESOURCER_HOME>/../..` and only when `RESOURCER_HOME` ends in `workspace/<name>` and that directory holds no `profiles/` or `plugins/`; a `.env` that resolves outside the profile or workspace, is not a regular file, is over 64 KB, holds a NUL byte or is not UTF-8 counts as unreadable. Excludes Reed (`caterer`, an unset key in a readable file, an empty value, anything invalid) -> the strip says `disabled`; includes Reed -> `not_logged_in` until `runtime/reed-status.json` records `ok`; nothing readable at all -> the fallback chain below. | Reed state |
| `runtime/backup-status.json` | **requested from the backup job** | `{ok: bool, finishedAt: ISO, error?}`; `ok:false` marks the backup stale | backup |
| `backups/**` (depth <= 2) | backup job | newest regular file not starting with `.`, not ending `.tmp .partial .part .lock`, not `*.json`, mtime = last backup; stale after 26 h (setting) | backup age |
| `runtime/*heartbeat*`, `*.hb`, `*.pid` | tick / watchdog | mtime only | activity, stall detection (queue non-empty, inside the window, no run, nothing for 20 min, not halted) |
| `config/dashboard-settings.json` | operator (optional) | keys in `plugin/resourcer/README.md`; bad values fall back | goals, targets, window, `location_mode` |
| `config/territory-defaults.json` | legacy config | `distance, activeWithin, cvLimit, priority, sources` for search defaults; invalid values fall back to 20 / "1 month" / 20 / low / both | search defaults |

The plugin writes exactly: `pending-searches/search-*.json` (+ its dot temp files and `.request-search.lock`), `runtime/pipeline-halt.json`
(removal), `logs/errors.jsonl`, `outbox/alerts.jsonl` (one appended line each on a halt clear), `logs/errors-acknowledged.json`.

## 6. Verification

| What | Command | Result |
|---|---|---|
| Node suites, Windows Node 25.6.1 | `node --test "tests/dashboard/**/*.test.js"` | 132 tests: 130 pass, 0 fail, 2 skipped (symlink test needs privileges on Windows; the Python wrapper needs an interpreter with fastapi). After the status strip fixes (2026-09-30): 139 tests (`tests/dashboard/*.test.js`), 133 pass, 0 fail, 6 skipped |
| Node suites, WSL Ubuntu 24.04, Node 22.22.1 | `RESOURCER_PYTHON=<venv>/bin/python node --test 'tests/dashboard/**/*.test.js'` | 132 pass, 0 skipped (includes the pytest wrapper). After the status strip fixes: 139 pass, 0 skipped |
| Python suite (FastAPI `TestClient`, synthetic DB and workspace) | `<venv>/bin/python -m pytest tests/dashboard/py -q` | 251 pass on fastapi 0.142.0 / starlette 1.7.0 and on fastapi 0.133.1 / starlette 1.3.1 (the version `research/hermes-dashboard-plugin.md` pins); Python 3.12.3, SQLite 3.45.1. After the status strip fixes: 301 pass on fastapi 0.142.0 (32 new in `test_reed_state.py`) |
| Real React 19.3 in jsdom (manual, scratch install of react, react-dom, jsdom) | `NODE_PATH=<dir>/node_modules node tests/dashboard/manual/real-react-check.js` | renders every panel, drives halt clear, search form, Run now, the header slot and hostile strings; zero React warnings or errors |

Notes for whoever runs this: `pip install` into a `--without-pip` venv works here (`python3 -m venv --without-pip v && pip3 --python v/bin/python install fastapi httpx pytest`)
because the WSL image has no `ensurepip`. Python bytecode is never written into `plugin/resourcer` by the tests. **`node --test tests/dashboard` (a directory
argument, as written in DESIGN 10) fails on Node 22 and 25 with `MODULE_NOT_FOUND`; use the glob form above.** No test touches the network, a live site, the
legacy tree or a real candidate; all names, emails and numbers in tests are invented (`example.invalid`).

Coverage in one line each: shared validation vectors (50) and duplicate/in-flight cases (19) run in both languages; path jail (parametrised escapes, symlinks,
secret names, route-level); read-only enforcement (INSERT refused, hash unchanged in delete and WAL modes, lock gives 503); every route including degraded and
missing-table paths; PII checks on every response family; halt clear against the real Node halt library; pending-gate acceptance; atomic no-clobber writes and
hard-link fallback; 8-way and 10-way concurrent requests; Python threads racing Node processes on one request (exactly one wins); lock takeover, ownership and
busy paths; NaN/Infinity bodies; body size, content type and JSON errors; time helpers against `zoneinfo`; settings parsing; loader contract (imports, routes,
no side effects at import); banned tokens, ASCII, LF, no secrets in the shipped tree.

## 7. UNVERIFIED-LIVE (acceptance checks for the operator; none can be proved offline)

1. Hermes discovers `/opt/data/plugins/resourcer`, `hermes plugins enable resourcer` succeeds on the hosted image, the tab appears, the routes mount after a
   dashboard restart (`README.md` lists the fallback config write and the log line to grep). Whether the operator may restart the dashboard on Hermes Cloud.
2. On the real dashboard: `SDK.fetchJSON` accepts a `fetch`-style init for POST (read in source, not run), `registerSlot("resourcer","header-banner",...)` argument order and
   slot existence, `SDK.authedFetch` presence on older builds, `window.__HERMES_PLUGIN_SDK__.hooks.useRef`, the theme variable names (fallback colours are supplied), `hidden`
   handling on tab switch, a proxy in front of the dashboard adding CSP or body limits.
3. `zoneinfo`/tz data, Python 3.13 and the FastAPI version on the dashboard interpreter (code uses only stdlib and `fastapi`; verified on 3.12 with two FastAPI versions).
4. Hard links (`os.link`) and directory `fsync` on the `/opt/data` volume (both have fallbacks that are tested with an injected failure), and SQLite read-only access to a
   WAL database on that volume while the pipeline writes.
5. The real event names, texts and cadence written by the port's watchdog runner and login code (the Caterer state mapping is best effort until `runtime/caterer-status.json`
   exists), the real `run_results` writer and backup job output (file names, `backup-status.json`).
6. The authenticated `request.state.session` shape in gated mode (only `user_id` is read, defensively).
7. Behaviour of Hermes' rescan endpoint and dashboard restart (research 13.1 items 1-6 still stand).
8. Status strip, Reed and Caterer chips (2026-09-30): the dashboard process can read `/opt/data/profiles/resourcer/.env` (mode 0600; it must run as the same user, otherwise the file counts as unreadable and the chip falls back to `runtime/reed-status.json`, which the daily pre-flight keeps at `disabled`); with `RESOURCER_SOURCES=caterer` the Reed chip says "Disabled"; after the owner sets `both` and before the first Reed login it says "Not logged in", never "Auth OK"; after `node scripts/caterer-login.js --check` on the instance the Caterer chip reads "Session OK" without waiting for a tick.

## 8. Open issues

* Two implementations of the validation and duplicate rules (Python plugin, Node tool). They are pinned to each other by shared fixtures; a change to either must change both fixtures and both files.
* (Closed 2026-09-30.) The Caterer, Reed, backup and heartbeat status inputs in section 5 now exist. `caterer-login.js` writes `runtime/caterer-status.json` on every outcome, so the Caterer chip is no longer "Unknown" before the first supervisor tick; the Reed chip follows `RESOURCER_SOURCES` (see "Status strip fixes").
* `stallSuspected` and the 26 h backup threshold are the plugin's own heuristics (settings `stall_minutes`, `backup_stale_hours`).

## Integration rehearsal changes (docs/parity/integration.md)

- `plugin_api.py: backup_state` ignores names containing `.pre-migrate-` and directories named `bundle-restore-*`: the unencrypted safety copies written by `migrate-schema.js` and `restore-bundle.js` made a fresh install look as if a nightly backup existed (and, for the restore copy, as an unencrypted one). Test: `tests/dashboard/py/test_status.py::test_pre_migrate_copies_and_bundle_restore_copies_are_not_backups`.
- Run against the simulated workspace (`tests/e2e/08-dashboard.e2e.js`, FastAPI TestClient): `/health`, `/status`, `/stats`, `/runs`, `/territories`, `/schedule` agree with the rehearsal's run (pool, unlocked, new, duplicates, credits, last push, Caterer state); `POST /search` writes a valid pending file (no `spawnedAt`), a duplicate is 409, bad input is 400; the next tick consumes the file; `POST /halt/clear` clears a halt and the supervisor then runs; no response carries a secret or a candidate's name, e-mail or phone.

## Review fixes 2026-09-30

Tests: `tests/dashboard/py/test_search.py`, `test_jail.py`, `test_helpers.py`, `tests/dashboard/request-search.test.js`, `tests/dashboard/plugin-install.test.js` (each new test failed against the reviewed code).

- **Queue cap** (security review 63). `POST /search` and `tools/request-search.js` refuse with 429 `queue_full` (CLI exit 4) when 25 manual searches (`source` `dashboard` or `request-search-cli`, not claimed) are already waiting, or when `pending-searches/` holds more than 500 files. Scheduled territories (`source` `territory-scheduler`) and claimed files do not count, so a busy scheduler never blocks a manual request. The value is `SEARCH_QUEUE_CAP` in both files.
- **Who asked**. A dashboard request file now carries `requestedBy` (the session user id, else `dashboard-user`); the client cannot supply it. The documented key order is `... requestedAt, source, requestedBy`. The CLI file is unchanged (`source` is `request-search-cli`).
- **Cross-site guard** (review 76). All POST routes answer 403 `cross_site` when the browser sent `Sec-Fetch-Site` with anything but `same-origin` or `none`. Requests without the header (curl, older browsers) are unchanged: Hermes' own gate stays the primary defence. `scrub()` slices its input before the regex scans and the e-mail pattern is bounded (60 KB used to cost 3.6 s).
- **Machine-level home refused** (review 75). `get_home()` raises `JailError` when the root has fewer than three path parts or holds `profiles/` or `plugins/`; `/health` reports it (`ok: false`, `error`) instead of failing, every other route answers 400 `path_jail`. Hard links planted inside the workspace remain undetectable by path resolution (not fixable in the plugin).
- **Installer** (review 87). `plugin/resourcer/install-plugin.sh` (run with `bash`): copies the plugin without bytecode caches, moves an old install aside instead of deleting it, links it into the profile, enables it for the default home and the profile (falls back to Hermes' config helpers). The README no longer has `rm -rf`, `find -exec` or command-line heredocs in its install and roll-back steps, points the log check at `/opt/data/logs/errors.log`, says a dashboard stop ends the operator's own Chat session, and adds an `httpx` probe to the verify step. UNVERIFIED-LIVE on a real Hermes box.

## Status strip fixes 2026-09-30 (go-live round, found on the live instance)

Tests: `tests/dashboard/py/test_reed_state.py` (32, all failed against the previous plugin except the secrets guard), `tests/dashboard/ui.test.js` (Reed chip), `tests/browser/login-status.test.js` (14, 12 failed before). `tests/dashboard/py/conftest.py` now clears `RESOURCER_SOURCES` and `RESOURCER_ENV_FILE` for every test.

- **Reed said "Auth OK" while Reed was disabled and had never logged in.** Cause: `reed_state()` turned the newest `run_results.reed_json` (history imported from the laptop, `authFailed:false`) into `ok`. Now `plugin_api.py:reed_source_setting()` resolves `RESOURCER_SOURCES` in the order of `lib/env.js` (non-empty process variable; then the first env file that defines the key, an empty value meaning unset: `RESOURCER_ENV_FILE`, `<profile>/.env`, `<RESOURCER_HOME>/.env`; then the pipeline default `caterer`; anything that is not `caterer|reed|both` counts as `caterer`, as in `reed-api-client.js:sourcesGate`). Result of `GET /status` `reed`:
  - Reed excluded: `{state:"disabled", enabled:false, sources:"caterer", source:"RESOURCER_SOURCES", detail:"RESOURCER_SOURCES=caterer", updatedAt:null, ageMinutes:null}`. Wins over a failure marker, a status file and run history. Detail for an unset key says "default caterer"; for an invalid value it says the value is not `caterer|reed|both` and never echoes it.
  - Reed enabled, an `ok` in `runtime/reed-status.json` (written by `markAuthOk` on every successful login or refresh): `ok` as before. A newer failure marker or `auth_failed` still wins. A stale `disabled` status file is ignored.
  - Reed enabled and no recorded login (only run history, or nothing): NEW state `not_logged_in` ("Not logged in", warn tone), detail "Reed is on (RESOURCER_SOURCES=both) but no successful Reed login is recorded yet".
  - No process variable and no readable env file (missing, unreadable, binary, over 64 KB, not UTF-8, a directory, a FIFO, outside the profile, a symlink leaving it): the old chain (marker, `runtime/reed-status.json`, run history) with `enabled:null, sources:null`.
  - New response keys `enabled` (bool or null) and `sources` (`caterer|reed|both` or null); `dist/index.js` maps `not_logged_in` to "Not logged in". The value of RESOURCER_SOURCES is the only thing ever read from an `.env`: the reader matches one line pattern, keeps nothing else, and the tests plant fake secret keys (`AI_GATEWAY_API_KEY`, a passphrase, a Zoho secret, an `export`ed token) and assert that no route (`/health /status /stats /runs /territories /schedule /halt /errors`) returns a key name, a value or any other `.env` text.
  - Fence: the profile is `<RESOURCER_HOME>/../..` only when `RESOURCER_HOME` is `<profile>/workspace/<name>` and that directory holds no `profiles/` or `plugins/` (a machine-level `.env` is never read); candidates are resolved with `realpath` and must stay inside the profile or the workspace, and outside `secrets/`, `state/`, `.ssh/`, `.git/`.
  - Cost: a few small file reads per `/status` poll (not cached, so an edit to the `.env` shows within one poll).
- **Caterer said "Unknown" until the first supervisor tick although the sign-in worked.** `caterer-login.js` now writes `runtime/caterer-status.json` (atomic, `{state, updatedAt, detail<=200}`, the same file and shape as `watchdog-runner.js:writeCatererStatus`) from `ensureLoggedInDetailed` (so also `ensureLoggedIn`, the CLI, the pre-flight and the keep-alive, phase 1's self-heal and the runner) and `openVerificationLink`:

  | Outcome | state | detail |
  |---|---|---|
  | signed in (no sign-in needed) | `ok` | empty |
  | signed in by this call | `ok` | `signed in again` |
  | sign-in attempt begins | `relogin` | `sign-in attempt started` (replaced by the outcome; a killed process leaves it, and the runner then writes `login_failed`) |
  | safe-list block, also while the sign-in is suppressed | `safelist_blocked` | `SafeListLoginBlocked` |
  | CV Database module failing while signed in | `stale` | `CV Database module error` (as the runner) |
  | `--check` (or keep-alive) and not signed in | `stale` | `not signed in (check only, no sign-in attempted)` |
  | sign-in failed, credentials unusable, or suppressed by the attempt limiter | `login_failed` | the marker (`LOGIN_FAILED`, `CRED_MISSING`, ...) or `sign-in suppressed (min-gap|hold)` |
  | `--open-link` cleared the block | `ok` | `safe-list block cleared by the emailed link` |
  | `--open-link` did not clear it | `safelist_blocked` | `the emailed link did not clear the block` |
  | network failure, check error, unrecognised page, bad link | nothing written | the last known state stays (a guess would send the operator to a needless re-login, which costs a safe-list email) |

  No exit code, CLI line or alert changed (the rate-limited alerts are untouched); the write is `try/catch` and passed through `env.redact`; a credential, username or link token never reaches the file (tested). The library `login()` itself does not write (only `ensureLoggedInDetailed` calls it); the file is written by whichever of the runner and this module ran last, both with the same mapping.
- **Tests outside this package affected.** `tests/e2e/08-dashboard.e2e.js` test 8.3 asserts `status.json.reed.state === 'unknown'` for a world whose profile `.env` says `RESOURCER_SOURCES=caterer`; the plugin now (correctly) answers `disabled` there. CLOSED 2026-09-30 by the finalizer: the assertion expects `disabled` and `bash tests/e2e-linux.sh --only 08` passes (before the fix only 8.3 failed). Earlier note (run: `bash tests/e2e-linux.sh --only 08`, WSL: only that assertion failed, 8.1/8.2/8.4/8.5/8.6 passed; `--only 02,04` passed with the new caterer-status writer).
