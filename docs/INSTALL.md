# INSTALL: put the resourcer on Hermes and prove it works

Audience: (1) the operator LLM, running as the Hermes agent of the `resourcer` profile with its terminal tool, which has never seen this project and must install and verify it without guessing; (2) the human owner, who does the steps marked HUMAN.

How to read it: do the steps in order. Every step has the exact command, the output to expect, how to verify, what to do on each known failure, and whether it is safe to repeat. Nothing here needs root. Nothing here needs you to invent a command.

Related documents: `docs/ACCEPTANCE.md` (the go-live checklist that follows this install), `docs/OPERATIONS.md` (day-to-day), `docs/CUTOVER.md` and `docs/ROLLBACK.md` (moving from the old system and back), `docs/SECURITY.md`, `docs/ENV.md`, `docs/KNOWN-LIMITS.md`, `docs/SCREENING.md`.

## 0. Rules, legend, human checklist

### 0.1 Paths used everywhere

| Name | Path |
|---|---|
| profile home | `/opt/data/profiles/resourcer` |
| repository (clone target) | `/opt/data/profiles/resourcer/workspace` |
| pipeline working directory (RESOURCER_HOME) | `/opt/data/profiles/resourcer/workspace/resourcer` |
| profile secrets file (never print it) | `/opt/data/profiles/resourcer/.env` |
| cron wrapper scripts | `/opt/data/profiles/resourcer/scripts` |
| dashboard plugin (machine level) | `/opt/data/plugins/resourcer` |
| scratch files for this install (outside the repository) | `/opt/data/profiles/resourcer/install-work` |

Write every path in full in every command. Do not rely on `cd` or shell variables from an earlier command. The scratch folder is created in 0.7; every later step that uses it assumes it exists.

### 0.2 Rules for the operator

1. Do the steps in order. Do not skip, merge or reorder them. After each step print one row of the progress table (0.6).
2. Every command below is complete. Copy it exactly. Do not add flags, do not "improve" it, do not swap it for a similar command.
3. Secrets: never print, `cat`, quote, copy or ask for a secret value (keys, passphrases, passwords, tokens, the `.env` file, anything in `secrets/` or `state/`, private key files). Use only the presence checks given here (they print a count, a mode or a name). If a secret ever appears in chat or in output, stop and tell the owner to rotate it.
4. Approvals: only commands marked HUMAN-APPROVE are expected to raise a Hermes approval prompt. Tell the owner before you send one and wait. If any other command prompts, is refused or is blocked, do not rephrase it and do not look for another route: stop and report the exact refusal text. One exception is decided in 0.7: if the probe there shows that Hermes asks for approval on a delete or a move of a single named file, every `rm` and `mv` line of this runbook counts as HUMAN-APPROVE from then on.
5. Never restart, stop or update the Hermes gateway or the dashboard yourself. Never run `hermes update`. Never use the host-wide `hermes pause` or `hermes resume`. A restart is a HUMAN step (portal). Use `hermes -p resourcer ...` for every Hermes command, with one named exception: the two machine-level plugin commands of 10.2 (`hermes plugins enable resourcer` and `hermes plugins list --enabled`, without `-p`), which touch the plugin list of the default home and are HUMAN-APPROVE.
6. Code lockdown: do not edit, move, delete or overwrite anything in the repository (`resourcer/scripts/`, `resourcer/candidates-db.js`, `resourcer/package.json`, `plugin/`, `hermes/`, `tools/`). If you think a file is wrong, write down the evidence and report it. The only commands in this runbook that change the repository tree are `git clone` / `git pull` (step 2), `npm ci` or `npm install` in `resourcer/` (step 3) and the copies into the profile and plugin directories (steps 6, 9, 10).
7. Foreground terminal commands stop at 600 seconds (the default is 180). Commands marked `timeout=600` need that setting. Anything that could run longer is started with the terminal background option and waited for.
8. Compare, do not assume: if the output differs from "Expect" in any way, report the difference, even if it looks harmless.
9. When a check fails, use that step's "If it fails" list. If the failure is not listed, stop and report. Do not retry a failing login or a failing bulk command in a loop.
10. Candidate data: the only data sent to any AI service during the install is the invented text in step 7. Never open `downloads/*.json`.
11. Write no notes files into the repository. Keep the install log as the progress table in chat.

### 0.3 Legend

| Tag | Meaning |
|---|---|
| OPERATOR | you run it |
| HUMAN | only the owner can do it (typing a secret, pressing a portal button, opening an e-mail). Ask, wait, then verify |
| HUMAN-APPROVE | the command trips a Hermes approval prompt. Say so first, then send it, then wait for the owner to approve |
| Idempotent: yes / no | whether the step can be repeated safely |

### 0.4 Human checklist (what the owner must have ready)

| # | Owner provides or does | Needed at |
|---|---|---|
| H1 | A Vercel AI Gateway key from a Pro (or higher) team with a credit balance, a budget and auto top-up, created for this project only. Entered on the dashboard Keys page, profile switcher on `resourcer`, as the custom key `AI_GATEWAY_API_KEY` | step 6 |
| H2 | On GitHub: the repository's SSH address, and adding the public deploy key that step 2 prints as a READ-ONLY deploy key (do not tick "Allow write access"). Alternative: a tarball of the repository placed on the instance | step 2 |
| H3 | The data-bundle passphrase (16 characters or more). Either type it on the Keys page as the custom key `BUNDLE_PASSPHRASE`, or create the file `secrets/bundle-passphrase` (mode 600) in your own terminal. It is deleted again right after the restore. Keep the passphrase somewhere off the instance as well | step 5 |
| H4 | A backup passphrase (16 characters or more, different from H3) typed on the Keys page as `BACKUP_PASSPHRASE`. Keep a copy off the instance (password manager): without it the backups cannot be read if the instance is lost | step 6 |
| H5 | An alert channel that reaches your phone within minutes (the pipeline can need a human within hours), configured in Hermes for the `resourcer` profile, and the exact delivery target text to give the operator (9.4; the jobs are created with it in 9.5, never with `local`). Then confirm the test alert arrived. This step blocks go-live | step 9 |
| H6 | Confirmation, in writing in this chat, that the OLD laptop pipeline is stopped and stays stopped (`docs/CUTOVER.md`). Two systems signing in to the same Caterer account invalidate each other's sessions and cause repeated safe-list blocks | before step 8 |
| H7 | Be at the mailbox that receives Caterer verification e-mails while step 8 runs. Each link is single use and only the newest works | step 8 |
| H8 | Press Restart for the dashboard in the Hermes portal, then reopen the Chat tab | step 10 |
| H9 | Decisions: (a) the zero-data-retention setting after the step 7 result, (b) whether Reed is set up before or after the first cycle (9.8), (c) an off-instance copy of the backups (`BACKUP_UPLOAD_CMD`), (d) an external dead-man monitor URL (`RESOURCER_DEADMAN_URL`) | steps 6, 7, 9 |
| H10 | Acceptance that the first live run spends Caterer credits and creates real records in Zoho Recruit | step 9 |
| H11 | Inputs for the operator: the repository SSH address, the manifest digest (if the release notes give one), and one outward postcode for the first small search (for example `M1`) | steps 2, 9 |

Where the Keys page is used: Hermes dashboard, Keys (API Keys), profile switcher set to `resourcer`, "add a custom key". If the dashboard has no custom-key form, the owner runs `hermes -p resourcer config set NAME value` in the owner's own terminal (never in the operator's chat).

### 0.5 Stop and ask the human when...

> Stop the install, say what you ran and what it printed (no secrets), and wait, when:
> - any preflight FAIL is not fixed by the "If it fails" list of the step you are on;
> - a command prompts for approval and is not marked HUMAN-APPROVE, or a command is refused or blocked;
> - a checksum, a manifest check or a bundle check fails, or `git status` shows changes you did not make;
> - a secret value appears in output or in chat;
> - something asks you for a password, a code or a link that this runbook does not name;
> - the Caterer login result is anything other than success (step 8): never retry it in a loop;
> - a step's output differs from "Expect";
> - memory available is under 900 MB or the disk has under 800 MB free;
> - you would need root, sudo, apt, a code edit, or a restart of anything;
> - Hermes says a setting is "managed by your administrator";
> - a step says "no run in flight" and a run is in flight.

### 0.6 Progress table (print after every step)

| Step | What you ran (short) | Result (the key line printed) | PASS / FAIL / BLOCKED | Needs from the human |
|---|---|---|---|---|

At the end print the whole table again, then the list of WARN lines that remain and every deviation from this runbook.

### 0.7 Create the scratch folder and probe approvals (OPERATOR, once, before step 1)

The scratch folder holds the few files this runbook makes outside the repository (steps 4, 7 and 10). It does not exist on a fresh profile; a write tool that does not create parent folders fails without it.

```
mkdir -p /opt/data/profiles/resourcer/install-work
```

```
chmod 700 /opt/data/profiles/resourcer/install-work
```

```
ls -ld /opt/data/profiles/resourcer/install-work
```

Expect: no output from the first two, and a line beginning `drwx------` from the third.

Then find out how this Hermes treats a move and a delete of one named file. Later steps use plain `mv` and `rm` on single named files, and some Hermes versions flag deletes under an absolute path as dangerous (UNVERIFIED-LIVE). Three commands, one at a time:

```
touch /opt/data/profiles/resourcer/install-work/approval-probe
```

```
mv /opt/data/profiles/resourcer/install-work/approval-probe /opt/data/profiles/resourcer/install-work/approval-probe-2
```

```
rm /opt/data/profiles/resourcer/install-work/approval-probe-2
```

Expect: no output and no approval prompt. If the `mv` or the `rm` raises a prompt or is refused: do not rephrase it. Tell the owner the exact text and ask two things in this chat: approve this one, and may every later `rm` and `mv` of a single named file in this runbook be approved the same way when you announce it. Write `rm/mv approvals: yes` (or `no`) in the progress table. With `yes`, every `rm` and `mv` line below counts as HUMAN-APPROVE (announce it, send it, wait). If it is refused outright and the owner cannot lift it, STOP: several steps need to delete their own scratch files.

Idempotent: yes.

## 1. Preflight (read-only environment probes)

Goal: prove the instance can host the service before anything is installed, and record the numbers.

The script `tools/preflight.sh` is part of the repository. If you are reading this file, the repository is already on the instance: find where with `ls /opt/data/profiles/resourcer/workspace/tools/preflight.sh`. If that file does not exist, the repository is somewhere else or missing: do step 2 first, then come back here.

Run (`timeout=300`):

```
sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh
```

Expect: sections A to H, each line starting with `PASS`, `WARN`, `FAIL` or `INFO`, and a last line `PREFLIGHT_RESULT pass=N warn=N fail=0`. The exit code is 0 when there is no FAIL. A WARN ending in `[needs step N]` is expected until step N is done. It prints names, paths, modes, counts and versions only, never a secret. It creates and removes a scratch folder `state/.pf-<pid>` and may create `state/` (mode 700); it starts Chromium headless for a moment and asks a few public hosts for headers (no login, no candidate data).

