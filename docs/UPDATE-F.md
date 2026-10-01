# UPDATE F: the role scope for people whose role was never recorded, for an instance at the release `bc3e750`

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note takes an installed instance from the release of commit `bc3e750` (the role-scoped second look, `docs/UPDATE-E.md`) to this one in ONE cycle: one pause, one pull, one set of checks, one resume. It changes the pipeline's core filter for two groups of people and nothing else, so read "What changes and why" first. A fresh install follows `docs/INSTALL.md` and needs none of this. An instance that is not yet at `bc3e750` does `docs/UPDATE-E.md` (and the notes before it) first.

## What changes and why

One change, described in full in `docs/ROLESCOPE.md` (the owner-facing explanation, with the table of what was agreed and where it is proven):

- **A rejection applies to the role that was searched, and to nothing else, for Reed and for the people the old system left behind.** The owner said on 2026-10-01: "Reed/Caterer rejections where we have seen their CV but only used the keyword search should follow the same footpath of proper screening even if it means further unlocks, and these should not be blocked for all roles but only for those that we searched for." Until now a Reed person rejected at the snippet stage was skipped for EVERY job title for ever, and so was every Caterer person unlocked and never pushed (the old system recorded no role for them, or only a rejection for the one title that was searched). Now: a new Reed rejection (and approval) is recorded per job title, the same profile under another title is screened as normal and under the same title is skipped; a person whose role was never recorded (including a Caterer person whose only record is a rejection for ANOTHER title) is screened ONCE for the title of the search they next come up in, once they are older than the minimum age (14 days), and the outcome is recorded for that title, so the same role is never screened or paid for again (`docs/DECISIONS.md` RL-1 to RL-5).
- **It works with `CV_SCREEN` in any mode** (`shadow`, `off` or `on`). It does not change `CV_SCREEN`: the report of step 7.2 shows which mode you are in.
- **It may cost a further Caterer credit or Reed profile view, and that is counted and capped, not blocked.** A Caterer look is an unlock: it is counted, shown (results of the run, `node scripts/cv-report.js`, the 18:00 digest) and capped with the cap and the reserve of the second look (`CV_RESURFACE_MAX_PER_DAY` 40, `CV_RESURFACE_MIN_CREDITS` 1000: design defaults, not yet confirmed by the owner). A Reed look is a profile view only if the person is approved, bounded by the daily profile views and the run limit. Whether the platforms really charge is not known until the first live day (`docs/KNOWN-LIMITS.md` K-RL1; step 9 says what to read).
- **Expect more screening in the Reed half.** The old Reed rows are screened when a search meets them instead of being skipped, so a Reed run makes more screening calls and takes longer until they have all been met (`docs/KNOWN-LIMITS.md` K-RL4). That is the change working. One run lets at most 100 such people through (`ROLE_SCOPE_REED_MAX_PER_RUN`, a design default), and a run that is still going at minute 56 of its tick is ended cleanly by the `tick-hard-cap` alert: one alone is harmless, a repeating one is reported (step 9).

