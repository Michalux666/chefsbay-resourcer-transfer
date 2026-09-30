# Parity: lifecycle package (Phase 2 push, schema migration, retention, run_results)

Owner: WP6 "lifecycle". Legacy source (read-only): `workspace-resourcer/scripts/process-approved-queue.js` (1,422 lines, line numbers below refer to it).

New files: `resourcer/scripts/process-approved-queue.js`, `migrate-schema.js`, `retention-sweep.js`, `backfill-run-results.js`, `preflight-db.js`, `lib/cv-retention.js`, `tests/lifecycle/**`. The integration pass of 2026-09-29 (section 9) also touched `resourcer/candidates-db.js` and `scripts/fill-mandatory-fields.js`; those are described in `core.md` (D13, D14).

## 1. Operator commands

| When | Command | Notes |
|---|---|---|
| Install / after restoring the bundle DB, no run in flight | `node scripts/migrate-schema.js` | idempotent; takes one online backup into `backups/` when something structural changes; WAL only when the volume supports it |
| Once, before the first sweep | `node scripts/backfill-run-results.js` | prints per-day `new` sums from the files and from `run_results`; must say `PARITY OK`; add `--strict` for exit 3 on a mismatch |
| Daily (no-agent cron, redirect stdout to a file) | `node scripts/retention-sweep.js` | one JSON summary on stdout; `--dry-run` first; `--list` names the deleted downloads/ files |
| Per run (called by phase1 handoff / run-pipeline / recover-stranded) | `node scripts/process-approved-queue.js <queue.json>` | exit 0 done (also "already processed"), 1 fatal |
| Before any run: operator preflight and the start of every supervision tick | `node scripts/preflight-db.js --quiet` | exit 0 only when `candidates.db` exists, is not empty, passes `PRAGMA integrity_check` and holds at least one candidate (`--allow-empty` for a fresh install); exit 1 otherwise with one reason line on stderr (`missing`, `empty-file`, `not-a-file`, `open-failed`, `locked`, `integrity-failed`, `no-candidates-table`, `no-candidates`); 2 usage. Section 9.4 |

Nothing here needs a new environment variable beyond `RESOURCER_SOURCES` (already registered; Phase 2 now reads it, section 9.2). `LIFECYCLE_TEST_TMP` is used only by `tests/lifecycle` to place temp dirs (falls back to `os.tmpdir()`).

## 2. process-approved-queue.js: legacy line -> new function

