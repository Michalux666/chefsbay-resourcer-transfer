# CV screening after the unlock (owner guide)

This page is for the owner. It says what the CV screening stage asks, why, how it decides in plain English, how to change its numbers, what the switches mean, how to read its log and alerts, and what it cannot do. The build notes for whoever maintains it (what changed in Phase 2, the mapping to the old system) are in `docs/parity/cv-stage.md`.

**Read this first (one minute).**
- The stage reads each downloaded CV, looks at the whole work history (not only the latest job) and asks Jev whether it fits the role that was searched for. Simple code, using numbers you can edit, then says pass or reject. It starts in **shadow** mode (the default): it records what it would have done and never blocks anything. Applying its decisions (`CV_SCREEN=on`) is your call, made with the acceptance of section 10, "Operating it".
- Jev makes the call for practically every CV it can be asked about. Two groups of CVs are never rejected and go to Zoho as today: CVs that cannot be read at all, and CVs that were read but from which no list of jobs could be made (about 5 to 8 percent of CVs in total, section 9). Counted over all CVs, Jev decides about 92 to 95 percent, not 99; over the CVs it can be asked about, 100 percent in every measurement.
- When it is in real doubt it lets the CV through (a wasted credit costs 1, a lost candidate 3, both editable) and marks the decision `forced`. Read the forced list once a week (section 7).
- Three things for you to decide before `CV_SCREEN=on`: (1) whether a person may be turned down automatically (section 9); (2) whether a person who only ever worked as a kitchen porter or kitchen assistant should be turned down for a chef, cook or chef de partie search (today: yes when Jev is sure the work was only pot washing and clearing, section 9); (3) that a rejected person is not offered again for another role either, because of how the pipeline already treats everybody it has unlocked (section 6).

## 1. What it is, in one paragraph

Today nobody reads a CV before it goes to Zoho: the pipeline screens the short search-card snippet (before the unlock) and, after the unlock and download, pushes the candidate. The new stage sits between the download and Zoho. It reads the downloaded CV, takes out everything personal, turns the work history into a short list of jobs, and asks Jev (TypeSafe, through the Vercel AI Gateway; the only model this stage ever calls) how each job relates to the role that was searched for. Plain code then decides **pass or reject**. A pass goes to Zoho as before. A reject is not pushed; its CV and file are deleted and the rejection is remembered for that job title. That is what `CV_SCREEN=on` does. The stage runs in **`shadow` by default**: every CV is screened and logged, but nothing is blocked, so the pipeline behaves as it did before and the log shows what `on` would do (section 6). `CV_SCREEN=off` switches the stage off completely.

## 2. The rule the stage follows

The recruiters' own policy, kept as it was written: approve on relevant experience at a suitable level, progression or stability; reject on no relevant experience, clearly under-qualified, grossly over-qualified for an entry role, an empty or out-of-date history, an unrelated industry; err on the side of approving when in doubt, except for a clear mismatch; salary, location and driving licence never count; the recruiter makes the final call.

Your instruction on top of it (2026-09-30): **Jev must make the pass or reject decision itself for at least 99 percent of candidates**; the second model is for very rare cases only. That is why this stage is **forced choice**: it never says "review". Every CV it can read and turn into a job list gets pass or reject from one operating point, and a decision taken in real doubt says so. (The 99 percent is measured over those CVs, as you specified; the CVs that cannot be read, or from which no jobs can be listed, pass through and are counted separately, section 9.)

## 3. How a decision is made, step by step

1. **Read.** The CV file (PDF, Word, RTF or text) is turned into text. If that is impossible (a scanned image, an unsupported old Word file, an empty file, fewer than 120 characters) or no work history can be found in the text, the CV is **unreadable**: it goes to Zoho on the strength of the snippet decision and is never rejected.
2. **Remove personal data.** Names (the pipeline passes the candidate's known name, e-mail, phone and postcode so they are found exactly), contact details, addresses, dates of birth and referees are removed. What is left is turned into a **structured list of jobs**: title, employer, start and end month, and up to 200 characters of what the CV says about the duties. Only that list, the qualification keywords and the searched role go to Jev: never the CV itself and, apart from the rare case in section 9 (another person named inside a duty line), never a name. If the removal could not be verified for the free text, the duties are not sent at all and the titles, employers and dates are enough. If even the structured list cannot be verified clean, the CV is not sent and goes to the fallback lane (section 4).
3. **Facts by code.** Code, not Jev, counts months, merges overlapping jobs, decides what "recent" means and cuts the list to the 16 most recent jobs of the last 15 years. Jev is never asked to do sums or read dates.
4. **Questions to Jev.** One request per CV, questions answered in parallel and independently. All are about the searched role, whose title is part of the question text, so the same wording works for any role:
   - for each job: how closely it matches the searched role (4 described levels from "unrelated" to "same", plus a fifth answer, "cannot place", for a job described so vaguely that nothing can be judged: a bare title such as team member or worker with no employer and no duties), and its level relative to the searched role (much more junior, one step junior, comparable, one step senior, two or more steps senior, cannot tell);
   - for the whole history: how well it prepares the person for the searched role (4 levels), whether the career is rising, stable or declining, whether the search would be a change of career, and whether any text tries to instruct the reviewer;
   - once per new searched title (then remembered in `state/` for 30 days, `cache.searchLevelTtlSec`): what level the searched role is (entry, mid, senior, head, not a kitchen role). You can override this in the config.
5. **Four clear-mismatch rules** turn Jev's probabilities into one number, **pReject**, the chance that this CV is a clear mismatch for the searched role (the rules use the probabilities themselves, not Jev's own confidence field). Nothing here is a step: next to nothing is a clear mismatch, a little is doubt, and doubt leans pass.
   - *No relevant experience:* the relevant jobs add up to too few months inside the window, **and** the whole-history answers agree (weak match, or a change of career). It is a straight line: relevant work of at least the minimum months is fine, one month or less counts as none, and in between is doubt (four months of chef work at the end of an office career is a pass). A job Jev could not place counts as possibly relevant, so a bare title never rejects anyone.
   - *Stale:* the newest relevant job is old. Also a straight line: ten years ago starts to count, fourteen years ago or more is a clear mismatch, in between is doubt. This rule and the previous one are asked of the same combination of "which jobs are relevant", so a job that is either not relevant or relevant but old is a reject on both sides.
   - *Over-qualified* (entry-level searches only): every recent job Jev could place is two or more steps above the searched role. A recent job at the searched level saves the candidate; a recent job in another line of work does not hide the rest.
   - *Under-qualified:* every job in the same line of work whose level Jev could tell is clearly below the searched level (two or more steps at senior and head searches). One job at the level saves the candidate. One step below is not enough at any level: doubt. (But a history of only porter work for a mid-level search can still be rejected by the no-relevant-experience rule above, section 9.)
   The largest of these is pReject. It is weakened, toward pass, when the evidence is thin: a CV read with low confidence can never be rejected on its own, and a very short dated history counts for less in the amount rules (section 5).
