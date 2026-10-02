# The search window ("active within") and the CV limit

Audience: the owner. This is what was wrong, what changed (Update G), what you can set, what is still unverified, and how the first live run shows it. The install note for the operator is `docs/UPDATE-G.md`; the commands and the alert are in `docs/OPERATIONS.md` section 5.1 and section 11; the decisions are `docs/DECISIONS.md` section 19 (every number and mapping there is a design default, not yet confirmed by the owner, except your instruction of 2026-10-01); the open limits are `docs/KNOWN-LIMITS.md` section 14.

## 1. What was wrong

On 2026-10-01 three one-off searches were queued with `node tools/request-search.js --job <title> --location FY4 --distance 20 --active-within "12 months" --sources both --priority high --cv-limit 30` (one for each of three job titles). The run parameters recorded `ACTIVE_WITHIN="12 months"` and `CV_LIMIT=30` and `watchdog-runner.js` handed them to Caterer's phase 1, but neither window reached the search:

1. **Reed** searched the last month with a limit of 20, whatever the request or the territory said: `run-pipeline.js` passed the literals `--active-within month` and `--cv-limit 20` to `reed-phase1.js`. Reed itself supports the window (`reed-search.js` already maps 12 months to `year`); only the hand-off was broken.
2. **Caterer** never saw the window: `build-caterer-results-url.js` did not emit `LastActivityId`, so the stored `1 month` of every territory, and every window a person asked for, was silently dropped from 2026-06-02. The legacy search probe (`search-probe.js` in the old workspace, written 2026-08-05) said exactly this. What Caterer applies when the parameter is absent is unknown.
3. The manual request also created scheduled territory rows with the default stored values (1 month, 20, priority low, next run 2026-11-01), not the requested ones. **That stays as it is**: a manual search is a one-off; a standing territory is changed with the territory tools.

## 2. What changed

| | Before | Now |
|---|---|---|
| Reed window | always `month` | the request's or territory's window, mapped to the value `reed-search.js` knows (table below) |
| Reed CV limit | always 20 | the request's or territory's limit, still lowered to the Reed profile views left today exactly as before |
| Caterer window | never sent | sent as `LastActivityId` for a one-off request (default); for every territory only if you set `CATERER_ACTIVITY_FILTER=all` |
| What the report shows | nothing about the window | `ACTIVITY_FILTER` log line and an `activity` block in the status, the queue and the run results: requested, sent, what Caterer says it applied, match, pool, and Reed's window and limit |

A scheduled territory with the stored defaults (1 month, 20) behaves exactly as before: the Caterer URL is byte for byte the one it was, and Reed gets `--active-within month --cv-limit 20` (tests prove both). Nothing about screening, criteria, operating points, `CV_SCREEN`, the territory table or the schedule changed.

What does change for a scheduled territory, so that nothing here is a surprise:

- A territory row that holds a window or a limit other than the defaults (a territory-tool override, a catch-up payload) now searches Reed with those values; before, Reed ignored them. Only the exact defaults are provably identical to before. Caterer is unaffected under the default setting (`manual`).
- Every Caterer run reads the results page summary once (one small page evaluation, not counted in the browser round-trips), writes an `ACTIVITY_FILTER` line (`match=n/a` for a scheduled run, with the text Caterer applied) and carries an `activity` block in the status, the queue and the run results.
- A `CATERER_ACTIVITY_FILTER` value that is not `manual`, `all` or `off` is treated as `manual` and adds a warning note and a `activity-filter-warn` event to each run (the URL is still the old one).

**The CV limit is now per source.** A two-source request for 30 CVs can take up to 30 from Caterer and up to 30 from Reed (before this change: 30 and always 20). Reed still lowers its limit to the profile views left today. `activity.reed.cvLimitRequested` is the request's limit after the fallback to 20 for a missing or invalid value, and `activity.reed.cvLimit` is the limit Reed really used.