| Legacy | New (`process-approved-queue.js`) | Status |
|---|---|---|
| 45-103 `findPhase1StatusFile` (3 strategies, content match, 7-day guard) | `findPhase1StatusFile` | identical logic |
| 126-165 `flattenPhase1Stats` | `flattenPhase1Stats` | identical |
| 174-200 `initRunState` / `updateRunState` | `makeRunState` (`.update`) | same fields; atomic writes |
| 203-210 `logError` | `logError` | same JSON shape; secrets redacted; no candidate names (see D3) |
| 212-216 constants (5 downloads, 500 ms Zoho spacing, 30 s child timeout) | `DEFAULT_CONFIG` | same values, overridable by tests only |
| 221-233 `findExistingCv` (source-ordered prefixes, 5 extensions) | `findExistingCv` | identical order; unsafe ids return null |
| 235-252 `guessExtension` | `guessExtension` | changed: only extensions the reader can find (D4) |
| 255-292 `downloadCvDirect` (size, HTML-masquerade guards) | `downloadCvDirect` | same checks and messages; atomic 0600 write; legacy Windows UA string kept |
| 295-309 `downloadCvViaScript` (shell string) | `downloadCvViaScriptReal` | `execFile` argument array, `process.execPath` |
| 312-336 `getZohoIdFromDb` (caterer, reed_id, caterer_id+source=reed) | `getZohoIdFromDb` | identical fall-through |
| 340-369 `buildSourceNote_REMOVED` | - | dead code, dropped |
| 372-389 `runConcurrent` | `runConcurrent` | identical |
| 393-411 args, queue read, exit 1 paths | `run` (`usage`, `queue-missing`, `queue-invalid-json`) | same messages and exit 1 |
| 413-428 reprocess guard | `run` | identical, including the quirk that `approved-queue-<ts>` results are named without the prefix so only merged/reed queues match (Zoho ids in the DB stop re-pushes for the others) |
| 430-464 destructuring, phase1Stats normalisation, `candidates` not array -> exit 1 | `run` | identical; non-object candidate entries become id-less and are reported `INVALID_ID` |
| 466-486 lock extension `phase2_starting` | `run` | identical, atomic write |
| 495-511 token refresh once, warning only | `run` | identical |
| 513-534 Step 2 resume detection | `run` | identical + numeric-id validation (D2) |
| 553-615 Step 3 downloads (Reed API path, Caterer HTTP / script path) | `run` | thrown Caterer download errors are per-candidate errors (D1); **integration change (F2): a candidate that carries `encId` is downloaded through `caterer-download-cv.js` (the signed-in browser), the direct node fetch with the saved cookie header (`cvUrl`) is only the fallback for a queue without `encId`** - node to recruiter.caterer.com is blocked by bot mitigation (2026-06-01) and the legacy order tried it first |
| 618-678 Step 4 candidate JSON (3 profile shapes) | `run` | identical fields; atomic 0600 write |
| 680-710 Step 4.5 mandatory field recovery, NO_EMAIL | `run` | identical; only field names are logged |
| 713-899 Step 5 push (3 attempts, 3 s then 6 s, MANDATORY_NOT_FOUND recovery, attach, DB write, progress, result row) | `run` | identical decisions; deletion rule added (section 3) |
| 902-1067 results object (all fields, `catererStats`, `reedStats`, timing) | `run` | identical object; written atomically, 0600 |
| 1067 (results written) | `run` | NEW: `run_results` row (section 4) |
| 1069-1105 credits-sync + live fallback (exit 2 = stale, not written) | `run`, `getCreditsReal` | identical; `credits-sync.json` at `RESOURCER_HOME` root; the child's timeout is 120 s (`CREDITS_TIMEOUT_MS`), was 30 s (section 9.2) |
| 1107-1120 run state `complete` | `run` | identical |
| 1122-1151 territory upsert + auto-downgrade log | `run` | identical; DB opened with `fileMustExist` and a 15 s busy timeout (D5) |
| 1153-1206 pending-search cleanup, Reed auth retry counter (max 3), caterer-only keep rule | `run` | unlink through the jail; alerts added; Reed disabled deletes the file, the caterer-only keep rule is bounded (section 9.2) |
| 1209-1224 `runs/pipeline-wake.flag` | `run` | kept (vestigial hygiene signal) |
| 1226-1241 detached wake script for the LLM watcher | - | REMOVED (DESIGN 7) |
| 1245-1251 final summary | `run` | same lines (ASCII), plus a cleanup counter |
| 1253-1378 WhatsApp report and sent-hash log | - | REMOVED; alerts through `notify()` (section 6) |
| 1380-1406 Step 8 phase1 status `complete`, `phase2Complete` | `run` | identical, atomic write |
| 1409-1421 explicit `process.exit`, FATAL path | CLI wrapper, `run` catch | identical exit codes; FATAL also raises a critical alert |

Interface to sibling modules (unchanged legacy names): `zoho-auth.refreshToken`, `zoho-create-candidate.createCandidate`, `zoho-attach-resume.attachResume`, `fill-mandatory-fields.fillMandatoryFields`, `candidates-db.{getZohoId,setZohoId,getDb}`, `reed-download.{downloadCandidate,normalizeProfileToZoho}`, `caterer-cookie-jar.fetchWithCookieJarUpdate`, `caterer-session-utils.{loadCookieHeader,BASE_CATERER}`, `territory-utils.upsertTerritory`, script `caterer-download-cv.js` (args `encId auditId downloadsDir id`), script `caterer-get-credits.js`. Everything is resolved lazily and injectable (`run(queue, deps)`), which is how the tests drive it.

## 3. The deletion rule

`shouldDeleteCandidateArtifacts({zohoId, cvAttached, isDuplicate}) = !!zohoId && (cvAttached || isDuplicate)` (`lib/cv-retention.js`).

Placement: inside the per-candidate block, in a `finally` that starts as soon as Zoho holds the candidate. The eligibility flag is computed right after the attach step, before the DB write, so a failing DB write, a failing progress write or a failing log line cannot skip the cleanup of a candidate Zoho already has (proved by the injection matrix and two dedicated tests). Removed: `candidate-<id>.json` and every extension of the candidate's own CV prefix (`cv-<id>.*` for Caterer, `cv-reed-<id>.*` for Reed), plus the exact file that was attached when the legacy prefix fallback picked the other prefix. Nothing else of the other prefix is touched, and that fallback file is protected when another candidate in the same queue has the same numeric id from the other source.

| Outcome | CV and candidate JSON |
|---|---|
| created + attached (also "already has a resume") | removed |
| duplicate (no attach needed) | removed |
| created, attach failed / threw / throttled out | kept for the retention sweep (14 days); never retried automatically (legacy never did either) |
| created, no CV at all (download failed, Reed profile-only) | JSON kept 14 days (rule needs attach or duplicate); nothing to attach later |
| create failed after 3 attempts, mandatory field, no e-mail | kept |
| already in Zoho per DB (skipped row) | left alone; a CV present there means an earlier attach failed; 14-day sweep |

