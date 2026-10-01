# RESCREEN: give the cards that Update A's review policy rejected only because Jev was uncertain a second look

Audience: the owner (sections 1 to 6) and the operator LLM of the `resourcer` profile (sections 7 to 12, a runbook in the style of `docs/UPDATE-C.md`). The tool is `tools/rescreen-policy-rejects.js`. Nothing in this document changes a criterion, an operating point, a setting or the schedule, and the tool changes no pipeline code.

## 1. What this is, and why

Until the release was installed (on 2026-10-01) the instance ran Update A (commit `d60d917`). Under Update A, snippet screening before the unlock sent every card that Jev was not decisive about to the **review policy**, and the policy default `SCREEN_REVIEW_PRE=reject` REJECTED it. That was a large share of all cards (the real share is in `node tools/screening-report.js` for those days; it was not recomputed for this document). A rejection before the unlock is booked by phase 1 as a row in `candidate_rejections` (origin `pipeline`, the job title searched), and phase 1 skips that candidate for that job title from then on: the person is never shown to Jev again for that title.

The release decides by forced choice (`docs/SCREENING-CRITERIA.md`): Jev decides at least 99 percent of the cards, in doubt it approves, and only a clear mismatch is rejected. So many of the cards Update A rejected for doubt would be approved today, and they are gone for their title. How many such candidates there are is not known until the dry run of section 8 counts them (an early guess was 100 or more a day since go-live on 2026-09-30; it has not been checked).

This tool finds exactly those rejections, clears them, and queues the territories again, a few a day, so the normal pipeline screens those candidates again under the new criteria. It is a one-off clean-up for a defect of the old policy; it is not a regular job.

## 2. What it touches, and what it never touches

| It does | It never does |
|---|---|
| Reads the shadow log (`shadow/screening-*.jsonl`, personal data, mode 0600) and keeps only ids, dates, who decided and the job title in memory. The card text in it is dropped on the spot and is never printed, copied or written anywhere. | Print or write a name, an e-mail address, a phone number, a CV or a card text, or print a candidate id. Its output is counts, days and territories (job title and outward postcode). The ledger holds the cleared rows themselves, every column (platform ids, job title, date, origin; for a Reed candidate the whole `candidates` row, whose `role` and `location` text can be filled on rows written by older code), mode 0600. Neither table has a name, e-mail or phone column. |
| Deletes exactly the selected `candidate_rejections` rows (origin `pipeline`, that job title, dated inside the window), in one transaction, after a verified backup and after a ledger of them was written. | Touch the `candidates` table or an `unlocked` flag (with ONE exception for Reed, section 6, that is OFF unless you pass `--reed-seen`). |
| Writes pending searches (`pending-searches/zz-rescreen-<time>-<id>.json`, priority low, sources as the territory asks) for the territories whose candidates were cleared, at most `--per-day` a UTC day. | Delete a row with another origin (a CV-screening rejection, `cv:...`), another job title, the `*` sentinel, a candidate that is unlocked or in Zoho, a rejection that Jev made itself, a card that was flagged as an instruction to the reader, an empty card, or anything after the unlock. |
| Writes a ledger (`runtime/rescreen-ledger-<UTC time>.jsonl`, mode 0600) with the full content of every deleted row, so `--undo` puts exactly those rows back, and, after the commit, a marker that the apply took effect (`runtime/rescreen-applied-<UTC time>.json`; an undo writes `rescreen-undone-<UTC time>.json`). Together they are the once-only guard of section 3. | Change the territory table, the scheduler, a setting, `config/screening-criteria.json` or any screening decision. A re-screen is an ordinary run through the normal queue, and `--queue` leaves out every territory at priority high or medium, because an ordinary run steps those down (section 5). |

## 3. Exactly which rejections (the predicate)

The candidate set is the intersection of two things, minus the exclusions below.

**(a) A shadow row** of stage `pre_unlock` that records the review policy rejecting a card because Jev was uncertain. Both engine shapes are read by one classifier (`classifyRow`); the Update A rows were built for the tests from the real engine of `d60d917` (`tests/rescreen/fixtures/make-rows.js`, `update-a-rows.json`), the current ones from this repository's engine (`head-rows.json`).