Nothing here changes a screening decision, a criterion, the operating point, the meaning of `CV_SCREEN` or the Zoho push. There is no database migration (the new records are ordinary rows of the existing table `candidate_rejections`, origins `reed:snippet` and `reed:approved`) and no new dependency. The release changes no cron wrapper and no dashboard file; it changes TWO profile files, `AGENTS.md` and the `resourcer-ops` skill (they tell the operator about the new settings, which only the owner changes), which step 5 copies.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 5), then the checks (step 7), then resume. There is no setting to change in this update: never set `ROLE_SCOPE_LEGACY`, `ROLE_SCOPE_MIN_AGE_DAYS`, `ROLE_SCOPE_REED_MAX_PER_RUN`, `CV_RESURFACE`, `CV_RESURFACE_MAX_PER_DAY`, `CV_RESURFACE_MIN_CREDITS`, `CV_SCREEN`, `RESOURCER_SOURCES` or any `SCREEN_*` setting in this update. The defaults are the point: the role scope is on, with a minimum age of 14 days for a Caterer person whose role was never recorded, capped at 40 a day with a reserve of 1000 credits, and at most 100 Reed people of unrecorded role per run. Switching `CV_SCREEN` on is the owner's separate order of 2026-10-01 and is step 10, run by the owner and never by you.
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` in this note does too.
6. Nothing here uses a real candidate: the commands that touch the database (7.3 and 7.4) ask about a number that is not a candidate and cannot write anything.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed this release to the code repository, to the branch this instance tracks (step 3 is a fast-forward of that branch), and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of this release. The owner gets it from the person who finalised the release: it is the `manifest_sha256=` value that `node tools/make-manifest.js` prints on the owner's machine after the last commit. The `MANIFEST.sha256` file of the checkout is not a substitute for it, on purpose: a manifest regenerated with a tampered script would otherwise pass, so you take `<NEW_DIGEST>` from the owner's message and never from the checkout you are verifying;
- for the owner to compare: the digest of the release you update FROM (commit `bc3e750`) is `8d33312998b1c90becf4779898517e69d9eeb8a9d2d0bef16599b3533c99b4ab`; the owner confirms the digest of THIS release on the owner's own machine (`node tools/make-manifest.js --dry-run` on the pushed commit prints the `manifest_sha256=`) before sending `<NEW_DIGEST>` to the operator; the operator never takes it from this note. The value the finaliser printed for this release on 2026-10-01 is `ebf6a4b9382238795044b52823ae233c69b23058d6db35bc6638a0c2fd669114`; it is written here only for the owner to compare with that printout, and it is not a source for the operator;
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

Expect: `busy` is false. If it is true, a run is in flight: wait a few minutes and run the status command again (do not loop). A run lasts at most about an hour: if `busy` is still true after an hour, STOP, leave both jobs paused, tell the owner and wait for the word. A `halt` that is not null is a screening outage that started before the update: note the reason and go on; do not clear it.

## 2. Record the way back (OPERATOR)

```
git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD
```

Expect: 40 hex characters that START with `bc3e750`. Write them down as `<OLD_COMMIT>`. Any other value: STOP and report it (the instance is not at the release this note starts from).

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=` followed by `8d33312998b1c90becf4779898517e69d9eeb8a9d2d0bef16599b3533c99b4ab`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`, or another digest: STOP (the instance was modified, or is not at `bc3e750`; do not update over it).

## 3. Pull this release (OPERATOR)

It runs in the workspace directory (`docs/INSTALL.md` 2.6):

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating bc3e750..<new id>`, `Fast-forward`, and a file list that includes `resourcer/scripts/lib/resurface.js`, `resourcer/scripts/reed-phase1.js`, `resourcer/candidates-db.js` and `docs/ROLESCOPE.md`. `Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes exactly two: `hermes/AGENTS.md` (the alert table says the cap alert also covers people whose role was never recorded; the list of settings only the owner changes names `ROLE_SCOPE_LEGACY` and `ROLE_SCOPE_MIN_AGE_DAYS` and says the role scope works in every `CV_SCREEN` mode) and the `resourcer-ops` skill (what to read and report about the role scope). The cron wrappers, `SOUL.md`, `hermes/cron/jobs.json` and the dashboard plugin are unchanged: do not touch them, and nothing needs a dashboard restart.

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

Expect: `MANIFEST_OK` and no `INSTALLED_CHANGED` line (an `INSTALLED_MISSING` line for the plugin is only a warning and is expected when the plugin was never installed). An `INSTALLED_CHANGED` line that names a wrapper, `SOUL.md` or a plugin file: STOP and report it (this release does not change them).

## 6. Nothing else to install, nothing to set (OPERATOR)

`resourcer/package.json`, the cron wrappers and `hermes/cron/jobs.json` are unchanged: no `npm install`, no job edit, no wrapper copy. There is no setting to change, because the default is the intended state: `ROLE_SCOPE_LEGACY` is on, `ROLE_SCOPE_MIN_AGE_DAYS` is 14, `ROLE_SCOPE_REED_MAX_PER_RUN` is 100, the cap is 40 a day, the reserve is 1000 credits. No restart of anything is needed (the operator reads `AGENTS.md` and the skill afresh at its next session): every Phase 1 and Phase 2 process reads the code and the settings when it starts. There is no database migration: the new records are ordinary rows of the existing table `candidate_rejections` (origins `reed:snippet`, `reed:approved`, and the existing `resurface:started`, `resurface:pushed`, `resurface:snippet`), and the day counters in `runtime/cv-resurface.json` get a few more keys (numbers only; an older file reads as zeros).

## 7. Checks: all without network (OPERATOR)

Send each command once and wait for its answer. No canary that calls Jev is needed: this update changes no screening decision.

### 7.1 The CV readers

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cv-review.js --self-test
```

Expect: exit 0 and exactly one line, `CV_SELF_TEST_OK pdf docx`. A line that starts `CV_SELF_TEST_FAILED` names the file type and a fixed reason code: STOP and report the line.

