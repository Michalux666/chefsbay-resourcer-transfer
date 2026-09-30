# Parity: supervision (WP5) - bounded cron tick, runner, alerts, backups, maintenance

Owner: WP5 "supervision". Legacy source (read-only): `workspace-resourcer/scripts/pipeline-watchdog.js` (291 lines), `watchdog-runner.js` (498), `cull-ghost-phase1.js`, `recover-stranded-phase1.js`, `queue-due-territories.js`, `lib/pipeline-halt.js`, `lib/screening-health.js`, `gateway-health-check.js` (dropped). Line numbers below refer to those files.

New files:

| File | Role |
|---|---|
| `resourcer/scripts/pipeline-watchdog.js` | The supervision tick (`--tick`), one-iteration mode (`--once`), `--queue-due`, `--status`, `--clear-cooldown`, `--release-quarantine <file>` |
| `resourcer/scripts/watchdog-runner.js` | One run of one territory (gate, claim, init status, params, session check, phase1, outcome) |
| `resourcer/scripts/lib/tick.js` | PID-liveness locks, process identity tokens, kill of a process tree, run record, adopted-process registry, the single "is a run in flight" authority |
| `resourcer/scripts/alerts-deliver.js` | Outbox to stdout: dedupe, quiet hours, held alerts, 18:00 digest, 07:00 alive line, the independent watch on the tick (`tick-silent`), dead-man ping every 55 minutes while the tick is alive, `--test` |
| `resourcer/scripts/backup-db.js` | Nightly encrypted online backup, retention 14 daily / 8 weekly, restore test, upload hook, age check |
| `resourcer/scripts/maintenance.js` | runs/ prune, log rotation, Chrome cache cap, temp files, outbox, disk guard, monthly VACUUM, memory guard |
| `hermes/scripts/resourcer-{tick,queue-due,alerts,maintenance,retention,backup,preflight,keepalive}.sh` | Thin POSIX cron wrappers |
| `hermes/cron/jobs.json` | The eight job specs with the exact `hermes cron create` strings, and `installSteps` (the one-time commands, not cron) |
| `resourcer/scripts/pending-gate.js` | The queue gate: validates pending searches and quarantines malformed ones (`pending-searches/.quarantine/`), stale-spawn rotation, `--mark-spawned` |
| `tests/supervision/*.test.js` | 330+ tests (see section 9) |

Contract: DESIGN 5.5, 7, 8, 9, 10; research `hermes-operations.md` (sections 1, 3, 4, 12), `current-system-review.md` (1, 3, 4.1, 5.1 items 3/4/10, 5.2, 5.3, 6) and the incident notes on the watchdog.

## 1. Operator commands

| When | Command | Notes |
|---|---|---|
| Health at a glance | `node scripts/pipeline-watchdog.js --status [--scan]` | JSON: tick lock, run record, busy, back-offs, halt, queue depth, last runs; `--scan` (Linux) lists pipeline processes not tracked by a run record |
| A territory was quarantined (critical `territory-quarantined:<file>` alert) | fix the cause (`logs/phase1-console-*.log`), then `node scripts/pipeline-watchdog.js --release-quarantine <file>` | moves `pending-searches/.quarantine/<file>` back into the queue with its claim and failure counters cleared; `--status` lists `quarantined` |
| After fixing a Caterer session by hand | `node scripts/pipeline-watchdog.js --clear-cooldown` | drops the exit-11 and launch back-offs (replaces "pm2 restart" to clear the in-memory back-off) |
| Run one iteration by hand | `node scripts/pipeline-watchdog.js --once` | same code as the tick, one pass |
| Queue due territories now | `node scripts/pipeline-watchdog.js --queue-due` | idempotent, paced (4.5 min) and locked, shared with the tick |
| Backup now / verify / restore | `node scripts/backup-db.js --auto` / `--restore-test` / `--verify <file>` / `--restore <file> --out <path> [--force]` | decrypt commands accept `--passphrase-file`; `--list`, `--check-age` |
| Alerts by hand | `node scripts/alerts-deliver.js [--dry-run] [--digest] [--test]` | prints what would be delivered; `--test` queues one critical test alert (the next run of the alert job delivers it to the channel) and prints the line it will produce |
| Housekeeping by hand | `node scripts/maintenance.js --daily` or one of `--runs --logs --chrome-cache --tmp --pre-migrate --outbox --disk --vacuum --mem`, `--dry-run`, `--json` | exit 3 = critical condition (disk above 85 percent, or memory below the floor for `--mem`) |
| Retention sweep by hand | `node scripts/retention-sweep.js [--dry-run]` | owned by the lifecycle package; its own cron job since the integration pass |
| Create the cron jobs | the `cliPaused` strings in `hermes/cron/jobs.json` with the human's delivery target substituted for `<DELIVER_TARGET>` (both `--deliver` and `--failure-deliver`; never `local`); prerequisites (timezone, `cron.wrap_response false`) first | eight jobs |
| Install sequence | `installSteps` in `hermes/cron/jobs.json`: `migrate-schema.js`, `backfill-run-results.js --strict`, then resume `resourcer-alerts` and PROVE delivery (`alerts-deliver.js --test`, `hermes -p resourcer cron run resourcer-alerts`, the human confirms the message arrived), then `resourcer-queue-due`, `resourcer-tick`, then the nightly jobs | one-time; not cron |

Exit codes: tick/`--once`/`--queue-due` 0 normal (also "another tick is running", "nothing to do"), 1 unexpected error, 2 usage. Runner 0 done, 10 no work or busy (also reason `browser-busy`: another browser run holds `runtime/browser.lock`), 11 session stale (reasons `safelist`, `login`, `session-timeout`, `cvdb-module`, `phase1-session-stale`), 12 phase1 failed, 13 killed at 70 minutes, 1 runner error (unchanged; new reason `browser-lock-error`). `backup-db.js` 0 ok, 1 backup failed, 2 usage, 3 restore test failed, 4 backup too old, 5 upload failed. `maintenance.js` 0 / 1 / 2 usage / 3 critical. Wrappers: 90 workspace not found, 91 node missing, otherwise the script's own code; every failure prints exactly one line.

## 2. Architecture

```
Hermes cron "* 5-23 * * *"  ->  resourcer-tick.sh  ->  node pipeline-watchdog.js --tick [--max-minutes N]   (stdout/stderr -> logs/tick-<date>.log)
   tick lock runtime/tick.lock (pid + /proc identity token + mtime heartbeat)
   loop (<= 55 min):  reconcile runtime/run.json ->  busy?  supervise (10 s)          not busy?  maintenance, window, back-offs, gate,
                      halt probe, memory guard  ->  launch runner DETACHED (stdout/stderr -> logs/runner-<date>.log)
   runner  = node watchdog-runner.js --from-gate   claims runtime/run.json (exclusive create), heartbeat every 10 s,
             mark-spawned -> create-init-status -> params -> session check -> phase1.js (own process group, console -> logs/phase1-console-<ts>.log)
             writes runtime/last-run.json {nonce, exitCode, reason, pool, ...}, then removes run.json
   next tick (any tick, any time) adopts the run by PID, applies the result once (nonce), keeps the back-offs in runtime/watchdog-state.json
```

