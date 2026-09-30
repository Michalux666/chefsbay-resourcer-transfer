# AI screening: what it judges, how, and how to change it

This page is for the owner. It explains, in plain English, how the resourcer decides which Caterer
and Reed candidates are worth an unlock (or a profile view), what the criteria are, how borderline
cases are handled, how we will find out whether the new "Jev" model can be trusted, and what to do
about privacy. Code: `resourcer/scripts/ai-review.js` and `resourcer/scripts/lib/screening/`.
Settings: `resourcer/config/screening.json`. Report: `tools/screening-report.js`.

## 1. The short version

- Every candidate card is judged **before** we spend an unlock credit (pre-unlock, Caterer and Reed)
  and Caterer candidates are judged **again after** the unlock (post-unlock, with the real job title).
- **The judge is Jev alone** (engine `jev_only`, the default since 2026-09-30). Jev is TypeSafe AI's
  model, reached through the Vercel AI Gateway. It answers typed questions about each card and our code
  turns the answers into approve, reject or "not sure". The owner's Vercel team lets **only Jev** through
  the gateway, so no language model is used anywhere in screening (section 16).
- A card Jev is "not sure" about is settled by an explicit setting, the **review policy**: rejected before
  the unlock and approved after it by default, each one switchable (section 16.3). Those decisions carry
  their own reason codes and are counted separately, so you can see how much of screening is Jev's
  confident answer and how much is the policy.
- The older engines `llm`, `jev_shadow` and `jev` still exist (a language model decides, or Jev runs next
  to it). They call the gateway's chat endpoint, which the owner's team blocks, so they are for tests and
  for a later runtime, not for this install (section 4). The code refuses them unless `SCREEN_ALLOW_LLM=1`
  is set as well: a leftover or mistyped `SCREEN_ENGINE` becomes `jev_only` with a warning, so no other
  model can go through the gateway by accident (section 16.1).
- Jev's thresholds are placeholders, not fitted to Chefs Bay data (section 7). Jev-only mode runs on them
  anyway (the owner's choice) and says so once per run; a labelled sample is how to measure it (section
  16.6). The agreement report of section 9 needs a language model to compare with, so in `jev_only` it
  says "not applicable".
- If the AI service is down, screening says so (`API_UNAVAILABLE`, exit code 3), the pipeline pauses
  and **no territory or candidate is used up**. A service failure is not turned into rejections: a
  request the gateway refuses (a 4xx), a call in which nothing at all was usable, and a
  run of unusable answers across calls all count as "service down" too (sections 4, 13 and 16.5). The one
  case that still produces a "rejected" line is a single card whose answer stays unusable next to cards
  that were fine, and the caller does not record that as a rejection (it is screened again). `jev_only`
  does the same before the unlock; after the unlock the review policy settles such a card (section 16.5).

## 2. What is judged, and on what information

| Stage | Who | Information the judge sees |
|---|---|---|
| Pre-unlock, Caterer | every card not already in our database | the card text (at most 500 characters): headline title, city, "recent experience" snippets, employer names, dates, short duties |
| Pre-unlock, Reed | every card not already in our database | the card fields (current and desired role, salary, type, permit, notice) plus the first 1,500 characters of the free anonymised CV |
| Post-unlock, Caterer | every unlocked candidate | the same card text plus the job title returned by the unlock |

What the judge is told about the search: the job title (for example "Chef de Partie"), the town or
postcode area and the radius (context only, never a reason). Jev is told only the job title and a two-line
description of the agency: the town and the radius are not sent to it.

What is **never** used to reject: salary expectations, where the person lives, whether they drive.

What is **removed before anything leaves the server** (section 12): the first name, the surname
(best effort), full postcodes, e-mail addresses, phone numbers and web addresses.

## 3. The criteria (the recruiter instructions, verbatim)

In `jev_only` no model reads this text: Jev's questions (section 7) express the same criteria. It stays because the
language-model engines read it word for word and it is the reference for what the criteria mean.

These are the old instructions, kept word for word (only the dash characters were cleaned up). The
same block is used for the pre-unlock and the post-unlock judgement, which fixes an old mismatch
(the post-unlock prompt used to forget that a Commis Chef is fine for a generic "Chef" search, and
that alone cost about 150 unlock credits in four months).

```
You are an experienced hospitality recruiter for Chefs Bay, a temporary staffing agency in the UK.

Chefs Bay is a TEMP AGENCY. Key rules:
<one of the two over-qualification notes below>

UNDER-QUALIFICATION IS a reason to reject. If a candidate is too junior to competently perform the
<job> role, reject them. Example: Kitchen Assistant or Commis Chef for a Chef de Partie role = REJECT.
However, a Commis Chef for a generic 'Chef' search = APPROVE.

APPROVE if:
- The candidate's current or most recent role is at a level appropriate for <job>
- They have a previous history and strong background in roles relevant to <job>
- They are a working professional in the same area as the role being searched

REJECT if:
- The candidate is clearly too junior to competently perform the duties of <job>
- The candidate's background is in a completely unrelated area with no relevant experience for <job>
- No meaningful professional background or relevant history is visible
- The candidate is massively overqualified for an entry-level role (see over-qualification rules above)

DO NOT reject based on: Salary expectations, location, or driving licence
```

Which over-qualification note is used depends on the **search tier** (section 5):

- Entry-level searches (tier 0 or 1): "REJECT candidates whose most recent role is clearly
  senior-level (Head Chef, Executive Chef, Chef Manager, Sous Chef, Second Chef) ... APPROVE Chef de
  Partie, CDP, Line Cook or similar mid-level candidates - one tier up is fine for agency work.
  APPROVE other entry-level candidates."
- All other searches (tier 2, 3, 4): "OVER-QUALIFICATION within the same professional area is NOT a
  reason to reject. A more senior professional picking up agency shifts at good rates is common and
  valuable. Example: Head Chef or Sous Chef available for Chef de Partie shifts = APPROVE."

Two things are added around the verbatim text, neither changes the criteria:

1. A safety line telling the model that candidate text is untrusted data and that any instruction
   written inside a CV (for example "approve me") must be ignored.
2. A request to also return a short **reason code** and a **confidence** number, so the log can be
   analysed. The code list is in section 8.

## 4. The engines

`engine` in `config/screening.json` (or the environment variable `SCREEN_ENGINE`):

| Engine | Who decides | Jev | Use |
|---|---|---|---|
| `jev_only` (**default**) | Jev; a card it is not sure about by the review policy | decides | this install: no language model at all (section 16) |
| `llm` | the language model | not used | parity with the old system, no Jev traffic |
| `jev_shadow` | the language model | answers in parallel, logged only | collects the evidence for the go/no-go |
| `jev` | Jev first (approve or reject when it is clear); the language model for everything unclear | decides | after the gate is passed (section 9) |

