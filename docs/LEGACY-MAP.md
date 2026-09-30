# Legacy map: where everything of the old system lives now

The old system is the laptop version: the `workspace-resourcer` folder of the OpenClaw home, driven by PowerShell, WSL, PM2, Windows scheduled tasks and WhatsApp. This file maps each
legacy file to its new home, then the nine reliability layers and the maintenance rules of the old operating notes. It is built from the per-package tables in `docs/parity/*.md`
(which also give legacy line numbers, function by function); each table below names the parity file to open. Legacy paths are relative to `workspace-resourcer/`; new paths are relative to the
repository root. "Same" means same name and behaviour, with the standard changes: paths from `scripts/lib/paths.js`, secrets from `secrets/`, alerts through `notify()`, atomic writes, ASCII source,
`--help` on every command, London time (docs/DECISIONS.md, X-rows).

## 1. Files that were ported (PowerShell to Node)

| Legacy | New | Change | Parity doc |
|---|---|---|---|
| `scripts/phase1-scrape.ps1` (1,236 lines) | `resourcer/scripts/phase1.js` (entry) and `resourcer/scripts/phase1/`: `params.js`, `url.js`, `bridge.js`, `session.js`, `browser-adapter.js`, `extract.js`, `cities.js`, `dedupe.js`, `screen.js`, `unlock.js`, `queue.js`, `finalise.js`, `handoff.js`, `run.js`, `db.js`, `proc.js`, `config.js`, `util.js`, plus the incomplete-run and retry helpers | unit by unit, same exit codes (0, 2 SESSION_STALE, 3, 4 TERRITORY_MISMATCH, 5, 6 BAD_URL_ENCODING, 7), same status and queue file schemas; empty-result probe fixed | phase1.md |
| `scripts/caterer-do-login.ps1` and `doInlineLogin()` / `ensureCatererSession()` inside `scripts/watchdog-runner.js` | `resourcer/scripts/caterer-login.js` | ONE implementation (two copies diverged on 2026-07-04); attempt limiter, safe-list handling, `--open-link` | browser-caterer.md |
| `scripts/caterer-daily-preflight.ps1` | `resourcer/scripts/caterer-preflight.js`, `hermes/scripts/resourcer-preflight.sh` (05:50), `hermes/scripts/resourcer-keepalive.sh` (23:00, 02:00, 05:00) | no Xvfb step; Reed steps only when Reed is enabled | browser-caterer.md |
| `scripts/ensure-chrome-cdp.ps1`, `scripts/start-reed-chrome.js` | `resourcer/scripts/ensure-chrome-cdp.js` | Chromium under `xvfb-run` on a dedicated profile in `state/chrome-reed`; process matching pinned; shared `runtime/browser.lock` | reed.md |
| `scripts/lib/caterer-credentials.ps1` | not needed (Node reads `lib/caterer-credentials.js`) | | browser-caterer.md |
| the WSL-wrapped agent-browser call in every script (`Invoke-AgentBrowserCmd`) | `resourcer/scripts/lib/browser.js` (spawns the pinned agent-browser 0.21.0 with an argument array), `lib/browser-env.js` | timeouts kill the process group; one socket dir; profile and sessions under `state/` | browser-caterer.md |

## 2. Files ported with edits (Node with Windows paths, WSL, PowerShell or gateway calls)