Guarantees (tests): exhaustive injection matrix of 168 cases (6 create outcomes x 7 attach outcomes x DB write ok/fail x CV present/absent, one run, 168 candidates): CV/JSON present exactly when not eligible, statuses and DB ids as expected. `findExistingCv` retry reuse: a CV already on disk is used with no download. Reprocess guard: unchanged; see the sweep ordering below.

## 4. run_results

- DDL exactly `research/dashboard-parity.md` 4.5 (`RUN_RESULTS_DDL`, index `idx_run_results_date(date, completed_at)`), created by `migrate-schema.js` and defensively by the Phase 2 writer (`CREATE ... IF NOT EXISTS`), with column-drift repair for an older partial table.
- Writer: `INSERT OR REPLACE` right after the results file, inside try/catch (a failure logs `run_results` to `errors.jsonl`, raises a warn alert, never fails the run). The sweep repairs a missing row from the results file before it deletes that file.
- Mapping (`backfill-run-results.js: buildRunResultRow`) is the single implementation used by the writer, the backfill and the sweep repair; it applies the legacy dashboard defaults (`downloaded ?? total`, counts `?? 0`, `sources || 'caterer'`, blank keywords -> NULL). `sources` is coerced to the dashboard enum `caterer | reed | both` (case and padding tolerated; anything else counts as absent), see 9.3. A test proves the live row equals the backfilled row for the same results file (except `created_at`).
- Backfill: one row per `phase2-results-*.json`, `INSERT OR IGNORE`, BOM stripped, unparseable and date-less files counted and skipped, no legacy pair merging (dashboard-parity 2.8). Queue files fill only fields the results file lacks (`--no-queues` disables). It never deletes, moves or edits a file (a test compares directory hashes and greps the source). Per-day parity table for the last N days (default 14).

## 5. migrate-schema.js

Steps: journal mode (WAL only if the volume passes a filesystem-type verdict and a functional two-connection probe; otherwise the DB keeps its mode and a warning is printed, exit 0), `candidates.created_at/zoho_pushed_at` + the two triggers (only when missing), `candidate_rejections.reason_code` nullable (only when the table exists; the table is never created here because a missing table selects the legacy unscoped skip rule), `run_results` + index, `PRAGMA quick_check`. One IMMEDIATE transaction for all DDL. Exit 0 ok, 1 real error (missing DB, unopenable/garbage file, failed check), 2 usage. `--dry-run`, `--create`, `--json`, `--journal-mode`, `--no-backup`.

Tested on a synthetic DB with the real legacy schema (read from `sqlite_master` of a copy on 2026-09-29): data hashes of `candidates`, `territory_searches`, `candidate_rejections` unchanged, triggers byte-identical, second run all `present` with no new backup, pre-2026-08-24 schema variant, empty DB, drifted `run_results`, busy writer (busy_timeout works because the transaction is IMMEDIATE), garbage file, WAL on ext4 and refusal on a 9p mount (WSL `/mnt/c`).

## 6. retention-sweep.js

Refuses to touch `downloads/` (including review-tmp) until `run_results` exists and has rows; `runs/` and `logs/` are still processed. Age accounting uses `completedAt` from the results file, the phase1 status file (`phase2Complete`/`phase2Status: done`), or file mtime.