| Shape | Fields of the selected row |
|---|---|
| Update A (`d60d917`, `resourcer/scripts/lib/screening/engine.js`) | `stage` `pre_unlock`; `used` = `{engine: "policy", approved: false, reasonCode: "sys_review_policy_reject"}`; `policy` = `{why: "review", side: "reject", reviewReason: ...}` where the reason is `AMBIGUOUS_LEVEL`, `INSUFFICIENT_INFO`, `UNKNOWN_SEARCH_LADDER` or `<code>_UNCERTAIN` (the classifier accepts any reason except `INJECTION_FLAG` and `ANSWER_UNUSABLE`; these four are the ones the pre-unlock stage of that engine can produce); `jev` = `{status: "ok", lane: "review", reviewReason}`; no `injection`, `card_unreadable` or `no_content` flag. |
| Current engine | The same fields exist, but its `decide()` forces a choice for every usable answer, so it never reaches the review lane for an uncertain card: its rows are Jev decisions (`used.engine` `jev`, a doubtful one carries the flag `forced` in `jev.flags`) and, rarely, policy rows for an instruction to the reader or an empty card. The classifier would still place a row of the current engine by the same rule if a later engine wrote one. |

A row without a `policy` block is placed from its `jev` block; a row whose fields disagree (a `review` reason with an injection flag, `jev.status` not `ok`, an unknown `why`) or is malformed (an approval flag that is not a boolean, a `policy` or `jev` block that is not an object, `flags` that is not a list) is never selected. Not selected, whatever the shape: `why: "injection"` (the keyword filter fired and Jev was not asked, or Jev's own flag, or both), `why: "no_content"` (an empty card, Jev not asked), `why: "invalid"`, a rejection Jev made (`used.engine` `jev`), a policy APPROVAL, an unusable answer (`sys_invalid_result`, left undecided by phase 1: nothing was booked), every row of stage `post_unlock`, and the invented install-canary rows. A card that Update A decided from its decision cache wrote no shadow row at all, so it cannot be found: the dry run can only under-count (`docs/KNOWN-LIMITS.md` K-RSC1).

**(b) A stored rejection** that still exists for that candidate and job title: a `candidate_rejections` row with origin exactly `pipeline`, dated inside `--since` and `--until` and not older than the decision. Phase 1 books a rejection only after the decision, so a shadow row without a stored rejection (a page that was retried, a batch that ended unavailable) selects nothing.

**Exclusions** (each counted by reason in the dry run): the candidate is unlocked or has a Zoho id (`unlocked`); a newer shadow row shows Jev decided the card since (`newer_jev_decision`) or another decision was taken since (`newer_other_decision`); the stored rejection has origin `cv:...` (`cv_rejection`), another origin (`other_origin`) or is dated outside the window (`outside_window`); another row would still block the candidate after the delete, the `*` sentinel or a duplicate (`still_blocked`); there is no stored rejection (`no_stored_rejection`); this tool already cleared the candidate for that job title (`cleared_before`, the once-only guard below); the id is not a platform number (`bad_id`); the row names no known source (`unknown_source`).

**The once-only guard (owner requirement, 2026-10-01).** Only the people the old fallback rejected are re-screened, once, never in a loop, and the same profiles are not screened again later: only when they come up for a DIFFERENT role. So every candidate and exact job title that appears in ANY ledger (`runtime/rescreen-ledger-*.jsonl`) of an apply that took effect and was not undone is excluded for ever as `cleared_before`, whether or not a rejection row exists for it again and whether or not any shadow log exists. That matters because the second look leaves a NEW rejection row for a person Jev rejects (origin `pipeline`, a later date, possibly even the same row id and day) and its shadow row may be missing (shadow logging off, a pruned file, a decision served from the cache): without the guard the old policy row would match again and the person would be cleared a second time. How the tool knows what took effect: an apply writes its ledger first, deletes in one transaction and, after the commit, records itself in `runtime/rescreen-applied-<stamp>.json` (if a kill falls between the commit and that file, a row of the ledger that is gone or changed in the table proves it); a ledger of a rolled-back or killed apply covers nothing. An undo records itself in `runtime/rescreen-undone-<stamp>.json` and releases exactly the rows it put back; a row it left alone because a newer rejection of the same candidate and title already existed (a second look took place) stays covered. The same person for another job title is a new role and is cleared once for it. A ledger that cannot be read in full (damaged line, shorter than its marker says, a marker without its ledger, a folder that cannot be listed) is a `WARNING` in the dry run, which still counts everything it can prove; `--apply` and `--queue` refuse with exit 3 and write nothing until the file is restored (never move or delete a ledger: that removes the protection of its candidates). The ledgers and markers are never pruned (section 12). After restoring a database backup older than an apply the ledger keeps covering (fail closed): `--undo <ledger>` releases it.

**Why clearing the row is enough (the skip logic, traced).** Caterer: `resourcer/scripts/phase1/dedupe.js` asks `candidates-db.js check-batch-scoped`, which skips a card only when the candidate has `unlocked = 1` in `candidates` (never pay twice), or a `candidate_rejections` row for exactly this job title (case-sensitive), or one with the `*` sentinel. Nothing else: the seen-only `candidates` row that phase 1 also writes for a rejected card does not skip. So after the delete a cleared candidate that comes up again is passed to screening, and one whose row was not deleted is still skipped; `tests/rescreen/eligibility-caterer.test.js` proves both with the real phase 1 on a real database. The `unlocked = 1` skip and the `*` sentinel are why such candidates are excluded above: deleting their title row would not unblock them. Reed skips on something else, see section 6; `tests/rescreen/eligibility-reed.test.js` proves it with the real `reed-phase1.js`.

The window is `--since` (default 2026-09-30, a design default, not yet confirmed by the owner) to `--until` (default now), in UTC days.

## 4. What it costs: Caterer credits, Reed views, and the per-day figure

The clean-up itself costs nothing: no unlock, no Jev request, no Reed call. The cost comes afterwards, when a queued territory runs and the cleared candidates are screened again.

- **Jev requests.** One small request per screened card, like any run. No credit.
- **Caterer unlock credits.** Every candidate that Jev approves is unlocked: one credit each. A queued run is an ordinary run: it stops after the territory's CV limit of approved candidates (20 by default), counting the cleared ones and any new ones together. So the worst case is `--per-day` runs times 20, with the default 10 a day at most 200 extra unlocks a day beyond the regular sweep; the typical case is the share of the cleared candidates that the new criteria approve (the criteria approve most cards they decide). **The credits bound the queue:** `--queue` reads the newest balance that a finished run recorded (`run_results.credits_remaining`) and queues no more territories that use Caterer than `(balance - 200) / 20` (a design default reserve of 200 credits is left for the regular sweep, then 20 per queued run); it says so in its output (`credits_floor` counts the territories left out) and says plainly when no run recorded a balance, in which case the credits are NOT guarded and you read the balance in the digest first. When the credits do run out the unlock fails, phase 1 stops after a short streak of failures and keeps the search (the alert `phase1-unlock-failing` says to check the Caterer credits), so a number that is too high shows as stopped runs, not as a debt.
- **Reed profile views** (`reed_daily_usage`). Every approved Reed candidate costs at least one view, and a run asking for Reed may use up to 20 (the default CV limit). The tool respects the budget the way `tools/reed-catchup.js` does within one call: nothing that asks for Reed is queued once today's views reach the limit (300 unless `reed_daily_usage` says otherwise), and every queued file reserves 20 views of what is left for the day. So the number of Reed-asking territories queued in one call is at most `floor(views left / 20)`, whatever `--per-day` says. (Since 2026-10-01 `tools/reed-catchup.js` itself reserves views across calls only for its searches that are still pending, `docs/OPERATIONS.md` 8.1, because a finished search's views are already in the day's count. This tool does not look at files that are already waiting from an earlier call: across calls it is bounded by `--per-day` and by the views left, and the 18:00 digest shows the day's views.)
- **The per-day figure.** `--per-day` (default 10) is a total per UTC day over all calls, kept in `runtime/rescreen-queue.json`; running `--queue` again queues the next ones and never the same territory twice. It bounds the extra Caterer unlocks (times 20) and the extra Reed views (times 20) as above. The default 10 is a design default, not yet confirmed by the owner. A suggested start is 5 a day, raised once a day has passed cleanly (look at the credits and the Reed views in the 18:00 digest).
- **A run is a whole territory.** There is no re-screen-only run: the queued territory runs its normal Caterer search (and Reed search, if it asks for Reed), mostly skipping the people it already knows. Only the cleared candidates that come up in the search results again are screened again (section 5).

