# Environment and settings reference

Every setting the code, the cron wrappers, the tools and the tests read, with its default, who reads it and what it does. It was built from a scan of the repository (see "How this list was made"), so a
name that is not here is not read. Columns: **Default** is the value used when the setting is unset or empty; **Read by** lists the production files that read it (paths relative to `resourcer/scripts/` unless a directory is
given); **Secret** says whether the value is a credential (`HUMAN-ONLY` = only the owner types it, never in chat); **Test** is `yes` for variables that exist only for the test suites.

## How settings are read

- Hermes runs cron scripts with a scrubbed environment: the profile `.env` is **not** inherited (and `AI_GATEWAY_API_KEY` can never be passed through). The Node code therefore reads the profile `.env` itself (`scripts/lib/env.js`).
  Precedence for every setting read through `env.js`: real process environment, then `RESOURCER_ENV_FILE`, then `<profile>/.env`, then `RESOURCER_HOME/.env`. An empty value counts as unset. Lines are `NAME=value`, `#` starts a comment, quotes are optional.
- A setting marked **[env only]** is read from the process environment (or by a shell wrapper) and is not taken from `.env`. The cron wrappers set `RESOURCER_HOME` and `HERMES_HOME` themselves.
- `hermes/.env.example` lists what a profile `.env` may hold, with placeholders. Do not copy it over `.env` (writes to `.env*` from a shell need approval, and the file must be written by the owner on the dashboard Keys page).
- Numbers that are not valid or are out of range fall back to the default; a bad value never crashes screening.
- Files a setting can name live under the workspace: `config/screening.json` (screening engine and injection bar), `config/screening-criteria.json` (the screening criteria: questions, rules, operating point), `config/cv-screening.json` (the CV screening criteria), `config/territory-defaults.json` (search defaults), `config/dashboard-settings.json` (dashboard goals, targets, operating-hours display, `location_mode`, `show_candidate_names`, stall and backup thresholds; see `plugin/resourcer/README.md`).

## Location, profile and files