Verify: `fail=0`. Copy these numbers into the progress table: available memory (B2), free disk (B4), Chromium version (D3), egress country (H1), Node version (C1).

If it fails (by probe id):

| Probe | Meaning | What to do |
|---|---|---|
| A1, A2 | not Linux or not x86_64 | STOP: the pinned browser tooling is linux-x64 only. Tell the owner |
| A8 | `RESOURCER_HOME` does not exist | run step 2, then this step again |
| B2 | under 900 MB memory available | STOP. Ask the owner to free memory (the other profile is heavy). Do not start anything |
| B4 | under 800 MB free disk | STOP. Ask the owner |
| B8 | volume mounted `noexec` | STOP: the browser tool and native modules cannot run |
| B9 | HOME or TMPDIR missing or not writable | STOP (the virtual display tool needs TMPDIR) |
| C1 | Node older than 22 | STOP |
| C9, C11 | Intl cannot use Europe/London; SQLite second reader failed | STOP and report the line |
| D3 | no Chromium found | see step 4.4; if the owner cannot name a path: STOP |
| D6 | headless Chromium did not start with the repository flags | STOP and report the Chromium error text on the line |
| E12 | text the cron-creation scan rejects is present in `scripts/` or `hermes/` | STOP and report the file |
| E14 | the code manifest check failed | STOP and report the CHANGED / MISSING / UNLISTED names |
| F2 | `cron.script_timeout_seconds` is below 3500 | run `hermes -p resourcer config set cron.script_timeout_seconds 3600`, then repeat this step |
| H2 | the AI Gateway is not reachable | STOP: network problem; report |
| H4, H5 | Zoho is not reachable | STOP: network problem; report |
| H10 | the npm registry is not reachable | STOP: step 3 cannot run |
| any other FAIL | | STOP and report |

A WARN worth reporting even though it is not a failure: B2 between 900 and 1500 MB (a run with Reed will not fit), C6 (no compiler fallback), H1 not `GB` (Reed needs a UK exit), H6 or H7 showing HTTP 403 or 503 (normal for plain clients; step 8 decides), A7 (HERMES_HOME differs from the folder the repository sits in).

Idempotent: yes. Rerun it after steps 3, 4, 5, 6, 9 and 10, and at the end with `--final` (see step 11). Options: `--offline` (no network probes), `--no-browser` (no Chromium or virtual display launch), `--reed` (also starts a headed Chromium under the virtual display for a few seconds and makes the display tools mandatory), `--final` (turns every `[needs step N]` WARN into a FAIL).

## 2. Put the repository on the instance

Goal: the repository is at `/opt/data/profiles/resourcer/workspace`, unmodified, verified against its manifest.

### 2.1 Look first (OPERATOR)

```
ls -A /opt/data/profiles/resourcer/workspace
```

- Empty, or the folder does not exist: continue with 2.2 (route A) or 2.7 (route B).
- It lists at least `.git`, `resourcer`, `tools`, `docs`, `hermes`, `plugin`, `data` (a correct checkout also lists `tests`, `README.md`, `OPERATOR-PROMPT.md`, `MANIFEST.sha256`, `.gitignore` and `.gitattributes`): the repository is already there. Go to 2.8 (verify); use 2.6 only if the owner asked for an update.
- Anything else, meaning a folder that has neither `.git` nor `resourcer/package.json`, or that holds unrelated files: STOP and ask the human.

### 2.2 Make a read-only deploy key (OPERATOR)

Skip the key generation if `/opt/data/profiles/resourcer/deploy/id_ed25519` already exists.

```
mkdir -p /opt/data/profiles/resourcer/deploy
```

```
chmod 700 /opt/data/profiles/resourcer/deploy
```

```
ssh-keygen -t ed25519 -N '' -C hermes-resourcer-deploy -f /opt/data/profiles/resourcer/deploy/id_ed25519
```

Expect: `Your public key has been saved in /opt/data/profiles/resourcer/deploy/id_ed25519.pub` and a fingerprint line. Never print `id_ed25519` (no `.pub`): it is the private key.

### 2.3 Print the public key (OPERATOR) and get it added (HUMAN)

```
cat /opt/data/profiles/resourcer/deploy/id_ed25519.pub
```

Expect: one line beginning `ssh-ed25519 AAAA` and ending `hermes-resourcer-deploy`. This is public and safe to show.

HUMAN: in the GitHub repository open Settings, Deploy keys, Add deploy key. Title `hermes-resourcer`. Paste the line. Leave "Allow write access" unticked. Tell the operator when it is done.

### 2.4 Pin GitHub's host key (OPERATOR)

```
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > /opt/data/profiles/resourcer/deploy/known_hosts
```

```
ssh-keygen -lf /opt/data/profiles/resourcer/deploy/known_hosts
```

Expect: `256 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com (ED25519)`. If the fingerprint differs: STOP.

### 2.5 Test access (OPERATOR)

Replace `<REPO_SSH_URL>` with the address from the owner (H11), for example `git@github.com:OWNER/REPO.git`.

```
GIT_SSH_COMMAND='ssh -i /opt/data/profiles/resourcer/deploy/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/data/profiles/resourcer/deploy/known_hosts -o StrictHostKeyChecking=yes' git ls-remote <REPO_SSH_URL> HEAD
```

Expect: one line, 40 hex characters, a tab, `HEAD`.

If it fails: `Permission denied (publickey)` means the deploy key is not added to this repository yet (wait for the owner) or it was added to another repository. `Host key verification failed` means 2.4 was not done. `Could not resolve hostname` is a network problem: report.

### 2.6 Clone, or update an existing checkout (OPERATOR)

Fresh clone (`timeout=300`):

```
GIT_SSH_COMMAND='ssh -i /opt/data/profiles/resourcer/deploy/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/data/profiles/resourcer/deploy/known_hosts -o StrictHostKeyChecking=yes' git clone --depth 1 <REPO_SSH_URL> /opt/data/profiles/resourcer/workspace
```

Remember the key for later pulls:

```
git -C /opt/data/profiles/resourcer/workspace config core.sshCommand 'ssh -i /opt/data/profiles/resourcer/deploy/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/data/profiles/resourcer/deploy/known_hosts -o StrictHostKeyChecking=yes'
```

Already cloned (only when the owner asks for an update, and then repeat steps 9.2, 10.3 and the checks in 2.8; for the updates of an installed instance follow `docs/UPDATE-JEV-ONLY.md` (first release to the Jev-only engine) then `docs/UPDATE-C.md` (one cycle from Update A to the current release: screening criteria, the CV stage, CV_SCREEN=on made safe, an install self-test, the Reed first-page fix; `docs/UPDATE-B.md` is superseded for an instance at `d60d917`), then `docs/UPDATE-RESCREEN.md` (the tools-only commit that adds the re-screen tool, `docs/RESCREEN.md`) instead):

```
git -C /opt/data/profiles/resourcer/workspace pull --ff-only
```

If the remote address contains a token before the `@` (a URL such as `https://name:token@github.com/...`), STOP: show the owner only this redacted form and ask them to revoke the token and fix the remote:

```
git -C /opt/data/profiles/resourcer/workspace config --get remote.origin.url | sed -e 's#://[^/@]*@#://REDACTED@#'
```

### 2.7 Route B: tarball (only if the owner chose it in H2)