### 7.2 The report loads the new code

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1
```

Expect: exit 0 and, among the blocks, one that starts `RESURFACED (unlocked earlier, rejected for another role, screened again for this one;` and names `cap 40 a day, reserve 1000 credits; role scope for people whose role was never recorded` followed by `ROLE_SCOPE_LEGACY on, minimum age 14 days`. Right after the update its body says `none in this period`. A line that starts `WARNING:` names a setting that is not understood: report it (do not change it). Anything else (an error, no such block, `ROLE_SCOPE_LEGACY off`): STOP and report the text.

### 7.3 The claim command is installed and guarded

This asks the claim command about a number that is not a candidate, so nothing can be written:

```
node /opt/data/profiles/resourcer/workspace/resourcer/candidates-db.js resurface-claim caterer 999999999999 Canary
```

Expect: exit 0 and one JSON line, `{"claimed":false,"why":"not-eligible"}` (the role scope is active and that number is not a candidate) or `{"claimed":false,"why":"disabled"}` (the owner switched the role scope off and `CV_SCREEN` is not `on`). A line with `"claimed":true`, or any error text: STOP and report it.

### 7.4 The dedupe command answers as before for a number that is not a candidate

```
node /opt/data/profiles/resourcer/workspace/resourcer/candidates-db.js check-batch-scoped 999999999999 Canary
```

Expect: exit 0 and exactly `{"inDb":[]}`. Anything else: STOP and report it.

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

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the self-test line, the RESURFACED header of 7.2 (and the `CV_SCREEN` mode it shows) and the answers of 7.3 and 7.4.

Idempotent: yes. Repeating step 3 after it has passed answers `Already up to date`: on a repeat that is the expected answer, not the STOP of a first run. Repeating steps 4 to 7 changes nothing.

## 9. Watching the first days (OPERATOR, then OWNER)

You only read and report; the owner decides. Never change a setting.

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1
```

Read the block RESURFACED and its line `role scope: one more look`: how many people whose role was never recorded were given their one more look (Caterer, Reed), how many were rejected again and how many pushed to Zoho, how many were `charged`, and the Caterer credits and Reed profile views spent. The same appears as a sentence of the 18:00 digest (`Role scope (role never recorded, one more look): ...`, on the "Resurfaced today" line):

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/alerts-deliver.js --dry-run --digest
```

THE FIRST LIVE SIGNAL (`docs/KNOWN-LIMITS.md` K-RL1): the first day a legacy person is looked at, the report tells whether Caterer charged a second credit and Reed a view. Report the numbers to the owner on that day: `charged` against `not charged`, the credits and views spent, and the day's Caterer credits in the digest. Also report: how many looks the Reed half gave per run (the Reed Phase 1 log lines `ROLE SCOPE (seen before, ...)`), whether a Reed run ended with `REED_DAILY_LIMIT` (the daily views were used up), whether the alert `tick-hard-cap` repeats (a Reed run that is still going at minute 56 of its tick: one alone is harmless, a repeating one means the sweep of old Reed rows makes the Reed half too long: report it, the owner may lower `ROLE_SCOPE_REED_MAX_PER_RUN`), and whether the WARN alert `cv-resurface-cap-reached` appeared (the cap of 40 a day or the reserve of 1000 credits held a Caterer look back: nothing was lost or recorded against that person, they are looked at again the next day). Whether the cap, the reserve or the role scope should change is the owner's decision: `/opt/hermes/bin/hermes -p resourcer config set ROLE_SCOPE_LEGACY off` brings the old skip back for the people whose role was never recorded from the next run (the owner runs it, or tells you to); the per-title record of new Reed rejections stays.

## 10. CV screening on: the owner's order of 2026-10-01 (HUMAN, never the operator)

The owner ordered: "Switch CV screening on straight away". It is a setting of the live profile, not a file of this release, so this update does not change it and the operator must not (`CV_SCREEN` is on the owner-only list of `AGENTS.md`). The release ships it in `shadow`, and `docs/DECISIONS.md` OD-L ties `on` to the shadow acceptance of `docs/CV-SCREENING.md` 10.3 (numbers and a recruiter panel). The owner's order replaces that wait: the owner decides it knowing that, with `on`, a CV the stage rejects is rejected for good for that job title (and screened again for another title by the role-scoped second look), and that the `SWITCH-ON CHECK` block of `cv-report.js` may still say `NOT YET`. It is done AFTER step 8 has passed, so that a problem can be told from the update:

1. The owner runs `/opt/hermes/bin/hermes -p resourcer config set CV_SCREEN on` (or tells the operator, in so many words, to run exactly that). No restart is needed: every Phase 2 run reads it.
2. The operator then runs `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-review.js --self-test` (expect `CV_SELF_TEST_OK pdf docx`) and, the same day, `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1 --mode on`, and reports the `CV_SCREEN` mode, the reject rate and any alert whose key starts `cv-`.
3. Going back is `config set CV_SCREEN shadow` (stop rejecting, keep the evidence) or `off`, also the owner's.

With `on`, the second look at people rejected after an unlock (`CV_RESURFACE`) starts to apply to CV rejections as well, together with the role scope, in ONE list with ONE claim (scenario 20 of `tests/e2e-linux.sh` runs the role scope with `CV_SCREEN=on`).

## Rolling back

Keep both jobs paused while you roll back and tell the owner why. If the owner wants the previous code back:

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

No profile file was copied by this update, so none is put back:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back. Then resume the jobs you noted in step 1 (step 8).

What stays behind is harmless: the day counters of `runtime/cv-resurface.json` (numbers only; the previous code reads the keys it knows and ignores the rest), and rows of `candidate_rejections` whose origin is `reed:snippet`, `reed:approved` (a `reed_id` row: the previous code never reads one, so every seen Reed row blocks every title again, as before) or `resurface:*` (read as ordinary rejections of that title). A credit or a profile view spent on a person whose role was never recorded stays spent: the person is in Zoho if the push succeeded.
