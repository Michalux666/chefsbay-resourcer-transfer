# ROLLBACK: going back, and what is and is not recoverable

Audience: the owner (the operator agent may run the instance-side commands when the owner asks). Read section 0, then only the scenario that matches.

Companion pages: `docs/CUTOVER.md` (how you got here), `docs/TEARDOWN.md`, `docs/OPERATIONS.md`, `docs/INSTALL.md`.

## 0. The honest summary

- Until the laptop is wiped, going back is a documented procedure: pause Hermes, take Hermes's database back to the laptop with a merge, restart the old system (section A). The merge script was tested on synthetic databases and the decrypt step on a synthetic backup; the whole sequence has not been rehearsed on the real systems. It costs about an hour and one Caterer re-login (probably with a safe-list link).
- After the wipe, going back to the OLD system is effectively impossible. The encrypted archive keeps its files, not its environment (Windows scheduled jobs, the Linux subsystem, the sign-ins of the old gateway, the Reed browser profile, the tunnel). What you can do after the wipe is fix forward on Hermes, restore Hermes's own database from a backup, or rebuild Hermes elsewhere (section B). Plan the wipe with that in mind; the gate in `docs/CUTOVER.md` step 9 exists for this reason.
- The database is the asset. It records which candidates are already screened, rejected, unlocked (paid for) and in Zoho, and when each territory is due. Losing it does not lose the candidates in Zoho, but the pipeline would screen and unlock everyone again (paying credits again). Every scenario below is about not losing it, or getting it back.
- Neither system may run while you switch. Pause one completely before the other starts.

### 0.1 When to roll back (the decision rule)

Rolling back is a decision for you, not the agent. Use it if, within the first week and before you rotated the Caterer, Reed or Zoho credentials:

| Situation | Roll back? |
|---|---|
| Caterer keeps re-blocking Hermes (safe-list every day) and you cannot live with the daily link | Probably: cutover step 8 says AMBER |
| Caterer search returns nothing from the datacenter address on productive territories (pool 0, errors 1), and a normal browser shows results for the same search | Yes |
| Hermes cannot reach Zoho or screening for over a day and the cause is not a key or credit balance you can fix | Yes |
| The database on Hermes is corrupt and no backup restores it | Not a rollback: you still have the laptop database as of the bundle; restore that (section B4) and merge back if needed |
| A failing territory, a red alert, a halt | No. Those have their own procedures in `docs/OPERATIONS.md` |
| Hermes works but slowly or with an occasional alert | No |

The moment you have rotated a credential the old system can no longer sign in with the old value. From then on going back means also putting the new value back into the old files (Caterer: `caterer-credentials.json` in the old workspace; Reed: two hard-coded scripts; Zoho: `zoho-credentials.json`). That is possible but is a repair, not a rollback. Keep a note of what you rotated and when.

## A. Before the wipe: back to the laptop

Assumes: the laptop is fenced as in `docs/CUTOVER.md` step 1 (watchdog stopped, three OpenClaw jobs disabled, halt set to `migration`), the repo and the old workspace are still on it, and the bundle tools worked from there.

### A1. Pause Hermes (instance)

Use the profile-scoped commands. Do NOT use the host-wide pause (`hermes pause`): it stops every profile on the machine. Do NOT stop the profile's gateway: it parks the profile and drops its cron jobs. Pausing only stops new fires.

```sh
hermes -p resourcer cron pause resourcer-tick
hermes -p resourcer cron pause resourcer-queue-due
hermes -p resourcer cron pause resourcer-preflight
hermes -p resourcer cron pause resourcer-keepalive
hermes -p resourcer cron pause resourcer-maintenance
hermes -p resourcer cron pause resourcer-retention
hermes -p resourcer cron pause resourcer-backup
hermes -p resourcer cron list
```

Leave `resourcer-alerts` running if you want the alert channel to keep working during the change; pause it too if you do not.

### A2. Let the run in flight finish

```sh
cd /opt/data/profiles/resourcer/workspace/resourcer
node scripts/pipeline-watchdog.js --status
```