HUMAN: place `resourcer-repo.tar.gz` in `/opt/data/profiles/resourcer/incoming/` (dashboard file manager or the owner's own terminal) and tell the operator the file's sha256 from the release notes. OPERATOR:

```
sha256sum /opt/data/profiles/resourcer/incoming/resourcer-repo.tar.gz
```

Expect: the digest the owner gave. Then:

```
mkdir -p /opt/data/profiles/resourcer/workspace
```

```
tar -xzf /opt/data/profiles/resourcer/incoming/resourcer-repo.tar.gz -C /opt/data/profiles/resourcer/workspace --strip-components=1
```

If the archive has no single top-level folder, the paths will be wrong: run 2.8 and STOP if `resourcer/package.json` is not where it should be.

### 2.8 Verify the checkout (OPERATOR)

```
ls -l /opt/data/profiles/resourcer/workspace/data/resourcer-bundle.enc
```

Expect: a file of several megabytes. If it is missing or 0 bytes: STOP and ask the owner (the bundle travels with the repository).

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js
```

Expect: last line `MANIFEST_OK ...` and `MANIFEST_SHA256=<64 hex>`. If the owner gave a digest (H11), run the same command with `--expect <digest>` and require `MANIFEST_OK` again; a mismatch means the checkout is not the release the owner meant: STOP. Notes: the copies installed outside the repository are compared only once they exist. Until step 9.2 the output has `NOTE installed wrappers not compared (no profile found; ...)` and `NOTE installed plugin not compared (not found; ...)`, and no `INSTALLED_*` line: that is expected, not a problem. After 9.2 (wrappers, `SOUL.md`, `AGENTS.md`, the skill) and 10.1 (plugin) the same NOTE lines say `compared in <folder>`; from then on `INSTALLED_CHANGED` and `INSTALLED_UNLISTED` fail the check and `INSTALLED_MISSING` is a warning that names what is not installed yet. `MANIFEST_OK` is the pass criterion. `MANIFEST_MISSING` (exit 3): the release has no `MANIFEST.sha256`: STOP and ask.

```
git -C /opt/data/profiles/resourcer/workspace status --porcelain
```

Expect: no output (a lone `?? AGENTS.md` appears only after step 6.4). Any other line: STOP. (Route B, the tarball, has no `.git`: skip this command.)

Idempotent: yes (2.2 and 2.4 overwrite nothing that matters; 2.6 clone fails harmlessly if the folder is not empty).

Now rerun step 1 if it was skipped: `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --offline --no-browser`. Expect `fail=0` with one known exception: D3 (no Chromium at `/usr/bin/chromium`) is a presence check and FAILs even with `--no-browser` until you have set `CHROMIUM_PATH` in 4.4, and D1 and D2 WARN `[needs step 4]`. Ignore only those lines here; any other FAIL is a STOP.

## 3. Install the Node dependencies

Goal: `resourcer/node_modules` exists, `better-sqlite3` loads.

Look for the lockfile (OPERATOR):

```
ls /opt/data/profiles/resourcer/workspace/resourcer/package.json /opt/data/profiles/resourcer/workspace/resourcer/package-lock.json
```

- Both listed: use `npm ci` (exact versions).
- Only `package.json` listed: `ls` also prints `cannot access '...package-lock.json': No such file or directory` and exits 2. That is expected while the release ships no lockfile (preflight C7 WARN says the same). Use `npm install` (with `--no-package-lock`, so that no new file appears in the repository) and tell the owner the install was not pinned by a lockfile; the owner can remove the warning for good by committing `resourcer/package-lock.json`.

Run one of these (`timeout=600`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && npm ci --omit=dev --no-audit --no-fund
```

```
cd /opt/data/profiles/resourcer/workspace/resourcer && npm install --omit=dev --no-audit --no-fund --no-package-lock
```

Expect: a line `added N packages in Ns` and exit 0, in under about three minutes; `npm notice` lines about a newer npm version may follow and are ignored. `node_modules` is about 110 MB.

Verify the native database driver loads (a zero-byte file is an accepted empty database with `--allow-empty`):

```
mkdir -p /opt/data/profiles/resourcer/workspace/resourcer/state
```

```
touch /opt/data/profiles/resourcer/workspace/resourcer/state/probe-empty.db
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/preflight-db.js --db /opt/data/profiles/resourcer/workspace/resourcer/state/probe-empty.db --allow-empty
```

Expect: `[preflight-db] OK candidates=0 journal=delete`. Then clean up:

```
rm /opt/data/profiles/resourcer/workspace/resourcer/state/probe-empty.db
```

Then `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --offline --no-browser` must show C10 (or its rollback-journal WARN), C11 and C13 as PASS with no `[needs step 3]` left. The D3 FAIL and the D1/D2 `[needs step 4]` WARNs of 2.8 may still be there until step 4; nothing else may FAIL.

If it fails:

| Symptom | Cause | Action |
|---|---|---|
| `EACCES` writing the npm cache | HOME not writable for npm | repeat the command with `--cache /opt/data/profiles/resourcer/.npm-cache` added; report |
| the better-sqlite3 download fails (`prebuild-install` / HTTP error) | the release host is blocked | repeat once; if preflight C6 said a compiler is present, add `--build-from-source` to `npm install`; otherwise STOP and report |
| `ENOSPC` | disk full | STOP |
| `[preflight-db] NOT FIT (driver-missing)` | the native module did not build | STOP and report the line |
| warnings `EBADENGINE` | engine range notes only | not a failure; report them |

Idempotent: yes.

## 4. Install the pinned agent-browser and check Chromium

Goal: `/opt/data/profiles/resourcer/bin/agent-browser` is exactly version 0.21.0 (verified by sha256), Chromium works, the browser stack passes its smoke test. The version is pinned on purpose: newer versions change how sessions are kept.

### 4.1 Download and verify (OPERATOR)

```
mkdir -p /opt/data/profiles/resourcer/bin
```

```
curl -fsSL -o /opt/data/profiles/resourcer/bin/agent-browser.part https://github.com/vercel-labs/agent-browser/releases/download/v0.21.0/agent-browser-linux-x64
```

```
echo "c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff  /opt/data/profiles/resourcer/bin/agent-browser.part" | sha256sum -c -
```

Expect: `/opt/data/profiles/resourcer/bin/agent-browser.part: OK`. If it prints `FAILED`: delete the file with `rm /opt/data/profiles/resourcer/bin/agent-browser.part` and STOP; never use a file that fails the check.

```
chmod 755 /opt/data/profiles/resourcer/bin/agent-browser.part
```

```
mv /opt/data/profiles/resourcer/bin/agent-browser.part /opt/data/profiles/resourcer/bin/agent-browser
```

```
/opt/data/profiles/resourcer/bin/agent-browser --version
```

Expect exactly: `agent-browser 0.21.0`.

### 4.2 Alternative if github.com cannot be reached (preflight H9 WARN)

```
mkdir -p /opt/data/profiles/resourcer/install-work/ab
```

```
cd /opt/data/profiles/resourcer/install-work/ab && npm pack agent-browser@0.21.0
```

```
cd /opt/data/profiles/resourcer/install-work/ab && tar -xzf agent-browser-0.21.0.tgz package/bin/agent-browser-linux-x64
```

```
echo "c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff  /opt/data/profiles/resourcer/install-work/ab/package/bin/agent-browser-linux-x64" | sha256sum -c -
```

Expect `...: OK`. Then `cp` that file to `/opt/data/profiles/resourcer/bin/agent-browser`, `chmod 755` it, check `--version` as above, and remove the scratch files with plain `rm` on each file and `rmdir` on each empty folder (no recursive delete).

### 4.3 Preflight and smoke test (OPERATOR)

```
sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --offline
```

Expect: D1, D2, D3, D5, D6 PASS and `fail=0`. If D3 is a FAIL, do 4.4 first and then rerun this command. Copy the path printed on the `PASS D3 chromium <path> (<source>): <version>` line: the smoke test below needs it when the source is not `default`.

Smoke test (credential-free, contacts no site, `timeout=600`; it needs `ps` and `pgrep`; if it says they are missing, report and continue):

```
bash /opt/data/profiles/resourcer/workspace/tests/browser/smoke-linux.sh
```

Expect: `PASS` lines (more than the two host-fact lines at the top), a last line `SMOKE_RESULT: pass=N fail=0 skip=N warn=N`, exit 0, and NO line beginning `SKIP: chromium not found`. A FAIL is a STOP: report the FAIL line.

If the `SKIP: chromium not found` line appears, the browser stack was NOT tested, even though the run ends with `fail=0` and exit 0 (a run whose only checks are the two host-fact PASS lines and `skip=1` is not a pass). This happens when Chromium is not at `/usr/bin/chromium` and its path lives only in the profile `.env` (4.4), which your shell does not see. Run it again with the D3 path in the environment (`timeout=600`):

```
CHROMIUM_PATH=<the path from the D3 line> bash /opt/data/profiles/resourcer/workspace/tests/browser/smoke-linux.sh
```

Expect the same as above without the SKIP line. If it still skips, STOP and report.

### 4.4 If Chromium is not at /usr/bin/chromium

If preflight D3 is an INFO line saying Chromium was found through `/etc/hermes/agent-browser-executable-path`, nothing needs to be done: the code reads that file too (the smoke test also reads it, so the `CHROMIUM_PATH=` form above is not needed). If D3 is a FAIL and the owner knows where Chromium is, set the path (a non-secret setting):

```
hermes -p resourcer config set CHROMIUM_PATH <the path the owner gives>
```

Verify with `grep -c '^CHROMIUM_PATH=.' /opt/data/profiles/resourcer/.env` (expect `1`), rerun the preflight command of 4.3 (D3 must now PASS) and then the smoke test with `CHROMIUM_PATH=` in front, as shown in 4.3. No Chromium at all: STOP.

Idempotent: yes (the download is overwritten by an identical verified file).

## 5. Restore the encrypted data bundle

Goal: `candidates.db` (the memory of every candidate already seen, and the territory schedule), the config files, the caches, the pending searches and the three credential files are on the instance, with the right modes, and the schema is migrated. The bundle never contains sessions, cookies, browser state, CVs or logs.

Precondition: no pipeline run in flight (there is none: nothing is enabled yet) and H6 confirmed for the old system.

### 5.1 Prepare the passphrase file (HUMAN, then OPERATOR)

```
mkdir -p /opt/data/profiles/resourcer/workspace/resourcer/secrets
```

```
chmod 700 /opt/data/profiles/resourcer/workspace/resourcer/secrets
```

Route 1 (preferred): HUMAN creates `/opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase` in the owner's own terminal, one line, mode 600 (`node /opt/data/profiles/resourcer/workspace/tools/restore-bundle.js --save-passphrase` in a real terminal asks twice with hidden input and writes it correctly; it cannot run in the operator's chat). Nothing else to do here. The owner's terminal must be logged in as the same Unix user as the operator: a mode 600 file owned by another user is unreadable to the operator. Compare `id -un` in both; if they differ, or the owner has no terminal on the instance, use route 2.

Route 2: HUMAN types the passphrase on the Keys page as `BUNDLE_PASSPHRASE`. Then OPERATOR moves it into the file without ever displaying it (the command prints nothing):

```
grep '^BUNDLE_PASSPHRASE=' /opt/data/profiles/resourcer/.env | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' > /opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase
```

```
chmod 600 /opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase
```

Verify without showing content: `stat -c '%a %s' /opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase` prints `600 <size>` where the size is at least 17 (16 characters plus a newline). A size of 1 means the key was not found on the Keys page: ask the owner.

### 5.2 Dry run (OPERATOR)

```
cd /opt/data/profiles/resourcer/workspace && BUNDLE_PASSPHRASE_FILE=/opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase RESOURCER_HOME=/opt/data/profiles/resourcer/workspace/resourcer node tools/restore-bundle.js --dry-run
```

Expect: a plan with one line per file (names, sizes, and an action word: `create` for a new file, `unchanged` for a file that is already identical, such as `config/*.json` or `scripts/extract-js.b64` from the repository; `replace` or `keep` on a rerun), possibly one or more `bundle warning: ...` lines (report them; they do not stop the restore), no secret values, and the last line `DRY_RUN_OK nothing was written`, exit 0. Nothing is written.

Exit codes:

| Exit | Meaning | Action |
|---|---|---|
| 2 | authentication failed: wrong passphrase, or the bundle was altered | STOP. Ask the owner to check the passphrase; never guess. If route 2 of 5.1 was used, the file may not hold the real value (some hosts mask secrets when a command reads the `.env` file): switch to route 1 |
| 3 | bundle malformed or truncated | the transfer broke: ask the owner to re-send; compare the size with `ls -l` |
| 4 | refused (a live run, a newer database already present, a blocked destination) | STOP: read the reason line; do not use `--force` unless the owner tells you to in this chat |
| 5 | verification mismatch | STOP |
| 6 | the schema migration failed | STOP and report the message |
| 7 | passphrase problem: file missing, unreadable or empty (the default file `secrets/bundle-passphrase` must also be mode 600). A wrong or too-short but non-empty passphrase is NOT exit 7: it shows as exit 2 | fix 5.1 |

### 5.3 Restore (OPERATOR)

The same command without `--dry-run` (`timeout=600`):

```
cd /opt/data/profiles/resourcer/workspace && BUNDLE_PASSPHRASE_FILE=/opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase RESOURCER_HOME=/opt/data/profiles/resourcer/workspace/resourcer node tools/restore-bundle.js
```

Expect: a last line `RESTORE_OK files=N created=N replaced=N unchanged=N kept=N skipped=N`, exit 0, and shortly before it the line `migrate-schema: ok` (the `[migrate-schema] OK` form belongs to 5.5, where the script runs on its own). It also keeps a safety copy of anything it replaced under `backups/bundle-restore-<time>/`.

Idempotent: yes. A second run reports the files as unchanged and refuses to overwrite a newer database.

### 5.4 Remove the passphrase (OPERATOR, then HUMAN)

```
rm /opt/data/profiles/resourcer/workspace/resourcer/secrets/bundle-passphrase
```

HUMAN (route 2 only): delete the `BUNDLE_PASSPHRASE` key on the Keys page. The owner keeps the passphrase off the instance for any later restore.

### 5.5 Verify the data (OPERATOR)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/migrate-schema.js
```

Expect: every step shows `present` (nothing to change) and `[migrate-schema] OK`. If a line says the volume cannot do WAL and a rollback journal is used, that is correct, only report it.

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/preflight-db.js
```