## 5. What can go wrong, and what to do

| Risk | What happens | What to do |
|---|---|---|
| The tool selects too much | It cannot: the selection needs a shadow row AND a stored pipeline rejection, and every exclusion is counted. A wrong number is refused: `--apply` needs `--confirm N` with the exact row count of the dry run. | Read the dry run. If the number is not what you expect, stop and ask. |
| A run starts while it works | `--apply` and `--undo` refuse (exit 3) while a pipeline run is in flight (the predicate of `pipeline-watchdog.js --status`, `busy`) or a screening halt is set, and check again after the backup. | Pause both jobs and wait for idle first (section 8.1). |
| The database fails halfway | One transaction: nothing is deleted. The ledger was written first, so it may list rows that were not deleted; `--undo` of it is a no-op for rows that are still there. | Run the dry run again; apply again if it is still right. |
| The decision was not right after all | `--undo <ledger>` puts exactly those rows back (idempotent; refuses a row that exists with different content; leaves alone a row that a newer rejection of the same candidate and title replaced). | Section 11. |
| A cleared candidate does not come back | The candidate is screened again only if the Caterer or Reed search of the territory lists them again (active within the search window, page limits, ranking). A candidate who no longer appears is not screened until they do. Nothing is lost: the rejection is gone, so the next time they appear they are screened. | Nothing. |
| A queued run finds fewer than 5 new candidates | Like any run it would step a raised territory's priority down one tier and re-base its cadence (`docs/KNOWN-LIMITS.md` K-RSC3), which is a change of the schedule. A re-screen run usually finds only a few new candidates, so `--queue` leaves out every territory at priority high or medium (`above_low` in its output): the regular sweep of that territory screens the cleared candidates when it comes up. A territory at priority low cannot step down. | Nothing; if the owner wants a raised territory brought forward, the owner says so and it is a separate decision. |
| The cleared candidates are screened again and rejected again | A new rejection row is booked (origin `pipeline`), exactly as for any card Jev rejects. Nobody is cleared or screened a third time for that job title: the once-only guard (section 3) holds them even if their shadow row of the second look is missing. | Nothing. |
| A ledger cannot be read | The dry run prints `WARNING: ledger <name> ...` and counts what it can prove; `--apply` and `--queue` refuse (exit 3, nothing written) because the guard cannot be proven. | Tell the owner. Restore the file from a copy; never move or delete a ledger. |
| A database backup older than an apply is restored | The rejection rows are back, the ledger still covers their candidates (fail closed, nobody is cleared again). | If the owner wants them cleared again: `--undo <ledger>` (a no-op for rows that are back) releases the ledger, then section 8. |
| A territory cannot be found for a cleared candidate | The rows are cleared, the territory is `unknown territory` in the output and cannot be queued: the regular sweeps screen the candidate when they next reach the territory. | Nothing. |