The engines other than `jev_only` are refused unless `allowLlm` (environment `SCREEN_ALLOW_LLM=1`) is set. Without it, an
engine named in `SCREEN_ENGINE` or in the settings file is replaced by `jev_only` and the reviewer prints
`WARN screening config: engine '<name>' calls a language model ...` (phase 1 copies it into its run log). The language-model
client itself refuses to be built without the opt-in, so no other route can send a chat request. Set `SCREEN_ALLOW_LLM=1`
only if the Vercel team allows the model that engine calls.

Every candidate is judged **on its own**, one request each (the old system judged ten at a time,
which made a result depend on its neighbours and sometimes lost a candidate). A few run at once.
The rest of this section (unusable answers, backup model, the three guards) describes the language-model
engines. The guards apply to Jev in `jev_only` as well; there is no backup model (section 16.5).

If the language model gives an unusable answer (not valid JSON, "approved" that is not true or false,
cut off, a refusal), it is asked again, then a backup model is asked. Only if that also fails does that
one candidate get the fallback: **rejected conservatively** before the unlock (logged as
`sys_invalid_result`), **approved** after the unlock because the credit is already spent (logged as
`sys_fail_open`). The caller (`phase1.js`) does not treat `sys_invalid_result` as a verdict: it books
no rejection and no "seen" record for that card, so it is screened again the next time it appears.

Three guards stop a broken model or a wrong setting from silently rejecting whole pages (most Caterer
pages have only one to three candidates, so a "many candidates" test alone is not enough):

1. A request the gateway refuses (HTTP 400, 404 or 422: a retired or misspelt model name, an option
   the model does not accept) on **both** the main and the backup model is treated as the service being
   unavailable (exit 3), not as a verdict on the candidate.
2. If **every** candidate of a call of two or more is unusable, the call fails as unavailable (exit 3).
   The older test still applies as well: 5 or more unusable and half of the batch.
3. A small counter in `runtime/screening-invalid-streak.json` counts unusable candidates across calls
   while nothing in the same call worked. At `batch.invalidStreakMax` (default 3, forgotten after
   `batch.invalidStreakTtlSec` = 30 minutes, reset by any usable answer) the next call fails as
   unavailable. This is what catches a systemic fault on one-candidate pages.

The `SCREENING_MODEL:` line of a run in which nothing decided names the models that were tried (it used
to say `unknown`). If you prefer approve over reject for the fallback, set `batch.onInvalid` to `approve`.

## 5. Tiers

The **search tier** is worked out from the job title being searched, by the same word patterns as
before. It only decides which over-qualification note the model reads (section 3) and how strict
Jev's ladder is (section 7).

| Tier | Meaning | Examples |
|---|---|---|
| 0 | unknown or not a kitchen ladder title (gets the entry-level note) | Catering Assistant, Waiter, Waitress, Bartender, Food Production, Dish Washer |
| 1 | entry level | Kitchen Assistant, Kitchen Porter, KP |
| 2 | mid | Chef, Cook, Chef de Partie, CDP, Line Cook, Pastry Chef, Baker |
| 3 | senior | Sous Chef, Second Chef, Senior CDP, Junior Sous Chef |
| 4 | head | Head Chef, Executive Chef, Chef Manager, Catering Manager |

Known quirk, kept on purpose: **"Commis Chef" is tier 2, not tier 1**, because the generic word
"chef" matches first. So Commis Chef searches have always been told "over-qualification is not a
reason to reject", while a "Catering Assistant" search is told the strict entry-level rule. About 560
Commis Chef runs were affected. `SCREEN_TIER_MODE=fixed` makes Commis Chef tier 1 as the comment in
the old code intended; that changes who is rejected, so it is your decision, not a bug fix.
"Sous-Chef" written with a hyphen is also tier 2 (it does not match "sous chef").

## 6. How borderline and thin cases are handled (not rigid, not over-strict)

Principles, in code, not just in wording:

1. **Missing information is never a reason for a machine rule to reject.** A card with no experience
   block, or an empty card, goes to a judge; Jev's own answer for "not enough information" is
   "review" (or "approve" when a hospitality signal is present), never "reject".
2. **A reject needs positive evidence** of a mismatch (clearly too junior, clearly unrelated,
   front-of-house only for a kitchen search, and so on) at high probability, **and** a second,
   independent question must agree (the overall-fit score).
3. **Counter-evidence blocks a reject.** If the card shows the duties of the role being searched, or
   any kitchen history while the latest job is something else, it goes to review instead.