| Window | Caterer `LastActivityId` (unverified) | Text the page is expected to echo | Reed value sent |
|---|---|---|---|
| 14 days | 7 | 14 days | two weeks |
| 1 month | 8 | 1 month | month (the old literal) |
| 2 months | 9 | 2 months | two months |
| 3 months | none known: no filter, a WARN | - | three months |
| 6 months | 11 | 6 months | six months |
| 12 months | 15 (CONTESTED, see below) | 12 months | year |
| 18 months | none known: no filter, a WARN | - | two years (the next wider one: Reed has no 18 months) |
| All | 0 (sent only when the request says All) | All, or no text at all | all |

**The Caterer ids come from one legacy source and a second one disagrees.** The ids above are those of the legacy search probe of 2026-08-05 (and of the brief of 2026-10-01). The old `caterer-search` skill table (the file field-mappings.md in the references folder of the old caterer-search skill, written from the live form on 2026-03-13) gives other values for four windows: 7 days = 6, 3 months = 10, **12 months = 14 and 18 months = 15**. The ids for 14 days (7), 1 month (8), 2 months (9), 6 months (11) and All (0) are the same in both. So **12 months = 15 is contested**: if the old skill table is right, id 15 means 18 months, a request for 12 months is searched at 18 months (wider, not narrower), and the first run shows `applied="18 months" match=no` and raises the `caterer-activity-mismatch` alert. Nothing is changed or guessed here: the table keeps the probe's values, the self-check (section 4) shows which one is right on the first live run, and the probe with `--extra-ids 6,10,14` (section 5) reads the page's own text for 14, 10 and 6 so that you decide from what the page says. 3 months and 18 months stay unmapped until then.

**What a window that cannot be sent exactly gets.** Reed 18 months is searched at 2 years, the next wider value, so never narrower than asked. Caterer 3 months and 18 months get no filter, so Caterer's own default applies; what that default is, is unknown (section 5, K-ACT2), and it may be narrower than asked. The log and the run record say so (`ACTIVITY_FILTER_NOTE`).

## 3. What you can set

- **Per search:** `--active-within` and `--cv-limit` of `request-search.js` (or the dashboard card), as before. They now reach both sources.
- **Who sends the window to Caterer:** `CATERER_ACTIVITY_FILTER` in the profile `.env` (only you change it; `docs/ENV.md`).
  - `manual` (the default, a design default, not yet confirmed by the owner): one-off requests only. The standing territories are not changed.
  - `all`: every territory sends its stored window. Its stored `1 month` would then apply to about 1,700 territories, so every pool could shrink. That is a business decision: decide it from the probe numbers (section 5), not before.
  - `off`: nobody sends it; the behaviour before Update G.
- **The mapping:** `resourcer/config/caterer-activity.json` (the ids and the text each id is expected to echo). If the file is broken the filter is switched off with a WARN, never guessed. You (or whoever maintains the repository) edit it once the live page shows the real ids; an edit made only on the instance is reported as `CONFIG_CHANGED` by the manifest check until it is committed.

## 4. How a run shows the filter that was really applied

After the first results page loads, phase 1 reads two things from it, as the legacy probe did: the "Candidates <N>" header (the pool) and the "Active within last: <text>" part of the summary line (the filter Caterer says it applied). Only that count and that short text leave the page: no name, no card, no other text. One line goes in `logs/phase1-console-*.log`:

```
ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="12 months" match=yes
```

`match` is `yes` (the page shows what the config expects for the id that was sent), `no` (it shows another window), `unreadable` (the page could not be read: its layout may have changed) or `n/a` (nothing was sent, or the config does not know the id; `applied` is still logged, empty when the page shows no window: this is how you learn what Caterer does when the parameter is absent). The same facts are stored in the `activity` block of the status file, the queue and the run results (`requestedActiveWithin`, `requestedCvLimit`, `sentLastActivityId`, `appliedFilterText`, `poolHeaderCount`, `matched`, and for a two-source run `reed` with the window and limit Reed was given, after the daily view budget). `node tools/activity-probe.js --recent 5` prints them for the last runs.