Expect: `[preflight-db] OK candidates=<N> journal=wal` (or `delete`). N should be close to the number the owner gives you (about 65,000 in the last laptop copy). `NOT FIT (...)`: STOP.

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/backfill-run-results.js --strict
```

Expect: exit 0 and a line `PARITY OK`. On a fresh install there are no result files, so it inserts nothing; that is correct (run history is not carried over; the dashboard counters start from the first run here).

```
ls -l /opt/data/profiles/resourcer/workspace/resourcer/secrets
```

Expect: `caterer-credentials.json`, `zoho-credentials.json`, `reed-credentials.json`, each mode `-rw-------`; the folder itself `drwx------`. Do not open them.

Then `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --offline --no-browser`: E5, E6, E9, E9b PASS, and no E8 WARN.

## 6. Profile secrets, settings and identity files

### 6.1 HUMAN: enter the secrets

On the dashboard Keys page with the profile switcher on `resourcer`, add these custom keys (values are typed by the owner, never in chat):

| Key | Required | Notes |
|---|---|---|
| `AI_GATEWAY_API_KEY` | yes | the Vercel AI Gateway key (H1) |
| `BACKUP_PASSPHRASE` | yes | 16+ characters (H4); a copy is kept off the instance |
| `RESOURCER_DEADMAN_URL` | recommended | the URL of an external dead-man monitor (H9d); it is pinged only while the supervisor is alive |
| `BACKUP_UPLOAD_CMD`, `BACKUP_UPLOAD_ENV` | recommended | how an encrypted backup is copied off the instance (H9c); see `docs/ENV.md` |

### 6.2 OPERATOR: verify without reading values

```
grep -c '^AI_GATEWAY_API_KEY=.' /opt/data/profiles/resourcer/.env
```

```
grep -c '^BACKUP_PASSPHRASE=.' /opt/data/profiles/resourcer/.env
```

```
stat -c '%a %U %n' /opt/data/profiles/resourcer/.env
```

Expect: `1`, `1`, and a line starting `600` followed by the user you run as (compare with `id -un`; the user is not always called `hermes`). If the mode is not 600: `chmod 600 /opt/data/profiles/resourcer/.env`. If a count is `0`: the key is missing, wrong-cased or empty: ask the owner. Never `cat` the file.

### 6.3 OPERATOR: record two explicit non-secret settings

They are the defaults; setting them makes the state visible and auditable.

```
hermes -p resourcer config set RESOURCER_SOURCES caterer
```

```
hermes -p resourcer config set SCREEN_ENGINE jev_only
```

Verify:

```
grep -c '^RESOURCER_SOURCES=caterer' /opt/data/profiles/resourcer/.env
```

```
grep -c '^SCREEN_ENGINE=jev_only' /opt/data/profiles/resourcer/.env
```

Expect `1` and `1`. (`RESOURCER_SOURCES=caterer` keeps Reed off until step 12. `SCREEN_ENGINE=jev_only` means Jev is the only model screening uses and no language model is ever called: the owner's Vercel team allows only Jev through the AI Gateway. Never set another engine, and never set `SCREEN_ALLOW_LLM`: without that switch the code turns any other engine into `jev_only` anyway.) If Hermes answers `Cannot set '...': it is managed by your administrator`: STOP.

Set no other variable unless a step tells you to. The variables are listed in `docs/ENV.md`.

### 6.4 The profile identity files (skip if a file is missing, report it, it is not a blocker)

```
ls /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/hermes/SOUL.md /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/SKILL.md
```

If all three are listed:

```
cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cp /opt/data/profiles/resourcer/workspace/hermes/SOUL.md /opt/data/profiles/resourcer/SOUL.md
```

HUMAN-APPROVE: Hermes may ask before it lets a command write `SOUL.md`. Tell the owner, then send it; if it is refused, stop and report.

```
mkdir -p /opt/data/profiles/resourcer/skills/ops/resourcer-ops
```

```
cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/
```

```
hermes -p resourcer config set terminal.cwd /opt/data/profiles/resourcer/workspace
```

Verify:

```
hermes -p resourcer skills list
```

Expect a line naming `resourcer-ops`. Then prove the three installed copies equal the repository copies. `check-manifest.js` cannot do it yet (it compares the profile files only once the wrappers exist, after 9.2), so use `cmp`: each command prints nothing when the two files are identical, and a line containing `differ` (or starting `cmp:`) when they are not (then STOP and report).

```
cmp /opt/data/profiles/resourcer/workspace/hermes/SOUL.md /opt/data/profiles/resourcer/SOUL.md
```

```
cmp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md
```

```
cmp /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/SKILL.md /opt/data/profiles/resourcer/skills/ops/resourcer-ops/SKILL.md
```

Then:

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js
```

Expect `MANIFEST_OK` and, at this point, the two `NOTE ... not compared` lines of 2.8 (nothing more is compared yet). After 9.2 the same command compares these three files as well. The new session that starts after this step will follow `AGENTS.md` (read-only operation of the pipeline). Its rules on `npm`, `git pull` and copying do not apply to the steps of this runbook that name those commands.

Idempotent: yes (all copies overwrite with identical content).

## 7. Screening canaries (real AI calls with invented text)

Goal: prove the AI Gateway key works, the owner's Vercel team lets Jev through, Jev (the only model this system uses) answers in the expected shape through the screening tool (for the search cards, 7.3, and for a downloaded CV, 7.6), and record whether zero data retention is available. There is no language model in screening (engine `jev_only`, docs/SCREENING.md section 16): the team blocks every other model, so a canary of one would only answer HTTP 403, and none is part of this install. All text sent in this step is invented. No candidate data is used. Total cost: a fraction of a cent per call. Precondition: step 6 done. Do not repeat these calls in a loop: send each one once, wait for the answer.

### 7.1 Gateway auth and credits (OPERATOR)

```
sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --no-browser
```

Expect: H2 PASS (catalog reachable) and H3 PASS ("accepts the key and reports credits"). H3 `rejected` (401 or 403): wrong or revoked key, STOP and tell the owner. `no credits` (402): the owner tops up. Overall `fail=0`.

### 7.2 The supervisor's own deep check (OPERATOR)

The supervisor runs this check by itself when screening is down. Run it once by hand. The scratch folder made in 0.7 must exist (`ls -d /opt/data/profiles/resourcer/install-work`; if it does not, do 0.7 now). Use your file-write tool (not a shell redirect) to create `/opt/data/profiles/resourcer/install-work/deep-check.js` with exactly this content:

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

Expect: one JSON line beginning `{"ok":true,"reason":"","ms":` with `"level":"auth"` and `"engines":{"jev":{"ok":true}}` (there is no `llm` entry: the deep check calls Jev only), exit 0. Then delete the file: `rm /opt/data/profiles/resourcer/install-work/deep-check.js`.

If it fails: the `reason` is one of `screening gateway unreachable`, `screening gateway auth failed`, `screening credits exhausted`, `screening gateway error`, `AI screening unavailable`. Report it with its `detail`. Auth failed: the owner replaces the key; if the `detail` says the team has restricted access to a model, the owner must allow `typesafe-ai/jev` on the Vercel team (AI Gateway model access settings), and the JSON then also carries a `remedy` field that says so. Credits exhausted: the owner tops up. `screening gateway error` with `no_providers_available` in the `detail`: a zero-data-retention request that no provider can serve (see 7.5; nothing in this step should have set `SCREEN_ZDR`). `screening gateway error` otherwise: Jev or the gateway is failing; repeat once, then report (there is no backup model; this is a HUMAN decision).

### 7.3 One real call through the screening tool, both stages (OPERATOR)

