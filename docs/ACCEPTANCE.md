# ACCEPTANCE: the go-live checklist

Use this after `docs/INSTALL.md` step 11. The offline tests could not prove anything that needs the real Hermes instance, the live Caterer and Reed sites, the real Zoho account or the real AI Gateway. Every such item that the build and review phases collected (the "unverified live" lists of the `docs/parity/*.md` files and the integration rehearsal) is here, with the command that settles it.

The pipeline is already running when you start (INSTALL step 9 switched it on). This checklist decides whether it stays on and whether the old laptop system may be retired.

## How to use it

- **GATE** items block go-live. Each must be PASS, or be waived by the owner in writing in the chat, with a reason, in the waiver table (section 12). If a GATE cannot be met, pause the sourcing: `hermes -p resourcer cron pause resourcer-tick` and `hermes -p resourcer cron pause resourcer-queue-due`, and report.
- **WATCH** items do not block. Look at them on the review days named (day 1 = the first full day after the tick was switched on, day 3, day 7) and act as the last column says.
- Notation: `R` = `/opt/data/profiles/resourcer/workspace/resourcer`, `W` = `/opt/data/profiles/resourcer/workspace`, `P` = `/opt/data/profiles/resourcer`. The operator expands these and writes full paths in every command; never type `R`, `W` or `P` literally.
- Order: sections 1 to 7 in order (section 8 only with Reed). Sections 9 to 12 are the review schedule, the failure procedure, the decisions and the sign-off. The operator runs the commands and records the result line; the owner does the items marked HUMAN. The rules of `docs/INSTALL.md` section 0.2 apply (no secrets printed, no restarts, no code edits, stop on unexpected output).
- A section marked "Reed only" applies only when Reed is switched on (INSTALL step 12); write "Reed off" in the result column otherwise.

## 1. Go-live basics

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | GL01 | GATE | `sh W/tools/preflight.sh --final` | `PREFLIGHT_RESULT ... fail=0`, no `[needs step N]` line left |
| [ ] | GL02 | GATE | `node W/tools/check-manifest.js` | `MANIFEST_OK`, no `INSTALLED_CHANGED`; `git -C W status --porcelain` prints nothing (a lone `?? AGENTS.md` is fine) |
| [ ] | GL03 | GATE | `hermes -p resourcer cron list` | eight jobs, all enabled (`resourcer-tick`, `-queue-due`, `-alerts`, `-preflight`, `-keepalive`, `-backup`, `-maintenance`, `-retention`), each with the owner's delivery target and none with `local` (the INSTALL 9.6 check for the word `local` prints `0`); the wrappers are executable (GL01 shows the E10 PASS line) |
| [ ] | GL04 | GATE | `node R/scripts/pipeline-watchdog.js --status` | `lastTickAt` under two minutes old (between 05:00 and 23:59 London), `halt` null, `consecutiveFailures` 0, and `hermes -p resourcer cron runs <JOB_ID> --limit 3` (the id of `resourcer-tick` from `cron list`; by name the command printed nothing on 2026-10-01) shows recent runs about a minute apart with exit 0. `tick` is normally `null` (no tick process is executing at that instant; a tick with nothing to start ends in under a second); it is non-null with `alive` true and a small `heartbeatAgeSec` only while a run is being supervised. Never fail this item because `tick` is null |
| [ ] | GL05 | GATE | the test alert of INSTALL 9.7 (`alerts-deliver.js --test`) | the owner confirmed receipt on the real channel; the delay is written down; `grep -c alerts-test R/outbox/alerts-delivered.jsonl` prints `1` or more |
| [ ] | GL06 | GATE | the first run of INSTALL step 11 | exit 0 in `R/runtime/last-run.json`, `pool` above 0, `approved` above 0; the owner checked three new Zoho records (fields, city, CV attached, no duplicate) |
| [ ] | GL07 | GATE | HUMAN | the old laptop pipeline is stopped and stays stopped (its scheduler, watchdog and dashboard); the owner says so in the chat. Two systems on one Caterer account cause safe-list churn and duplicate unlocks |
| [ ] | GL08 | GATE | `ls R/secrets` and the Keys page | no `bundle-passphrase` file; no `BUNDLE_PASSPHRASE` key on the Keys page |
| [ ] | GL09 | GATE | HUMAN attestation, `docs/SECURITY.md` and `docs/TEARDOWN.md` | done or scheduled with a date: the GitHub token that sat in the old repository's remote address is revoked; the Reed password and the Zoho refresh token are rotated now that the bundle was restored; old chat transcripts and memory notes that contain credentials are purged; the old `.git` folder and credential files are deleted from the laptop |
| [ ] | GL10 | GATE | `stat -c '%a %n' P/.env R/secrets R/secrets/*.json R/state/caterer-session.json` | `600` for `.env` and every file, `700` for `secrets` |
| [ ] | GL11 | WATCH | day 1, 3, 7: `node R/scripts/alerts-deliver.js --dry-run --digest` | pulled count against 181 a day and 1,269 a week, runs, errors, halts, credits, backup age; no unexplained critical alert. Report the numbers |
| [ ] | GL12 | WATCH | day 1, 3, 7: `df -h /opt/data` and `hermes -p resourcer cron list` | disk under 85 percent used; all eight jobs still enabled |