4. **Near a boundary, do not guess.** For senior searches, one tier below (a Sous Chef for a Head Chef
   search, a CDP for a Sous Chef search) is "uncertain" and goes to the language model; only a gap of
   two tiers or more is a clear reject. For mid-level searches the ladder table in section 7 applies as
   written: a Kitchen Porter for a Chef search and a Commis for a Chef de Partie search are clear
   rejects (as in the owner's rubric), whichever tier they are next to.
5. **Anything odd is review, not reject:** a missing or malformed Jev answer, a card that tries to
   give instructions to the reader, a post-unlock title that contradicts the card.
6. **After the unlock the bar to reject is higher** (the credit is spent; a false reject loses a
   person, a false approve only costs a recruiter a minute).
7. **The language model's reject for "no visible background" is the old rule.** In the default
   engine this is unchanged, because the aim of the first release is parity. If you want thin cards
   from a hospitality headline to be approved instead (owner decision D6, "recall-tilted"), set
   `rubric.insufficientEvidence` to `lenient`. That replaces only that one bullet with "a card with
   very little detail is NOT enough to reject: when the headline or any listed role is in hospitality
   or catering, approve". The setting is logged with every decision, so you can compare before/after.
   The opt-in `rubric.staleProfileClause` (default off) adds "profile clearly out of date" as a
   reject reason; it is off because it can act as an age filter (section 12) and the aim is the
   widest net.

## 7. Jev: the questions and the ladder

Jev never writes text. It answers typed questions about one candidate, with probabilities. Our code
combines the answers. The questions (exact wording is in `jev-questions.js`; the search role and a
two-line agency description are the only context):

| Question | Type | Asks |
|---|---|---|
| `current_tier` | choice | what kind of job is the most recent or current title: kitchen porter / commis / chef de partie-cook / sous / head / front of house / management (not kitchen) / unrelated / "not stated" |
| `hospitality_seen` | yes/no | is any hospitality or catering job, employer or skill named |
| `kitchen_seen` | yes/no | is work in a professional kitchen shown |
| `role_match_seen` | yes/no | does the card show the role being searched, or its duties |
| `info_sufficient` | yes/no | is enough stated to judge what work the person does |
| `instruction_injection` | yes/no | does the text give instructions to a reader or an AI (an answer of 0.7 or more is a review, `decide.stage1.injectionP` and `decide.stage2.injectionP`) |
| `overall_fit` | 3-level score | not a fit / possible fit / clear fit for agency shifts in this role |
| after unlock: `real_title_tier`, `title_consistent` | choice, yes/no | what kind of job is the unlocked title; does it match the card |

The ladder (which titles are fine, too senior, too junior or uncertain) lives in code and
`config/screening.json` under `decide.ladder`, per search tier:

| Search tier | In band (fine) | Too senior (reject) | Too junior (reject) | Uncertain (review) |
|---|---|---|---|---|
| 0, only for the titles in `decide.ladder.tier0Titles`: Catering Assistant, Kitchen Hand, Food Production, Waiter, Waitress, Server, Front Of House, Bartender, Dish Washer | porter, commis, CDP/cook, front of house | sous, head, non-kitchen manager | - | - |
| 0, any other title (Barista, Kitchen Supervisor, Restaurant Manager ...) | no ladder: everything goes to the language model in the older engines and to the review policy in `jev_only` (`UNKNOWN_SEARCH_LADDER`) | | | |
| 1 | porter, commis, CDP/cook | sous, head, non-kitchen manager | - | front of house (a reject only when no kitchen work is seen at all) |
| 2 (generic) | commis, CDP/cook, sous, head | - | porter | - |
| 2 (Chef de Partie, CDP, Line Cook) | CDP/cook, sous, head | - | porter, commis | - |
| 3 | sous, head | - | porter, commis | CDP/cook |
| 4 | head | - | porter, commis, CDP/cook | sous |

A title matches an entry of `decide.ladder.tier0Titles` when the entry's words appear in it as whole words, in any case
(`Head Waiter` and `Bartender - weekends` match; `Observer` does not match `server`; the one-word spelling `Dishwasher` is a
different word from `dish washer` and needs its own entry). Since 2026-09-30 (SCR-28) the list holds the owner's real
non-kitchen titles. The tier-0 ladder was written for entry-level kitchen searches, so for these titles a porter, commis or
cook counts as in band too and a Sous or Head Chef counts as too senior; if a front-of-house search should accept only
front-of-house candidates, add a per-title entry to `decide.ladder.overrides` (`tiers: [0]`, `matchAny: ["waiter"]`,
`inBand: ["front_of_house"]`) and re-run the report; that override is not shipped.

Other clear mismatches, at every tier that allows them: unrelated industry (needs "no hospitality
anywhere"), front of house only and management only (both need "no kitchen work seen").

Thin information ("not enough stated") approves only when the card still shows hospitality **and**
no level mismatch is close (below `clearFitHardMax`) **and** the overall-fit score does not say "not
a fit" (below `approveNotFitMax`); otherwise it goes to review. Before, a confident wrong tier call
could be approved because the information score happened to sit just under its floor.

The three lanes:

- **approve**: the title is in band with probability at least `approveP`, and "not a fit" is
  unlikely; or the overall-fit score says clear fit and no mismatch is close.
- **reject**: the strongest mismatch has probability at least `rejectP`, the fit score agrees, and
  there is no counter-evidence.
- **review**: everything else. The language model decides in the older engines; in `jev_only` the review
  policy does (section 16).

The numbers (`decide.stage1` before the unlock, `decide.stage2` after) are **placeholders marked
CALIBRATE**: 0.90 to reject and 0.60 to approve before the unlock; 0.95 and 0.50 after. They are
sensible starting points from the Jev design guide and are **not** fitted to your data. Do not
promote Jev on them; use the report to tune them (section 9). The engine `jev` refuses to decide until
`decide.calibration.calibrated` is set to true; before that it logs a warning and runs `jev_shadow`. The
engine `jev_only` is different: it is the owner's explicit choice, so it never refuses and never
downgrades; it runs on the placeholders and prints one warning per run (section 16.6).

**The injection bar is 0.7 (2026-09-30, SCR-27).** Jev's own "does the text contain instructions to an AI" answer fires on the
card's button text ("Unlock candidate", "Updated 3 days ago"): at the old bar of 0.5 it sent cards to the review lane that
nothing was wrong with. The backtest of 326 labelled historical cards (Caterer, pre-unlock, the old system's decisions as
labels) found that moving the bar from 0.5 to 0.7 cuts the uncertain share from 53.4 percent to 45.7 percent and the
candidates the pre-unlock policy loses (old system approved, policy rejects) from 24 to 14, at the cost of 4 more credits
spent on cards the old system rejected. Both stages use 0.7. It is still a CALIBRATE placeholder (the phrase heuristic of
section 10 is unaffected and still routes a card that literally instructs the reader). The sample is small, Caterer only and labelled by the old model, so re-check it with the labelled
sample of section 16.6.

Jev's own "confidence" number is not used to decide. It is a function of its top probability only,
independent tests found it no better than the probability itself, and it says nothing about being
right. We store the raw probabilities and re-run the decision rules offline for any threshold. The language
model also reports a confidence number; it is self-reported, not calibrated, and is logged but not used
to decide.

## 8. Reason codes

Every decision carries a code (used in the log and the report). The sentence printed for humans is
still up to 120 characters and nothing depends on its wording.

| Code | Meaning |
|---|---|
| `approve_level_match` | current role is at an appropriate level |
| `approve_relevant_history` | strong relevant background |
| `approve_senior_ok` | more senior than needed but acceptable |
| `approve_other` | any other reason to approve |
| `reject_no_history` | no visible experience or background |
| `reject_foh_only` | front of house or bar only, for a kitchen search |
| `reject_unrelated_industry` | unrelated industry |
| `reject_management_only` | management with no hands-on kitchen work |
| `reject_too_junior` | too junior for the role |
| `reject_stale_profile` | out of date (only with the opt-in clause) |
| `reject_wrong_specialism` | specialism does not fit |
| `reject_overqualified_entry` | massively over-qualified for an entry-level search |
| `reject_other` | any other reason to reject |
| `sys_fail_open`, `sys_invalid_result` | the two fallbacks in section 4 (never produced by a model) |
| `sys_review_policy_reject`, `sys_review_policy_approve` | a decision taken by the review policy of engine `jev_only` (section 16), never produced by a model |

## 9. Calibration, and how to promote from `jev_shadow` to `jev`

In `jev_only` (the default) there is no language model to compare Jev with, so the gate below is "not
applicable in jev_only mode" and `tools/screening-report.js` prints the Jev-only numbers of section 16.7
instead. This section describes the path from `jev_shadow` to `jev`, which this install does not use and the code refuses
unless `SCREEN_ALLOW_LLM=1` is set (section 16.1): it needs a language model reachable through the gateway.

### What is recorded

For every screened candidate one line is added to `shadow/screening-YYYY-MM-DD.jsonl` (London date):
the platform candidate id, source (caterer or reed), stage, search title and tier, a hash and length of
the snippet, the **redacted** snippet, which stage-1 rules matched, the language model's decision
(code, confidence, model, time), and Jev's answers as numbers with its lane. In `jev_only` the
language-model part is null and the row says which decision the review policy took (section 16.7). Files
are private (mode 0600) and deleted after 180 days.

### The report

```
node tools/screening-report.js                      # last 21 days
node tools/screening-report.js --since 7d --source caterer
node tools/screening-report.js --strict             # exit 0 GO, 1 NO-GO, 2 not enough data
node tools/screening-report.js --json               # every number, machine readable
```

It prints: agreement between Jev and the language model (overall, by Jev confidence band, by source,
stage, role and tier) with a reliability table; approve rates by role and source; how often Jev would
approve what the model rejects (wasted credit) or reject what the model approves (lost candidate); a
threshold sweep (which approve/reject bars would give what coverage and agreement, re-run offline
on the stored answers, one grid per stage) with a recommended point; per-rule results for the
stage-1 rules; and the verdict.

**Important:** the language model is the reference, not the truth. "Agreement" means "the same as
today". To measure correctness you need people. Ask for a sample:

```
node tools/screening-report.js --export-sample 150 --out to-label.jsonl
```

That writes 150 redacted cards (a third where Jev and the model disagree, a third where Jev was
unsure, the rest random) **without any model answer**, each with `"label": null`. Have two
recruiters set `label` to `approve` or `reject` independently, save the answers as JSON lines
`{"candidateId":"...","jobTitle":"...","label":"approve"}`, and run
`node tools/screening-report.js --labels labels.jsonl` to see each engine's accuracy against them.
About 400 labelled cards give roughly plus or minus 5 points at 95 percent confidence.

### The gate (all numbers are in `config/screening.json` under `gate`)

Jev may decide (`jev_shadow` to `jev`) when, over the last 21 days and with enough data:

1. **Agreement:** the promoted system (Jev when it is clear, the model for the rest) agrees with the
   model on at least **90 percent** of decisions, **per source** (Caterer and Reed separately). The old
   engine agrees with itself about 94 percent of the time on repeats, so 90 is not lenient. This number
   counts the review lane as agreeing by construction, so it is never the only check (5 and 6).
2. **Approval rate:** for each role with at least 50 compared cards, the promoted system's approve
   rate is within **3 points** of the model's.
3. **Wasted credits:** Jev approves something the model rejects on no more than **5 percent** of
   compared cards.
4. **Enough data:** at least 500 compared cards per source.
5. **Lost candidates (the costly error):** Jev rejects something the model approves on no more than
   **1.5 percent** of compared cards (`gate.maxJevRejectLlmApprove`) **and** on no more than **5
   percent** of the cards the model approved (`gate.maxJevRejectOfLlmApproved`). The two error types
   are capped separately, so a lost candidate can never be "paid for" by a wasted credit (the approval
   rates can cancel out while both errors are large).
6. **Jev's own lanes:** the 95 percent lower bound of Jev's agreement on the cards it decides itself is
   at least **93 percent** (`gate.minLaneAgreementLo`), and it decides at least **25 percent** of the
   cards it answers on (`gate.minLaneCoverage`; measured on the Jev lanes of every row, so it is right in
   `jev` mode where only a sample of Jev decisions is re-checked by the model).
7. **Every source is seen:** the engine switch applies to Caterer and Reed alike, so a log with Caterer
   rows only is `INSUFFICIENT DATA` until Reed rows exist. While Reed is off on purpose, scope the
   gate in `config/screening.json`: `"requiredSources": ["caterer"]`. That is a deliberate decision that
   the report prints; remember that Reed then runs on Jev without having been measured.

The report says `GO`, `NO-GO` or `INSUFFICIENT DATA` and lists each check. Two weeks of normal running
is about 6,500 cards. If it says NO-GO, use the sweep to see whether other thresholds pass the gate
(the recommendation now respects the lost-candidate caps and the lane bound as well), change them in
`decide.stage1` / `decide.stage2`, wait for more data, and run it again. Change one thing at a time and
note it. `--config <file>` with a path that does not exist is an error, not silently the defaults.

### Promoting

1. Report says GO (and, ideally, the labelled sample agrees).
2. In `config/screening.json`: set `decide.calibration.calibrated` to `true`, fill in `reportId` and
   `date` (notes to yourself), and set `engine` to `jev`. Environment variables `SCREEN_CALIBRATED=1`
   and `SCREEN_ENGINE=jev` do the same and win over the file.
3. Watch the first days: the report keeps working in `jev` mode because 5 percent of Jev decisions are
   re-checked by the model in the background (`shadow.auditRate`). Check the approve rate, the
   post-unlock reject rate (the old engine had 5.8 percent) and Zoho quality.
4. Rollback is one line: set `engine` back to `jev_shadow` (or `llm`). Nothing else changes.

If Jev is unreachable while the engine is `jev`, the language model decides everything (a "degraded"
note appears in `runtime/screening-degraded.json`); the pipeline does not halt while either can answer.

## 10. Stage-1 rules (no network, no model)

Rules that need no model, run first. Each has a mode in `stage1.rules`: `off`, `shadow` (evaluated and
logged, the judge still decides) or `enforce` (the rule decides and no model is called).

| Rule | Fires when | Default |
|---|---|---|
| `S1-NA-NONHOSP` | the card has no experience block at all **and** its headline is not a hospitality title (50 of 50 such cards were rejected by the old model) | `shadow` |
| `T-ENTRY-OVERQUAL-HEAD`, `T-ENTRY-OVERQUAL-SOUS` | entry-level search and the latest role is clearly head / sous level | `shadow` |
| `T-UNDER-GAP` | senior or head search and the latest role is porter/commis level (two tiers or more) | `shadow` |

No rule rejects for missing information alone: a hospitality headline with no experience block is never
rule-rejected; an empty card goes to the judge; a card that contains instructions to a reader is
flagged and always goes to the language model. A rule should be switched to `enforce` only when the
report's rule table says **promote: YES** (at least 200 compared hits, 98 percent agreement, no
high-confidence disagreement). Enforced rules are still audited by the model at `shadow.auditRate`.

## 11. Changing the criteria

| To change | Edit | Then |
|---|---|---|
| the recruiter wording | `scripts/lib/screening/rubric.js` | it changes who is approved: bump `RUBRIC_VERSION`, run in shadow, read the report |
| approve/reject bars, ladder, gate numbers | `config/screening.json` | re-run the report; sweep first |
| Jev's questions | `scripts/lib/screening/jev-questions.js` | bump `QUESTIONS_VERSION`; thresholds do not carry over |
| a stage-1 rule's mode | `config/screening.json` (`stage1.rules`) | no code change |
| the models (`SCREEN_LLM_*` matter for the language-model engines only) | `SCREEN_LLM_MODEL`, `SCREEN_LLM_BACKUP_MODEL`, `SCREEN_JEV_MODEL` | run the install canary; the report groups by model |
| what an unsure card becomes (`jev_only`) | `decide.reviewPolicy` or `SCREEN_REVIEW_PRE` and `SCREEN_REVIEW_POST` | watch the policy share (section 16.4) |
| Commis Chef tier | `SCREEN_TIER_MODE=fixed` | your decision (section 5) |

Rules of thumb: change **one** thing per release; keep parity first and improvements second; the two
policy options that make screening less strict (`lenient`) or stricter (`staleProfileClause`) are off
by default and must be a conscious choice. Question wording, thresholds and the rubric are the parts
worth reviewing by a person.

## 12. Privacy, hosting and legal notes (not legal advice)

**What leaves the server.** For each candidate: the redacted card text (job titles, employers,
dates, duties, town), and for the language model also the search title, town/postcode area and radius.
Names, e-mail, phone numbers (UK and international with a `+`), full postcodes (also written with a
comma, and GIR 0AA), web addresses (also bare linkedin/instagram/facebook/twitter/tiktok/indeed
domains), @handles, National Insurance numbers and dates of birth or ages written with a keyword
(born, DOB, aged) are removed first. This is a heuristic, not a guarantee: the card's rank prefix ("12. ", of 1 to 6 digits)
marks the start of the name, and the surname is the word (after any particles such as van der, dos, de la) that follows the
first name unless it is a job word, so a surname that is also a job word (Cook, Baker) stays, a second surname or middle
name stays, and a name mentioned in the body is only replaced when it is the first name. Names in upper case, and names
typed in lower case within the first two words after the rank (or after the card's first name), are removed like any other
(2026-09-30, SCR-26: before that only capitalised names after a 1 to 3 digit rank were, and a backtest of 952 historical cards
found 149 with a 4-digit rank and 132 with a lower-case name, whose names would have been sent to Jev; a lower-case word
that follows the name and is not a job word is taken for a surname too, so an unusual lower-case headline word right after
the name can be removed with it). Numbers written
without a leading 0 or +, street addresses, obfuscated e-mails and uncased scripts are not caught.
Tests plant a fake name and postcode and check that neither reaches the model, Jev or the log. Treat the
shadow log as personal data (below).

Screening itself does not write CVs or snippets to disk, with three exceptions: the shadow log below
(redacted card text and the platform candidate id, kept 180 days, unless `shadow.storeText` is off, which
is forced when redaction is off), the decision cache (decisions only, never text), and, only with
`SCREEN_INPUT_MODE=file`, a short-lived 0600 file under `runtime/screening-input/` that the reviewer deletes
as soon as it has read it. The old `review-tmp` files are gone; leftovers older than an hour are deleted
when the tool starts. Single-candidate reviews now read the snippet, job title and first name from
standard input (`--single-file -`), so none of them appears on a command line.

The default engine `jev_only` sends every redacted card to Jev (United States) and to nobody else. If the
data protection position (DPA, UK addendum, international transfer) is not settled yet, that is the owner's
decision to take before screening is switched on (docs/DECISIONS.md OD-A records what was accepted). The
other engines would send the same text to a language model instead, and the owner's Vercel team blocks
those models.

**Where it goes.** The Vercel AI Gateway (one key, `AI_GATEWAY_API_KEY`), then TypeSafe AI's Jev
(served through DigitalOcean); only Jev is allowed through this key on the owner's Vercel team (the older
engines would also reach Anthropic and its cloud hosts). Jev is
hosted in the **United States**, there is no UK or EU region, and TypeSafe's terms give no fixed
retention period ("as long as reasonably necessary", and its terms allow keeping data for telemetry);
zero data retention is an enterprise feature and the sources disagree about whether the gateway can
provide it for Jev. Set `SCREEN_JEV_ZDR=1` (Jev only) or `SCREEN_LLM_ZDR=1` (the language model only)
after the install-time canary shows that path works; `SCREEN_ZDR=1` sets both and is only safe when
both paths passed the canary, because a gateway that cannot honour it answers with a 400 and the deciding
model would then be unavailable (see docs/INSTALL.md). In `jev_only` only the Jev path exists, so
`SCREEN_JEV_ZDR=1` and `SCREEN_ZDR=1` mean the same; a refusal (HTTP 400 `no_providers_available`) makes
screening unavailable (exit 3, halt), never a fallback. TypeSafe has a data
processing agreement with the UK addendum; the vendors state they do not train on your inputs.
Check the DPA and the sub-processor list before relying on this.

**Contract clause to respect.** TypeSafe's terms (clause 2.3(b)) forbid using Jev's outputs to train
a model that imitates Jev or to build a competing service. Nothing here trains anything. Storing
Jev's numbers to tune thresholds is fine; do **not** use them as labels to train another model. If you
ever want to fit a classifier on Jev's probabilities plus your own human labels (the documented
use), ask TypeSafe to confirm in writing first.

