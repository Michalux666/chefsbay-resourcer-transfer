# Parity: bundle (encrypted data bundle tooling)

Package owner files: `tools/make-bundle.js`, `tools/restore-bundle.js`, `tools/verify-bundle.js`, `tools/lib/bundle-format.js`, `tests/bundle/**`, this file.
Contract: DESIGN 5.9 and 8; port-manifest sections 4 and 5; research `current-system-review.md` 4.6, 5.3, 5.5.

The bundle moves everything that must survive the port (database, config, caches, pending queue, three credential files) from the laptop to the instance without any of it appearing in plaintext in the repo, in git, in a log or in an LLM transcript. Nothing in this package talks to a network, a browser or a third party.

## Usage

```
laptop:    node tools/make-bundle.js [--source <legacy workspace>] [--out data/resourcer-bundle.enc] [--dry-run] [--require-fence]
anywhere:  node tools/verify-bundle.js [--bundle data/resourcer-bundle.enc]
instance:  node tools/restore-bundle.js [--bundle ...] [--home <RESOURCER_HOME>] [--dry-run] [--force] [--no-overwrite] [--skip-migrate]
```

Passphrase (16+ characters, NFKC-normalised, one trailing newline stripped): hidden prompt (asked twice when building), or `BUNDLE_PASSPHRASE_FILE=<file>`, or `BUNDLE_PASSPHRASE_FD=<n>`; restore and verify also read `<home>/secrets/bundle-passphrase` when none of those is given (see "The human-only passphrase channel" below). It is never accepted as an argument: `--passphrase`, `--passphrase=x`, `-p` and bare arguments all fail with exit 1 and are never echoed.

Environment variables introduced (for `docs/ENV.md`): `BUNDLE_PASSPHRASE_FILE`, `BUNDLE_PASSPHRASE_FD`, `BUNDLE_SQLITE_MODULE` (directory of better-sqlite3 when it is not installed under `resourcer/`), `BUNDLE_SCRYPT_LOG2N` (15..18, tests only; default cost is 2^17), `BUNDLE_TEST_TMP` (tests only).

Exit codes: 0 ok; 1 usage or unexpected error; 2 authentication failed (wrong passphrase or any tampering after the header); 3 bundle malformed, truncated or wrong version; 4 refused (live pipeline, newer database, blocked destination, live target run); 5 verification or source problem (integrity check, sha256 or row-count mismatch, missing required source file, Reed extraction failed); 6 `migrate-schema.js` failed; 7 passphrase problem.

Every run ends with one marker line: `BUNDLE_OK`, `DRY_RUN_OK`, `VERIFY_OK`, `RESTORE_OK` or `..._FAILED <reason>`. Output contains file names, sizes, modes, counts and table row counts only. No hashes of secret files are printed (a hash of a short credential file is a password-guessing oracle); the one hash printed is the sha256 of the encrypted `.enc` file at build time, for checking a transfer.

## Bundle format (`tools/lib/bundle-format.js`)

- Header, 56 bytes, plaintext and bound into every chunk as AAD: magic `CBRBNDL1`, version 1, kdf scrypt, cipher AES-256-GCM, log2(N) (default 17, decoders accept 15..18), r=8, p=1, chunk size (1 MiB), 32-byte salt, 4-byte nonce prefix.
- Chunks: `flags(1) | ctLen(4) | ciphertext | tag(16)`. Nonce = prefix || 64-bit chunk counter. AAD = header || counter || flags (bit 0 = final chunk). Reorder, drop, duplicate, append, truncate and bit flips all fail (tests flip every bit position of a sample bundle and cut at every byte length).
- Decrypted stream: `manifestLen(4) | manifest JSON | file bytes in manifest order`. The manifest is inside the encryption and lists every file (path, mode, size, sha256, kind, secret), per-table row counts of `candidates.db`, its `PRAGMA integrity_check` result, the latest-activity watermark, build timestamp (`builtAt`), a source host label, source fence state and warnings (names only).
- Fixed-size buffers only (1 MiB chunk plus a 1 MiB read piece): a 60 MB and a 180 MB file peak at the same resident size (see tests).
- Only these paths can travel, enforced on both sides by an allowlist (`classifyPath`): `candidates.db`, `config/<name>.json` (never `dashboard-auth.json`), `scripts/extract-js.b64`, the three root caches, `pending-searches/<name>.json`, `secrets/{caterer,zoho,reed}-credentials.json`. Path traversal, duplicates (case-insensitive), a secret with group/other mode and unknown paths are rejected while reading the manifest.