## 2. Platform and tooling

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | BC01 | GATE | `bash W/tests/browser/smoke-linux.sh` (`timeout=600`) | `SMOKE_RESULT: ... fail=0` with NO line beginning `SKIP: chromium not found` (that line means the browser part was not tested; rerun with `CHROMIUM_PATH=<path from the preflight D3 line>` in front, INSTALL 4.3); the line about the CDP surface reads `false true`. A run whose only checks are the two host-fact PASS lines is not a pass |
| [ ] | BC02 | GATE | INSTALL step 8 | GO: `caterer-login.js --check` exit 0 twice, two minutes apart, from the datacenter address with headless Chromium 153. If Caterer's bot protection blocks it, the only fallback is a headed browser on a virtual display (`RESOURCER_AB_HEADED=1`): that is a code-level decision for the owner, not the operator |
| [ ] | BC03 | GATE | first real sign-in (INSTALL 8.1 to 8.2) | a safe-list block appears once; the `caterer-safelist` alert reached the channel; `caterer-login.js --open-link` cleared it; the following `--check` is exit 0 |
| [ ] | BC03b | WATCH | after the next instance restart or suspend (day 1 to 7): `node R/scripts/caterer-login.js --check` | exit 0 without a new e-mail link (the saved browser identity survives). If a new block appears every time, report: the state file is not being reused |
| [ ] | BC04 | WATCH | day 1: `SMOKE_LONG=1 bash W/tests/browser/smoke-linux.sh` (`timeout=600`, idle-time check step) | passes. If it reports the browser daemon killed while idle, every tick starts cold; watch how often `caterer-safelist` alerts appear |
| [ ] | BC05 | WATCH | day 1: compare Caterer credits before and after a run with the unlocked count in the digest | equal (no candidate unlocked twice: the browser tool must not re-send a slow command) |
| [ ] | BC06 | WATCH | when any `CHECK_ERROR` or `ERR_` text appears in `R/logs/*.log` | copy the error name into the report; two texts matter: name-resolution failures and redirect loops on the search page |
| [ ] | BC07 | GATE | the safe-list alert of step 8 | it reached the owner's channel (or, if step 8 raised none, GL05 covers delivery) |
| [ ] | BC08 | WATCH | accepted risk | the Caterer password is visible in the arguments of one short browser command for about a second on a single-user container; the owner accepts or asks for a change |
| [ ] | CO01 | GATE | INSTALL step 3 | `[preflight-db] OK`: `better-sqlite3` loads on Debian 13 and Node 26 (prebuilt or compiled, record which) |
| [ ] | CO02 | GATE | `node R/scripts/preflight-db.js` | `OK candidates=N journal=wal` or `journal=delete`; both are correct, record which |
| [ ] | CO07 | GATE | GL06 | the Caterer search regexes read the live page: `pool` above 0 |
| [ ] | PH01 | GATE | the first run with a busy postcode area | the console log `R/logs/phase1-console-<time>.log` shows more than one results page being read when the search has more than 50 candidates |
| [ ] | PH02 | GATE | `cat R/runtime/last-run.json` after the first run | `errors` 0; no line in the console log containing `AB_` or `Error:` from the browser tool |
| [ ] | PH07 | GATE | after the first run: `node R/scripts/preflight-db.js` and dashboard `/health` (owner) | `OK`; `dbOpen` true; no `db_unavailable` while a run was writing |