## 6. Reed candidates (`--reed-seen`)

Reed's phase 1 does not read `candidate_rejections`. It skips a candidate that has ANY row in `candidates` for that `reed_id` (`reed-phase1.js`, `checkByReedId`), whatever the job title, and it books a screened-and-rejected card only as such a "seen" row (`seenReedCandidate`: `unlocked` 0, no Zoho id). So deleting a `candidate_rejections` row does nothing for Reed: there is none. The only way to bring a Reed candidate back, without changing pipeline code, is to delete that seen-only `candidates` row.

That is the one place where this tool touches the `candidates` table, so it is **off by default**: the dry run counts such candidates as "blocked only by a seen row, NOT counted", and `--reed-seen` includes them. With the flag the tool deletes a `candidates` row only when it is a Reed row (`source` `reed`, `reed_id` set) with `unlocked` 0 or null and no Zoho id, one that the shadow evidence says was policy-rejected for uncertainty; it records the full row in the same ledger (`kind` `reed_seen`) and `--undo` restores it, with its id and every column. A row that also carries a Caterer id is not a plain seen row and is left alone. Two things to know: the Reed skip has no job-title scoping, so a cleared Reed candidate comes up for screening for any title when they next appear in a Reed search, not only for the title of the old rejection; and Reed shadow rows carry no run id (the Reed screening call is made without one), so the territory of a Reed candidate is found as the one run for that title, asking for Reed, whose time span holds the row. When that is not unique the candidate is cleared but its territory is `unknown territory`.

