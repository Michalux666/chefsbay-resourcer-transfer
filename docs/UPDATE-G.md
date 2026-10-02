# UPDATE G: the search window and the CV limit reach both sources, for an instance at the previous release

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note takes an installed instance from the previous release (the commit the owner names, which you record as `<OLD_COMMIT>` in step 2; the release that carried the role-scoped second look, `docs/UPDATE-E.md`, commit `bc3e750`) to this one in ONE cycle: one pause, one pull, one set of checks, one read-only probe, one resume. A fresh install follows `docs/INSTALL.md` and needs none of this. An instance that has not yet had the release before this one does that note first.

## What changes and why

The owner-facing explanation is `docs/ACTIVITY.md`; read it first if you have not. In short:

- **A search's "active within" window and CV limit now reach both sources.** On 2026-10-01 three one-off searches asked for 12 months and 30 CVs. The run recorded both, but Reed searched the last month with a limit of 20 (two literals in `run-pipeline.js`) and Caterer never saw the window (`build-caterer-results-url.js` has not emitted `LastActivityId` since 2026-06-02). Now Reed gets the window and the limit (the limit is still lowered to the Reed views left today), and Caterer gets the window as `LastActivityId` for a ONE-OFF request. A scheduled territory with the stored defaults (1 month, 20) behaves exactly as before: the same Caterer URL, the same Reed arguments.
- **Standing territories are not changed.** The setting `CATERER_ACTIVITY_FILTER` defaults to `manual` (one-off requests only; a design default, not yet confirmed by the owner). `all` would apply every territory's stored window and shrink every pool: that is the owner's business decision, taken after the probe of step 8. You never set it.
- **The run shows the filter that was really applied.** After the first results page, phase 1 reads the filter text Caterer says it applied (and the page's pool count) and writes one `ACTIVITY_FILTER` line; the status, the queue and the run results carry an `activity` block. A mismatch or an unreadable page raises one new WARN alert, `caterer-activity-mismatch`, at most once a day; the run is never stopped by it.
- **A read-only probe,** `tools/activity-probe.js`, prints what each Caterer window and each Reed window really returns (counts only). You run it once, in step 8, and the owner reads the numbers.
- **Two small corrections:** the CV stage alert `cv-reject-rate-high` now fires above 20 percent (it was 10; a design default, not yet confirmed by the owner), and the documents now say to read the Hermes cron history by job id (`cron runs` by name printed nothing on 2026-10-01).

Not changed: screening decisions, criteria, operating points, `CV_SCREEN`, the territory table, the schedule, the role-scoped second look. There is no database migration and no new dependency.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 5), then the checks (step 7), then the probe (step 8), then resume. There is no setting to change: never set `CATERER_ACTIVITY_FILTER`, `RESOURCER_SOURCES`, `CV_SCREEN` or any `SCREEN_*` setting in this update, and never edit `config/caterer-activity.json`.
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` in this note does too.
6. Nothing here uses a candidate. The probe and the checks only read; the probe loads search pages (and runs Reed searches) and prints counts.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed this release to the code repository, to the branch this instance tracks (step 3 is a fast-forward of that branch), and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of this release. The owner gets it from the person who finalised the release: it is the `manifest_sha256=` value that `node tools/make-manifest.js` prints on the owner's machine after the last commit. The `MANIFEST.sha256` file of the checkout is not a substitute for it, on purpose: a manifest regenerated with a tampered script would otherwise pass, so you take `<NEW_DIGEST>` from the owner's message and never from the checkout you are verifying. The owner confirms it on the owner's own machine (`node tools/make-manifest.js --dry-run` on the pushed commit prints the same `manifest_sha256=`) before sending it;
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

Expect: 40 hex characters. Write them down as `<OLD_COMMIT>`. If the owner named the commit of the previous release, it must start with those characters (the previous release starts with `bc3e750`); any other value: STOP and report it.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=<64 hex characters>`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`: STOP (the instance was modified; do not update over it).

## 3. Pull this release (OPERATOR)

It runs in the workspace directory (`docs/INSTALL.md` 2.6):

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating <OLD_COMMIT start>..<new id>`, `Fast-forward`, and a file list that includes `resourcer/scripts/lib/search-activity.js`, `resourcer/config/caterer-activity.json`, `tools/activity-probe.js` and `docs/ACTIVITY.md`. `Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes exactly two: `hermes/AGENTS.md` (the alert table has the new key `caterer-activity-mismatch`, the reject-rate alert says 20 percent, the owner-only list names `CATERER_ACTIVITY_FILTER` and `config/caterer-activity.json`) and the `resourcer-ops` skill (the search window, the read-only `--recent` command). The cron wrappers, `SOUL.md`, `hermes/cron/jobs.json` and the dashboard plugin are unchanged: do not touch them, and nothing needs a dashboard restart.

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

`resourcer/package.json`, the cron wrappers and `hermes/cron/jobs.json` are unchanged: no `npm install`, no job edit, no wrapper copy. The new table `resourcer/config/caterer-activity.json` is part of the checkout you just pulled: nothing to copy. There is no setting to change, because the default is the intended state: `CATERER_ACTIVITY_FILTER` is unset, which means `manual`. No restart of anything is needed: every phase 1 and `run-pipeline.js` process reads the code and the settings when it starts. There is no database migration: the window is recorded in the JSON files of a run (status, queue, results), and the once-a-day alert keeps one small file, `runtime/activity-alert.json` (a day marker, created on first use).

## 7. Checks: all without network (OPERATOR)

Send each command once and wait for its answer. These build a URL and read files; they do not open a browser.

### 7.1 A scheduled search builds the URL it always built

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/build-caterer-results-url.js --job "Chef" --location FY4 --distance 20 --search-id probe --active-within "1 month"
```