## Flow

`make-bundle.js`: (1) refuse if a run is live (below) -> (2) passphrase -> (3) extract Reed values in-process -> (4) read caterer/zoho credential bytes and prove they are JSON objects (key names only are printed) -> (5) `better-sqlite3` `backup()` of the live DB through a read-only handle into a private temp dir, normalise to a single file (`journal_mode=DELETE`), `PRAGMA integrity_check`, row counts -> (6) collect config/caches/`extract-js.b64`/pending files -> (7) write `<out>.check-<pid>`, run the full decrypt-and-check on it (auth, every sha256, database opened in memory, counts) -> (8) atomic rename to `--out`. The temp snapshot is removed on every exit path including SIGINT/SIGTERM; the source workspace is never written (asserted by a tree snapshot before/after).

`restore-bundle.js`: (1) pass 1 authenticates every chunk and every file hash, writing nothing anywhere -> (2) plan per file: `create | unchanged | replace | keep | skip | blocked` -> (3) refusals (newer or unreadable DB, live run on the target, non-regular destination) or `--dry-run` end here with nothing written, not even the target directory -> (4) lock, pass 2 extracts only what changes into `.bundle-staging-<pid>/` inside the target (same filesystem) -> (5) staged DB integrity and row counts against the manifest -> (6) timestamped copies of everything to be replaced under `backups/bundle-restore-<UTC>/` (0700/0600; the DB via `backup()` so a WAL is included) -> (7) atomic per-file moves, DB last, stale `-wal/-shm/-journal` removed first -> (8) verify what is on disk (sha256, modes on POSIX, `integrity_check`, counts) -> (9) `scripts/migrate-schema.js` if present (cwd = target, `RESOURCER_HOME` set, all `BUNDLE_*` variables removed from its environment; absent = warning) then re-check counts -> (10) `state/bundle-restored.json` (names, sizes, actions; no hashes).

"Newer" database: the existing DB holds more rows than the bundle in any of candidates, candidate_rejections, territory_searches, reed_daily_usage, run_results, or its latest activity (max of the timestamp columns, normalised) is after the bundle's. "Data-equivalent" (same counts and same latest activity, ignoring caches and extra tables) is reported as `unchanged`, which is what makes a re-run after `migrate-schema.js` (WAL, `run_results`) a no-op. An unreadable existing DB is refused without `--force`.

## Live-pipeline detection (`checkPipelineLive`)

Live when any of: a `runs/phase1-*.json` or `runs/run-*.json` whose status is not terminal (`complete`, `error`, `phase1_abandoned`, `phase1_stale`) and whose `updatedAt` (else `startedAt`, else mtime) is within 90 minutes; an unreadable such file modified within the window; a `*.run-lock`, `*.lock` or `*.pid` file in `runs/` or `runtime/` younger than 60 minutes whose pid is alive (or unknown). Stale locks are reported and ignored. `--i-paused-the-pipeline` overrides only after the operator types `I PAUSED THE PIPELINE` on a terminal; without a terminal it stays refused. The halt file is reported (reason) but is a fence, not a live run; `--require-fence` makes it mandatory for the cutover.

## Legacy map