## 3. Data and secrets

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | BU01 | GATE | INSTALL 5.3 | `RESTORE_OK`; `migrate-schema` OK |
| [ ] | BU02 | GATE | HUMAN | the bundle passphrase never appeared in the chat or in a command; GL08 holds |
| [ ] | BU03 | GATE | `sha256sum W/data/resourcer-bundle.enc` | equals the digest printed by the build on the laptop (`BUNDLE_OK`), which the owner reads out |
| [ ] | BU04 | WATCH | time and lowest `grep MemAvailable /proc/meminfo` during INSTALL 5.3 | under one minute; memory never below 900 MB |
| [ ] | CO03 | GATE | GL06 and the alert list | Zoho token refresh and record create with attachment worked on the real account; no `zoho-push-failing`, no `cv-attach-failed`; preflight H4, H5 and H8 PASS |
| [ ] | CO04 | GATE | GL06, PDF CVs; command block CB1 | at least one pushed record has a CV attachment that opens (owner); CB1 prints `0` |
| [ ] | CO04b | WATCH | day 3 and 7: `grep -c -i mammoth R/logs/errors.jsonl` and one Word CV in Zoho (owner) | `0` errors; a Word CV attached and readable |
| [ ] | CO05 | WATCH | alerts `stranded-recovered` / `stranded-unrecoverable` | the first may appear after an interrupted run; the second must not. If it does: report the queue file name |
| [ ] | CO06 | WATCH | day 1: `grep -c CATERER_ R/logs/keepalive-*.log R/logs/preflight-*.log` | the 23:00, 02:00, 05:00 keep-alive and the 05:50 pre-flight ran; the markers are `CATERER_OK` or `CATERER_KEPT_ALIVE` |