**The log is personal data.** Candidate id plus redacted text, mode 0600, kept 180 days, then
deleted (`pruneShadow`). To keep only hashes, set `shadow.storeText` to `false` (or
`SCREEN_SHADOW_TEXT=0`); you then cannot build a labelled sample from the log. Use the same access
rules as for `candidates.db`.

**Automated decisions.** Screening decides who is unlocked or viewed; recruiters still decide who is
placed. That is still a form of automated pre-selection, so under UK GDPR (article 22 and the
transparency rules) and equality law you should: say so in the candidate privacy notice, keep a human
route for challenges, avoid proxies for protected characteristics (the log holds no names or photos; birth
dates and ages are masked when written with a keyword but that is not enforced for free text, mainly
Reed CV text; salary, location and licence are never used; the stale-profile rule is off because
it can work as an age filter), and audit regularly (the weekly review of a labelled sample above).
A data protection impact assessment is sensible. Ask counsel; this page is not legal advice.

## 13. When things fail, and what you will see

The table describes the language-model engines. What `jev_only` does in the same situations is section 16.5.

| Situation | Behaviour |
|---|---|
| service unreachable, 5xx, 429 or timeouts after retries | exit 3, `API_UNAVAILABLE:<detail>` on stdout, marker on stderr; Caterer waits 2 minutes and retries the page, three failures in a row halt the pipeline (nothing is consumed) |
| key wrong (401, 403) or credits gone (402) | exit 3 immediately, no retries; the supervisor health check then reports `screening gateway auth failed` or `screening credits exhausted` |
| the gateway refuses the request (HTTP 400/404/422) on both models | unavailable (exit 3), whatever the page size; the run is labelled with the models it tried |
| one candidate's answer stays unusable, other candidates in the call were fine | that candidate only: `sys_invalid_result` (before unlock; the caller books no rejection and screens it again later) or `sys_fail_open` approve (after unlock), logged in `logs/errors.jsonl` |
| every candidate of a call of two or more unusable, or 5+ and half of the batch, or 3 unusable in a row across calls | treated as unavailable (never a silent mass reject) |
| the reviewer exits 1, prints no JSON, prints `[]` or only unusable results for a page | `phase1.js` stops the run as incomplete (`incomplete: screening-error`): nothing is booked, Phase 2 is skipped, the pending search stays; if the text shows `API_UNAVAILABLE`, `OAuth` or `Gateway HTTP 5` the pipeline halt is raised too; a repeating non-API fault is given up after `PHASE1_INCOMPLETE_MAX_RUNS` (3) runs with a critical alert `phase1-incomplete-giveup` |
| Jev down in `jev_shadow` | nothing changes; the log shows `jev.status` error |
| Jev down in `jev` | the model decides everything; degraded flag; no halt |
| bad command line or unreadable input | exit 1 with `FATAL` |

