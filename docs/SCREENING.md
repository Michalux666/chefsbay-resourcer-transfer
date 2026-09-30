# AI screening: what it judges, how, and how to change it

This page is for the owner. It explains, in plain English, how the resourcer decides which Caterer
and Reed candidates are worth an unlock (or a profile view), what the criteria are, how borderline
cases are handled, how we will find out whether the new "Jev" model can be trusted, and what to do
about privacy. Code: `resourcer/scripts/ai-review.js` and `resourcer/scripts/lib/screening/`.
Settings: `resourcer/config/screening.json`. Report: `tools/screening-report.js`.

## 1. The short version

- Every candidate card is judged **before** we spend an unlock credit (pre-unlock, Caterer and Reed)
  and Caterer candidates are judged **again after** the unlock (post-unlock, with the real job title).
- Today's judge is a normal language model (Claude, reached through the Vercel AI Gateway) reading
  the same recruiter instructions the old system used, word for word.
- A second, much cheaper model, **Jev**, judges the same cards **in parallel but only takes notes**.
  Its answers are written to a private log. It cannot change any decision. This is called
  `jev_shadow` and it is the default.
- After a few weeks a report (`tools/screening-report.js`) shows how often Jev agrees with the
  language model and whether it is safe to let Jev decide (section 9). Switching is one setting.
- If the AI service is down, screening says so (`API_UNAVAILABLE`, exit code 3), the pipeline pauses
  and **no territory or candidate is used up**. A service failure is not turned into rejections: a
  request the gateway refuses (a 4xx from both models), a call in which nothing at all was usable, and a
  run of unusable answers across calls all count as "service down" too (sections 4 and 13). The one
  case that still produces a "rejected" line is a single card whose answer stays unusable next to
  cards that were fine, and the caller does not record that as a rejection (it is screened again).

## 2. What is judged, and on what information

| Stage | Who | Information the judge sees |
|---|---|---|
| Pre-unlock, Caterer | every card not already in our database | the card text (at most 500 characters): headline title, city, "recent experience" snippets, employer names, dates, short duties |
| Pre-unlock, Reed | every card not already in our database | the card fields (current and desired role, salary, type, permit, notice) plus the first 1,500 characters of the free anonymised CV |
| Post-unlock, Caterer | every unlocked candidate | the same card text plus the job title returned by the unlock |

What the judge is told about the search: the job title (for example "Chef de Partie"), the town or
postcode area and the radius (context only, never a reason).

What is **never** used to reject: salary expectations, where the person lives, whether they drive.

What is **removed before anything leaves the server** (section 12): the first name, the surname
(best effort), full postcodes, e-mail addresses, phone numbers and web addresses.

## 3. The criteria (the recruiter instructions, verbatim)

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
| `llm` | the language model | not used | parity with the old system, no Jev traffic |
| `jev_shadow` (**default**) | the language model | answers in parallel, logged only | collects the evidence for the go/no-go |
| `jev` | Jev first (approve or reject when it is clear); the language model for everything unclear | decides | after the gate is passed (section 9) |

Every candidate is judged **on its own**, one request each (the old system judged ten at a time,
which made a result depend on its neighbours and sometimes lost a candidate). A few run at once.

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
| `instruction_injection` | yes/no | does the text give instructions to a reader or an AI |
| `overall_fit` | 3-level score | not a fit / possible fit / clear fit for agency shifts in this role |
| after unlock: `real_title_tier`, `title_consistent` | choice, yes/no | what kind of job is the unlocked title; does it match the card |

The ladder (which titles are fine, too senior, too junior or uncertain) lives in code and
`config/screening.json` under `decide.ladder`, per search tier:

| Search tier | In band (fine) | Too senior (reject) | Too junior (reject) | Uncertain (review) |
|---|---|---|---|---|
| 0, only for Catering Assistant, Kitchen Hand, Food Production (`decide.ladder.tier0Titles`) | porter, commis, CDP/cook, front of house | sous, head, non-kitchen manager | - | - |
| 0, any other title (Waiter, Bartender, Kitchen Supervisor, Restaurant Manager ...) | no ladder: everything goes to the language model (`UNKNOWN_SEARCH_LADDER`) | | | |
| 1 | porter, commis, CDP/cook | sous, head, non-kitchen manager | - | front of house (a reject only when no kitchen work is seen at all) |
| 2 (generic) | commis, CDP/cook, sous, head | - | porter | - |
| 2 (Chef de Partie, CDP, Line Cook) | CDP/cook, sous, head | - | porter, commis | - |
| 3 | sous, head | - | porter, commis | CDP/cook |
| 4 | head | - | porter, commis, CDP/cook | sous |

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
- **review**: everything else. The language model decides.

