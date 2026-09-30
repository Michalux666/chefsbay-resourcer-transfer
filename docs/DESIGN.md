# DESIGN CONTRACT: resourcer on Hermes

Authoritative for every work package. If a package cannot follow a rule, it records a deviation in its result; it never silently diverges.
Research inputs live in `C:\Users\micha\.openclaw\hermes-port\research\` (read the ones named in your brief). The legacy system is `C:\Users\micha\.openclaw\workspace-resourcer` (READ-ONLY, never modify, never run its pipeline, never open its `candidates.db` for writing).

## 1. Goal and principles

Move the resourcer (Caterer.com and Reed.co.uk CV sourcing -> AI screening -> unlock/download -> Zoho Recruit) from a Windows laptop (OpenClaw, PowerShell, WSL, pm2) to a Hermes Cloud profile `resourcer` on Linux, hands-off: an operator LLM follows `docs/INSTALL.md` with nothing to discover or debug.

1. **Reliability over novelty.** Behaviour, state-file schemas, exit codes and reliability layers of the legacy system are preserved unless this document lists a deliberate change. Weeks of hardening must not be lost.
2. **Everything testable offline is tested offline** (fake browser, fake gateway, temp DBs, temp dirs) before hand-off. The operator only runs acceptance checks, never debugging sessions.
3. **No secrets or personal data in the repo, logs, tests or fixtures.** Fake data only. Secrets travel only in the encrypted data bundle (see 9) and live on the instance in `secrets/` (0700) or the profile `.env` (0600).
4. **Never write CVs or snippets outside the process.** CVs are deleted after Zoho create+attach; snippets are never written to `/tmp`.
5. **One rubric, one place.** Screening criteria live in code/config, not scattered prompts.

## 2. Target environment (facts, from research)

Debian 13 x64, no root, no sudo, user `hermes` (UID 10000), Node 26, Python 3.13, `chromium` and `xvfb-run` preinstalled, gcc/make present, ~4 GB RAM shared with a timesheet profile (default), ~2.9 GB free on `/opt/data` (persistent). `/tmp` and the root overlay are ephemeral. Egress is a UK datacenter IP. Hermes cron: `hermes -p resourcer cron create "<schedule>" --no-agent --script <name>.sh --deliver local --workdir <dir>`; scripts must be real `.sh` files in `<profile>/scripts/`; timeout is global (default 3600 s, no per-job flag); cron environment is scrubbed (profile `.env` is NOT inherited, `AI_GATEWAY_API_KEY` is blocklisted from passthrough) so Node reads the `.env` file itself via `scripts/lib/env.js`; empty stdout is silent; non-zero exit alerts; a script's descendants are tree-killed on timeout and children holding the script's stdout/stderr pipes stall the job (redirect real work's fds to files). Hermes Cloud scales to zero after ~120 s idle: only running cron jobs/tracked background work keep it awake, so supervision is a **bounded foreground cron tick (<= 55 min)**, never a detached daemon. Foreground terminal calls are capped at 600 s. Dashboard plugins live at `/opt/data/plugins/<name>/` (machine level); the plugin must jail itself to the resourcer profile paths.

Local test beds: Windows Node v25.6.1 (this laptop) and WSL Ubuntu 24.04 (Node 22.22.1, Python 3.12, `flock`, `xvfb-run`; no chromium, no fastapi: create a venv under the scratchpad if you need it). Code must run on Node >= 22 (CommonJS, `node:test`, `node:sqlite` NOT used; `better-sqlite3` is the DB driver).

## 3. Repository layout

```
README.md  HANDOFF.md  OPERATOR-PROMPT.md
docs/            INSTALL.md CUTOVER.md ROLLBACK.md OPERATIONS.md SCREENING.md SECURITY.md DECISIONS.md
                 ACCEPTANCE.md KNOWN-LIMITS.md LEGACY-MAP.md TEARDOWN.md ENV.md DESIGN.md parity/<wp>.md
resourcer/       workspace root (= RESOURCER_HOME on the instance)
  package.json  candidates-db.js  config/  scripts/  scripts/lib/  scripts/phase1/
  (runtime dirs, created on demand, never committed: runs/ downloads/ logs/ runtime/ pending-searches/
   secrets/ outbox/ shadow/ state/ backups/)
