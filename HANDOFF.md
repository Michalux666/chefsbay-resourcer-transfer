# Hand-off: where things stand and what you do next

This is the page to read first. It says what exists, how far it has been proven, what only you can do, and in which order. Everything else is linked from here; nothing in this page replaces those documents.

## 1. What you have

The CV-sourcing pipeline (Caterer.com and Reed.co.uk, AI screening, unlock and download, Zoho Recruit) has been rebuilt to run on a Hermes Cloud profile named `resourcer` instead of the Windows laptop. The behaviour, the state-file formats, the exit codes and the reliability layers of the old system were kept; every deliberate difference is listed in `docs/DECISIONS.md`. Nothing in this repository contains a secret or real candidate data: the database, the credentials and the config travel only in the encrypted bundle `data/resourcer-bundle.enc`, which you build at cutover.

| Part | Where | What it does |
|---|---|---|
| The pipeline | `resourcer/` | Phase 1 (search and scrape), screening, Phase 2 (unlock, download, Zoho push), supervision, alerts, backups, retention |
| The cron jobs | `hermes/cron/jobs.json`, `hermes/scripts/` | Eight small no-agent jobs; no AI is involved in supervision |
| The operator | `hermes/AGENTS.md`, `hermes/SOUL.md`, `hermes/skills/resourcer-ops/` | The standing instructions of the Hermes agent that installs and watches it. It operates; it never edits code |
| The dashboard tab | `plugin/resourcer/` | Live progress, targets, halt banner, search request form, inside the Hermes dashboard |
| Tools | `tools/` | Data bundle (make, restore, verify), code manifest, environment probes (`preflight.sh`), search request, screening report, legacy archive |
| Tests | `tests/` | About 1,600 offline tests and 12 end-to-end scenarios; all pass (`README.md` has the commands) |

## 2. How far it is proven

- Proven offline: the code paths, the state files, the exit codes, the restart and recovery behaviour, the encrypted bundle round trip, and the install runbook (an operator LLM dry-ran `docs/INSTALL.md` against a simulated Hermes; the documentation problems it found are fixed in this version, the few code-side ones are listed in `docs/KNOWN-LIMITS.md` section 10).
- Not provable without the real world (UNVERIFIED-LIVE): the real Hermes host (cron behaviour, approval prompts, scale-to-zero), Caterer from the datacenter address (its bot protection may block it), the Reed login (needs you once), Zoho, and the AI Gateway. Each of these is a numbered check in `docs/ACCEPTANCE.md`; the honest list of what is imperfect is `docs/KNOWN-LIMITS.md`.
- So the first live day is a supervised trial, not a launch: the install stops at a GO / NO-GO for Caterer (`docs/INSTALL.md` step 8), and the first cycle is watched end to end (step 11).

## 3. What you do, in order

Today, at the laptop (`docs/CUTOVER.md`; every command in it is typed by you in PowerShell, and the passphrases are typed only by you):

1. Prepare: three different passphrases (bundle, archive, backup) in your password manager; a GitHub login; the Hermes Portal login; a funded Vercel AI Gateway key; a decision where alerts go (phone-reaching channel) and where the off-instance backup goes. (CUTOVER step 0.)
2. Fence the old system so it cannot touch Caterer, Reed or Zoho again (CUTOVER steps 1 and 2). Two systems on one Caterer account log each other out and double-unlock candidates.
3. Build and verify the encrypted bundle (step 3). Build the encrypted archive of the old system and copy it off the laptop (step 4).
4. Commit and push to a NEW private GitHub repository, after the scan says nothing sensitive is tracked (step 5). Or use the tarball route of `docs/INSTALL.md` 2.7.
5. Paste `OPERATOR-PROMPT.md` (with its three inputs filled in) into the Hermes chat of the `resourcer` profile (step 6). From here the operator follows `docs/INSTALL.md` and asks you for the human-only things.

While the install runs (`docs/INSTALL.md` section 0.4 lists them as H1 to H11; CUTOVER step 7 has the timeline): add the read-only deploy key on GitHub; type the AI Gateway key and the backup passphrase on the dashboard Keys page; create the bundle passphrase file; confirm in writing that the old pipeline is stopped; read the newest Caterer e-mail and hand its link over once; choose the alert channel, give the operator the exact target text and confirm the test alert arrived; press Restart for the dashboard in the portal; check three new Zoho records after the first run.

Before the laptop is wiped or leaves you (`docs/CUTOVER.md` step 9, `docs/TEARDOWN.md`, `docs/SECURITY.md` section 10): revoke the GitHub token that sat in the old repository's address, rotate the Reed password and the Zoho refresh token, purge the old transcripts and notes that contain credentials, and only then delete the old system. Do not wipe before the gate in CUTOVER 11.1 is true; the laptop is your rollback path (`docs/ROLLBACK.md`).

If time is short, the honest minimum is in the table in CUTOVER section 1: fence, verify idle, build the bundle, copy it off the laptop, store the passphrase, revoke the token. The pipeline is then down until Hermes is installed from the bundle, but nothing is lost.

## 4. Decisions waiting for you

| Decision | Default | Where |
|---|---|---|
| Alert channel and who reads it before 09:00 | none: the install stops until you name one | INSTALL 9.4, ACCEPTANCE DC5 |
| Off-instance copy of the nightly backups (`BACKUP_UPLOAD_CMD`) and an external dead-man monitor | recommended; a backup on the same volume does not survive losing the instance | INSTALL 6.1, OPERATIONS section 14 |
| Reed before or after the first cycle | after (Caterer only at first; Reed needs you for about 30 minutes) | INSTALL 9.8 and step 12 |
| Zero data retention at the AI Gateway | decided from the result of INSTALL 7.5 | SCREENING section 12 |
| Screening engine: the language model decides and the small model (Jev) only takes notes | `jev_shadow`; promotion later, on the calibration report | SCREENING section 9, INSTALL 13 |
| Whether the data bundle travels through git or out of band | git, protected by its passphrase (permanent in history) | CUTOVER step 5, SECURITY section 5 |
| When the old laptop system is retired | after the acceptance gate | TEARDOWN |

## 5. Rules that keep it safe

- The code on the instance is locked. `tools/check-manifest.js` must say `MANIFEST_OK`. After any intended change, run `node tools/make-manifest.js` as the last step and commit `MANIFEST.sha256` (`README.md`, `docs/OPERATIONS.md` section 12).
- Secrets are typed only by you (Keys page or your own terminal). If one appears in a chat, rotate it.
- Nobody starts a second copy of the pipeline anywhere while Hermes is the live one.

## 6. Reading order

`README.md` (map of the repository), `docs/CUTOVER.md` (you, today), `OPERATOR-PROMPT.md` (what you paste), `docs/INSTALL.md` (what the operator does), `docs/ACCEPTANCE.md` (go-live checks), `docs/OPERATIONS.md` (day to day), `docs/KNOWN-LIMITS.md`, `docs/ROLLBACK.md`, `docs/TEARDOWN.md`, `docs/SECURITY.md`, `docs/ENV.md`, `docs/SCREENING.md`, `docs/DECISIONS.md`, `docs/LEGACY-MAP.md`, `docs/DESIGN.md`.