Read `busy` and `run`. Wait until `busy` is false (a run is normally 4 to 15 minutes; the ceiling is 70). Do not kill a run that is in its Zoho push (Phase 2) or after unlocks: unlocked candidates that were not pushed are not looked at again by any later run. If a run is provably stuck (no log growth in `logs/` for 20 minutes), stop it by pid: `kill <run.pid>` and, if set, `kill <run.childPid>`, both from the status output, and note which territory (`run.file`) it was. Its leftover status file is inert and is not carried to the laptop.

Also check the queue for anything you need to carry back: `node scripts/pipeline-watchdog.js --status` shows `queueDepth` and `quarantined`; one-off searches you requested from the dashboard are files named `search-*.json` in `pending-searches/` (list names only: `ls pending-searches`).

### A3. Take the database from Hermes

Create a fresh encrypted backup (this is consistent even if something is writing), and note its name:

```sh
node scripts/backup-db.js --backup
node scripts/backup-db.js --list
```

Move the newest `backups/candidates-<time>.db.gz.enc` (and nothing else) to the laptop. The file is encrypted and small (about 1.5 MB), so any route is acceptable: the off-instance destination your backups already go to (`BACKUP_UPLOAD_CMD`; `node scripts/backup-db.js --auto` makes a backup and uploads it in one go, and the laptop then fetches it from that destination), the dashboard file tools if they offer a download, or, failing both, ask the operator to commit the encrypted file to a private branch of the transfer repo with a temporary write-enabled deploy key (remove the key afterwards).

### A4. Decrypt it on the laptop (PowerShell)

The backup passphrase comes from your password manager. Put it in a file only for the duration of this step, in a temporary folder outside the repo, and delete the file afterwards. Nothing here prints it.

```ps1
$LEGACY = Join-Path $env:USERPROFILE '.openclaw\workspace-resourcer'
$REPO   = Join-Path $env:USERPROFILE '.openclaw\hermes-port\repo'
$WORK   = Join-Path $env:USERPROFILE 'rollback-work'
New-Item -ItemType Directory -Force -Path $WORK | Out-Null
# Create $WORK\pp.txt now in a plain editor: one line, the backup passphrase. Put the downloaded backup next to it.
$env:RESOURCER_HOME = $WORK
$env:NODE_PATH = Join-Path $LEGACY 'node_modules'
node "$REPO\resourcer\scripts\backup-db.js" --restore "$WORK\candidates-<time>.db.gz.enc" --out "$WORK\hermes-snapshot.db" --passphrase-file "$WORK\pp.txt"
Remove-Item "$WORK\pp.txt"
```

It prints one JSON line: `{"ok":true,"out":...,"tables":{...}}`. The file is the Hermes database as of that backup, integrity-checked. `NODE_PATH` lends the old workspace's SQLite driver to the repo's script. If it says `no backup passphrase`, the passphrase file is missing; if `integrity_check failed`, the backup is bad: use the previous one from `--list`.

### A5. Merge it into the laptop database

The two databases share the same tables. The merge is: add what Hermes learned, never remove anything, never overwrite the laptop's Zoho ids. It is safe to run twice (a second run touches nothing except the Reed daily counters). The script is in section D. Save it as `$WORK\merge-back.js` (if `tools\merge-back.js` exists in the repo, use that instead), then run it in the same PowerShell window as A4 (it needs the `NODE_PATH` set there), with the old system stopped:

```ps1
Set-Location $WORK
pm2 list        # pipeline-watchdog must read "stopped"
node merge-back.js "$LEGACY\candidates.db" "$WORK\hermes-snapshot.db"
```

It first copies the laptop database to `candidates.db.pre-merge-<time>` beside it, then prints the rows touched per step and the counts before and after, and ends `MERGE_OK`. The counts must have gone up by roughly what Hermes did (new candidates, more with a Zoho id). "zoho id disagreements (laptop value kept)" should be 0; a small number means the same candidate was created in Zoho by both systems: check those two records in Zoho by hand. If anything fails, it rolls the change back and says so.

Then verify (prints counts only):

```ps1
node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(d.pragma('integrity_check',{simple:true}));for(const t of ['candidates','candidate_rejections','territory_searches','reed_daily_usage'])console.log(t,d.prepare('select count(*) c from '+t).get().c)" "$LEGACY\candidates.db"
```