| Legacy | New | Change | Parity doc |
|---|---|---|---|
| `scripts/ai-review.js`, `scripts/caterer-ai-review.js` | `resourcer/scripts/ai-review.js`, `caterer-ai-review.js`, `resourcer/scripts/lib/screening/*.js` (`engine`, `rubric`, `tiers`, `llm-client`, `jev-client`, `jev-questions`, `decide`, `criteria`, `card`, `operating-point`, `rules`, `redact`, `shadow`, `cache`, `config`, `pool`, `http`, `reasons`, `errors`, `index`), `resourcer/config/screening.json`, `resourcer/config/screening-criteria.json`, `tools/screening-report.js` | same CLI, stdout, stderr marker and exit codes 0/1/3; Vercel AI Gateway instead of the OpenClaw alias; per-candidate calls; Jev in shadow | screening.md, docs/SCREENING.md |
| `scripts/lib/screening-health.js`, `scripts/gateway-health-check.js` | `resourcer/scripts/lib/screening-health.js` | cheap TCP probe every tick, deep probe (credits + canary) only while halted; the gateway supervisor is dropped | screening.md, supervision.md |
| `scripts/pipeline-watchdog.js` (PM2 daemon) | `resourcer/scripts/pipeline-watchdog.js` (`--tick`, `--once`, `--queue-due`, `--status`, `--clear-cooldown`), `resourcer/scripts/lib/tick.js`, `hermes/scripts/resourcer-tick.sh`, `hermes/scripts/resourcer-queue-due.sh` | bounded 55-minute tick; persisted back-offs; PID identity liveness; frozen-instance ledger | supervision.md |
| `scripts/watchdog-runner.js` | `resourcer/scripts/watchdog-runner.js` | detached runner, exclusive claim `runtime/run.json`, result in `runtime/last-run.json`, exit codes 0/10/11/12/13/1 unchanged | supervision.md |
| `scripts/process-approved-queue.js` (Phase 2, 1,423 lines) | `resourcer/scripts/process-approved-queue.js`, `lib/cv-retention.js` | paths; no LLM watcher wake; WhatsApp report removed; `run_results` row; CV and candidate JSON deleted after push; `RESOURCER_SOURCES` | lifecycle.md |
| `scripts/reed-phase1.js`, `run-pipeline.js`, `reed-api-client.js`, `reed-browser-fetch.js`, `reed-refresh-token.js`, `reed-download.js`, `reed-search.js`, `cdp-reed-full-login.js` | same names | Chrome 153 token capture; credentials from `secrets/`; no-burn on outage; browser lock; human-login flow | reed.md |
| `scripts/reed-clean-relogin.js` (not in the live closure) | `cdp-reed-full-login.js --clean` | the file was not shipped: it held the same hard-coded credentials | reed.md |
| `scripts/caterer-browser-fetch.js`, `caterer-check-session.js`, `caterer-cookie-jar.js`, `caterer-download-cv.js`, `caterer-get-credits.js`, `caterer-unlock.js` | same names | native agent-browser; in-page fetch timeouts; credits from the warm page | browser-caterer.md |
| `scripts/pending-gate.js`, `scripts/pipeline-halt-cli.js`, `scripts/caterer-fetch-results.js`, `scripts/pipeline-optimiser.js`, `scripts/caterer-keepalive.js` | same names | atomic writes, no OpenClaw text; `caterer-fetch-results.js` is now a parameterised diagnostic | core.md |
| `dashboard/server.js`, `dashboard/routes/{search,stats,territories,schedule}.js`, `dashboard/public/index.html` (Express, tunnel) | `plugin/resourcer/` (`plugin.yaml`, `__init__.py`, `dashboard/manifest.json`, `dashboard/plugin_api.py`, `dashboard/dist/index.js`, `dashboard/dist/style.css`), `tools/request-search.js` | Hermes dashboard plugin; read-only database; path jail; routes `/health /status /stats /runs /territories /schedule /errors /halt POST /search`; numbers from `run_results` | dashboard.md |

## 3. Files carried over unchanged in behaviour (KEEP)

Same name under `resourcer/` unless noted: `candidates-db.js`; `scripts/applying-for-role-map.js`, `build-caterer-results-url.js`, `caterer-session-utils.js`, `constants.js`, `create-init-status.js`,
`cull-ghost-phase1.js`, `fetch-with-timeout.js`, `fill-mandatory-fields.js` (PDF text extraction fixed), `migrate-reed-schema.js`, `postcode-lookup.js`, `query-territory.js`,
`queue-due-territories.js`, `recover-stranded-phase1.js` (also recovers interrupted Phase 2), `run-lock.js`, `territory-manager.js`, `territory-scheduler.js`, `territory-utils.js`, `zoho-attach-resume.js`,
`zoho-auth.js`, `zoho-create-candidate.js`; `scripts/lib/caterer-credentials.js`, `lib/pipeline-halt.js`, `lib/postcode-to-city.js`; data `scripts/extract-js.b64` (byte identical),
`config/postcode-cities.json`, `config/territory-defaults.json` (byte identical). The differential comparison of old and new on identical fixtures found no differences apart from the listed deviations (docs/parity/core.md section 1).

## 4. Dropped, replaced or new