Expect: exit 0 and two lines: `RESULTS_URL:` ending `&HideCandidatesSinceDays=7&SearchId=probe&scr=1` (no `LastActivityId` anywhere), and `SEARCH_ID:probe`. A `LastActivityId` in this URL: STOP and report it (a scheduled search must not carry one under the default setting).

### 7.2 A one-off request carries its window

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/build-caterer-results-url.js --job "Chef" --location FY4 --distance 20 --search-id probe --active-within "12 months" --manual
```

Expect: exit 0 and a `RESULTS_URL:` ending `&HideCandidatesSinceDays=7&LastActivityId=15&SearchId=probe&scr=1`. Anything else: STOP and report the line.

### 7.3 A window with no known Caterer id sends nothing and says so

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/build-caterer-results-url.js --job "Chef" --location FY4 --distance 20 --search-id probe --active-within "3 months" --manual
```

Expect: exit 0, a `RESULTS_URL:` with no `LastActivityId`, and on the error stream a line that starts `NOTE:no Caterer LastActivityId is known for "3 months"`. Anything else: STOP and report it.

### 7.4 The window of the last runs can be read

```
node /opt/data/profiles/resourcer/workspace/tools/activity-probe.js --recent 3
```

Expect: exit 0, a first line `# recent runs: <n>`, and one `RUN ...` line for each of the last runs. Right after the update those runs say `activity=not-recorded` (they ran before the window was recorded): that is the normal case until the first run after the resume.

### 7.5 The probe lists its variants without a request

The owner names the job title and the postcode area for the probe (`<TITLE>` in quotes below; the searches of 2026-10-01 used `FY4` and 20 miles):

```
node /opt/data/profiles/resourcer/workspace/tools/activity-probe.js --job "<TITLE>" --location FY4 --distance 20 --dry-run
```

Expect: exit 0, the line `# activity-probe source=both location=FY4 distance=20mi DRY RUN (no request is made)`, seven `CATERER variant` lines (`param=none`, then `LastActivityId=7`, `8`, `9`, `11`, `15` and `0`), eleven `REED variant` lines and a closing `# 7 Caterer and 11 Reed variants; nothing was requested`. No URL is printed. Anything else: STOP and report it.

## 8. The read-only probe (HUMAN gate: the owner reads the result)

Both jobs are still paused, so no run is in flight. The probe loads search pages (Caterer) and runs searches (Reed), prints counts, and unlocks nothing, spends no credit and views no profile. It never signs in: if the Caterer browser is signed out it says so and stops.

```
node /opt/data/profiles/resourcer/workspace/tools/activity-probe.js --job "<TITLE>" --location FY4 --distance 20
```

Expect: exit 0 after a few minutes, a line `CATERER param=... applied="..." pool=<n> status=ok` for each of seven pages, a line `REED activityTimeFrame=... total=<n> status=ok` for each of eleven Reed values, and a last line `# done: 0 variant(s) could not be read`. Other exits: 3 means the probe refused because a run is in flight or the browser lock is held (check the status of step 1, wait, run it once more; do not loop); 4 means the Caterer browser is signed out or Reed could not refresh its token (report the lines, this is not part of this update); 5 means some variants could not be read (report the lines).

STOP here. Send the owner the printed lines exactly as they are (they hold counts and fixed words only) and wait for the owner's word before step 9. The owner reads them like this (`docs/OPERATIONS.md` section 5.1): each `LastActivityId` line should echo its own window (`applied="12 months"` for 15); the `none` line, compared with the others, shows what Caterer does when no window is sent; the Reed totals show whether Reed accepts each value. If the owner then changes the mapping in `config/caterer-activity.json` or sets `CATERER_ACTIVITY_FILTER=all`, that is the owner's own change and not a step of this note; you do not do it.

## 9. Resume (OPERATOR)

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

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes: do not clear it by hand. Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the answers of 7.1 to 7.5, and the probe lines of step 8.

Idempotent: yes. Repeating step 3 after it has passed answers `Already up to date`: on a repeat that is the expected answer, not the STOP of a first run. Repeating steps 4 to 7 changes nothing. The probe (step 8) can be run again at any time while the pipeline is idle; it changes nothing.

## 10. Watching the first days (OPERATOR, then OWNER)

You only read and report; the owner decides. Never change a setting.

```
node /opt/data/profiles/resourcer/workspace/tools/activity-probe.js --recent 5
```

THE FIRST LIVE SIGNAL (`docs/KNOWN-LIMITS.md` K-ACT1 and K-ACT2): after the first one-off request and the first scheduled run, read the `RUN` lines. A one-off request for 12 months shows `sent="LastActivityId=15"` and `match=yes` when the id is right, and `match=no` (with the alert `caterer-activity-mismatch`) when it is not; a scheduled run shows `sent="LastActivityId=none"` and in `applied=` the window Caterer applies when none is sent, with its `pool=`. A two-source run also shows `reed_window=` and `reed_cv_limit=`, the window and the limit Reed was given. Report the lines to the owner on that day. If the WARN alert `caterer-activity-mismatch` appears, report its text and the newest `ACTIVITY_FILTER` line; the run was not stopped and nothing was lost, only the pool differs. The owner decides what to do about the mapping and about `CATERER_ACTIVITY_FILTER=all`; the second is a business decision (every standing territory's pool would change), taken from the numbers of step 8 and these lines.

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

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back. Then resume the jobs you noted in step 1 (step 9).

What stays behind is harmless: the file `runtime/activity-alert.json` (a day marker), and the `activity` block in the status, queue and results files of the runs made while this release was installed (the old code ignores it). After the rollback a one-off request is again searched by Reed with the last month and a limit of 20, and Caterer is again not sent the window.