| Target | Rule |
|---|---|
| `review-tmp-*` | always |
| results + their queue | Phase 2 completed + 3 days; queue deleted first, results second and only if the queue delete succeeded or the queue is gone; each results file is recorded in `run_results` (repaired if missing) before either goes |
| results without queue | after 3 days |
| `approved-queue-*` / `reed-approved-queue-phase1-*` with no results of their own | status file complete + 3 days, else 14 days (reported as a stranded queue with candidate count) |
| `reed-approved-queue-<job>-<location>-<ts>.json` (no status file maps to it) | same rule as above once a completed merged run for the same job and location finished within 3 hours after the queue was written (the queue was merged into it); otherwise 14 days |
| `merged-queue-*` with no results | 14 days |
| `reed-empty-*` | 3 days |
| corrupt or undated results | 14 days |
| orphan `cv-*`, `cv-reed-*`, `candidate-*.json` | 14 days; ids (never contents) of those with no Zoho id are appended to `logs/retention-unpushed.jsonl` and alerted |
| `cv-reed-anon-<id>.*` (redacted Reed CV written by `reed-download.js --anonymized-cv`) | 14 days as an orphan; never pushed, so not counted in `unpushedOrphans` and not in `retention-unpushed.jsonl` |
| `*.tmp` of a known file (`approved-queue-*`, `merged-queue-*`, `reed-approved-queue-*`, `phase2-results-*`, `candidate-*`, `cv-*`, `cv-reed-anon-*`, `reed-empty-*`; name `<file>.<pid>.<ms>.tmp` left by a hard kill) | 1 hour (behind the same `run_results` gate as everything in `downloads/`) |
| any other `*.tmp` in `downloads/` | 1 day |
| `runs/`: `phase1-*`, `params-*`, `run-*` (+ `.run-lock`, `.stale-*`) | 7 days; anything else is left alone. Their `*.tmp` leftovers (e.g. `phase1-<ts>.json.<pid>.<ms>.tmp`) go after 1 hour, any other `*.tmp` after 1 day |
| `runtime/screening-input/*` (snippet files of a screening call that was hard-killed) | every regular file older than 1 hour; not gated by `run_results`; sub-directories and symlinks are never entered or followed |
| `shadow/screening-YYYY-MM-DD.jsonl` | older than 180 days (London date in the name), removed by `lib/screening/shadow.pruneShadow({days:180})` when that module is present; nothing else in `shadow/` is touched; a dry run only counts |
| `logs/`: `.log .err .out .txt` and rotated `*.jsonl.<stamp>` | gzip after 14 days (verified, mtime kept); active files above 50 MB rotate when quiet for 10 minutes; `.gz` deleted after 90 days |
| disk | critical alert above 85% used |

Safety: every deletion goes through `jailedUnlink` (plain basename, regular file, never a symlink, directory equal to one of `paths.DOWNLOADS/RUNS/LOGS` or `runtime/screening-input` after `realpath`); a static test asserts no other unlink/rm exists in the package. The one exception is `shadow/`, which belongs to the screening package and is pruned only through its `pruneShadow`. `state/` and `secrets/` are never touched (tested byte for byte, with hashes and mtimes). Per-run deletion budget (`--max-delete`, default 20,000). A lock file in `logs/` (pid + 2 h staleness, empty-file race handled) prevents concurrent sweeps. `--dry-run` writes nothing (no delete, gzip, DB row, alert or lock).

## 7. Deviations from legacy

- D1 Caterer CV download errors that are thrown (no session file, network error, timeout) are recorded as that candidate's download error and the run continues; legacy aborted the whole run (FATAL) and stranded every approved candidate (unlocked in the DB, never pushed).
- D2 Candidate ids must be numeric (`^\d{1,20}$`); anything else is reported as an `INVALID_ID` error row and never reaches a file path (legacy interpolated the id into `cv-${id}.ext`).
- D3 No candidate names, e-mails, phones or CV field values in console output or `errors.jsonl` (DESIGN 1.3): ids and field names only. Names remain in the results file rows (kept 3 days) as in legacy.
- D4 A downloaded CV is saved only under an extension `findExistingCv` searches (`.pdf .docx .doc .rtf .txt`); a hostile or odd `Content-Disposition` extension falls back to the content type, then `.pdf`, instead of creating an orphaned file that was never attached.
- D5 DB handles use `fileMustExist` (a wrong `RESOURCER_HOME` cannot silently create an empty `candidates.db`) and a 15 s busy timeout; state files (queue-derived JSON, results, run state, status file, pending file, credits sync) are written atomically; CV, candidate JSON and results are mode 0600.
- D6 The same candidate listed twice in one queue: the second occurrence is recorded as `duplicate` without a Zoho call (legacy got DUPLICATE_DATA from Zoho for it; the first push now deletes the JSON).
- D7 Alerts (`notify`): Reed auth retry / give-up, Zoho push failing for every candidate of a run (>= 3), CV attach failures, cleanup failures, `run_results` write failure, fatal abort. The legacy WhatsApp text report (disabled since 2026-05-14) is gone.
- D8 `pending-searches/*.json` is removed with the same rules as legacy (through `jailedUnlink` on that directory). This is the only Phase 2 deletion outside downloads/runs/logs and it is required Phase 2 behaviour; the retention code never touches `pending-searches/`. (The retention sweep itself also prunes `runtime/screening-input/` and, through the screening package, `shadow/`; see D11.)
- D9 `journal_mode=WAL` (DESIGN 5.6, research review item 12) is applied only when verified safe; `research/dashboard-parity.md` finding 4 and `hermes-operations.md` warn about shared-memory locking on virtiofs/9p, so a volume that fails the probe stays in rollback-journal mode.