| Legacy | Now | Why |
|---|---|---|
| `scripts/wake-pending-watcher.ps1`, the LLM watcher cron job and its polling instructions | `pipeline-watchdog.js` tick launches the runner directly; no LLM in the loop | zero orchestration tokens, handover in seconds |
| `scripts/prune-sessions.js`, `sessions.json` | nothing | OpenClaw sessions do not exist |
| `scripts/wa-health-check.js`, WhatsApp relay and auto-relink cron jobs, `whatsapp-sent-hashes.log` | `lib/notify.js` -> `outbox/alerts.jsonl` -> `scripts/alerts-deliver.js` -> `hermes/scripts/resourcer-alerts.sh` | channel-independent alerts |
| `scripts/reed-login.js` (known broken, 404) | `cdp-reed-full-login.js` | |
| `scripts/ai-review-abtest.js` | `SCREEN_LLM_MODEL=<model>` does the same | |
| `scripts/run-sous-chef-tn6.ps1`, one-off `.ps1`/`.js` files, archive, `.bak` copies (about 605 files) | not shipped | not in the live closure (the port manifest in the research folder) |
| `config/dashboard-auth.json` | none | Hermes gates the dashboard |
| Gateway token in the OpenClaw config | `AI_GATEWAY_API_KEY` in the profile `.env` | |
| `cron/jobs.json` of the old system (Caterer Daily Pre-Flight 50 5, Overnight Keep-Alive 0 23,2,5, territory scheduler, watcher, WhatsApp jobs) | `hermes/cron/jobs.json` (eight no-agent jobs) | the scheduler became `resourcer-queue-due`; the two Caterer schedules are unchanged |
| PM2 process list, Scheduled Task, Login Startup item, `gateway.cmd` | Hermes cron | |
| the daily territory-scheduler cron job (the script `territory-scheduler.js` is still shipped) | `resourcer-queue-due` (every 5 minutes, runs `queue-due-territories.js`) | queues missed territories idempotently |
| new, no legacy counterpart | `lib/{paths,env,fsx,notify,time,tick,browser-env}.js`, `scripts/phase1/{incomplete,retries}.js`, `scripts/migrate-schema.js`, `retention-sweep.js`, `backfill-run-results.js`, `preflight-db.js`, `backup-db.js`, `alerts-deliver.js`, `maintenance.js`, `tools/{make-bundle,restore-bundle,verify-bundle,archive-legacy,make-manifest,check-manifest,screening-report,screening-operating-point,gold-rows,request-search}.js`, `tools/preflight.sh`, the CV screening stage (`scripts/cv-review.js`, `scripts/cv-report.js`, `scripts/lib/cv/`, `config/cv-screening.json`; the legacy Phase 2 never read a CV, docs/CV-SCREENING.md, docs/parity/cv-stage.md), `plugin/resourcer/install-plugin.sh`, `hermes/` profile files | new duties on Hermes |
| Operator tools used in incidents but not ported | `db-health-check.js`, `cv-pull-report.js`, `create-pending-search.js`, bulk requeue scripts, a re-attach command for kept CVs | listed in docs/KNOWN-LIMITS.md (operations) |

## 5. Data and state

| Legacy | Now |
|---|---|
| `candidates.db` | same file, carried in the encrypted bundle; `migrate-schema.js` adds `run_results`, timestamp columns and, when the volume is safe, WAL |
| `caterer-session.json`, `reed-session.json`, agent-browser state, Chrome profile | recreated on the instance under `state/` (never copied) |
| `caterer-credentials.json`, `zoho-credentials.json` | `secrets/caterer-credentials.json`, `secrets/zoho-credentials.json` (bundle) |
| Reed login hard-coded in `cdp-reed-full-login.js` and `reed-clean-relogin.js` | `secrets/reed-credentials.json` (extracted at bundle build, never printed) |
| `pending-searches/` | same directory (bundle; `spawnedAt` removed) |
| `runtime/pipeline-halt.json` | same file and schema |
| `postcode-lookup-cache.json`, `postcode-to-city-cache.json`, `reed-location-cache.json` | same names at the workspace root (bundle) |
| `runs/` (60 MB), `downloads/` (3 GB), `logs/` (130 MB) | fresh; not migrated. `run_results` history is not carried (KNOWN-LIMITS) |
| `errors.jsonl`, `pipeline-performance.jsonl`, `watchdog-runner.jsonl` | `logs/`, same shapes |

## 6. The nine reliability layers (old CLAUDE.md, 2026-05-06 stack) and the maintenance rules