Whether to include Reed is the owner's decision (section 8.3). `--reed-seen` must be given on every call that has to count the same rows: the number for `--confirm` is the number the dry run printed WITH the same options.

## 7. Rules for the operator

1. Same rules as `docs/INSTALL.md` 0.2: one command at a time, exactly as written, full paths, no secrets printed, and STOP on any output that differs from "Expect".
2. Use only the commands in this note. This terminal does not allow `grep`, `head` or `sed`, and nothing here needs them or a shell pipe. Never print the `.env` file, a shadow file or a database table.
3. Every Hermes command is `/opt/hermes/bin/hermes -p resourcer ...`. Never restart, stop or update the Hermes gateway or the dashboard. No setting is changed by anything in this note: never run `config set`.
4. **The numbers come from the owner.** `<N>` is the row count that the dry run printed AND the owner has confirmed; `<M>` is the number of territories a day the owner named. Never copy a command with a number you chose yourself: `--apply` deletes rows and `--queue` spends credits.
5. The tool prints counts only. If any output shows a name, an e-mail address, a phone number or card text, STOP and report it without quoting it.
6. A step that the tool refuses (exit 3) changed nothing: read the sentence, fix the cause it names (a run in flight, a halt) and run the same command again; do not work around a refusal.
7. On any STOP, refusal you cannot clear, or error in sections 8.1 to 8.5, **leave both jobs paused**, tell the owner and wait for the word. Resume only at the end of 8.6 (or when the owner says to).
8. Every `--queue` run needs the owner's message of that day with the number `<M>`. Never run it on your own, and never run a step of this note on your own initiative: the owner asks for the re-screen.

## 8. The apply

### 8.1 Pause the jobs and wait until the pipeline is idle (OPERATOR)

First note which of the two jobs are enabled now, because only those are resumed at the end:

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

Expect: `busy` is false. If it is true, a run is in flight: wait a few minutes and run the status command again (do not loop). A run lasts at most about an hour: if `busy` is still true after an hour, STOP, leave both jobs paused, tell the owner and wait for the word. A `halt` that is not null is a screening outage: STOP and tell the owner (the tool refuses while a halt is set; do not clear it).

### 8.2 The dry run (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js
```

Expect: exit 0 and, in this order, a header line `rescreen-policy-rejects (dry run) window 2026-09-30 to <today> (UTC)`; a line `shadow log: ...` with the number of files, rows and the pre-unlock decisions by who made them; the line `cards the review policy rejected before the unlock because Jev was uncertain (distinct candidate and job title): <n>`; a line `left out: ...` with one count per reason; `re-screenable candidates: <k>`; `rows that --apply would delete: <N>   (--apply --confirm <N>)`; the counts by source, by day of the decision and by territory; a line that says `--apply is possible now` (or names what would refuse it); and `nothing was written`. A line that starts `WARNING: ledger` means a ledger of an earlier apply cannot be read (section 3, the once-only guard): STOP, leave both jobs paused, tell the owner and do not touch the file. Any other line that starts `WARNING:` names a shadow file that is not mode 0600: report it, do nothing about it. A line `once-only guard: <n> ledgers in runtime/: ...` says how many ledgers took effect and how many candidates are never cleared again; it is `0 ledgers` before the first apply. Nothing is written by this command; run it as often as you like.

If the owner wants Reed candidates included (section 6), also run:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --reed-seen
```

Expect: the same output with the Reed candidates counted: `rows that --apply would delete` is larger and `reed:` appears under the sources.