**What a mismatch means.** `match=no` means Caterer did not show the window that was sent: the id in `config/caterer-activity.json` is probably wrong (or Caterer changed what an id means). The run is not stopped, because a wrong window only changes the size of the pool; the WARN alert `caterer-activity-mismatch` (once a day) tells you. `match=unreadable` raises the same alert when the page had candidate cards: the layout of the results page changed, so nothing about the window can be confirmed until the reader is updated. A page with the "Candidates <N>" header but no summary line counts as unreadable, not as a mismatch. A read that itself fails (a timeout or a browser error) is logged as `unreadable` but raises no alert, because it says nothing about the page. The alert is sent once a day for each of the two causes (a mismatch and an unreadable page do not hide each other). A window that has no known id is not a mismatch: it is a WARN line (`activity-filter-warn` in `logs/watchdog-runner.jsonl`, `ACTIVITY_FILTER_NOTE` in the run log).

## 5. What is still unverified, and how the first live run shows it

Nothing here could be tried against the live sites offline; the rehearsal uses fakes that echo what the code expects.

1. **The Caterer ids and the echoed texts** (K-ACT1, K-ACT5), 12 months in particular (two legacy sources disagree, section 2). First live signal: the `ACTIVITY_FILTER` line of the first one-off request, and the probe. A `match=no` shows a wrong id at once. The probe's extra rows (`--extra-ids 6,10,14`) show what ids 6, 10 and 14 mean on the live page, which settles 12 months (14 or 15) and shows whether 10 is 3 months.
2. **What Caterer applies when the parameter is absent** (K-ACT2). First live signal: `applied=` and `pool=` of the first scheduled run, and the `none` row of the probe next to the `1 month` row. If they are equal, Caterer's default is one month and `all` would change nothing; if the `none` pool is the larger, Caterer's default is wider and `all` would shrink every territory by the difference.
3. **Whether Reed accepts every window value** (K-ACT4). First live signal: the Reed rows of the probe (a total, or an error code for a value Reed refuses).
4. **The ids of 3 months and 18 months** (K-ACT3). The probe reads only the ids it is given (those of the config and `--extra-ids`); an id nobody has named is not found by it. 10 (3 months in the old skill table) is one of the extra ids; 18 months is 15 in the old skill table, which is the same id the probe table gives for 12 months. Anything else is read off the live search form by a person, who then adds it to the config.

The probe is `tools/activity-probe.js` (read only: search pages only, no unlock, no credit, no profile view, no CV, no Zoho, no database; counts and fixed strings only; refuses while a run is in flight). `docs/UPDATE-G.md` step 8 runs it once, and you read the result and decide: the mapping, and whether to set `CATERER_ACTIVITY_FILTER=all`. It loads one results page for each Caterer variant (the no-parameter page, the six ids of the config and the three extra ids: ten pages) and eleven Reed searches. A page normally takes seconds, but each one is allowed up to about three and a half minutes (215 seconds), so the worst case for the ten Caterer pages is about 36 minutes and Reed adds a few more; the terminal's own time limit must allow that (`docs/UPDATE-G.md` step 8 says what to use).

## 6. Where it is proven

`tests/activity/mapping.test.js` (labels, config validation, setting, Reed mapping, page reader, alert once a day), `url.test.js` (the URL and the run params: scheduled byte for byte as before, one-off carries the id, all and off), `reed-handoff.test.js` (the Reed arguments, every label, the stored defaults unchanged, the lowered limit), `selfcheck.test.js` (match yes, no, unreadable inside a real phase 1 run), `results.test.js` (the block reaches the run results), `probe.test.js` (the probe, refusal while busy, no personal data) and the whole-pipeline rehearsal `tests/e2e/21-activity.e2e.js` (a one-off request for 12 months and 30 CVs, a scheduled territory, the three settings, an unmapped window, a mismatch).