## 4. Screening

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | SR01 | GATE | INSTALL 7.2 and 7.3 | the deep check is `"ok":true` with `"engines":{"jev":{"ok":true}}` (no `llm` entry); the batch canary approves the Chef de Partie and rejects the cashier; the single canary rejects with a `reject_` code, or is approved by the review policy (`sys_review_policy_approve`), which is recorded, not a failure; no chat-completions request was made |
| [ ] | SR02 | WATCH | day 1, 3, 7: command block CB2 (two counts) | the second count divided by the first is 0.95 or more (Jev answered ok in 95 percent of rows). Lower: report the codes printed by the fourth command; `http_403` may mean the account or the Vercel team restricted the model |
| [ ] | SR03 | GATE | preflight H3 | PASS, or INFO with a 404 for the credits endpoint (both acceptable); record which |
| [ ] | SR04 | WATCH | day 7: `node W/tools/screening-report.js --since 7d` | approve rate by source and role; the owner compares with the old system's rate. A big drop or rise: report. There is no promotion gate in `jev_only`: the verdict reads "not applicable in jev_only mode" (INSTALL 13) |
| [ ] | SR05 | WATCH | day 1 and 3: command block CB3 (four counts) | `0` for e-mails and for phone numbers; `0` for postcodes (a few false hits are possible: report the count, never the text); `0` for card texts that still start with a rank number (a 1 to 6 digit rank, then a dot: the redactor strips it, and with it the name after it, in any case; SCR-26). This checks the redaction on real cards without printing any candidate text. Names in lower case cannot be counted this way: the owner may look at a few rows with the reviewer present |
| [ ] | SR06 | GATE | INSTALL 7.5 | the zero-data-retention result and the owner's decision are written down |
| [ ] | SR07 | WATCH | `stat -c '%a' R/shadow/*.jsonl` | `600` |
| [ ] | SR08 | WATCH | day 1, 3, 7: command block CB2 (the third count divided by the first) and `node W/tools/screening-report.js --since 7d` | the share taken by the review policy should be near zero: Jev decides at least 99 percent of the cards (OD-J); above 1 percent report it (a change of card format shows as `why=invalid`, a wave of instruction-looking text as `why=injection`). Also read the forced share (about a sixth of decisions on the historical sample) and audit a sample of forced approvals (`--export-sample`, owner only). Above one half in policy: report at once (Jev's answers are unusable or the card format changed) |
| [ ] | SR09 | GATE | INSTALL 7.6 (an installed instance: docs/UPDATE-C.md step 7.4) | the two CV canaries: exit 0 each; the chef is `{"decision":"pass","final":"approve","lane":"jev"...`, the retail assistant `{"decision":"reject","final":"reject","lane":"jev"...`; `SCREENING_MODEL: typesafe-ai/jev` on stderr; the invented files are deleted |
| [ ] | SR10 | WATCH | day 1: `node R/scripts/cv-report.js --days 1 --mode shadow` | the CV stage (shadow) screened the CVs of every run that approved candidates: `screened` above 0 and the WHO DECIDED block prints; every candidate still went to Zoho. Zero rows after a full day with approved candidates: report (has `CV_SCREEN` been set to `off`?) |
| [ ] | SR11 | WATCH | day 3 and 7: `node R/scripts/cv-report.js --days 7 --mode shadow` | `Jev-decided` reads `ok (99% or more)` and `fallback lane` reads `ok (1% or less)` (the owner rule, OD-J, CVS-5); unreadable about 5 to 8 percent of all CVs (fails the check above 12); would-be rejects 1 to 5 percent (2 to 4 expected); forced about 6 percent. Outside: report the numbers and the reason codes, change nothing |
| [ ] | SR12 | WATCH | day 1, 3, 7: the alert list | no `cv-fallback-rate-high`, `cv-reject-rate-high`, `cv-forced-rate-high`, `cv-unreadable-rate-high`, `cv-shadow-stopped` or `cv-review-errors` (`cv-screening-unavailable` and `cv-reject-not-recorded` belong to mode `on` only). One alert on one queue is a note; repeats are reported |
| [ ] | SR13 | WATCH (HUMAN) | day 7, or after 300 screened CVs: `node R/scripts/cv-report.js --days 14 --mode shadow --forced --rejects` | the SWITCH-ON CHECK reads `numbers OK: only the panel review is left` (shadow screening of one queue stops after `phase2.shadowMaxSeconds`, 120 s, so a large queue or a slow Jev leaves its tail unscreened: read the screened count of the report, its block `UNSCREENED BY THE SHADOW STOP` (the share of the queued CVs the time cap left unscreened) and any `cv-shadow-stopped` alert, and do not accept a period whose sample is mostly small queues), and a panel of two or more recruiters, opening each candidate in Zoho, agrees with EVERY would-be reject of the period and with the 30 lowest-confidence forced decisions. One reject the panel would not have made is a stop: change one number (`docs/CV-SCREENING.md` section 5), wait for a new period. Only then may the owner decide DC9 |
| [ ] | SR14 | GATE | day 1: `stat -c '%a' R/shadow/cv-*.jsonl` and command block CB4 | `600`; CB4 prints `0`, `0`, `0`: no e-mail and no postcode in the CV log, and no results file with a positive `cvRejected` (in shadow the stage never blocks a candidate) |
| [ ] | SR15 | GATE | INSTALL 7.6, first command (an installed instance: docs/UPDATE-C.md step 7.1): `node R/scripts/cv-review.js --self-test` | exactly one line, `CV_SELF_TEST_OK pdf docx`, exit 0 (no network, no key). `CV_SELF_TEST_FAILED pdf:...` means the PDF or Word reader cannot load on this instance: every PDF would pass as unreadable, so STOP and report the line |

## 4b. Command blocks used by the tables

CB1 (CO04), prints one number, expect `0`:

```
grep -c -i -E 'pdf-parse|extractCvText' /opt/data/profiles/resourcer/workspace/resourcer/logs/errors.jsonl
```

CB2 (SR02, SR08): the number of rows, the number of rows where Jev answered ok, the number of rows decided by the review policy, and (only if the ratio is low) the failure codes:

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c '"mode":"jev_only"'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c '"jev":{"status":"ok"'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c '"used":{"engine":"policy"'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -o '"jev":{"status":"[a-z]*","kind":"[a-z]*","code":"[a-z_0-9]*"'
```

The fourth command prints only the status, kind and code fields (no candidate text). Report how many of each.

CB3 (SR05), four numbers, each expected `0`:

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+.[A-Za-z]{2,}'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c -E '(+44|0)[0-9][0-9 ]{8,11}'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c -E '[A-Z]{1,2}[0-9][0-9A-Z]? ?[0-9][A-Z]{2}'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c -E '"input":"[0-9]+[.] '
```

Never print the matching lines: they would be candidate text.

CB4 (SR14), three numbers, each expected `0`:

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/cv-*.jsonl | grep -c -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+.[A-Za-z]{2,}'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/shadow/cv-*.jsonl | grep -c -E '[A-Z]{1,2}[0-9][0-9A-Z]? ?[0-9][A-Z]{2}'
```

```
cat /opt/data/profiles/resourcer/workspace/resourcer/downloads/phase2-results-*.json | grep -c -E '"cvRejected": ?[1-9]'
```

The CV log holds numbers, reason codes and the platform candidate id only; the third command counts and never prints the results files, which hold candidate names.

## 5. Supervision, alerts, backups

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | SU01 | GATE | `hermes -p resourcer cron runs <JOB_ID> --limit 5` (the id of `resourcer-tick` from `cron list`) during a live run | runs about a minute apart, none stuck; while a 15 to 45 minute run is in flight the tick stays alive and `--status` shows one run only |
| [ ] | SU02 | GATE | INSTALL 9.3 | the probe shows `HERMES_HOME` equal to the profile home (`match=yes`), a `tool` line for node, timeout and xvfb-run that is not `MISSING`, `temp-dir=... writable=yes` (an unset `TMPDIR` is fine when `/tmp` is writable; a set one is 61 characters or less), and the profile `.env` readable |
| [ ] | SU03 | WATCH | INSTALL 9.3 second fire (the probe reports `DETACHED-SLEEPER ... GONE`: measured, a run does not outlive its cron run); then any run that crosses minute 55 of a tick | MITIGATED by the tick drain: the tick launches nothing after minute 38, waits out its own run and ends as soon as it is done (`tick end: launch-cutoff` in `logs/tick-*.log`), so a run that ends between minute 55 and 56 completes with exit 0 (not 13) and no `tick-hard-cap` alert appears. Still a known risk (KNOWN-LIMITS K-PLAT5) for a run that cannot finish by minute 56 of its tick, for example longer than 56 minutes: it is ended cleanly, recorded as exit 13 with reason `tick-hard-cap`, retried later, with one WARN alert. Report it if `tick-hard-cap` repeats |
| [ ] | SU04 | WATCH | `--status` plus preflight B1, B2 | the process identity checks work (tick alive true) and the memory numbers make sense for the instance |
| [ ] | SU05 | GATE | `node R/scripts/backup-db.js --auto` (`timeout=600`), then `--restore-test`, then `--list` | exit 0, exit 0, one encrypted file; done once by hand, ideally while a run is in flight (the online copy must work while the pipeline writes) |
| [ ] | SU06 | GATE | HUMAN | an off-instance copy exists: `BACKUP_UPLOAD_CMD` is set, `backup-db.js --auto` exits 0 (not 5), and the owner has restored from that copy once with the passphrase held off the instance; OR the owner waives it in the waiver table, accepting that the backups die with the instance |
| [ ] | SU07 | GATE | the test alert of GL05 | delivered |
| [ ] | SU07b | WATCH | day 1 and 2 | the 07:00 alive line and the 18:00 digest arrive on the channel (non-critical alerts are held from 22:00 to 06:00 London; critical ones arrive at any hour) |
| [ ] | SU08 | WATCH | day 1 after 05:50: `grep -c -i login R/logs/preflight-*.log` and `node R/scripts/caterer-login.js --check` | the 04:10 cache clean-up did not log the Caterer session out: no fresh sign-in was needed at 05:50 |
| [ ] | SU09 | WATCH | day 1 | `R/logs/preflight-<UTC date>.log` and `keepalive-<UTC date>.log` exist and end without an error line |
| [ ] | SU10 | WATCH | the memory samples taken in INSTALL 11.2 | the lowest MemAvailable during a run, next to the other profile: record it. Under 900 MB, or a `low-memory` alert that does not clear: report (the start floor is 700 MB, the review advised about 1,200 MB) |
| [ ] | SU11 | WATCH | `grep -c 'clock jumped' R/logs/tick-*.log` and the Zoho duplicate count | after any instance suspend the tick logs the jump and the run is neither killed nor started twice; no duplicate candidates in Zoho |
| [ ] | SU12 | WATCH (Reed only) | `node R/scripts/ensure-chrome-cdp.js --status` after a Reed run | `"cdp":false`, no browser left; a stopped Reed browser does not disturb the Caterer session |
| [ ] | SU13 | WATCH | rule | nobody starts a Reed tool by hand while a run is in flight |
| [ ] | HF01 | WATCH | `hermes -p resourcer config get cron.provider`; the preflight F6 line (`HERMES_SCALE_TO_ZERO=...`) | record both. The tick fires every minute from 05:00 to 23:59 and so keeps the instance awake all day (cost); with an external cron provider each fire is a wake-up. The owner decides whether that is acceptable |
| [ ] | HF02 | GATE | preflight F3 and F4 | Hermes timezone Europe/London; `cron.wrap_response` false |
| [ ] | HF03 | WATCH | day 1 | `tail -n 5 R/logs/tick-<UTC date>.log` shows ticks and no repeating error line |

## 6. Dashboard

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | DA01 | GATE | INSTALL step 10 | the tab is listed, `/api/plugins/resourcer/health` is 200 in the logged-in browser with `ok: true`, panels fill within about 5 seconds after the portal restart |
| [ ] | DA02 | WATCH | HUMAN, day 1: type an invalid postcode such as `XXXX` in the search form | a clear error and no new file: `ls R/pending-searches` is unchanged. Also check that the tab works after switching tabs and back (hidden panels) |
| [ ] | DA03 | WATCH | preflight G1 to G4 | the dashboard interpreter has fastapi and zoneinfo for Europe/London; record the versions |
| [ ] | DA04 | WATCH | during a run, HUMAN: the panels keep updating | no `db_unavailable`; the read-only database view works while the pipeline writes |
| [ ] | DA05 | WATCH | `ls R/runtime/caterer-status.json R/runtime/backup-status.json` | both exist after the first run and first backup; the Caterer state on the tab matches `caterer-login.js --check` |
| [ ] | DA06 | WATCH | the halt control, when no run is in flight; tell the owner first, this sends a critical alert: `node R/scripts/pipeline-halt-cli.js set test test`, look for the red banner within 5 seconds and press "Clear halt" in the tab, then `node R/scripts/pipeline-halt-cli.js get` | banner appears and disappears; `get` prints `{"halted":false}`. The supervisor would also clear this test halt by itself within a few minutes. Do not leave a halt set |
| [ ] | DA07 | WATCH | INSTALL 10.3 | record whether the owner could restart the dashboard from the portal; every later change to `plugin_api.py` needs the same |

## 7. First-cycle correctness (from the phase 1 and integration lists)

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | PH03 | WATCH | day 3: `node W/tools/request-search.js --job "Chef" --location ZE1 --sources caterer --cv-limit 10` and let it run | a remote area ends as an empty result, not an error: `last-run.json` shows `pool` 0 and `errors` 0 (if `errors` 1, report) |
| [ ] | PH04 | WATCH | day 1: `grep -c -i timeout R/logs/phase1-console-*.log` | `0` for every file (no unlock or screening call hit its time limit) |
| [ ] | PH05 | WATCH | week 1: `grep -c 'runner exited code 13' R/logs/tick-*.log` | `0` for every file (no run was killed at the 70 minute ceiling) |
| [ ] | PH06 | WATCH | week 1: `grep -c -i 'suppressed' R/logs/watchdog-runner.jsonl` and alerts `caterer-login-failed` | no sign-in attempt was suppressed; no `caterer-login-failed` |
| [ ] | IN01 | WATCH (Reed only) | memory samples during a Reed run | two browsers can overlap for a few minutes during Phase 2; the lowest MemAvailable stays above 900 MB |
| [ ] | IN02 | WATCH | any run killed while pushing | at most one candidate per kill can lack a CV (it was created but not attached); the owner checks Zoho records for the run |
| [ ] | IN03 | WATCH | `errors` in `last-run.json` per run | small (a few per run at most); a killed browser call is a per-candidate error by design |
| [ ] | IN04 | WATCH | any run that ends within minutes with `pool` 0 and `errors` 1 | a session that died mid-run consumes the territory (old behaviour). Do not queue more; run `caterer-login.js --check`; the next run signs in again; report the territory so the owner can requeue it |
| [ ] | IN05 | WATCH | `grep -c 'HALTED' R/logs/tick-<UTC date>.log` | a halt that clears and re-raises many times an hour means the check passes but real calls fail: `pause` the tick job and report |
| [ ] | IN06 | WATCH | HUMAN decision | the shadow screening log keeps redacted card text for 180 days (`docs/SCREENING.md` section 12): the owner accepts, or sets the text switch off |
| [ ] | IN07 | WATCH | after any real freeze and resume of the instance | one run only, no double push, heartbeat resumes within seconds |

## 8. Reed (only when Reed is switched on, INSTALL step 12)

| Result | ID | Class | Check | Expect |
|---|---|---|---|---|
| [ ] | RE01 | GATE (Reed) | INSTALL 12.2 | `REED_LOGIN_OK`. The real Reed login pages and its bot check were passed by a human once |
| [ ] | RE02 | GATE (Reed) | INSTALL 12.2 and three Reed runs later: `node R/scripts/reed-api-client.js --auth-state` | the port-forward route worked; the login survives several browser stop and start cycles with no new human login |
| [ ] | RE03 | GATE (Reed) | preflight H1 and the login output | egress country `GB`; the `ip=` shown by the login is a UK address; no `reed-451` alert |
| [ ] | RE04 | GATE (Reed) | the first Reed run | Reed candidates downloaded and pushed; the Reed daily count on the dashboard moved; no `reed-auth-failed` alert |
| [ ] | RE05 | GATE (Reed) | `cd W && NODE_PATH=R/node_modules REED_REAL_CHROMIUM=/usr/bin/chromium node --test "tests/reed/real-chromium.test.js"` | 0 failures (real Chromium 153 under the virtual display with the shipped flags) |
| [ ] | RE06 | WATCH (Reed) | memory samples | see IN01 and SU10 |
| [ ] | RE07 | WATCH (Reed) | after a Reed run | SU12 |
| [ ] | RE08 | WATCH (Reed) | day 1, 3, 7 after Update D (first-page failure, `docs/parity/reed-first-page.md`): attempts `grep -c '=== Reed Phase 1 ===' R/logs/phase1-console-*.log`, failures `grep -c '^\[reed\] REED_FIRST_PAGE_FAILED' R/logs/phase1-console-*.log` (each command prints one count per log file: add them up), then `node W/tools/reed-catchup.js` | failures are under 2 percent of attempts over the day (under 1 in 50; 2 percent is a design default chosen for this update, not an owner decision; the incident of 2026-09-30 was 12 in 33), and every failure is visible: the dashboard shows "Reed failed" on that run, one `reed-first-page-failed` alert was raised for the episode, and the catch-up dry run lists the territory (`failed`). Above 2 percent, or five failures in a row (the alert turns critical): report the `REED_REQUEST_FORENSIC` lines of the newest log with failures (attempt, status, code, token, sinceNavMs, navDuringRequest); change nothing. The wait times are settings (`docs/ENV.md`), the owner decides any change |

## 9. Day-by-day review of the first week (WATCH schedule)

| Day | Operator runs | Owner looks at |
|---|---|---|
| 1 (first full day, after 22:00) | GL02, GL04, GL11, GL12, PH04, SU08, SU09, HF03, SR05, SR10, SR12, SR14, BC05, CO06 | the numbers of the digest; three Zoho records; the alert channel got the 07:00 and 18:00 messages |
| 2 | GL04, backup age (`node R/scripts/backup-db.js --check-age` exit 0) | alerts received during the night |
| 3 | GL02, GL11, SR02, SR05, SR11, SR12, CO04b, PH03, DA06 | pulled count so far against 181 a day |
| 5 | GL04, GL12, IN05 | any `run-failures` or `territory-quarantined` alert |
| 7 | GL02, GL11, SR02, SR04, SR11, SR12, PH05, PH06, SU10, SU11, HF01 | weekly count against 1,269; decision to retire the old system; decision on Reed timing and on `BACKUP_UPLOAD_CMD`; the recruiter panel of SR13 and the decision DC9 |

If a WATCH item goes wrong, do not fix anything yourself. Report: what you ran, what it printed, the time, and the one action you recommend. The alert table in `hermes/AGENTS.md` says what each alert means.

## 10. When a GATE fails

1. Pause the sourcing: `hermes -p resourcer cron pause resourcer-tick` and `hermes -p resourcer cron pause resourcer-queue-due`. The other jobs stay on.
2. Report the ID, the command, the output.
3. The owner decides: fix and repeat the item, or waive it (section 12), or roll back (`docs/ROLLBACK.md`).
4. Resume with `hermes -p resourcer cron resume <name>` for each paused job only after the item is PASS or waived.

## 11. Items that are decisions, not checks

| ID | Decision | Owner's answer |
|---|---|---|
| DC1 | Zero data retention on or off (SR06, INSTALL 7.5) | |
| DC2 | Reed before or after the first cycle (INSTALL 9.8) and the cost of a later start (Reed halves of the territories processed meanwhile are not queued again) | |
| DC3 | Off-instance backup copy method (SU06) | |
| DC4 | External dead-man monitor URL set or not (INSTALL 6.1) | |
| DC5 | Alert channel and who reads it before 09:00 (INSTALL 9.4) | |
| DC6 | Shadow log keeps card text 180 days (IN06) | |
| DC7 | Scale-to-zero and always-awake cost (HF01) | |
| DC8 | When the old laptop system is retired (`docs/TEARDOWN.md`) | |
| DC9 (the technical blocker K-CV8 was fixed by Update C and is proven by rehearsal scenario 15; the live check of the CV canary, K-CV7, belongs to the shadow week) | CV screening from `shadow` to `on` (SR13) and the two decisions of `docs/CV-SCREENING.md` section 9 that are still open: whether a person may be turned down automatically and whether porter-only histories may be rejected for a chef search (DECISIONS OD-L; that a rejected person is screened again for another role was decided on 2026-10-01 and built, RS-1 to RS-4, `docs/RESURFACE.md`) | |

## 12. Sign-off and waivers

Waivers (a GATE that is not PASS but the owner accepts):

| ID | Reason | Risk accepted | Owner, date |
|---|---|---|---|
| | | | |

Sign-off: every GATE above is PASS or waived; the WATCH items are scheduled.

| Role | Name | Date | Note |
|---|---|---|---|
| Operator (the Hermes agent) | | | |
| Owner | | | |