Browser exclusion (DESIGN 7): before each run the runner calls `node scripts/ensure-chrome-cdp.js --stop-if-idle` (a Reed browser left by a killed run; a no-op while any live holder owns the lock), then takes `runtime/browser.lock` with owner `caterer` through `require('./ensure-chrome-cdp').browserLock.wait` (30 s, `RESOURCER_BROWSER_LOCK_WAIT_MS`) BEFORE it claims the territory, holds it through the session check and phase1, and releases it after the result file is written. A live foreign holder means exit 10 `browser-busy` with nothing claimed. Children get `RESOURCER_BROWSER_LOCK_HOLDER_PID` (the holder, or the real holder when the lock was borrowed) so `run-pipeline.js` borrows it for the Reed tail. A runner killed with `SIGKILL` cannot release it; the lock then reads as stale by pid liveness. `caterer-preflight.js` (daily and keep-alive) ends with the same `--stop-if-idle`.

Frozen instance (suspend/resume, section 5 D13): every age the tick and the runner compare goes through the ledger `runtime/clock-jumps.json`, so a healthy run is neither killed nor ignored (and then doubled) after a resume.

Why detached: a tick is a foreground cron job (it keeps the instance awake while a run is in flight) but it must be free to end at 55 minutes or to be killed at any instant. The run outlives the tick; the next tick (Hermes fires one every minute) adopts it. Nothing holds Hermes' stdout/stderr pipes: the wrapper redirects the tick's fds to a file, and the tick launches the runner with file descriptors; the wrapper test kills the tick with `SIGKILL` mid-run and checks that the wrapper's pipes close at once while phase1 keeps running. On the real instance a run does NOT outlive the cron run that started it (measured 2026-09-30, `DETACHED-SLEEPER ... GONE`), so the tick drains (section 15): it launches nothing after minute 38 and waits for its own run.

