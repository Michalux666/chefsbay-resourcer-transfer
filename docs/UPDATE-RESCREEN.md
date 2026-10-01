# UPDATE RESCREEN: the re-screen tool (tools only) for an instance at the release 315e99b

**This is NOT Update D.** "Update D" (the Reed first-page fix) is already part of the release 315e99b that is installed; this note is a separate, later, tools-only commit. Do not skip it because "Update D is installed", and do not read it as a second Update D.

Audience: the operator LLM of the `resourcer` profile (terminal tool) and the owner. This note takes an installed instance from the release commit `315e99b` (Updates C and D installed together, `docs/UPDATE-C.md`; manifest digest `4bca8bb203613b5bd8c3e97669af3633efdbf5205cb2e3af246c1692e7797f26`) to the commit that adds `tools/rescreen-policy-rejects.js`. An instance that is still at `d60d917` or older does `docs/UPDATE-C.md` first and this note afterwards.

## What changes and why

One new tool, its tests and its documents. Nothing that runs on the instance by itself changes: no file under `resourcer/` (no script, no setting, no criteria file), no cron wrapper, no job, no dashboard plugin file, no profile file (`SOUL.md`, `hermes/AGENTS.md`, the `resourcer-ops` skill). So there is nothing to copy, no restart, no `npm install`, no migration, and no setting to change. The tool re-screens the pre-unlock rejections that the review policy of Update A made only because Jev was uncertain; what it does, what it costs and how it is used is `docs/RESCREEN.md`. Installing this note does not run it: the tool is used only at the owner's word, with the owner's numbers.

The files that arrive: `tools/rescreen-policy-rejects.js`, `docs/RESCREEN.md`, `docs/UPDATE-RESCREEN.md`, changed sections of other documents (`README.md`, `HANDOFF.md`, `docs/INSTALL.md`, `docs/OPERATIONS.md`, `docs/KNOWN-LIMITS.md`, `docs/SECURITY.md`, `docs/DECISIONS.md`, `docs/parity/integration.md`), the tests (`tests/rescreen/`, scenario 17 of `tests/e2e/`, the document tests) and the new `MANIFEST.sha256`. The manifest covers `tools/`, so its digest changes with the new tool: that is why step 4 needs the owner's `<NEW_DIGEST>`.

## Rules for this update

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard. No setting is changed by this update: never run `config set`.
4. `git reset --hard` (rollback only) is HUMAN-APPROVE. If step 0.7 of the install found that `rm` needs approval, every `rm` needs it; this note has none.

## 1. Before you start (HUMAN, then OPERATOR)

HUMAN: the owner has pushed the commit to the branch this instance tracks (step 3 is a fast-forward of that branch; `Already up to date` on a first run means the owner has not pushed: STOP), and gives you:

- `<NEW_DIGEST>`: the 64-character manifest digest of this commit. The owner gets it from the person who finalised the release: it is the `manifest_sha256=` value that `node tools/make-manifest.js` prints on the owner's machine after the last commit. You take `<NEW_DIGEST>` from the owner's message and never from `MANIFEST.sha256` or from the checkout you are verifying: a manifest regenerated together with a tampered script would otherwise pass;
- for the owner to compare: the digest the finaliser computed for this commit is `c932de1b487f310d7db4e66c4442835fca30d8cebfbde8bf43d1a84bcc3d9e32`. The owner confirms it on the owner's own machine (`node tools/make-manifest.js --dry-run` on the pushed commit prints the same `manifest_sha256=`) before giving it to you as `<NEW_DIGEST>`; it is shown here for that comparison only, you never take your `<NEW_DIGEST>` from this file;
- the go-ahead to update now. Update when no run is in flight (`docs/OPERATIONS.md` section 12).

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