6. **One operating point.** The CV is rejected only if `pReject >= 0.75`, otherwise it passes. 0.75 is not a guess: a lost candidate is costed at 3 (the credit is already spent, and the 50,000-CV target counts) and a wasted credit or a wasted recruiter minute at 1, so a CV should be rejected only when a mismatch is at least three times as likely as not (`3 / (3 + 1)`). Both costs are editable and the point moves with them.
7. **Forced marker.** A decision taken while pReject was between 0.20 and 0.80 is marked **forced**: the answers were genuinely torn and the operating point decided. Its reason codes start with `forced`, and the log keeps its confidence (the probability that the side chosen is right). These are the decisions to audit each week.

The whole path is deterministic apart from Jev's own answers: the same answers and the same config always give the same decision, and the answers of the last 7 days are kept (numbers only) so a change of numbers is re-run for free.

## 4. Who decides: four lanes

| Lane | What it is | Counted as |
|---|---|---|
| `jev` | Jev's answers plus the facts, forced choice, always pass or reject | **Jev-decided** (target 99 percent or more) |
| `facts` | A CV read with high confidence that lists no work history at all: nothing to ask Jev, an empty profile is rejected by code | not fallback; none at all in the real-CV run |
| `fallback` | The very rare CV Jev could not settle: its answers were unusable after two tries, or the gateway refused the request as malformed (HTTP 400, 404 or 422, asked once, never again), or both injection filters fired, or the personal data could not be verified clean. Decision `review`. The second model is not part of this build, so `fallback.policy` settles it (default approve: it goes to a recruiter). An injection attempt can never turn a Jev reject into an approval (`fallback.keepJevReject`) | **fallback share** (target 1 percent or less) |
| `unreadable` | The text could not be read, or no work history could be found in it | not counted against Jev; always passes |

If Jev cannot be reached at all (no network, key refused (401, 403), out of credit (402), rate limit (429) or server error (5xx) that outlasts the retries, timeouts, or answers unusable or requests refused for three CVs in a row) nothing is decided: the stage stops and **loses nothing** (section 7). One unusable answer or one refused request is a fault of one CV, not an outage: that CV takes the fallback lane.

## 5. The numbers, and how to change them

Everything below is in `config/cv-screening.json`. Nothing that decides pass or reject names a job title. Two things are fixed in the code because the gate reads them: the set of levels (entry, mid, senior, head, not a kitchen role) and the names of the six seniority answers; which title belongs to which level is worked out by Jev, taught only by the wording in `questions.ladder`. The CV reader, a separate tested module that only finds the jobs in a CV, carries a general list of about 350 occupation and employer words to tell a title from an employer; it never decides anything, but a title made only of words it does not know can be read as an employer or missed. If the reader misses the one relevant job and finds only irrelevant ones, the CV can be rejected wrongly; the reader's own confidence weakens the evidence (section 3), and partly read CVs are rejected twice as often as well read ones (section 8.2). A key the code does not know is ignored with a warning, a value of the wrong type or range falls back to its default with a warning, and a broken file means the built-in copy; screening never fails because someone edited a number. Keys starting with an underscore are notes. Change one thing at a time and look at the shadow log before the next.

**The operating point (the one bias):**

| Setting | Default | Meaning |
|---|---|---|
| `operatingPoint.costWasted` | 1 | What letting a mismatched CV through costs |
| `operatingPoint.costLost` | 3 | What rejecting a good CV costs |
| `operatingPoint.rejectAbove` | 0.75 | Reject when pReject reaches this. `null` = worked out as costLost / (costLost + costWasted) |
| `forced.low`, `forced.high` | 0.20, 0.80 | The doubt band that gets the `forced` marker |