The default window starts on 2026-09-30, so it also covers that afternoon. If the owner wants only a day or a span (for example only the runs of 2026-10-01), the owner names the days and you run the dry run with them (`<D>` is a date like `2026-10-01`; `--until` is optional):

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --since <D> --until <D>
```

Expect: the same output for that window only (the `window` in the header line shows it). Add `--reed-seen` to it when the owner wants Reed included. Every later command must carry the same `--since`, `--until` and `--reed-seen`: the number for `--confirm` is the number of that exact dry run.

Report to the owner, in your own words: `<N>`, how many of those rows are Caterer and how many Reed, the three biggest territories, the `left out` line, and whether `--apply is possible now`.

### 8.3 HUMAN decision gate (OWNER)

STOP here until the owner answers. The owner decides: (1) whether to apply at all; (2) the number `<N>`, which must be the one the dry run just printed (the tool refuses any other number); (3) whether to include Reed (`--reed-seen`, section 6); (4) the number of territories a day for section 9. If `<N>` is above 400, the tool refuses (`--max-rows`, a design default, not yet confirmed by the owner): the owner can narrow the window (`--since <D>`, `--until <D>`, for example one day at a time, commands in 8.2 and 8.4) or raise `--max-rows <K>` (8.4). Nobody but the owner gives these numbers.

### 8.4 Apply (OPERATOR)

Only with the owner's number. Without Reed:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --apply --confirm <N>
```

With Reed, the same number counted with the same flag:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --reed-seen --apply --confirm <N>
```

Expect: exit 0 and these lines: `backup candidates-<stamp>.db.gz.enc written and verified: candidate_rejections <n> rows`; `ledger runtime/rescreen-ledger-<stamp>.jsonl written first (mode 0600)`; `deleted <N> rows in one transaction (<k> candidates)`; the `undo:` line that names the ledger and a `next:` line that points at section 9. Write the ledger file name down: it is the way back. Exit 3 prints `NOT APPLIED (nothing was written): <reason>`: the reasons are a missing or wrong `--confirm`, a run in flight, a halt, more rows than `--max-rows`, a ledger that cannot be read (`the once-only guard cannot read ...`: STOP and tell the owner) or no verified backup (for example no backup passphrase: STOP and tell the owner). The apply also writes `runtime/rescreen-applied-<stamp>.json` after the commit; a `WARNING:` after the `undo:` lines says that file could not be written (the guard then relies on the table state: tell the owner). Exit 4 means the transaction failed and was rolled back: nothing was deleted; tell the owner. The command takes a backup first, so it needs about a minute on a large database. If the owner chose a window or a higher limit, the same command carries them (the options come before `--apply`; `<D>`, `<K>` and `<N>` are the owner's):

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --since <D> --until <D> --max-rows <K> --apply --confirm <N>
```

A delete of a large share of a table can make the next nightly backup raise the registered warning `backup-shrunk` (it compares row counts with the backup before): after an apply that is expected, tell the owner it is this tool, and do nothing about it.

### 8.5 Check the result (OPERATOR)

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js
```

Expect: `rows that --apply would delete: 0` and, in `left out`, `cleared_before` equal to the number of candidates just cleared (a second apply finds nothing; a Reed candidate counts once as well). A line `once-only guard: ... took effect ...` shows the guard. If the number is not 0, STOP and report.

### 8.6 Resume (OPERATOR)

Resume only the jobs you noted as enabled in step 8.1 (normally both):

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick
```

```
/opt/hermes/bin/hermes -p resourcer cron resume resourcer-queue-due
```

```
node /opt/data/profiles/resourcer/workspace/resourcer/scripts/pipeline-watchdog.js --status
```

Expect: `lastTickAt` recent within two minutes (between 05:00 and 23:59 London; `tick` may be null at first, that is normal). From now on the regular sweeps also screen the cleared candidates whenever their territory comes up; section 9 only brings that forward.

## 9. Queue a few territories a day (OPERATOR, with the owner's number)