First the before-unlock stage (batch), one suitable and one unsuitable invented candidate (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode batch --job Chef --location M1 --distance 20 --source caterer --run-id install-canary --with-codes --candidates '[{"id":"canary-yes","snippet":"Chef de Partie | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Chef de Partie Jan 2019 - Current Test Bistro Ltd Key Responsibilities Running the sauce section, daily prep, ordering, food safety"},{"id":"canary-no","snippet":"Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"}]'
```

Expect: exit 0; standard output is one line, a JSON array with `"id":"canary-yes"` having `"approved":true` and `"id":"canary-no"` having `"approved":false`, each with a `reason` and a `reasonCode` (Jev's own `reject_...` code, or `sys_review_policy_reject` when both injection filters flagged the card); standard error contains `SCREENING_MODEL: typesafe-ai/jev` (`typesafe-ai/jev+policy` when the review policy decided a card) and, once, a `WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds` line, which is expected until the owner has calibrated the operating point on recruiter labels (docs/SCREENING-CRITERIA.md section 6). Each call also sends one small extra request per distinct search title (Jev is asked once what level of role `Chef` is): that is expected.

Then the after-unlock stage (single):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode single --job Chef --title "Retail Cashier" --source caterer --run-id install-canary --with-codes --snippet "Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"
```

Expect: exit 0; one line `{"approved":false,"reason":"...","reasonCode":"reject_..."}`. If it reads `"approved":true` with `"reasonCode":"sys_review_policy_approve"`, the review policy (approve after the unlock) decided: the card was flagged as an instruction to an AI by both filters, or Jev's answer stayed unusable. That is not expected for this invented text and not a failure of the install, but record it and tell the owner.

If it fails:

| Symptom | Meaning | Action |
|---|---|---|
| exit 3, output begins `API_UNAVAILABLE:` | Jev could not be reached, or the gateway refused the key or the model | report the text after the colon (`restricted access to this model` means the owner must allow `typesafe-ai/jev` on the Vercel team); do not repeat more than once |
| batch: `canary-yes` rejected with `sys_review_policy_reject` | the invented text tripped both injection filters (the keyword filter and Jev's own answer), or the card was empty: only the owner rewords the canary | STOP and report both lines |
| batch: `canary-yes` rejected with a `reject_...` code | Jev's answers and the criteria rejected an obvious Chef de Partie | STOP and report both lines |
| batch: `canary-no` approved | Jev approved an unrelated candidate | STOP and report both lines |
| batch: a canary card has `reasonCode` `sys_invalid_result` | Jev's answer for that card was unusable twice; the card is left undecided, not rejected | repeat the batch call once; if it comes back again STOP and report both lines |
| exit 1 with `FATAL` | usage or input problem | report the text |

### 7.4 What Jev answered, from the private log (OPERATOR)

The calls in 7.3 wrote one row each to the private shadow log. Read only the Jev status of the canary rows:

```
grep -h '"runId":"install-canary"' /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -c '"jev":{"status":"ok"'
```

Expect: `3` (two batch rows and one single row). Anything from 1 to 2 is a partial answer: report it. `0`: show the reason, which contains no personal data:

```
grep -h '"runId":"install-canary"' /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -o '"jev":{[^}]*}'
```

Then, in every case, show who decided each row (an engine name and a code, no personal data):

```
grep -h '"runId":"install-canary"' /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -o '"used":{[^}]*}'
```

Expect three lines, each `"engine":"jev"` (Jev decided) or `"engine":"policy"` with a `sys_review_policy_` code (the review policy decided, which is rare: it settles only a card both injection filters flagged, an empty card and, after the unlock, an unusable answer); report which. A line with `"engine":"system"` and a `sys_invalid_result` code means Jev's answer for that card was unusable (the card is left undecided, not rejected): report it. A Jev failure IS a blocker in this engine: without Jev nothing can be screened (the tool exits 3 and the pipeline halts). `http_403` means the AI Gateway account or the Vercel team restricts the model (the owner must allow `typesafe-ai/jev`), `http_402` no credits, `timeout` slowness.

### 7.5 Zero data retention canary (OPERATOR)

Repeat the single call with zero data retention requested (`timeout=300`). Every request of this call asks the gateway to route only to providers that keep no data:

```
cd /opt/data/profiles/resourcer/workspace/resourcer && SCREEN_ZDR=1 RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/ai-review.js --mode single --job Chef --title "Retail Cashier" --source caterer --run-id install-canary-zdr --with-codes --snippet "Retail Cashier | Testville Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment"
```

```
grep -h '"runId":"install-canary-zdr"' /opt/data/profiles/resourcer/workspace/resourcer/shadow/screening-*.jsonl | grep -o '"jev":{[^}]*}'
```

Read the result:

| Result | Meaning | Recommendation to the owner |
|---|---|---|
| exit 0 and the second command shows `"status":"ok"` | zero data retention works for Jev | the owner may set `SCREEN_JEV_ZDR=1` (or `SCREEN_ZDR=1`, the same thing here; see `docs/SCREENING.md` section 12) |
| exit 3 (`API_UNAVAILABLE`) with `no_providers_available` or `HTTP 400` in the text, and the second command shows `"status":"error"` with `http_400` | no zero-retention provider exists for Jev | leave `SCREEN_ZDR` and `SCREEN_JEV_ZDR` unset: setting either would make every screening call fail (exit 3, halt) and tell the owner data goes to a US processor without a zero-retention promise |
| exit 3 with any other text | Jev failed for another reason | report the text; do not draw a conclusion about zero data retention |

This is a HUMAN decision (H9a). Do not set `SCREEN_ZDR` or `SCREEN_JEV_ZDR` yourself. Record the result in the progress table.

### 7.6 CV screening canary (OPERATOR)

First prove that the PDF and Word readers load on this instance (no network, no key, nothing is written; `docs/UPDATE-C.md` step 7.1):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cv-review.js --self-test
```

Expect: exit 0 and exactly one line, `CV_SELF_TEST_OK pdf docx`. A line that starts `CV_SELF_TEST_FAILED` names the file type and a fixed reason code (`pdf:error_parse_failed`: `pdf-parse` cannot load, so every PDF would pass as unreadable): STOP and report the line.

The CV stage reads a downloaded CV between the download and the Zoho push (`docs/CV-SCREENING.md`). It needs no setting: `CV_SCREEN` defaults to `shadow`, which records what it would have done and blocks nothing. Prove it with two invented CVs, a chef and a retail assistant, both for a Chef de Partie search (the command decides and prints; it never blocks anything). Use your file-write tool (not a shell redirect) to create `/opt/data/profiles/resourcer/install-work/canary-cv.txt` with exactly this content (the scratch folder of 0.7 must exist):

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

Run the chef (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv.txt --no-shadow
```

Expect: exit 0; standard output is one JSON line that begins `{"decision":"pass","final":"approve","lane":"jev"` (it holds numbers and reason codes only, no text); standard error ends with `SCREENING_MODEL: typesafe-ai/jev`. `--no-shadow` keeps the invented CVs out of the shadow log. Then the retail assistant (`timeout=300`):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv-no.txt --no-shadow
```

Expect: exit 0; one JSON line that begins `{"decision":"reject","final":"reject","lane":"jev"` with the reason codes `no_relevant_experience` (and usually `career_change`); the same `SCREENING_MODEL` line. In shadow mode this decision blocks nothing: it only shows that the stage can tell the two apart. Then delete both files, one command each:

```
rm /opt/data/profiles/resourcer/install-work/canary-cv.txt
```

```
rm /opt/data/profiles/resourcer/install-work/canary-cv-no.txt
```

If it fails:

| Symptom | Meaning | Action |
|---|---|---|
| exit 3, output begins `API_UNAVAILABLE:` | Jev could not be reached or refused the key or the model | as in 7.3: report the text after the colon; do not repeat more than once |
| the chef is `"decision":"reject"`, or either is `"lane":"fallback"` or `"decision":"unreadable"` | the stage read or judged an obvious CV wrongly | STOP and report the JSON line (numbers and codes only) |
| the retail assistant is `"decision":"pass"` | Jev doubted an obvious mismatch (a forced pass) | STOP and report the JSON line |
| exit 1 with `FATAL` | usage or input problem (for example a file was not created) | report the text |
### 7.7 Clean up

The canary rows in `shadow/` carry the run ids `install-canary` and `install-canary-zdr`; they contain only invented text and stay until the normal 180-day expiry (the readers of the shadow log, and so the screening report, skip every run id that starts with `install-canary`); the CV canaries of 7.6 write no row (`--no-shadow`). Remove the scratch folder contents: `rm` on any file you created in `/opt/data/profiles/resourcer/install-work/` (none should remain).

Idempotent: yes (each call costs a fraction of a cent).

## 8. Caterer login canary: GO / NO-GO

Goal: prove the instance can sign in to Caterer.com and search, before any automation is switched on. This is the riskiest step: a wrong move triggers a device block or locks the account. A first sign-in from a new machine is EXPECTED to be blocked once ("safe-list").

Preconditions: steps 3 to 6 done; H6 confirmed in chat by the owner; the owner is at the mailbox that receives Caterer verification e-mails (H7); no pipeline job is enabled yet (nothing is: step 9 comes later).

Never run the sign-in command twice in a row "to see if it works": every attempt e-mails a new link and voids the older ones.

### 8.1 The one sign-in attempt (OPERATOR, `timeout=600`)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/caterer-login.js --json
```

It checks the browser session and signs in only if needed. The last output line is JSON with `state` and `exitCode`. Look up the exit code in the decision table (8.3).

### 8.2 If it is a safe-list block: clear it with the newest e-mail link (HUMAN, then OPERATOR)

HUMAN: open the NEWEST e-mail from Caterer in the mailbox, copy the link (it contains `TwoFaAuthRedirect`) and paste it to the operator. It is single use and short-lived; it is not a password.

OPERATOR (put the pasted link between the quotes):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/caterer-login.js --open-link "<the link>"
```

Expect: `SAFELIST_CLEARED: signed in (...); session saved`, exit 0. If it prints `BAD_LINK`, the text was not the right kind of link; if it prints `SAFELIST_BLOCKED: the link did not clear the block`, the link was old or already used: the owner sends the newest one. At most two link attempts, then NO-GO for 60 minutes.

### 8.3 Decision table

| Observed | Meaning | Operator | Human | Verdict |
|---|---|---|---|---|
| exit 0, `SESSION_OK` or `Login complete` | signed in and the search page works | run 8.4 | none | GO after 8.4 |
| exit 2, `SAFELIST_BLOCKED` (first time on this instance) | expected: a new device needs verification | do 8.2 once. Do NOT run 8.1 again | supplies the newest link | GO after 8.2 succeeds and 8.4 passes |
| exit 2 again after a good link, or a second block within a day | the saved browser identity is not persisting | STOP, report, do not retry | decides | NO-GO |
| exit 4, `CATERER_MODULE_ERROR` | the session is fine but Caterer's CV search is failing for this account (a known Caterer-side fault). Signing in again will not help | do not retry more than once per hour with `--check`; report | checks in a normal browser that the CV database opens; contacts Caterer if not | NO-GO for sourcing |
| exit 3, `CRED_MISSING`, `CRED_PLACEHOLDER` or `CRED_INVALID` | the credentials file is missing or not real (bundle or step 5 problem) | STOP; report the marker only | fixes `secrets/caterer-credentials.json` (own terminal) | NO-GO |
| exit 3, `LOGIN_FAILED` | wrong password, locked account or an unexpected page | STOP; the code already blocks retries for 10 minutes and holds for 3 hours after three failures | logs in from a normal browser to see what Caterer says | NO-GO |
| exit 1, `CHECK_ERROR` mentioning a name-resolution or network failure | the instance cannot reach Caterer | wait 5 minutes, rerun `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --no-browser` (H1, H6), then `--check` (8.4) once | none | NO-GO until it passes |
| any other outcome where the page says "Access Denied", or the browser gets HTTP 403 or 429 on `/login`, or preflight H6 returned 403 and the browser cannot open `/login` | Caterer's bot protection blocks this network address (a WAF block). This is not detected by a dedicated marker (UNVERIFIED-LIVE) | STOP. Do not retry more than once per hour: bursts prolong a block | reports to Caterer, decides on another network route | NO-GO |
| anything else | unknown | STOP and report the printed lines | | NO-GO |

### 8.4 GO criteria (all three, OPERATOR)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node scripts/caterer-login.js --check
```

Expect exit 0 and `SESSION_OK: already signed in`. Wait about two minutes and run the same command once more: exit 0 again.

```
ls -l /opt/data/profiles/resourcer/workspace/resourcer/state/caterer-session.json
```

Expect: the file exists, mode `-rw-------`. Never print it (it holds session cookies).

GO means all three are true. Record `GO` or `NO-GO` and the reason in the progress table.

If NO-GO: continue with steps 9 and 10, but in step 9 do NOT resume `resourcer-queue-due`, `resourcer-tick`, `resourcer-preflight` or `resourcer-keepalive`. Tell the owner what is needed to turn NO-GO into GO.

Idempotent: `--check` yes. The sign-in itself: only with the waits above.

## 9. Create the cron jobs (paused), prove alert delivery, enable in order

Goal: the eight supervision jobs exist, the human really receives alerts, and only then the jobs are switched on, in order. The jobs are no-agent scripts: no model is involved and they cost nothing.

### 9.1 Scheduler settings (OPERATOR)

```
hermes -p resourcer config set timezone Europe/London
```

```
hermes -p resourcer config set cron.wrap_response false
```

```
hermes -p resourcer config get cron.script_timeout_seconds
```

Expect the third to print a number of 3500 or more, or an empty/default value (default 3600). If it prints a number below 3500: `hermes -p resourcer config set cron.script_timeout_seconds 3600`.

### 9.2 Install the wrapper scripts as real files (OPERATOR)

```
mkdir -p /opt/data/profiles/resourcer/scripts
```

```
cp /opt/data/profiles/resourcer/workspace/hermes/scripts/resourcer-*.sh /opt/data/profiles/resourcer/scripts/
```

The copy keeps the mode stored in the repository, and files published from Windows are stored without the executable bit, so the wrappers can land as mode 644. Hermes starts each wrapper directly, and a 644 file fails on its first run with `Permission denied` (exit 126), for all eight jobs. Set the mode (a change in the profile, outside the repository tree; always do it, even if the modes look right):

```
chmod 755 /opt/data/profiles/resourcer/scripts/resourcer-*.sh
```

```
sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --offline --no-browser
```

Expect E10 PASS ("all 8 cron wrappers installed as executable regular files identical to the repository"), E11 PASS, E12 PASS. An E10 FAIL that says `not executable` means the `chmod` did not take: report the line and do not go on. Hermes rejects symlinks that leave the scripts folder, so copy, never link.

From now on `check-manifest.js` also compares the installed wrappers, `SOUL.md`, `AGENTS.md` and the skill (see 2.8):

```
node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js
```

Expect `MANIFEST_OK` and the note `installed wrappers compared in /opt/data/profiles/resourcer/scripts`; any `INSTALLED_CHANGED` line is a STOP; an `INSTALLED_MISSING` line names a profile file of step 6.4 that is not installed (report it). The plugin is still reported as `not compared (not found...)` until step 10.

### 9.3 Prove what a cron run really sees (OPERATOR)

A throwaway job runs the preflight script in a report mode that prints only names and paths. Create it, run it, read it, remove it. It is the only job of this install that is created with `--deliver local` (its output is read from a file, and it is removed again below); the eight real jobs of 9.5 never are.

```
cp /opt/data/profiles/resourcer/workspace/tools/preflight.sh /opt/data/profiles/resourcer/scripts/resourcer-envprobe.sh
```

```
chmod 755 /opt/data/profiles/resourcer/scripts/resourcer-envprobe.sh
```

```
hermes -p resourcer cron create "every 30m" --no-agent --script resourcer-envprobe.sh --name resourcer-envprobe --deliver local --paused --workdir /opt/data/profiles/resourcer/workspace/resourcer
```

```
hermes -p resourcer cron run resourcer-envprobe
```

If `cron run` complains that no scheduler is available, use `hermes -p resourcer cron tick` instead. Wait a minute, then find the newest output file and read it:

```
ls -t /opt/data/profiles/resourcer/cron/output/*/*.md
```

Take the first path listed (the newest) and print it with `cat`. Expect, among other lines:

- `ENVPROBE HERMES_HOME=/opt/data/profiles/resourcer ... match=yes`
- `ENVPROBE temp-dir=<dir> exists=yes writable=yes`. `ENVPROBE TMPDIR=unset (the default /tmp is used)` is acceptable, because then `/tmp` is the temp folder and the line above must say `temp-dir=/tmp exists=yes writable=yes`; if `TMPDIR` is set, its `length=` must be 61 or less
- one `ENVPROBE tool <name>=<path>` line each for `node`, `timeout` and `xvfb-run`, none of them `MISSING` (`chromium`, `hermes` and `xauth` may show `MISSING` in the scrubbed environment; report it)
- `ENVPROBE profile-env-file=readable`
- `ENVPROBE AI_GATEWAY_API_KEY in the process environment: absent` (correct: the code reads the profile file itself)
- `ENVPROBE_DONE`

Then run the job a second time (`hermes -p resourcer cron run resourcer-envprobe`), wait a minute, read the newest output the same way. Expect `DETACHED-SLEEPER pid=... SURVIVED the end of the previous run`. If it says `GONE`, a process started by one cron run does not outlive that run (this was measured on the instance, and the supervisor is built for it): the tick launches no new run after minute 38 and waits for the run it launched, so a run that ends by minute 56 completes; only a run that cannot finish by minute 56 is ended cleanly and retried later (alert `tick-hard-cap`, `docs/OPERATIONS.md` section 2). Report it to the owner as a known risk (`docs/ACCEPTANCE.md` item SU03).

STOP and report if `match=NO` (HERMES_HOME differs), if `temp-dir=... writable=NO`, or if `TMPDIR` is set and not writable. An unset `TMPDIR` is not a failure by itself.

Clean up:

```
hermes -p resourcer cron remove resourcer-envprobe
```

```
rm /opt/data/profiles/resourcer/scripts/resourcer-envprobe.sh
```

```
rm -f /opt/data/profiles/resourcer/cron-envprobe.state
```

### 9.4 HUMAN: choose and configure the alert channel (blocking)

The pipeline reports problems as text. Some need a human within hours (a Caterer verification link, a halt, low credits). A job that delivers to `local` only saves files under `cron/output/` and its failure notices are suppressed: nobody would be told. So none of the eight jobs is ever created with `local` (only the throwaway probe of 9.3 was). The owner must:

1. Choose a channel that reaches the phone within minutes at 06:00 (a chat app, or e-mail only if it is read before 09:00).
2. Configure it in Hermes for the `resourcer` profile (dashboard channels/messaging settings; if Hermes needs a restart to activate it, that is a portal action for the owner, never for the operator).
3. Give the operator the exact target text that `--deliver` accepts, for example `telegram:<chat>` or `email:<address>` (the platform and format come from Hermes; the operator does not guess it). Call it T below. A delivery target is not a secret; if what the owner pastes looks like a token or a password, STOP: it is not a target.

Write T in the progress table. Alert delivery is blocking: no job is resumed until 9.7 passes (the alert job itself is the one exception, see 9.7). If the owner cannot set up any channel today, stop the install here and record "no alert channel" in the table; only the owner may waive it, in writing in this chat, and the waiver is listed in `docs/ACCEPTANCE.md` as an open risk.

### 9.5 Create the eight jobs, all paused, with the target (OPERATOR)

`hermes/cron/jobs.json` is the source of truth: each job's `cliPaused` string is the command, with `<DELIVER_TARGET>` standing for T. The eight commands below are those strings, in that order of creation. If a command below differs from its `cliPaused` string in that file, the file wins: report the difference.

Before you run any of them, replace every `<DELIVER_TARGET>` with T exactly (each command has two: `--deliver` and `--failure-deliver`, sixteen places in all). Left unchanged, the shell rejects `<DELIVER_TARGET>` as a redirection, on purpose. Do not create a job with `local`, and do not leave `--failure-deliver` out: the failure notice is the only night-time signal when a script crashes. The alert job runs every five minutes around the clock, so a critical alert raised at night reaches the owner within five minutes; the tick and the queue jobs keep their own hours.

First confirm that this Hermes knows the flags (it prints help only):

```
hermes -p resourcer cron create --help
```

Expect the flags `--name`, `--deliver`, `--failure-deliver`, `--no-agent`, `--script`, `--workdir` and `--paused`. If one is missing, STOP and report; do not drop it.

Run all eight:

```
hermes -p resourcer cron create "* 5-23 * * *" --no-agent --script resourcer-tick.sh --name resourcer-tick --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "*/5 5-21 * * *" --no-agent --script resourcer-queue-due.sh --name resourcer-queue-due --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "50 5 * * *" --no-agent --script resourcer-preflight.sh --name resourcer-preflight --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "0 23,2,5 * * *" --no-agent --script resourcer-keepalive.sh --name resourcer-keepalive --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "*/5 * * * *" --no-agent --script resourcer-alerts.sh --name resourcer-alerts --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "10 4 * * *" --no-agent --script resourcer-maintenance.sh --name resourcer-maintenance --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "20 4 * * *" --no-agent --script resourcer-retention.sh --name resourcer-retention --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

```
hermes -p resourcer cron create "30 3 * * *" --no-agent --script resourcer-backup.sh --name resourcer-backup --deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /opt/data/profiles/resourcer/workspace/resourcer --paused
```

### 9.6 Verify the jobs, and how to change a target later (OPERATOR)

```
hermes -p resourcer cron list
```

Expect: all eight names (`resourcer-tick`, `-queue-due`, `-preflight`, `-keepalive`, `-alerts`, `-maintenance`, `-retention`, `-backup`), each shown as paused, schedules as in 9.5 (in particular `*/5 * * * *` for the alert job, which is why night-time criticals arrive within five minutes), the delivery target T shown where the list shows it, and no other job of yours left over (the probe of 9.3 is gone). If a creation is refused with a message like `Blocked: command or referenced script cannot restart, stop, or uninstall the gateway`, STOP: a wrapper contains text the scan rejects; report the file (preflight E12).

```
hermes -p resourcer cron list | grep -c -w local
```

Expect `0` (grep also exits 1 when it counts nothing; that is the good result here). A higher count means a job still delivers to `local`; fix it with the edit command below.

To change one job's target later (a wrong target text, or a new channel), learn the exact flags first, then edit:

```
hermes -p resourcer cron edit --help
```

Expect flags including `--deliver` and `--failure-deliver`; if they are named differently, use those names and report it. Then, with the new target N and the job name in place of `<name>`:

```
hermes -p resourcer cron edit <name> --deliver N --failure-deliver N
```

Do not edit the profile's cron store by hand.

Idempotent: no. A second create makes a duplicate. If a job already exists, do not create it again: `hermes -p resourcer cron list` first. To fix a mistake, remove that one job with `hermes -p resourcer cron remove <name>` and create it again.

### 9.7 Prove delivery with a test alert (OPERATOR + HUMAN, blocking)

The test alert is a critical line in the outbox (critical alerts are delivered at any hour, with no personal data in it). First show the line it will produce; this changes nothing:

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/alerts-deliver.js --test --dry-run
```

Expect one line `[CRITICAL hh:mm] TEST ALERT from alerts-deliver.js --test: ...`. Now queue it for real (it also prints the same line):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/alerts-deliver.js --test
```

Show everything the alert job would deliver next (changes nothing):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/alerts-deliver.js --dry-run
```

Expect the test line (older alerts from steps 7 and 8, such as a safe-list notice, may be listed too; they are expected and will reach the owner too).

Now deliver it through the real path. The alert job is the one job that is switched on before the test passes, because the test needs it:

```
hermes -p resourcer cron resume resourcer-alerts
```

```
hermes -p resourcer cron run resourcer-alerts
```

(If `cron run` complains that no scheduler is available, use `hermes -p resourcer cron tick` instead.) Then check the local audit trail:

```
grep -c 'alerts-test' /opt/data/profiles/resourcer/workspace/resourcer/outbox/alerts-delivered.jsonl
```

Expect `1` (a higher number only if you queued the test more than once). HUMAN: confirm in chat that a message starting `[CRITICAL` and containing `TEST ALERT` arrived on the channel, and how long it took. Wait up to 10 minutes.

If the count is at least 1 but the owner received nothing: the channel or the target text is wrong; look at `hermes -p resourcer cron runs resourcer-alerts --limit 3` and the newest output file under `/opt/data/profiles/resourcer/cron/output/`, fix the target with the owner (9.4, then the edit command of 9.6 for all eight jobs), and repeat this step from `--test` (each test carries a fresh event id, so the second one is not swallowed by the repeat rule). If the count is 0: the job did not run the script: report the run listing.

Do not go on until the owner confirms receipt.

### 9.8 Decisions before the first run (HUMAN)

- H10: the first live run spends Caterer credits and creates real records in Zoho Recruit.
- H9b, Reed timing. Territories that are processed while Reed is off do not get their Reed half later by themselves (nothing re-runs them automatically; since the release the owner can have them found and re-queued a few a day with `tools/reed-catchup.js`, `docs/OPERATIONS.md` 8.1, at the cost of re-running the whole territory; about a third of the Zoho-linked candidates historically came from Reed). Choose: (A) start Caterer-only now and add Reed at step 12 (default), or (B) do step 12 first (Reed needs the owner for about 30 minutes and may be blocked by a bot check), then come back to 9.9.
- Only if step 8 was GO: resume the sourcing jobs. Otherwise resume only alerts, backup, maintenance and retention.

Optional but recommended (OPERATOR): queue one small first search so the first run is short and identifiable. Use the postcode from the owner (H11); `<OUTWARD>` is an outward code such as `M1`:

```
cd /opt/data/profiles/resourcer/workspace && node tools/request-search.js --job "Chef" --location <OUTWARD> --sources caterer --priority high --cv-limit 10 --dry-run
```

Expect `VALID: Chef | <OUTWARD> (dry run, nothing written)`. Then the same command without `--dry-run`. Expect `QUEUED: search-...json (position 1 ...)`. Exit 3 means the same search is already queued (fine).

### 9.9 Enable the jobs, in this order (OPERATOR)

Run each command, then check `hermes -p resourcer cron list` shows the job enabled before you go on. The alert job was already resumed by the test in 9.7 (`resume` of an enabled job is harmless); run the command anyway so the order is on record.

```
hermes -p resourcer cron resume resourcer-alerts
```

```
hermes -p resourcer cron resume resourcer-queue-due
```

```
hermes -p resourcer cron resume resourcer-tick
```

Enable the tick soon after the alert job (which has been running since 9.7): inside 06:00 to 22:00 London the alert job raises a critical `tick-silent` alert when it has not seen a tick heartbeat for ten minutes, so if the decisions of 9.8 took longer than that, the owner may already have received one. It is true, it needs no action, and it clears itself once the tick runs. With the tick deliberately paused (a NO-GO in step 8) that alert repeats hourly: either accept it or pause `resourcer-alerts` again (`hermes -p resourcer cron pause resourcer-alerts`) until the NO-GO is resolved.

Now stop and verify the supervisor is alive (within two minutes; new runs only start between 06:00 and 22:00 London):

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect JSON with `"inOperatingHours"` (true or false), `"halt": null`, `"lastTickAt"` less than two minutes old (between 05:00 and 23:59 London the tick job fires every minute), `"consecutiveFailures": 0` and `"queueDepth"` of at least 1 (your small search, plus whatever was due). `"tick"` is normally `null`, and that is healthy: it describes a tick process that is executing at that very moment, and a tick with nothing to start ends in well under a second (its log says `tick end: gate-no_work` or `outside-window`). It is non-null (`"alive": true` and a small `"heartbeatAgeSec"`) only while a run is being supervised. Judge the job by `lastTickAt` and by `hermes -p resourcer cron runs resourcer-tick --limit 3` (recent runs about a minute apart, exit 0), never by `tick` being non-null. If `lastTickAt` is `null` or older than two minutes after three minutes of waiting (between 05:00 and 23:59 London), the job is not running: check `hermes -p resourcer cron list` and `hermes -p resourcer cron runs resourcer-tick --limit 3`, report, and do not continue.

Then the nightly jobs:

```
hermes -p resourcer cron resume resourcer-backup
```

```
hermes -p resourcer cron resume resourcer-maintenance
```

```
hermes -p resourcer cron resume resourcer-retention
```

```
hermes -p resourcer cron resume resourcer-keepalive
```

```
hermes -p resourcer cron resume resourcer-preflight
```

Verify:

```
hermes -p resourcer cron list
```

Expect eight jobs, all enabled (four if step 8 was NO-GO, with `-queue-due`, `-tick`, `-keepalive`, `-preflight` still paused), each with the target T of 9.4. Run `node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js`: expect `MANIFEST_OK` and no `INSTALLED_CHANGED`.

Pause or resume one job with `hermes -p resourcer cron pause <name>` / `resume <name>`; never the host-wide pause.

Idempotent: `resume` of an enabled job is harmless.

## 10. Install the dashboard plugin

Goal: the "Resourcer" tab appears in the Hermes dashboard for the `resourcer` profile, with live progress and the halt button. The plugin lives at machine level in `/opt/data/plugins/resourcer`, and must be enabled in TWO places (the dashboard's own configuration and the profile's), otherwise either the tab or its data is missing. The plugin can only read the resourcer workspace; it never starts pipeline work.

### 10.1 Copy (OPERATOR)

```
mkdir -p /opt/data/plugins
```

Upgrade only: if `/opt/data/plugins/resourcer` already exists, move it aside first (no recursive delete; the target folder is the one made in 0.7):

```
mv /opt/data/plugins/resourcer /opt/data/profiles/resourcer/install-work/plugin-previous-$(date -u +%Y%m%d-%H%M%S)
```

```
cp -r /opt/data/profiles/resourcer/workspace/plugin/resourcer /opt/data/plugins/resourcer
```

```
ls /opt/data/plugins/resourcer/plugin.yaml /opt/data/plugins/resourcer/dashboard/manifest.json /opt/data/plugins/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/dist/index.js
```

Expect all four listed.

### 10.2 Enable in both places (OPERATOR, first command HUMAN-APPROVE)

The first command and the first verification command below have no `-p resourcer`. They are the only Hermes commands of this runbook that act on the machine-level (default home) plugin list instead of the resourcer profile, because the dashboard loads its plugins from there. They change or read nothing except the entry named `resourcer`. HUMAN-APPROVE: tell the owner that this touches the default home's plugin list (outside the resourcer profile, so it is an exception to the scope in the operator prompt), and wait for a yes in this chat before you send it; if Hermes also shows an approval prompt, the owner approves that too. Run these two commands for the plugin `resourcer` only, and never edit, disable or list anything else in that home.

```
hermes plugins enable resourcer
```

```
mkdir -p /opt/data/profiles/resourcer/plugins
```

```
ln -sfn /opt/data/plugins/resourcer /opt/data/profiles/resourcer/plugins/resourcer
```

```
hermes -p resourcer plugins enable resourcer
```

Verify (the first is the other command without `-p`; it only reads):

```
hermes plugins list --enabled
```

```
hermes -p resourcer plugins list --enabled
```

Expect `resourcer` in both. If either enable is refused, STOP and report the message; a fallback exists (10.6) but only with the owner's say-so.

### 10.3 HUMAN: restart the dashboard

The plugin's backend is loaded once when the dashboard starts, so the first enable needs a dashboard restart. The owner presses Restart for the dashboard in the Hermes portal (or the System page), then reopens the Chat tab. The operator must not restart it: the dashboard may be the very connection the operator's chat uses.

### 10.4 Verify (OPERATOR)

```
curl -s "http://127.0.0.1:9119/api/dashboard/plugins?profile=resourcer"
```

Expect a JSON list containing an entry whose name is `resourcer`. If curl cannot connect, the dashboard is on another port or address: ask the owner; do not guess.

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/api/plugins/resourcer/health
```

Expect `401` (mounted, behind the dashboard login) or `200`. `404` means the plugin backend is not mounted: enable was missed in one place, or the dashboard was not restarted.

```
ls /opt/data/logs
```

If `errors.log` is listed:

```
grep -E "Mounted plugin API routes: /api/plugins/resourcer/|Failed to load plugin resourcer" /opt/data/logs/errors.log | tail -n 3
```

Expect `Mounted plugin API routes: /api/plugins/resourcer/`. A `Failed to load plugin resourcer` line: STOP and report it.

Search validation only (writes nothing):

```
cd /opt/data/profiles/resourcer/workspace && node tools/request-search.js --job "Chef" --location LS1 --dry-run
```

Expect `VALID: Chef | LS1 (dry run, nothing written)`.

HUMAN, in the logged-in dashboard: open the "Resourcer" tab. The status strip, "Live progress" and "Targets" panels fill within about 5 seconds; a red banner appears only when the pipeline is halted. In the browser console, `window.__HERMES_PLUGIN_SDK__.fetchJSON("/api/plugins/resourcer/health").then(console.log)` prints an object with `ok: true`. If the tab is missing or empty, see the troubleshooting table in `plugin/resourcer/README.md`.

Then `node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js`: expect `MANIFEST_OK` and no `INSTALLED_CHANGED` for the plugin.

### 10.5 Upgrades and rollback

Upgrade: repeat 10.1 (with the move-aside), then a dashboard restart (10.3) if `plugin_api.py` changed; files under `dist/` need only a browser reload. Rollback: `hermes plugins disable resourcer` (the same machine-level exception as 10.2: HUMAN-APPROVE, plugin `resourcer` only), `hermes -p resourcer plugins disable resourcer`, move `/opt/data/plugins/resourcer` aside with `mv`, HUMAN restarts the dashboard.

### 10.6 Fallback if `plugins enable` is refused (only with the owner's approval)

The scratch folder made in 0.7 must exist (`ls -d /opt/data/profiles/resourcer/install-work`; if it does not, do 0.7 now). Use your file-write tool to create `/opt/data/profiles/resourcer/install-work/enable-plugin.py`:

```
from hermes_cli.config import load_config, save_config
cfg = load_config()
plugins = cfg.setdefault("plugins", {})
enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []
if "resourcer" not in enabled:
    enabled.append("resourcer")
plugins["enabled"] = enabled
save_config(cfg)
print("enabled ->", plugins["enabled"])
```

The interpreter is the one named on the first line of the `hermes` launcher (usually `/opt/hermes/.venv/bin/python`). Run it once per home:

```
HERMES_HOME=/opt/data /opt/hermes/.venv/bin/python /opt/data/profiles/resourcer/install-work/enable-plugin.py
```

```
HERMES_HOME=/opt/data/profiles/resourcer /opt/hermes/.venv/bin/python /opt/data/profiles/resourcer/install-work/enable-plugin.py
```

Then `rm /opt/data/profiles/resourcer/install-work/enable-plugin.py` and continue with 10.3.

Idempotent: yes.

## 11. First-cycle verification (what to watch and what should exist)

Goal: one complete run, end to end, checked by the operator and the owner, before you call the install finished. This is where the live behaviours that no offline test could prove are seen for the first time.

New runs start only between 06:00 and 22:00 London. Outside that window the supervisor stays idle: check `"inOperatingHours"` in the status output and wait.

### 11.1 Timeline

| When | Command | Expect |
|---|---|---|
| within 2 minutes of the tick being enabled | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status` | `lastTickAt` under 2 minutes old, `halt` null, `cooldownUntil` null, `consecutiveFailures` 0. `tick` is normally `null` (no tick process is executing at that instant); judge by `lastTickAt`, not by `tick` |
| within 5 minutes of the window opening (or of enabling) | `tail -n 30 /opt/data/profiles/resourcer/workspace/resourcer/logs/tick-$(date -u +%Y%m%d).log` | a line `READY (<job>, queueDepth=N) - started watchdog-runner (pid P)` |
| while it runs (15 to 45 minutes) | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status` again | `run` is not null, `run.alive` true, `busy` true; `tick` is now normally non-null too (`alive` true, small `heartbeatAgeSec`) because a tick process is supervising the run |
| while it runs | `ls -t /opt/data/profiles/resourcer/workspace/resourcer/runs` | a new `phase1-<time>.json` (status moves through `phase1_initializing`, `phase1_running`, `phase1_complete`, then `complete`) |
| while it runs | `tail -n 20 /opt/data/profiles/resourcer/workspace/resourcer/logs/watchdog-runner.jsonl` | events `picked`, `marked-spawned`, `init-status`, `params-written`, `phase1-start` and no `session-stale` or `fatal` |
| at the end | tick log | `runner finished a run (exit 0) - re-checking gate immediately for next territory` |
| at the end | `cat /opt/data/profiles/resourcer/workspace/resourcer/runtime/last-run.json` | `"exitCode":0`, counts for `pool` and `approved` (numbers only) |
| at the end | `ls -t /opt/data/profiles/resourcer/workspace/resourcer/downloads` | `approved-queue-<time>.json` and `phase2-results-<time>.json` (do not open them: they hold personal data); only a few `cv-...` files at most |
| at the end (once the run approved candidates) | `ls /opt/data/profiles/resourcer/workspace/resourcer/shadow` | `cv-<date>.jsonl` next to `screening-<date>.jsonl`: the CV stage (shadow) screened the downloaded CVs; nothing was blocked. Its numbers: `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 1 --mode shadow` |
| at the end | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/alerts-deliver.js --dry-run --digest` | today's pulled count, runs, errors, credits; no unexpected critical alert |
| at the end | the small first search | its file is gone from `pending-searches/` (`ls /opt/data/profiles/resourcer/workspace/resourcer/pending-searches`) |

### 11.2 Numbers to record

- Memory: at the start, in the middle and at the end of the run, `grep MemAvailable /proc/meminfo`. Note the lowest value (`docs/ACCEPTANCE.md` item SU10).
- Caterer credits: the owner reads the balance in Caterer before and after; the drop should equal the candidates unlocked.
- Duration of the run and the count approved, unlocked, pushed.

### 11.3 HUMAN: check Zoho Recruit

In Zoho Recruit open the candidates created today. Check three records: name, e-mail and phone present; the City field holds a place name (not a postcode); a CV is attached and opens; no duplicate of an older record. Report the counts.

### 11.4 If the first run does not look right

| Sign | Meaning | Action |
|---|---|---|
| tick log: `session back-off` or a `caterer-*` alert, `cooldownUntil` set | Caterer session went stale | run `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/caterer-login.js --check` (8.4). If exit 2, do 8.2. Then `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --clear-cooldown` |
| run ends within minutes with `pool` 0 and one error | often the first run after a fresh sign-in; not systemic | do not queue more; run `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/caterer-login.js --check`; wait for the next run; if it repeats, STOP and report |
| `halt` set in `--status`, red banner | AI screening is down | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-halt-cli.js get`; the reason names the cause (key, credits, gateway); nothing is consumed while halted |
| `territory ... failed N run(s) in a row` or a `territory-quarantined` alert | one search keeps failing and was set aside so the queue continues | report the file name and the last lines of `logs/phase1-console-*.log`; do not edit anything; release with `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --release-quarantine <file>` only after the owner fixed the cause |
| exit 13, `run-killed` | the run hit the 70-minute ceiling | report; check for a stuck page in the console log |
| `zoho-push-failing` alert | Zoho rejected creates | the owner checks Zoho credentials and API quota; the candidates stay queued for recovery |
| memory under 900 MB during a run | the other profile is busy | report the numbers |

### 11.5 Next morning

- `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/backup-db.js --check-age` exits 0 (the 03:30 backup ran); `--list` shows one encrypted file.
- The 05:50 pre-flight and the night keep-alive left `logs/preflight-<date>.log` / `logs/keepalive-<date>.log` and no alert.
- The 07:00 "alive" line and, later, the 18:00 digest reach the owner's channel.
- `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --final` ends with `fail=0`.

Then go to `docs/ACCEPTANCE.md` and work through it. The install is finished when every GATE item there is PASS or waived by the owner in writing. Keep watching the WATCH items for the first week.

## 12. Reed (later, human-assisted)

Reed stays OFF (`RESOURCER_SOURCES=caterer`) until the owner has done a one-time login. Do this only after the Caterer side has run cleanly, unless the owner chose option B in 9.8. It needs the owner for about 30 minutes and a way to reach the instance's local browser port from the owner's computer (Hermes Cloud has no documented remote shell: this route is UNVERIFIED-LIVE; if the owner has no route, Reed stays off. That is an accepted limit, see `docs/KNOWN-LIMITS.md`).

Preconditions: memory available is at least 1500 MB (preflight B2 without warning); preflight H1 shows `GB` (a session created outside the UK is refused with HTTP 451); `secrets/reed-credentials.json` exists (E7); do it after 22:00 London with no run in flight (`--status` shows `run: null`).

### 12.1 Check the credential file and the browser (OPERATOR)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cdp-reed-full-login.js --check-credentials
```

Expect: it reports the credentials as usable (names only). `reed-credentials` problems are the owner's to fix.

```
sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh --reed
```

Expect: D4, D8 and D9 PASS (virtual display tools present, Chromium stays up under them).

### 12.2 The human login (OPERATOR starts, HUMAN acts)

Start it as a background terminal task (it waits up to 30 minutes and prints `REED_LOGIN_OK` when done):

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cdp-reed-full-login.js --human
```

It prints the port to forward and the steps. HUMAN, from the owner's own computer: forward the browser port as printed (`ssh -N -L 9222:127.0.0.1:9222 <user>@<instance-host>`), open `chrome://inspect/#devices`, add `localhost:9222`, inspect the Reed login page and log in there (solve the check, password, two-step code). Add `--clean` to the command only if an earlier alert said HTTP 451.

Expect: `REED_LOGIN_OK expires=<time> ip=<address>` and exit 0.

### 12.3 Check and switch on (OPERATOR)

```
cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/reed-api-client.js --auth-state
```

Expect: status ok, no login block, no hold. Optional offline proof that the browser launcher works with the real Chromium (from the repository root):

```
cd /opt/data/profiles/resourcer/workspace && NODE_PATH=/opt/data/profiles/resourcer/workspace/resourcer/node_modules REED_REAL_CHROMIUM=/usr/bin/chromium node --test "tests/reed/real-chromium.test.js"
```

HUMAN decision (H9b): switch Reed on:

```
hermes -p resourcer config set RESOURCER_SOURCES both
```

Queue one small Reed-and-Caterer search and watch its run as in step 11:

```
cd /opt/data/profiles/resourcer/workspace && node tools/request-search.js --job "Chef" --location <OUTWARD> --sources both --priority high --cv-limit 10
```

Expect, after the run: `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/reed-api-client.js --auth-state` still ok; `runtime/reed-status.json` reads ok; no `reed-*` alert; after the run no Chromium or virtual display left (`node /opt/data/profiles/resourcer/workspace/resourcer/scripts/ensure-chrome-cdp.js --status` prints `"cdp":false` and exits 1, and the tick log shows the Reed browser was stopped). If the owner wants to go back: `hermes -p resourcer config set RESOURCER_SOURCES caterer`.

Alerts you may see: `reed-human-login` (a bot check again: repeat 12.2), `reed-credentials` (owner fixes the file), `reed-451` (repeat 12.2 with `--clean`, and check the egress country).

## 13. Reading how Jev is doing (and what is not promoted)

Not part of the install. Jev decides alone (`SCREEN_ENGINE=jev_only`); there is no language model, so there is nothing to promote and no go/no-go gate: the report says "not applicable in jev_only mode". What the operator can produce after a few weeks is the Jev-only report of `docs/SCREENING.md` section 16.7 (`node /opt/data/profiles/resourcer/workspace/tools/screening-report.js`): the lane distribution, the approval rate by role and source, the share Jev decided itself (the owner requires at least 99 percent, so the share taken by the review policy should be near zero), and the forced share (decisions taken in real doubt, about a sixth). For the CV stage, `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/cv-report.js --days 7 --mode shadow` (`docs/CV-SCREENING.md` section 7). Changing the review-policy switches, the criteria files, the operating points or `CV_SCREEN` is the owner's decision alone. The canary rows written in step 7 carry the run ids `install-canary` and `install-canary-zdr` and can be ignored.

## Appendix A. What this install changes on the instance

| Where | What |
|---|---|
| `/opt/data/profiles/resourcer/deploy/` | deploy key pair, pinned GitHub host key (mode 700) |
| `/opt/data/profiles/resourcer/workspace/` | the repository; `AGENTS.md` copied in (6.4); `resourcer/node_modules/` (step 3) |
| `/opt/data/profiles/resourcer/workspace/resourcer/` | `candidates.db`, `config/`, caches, `pending-searches/`, `secrets/` (700), later `runs/ downloads/ logs/ runtime/ outbox/ shadow/ state/ backups/` |
| `/opt/data/profiles/resourcer/bin/agent-browser` | the pinned browser tool |
| `/opt/data/profiles/resourcer/.env` | secrets and settings entered through the Keys page and `hermes config set` |
| `/opt/data/profiles/resourcer/scripts/resourcer-*.sh` | eight cron wrappers (mode 755, 9.2); the throwaway `resourcer-envprobe.sh` of 9.3 is removed again |
| Hermes cron store of the profile | eight jobs |
| `/opt/data/profiles/resourcer/SOUL.md`, `skills/ops/resourcer-ops/` | identity and skill |
| `/opt/data/plugins/resourcer/`, `/opt/data/profiles/resourcer/plugins/resourcer` (link) | dashboard plugin |
| the plugin list of the default Hermes home (`/opt/data/config.yaml`) | the entry `resourcer` added by `hermes plugins enable resourcer` (10.2, the one machine-level change; nothing else there is read or changed) |
| `/opt/data/profiles/resourcer/install-work/` | scratch folder made in 0.7 (mode 700) for the few files of this install; may be emptied with `rm` on each file |

Nothing is installed system-wide and nothing outside `/opt/data` is written.

## Appendix B. Quick reference of the commands the operator may use again later

| Purpose | Command |
|---|---|
| health at a glance | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status` |
| integrity of the code | `node /opt/data/profiles/resourcer/workspace/tools/check-manifest.js` |
| environment probes | `sh /opt/data/profiles/resourcer/workspace/tools/preflight.sh` |
| Caterer session check | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/caterer-login.js --check` |
| clear a Caterer back-off after the owner fixed the session | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --clear-cooldown` |
| halt state | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-halt-cli.js get` |
| what would be alerted / today's numbers | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/alerts-deliver.js --dry-run --digest` |
| backup age | `node /opt/data/profiles/resourcer/workspace/resourcer/scripts/backup-db.js --check-age` |
| jobs | `hermes -p resourcer cron list` |