- D10 (2026-09-29) Phase 2 reads `RESOURCER_SOURCES`: with Reed off, the pending-file hint no longer turns a caterer-only run into `sources: both`, and a pending file asking for `both`/`reed` is deleted at the end of the run; with Reed on, the "asked for Reed, got a caterer-only run" keep rule is bounded to 2 retries. Legacy kept such a file for ever and recorded `sources: both` on 6,541 of 6,603 historical results files although Reed was mostly off. Section 9.2.
- D11 (2026-09-29) The retention sweep also removes `runtime/screening-input/*` older than 1 hour, hard-kill `*.tmp` leftovers of known files after 1 hour (instead of 1 day), `cv-reed-anon-*` after 14 days, and old `shadow/screening-*.jsonl` through `pruneShadow`. Section 9.5.
- D12 (2026-09-29) `run_results.sources` is coerced to `caterer | reed | both`. Section 9.3.

## 8. Verification summary

- `node --test "tests/lifecycle/*.test.js"`: 142 tests at hand-off, 188 after the integration pass of 2026-09-29 (section 9). Windows Node v25.6.1: 184 pass, 4 skipped (the symlink tests need privileges on that host). WSL Ubuntu 24.04, Node 22.22.1, ext4 home: 188 pass, 0 skipped (symlink jail tests and real WAL included); migrate-schema and preflight-db tests also pass with temp dirs on the 9p `/mnt/c` mount, where the WAL refusal is exercised for real. The tests find `better-sqlite3` in `resourcer/node_modules` themselves (`tests/lifecycle/helpers/sqlite.js`); `NODE_PATH` is no longer needed where `npm install` ran in `resourcer/`.
- Zero network: `helpers/net-guard.js` makes `fetch` throw for any host but 127.0.0.1; the fake Zoho is a real HTTP server on 127.0.0.1.
- `tests/lifecycle/real-modules.test.js` runs Phase 2 against the real sibling modules (`zoho-create-candidate`, `zoho-attach-resume`, `fill-mandatory-fields`, `candidates-db`, `territory-utils`) with only `RECRUIT_BASE` redirected; it skips itself if they are absent.
- Scale check (WSL ext4, 64,290 files shaped like the legacy `downloads/`): dry run 1.3 s, a real run 2.4 s at the 20,000-deletion budget, 120 MB RSS; four runs drain it; the 880 never-pushed orphans were counted exactly. A first bulk sweep can use `--max-delete 100000`.
- `migrate-schema.js` was run against a scratch copy of the real legacy database (65,331 candidates): dry run changes nothing, migration 0.2 s, row hashes of `candidates`/`territory_searches` unchanged, second run all `present`, `quick_check` ok.

## 8. Known limits (not fixed here)