**How thin evidence is weighed toward pass (`evidence`):** `parseFloor` 0.3 and `parseFull` 0.5 (a CV whose reader confidence is at or below the first can never be rejected, at or above the second it counts fully); `thinFloorMonths` 3 and `thinFullMonths` 9 (the same for the amount rules, by total months of dated work); `undatedCreditMonths` 12 (a relevant job without dates counts as this many months); `noneAtMonths` 1 (relevant months at or below this count as none, the no-relevant-experience rule is a straight line from there up to the level's minimum); `unclearRelevantP` 0.5 (a job Jev could not place counts as relevant with this probability); `minReadableChars` 120; `emptyProfileMinParse` 0.8.

**Alerts, caches and the shadow stop:**

| Setting | Default | Meaning |
|---|---|---|
| `alerts.rejectRateCeiling`, `alerts.rejectRateMinCandidates` | 0.10, 10 | `cv-reject-rate-high` when more than this share of a queue of at least that many CVs is rejected (in shadow mode: would be rejected). Real CVs show 2 to 4 percent |
| `alerts.forcedRateCeiling` | 0.35 | `cv-forced-rate-high` (queues of at least 10 CVs). Normal is about 6 percent |
| `alerts.unreadableRateCeiling` | 0.30 | `cv-unreadable-rate-high` (queues of at least 10 CVs). Normal is 5 to 8 percent |
| `alerts.fallbackRateCeiling`, `alerts.fallbackMinCandidates` | 0.05, 20 | `cv-fallback-rate-high` when more than this share of at least that many CVs was not decided by Jev |
| `cache.answersTtlSec` | 604800 (7 days) | How long Jev's numeric answers for one CV are reused, so a re-run or a change of numbers costs no request |
| `cache.searchLevelTtlSec` | 2592000 (30 days) | How long the level Jev gave to a searched title is remembered; after that it is asked again (0 = every time) |
| `phase2.shadowStopAfterFailures` | 5 | In shadow mode: CVs in a row that could not be screened before the rest of the queue is skipped (section 6) |

**The recruiters' criteria per searched-role level (`levels`)**, as shipped:

| Level | Relevant means | Months needed | Window (years) | Stale from / fully (years ago) | Over-qualified rejects | Under-qualified rejects (too junior) |
|---|---|---|---|---|---|---|
| entry | same industry or closer | 3 | 15 | 10 / 14 | yes: two or more steps senior, in the last 3 years | no |
| mid | close or same | 6 | 12 | 10 / 14 | no | only two or more steps below (rare: nothing is two steps below a mid role in a kitchen) |
| senior | close or same | 12 | 10 | 10 / 14 | no | yes: two or more steps below |
| head | close or same | 12 | 10 | 10 / 14 | no | yes: two or more steps below |
| not_a_kitchen_role | close or same | 3 | 15 | 10 / 14 | no | no |
| unknown (level not clear) | close or same | 3 | 15 | 10 / 14 | no | no |

Each level also has `rejects` switches (`noRelevantExperience`, `careerChange`, `stale`, `overQualified`, `underQualified`); a rule that is switched off simply never contributes. Other settings: `input.maxRoles` 16 (jobs sent to Jev, at most 20), `thresholds.unclearLevel` 4 (which relevance answer means "cannot place"; 0 = none).

**Worked examples of edits:**
- Reject less overall: raise `operatingPoint.costLost` to 5 (point 0.83) or set `rejectAbove` to 0.85. Reject more: lower it. Section 8.3 shows what each does.
- Reject a mid-level search for being one step junior (a kitchen assistant for a chef de partie or cook, the reviewer prompt's own example): set `levels.mid.seniority.tooJunior` to `["much_more_junior", "one_step_junior"]`. On the 607 real CVs this changes 2 decisions; the owner's rule of "doubt leans pass, reject only obvious gaps of two levels" is why it is not the default.
- Make the amount rules strict again (steps instead of straight lines): `evidence.noneAtMonths` 1000 and `levels.<level>.staleFullYears` 0. On the 607 real CVs this changes 9 decisions, all towards reject.
- Ask for more experience for a senior search: `levels.senior.minRelevantMonths` 24.
- Stop rejecting stale histories for head chef searches: `levels.head.rejects.stale` false.
- Jev splits a title such as Banqueting Chef three ways: pin it, `"searchLevelOverrides": {"banqueting chef": "mid"}`.
- Injection wording to catch: add a pattern to `injection.patterns` (regular expressions without backslashes). A CV goes to the fallback lane only when a pattern **and** Jev's own injection answer (`injection.probability` 0.5) both fire.
- Fallback policy for a CV Jev could not settle: `fallback.policy` `approve` (default) or `reject`. An unreadable CV always passes whatever this says.
- The question wording is in the same file (`questions.*`). Changing it changes Jev's answers, so change `questions.version` too and re-check the shadow log; the option names inside the questions must stay, and the relevance question must keep its last answer ("cannot place") where `thresholds.unclearLevel` points.

## 6. The switches

| Setting | Values | Meaning |
|---|---|---|
| `CV_SCREEN` (profile `.env`) | `shadow` (default, also when unset), `on`, `off` | `shadow`: every CV is screened and logged, **nothing is ever blocked**, an outage is only a warning. `on`: the decision is applied. `off`: a strict no-op, nothing runs and Phase 2 is exactly as before the stage existed. Anything else is `shadow` with a warning (a typo can never switch blocking on) |
| `CV_SCREEN_CONFIG_FILE` | a path | Use another criteria file |
| `CV_SCREEN_CONCURRENCY` | 1 to 8 (default 4) | Reviewer processes at once (one per CV) |
| `CV_FALLBACK_POLICY` | `approve` or `reject` | Overrides `fallback.policy` |
| `CV_REJECT_ABOVE` | 0 to 1 | Overrides `operatingPoint.rejectAbove` |
| `AI_GATEWAY_API_KEY`, `SCREEN_GATEWAY_ORIGIN`, `SCREEN_JEV_MODEL`, `SCREEN_JEV_TIMEOUT_MS`, `SCREEN_MAX_ATTEMPTS` | as for snippet screening | The same key, gateway and retry behaviour; the model is always Jev |

**Roll-out:** the stage is in shadow from the first Phase 2 run after the release, with nothing to set. Let a few hundred CVs go through, read the report (section 7), audit the rejects and the forced decisions with a recruiter panel, and switch to `on` only when the acceptance of section 10 is met. To stop: `CV_SCREEN=off` (nothing else to undo; already-rejected candidates stay rejected for their job title).

What `shadow` does to a run, precisely: after the download every candidate that has a CV file is screened (at most `CV_SCREEN_CONCURRENCY` at a time, one reviewer process per CV) and one aggregate row per CV goes to the shadow log. Every candidate is pushed to Zoho exactly as without the stage, whatever the decision; the results file gets a `cvScreen` block with the counts (`cvRejected` is always 0 in shadow, `cvScreen.reject` is what `on` would have rejected). Jev being unavailable never holds anything: the CV is simply not screened and the run prints one warning. Two guards keep a hung or failing gateway from slowing Phase 2 down. After `phase2.shadowStopAfterFailures` (5) CVs in a row that could not be screened (the reviewer failed, timed out or found Jev unavailable; a CV that needed no request, such as an unreadable file, neither counts nor resets the count) the rest of that queue is skipped and the reviewers still running are stopped, with one warning alert (`cv-shadow-stopped`); with a hung gateway that takes as many rounds of the 90 second Jev deadline as 5 divided by the number of reviewers at once (two rounds, about 3 minutes, with the default 4), instead of the 10 or more minutes that a queue of 40 CVs would otherwise take. And when the screening halt is already up (the supervisor found Jev unavailable) the stage is skipped for that queue with one line in the run output. Neither guard ever blocks a candidate or raises the halt; both apply to shadow only. In `on` mode the first outage holds the queue.

What `on` does to a run, precisely: the candidate is screened after the download and before the Zoho push. A pass, an unreadable CV and a fallback-approve go on as today. A reject is not pushed, its `cv-<id>` file and `candidate-<id>.json` are deleted (the retention rule), a row is written to `candidate_rejections` for **this job title** with the reason text `cv:<reason codes>`, and the results file counts it as `cv_rejected`. Note what this does not do: the person stays marked as unlocked in `candidates.db`, and the pipeline's own search filter skips every unlocked person for every role ("we already hold their CV"), so a rejected person is not offered again for another role either, and their CV is gone. That is how every rejection after an unlock has always behaved; making a rejected person findable for other roles would be a change to that filter (or to the unlocked flag), which this stage does not make. A re-run never downloads or decides again what was decided (idempotent). If Jev is unreachable the queue is **held**: nothing further is pushed or rejected, every CV and queue entry is kept, the same screening halt is raised as for snippet screening (same reason strings, so supervision and this stage share one state), a critical alert goes out, and the queue is retried once screening works. The stage never approves anything because Jev was down.

## 7. Reading the log and the alerts

**Weekly report:** `node scripts/cv-report.js --days 7 --forced`. It prints, from the shadow log only (no CV text is in it):
- WHO DECIDED: the Jev-decided share (flagged if it is under 99 percent), the fallback share (flagged if it is over 1 percent), code-only decisions, the unreadable pass-through split into "could not be read" and "read, but no work history found", and the Jev-decided share of ALL screened CVs (the honest figure if the second kind is counted);
- the reject rate and the forced share, the reason codes, and the reject rate by searched role;
- **what another operating point would have done to the same CVs** (every row keeps its pReject);
- with `--forced`, every forced decision, lowest confidence first: date, candidate id, searched role, decision, confidence, reason codes. `--mode shadow` or `--mode on` separates the two phases, `--json` gives the same numbers as one JSON object.

**The shadow log** is `shadow/cv-YYYY-MM-DD.jsonl` (London date), one line per screened CV, kept 180 days, files private. A line holds numbers and codes only: searched role, level of the searched role and its probability, decision, final action, lane, forced, confidence, pReject, the operating point used, reason codes, counts of roles and months, Jev's numeric answers and the month numbers of the jobs (so the decision can be re-run offline), the model that answered, and the platform's candidate id (a pseudonymous number: treat the file like `candidates.db`). It never holds a CV, redacted text, a job title, an employer, a duty, a name or a contact detail.

**Reading the reason codes:**

| Code | Meaning |
|---|---|
| `pass_relevant_history` | Nothing pointed at a mismatch |
| `forced` | Decided in real doubt; audit this one |
| `pass_doubt` | A pass, but a rule was partly met (or would have been, for a badly read CV); the operating point leaned pass |
| `no_relevant_experience`, `career_change` | Next to no relevant work in the window, and the whole history agrees; `career_change` when the change-of-career answer agreed |
| `stale_experience` | The newest relevant work is old (ten years starts to count, fourteen is a clear mismatch) |
| `over_qualified` | Every recent job Jev could place is two or more steps above an entry-level search |
| `under_qualified` | Every same-field job whose level Jev could tell is two or more levels below the search |
| `vague_roles` | A job was described too vaguely to judge (a bare title), so it counted as possibly relevant |
| `no_roles` | Read well, but lists no work history |
| `thin_evidence`, `parse_low_confidence` | The evidence was weighed down toward pass |
| `injection_signal` | One injection filter fired; Jev still decided |
| `injection_flag` | Both filters fired: fallback lane |
| `answers_invalid`, `redaction_unverified` | Fallback lane causes |
| `policy_fallback_approve`, `policy_fallback_reject`, `policy_kept_reject` | What the fallback policy did |
| `unreadable_<why>` | Not read: `too_little_text`, `no_work_history`, or the reader's own reason (scanned, unsupported, empty) |

**Alerts** (in the alert feed, one per queue at most for each key; they are raised in shadow mode too, where the reject alert says "would have rejected"): `cv-reject-rate-high` (more than 10 percent of at least 10 CVs rejected: real CVs show 2 to 4 percent, so this is a gate that is too strict, or a broken reader); `cv-fallback-rate-high` (more than 5 percent of at least 20 CVs not decided by Jev; the 99 percent rule needs the weekly report, this is the early warning); `cv-forced-rate-high` (more than 35 percent decided in doubt; normal is about 6 percent); `cv-unreadable-rate-high` (more than 30 percent unreadable; normal is 5 to 8 percent, a broken PDF reader gives more than half); `cv-screening-unavailable` (critical, mode `on` only: the queue is held); `cv-shadow-stopped` (mode `shadow` only: 5 CVs in a row could not be screened, so the rest of that queue was skipped; nothing was blocked); `cv-reject-not-recorded` (a rejection could not be written; the files were kept and the decision repeats); `cv-review-errors` (the reviewer process itself failed on some CVs; they passed through). A rate is "above" its ceiling, never "at" it. The ceilings are in `alerts.*` (section 5).

**The weekly review (15 minutes):** run the report. Check the two shares. Read the forced list, look up each candidate id, and ask whether you would have decided the same; if a pattern of forced decisions is wrong, that is the number to change (section 5). Look at the reject rate by searched role for a role that stands out. Change one number, wait for the next week's numbers.

## 8. What was measured, and what it proves

Everything here was measured on 2026-09-30 with the shipped numbers (the `cv2` question wording). Live requests to Jev used by the whole work: 3,422 of the 4,000 allowed (about 17 US cents): 3,205 for the build and calibration and 217 for the independent review (72 new probes written after the design was fixed, some scored twice, plus the tests of odd characters). "Before" means the first version of this stage (straight-line rules were steps, no "cannot place" answer, one step below rejected at mid level); "after" is what ships. The full log of live runs is kept with the lab that built the stage (`cv-lab/runs.md`, not part of this repository).

**What each data set is, and how far to trust it.**

| Set | What | How clean |
|---|---|---|
| Probes 1 | 130 invented CVs (109 with a firm expected answer) written from the recruiters' policy alone before any design existed | The first design was tuned looking at all of it: not out of sample |
| Probes 2 | 96 invented CVs (77 firm) in the style of the real corpus (untitled jobs, prose duties, bare titles, year-only dates), written after the first real-CV diagnosis | Its **before** score is a fair out-of-sample number; its after score is after fixing what it showed |
| Probes 3 | 59 invented CVs (46 firm), written after all tuning, expected answers fixed before scoring | Clean, but small and easy (Jev is nearly certain on invented CVs) |
| Real corpus | 607 redacted, structured CVs of candidates the old process pushed to Zoho (final build; 309 TRAIN and 298 TEST by a hash of the id) | TRAIN was used to calibrate; TEST was scored once with the final numbers (the old numbers were scored on it too, for the comparison; the last two rounds of gate changes moved no decision on it). No labelled rejects exist |
| Real files | 250 CV files not in the corpus, run through the whole path (read, redact, parse, Jev, gate) with the first version | One look only: the raw files were removed from the machine right afterwards, so it could not be repeated for the final numbers |

**8.1 The probes (232 firm cases in three sets).**

| | Probes 1 (109) | Probes 2 (77) | Probes 3 (46) | all 232 |
|---|---|---|---|---|
| Before: decided as expected | 109 | 68 (88.3%, interval 79 to 94) | 46 | 223 (96.1%) |
| After: decided as expected | 109 (100%, 96.6 to 100) | 77 (100%, 95.2 to 100) | 46 (100%, 92.3 to 100) | 232 (100%, 98.4 to 100) |
| Lost candidates before / after | 0 / 0 | 9 / 0 | 0 / 0 | 9 / 0 |
| Wasted credits before / after | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Unsafe approvals (clear mismatch let through) | 0 | 0 | 0 | 0 |
| Jev-decided share, injection probes excluded | 99.1% (114 of 115) | 100% (90 of 90) | 100% (56 of 56) | |
| Forced decisions (firm ones right) | 5 (1 of 1) | 16 (6 of 6) | 3 (0 firm) | |
| "Either" cases (policy silent) passed, before / after | 19 of 21 / 21 of 21 | 3 of 19 / 11 of 19 | 6 of 13 / 7 of 13 | |

The 9 lost candidates of the first version on Probes 2 were: two CVs with one bare title and nothing else (missing information rejected), a bare vague job beside five years of kitchen assistant work, three short recent chef stints of three, three and five months after an unrelated career, a demi chef de partie for a chef de partie search, and two long histories in which the relevant jobs sat behind more than ten short recent ones (only the ten newest jobs were sent). Each was fixed by a general change (sections 3 and 5), not by looking at a title. The 5 fallback decisions of Probes 1 and 6 of Probes 2 to 3 are the injection probes, where the fallback lane is the correct result.

Repeating all 130 probes of Probes 1 live with the answer cache off gave the same decision for every one (0 flips) and moved the probability by 0.004 on average (largest move 0.17).

**8.2 The real corpus (607 CVs).**

| | TRAIN 309 | TEST 298 | all 607 |
|---|---|---|---|
| Jev-decided | 292 of 292 (100%) | 281 of 281 (100%) | 573 of 573 (**100%**) |
| Fallback lane | 0 | 0 | **0** |
| Unreadable pass-through (no work history could be found in the text) | 17 (5.5%) | 17 (5.7%) | 34 (5.6%) |
| Rejected, before | 16 (5.2%) | 10 (3.4%) | 26 (4.3%) |
| **Rejected, after** | **8 (2.6%)** | **6 (2.0%)** | **14 (2.3%)** |
| Decided in real doubt (forced) | 21 (6.8%) | 18 (6.0%) | 39 (6.4%): 39 passes, 0 rejects |
| Lost candidates, wasted credits | not measurable: the corpus holds no candidate the old process rejected and no expected answers | | |

The 12 CVs that were rejected before and pass now are all real doubt cases: a chef stint of three or four months after an office career, a bare "Team Worker" role, a 2-month kitchen job, a head chef whose last job ended eleven years ago, hospitality staff who did a little cooking. The reject rate is an upper bound on lost candidates (every corpus CV was pushed by the old process). I read all 14 rejects (titles and years only): 10 are clear mismatches (retail, care, cleaning, management outside catering, a kitchen job 22 years ago, head chefs for a commis shift), 2 are front-of-house-only histories for a chef or cook search (defensible under the recruiters' policy), and 2 are debatable (a front and back of house hospitality worker, a front-of-house coordinator with several untitled jobs). That is **2 to 4 of 607 CVs (0.3 to 0.7 percent) at risk of being a lost candidate**. I am an AI reader, not a recruiter panel: treat this as a screen, not a measurement.

The other side of the bias: of the 39 forced passes, I judge about 6 to be mismatches a recruiter would have rejected (a sales career with a chef job 14 years ago, a teacher, assistant managers who last worked 19 years ago). If Jev's numbers were calibrated, about 17 of the 39 forced decisions are wrong, almost all of them mismatches let through (a wasted credit, which is what the 1:3 bias chooses), under one a good CV rejected. Jev is documented as overconfident on some question types, so treat that as a floor.

Reject rate by how well the CV was read: well read 2.0% (7 of 347), partly read 4.5% (7 of 155), badly read 0% (0 of 105). A badly read CV cannot be rejected at all; 5 of them would have been (a driver for a cook search, a 1991 job for a catering assistant search) and are passed with the reason codes `pass_doubt` and `parse_low_confidence`, so the weekly report can count them. The partly read rejects are genuine mismatches (retail, childminder, managers, care), not parse noise: I checked every one. By outcome group: 13 of 515 CVs pushed by the old process rejected (2.5%), 1 of 14 not in the database, 0 of 50 pushed after a rejection for another role, 0 of 28 never unlocked.

Real CV files, first version, 250 files not in the corpus, natural role mix: **Jev decided 237 of 237 (100%)**, fallback 0, 5.2% unreadable (9 no work history found, 2 scanned, 2 old binary Word), 16 rejected (6.4%), 17 forced. The whole path (read, redact with the candidate's known details, parse, Jev, gate) took a median 0.36 seconds per CV. Real files ended in the same place as the redacted corpus, so the reader, the redaction check and the parser are not a source of fallbacks.

**8.3 What the bias costs: the operating-point sweep.** Firm probe cases counted over all three sets (232), real CVs rejected (TRAIN and TEST):

| Point | Lost candidates | Wasted credits (unsafe) | Cost at 1:3 | Real CVs rejected, TRAIN 309 / TEST 298 |
|---|---|---|---|---|
| 0.05 | 10 | 0 | 30 | 41 (13.3%) / 42 (14.1%) |
| 0.15 | 7 | 0 | 21 | 30 (9.7%) / 30 (10.1%) |
| 0.30 | 6 | 0 | 18 | 26 (8.4%) / 18 (6.0%) |
| 0.50 | 1 | 0 | 3 | 15 (4.9%) / 10 (3.4%) |
| 0.60 | 0 | 0 | 0 | 14 (4.5%) / 8 (2.7%) |
| 0.70 | 0 | 0 | 0 | 12 (3.9%) / 6 (2.0%) |
| **0.75 (shipped)** | **0** | **0** | **0** | **8 (2.6%) / 6 (2.0%)** |
| 0.80 | 0 | 0 | 0 | 8 (2.6%) / 6 (2.0%) |
| 0.85 | 0 | 3 (1) | 3 | 7 (2.3%) / 5 (1.7%) |
| 0.90 | 0 | 6 (1) | 6 | 6 (1.9%) / 4 (1.3%) |
| 0.95 | 0 | 20 (12) | 20 | 4 (1.3%) / 3 (1.0%) |

On the probes the cost is zero from 0.60 to 0.80; below 0.50 candidates are lost, above 0.85 mismatches get through and at 0.95 clear ones do. The shipped 0.75 sits in the middle of that plateau and is also the value the 1:3 costs work out to. On real CVs the point is a real lever (about 12 points of reject rate between 0.05 and 0.95): 490 of the 573 real CVs Jev decided have pReject below 0.05 and 10 above 0.90, so 87 percent of decisions do not depend on the point at all and the rest is a band of about 70 CVs in which the point chooses.

**8.4 Other checks.**
- *Missing information.* Forty real CVs that pass with certainty had information taken out the way a poor parse would: all titles, or all duties and employers, or everything but the dates. Rejected: 1 of 40 with the titles removed (nothing else left to read), 0 of 40 with titles only, 1 of 40 with employers and dates only. A history reduced to the newest job alone rejects 6 of 40, which is Jev correctly reading a non-kitchen newest job (losing the older jobs is a parse failure the stage cannot see).
- *The level rules on real histories.* Sixty real CVs were asked again as head chef, sous chef and kitchen porter searches (167 questions). Against a title-tier reading written for the check (not shipped): where the tier reading said pass the stage passed 102 of 103; where it said reject the stage rejected 41 of 64, and of the 23 it passed, 14 were forced passes (doubt) and most of the rest are titles the reading itself mis-tiers (a plain "Chef", "Kitchen Porter to Sous chef"). Head chef searches with only chef de partie history are the weak spot: Jev splits between "two levels below" and "one level below", so about half pass as doubt.
- *The searched role's level.* 53 titles were put to Jev one by one: spellings of one title agree (Chef de Partie, chef-de-partie, CDP give mid at 0.88 to 1.0; Sous Chef and Sous-Chef give senior at 1.0), neighbours sit on the right rung (junior sous chef, second chef senior; chef manager, catering manager, kitchen manager head; trainee chef, commis, kitchen hand entry) and the honestly ambiguous ones come out as mixtures that the gate treats as mixtures (banqueting chef 41 percent mid, 40 head, 17 senior; food production 52 percent unclear; demi chef de partie 68 mid, 32 senior; waiter 60 not a kitchen role, 32 mid).

## 9. Limits and known gaps

- **No labelled real rejects.** The precision of the rejects rests on the probes and on my reading of the 14 real rejects (8.2). Add real recruiter verdicts as soon as `shadow` has run; the log keeps everything needed to re-score. Until then the forced decisions are the audit list.
- **Automated rejection.** With `on`, a rejected candidate is never seen by a recruiter. Whether that is acceptable under the UK rules on automated decisions and equality law is for you and your adviser to decide; this stage does not decide it. The shadow phase and the weekly audit exist so a person keeps looking.
- **The criteria numbers are the recruiters' rules turned into numbers, not fitted to Chefs Bay outcomes.** "Obviously out of date" is read as: doubt from ten years, a clear mismatch from fourteen; "no relevant experience" as: one month or less. Both are your call and both are one number.
- **About 5 to 8 percent of CVs are never screened.** By your rule a CV whose text cannot be read passes through and does not count against Jev. Two things land there: files the reader cannot open (4.5 percent of the 22,644 CV files on disk: 2.6 percent old binary Word files, 1.5 percent scanned images, 0.4 percent other) and readable CVs in which the parser finds no jobs (3.4 percent of the readable files, 3.6 percent of 250 random real files, 5.6 percent of the corpus, which was built to be rich in hard cases): CVs without dates, some two-column layouts and a few prose CVs. If they are counted in the denominator Jev decides about 92 to 95 percent of all candidates, not 100. They are the biggest hole in the stage, and each such CV passes exactly as it does today. Better reading of those layouts (and of old Word files) is the most useful next improvement.
- **Only the 16 most recent jobs of the last 15 years are judged.** Beyond that the older jobs are cut: a relevant history behind more than 16 short recent jobs is cut off and misjudged (invented histories of 13 and of 30 to 40 jobs were decided as expected).
- **Dates given only as years** are read as January to December, which makes short jobs look longer, so it leans toward pass.
- **The level rules are the weakest rules.** Jev's answer to "how many levels below the searched role" is torn for a chef de partie searched as head chef (two levels below is a reject, one level below is doubt), so about half of such CVs pass as forced doubt. Real CVs meet these rules rarely (3 of 607 were caught). A code-owned ladder (Jev names each job's level once and code does the difference) would be steadier; it was not tried because it changes every question and needs a new full re-run.
- **Front of house for a kitchen search.** A history that is only waiting, bar or reception is rejected for a chef, cook or chef de partie search (2 of the 14 real rejects) and passes for entry kitchen roles. That is the recruiters' reading of "no relevant experience"; if you disagree, set `levels.mid.relevantMinLevel` to 1 (work in the same industry then counts as relevant), or switch `levels.mid.rejects.noRelevantExperience` off.
- **Only porter or kitchen assistant work, for a chef, cook or chef de partie search.** One level below is meant to be doubt (pass), and it is for a commis or a trainee. But a history of only pot washing and kitchen support is judged by Jev as "adjacent" work, not "close", and at mid level adjacent work does not count as relevant, so the no-relevant-experience rule rejects it when Jev is sure: of 6 such histories written for the independent review, the 2 that were porter work only (pot washing, deliveries) were rejected, and the other 4 (kitchen assistant, or duties that mention helping with preparation) passed as forced doubt. The recruiters' older prompt would reject these too (a kitchen assistant for a chef de partie is its own example of a reject); your newest rule (doubt leans pass, reject only a gap of two or more levels) would pass them. Setting `levels.mid.relevantMinLevel` to 1 passes them, but it also passes waiting and bar histories, and 6 of the 232 firm probes (5 of the 109 written from the recruiters' policy alone) would then be wrongly passed; 4 of the 14 real rejects would flip too. Decide which reading you want before switching `on`; it is one number.
- **Unusual titles.** A title Jev cannot place on one level (Banqueting Chef) is a mixture of levels and produces forced decisions; pin it in `searchLevelOverrides`.
- **Jev is early access.** Its probabilities are not guaranteed calibrated and its behaviour can change with a new model version (the version is logged with every row). Repeating 130 probes live gave the same decision every time, but that says nothing about a new version. Jev does not treat text as hostile: the two-filter rule and the recruiter's final call are the protection. When both filters flag a CV it can never turn a reject into a pass; an attempt that only one of them catches is decided by Jev like any other CV.
- **A request the gateway refuses is a fault of one CV, until it is a run of them.** An HTTP 400, 404 or 422 answer (our request is wrong: the transport calls it a request error) is asked once and never again, and that one CV takes the fallback lane (reason code `answers_invalid`, the refusal status is kept as a number in the log row; the gateway's own text is never logged), settled by `fallback.policy` (approve by default). One CV with an odd character in a job title therefore no longer holds a whole queue: one real cause was found in the review (a broken character, which the gateway refuses as invalid Unicode) and is now cleaned before sending, and a cause nobody has met yet costs one CV a trip to a recruiter. A systemic refusal (a wrong route, a changed model name) shows as the same fault for every CV, so three CVs in a row (`jev.invalidStreakMax`, counted together with unusable answers, reset by any CV that gets a real answer, forgotten after 30 minutes) are escalated to an outage: mode `on` holds the queue and raises the halt, mode `shadow` warns and stops after 5. The trade-off: up to two CVs of such a run take the fallback lane before the guard fires (in mode `on` nothing is pushed then: the queue is held and retried once the halt clears, and a CV that was rejected before the hold stays rejected). 5xx, 429, timeouts, 401, 402, 403 and network errors are still an outage at the first CV.
- **No second model in this build.** The fallback lane is settled by policy. The 99 and 1 percent targets held in every real-CV measurement (810 of 810 decided by Jev, 0 fallbacks), but only the weekly report on live traffic can show it stays so.
- **English is best.** Other languages work less well; the invented French, Spanish and Italian probes were decided as expected, and 2 of the 38 real CVs tagged non-English were unreadable to the parser.
- **The probe sets are small and Jev is nearly certain on invented CVs**, so a 100 percent score there says the mechanics and the policy agree, not that the real error rate is zero. The real-CV evidence has no expected answers.
- **Privacy.** Structured, redacted job lists go to a US processor (TypeSafe through Vercel) whose retention is "as long as reasonably necessary"; this is the trade-off you accepted. Only the structured list leaves the machine, nothing about a CV is written to disk by this stage except numbers and codes, and the log holds no text. The candidate's own name, e-mail, phone number and postcode, addresses, dates of birth and the references section are removed (checked on 573 real records and on 120 test CVs carrying real candidates' details in many formats: no hit). What cannot be removed with certainty is the name of another person written inside a duty line. Two cases are handled: a name after a title such as Mr, and a capitalised name after a relation ("reported to", "managed by", "supervised by", "trained by", "led by", "mentored by", "worked under" and similar; words that are job titles or employers, such as "Head Chef" or "Compass Group", are left alone). Before that second rule was added, all 30 test CVs with "reported to Ottoline Farthing" sent the name to Jev; now none do. A name written in any other way ("Ottoline, my old boss, taught me sauces") is not caught. Each job's duty text (up to 200 characters, 140 on average) is sent as written, not reduced to keywords.
- **Throughput.** One reviewer process per CV, four at a time; reading, redacting, parsing and the gate took under a second per CV on real files, and Jev about a second. Phase 2 is not the bottleneck.

## 10. Operating it

For the owner: where you are on day one, how to read the report, what must be true before `CV_SCREEN=on`, and how to go back. Commands are run in the workspace (`resourcer/`) as `node scripts/...`.

**10.1 Where you are on day one.** The release runs the stage in `shadow`. There is nothing to switch on and nothing to set. After every download the CVs of that run are screened, every candidate goes to Zoho exactly as before, and one line per CV (numbers and codes, no text) is added to `shadow/cv-YYYY-MM-DD.jsonl`. Each run prints one summary line (`CV screening (shadow): screened N, pass ..., reject ...`) and its results file carries a `cvScreen` block. The cost is one or two Jev requests per CV; the answers are reused for 7 days. If you do nothing, nothing ever changes for a candidate.

**10.2 Reading the report.** `node scripts/cv-report.js --days 7 --forced` prints, from the log only (no CV text is in it), these blocks in this order:

| Block | What it says | What you want |
|---|---|---|
| WHO DECIDED, `Jev-decided` | How many CVs Jev decided, as a share of the CVs it received (the ones that needed a decision) | 99 percent or more. The line says `ok (99% or more)` or `BELOW the 99% the owner requires` |
| `fallback lane` | CVs Jev could not settle: unusable answers, a request the gateway refused, both injection filters, personal data not verified clean | 1 percent or less (`ok (1% or less)` or `ABOVE the 1% the owner allows`). If above, look at the reason codes further down: many `answers_invalid` is the gateway or the question wording, `injection_flag` is a hostile CV or a keyword pattern that is too wide, `redaction_unverified` is a redaction fault (report it) |
| `code only` | CVs read with high confidence that list no work history at all | A handful, or none |
| `unreadable`, and its split | CVs that pass through unscreened: `could not be read` (scanned, old Word, empty file) and `read but no work history found` | About 5 to 8 percent of all CVs together |
| `Jev-decided of ALL` | The honest share when the unreadable CVs are counted too | 92 to 95 percent is expected; this is not the target, the first line is |
| DECISIONS, `rejected` | In shadow mode: the CVs `on` WOULD reject | About 2 to 4 percent of all screened CVs |
| `forced` | Decisions taken in real doubt, where the operating point chose; nearly all are passes | About 6 percent. These are the ones to audit |
| SWITCH-ON CHECK | The numbers of 10.3 one per line, `[ok]` or `[NOT YET]`, then the two lines only people can do, and a verdict | `numbers OK: only the panel review is left` |
| REASON CODES | Why (section 7) | The `pass_relevant_history` code dominating |
| BY SEARCHED ROLE | Screened, rejected and forced per searched role | A role whose reject share is far above the others deserves a look |
| WHAT ANOTHER OPERATING POINT WOULD HAVE DONE | How many would be rejected at each operating point, on the same CVs; `*` marks the one in use | The step between neighbouring points is small; a jump means many CVs sit near the point |
| FORCED DECISIONS, LOWEST CONFIDENCE FIRST (with `--forced`) | One line per forced decision: date, candidate id, searched role, `approve` or `reject`, confidence, pReject, reason codes | The first 30 lines are what the panel reads |

Other options: `--rejects` lists every decision that rejects (in shadow: would reject), oldest first, with the forced marker; `--mode shadow` or `--mode on` counts only the rows of one mode (use `--mode shadow` for the acceptance); `--from YYYY-MM-DD` and `--days N` choose the period; `--json` gives the same numbers as one JSON object. The candidate id is the platform's pseudonymous number: look it up in Zoho or `candidates.db`; treat the log like the database.

**10.3 The acceptance for switching from shadow to on.** All of these, on shadow data (`node scripts/cv-report.js --days 14 --mode shadow --forced --rejects`, longer if fewer than 300 CVs came through):

1. At least 300 CVs screened, spread over several searched roles (the report line `enough CVs`).
2. Jev decided at least 99 percent of the CVs it received (`Jev-decided`).
3. The fallback lane at most 1 percent (`fallback lane`).
4. The unreadable share within expectation, about 5 to 8 percent of all CVs. More than 12 percent fails the check: the reader is failing on this traffic (a layout may have changed), so find out why before `on`. Above 30 percent the run alert `cv-unreadable-rate-high` fires.
5. The reject rate about 2 to 4 percent. Between 1 and 5 percent passes the check, but ask the panel to look harder at the edge; above 10 percent in one queue raises `cv-reject-rate-high`.
6. A recruiter panel (two or more recruiters) agrees, from the CV in Zoho, with **every** would-be reject of the period (`--rejects`) and with the 30 lowest-confidence forced decisions (the first 30 lines of `--forced`). In shadow every candidate is in Zoho with a CV, so the panel can open each one. A single reject the panel would not have made is a stop: read its reason codes, change one number (section 5), wait for a new period and repeat.
7. Your own decisions of section 9 are made: whether a person may be turned down automatically, whether porter-only histories may be rejected for a chef search, and that a rejected person is not offered again for another role.

Items 1 to 5 are the `SWITCH-ON CHECK` block of the report, which says `numbers OK: only the panel review is left` when all five pass. Items 6 and 7 are people: the report cannot check them and prints them as `[people]` lines.

**10.4 Switching on.** `hermes -p resourcer config set CV_SCREEN on`. No restart is needed: every Phase 2 run reads it. The same day, run `node scripts/cv-report.js --days 1 --mode on --rejects` and read the alert feed. From then on a rejected candidate is not pushed to Zoho, their CV and JSON are deleted, and the platform id and reason codes stay in the log and in `candidate_rejections` (origin `cv:...`). Keep the weekly review of section 7. In `on`, Jev being unavailable holds the queue with everything kept (`cv-screening-unavailable`, CRITICAL); it retries by itself once the screening halt clears, and only a key or credit problem needs you.

**10.5 Backing out.** `hermes -p resourcer config set CV_SCREEN off`. From the next Phase 2 run the stage is a strict no-op: no reviewer, no Jev request, no log row, no `cvScreen` block, and the pipeline behaves as it did before the stage existed. There is nothing else to undo. To stop rejecting but keep collecting evidence, set `shadow` instead of `off`. Candidates already rejected stay rejected for that job title (their rows are in `candidate_rejections`, origin starting `cv:`) and their CV files are gone; deleting a row alone does NOT make that person screenable again: the search filter skips every unlocked candidate whatever the job title (decision CVS-8), so a recovery also needs the candidate's unlocked flag reset, which is an owner decision, and a re-run of the same queue simply decides again. The runtime files (`state/cv-answers.jsonl`, `state/cv-search-levels.json`, `runtime/cv-invalid-streak.json`, `shadow/cv-*.jsonl`) can stay: nothing reads them once the stage is off.

**10.6 What the stage's alerts ask of you.**

| Alert | Meaning | What to do |
|---|---|---|
| `cv-shadow-stopped` | Shadow mode: 5 CVs in a row could not be screened (Jev hung or failing), the rest of that queue was not screened | Nothing was blocked or lost. Check `AI_GATEWAY_API_KEY`, the credits and the gateway status; the next queue tries again by itself. Report it if it repeats |
| `cv-screening-unavailable` | Mode `on`: Jev could not be reached, the queue is held | The halt text says why; auth or credits need you; it resumes by itself |
| `cv-reject-rate-high` | More than 10 percent of a queue (10 or more CVs) rejected, or would be | A gate that is too strict or a broken reader: `node scripts/cv-report.js`, then section 5. In `on` consider `shadow` while you look |
| `cv-fallback-rate-high`, `cv-forced-rate-high`, `cv-unreadable-rate-high` | The fallback, forced or unreadable share of a queue is above its ceiling | Read the report (10.2); the first two point at Jev or the wording, the last at the reader |
| `cv-review-errors`, `cv-reject-not-recorded` | The reviewer process failed on some CVs (they passed through); a rejection could not be written (files kept, decided again next run) | Report the text; `node scripts/preflight-db.js` for the second |
