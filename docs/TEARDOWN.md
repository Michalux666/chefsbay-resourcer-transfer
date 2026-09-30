# TEARDOWN: destroying the transfer repo and the bundle once Hermes is proven

Audience: the owner. The operator agent runs the instance-side commands only when the owner asks, and the recursive deletes need the owner's approval.

Companion pages: `docs/CUTOVER.md` (what you created), `docs/ROLLBACK.md` (what teardown makes harder), `docs/SECURITY.md` (the data inventory), `docs/OPERATIONS.md`.

## 0. What this page does and why it is not instant

The cutover made copies of your most sensitive things in places that outlive the cutover: an encrypted bundle (database, three credential files, configuration) inside a GitHub repository, a passphrase file on the instance, a deploy key on the instance, tokens and cached logins on the laptop. This page removes them in an order that never leaves you without a way to recover, and then proves nothing is left.

Three facts shape the order:

1. You cannot make a file that has already been in a repository safe again by re-encrypting it, deleting it from the newest commit or changing its passphrase. It stays in the history, in every clone, and (for a while) on GitHub's side after a repository is deleted. The real protections are the passphrase strength, the credential rotation you did after the cutover (`docs/CUTOVER.md` section 11.2), and deleting the repository. Do not treat the passphrase rotation below as a substitute for the credential rotation.
2. The repository is also where your code lives. Deleting it deletes the only shared copy. Keep a code-only copy first (T1).
3. After teardown the bundle no longer exists, so a rebuild can only start from a backup (`docs/ROLLBACK.md` section B). Do not tear down until an off-instance backup exists and has been restored once on a machine that is not the instance.

## 1. Preconditions (all must be true)

| # | Condition | How to check |
|---|---|---|
| 1 | Hermes has run cleanly for the period you chose. A week is the sensible minimum; it is also the rollback window. | Digests and no open critical alert |
| 2 | You will not roll back: nothing in `docs/ROLLBACK.md` section 0.1 applies | Your call |
| 3 | The Caterer, Reed and Zoho credentials, and the GitHub token, were rotated after the cutover and the new values are in the password manager (`docs/CUTOVER.md` 11.2) | Your notes |
| 4 | An off-instance encrypted database backup exists and was decrypted once elsewhere (restore drill) | `node scripts/backup-db.js --list` on the instance; the drill on your machine |
| 5 | The backup passphrase is in the password manager and on paper, and is a DIFFERENT secret from the bundle passphrase | Password manager |
| 6 | The encrypted archive of the old system is stored off the laptop (two places) and you have decided how long to keep it (T9) | `docs/CUTOVER.md` step 4 |
| 7 | The instance's working tree matches the released code: `node tools/check-manifest.js` ends `MANIFEST_OK` and `git status --short` prints nothing except `?? AGENTS.md` | Run both on the instance |

## 2. Where the sensitive copies are