Halt reasons are a fixed set (no status codes in them, so a changing HTTP code does not create a new
halt): `screening gateway unreachable`, `screening gateway auth failed`, `screening credits
exhausted`, `screening gateway error`, `AI screening unavailable`. The supervisor calls
`screening-health.js`: a cheap connectivity check on every tick (milliseconds, no API call) and, only
while halted and at most once a minute, a deep check (credit balance plus one tiny canary call, about a
second and a fraction of a cent; the old probe took 73 to 103 seconds).

Cost: roughly 0.2 cents per candidate for the language model and a few hundredths of a cent for Jev;
about 500 candidates a day is around one dollar a day at most. In `jev_only` only the Jev part applies.

## 14. Settings reference

Environment variables (all optional except the key). Each overrides `config/screening.json`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | none (required) | Vercel AI Gateway key; read from the profile `.env`; never logged |
| `SCREEN_ENGINE` | `jev_only` | `jev_only`, `llm`, `jev_shadow` or `jev`; anything but `jev_only` is refused (it becomes `jev_only`, with a warning) unless `SCREEN_ALLOW_LLM=1` |
| `SCREEN_ALLOW_LLM` | off | `1` lets the engines `llm`, `jev_shadow` and `jev` run (they call the gateway's chat endpoint). Leave it off while the Vercel team allows Jev only (section 16.1) |
| `SCREEN_TIER_MODE` | `legacy` | `legacy` or `fixed` (Commis Chef tier) |
| `SCREEN_REVIEW_PRE`, `SCREEN_REVIEW_POST` | `reject`, `approve` | `jev_only`: what an unsure card becomes before and after the unlock (`reject` or `approve` each; section 16.3) |
| `SCREEN_GATEWAY_ORIGIN` | `https://ai-gateway.vercel.sh` | gateway origin (tests point it at a fake) |
| `SCREEN_LLM_MODEL`, `SCREEN_LLM_BACKUP_MODEL` | `anthropic/claude-sonnet-5.5`, `anthropic/claude-sonnet-5` | deciding model and backup (not used by `jev_only`) |
| `SCREEN_JEV_MODEL` | `typesafe-ai/jev` | Jev model |
| `SCREEN_CONCURRENCY`, `SCREEN_LLM_CONCURRENCY` | 6, 4 | requests in flight |
| `SCREEN_JEV_TIMEOUT_MS`, `SCREEN_LLM_TIMEOUT_MS` | 15000, 60000 | per request |
| `SCREEN_MAX_ATTEMPTS` | 3 | per engine per request |
| `SCREEN_BACKOFF_BASE_MS`, `SCREEN_RETRY_AFTER_CAP_MS` | 1000, 30000 | retry delay base and cap on a server Retry-After |
| `SCREEN_SHADOW`, `SCREEN_SHADOW_RATE`, `SCREEN_SHADOW_TEXT` | on, 1, on | shadow logging, share of candidates compared, keep redacted text |
| `SCREEN_REDACT` | on | redaction (leave on) |
| `SCREEN_STALE_RULE`, `SCREEN_INSUFFICIENT` | off, `legacy` | the two opt-in rubric variants |
| `SCREEN_CACHE_TTL_SEC` | 3600 | decision cache (decisions only, never text); 0 disables |
| `SCREEN_PAGE_RETRY_PAUSE_SEC` | 120 | pause the caller takes before retrying a page |
| `SCREEN_ZDR`, `SCREEN_LLM_ZDR`, `SCREEN_JEV_ZDR` | off | ask for zero data retention: both paths, the language model only, Jev only (only after the canary proves that path; a specific switch beats `SCREEN_ZDR`) |
| `SCREEN_CALIBRATED` | from file | marks Jev thresholds as calibrated (in `jev_only` it only silences the warning) |
| `SCREEN_CONFIG_FILE` | `config/screening.json` | alternative settings file |
| `SCREEN_SOURCE`, `SCREEN_RUN_ID` | detected, none | label rows in the log (also `--source`, `--run-id`) |

Command line (unchanged from the old script, so callers need no change): `node scripts/ai-review.js
--mode batch --job <title> --location <postcode> --distance <miles> --candidates-file <path>` and
`--mode single --job <title> --title <job title> --snippet <text>`. Output: a JSON array (batch) or
object (single) on one line of stdout, `SCREENING_MODEL: <label>` on stderr, exit 0 (ok), 1 (usage or
input error) or 3 (`API_UNAVAILABLE`). Optional additions: `--candidates-file -` reads stdin,
`--consume-input` deletes the file after reading, `--source caterer|reed` and `--run-id <id>` label the
log, `--name <first name>` (single mode) helps redaction, `--single-file <path|->` (single mode) reads
`{"title","snippet","name"}` from a file or stdin instead of the three flags, `--with-codes` adds
`reasonCode` to each result (`phase1.js` always passes it so it can tell `sys_invalid_result` from a real
rejection), `--batch-size` is accepted and ignored. `scripts/caterer-ai-review.js` is the same program
under its old name.

Other settings live only in `config/screening.json`: `batch.deadlineMs` (600 s), `batch.breakerConsecutive`
(3), `batch.invalidStreakMax` (3) and `batch.invalidStreakTtlSec` (1800), `batch.onInvalid`,
`shadow.graceMs` (5 s, the most a slow Jev can delay a run), `shadow.auditRate` (ignored in `jev_only`), `decide.reviewPolicy` (also the two variables above), `shadow.retentionDays`,
`llm.reasoningEffort` (leave empty unless the model is slow), `decide.ladder.tier0Titles`, `gate.*`
(including `maxJevRejectLlmApprove`, `maxJevRejectOfLlmApproved`, `minLaneAgreementLo`, `minLaneCoverage`,
`requiredSources`). A setting of the wrong type (in `decide.ladder` too: anything but lists of strings where the ladder needs them) is replaced by its default with a `WARN screening config:`
line on stderr; `gateway.origin` must be https (plain http only for this machine), and
`SCREEN_CONFIG_FILE` naming a file that does not exist warns.

## 15. Tests and known limits

Run (the quoted pattern matters: a bare directory name does not work with Node 22 or later):
`node --test "tests/screening/*.test.js"`. They use a fake gateway on 127.0.0.1, fake keys and
synthetic candidates, and refuse any other network address.

The redaction of rank prefixes and name case is pinned by `tests/screening/redact-rank-case.test.js`; the tier-0 titles and the
injection bar by `tests/screening/ladder-titles-injection.test.js`.

The Jev-only engine has its own suites, `tests/screening/jev-only.test.js` and `tests/screening/jev-only-report.test.js`: in every scenario
the fake gateway's counter for the chat-completions route must stay at 0 (and that route is set to answer 403 "restricted access").
`tests/e2e/13-jev-only.e2e.js` runs the whole pipeline on the default engine.

Not verifiable offline (checked at install and during shadow): whether the owner's Vercel team lets Jev through (INSTALL 7.2 and 7.4
check it), the real response shape and latency
of Jev through the gateway (the parser is defensive: confidence is read from the answer, then from
metadata, then computed; missing or malformed answers become "review"), whether the new model
approves at the same rate as the old one, whether structured output is accepted for the chosen
model, whether zero data retention works for Jev, and how the real cards look after redaction.