Where the code runs and which files it reads. `RESOURCER_HOME` and `HERMES_HOME` come from the process environment (or the cron wrapper) only; a line in the profile `.env` does not change them.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `RESOURCER_HOME` | the `resourcer/` directory that holds the running script; on the instance `/opt/data/profiles/resourcer/workspace/resourcer` | plugin/plugin_api.py, lib/paths.js, tools/preflight.sh, tools/screening-report.js, +1 more; tests (47) | no | no | **[env only]** Workspace root. Every runtime directory (`runs/ downloads/ logs/ runtime/ pending-searches/ secrets/ outbox/ shadow/ state/ backups/`) and `candidates.db` derive from it (`lib/paths.js`). The cron wrappers export it. The dashboard plugin reads it from its own process environment, else `dashboard/plugin_config.json` `{"resourcerHome": ...}`, else the default path; it can only read and write below it. |
| `HERMES_HOME` | the profile home: the wrappers use the parent of their own `scripts/` directory; the scripts fall back to `RESOURCER_HOME/../..` | lib/browser.js, lib/env.js, tools/preflight.sh, hermes/*.sh (cron wrappers); tests (17) | no | no | **[env only]** Hermes profile home (`/opt/data/profiles/resourcer`): holds the profile `.env`, `bin/agent-browser`, `scripts/` (installed wrappers), `SOUL.md`, `skills/`. Where a script needs the profile `.env` it reads `HERMES_HOME/.env` if the variable is set, so a value that names another profile (for example the host default home) selects the wrong file: check `sh tools/preflight.sh` and the wrapper log after install. |
| `RESOURCER_ENV_FILE` | unset | lib/env.js, tools/preflight.sh; tests (10) | no | no | **[env only]** An extra env file. Precedence of every setting read through `lib/env.js`: real process environment, then this file, then `<profile>/.env`, then `RESOURCER_HOME/.env`. Empty values count as unset. The files are read once per process. |
| `PROFILE_HOME` | derived from `RESOURCER_HOME/../..` | tools/preflight.sh | no | no | **[env only]** Read only by `tools/preflight.sh` as an override for the profile home it inspects. (The cron wrappers also use a local shell variable of the same name; that one is not an input.) |
| `TZ` | not read | inherited environment | no | no | Not read by the code: all hour-of-day logic (operating window 06:00-22:00, quiet hours, digest) uses Europe/London through `Intl`. Set the Hermes profile timezone to `Europe/London` (`hermes -p resourcer config set timezone Europe/London`) so the cron expressions fire at the intended London times. Browsers get their own zone from `RESOURCER_BROWSER_TZ`. `tools/preflight.sh` reports it. |
| `HOME` | inherited | lib/browser-env.js, tools/preflight.sh; tests (1) | no | no | Browser children need a writable `HOME`; when it is missing or not writable they get the `state/` directory instead (`lib/browser-env.js`). |
| `PATH` | inherited | lib/browser-env.js; tests (3) | no | no | Must contain `node` (the wrappers exit 91 otherwise), and for the tick wrapper `timeout`; for Reed `xvfb-run`, `Xvfb` and `xauth`. |
| `TMPDIR` | inherited | lib/browser-env.js, tools/preflight.sh, hermes/*.sh (cron wrappers); tests (2) | no | no | Hermes points it at a scratch directory that may not exist. The tick, pre-flight and keep-alive wrappers replace a missing or unwritable `TMPDIR` by `state/t`. Browsers are given their own `TMPDIR` by the code (see the "set by the code" section). |
| `DISPLAY` | inherited | lib/browser.js; tests (3) | no | no | Read only when `RESOURCER_AB_HEADED=1` (headed fallback for the Caterer browser). Removed from the environment of the headless Caterer browser and of the Reed launcher child (`xvfb-run` provides its own). |

## Sources, supervision and runs

How the tick, the runner and Phase 2 behave.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `RESOURCER_SOURCES` | `caterer` | caterer-preflight.js, process-approved-queue.js, reed-api-client.js, run-pipeline.js, +1 more; tests (3) | no | no | `caterer`, `reed` or `both`. Reed is on when the value is `both` or `reed`; anything else means Caterer only (`run-pipeline.js` logs a warning for an invalid value). Applied in the runner (the pending file is rewritten, the original request kept as `sourcesRequested`), in `run-pipeline.js`, in Phase 2 (a pending file asking for Reed is dropped while Reed is off) and in the pre-flight. Set to `both` only after the Reed canary (docs/DECISIONS.md `OD-E`). `reed` alone still scrapes Caterer first (legacy behaviour). |
| `RESOURCER_MAX_TICK_MIN` | `55` | hermes/scripts/resourcer-tick.sh, pipeline-watchdog.js | no | no | Length of one supervision tick in minutes. Capped at 55 in code (below the 3600 s cron timeout); it can only be lowered. The wrapper passes `--max-minutes` when the variable is in the cron job's own environment; otherwise `pipeline-watchdog.js` reads it through `lib/env.js`. A tick that launched a run does not end at this bound while the run is in flight: it stays until the run ends, at most until `RESOURCER_TICK_HARD_CAP_MIN`. A value below 20 turns the launch cutoff and this drain off (tests and smoke checks): such a tick ends at its bound as before. |
| `RESOURCER_LAUNCH_CUTOFF_MIN` | `38` | pipeline-watchdog.js | no | no | Minutes after a tick started at which it stops launching new runs (a run started later could not finish before the tick ends, and a run does not survive the end of the cron run that started it). After the cutoff the tick only supervises what is running and exits as soon as nothing is in flight. Clamped to 10 up to `RESOURCER_MAX_TICK_MIN` minus 10 (so 10 to 45 with the default bound); a value that is not a positive number means the default. Only lowering it makes sense when runs are being ended by the hard cap (alert `tick-hard-cap`). Frozen time (a suspended instance) is not counted. |
| `RESOURCER_TICK_HARD_CAP_MIN` | `56` | pipeline-watchdog.js | no | no | Latest minute, counted from the start of the tick, at which the tick still waits for a run it launched itself. A run still in flight then is ended cleanly (its phase 1 child first, then the runner if it has not exited within 10 s), keeps its territory claim like a run ended at the 70-minute ceiling, is recorded with exit 13 and reason `tick-hard-cap` (never counted against the territory) and raises the warning `tick-hard-cap` (at most once in 6 hours). Clamped to `RESOURCER_MAX_TICK_MIN` up to 56: 56 plus the kill work stays below the wrapper's 3450 s outer timeout, which stays below the global cron timeout (at least 3500 s), so it can only be lowered. A run adopted from an earlier tick is never ended by it. |
| `RESOURCER_SETTLE_MS` | `5000` | watchdog-runner.js | no | no | Pause after the runner's session check and before phase 1 starts. Tests use 0. |
| `RESOURCER_BROWSER_LOCK_WAIT_MS` | `30000` | watchdog-runner.js | no | no | How long the runner waits for `runtime/browser.lock` (held by a Reed browser or a manual Reed tool) before it exits 10 `browser-busy` without claiming a territory. |
| `RESOURCER_SLEEP_SCALE` | `1` | caterer-get-credits.js, caterer-login.js | no | no | Multiplier for the fixed sleeps in the Caterer login and credits code. Tests set 0. Leave at 1. |

## AI screening (docs/SCREENING.md)

Every `SCREEN_*` setting overrides the same key in `config/screening.json`. Order of precedence: environment or profile `.env`, then `config/screening.json`, then built-in defaults.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `AI_GATEWAY_API_KEY` | none (required) | lib/screening-health.js, lib/screening/engine.js, lib/screening/llm-client.js, lib/cv/jev.js, tools/preflight.sh; tests (4) | HUMAN-ONLY | no | Vercel AI Gateway key. In the default engine `jev_only` it is used for Jev only: the owner's Vercel team allows no other model through the gateway. Read by the Node code from the profile `.env` (Hermes never passes it to cron scripts). Missing or rejected means screening is unavailable: exit 3 and a halt. The owner enters it on the dashboard Keys page; never in chat. |
| `SCREEN_ENGINE` | `jev_only` | lib/screening/config.js; tests (3) | no | no | `jev_only` (Jev is the only model, no request ever goes to a language model; an unsure card is settled by the review policy, docs/SCREENING.md section 16), `llm` (language model only), `jev_shadow` (the language model decides, Jev is logged in parallel) or `jev` (Jev first, the model for unclear cases). `jev` behaves as `jev_shadow` until `decide.calibration.calibrated` is true; `jev_only` never downgrades. An unknown value falls back to `jev_only`. The three engines other than `jev_only` call the gateway's chat endpoint, which the owner's Vercel team blocks: they exist for tests and for later, and the code refuses them (the engine becomes `jev_only`, with a `WARN screening config:` line) unless `SCREEN_ALLOW_LLM=1` is set too. A leftover value from an earlier install is therefore harmless. |
| `SCREEN_ALLOW_LLM` | `off` | lib/screening/config.js; tests (2) | no | no | `1` lets the engines `llm`, `jev_shadow` and `jev` run. Leave it unset: the AI Gateway carries Jev only (docs/DECISIONS.md OD-I, SCR-23). Same as `allowLlm` in `config/screening.json`; the environment wins. Anything that is not a clear yes means no. |
| `SCREEN_TIER_MODE` | `legacy` | lib/screening/config.js | no | no | `legacy` keeps the old role-tier quirk (Commis Chef is tier 2); `fixed` makes Commis Chef tier 1. Changes who is rejected: an owner decision. Language-model engines only: it has no effect on `jev_only`, where Jev is asked the role level of the title and a commis chef search is an entry-level search (docs/SCREENING-CRITERIA.md section 12). |
| `SCREEN_GATEWAY_ORIGIN` | `https://ai-gateway.vercel.sh` | lib/screening/config.js, lib/cv/config.js; tests (2) | no | no | Gateway origin. Tests point it at a fake on 127.0.0.1. Anything else receives the API key and the redacted candidate text: keep it under the owner's control. |
| `SCREEN_REVIEW_PRE` | `reject` | lib/screening/config.js; tests (2) | no | no | Engine `jev_only`: what a card becomes BEFORE the unlock when both injection filters (the keyword filter and Jev's own answer) flag it as an instruction to an AI, or when it is empty. Jev decides every other card, approve or reject (docs/SCREENING-CRITERIA.md), so this is a rare fallback. (An unusable Jev answer before the unlock is no policy case: the card is left undecided and screened again.) `reject` (default, the old fail-closed rule) or `approve` (recall-tilted: every unsure card costs an unlock credit). Same as `decide.reviewPolicy.preUnlock`. Reason code `sys_review_policy_reject` or `sys_review_policy_approve`. |
| `SCREEN_REVIEW_POST` | `approve` | lib/screening/config.js; tests (2) | no | no | Engine `jev_only`: the same after the unlock, where it also settles an answer that stays unusable. `approve` (default: the credit is spent, a recruiter looks) or `reject`. Same as `decide.reviewPolicy.postUnlock`. |
| `SCREEN_LLM_MODEL` | `anthropic/claude-sonnet-5.5` | lib/screening/config.js | no | no | Deciding language model. Ignored in `jev_only`. |
| `SCREEN_LLM_BACKUP_MODEL` | `anthropic/claude-sonnet-5` | lib/screening/config.js | no | no | Model asked when the primary gives unusable output or fails; ignored when equal to the primary. Ignored in `jev_only`. |
| `SCREEN_JEV_MODEL` | `typesafe-ai/jev` | lib/screening/config.js, lib/cv/config.js | no | no | Jev model slug on the gateway. In `jev_only` a name that does not contain `jev` is replaced by the default with a warning: no other model may be named through the gateway. |
| `SCREEN_CONCURRENCY` | `6` | lib/screening/config.js | no | no | Jev requests in flight (1-16). |
| `SCREEN_LLM_CONCURRENCY` | `4` | lib/screening/config.js | no | no | Language-model requests in flight (1-16). Unused in `jev_only`. |
| `SCREEN_JEV_TIMEOUT_MS` | `15000` (`20000` for the CV stage) | lib/screening/config.js, lib/cv/config.js | no | no | Timeout of one Jev request. The CV stage reads it too (its own default is `jev.timeoutMs` 20000 in `config/cv-screening.json`). |
| `SCREEN_LLM_TIMEOUT_MS` | `60000` | lib/screening/config.js | no | no | Timeout of one language-model request. Unused in `jev_only`. |
| `SCREEN_MAX_ATTEMPTS` | `3` | lib/screening/config.js, lib/cv/config.js | no | no | Attempts per engine per request (1-6). 401, 402 and 403 are never retried. |
| `SCREEN_BACKOFF_BASE_MS` | `1000` | lib/screening/config.js, lib/cv/config.js; tests (1) | no | no | Base retry delay (tests use a few ms). |
| `SCREEN_RETRY_AFTER_CAP_MS` | `30000` | lib/screening/config.js, lib/cv/config.js; tests (1) | no | no | Upper bound on a server Retry-After. |
| `SCREEN_SHADOW` | `on` | lib/screening/config.js | no | no | Log every decision (and, in `jev_shadow`, the comparison of Jev and the model) to `shadow/screening-YYYY-MM-DD.jsonl` (mode 0600, 180 days). `off` also stops the parallel Jev call in `jev_shadow`; in `jev_only` it only stops the log (Jev still decides). |
| `SCREEN_SHADOW_RATE` | `1` | lib/screening/config.js | no | no | Share of candidates compared (0-1). |
| `SCREEN_SHADOW_TEXT` | `on` | lib/screening/config.js | no | no | Keep the redacted card text in the shadow log. `0` keeps hashes only (then no labelled sample can be exported). |
| `SCREEN_REDACT` | `on` | lib/screening/config.js | no | no | Redact names, postcodes, e-mails, phones and URLs before anything leaves the process. Leave on. |
| `SCREEN_STALE_RULE` | `off` | lib/screening/config.js | no | no | Opt-in rubric clause "profile clearly out of date" (can act as an age filter). Language-model prompt only: unused in `jev_only`. |
| `SCREEN_INSUFFICIENT` | `legacy` | lib/screening/config.js; tests (1) | no | no | `lenient` replaces the "no visible background" reject with an approve when the headline or any listed role is hospitality (recall-tilted policy, owner decision). Language-model prompt only: in `jev_only` the recall switch is `SCREEN_REVIEW_PRE`. |
| `SCREEN_CACHE_TTL_SEC` | `3600` | lib/screening/config.js; tests (1) | no | no | Decision cache (decisions only, never text); 0 disables. |
| `SCREEN_PAGE_RETRY_PAUSE_SEC` | `120` | lib/screening/config.js, phase1/config.js, reed-phase1.js; tests (1) | no | no | Pause phase 1 and Reed take before retrying a page after a screening failure (three failures in a row raise the halt). |
| `SCREEN_ZDR` | `off` | lib/screening/config.js, lib/cv/config.js | no | no | Ask the gateway for zero data retention on both the language model and Jev (`SCREEN_LLM_ZDR` and `SCREEN_JEV_ZDR` set them separately). Turn on only after the install canary proves it works for Jev; otherwise the gateway answers HTTP 400 `no_providers_available` and screening fails. |
| `SCREEN_LLM_ZDR` | follows `SCREEN_ZDR` | lib/screening/config.js | no | no | Zero data retention for the language model only (overrides `SCREEN_ZDR` for it). Canary the language-model path before turning it on: the gateway answers HTTP 400 when it cannot satisfy the flag. Unused in `jev_only`. |
| `SCREEN_JEV_ZDR` | follows `SCREEN_ZDR` | lib/screening/config.js, lib/cv/config.js | no | no | Zero data retention for Jev only (overrides `SCREEN_ZDR` for it). Turn on only after the install canary proves the gateway can satisfy it for Jev. |
| `SCREEN_CALIBRATED` | from the config file (`false`) | lib/screening/config.js; tests (2) | no | no | Marks the operating point of `config/screening-criteria.json` (and, for the engine `jev`, the Jev thresholds) as calibrated against recruiter labels (needed before `SCREEN_ENGINE=jev` decides). Owner decision after the report returns GO. In `jev_only` it only silences the one-line "uncalibrated placeholder thresholds" warning printed once per run (the engine runs either way). |
| `SCREEN_CONFIG_FILE` | `config/screening.json` | lib/screening/config.js | no | no | Alternative settings file. |
| `SCREEN_CRITERIA_FILE` | none (`config/screening-criteria.json`, else the copy packaged next to the code) | lib/screening/criteria.js; tests | no | no | Path of an alternative criteria file (the questions, the rules and the operating point; docs/SCREENING-CRITERIA.md). A file that exists but is invalid stops screening (exit 3, never decides); a name that does not exist is skipped. |
| `SCREEN_SOURCE` | detected from the snippet | ai-review.js | no | no | `caterer` or `reed`, labels rows in the shadow log (also `--source`). |
| `SCREEN_RUN_ID` | none | ai-review.js | no | no | Run id for the shadow log (also `--run-id`). |
| `SCREEN_INPUT_MODE` | `stdin` | phase1/config.js; tests (1) | no | no | `stdin` or `file`: how phase 1 hands candidates to the screener. `file` writes a 0600 file under `runtime/screening-input/` (removed on every exit path); tests only. |

## CV screening (docs/CV-SCREENING.md)

The stage between the CV download and the Zoho push (Phase 2). Jev only, the same key and gateway as snippet screening; the stage does not read `SCREEN_ENGINE`, `SCREEN_ALLOW_LLM`, `SCREEN_REVIEW_PRE`, `SCREEN_REVIEW_POST` or `config/screening.json`. The gateway, timeout, retry and zero-data-retention settings of the previous section (`SCREEN_GATEWAY_ORIGIN`, `SCREEN_JEV_MODEL`, `SCREEN_JEV_TIMEOUT_MS`, `SCREEN_MAX_ATTEMPTS`, `SCREEN_BACKOFF_BASE_MS`, `SCREEN_RETRY_AFTER_CAP_MS`, `SCREEN_ZDR`, `SCREEN_JEV_ZDR`) apply to it too. Every `CV_*` setting overrides the same key in `config/cv-screening.json`.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `CV_SCREEN` | `shadow` (also when unset or unrecognised) | process-approved-queue.js, lib/cv/phase2.js | no | no | CV screening after the unlock: `shadow` (the release default: every CV is screened and logged, nothing is ever blocked, an outage is only a warning, a queue whose screening keeps failing is cut short with one alert), `on` (a reject is not pushed, its CV and file are deleted and the rejection is recorded for the job title; an outage holds the queue with everything kept, nothing more is unlocked while the halt is up and the halt clears only when the CV route answers the supervisor's canary) or `off` (a strict no-op: nothing runs and Phase 2 is exactly as before the stage existed; also `0`, `false`, `no`, `none`, `disabled`). A typo is `shadow` with a warning, so it can never switch blocking on. The owner switches to `on` only after the shadow week and the recruiter audit of docs/CV-SCREENING.md section 10 (docs/DECISIONS.md CVS-4). Read by every Phase 2 run: no restart needed. |
| `CV_SCREEN_CONFIG_FILE` | `config/cv-screening.json` | lib/cv/config.js | no | no | Path of an alternative CV criteria file (the operating point, the per-level criteria, the question wording). It must exist and be valid: a file that is broken (not JSON, a value out of range or of the wrong type, a blanked question option) or that this setting names but that does not exist is a fault (the default file ships in the repository, so its absence is one too), and the stage fails closed: `cv-review.js` exits 3 (`SCREENING_REASON: cvconfig`), mode `on` holds the queue and halts (`CV screening criteria invalid`), shadow stops the stage for the queue with the warning `cv-config-invalid`. A key the code does not know is only a warning. |
| `CV_SCREEN_CONCURRENCY` | `4` | lib/cv/config.js | no | no | CV reviewer processes at once (1 to 8; one process per CV). Same as `jev.concurrency`; the environment wins. |
| `CV_RESURFACE` | `on` (also when unset) | lib/resurface.js | no | no | The role-scoped second look (docs/RESURFACE.md): a candidate who was unlocked and then rejected by CV screening for ONE role is screened again, as normal, when they come up under a DIFFERENT search title (snippet screening for the new role and, if approved, a fresh CV stage for it); a candidate who was pushed to Zoho is never looked at again. `on` (also `true`, `1`, `yes`) or `off` (also `false`, `0`, `no`); `off` restores the old rule exactly (every unlocked candidate is skipped for every role) and is the rollback. Anything else (a typo) is `off`, and every Phase 1 log and `cv-report.js` print a warning, so a typo can never switch spending on. It is effective ONLY while `CV_SCREEN` is `on`: only then do CV rejections exist. A second charge for the re-download is accepted by the owner (docs/DECISIONS.md RS-2) and is counted and capped (the next two settings). Read by every Phase 1 and Phase 2 process: no restart needed. |
| `CV_RESURFACE_MAX_PER_DAY` | `40` | lib/resurface.js | no | no | Runaway protection of the second look, not a switch: at most this many candidates are looked at again per London day, Caterer and Reed together (counted in `runtime/cv-resurface.json`). A candidate the cap stops stays skipped for now, nothing is recorded against them, they are eligible again the next day, and the WARN alert `cv-resurface-cap-reached` is raised once a day. `0` is the same as `CV_RESURFACE=off`. A value that is not a whole number is 40 with a warning. 40 is a design default, not yet confirmed by the owner. |
| `CV_RESURFACE_MIN_CREDITS` | `1000` | lib/resurface.js | no | no | The credit reserve of the second look: no candidate is looked at again while the Caterer balance (read right before the claim) is below this many credits, so the normal first unlocks keep their credits; the same WARN alert is raised. The normal unlock path has no reserve of its own (it does not read the balance before an unlock); this one exists only for the second look. A balance that cannot be read also holds the candidate back. For Reed the equivalent is the daily limit of profile views itself (a resurfaced Reed candidate is held back when no view is left today). 1000 is a design default, not yet confirmed by the owner. |
| `CV_FALLBACK_POLICY` | `approve` | lib/cv/config.js | no | no | What happens to the very rare CV Jev could not settle (unusable answers, both injection filters fired, personal data not verified clean): `approve` (a recruiter sees it) or `reject`. An unreadable CV always passes. Same as `fallback.policy`. |
| `CV_REJECT_ABOVE` | `0.75` | lib/cv/config.js | no | no | The one operating point of the CV stage: a CV is rejected only when its pReject reaches this number (0 to 1). Same as `operatingPoint.rejectAbove`; with that set to null the point is `costLost / (costLost + costWasted)`, 0.75 for the owner weights 1 and 3 (docs/DECISIONS.md CVS-3). |
| `CV_PDF_PARSE_DIR` | unset | lib/cv/vendor/text-extract.js | no | no | A directory to load the PDF reader package (`pdf-parse`) from when the normal module lookup does not find it. Tests and unusual installs only; the resourcer dependencies already provide it. |

## Caterer browser and login

The pinned agent-browser 0.21.0 driving headless Chromium, and the Caterer sign-in.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `CHROMIUM_PATH` | first existing of `/usr/bin/chromium`, `/usr/bin/chromium-browser`, the path recorded in `/etc/hermes/agent-browser-executable-path`; the Reed launcher also tries `/usr/bin/google-chrome` and `google-chrome-stable` | lib/browser-env.js, tools/preflight.sh; tests (3) | no | no | Chromium binary for both browsers. Set it when the browser is elsewhere. |
| `RESOURCER_AB_BIN` | `<profile>/bin/agent-browser`, then `RESOURCER_HOME/bin/agent-browser`, then `agent-browser` on PATH | lib/browser.js, tools/preflight.sh; tests (2) | no | no | The agent-browser executable. Must be the pinned 0.21.0 (sha256 `c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff`); a different version on PATH raises the `ab-version` alert. A `*.js` path is run through node (how the fake browser works in tests). |
| `RESOURCER_AB_CHROME_ARGS` | `--no-sandbox,--disable-dev-shm-usage,--lang=en-GB` | lib/browser-env.js, tools/preflight.sh | no | no | Comma-separated Chromium flags for the Caterer browser (exported to agent-browser as `AGENT_BROWSER_ARGS`). Replaces the default list; an empty value is ignored. |
| `RESOURCER_AB_HEADED` | unset (headless) | lib/browser.js | no | no | `1` runs the Caterer browser headed on `RESOURCER_AB_DISPLAY` or `DISPLAY`. Documented fallback only; needs a persistent display. |
| `RESOURCER_AB_DISPLAY` | `DISPLAY` | lib/browser.js | no | no | Display for headed mode. |
| `RESOURCER_AB_IPC_READ_MS` | `30000` | lib/browser.js | no | no | The agent-browser CLI's own read timeout; state-changing commands are killed 3 s before it so they are never re-sent. Tests shrink it. |
| `RESOURCER_AB_NAV_GAP_MS` | `5000` | lib/browser.js | no | no | Minimum gap between a navigation by one process and the next navigation by another process (the 2026-07-10 double-navigation incident). Tests use 0. |
| `RESOURCER_BROWSER_TZ` | `Europe/London` | lib/browser-env.js; tests (2) | no | no | Time zone given to both browsers (`off` disables): a UK datacenter address with a UTC browser is an avoidable bot signal. |
| `RESOURCER_BROWSER_LANG` | `en-GB` | lib/browser-env.js; tests (2) | no | no | Language given to both browsers (`off` disables). |
| `RESOURCER_FETCH_CACHE` | `no-store` | caterer-browser-fetch.js | no | no | Cache mode of the in-page fetches that unlock candidates and download CVs through the Caterer browser. `default` restores the plain request (then the browser may keep CV bytes and unlock replies in its disk cache). Leave at `no-store`. |
| `CATERER_SESSION_FILE` | `state/caterer-session.json` | lib/browser.js, phase1/session.js | no | no | Overrides the saved Caterer session path for the login code, the browser wrapper and phase 1 (they must agree; a mismatch raises `caterer-session-file`). |
| `CATERER_SAFELIST_COOLDOWN_MIN` | `60` | caterer-login.js | no | no | Minutes between login attempts after a safe-list block (every attempt e-mails a new link and voids the old one). |

## Phase 1 (scrape, screen, unlock)

Timings and limits of `scripts/phase1.js`. All are optional; the defaults are the tested values.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `PHASE1_HEARTBEAT_SEC` | `20` | phase1/config.js; tests (1) | no | no | Seconds between `HEARTBEAT:` lines while the screener runs. |
| `PHASE1_SETTLE_MS` | `5000` | phase1/config.js; tests (1) | no | no | Sleep after a `networkidle` timeout before the page is evaluated. |
| `PHASE1_UNLOCK_PAUSE_MS` | `1500` | phase1/config.js | no | no | Pause after each queued candidate. |
| `PHASE1_MAX_CONSECUTIVE_PAGE_ERRORS` | `5` | phase1/config.js | no | no | Consecutive failed pages that stop the run. |
| `PHASE1_INCOMPLETE_MAX_RUNS` | `3` | phase1/config.js | no | no | Early-ended runs of one search in a row before its territory is consumed anyway (counter in `runtime/phase1-incomplete-runs.json`). |
| `PHASE1_UNLOCK_FAIL_LIMIT` | `5` | phase1/config.js | no | no | Consecutive unlock failures that stop the run as incomplete. |
| `PHASE1_DB_FAIL_LIMIT` | `3` | phase1/config.js | no | no | Consecutive `candidates-db.js` write failures that stop the run as incomplete. |
| `PHASE1_RUN_TIMESTAMP` | unset | phase1/config.js | no | no | `yyyy-MM-dd-HHmmss`: resume that run and reload its queue checkpoint. |
| `PHASE1_LOCK_TIMEOUT_SEC` | `30` | phase1/config.js | no | no | Timeout of the global run-lock call. |
| `PHASE1_CREDITS_TIMEOUT_SEC` | `180` | phase1/config.js | no | no | Timeout of the credits check. |
| `PHASE1_DB_TIMEOUT_SEC` | `60` | phase1/config.js | no | no | Timeout of one `candidates-db.js` call. |
| `PHASE1_SCREEN_TIMEOUT_SEC` | `1500` | phase1/config.js | no | no | One batch screening call; a timeout counts as "screening unavailable". |
| `PHASE1_SINGLE_TIMEOUT_SEC` | `330` | phase1/config.js | no | no | One post-unlock review (a timeout approves: the credit is spent). |
| `PHASE1_UNLOCK_TIMEOUT_SEC` | `180` | phase1/config.js | no | no | One unlock call. |
| `PHASE1_HANDOFF_TIMEOUT_SEC` | `3900` | phase1/config.js | no | no | Hand-off to Phase 2 or `run-pipeline.js`. |
| `PHASE1_LOGIN_TIMEOUT_SEC` | `600` | phase1/config.js | no | no | The one automatic re-login phase 1 may attempt. |

## Reed

Reed uses one long-lived headed Chromium under `xvfb-run`, driven over the DevTools protocol. Reed is off until `RESOURCER_SOURCES` includes it.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `REED_CDP_PORT` | `9222` | ensure-chrome-cdp.js | no | no | Loopback DevTools port of the Reed browser (unauthenticated: any local process of the same user can drive the logged-in Reed session while it runs). |
| `REED_CHROME_PROFILE` | `state/chrome-reed` | ensure-chrome-cdp.js | no | no | Reed browser profile directory (holds the Reed login cookies). |
| `REED_CHROME_ARGS` | `--no-sandbox,--disable-dev-shm-usage,--lang=en-GB` | lib/browser-env.js; tests (1) | no | no | Comma-separated container-dependent Chromium flags for the Reed browser; replaces the default list. |
| `REED_TARGET_URL` | `https://www.reed.co.uk/recruiter/v2/candidates/search/results` | cdp-reed-full-login.js, ensure-chrome-cdp.js, reed-refresh-token.js | no | no | Search page the Reed tab must end on (the API only answers with a live tab there). |
| `REED_LOGIN_URL` | `https://secure-recruiter.reed.co.uk/login` | cdp-reed-full-login.js | no | no | Reed login page. |
| `REED_CDP_WAIT_S` | `30` | ensure-chrome-cdp.js | no | no | Seconds to wait for the Reed browser to serve DevTools after launch (also `ensure-chrome-cdp.js --wait`). |
| `REED_KEEP_CHROME` | `0` | reed-phase1.js, run-pipeline.js, watchdog-runner.js; tests (1) | no | no | `1` leaves the Reed browser running after a run (operator debugging; the next Caterer run stops it). |
| `REED_LOCK_WAIT_SEC` | `300` | run-pipeline.js | no | no | How long `run-pipeline.js` waits for `runtime/browser.lock` before recording `browser_lock_busy`. |
| `REED_LOGIN_BLOCK_HOURS` | `12` | cdp-reed-full-login.js, reed-api-client.js; tests (1) | no | no | After a Cloudflare Turnstile block no automatic login is tried for this many hours, and Reed is held. |
| `REED_AUTH_HOLD_MIN` | `30` | reed-api-client.js; tests (1) | no | no | Minutes Reed is held after other auth failures (0 disables the short hold). |
| `REED_ALERT_REMIND_HOURS` | `72` | reed-api-client.js; tests (1) | no | no | A forgotten Reed alert episode is repeated after this many hours (0 = never). |
| `REED_AUTO_RELAUNCH` | `1` | reed-browser-fetch.js | no | no | `0` disables the single relaunch attempt when the Reed browser vanished mid-run. |
| `REED_CDP_TRUST_EXISTING` | `0` | ensure-chrome-cdp.js | no | no | `1` adopts a DevTools endpoint on the port that does not belong to the Reed profile. Leave off. |
| `REED_CDP_CLOSE_WAIT_MS` | `10000` | ensure-chrome-cdp.js | no | no | Grace for the browser to flush cookies after the CDP quit before the forced stop. |
| `REED_REFRESH_TIMEOUT_MS` | `90000` | reed-phase1.js | no | no | Kill timeout of the token refresh (30 s aborted slow valid captures on 2026-06-09). |
| `REED_LOGIN_TIMEOUT_MS` | `90000` | reed-phase1.js | no | no | Kill timeout of the automatic login. |
| `REED_LAUNCH_TIMEOUT_MS` | `60000` | reed-phase1.js, reed-refresh-token.js | no | no | Kill timeout of the browser launch step. |
| `REED_CAPTURE_TIMEOUT_MS` | `45000` | reed-refresh-token.js | no | no | Time allowed to capture the bearer token after navigation. |
| `REED_CDP_COMMAND_TIMEOUT_MS` | `30000` | reed-refresh-token.js | no | no | Timeout of one DevTools command. |
| `REED_CV_DELAY_MS` | `200` | reed-phase1.js | no | no | Pause between Reed CV fetches. |
| `REED_SCREEN_TIMEOUT_MS` | `900000` | reed-phase1.js | no | no | Kill timeout of the screening child in `reed-phase1.js` (a timeout counts as "unavailable"; tests lower it). |
| `REED_TAB_READY_WAIT_MS` | `10000` | reed-browser-fetch.js | no | no | Before a Reed API request the tab must be loaded, idle and unchanged between two polls; this is the longest wait for that (0 switches the wait off). After it the request is sent anyway and the retries take over. Design default, not an owner decision. |
| `REED_TAB_SETTLE_MS` | `1500` | reed-browser-fetch.js | no | no | Quiet time after the tab's last navigation before the first Reed API request of a process (so the Reed page can finish what it does after loading). Adds at most this to a run. Design default. |
| `REED_RETRY_BACKOFF_MS` | `1500` | reed-browser-fetch.js | no | no | Base pause between the attempts of a Reed API request that answered HTTP 400 `RequiredHeaderMissingException` (code 50010): 1.5 s, then 3 s. Design default. |
| `REED_RETRY_CAP_MS` | `45000` | reed-browser-fetch.js | no | no | Total time cap of those retries (three attempts at most). It is checked before each pause and bounds the re-capture, not an attempt already running: a failing answer comes back at once (about 8 to 9 s for a whole failed page in the fakes), a hanging page is bounded by the 30 s answer timeout and the tab wait instead. Design default. |

## Backups and alerts

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `BACKUP_PASSPHRASE` | none (required for backups) | backup-db.js; tests (2) | HUMAN-ONLY | no | Passphrase (at least 16 characters) of the nightly encrypted backup; alternatively the file `secrets/backup-passphrase` (mode 0600, first line). Keep a copy off the instance or the backups are unreadable if the instance is lost. Not passed to the upload command. |
| `BACKUP_UPLOAD_CMD` | unset (no off-instance copy) | backup-db.js | no | no | Command that copies the encrypted backup off the instance: a JSON array of strings such as `["rclone","copyto","{file}","remote:bucket/{name}"]`, or a plain command split on spaces. `{file}`, `{name}` and `{manifest}` are substituted; runs with an argument array, no shell, 10 minute limit. Exit 5 of the backup job means the upload failed (the local copy is fine). |
| `BACKUP_UPLOAD_ENV` | empty | backup-db.js | no | no | Comma-separated names of settings (for example an access key, kept in the profile `.env`) that are passed to the upload command. Nothing else secret is. |
| `RESOURCER_DEADMAN_URL` | unset | alerts-deliver.js | yes | no | External liveness URL that the alert job pings about hourly (every 55 minutes), and only while the tick heartbeat is fresh, so a missing ping tells the external service that the supervisor is down (a ping URL is a bearer secret). |

## Dashboard plugin installer (plugin/resourcer/install-plugin.sh)

Shell overrides for a non-standard layout, read only by the installer script when it is run as a file (`bash install-plugin.sh`). Leave unset on the instance.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `PLUGIN_DEST` | `/opt/data/plugins/resourcer` | plugin/resourcer/install-plugin.sh | no | no | **[env only]** Where the plugin is installed; an existing directory is moved aside to `<dest>.old-<UTC time>`, never deleted. |
| `PROFILE_PLUGINS_DIR` | `/opt/data/profiles/resourcer/plugins` | plugin/resourcer/install-plugin.sh | no | no | **[env only]** Profile directory in which the installer links the plugin. |
| `HERMES_BIN` | `hermes` | plugin/resourcer/install-plugin.sh | no | no | **[env only]** The Hermes command used to enable the plugin. |
| `HERMES_DEFAULT_HOME` | `/opt/data` | plugin/resourcer/install-plugin.sh | no | no | **[env only]** Default Hermes home whose config lists the enabled plugins (fallback path when `hermes plugins enable` is refused). |
| `HERMES_PROFILE_HOME` | `/opt/data/profiles/resourcer` | plugin/resourcer/install-plugin.sh | no | no | **[env only]** Profile home whose config lists the enabled plugins (same fallback). |
| `HERMES_PYTHON` | the interpreter named in the first line of the `hermes` launcher | plugin/resourcer/install-plugin.sh | no | no | **[env only]** Python used by the installer fallback that writes the plugin entry with the config helpers of Hermes itself (also a shell variable in the manual snippets of `plugin/resourcer/README.md`). |

## Data bundle tools (laptop and instance)

These tools read the process environment only, never the profile `.env`.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `BUNDLE_PASSPHRASE` | unset | inherited environment | HUMAN-ONLY | no | **Install-time key, not read by any code.** Route 2 of docs/INSTALL.md section 5.1: the owner types the bundle passphrase on the dashboard Keys page under this name, the operator moves it into a 0600 file with a command that prints nothing (`secrets/bundle-passphrase`), and the owner deletes the key from the Keys page after the restore. Route 1 (the owner creates the file in their own terminal) avoids putting it in the profile `.env` at all. |
| `BUNDLE_PASSPHRASE_FILE` | unset | tools/lib/bundle-format.js (make-bundle, restore-bundle, verify-bundle, archive-legacy) | HUMAN-ONLY (the file) | no | **[env only]** File holding the bundle passphrase (16 characters or more, first line, mode 0600), created by the human in their own terminal; deleted after restore. Never an argument. Sources, first match wins: this variable, `BUNDLE_PASSPHRASE_FD`, the file `<home>/secrets/bundle-passphrase` (restore only; a regular file with mode 0600), a hidden prompt on a real terminal. |
| `BUNDLE_PASSPHRASE_FD` | unset | tools/lib/bundle-format.js (make-bundle, restore-bundle, verify-bundle, archive-legacy) | HUMAN-ONLY (the descriptor) | no | **[env only]** File descriptor number to read the passphrase from. |
| `BUNDLE_SCRYPT_LOG2N` | `17` | tools/lib/bundle-format.js (make-bundle, restore-bundle, verify-bundle, archive-legacy) | no | no | **[env only]** scrypt cost exponent for building a bundle (15 to 18). Lowering it weakens the encryption (`make-bundle.js` prints a warning below 17): tests only. |
| `BUNDLE_SQLITE_MODULE` | unset | tools/lib/bundle-format.js; tests (1) | no | no | **[env only]** Directory of `better-sqlite3` when it is not installed under `resourcer/node_modules`. |

## Install probes (tools/preflight.sh)

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `MANIFEST_EXPECT` | unset | tools/preflight.sh | no | no | **[env only]** Pinned sha256 of `MANIFEST.sha256` (the `MANIFEST_SHA256=` value printed at install time and recorded off the instance); `tools/preflight.sh` passes it as `--expect` to `tools/check-manifest.js`. |
| `HERMES_SCALE_TO_ZERO` | not read by the pipeline | tools/preflight.sh | no | no | **[env only]** Reported by `tools/preflight.sh` (whether the instance scales to zero when idle). |

## Set by the code for child processes (not inputs)

Do not set these. They are listed so a search for the name finds an explanation.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `RESOURCER_BROWSER_LOCK_HOLDER_PID` | unset | ensure-chrome-cdp.js; tests (2) | no | no | **[env only]** Set by the runner and `run-pipeline.js` for their children so `ensure-chrome-cdp.js` treats the lock as borrowed when the process ancestry is broken. Do not set by hand. |
| `AGENT_BROWSER_SOCKET_DIR` | `state/ab`, or `/tmp/rab-<hash>` when the socket path would be too long | set by lib/browser.js for agent-browser | no | no | **[env only]** Forced by `lib/browser.js` on every agent-browser call so exactly one daemon exists per session (the 2026-08-02 backend-split incident). Every inherited `AGENT_BROWSER_*` value is removed first. |
| `AGENT_BROWSER_EXECUTABLE_PATH` | from `CHROMIUM_PATH` | set by lib/browser.js for agent-browser | no | no | **[env only]** Chromium path handed to agent-browser. |
| `AGENT_BROWSER_ARGS` | from `RESOURCER_AB_CHROME_ARGS` | set by lib/browser.js for agent-browser | no | no | **[env only]** Chromium flags handed to agent-browser. |
| `AGENT_BROWSER_HEADED` | unset | set by lib/browser.js for agent-browser | no | no | **[env only]** Set to `1` only by `RESOURCER_AB_HEADED=1`. |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | unset | set by lib/browser.js for agent-browser | no | no | **[env only]** Set to `0` only when a newer agent-browser than 0.33.1 is found on PATH. |
| `BACKUP_FILE` | - | set by backup-db.js for the upload command | no | no | **[env only]** Given to the `BACKUP_UPLOAD_CMD` child: path of the encrypted backup. |
| `BACKUP_NAME` | - | set by backup-db.js for the upload command | no | no | **[env only]** Given to the upload child: file name of the backup. |
| `BACKUP_MANIFEST` | - | set by backup-db.js for the upload command | no | no | **[env only]** Given to the upload child: path of the backup's manifest file. |
| `PF_KEY` | - | tools/preflight.sh (internal) | no | no | **[env only]** Used inside `tools/preflight.sh` to hand the AI Gateway key to its own helper without putting it on a command line. Not an input. |
| TMPDIR, HOME, TZ (browser children) | TMPDIR `state/t` (Caterer daemon) or `state/rt` (Reed launcher), moved to `/tmp/rab-<hash>/t\|rt` when the Chromium singleton socket path (TMPDIR + 46 characters) would exceed 107; HOME the inherited writable one, else `state/`; TZ `Europe/London` | set by lib/browser-env.js, lib/browser.js, ensure-chrome-cdp.js | no | no | **[env only]** Given by `lib/browser-env.js` to both browsers (and to `xvfb-run`) instead of the scratch directory of Hermes, which may be missing, unwritable or too long. `TZ` and the language come from `RESOURCER_BROWSER_TZ` and `RESOURCER_BROWSER_LANG`. |
| `NO_COLOR` | - | set by lib/browser.js | no | no | **[env only]** Set to `1` for agent-browser output. |
| `LANGUAGE` | - | set by lib/browser-env.js | no | no | **[env only]** Derived from `RESOURCER_BROWSER_LANG` for browser children (with `TZ` from `RESOURCER_BROWSER_TZ`). |

## Test-only variables

Used by the test suites and rehearsal scripts. Never set them in a profile. `RESOURCER_TEST_NOW` and the `PHASE1_SCRIPT_<NAME>` override are the two that reach production code, which is why they are called out.

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `RESOURCER_TEST_NOW` | unset | lib/time.js | no | yes | **[env only]** **Reaches production code.** An ISO instant that replaces the clock for the operating window (`inOperatingHours`) and the alert quiet hours and digest hour, and for nothing else. Read from the real process environment only (never from `.env`), so the Hermes cron environment cannot carry it; a leaked value would freeze the operating window. Never set it in a profile. |
| `PHASE1_SCRIPT_<NAME>` | unset | phase1/config.js; tests (1) | no | yes | **Reaches production code.** `PHASE1_SCRIPT_AI_REVIEW`, `PHASE1_SCRIPT_CATERER_GET_CREDITS` and so on replace the script phase 1 runs (`scripts/<name>.js`) with an absolute path. It exists for tests; anyone who can set it can make phase 1 run other code, so it must never be in a profile `.env` (the manifest check does not see environment variables). |
| `REED_API_BASE` | `https://api.reed.co.uk/api-bff-recruiter-candidates` | reed-api-client.js | no | yes | Reed API origin and path. Tests point it at a local stand-in; nothing else should. |
| `REED_XVFB_RUN` | `xvfb-run` | ensure-chrome-cdp.js | no | yes | Name or path of the `xvfb-run` wrapper (tests and exotic setups). |
| `REED_CDP_POLL_MS` | `1000` | ensure-chrome-cdp.js | no | yes | Readiness poll interval of the launcher (tests). |
| `REED_LOGIN_TIME_SCALE` | `1` | cdp-reed-full-login.js | no | yes | Multiplier for the login flow's waits (tests use a small value). |
| `BUNDLE_TEST_TMP` | OS temp dir | tests only (1 file) | no | yes | Where the bundle tests create temp directories. |
| `NODE_PATH` | - | tests only (3 files) | no | yes | **[env only]** Make `better-sqlite3` (in `resourcer/node_modules`) resolvable from `tests/`: `NODE_PATH=$PWD/resourcer/node_modules`. |
| `NODE_OPTIONS` | - | tests only (1 file) | no | yes | **[env only]** The end-to-end rehearsal injects `tests/e2e/lib/preload.js` here to redirect known hosts to fakes and throw for any other host. |
| `RESOURCER_PYTHON` | unset | tests only (2 files) | no | yes | **[env only]** Python with `fastapi`, `httpx` and `pytest`; without it the dashboard plugin test suites skip. |
| `REED_REAL_CHROMIUM` | unset | tests only (1 file) | no | yes | **[env only]** Path of a real Chromium; enables `tests/reed/real-chromium.test.js` (also an acceptance check on the instance). |
| `E2E_ROOT` | `~/hermes-sim` | tests only (2 files) | no | yes | **[env only]** Where `tests/e2e-linux.sh` builds the simulated profile and the per-scenario worlds. |
| `E2E_LOGS` | `$E2E_ROOT/logs` | tests only (1 file) | no | yes | **[env only]** Per-scenario logs of the rehearsal. |
| `E2E_VENV` | `~/hermes-sim-venv` | tests only (1 file) | no | yes | **[env only]** Python venv the rehearsal creates when `E2E_PYTHON` is not given. |
| `E2E_PYTHON` | unset | tests only (2 files) | no | yes | **[env only]** Python with `fastapi` and `httpx` for the dashboard scenario. |
| `E2E_REPO_COPY` | `~/hermes-sim-repo` | tests only (1 file) | no | yes | **[env only]** Linux copy of a repository that sits on a Windows drive mount. |
| `E2E_KEEP` | unset | tests only (1 file) | no | yes | **[env only]** `1` keeps the per-scenario worlds (same as `--keep`). |
| `E2E_SEED` | `20260929` | tests only (1 file) | no | yes | **[env only]** Seed of the random-kill scenario. |
| `E2E_SERVICES_FILE` | - | tests only (1 file) | no | yes | **[env only]** JSON map of host name to local port for the preload that redirects the known hosts to the fakes. |
| `E2E_NETLOG` | - | tests only (1 file) | no | yes | **[env only]** File where the preload records any attempt to reach a non-loopback host (must stay empty). |
| `E2E_CLOCK_FILE` | - | tests only (1 file) | no | yes | **[env only]** JSON list of clock jumps applied by the preload (the suspend/resume scenario). |
| `E2E_REED_CANDIDATES_FILE` | - | tests only (1 file) | no | yes | **[env only]** Optional card overrides for the fake Reed browser. |
| `SMOKE_NET` | unset | tests only (1 file) | no | yes | **[env only]** `tests/browser/smoke-linux.sh`: also run the egress-country check (one request to an IP echo service). |
| `SMOKE_LONG` | unset | tests only (1 file) | no | yes | **[env only]** `smoke-linux.sh`: also run the 10-minute idle/reaper check. |
| `SMOKE_KEEP` | unset | tests only (1 file) | no | yes | **[env only]** `smoke-linux.sh`: keep the temp directory. |
| `P1_TEST_TMP` | OS temp dir | tests only (5 files) | no | yes | **[env only]** Temp base of the phase 1 tests. |
| `REED_TEST_TMP` | OS temp dir | tests only (6 files) | no | yes | **[env only]** Temp base of the Reed tests. |
| `SUP_TEST_TMP` | OS temp dir | tests only (1 file) | no | yes | **[env only]** Temp base of the supervision tests. |
| `LIFECYCLE_TEST_TMP` | OS temp dir | tests only (2 files) | no | yes | **[env only]** Temp base of the lifecycle tests. |
| `P1_BETTER_SQLITE3_DIR` | unset | tests only (1 file) | no | yes | **[env only]** A `node_modules` directory containing `better-sqlite3` for the two real-database phase 1 tests. |
| P1_*, FAKE_*, DRIVER_*, and other fixtures | - | tests only (24 files) | no | yes | **[env only]** Knobs passed by a test to its own fake child (fake agent-browser, fake Chromium, fake screener, fake Zoho, fake gateway port and key, scenario files, forced hangs and errors, fake secrets used to prove redaction). Not settings; the names are in the scan output below. |

## Names that look like settings but are not read from the environment

| Name | Default | Read by | Secret | Test | Meaning |
|---|---|---|---|---|---|
| `HERMES_HOME_SEEN` | - | - | no | no | Local variable of the cron wrappers that remembers an inherited `HERMES_HOME` so a mismatch can be logged. |
| `REED_AUTH_MAX_RETRIES` | `3` (constant) | - | no | no | Constant in Phase 2: Reed auth retries per pending search before it is dropped. Not configurable. |
| `REED_SEARCH_URL` | - | - | no | no | Constant in `reed-refresh-token.js` (taken from `REED_TARGET_URL`). |
| `REED_SOURCES` | - | - | no | no | A list of file names inside `tools/make-bundle.js`. |
| REED_EMAIL, REED_PASS, REED_PASSWORD, REED_USERNAME | - | tools/make-bundle.js | no | no | Names of constants inside the two legacy Reed scripts that `tools/make-bundle.js` searches by pattern to extract the Reed login at build time. Not environment variables. |
| Markers: REED_AUTH_FAILED, REED_RELOGIN_NEEDED, REED_LOGIN_OK, REED_LOGIN_BLOCKED_TURNSTILE, REED_TOKEN_REFRESHED, REED_CRED_*, CATERER_MODULE_ERROR | - | cdp-reed-full-login.js, reed-api-client.js, reed-download.js, reed-phase1.js, +1 more; tests (5) | no | no | Output markers printed on stdout/stderr and exit-code names, or variable names that only appear in test fixtures. Not settings. |

## How this list was made, and how to check it

The list was generated by scanning `resourcer/`, `tools/`, `plugin/`, `hermes/` and `tests/` for `process.env.X`, `process.env["X"]`, `env.get/has/require("X")` (the `lib/env.js` reader), destructuring of `process.env`, Python `os.environ`
reads, shell `${X:-default}` expansions and `export X` lines, plus every quoted name that starts with `RESOURCER_`, `SCREEN_`, `CV_`, `PHASE1_`, `BUNDLE_`, `BACKUP_`, `CATERER_`, `REED_`, `E2E_`, `LIFECYCLE_`, `P1_`, `FAKE_`, `HERMES_`,
`AGENT_BROWSER_`, `AI_GATEWAY` or `CHROMIUM`. The generator refused to finish while any scanned name was missing from the table. To re-check by hand after a change:

```
grep -rhoE "(RESOURCER|SCREEN|CV|PHASE1|BUNDLE|BACKUP|CATERER|REED|AGENT_BROWSER|HERMES)_[A-Z0-9_]+|AI_GATEWAY_API_KEY|CHROMIUM_PATH" resourcer tools plugin hermes --include=*.js --include=*.py --include=*.sh | sort -u
```

and compare with the first column. Any new setting must be added here and, when a profile may hold it, to `hermes/.env.example`.

Names found in the scan, by table: Names that look like settings but are not read from the environment: 15; Set by the code for child processes (not inputs): 7; AI screening (docs/SCREENING.md): 34; CV screening (docs/CV-SCREENING.md): 6; Backups and alerts: 4; Data bundle tools (laptop and instance): 2; Test-only variables: 71; Caterer browser and login: 12; Location, profile and files: 8; Dashboard plugin installer (plugin/resourcer/install-plugin.sh): 6; Install probes (tools/preflight.sh): 2; Phase 1 (scrape, screen, unlock): 16; Reed: 21; Sources, supervision and runs: 7. Total distinct names: 201.