Expect: 40 hex characters that start with `315e99b`. Write it down as `<OLD_COMMIT>`. Any other value: STOP and report it (an instance at `d60d917` does `docs/UPDATE-C.md`; any other id is not covered by this note).

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off
```

Expect: last lines `MANIFEST_OK` and `MANIFEST_SHA256=4bca8bb203613b5bd8c3e97669af3633efdbf5205cb2e3af246c1692e7797f26`. Write that digest down as `<OLD_DIGEST>`. Anything but `MANIFEST_OK`, or a different digest: STOP (the instance was modified or is not at the release; do not update over it).

## 3. Pull the commit (OPERATOR)

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

Expect: `Updating 315e99b..<new id>`, `Fast-forward`, and a file list that includes `tools/rescreen-policy-rejects.js`, `docs/RESCREEN.md` and `docs/UPDATE-RESCREEN.md`, and no file under `resourcer/`, `hermes/` or `plugin/`. `Already up to date`: the owner has not pushed: STOP. Any complaint about local changes or a non-fast-forward: STOP and report the text.

## 4. Verify the checkout against the owner's digest (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed off --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and `MANIFEST_SHA256=` equal to `<NEW_DIGEST>`. A mismatch means the checkout is not the commit the owner meant: STOP.

## 5. No installed copy changes (OPERATOR)

This commit changes none of the files that the profile and the machine keep a copy of (the cron wrappers, `SOUL.md`, `AGENTS.md`, the `resourcer-ops` skill, the dashboard plugin), so there is nothing to copy. Prove it with the full check, which compares every installed copy with the checkout:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --installed auto --expect <NEW_DIGEST>
```

Expect: `MANIFEST_OK` and no `INSTALLED_CHANGED` line (an `INSTALLED_MISSING` line for the plugin is only a warning and is expected when the plugin was never installed). An `INSTALLED_CHANGED` line means an installed copy differs from the checkout although this commit did not change it: the instance had drifted before. STOP and report it; do not copy anything over it (the owner decides).

## 6. Nothing else to install, nothing to set (OPERATOR)

No setting, no job, no wrapper, no database change, no restart. The tool is not run by anything and starts nothing: it is used at the owner's word, from `docs/RESCREEN.md`. You may confirm that it is there and prints its help without touching anything:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --help
```

Expect: exit 0 and the text `Usage: node tools/rescreen-policy-rejects.js`. (Do not run it without `--help` until the owner asks for the re-screen: even its dry run reads the shadow log, which holds personal data, and `docs/RESCREEN.md` section 8 is the way to use it.)

## 7. Resume (OPERATOR)

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

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). Report to the owner: `MANIFEST_OK` with `<NEW_DIGEST>`, the full check without `INSTALLED_CHANGED`, the help line, and that the re-screen has not been run and waits for the owner's word (`docs/RESCREEN.md` sections 8 to 11).

Idempotent: yes. Repeating step 3 after it has passed answers `Already up to date`: on a repeat that is the expected answer, not the STOP of a first run. Repeating steps 4 to 6 changes nothing.

## Rolling back

Keep both jobs paused while you roll back and tell the owner why. If the re-screen was applied and the owner wants it undone, do that FIRST with the tool of this commit (`docs/RESCREEN.md` section 11): the old commit has no tool, and the ledger files stay behind. Then:

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron pause resourcer-queue-due
```

HUMAN-APPROVE (`<OLD_COMMIT>` is the id written down in step 2, it starts `315e99b`):

```
git -C /opt/data/profiles/resourcer/workspace reset --hard <OLD_COMMIT>
```

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js --expect <OLD_DIGEST>
```

Expect `MANIFEST_OK`. No setting was changed by this update, so there is nothing to set back, and no installed copy was touched, so there is nothing to put back. Then resume the jobs you noted in step 1 (step 7).

What stays behind is harmless: any `runtime/rescreen-ledger-*.jsonl` (the cleared rows, mode 0600), `runtime/rescreen-queue.json`, any `pending-searches/zz-rescreen-*.json` the owner queued before the rollback (they are ordinary searches, the old code runs them as such), and the backups the tool took (`backups/`, encrypted).