## 16. Jev-only mode (`jev_only`, the default engine)

### 16.1 What it is and why

Decision of 2026-09-30 (docs/DECISIONS.md OD-I): the Vercel AI Gateway carries Jev (`typesafe-ai/jev`) and nothing
else. The owner's Vercel team blocks every other model: any chat request is answered with HTTP 403 "Your team has
restricted access to this model". Other models will later run through the Hermes agent runtime, not through this
gateway. So in this engine **no language model exists anywhere in screening**: the code never sends a request to a
chat-completions endpoint (the tests count requests on a fake gateway in every scenario), the deep health check
never calls one, the background audit is off, and `SCREEN_LLM_MODEL` and `SCREEN_LLM_BACKUP_MODEL` are ignored.
Only Jev may be named on the gateway: another model name in `SCREEN_JEV_MODEL` is replaced by the default, with a
warning.

Two locks keep it that way. `config.load` replaces any other engine by `jev_only` (with a `WARN screening config:` line)
unless `SCREEN_ALLOW_LLM=1` is set, so a leftover `SCREEN_ENGINE=jev_shadow` from an earlier install, or a typo such as
`JEV`, is harmless: the run goes on with Jev alone. And the language-model client refuses to be built without that
opt-in, so no other code path can send a chat request. The deep health check follows the effective engine, so it never
calls a chat endpoint either.