The numbers (`decide.stage1` before the unlock, `decide.stage2` after) are **placeholders marked
CALIBRATE**: 0.90 to reject and 0.60 to approve before the unlock; 0.95 and 0.50 after. They are
sensible starting points from the Jev design guide and are **not** fitted to your data. Do not
promote Jev on them; use the report to tune them (section 9). The engine `jev` refuses to decide until
`decide.calibration.calibrated` is set to true; before that it logs a warning and runs `jev_shadow`.

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

## 9. Calibration, and how to promote from `jev_shadow` to `jev`

### What is recorded

For every screened candidate one line is added to `shadow/screening-YYYY-MM-DD.jsonl` (London date):
the platform candidate id, source (caterer or reed), stage, search title and tier, a hash and length of
the snippet, the **redacted** snippet, which stage-1 rules matched, the language model's decision
(code, confidence, model, time), and Jev's answers as numbers with its lane. Files are private (mode
0600) and deleted after 180 days.

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
| the models | `SCREEN_LLM_MODEL`, `SCREEN_LLM_BACKUP_MODEL`, `SCREEN_JEV_MODEL` | run the install canary; the report groups by model |
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
(born, DOB, aged) are removed first. This is a heuristic, not a guarantee: the surname is the
capitalised word (after any particles such as van der, dos, de la) that follows the first name unless it
is a job word, so a surname that is also a job word (Cook, Baker) stays, a second surname or middle
name stays, and a name mentioned in the body is only replaced when it is the first name. Numbers written
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

Default engine `jev_shadow` sends every redacted card to Jev (United States) in parallel from the first
run. If the data protection position (DPA, UK addendum, international transfer) is not settled yet, run
`SCREEN_ENGINE=llm` (or `SCREEN_SHADOW=0`) until it is; that is the owner's decision (docs/DECISIONS.md
should record it).

**Where it goes.** The Vercel AI Gateway (one key, `AI_GATEWAY_API_KEY`), then either Anthropic (and
its cloud hosts) for the language model, or TypeSafe AI's Jev (served through DigitalOcean). Jev is
hosted in the **United States**, there is no UK or EU region, and TypeSafe's terms give no fixed
retention period ("as long as reasonably necessary", and its terms allow keeping data for telemetry);
zero data retention is an enterprise feature and the sources disagree about whether the gateway can
provide it for Jev. Set `SCREEN_JEV_ZDR=1` (Jev only) or `SCREEN_LLM_ZDR=1` (the language model only)
after the install-time canary shows that path works; `SCREEN_ZDR=1` sets both and is only safe when
both paths passed the canary, because a gateway that cannot honour it answers with a 400 and the deciding
model would then be unavailable (see docs/INSTALL.md). TypeSafe has a data
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
about 500 candidates a day is around one dollar a day at most.

## 14. Settings reference

Environment variables (all optional except the key). Each overrides `config/screening.json`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | none (required) | Vercel AI Gateway key; read from the profile `.env`; never logged |
| `SCREEN_ENGINE` | `jev_shadow` | `llm`, `jev_shadow` or `jev` |
| `SCREEN_TIER_MODE` | `legacy` | `legacy` or `fixed` (Commis Chef tier) |
| `SCREEN_GATEWAY_ORIGIN` | `https://ai-gateway.vercel.sh` | gateway origin (tests point it at a fake) |
| `SCREEN_LLM_MODEL`, `SCREEN_LLM_BACKUP_MODEL` | `anthropic/claude-sonnet-5.5`, `anthropic/claude-sonnet-5` | deciding model and backup |
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
| `SCREEN_CALIBRATED` | from file | marks Jev thresholds as calibrated |
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
`shadow.graceMs` (5 s, the most a slow Jev can delay a run), `shadow.auditRate`, `shadow.retentionDays`,
`llm.reasoningEffort` (leave empty unless the model is slow), `decide.ladder.tier0Titles`, `gate.*`
(including `maxJevRejectLlmApprove`, `maxJevRejectOfLlmApproved`, `minLaneAgreementLo`, `minLaneCoverage`,
`requiredSources`). A setting of the wrong type is replaced by its default with a `WARN screening config:`
line on stderr; `gateway.origin` must be https (plain http only for this machine), and
`SCREEN_CONFIG_FILE` naming a file that does not exist warns.

## 15. Tests and known limits

Run (the quoted pattern matters: a bare directory name does not work with Node 22 or later):
`node --test "tests/screening/*.test.js"`. They use a fake gateway on 127.0.0.1, fake keys and
synthetic candidates, and refuse any other network address.

Not verifiable offline (checked at install and during shadow): the real response shape and latency
of Jev through the gateway (the parser is defensive: confidence is read from the answer, then from
metadata, then computed; missing or malformed answers become "review"), whether the new model
approves at the same rate as the old one, whether structured output is accepted for the chosen
model, whether zero data retention works for Jev, and how the real cards look after redaction.
