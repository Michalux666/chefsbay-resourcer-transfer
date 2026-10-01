# Parity: CV stage package (CV screening between the download and Zoho)

Owner: the "CV stage" work package. There is no legacy counterpart to port: the legacy Phase 2 (`workspace-resourcer/scripts/process-approved-queue.js`, 1,422 lines, line numbers below refer to it) pushed every candidate to Zoho as soon as the CV was downloaded and never read the CV. The only screening before the push was the search-card snippet, before and after the unlock (`ai-review.js`, the screening package). This document therefore maps the stage to the legacy step it was inserted into, records how it plugs into Phase 2, lists the decisions applied on top of the reviewed patch, and states what stays exactly as it was.

New files: `resourcer/scripts/lib/cv/**` (adapters, gate, questions, config, caches, Jev client, shadow log, Phase 2 step, six vendored corpus modules, three stubs), `resourcer/scripts/cv-review.js`, `resourcer/scripts/cv-report.js`, `resourcer/config/cv-screening.json`, `docs/CV-SCREENING.md` (the owner's guide), `tests/cv/**`. Changed: `resourcer/scripts/process-approved-queue.js` (section 3), `tests/lifecycle/helpers/harness.js` and `tests/lifecycle/real-modules.test.js` (one line each, section 6). No new npm dependency, no schema change, no new cron job, no new dashboard field.

## 1. Operator commands

| When | Command | Notes |
|---|---|---|
| Every Phase 2 run | `node scripts/process-approved-queue.js <queue.json>` | reads `CV_SCREEN` (`shadow` by default, `on`, `off`); exit 2 is new: held because CV screening (mode `on`) could not reach Jev, nothing lost, retried by the stranded-run recovery |
| One CV by hand | `node scripts/cv-review.js --job "<searched role>" --cv-file <path> [--known-file <json\|->] [--mode shadow\|on\|cli]` | one JSON line on stdout; exit 0 decision, 1 usage or internal, 3 Jev unavailable (`API_UNAVAILABLE:<detail>`); `--help` |
| Weekly, and before switching to `on` | `node scripts/cv-report.js --days 7 --forced` | `--mode shadow\|on`, `--rejects`, `--from`, `--json`; the SWITCH-ON CHECK block; `docs/CV-SCREENING.md` section 10 |
| Back out | `hermes -p resourcer config set CV_SCREEN off` | strict no-op from the next run |

Settings (registered in `docs/ENV.md`): `CV_SCREEN` (default `shadow`), `CV_SCREEN_CONFIG_FILE`, `CV_SCREEN_CONCURRENCY`, `CV_FALLBACK_POLICY`, `CV_REJECT_ABOVE`, `CV_PDF_PARSE_DIR`; the Jev transport reuses the screening settings. Everything else is in `config/cv-screening.json` (built-in copy `lib/cv/defaults.json`, identical content, checked by a test).

## 2. Legacy step -> new code

| Legacy | New | Status |
|---|---|---|
| 552-616 Step 3: parallel CV download | `process-approved-queue.js` Step 3 (unchanged) | the stage starts after it |
| 617-679 Step 4: candidate JSON files | Step 4 (unchanged) | the JSON gives the reviewer the candidate's own name, e-mail, phone and postcode to remove from the CV |
| 680-711 Step 4.5: mandatory-field recovery | Step 4.5 (unchanged) | runs before the stage so a CV read for recovery is not read twice |
| (nothing) | **Step 4.6** `cvStage.screenCandidates` (`lib/cv/phase2.js`) | new: one `cv-review.js` child per CV, `CV_SCREEN_CONCURRENCY` at a time |
| 712-900 Step 5: sequential Zoho push | Step 5; a candidate rejected by the stage is a `cv_rejected` row and is not pushed | new row status, `phaseResults` and the results file only |
| 901- Step 6: results file | Step 6; two optional keys `cvRejected` and `cvScreen` when the stage ran | absent when the mode is `off` |
| 1253 Step 7.5: chat report | `notify()` alerts | the stage's alert keys are in section 5 |
| `candidates-db.js` `rejectCandidateForTitle` (166-172; `origin` `'pipeline'`) | `lib/cv/phase2.js` `recordRejection` (origin `cv:<reason codes>`, `reed_id` for Reed) | same table, same scoping by job title, same "idempotent" insert; the schema is never changed; `reason_code` is filled only when the optional column exists |
| `candidates-db.js` `checkCandidatesBatchScoped` (`unlocked = 1` is always skipped) | unchanged | why a rejected person is not offered again for another role (`docs/CV-SCREENING.md` section 6) |
| `lib/cv-retention.js` `removeCandidateArtifacts` | called by Phase 2 `removeCvArtifacts` for a reject | the one place a candidate's CV and JSON are deleted |
| `ai-review.js` (snippet, before and after the unlock) | unchanged | the stage shares nothing with it but the HTTP helper, the error classes, the halt reason strings and the pool helper (section 2b) |

### 2b. What the stage imports from the rest of the repository

The whole list; keep these exports stable or update the stage. `lib/screening/http.js` (`request`), `lib/screening/errors.js` (`HttpFailure`, `ScreeningUnavailable`, `UsageError`, `reasonKeyOf`), `lib/screening/pool.js` (`mapPool`), `lib/env.js` (`get`, `redact`), `lib/fsx.js` (`ensureDir`, `writeFileAtomic`, `writeJsonAtomic`, `readJson`, `safeUnlink`), `lib/paths.js` (`HOME`, `CONFIG`, `STATE`, `RUNTIME`, `SHADOW`), `lib/time.js` (`londonParts`), `lib/notify.js`, `lib/pipeline-halt.js` (`getHalt`, `setHalt`), `lib/cv-retention.js` (through Phase 2, unchanged) and, lazily, `lib/screening-health.js` (`REASONS`, `REMEDIES`; if they are renamed, `haltFor()` in `lib/cv/phase2.js` falls back to its own generic reason). It does not read `SCREEN_ENGINE`, `SCREEN_ALLOW_LLM`, `SCREEN_REVIEW_PRE`, `SCREEN_REVIEW_POST`, `SCREEN_LLM_*` or `config/screening.json`, so the Jev-only engine and its review policy can change without touching it, and the reverse. The one rule that both share is the transport: a change of the retry rules in `lib/screening/http.js` applies to both.

## 3. Phase 2 integration (`process-approved-queue.js`, lines of the merged file)

| Line | What |
|---|---|
| 13 | `require('./lib/cv/phase2')` |
| 32 | `cvScreenTimeoutMs: 180000` in `DEFAULT_CONFIG` (one reviewer; the Jev part has its own 90 s deadline) |
| 67-69 | test seams in `realDeps()`: `cvScreenMode`, `cvScreen`, `cvConfig`; the mode is `cvStage.mode(env.get('CV_SCREEN'))`, so unset means `shadow` |
| 657-678 | the mode and config, the `holdRun` helper (outage: status `error` `cv-screening-unavailable`, halt, critical alert, recovery attempt refunded, exit code 2), and the early hold when the screening halt is already up (mode `on` only) |
| 698 | `removeCvArtifacts`, the single deletion helper |
| 723 | idempotent short cut: a candidate rejected earlier for this job title is not downloaded again (mode `on`) |
| 859-899 | Step 4.6: skipped with one line when the mode is `shadow` and the screening halt is up; the screening; the outage hold (`on`); the shadow stop warning; the summary line; the alerts |
| 928 | Step 5: `cv_rejected` rows |
| 1148, 1243 | `cvRejectedCount`; `cvRejected` and `cvScreen` in the results file when the stage ran |
| 1464, 1484-1490 | the final summary line; the alerts `cv-reject-not-recorded` and `cv-review-errors` |
| end | the usage text: exit code 2 |

The patch's `process-approved-queue.diff` applies to the repository file byte for byte (the file was identical to the snapshot the patch was built on: same sha256), so nothing was merged by hand. The changes of section 4 were made on top.

## 4. Decisions applied on top of the reviewed patch

The default `shadow` mode (a) follows the owner's instruction that shadow is only the first step of CV screening. The other rows (the alert ceilings, the shadow stop, the cache lifetime) are reviewer or assistant defaults: design defaults, not yet confirmed by the owner (see the CVS rows of `docs/DECISIONS.md`).

| Decision | Where | Tested in |
|---|---|---|
| (a) `CV_SCREEN` defaults to `shadow`: unset, empty and unrecognised values (with a warning) are `shadow`; `off` (also `0`, `false`, `no`, `none`, `disabled`) is a strict no-op; `on` enforces | `lib/cv/config.js` `screenMode`; `process-approved-queue.js` line 67 | `tests/cv/config.test.js`, `tests/cv/phase2.test.js` (mode from the environment), `tests/cv/phase2-modes.test.js` (nothing configured, typo, off) |
| (b) A request the gateway refuses as malformed (transport kind `request`: 400, 404, 422 and any other 4xx that is not 401, 402, 403, 408, 429) is asked once and is the per-CV `answers_invalid` (fallback lane, policy approve); the 3-in-a-row streak guard (`jev.invalidStreakMax`, shared with unusable answers) escalates to an outage with reason key `error`; 5xx, 429, timeouts, 401, 402, 403 and network errors are outages at the first CV | `lib/cv/jev.js` `ask`; `lib/cv/index.js` (the `!main.ok` branch); `lib/cv/levels.js` (a refused level request gives level `unknown`) | `tests/cv/refused-requests.test.js`, `tests/cv/jev.test.js`, `tests/cv/phase2-modes.test.js` (both modes end to end) |
| (c) Alert ceilings: reject rate 0.10 with at least 10 CVs, forced 0.35, unreadable 0.30, fallback 0.05 (at least 20 modelled CVs); "above", never "at"; in shadow mode the reject alert says "would have rejected" | `lib/cv/defaults.json`, `config/cv-screening.json`, `lib/cv/phase2.js` `alertsFor` | `tests/cv/alerts.test.js`, `tests/cv/phase2.test.js` |
| (d) Shadow mode with a hung or failing gateway stops early: after `phase2.shadowStopAfterFailures` (5) CVs in a row that could not be screened the rest of the queue is skipped, reviewers still running are killed, one WARN alert `cv-shadow-stopped`, nothing blocked, no halt. Only a CV that needed a Jev request resets the count. A screening halt that is already up skips the stage for the queue (shadow only). Mode `on` is unchanged: the first outage holds the queue | `lib/cv/phase2.js` `screenCandidates` and `runCli` (an `AbortSignal`), `process-approved-queue.js` | `tests/cv/phase2-modes.test.js` |
| (e) The search-level cache has a lifetime: `cache.searchLevelTtlSec`, 30 days (0 = ask every time) | `lib/cv/cache.js` `SearchLevels`, `lib/cv/index.js` | `tests/cv/cache-ttl.test.js` |
| (f) No script edits the shared documents: `apply-docs.js` of the patch is not part of the tree (a static test asserts that no file of that name ships); the rows it would have written are in the package result for the finalizer | `tests/cv/static.test.js` | |
| Report | `cv-report.js` gains the SWITCH-ON CHECK block (enough CVs, Jev-decided, fallback, unreadable, reject rate; the two panel items are printed as `[people]` lines) and `--rejects` | `tests/cv/report.test.js` |
| Reviewer label | `cv-review.js --mode shadow\|on\|cli`, passed by Phase 2, so shadow rows are labelled `shadow` even when `CV_SCREEN` is not set anywhere (the default) | `tests/cv/phase2-modes.test.js` |

## 5. Alert keys (registered in `hermes/AGENTS.md` and `docs/OPERATIONS.md` section 11 by the release)

`cv-reject-rate-high`, `cv-fallback-rate-high`, `cv-forced-rate-high`, `cv-unreadable-rate-high`, `cv-screening-unavailable` (CRITICAL, mode `on`), `cv-reject-not-recorded`, `cv-review-errors`, `cv-shadow-stopped` (new, mode `shadow`). All WARN except `cv-screening-unavailable`.

## 6. Behaviour that must not change, and what proves it

| Behaviour | Proof |
|---|---|
| A reject deletes only that candidate's CV and JSON, and only after the rejection row is written; a rejection that cannot be written keeps the files and repeats next run | `tests/cv/phase2.test.js` (reject, record failure, outage keeps every other candidate's files) |
| `CV_SCREEN=off` is byte-identical to a build without the stage: no reviewer process, no Jev request, no `cvRejected` or `cvScreen` key, no file of the stage, no console line | `tests/cv/phase2.test.js`, `tests/cv/phase2-modes.test.js`; the lifecycle suites run Phase 2 with the mode `off` (their harness sets it in one line: they test the Zoho lifecycle, the stage has its own suite). One-off proof at merge time: the file of commit d60d917 (before the stage) and the merged file, both with `off`, run on the same fake queue (four candidates, one without an e-mail address) gave the same 39 console lines, the same 23-key results file (apart from timestamps and timings), the same files on disk and the same alerts |
| Unreadable and no-work-history CVs pass through, are never rejected whatever the fallback policy, and are counted separately (`could not be read` against `read but no work history found`) | `tests/cv/stage.test.js`, `tests/cv/report.test.js` |
| A Jev outage in the middle of a queue in mode `on` holds the queue with nothing lost: nothing pushed, every other CV and queue entry kept, the screening halt raised with the fixed reason strings, one critical alert, exit code 2, the recovery attempt refunded | `tests/cv/phase2.test.js` |
| The stage calls one model (Jev) on one route, never reads `SCREEN_ENGINE`, `SCREEN_ALLOW_LLM` or `config/screening.json` | `tests/cv/static.test.js` |

