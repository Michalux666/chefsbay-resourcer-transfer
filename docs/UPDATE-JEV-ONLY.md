# UPDATE: switch an installed instance to the Jev-only engine

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note is only for an instance that was
installed from the first release (commit `016b444`, screening engine `jev_shadow`, an LLM deciding through the AI Gateway). A
fresh install follows `docs/INSTALL.md` and needs none of this.

## What changes and why

The Vercel AI Gateway of the owner carries Jev (`typesafe-ai/jev`) and no other model. The first release screens with a language model
through the same gateway, which the Vercel team blocks (HTTP 403 "restricted access"), so its screening halts the pipeline. The new release
screens with Jev alone (engine `jev_only`, `docs/SCREENING.md` section 16; `docs/DECISIONS.md` OD-I and SCR-17 to SCR-28). In short:

- the default engine is `jev_only`; the older engines are refused unless `SCREEN_ALLOW_LLM=1` is set, so a leftover `SCREEN_ENGINE=jev_shadow`
  in the profile `.env` is harmless once the new code is in place (it becomes `jev_only`, with a `WARN screening config:` line);
- a card Jev is not sure about is settled by the review policy: rejected before the unlock, approved after it (owner settings `SCREEN_REVIEW_PRE`, `SCREEN_REVIEW_POST`);
- an unusable Jev answer is left undecided before the unlock (screened again later), and the deep health check calls Jev only;
- the go-live fixes of the screening are in the same release and need no setting: a card rank of up to 6 digits and a lower-case name no longer leak a name into the shadow log or to Jev, Jev's instruction-to-an-AI answer flags a card for review at 0.7 (was 0.5), and searches for Waiter, Waitress, Server, Front Of House, Bartender and Dish Washer use the tier-0 ladder instead of being rejected wholesale by the review policy (`docs/DECISIONS.md` SCR-26 to SCR-28);
- the supervision tick now drains (`docs/DECISIONS.md` SUP-15): a run does not outlive the cron run that started it, so the tick starts no new run after minute 38, waits for the run it started (up to minute 56), and ends a run still going then, cleanly, with one WARN alert `tick-hard-cap` (the territory is retried). The limits have defaults (`RESOURCER_LAUNCH_CUTOFF_MIN` 38, `RESOURCER_TICK_HARD_CAP_MIN` 56); never set them yourself;
- the dashboard plugin shows the Reed status chip from `RESOURCER_SOURCES` (step 5).

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard.
4. ORDER MATTERS: code first (steps 2 to 6), settings second (step 7). The old code does not know `jev_only`: it would treat it as an unknown engine and fall back to `jev_shadow`, which calls the blocked chat route.
5. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, the `rm` in step 8 does too.

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

Expect: `busy` is false. If it is true, a run is in flight: wait a few minutes and run the status command again (do not loop). While a halt is shown (`halt` not null, reason `screening gateway auth failed`), that is the state this update cures; go on.

## 2. Record the way back (OPERATOR)

```
git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD
```

Expect: 40 hex characters that start with `016b444`. Write it down as `<OLD_COMMIT>`.

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=<64 hex>`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`: STOP (the instance was modified; do not update over it).

## 3. Pull the release (OPERATOR)

This is the update command of `docs/INSTALL.md` 2.6; the deploy key is remembered in the repository, and it works on the shallow clone. It runs in the workspace directory:

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating <old id>..<new id>`, `Fast-forward`, and a file list that includes `resourcer/scripts/lib/screening/engine.js`, `resourcer/scripts/lib/screening/second-opinion.js` and `docs/UPDATE-JEV-ONLY.md`.
`Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the release the owner meant: STOP.

## 5. Install the changed profile and plugin files (OPERATOR)

Of the files that the profile keeps a copy of, this release changes `hermes/AGENTS.md`, the `resourcer-ops` skill and three files of the dashboard plugin. The cron wrappers and `SOUL.md` are unchanged: do not touch them.

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

Expect: no output from either `cmp`. Now the dashboard plugin. If `ls -d /opt/data/plugins/resourcer` says it does not exist, the plugin was never installed on this instance: skip the rest of this step up to the full check. Otherwise copy the three changed files into the existing plugin folder (the folder `docs/INSTALL.md` 10.1 made; nothing is moved or deleted):

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/README.md /opt/data/plugins/resourcer/README.md
```

```
cmp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cmp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

```
cmp /opt/data/profiles/resourcer/workspace/plugin/resourcer/README.md /opt/data/plugins/resourcer/README.md
```

Expect: no output from any `cmp`. The dashboard loads `plugin_api.py` only when it starts, so the new Reed chip appears after the owner presses Restart for the dashboard in the Hermes Portal (`docs/INSTALL.md` 10.3); until then the old one keeps running, which matters only for that chip. Do NOT restart the dashboard yourself (rule 3). Then the full check, which also compares every installed copy:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and no `INSTALLED_CHANGED` line. An `INSTALLED_CHANGED` line that names a wrapper or `SOUL.md`, or a plugin file other than the three copied above: STOP and report it (this release does not change them).

## 6. Nothing else to install

`resourcer/package.json`, the database schema, the cron wrappers and `hermes/cron/jobs.json` are unchanged: no `npm install`, no migration, no job edit. The new tick limits have defaults: set nothing.

## 7. Change the setting (OPERATOR)

Only this one setting changes. It replaces the `SCREEN_ENGINE=jev_shadow` that `docs/INSTALL.md` 6.3 of the first release wrote:

```
/opt/hermes/bin/hermes -p resourcer config set SCREEN_ENGINE jev_only
```

Expect: no error. If Hermes says `Cannot set 'SCREEN_ENGINE': it is managed by your administrator`: STOP. Optionally read it back (informational: Hermes may print the value masked, and if it refuses do not retry, step 9 proves the engine):

```
/opt/hermes/bin/hermes -p resourcer config get SCREEN_ENGINE
```

The other earlier values need no action. The first release set only `RESOURCER_SOURCES` and `SCREEN_ENGINE`, so on a normal instance none of these exist, and you cannot list the `.env` in this terminal, so do not look for them:

| Setting | What to do |
|---|---|
| `SCREEN_LLM_MODEL`, `SCREEN_LLM_BACKUP_MODEL`, `SCREEN_LLM_CONCURRENCY`, `SCREEN_LLM_TIMEOUT_MS`, `SCREEN_LLM_ZDR` | Nothing. They are ignored by `jev_only`. Never set them. |
| `SCREEN_CALIBRATED` | Nothing. In `jev_only` it only silences the once-per-run "uncalibrated thresholds" warning. Leave it unset until the owner has tuned the thresholds. |
| `SCREEN_ZDR`, `SCREEN_JEV_ZDR` | Nothing, unless step 8 reports `no_providers_available`: the owner has to say so, and then you run `/opt/hermes/bin/hermes -p resourcer config set SCREEN_ZDR 0` and `/opt/hermes/bin/hermes -p resourcer config set SCREEN_JEV_ZDR 0` (a value of 0 is off) and repeat step 8 once. Never turn zero data retention on yourself (`docs/INSTALL.md` 7.5). |
| `SCREEN_ALLOW_LLM` | Never set it. It is what would let a language-model engine run again. |

No restart is needed: every screening process reads the profile `.env` when it starts.

## 8. Deep screening check, Jev only (OPERATOR)

Use your file-write tool (not a shell redirect) to create `/opt/data/profiles/resourcer/install-work/deep-check.js` with exactly this content. The folder exists from `docs/INSTALL.md` 0.7; if `ls -d /opt/data/profiles/resourcer/install-work` says it does not, do 0.7 first.

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

Expect: one JSON line beginning `{"ok":true,"reason":"","ms":`, with `"level":"auth"` and `"engines":{"jev":{"ok":true}}`, exit 0. There must be NO `llm` entry inside `engines`: an `llm` entry means the old code is still running or `SCREEN_ALLOW_LLM` is set: STOP and report.

If it fails, the JSON holds `reason` and `detail`. `screening gateway auth failed` with `restricted access` in the detail: the owner must allow `typesafe-ai/jev` on the Vercel team (AI Gateway model access); the JSON then also carries a `remedy` field that says so. `screening credits exhausted`: the owner tops up. `screening gateway error` with `no_providers_available`: see the zero-data-retention row of step 7. Any other `screening gateway error`: repeat once, then report. Do not go on to step 9 until the check is `"ok":true`.

Then delete the scratch file (`rm` may need approval, see rule 5):

```
rm /opt/data/profiles/resourcer/install-work/deep-check.js
```

## 9. One real call through the screening tool (OPERATOR)

Run the two commands of `docs/INSTALL.md` 7.3 exactly as written there (the batch call, then the single call; invented text only). Expect what 7.3 says: exit 0, `SCREENING_MODEL: typesafe-ai/jev` (`typesafe-ai/jev+policy` when the review policy decided a card), one `WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds` line (expected), and this time NO line that begins `WARN screening config:` (such a line would name a setting that is still wrong; STOP and report it). If either call fails, use the failure table of 7.3.

## 10. Resume (OPERATOR)

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). If the pipeline was halted before the update, `halt` clears itself within a few minutes once the tick has run the deep check: do not clear it by hand. Report `MANIFEST_OK` with `<NEW_DIGEST>`, the deep-check line and the 7.3 result to the owner. The owner then watches the first runs with `docs/ACCEPTANCE.md` SR02 and SR08 (share of decisions taken by the review policy). Tell the owner two more things: the dashboard shows the new Reed chip after its next restart (step 5), and each tick now stops starting runs at minute 38 and ends when its own run is done (`tick end: launch-cutoff` in `logs/tick-<date>.log`; a single WARN alert `tick-hard-cap` is harmless, `docs/OPERATIONS.md` section 2).

Idempotent: yes. Repeating steps 3 to 9 changes nothing once they have passed.

## Rolling back

The first release cannot screen through this gateway (its engines call the blocked chat route), so a rollback only makes sense to investigate. Keep both jobs paused and tell the owner. If the owner wants the old code back:

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

If step 5 copied the plugin files (`/opt/data/plugins/resourcer` exists), put those three back too from the old checkout:

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/dist/index.js /opt/data/plugins/resourcer/dashboard/dist/index.js
```

```
cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/README.md /opt/data/plugins/resourcer/README.md
```

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. The old code does not understand `jev_only`, so set the setting back too (the value `docs/INSTALL.md` 6.3 of the first release wrote):

```
/opt/hermes/bin/hermes -p resourcer config set SCREEN_ENGINE jev_shadow
```

Leave the jobs paused: with that engine every screening call is refused by the Vercel team until the owner allows a chat model there. The way forward is this update again once the cause of the rollback is fixed.