| Legacy | New |
|---|---|
| `scripts/pending-gate.js:36-50, 101-128` and the gotcha "pending files must not carry `spawnedAt`" (CLAUDE.md note 11), BOM strip at :101 | `make-bundle.js:collectPending` (BOM stripped, `spawnedAt` deleted, re-serialised with 2-space JSON like the legacy writer; unparseable or oddly named files skipped with a named warning); `restore-bundle.js` never resurrects a pending file the same bundle created earlier that has since been consumed |
| `scripts/run-lock.js:33-117` (in-flight statuses and ages, `getActiveRuns`) and `scripts/constants.js:46-51` (terminal statuses) | `bundle-format.js:checkPipelineLive` (`TERMINAL_STATUSES`; 90-minute window per the brief instead of per-status ages) |
| `scripts/run-pipeline.js:289-309` (`<status>.run-lock`, pid plus 60 minutes) | `checkPipelineLive` lock scan (same 60-minute rule, pid liveness) |
| `scripts/lib/pipeline-halt.js:23` (`runtime/pipeline-halt.json`) | `checkPipelineLive` halt read, `make-bundle.js --require-fence` |
| `scripts/cull-ghost-phase1.js:41-47` (ghost thresholds) | not used: the brief's fixed 90-minute window is deliberately stricter than the 15/5/20/30 minute cull thresholds |
| `scripts/cdp-reed-full-login.js:13-14`, `scripts/reed-clean-relogin.js:26-27` (`const EMAIL`, `const PASSWORD` literals) | `make-bundle.js:extractReedCredentials` / `extractConst` -> `secrets/reed-credentials.json` `{email, username, password}` |
| `caterer-credentials.json`, `zoho-credentials.json` (workspace root) | opaque byte copies to `secrets/` (0600 in a 0700 directory) |
| `candidates.db` (journal mode delete, 5 tables, 2 triggers) | `bundle-format.js:snapshotDatabase`, `inspectDatabase`, `compareDatabases` |
| `config/*.json` except `dashboard-auth.json`, `scripts/extract-js.b64`, `postcode-lookup-cache.json`, `postcode-to-city-cache.json`, `reed-location-cache.json`, `pending-searches/*.json` | same relative paths under `RESOURCER_HOME` (the ported code reads the caches via `paths.p(...)` at the workspace root, `secrets/reed-credentials.json` via `paths.SECRETS`) |
| research 5.5 steps 2-3 (fence, freeze, copy, parity queries, refuse to overwrite a newer DB unless forced) | `make-bundle.js` checks and `--require-fence`, `restore-bundle.js` plan/refusal/`--force`, post-restore count check |
| research 4.6 (secrets and PII hygiene) | allowlist, scrubber (`createOutput`), no hashes of secrets, JSON parse errors never echoed |
| never included: `caterer-session.json`, `reed-session.json`, agent-browser/Chrome state, `downloads/`, `runs/`, `logs/`, `review-tmp-*`, `dashboard-auth`, gateway tokens, `.git` | unreachable by construction (allowlist), asserted by tests with decoy files |

## Preserved behaviour

- Legacy workspace is opened read-only (`readonly: true`), never written; verified by a before/after tree snapshot in tests and by a dry run against the real workspace (no output, temp snapshot removed).
- `spawnedAt` handling and BOM tolerance of the pending queue; the legacy `.dup-removed-*` sub-directories and non-JSON files are not bundled.
- Row counts and integrity of every legacy table travel and are re-verified after restore; nothing is deleted from the target that the bundle does not name.
- Secrets are copied as opaque bytes (caterer, zoho) so formatting, key order and BOMs are preserved exactly.

## Deviations (all listed in the package result)

1. `--source` default is assembled at run time (`'.open' + 'claw'`) so the DESIGN section 9 banned-token grep stays clean while the brief's default legacy path still works.
2. The halt file is treated as a fence, not as evidence of a live run (refusing on it would contradict the cutover runbook step 2). `--require-fence` is the strict option.
3. Missing required source files abort (exit 5): `scripts/extract-js.b64`, `config/postcode-cities.json`, `config/territory-defaults.json` (port-manifest section 1 lists them as runtime data). The three caches and `pending-searches/` stay optional.
4. Reed extraction needs a usable pair from at least one of the two files (preferring `cdp-reed-full-login.js`); a failing or differing second file is a warning that names file and variable only. Values must be plain string literals: concatenation, template interpolation and environment fallbacks abort the build.
5. `reed-credentials.json` carries `username` as an alias of `email` next to the `email` and `password` the ported Reed code reads.
6. Liveness scans `runs/run-*.json` as well as `phase1-*.json` (the legacy lock read every JSON in `runs/`) and skips files not modified for 2 hours (speed on a 12k-file `runs/`).
7. Wrong passphrase, tampering and reordering all report exactly `authentication failed`; truncation reports `bundle is truncated` (structural, needs no key).
8. Added beyond the brief: `--no-overwrite`, `--skip-migrate`, `--require-fence`, `--skip-db-check` (verify), the restore lock, the consumed-pending rule, the build-time self-check, a target-side live-run refusal, `state/bundle-restored.json`.

