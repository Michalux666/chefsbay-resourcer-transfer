# UPDATE B: forced-choice screening criteria and CV screening (shadow) for an installed instance

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note is only for an instance whose code is at commit `d60d917` (Update A: Jev-only screening, the privacy fix, the tick drain, the dashboard labels; `docs/UPDATE-JEV-ONLY.md`). An instance still on the first release (commit `016b444`) does that update first. A fresh install follows `docs/INSTALL.md` and needs none of this.

## What changes and why

Two changes, both Jev only (the AI Gateway carries no other model), both described for the owner in their own pages:

- **Snippet screening decides by forced choice from an editable criteria file** (`docs/SCREENING-CRITERIA.md`, `docs/DECISIONS.md` SCR-29 to SCR-33). Jev answers small questions about each card and, once per search title, what level of role that title is; code turns the answers into approve or reject with one operating point. Jev decides at least 99 percent of the cards; the review policy now settles only the rare fallback card (both injection filters flagged it, or it is empty, or after the unlock an unusable answer). No job title is named in code any more (the tier-0 ladder is gone). Each search title costs one extra small request per process. A profile settings file written by Update A still loads: at most one `WARN screening config:` line names keys that are not read any more.
- **A CV screening stage runs after the unlock and the CV download, before the Zoho push** (`docs/CV-SCREENING.md`, `docs/DECISIONS.md` CVS-1 to CVS-10). It reads the whole CV, removes everything personal, asks Jev how the work history fits the searched role and decides pass or reject. It starts in **shadow** mode: it records what it would have done and blocks nothing, so every candidate goes to Zoho exactly as before. Switching it to `on` (which stops rejected candidates reaching Zoho) is the owner's decision after a week of shadow data and a recruiter audit (`docs/ACCEPTANCE.md` SR13). This update sets nothing: an unset `CV_SCREEN` is `shadow`.

