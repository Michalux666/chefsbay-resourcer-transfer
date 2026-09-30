# UPDATE C: CV_SCREEN=on made safe, a CV criteria file that fails closed, bounded shadow, an install self-test, for an installed instance

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note is only for an instance whose code is at commit `a7fc7be` (Update B: forced-choice snippet screening and the CV stage in shadow; `docs/UPDATE-B.md`). An instance still on an earlier release does `docs/UPDATE-JEV-ONLY.md` and then `docs/UPDATE-B.md` first. A fresh install follows `docs/INSTALL.md` and needs none of this.

## What changes and why

Update B shipped the CV stage in `shadow`, which blocks nothing. A live verification of it found faults that do not matter in shadow but that made `CV_SCREEN=on` unsafe to switch on. This update fixes them. It changes no number, no criterion, no operating point, and `CV_SCREEN` still defaults to `shadow` everywhere:

- **With `CV_SCREEN=on`, a failure of the CV route alone used to cycle** (hold, halt, the supervisor asks only the snippet route and clears the halt, a new run unlocks more candidates, hold again). Now the supervisor's deep check also sends one small invented request through the CV stage's own client (the CV canary) while the mode is `on`, so the halt clears only when the CV route itself answers; no Phase 1 unlock starts while the halt is up; a held run is recorded as exit 14 `phase2-held` (neither a success nor a failure); the recovery completes the held queue after the halt clears (a both-source queue on its merged queue; the halt is re-verified even when no search is waiting). A route that answers the small canary but fails on real CVs cannot cycle for ever: after two clears within 6 hours while a held queue waits, the supervisor stops clearing and raises the halt `screening halt keeps returning`, which needs a manual clear (K-CV15). Shadow is unaffected.
- **A broken or missing `config/cv-screening.json` fails closed**, like the snippet criteria: `cv-review.js` exits 3, mode `on` holds the queue under the halt reason `CV screening criteria invalid`, shadow stops the stage for the queue with one new WARN alert `cv-config-invalid`. A broken `config/screening-criteria.json` now has its own reason `screening criteria invalid` and remedy and is found by the supervisor's cheap check, before a browser run is started.
- **Shadow is bounded in time**: `phase2.shadowMaxSeconds` (default 120, editable in the owner's criteria file) stops the screening of a queue after that long, counted from the start of the queue's screening (a slow but answering Jev), with the existing `cv-shadow-stopped` warning. Note for the shadow week: a large queue or a slow Jev leaves the tail of that queue unscreened, so the shadow sample (and the SWITCH-ON CHECK of `cv-report.js`, which prints the screened count) favours small, fast queues; read the count of screened CVs, and the alerts `cv-shadow-stopped`, before trusting a rate (ACCEPTANCE SR13).
- **Install checks**: the flag `--self-test` of `cv-review.js` (no network) proves the PDF and Word readers load; `ai-review.js --no-shadow` keeps the snippet canaries out of the shadow log, and the readers now ignore rows whose run id starts with `install-canary` (also `install-canary-zdr`), so the canary rows an Update B instance already holds no longer count in the screening report.
- **Small fixes**: the rejection row records the first real reason code instead of the `forced` marker; the two CV counters of the results file reconcile after a hold and `run_results.skipped` carries the CV rejections; `cv-report.js` says `no data yet` instead of `ok` beside a zero share; concurrent reviewers no longer lose each other's entries in the search-level cache; the snippet redaction removes a leading name that starts with a particle, an initial, an honorific or a typographic apostrophe, and masks a long number behind a label.

Also in this release, with nothing for you to do: one new alert key (`cv-config-invalid`, `hermes/AGENTS.md`, `docs/OPERATIONS.md` section 11) and runner exit code 14 (`phase2-held`).

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 5), then the checks (step 7), then resume. There is no setting to change: never set `CV_SCREEN`, `CV_REJECT_ABOVE`, `CV_FALLBACK_POLICY` or any `SCREEN_*` setting in this update, and never edit `config/screening-criteria.json` or `config/cv-screening.json` (they are the owner's; a tracked file that the owner edits in place makes the next `git pull --ff-only` stop with "local changes", so keep edited copies under the profile and point `SCREEN_CRITERIA_FILE` / `CV_SCREEN_CONFIG_FILE` at them).
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` in this note does too.
6. The canary texts are invented. Never use a real candidate or a real CV in this update.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed the new release to the code repository and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of the release (`manifest_sha256=` printed by `node tools/make-manifest.js`, or in the release notes);
- the go-ahead to update now. Update after 22:00 London time, when no run is in flight (`docs/OPERATIONS.md` section 12).

OPERATOR: pause both jobs and wait until the pipeline is idle:

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `busy` is false. If it is true, a run is in flight: wait a few minutes and run the status command again (do not loop). A `halt` that is not null is a screening outage that started before the update: note the reason and go on; do not clear it.

## 2. Record the way back (OPERATOR)

```
git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD
```

Expect: 40 hex characters that start with `a7fc7be`. Write it down as `<OLD_COMMIT>`. A value that starts with `d60d917` means the instance is still on Update A: STOP and tell the owner (`docs/UPDATE-B.md` comes first). Any other value: STOP and report it.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=8d28dc66d5b449506e71a6a9908b4d45d84a00c99508a870539b091c06519ed5` (the digest of Update B). Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`, or a different digest: STOP (the instance was modified or is not at Update B; do not update over it).

## 3. Pull the release (OPERATOR)

This is the update command of `docs/INSTALL.md` 2.6; the deploy key is remembered in the repository, and it works on the shallow clone. It runs in the workspace directory:

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating a7fc7be..<new id>`, `Fast-forward`, and a long file list that includes `resourcer/scripts/lib/cv/canary.js`, `resourcer/scripts/lib/cv/selftest.js`, `resourcer/scripts/phase1/cv-hold.js` and `docs/UPDATE-C.md`.
`Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes only `hermes/AGENTS.md` (the alert table, the halts text) and the `resourcer-ops` skill (the runner exit codes). The cron wrappers, `SOUL.md` and the dashboard plugin are unchanged: do not touch them.

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

Expect: no output from either `cmp`. Then the full check, which also compares every installed copy:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and no `INSTALLED_CHANGED` line. An `INSTALLED_CHANGED` line that names a wrapper, `SOUL.md` or a plugin file: STOP and report it (this release does not change them).

## 6. Nothing else to install, nothing to set (OPERATOR)

`resourcer/package.json`, the database schema, the cron wrappers, `hermes/cron/jobs.json` and the dashboard plugin are unchanged: no `npm install`, no migration, no job edit, no plugin copy, no dashboard restart. There is no setting to change. The CV stage stays in shadow because `CV_SCREEN` is unset (the default). No restart is needed: every screening and Phase 2 process reads the code and the settings when it starts. Files already on the instance (`state/cv-answers.jsonl`, `state/cv-search-levels.json`, `shadow/cv-*.jsonl`) stay as they are; the search-level cache file keeps its format.

## 7. Checks: one without network, then canaries with invented text (OPERATOR)

Send each command once and wait for its answer; never repeat them in a loop.

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

Expect: exit 0; standard output is one line, a JSON array with `"id":"canary-yes"` having `"approved":true` and `"id":"canary-no"` having `"approved":false`, each with a `reason` and a `reasonCode`; standard error contains `SCREENING_MODEL: typesafe-ai/jev` and, once, a `WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds` line (expected until the owner has calibrated the operating point) and NO line that begins `WARN screening config:`. Exit 3 with `screening-criteria.json` in the output: the criteria file on the instance is missing or invalid; STOP, edit nothing, report the text.

### 7.3 Snippet screening, after the unlock (single)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode single --job Chef --title "Retail Cashier" --source caterer --run-id install-canary --with-codes --no-shadow --snippet "Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"
```

Expect: exit 0; one line `{"approved":false,"reason":"...","reasonCode":"reject_..."}`. A `"approved":true` with `"reasonCode":"sys_review_policy_approve"` means the review policy decided: not expected, so record it and tell the owner.

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

Expect: exit 0; standard output is one JSON line that begins `{"decision":"pass","final":"approve","lane":"jev"`; standard error ends with `SCREENING_MODEL: typesafe-ai/jev`. Exit 3 with `SCREENING_REASON: cvconfig` on standard error: `config/cv-screening.json` is broken or missing on this instance (the file ships in the repository; `MANIFEST_OK` should have caught a changed copy): STOP, edit nothing, report the text. Then the retail assistant (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv-no.txt --no-shadow
```

Expect: exit 0; one JSON line that begins `{"decision":"reject","final":"reject","lane":"jev"` with the reason code `no_relevant_experience` (usually with `career_change`); the same `SCREENING_MODEL` line. In shadow mode this blocks nothing. Then delete both files, one command each (`rm` may need approval, see rule 5):

```
rm /opt/data/profiles/resourcer/install-work/canary-cv.txt
```

```
rm /opt/data/profiles/resourcer/install-work/canary-cv-no.txt
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
| exit 1 with `FATAL` | usage or input problem (for example a file was not created) | report the text |

## 8. Resume (OPERATOR)

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes once the tick has run the deep check: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the self-test line and the four canary results (batch, single, chef CV, retail CV).

Idempotent: yes. Repeating steps 3 to 7 changes nothing once they have passed.

## 9. What changes in what you see (OPERATOR, then OWNER)

Nothing changes for a candidate: the stage is still in shadow. You will see:

- the new WARN alert `cv-config-invalid` only if `config/cv-screening.json` is broken or missing (shadow: the stage did not run for that queue, nothing was blocked): report the text; the owner restores the file from git (`docs/CV-SCREENING.md` section 5);
- `cv-shadow-stopped` now also when a queue had been screened for 120 seconds (Jev slow): nothing was blocked or lost;
- with `CV_SCREEN=on` only: the halt reason `screening halt keeps returning` (CRITICAL `pipeline-halt` alert): the CV route answers its small test request but fails on real CVs, twice in 6 hours. Nothing more is unlocked and the held queue is kept; HUMAN looks at the Phase 2 log and `node scripts/cv-report.js --days 1 --mode on`, fixes the cause and clears it with `node scripts/pipeline-halt-cli.js clear` (`docs/OPERATIONS.md` section 6, K-CV15). Never with shadow;
- in `pipeline-watchdog.js --status`, `recentRuns` entries with exit code 14 and reason `phase2-held` only with `CV_SCREEN=on`: the run was held by CV screening (neither a success nor a failure);
- the screening report (`tools/screening-report.js`, ACCEPTANCE SR08) no longer counts the canary rows of run id `install-canary`: its numbers may drop by the three rows of the earlier canaries, which is the point.

For the owner: `CV_SCREEN=on` is still your decision, after the shadow week and the recruiter audit (`docs/CV-SCREENING.md` section 10; `docs/ACCEPTANCE.md` SR13 and DC9). What this update removes is the technical blocker (known limits K-CV8 and K-CV9); the live check of the canary against the real gateway is still open (K-CV7). You never set it.

## Rolling back

Keep both jobs paused while you roll back and tell the owner why. If the owner wants the Update B code back:

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-queue-due
```

HUMAN-APPROVE (`<OLD_COMMIT>` is the id written down in step 2):

```
git -C /opt/data/profiles/resourcer/workspace reset --hard <OLD_COMMIT>
```

Put the two profile files back from the old checkout:

```
cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/
```

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back. Then resume the two jobs (step 8) and run the canaries of `docs/UPDATE-B.md` step 7 to prove the old code again. What stays behind is harmless: the files `state/cv-answers.jsonl`, `state/cv-search-levels.json`, `runtime/cv-invalid-streak.json` and `shadow/cv-*.jsonl` (numbers and pseudonymous candidate ids); a halt left by a held CV queue, if the owner had `CV_SCREEN=on`, is cleared by the old supervisor as it always was (its deep check asks only the snippet route, which is the cycle this update fixes: keep `CV_SCREEN` at `shadow` on the old code).