`--queue` works on the ledgers, so it can be run on the day of the apply and on later days. It never queues a territory that is already queued, running, quarantined or held by CV screening, that is disabled or gone, or that already ran since the apply, and never more than `<M>` in a UTC day in total. It queues nothing that asks for Reed while Reed is switched off or held (the run would be recorded Caterer-only for a territory that asks for Reed), and nothing once the day's Reed view budget is used up (section 4). First look, writing nothing:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --queue --per-day <M> --dry-run
```

Expect: a line `queue (dry run): <n> ledger, <k> cleared rows ...`, the `left out:` counts by reason (`above_low` for territories at priority high or medium, `credits_floor` when the balance is too low, `ran_since_apply`, `queued_or_running`, `per_day_limit`, `reed_budget`, `reed_unavailable`), `per-day limit <M> (<q> already today); Reed views today <u> of <limit>`, a line `Caterer credits: ...` (the balance at the last finished run and the reserve, or that no balance is recorded and the credits are NOT guarded) and `would queue <j>: <territory list>`. If the credits are not guarded, tell the owner and wait. Then queue, with the same number:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --queue --per-day <M>
```

Expect: `queued <j>: ...` and one `+ zz-rescreen-<time>-<id>.json (<code>)` line per territory. The files sort after every scheduled or dashboard search, so they use idle capacity only. Running the command again queues the next ones, never the same one twice. Only on a later day, and only when the owner asks with a number for that day, run the same two commands again; repeat until `would queue 0` and the territories are covered by `ran_since_apply` (or `above_low`: those are left to their regular sweep).

## 10. Watching the first re-screen runs (OPERATOR, then OWNER)

Nothing here changes anything; you read and report.

- After the first queued run has finished, the dry run of 8.2 shows fewer territories and the queue dry run shows `ran_since_apply` for it.
- `node /opt/data/profiles/resourcer/workspace/tools/screening-report.js --since 1d --source caterer` shows the day's screening: the policy share should stay near zero and the approval rate should be higher than before the release.
- The run's own numbers are in the 18:00 digest and on the dashboard. A queued run that approved the cleared candidates shows them as new in Zoho. A territory at priority low cannot step down; if a run log shows `AUTO-DOWNGRADE` for a queued territory, tell the owner (`docs/KNOWN-LIMITS.md` K-RSC3).
- Caterer credits and Reed views: read the digest; if either is running low, tell the owner and lower `<M>` or stop queueing for the day. Nothing has to be undone for that.

## 11. Undo (OPERATOR, with the owner's word)

Only if the owner asks. Pause both jobs and wait for idle exactly as in 8.1, then look first, writing nothing (`<LEDGER>` is the file name from 8.4, `rescreen-ledger-<stamp>.jsonl`):

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --undo <LEDGER> --dry-run
```

Expect: `ledger <LEDGER>: <n> lines; would restore <r>, already present <p>, left alone because a newer row for the same candidate and job title exists <s>`. Then:

```
node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js --undo <LEDGER>
```

Expect: the same line with `restored <r>` and `backup candidates-<stamp>.db.gz.enc verified first`, then `once-only guard released <r> lines, <s> stay covered (a second look took place)`: the rows that were put back may be cleared again by a new apply, the ones a second look had already replaced stay covered. Exit 4 with `the undone marker could not be written` means the rows are back but the guard still covers the ledger: run the same command again. Exit 3 with `1 row(s) of the ledger exist with different content` means a row with the same id was changed since: nothing was written; STOP and tell the owner. A second undo restores nothing (`restored 0`). Candidates that were re-screened and approved since stay approved: undo only puts the old rejection rows back, which for an unlocked candidate changes nothing (an unlocked candidate is always skipped). Resume the jobs as in 8.6.

## 12. What stays behind

The ledgers (`runtime/rescreen-ledger-*.jsonl`, mode 0600, every column of the cleared rows: ids, job titles, dates; no name, e-mail or phone number), their markers (`runtime/rescreen-applied-*.json` and `runtime/rescreen-undone-*.json`, mode 0600: the ledger name, counts and table row numbers), together the once-only record that nothing prunes (`scripts/maintenance.js`, `scripts/retention-sweep.js` and the backups never touch them: `tests/rescreen/once-only.test.js` proves it on ten-year-old files), `runtime/rescreen-queue.json` (which territories were queued on which UTC day; days older than 14 are dropped) and the backups the tool took (`backups/`, encrypted, kept and pruned by the nightly backup rules). Leave them: they are small and they are the way back, and the ledgers with their markers are what keeps anybody from being cleared twice: never delete or move one. An ordinary search file `pending-searches/zz-rescreen-*.json` that is still there is a queued territory; the pipeline consumes it like any search.
