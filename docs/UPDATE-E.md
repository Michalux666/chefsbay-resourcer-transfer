# UPDATE E: the role-scoped second look at people rejected after an unlock, for an instance at the previous release

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note takes an installed instance from the previous release (the commit the owner names, which you record as `<OLD_COMMIT>` in step 2) to this one in ONE cycle: one pause, one pull, one set of checks, one resume. It changes the pipeline's core filter for ONE case and nothing else, so read "What changes and why" first. A fresh install follows `docs/INSTALL.md` and needs none of this. An instance that has not yet had the release before this one does that note first (`docs/UPDATE-C.md`).

## What changes and why

One change, described in full in `docs/RESURFACE.md` (the owner-facing explanation, with the table of what was agreed and where it is proven):

- **A person who was unlocked and then rejected by CV screening for one role is screened again when they come up under a different role.** Until now every unlocked person was skipped for every role (`docs/DECISIONS.md` CVS-8), so someone over-qualified or in the wrong specialty for one search was lost for all of them. The owner decided on 2026-10-01 (`docs/DECISIONS.md` RS-1 to RS-4): the rejection is role-scoped like the snippet rejection; a second Caterer credit (or Reed profile view) for the re-download is accepted; the feature is on by default; a role is never charged twice. For the SAME role the rejection stays final, a person who was pushed to Zoho is never looked at again, nobody is ever pushed twice, and no CV or contact detail of a rejected person is kept.
- **It works only while `CV_SCREEN` is `on`.** Only then do CV rejections exist. `CV_SCREEN` is `shadow` unless the owner switched it, and in `shadow` or `off` this update changes nothing at all (the behaviour is the same as before, and the tests compare it). If the owner HAS switched `CV_SCREEN` to `on`, the second look is live from the first run after the resume (step 6 tells you how to see which case you are in).
- **It may cost a second credit, and that is counted and capped, not blocked.** Every re-download is counted (what it cost, charged or not, in credits and Reed profile views), shown in the results of the run, in `node scripts/cv-report.js` (block RESURFACED), in one line of the 18:00 digest, and capped: at most 40 people a London day and no re-download while the Caterer balance is below 1000 credits (`CV_RESURFACE_MAX_PER_DAY`, `CV_RESURFACE_MIN_CREDITS`: design defaults, not yet confirmed by the owner). One new WARN alert, `cv-resurface-cap-reached`, once a day, says when the cap or the reserve held someone back. Whether the platforms really charge for a second look is not known until the first live day (`docs/KNOWN-LIMITS.md` K-RS1; step 9 says what to read).

