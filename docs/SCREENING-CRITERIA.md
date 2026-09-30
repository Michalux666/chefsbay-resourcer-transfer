# Screening criteria: what Jev is asked, why, and how to change it

This page is for the owner. It explains, in plain English, the questions the screening asks Jev about every candidate
card, how the answers become approve or reject, how to change the criteria without a programmer, how to move the one
number that trades wasted credits against lost candidates, and how to read the numbers. Settings:
`resourcer/config/screening-criteria.json` (the criteria and the operating point) and `resourcer/config/screening.json`
(the engine, the injection bar and the review policy of the rare fallback cases). Code:
`resourcer/scripts/lib/screening/` (`jev-questions.js`, `decide.js`, `card.js`, `criteria.js`, `operating-point.js`). Tools: `tools/screening-report.js`,
`tools/gold-rows.js`, `tools/screening-operating-point.js`.

## 1. The short version

- The criteria are the recruiters' own policy (the `caterer-cv-reviewer` skill and the old screening prompts), written down
  as 14 numbered criteria. Each one has a small question for Jev and, where it is a plain fact on the card, a rule in code.
- Jev never decides by itself. It answers small typed questions with probabilities ("what kind of job is this?", "is this
  person clearly too junior for the searched role?", "would a recruiter put this person forward?"). The code applies the
  rules in this file.
- **Every card ends in approve or reject, decided from Jev's answers.** There is no "unsure" lane. The recruiters' own
  tie-break is built in: when in doubt, approve; reject only a clear mismatch (a seniority gap of two or more tiers, no
  relevant experience, an unrelated industry, an empty or out-of-date profile). Only an unusable answer, or a card that both
  the keyword filter and Jev flag as an injection, goes to the fallback lane, which the review policy settles (a card that instructs an AI is never handed to a second model).
- Everything is judged **against the role being searched**. The searched title is part of every question, and Jev works out
  once per title what kind of role it is (entry-level porter, commis, chef de partie, sous chef, head chef, waiter,
  manager). Nothing in the code lists job titles.
- Salary, location, driving licence, name and contact details are never sent to Jev and never used.
- `screening-criteria.json` is the **single editable source**: the wording of every question, the two rule tables, the out-of-date rule, the
  policy readings and the operating point are in it, and nothing else decides (no job-title table in code, no second copy of a number). Change it,
  save, and the next run uses it; a file that is broken stops screening with an error that names the line, and never half applies.
- One number, `rejectAt`, decides how cautious the rejects are. It is set from what a mistake costs: a wasted unlock credit
  costs 1, a lost candidate costs 3 (both editable). A decision that Jev did not clearly favour carries the marker `forced`
  and its confidence in the log, so a weekly review can audit exactly those.

## 2. What is asked (the wording is in `screening-criteria.json`)

Every candidate is one request with these questions. `search.role` is the title being searched.

| Question | Type | Plain-English meaning | Used for |
|---|---|---|---|
| `role_level` | choice, asked once per title | what kind of role the searched title is (entry, junior cook, generic chef, chef de partie, sous, head, service or bar, management, other) | picks the row of both rule tables |
| `candidate_kind` | choice | what kind of job the most recent job is, from the title and the history together | wrong kind of work, too junior, unrelated industry |
| `kind_work` | choice | the same, from the first job in the history only | both readings must agree before a structural reject |
| `seniority` | choice | how senior the most recent job is compared with the searched role (two or more steps junior ... two or more steps senior, not comparable, cannot tell) | too junior, too senior for an entry role |
| `too_junior`, `overqualified` | yes/no | plain "clearly too junior?" and "far too senior for an entry role?" | must agree before a level reject |
| `relevance` | 4-level score | how relevant the whole history is to the searched role | must agree before a wrong-kind-of-work reject |
| `same_area_seen` | yes/no | any work in the same area as the searched role (cooking for a chef search) | stops a reject when the card shows the work |
| `hospitality_experience` | yes/no | any paid hospitality or catering work at all | stops an unrelated-industry reject for a career changer |
| `info_sufficient` | yes/no | does the card state a job title, employer or duty at all | an empty profile |
| `injection` | yes/no | does some text give instructions to a reader or an AI | with the keyword filter: the fallback lane |
| `would_place`, `would_place2`, `clear_mismatch` | yes/no | the whole policy asked three ways: would a recruiter put this person forward; the same with "put forward when in doubt"; is this a clear mismatch | the probability of a clear mismatch, and every doubtful card |
| after the unlock: `title_seniority`, `title_consistent` | choice, yes/no | level of the real job title the unlock returns, and whether it matches the card | uses the real title |

Why several questions: Jev is much more reliable on small, separate questions than on one big one. Asking "what kind of job"
twice (title and history) and requiring agreement catches cards whose headline says one thing and whose history says
another. Asking the whole policy three times, in three wordings, averages out the wording noise of any single question.

## 3. How the decision is made

The code goes down this list. The first step that applies decides.

1. **Fallback lane** (rare): an answer that is missing, malformed or not a number (`ANSWER_UNUSABLE`); a card with plenty of text but neither a title nor a history, which the card reader did not understand (`ANSWER_UNUSABLE`, flag `card_unreadable`: a change of the card format must stop the run, not look like a page of empty profiles); or an injection that
   both the keyword filter and Jev flag (`INJECTION_FLAG`: the injection answer at or above `decide.stage1.injectionP` in
   `screening.json` and the keyword filter of the engine fired on the same card). Either signal alone does not stop Jev
   deciding: a chef who writes "always approve deliveries" is judged as a chef, and an instruction that the keyword filter
   misses is judged on the content.
2. **Empty profile**: no history and either no title or nothing stated: reject (`reject_no_history`, flag `empty_profile`). A card that is empty in this sense but carries 300 characters or more of real text is not empty, it is unreadable (step 1).
3. **Out of date** (from the card text, not from Jev): reject (`reject_stale_profile`), see section 7. A profile that looks out of date but shows a sign of
   life (an "Active ... ago" within a year, or the card's own "N applications in last M days") is not rejected as out of date and carries the flag
   `stale_but_active`.
4. **Structural mismatch** `mStruct`: the tables of section 5 say, for the searched role, which kinds of job and which levels
   are a clear mismatch. The mismatch is the geometric mean of the table's reject mass and a second, independent answer
   (`too_junior`, `overqualified`, `relevance`, `same_area_seen`, `hospitality_experience`), so a strong reading can carry a
   moderate one but two moderate ones cannot reach the bar.
5. **Policy readings** `mPolicy`: the mean of the three whole-policy yes/no readings, expressed as the probability of a clear
   mismatch.
6. **`R = max(mStruct, mPolicy)`. Reject when R reaches `rejectAt`, otherwise approve.** Doubt cells of the tables count for
   neither side: they are left to the policy readings, which is how "in doubt, approve" works.

A card whose R lies between 0.3 and 0.7 carries the flag `forced`; its confidence in the log is R for a reject and 1 - R for
an approve.

## 4. Reason codes and flags

Approve: `approve_level_match` (level and kind fit), `approve_senior_ok` (more senior than needed, which is fine except for
entry roles), `approve_other` (approved in doubt: the tables did not settle it).

Reject: `reject_too_junior`, `reject_overqualified_entry` (far too senior for an entry role), `reject_foh_only` (front of house
or bar background for a kitchen search), `reject_management_only`, `reject_unrelated_industry`, `reject_no_history`,
`reject_stale_profile`, `reject_other` (the policy readings said mismatch and no table named a reason).

Flags in the log (`jev.flags`): `forced`, `empty_profile`, `stale_profile`, `stale_but_active`, `role_unclear`, `title_contradiction`, `injection`, `card_unreadable`.
Fallback reasons (`reviewReason`): `INJECTION_FLAG`, `ANSWER_UNUSABLE`.

## 5. The two tables you can edit

Both are in `screening-criteria.json` under `decision`, one row per role level. "approve" means that answer is fine for that
searched role, "reject" that it is a clear mismatch, "doubt" that it is neither clearly fine nor clearly wrong.

**`decision.rules`: the level of the most recent job against the searched role (answers of `seniority`)**

| searched role is | much more junior | one step junior | comparable | one step senior | two or more steps senior | not comparable | cannot tell |
|---|---|---|---|---|---|---|---|
| entry (porter, kitchen assistant, catering assistant) | approve | approve | approve | approve | reject | approve | doubt |
| junior cook (commis) | approve | approve | approve | approve | reject | approve | doubt |
| generic chef or cook | reject | approve | approve | approve | approve | doubt | doubt |
| chef de partie | reject | reject | approve | approve | approve | doubt | doubt |
| sous chef, head chef | reject | doubt | approve | approve | approve | doubt | doubt |
| waiter, bar, manager, other | doubt | doubt | approve | doubt | doubt | doubt | doubt |

Read the first row like this: for a kitchen porter search, a candidate who is far more senior (a head chef or a sous chef) is
rejected, one tier up (a chef de partie) is fine. Read the "generic chef" row: a commis is fine (the recruiters' rule), a
kitchen porter is too junior. Read "chef de partie": a commis is too junior (the recruiters' rule). For sous and head chef
searches, one step junior is a doubt cell, because the policy says "in doubt, approve" and only a gap of two or more steps is
an obvious reject.

**`decision.fieldRules`: the kind of job against the searched role (answers of `candidate_kind` and `kind_work`)**

For every kitchen role level (junior cook to head chef): any kitchen job is "ok"; `service_or_bar` and `other_hospitality`
reject as `reject_foh_only`; `hospitality_management` rejects as `reject_management_only`; `not_hospitality` rejects as
`reject_unrelated_industry`; `cannot_tell` is a doubt cell. For an entry role: front of house is "ok" (people move between
porter, assistant and service work), management is a doubt cell, and an unrelated industry rejects. For waiter or manager
searches almost everything is a doubt cell except a plain match ("ok") and an unrelated industry (reject).

To change a rule, change the word in the table: `approve`, `reject`, `doubt` in `rules`; `ok`, `doubt` or a reject reason (for
example `reject_foh_only`) in `fieldRules`. The file is checked every time it is read: a missing row, a word that is not allowed
or an unknown question stops screening with an error that says which line is wrong. It is never half applied.

## 6. The operating point, and how to move it

`decision.operatingPoint` in `screening-criteria.json`:

| Setting | Now | Meaning |
|---|---|---|
| `stage1.costWastedCredit` | 1 | what an unlock credit spent on a card the recruiters would not want costs |
| `stage1.costLostCandidate` | 3 | what a candidate we never unlock, whom the recruiters would want, costs |
| `stage1.rejectAt` | 0.70 | reject when the probability of a clear mismatch, R, reaches this |
| `stage2.costWastedCredit`, `stage2.costLostCandidate`, `stage2.rejectAt` | 0.25, 3, 0.90 | after the unlock the credit is spent, so a wasted credit costs little and the bar is higher |
| `forced.from`, `forced.to` | 0.3, 0.7 | decisions with R inside this band carry the flag `forced` |

If R were a true probability the best bar would be `costLost / (costLost + costWasted)` = 0.75. It is not (Jev's numbers are
not calibrated on Chefs Bay data), so `rejectAt` was fitted by a sweep on the training split of the historical cards. It stays at 0.70 (before
the unlock) and 0.90 (after it): both are defaults chosen in the design, editable in this file, and not yet confirmed by the owner. What each bar costs on the historical sample (reliable old labels; "lost" = Jev
rejects what the old system approved, "wasted" = Jev approves what the old system rejected), with the rules of this file including the
applications-count rule of section 7, re-run offline on the stored Jev answers (no new call):

| rejectAt | TRAIN headline (230): lost / wasted / weighted cost | TEST headline (96): lost / wasted / weighted cost |
|---|---|---|
| 0.50 | 9 / 15 / 42 | 1 / 6 / 9 |
| 0.60 | 5 / 19 / 34 | 1 / 8 / 11 |
| 0.65 | 3 / 23 / 32 | 0 / 9 / 9 |
| **0.70** | **2 / 24 / 30** | **0 / 12 / 12** |
| 0.75 | 2 / 29 / 35 | 0 / 12 / 12 |
| 0.80 | 2 / 31 / 37 | 0 / 15 / 15 |
| 0.90 | 1 / 61 / 64 | 0 / 28 / 28 |

The cost is lowest at 0.70 on the training split (30; 0.65 costs 32) and between 9 and 12 from 0.50 to 0.75 on the test split, so the bar was not
moved. On all 452 training and all 185 test cards (including the labels of lower confidence) the same rules lose 6 and 2 candidates and waste 51 and 18
credits; before the applications rule they lost 16 and 5 and wasted 43 and 17 (the weighted cost fell from 91 to 69 and from 32 to 24; on the headline sets from 33 to 30 and from 14 to 12).
The bar after the unlock has no historical data (the unlock's real title is not stored); 0.90 follows the cost ratio, and on the probes a bar of 0.95 lets one more
card through (108 of 109 training probes pass against 109 of 109 at 0.90).

To change it: edit the numbers in the file, save, and the next run uses them. To see what a bar would cost on cards that
recruiters have labelled, use the sweep tool: `node tools/screening-operating-point.js --rows labelled.jsonl` (a row is
`{"answers": ..., "searchRole": "Chef", "stage": 1, "verdict": "approve"}`; the answers are the ones the shadow log stores; the
verdict is a recruiter's, never Jev's own). It prints the trade-off curve and the cheapest bar and never writes a file.
Rule of thumb: if lost candidates hurt more than you thought, raise `costLostCandidate` and `rejectAt`; if too many credits are
wasted, lower them.

## 7. The other numbers

In `screening.json`, `decide.stage1` and `decide.stage2`: `injectionP` (the Jev half of the double injection flag),
`infoFloor` (0.5: below it a card with no history is an empty profile), `notStatedP` and `titleConsistentMin` (stage 2).
The keys of the retired ladder design (`rejectP`, `approveP`, `needCorroboration`, `notFitMin`, `counterRoleMatch`, `noInfoApproveHospP`,
`clearFitP`, `clearFitHardMax`, `approveNotFitMax` and the whole `decide.ladder`) are gone from `screening.json`. An older file that still holds them
loads, prints one warning that names them, and they change nothing.

In `screening-criteria.json`:

- `thresholds`: `unreadableMinChars` (optional, 300: a card with no title and no history but at least this much real text is unreadable, not empty), `roleLevelMinP` (how sure Jev must be of the role level before the tables are used), `fieldOkMin` and
  `levelApproveMin` (how sure the tables must be to call an approval a clear level match), `reasonMin` (how much table mass a
  reject needs to name a reason).
- `stale`: `mode` (`reject`, `doubt` or `off`), `updatedDays` and `roleGapDays` (both 2190, six years), `activeDays` (365),
  `applicationsAreActivity` (true), `recentlyActive` (`ignore` or `doubt`), `doubtWeight` (how much a doubt-mode stale profile
  raises R). A card is out of date when it was last updated six years ago or more, or its newest dated job ended six years ago or
  more, **unless** it shows a sign of life inside `activeDays`: an "Active ... ago" age on the card, or (with
  `applicationsAreActivity` true, a design default, see SCR-31) the card's own "N applications in last M days" with N at least 1. An
  application window longer than `activeDays` does not count. `recentlyActive: doubt` makes such a card raise R by `doubtWeight`
  instead of ignoring the sign of life. The out-of-date rule applies before the unlock only.
- `policy.readings`: which yes/no questions form the whole-policy reading, as `fit` (yes means suitable) or `mismatch` (yes
  means a clear mismatch), each with an optional weight.
- `corroborate`: which yes/no question must agree with which reject.

## 8. How to change the wording

The wording of every question is in the same file, under `questions`. Each question has `type`, `instructions` and, for a
choice or a score, `criteria` (the description of each option or level). Rules that keep Jev reliable:

- keep the field paths in backticks (`candidate.recent_work`, `search.role`);
- describe situations, not degrees (a score level must make sense on its own);
- every choice keeps an escape option (`cannot_tell`, `other`), because Jev always names a winner;
- one condition per yes/no question, phrased so that yes means "the thing is there", with no negatives.

Changing wording changes what Jev answers. After a change run the tests (`node --test tests/screening`), then re-run the
backtest on the historical sample before trusting it. Notes are keys that start with an underscore; they are ignored. Changing
a rule, a number or a note does not change what Jev is asked, so it can be re-evaluated offline on stored answers at no cost.

## 9. How to read the report

- **Jev-decided share**: the share of cards approved or rejected from Jev's answers. It must stay at 99 percent or more; the
  rest is the fallback share (an unusable answer or a double injection flag), which must stay at 1 percent or less. A rise
  of `ANSWER_UNUSABLE` means the gateway or the wording changed.
- **Lost candidate**: Jev rejected, the old system (or a recruiter) had approved. **Wasted credit**: Jev approved, the old
  system (or a recruiter) had rejected. Both compare with an old model, not with the truth: read the disagreements (the
  adjudication sheet lists the most informative ones) before drawing a conclusion.
- **Forced share and forced agreement**: the decisions Jev did not clearly favour. On the historical sample about 16 percent of
  decisions are forced, and only about 6 in 10 of them agree with the old label, against about 94 percent for the others. Those
  are the cards to audit every week: forced approvals are where credits are wasted, and by design almost all the forced
  mistakes are on the approve side.
- **Probes**: 205 hand-written cards whose right answer comes from the policy, not from any model. The pass rate per
  criterion is the label-independent check; `tests/screening/probes.test.js` runs them offline (with keyword answers: it pins the mechanics, not
  Jev). Measured with Jev: 204 of 205 pass, one unsafe approval (a sous chef title for a kitchen porter search, after the unlock, at R 0.89 against the
  bar 0.90). Two probes (B023, C024: out of date, "inactive") carried an application count on their card; under the applications rule that card is recently
  active, so their text now says "No applications", which is what they meant. Jev never sees the count, so its answers to them are unchanged and the pass
  count was re-computed offline from the stored answers (109 of 109, 95 of 96, 204 of 205 in all).
- `flags` in the log: `forced`, `empty_profile`, `stale_profile`, `stale_but_active`, `role_unclear`, `title_contradiction`, `injection`, `card_unreadable`.
- To turn recruiter labels into a better bar: `node tools/screening-report.js --export-sample 150 --out to-label.jsonl`, have recruiters fill in `label`,
  `node tools/gold-rows.js --labels to-label.jsonl --out rows.jsonl`, then `node tools/screening-operating-point.js --rows rows.jsonl`. The rows hold numbers
  and the search title only. Keep the test-split labels out of any tuning: choose the bar on one half, check it on the other.

A healthy week looks like: the Jev-decided share at 99 percent or more, `INJECTION_FLAG` close to zero, the forced share
around a sixth of decisions, lost and wasted both a small share of the decided cards, and a recruiter's audit of a random
sample of forced approvals finding most of them acceptable.

## 10. What this does not do

- It does not judge progression or stability (the policy mentions them): a 500-character card shows one or two jobs, too
  little to judge.
- It does not send Caterer's `Applications`, `Never unlocked`, update or location text to Jev: they are removed before Jev sees the card. The code reads the update and
  activity ages and the application count from the card for the out-of-date rule of section 7, and nothing else.
- It cannot see past the first 500 characters of a Caterer card, so a candidate whose relevant job is older than the first two
  listed is judged on those two.
- The forced decisions are sometimes wrong at the margin, and the numbers say how often: see the report. The old labels are an
  old model's opinion, not the truth; the adjudication sheet is the start of a recruiter-labelled gold set.

## 11. Facts the code reads from the card (never Jev)

`card.js` reads these from the card text; they are stored next to Jev's answers as numbers (the `x_...` keys of the shadow row), so a decision can be
re-run offline. None of them goes to Jev.

| Fact | From | Used for |
|---|---|---|
| title (the headline before the pipe), history (the text after "Other CV snippets"), history length, number of dated jobs | the card | an empty profile (no title and no history), the request Jev gets |
| `x_updated_days` | "Updated 3 years ago" | out of date |
| `x_active_days` | "Active 5 days ago" | a sign of life |
| `x_apps_days` | "3 applications in last 30 days" (the window, 30 or 90 days; only when the count is 1 or more; "No applications" and "Applications withheld" give no fact) | a sign of life |
| `x_role_gap_days` | the newest dated job in the history (0 when a job is current) | out of date |
| `x_injection_kw` | the keyword filter the engine also runs | the double injection flag |
| `x_content_chars` | text that is neither page furniture nor a dropped Reed field | a card with much text and no title or history is unreadable, not empty |

A Reed card has no update, activity or application text: its history is the CV text, and a Reed card without CV text is a title-only card. Reed's location,
salary, contract type, work permit, notice and "open to" fields are dropped before Jev sees the card.

## 12. Decisions in this design that are the owner's (they change who is rejected)

1. **The operating point**: a wasted credit costs 1 and a lost candidate 3; `stage1.rejectAt` 0.70 and `stage2.rejectAt` 0.90 (section 6). At equal weights the
   training sweep picks a lower bar (0.40) and loses more of the reliably-labelled old approvals.
2. **A commis chef search is an entry-level search**: a sous or head chef is rejected for it, a cook and a commis are fine. The shipped code did the opposite because of
   a title-matching quirk ("Commis Chef" fell in tier 2). Edit the `junior_cook` row of `rules` to change it.
3. **The out-of-date rule rejects at six years, unless the card shows a sign of life**: `stale.mode` `reject`, `updatedDays` and `roleGapDays` 2190, and a sign of
   life is an "Active" age within `activeDays` (365) or, `applicationsAreActivity` true, an application on the card. Without the applications part the reliably-labelled sets lost 5 candidates
   the old system approved (4 training, 1 test) and 3 of them were this rule; with it 2 are lost (2 training, 0 test), and on all 452 training cards 6 instead of 16.
   `stale.mode` `doubt` or `off`, and the numbers, change it.
4. **One step below a sous or head search** (a chef de partie for a sous chef search) is a doubt cell: it is approved unless the policy readings see a clear mismatch
   (the policy says "in doubt, approve"; only two or more tiers is obvious).
5. **For an entry role, front-of-house experience is acceptable** (as the old ladder did for "Catering Assistant") and a retail or other unrelated background is a reject;
   non-cooking management is a doubt cell.
6. **A card with a title and no history is decided on its title** (a fitting title is put forward); a card with neither title nor history, or with nothing stated, is rejected
   (`reject_no_history`), as the legacy prompt says. This narrows the first release's rule "missing information is never a reason to reject" to: missing information alone
   never rejects a card that has a title or a history.
7. **After the unlock the real title decides the level and the bar to reject is 0.90** (stage 2 has no labelled data; it follows the cost ratio).
8. **The fallback lane exists only for an unusable answer, an unreadable card and a double injection flag**; what the engine does with it is `decide.reviewPolicy` (before the
   unlock: reject; after it: approve). A card that both filters flag as an instruction to an AI is never handed to a second model.