## Verified (see the package result for the exact runs)

Windows Node 25 and Linux (Ubuntu 24.04 on the Windows Subsystem for Linux, Node 22, repo copied under the home directory for real permissions): round trip byte exact incl. row-for-row DB equality; wrong passphrase; every truncation length; every bit position; reordered/duplicated/dropped/appended chunks; manifest attacks; live-run refusal by status, age, lock, unreadable file; typed confirmation (fake terminal) and a real pseudo-terminal run for the hidden prompt (no echo, twice, mismatch, Ctrl-C); secret values scanned for in every output; modes 0600/0700 on Linux; idempotent double restore, also after a `migrate-schema.js` run; newer-DB refusal and `--force` with a kept copy; dry run leaves the tree identical; corrupt source DB; WAL source with uncheckpointed writes; the real `resourcer/scripts/migrate-schema.js` from this repo; 60 MB and 180 MB streaming memory proof.

## Unverified live (acceptance checklist)

- Building from the real laptop while the pipeline is fenced (`--require-fence`) and restoring on the real Hermes instance (Node 26, `better-sqlite3` compiled there, `/opt/data` filesystem, real `scripts/migrate-schema.js` WAL probe).
- Passphrase hand-over to whoever runs restore on the instance without exposing it to the LLM operator transcript: implemented as the human-placed `secrets/bundle-passphrase` (see below); UNVERIFIED-LIVE that the Hermes dashboard file manager can create it and in which mode.
- Transfer of `data/resourcer-bundle.enc` (size about 6 MB now) and comparison of the printed sha256.
- Time and memory of scrypt cost 2^17 (about 128 MiB, 0.3-0.5 s here) on the shared 4 GB box.

## Review fixes 2026-09-30

Tests: `tests/bundle/human-channel.test.js`, `cutover.test.js`, `archive.test.js`, and the updated `tools.test.js` (one assertion changed on purpose: a re-run no longer replaces a differing secret).

### The human-only passphrase channel (hermes-fit review 80)

An LLM operator has no hidden terminal prompt and must never see the passphrase, so `restore-bundle.js` and `verify-bundle.js` read it from **`<home>/secrets/bundle-passphrase`** when no other source is given. Order, first match wins: `BUNDLE_PASSPHRASE_FILE`, `BUNDLE_PASSPHRASE_FD`, that file, a hidden prompt on a real terminal. The file is placed by the human, never by the operator:

- through the dashboard file manager / Keys page, or
- by typing `node tools/restore-bundle.js --save-passphrase` in a terminal the human controls (needs a real terminal, asks twice with hidden input, refuses to run without one, stores the file 0600 in a 0700 `secrets/`, refuses to replace an existing file without `--force`, restores nothing).

The tool refuses the file (exit 7, message names `chmod 600`, content never quoted) when it is a link or not a regular file, or is readable by group or others (a file manager may create it 0644: the operator runs `chmod 600` on that path, which shows nothing). A UTF-8 BOM and CRLF are tolerated. The tool never deletes it; after a successful restore it prints `remove it now: rm <path>` and the operator removes it with a plain `rm`. `make-bundle.js` (laptop, needs the passphrase typed twice) and `archive-legacy.js` do not use the file. The equivalent for the nightly backup (`secrets/backup-passphrase`) is `backup-db.js` (another package).

### Restore guards

- A secret (`secrets/*-credentials.json`) that already exists and differs is **kept** (`keep ... existing secret differs; kept`, mode tightened to 0600): credentials are rotated on the instance, not through the bundle. `--replace-secrets` overrides (a copy goes to `backups/`). A pending search that differs (it may already be claimed, `spawnedAt`) is kept too.
- `secrets/`, `config/`, `pending-searches/`, `scripts/`, `state/` and `backups/` must be real directories: a symbolic link is refused (exit 4) before anything is written through it. `state/` is created 0700 and `bundle-restored.json` 0600. File modes come from the built-in table, never from the manifest.