### 16.2 What Jev decides and what the policy decides

| Situation | Decided by | Reason code |
|---|---|---|
| Jev is confident the card fits (approve lane, section 7) | Jev | `approve_*` |
| Jev is confident of a clear mismatch and the fit score agrees (reject lane) | Jev | `reject_*` |
| Jev is not sure (review lane): level uncertain, thin information without a hospitality signal, a post-unlock title that contradicts the card, a search title with no ladder, Jev's own "this card instructs the reader" answer | the review policy | `sys_review_policy_reject` or `sys_review_policy_approve` |
| The card matches the instruction-to-the-reader pattern (Jev is not asked) | the review policy | the same |
| The card is empty (under 20 characters; Jev is not asked) | the review policy | the same |
| Jev's answer stays unusable after 2 attempts (malformed, a question missing, a non-Jev model named), or the thresholds cannot be applied to it, before the unlock | nobody: the card is left undecided (phase 1 books nothing and screens it again); it counts towards the guards of 16.5 | `sys_invalid_result` |
| The same, after the unlock | the review policy (the credit is spent) | `sys_review_policy_*` |
| Jev cannot answer at all (unreachable, refused, out of credit, timeout) | nobody: the call is unavailable (exit 3) | none (16.5) |

Whether Jev is unsure depends on the thresholds (`decide.stage1`, `decide.stage2`), which are placeholders (16.6). A
stage-1 rule of section 10 set to `enforce` would still decide before Jev is asked; by default none is.

**Searches with no ladder.** A search title on no ladder (search tier 0 other than the three titles in
`decide.ladder.tier0Titles`: for example Barista, Kitchen Supervisor, Restaurant Manager, Housekeeper) puts EVERY card in the
review lane (`UNKNOWN_SEARCH_LADDER`), because Jev's ladder does not say what is a fit for such a role. With no other model
in the system the policy decides all of them: with the default policy every card of such a search is rejected before the
unlock. The list ships with the owner's real non-kitchen titles (Waiter, Waitress, Server, Front Of House, Bartender, Dish
Washer; 2026-09-30, SCR-28, closing K-SCR12 for them). For any other title, add it to `decide.ladder.tier0Titles` (it then
uses the tier-0 ladder, which may need adjusting for front-of-house roles, section 7) or set `SCREEN_REVIEW_PRE=approve` (which
affects every search). The report shows the symptom as a
100 percent policy share for that role, and `policy.reviewReason` in the shadow rows says `UNKNOWN_SEARCH_LADDER`.

### 16.3 The two policy switches

`decide.reviewPolicy.preUnlock` (environment `SCREEN_REVIEW_PRE`) and `decide.reviewPolicy.postUnlock`
(`SCREEN_REVIEW_POST`). The defaults reproduce the old system's fail-closed before the unlock and fail-open after it.

| Setting | What happens | What it costs |
|---|---|---|
| `preUnlock: reject` (**default**) | An unsure card is rejected before the unlock (booked as a rejection for that job title only, so the person stays eligible for other roles). | A person who would have been suitable is not unlocked for this search: a lost candidate. No credit is spent on unsure cards. |
| `preUnlock: approve` (recall-tilted) | An unsure card is unlocked. | One unlock credit for every unsure card, and a recruiter's minute for each one that turns out unsuitable. While the thresholds are placeholders the review lane can be a large share of the cards: watch the credit balance and the policy share (16.4). |
| `postUnlock: approve` (**default**) | An unsure unlocked candidate goes to Zoho for a recruiter. | A recruiter's minute for an unsuitable candidate; the credit is spent either way. |
| `postUnlock: reject` | An unsure unlocked candidate is dropped. | The credit is wasted and the person is lost. Not advised. |

