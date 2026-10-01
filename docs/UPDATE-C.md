# UPDATE C: the release (forced-choice screening, the CV stage, CV_SCREEN=on made safe, the Reed first-page fix) for an instance at Update A

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note takes an installed instance from commit `d60d917` (Update A: Jev-only screening, the privacy fix, the tick drain, the dashboard labels; `docs/UPDATE-JEV-ONLY.md`) to this release in ONE cycle: one pause, one pull, one set of checks, one resume. It contains everything that `docs/UPDATE-B.md` (screening criteria and the CV stage in shadow) and the two later updates added, so an instance still at `d60d917` does this note and NOT `docs/UPDATE-B.md` (that note is superseded for such an instance: its pull would bring the whole release while its text says that no dashboard plugin file changes). An instance still on the first release (commit `016b444`) does `docs/UPDATE-JEV-ONLY.md` first. A fresh install follows `docs/INSTALL.md` and needs none of this.

## What changes and why

Four changes and a few small fixes. Nothing here changes a number, a criterion or the operating point that the owner has decided, and `CV_SCREEN` stays at its default `shadow`. All model calls go to Jev through the AI Gateway (the gateway carries no other model; the deep health check also reads the account balance, `GET /v1/credits`, which is not a model call).

- **Snippet screening decides by forced choice from an editable criteria file** (`docs/SCREENING-CRITERIA.md`, `docs/DECISIONS.md` SCR-29 to SCR-33). Jev answers small questions about each card and, once per search title, what level of role that title is; code turns the answers into approve or reject with one operating point. Jev decides at least 99 percent of the cards (the owner's rule); the review policy settles only the rare fallback card. No job title is named in code any more. A profile settings file written by Update A still loads: at most one `WARN screening config:` line names keys that are not read any more.
- **A CV screening stage runs after the unlock and the CV download, before the Zoho push** (`docs/CV-SCREENING.md`). It reads the whole CV, removes everything personal, asks Jev how the work history fits the searched role and decides pass or reject. It starts in **shadow**: it records what it would have done and blocks nothing, so every candidate goes to Zoho exactly as before. Shadow is only the first step: switching it to `on` (which stops rejected candidates reaching Zoho) is the owner's decision after the shadow acceptance of `docs/CV-SCREENING.md` section 10.3 (at least 300 screened CVs and a recruiter audit; `docs/ACCEPTANCE.md` SR13, DC9). This update sets nothing.
- **`CV_SCREEN=on` is made safe to switch on later** (Update C). A failure of the CV route alone used to cycle (hold, halt, the supervisor asks only the snippet route and clears the halt, a new run unlocks more candidates, hold again). Now the supervisor's deep check also sends one small invented request through the CV stage's own client while the mode is `on`; no Phase 1 unlock starts while the halt is up; a held run is recorded as runner exit 14 `phase2-held` (neither a success nor a failure); the recovery completes the held queue after the halt clears. A broken or missing `config/cv-screening.json` fails closed (mode `on` holds, shadow stops the stage with the new WARN alert `cv-config-invalid`). Shadow is bounded in time (`phase2.shadowMaxSeconds`, default 120 s; a design default, not yet confirmed by the owner). `scripts/cv-review.js --self-test` proves the PDF and Word readers load. `scripts/cv-report.js` prints the share of queued CVs that the shadow time cap left unscreened. With the default `shadow` none of the hold behaviour is active.
- **A Reed attempt that cannot fetch its first search page is a failure, not an empty search** (Update D, `docs/parity/reed-first-page.md`). On 2026-09-30 twelve of 33 Reed attempts failed with HTTP 400 (RequiredHeaderMissingException, code 50010) and were recorded as a clean empty search, so their territories silently lost the Reed half. Now the Reed request carries its token in the same browser call, waits for an idle tab, is retried (3 attempts in all, bounded by a 45 s cap: design defaults, not yet confirmed by the owner), and a failure is recorded as a failure: Reed status `failed` in the results and in `run_results`, a "Reed failed" badge on the dashboard run (after the dashboard restart, step 5), the alert `reed-first-page-failed`, a line in the 18:00 digest and a Reed-pending mark on the territory with ONE automatic retry the next day. `tools/reed-catchup.js` lists the territories that lost their Reed half and, at the owner's word, re-queues a few a day (`docs/OPERATIONS.md` 8.1). The root cause on the live site is still unverified (K-REED13): the fix is proven in the fakes.
- **How the two meet** (the release itself). The results file and the `run_results` row carry both the CV counters and the Reed half of one run. A both-source queue that CV screening held before its Reed step ran, and that the recovery then completes on the Caterer queue alone, is recorded Reed `not_run` and the territory is marked Reed-pending, so its Reed half is not lost silently (K-REED17; a design default, not yet confirmed by the owner). `tools/reed-catchup.js` never lists or queues a territory whose run is merely held. The worst time the Reed retries and the shadow cap add to one run stays inside the tick's drain window (`docs/OPERATIONS.md` section 2).

Also in this release, with nothing for you to do: ten new alert keys (`cv-reject-rate-high`, `cv-fallback-rate-high`, `cv-forced-rate-high`, `cv-unreadable-rate-high`, `cv-shadow-stopped`, `cv-review-errors`, `cv-screening-unavailable`, `cv-reject-not-recorded`, `cv-config-invalid` and `reed-first-page-failed`; `hermes/AGENTS.md`, `docs/OPERATIONS.md` section 11), the runner exit code 14 (`phase2-held`, only with `CV_SCREEN=on`), the report `scripts/cv-report.js` and the tools `tools/gold-rows.js`, `tools/screening-operating-point.js` and `tools/reed-catchup.js`.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard: that is a human action in the Portal (step 5 says when the owner does it).
4. ORDER MATTERS: code first (steps 2 to 5), then the checks (step 7), then resume. There is no setting to change: never set `CV_SCREEN`, `CV_REJECT_ABOVE`, `CV_FALLBACK_POLICY`, `RESOURCER_SOURCES` or any `SCREEN_*` setting in this update (`CV_SCREEN` stays unset, which is shadow; `RESOURCER_SOURCES` stays as the owner set it, `both`), and never edit `config/screening-criteria.json` or `config/cv-screening.json` (they are the owner's; a tracked file that the owner edits in place makes the next `git pull --ff-only` stop with "local changes", so keep edited copies under the profile and point `SCREEN_CRITERIA_FILE` / `CV_SCREEN_CONFIG_FILE` at them).
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` in this note does too. The `cp` commands into `/opt/data/plugins/` (step 5, rollback) write outside the profile and may need approval as well: ask the owner and wait, never go round it.
6. The canary texts are invented. Never use a real candidate or a real CV in this update.
7. Stale variables in this terminal. The operator terminal may still carry variables exported in an earlier session (`RESOURCER_SOURCES`, `SCREEN_ENGINE`). They are not settings of the profile: the pipeline reads the profile `.env` (what `config set` writes). They only reach a command you run by hand here, and there they win over the `.env`. So a canary that prints a `WARN screening config:` line about a retired `SCREEN_ENGINE` value is harmless: nothing is wrong with the instance, the engine is `jev_only` anyway. If you want a clean output, put `env -u SCREEN_ENGINE ` (and `env -u RESOURCER_SOURCES ` for that variable) in front of the same command; do not unset or change anything in the profile.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed the release to the code repository, to the branch this instance tracks (step 3 is a fast-forward of that branch: a release that sits on another branch makes step 3 answer `Already up to date`, a STOP), and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of the release. The owner gets it from the person who finalised the release: it is the `manifest_sha256=` value that `node tools/make-manifest.js` prints on the owner's machine after the last commit (it is also in the release report). The `MANIFEST.sha256` file of the checkout is not a substitute for it, on purpose: a manifest regenerated with a tampered script would otherwise pass, so you take `<NEW_DIGEST>` from the owner's message and never from this file or from the checkout you are verifying. For the owner's comparison, the digest computed when this release was finalised (after its last code change) is `4bca8bb203613b5bd8c3e97669af3633efdbf5205cb2e3af246c1692e7797f26`; compare it with what your own `make-manifest` prints on the commit you pushed, and give the operator only a value that you have checked yourself;
- the go-ahead to update now. Update after 22:00 London time, when no run is in flight (`docs/OPERATIONS.md` section 12).

OPERATOR: first note which of the two jobs are enabled now, because only those are resumed at the end (the owner may have paused one on purpose):

```
/opt/hermes/bin/hermes -p resourcer cron list
```

Expect: a list that shows `resourcer-tick` and `resourcer-queue-due` and whether each is enabled or paused. Write down which of the two were enabled. Then pause both and wait until the pipeline is idle:

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `busy` is false. If it is true, a run is in flight: wait a few minutes and run the status command again (do not loop). A run lasts at most about an hour (the tick's hard cap is minute 56): if `busy` is still true after an hour, STOP, leave both jobs paused, tell the owner and wait for the word. A `halt` that is not null is a screening outage that started before the update: note the reason and go on; do not clear it.

## 2. Record the way back (OPERATOR)

```
git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD
```

Expect: 40 hex characters that start with `d60d917`. Write it down as `<OLD_COMMIT>`. A value that starts with `016b444` means the instance is still on the first release: STOP and tell the owner (`docs/UPDATE-JEV-ONLY.md` comes first). A value that starts with `a7fc7be` means Update B was installed on its own: STOP and tell the owner (this note is written for `d60d917`; the steps are the same, `<OLD_DIGEST>` is then `8d28dc66d5b449506e71a6a9908b4d45d84a00c99508a870539b091c06519ed5` and the pull says `Updating a7fc7be..`, and the owner decides). Any other value: STOP and report it.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=fe1ca88206ff5e24325b5bd4378ce7a8d3e8d81329dec27a2823d689662ec4a0` (the digest of Update A). Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`, or a different digest: STOP (the instance was modified or is not at Update A; do not update over it).

## 3. Pull the release (OPERATOR)

This is the update command of `docs/INSTALL.md` 2.6; the deploy key is remembered in the repository, and it works on the shallow clone. It runs in the workspace directory:

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating d60d917..<new id>`, `Fast-forward`, and a long file list that includes `resourcer/scripts/cv-review.js`, `resourcer/scripts/lib/cv/canary.js`, `resourcer/config/cv-screening.json`, `tools/reed-catchup.js`, `plugin/resourcer/dashboard/plugin_api.py` and `docs/UPDATE-C.md`.
`Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile and plugin files (OPERATOR, then OWNER)

Of the files that the profile and the machine keep a copy of, this release changes exactly four: `hermes/AGENTS.md` (the alert table, the halts text), the `resourcer-ops` skill (the runner exit codes, the Reed failure and the catch-up), and two files of the dashboard plugin, `plugin/resourcer/dashboard/plugin_api.py` and `plugin/resourcer/dashboard/dist/index.js` (the "Reed failed" badge). The cron wrappers, `SOUL.md`, `hermes/cron/jobs.json` and `hermes/.env.example` (an example, never installed) are unchanged or not installed: do not touch them.

```
cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/
```

```
cmp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cmp /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/SKILL.md /opt/data/profiles/resourcer/skills/ops/resourcer-ops/SKILL.md
```

Expect: no output from either `cmp`. Now the dashboard plugin. If `ls -d /opt/data/plugins/resourcer` says it does not exist, the plugin was never installed on this instance: skip the rest of this step up to the full check. Otherwise copy the two changed files into the existing plugin folder (the folder `docs/INSTALL.md` 10.1 made; nothing is moved or deleted):

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

```
cmp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cmp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

Expect: no output from any `cmp`. What the copy does and does not do, exactly:

- `dist/index.js` (the page script) is served fresh on every page load: the owner's browser shows the new script after a reload (F5) of the dashboard page. Nothing else is needed.
- `plugin_api.py` (the Python backend of the plugin) is imported ONCE when the dashboard process starts. A rescan of the plugins does not load it again, and nothing you can run here does. So the new backend takes effect only at the next dashboard restart. A dashboard or gateway restart is a HUMAN action in the Hermes Portal (`docs/INSTALL.md` 10.3: the owner presses Restart for the dashboard). You never restart Hermes or the dashboard yourself (rule 3).
- So the pipeline does not wait for it: do steps 6 to 8 now, resume the jobs, and ask the owner to press Restart whenever it suits (any time, there is no urgency, nothing the pipeline does depends on it). Until then the old backend keeps running and the dashboard simply does not show the "Reed failed" badge; the failure is still in the results, in `run_results`, in the alert `reed-first-page-failed` and in the 18:00 digest.
- The mismatch risk is small and one-sided on purpose: the new page script only READS optional fields (`failed`, `failureReason`) that the new backend adds to a run's Reed statistics, so new script with the old backend shows no badge and breaks nothing, and the old script with the new backend ignores the extra fields. Both orders are safe. If the dashboard shows a blank or broken Runs panel after the owner's restart or reload, report it and do not repair it (the rollback below puts the old files back).
- A rollback that leaves the new backend loaded after a restart is equally harmless for the same reason.

Then the full check, which also compares every installed copy:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and no `INSTALLED_CHANGED` line (an `INSTALLED_MISSING` line for the plugin is only a warning and is expected when the plugin was never installed). An `INSTALLED_CHANGED` line that names a wrapper, `SOUL.md` or a plugin file other than the two copied above: STOP and report it (this release does not change them).

## 6. Nothing else to install, nothing to set (OPERATOR)

`resourcer/package.json`, the cron wrappers and `hermes/cron/jobs.json` are unchanged: no `npm install`, no job edit, no wrapper copy. There is no setting to change. The CV stage is in shadow because `CV_SCREEN` is unset (the default); `RESOURCER_SOURCES` stays as the owner set it (`both`); the criteria files came with the pull. No restart of anything is needed for the code: every screening and Phase 2 process reads the code and the settings when it starts. One database change happens by itself, later and only when needed: the first time a run that asked for Reed finishes Phase 2 with a Reed result (searched, empty, failed or login failed), the code adds the empty column `territory_searches.reed_pending_since` to the territory table (automatically, idempotent; the nightly backup includes it, and old code ignores it). The earlier files on the instance (`state/cv-answers.jsonl`, `state/cv-search-levels.json`, `shadow/cv-*.jsonl`) stay as they are.

## 7. Checks: one without network, then canaries with invented text (OPERATOR)

Send each command once and wait for its answer; never repeat them in a loop. The canaries cost a fraction of a cent each.

### 7.1 The CV readers (no network)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cv-review.js --self-test
```

Expect: exit 0 and exactly one line, `CV_SELF_TEST_OK pdf docx`. A line that starts `CV_SELF_TEST_FAILED` (exit 1) names the file type and a fixed reason code, for example `pdf:error_parse_failed`: the PDF reader cannot load on this instance, which would turn every PDF into "unreadable" (a pass). STOP and report the line; do not go on to the canaries.

### 7.2 Snippet screening, before the unlock (batch)

One suitable and one unsuitable invented candidate (`timeout=300`). The command is the one of `docs/INSTALL.md` 7.3 with `--no-shadow`, so these invented cards are not written to the shadow log:

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode batch --job Chef --location M1 --distance 20 --source caterer --run-id install-canary --with-codes --no-shadow --candidates '[{"id":"canary-yes","snippet":"Chef de Partie | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Chef de Partie Jan 2019 - Current Test Bistro Ltd Key Responsibilities Running the sauce section, daily prep, ordering, food safety"},{"id":"canary-no","snippet":"Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"}]'
```

Expect: exit 0; standard output is one line, a JSON array with `"id":"canary-yes"` having `"approved":true` and `"id":"canary-no"` having `"approved":false`, each with a `reason` and a `reasonCode` (`approve_...` and `reject_unrelated_industry` are typical); standard error contains `SCREENING_MODEL: typesafe-ai/jev` and, once, a `WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds` line (expected until the owner has calibrated the operating point on recruiter labels) and NO line that begins `WARN screening config:` about a setting of the profile (such a line names a setting that is still wrong: STOP and report it; a line about a retired `SCREEN_ENGINE` value that comes from a stale variable of this terminal is harmless, rule 7). Exit 3 with `screening-criteria.json` in the output: the criteria file on the instance is missing or invalid; STOP, edit nothing, report the text.

### 7.3 Snippet screening, after the unlock (single)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode single --job Chef --title "Retail Cashier" --source caterer --run-id install-canary --with-codes --no-shadow --snippet "Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"
```

Expect: exit 0; one line `{"approved":false,"reason":"...","reasonCode":"reject_..."}`. A `"approved":true` with `"reasonCode":"sys_review_policy_approve"` means the review policy decided (both injection filters flagged the invented card, or Jev's answer stayed unusable): not expected, so record it and tell the owner.

### 7.4 CV screening (two invented CVs)

Use your file-write tool (not a shell redirect) to create `/opt/data/profiles/resourcer/install-work/canary-cv.txt` with exactly this content. The folder exists from `docs/INSTALL.md` 0.7; if `ls -d /opt/data/profiles/resourcer/install-work` says it does not, do 0.7 first.

```
Sam Sampleperson
Chef de Partie

Employment history

Chef de Partie, Test Bistro Ltd, Testville
January 2019 to present
Running the sauce section, daily prep, ordering and food safety in a 60 cover restaurant.

Commis Chef, Sample Kitchen Ltd, Testville
March 2016 to December 2018
Preparation and cooking on the larder and pastry sections.

Education
Level 2 Food Safety in Catering
```

Then create `/opt/data/profiles/resourcer/install-work/canary-cv-no.txt` with exactly this content:

```
Robin Roleplay
Retail Assistant

Employment history

Retail Assistant, Test Store Ltd, Testville
January 2019 to present
Till operation, stock replenishment and customer service.

Sales Assistant, Sample Shop Ltd, Testville
March 2016 to December 2018
Shop floor sales and merchandising.
```

Run the chef, searched as Chef de Partie (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv.txt --no-shadow
```

Expect: exit 0; standard output is one JSON line that begins `{"decision":"pass","final":"approve","lane":"jev"` (it holds numbers and reason codes only, no text); standard error ends with `SCREENING_MODEL: typesafe-ai/jev`. `--no-shadow` keeps the invented CV out of the shadow log, so it cannot disturb the numbers the owner reads later. Exit 3 with `SCREENING_REASON: cvconfig` on standard error: `config/cv-screening.json` is broken or missing on this instance (the file ships in the repository; `MANIFEST_OK` should have caught a changed copy): STOP, edit nothing, report the text. Then the retail assistant (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv-no.txt --no-shadow
```

Expect: exit 0; one JSON line that begins `{"decision":"reject","final":"reject","lane":"jev"` with the reason code `no_relevant_experience` (usually with `career_change`); the same `SCREENING_MODEL` line. In shadow mode this blocks nothing: it only shows that the stage tells the two apart. Then delete both files, one command each (`rm` may need approval, see rule 5):

```
rm /opt/data/profiles/resourcer/install-work/canary-cv.txt
```

```
rm /opt/data/profiles/resourcer/install-work/canary-cv-no.txt
```

### 7.5 The deep screening check (what the supervisor asks while the pipeline is halted)

Use your file-write tool (not a shell redirect) to create `/opt/data/profiles/resourcer/install-work/deep-check.js` with exactly this content (the folder exists from `docs/INSTALL.md` 0.7):

```
'use strict';
const h = require('/opt/data/profiles/resourcer/workspace/resourcer/scripts/lib/screening-health');
h.check({ deep: true }).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
});
```

Run (`timeout=300`):

```
RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node /opt/data/profiles/resourcer/install-work/deep-check.js
```

Expect: one JSON line beginning `{"ok":true,"reason":"","ms":`, with `"level":"auth"` and `"engines":{"jev":{"ok":true}}`, exit 0. There must be NO `llm` entry inside `engines` (an `llm` entry means old code is running or `SCREEN_ALLOW_LLM` is set: STOP and report). There is no `cv` entry either: the CV canary of the deep check runs only while `CV_SCREEN` is `on`, which this update never sets (step 7.6 is the optional live proof). If it fails, the JSON holds `reason` and `detail`: `screening gateway auth failed` with `restricted access` in the detail means the owner must allow `typesafe-ai/jev` on the Vercel team (the JSON then carries a `remedy` field that says so); `screening credits exhausted`: the owner tops up; `screening criteria invalid`: a criteria file is broken, STOP and report; any other `screening gateway error`: repeat once, then report. Do not go on until the check is `"ok":true`. Keep the scratch file only if the owner asked for 7.6; otherwise delete it now (the `rm` command at the end of 7.6).

### 7.6 Optional, only if the owner asks: the CV canary of the deep check, live

This proves once, against the real gateway, the canary that makes `CV_SCREEN=on` safe (K-CV7). It sets NOTHING: `CV_SCREEN=on` is given in front of this one command only (it reaches this process, not the profile), and it uses the scratch file of 7.5. Run (`timeout=300`):

```
CV_SCREEN=on RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node /opt/data/profiles/resourcer/install-work/deep-check.js
```

Expect: `"ok":true` and `"engines":{"jev":{"ok":true},"cv":{"ok":true}}`, exit 0. A `cv` entry with `"ok":false` (reason `CV screening criteria invalid`, a gateway reason or `screening gateway error`): report the JSON; nothing is changed by it. Then delete the scratch file (after 7.5, or after 7.6 if the owner asked for it; `rm` may need approval, see rule 5):

```
rm /opt/data/profiles/resourcer/install-work/deep-check.js
```

If any check fails:

| Symptom | Meaning | Action |
|---|---|---|
| `CV_SELF_TEST_FAILED` | a file reader cannot load or read an invented file | STOP and report the line (fixed reason codes, no text) |
| exit 3, output begins `API_UNAVAILABLE:` | Jev could not be reached, or the gateway refused the key or the model | report the text after the colon (`restricted access to this model` means the owner must allow `typesafe-ai/jev` on the Vercel team); do not repeat more than once; the pipeline halts by itself until Jev answers, do not clear the halt |
| exit 3 and `SCREENING_REASON: cvconfig`, or the text names `screening-criteria.json` | the criteria file on the instance is missing or invalid | STOP, edit nothing, report the text |
| the chef CV is `"decision":"reject"`, or any canary is `"lane":"fallback"` or `"decision":"unreadable"` | the stage read or judged an obvious CV wrongly | STOP and report the JSON line (numbers and codes only) |
| the retail assistant is `"decision":"pass"` | Jev doubted an obvious mismatch (a forced pass) | STOP and report the JSON line |
| batch: `canary-yes` rejected, or `canary-no` approved | the criteria and Jev disagree with the recruiters on an obvious card | STOP and report both lines |
| batch: a canary card has `reasonCode` `sys_invalid_result` | Jev's answer for that card was unusable twice; the card is left undecided, not rejected | repeat the batch call once; if it comes back again STOP and report both lines |
| exit 1 with `FATAL` | usage or input problem (for example a file was not created) | report the text |

## 8. Resume (OPERATOR)

Resume only the jobs you noted as enabled in step 1 (normally both):

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes once the tick has run the deep check: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the self-test line, the four canary results (batch, single, chef CV, retail CV) and the deep-check line; and ask the owner to press Restart for the dashboard in the Portal when convenient (step 5: until then the "Reed failed" badge does not show).

Idempotent: yes. Repeating step 3 after it has passed answers `Already up to date`: on a repeat that is the expected answer, not the STOP of a first run. Repeating steps 4 to 7 changes nothing.

## 9. Watching the first runs (OPERATOR, then OWNER)

Nothing here is urgent and nothing here changes anything. You only read and report; the owner decides.

### 9.1 The first CV shadow rows

Phase 2 runs the CV stage for every run that approved candidates, so the first shadow rows appear after the first such run (runs start only between 06:00 and 22:00 London). After the first run that pushed candidates (before it the folder may not exist yet: `ls` then exits 2 with `No such file or directory`; that only means no run has finished since the update, wait):

```
ls /opt/data/profiles/resourcer/workspace/resourcer/shadow
```

Expect: a file `cv-<date>.jsonl` next to `screening-<date>.jsonl`. Then the report of the day:

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1 --mode shadow
```

Expect: a first line `CV screening report: N screened CVs, operating point tau 0.75` with N above 0, then the blocks WHO DECIDED, DECISIONS, UNSCREENED BY THE SHADOW STOP, SWITCH-ON CHECK, REASON CODES, BY SEARCHED ROLE. With N below about 20 the shares mean little; every `[NOT YET]` line in the SWITCH-ON CHECK is normal in the first days. In `WHO DECIDED`, `Jev-decided` should say `ok (99% or more)` and `fallback lane` should say `ok (1% or less)`. The block `UNSCREENED BY THE SHADOW STOP` says `none` or the share of queued CVs that a slow Jev left unscreened (`phase2.shadowMaxSeconds`): read every rate beside it. A report with N equal to 0 after a run that pushed candidates: report it (has `CV_SCREEN` been set to `off`? it should be unset). Every candidate of those runs must still have reached Zoho: the stage blocks nothing in shadow. The acceptance items are `docs/ACCEPTANCE.md` SR09 to SR15: day 1 SR10, SR12, SR14; day 3 SR11, SR12; day 7 SR11, SR12 and the recruiter panel of SR13. Only after the panel agrees may the owner decide to run `hermes -p resourcer config set CV_SCREEN on` (`docs/CV-SCREENING.md` section 10). You never set it.

### 9.2 The Reed failure rate

A Reed attempt that cannot fetch its first search page is now visible everywhere: the run's Reed status is `failed`, the dashboard shows "Reed failed" (after the restart), the 18:00 digest prints `Reed attempts that failed today: N` only when there were any, and the alert `reed-first-page-failed` is raised once per episode (WARN, CRITICAL after 5 failed attempts in a row). Each failed attempt logs one line, `REED_REQUEST_FORENSIC attempt=N/3 status=... code=... token=yes|no sinceNavMs=... navDuringRequest=yes|no ...`, in the newest `logs/phase1-console-*.log` (names and numbers only, no token). Read it with your file viewer, never with a shell pipe, and report the lines; change no setting. The acceptance item is `docs/ACCEPTANCE.md` RE08: over a day the failures should be under 2 percent of the Reed attempts (day 1, 3 and 7). You need no `grep` for the rate: the line `Reed attempts by run day` of the catch-up list in 9.3 prints the attempts and failures of each run day and their percentage. Above that: report the count and the forensic lines (`docs/OPERATIONS.md` 8.1 explains each field). The live root cause is still unverified (K-REED13); the retries are design defaults, not owner decisions.

### 9.3 The Reed catch-up (the owner decides how many a day)

Territories that lost their Reed half before this release (the twelve of 2026-09-30, and any processed while Reed was off) are not caught up by themselves. You may list them at any time; it is a dry run and changes nothing (counts and territory codes only):

```
node /opt/data/profiles/resourcer/workspace/tools/reed-catchup.js
```

To see what a number would queue, still writing nothing, and then to queue it, ONLY with the number the owner gave (replace `<N>` by it; the suggested start is 5 a day, and the tool never queues more than `--per-day` in a UTC day, default 10). Never copy these two lines with a number you chose yourself; the second one spends credits:

```
node /opt/data/profiles/resourcer/workspace/tools/reed-catchup.js --queue <N> --per-day 10 --dry-run
```

```
node /opt/data/profiles/resourcer/workspace/tools/reed-catchup.js --queue <N> --per-day 10
```

Each queued territory re-runs whole (its Caterer half is mostly skipped as already known, but it can unlock new candidates, which costs credits like any search) through the normal queue after every scheduled search. While Reed is switched off or held after a login problem the tool queues nothing and exits 3. A territory whose run CV screening merely held is left out (`held by CV screening` in its output). The owner raises the number once a day has passed cleanly.

### 9.4 What else you may see

- With `CV_SCREEN` unset, nothing of the hold machinery: no `phase2-held` exit, no halt from the CV stage. The new WARN alert `cv-config-invalid` appears only if `config/cv-screening.json` is broken or missing (nothing was screened for that queue, nothing was blocked; the owner restores the file from git, `docs/CV-SCREENING.md` section 5); `cv-shadow-stopped` also when a queue had been screened for 120 seconds (Jev slow).
- In `pipeline-watchdog.js --status`, `recentRuns` entries with exit code 14 and reason `phase2-held` only with `CV_SCREEN=on`: neither a success nor a failure. With `on` only, the halt reason `screening halt keeps returning` (CRITICAL `pipeline-halt` alert) needs a human (`docs/OPERATIONS.md` section 6, K-CV15).
- The screening report (`tools/screening-report.js`, ACCEPTANCE SR08) no longer counts the canary rows of run id `install-canary`: its numbers may drop by the rows of earlier canaries, which is the point.

For the owner: `CV_SCREEN=on` is still your decision, after the shadow acceptance and the recruiter audit (`docs/CV-SCREENING.md` section 10.3, `docs/ACCEPTANCE.md` SR13 and DC9). The technical blockers are removed (K-CV8 and K-CV9), the live check of the CV canary is still open until step 7.6 or the first `on` day (K-CV7). You never set it from here.

## Rolling back

Keep both jobs paused while you roll back and tell the owner why. If the owner wants the Update A code back:

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-queue-due
```

HUMAN-APPROVE (`<OLD_COMMIT>` is the id written down in step 2, it starts `d60d917`):

```
git -C /opt/data/profiles/resourcer/workspace reset --hard <OLD_COMMIT>
```

Put the old profile and plugin copies back from the old checkout (the plugin only if step 5 copied it):

```
cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back. The owner presses Restart for the dashboard in the Portal when convenient to unload the new backend (the old page script with the new backend, or the new page script with the old backend, both work: step 5). Then resume the jobs you noted in step 1 (step 8) and, if the owner wants proof of the old code, run the canaries of `docs/UPDATE-JEV-ONLY.md` step 9.

What stays behind is harmless: the files `state/cv-answers.jsonl`, `state/cv-search-levels.json`, `runtime/cv-invalid-streak.json`, `runtime/reed-first-page-streak.json`, `runtime/reed-catchup.json` and `shadow/cv-*.jsonl` (numbers and pseudonymous candidate ids); the empty column `territory_searches.reed_pending_since` (the old code names the columns it reads and writes); any `pending-searches/zz-reed-catchup-*.json` the owner queued before the rollback (they are ordinary searches, the old code runs them as such); and the criteria files of `resourcer/config/` come back to their old content with the `reset`.