Liveness is by PID plus identity, never by command line: a record `{pid, token}` is alive when `kill(pid,0)` succeeds, the process is not a zombie and, on Linux, `boot_id:starttime` from `/proc/<pid>/stat` equals the recorded token (a recycled pid or a reboot cannot pass). Where `/proc` is unavailable (Windows test host) a stale heartbeat (mtime) is the only guard. A frozen tick (instance suspend) that resumes finds its lock taken over and exits without acting (`lock.stillOwner()` before every iteration; `release()` never removes another owner's lock). The runner's exclusive create of `run.json` is the last line of defence against a double run whatever the tick does.

## 3. Legacy map

### 3.1 `pipeline-watchdog.js`

| Legacy | New | Status |
|---|---|---|
| 37-49 constants (60 s poll, 15 min stale back-off, 5 min maintenance) | `C` in `pipeline-watchdog.js` (`POLL_MS`, `STALE_COOLDOWN_MS`, `MAINT_INTERVAL_MS`) | same values; the back-off and the streaks are persisted in `runtime/watchdog-state.json` instead of memory |
| 51-82 `runMaintenance` (cull-ghost, prune-sessions, wa-health, gateway-health, orphans, queue-due) | `maybeMaintenance` -> `releaseOrphanedLocks`, `cullGhost`, `runQueueDue`, `slowChecks` | prune-sessions, wa-health-check and gateway-health-check dropped (DESIGN 7); cull-ghost/recovery only when idle (see D6) |
| 84-108 `queueDueTerritories` (`--json --quiet`, logs only when it queued) | `runQueueDue` | same call and log rule; adds a lock, 4.5 min pacing shared with the cron job, warning after 3 failures |
| 110-114 `inOperatingHours` (OS-local 06-22) | `inOperatingHours` (`lib/time.js`, Europe/London) | DESIGN 7 fix; DST-tested |
| 116-128 halt globals, `PORT_FAILS_BEFORE_HALT = 2` | `preflight`: `state.probeFail` (2 consecutive misses, streak expires after 5 min) | persisted; the port probe becomes `screening-health.check({deep:false})` |
| 136-172 `NONTERMINAL_STATUSES`, `releaseOrphanedLocks` | same names | authority is now `tick.busyState` (run record, adopted children, run-locks); adds a 2 minute age guard except right after a known dead run |
| 177-215 `spawnRunner` (child, `runnerActive`, exit handler) | `launchRunner` + `reconcileRun` + `handleResult` | detached runner, result via `runtime/last-run.json` |
| 196-200 exit 11: 15 min back-off, CRITICAL log | `handleResult` | same back-off measured from the run end; alert policy in D3 |
| 201-205 exit 0: re-check the gate at once | `iterate` falls through to the gate in the same pass | verified by a handover test (gap under 15 s of fake time) |
| 217-283 `check()` (window, runner active, cool-down, gate, port probe, halt, deep probe every 5 min, spawn) | `iterate` + `checkGate` + `preflight` | order preserved; deep probe every 60 s (D4) |
| 244-255 port probe -> `setHalt('gateway is not running', ...)` | `preflight` -> `setHalt(<fixed reason from screening-health>, detail, {remedy, blockedRun:true})` | no OpenClaw gateway; reason strings are the fixed set |
| 263-270 deep probe while halted, `clearHalt` on success | `preflight` | awaited (90 s cap) instead of fire-and-forget |
| 276 wake.flag removal | dropped | the flag has no reader (process-approved-queue still writes it as hygiene) |
| 285-290 startup: release orphans, check, maintenance, two intervals | `runTick` | one bounded loop; orphans are released when a dead run is found, on LOCKED gates and every 5 minutes |

### 3.2 `watchdog-runner.js`

| Legacy | New | Status |
|---|---|---|
| 37-44 exit codes 0/10/11/12/13/1 | `EXIT` | identical; Update C adds 14 (`phase2-held`: Phase 2 held by CV screening in mode `on`; faultless, recorded without a failure count, no quarantine, no alert; `lib/phase2-exit.js`) |
| (new in Update C) halt of a held queue | `verifyHeldHalt`, `clearVerifiedHalt`, `hasHeldQueue` in `pipeline-watchdog.js` | a halt is re-verified on a tick with no READY search while a queue with `phase2Hold` waits; after two clears within 6 hours with a held queue the third clear is refused (halt `screening halt keeps returning`, K-CV15) |
| 68 `MAX_RUN_MS` 70 min | `MAX_RUN_MS` (timer armed at phase1 spawn; on firing it re-checks running time and re-arms when the instance was frozen) | identical on a normal day; plus a tick-level backstop (running time + 2 min grace, with the heartbeat read twice before a kill) |
| 70-77 `log(event, data)` -> `logs/watchdog-runner.jsonl` + console | `makeLogger` | same file and shape `{ts, event, ...}`; redacted |
| 79-83 `runNode` | `execNode` / `mustRun` | argument arrays, 30 s default |
| 86-104 `resolvePending` (`--pending`, gate) | `resolvePending` | identical, gate non-zero exit still -> exit 1 |
| 113 `PIPELINE_PROC_RE` | `PIPELINE_PROC_RE = phase1[.]js\|run-pipeline\|reed-phase1\|process-approved-queue\|ai-review` | kept for the `--scan` diagnostic only; matches `ai-review` and `caterer-ai-review`; liveness never scans |
| 129-150 `pipelineBusyPid` (CIM scan, `-1` when unknown) | `tick.busyState`, `pipelineBusyPid` (same contract) | PID identity + registry instead of a scan; unreadable record = busy (fail safe) |
| 153-177 `buildParams` | `buildParams` | identical fields; `SOURCES` passes the `RESOURCER_SOURCES` gate |
| 180-206 `runPhase1` (powershell, piped output, `SIGKILL`) | `runPhase1` (`node scripts/phase1.js --params-file`, own process group, console straight to a file, `killTree`) | D5 |
| 214-323 `ensureCatererSession` / `checkLoggedIn` / `doInlineLogin` | `caterer-login.js` (WP3, ONE implementation); `checkSession` maps its answer through `normaliseSession` (`ok`, `login`, `safelist`, `moduleerror`, `unknown`, `error`) | the duplicated login is gone (2026-07-04 lesson); 5 s settle kept; `moduleerror` is explicit: exit 11 reason `cvdb-module`, phase1 never starts |
| 325-360 `findFinalStatus` | `findFinalStatus` | identical |
| 362-488 `main`: resolve, busy guard, dry-run, mark-spawned, init status, params, session, phase1, outcome | `runOnce` | same order; adds the exclusive claim first, the source gate, result file |
| 400-401 wake flag delete | dropped | see above |
| 481-487 outcome mapping (spawn error 12, killed 13, code 2 -> 11, non-zero 12) | `mapPhase1Exit` | identical; a signal-aborted run maps to 1 |
| 490-497 exports / CLI guard | same | `pipelineBusyPid`, `PIPELINE_PROC_RE` still exported |

### 3.3 Other legacy files

| Legacy | New |
|---|---|
| `cull-ghost-phase1.js`, `recover-stranded-phase1.js` | called as child processes; the `CULL_OK` / `RECOVERY_OK n=<n> <id>(pid=<p>,mode=<m>)` lines are parsed and each recovered child is registered in `runtime/adopted-procs.json` so it counts as a live run |
| `queue-due-territories.js` | called as a child (`--json --quiet`) by the tick and by the `resourcer-queue-due` cron job |
| `lib/pipeline-halt.js` | consumed through `getHalt/setHalt/clearHalt`; the library raises its own critical/info alerts, so the tick adds none for halts |
| `lib/screening-health.js` / `gateway-health-check.js` | `require('./lib/screening-health').check({deep})`; the gateway supervisor is dropped |
| pm2 dashboard/daemon, Scheduled Task, Login Startup, WhatsApp relay | dropped (DESIGN 7) |

## 4. Behaviour preserved (each covered by a test)

- Operating window 06:00-22:00 every day including weekends, now Europe/London across both DST changes; only the launch of new runs is gated, an in-flight run is supervised to its end.
- One run at a time; the gate stays the source of work (1 per pass, `spawnedAt` guards); a READY gate never overrides a live run (the legacy `phase1_complete` Reed-tail race).
- Exit 11: 15 minutes back-off measured from the run end, survives tick restarts; exit 0: immediate re-check; exit 10/12/13/1: next poll (60 s).
- 70-minute ceiling: runner timer (kills phase1 and its whole group, exit 13) plus a tick backstop for a wedged runner.
- Halt: cheap probe on every READY pass, two consecutive misses to halt, the territory is not started (so not consumed), deep probe only while halted, self-clearing, halt state file and errors.jsonl entries written by the halt library unchanged.
- Orphaned-lock release guarded by process liveness, so a live run (including the Reed tail) is never abandoned.
- cull-ghost + recover-stranded and queue-due-territories every 5 minutes; idempotent queueing.
- Run bookkeeping files: `runs/phase1-*.json` untouched in schema, `params-watchdog-<ts>.json`, `phase1-console-<ts>.log`, `logs/watchdog-runner.jsonl` events (`picked`, `marked-spawned`, `init-status`, `params-written`, `session-relogin`, `session-safelist-blocked`, `session-dead`, `session-loaded`, `phase1-start`, `phase1-timeout-kill`, `phase1-spawn-failed`, `phase1-killed-timeout`, `session-stale`, `phase1-nonzero`, `done`, `busy-abort`, `gate-not-ready`, `resolve-error`, `dry-run`, `fatal`; new: `browser-stop-idle`, `browser-lock`, `browser-busy`, `browser-lock-error`, `clock-jump`, `phase1-timeout-deferred`) - the dashboard maps its Caterer state from the session events among these.

## 5. Deliberate deviations

| # | Deviation | Why |
|---|---|---|
| D1 | The daemon becomes a bounded tick; state (back-off, streaks, handled run) is persisted; the run is a detached process adopted by PID. | DESIGN 5.5, scale-to-zero, 3600 s cron timeout. |
| D2 | The `RESOURCER_SOURCES` gate is applied here **and the pending file is rewritten** (`sources` = effective, `sourcesRequested` = original) before mark-spawned/init status. When the operator later enables Reed, a file that carries `sourcesRequested` is restored to its original request; while Reed stays off a gated file is left exactly as it is (retries do not rewrite it). | The phase1 doc feared a re-run loop because Phase 2 keeps a pending file that asked for Reed when the result is caterer-only. Traced against the current `process-approved-queue.js` (section 12): the lifecycle package now also deletes such a file while Reed is off and labels the result caterer, so the loop is closed on both sides; this rewrite keeps params, pending file, init status and queue file agreeing and makes the Reed switch-on per file. Every territory row is `both`, so this is the normal case until the Reed canary passes. The DB row is untouched. |
| D3 | Alert policy: exit 11 with reason `safelist`, `login` or `cvdb-module` raises no tick alert (the login module already alerts and rate-limits those: 3-6 h re-notify); `phase1-session-stale` and `session-timeout` alert critically. Three failed runs in a row -> warn (repeated at 13, 23, ... and every 6 h, critical after 24 h; section 14); exit 13 -> warn; runner crash -> warn; low memory -> warn; gate failing 5 checks -> warn; three "never screened" runs -> warn; no CV pushed for 3 window hours -> critical; queue-due failing 3 times -> warn. | Review 5.2 alert list; avoids a 15-minute repeat of a 3-hour policy. |
| D4 | Halt deep probe at most every 60 s (legacy 5 min) and it takes about a second; probes are only run when a territory is READY (unchanged). | The legacy interval existed because the probe cost 73-103 s. |
| D5 | phase1 is started as its own process group with the console redirected to a file; after it exits, any leftover member of that group is ended (`reaped-leftovers`). A process that left the group on purpose (browser daemon, Reed Chrome) is not touched. | Zombie-proof exits (April notes); Hermes tree-kill semantics. Kill is SIGTERM then SIGKILL after 5 s (legacy SIGKILL at once). |
| D6 | cull-ghost (which starts stranded-run recovery) runs only when no run is in flight. | DESIGN 7: Caterer and Reed browsers never run at the same time; the recovered Phase 2 for `both` includes Reed. |
| D7 | A hung Caterer sign-in (15 minutes) exits 11 (`session-timeout`) instead of proceeding; a `moduleerror` answer (any spelling containing `moduleerror` or `cvdb`, string or object) exits 11 (`cvdb-module`) instead of proceeding. | A login still driving the browser must not overlap the scrape; the module-error case masqueraded as SESSION_STALE in the legacy system anyway (2026-08-23), and an unrecognised spelling would have let phase 1 scrape a redirect loop. |
| D8 | Non-zero finished runs (including 11) release their orphaned status files at once (age guard 0); the periodic and LOCKED-gate releases use a 2 minute age guard. | The legacy waited for the next maintenance pass; this also removes the stale `phase1_initializing` files behind the phase1 "bridge" quirk (section 8). |
| D9 | Memory guard: a READY territory is held (warn, no halt) when available memory (min of `MemAvailable` and the cgroup headroom) is below 700 MB. | Brief; 4 GB shared with a timesheet profile. |
| D10 | New `runtime/` files: `tick.lock`, `tick.heartbeat`, `run.json`, `last-run.json`, `watchdog-state.json`, `adopted-procs.json`, `queue-due.lock`, `queue-due-state.json`, `caterer-status.json`, `backup-state.json`, `backup-status.json`, `alerts-state.json`, `alerts-last-run.json`, `maintenance-state.json`, `clock-jumps.json`; `browser.lock` is taken here but defined by the Reed package. | The last five the dashboard asked for (`caterer-status.json`, `backup-status.json`, a `*heartbeat*` file). |
| D11 | Missing legacy `phase2_pushing` in `NONTERMINAL_STATUSES` (the legacy list has `phase2_push`, which no code writes) is kept as is. | Parity; the status only appears on `run-*.json`, which the release never touches. |
| D12 | The retention sweep is its own cron job (`resourcer-retention`, 04:20 London, output to `logs/retention-<date>.log`); `resourcer-maintenance.sh` no longer calls it. Maintenance also removes `backups/candidates.db.pre-migrate-*` after 7 days and crashed `*.tmp` backup files from `backups/`, and never lists `secrets/` or `shadow/` or removes anything from `state/` except entry files of browser cache directories above the cap. | Integration review: the sweep needs its own visible schedule and exit code; the unencrypted pre-migrate copy must not outlive its purpose. |
| D13 | Suspend/resume: a ledger of frozen intervals (`runtime/clock-jumps.json`) is written by the tick (sleep overshoot, wall-versus-monotonic drift) and by the runner heartbeat, and subtracted from every age (run ceiling, tick backstop, recovered-child age, run-lock age, run heartbeat age, tick-lock staleness). Before a kill the run heartbeat is read twice a grace period apart; a tick that finds its predecessor's last iteration older than 3 minutes while something is in flight waits one grace period first; a live tick lock that merely looks stale gets the same proof-of-life wait before it is taken; a tick that lost its lock neither launches nor overwrites the new owner's state. A runner whose heartbeat is advancing is spared up to 10 minutes past the ceiling, no further. | Hermes freezes an idle instance and resumes it later: the wall clock jumps and everything looks hours old. Without this a healthy run was killed by the backstop and a recovered child aged out of `busyState` (a second run beside it). Proven with injected clocks and with real `SIGSTOP`/`SIGCONT` of a runner and its phase1 (a mutation that removes the re-arm makes that test exit 13). |

## 6. Alerts raised by this package

| Key | Severity | Raised by | When |
|---|---|---|---|
| `caterer-session` | critical | tick | runner exit 11 with reason `phase1-session-stale` or `session-timeout` |
| `run-failures` | warn, critical after a 24 h streak | tick | three consecutive failed runs, again at 13, 23, ... and every 6 h; the text carries the streak length |
| `territory-quarantined:<file>` | critical | tick / gate | a pending search failed 3 runs in a row (exit 12/13/1 or a crash, never a session, screening or signal failure) or is malformed (not an object, no job title or location, unknown sources); it was moved to `pending-searches/.quarantine/` and names the file, the last exit and the release command |
| `tick-silent` | critical | alert job | `runtime/tick.heartbeat` older than 10 minutes inside 06:00-22:00 London (the only alert that does not depend on the tick itself) |
| `db-unfit` | critical | tick | `candidates.db` is not `ok` and not `locked` (missing, empty, corrupt = `open-failed`, driver-less = `driver-missing`, failed integrity check, no candidates, or a crashed check); the text names the remedy per cause |
| `sqlite-driver` | critical | tick (30 min) | `better-sqlite3` cannot be loaded during the drought check |
| `log-flood` | critical | tick | a run's phase1 console log passed 300 MB: the run is ended and the log cut to its last 256 KB |
| `runner-busy` | warn | tick | the runner answered exit 10 (busy or nothing to do) for 30 minutes while the gate was READY |
| `deadman-ping-failed` | warn (6 h window) | alert job | the dead-man endpoint did not answer 2xx |
| `outbox-oversize` | warn | alert job | an outbox line longer than the 4 MiB read window was skipped |
| `alerts-test` | critical | `alerts-deliver.js --test` | a deliberate test alert (unique event id, never deduped) |
| `run-killed` | warn | tick | a run ended at the 70 minute ceiling |
| `runner-crashed` | warn | tick | run record dead without a result |
| `never-screened` | warn | tick | three runs in a row with pool equal to DB skips, 1 error, 0 approved |
| `push-drought` | critical | tick (every 30 min) | queue non-empty, in window from 09:00, no halt or back-off, no CV reached Zoho for 3 h; measured from the later of the last push (`run_results`, else `candidates.zoho_pushed_at`) and the moment supervision started, so a fresh install that never pushes is caught too |
| `low-memory` | warn | tick | READY but below 700 MB |
| `gate-error` | warn | tick | five gate failures in a row, again every 60 |
| `queue-due-failing` | warn | tick / cron | three failures in a row, again every 12 |
| `disk-usage` | critical | tick (every 5-minute maintenance pass, also while a run is in flight) and maintenance | above 85 percent used (same key as the retention sweep, so one alert) |
| `vacuum-failed` | warn | maintenance | monthly VACUUM failed |
| `backup-failed`, `backup-integrity` | critical | backup | backup or its integrity check failed |
| `backup-restore-test` | critical | backup | weekly restore test failed |
| `backup-upload` | warn, critical if no successful upload for over 50 h | backup | `BACKUP_UPLOAD_CMD` failed |
| `backup-stale` | critical | tick / `--check-age` | newest backup older than 26 h, or none ever |
| `backup-shrunk` | warn | backup | a core table lost more than 20 percent since the previous snapshot |

Delivery (`alerts-deliver.js`): dedupe key = `key|severity[|event][|reason]` so the halt library's critical "halted" and info "resumed" (same key) both arrive; windows critical 60 min, warn 6 h, info 24 h, suppressed repeats are counted on the next delivery; quiet hours 22:00-06:00 London hold non-critical alerts until 06:00 (merged per key, capped at 200); at most 25 lines per run and, above that, criticals first, then warns, then the rest; whole lines only (a partial trailing line waits); a torn line followed by a whole record is salvaged (records start with `{"ts"`); a line longer than the read window is skipped with one warning; offset saved after printing (at-least-once); head hash guards a replaced or rotated file; the outbox is rotated once it is over 2 MB and fully consumed. The job takes `runtime/alerts.lock` (a second concurrent run exits silently) and refuses to consume anything when its own state file is unwritable (one critical line instead of a repeat storm). The dead-man endpoint is pinged every 55 minutes (so at least hourly) and only while the tick heartbeat is fresh; a failing ping is a `deadman-ping-failed` warn, not a line on every run.

## 7. State and file formats

- `runtime/run.json` `{pid, token, nonce, role:'runner', startedAt, file, jobTitle, location, childPid, childToken, phase1StartedAt}`; created exclusively (`wx`), heartbeat = mtime refreshed every 10 s; stale when the runner AND its phase1 child are dead. Never stolen for a stale heartbeat while the process identity is provably alive.
- `runtime/last-run.json` `{nonce, exitCode, reason, file, statusFile, phase1Code, killed, phase1Status, pool, approved, skippedDb, errors, phase2Status, elapsedSec, startedAt, endedAt}`; exit 10 (no work/busy) writes none.
- `runtime/watchdog-state.json` `{staleCooldownUntil, launchNotBefore, probeFail:{count,lastAt}, haltProbeAt, lastMaintenanceAt, lastSlowCheckAt, handledRunNonce, killedNonces, consecutiveFailures, gateErrors, recentRuns[20], lastTickAt, ...}`.
- Backup file `candidates-<UTC yyyymmdd-hhmmss>.db.gz.enc` + manifest `.json` `{version, name, createdAt, sourceBytes, bytes, sha256, integrity, tables{name:count}}`. Layout: `RSBK` | version u8 (1) | kdf u8 (1 = scrypt) | log2N u8 (17 by default; files written at 15 still restore) | r u8 (8) | p u8 (1) | salt[16] | iv[12] (37 bytes, also the GCM AAD) | AES-256-GCM ciphertext of the gzip stream | tag[16]. Key = scrypt(passphrase, salt). The plaintext snapshot only ever exists under `state/backup-tmp/` (outside `backups/`, so a leftover can never look like a fresh backup to the dashboard) and is deleted with its `-wal`/`-shm` files.
  This is a single-stream format of its own (minimum passphrase length 16, the same policy as the bundle). `tools/lib/bundle-format.js` was considered and not reused: it is the cutover container (an allowlist of bundle paths that refuses anything else, a fixed manifest schema, prompt-driven passphrase), it lives outside `RESOURCER_HOME`, and it would tie a nightly job to the tools directory for a 1.5 MB file. Restore: `node scripts/backup-db.js --restore <file> --out <path>` (or `--verify`).
- Retention: newest backup of each of the last 14 distinct UTC days plus the newest of each of the last 8 ISO weeks; the encrypted file and its manifest are removed together; foreign files in `backups/` are never touched.

## 8. Decisions for other packages

- **phase1 "bridge" quirk** (phase1 doc, section 4): keep `clearForeignBridges` as is. The supervisor removes its cause: a finished non-zero run has its `phase1_initializing` file abandoned at once (D8), the LOCKED-gate path does the same for orphans over 2 minutes old, and the runner is the only starter, so a foreign fresh init file no longer appears in normal operation. Re-visit only if `PIPELINE_BLOCKED` (exit 3) shows in `logs/watchdog-runner.jsonl` after go-live.
- **Retention overlap**: `retention-sweep.js` (WP6) and `maintenance.js` both prune `runs/` (7 days), compress logs (14 days) and guard the disk (85 percent, same alert key). Both are idempotent; since the integration pass they are two cron jobs (04:10 and 04:20), so either can be paused without touching the other.
- **Chrome tree between runs** (DESIGN 7): the Reed browser is stopped before every Caterer run (`--stop-if-idle`) and at the end of every pre-flight and keep-alive; the Caterer agent-browser daemon stays warm (killing it costs a safe-list round trip, WP3 doc). Memory is also protected by the 700 MB guard and the cache cap.

## 9. Tests

`node --test "tests/supervision/*.test.js"` (a directory argument does not work on Node 22+: it is treated as a module path).

| File | Covers |
|---|---|
| `tick-lib.test.js` | locks (stale by dead pid, recycled pid token, heartbeat steal, init grace, old owner detects loss, 6 processes x 8 rounds racing for one stale lock: exactly one winner), `killTree` (group, wrong token), `busyState` (runner, orphaned child, dead, adopted, run-lock age) |
| `operating-window.test.js` | window edges in GMT, BST, both DST changes, independence from the OS timezone, cron hour range superset, alert quiet hours |
| `watchdog-tick.test.js` | fake-clock state machine: window, gate, launch, handover, overlap, adoption, 55 minute cap, exit 11 back-off across restarts, 12/13/10 handling, alert ownership, never-screened, 70 minute kill, crash and orphan release, halt (miss streak, expiry, deep probe pacing, resume, missing health module, hung probe), memory guard, queue-due pacing and lock, cull-ghost parsing and adoption, push drought, heartbeat |
| `runner.test.js` | params, source gate (including the pending-file rewrite, restore and idempotence), session mapping including every module-error spelling, exit mapping, claims and double-run refusal, dry run, error exits, result file, heartbeat, browser exclusion (order, borrowed lock, busy, broken module, release on every exit path, non-fatal stop-if-idle); real processes with the real gate, init-status scripts and launcher lock: success, exit 2/5, child pid recorded, two runners at once run phase1 once, 70 minute ceiling kills the group, leftover reaping, detached daemon survives, full CLI, `browser.lock` held for the whole run |
| `tick-e2e.test.js` | real processes: back-to-back runs without overlap; `kill -9` of the tick / the runner / everything mid-run; SIGTERM; overlapping ticks; stale lock; halt and resume with the real halt library; session block; phase1 exit 2; source gate; stranded-phase-2 recovery adoption; CLI modes |
| `alerts.test.js` | tick-silent (window edges, grace, suspended alert job), hourly dead-man semantics, `--test`, torn/oversize lines, severity-ordered truncation, overlapping runs, unwritable state, dedupe windows, halt/resume keys, quiet hours and flush, caps, truncation and replacement, dry run, rotation with stragglers, digest content from a temp `run_results`, alive line, dead-man ping (local server), poison-pill guards, CLI |
| `backup.test.js` | round trip of a WAL database, ciphertext checks, tamper/truncation/wrong passphrase, concurrent writer, retention and ISO weeks, restore test failure modes, upload hook (array spawn, env, timeout, escalation), age check, nightly flow, shrink warning, streaming a 24 MB file, status file, CLI |
| `maintenance.test.js` | every step and its idempotence, dry run, cache keep-list, disk maths (`df` rules), memory sources, VACUUM, pre-migrate pruning and boundaries, backups/ temp files, the never-touched directories, CLI |
| `wrappers.test.js` | banned tokens, ASCII/LF, scanner rules, POSIX-only syntax, `sh -n`, each wrapper run for real (silent success, one failure line, precondition exits), the pipes-close-after-`kill -9` test, `jobs.json` consistency and schedules, the two legacy Caterer schedules, `installSteps`, the retention wrapper (also against the real sweep) |
| `resume.test.js` | clock guard, frozen-interval ledger, `busyState`/`inspectRun` discounts, tick with injected wall and monotonic clocks (freeze inside a sleep, inside an iteration, both clocks running, unrecorded freeze, fresh tick after a resume, recovered child, lock taken over while frozen), stale tick lock proof-of-life, runner ceiling with an injected clock, real `SIGSTOP`/`SIGCONT` of a runner and phase1 |
| `status-contract.test.js` | fields, enums and ISO timestamps of `caterer-status.json`, `backup-status.json`, `tick.heartbeat` and the `watchdog-runner.jsonl` events against a port of the plugin's derivation and, with `RESOURCER_PYTHON`, against the real `plugin_api.py` |
| `sources-consumed.test.js` | tick -> runner gate -> fake phase1 -> the REAL Phase 2 cleanup: the pending file is consumed once and the result is labelled caterer; Reed on leaves it alone; a gated file gets its Reed request back |
| `poison.test.js` | gate validation and quarantine, release, the runner's claim policy (`faultless`), and a real-process tick with a poison territory in front of a good one: the good one runs, the poison one rotates and is quarantined at the third failure, `--release-quarantine` |
| `recover-merged.test.js` | recovery of a killed both-source Phase 2 on the merged queue |
| `tick-drain.test.js` | the launch cutoff and hard cap (clamping, nesting under the wrapper timeout, `RESOURCER_LAUNCH_CUTOFF_MIN` / `RESOURCER_TICK_HARD_CAP_MIN` through `lib/env.js`), no launch after the cutoff, a run waited out past the 55-minute mark, the hard-cap end (child first, wedged runner signalled after a grace period, `tick-hard-cap` recorded, claim kept, not counted against the territory, alert rate limit), a tick under 20 minutes, adopted and recovered processes, a frozen instance |
| `tick-drain-real.test.js` | the real tick and the real runner: a run still going at the hard cap is ended, recorded as `tick-hard-cap`, its claim stays and nothing is left behind |
| `preflight-env.test.js` | the `env` probe of `tools/preflight.sh` prints variable names only from `NAME=value` lines (a multi-line value adds no names) and the `AGENT_BROWSER_` warning follows the same rule |
| `preflight-stop.test.js` | `caterer-preflight.js` ends every mode and every failure path with `--stop-if-idle` and never changes its exit code |

Run on: Windows Node v25.6.1 (everything that is not POSIX-specific) and WSL Ubuntu 24.04 with Node v22.22.1 from a copy in `~` (all of it, real signals and process groups; `NODE_PATH` pointing at a `better-sqlite3` install and `RESOURCER_PYTHON` at an interpreter with fastapi make the DB, backup and plugin cross-checks run instead of skip).

## 10. UNVERIFIED-LIVE (acceptance checks)

1. Hermes fires `resourcer-tick` every minute and skips the fire while the previous tick runs (in-flight guard); a 55 minute tick is not force-released ("live worker thread").
2. `PATH` (node, `timeout`) and `HOME` in the cron environment. The profile is taken from the wrapper's own location (`<profile>/scripts`), never from an inherited `HERMES_HOME`, which is overwritten and exported for the children; `TMPDIR` is replaced by `state/t` when missing or unwritable.
3. MEASURED: a detached runner does NOT survive the end of the cron run that started it (`DETACHED-SLEEPER ... GONE`); the tick drain (section 15) is the answer. Still unverified: a gateway restart during a run, and scale-to-zero behaviour with `cron.provider: chronos` (one wake per fire).
4. `/proc/<pid>/stat` identity on the instance kernel; `fs.statfsSync` and `/sys/fs/cgroup` numbers under the real cgroup.
5. `better-sqlite3` online backup and read-only open on the persistent volume (WAL) while the pipeline writes.
6. Off-instance upload command chosen by the human (`BACKUP_UPLOAD_CMD`), and that a restore from it works with the passphrase held off-instance.
7. Alert delivery end to end: stdout of `resourcer-alerts` reaches the configured channel, `cron.wrap_response false` keeps it plain, quiet-hours behaviour at 22:00 and 06:00 London, the 18:00 digest and 07:00 alive line.
8. The Chrome cache cap does not disturb the warm Caterer daemon (it only removes entry files from idle cache directories at 04:10).
9. `caterer-preflight.js` at 05:50 and `--keepalive` at 23:00/02:00/05:00 (jobs created; behaviour is WP3's).
10. Memory guard threshold (700 MB) against a real run beside the timesheet profile.
11. What Hermes really does to a frozen instance: whether the monotonic clock pauses (the ledger handles both), and that a detached runner's heartbeat loop resumes within seconds. The `SIGSTOP` test proves the logic, not the platform.
12. `--stop-if-idle` and `browser.lock` against a real Chromium: a Reed browser left by a killed Reed run is quit before the next Caterer run; a `REED_KEEP_CHROME=1` browser is stopped at the next Caterer run by design.
13. A runner killed with `SIGKILL` while its phase1 lives on: the lock reads stale (the holder pid is dead) although a Caterer browser is still working, so a manual Reed tool started in that window is not blocked. The tick itself stays blocked by the run record.

## 11. Needs from others / open issues

- `DESIGN.md` section 10 and `resourcer/package.json` `scripts.test` use `node --test <directory>`; on Node 22 and 25 that fails ("Cannot find module"). Use a glob.
- `docs/ENV.md` (docs package): `RESOURCER_SETTLE_MS` (runner settle after the session check, default 5000), `BACKUP_PASSPHRASE` (secret; or `secrets/backup-passphrase`), `BACKUP_UPLOAD_CMD` (JSON array or plain command; `{file}` `{name}` `{manifest}`), `BACKUP_UPLOAD_ENV` (comma list of variable names passed to the upload command), `RESOURCER_DEADMAN_URL` (secret URL pinged every 55 minutes, only while the tick heartbeat is fresh, so about hourly between 05:00 and 23:59 London and not overnight). `RESOURCER_MAX_TICK_MIN` and `RESOURCER_SOURCES` are read as documented.
- `docs/OPERATIONS.md` / `INSTALL.md`: create the eight jobs from `hermes/cron/jobs.json` (with a real delivery target, see section 14), set the timezone and `cron.wrap_response false`, choose the alert channel, set `BACKUP_PASSPHRASE` and keep it off-instance, `BACKUP_UPLOAD_CMD`, and the dead-man URL; the operator recovery commands are `--status`, `--clear-cooldown`, `caterer-login.js --open-link`, `backup-db.js --restore`.
- The dashboard's `/status` can read `runtime/tick.heartbeat` (the only `*heartbeat*` file this package writes), `runtime/caterer-status.json`, `runtime/backup-status.json`. `config/dashboard-settings.json` `operating_hours` is display only: the tick's window is fixed at 06-22 London (change the constant and the cron hours together).
- `resourcer/scripts/lib/fsx.js` contains an invisible BOM inside a regex (WP3 noted it); `lib/tick.js` uses `fsx.pidAlive`, `writeJsonAtomic`, `ensureDir`, `readJson`, `sha256File`, `sleep` only.
- `docs/ENV.md`: `RESOURCER_BROWSER_LOCK_WAIT_MS` (runner wait for `browser.lock`, default 30000).
- Dashboard package: `backup_state` counts any regular file in `backups/` that is not `.json`, `.tmp`, `.partial`, `.part`, `.lock` or a dotfile, so a fresh `candidates.db.pre-migrate-*` copy looks like a backup until the nightly status file exists; it should also skip names containing `.pre-migrate-`. Stall detection cannot fire while a tick is alive because `tick.heartbeat` is refreshed every minute by design (it means "the supervisor is alive").
- Browser package: `caterer-preflight.js --keepalive` at 23:00 can overlap a run that started at 21:59 (both drive the `caterer` agent-browser session); it does not look at `browser.lock`. Not changed here (only the stop call was in scope).
- `docs/parity/browser-caterer.md` still says the pre-flight and keep-alive are "not scheduled yet": they are (`resourcer-preflight`, `resourcer-keepalive`).

## 12. Integration pass 2026-09-29 (findings)

1. **moduleerror**: the explicit exit 11 `cvdb-module` was already in the runner; `normaliseSession` now recognises every spelling (string or object), and an end-to-end test starts no phase 1.
2. **Cron**: `resourcer-preflight` (`50 5 * * *`) and `resourcer-keepalive` (`0 23,2,5 * * *`) were already present with the legacy schedules (old jobs "Caterer Daily Pre-Flight" and "Caterer Overnight Keep-Alive", Europe/London); added `resourcer-retention` and `installSteps`.
3. **Browser exclusion**: runner lock and stop call, `RESOURCER_BROWSER_LOCK_HOLDER_PID` to children, pre-flight ends with `--stop-if-idle` (section 2 and D12).
4. **RESOURCER_SOURCES trace**: the runner rewrites the pending file (D2). Phase 2 as it stands now also deletes a pending file that asked for Reed while `RESOURCER_SOURCES` keeps Reed off, and labels the result caterer; with Reed on and a caterer-only result it keeps the file for a bounded number of retries (`sourceMismatchRetries`). No change to `process-approved-queue.js` is needed from this side.
5. **Status files**: all four writers match section 5 of `docs/parity/dashboard.md` (fields, enum, ISO with milliseconds and `Z`); verified against the real `plugin_api.py`. Nothing needed changing on the writer side.
6. **maintenance.js**: `--pre-migrate` (7 days), crashed backup temp files, and a test that ancient files in `secrets/`, `shadow/`, `state/`, `config/`, `downloads/` and `pending-searches/` survive a daily run.
7. **Suspend/resume**: D13.

## 13. Integration rehearsal changes (docs/parity/integration.md)

The end-to-end rehearsal (`tests/e2e-linux.sh`) ran the tick, runner, phase 1, Phase 2, screening, backup, retention and dashboard together on Linux against fakes and changed this package as follows:

1. **The claim of a run that did not finish is given back.** (Superseded by section 14, item 3: only failures the territory did not cause give the claim back; the others keep it, which restores the legacy stale-spawn rotation.) The runner removes `spawnedAt` from its pending file on every non-zero exit except 10 (session stale, module error, phase 1 failure, kill, runner error) and when a screening outage stopped the run; the tick does the same for a run that died without a result (`releaseClaim`). Before this a crashed run left the gate saying `SPAWNED` for the 10-minute stale-spawn window, and `--clear-cooldown` after an operator fix did not resume the queue. (`tests/supervision/tick-e2e.test.js` used to assert the claim stays; it now asserts it is released and that the tick back-off is what holds the territory.)
2. **A killed runner's `browser.lock` is removed** once its run is provably dead and the holder pid is gone (`clearStaleBrowserLock`); a live holder (a manual Reed tool) is never touched.
3. **An orphaned Phase 2 progress record is closed.** `releaseOrphanedLocks` also closes `run-*.json` left in `phase2_starting` / `phase2_pushing` when nothing is alive (it held the run lock for 30 minutes).
4. **The Reed browser is stopped by the runner.** A Reed tail started from phase 1 borrows the runner's `browser.lock`, so `run-pipeline` / `reed-phase1` do not own the browser and never stopped it: Chromium and Xvfb idled until the next run or the next morning's pre-flight. The runner now runs `ensure-chrome-cdp.js --stop` before it releases the lock when the run had a Reed tail (`REED_KEEP_CHROME=1` keeps it).
5. **The tick refuses to launch on an unfit database** (`db-unfit`, see docs/parity/lifecycle.md 9.4; the rule was inverted in section 14, item 4): missing, empty, not a file, failed integrity check or no candidates table; one critical alert per 30 minutes; not a halt (a screening recovery must not clear it). A locked or unreadable driver only means the check could not be made and does not hold the queue. `ctx.dbFit` is the test seam.
6. **`RESOURCER_TEST_NOW`** (tests only): an ISO instant that replaces the clock for the operating window (`inOperatingHours`) and the alert quiet hours / digest hour, and for nothing else. Read from the process environment only (never from `.env`); Hermes' scrubbed cron environment cannot carry it.
7. **The overnight keep-alive stands aside while a pipeline run is in flight** (it would drive the same `caterer` browser session); `caterer-preflight.js` also refreshes `runtime/reed-status.json` (`reed-api-client.js --sync-status`) so the dashboard says "disabled" while `RESOURCER_SOURCES` excludes Reed.
8. Answers to "Decisions for other packages" (section 8) and the open list (section 11): the dashboard's `backup_state` now ignores `candidates.db.pre-migrate-*` and `bundle-restore-*`; the keep-alive/run overlap is closed by item 7; the SIGKILL-leaves-`browser.lock` window by item 2 (once the run record is reconciled); `docs/ENV.md` still owes `RESOURCER_BROWSER_LOCK_WAIT_MS` and the test-only variables listed in docs/parity/integration.md.

## 14. Review fixes 2026-09-30 (eight adversarial reviewers; supervision fixer)

Each item names the review finding it answers and the test that fails on the code before the fix and passes after it.

1. **Nothing independent watched the tick (critical).** `alerts-deliver.js` is its own cron job, so it now watches the tick: when `runtime/tick.heartbeat` (touched by the tick at every start and iteration) is older than 10 minutes inside 06:00-22:00 London it injects a critical `tick-silent` alert (deduped hourly like any critical). Two guards keep it from crying wolf: a heartbeat that was never written counts silence from the alert job's first run (10 minutes of grace, so "alerts first, tick a few minutes later" during install is safe), and when the alert job itself had not run for more than 10 minutes (a suspended instance) the first stale reading proves nothing and the next run decides. The dead-man ping moved from once a day to every 55 minutes (at least hourly) and happens only while the heartbeat is fresh, so a dead tick, a paused job or a dead instance makes the external monitor raise its own alarm. A failing ping is a keyed warn (6 h window) instead of a line on every run. `alerts-deliver.js --test` queues one critical test alert with a unique event id (never deduped) and prints the line; the next alert-job run delivers it to the real channel. Tests: `alerts.test.js` (tick-silent x5, dead-man x2, `--test`).
2. **Every job was created with `--deliver local` (high).** `hermes/cron/jobs.json` gives all eight jobs one shared `<DELIVER_TARGET>` for `--deliver` and `--failure-deliver` (the exact create string is in each `cli`/`cliPaused`); the placeholder cannot be pasted into a shell unchanged, and the `delivery` block tells the operator to stop and ask the human for a target rather than fall back to `local`. Install step 3 proves delivery (`alerts-deliver.js --test`, `hermes -p resourcer cron run resourcer-alerts`, the human confirms) before the tick is resumed; the top-level `acceptance` list adds `cron list` (eight enabled jobs with the target) and `pipeline-watchdog.js --status` (`lastTickAt` under 2 minutes, `quarantined` empty). The alert job now runs `*/5 * * * *` around the clock; overnight (documented in `notes` and in the job's `overnight` field) criticals are delivered within 5 minutes, warn and info wait for 06:00, `tick-silent` is off outside 06:00-22:00, and job failures also arrive as failure notices. Cost: the instance no longer scales to zero at night (the note says how to go back to `*/5 5-23`). Test: `wrappers.test.js` (jobs.json delivery).
3. **Poison territories (two findings, high).** Restored the legacy stale-spawn rotation: `watchdog-runner.js` keeps the `spawnedAt` stamp after every failure the territory may have caused (phase1 exit 12, kill 13, runner errors after the claim such as `init-status-error`, `params-error`, `fatal`), so the gate skips the file for 10 minutes and the next territory runs; it gives the claim back only for exit 11 (session), a screening outage, a signal abort, a foreign lock (`phase1-exit-3`), `phase1-exit-7` and infrastructure errors (`browser-lock-error`, `resolve-error`, `mark-spawned-error`, `spawn-error`) - `faultless()`. The tick counts failures per pending file in the file itself (`failedRuns`, `lastFailure`; cleared on exit 0), never counts a faultless failure, and does not count while three different territories are failing among the last six runs (a system fault, not a poison file: without this an outage would drain the queue into quarantine). At the third failure the file moves to `pending-searches/.quarantine/` (with a `<name>.why.txt`) and one critical `territory-quarantined:<file>` alert names the file, the last exit and the release command. A wedged run killed at 70 minutes keeps its claim; a plain crash still gives it back (`releaseClaim`). `pending-gate.js` validates every file before offering it (an object with a non-empty `jobTitle` and `location`, `sources`/`sourcesRequested` one of caterer|reed|both) and quarantines invalid ones immediately with the same alert; it ignores dot files, dot directories and directories. `queue-due-territories.js` treats a territory sitting in `.quarantine/` as queued (summary field `alreadyQuarantined`), otherwise it would create a fresh file every 5 minutes and the poison would loop forever. The runner also refuses an invalid explicit `--pending` file. `pipeline-watchdog.js --release-quarantine <file>` puts a file back with its counters cleared. Tests: `poison.test.js` (real-process tick with a poison file in front of a good one), `watchdog-tick.test.js`, `tests/core/territory-cli.test.js`.
4. **The database gate let corrupt and driver-less databases through (high).** `dbFitCheck` now fails closed: a run starts only when `preflight-db.js` says ok or exactly `locked` (a writer holds it, so the check could not be made). `open-failed`, `driver-missing`, `integrity-failed`, `missing`, `empty-file`, `no-candidates*`, an unknown verdict and a crashed check all hold the queue with the same critical `db-unfit` alert (30-minute rate limit, text names the remedy: restore a backup for corruption, `npm rebuild better-sqlite3` for a driver that will not load). The drought check also raises `sqlite-driver` instead of returning silently. The other half (distinct exit codes from `candidates-db.js check`, phase1 dedupe aborting on an error) belongs to the core/phase1 fixers. Tests: `watchdog-tick.test.js` (dbFitCheck, corrupt/driver-less end to end).
5. **Streak alerts repeat (medium).** `run-failures` at 3, 13, 23, ... and every 6 h with the streak length, critical after 24 h; `gate-error` every 60 further failures; `queue-due-failing` every 12; runner exit 10 for 30 minutes raises `runner-busy`.
6. **Alerts lost or stormed (medium).** Torn lines are salvaged, an oversized line is skipped with one warning, criticals are printed first when a run exceeds 25 lines, overlapping alert jobs take `runtime/alerts.lock`, an unwritable state file prints one critical and consumes nothing. A critical alert that `notify()` cannot write is logged (its text goes to the tick log) and makes the tick exit 1 so the cron failure notice reaches the human (`lib/notify.js` itself is the core package's; see "Not done").
7. **Disk and log floods (medium).** The disk guard runs on every 5-minute maintenance pass, also while a run is in flight; the supervise loop ends a run whose phase1 console log passes 300 MB (`runLog` in `run.json`), keeps the last 256 KB and raises `log-flood`; the tick wrapper sets `ulimit -f 2097152` (1 GiB per file) as a backstop for floods faster than the 10 s loop.
8. **Clock excursions (low).** Persisted timestamps more than a day ahead of the clock (tick state, queue-due state, alert dedupe, dead-man) are treated as unset.
9. **Push drought blind on day one (medium).** Measured from the later of the last push (`run_results`, else `candidates.zoho_pushed_at`) and `state.superviseSince`.
10. **Recovery of a killed both-source Phase 2 (medium).** `recoverInterrupted` uses the newest `merged-queue-*.json` of the same title and location written since the run began and its own results file; a plain phase 1 death is unchanged.
11. **Wrappers (medium/low).** The profile comes from the script location and `HERMES_HOME` is overwritten and exported (a wrong inherited value used to select another profile's `.env`); `TMPDIR` is replaced by `state/t` when missing or unwritable (xvfb-run needs one); `RESOURCER_MAX_TICK_MIN` in the profile `.env` is reachable because the flag is only passed when the wrapper environment has it; pre-flight and keep-alive report the `CATERER_/REED_/AB_` marker line, not the closing `BROWSER_STOP_IDLE` line; the wrapper tests also run under bash.
12. **Backup KDF (low).** Default scrypt cost 2^17 (the bundle's); older files still restore. The passphrase lives next to the backups by design (the human must escrow it elsewhere: OPERATIONS).

Not done here (owner or reason): unreadable `run.json`/`tick.lock` (EACCES/EISDIR) stays "busy" by design (fail safe; only out-of-band tampering makes files unreadable to their own user); pid-only liveness of `.run-lock` and `browser.lock` needs their writers (`process-approved-queue.js`, `ensure-chrome-cdp.js`) to record a /proc token; the 55 minute bound is still only checked between iterations (worst case one slow iteration past it: the wrapper timeout ends it with a loud rc 124); killing a phase1 whose status file went stale needs the phase1 fixer's per-unlock status refresh first; the memory floor (700 MB) needs the measured peak from the acceptance run beside the timesheet profile before it is changed; `RESOURCER_TEST_NOW` in `lib/time.js`, the notify leading newline and the HERMES_HOME order in `env.js`/`browser.js` are the core/browser packages'.

## 15. Go-live round 2026-09-30 (tick drain)

Found by the instance probe: a process started by one cron run does not survive the end of that run, so a run that outlasted its 55-minute tick died with it.

1. **The tick drains.** `RESOURCER_LAUNCH_CUTOFF_MIN` (default 38, clamped to 10 up to the bound minus 10): after it the tick launches nothing, does not ask the gate, and exits as soon as nothing is in flight (`tick end: launch-cutoff`). A run this tick launched is waited for past the 55-minute bound (`RESOURCER_MAX_TICK_MIN`) until `RESOURCER_TICK_HARD_CAP_MIN` (default 56, clamped to the bound up to 56; the wrapper timeout of 3450 s stays above it plus the kill work). A run still going then is ended like an overrun: phase 1 child first, then the runner if it has not exited within 10 s; recorded as exit 13 with reason `tick-hard-cap`, its claim kept, not counted against the territory (never quarantined), one WARN alert `tick-hard-cap` (at most once in 6 hours). A run adopted from an earlier tick, and a recovered process, are supervised as before (the tick leaves at its bound). A tick shorter than 20 minutes has neither cutoff nor drain. Elapsed times leave out frozen time (D13). `tickLimits()` is exported.
2. **Consequence.** A run that cannot finish by minute 56 of its tick (longer than 56 minutes) can never complete; the 70-minute ceiling is not reached. KNOWN-LIMITS K-PLAT5 and K-SUP4, ACCEPTANCE SU03, DECISIONS SUP-15.
3. **Preflight.** `tools/preflight.sh` reads variable names from `env` lines that start a variable (`env_names`), so a multi-line value no longer prints its continuation lines as names.
4. **Unchanged:** `hermes/scripts/resourcer-tick.sh` (the cron wrapper keeps its 3450 s timeout).