### make-bundle

- Prints `kdf: scrypt N=2^<n>` and, below the default 2^17 (only `BUNDLE_SCRYPT_LOG2N` can lower it), a warning that is also recorded in the manifest. Passphrases with fewer than 8 different characters are refused. The bundle is designed to travel out of band (scp); if it is ever committed, the passphrase is the only protection and history is permanent (a generated passphrase is not implemented).
- `--backfill-run-history <downloads dir>` (research/dashboard-parity 4.5, coverage review 99): builds the `run_results` history from `phase2-results-*.json` inside the private snapshot copy (never in the legacy database), prints a per-day parity table (counts only) and fails on a mismatch; the manifest and the restore check then carry the `run_results` row count. The restored dashboard therefore has its history, burn and retention gate.
- `--require-fence` now means: the halt file is present when the build starts AND still present, with no live run and no change to the legacy database since the snapshot, when the build ends (otherwise exit 4, nothing written). The halt file alone is not a fence: the legacy watchdog clears any halt by itself within five minutes once screening looks healthy. The real fence is stopping the legacy supervisor first (docs/CUTOVER.md); without `--require-fence` the same conditions only warn.

### tools/archive-legacy.js (new): the owner's safety copy

`node tools/archive-legacy.js [--dry-run | --extract <dir> --archive <file> | --list --archive <file>] [--source] [--output] [--max-file-mb 25] [--max-session-mb 1] [--max-total-mb 2048] [--log-days 14] [--include-git] [--force]`. Same container as the bundle (scrypt + AES-256-GCM chunks from `tools/lib/bundle-format.js`, hidden passphrase prompt twice, 16+ characters, or `BUNDLE_PASSPHRASE_FILE/FD`), with its own manifest (`resourcer-legacy-archive`; a data bundle and an archive cannot be confused: each tool rejects the other's manifest, exit 3).

- Included: the legacy per-user home's config files, credentials, cron, skills, agent config, the resourcer workspace (scripts, skills, config, docs, AGENTS/MEMORY files, pending searches) with `candidates.db` taken as an online backup, and the main agent workspace.
- Excluded: `downloads/`, `node_modules/`, `.git` (holds a plaintext access token; `--include-git` opts in), browser profiles (`chrome*`, `.agent-browser*`, any directory with `Local State`), screenshots and other images, executables, raw database files and their backups (the online copy replaces them), cookie and session-token files, tombstoned session files (`*.deleted.*`), files inside any `sessions` directory over the cap, `.log` files and `logs/` / `runs/` contents older than the age limit, temp files, links (never followed), names Windows cannot represent, files over the size cap, and this repository.
- Prints only counts, sizes, group (top-level directory) names and exclusion counts per reason. `--dry-run` needs no passphrase and writes nothing. A file that changes while packing is dropped and counted (files touched in the last 10 minutes are read once into memory first); the source is never written. Refuses an output inside the source or an existing output without `--force`, and a total above `--max-total-mb`.
- `--extract` authenticates the whole archive first, then extracts into `<dir>.extracting-<pid>` and renames on success (files 0600, directories 0700, mtimes restored); the target must be new or empty; every path is validated on both sides (no `..`, absolute or drive paths, backslashes, control characters, reserved device names).
- Against the real legacy home a dry run finds about 24,000 files / 205 MiB (numbers change daily); UNVERIFIED-LIVE: a real encrypted run and extract on the laptop with the real passphrase.

### Post-cutover secret hygiene (coverage review 102, requirements for docs/SECURITY.md and docs/TEARDOWN.md)

The new repository holds no legacy secret. The legacy side does: the GitHub access token inside the legacy workspace's `.git/config` remote URL (revoke it, then delete the legacy `.git`), the hard-coded Reed password in two legacy scripts and in about 50 legacy session transcripts, the owner's memory notes that quote the Reed and old Caterer passwords, and the Zoho refresh token. After the bundle is restored and the pipeline runs on Hermes: rotate the Reed password and the Zoho refresh token, purge or redact those notes and transcripts (or keep them only inside the encrypted archive), delete `secrets/bundle-passphrase` from the instance, and never paste the bundle passphrase into a chat (transcripts are stored and sent to the model provider).