Change one at a time and note the date: the shadow rows record which side applied (`policy.side`).

### 16.4 How much is policy: the share to watch

Every decision taken by the policy has its own reason code and is counted separately:

- the summary line on stderr of every call, `policy=N (reject=a approve=b share=x) why={...}`, where `why` is `review`,
  `injection`, `no_content` or, after the unlock only, `invalid` (a decision served from the cache reads `cached`).
  Unusable answers before the unlock are no policy decision: they show as `invalid=N` on the same line;
- the shadow rows: `used.engine` is `policy`, and `policy` holds `why` and `side`;
- the run label `SCREENING_MODEL: typesafe-ai/jev+policy` (plain `typesafe-ai/jev` when Jev decided every card);
- section J of the report (16.7): the policy share overall and by stage, by reason, by role and by source.

There is no target number. A high share means Jev is often unsure, which is a fact about the placeholder thresholds
or about Jev, not an install fault; the report shows where (role, source, stage, reason), so the thresholds can be
tuned or the policy changed on purpose.

### 16.5 Failures: never a silent reject, never a fallback

| Situation | Behaviour |
|---|---|
| Jev unreachable, HTTP 5xx or 429, or a timeout, after the retries | exit 3, `API_UNAVAILABLE:<detail>` on stdout, `SCREENING_MODEL: typesafe-ai/jev` on stderr; phase 1 waits and retries the page, three failures in a row halt the pipeline, nothing is consumed |
| HTTP 401, 402 or 403 (bad key, no credit, or "Your team has restricted access to this model") | exit 3 at once, no retries; the halt reason is `screening gateway auth failed` or `screening credits exhausted`; for the restricted-model 403 the remedy says to allow `typesafe-ai/jev` on the Vercel team |
| HTTP 400, 404 or 422 (for example the zero-data-retention refusal `no_providers_available`) | exit 3, halt reason `screening gateway error` |
| one card of a call cannot be screened while others could | the whole call is unavailable (all or nothing) |
| Jev's answer for one card stays unusable, the other cards of the call are fine | that card only. Before the unlock: `sys_invalid_result`, the card is left undecided and phase 1 screens it again. After the unlock: the review policy (`sys_review_policy_*`, shadow row `policy.why` = `invalid`). Logged to `logs/errors.jsonl` as `screening_invalid_result`; never cached |
| every card of a call of two or more unusable, or 5 or more and half of the call, or 3 unusable in a row across calls (`batch.invalidStreakMax`, 30 minutes) | unavailable (exit 3): the same guards as the language-model engines |
| a missing key | exit 3 before any request, marker `none` |

A policy reject is booked by phase 1 like any other rejection: the owner chose the policy for a card Jev was unsure
about. An unusable answer is different, it is a fault and not an unsure card: before the unlock it is
`sys_invalid_result` (phase 1 books nothing and screens the card again, as with the language-model engines; Reed, like
the old system, books it as a rejection). The guards above are what stop a systemic Jev fault from turning into a run of
undecided cards. `decide()` reports any exception (for example a settings error the load check did not catch) as an
unusable answer, so such a fault feeds the same guards instead of quietly sending every card to the policy.

Known gap (docs/KNOWN-LIMITS.md K-SCR13): the guards do not count unusable answers after the unlock (one card per call).
If Jev's after-unlock questions alone were to fail, every unlocked candidate would be approved by the policy. Section J of
the report shows it (policy share by stage and reason `invalid`).

### 16.6 Uncalibrated thresholds

`decide.calibration.calibrated` is false, and `jev_only` runs anyway: it never downgrades to another engine (that
interlock belongs to `jev`). At the start of a screening run the engine writes exactly one line to stderr:

`WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds ...`

"Run" means one pipeline run when the caller passes `--run-id` (phase 1 does; `runtime/screening-uncalibrated-warned.json`
remembers the last run id, and phase 1 copies the line into its run log), otherwise one process (Reed passes no run id, so its
log shows it once per screening call). Every shadow row carries `cal: false`. `SCREEN_CALIBRATED=1` (or
`decide.calibration.calibrated: true`) only silences the line: set it when the thresholds have been tuned on data.

There is no language model to compare Jev with in this mode, so calibration means people. Export a sample
(`node tools/screening-report.js --export-sample 150 --out to-label.jsonl`; it includes the policy decisions), have two
recruiters label it, and run `--labels`: the report then prints the accuracy of Jev's own decisions and of the policy
separately. Then tune `decide.stage1` and `decide.stage2` (the bars and the ladder of section 7), one change at a time.

### 16.7 Shadow log and report in this mode

Rows keep the schema of section 9 (redacted, section 12) with `mode: "jev_only"`, `llm: null`, `cal` and, for a policy
decision, `used.engine: "policy"` and `policy: {why, side}`. The background audit (`shadow.auditRate`) is off.
`tools/screening-report.js` on such rows prints section J: the Jev lane distribution, the approval rate by role, source
and stage, a histogram of Jev's confidence in its approve and reject decisions, the policy decisions (share, by reason
and stage), the cards left undecided, the top reason codes and a what-if grid (re-run offline on the stored answers: how much would go to the
policy, and what share of Jev's decisions would be approvals, at other approve and reject bars). There is no agreement metric. The verdict line reads "engine promotion
(jev_shadow -> jev): not applicable in jev_only mode" and `--strict` exits 3.

### 16.8 The extension point: a second opinion for unsure cards

A future runtime (for example a language model reached through Hermes, not through this gateway) can be plugged in
without touching Jev's logic. `resourcer/scripts/lib/screening/second-opinion.js` defines the interface and nothing
else. **No provider ships**, and no setting enables one.

```js
// createEngine(cfg, { secondOpinion: provider })   engine jev_only only; every other engine ignores it
const provider = {
  name: 'hermes-runtime',   // shown in SCREENING_MODEL and in the shadow row
  review(req, { signal }) { return Promise.resolve({ approved: true, reasonCode: 'approve_other', confidence: 0.8 }); },
};
// req: { job, stage, searchTier, snippet, title, reviewReason, candidateId }   redacted text only
```

The engine asks the provider only about a card Jev could not decide: the review lane or an unusable answer. A card that
trips the instruction-to-the-reader checks, and an empty card, never leave the engine (they go to the policy). An
answer `{approved: boolean, ...}` becomes the decision (source `second_opinion`, model = the provider's name). `null`, a
throw, a malformed answer or a 30-second timeout all mean "no opinion", and the card falls back to the review policy:
a provider can never make screening unavailable. The shadow row records `second: {provider, status}`. Whatever the
provider needs to reach a model belongs to the provider; if it sends text to a third party, the data protection
position of section 12 has to cover that first.