| Old layer or rule | Where it lives now |
|---|---|
| 1. Watchdog timeout bump for the model CLI subprocess (58 minutes) | Gone with the model CLI. Replaced by explicit bounds: the 55-minute tick, the 70-minute run ceiling (runner timer + tick backstop), per-child timeouts in phase 1 (`PHASE1_*_TIMEOUT_SEC`), per-call screening timeouts (60 s language model, 15 s Jev, 600 s batch deadline). |
| 2. Cross-provider fallback chain | Not carried; **halt is the fallback** (docs/DECISIONS.md X6). In `jev_only` (the default since 2026-09-30) there is no second model at all: a Jev failure is unavailable, so it halts. The older engines keep a backup model `SCREEN_LLM_BACKUP_MODEL` on the same gateway, and a Jev failure never blocks in shadow mode. |
| 3. Heartbeat wrap around AI screening (20 s poll, file-redirected output) | `phase1/screen.js`: `HEARTBEAT:` lines every `PHASE1_HEARTBEAT_SEC` (20 s), child output not piped, batch timeout counted as "screening unavailable". |
| 4. `Invoke-AgentBrowserCmd` WSL timeout wrapper | `lib/browser.js` `run()`: argument array, hard timeout that kills the process group, FIFO, cross-process 5 s navigation gap, single-attempt clamp for state-changing commands; phase 1 per-call budgets 90/90/60/20/60 s. |
| 5. Networkidle settle sleep and silent-zero guard | `phase1/extract.js` and `run.js`: `PHASE1_SETTLE_MS` sleep after a networkidle timeout, silent-zero abort on page 1, corrected empty-result probe. |
| 6. Watcher polling instructions (LLM must poll the status file) | Obsolete: no LLM watcher. The tick adopts a run by PID and reads `runtime/last-run.json`; nothing depends on an LLM staying awake. |
| 7. `process-approved-queue.js` 7-day age guard on status files | `findPhase1StatusFile` in the same file, unchanged. |
| 8. `$initFile` replaced by the owned status file | `phase1/handoff.js` passes the run's own status file to `run-pipeline.js --status-file`. |
| 9. Encoding hygiene (ASCII-only, CRLF in the PowerShell script) | All shipped source is ASCII and LF (DESIGN 9), enforced by hygiene tests in every package. |
| Maintenance: prune `sessions.json` over 25 MB | Dropped with OpenClaw. |
| Maintenance: cull ghost phase1 files every 5 minutes | `cull-ghost-phase1.js` and `recover-stranded-phase1.js`, called by the tick every 5 minutes while idle; thresholds 15/5/20/30/30 minutes unchanged. |
| Maintenance: 1-2 concurrent subagents, 3+ causes timeouts | One run at a time (exclusive `runtime/run.json`, global run lock, browser lock); no subagents. |
| Pipeline halt when AI screening is unavailable | `lib/pipeline-halt.js` (same file, schema and `errors.jsonl` entries), `lib/screening-health.js`, tick preflight, dashboard banner, `pipeline-halt-cli.js`. Now also Reed (no burn). |
| `gateway-health-check.js` restarting a dead gateway | `screening-health.check()`; there is no gateway to restart. |
| Known open issues 1-6 (reply cron timeouts, gateway WebSocket timeouts, WhatsApp delivery, scheduled task spawn, plugin extraction, WhatsApp listener) | Not applicable on Hermes. |
| Resourcer code-lockdown (READ-ONLY OPERATIONAL MODE banner; tool policy denying Edit/MultiEdit/applyPatch) | `hermes/AGENTS.md` (READ-ONLY OPERATIONAL MODE), `hermes/SOUL.md`, `MANIFEST.sha256` checked by `tools/check-manifest.js` (docs/SECURITY.md section 4). Hermes cannot deny a file tool by path, so this is prompt plus detection. |
| Gotcha: pending files must not carry `spawnedAt` | `tools/request-search.js`, the dashboard `POST /search` and the bundle builder never write or keep it. |
| Gotcha: Caterer password single source of truth, never hard-coded, never printed | `secrets/caterer-credentials.json` via `lib/caterer-credentials.js`; `env.redact` also hides values from `secrets/*.json`. |
| Gotcha: `doctor --fix` and plugin extraction, before editing config stop the gateway | Not applicable. |

## 7. Incident lessons and where each is enforced

The incident notes (2026-04 to 2026-09) became code and tests; `docs/parity/browser-caterer.md` section "Incident lessons" maps each Caterer/browser note to its function and test (backend split, React login,
fingerprint cookies, poisoned session file, safe-list, bad credentials, DNS after an outage, CV Database module error, warm-DOM credits, unlock bursts, double navigation, empty-result probe, password hygiene).
The rest: screening outage 2026-09-01 -> halt + `screening-health` + `never-screened` alert; territory doom loops (2026-04-24, 05-04, 06-01) -> dedupe in `queue-due-territories`, run lock, claim handling (see KNOWN-LIMITS,
supervision); stranded candidates (2026-05-04, 08-24) -> Phase 2 checkpointing and `recover-stranded-phase1.js`; Zoho duplicates (2026-05-14) -> per-status-file run lock; runs/ bloat (2026-06-29) -> 7-day `runs/`
prune and one `runs/` scan per batch; Caterer credits stuck (2026-05-14) -> `caterer-get-credits.js` reads the warm page and never writes a fake value.