plugin/resourcer/  dashboard plugin (manifest at dashboard/manifest.json, dashboard/plugin_api.py, dashboard/dist/index.js)
hermes/          profile files: AGENTS.md SOUL.md .env.example cron/jobs.json scripts/*.sh skills/resourcer-ops/SKILL.md
tools/           make-bundle.js (laptop) restore-bundle.js verify-bundle.js (instance) preflight.sh install helpers
tests/           node --test suites (per package) + fake servers + e2e-linux.sh
data/            resourcer-bundle.enc  (added at cutover, encrypted; never plaintext)
```

Instance layout: `RESOURCER_HOME=/opt/data/profiles/resourcer/workspace/resourcer`; profile home `/opt/data/profiles/resourcer` (`HERMES_HOME`); cron wrapper scripts installed to `<profile>/scripts/` (thin `.sh` that `cd`s and `exec node`s into `RESOURCER_HOME`).

## 4. Shared libraries (already written; do not rewrite, extend only via the owner)

`resourcer/scripts/lib/`: `paths.js` (all directories, `RESOURCER_HOME` override), `env.js` (reads process env and the profile `.env` file; `get/has/require/redact`), `fsx.js` (`writeJsonAtomic`, `readJson`, `appendLine`, `ensureDir`, `pidAlive`, `sleep`, `sha256File`), `notify.js` (`notify({severity,key,text,meta})` appends to `outbox/alerts.jsonl`; replaces every legacy `WHATSAPP_ALERT:`), `time.js` (`londonParts`, `londonHour`; ALL hour-of-day logic uses Europe/London via `Intl`, never OS-local time). Never `console.log` a secret; wrap anything that might contain one in `env.redact`.

## 5. Interfaces between packages

### 5.1 `scripts/lib/browser.js` (owner WP3) - agent-browser wrapper, replaces `Invoke-AgentBrowserCmd` and every `wsl bash -c "agent-browser ..."`
```
run(args: string[], {session='caterer', timeoutMs=120000}) -> Promise<{ok:boolean, code:number|null, out:string, timedOut:boolean}>
   // spawn (no shell), env forces ONE socket dir (AGENT_BROWSER_SOCKET_DIR under paths.STATE) and browser exe/profile under paths.STATE, DISPLAY handling, kill the process tree on timeout, out = stdout+stderr merged like PowerShell 2>&1
open(url,{timeoutMs}) waitNetworkIdle({timeoutMs}) evalB64(b64,{timeoutMs}) getUrl({timeoutMs}) stateSave(file) stateLoad(file) close()
```
The six call forms are the only ones the pipeline uses: `open`, `wait --load networkidle`, `eval -b <b64>`, `get url`, `state save`, `state load`; all on session `caterer` (see `research/agent-browser-linux.md`). agent-browser version is pinned (0.21.0). Profile and session dirs are under `state/` (persistent), never `/tmp`.

### 5.2 Caterer login (owner WP3): `scripts/caterer-login.js` exports `ensureLoggedIn({allowRelogin})` and has a CLI; port of `caterer-do-login.ps1` + inline `doInlineLogin()` in watchdog-runner (ONE implementation; the 2026-07-04 bug was two copies). Credentials via `scripts/lib/caterer-credentials.js` reading `secrets/caterer-credentials.json`.

### 5.3 Screening CLI (owner WP2) - unchanged contract of `scripts/ai-review.js` / `caterer-ai-review.js`
`--mode batch --job --location --distance [--batch-size] --candidates-file <json>` and `--mode single --job --title --snippet`; JSON on stdout (`[{id:string,approved:boolean,reason:string<=120}]` / `{approved,reason}`), stderr marker `SCREENING_MODEL: <label>` on success AND on API failure, token `API_UNAVAILABLE` on stderr and stdout prefix `API_UNAVAILABLE:`, exit 0 / 1 / 3. Rules and deliberate divergences: `research/screening-contract.md` section 6.11 (D1..D11) with the defaults in section 8 below. Callers (phase1, reed-phase1) invoke it as a child process.

### 5.4 Phase 1 (owner WP4): `scripts/phase1.js` (+ `scripts/phase1/*.js`)
Node port of `phase1-scrape.ps1` (1,236 lines) keeping every unit (see `port-manifest.md` section 2), the parameter names (`-ParamsFile` becomes `--params-file <json>` and each former parameter becomes `--kebab-case`), the status-file schema (`runs/phase1-<ts>.json`, UTF-8 no BOM), the queue-file schema, and the exit codes **0 ok, 2 SESSION_STALE, 3 another pipeline active, 4 TERRITORY_MISMATCH, 5 missing params, 6 BAD_URL_ENCODING, 7 params file unreadable**. `watchdog-runner.js` depends on them. Fixes listed in section 7 apply.

### 5.5 Supervision (owner WP5)
`hermes/scripts/resourcer-tick.sh` runs `node scripts/pipeline-watchdog.js --tick --max-minutes 55` under a PID-liveness lock (Node, not `flock`-only), redirecting all work output to `logs/`; `pipeline-watchdog.js` and `watchdog-runner.js` keep the legacy logic (operating-hours window in Europe/London, 15-minute stale back-off after exit 11, 70-minute run kill, halt probe, queue drain, `queue-due-territories` hook, `cull-ghost-phase1` and `recover-stranded-phase1` maintenance) minus pm2/schtasks/openclaw/WhatsApp. Runs are launched with stdout/stderr redirected to files; liveness is by PID file plus heartbeat mtime, never by command-line scans.

### 5.6 Data lifecycle (owner WP6)
`scripts/migrate-schema.js` (idempotent; WAL, busy_timeout, `run_results` table exactly as `research/dashboard-parity.md` section 4.5, optional nullable `candidate_rejections.reason_code`); `process-approved-queue.js` patched (paths, remove the OpenClaw wake call, write `run_results` right after the results file is written, **delete `cv-<id>.*` and `candidate-<id>.json` once the Zoho id is set AND (CV attached OR duplicate)**; failed attaches kept 14 days); `scripts/retention-sweep.js` (queue/result JSON after phase2Complete + 3 days, runs/ > 7 days, logs rotation/compress > 14 days, orphan CVs > 14 days, `review-tmp-*` always, disk-usage guard that raises a `notify` critical above 85%); `scripts/backfill-run-results.js`. Nothing under `downloads/` may be deleted before `run_results` is populated (script enforces).

### 5.7 Reed (owner WP7)
`ensure-chrome-cdp.js` (chromium under `xvfb-run -a` with `--remote-debugging-port`, profile in `state/`), Reed login/token flows fixed for Chrome 153 (`Network.requestWillBeSent`, not `setRequestInterception`), credentials only from `secrets/reed-credentials.json` (NEVER hard-coded), `reed-phase1.js` + `run-pipeline.js` patched (paths, launcher, screening integration, D4 no-burn-on-outage, shared halt). Reed is gated by `RESOURCER_SOURCES` (`caterer` default until the operator's canary passes, then `both`).

### 5.8 Dashboard (owner WP8)
`plugin/resourcer/dashboard/{manifest.json,plugin_api.py,dist/index.js}` per `research/hermes-dashboard-plugin.md` and `research/dashboard-parity.md`: routes `/health /status /stats /runs /territories /schedule POST /search POST /halt/clear`; read-only SQLite (`file:...?mode=ro`); paths jailed to the resourcer profile; atomic JSON writes for search requests (unique file names, prefix `search-`, never `spawnedAt`, 409 on duplicate title+location); `tools/request-search.js` shares the same validation for CLI use. No CSRF/auth logic of its own (Hermes gates it).

### 5.9 Data bundle (owner WP9)
`tools/make-bundle.js` (laptop; prompts for a passphrase with hidden input; refuses to run while a pipeline run is live; SQLite online backup of `candidates.db`; AES-256-GCM with scrypt, Node `crypto` only), `tools/restore-bundle.js` (instance; idempotent; modes 0600/0700; refuses to overwrite a newer DB without `--force`; verifies sha256 and row counts; prints only names and counts, never contents), `tools/verify-bundle.js`. Bundle contents: `candidates.db`, `config/*.json`, `scripts/extract-js.b64`, the postcode/Reed caches, `pending-searches/`, `secrets/{caterer-credentials,zoho-credentials,reed-credentials}.json` (Reed values extracted from the two legacy source files by pattern at build time, never printed). Never included: session/cookie files, Chrome/agent-browser state, downloads, runs, logs, `review-tmp-*`, dashboard-auth, gateway tokens.

## 6. Environment variables (register every new one in `docs/ENV.md` via the docs package's grep)

`RESOURCER_HOME`, `HERMES_HOME`, `RESOURCER_ENV_FILE`, `RESOURCER_SOURCES` (`caterer|reed|both`, default `caterer`), `RESOURCER_MAX_TICK_MIN` (55), `TZ` (Europe/London, and code must not depend on it), `AI_GATEWAY_API_KEY` (Vercel AI Gateway, read from the profile `.env` by `env.js`), `SCREEN_ENGINE` (`llm|jev_shadow|jev`, default `jev_shadow`), `SCREEN_TIER_MODE` (`legacy|fixed`, default `legacy`), `SCREEN_GATEWAY_ORIGIN` (default `https://ai-gateway.vercel.sh`), `SCREEN_LLM_MODEL` (default `anthropic/claude-sonnet-5.5`), `CHROMIUM_PATH`, `AGENT_BROWSER_SOCKET_DIR` (forced by `browser.js`), `SCREEN_BACKOFF_BASE_MS` (tests).

## 7. Deliberate behaviour changes (everything else is parity)

Remove: OpenClaw gateway/alias, `openclaw` CLI, pm2, schtasks, Login Startup, WSL, PowerShell, WhatsApp, ngrok, Windows paths, `prune-sessions`, `gateway-health-check`, the LLM watcher wake, the Express dashboard. Fix: the phase1 empty-result probe lost its backslashes (regex was `wrong` since 09-04; remote-territory `EMPTY` guard never fired; write it correctly and test it); Reed no longer burns candidates when screening is down (D4); post-unlock prompt aligned with the batch prompt through one shared rubric (D2); watchdog hour window in Europe/London; no `review-tmp-*` files; secrets never hard-coded (Reed) and never `Write-Host`ed; browser profile/session state under `state/`, not `/tmp`; the Reed Chrome tree is killed after each use (the Caterer browser daemon stays warm between runs, DECISIONS X5); Caterer and Reed browsers never run at the same time.

## 8. Defaults chosen for the owner decisions (documented in `docs/DECISIONS.md`, all reversible by config)

D1 fix Reed burn: yes. D2 align post-unlock prompt: yes; D10 tier quirk: `SCREEN_TIER_MODE=legacy`. D3 shadow log: redacted (first name, surname heuristic, postcode) in `shadow/screening-*.jsonl`, 180 days. D4 alerts: outbox plus a no-agent cron that prints new alerts (Hermes delivers stdout to the configured channel: `local` by default, email/Telegram when the human adds it), quiet hours 22:00-06:00 except critical. D5 backups: nightly `.backup` + integrity check + gzip + encrypt to `backups/` (14 daily, 8 weekly) and a hook `BACKUP_UPLOAD_CMD` for an off-instance copy chosen by the human (document that a same-volume backup does not survive loss of the instance). D6/D7/D11 later. D8: Reed off until canary passes. D9 CV retention: as 5.6. Screening engine default `jev_shadow`: the normal LLM (Claude via the same gateway key, prompts verbatim) DECIDES, Jev answers in parallel and is only logged; promotion to `jev` is one config flip after the calibration report (`tools/screening-report.js`) clears the gate in `docs/SCREENING.md`.

## 9. Coding standards

CommonJS, Node >= 22, ASCII-only source (no smart quotes/em dashes; PowerShell mojibake taught us), LF line endings, no npm dependencies beyond `better-sqlite3`, `mammoth`, `pdf-parse` and `ws` (DECISIONS X7); `agent-browser` pinned separately, spawn with argument arrays (never a shell string built from data), atomic writes for every state file, every CLI supports `--help` and exits with defined codes, no `process.exit` inside libraries, no comments except a one-line WHY where non-obvious. Every script that used a Windows path uses `paths.js`. Banned tokens anywhere in shipped code: `C:\`, `C:/Users`, `wsl `, `powershell`, `pwsh`, `openclaw`, `pm2`, `schtasks`, `18789`, `WHATSAPP`, `ngrok`, `\\` path literals. Tests: `node --test`, zero network (a fetch guard throws for non-127.0.0.1 hosts), temp dirs, fake secrets, deterministic. Each package writes `docs/parity/<wp>.md` mapping legacy file:line -> new file:function and listing preserved behaviours and any deviation.

## 10. Verification rules for every package

Run your tests on Windows Node and, where it touches paths/processes/locks/sockets/permissions, again in WSL (`wsl bash -lc "cd /mnt/c/Users/micha/.openclaw/hermes-port/repo && node --test \"tests/<pkg>/*.test.js\""`; note NTFS permission semantics differ, so copy to `~` inside WSL for chmod/lock tests). Report exactly what ran and what could not be run. Never claim a live-site behaviour was verified; label it UNVERIFIED-LIVE and list it for the acceptance checklist.