| Item | Places it may exist | Removed in |
|---|---|---|
| `data/resourcer-bundle.enc` | the transfer repo on GitHub (every commit that had it); the laptop clone `data\`; any other clone (the `transfer-check` folder from step 5e); the instance clone `data/` and its `.git` history; a copy off the laptop you made at step 3; downloads, e-mail, USB | T3, T5, T6 |
| Bundle passphrase | password manager; paper; `secrets/bundle-passphrase` on the instance; possibly a shell history or the operator's session store if it was ever typed there | T6, T7, T8 |
| Deploy key (private half) | instance, in the folder INSTALL.md created (the suggested place is `/opt/data/profiles/resourcer/deploy`) | T5 (the public half dies with the repository) |
| GitHub tokens | Windows Credential Manager, browser sessions, the old repository's remote | T4 |
| Unencrypted safety copies made by the tools | `backups/bundle-restore-<time>/` (only if a restore replaced files), `backups/candidates.db.pre-migrate-*` (removed by the nightly housekeeping after 7 days), `state/restore/` if you used `docs/ROLLBACK.md` B3 | T6 |
| Restored working files | `secrets/*.json` (LIVE credentials: keep), `candidates.db` (live: keep) | not removed |

## 3. The steps

### T0. The secret hygiene list, in order (`docs/SECURITY.md` section 10, `docs/ACCEPTANCE.md` GL09)

The old system spread secrets widely. `docs/CUTOVER.md` 11.2 and 11.3 give the where, how and verification for each row; this is the order, with the timing that keeps the rollback path open.

1. Now, independent of everything else: revoke the GitHub personal access token that sits in the old workspace's git remote address, and delete the old workspace's `.git` folder on the laptop before the laptop leaves your hands (an archive made with the default settings does not contain it).
2. After the rollback window (a week, or the gate of CUTOVER 11.1) and before the wipe: rotate the Reed password (hard-coded in two old scripts, present in about 50 old chat transcripts and in a memory note), the Zoho client secret and refresh token, and the Caterer password if any old value survives in notes or transcripts (an older one does). Update the instance files through the private channel and put every new value in the password manager when you create it.
3. Purge or redact the old memory notes and chat transcripts that contain passwords: the memory folder under `%USERPROFILE%\.claude\projects` (the login-procedures reference note holds the Reed password and an older Caterer password) and the old session transcripts under the Claude and agent folders. A wipe of the disk covers them; a hand-over without a wipe does not.
4. Delete the old credential files, session files, browser profiles and the Linux subsystem distribution from the laptop (also covered by a wipe).
5. Delete the bundle, its passphrase file and every copy (T3 to T6); retire its passphrase (T7).
6. Confirm the alert channel reaches a person and that the backup passphrase exists off the instance.

If the laptop is wiped, items 3 and 4 are done by the wipe; items 1, 2, 5 and 6 are not.

### T1. Keep the code

Do this first. The simplest way needs no file to leave the instance: on any machine where you can clone the transfer repository with your own login (your new computer, or the laptop before the wipe), make a copy of the code without the bundle and without history:

```ps1
git clone https://github.com/<YOUR-GITHUB-LOGIN>/<NEW-REPO-NAME>.git code-copy
Set-Location code-copy
git archive --format=zip -o ../code-only.zip HEAD -- . ':(exclude)data'
```

`code-only.zip` holds no secrets or data. Keep it in your own storage, and delete the `code-copy` folder afterwards (it has the bundle in its history). From the zip you can later start a fresh private repository for updates: unpack it, `git init`, commit, push to a NEW private repository with a NEW read-only deploy key, and never put `data/` in it again. `docs/OPERATIONS.md` section 12 describes pointing the instance at that repository. If you never need code updates from git, the zip is your backup of the code and you can skip the new repository.

The same archive can be made on the instance (`git archive --format=tar --prefix=resourcer-code/ HEAD -- . ':(exclude)data' > /opt/data/profiles/resourcer/code-only.tar` from `/opt/data/profiles/resourcer/workspace`), but getting the file off the instance depends on the dashboard file tools, so treat that as the fallback.

### T2. Confirm the credentials inside the bundle are dead

The bundle contains the Caterer, Reed and Zoho credentials as they were at the cutover. After the rotation in `docs/CUTOVER.md` 11.2 they no longer work. Confirm each rotation is done and recorded; if one is not, do it now, because deleting the repository does not make the old values safe. Also confirm the GitHub token embedded in the old workspace's git remote is revoked.

### T3. Delete the transfer repository on GitHub

In the browser, signed in as yourself: the repository > Settings > General > Danger Zone > Delete this repository > type its name to confirm. That also removes its deploy keys, issues, pull requests and any forks that belong to your account.

Then, still in the browser:

- Settings > Repositories > Deleted repositories (personal account). GitHub's documentation describes a period (about 90 days when this was written; check the current text) during which a deleted repository can be restored. Treat the bundle as exposed to offline password guessing for that period and after: this is why T2 matters and why the passphrase had to be strong. Do not restore it.
- Check there are no forks (the repository's Insights > Forks before you delete it) and no other people with access.
- If you added any collaborator, GitHub App or Action to the repository, remove them at Settings > Applications.

### T4. Revoke your own GitHub sign-ins

- Settings > Developer settings > Personal access tokens: delete every token created for the cutover and the old repository token if it still exists.
- Settings > Applications > Authorized OAuth Apps: revoke Git Credential Manager if you no longer need it.
- On the laptop, if it still exists: Windows Credential Manager > Windows Credentials > remove `git:https://github.com`, and in the repo folder run `git remote remove origin`.
- Settings > SSH and GPG keys: remove any key created for this work.

### T5. Clean the instance

Run these on the instance, from the repository root, one at a time. Approvals are expected for the recursive delete (the owner approves it).

```sh
cd /opt/data/profiles/resourcer/workspace
git remote -v
git status --short
```

`git remote -v` shows only the plain SSH address (no token); `git status --short` must print nothing except `?? AGENTS.md` (the copy INSTALL 6.4 made; any other line is a local edit: stop and find out why). Then remove the git history, which still holds the bundle even if the file is deleted from the tree (the clone is shallow, but it still contains the bundle's blob), and the bundle file itself:

```sh
rm -rf .git
rm -f data/resourcer-bundle.enc
ls -la data
```

`data/` should now hold only `.gitkeep` (it is fine to leave it). The working tree is now plain files with no history and no remote; the code lock (`node tools/check-manifest.js`) does not depend on git and must still end `MANIFEST_OK`.

Remove the deploy key (private half) and its helper files. Adjust the folder to whatever INSTALL.md used:

```sh
ls -la /opt/data/profiles/resourcer/deploy
rm -f /opt/data/profiles/resourcer/deploy/id_ed25519 /opt/data/profiles/resourcer/deploy/id_ed25519.pub /opt/data/profiles/resourcer/deploy/known_hosts
rmdir /opt/data/profiles/resourcer/deploy
```

Do not `cat` the private key at any point, not even to confirm it is there.

### T6. Delete the bundle, the passphrase file and the unencrypted safety copies

On the instance:

```sh
cd /opt/data/profiles/resourcer/workspace/resourcer
rm -f secrets/bundle-passphrase
grep -c '^BUNDLE_PASSPHRASE=' /opt/data/profiles/resourcer/.env
ls -d backups/bundle-restore-* backups/candidates.db.pre-migrate-* state/restore 2>/dev/null
```

The passphrase file should already be gone (INSTALL 5.4 removes it right after the restore); the `rm -f` is a check. The `grep -c` prints a count and never the value: it must print `0`; if it prints `1` the owner deletes the `BUNDLE_PASSPHRASE` key on the Keys page.

The last line lists any unencrypted safety copies that exist. They hold the same data as the live files in plaintext; delete each folder you see (recursive delete, with approval) and each `candidates.db.pre-migrate-*` file with `rm -f`. `secrets/` itself stays (live credentials), with its files mode 0600 and the folder 0700.

On the laptop and other machines (skip what the wipe already covers):

```ps1
Set-Location "<the folder of your repository checkout>"
Remove-Item -Force .\data\resourcer-bundle.enc -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\transfer-check" -ErrorAction SilentlyContinue
Get-ChildItem -Path "$env:USERPROFILE" -Recurse -Include 'resourcer-bundle*.enc' -ErrorAction SilentlyContinue | Select-Object FullName
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
```

The third line lists any other copy of the bundle under your profile (Downloads, Desktop, cloud-synced folders): delete them, and delete the copy you stored off the laptop at cutover step 3 (USB stick, cloud drive, bucket). Keep the archive (T9).

### T7. Retire the bundle passphrase

The bundle no longer exists, so "rotating" its passphrase means making sure it protects nothing that is still alive:

1. Delete the password-manager entry and the paper copy for the bundle passphrase, but only after T3 to T6 are done.
2. If you ever reused it for the backup passphrase or the archive passphrase, change those now. The backup passphrase: put the new value into the private channel (`secrets/backup-passphrase` or the profile `.env`), then on the instance run `node scripts/backup-db.js --auto` so tonight's and future backups use it. Older backups still need the OLD passphrase until they age out (14 daily and 8 weekly, so up to eight weeks): keep the old value in the password manager labelled "old backups only", and delete it when the last old backup has been pruned. The off-instance copies age the same way.
3. The archive passphrase is not rotated: the archive is a fixed file. Change it only by extracting and building a new archive (`node tools\archive-legacy.js` needs the old source, which may be gone), so do not reuse it anywhere.

### T8. Check the operator's history

Anything typed in the Hermes chat or a command line is stored in the profile's session database and may have been sent to the model provider. If a passphrase, key or password was ever pasted there (it should not have been), treat that secret as compromised and rotate it, then prune the sessions: `hermes sessions --help` shows the prune command for the version installed. Nothing in the rest of this page needs the chat history.

### T9. Decide how long to keep the archive

The encrypted archive of the old system (agent history, credential files, an online copy of the old database) is your only copy of that history. It is encrypted, so keeping it is safe as long as the passphrase is. Pick a date to destroy it (six months is reasonable), write the date in the password manager entry, and delete the file from every place when it comes. Agent history can mention candidates; do not keep it indefinitely.

## 4. Verify that nothing sensitive remains

These commands print names, counts and modes only. Run them after T1 to T8.

On the instance:

```sh
cd /opt/data/profiles/resourcer/workspace
# a. no git history or remote (expect: fatal: not a git repository)
git log --oneline 2>&1 | head -1
# b. no bundle, passphrase or archive file anywhere on the data volume (expect: nothing printed)
find /opt/data -xdev \( -name 'resourcer-bundle*' -o -name 'bundle-passphrase*' -o -name 'legacy-archive*' \) -print 2>/dev/null
# c. no unencrypted safety copies (expect: nothing printed)
find /opt/data/profiles/resourcer -xdev \( -name 'bundle-restore-*' -o -name '*.pre-migrate-*' -o -name '*.broken' \) -print 2>/dev/null
# d. no deploy key left (expect: No such file or directory)
ls -la /opt/data/profiles/resourcer/deploy 2>&1 | head -3
# e. secrets folder: names and modes only (expect: drwx------ and -rw------- entries, no bundle-passphrase)
ls -la resourcer/secrets
# f. the code lock still holds (expect: MANIFEST_OK)
node tools/check-manifest.js | tail -1
# g. backups are encrypted files (expect: names ending .db.gz.enc plus .json manifests)
ls resourcer/backups | head -20
```

On the laptop, if it still exists:

```ps1
Set-Location "<the folder of your repository checkout>"
git remote -v                                   # expect: nothing printed
git log --all --oneline -- data | Select-Object -First 3   # history is still local; the folder is deleted at the wipe
Get-ChildItem -Path $env:USERPROFILE -Recurse -Include 'resourcer-bundle*','legacy-archive*' -ErrorAction SilentlyContinue | Select-Object FullName
cmdkey /list | Select-String -Pattern 'git:https://github.com'
```

From another device:

- GitHub: the repository is gone (its address gives 404), Settings > Developer settings shows no token from this work, Settings > SSH keys shows none from this work, Settings > Sessions shows none from the laptop.
- The password manager holds: the backup passphrase (current, and old if T7 applies), the rotated credentials, the archive passphrase with its destroy-by date; it holds no bundle passphrase.

If any check prints something unexpected, stop and deal with that item before you continue; do not delete "everything under `secrets/`" to make a check pass.

## 5. What to keep

| Keep | Why | Where |
|---|---|---|
| `secrets/` on the instance | The live credentials | Instance, mode 0700 / 0600 |
| `candidates.db` and its nightly backups | The asset | Instance; the off-instance copy |
| The backup passphrase (and the old one while old backups exist) | Without it the backups are unreadable | Password manager and paper |
| The rotated credentials | After the wipe they exist only on the instance and in the password manager | Password manager |
| The code | The instance working tree, plus `code-only.tar` or a new private repository | Off the instance too |
| The encrypted archive, until its destroy-by date | History and a last resort | Two places off the laptop |
| The notes of what you rotated and when | Any rebuild starts from them | Password manager note |
| These docs | The runbooks | With the code |

## 6. After teardown

- A rebuild starts from a backup, not the bundle: `docs/ROLLBACK.md` B4.
- Code updates come from your new repository or tarball, applied by you (`docs/OPERATIONS.md` section 12). The resident agent does not pull code by itself.
- A new cutover (a new machine, a new instance) starts again at `docs/CUTOVER.md` step 1 with a NEW bundle and NEW passphrases.