- `candidate-<id>.json` is keyed by the bare id for both sources (legacy). A Caterer id equal to a Reed id in one queue is handled safely (no cross deletion, no wrong push; the second candidate errors with `No candidate JSON`) but not made possible; changing the file name would break readers outside this package.
- Failed CV attaches are never retried automatically (legacy did not either); the CV is kept 14 days for manual recovery.
- The reprocess guard does not cover `approved-queue-<ts>` (legacy quirk, kept).
- Pairing of a Reed queue to its run is a name/time heuristic (same job and location, completion within 3 hours after the queue file's mtime); when it does not match, the 14-day orphan rule applies, so that file holds candidate data for up to 14 days.
- `run_results.downloaded` is the number of CVs that needed downloading (`toDownload.length`), not the number that succeeded (legacy `dlCount`; section 9.3 shows this is the meaning the dashboard has always had).
- `run_results.date` is the `searchDate` of the queue, which phase 1 stamps with the Europe/London day; the dashboard compares it with the UTC day. They differ only between 00:00 and 01:00 BST, outside the 06:00-22:00 window, so it is left as in legacy.
- Worst case of `caterer-get-credits.js` is about 150 s (open 40 + network idle 40 + read 25 + retry read 25 + URL check 15 + a 5 s pause) when the site is slow at every step; the parent now waits 120 s. A kill only loses the optional credit refresh (the run and its results are already written).
- Console output of a run contains candidate ids; `errors.jsonl` contains ids and job/location. Compressed logs live 90 days.

## 9. Integration pass 2026-09-29 (core + lifecycle)

Scope: the seven items of the integration brief. Files: `candidates-db.js`, `fill-mandatory-fields.js`, `process-approved-queue.js`, `retention-sweep.js`, `lib/cv-retention.js`, `migrate-schema.js`, `backfill-run-results.js`, new `preflight-db.js`, their tests, `core.md`, this file.

### 9.1 Journal mode (candidates-db.js, migrate-schema.js)
`openDb()` no longer runs `PRAGMA journal_mode = WAL` on every open (`core.md` D13). `migrate-schema.js` stays the only place that turns WAL on, after its filesystem verdict and two-connection probe. `busy_timeout = 5000` is unchanged. `migrate-schema.js`, `backfill-run-results.js` and the new `preflight-db.js` now refuse a flag without its value (`--db`, `--dir`, `--journal-mode`) with exit 2 instead of silently using the default database or swallowing the next flag.

### 9.2 Phase 2: credits timeout and the RESOURCER_SOURCES doom loop (process-approved-queue.js)
- `getCreditsReal` waits `CREDITS_TIMEOUT_MS = 120000` for `caterer-get-credits.js` (was 30 s, shorter than the script's own 40 + 40 + 25 s). A kill still only means "no fresh value" (`{credits:null, source:'phase2-completion'}`).
- Trace of the loop. Phase 2, step 6.5, kept a pending file whose `sources` was `both`/`reed` when the result said `caterer`, without any counter. Cause chain: `watchdog-runner.buildParams` gates the run to `caterer` while `RESOURCER_SOURCES` is unset (the default), so the queue carries `sources: caterer`; the legacy "pending hint" then overrode that with the pending file's `both`, which hid the problem (and mislabelled the run), and the keep branch stayed reachable through a second pending file for the same territory whose `sources` differed (the duplicate-territory loop of 2026-06-01). Each pass kept the file, the gate re-queued it after the 10 minute claim, and the territory ran again.
- Fix (only in this file; `pending-gate.js` and `watchdog-runner.js` untouched, protocol unchanged): `reedAllowed(RESOURCER_SOURCES)` uses the watchdog's rule (`both` or `reed` = Reed on, anything else = off). Reed off: the hint is ignored and every matching pending file that asks for `both`/`reed` is deleted at the end of the run (log line, no alert; the territory row keeps its own `sources`). Reed on: the keep rule is bounded by `sourceMismatchRetries` (max 2; `spawnedAt` kept, so the gate waits at least 10 minutes between attempts), then the file is dropped with the warn alert `pending-sources-mismatch-giveup`. A corrupt pending file no longer stops the hint scan; a BOM is tolerated.
- The supervision side (`gatePendingSources` rewriting the picked file to the effective sources and remembering `sourcesRequested`) is complementary: with both in place the file normally already says `caterer`. Tested with the real `pending-gate.js` (`SPAWNED` during the claim, `READY` with the counter after 10 minutes).
- Consequence for history: caterer-only runs recorded while Reed is off now say `sources: caterer` and carry `reedStats: null` (legacy said `both` with an empty Reed block). Older rows are not rewritten.

### 9.3 run_results against docs/parity/dashboard.md section 5
| Contract | Finding | Action |
|---|---|---|
| Required subset `date, new_to_zoho, downloaded, duplicates, errors` non-null integers | The writer always sets them (`date` is required by the mapping; counts default to 0) | test on a fresh table |
| `downloaded` = "unlocked (downloaded) CVs", legacy `dlCount` = `toDownload.length`, fallback `total` | All 6,603 parseable legacy results files carry a numeric `downloaded` (equal to `total` in 6,491, lower in 112 resume runs); the writer reproduces it exactly | no change; tests for "CV already on disk is not counted" and for the `total` fallback |
| `sources` is one of `both / caterer / reed` (`VALID_SOURCES` in the plugin) | `queue.sources` was copied unchecked | `buildRunResultRow` and `resolvedSources` coerce through `cv-retention.normalizeSources` (case and padding tolerated, anything else = absent) |
| Missing table: the plugin degrades (`warnings[]`), the writer must not fail a run | `CREATE TABLE IF NOT EXISTS` plus column-drift repair run inside the writer's try/catch | tests: absent table, partial older table, exact column list and index |
| `caterer_json` / `reed_json` hold counts only | keys are within `pool,newToZoho,downloaded,duplicates,errors,phase1{...},authFailed,authFailureReason`; no names | test greps the JSON for names, e-mails and phones |

### 9.4 preflight-db.js (new)
`node scripts/preflight-db.js [--allow-empty] [--db f] [--json] [--quiet] [--busy-timeout-ms n]`. Exit 0 only when `candidates.db` exists, is not empty or a directory, opens, passes `PRAGMA integrity_check` and holds at least one candidate (`--allow-empty` accepts none, and a missing `candidates` table, for a fresh install). Otherwise exit 1 with `[preflight-db] NOT FIT (<reason>): <detail>` on stderr (`--json`: one object on stdout). Read-only in effect (`query_only`, no journal-mode change, file hash unchanged, never creates the file), but opened normally so a hot journal from a killed writer is rolled back instead of failing the check (tested with a real SIGKILLed writer). A writer holding the file gives reason `locked` after `--busy-timeout-ms` (default 15 s). Prints counts only. `checkDb()` and `main()` are exported for in-process use.

Why it matters: a missing or emptied database makes the pipeline treat every card as new (re-screening and, for Caterer, re-paying for the whole pool), and `candidates-db.js` would silently create an empty schema. The tick must call it first; lifecycle does not edit the tick. Requested wiring (supervision owner): near the top of `hermes/scripts/resourcer-tick.sh`, after `cd "$RESOURCER_HOME"`:

`"$NODE" scripts/preflight-db.js --quiet >>"$LOG" 2>&1 || { echo "resourcer-tick: candidates.db preflight failed (see $LOG)"; exit 92; }`

and/or an in-process `require('./preflight-db').checkDb()` before the first spawn in `pipeline-watchdog.js` that raises the shared halt with the reason. For a fresh install run it once with `--allow-empty`, or restore the bundle first.

### 9.5 Retention additions (retention-sweep.js, lib/cv-retention.js)
- `runtime/screening-input/*` (the file-mode snippet files of `phase1/screen.js`): every regular file older than 1 hour, independent of the `run_results` gate; own jail root; sub-directories and symlinks untouched.
- Known-file `*.tmp` leftovers (the `<file>.<pid>.<ms>.tmp` names `fsx.writeFileAtomic` leaves when a process is killed between write and rename): 1 hour, for `downloads/` (behind the gate, like everything there) and `runs/` (`phase1-*`, `params-*`, `run-*`); any other `*.tmp` keeps the 1 day rule. A test produces a real interrupted atomic write and checks the sweep recognises exactly that name.
- `cv-reed-anon-<id>.<ext>` gets its own class `cv-anon` (14 days as an orphan; no id or source, so it is not counted or logged as "never pushed").
- `require('./lib/screening/shadow').pruneShadow({days:180})` when present (dry run: counts with the same name and London-date rule; a throwing or missing function is reported in `summary.shadow` and the sweep still succeeds). `state/` and `secrets/` are never touched; verified byte for byte (hash and mtime).
- `lib/cv-retention.js`: the jail's name check was a regex containing a double-backslash literal, which trips the banned-token scan; it is now a hex-escaped character class. Behaviour unchanged (tests for slash, backslash, NUL). `static.test.js` now fails on any double backslash in the package sources.
- New flags: `--tmp-hours`, `--screening-input-hours`, `--shadow-days` (at least 1).

### 9.6 Not done here
- (Done in the integration pass, finding F8: the tick refuses to launch while `candidates.db` is missing, empty or corrupt - see docs/parity/integration.md. The operator preflight and the install docs still run `preflight-db.js` by hand.)
- No change to `date` semantics (London day vs UTC day), to `downloaded` (kept as legacy) or to `catererStats.downloaded`, which the legacy code fills from a `downloadError` field that nothing sets (so it equals the row count for the source).
- (Resolved in the integration pass: the launcher test compared the profile path with `/tmp/` although the test home itself lives under `/tmp` on Linux, and the jev engine test counted LLM calls while the 5% background audit sampled at random; both tests are fixed. The maintenance test passes in the current tree.)

## 10. Integration rehearsal changes (docs/parity/integration.md)

- **Incomplete runs.** `phase1Stats.incomplete` (a string such as `screening-unavailable` or `run-interrupted`) on the queue makes Phase 2 push the approved candidates but leave the territory unsearched and the pending search in place (its `spawnedAt` stamp removed, so the gate offers it again at once); `results.incomplete` records it. Phase 1 sets it when a screening outage stopped the run; `recover-stranded-phase1.js` sets it on a checkpoint queue (a queue without `phase1Stats`) of a killed phase 1.
- **Recovery of interrupted runs.** `recover-stranded-phase1.js` (called by cull-ghost every 5 minutes while idle) also handles a status file left `phase1_abandoned` or `phase2_starting` whose `approved-queue-<ts>.json` has candidates and no finished `phase2-results-<ts>.json`: it starts Phase 2 for that queue (at most 3 attempts, recorded in `phase2Recovery`; a finished results file only needs the status repaired; the child is adopted by the tick like any recovered run). Without it, candidates unlocked before a kill were never pushed and no later run would look at them.
- **Orphaned Phase 2 record.** A `run-*.json` left in `phase2_starting` or `phase2_pushing` by a killed Phase 2 is closed as `error` by the tick's orphan release (it otherwise held the run lock for 30 minutes).
- **Redaction.** `env.redact` also hides the secret-named values of `secrets/*.json`; `zoho-auth` no longer puts a token-endpoint response body into its error.

## 11. Review fixes 2026-09-30 (Phase 2 parity review, security review, coverage review)

Every item below has a regression test in `tests/lifecycle/phase2-hardening.test.js` that failed against the reviewed code (checked by running the new tests against the previous sources). Three assertions in existing tests changed on purpose: `childTimeoutMs` 30000 -> 150000 (`process-queue.test.js`), and `KEY_ORDER` gained `requestedBy` (`tests/dashboard/py/test_search.py`, dashboard package).

- **Reed halt no longer consumes the territory** (review 18). `phase1Stats.reed.screeningHalted` (or a flat `phase1Stats.screeningHalted`) sets `incomplete = 'reed-screening-unavailable'`: the approved Caterer candidates are still pushed, the territory is not marked searched and the pending search is kept with `spawnedAt` removed, exactly like the Caterer half.
- **A record we created ourselves gets its CV** (review 19). The Zoho id is written into `candidate-<id>.json` as `_zohoCreatedId` right after a successful create and before the attach (`createCandidate` ignores unknown keys). A `DUPLICATE_DATA` answer is treated as our own record (counted `new`, CV attached, then the normal deletion rule) when the id on file equals the returned id, or when an earlier attempt in the same call failed in a way that may still have created the record (timeout, dropped connection, non-JSON body; a clean Zoho rejection does not count). A genuinely pre-existing record keeps the old no-touch behaviour. The narrow window between the create and the file write is not closed.
- **Reprocess guard now matches `approved-queue-<ts>`** (review 24). The results file is looked up under the run id (queue name without the prefix). A second run of a finished queue prints `ALREADY_PROCESSED` and changes nothing. **`--force`** (`node scripts/process-approved-queue.js downloads/<queue>.json --force`) re-runs it on purpose: the results go to `phase2-results-<runId>-rerun-<UTC yyyymmddhhmmss>.json` with a matching `run_results` row (its `new_to_zoho` counts only what this pass created, so the dashboard sums stay right), the original results and row are never touched, the territory is not re-marked and no pending search is looked at. Rows the database already holds are `skipped`; if such a row still has its CV and a candidate file carrying the matching `_zohoCreatedId`, the CV is attached now and the leftovers are deleted (a failed attach from the earlier pass).
- **Partial failures are visible** (review 23). New alert `zoho-push-partial` (warn) when some but not all Zoho pushes failed; both it and `zoho-push-failing` carry the exact `--force` retry command. CVs and candidate files of failed pushes stay for the 14-day retention window as before. Deferred: an automatic re-push maintenance step.
- **Caterer CV download** (review 22). The download child gets its own 150 s timeout (`childTimeoutMs`), the browser downloads share a gate of 2 (`catererDownloadConcurrency`, Reed keeps `concurrency`), a failing browser download falls back to the direct fetch when the card has a `cvUrl`, and a download killed by its timeout is retried once before the candidate is pushed CV-less. UNVERIFIED-LIVE.
- **One bad candidate cannot end the run** (review 26). `fillMandatoryFields` (Step 4.5 and the MANDATORY_NOT_FOUND fallback) runs under `fillTimeoutMs` (30 s) and a try/catch: a throw or a stall becomes "nothing recovered" (`errors.jsonl` context `fill_mandatory`); building a profile from a malformed card is guarded too (`candidate_json`), and that candidate becomes a "No candidate JSON" error row. A CPU-bound parser stall cannot be interrupted by a timer (no child-process isolation yet).
- **Hostile CV text** (review 59). `fill-mandatory-fields.js`: extracted text is capped at 200 KB, the e-mail scan uses RFC-bounded quantifiers, and HTML stripping is a linear scan (the regex forms were quadratic: 100 KB of one character took 11 s). Test: 1 MB of local-part characters, a 60,000-`<script` document and a 60,000-`<` document all finish in milliseconds.
- **Session cookie only to the Caterer origin** (review 77, Phase 2 half). `downloadCvDirect` refuses any `cvUrl` whose origin differs from the Caterer base before the cookie is read. The `RESULTS_URL` check belongs to phase 1 (not changed here).
- **Deferred or not done**: review 25 (candidate JSON of candidates pushed without any CV stays 14 days: that is DESIGN 5.6 as written; the matrix test pins it), review 29 (full postcodes in `zoho-create-candidate.js` console lines: the fix is a five-line message change, but `tests/core/zoho.test.js` pins the current text and belongs to the core package; the exact replacement is in the package result), review 30 (comment style: the header of `process-approved-queue.js` is one line now; other packages' files untouched), review 74 (`caterer-download-cv.js` extension allow-list: not this package; the orphan CV is still swept after 14 days because the sweep accepts any alphanumeric extension, but the candidate is pushed without it), review 101 (Reed half forfeited while Reed is gated: needs a marker consumed by `queue-due-territories.js`).