Also in this release, with nothing for you to do: eight new alert keys (`cv-*`, `hermes/AGENTS.md`, `docs/OPERATIONS.md` section 11), a report `scripts/cv-report.js`, and the tools `tools/gold-rows.js` and `tools/screening-operating-point.js`.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 5), then the canaries (step 7), then resume. There is no setting to change: never set `CV_SCREEN`, `CV_REJECT_ABOVE`, `CV_FALLBACK_POLICY` or any `SCREEN_*` setting in this update, and never edit `config/screening-criteria.json` or `config/cv-screening.json` (they are the owner's). A tracked config file that the owner edits in place makes the next `git pull --ff-only` stop with "local changes", and `git reset --hard` would discard the edit: keep edited copies under the profile and point `SCREEN_CRITERIA_FILE` / `CV_SCREEN_CONFIG_FILE` at them instead.
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

Expect: 40 hex characters that start with `d60d917`. Write it down as `<OLD_COMMIT>`. A value that starts with `016b444` means the instance is still on the first release: STOP and tell the owner (`docs/UPDATE-JEV-ONLY.md` comes first). Any other value: STOP and report it.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=<64 hex>`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`: STOP (the instance was modified; do not update over it).

## 3. Pull the release (OPERATOR)

This is the update command of `docs/INSTALL.md` 2.6; the deploy key is remembered in the repository, and it works on the shallow clone. It runs in the workspace directory:

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating d60d917..<new id>`, `Fast-forward`, and a long file list that includes `resourcer/scripts/cv-review.js`, `resourcer/config/screening-criteria.json`, `resourcer/config/cv-screening.json` and `docs/UPDATE-B.md`.
`Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes only `hermes/AGENTS.md` (the alert table, the owner-only list) and the `resourcer-ops` skill. The cron wrappers, `SOUL.md` and the dashboard plugin are unchanged: do not touch them.

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

`resourcer/package.json`, the database schema, the cron wrappers, `hermes/cron/jobs.json` and the dashboard plugin are unchanged: no `npm install`, no migration, no job edit, no plugin copy, no dashboard restart. There is no setting to change. The CV stage is in shadow because `CV_SCREEN` is unset (the default); the criteria files came with the pull. No restart is needed: every screening and Phase 2 process reads the code and the settings when it starts.

## 7. Canaries: real calls with invented text (OPERATOR)

Three checks, about a fraction of a cent each. Send each command once and wait for its answer; never repeat them in a loop.

### 7.1 Snippet screening, before the unlock (batch)

One suitable and one unsuitable invented candidate (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode batch --job Chef --location M1 --distance 20 --source caterer --run-id install-canary --with-codes --candidates '[{"id":"canary-yes","snippet":"Chef de Partie | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Chef de Partie Jan 2019 - Current Test Bistro Ltd Key Responsibilities Running the sauce section, daily prep, ordering, food safety"},{"id":"canary-no","snippet":"Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"}]'
```

Expect: exit 0; standard output is one line, a JSON array with `"id":"canary-yes"` having `"approved":true` and `"id":"canary-no"` having `"approved":false`, each with a `reason` and a `reasonCode` (`approve_...` and `reject_unrelated_industry` are typical); standard error contains `SCREENING_MODEL: typesafe-ai/jev` and, once, a `WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds` line (expected until the owner has calibrated the operating point on recruiter labels) and NO line that begins `WARN screening config:` (such a line names a setting that is still wrong: STOP and report it).

### 7.2 Snippet screening, after the unlock (single)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode single --job Chef --title "Retail Cashier" --source caterer --run-id install-canary --with-codes --snippet "Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"
```

Expect: exit 0; one line `{"approved":false,"reason":"...","reasonCode":"reject_..."}`. A `"approved":true` with `"reasonCode":"sys_review_policy_approve"` means the review policy decided (both injection filters flagged the invented card, or Jev's answer stayed unusable): not expected, so record it and tell the owner.

### 7.3 CV screening (two invented CVs)

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

Expect: exit 0; standard output is one JSON line that begins `{"decision":"pass","final":"approve","lane":"jev"` (it holds numbers and reason codes only, no text); standard error ends with `SCREENING_MODEL: typesafe-ai/jev`. `--no-shadow` keeps the invented CV out of the shadow log, so it cannot disturb the numbers the owner reads later. Then the retail assistant (`timeout=300`):

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

If any canary fails:

| Symptom | Meaning | Action |
|---|---|---|
| exit 3, output begins `API_UNAVAILABLE:` | Jev could not be reached, or the gateway refused the key or the model | report the text after the colon (`restricted access to this model` means the owner must allow `typesafe-ai/jev` on the Vercel team); do not repeat more than once; the pipeline halts by itself until Jev answers, do not clear the halt |
| exit 3 and the text contains `screening-criteria.json` | the criteria file on the instance is missing or invalid | STOP, edit nothing, report the text (the file came with the pull: `MANIFEST_OK` should have caught a changed copy) |
| the chef CV is `"decision":"reject"`, or any canary is `"lane":"fallback"` or `"decision":"unreadable"` | the stage read or judged an obvious CV wrongly | STOP and report the JSON line (numbers and codes only) |
| the retail assistant is `"decision":"pass"` | Jev doubted an obvious mismatch (a forced pass) | STOP and report the JSON line |
| batch: `canary-yes` rejected, or `canary-no` approved | the criteria and Jev disagree with the recruiters on an obvious card | STOP and report both lines |
| batch: a canary card has `reasonCode` `sys_invalid_result` | Jev's answer for that card was unusable twice; the card is left undecided, not rejected | repeat the batch call once; if it comes back again STOP and report both lines |
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

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes once the tick has run the deep check: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>` and the four canary results (batch, single, chef CV, retail CV).

Idempotent: yes. Repeating steps 3 to 7 changes nothing once they have passed.

## 9. Watching the first CV shadow decisions (OPERATOR, then OWNER)

Phase 2 runs the CV stage for every run that approved candidates, so the first shadow rows appear after the first such run (runs start only between 06:00 and 22:00 London). Nothing here is urgent and nothing here changes anything. After the first run that pushed candidates:

```
ls /opt/data/profiles/resourcer/workspace/resourcer/shadow
```

Expect: a file `cv-<date>.jsonl` next to `screening-<date>.jsonl`. Then the report of the day:

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1 --mode shadow
```

Expect: a first line `CV screening report: N screened CVs, operating point tau 0.75` with N above 0, then the blocks WHO DECIDED, DECISIONS, SWITCH-ON CHECK, REASON CODES, BY SEARCHED ROLE. With N below about 20 the shares mean little; every `[NOT YET]` line in the SWITCH-ON CHECK is normal in the first days. In `WHO DECIDED`, `Jev-decided` should say `ok (99% or more)` and `fallback lane` should say `ok (1% or less)`. A report with N equal to 0 after a run that pushed candidates: report it (has `CV_SCREEN` been set to `off`? it should be unset). Every candidate of those runs must still have reached Zoho: the stage blocks nothing in shadow.

Tell the owner:

- The stage is in shadow. The acceptance items are `docs/ACCEPTANCE.md` SR09 to SR14 (canaries, first rows, the shares, alerts, the recruiter audit of every would-be reject, the privacy check of the CV log). Day 1: SR10, SR12, SR14. Day 3: SR11, SR12. Day 7: SR11, SR12 and the recruiter panel of SR13.
- The weekly report for the owner: `node scripts/cv-report.js --days 7 --mode shadow --forced --rejects` (`docs/CV-SCREENING.md` section 10). Only after the panel agrees may the owner decide to run `hermes -p resourcer config set CV_SCREEN on`. You never set it.
- What a shadow alert means (`docs/OPERATIONS.md` section 11): `cv-shadow-stopped` (Jev hung or failing for 5 CVs in a row; nothing was blocked or lost), `cv-reject-rate-high`, `cv-fallback-rate-high`, `cv-forced-rate-high`, `cv-unreadable-rate-high`, `cv-review-errors`: report the text, change nothing.
- Snippet screening now has its own numbers to read: the share Jev decided itself (99 percent or more) and the forced share (`docs/ACCEPTANCE.md` SR08).

## Rolling back

Keep both jobs paused while you roll back and tell the owner why. If the owner wants the Update A code back:

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

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back, and the old code never reads `CV_SCREEN`. Then resume the two jobs (step 8) and run the two commands of `docs/UPDATE-JEV-ONLY.md` step 9 to prove the old screening again. What stays behind is harmless: the files `state/cv-answers.jsonl`, `state/cv-search-levels.json`, `runtime/cv-invalid-streak.json` and `shadow/cv-*.jsonl` (numbers and pseudonymous candidate ids, never read by the old code and no longer pruned by it: the owner may delete `shadow/cv-*.jsonl` with `rm`, HUMAN-APPROVE), and any candidate that CV screening rejected while the owner had it `on` (rows in `candidate_rejections` with an origin that starts `cv:`; there are none while it stayed in shadow).