## 7. The vendored modules and the coding standard

`lib/cv/vendor/` holds six modules of the corpus agent (`text-extract.js`, `pdf-layout.js`, `cv-lexicon.js`, `cv-redact.js`, `date-parse.js`, `role-parser.js`) with only mechanical edits; their own tests are in `tests/cv/vendor/` (80 tests). They are the reader, redactor and parser used in production, and `tests/cv/adapters.test.js` fails if a merged tree ever falls back to the stubs. DESIGN section 9 applies to them in full: `tests/cv/static.test.js` checks that they, the stubs, `cv-report.js` and every test file are ASCII with LF line endings, hold no banned token and no double-backslash literal (the source builds its backslashes from `String.fromCharCode` or `\`), require nothing but Node built-ins and the two packages the pipeline already has, never exit the process and spawn nothing. Nothing had to be changed in them. Two deliberate exemptions, listed here so nobody reads them as an oversight:

1. **The job-title rule** (no job, level or industry word in shipped code) does not apply to the vendored modules: `cv-lexicon.js` is a list of about 350 occupation, employer and section words by design. It never decides anything; the decision code, the gate, the questions and the config loader are all under the rule.
2. **Comments.** The vendored files keep the header and section comments of their source (they are compared with the corpus agent's tree by the lab's `--check` tool, so they were not rewritten); the files written for this repository follow the one-line rule as far as the reviewed patch did, and several long header comments explain interfaces. No comment holds a secret or personal data.

Known dead code in a vendored file: `createExtractorPool()` of `text-extract.js` loads a worker file (`extract-worker.js`) that is not shipped. Nothing calls it (the adapter uses `extractText` only, and its test was left out); it is kept so the module stays identical to its source.

## 8. UNVERIFIED-LIVE (for the acceptance list)

- The stage has not run on a real Hermes instance, against the real gateway, or on real CV files since the calibration (`docs/CV-SCREENING.md` section 8: 250 real files once, 607 redacted records repeatedly). The first live shadow week is the acceptance (`docs/CV-SCREENING.md` section 10).
- What the real gateway answers to a malformed request beyond the one observed case (HTTP 400 for a lone surrogate, fixed by cleaning); the streak guard is the protection.
- Behaviour of a hung real gateway: the arithmetic (5 failures divided by the reviewers at once, each up to the 90 s Jev deadline) is tested with fakes only.
- `pdf-parse` on the Linux instance (it is a resourcer dependency and is loaded by the vendored reader; `CV_PDF_PARSE_DIR` is the escape hatch).
- The cost of the default shadow mode on real traffic (one to two Jev requests per CV).

## 9. Tests

`tests/cv/*.test.js` and `tests/cv/vendor/*.test.js` run offline (a fake Jev gateway and a fake Zoho on 127.0.0.1, temp directories, fake secrets, a net guard). Run them one file at a time or with `node --test --test-concurrency=1 "tests/cv/*.test.js" "tests/cv/vendor/*.test.js"` (quote the globs). Shared Phase 2 harness: `tests/cv/helpers/phase2-run.js`.


## 10. Finalizer round (Update B, 2026-09-30)

What the merge left to the finalizer, now done, and what the full run found.

| Item | What |
|---|---|
| Settings and alert keys | `docs/ENV.md` has a CV screening section (`CV_SCREEN` default `shadow`, `CV_SCREEN_CONFIG_FILE`, `CV_SCREEN_CONCURRENCY`, `CV_FALLBACK_POLICY`, `CV_REJECT_ABOVE`, `CV_PDF_PARSE_DIR`) and the reused gateway settings name the CV stage as a reader. `hermes/AGENTS.md` and `docs/OPERATIONS.md` section 11 hold the eight alert keys with the ceilings of this tree (reject 10 percent, forced 35, unreadable 30, fallback 5), including `cv-shadow-stopped`; the rows of the patch's `apply-docs.js` (default `off`, reject ceiling 60 percent, no `cv-shadow-stopped`) were not used. `tests/docs/docs-consistency.test.js` now also reads `CV_` names read through a local alias (`getEnv('CV_...')`). |
| Decisions and limits | `docs/DECISIONS.md`: `OD-J`, `OD-K`, `OD-L` and the new section 15 (CVS-1 to CVS-10); `docs/KNOWN-LIMITS.md` K-CV1 to K-CV7; `docs/ACCEPTANCE.md` SR09 to SR14, CB4, DC9; `docs/SECURITY.md` (the CV shadow log and caches, the third-party flow of structured work histories, Article 22 for automated rejection, erasure); `docs/OPERATIONS.md` section 13.1; `docs/INSTALL.md` 7.6 (two invented CVs) and 11.1; `hermes/skills/resourcer-ops/SKILL.md`; README, HANDOFF, LEGACY-MAP. |
| Update note | `docs/UPDATE-B.md` for an instance at commit d60d917: pull, digest, AGENTS.md and the skill, four canaries (snippet batch and single, a chef CV that must pass, a retail CV that must reject), no setting to change, how to watch the first shadow rows, rollback. Tests: `tests/docs/docs-consistency.test.js` (command hygiene and order, the canaries equal INSTALL 7.3 and 7.6 character for character, exactly the changed installed files, `CV_SCREEN` defaults to shadow everywhere). |
| Real CVs in the end-to-end world | The fake Caterer CVs ended in a contact block and skills but no employment history, so the stage could only call them unreadable; with 26 CVs scenario 7b raised `cv-unreadable-rate-high` (the alert is correct, the fixture was unrealistic). `tests/e2e/lib/data.js` gives every fake CV a one-job history (`cvTitles` makes one candidate a retail assistant) and every fake Reed CV a one-job text (`E2E_REED_CV_TEXT`, `tests/e2e/lib/fake-chromium.js`); the shared fake gateway (`tests/fake-gateway/server.js`) answers the CV questions with the keyword brain of `tests/cv/helpers/fake-jev.js`. |
| New scenario 14 | `tests/e2e/14-cv-screening.e2e.js`, the whole pipeline under the cron wrapper and a scrubbed environment (the reviewers must read the key from the profile `.env`): (a) nothing configured: shadow, five records in Zoho as before, one 0600 row per CV, no name, e-mail, employer or CV text anywhere on disk, no alert; (b) `CV_SCREEN=on`: a retail history is not pushed, its files are deleted, `candidate_rejections` gets a row for the job title with origin `cv:...`; (c) `CV_SCREEN=off`: no CV request, no row, no cache file, no results key. |
| Scenario 3c | A Jev outage with the default CV mode now also stops the CV stage after five CVs: the test expects exactly the WARN alert `cv-shadow-stopped`, no CV row and five records in Zoho. |
| Live canaries | The four canaries of UPDATE-B were run once through the real gateway (2026-09-30, the lab's live guard: key from its file by path, only POST `/typesafe/v1/systemone` with `typesafe-ai/jev`; 9 requests in all): the batch approved the chef and rejected the cashier (`approve_level_match`, `reject_unrelated_industry`), the single call rejected the cashier, the chef CV was `pass` (pReject 0) and the retail CV `reject` (`no_relevant_experience`, `career_change`, pReject 1), both lane `jev`, `SCREENING_MODEL: typesafe-ai/jev`. Still UNVERIFIED-LIVE: everything on the real Hermes instance. |
| Report cosmetic | With no rows `cv-report.js` printed `ok (99% or more)` next to a zero share; the SWITCH-ON CHECK block was correct (`[NOT YET]`). Fixed in Update C (section 11): `no data yet`. |
| Tests | Update B run (superseded by the run in `README.md`; the Update C tests are in `tests/cv/` and `tests/release/`). Fresh WSL copy, Node 22.22.1: the whole unit suite 2,482 tests, 2,476 pass, 0 fail, 6 skipped (see docs/parity/screening.md 7.5). End to end: all 14 scenarios (`bash tests/e2e-linux.sh`). Scenario 6 (suspend and resume) failed once in a first run made while other processes were loading the same machine ("never two at once", a sampling of process counts) and passed in every later run; nothing in the CV stage starts a `phase1.js` process. |

## 11. Update C (2026-09-30): what changed in the CV stage and the supervision around it

An instance at commit a7fc7be is not covered by the release note: it stops and asks the owner (`docs/UPDATE-C.md` step 2). The numbers of the operating point and the criteria are untouched; `CV_SCREEN` still defaults to `shadow`.

| Area | Change |
|---|---|
| Halt and canary (F1) | `lib/cv/canary.js` (one small invented request through `CvJev`, the question set of a one-job history, one try, nothing cached or logged) is asked by the deep check of `lib/screening-health.js` while `CV_SCREEN` is `on`, after the snippet canary; a halt raised by `holdRun` therefore clears only when the CV route answers. `phase1/cv-hold.js` (called before each page and before each unlock) ends a run early while the stage is `on` and the halt is up. `recover-stranded-phase1.js` leaves a status file with `phase2Hold` alone while the screening halt is up. Proven by `tests/e2e/15-cv-halt.e2e.js` (and its negative control) and `tests/supervision/phase2-held.test.js`. |
| Held runs (F9) | Phase 2 exit 2 becomes exit 14 of `phase1.js`/`run-pipeline.js` (`lib/phase2-exit.js`), runner exit 14 `phase2-held` (faultless: the claim is released), `handleResult` records it without a failure count. `run-pipeline.js` reports no results file and runs no optimiser for a held Phase 2; `phase2Hold` is removed from the status file when Phase 2 completes. |
| Fail closed (F3, F4) | `lib/cv/config.js` computes `cfg.fault` from the file alone (unknown keys stay warnings); `screenCv` throws `ScreeningUnavailable` (reason key `cvconfig`) on a fault, `cv-review.js` exits 3; Phase 2 holds (mode `on`) or skips the stage with `cv-config-invalid` (shadow). `screening-health.js` has the reasons `config` (`screening criteria invalid`) and `cvconfig`, its cheap check reads both files (the CV file only while `on`). `reasonKeyOf` maps kind `config`. |
| Shadow time limit (F7) | `phase2.shadowMaxSeconds` (120; 1 to 3600): a timer in `screenCandidates` aborts the running reviewers and skips the rest; the stats carry `shadowStoppedBy` (`failures` or `time`). |
| Bookkeeping (F5, F6, F12) | `primaryReasonCode` for `candidate_rejections.reason_code`; `cvScreen.rejectedEarlier` and `scope`; `run_results.skipped` and the territory `skipped` include `cvRejected`; `cv-report.js` `no data yet`. |
| Cache (F11) | `SearchLevels.put`: lock file, read again, merge, atomic write (`tests/cv/cache-concurrency.test.js`: eight processes, three rounds). |
| Install checks (F8) | `lib/cv/selftest.js` and `cv-review.js --self-test`; `ai-review.js --no-shadow`; `readRows` skips run ids that start with `install-canary`. |
| Redaction (F10) | `lib/screening/redact.js`: honorific, particle, initial, combining-mark, typographic-apostrophe and caseless-script leading names; labelled and long numbers. The counts-only scans (redacted backtest sample and CV corpus) are summarised in docs/KNOWN-LIMITS.md K-CV14. |

## 12. Release (Updates C and D installed together)

One addition to the CV stage: a shadow queue that was cut short leaves a `kind: queue-stop` line in the daily CV shadow file (`lib/cv/shadow.js` `buildQueueStopRow`, written by `lib/cv/phase2.js` `logShadowStop`, read by `readQueueStops`; `readRows` never returns it) and `scripts/cv-report.js` prints the block `UNSCREENED BY THE SHADOW STOP` (DECISIONS CVS-19). Tests: `tests/cv/report-cap.test.js`, `tests/cv/phase2-updatec.test.js` (F7), `tests/cv/phase2-modes.test.js`. The broken-file warnings of `lib/cv/config.js` now say the built-in numbers are for display only and nothing is decided on them. The interplay with the Reed fix is in `docs/parity/reed.md` R34 and `tests/release/`.