### A6. The queue on the laptop

Files in the old `pending-searches\` were written before Hermes ran territories; running them would repeat work. Move them aside and let the old system rebuild the queue from the merged `next_run_date` values (its own catch-up does this every few minutes):

```ps1
Rename-Item "$LEGACY\pending-searches" 'pending-searches.pre-rollback'
New-Item -ItemType Directory "$LEGACY\pending-searches" | Out-Null
```

If you had dashboard one-off searches still pending on Hermes (A2), re-request them on the old dashboard or copy their `search-*.json` files into the new folder (they carry no claim stamp).

### A7. Restart the old system

```ps1
node "$LEGACY\scripts\pipeline-halt-cli.js" clear
openclaw cron enable da4b812d-1da3-4b35-8870-a93ae5890ec2
openclaw cron enable 29bfeb15-38e6-4287-aca6-c736f6561d46
openclaw cron enable dccc2de4-baf0-4f32-936f-617ac0222fde
openclaw cron list
openclaw gateway status
pm2 restart pipeline-watchdog
pm2 save
pm2 list
```

(The three IDs are Territory Scheduler, Caterer Overnight Keep-Alive and Caterer Daily Pre-Flight; confirm the names in `openclaw cron list`.) The old screening needs the OpenClaw gateway running and signed in; `openclaw gateway status` must say it is. The old watchdog also probes it and holds the queue (a halt) if it is not.

### A8. The Caterer session on the laptop

Hermes signed in to the same Caterer seat, which signed the laptop out. Expect the old watchdog to log `SESSION_STALE`, try one automatic re-login and probably hit the safe-list check. Use the old procedure you used before the port (the "Login procedures reference" note in your memory folder describes it: open the newest emailed link in the same browser session). Reed: the laptop's Reed Chrome profile is untouched; if you changed the Reed password meanwhile, the two old scripts that hard-code it must be updated first.

### A9. Leave Hermes safe

Keep the instance and its volume; do not delete anything. The jobs stay paused. The nightly backup job is paused too, so make one last backup now if you might come back: `node scripts/backup-db.js --auto`. Write down: what failed, what the alerts said, the time you paused, and the row counts before and after the merge. When you are ready to try again, start from `docs/CUTOVER.md` step 1 (the old system's database is now the newer one; make a new bundle).

### A10. Abandoning the Hermes install completely (only if you are not coming back)

Pausing (A1) is enough for a temporary rollback. To undo what the install put on the instance, reverse `docs/INSTALL.md` Appendix A in this order, after you have a backup of the database somewhere else (deleting the workspace deletes `candidates.db`):

1. Remove the eight jobs, one at a time, checking with `hermes -p resourcer cron list`: `hermes -p resourcer cron remove resourcer-tick`, then `-queue-due`, `-preflight`, `-keepalive`, `-alerts`, `-maintenance`, `-retention`, `-backup` (all prefixed `resourcer-`).
2. Remove the cron wrappers: `rm -f /opt/data/profiles/resourcer/scripts/resourcer-*.sh` (no recursive delete needed).
3. Remove the dashboard plugin as `plugin/resourcer/README.md` ("Roll back") says: disable it in both places (`hermes plugins disable resourcer` and `hermes -p resourcer plugins disable resourcer`), remove the profile link and the plugin folder (recursive delete: the owner approves), then the owner restarts the dashboard from the Portal.
4. Remove the keys from the profile: the owner deletes `AI_GATEWAY_API_KEY`, `BACKUP_PASSPHRASE`, `RESOURCER_DEADMAN_URL`, `BACKUP_UPLOAD_CMD`, `BACKUP_UPLOAD_ENV` and any `BUNDLE_PASSPHRASE` on the Keys page, and revokes the AI Gateway key at the provider.
5. Remove the code and data (owner, recursive delete with approval): `/opt/data/profiles/resourcer/workspace`, the deploy key folder `/opt/data/profiles/resourcer/deploy`, `/opt/data/profiles/resourcer/install-work`, `/opt/data/profiles/resourcer/skills/ops/resourcer-ops`, `SOUL.md`. Delete the deploy key on GitHub (Settings > Deploy keys of the transfer repository).
6. Follow `docs/TEARDOWN.md` T3 to T8 for the repository and the bundle.

## B. After the wipe: what is recoverable

### B1. What exists, where

| Item | Where it lives | Survives the wipe? | Notes |
|---|---|---|---|
| Live database | Hermes volume: `candidates.db` | Yes | Not in your control if the instance is lost |
| Nightly encrypted backups | Hermes volume `backups/`: 14 daily and 8 weekly | Only while the instance volume survives | Same volume as the database: a broken instance loses both |
| Off-instance backup copy | The destination you set with `BACKUP_UPLOAD_CMD` | Yes, if you set it up and the upload succeeded | The only backup that survives loss of the instance. Alert `backup-upload` means it did not |
| Backup passphrase | Password manager and paper | Yes | Without it every backup is unreadable |
| Data bundle | The transfer repo on GitHub; a copy off the laptop | Until `docs/TEARDOWN.md` | Frozen at the cutover moment; older than every backup |
| Bundle passphrase | Password manager and paper | Yes | |
| Encrypted archive of the old system | Off-laptop storage | Yes | Old files and an online copy of the old database as of step 4 |
| Zoho Recruit | Zoho | Yes | The candidate records; each carries the Caterer or Reed id, which is how the database can be rebuilt (B5) |
| Code | The transfer repo (GitHub); the instance working tree; your own copy (see TEARDOWN) | See TEARDOWN | Keep a copy that is not the transfer repo |
| Credentials | `secrets/*.json` on the instance; password manager | Only if you stored the rotated values in the password manager | After a rotation the instance file and the password manager are the only copies |
| Sessions (Caterer, Reed), browser profile | `state/` on the instance | No: never backed up on purpose | A rebuild signs in again: Caterer with a safe-list link, Reed with a human login |
| The old system's environment (OpenClaw sign-ins, Windows jobs, WSL, Reed profile, tunnel) | The old laptop | No | Not recoverable from the archive. Rebuilding it is a project, and not recommended: rebuild Hermes instead |
| Screening shadow log | Hermes volume `shadow/` (180 days) | Same as the database | Not needed to run |
| Run history (dashboard numbers) | `run_results` table inside the database | With the database | The history up to the cutover was put into the bundle by `make-bundle.js --backfill-run-history` (counts only); the old per-run result files themselves were not carried over |

### B2. Hermes is up but something is wrong: fix forward

Do this first; most problems are not data loss. Start with `docs/OPERATIONS.md` (status, alert keys, Caterer session, halts). Nothing in section B is needed for a halt, a safe-list block, a failing territory, a full disk or a Reed login problem.

### B3. Restore the live database from a backup (same instance)

Use when `db-unfit` fired, the database is corrupt, or rows were lost. The tick refuses to start on an unfit database, so nothing runs while you do this.

```sh
cd /opt/data/profiles/resourcer/workspace/resourcer
hermes -p resourcer cron pause resourcer-tick
hermes -p resourcer cron pause resourcer-queue-due
hermes -p resourcer cron pause resourcer-backup
node scripts/pipeline-watchdog.js --status
```

Wait for `busy` to be false. Then:

```sh
node scripts/backup-db.js --list
node scripts/backup-db.js --restore backups/<chosen>.db.gz.enc --out state/restore/candidates.db
node scripts/preflight-db.js --db state/restore/candidates.db
```

`--restore` decrypts with `BACKUP_PASSPHRASE` from the profile `.env`, or `secrets/backup-passphrase`, or `--passphrase-file <path>`; it refuses to write over an existing file without `--force`; it checks integrity before it reports success. `preflight-db.js` must exit 0. Choose the newest backup that passes; if the newest is the corrupt one, take the previous day's.

Put it in place, keeping the broken files:

```sh
mv candidates.db candidates.db.broken
mv candidates.db-wal candidates.db-wal.broken 2>/dev/null
mv candidates.db-shm candidates.db-shm.broken 2>/dev/null
cp state/restore/candidates.db candidates.db
chmod 600 candidates.db
node scripts/migrate-schema.js
node scripts/preflight-db.js
```

Then resume the jobs (`hermes -p resourcer cron resume <name>` for each you paused). Keep `candidates.db.broken` until you are sure; delete it and `state/restore/` afterwards (they hold the same data, unencrypted). What is lost is everything between the backup and the failure, up to about a day. Candidates unlocked in that window and already in Zoho will look new to the pipeline: the next run may screen and unlock them again (a wasted credit each, and Zoho answers DUPLICATE). There is no tool to reconcile this; the loss is bounded by the 03:30 backup schedule, which is why a fresh manual backup (`node scripts/backup-db.js --auto`) before any risky change is worth doing.

### B4. Hermes is gone: rebuild elsewhere

Pick the newest good restore point, in this order:

1. The newest off-instance nightly backup (loses at most about a day).
2. The newest backup still on a surviving volume.
3. The bundle (the database as of the cutover; everything since is missing).
4. The archive (`node tools\archive-legacy.js --extract <empty dir> --archive <file>`; the database inside is the old one as of step 4).
5. Rebuild from Zoho (B5).

Rebuild steps (a new Hermes instance, or any Linux machine that meets `docs/DESIGN.md` section 2: Node 22 or newer, chromium, xvfb-run, git, about 3 GB free):

1. Get the code: clone the transfer repo if it still exists, or your own copy of it (`docs/TEARDOWN.md` says how to keep one).
2. Follow `docs/INSTALL.md` up to the data step, but restore the database from your chosen restore point instead of the bundle:
   `node scripts/backup-db.js --restore <backup file> --out <RESOURCER_HOME>/candidates.db --passphrase-file <file>`, then `node scripts/migrate-schema.js` and `node scripts/preflight-db.js` (must exit 0). For a bundle: `node tools/restore-bundle.js` (it also restores the config files, caches, pending searches and the three credential files).
3. Credentials: without the bundle you rebuild `secrets/` from the password manager. The files are JSON, mode 0600 in a 0700 folder. Key names (no values here): `caterer-credentials.json` has `username` and `password`; `reed-credentials.json` has `email` (and `username` as an alias) and `password`; `zoho-credentials.json` has `client_id`, `client_secret`, `refresh_token` (the three the token refresh needs; it writes `access_token` back itself), and the old file also carried `api_domain`, `scope` and `token_type`.
4. Sessions are new: Caterer signs in (expect a safe-list link), Reed needs its one-time human login, both per `docs/OPERATIONS.md`.
5. Re-create the eight cron jobs from `hermes/cron/jobs.json` (create paused, then resume in the order it lists), set the alert channel, `BACKUP_PASSPHRASE`, `BACKUP_UPLOAD_CMD`, and run the canary of `docs/CUTOVER.md` step 8.

### B5. Every backup is gone: rebuild the database from Zoho

Last resort. No tool ships for this; it is a small project. The facts that make it possible: every candidate the pipeline pushed carries its Caterer id or Reed id in the Zoho record, so `candidates` rows with `zoho_id` and `unlocked = 1` can be reconstructed from a Zoho export. What cannot be reconstructed: rows for candidates that were seen and rejected (about 17,000 for Caterer and 22,000 for Reed at the cutover, plus the scoped rejections), and candidates unlocked but rejected after the unlock or never pushed. The pipeline would screen those again (screening costs cents) and, for anyone it approves that is unlocked-but-not-in-Zoho, pay an unlock credit again. Territories can be rebuilt from `config/territory-defaults.json` plus the list of outward codes; their schedule restarts from "due now", which produces a burst that the Caterer daily unlock ceiling (about 290) spreads over several days. Expect days of reduced quality. Prevent this instead: keep an off-instance backup and prove you can read it.

### B6. Data-loss windows in one table

| Failure | Loss |
|---|---|
| Bad run, halt, session problem | None (territories are held, not consumed) |
| Database corrupt, backup on the same volume | Up to about 24 hours of rows (B3) |
| Instance lost, off-instance backup exists | Up to about 24 hours (B4) |
| Instance lost, no off-instance backup | Back to the bundle (the cutover moment) or the archive; everything since is missing (B4) |
| Everything lost | B5 |

## C. After a rollback, or a scare

- Re-run the parity check that matters: candidate count, unlocked count and territory count before and after, from the tools' own output (`preflight-db.js`, the merge output).
- Watch the first two days closely: the digest at 18:00 (`docs/OPERATIONS.md`), the alert channel, Zoho for duplicate records created in the overlap window.
- Do not restore the bundle over a live database to "reset" anything: `restore-bundle.js` refuses to overwrite a newer database, and `--force` would discard Hermes's newer data (it keeps a copy under `backups/bundle-restore-<time>/`, unencrypted). It keeps an existing credential file that differs from the bundle's (rotated values are safe unless you pass `--replace-secrets`), but it does restore the pending searches and configuration files the bundle carries; read the plan from `--dry-run` first.

## D. The merge script

Save exactly this as `merge-back.js` (ASCII, no changes needed). It only reads the Hermes snapshot and only adds to the laptop database. It prints counts, never row contents.

```js
'use strict';
// Merge what the Hermes database learned back into the laptop database. Idempotent. Prints counts only.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const [laptopArg, hermesArg] = process.argv.slice(2);
if (!laptopArg || !hermesArg) {
  console.error('usage: node merge-back.js <laptop candidates.db> <decrypted hermes snapshot.db>');
  process.exit(2);
}
const laptop = path.resolve(laptopArg);
const hermes = path.resolve(hermesArg);
for (const f of [laptop, hermes]) {
  if (!fs.existsSync(f)) { console.error('MERGE_FAILED file not found: ' + f); process.exit(1); }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const keep = laptop + '.pre-merge-' + stamp;
fs.copyFileSync(laptop, keep);
console.log('copy of the laptop database kept as ' + keep);

const db = new Database(laptop, { fileMustExist: true });
db.pragma('busy_timeout = 15000');
db.prepare('ATTACH DATABASE ? AS h').run(hermes);
const ok = (schema) => db.pragma(schema + '.integrity_check', { simple: true }) === 'ok';
if (!ok('main') || !ok('h')) { console.error('MERGE_FAILED integrity_check did not pass'); process.exit(1); }

const n = (sql) => db.prepare(sql).get().c;
const counts = () => ({
  candidates: n('SELECT count(*) c FROM main.candidates'),
  unlocked: n('SELECT count(*) c FROM main.candidates WHERE unlocked = 1'),
  withZohoId: n('SELECT count(*) c FROM main.candidates WHERE zoho_id IS NOT NULL'),
  rejections: n('SELECT count(*) c FROM main.candidate_rejections'),
  territories: n('SELECT count(*) c FROM main.territory_searches'),
});
const before = counts();

const steps = [
  ['new candidates', `INSERT OR IGNORE INTO main.candidates (caterer_id, reed_id, source, role, location, pulled_date, unlocked, zoho_id, created_at, zoho_pushed_at)
     SELECT caterer_id, reed_id, source, role, location, pulled_date, unlocked, zoho_id, created_at, zoho_pushed_at FROM h.candidates`],
  ['unlocked by caterer id', `UPDATE main.candidates SET unlocked = 1 WHERE unlocked = 0
     AND caterer_id IN (SELECT caterer_id FROM h.candidates WHERE unlocked = 1 AND caterer_id IS NOT NULL)`],
  ['unlocked by reed id', `UPDATE main.candidates SET unlocked = 1 WHERE unlocked = 0
     AND reed_id IN (SELECT reed_id FROM h.candidates WHERE unlocked = 1 AND reed_id IS NOT NULL)`],
  ['zoho id by caterer id', `UPDATE main.candidates SET zoho_id = (SELECT x.zoho_id FROM h.candidates x WHERE x.caterer_id = main.candidates.caterer_id)
     WHERE zoho_id IS NULL AND caterer_id IN (SELECT caterer_id FROM h.candidates WHERE zoho_id IS NOT NULL AND caterer_id IS NOT NULL)`],
  ['zoho id by reed id', `UPDATE main.candidates SET zoho_id = (SELECT x.zoho_id FROM h.candidates x WHERE x.reed_id = main.candidates.reed_id)
     WHERE zoho_id IS NULL AND reed_id IN (SELECT reed_id FROM h.candidates WHERE zoho_id IS NOT NULL AND reed_id IS NOT NULL)`],
  ['rejections', `INSERT OR IGNORE INTO main.candidate_rejections (caterer_id, reed_id, job_title, rejected_at, origin)
     SELECT caterer_id, reed_id, job_title, rejected_at, origin FROM h.candidate_rejections`],
  ['territories', `INSERT INTO main.territory_searches (job_title, location, distance, keywords, active_within, cv_limit, priority, enabled, interval_days,
       candidate_count, new_to_zoho, duplicates, skipped, errors, credits_remaining, last_searched, next_run_date, sources)
     SELECT job_title, location, distance, keywords, active_within, cv_limit, priority, enabled, interval_days,
       candidate_count, new_to_zoho, duplicates, skipped, errors, credits_remaining, last_searched, next_run_date, sources FROM h.territory_searches WHERE true
     ON CONFLICT (job_title COLLATE NOCASE, location COLLATE NOCASE, distance, keywords COLLATE NOCASE) DO UPDATE SET
       candidate_count = excluded.candidate_count, new_to_zoho = excluded.new_to_zoho, duplicates = excluded.duplicates, skipped = excluded.skipped,
       errors = excluded.errors, credits_remaining = excluded.credits_remaining, last_searched = excluded.last_searched, next_run_date = excluded.next_run_date
     WHERE excluded.last_searched IS NOT NULL AND (territory_searches.last_searched IS NULL OR excluded.last_searched > territory_searches.last_searched)`],
  ['reed usage', `INSERT INTO main.reed_daily_usage (date, profile_views, cv_downloads, daily_limit)
     SELECT date, profile_views, cv_downloads, daily_limit FROM h.reed_daily_usage WHERE true
     ON CONFLICT (date) DO UPDATE SET profile_views = max(profile_views, excluded.profile_views), cv_downloads = max(cv_downloads, excluded.cv_downloads)`],
];

const conflicts = n(`SELECT count(*) c FROM main.candidates m JOIN h.candidates x ON x.caterer_id = m.caterer_id
  WHERE m.zoho_id IS NOT NULL AND x.zoho_id IS NOT NULL AND m.zoho_id <> x.zoho_id`);

db.exec('BEGIN IMMEDIATE');
try {
  for (const [name, sql] of steps) {
    const r = db.prepare(sql).run();
    console.log('  ' + name.padEnd(24) + ' rows touched: ' + r.changes);
  }
  if (!ok('main')) throw new Error('integrity_check failed after the merge');
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('MERGE_FAILED ' + e.message + ' (nothing was changed)');
  process.exit(1);
}
const after = counts();
console.log('before: ' + JSON.stringify(before));
console.log('after:  ' + JSON.stringify(after));
console.log('zoho id disagreements (laptop value kept): ' + conflicts);
console.log('MERGE_OK');
```

What it does, table by table, and what it leaves alone:

| Table | Rule |
|---|---|
| `candidates` | Rows only Hermes has are added. For rows both have: `unlocked` becomes 1 if Hermes has 1; `zoho_id` is filled if the laptop has none and Hermes has one (the old database's own trigger stamps `zoho_pushed_at` with the merge time). A different `zoho_id` on both sides is never overwritten; it is counted. |
| `candidate_rejections` | Added when the (candidate, job title) pair is new. Hermes's extra `reason_code` column is ignored. |
| `territory_searches` | New territories are added. For existing ones (matched case-insensitively on title, location, distance, keywords) the run statistics and the `last_searched` / `next_run_date` of the side that searched more recently are taken. The laptop's `enabled`, `priority`, `interval_days` and `sources` are kept. |
| `reed_daily_usage` | Larger of the two counters per date. |
| `run_results`, `reed_location_cache` | Not merged. The old dashboard reads its history from result files, which Hermes did not write on the laptop, so its history has a gap for the Hermes period. |

The script was tested on Windows Node against synthetic databases that use the old schema, the same with a Hermes-style database (WAL mode, an extra table and column), and twice in a row. It has not been run on the real databases.
