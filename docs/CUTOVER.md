# CUTOVER: moving the resourcer from the laptop to Hermes

Audience: you, the owner, at the laptop, today, under time pressure. Every command here is meant to be typed by you in a normal PowerShell window (not admin). This page covers the laptop side and the human decisions; the work on the Hermes instance is done by the operator agent following `docs/INSTALL.md`, and you only step in where step 7 says so.

Companion pages: `docs/ROLLBACK.md` (going back), `docs/TEARDOWN.md` (destroying the transfer repo afterwards), `docs/OPERATIONS.md` (day 2), `docs/INSTALL.md` (the operator's runbook), `docs/SECURITY.md`.

Paths used below (PowerShell):

```ps1
$LEGACY = Join-Path $env:USERPROFILE '.openclaw\workspace-resourcer'
$REPO   = Join-Path $env:USERPROFILE '.openclaw\hermes-port\repo'
```

## 0. The ground rules (read once, 2 minutes)

1. Never run the old system and Hermes against Caterer, Reed and Zoho at the same time. They share one Caterer seat (each login logs the other out and triggers safe-list e-mails) and one candidate history (a candidate unlocked by the laptop after the snapshot is unknown to Hermes and gets screened, unlocked and pushed to Zoho twice). Step 1 stops the old system; nothing restarts it except a deliberate rollback.
2. You type the passphrases, in your own terminal. No AI assistant session, chat, e-mail, note or command line ever sees them. If you use Claude Code or any assistant on this laptop, do steps 3 and 4 in a plain PowerShell window instead.
3. The laptop is your rollback path until step 9 says otherwise. Do not wipe, rotate the Caterer, Reed or Zoho passwords, or delete anything from the old system before the gate in step 9 is met (the PAT revocation in step 9 is the one exception: do that early).
4. Every step below can be re-run. If a step prints STOP, do not continue until it is fixed.
5. The plaintext data never enters the repo. The only data file that is committed is `data/resourcer-bundle.enc`, encrypted with your passphrase. The step 5 scan proves nothing else is tracked.

## 1. Timeline and the short paths

Estimates (they include reading; "wait" means time you cannot shorten):

| Step | What | Typical | Worst case |
|---|---|---|---|
| 0 | Prepare: passphrases, accounts, decisions | 15 min | 30 min |
| 1 | Fence the old system (stop, disable jobs, halt) | 10 min | wait up to 70 min for a gap between runs (about 4 to 15 minutes is normal) |
| 2 | Verify it is idle (dry-run of the bundle tool) | 5 min | 10 min |
| 3 | Build and verify the encrypted bundle | 10 min | 15 min |
| 4 | Build the encrypted archive of the old system and copy it off the laptop | 20 min | 60 min (copy speed) |
| 5 | Commit and push to a new private GitHub repo, run the scan | 15 min | 30 min |
| 6 | Give `OPERATOR-PROMPT.md` to the Hermes agent | 5 min | 10 min |
| 7 | Install on Hermes (the agent works; you are needed for about 30 minutes in total, in short bursts) | 60 min | 150 min |
| 8 | Canary and go/no-go (login, first run, backup, alert) | 30 min | 90 min |
| 9 | Wipe gate, then credential rotation and the wipe itself | gate: same day or next morning; wipe 60 to 120 min | |

Laptop-side steps 0 to 6 take about 1.5 hours when nothing goes wrong and up to 3.5 hours when the fence has to wait for a run. Everything through step 8 takes about 3 to 6 hours in practice (8 hours in the worst case). The wipe comes after that.

If you have only N hours (the honest minimum for each):

| Time left before the laptop leaves you | Do this | What you accept |
|---|---|---|
| 30 minutes | Steps 1, 2, 3 (fence, verify, bundle), copy `data/resourcer-bundle.enc` to a place off the laptop, store the passphrase in your password manager, revoke the GitHub token (step 9, row 1). Skip 4 to 8. | The pipeline is DOWN until Hermes is installed from the bundle (about 140 new candidates a day are not pulled; the due territories catch up later, limited by the Caterer daily unlock ceiling). The old system code and its environment are lost with the wipe. |
| 1 hour | Add step 4 (archive) and copy it off the laptop. | Same downtime. You keep the old code, configuration and history in the archive. |
| 2 to 3 hours | Steps 0 to 6, then start step 7 and keep the laptop untouched (powered, fenced, not wiped) while the operator installs; you can leave the laptop after step 6 because step 7 needs only a phone or another computer. | You cannot roll back the wipe. Decide the wipe only after the step 9 gate. If the laptop must leave now unwiped, hand it over powered off and treat it as lost: ROLLBACK.md section B applies. |
| 4 to 6 hours | The full path through step 8, then the gate in step 9. | The overnight cycle (23:00 keep-alive, 05:50 re-login, 06:00 first run) is not yet proven when you wipe; if it fails on Hermes you fix forward (ROLLBACK.md section B). |
| Next morning | Do steps 0 to 8 today, keep the laptop fenced overnight, watch the 05:50 pre-flight and the 06:00 run, then wipe. | Nothing extra. This is the recommended path. |

## 2. Step 0: prepare (before you touch anything)

You need, in front of you:

- A password manager entry ready to hold three DIFFERENT passphrases (below).
- Your GitHub login (username and how you sign in). Not a token.
- The Hermes Portal login for the instance and access to its dashboard.
- A Vercel AI Gateway key with credit on it (screening runs through it; roughly one dollar a day at most, see `docs/SCREENING.md`). Check the balance now.
- The mailbox that receives the Caterer login address's mail (the Caterer safe-list link arrives there, and the Caterer address forwards to your own mailbox). Be able to open it during step 7.
- A decision on where alerts go (e-mail and/or Telegram) and where the off-instance encrypted database backup goes (an object-storage bucket in another provider account with a write-only key, or an e-mail address used only for backups). A backup on the same volume as the database does not survive loss of the instance (see `docs/DECISIONS.md` OD4, OD5).
- Roughly 10 GB free on the laptop, and somewhere off the laptop to put files (step 4).

Passphrases. You need three different secrets. Never reuse one for another, and never use a sentence you could forget or guess:

| Name | Protects | Used by | Length and form |
|---|---|---|---|
| Bundle passphrase | `data/resourcer-bundle.enc` (database, run history, three credential files, config) | you at step 3; the restore tool on the instance (from a file you create, see step 7) | 16 characters minimum with at least 8 different ones (the tool enforces both). Use 24 or more random characters or 6 or more random words. If the bundle sits in GitHub, the strength of this passphrase is the whole defence (the KDF is scrypt, about a third of a second per guess per core). |
| Archive passphrase | the encrypted archive of the old system | you at step 4 (and if you ever need to open it) | same rules |
| Backup passphrase | the nightly encrypted database backups on Hermes | Hermes (`BACKUP_PASSPHRASE` or `secrets/backup-passphrase`), you at any restore | same rules; it must ALSO exist off the instance (your password manager), or the backups are unreadable if the instance is lost |

Generate each in the password manager (preferred), or here (the value prints on screen once; copy it into the password manager and clear the screen):

```ps1
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
Clear-Host
```

Store each in the password manager AND write the three down on paper kept somewhere other than the laptop bag. Do not save them in a file inside `$REPO` (the repo would track it; step 5 catches that, but do not rely on the catch).

Check the repo is complete (STOP if any line says False):

```ps1
Set-Location $REPO
Test-Path .\OPERATOR-PROMPT.md, .\docs\INSTALL.md, .\tools\make-bundle.js, .\tools\archive-legacy.js, .\MANIFEST.sha256
node --version
```

## 3. Step 1: fence the old system

Goal: no run in flight, the watchdog stopped, the three scheduled jobs that also touch the Caterer seat disabled, and the halt file set to `migration`.

Why the wait: `pm2 stop` ends the watchdog AND, on Windows, its child processes (the runner and phase 1). A run killed during the Zoho push (Phase 2), or after unlocks, can leave unlocked candidates that were never pushed and that no later run will look at (their credits are spent; the database says "known"). The snippet below waits for a gap between runs and stops the watchdog in the same second.

1a. Look first (read only):

```ps1
pm2 list
```

`pipeline-watchdog` should say `online`; `chefsbay-dashboard` may stay online (a read-only view of the old system).

1b. Wait for a gap and stop the watchdog. Paste all of it:

```ps1
$LEGACY = Join-Path $env:USERPROFILE '.openclaw\workspace-resourcer'
$done = 'complete', 'error', 'phase1_abandoned', 'phase1_stale'

function Get-LegacyBusy {
    $runs = Join-Path $LEGACY 'runs'
    $files = @(Get-ChildItem -LiteralPath $runs -Filter 'phase1-*.json' -File) + @(Get-ChildItem -LiteralPath $runs -Filter 'run-*.json' -File)
    $files | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-90) } | ForEach-Object {
        $s = try { (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).status } catch { 'unreadable' }
        if ($s -notin $done) { '{0}  {1}' -f $_.Name, $s }
    }
}

Write-Host 'Waiting for a gap between runs (Ctrl+C to abort)...'
while (@(Get-LegacyBusy).Count -gt 0) { Start-Sleep -Seconds 1 }
pm2 stop pipeline-watchdog
pm2 save
Write-Host 'Stopped. Anything listed below was started in the last second and has been killed:'
Get-LegacyBusy
```

What the output means: the wait loop prints nothing while it waits. After `pm2 stop` the last command lists files only if a run started in the split second before the stop; such a run had not unlocked anything yet, and its leftover status file is harmless (step 2 deals with it). The check ignores files older than 90 minutes.

If you cannot wait (the run has been going for over 15 minutes, or the laptop must go now): press Ctrl+C, run `pm2 stop pipeline-watchdog` and `pm2 save` yourself, and accept that up to one run's worth of unlocked candidates (about 20) may never reach Zoho. Note the time; it goes in your notes for ROLLBACK.md.

The quiet time is after 22:00 London: the old watchdog starts no new runs then, so the wait is only the current run.

1c. Disable the three OpenClaw jobs that would otherwise keep using the same Caterer seat (they run inside the OpenClaw gateway, which must be running to change them):

```ps1
openclaw cron list
openclaw cron disable da4b812d-1da3-4b35-8870-a93ae5890ec2
openclaw cron disable 29bfeb15-38e6-4287-aca6-c736f6561d46
openclaw cron disable dccc2de4-baf0-4f32-936f-617ac0222fde
openclaw cron list
```

The three are named "Territory Scheduler", "Caterer Overnight Keep-Alive" and "Caterer Daily Pre-Flight". Check the names in the `list` output match the IDs before disabling (the IDs above were current on 2026-09-30). After the second `list` all three must show as disabled. Leave the other jobs alone: they belong to the main agent, not the resourcer. If the gateway is not running, these jobs cannot fire anyway; note that in your log and carry on.

1d. Set the halt to `migration` (the bundle tool's `--require-fence` looks for it, and the bundle records it as an audit trail; the old watchdog is stopped, so nothing clears it):

```ps1
node "$LEGACY\scripts\pipeline-halt-cli.js" set "migration" "Cutover to Hermes in progress. The old pipeline is stopped on purpose." "Do not clear until the cutover is finished or rolled back (docs/ROLLBACK.md)."
```

1e. If you reboot the laptop at any time before the wipe, run `pm2 list` afterwards and confirm `pipeline-watchdog` is still `stopped`. If it is `online`, stop it again and re-check step 2.

## 4. Step 2: verify the old system is idle

Run all three; every one must be clean.

```ps1
# a. pm2: pipeline-watchdog must read "stopped"
pm2 list

# b. no pipeline process is alive (prints nothing when clean). The watchdog daemon itself shows in pm2 as a generic node process, so it is not listed here.
Get-CimInstance Win32_Process |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'phase1-scrap[e]|run-pipelin[e]|reed-phase[1]|process-approved-queu[e]|watchdog-runne[r]|pipeline-watchdo[g]|ai-revie[w]' } |
  Select-Object ProcessId, Name

# c. the bundle tool's own dry run: checks the fence, integrity of the database and every file it would pack, reads the run history, and writes nothing
Set-Location $REPO
node tools\make-bundle.js --dry-run --require-fence --backfill-run-history "$LEGACY\downloads"
```

Expected from (c), among other lines:

```
pipeline check: no live run; halt file present (reason: migration)
run history: files=<n> parsed=<n> unreadable=<0 or 1> undated=0 inserted=<n> total_rows=<n>
  2026-09-28  files(new)= 239  run_results(new)= 239        (one line per day; the two numbers must be equal)
candidates.db: integrity ok, 6 tables: ... candidates=<n> ... run_results=<n> ...
DRY_RUN_OK nothing was written
```

`--backfill-run-history` reads the old `phase2-results-*.json` files (counts only, no names are printed or stored) and puts one row per run into the bundle's copy of the database, so the dashboard history, the 7-day burn and the retention gate work from the first day instead of starting empty. The old database itself is not changed. One unreadable file in thousands is normal; a per-day line whose two numbers differ is not: stop and look.

Write down the row counts on the `candidates.db:` line (candidates, candidate_rejections, territory_searches, reed_daily_usage, run_results). After the restore on Hermes they must match exactly.

STOP conditions:

- (b) prints a process: wait for it to end (`Get-Process -Id <id>` shows it) or, if it is stuck for over 20 minutes, end it with `Stop-Process -Id <id>` and accept the same small loss described in step 1.
- (c) says `LIVE` only because a status file left by a run you just killed is younger than 90 minutes, and (a) and (b) are clean: it is safe to continue with `node tools\make-bundle.js --dry-run --require-fence --backfill-run-history "$LEGACY\downloads" --i-paused-the-pipeline`; the tool then makes you type `I PAUSED THE PIPELINE` to confirm. Use the same flag at step 3.
- (c) says `integrity_check failed` or `required data file missing`: do not continue. Copy the whole line into your notes; the database is the most valuable thing you own here.

## 5. Step 3: build and verify the encrypted bundle

```ps1
Set-Location $REPO
node tools\make-bundle.js --require-fence --backfill-run-history "$LEGACY\downloads"
```

It asks for the bundle passphrase twice (hidden). A few seconds later it prints the run-history table and the file list (about 170 files: the database, three credential files, config, the caches, the pending searches) and ends with one line:

```
BUNDLE_OK out=...\data\resourcer-bundle.enc size=... sha256=... files=... chunks=...
```

The file is about 10 MB. The tool refuses to run while a run looks live (exit 4), asks for a typed confirmation with `--i-paused-the-pipeline`, extracts the Reed login from the old scripts without printing it, copies the database with SQLite's online backup, and before it finishes decrypts its own output and checks every hash. With `--require-fence` it also re-checks at the end that the halt is still there and that no run started and no database change happened while it was building (the old watchdog would clear a halt by itself, which is why step 1 stops the watchdog first). Warnings are printed and are normal (for example that `spawnedAt` was stripped from a pending search).

Now prove it from the outside (asks the passphrase once more):

```ps1
node tools\verify-bundle.js
```

It must end with `VERIFY_OK files=<n>` and print table counts equal to the ones you wrote down in step 2. Write down the `sha256=` value from the `BUNDLE_OK` line. Copy `data\resourcer-bundle.enc` to one place off the laptop now (step 4 lists them); at this point it is your only copy of the database that is safe from a laptop failure.

Exit codes if something goes wrong: 4 refused (a run looks live), 5 source problem (integrity check, a missing file, or the Reed login could not be read from the old scripts), 7 passphrase problem (shorter than 16 characters, the two entries differ, or no terminal).

## 6. Step 4: the encrypted archive of the old system

Purpose: a safety net, not part of the migration. It keeps the old configuration, scripts, skills, cron definitions, the agent workspaces and an online copy of the database, so that you can look something up later or rebuild. It is NOT a working system: the environment (Windows tasks, WSL, the OpenClaw sign-ins, the Reed browser profile) is not in it.

```ps1
Set-Location $REPO
node tools\archive-legacy.js --dry-run
node tools\archive-legacy.js
```

The dry run prints file counts by area and what is excluded (about 24,000 files and 205 MiB were counted on 2026-09-30; downloads, `node_modules`, `.git`, browser profiles, images, executables, raw database files, session cookies, old logs and this repository are left out). The real run asks for the archive passphrase twice, then writes `%USERPROFILE%\legacy-archive-<UTC time>.enc` (outside the repo, deliberately) and ends with `ARCHIVE_OK out=... size=... sha256=...`. It refuses (exit 4) to write inside the folder it archives, to overwrite an existing file without `--force`, or to build something over its size limit (`--max-total-mb`, default 2048). `.git` is excluded because the old repository's config holds a plaintext access token; add `--include-git` only if you want the code history, and only because the archive is encrypted.

The archive contains credentials and agent chat history. Treat it like the bundle: encrypted, off the laptop, passphrase in the password manager.

Check it decrypts, then copy it off the laptop:

```ps1
node tools\archive-legacy.js --list --archive "$env:USERPROFILE\legacy-archive-<time>.enc"
```

It asks the passphrase and prints `LIST_OK files=<n>`. `--extract <empty dir>` restores the files if you ever need them (mode 0600 for files, 0700 for directories).

Where to store it (at least two of these, one of them not a cloud account you sign into from this laptop):

| Acceptable | Notes |
|---|---|
| An external drive or USB stick kept at home or in a safe place | Encrypted content, so loss is not a disclosure; verify it reads back from another computer |
| Your personal cloud drive (OneDrive, Google Drive, Dropbox, iCloud) | Only after the upload finished and you saw the file on the web page from another device; the provider holds ciphertext only |
| An object-storage bucket you control (Backblaze B2, Cloudflare R2, S3) | Also a good home for the nightly database backups |
| Another computer you control | Copy with `scp` or a network share |

Not acceptable: leaving it only on this laptop (any drive, WSL, the Recycle Bin, a folder that only syncs later); only on the Hermes instance (one failure takes both); inside the transfer repo (it is destroyed on purpose, and step 5 would flag it); a shared drive other people can open; an e-mail attachment.

## 7. Step 5: commit and push to a new private GitHub repository

Only the encrypted bundle and the code go in. Do it with your own GitHub login through the browser. Never put a token in a command or in a URL: that is exactly how the old repository ended up with a live token in `.git/config`. Do not reuse the old `ChefsBayResourcer` repository.

A committed bundle stays in the repository's history for as long as the repository exists (and for a while after it is deleted), so its passphrase must be strong (step 0). If you would rather keep the bundle out of GitHub altogether, use the tarball route of `docs/INSTALL.md` 2.7 instead: you place `resourcer-repo.tar.gz` on the instance yourself, the bundle travels inside it or beside it, and the GitHub steps here and in `docs/TEARDOWN.md` (T3, T4, the deploy key) do not apply. The scan in 5c is still worth running on the folder you pack.

5a. Create the repository in the browser: github.com > New repository > a new name (for example `chefsbay-resourcer-transfer`) > Private > leave "Add a README", ".gitignore" and "license" all off > Create. Confirm the page shows the Private badge.

5b. Commit locally. The repo folder is already a git repository (it may have no commits yet; the commands below work either way):

```ps1
Set-Location $REPO
git config core.autocrlf false
git config user.name        # if empty: git config user.name "Your Name"
git config user.email       # if empty: use your GitHub noreply address (Settings > Emails), so your real address is not in the history
git checkout -B main
git add -A
git ls-files '*.sh' | ForEach-Object { git update-index --chmod=+x $_ }
git ls-files -s '*.sh'
git status --short | Measure-Object -Line
```

The two lines after `git add -A` store every shell script as executable. Files added from Windows are stored as mode 100644, and the cron wrappers copied from such a checkout fail on the instance with `Permission denied` (exit 126). Expect every line of `git ls-files -s '*.sh'` to start with `100755`. (`docs/INSTALL.md` 9.2 also runs `chmod 755` on the installed copies and preflight E10 fails when one is not executable, so a miss here is repaired on the instance, but do it here.) The repository's `.gitattributes` keeps line endings at LF whatever `core.autocrlf` says.

5c. The scan. It must say OK. This checks by location, extension and name that nothing sensitive is about to be committed, and that the bundle is the only encrypted file:

```ps1
$allowed = 'data/resourcer-bundle.enc', 'hermes/.env.example'
$bad = git ls-files |
  Select-String -Pattern '(^|/)(secrets|state|backups|runs|downloads|logs|runtime|outbox|shadow|node_modules)/|\.(db|sqlite|sqlite3|pem|key|enc|log|tmp|p12|pfx|kdbx|zip|7z|gz|tgz|tar)$|\.db-(wal|shm|journal)$|(^|/)\.env($|\.)|(^|/)(credentials|secrets|caterer-credentials|zoho-credentials|reed-credentials|caterer-session|reed-session|dashboard-auth)\.json$|passphrase' |
  ForEach-Object { $_.Line } | Where-Object { $_ -notin $allowed }
$big = git ls-files | ForEach-Object { Get-Item -LiteralPath $_ } | Where-Object { $_.Length -gt 1MB -and $_.Name -ne 'resourcer-bundle.enc' }
if ($bad -or $big) { 'STOP - do not commit. Unexpected files:'; $bad; $big.FullName } else { 'OK - nothing sensitive is tracked' }
git ls-files data
git check-ignore -v data/resourcer-bundle.enc; if ($LASTEXITCODE -eq 1) { 'bundle is not ignored: good' }
```

Expected: `OK - nothing sensitive is tracked`; `git ls-files data` prints exactly `data/.gitkeep` and `data/resourcer-bundle.enc`; the last line says the bundle is not ignored. (`git add -A` is what puts files in the list; if you already ran it, the list is what will be committed.) If the scan flags a file: `git rm --cached <file>`, move the file out of the repo folder, re-run the scan. Note that `.gitignore` does not ignore an archive or a note you saved inside the repo folder; the scan is the protection, so re-run it whenever you add anything.

5d. Commit and push:

```ps1
git commit -m "Resourcer on Hermes: code, docs and encrypted data bundle"
git remote add origin https://github.com/<YOUR-GITHUB-LOGIN>/<NEW-REPO-NAME>.git
git remote -v
git push -u origin main
```

`git remote -v` must show a plain `https://github.com/...` address with no `user:password@` and no token in it (STOP otherwise: `git remote remove origin`). The first push opens a browser window for Git Credential Manager: sign in as yourself. If GitHub rejects the push with a secret-scanning message, do not use the "allow the secret" link: read which file it names, and stop; the repo is designed to hold no real secrets, so a hit is either a test fixture or a real leak.

5e. Check what arrived (2 minutes, recommended):

```ps1
git clone https://github.com/<YOUR-GITHUB-LOGIN>/<NEW-REPO-NAME>.git "$env:TEMP\transfer-check"
(Get-FileHash -Algorithm SHA256 "$env:TEMP\transfer-check\data\resourcer-bundle.enc").Hash
```

The hash must equal the `sha256=` you wrote down at step 3 (case does not matter). Then delete `$env:TEMP\transfer-check`. This also proves line-ending settings did not touch the encrypted file.

## 8. Step 6: hand `OPERATOR-PROMPT.md` to the Hermes agent

1. Open the Hermes Portal > your instance > the dashboard > Chat, with the profile switcher set to `resourcer`.
2. Open `OPERATOR-PROMPT.md` from the repo root and fill in the three inputs at the bottom of the text (`<REPO_SSH_URL>`, `<MANIFEST_SHA256_OR_NONE>`, `<FIRST_SEARCH_POSTCODE>`; `docs/INSTALL.md` calls them H11): the repository's SSH address (`git@github.com:<YOUR-GITHUB-LOGIN>/<NEW-REPO-NAME>.git`), the manifest digest (`MANIFEST_SHA256`, printed by `node tools/check-manifest.js`; or the word `none`), and one outward postcode for the first small search (for example `M1`).
3. Copy everything inside the box, paste it as the first message, send. Paste nothing else: no passphrase, no key, no password, no e-mail link yet. The agent will tell you what it needs and where each item goes. To abandon the install at any point, reply "stop" (`docs/ROLLBACK.md` A10 undoes what was installed).
4. The install will ask you to confirm in writing (H6) that the old pipeline is stopped and stays stopped. Confirm only when step 2 came out clean.

From this point the operator follows `docs/INSTALL.md` step by step and reports each result.

## 9. Step 7: what only you do during the install

The agent follows `docs/INSTALL.md` and stops when it needs you; INSTALL section 0.4 lists the same items as H1 to H11. The usual asks, in the order they come:

| When | What you do | Rule |
|---|---|---|
| Deploy key (INSTALL 2.3) | The agent prints a PUBLIC key (a line starting `ssh-ed25519`). In GitHub: the new repo > Settings > Deploy keys > Add deploy key > title `hermes-resourcer` > paste it > leave "Allow write access" OFF > Add key. | Public key only. Never ask the agent to show a private key. |
| Bundle passphrase (INSTALL 5.1) | Create the file `secrets/bundle-passphrase` (one line, mode 600) in your own terminal (the restore tool can do it for you: `node tools/restore-bundle.js --save-passphrase`, which needs a real terminal and asks twice, hidden), or type it on the dashboard Keys page as `BUNDLE_PASSPHRASE` and let the agent move it into the file without displaying it. The agent restores the bundle, then removes the file; delete the Keys entry too. | The agent must never see the value. Keep the passphrase off the instance as well. |
| Keys page (INSTALL 6.1) | With the profile switcher on `resourcer`, add custom keys: `AI_GATEWAY_API_KEY` (a Vercel AI Gateway key with a credit balance, made for this project), `BACKUP_PASSPHRASE` (16 characters or more, a different secret from the bundle passphrase, with a copy in your password manager), and recommended `RESOURCER_DEADMAN_URL`, `BACKUP_UPLOAD_CMD`, `BACKUP_UPLOAD_ENV`. If there is no custom-key form, run `hermes -p resourcer config set NAME value` in your own terminal, not in the chat. | Values are typed by you. If one is pasted into the chat, treat it as compromised and rotate it. |
| Approvals | Approve the command prompts the agent announces (recursive deletes, writes to `SOUL.md`, config), or run the install session in `/yolo` if you accept no prompts. | Read what is being approved; it must match the install step being done. |
| Old system stopped (H6) | Confirm in writing in the chat that the old pipeline is stopped and stays stopped. | Only after step 2 came out clean. |
| Caterer sign-in (INSTALL 8) | Be at the mailbox. The first sign-in from the new address is EXPECTED to end in a `SAFELIST_BLOCKED`: Caterer e-mails a `TwoFaAuthRedirect` link to the login address (forwarded to your mailbox). Open the NEWEST e-mail, copy the link, paste it to the agent once; it runs `caterer-login.js --open-link`. | One link at a time: every attempt e-mails a new link and voids the older ones. Do not click the link in your own browser: it has to be opened in the Hermes browser session. It is single use and short-lived; do not keep it. |
| Alert channel (INSTALL 9.4 to 9.7) | Connect e-mail and/or Telegram to the profile in Hermes, give the agent the exact target text, and confirm the test alert arrived. | Nothing is switched on until it has arrived. This step blocks go-live. |
| Decisions (INSTALL 9.8) | Accept that the first live run spends Caterer credits and creates real Zoho records (H10); decide whether Reed is set up before or after the first cycle (H9b: default after); decide the off-instance backup and the dead-man monitor (H9c, H9d). | Territories processed while Reed is off do not get their Reed half later. |
| Dashboard restart (INSTALL 10.3) | Press Restart for the dashboard in the Portal, reopen the Chat tab. | The agent cannot and must not restart the gateway or the dashboard. |
| Zoho check (INSTALL 11.3) | Open three of the new records: contact details present, City is a place name, a CV is attached and opens, no duplicate. | |

Never: paste the bundle passphrase into the chat; type a password into a command line; let the agent read `.env` or `secrets/`.

## 10. Step 8: the canary and the go/no-go decision

"Canary" here means proving, on the real sites from the datacenter address, the things nobody can prove offline. The operator runs INSTALL steps 7 to 11; `docs/ACCEPTANCE.md` holds the go-live checklist. What you read, and why each matters:

1. `sh tools/preflight.sh --final` ends `PREFLIGHT_RESULT ... fail=0` (INSTALL 11.5).
2. The database is the one you built: `node scripts/preflight-db.js` prints `OK candidates=<n>` with the count from step 2, and `migrate-schema.js` reports every step `present`.
3. Screening: the canary calls of INSTALL 7 pass (key, credit, both engines).
4. Caterer sign-in (INSTALL 8): one attempt, one link, then `caterer-login.js --check` exits 0 twice, two minutes apart. INSTALL 8.3 has the technical decision table.
5. One real run (INSTALL 9.8 and 11): the small first search ends with candidates in Zoho with a CV attached; the digest and the dashboard agree; the credit drop equals the candidates unlocked.
6. Alerts and backup: the test alert reached you; `node scripts/backup-db.js --auto` then `--restore-test` pass; an encrypted backup exists off the instance.

Decision table for the owner (INSTALL 8.3 is the operator's view; this is what it means for the laptop):

| What you see | What it means | Decision |
|---|---|---|
| Checks 1 to 6 pass and the run pushed candidates with CVs | Hermes works from the datacenter address | GO: go to the step 9 gate |
| Sign-in works after one safe-list link and stays signed in through a routine re-login (`--check` exit 0 the next morning) | Normal; the address is remembered | GO, and expect an occasional link (`docs/OPERATIONS.md` section 7) |
| Blocked again (`caterer-safelist`) within a day of a good link, or the link opens but the session does not stick | The datacenter address is re-challenged every time | AMBER: do NOT wipe. Keep the laptop fenced and intact. Choose between an automated link reader (`docs/DECISIONS.md` OD6 and OD7), another exit address, or going back (`docs/ROLLBACK.md` A) |
| `CRED_*` or `LOGIN_FAILED` (exit 3), or `caterer-login-failed` (attempts paused 3 hours) | Wrong or expired password, or the account is locked | NO-GO until fixed: check the password by logging in to Caterer in a normal browser; fix `secrets/caterer-credentials.json` on the instance; one `--force` only after that |
| `CATERER_MODULE_ERROR` (exit 4), alert `caterer-cvdb-module` | Caterer's CV search is broken for the account; not a Hermes fault | WAIT: nothing can be proven until it clears; do not wipe |
| Sign-in fine but every territory returns pool 0 with errors 1, or the browser gets an "Access Denied" or HTTP 403 page | The site answers differently to this address; its bot protection may block the datacenter address | NO-GO: keep the laptop. Retry no more than once an hour: bursts prolong a block |
| Halt with `screening gateway auth failed` or `credits exhausted` | The AI Gateway key or balance | FIX and continue (minutes); the halt clears itself |
| `low-memory`, browser crashes, runs killed at 70 minutes | Not enough RAM next to the other profile | Reed stays off; retry off-peak; NO-GO for the wipe until one full run finishes clean |
| Reed login blocked by the bot check (`reed-human-login`) | Expected on a datacenter address | Not a blocker for GO: Reed stays off. But every territory processed while Reed is off forgoes its Reed half for good (historically about a third of the Zoho-linked candidates came from Reed; about 8,100 new ones from April to September against about 11,100 from Caterer from June to September), so plan the human login soon (`docs/OPERATIONS.md` section 8) |

If the verdict is NO-GO or AMBER, INSTALL step 9 leaves the sourcing jobs paused; the old system stays fenced but intact, and you choose between waiting, fixing, and `docs/ROLLBACK.md` A.

## 11. Step 9: before the laptop is wiped

### 11.1 The gate: every line must be true

| # | Condition | How you know |
|---|---|---|
| 1 | Hermes completed at least one clean cycle: a run through Phase 2 with candidates in Zoho and CVs attached, no open critical alert | Dashboard "Recent runs", the 18:00 digest, Zoho |
| 2 | Recommended: one overnight cycle too (23:00 keep-alive, 05:50 pre-flight, 06:00 run) worked without you, and the next-morning checks of INSTALL 11.5 pass (backup ran, no pre-flight or keep-alive alert, the 07:00 alive line and the 18:00 digest reached you, `preflight.sh --final` has `fail=0`); the GATE items of `docs/ACCEPTANCE.md` are PASS or waived by you in writing | The next morning. If you must wipe before this, you accept `docs/ROLLBACK.md` section B. |
| 3 | The nightly backup ran (or `backup-db.js --auto` was run by hand) and `--restore-test` passed | `backup-db.js --list`, no `backup-*` alert |
| 4 | An off-instance copy of a backup exists, and you decrypted it once on a machine that is not the instance (a restore drill) | Do it with `node scripts\backup-db.js --restore <file> --out <path> --passphrase-file <file>` from a checkout of this repo, or ask the operator to run `--verify` and confirm the file came from your storage |
| 5 | The encrypted archive (step 4) is stored off the laptop in two places, and `--list` succeeded on a copy | Step 4 |
| 6 | All three passphrases are in the password manager and on paper, and you have proven you can read them back | Type one into `verify-bundle.js` from the stored copy |
| 7 | Alerts reach you (a test alert arrived; you have seen at least one real digest) | Your inbox / Telegram |
| 8 | The bundle is safely stored (it is in GitHub AND one copy off the laptop) until TEARDOWN | Step 3 |
| 9 | You know the rollback decision rule and its cutoff (first week, before rotating any credential) | `docs/ROLLBACK.md` A |

Do NOT rotate the Caterer, Reed or Zoho credentials before the gate: a rollback needs the old ones. Revoking the GitHub token has no such dependency and should be done at once.

### 11.2 Credentials to rotate or revoke

Order: row 1 now; rows 2 to 4 after the gate and just before the wipe (each row after the change: update the instance file through the private channel of step 7, run the check, and put the new value in the password manager at the moment you create it: after the wipe the instance and the password manager are the only places it lives); the rest at wipe time.

| # | What | Where it lives now | Action | Verify |
|---|---|---|---|---|
| 1 | GitHub personal access token embedded in the old repository's remote | `%USERPROFILE%\.openclaw\workspace-resourcer\.git\config` (do not print it: `git remote -v` there shows it) | GitHub > Settings > Developer settings > Personal access tokens: delete the token(s) you do not recognise or that were last used from this laptop; if unsure, delete all classic tokens and recreate only what you need. Then decide about the old `ChefsBayResourcer` repository: after the archive is safe, delete it or confirm it is private, because passwords that were once hard-coded in the scripts may be in its history (treat any such password as leaked; rows 2 and 3 replace them). If the disk will not be wiped, also delete `workspace-resourcer\.git` on the laptop (it holds the token). | The token list no longer shows it; `git ls-remote` with the old URL fails with 401/403 |
| 2 | Caterer password | `secrets/caterer-credentials.json` (bundle, instance), the old workspace file, the older password in a memory note | Change it in Caterer (do it outside 06:00 to 22:00: it may sign the session out and cost a safe-list link). Update `secrets/caterer-credentials.json` on the instance. Then `node scripts/caterer-login.js --check`, and `node scripts/pipeline-watchdog.js --clear-cooldown` if a back-off was set. | Next morning's 05:50 pre-flight passes |
| 3 | Reed password | Hard-coded in two old scripts, in the bundle, in a memory note | Change it at Reed; update `secrets/reed-credentials.json`; when Reed is enabled, a human login is needed anyway (OPERATIONS). `restore-bundle.js` keeps an existing credential file that differs from the bundle's (only `--replace-secrets` overwrites it), but do not re-run it after a rotation without reading its plan first. | `node scripts/cdp-reed-full-login.js --check-credentials` prints `REED_CRED_OK` |
| 4 | Zoho client secret and refresh token | `secrets/zoho-credentials.json` (keys: client_id, client_secret, access_token, refresh_token, api_domain, scope, token_type); the old workspace file | Recommended (the old files existed in plaintext and in the bundle). In the Zoho API Console (the pipeline talks to the EU data centre, `accounts.zoho.eu`) regenerate the client secret, create a new refresh token with the SAME `scope` value as the old file, revoke the old refresh token, update the instance file. Read the scope BEFORE the wipe; this prints only that one non-secret value: `node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).scope)" "$LEGACY\zoho-credentials.json"` | The next Phase 2 push succeeds; no `zoho-push-failing` alert |
| 5 | Claude and OpenClaw sign-ins | `claude` CLI login (Max subscription) used by the old gateway; every provider key under `%USERPROFILE%\.openclaw` (`openclaw.json`, `credentials\`, agent auth files: search engine key, the fallback model provider key, gateway token) | Run `claude` and sign out with `/logout`; revoke the device or session in your Claude account; revoke each provider key in that provider's dashboard | The provider dashboards show no active key from this laptop |
| 6 | The dashboard tunnel | ngrok auth token (`%LOCALAPPDATA%\ngrok\ngrok.yml`), the old dashboard's login file `config\dashboard-auth.json` | `pm2 stop chefsbay-dashboard` then `pm2 delete chefsbay-dashboard`; revoke the ngrok auth token and release any reserved domain in the ngrok dashboard | The public address no longer answers |
| 7 | WhatsApp pairing of the old agent | `%USERPROFILE%\.openclaw\credentials\` | On the phone: WhatsApp > Settings > Linked devices > log out the laptop | The device is gone from the list |
| 8 | GitHub sign-in on this laptop | Windows Credential Manager (`git:https://github.com`), browser sessions, any SSH key in `%USERPROFILE%\.ssh` | Remove the credential entry; remove the SSH public keys from GitHub Settings > SSH keys; GitHub Settings > Applications > revoke authorised apps you used from here | Settings > Sessions shows no session from this laptop after sign-out |
| 9 | Hermes Portal, password manager, VPN, mail | Browser profiles, apps | Sign out everywhere; remove the laptop from the device lists; remove the VPN licence for this device | |
| 10 | Not the resourcer but on the same laptop | the `secrets.json` in your `OutreachAutomation` folder (outreach tool keys), the main agent workspace | Decide now: move what you need somewhere else, or revoke those keys too. This runbook does not migrate the outreach automation. | |

### 11.3 Browsers and profiles to sign out or delete

- Windows Chrome/Edge profiles used for Caterer, Reed, Zoho, GitHub, Hermes Portal, Claude, the mailbox. The Reed automation used a Chrome profile of about 4.6 GB signed in to Reed: sign out of every account inside it, then delete the profile folder.
- The Linux (WSL) distribution: it holds the Caterer browser session and its cookies. List with `wsl -l -v`, then `wsl --unregister <name>` for each.
- Your Claude Code and other assistant history: `%USERPROFILE%\.claude` (transcripts and memory notes hold old passwords and the Reed login) and `%USERPROFILE%\.openclaw` (agent sessions). If the disk is not wiped, delete both; if it is, the wipe covers them.
- Recycle Bin and Downloads (the bundle, the archive if you left a copy).

### 11.4 The wipe (only when 11.1 is fully true)

1. Confirm the archive and bundle copies and the password manager one last time from ANOTHER device.
2. Sign out of the Microsoft account and OneDrive; make sure any cloud folder finished syncing first.
3. Settings > System > Recovery > Reset this PC > Remove everything > Change settings > Clean data: On. This takes one to two hours.
4. From another device afterwards: remove the laptop from account.microsoft.com/devices, GitHub Settings > Sessions, the Claude account sessions, the password manager device list, the mailbox "signed-in devices" page.
5. Keep the notes of what you rotated and when. Then follow `docs/TEARDOWN.md` once Hermes has been proven for the period you chose (a week is sensible).

## 12. Quick reference: what each tool prints

| Tool | Success line | Failure line | Exit codes |
|---|---|---|---|
| `tools\make-bundle.js` | `BUNDLE_OK out=... size=... sha256=...` (`DRY_RUN_OK` for a dry run) | `BUNDLE_FAILED <reason>` | 0 ok, 1 usage, 4 refused (live run, missing fence), 5 source problem, 7 passphrase |
| `tools\verify-bundle.js` | `VERIFY_OK files=<n>` | `VERIFY_FAILED <reason>` | 0, 2 authentication failed (wrong passphrase or tampering), 3 malformed or truncated, 5 mismatch, 7 |
| `tools\archive-legacy.js` | `ARCHIVE_OK out=... sha256=...`, `ARCHIVE_DRY_RUN_OK`, `LIST_OK`, `EXTRACT_OK` | `ARCHIVE_FAILED <reason>` | 0, 2, 3, 4 refused, 5, 7 |
| `tools/restore-bundle.js` (on the instance, by the operator) | `RESTORE_OK files=...` | `RESTORE_FAILED <reason>` | 0, 2, 3, 4 refused (newer database, live run), 5, 6 migrate failed, 7 |

Run any tool with `--help` for its options. The passphrase is never a command-line argument: `--passphrase` and friends are refused on purpose.