Nothing here changes a screening decision, a criterion, the operating point, the meaning of `CV_SCREEN` or the Zoho push. There is no database migration (the record is an ordinary row of the existing table `candidate_rejections`) and no new dependency.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 5), then the checks (step 7), then resume. There is no setting to change: never set `CV_RESURFACE`, `CV_RESURFACE_MAX_PER_DAY`, `CV_RESURFACE_MIN_CREDITS`, `CV_SCREEN`, `RESOURCER_SOURCES` or any `SCREEN_*` setting in this update. The defaults are the point: the feature is on, capped at 40 a day, with a reserve of 1000 credits, and does nothing unless `CV_SCREEN` is `on`.
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` in this note does too.
6. Nothing here uses a real candidate: the one command that touches the database (7.3) asks about a number that is not a candidate and cannot write anything.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed this release to the code repository, to the branch this instance tracks (step 3 is a fast-forward of that branch), and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of this release. The owner gets it from the person who finalised the release: it is the `manifest_sha256=` value that `node tools/make-manifest.js` prints on the owner's machine after the last commit. The `MANIFEST.sha256` file of the checkout is not a substitute for it, on purpose: a manifest regenerated with a tampered script would otherwise pass, so you take `<NEW_DIGEST>` from the owner's message and never from the checkout you are verifying;
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

Expect: 40 hex characters. Write them down as `<OLD_COMMIT>`. If the owner named the commit of the previous release, it must start with those characters; any other value: STOP and report it.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=<64 hex characters>`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`: STOP (the instance was modified; do not update over it).

## 3. Pull this release (OPERATOR)

It runs in the workspace directory (`docs/INSTALL.md` 2.6):

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating <OLD_COMMIT start>..<new id>`, `Fast-forward`, and a file list that includes `resourcer/scripts/lib/resurface.js`, `resourcer/scripts/phase1/resurface.js`, `resourcer/candidates-db.js` and `docs/RESURFACE.md`. `Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes exactly two: `hermes/AGENTS.md` (the alert table has the new key `cv-resurface-cap-reached`; the list of settings only the owner changes names the three new ones) and the `resourcer-ops` skill (what to read and report about the second look). The cron wrappers, `SOUL.md`, `hermes/cron/jobs.json` and the dashboard plugin are unchanged: do not touch them, and nothing needs a dashboard restart.

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

`resourcer/package.json`, the cron wrappers and `hermes/cron/jobs.json` are unchanged: no `npm install`, no job edit, no wrapper copy. There is no setting to change, because the default is the intended state: `CV_RESURFACE` is on, the cap is 40 a day, the reserve is 1000 credits. No restart of anything is needed: every Phase 1 and Phase 2 process reads the code and the settings when it starts. There is no database migration: the second look writes ordinary rows of the existing table `candidate_rejections` (origin `resurface:started`, `resurface:pushed`, `resurface:snippet`) and keeps its day counters in the new small file `runtime/cv-resurface.json` (created on first use, mode 0600).

Which case you are in is shown by the check of step 7.2: its RESURFACED block says whether `CV_SCREEN` is `on` (the second look is active) or not (it does nothing). You never set `CV_SCREEN`.

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

Expect: exit 0 and, among the blocks, one that starts `RESURFACED (unlocked earlier, rejected for another role, screened again for this one;` and names `CV_RESURFACE on, CV_SCREEN` followed by the mode and `cap 40 a day, reserve 1000 credits`. Right after the update its body says `none in this period`. If `CV_SCREEN` shows `shadow` or `off`, the second look is not active: that is the normal case until the owner switches the CV stage on. Anything else (an error, no such block): STOP and report the text.

### 7.3 The database command is installed and guarded

This asks the claim command about a number that is not a candidate, so nothing can be written:

```
node /opt/data/profiles/resourcer/workspace/resourcer/candidates-db.js resurface-claim caterer 999999999999 Canary
```

Expect: exit 0 and one JSON line, `{"claimed":false,"why":"disabled"}` (the second look is not active: `CV_SCREEN` is not `on`, or the owner turned it off) or `{"claimed":false,"why":"not-eligible"}` (it is active and that number is not a candidate). A line with `"claimed":true`, or any error text: STOP and report it.

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

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the self-test line, the RESURFACED line of 7.2 (and whether the second look is active) and the answer of 7.3.

Idempotent: yes. Repeating step 3 after it has passed answers `Already up to date`: on a repeat that is the expected answer, not the STOP of a first run. Repeating steps 4 to 7 changes nothing.

## 9. Watching the first days (OPERATOR, then OWNER)

Only meaningful when `CV_SCREEN` is `on`. You only read and report; the owner decides. Never change a setting.

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1
```

Read the block RESURFACED: how many people were looked at again, how many were `charged`, `not charged` or `charge unknown`, the Caterer credits and Reed profile views spent, how many were pushed and how many rejected again, and how many were held back by the cap or the reserve. The same appears as one line in the 18:00 digest:

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/alerts-deliver.js --dry-run --digest
```

THE FIRST LIVE SIGNAL (`docs/KNOWN-LIMITS.md` K-RS1): the first day a person is looked at again, the report tells whether Caterer and Reed charged a second credit or view. Report the numbers to the owner on that day: `charged` against `not charged`, the credits and views spent, and the day's Caterer credits in the digest. If `charge unknown` is high, the balance could not be read: report it. If the WARN alert `cv-resurface-cap-reached` appears, the cap (40 a day) or the reserve (1000 credits) held someone back: report the day's numbers; nothing was lost or recorded against them, they are looked at again the next day. Whether the cap or the reserve should change, or the feature should be switched off, is the owner's decision: `/opt/hermes/bin/hermes -p resourcer config set CV_RESURFACE off` brings the old rule back exactly from the next run (the owner runs it, or tells you to).

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

Put the old profile copies back from the old checkout:

```
cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/
```

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back. Then resume the jobs you noted in step 1 (step 8).

What stays behind is harmless: the file `runtime/cv-resurface.json` (day counters, numbers only), and rows of `candidate_rejections` whose origin starts `resurface:` (the old code reads them as ordinary rejections for that job title, which is what they are; it skips every unlocked person for every role again, as before).
