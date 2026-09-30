# Parity: screening (work package "screening")

Legacy sources (read-only): `scripts/ai-review.js`, `scripts/caterer-ai-review.js`,
`scripts/lib/screening-health.js`, `scripts/ai-review-abtest.js`; callers `phase1-scrape.ps1`,
`reed-phase1.js`. New code: `resourcer/scripts/ai-review.js`, `caterer-ai-review.js`,
`lib/screening-health.js`, `lib/screening/*`, `config/screening.json`, `tools/screening-report.js`.
Tests: `tests/screening/*.test.js`, `tests/fake-gateway/*` (204 tests after the review-fix pass, 253 after the Jev-only build of 2026-09-30, section 6; see the end of this file).

## 1. Map: legacy file:line -> new file:function

| Legacy | New | Notes |
|---|---|---|
| ai-review.js:1-16 usage header | ai-review.js header, `helpText()` | new flags listed |
| ai-review.js:22-42 gateway URL, config path, model label | `lib/screening/config.js` (origin, models); `engine.js labelOf()` | label = engines that decided (D5); no config-file token |
| ai-review.js:44-54 timeouts, batch sizes, retries | `config.js DEFAULTS` (`llm.timeoutMs`, `retry.*`, `llm.maxAttempts`, `batch.*`) | see deviations 1, 8 |
| ai-review.js:56-59 exit codes 0/1/3 | `ai-review.js main()` return values | unchanged meaning |
| ai-review.js:65 `log()` | `main()` `lio.log` (stderr) | |
| ai-review.js:67-82 `parseArgs` | `ai-review.js parseArgs()` | same result for legacy inputs; `--k=v`, `-h`, values starting with `--` added |
| ai-review.js:84-90 `readToken` | `lib/screening/llm-client.js apiKey()` | key from `AI_GATEWAY_API_KEY` via `env.js` |
| ai-review.js:92-98 `cleanJsonText` | `llm-client.js parseJsonLoose()` | also extracts JSON from prose |
| ai-review.js:102-141 `callGateway` | `llm-client.js LlmClient.chat()`, `http.js request()` | chat completions with a strict json_schema |
| ai-review.js:146-161 retry | `http.js request()` | per call; hard errors (401/402/403) not retried |
| ai-review.js:166-169 `callScreeningModel` | `engine.js runLlm()` | primary model, retries, backup model |
| ai-review.js:176-191 `ROLE_TIERS`, `getRoleTier` | `lib/screening/tiers.js` | regexes verbatim; golden table test |
| ai-review.js:193-203 `buildOverqualNote` | `rubric.js buildOverqualNote()` | ASCII dash |
| ai-review.js:205-238 `buildBatchPrompt` | `rubric.js buildBatchPrompt()` / `buildRubricBody()` | byte-identical (legacy tail) for all tiers, test |
| ai-review.js:240-269 `buildSinglePrompt` | `rubric.js buildSinglePrompt()` | same rules block as batch (D2) |
| ai-review.js:271-317 mangled `--candidates` parsing | `ai-review.js parseMangledCandidates()`, `readCandidates()` | kept |
| ai-review.js:324-368 `runBatch` | `ai-review.js runBatch()`, `engine.js screenBatch()` | per-candidate calls, results index-aligned |
| ai-review.js:370-385 `runSingle` | `ai-review.js runSingle()`, `engine.js screenOne()` | |
| ai-review.js:387-447 `main` | `ai-review.js main()`, `run()` | error classes, not message regex |
| ai-review.js:449-450 exports | `ai-review.js module.exports` | `buildBatchPrompt`, `buildSinglePrompt` kept |
| caterer-ai-review.js:17 | `caterer-ai-review.js` | `require('./ai-review.js').run()` |
| lib/screening-health.js:29-43 `portOpen` | `screening-health.js tcpProbe()`, `portOpen()` | now probes the gateway origin |
| lib/screening-health.js:45-50 `gatewayToken` | removed | env key |
| lib/screening-health.js:55-99 `checkScreening` | `screening-health.js check()`, `checkScreening()` | new shape, legacy wrapper kept |
| ai-review-abtest.js:166-179 | not ported | A/B harness; `SCREEN_LLM_MODEL=<model>` does the same |
| phase1-scrape.ps1:741-742, reed-phase1.js:305-307 temp file | `--candidates-file -` (stdin) or `--consume-input`; in-process `createEngine()` | no snippet temp files (D7) |
| phase1-scrape.ps1:793-823 3-strike halt, 120 s pause | owner: phase1 (WP4); pause from `config.pageRetryPauseSec` / `SCREEN_PAGE_RETRY_PAUSE_SEC` | unchanged rule |
| phase1-scrape.ps1:865-892, 958-997 bookkeeping and fail-open | owner: phase1 (WP4) | CLI contract supports it, see section 3 |
| reed-phase1.js:305-356 | owner: Reed (WP7), D4 | on exit 3 do not mark candidates seen |
| watchdog-runner.js:113 process regex | owner: supervision (WP5) | must match `ai-review` and `caterer-ai-review` |

## 2. Preserved behaviours (and how each is verified)

| Behaviour | Verified by |
|---|---|
| flags `--mode --job --location --distance --candidates-file --candidates --title --snippet --help`; defaults Chef, empty, 20 | `cli-contract.test.js` |
| batch stdout: ONE line, no trailing newline, input order, `id` as string, keys `id,approved,reason`, first line matches the caller's array regex | `cli-contract.test.js` "batch happy path" |
| single stdout `{approved,reason}` only | "single mode" |
| reason: model text collapsed to one line, cut to 120, `Approved`/`Rejected` when empty | "reason longer than 120" |
| stderr `SCREENING_MODEL: <label>` on success AND on API failure, last one wins; never contains `API_UNAVAILABLE` on success; no stderr line that looks like the results array | "stderr: SCREENING_MODEL marker", "API unavailable" |
| API failure: stdout starts `API_UNAVAILABLE:` (nothing before it), stderr has the token, exit 3 | "API unavailable", "401, 402, 403" |
| exit 0 / 1 / 3 and `--help` exit 0; unknown mode prints usage and exits 1 | "--help exits 0", "input errors exit 1" |
| all-or-nothing batch (any unavailable candidate fails the call) | `llm-stage.test.js` "unavailable", `jev-stage.test.js` retry test |
| search-tier prompt selection incl. tier 0 and the Commis Chef quirk; tier regexes verbatim | `prompts-parity.test.js` (golden tables generated by executing the legacy functions) |
| recruiter prompt verbatim for all tiers (ASCII dashes only) | `prompts-parity.test.js` "batch prompt equals the legacy batch prompt" |
| single mode fails open after the unlock (approve on unusable output), still reports unavailability | `llm-stage.test.js` "single mode fails OPEN" |
| callers may keep `--candidates-file` and per-page invocation | `cli-contract.test.js` |
| exit code and marker text both usable (the legacy PS caller inferred exit 3 from the text) | contract tests assert both |
| `caterer-ai-review.js` still works as an entry point | "the legacy wrapper" |
| `lib/screening-health.js` keeps `checkScreening()` shape (default deep) and `portOpen()` | `health.test.js` "legacy-compatible" |
| halt state semantics (idempotent per reason) with fixed reason strings | `health.test.js` "reason strings are a fixed set" (uses `lib/pipeline-halt.js`) |

## 3. Deliberate deviations (each listed with the reason)

Numbers D1 to D11 refer to `research/screening-contract.md` 6.11 with the defaults of DESIGN section 8.

1. **D1 per-candidate calls.** One request per candidate; `--batch-size` is accepted and ignored. Removes
   "missing from AI response" and batch-composition effects. Retry delays (1 s base) and timeouts (60 s
   per call) are shorter than legacy (5 s / 15 s, 130 s per batch) because calls are small; worst case
   for a total outage is bounded by a circuit breaker (3 consecutive candidates) and a 600 s deadline,
   under Reed's 900 s exec timeout.
2. **Hard errors are not retried.** 401, 402, 403 abort the batch at once (legacy retried them 3 times).
3. **D2 strict boolean and aligned post-unlock prompt.** `"false"` is invalid (legacy made it true); the single
   prompt uses the batch rules block (adds the "Commis Chef for a generic Chef search = APPROVE" exception).
4. **D3 malformed model output never exits 1.** Retried, then backup model, then per candidate
   `sys_invalid_result` (reject before the unlock, logged to `logs/errors.jsonl`) or `sys_fail_open`
   (approve after the unlock). `batch.onInvalid=approve` flips the pre-unlock fallback. Changed by the review-fix
   pass (item 17): systemic invalid output is unavailable (exit 3) whatever the page size, and `phase1.js` never
   books a `sys_invalid_result` as a rejection.
5. **D5 label.** `SCREENING_MODEL` = engines that decided, joined by `+` (for example `typesafe-ai/jev+anthropic/claude-sonnet-5.5`,
   `rules`), `unknown` only for an empty batch, `none` when no engine could be attempted (no key). A run in which every candidate was unusable, or that failed as unavailable, is labelled with the models that were tried (it used to be `unknown`, which hid the fault).
   `unavailable` and `error` sentinels are kept for the Reed caller (exported in `SENTINELS`).
6. **D6 redaction, D7 no temp files.** Redaction before any third-party call and before the log; leftover
   `downloads/review-tmp-*` older than an hour are deleted at start.
7. **D8 health.** Cheap TCP probe per tick, real credit check plus canary only when asked, one tiny call
   instead of a 73 to 103 s agent round trip; reason strings are a fixed set (no status codes).
8. **D9 (research) rubric text.** ASCII dashes. The stale-profile clause is NOT in the default rubric
   (research D9 wanted it explicit): the brief says prompts verbatim, and the clause can act as an age filter.
   It exists as an opt-in (`rubric.staleProfileClause`), as does the recall-tilted `insufficientEvidence=lenient`.
   Behaviour drift to expect: the model no longer has the old agent's skill documents in context, so
   stale-profile rejections (about 3 percent of rejections) may fall.
9. **Added to the prompt, not changing criteria:** a system message (candidate text is untrusted), and a request
   for `reasonCode` and `confidence` with a strict JSON schema instead of "return a JSON array only".
10. **Engines.** Default `jev_shadow` (LLM decides, Jev logged) until the Jev-only build of 2026-09-30, after which the default is `jev_only` (section 6). `jev` decides only when
    `decide.calibration.calibrated` is true (otherwise it runs `jev_shadow` with a warning). Escalation
    is done in code with a second chat-completions call; the gateway-native evaluation-fallback mode
    (`SCREEN_ESCALATION=gateway`) is not implemented (recorded in DECISIONS as not needed).
11. **Jev question design.** Atomic Choice/Score/Noul questions and a code-side `decide()` (approve, reject,
    review), not one two-option "decision" question, per the brief and the Jev design guide.
12. **Stage 1.** Only validated rules, `shadow` by default; the empty-card rule defers to the judge instead of
    rejecting, and the Reed "no data" rule is a flag only (both would have rejected on missing information).
13. **Shadow log stores the REDACTED input** (DESIGN D3, current-system-review 7.6) rather than only a hash
    (screening-contract 6.6); `shadow.storeText=false` restores hash-only. Row schema in `engine.js newRow()`.
14. **Missing key is exit 3** (`API_UNAVAILABLE`, marker `none`), legacy exited 1; this lets the halt logic engage.
15. **Exit method.** The CLI sets `process.exitCode` and lets the loop drain (an unref'd 3 s timer forces it):
    `process.exit()` crashed libuv on Windows Node 25 with pending HTTP handles.
16. **Additions (compatible):** `-h`, `--key=value`, values that start with `--`, `--candidates-file -`
    (stdin), `--consume-input`, `--name`, `--source`, `--run-id` (also `SCREEN_SOURCE`, `SCREEN_RUN_ID`),
    `--with-codes` (adds `reasonCode`, default output unchanged), a decision cache (decisions only), audit sampling.

17. **Review-fix pass: no silent reject on small pages** (finding "unusable model output or a request-level 4xx becomes a
    silent, permanent reject", reproduced with the fake gateway before the fix: 1, 3 and 4 candidates rejected with exit 0
    while 5, 6 and 10 exited 3). `engine.js runLlm`: a 4xx (400/404/422) on every model tried is `kind: request` and the
    candidate counts as unavailable like a transport failure (the run fails as `ScreeningUnavailable`, reason key `error`), a missing model
    list too. `execute`: a call of two or more in which every candidate is unusable fails as unavailable; a cross-call
    counter (`lib/screening/streak.js`, `runtime/screening-invalid-streak.json`, `batch.invalidStreakMax` 3,
    `batch.invalidStreakTtlSec` 1800) counts unusable candidates while nothing in the call was usable and trips on the third in a row
    (one-candidate pages); a usable answer (not a `system` result) resets it; post-unlock single calls never touch it.
    A cache hit or a rule decision counts as usable. Callers pass `--with-codes` and skip the rejection bookkeeping for
    `sys_invalid_result` (phase 1 does; the Reed caller still has to: see the package result, `reed-phase1.js` marks
    `seenReedCandidate` for every non-approved result).
18. **Promotion gate** (finding "GO while Jev loses 10 percent of the LLM-approved candidates"; reproduced: system agreement 90.0 percent,
    Jev-lane agreement 80.0 percent, 50 of 500 LLM-approved lost, verdict GO). `tools/screening-report.js`: lost candidates are capped
    separately from wasted credits (`gate.maxJevRejectLlmApprove` 1.5 percent of compared cards and `gate.maxJevRejectOfLlmApproved` 5 percent of
    the LLM-approved ones), the Wilson lower bound of Jev-lane agreement must be at least `gate.minLaneAgreementLo` 0.93, Jev must decide at least
    `gate.minLaneCoverage` 0.25 of its answers (computed on the Jev lanes of every row, not on LLM/Jev pairs, which are biased in engine `jev`
    where only about 5 percent of Jev decisions carry an LLM audit answer), and every source in `gate.requiredSources` (default caterer and reed)
    must be present. `recommend()` honours the same caps. All numbers are placeholders to calibrate and sit in `config/screening.json`.
    The previous GO fixture (1.7 percent lost, 90 percent lane lower bound) is now NO-GO by design.
19. **Config hardening** (finding "unnormalised engine value, type-confusion crashes, unvalidated decide thresholds"): file values are trimmed and
    lower-cased like the environment, a wrong-typed section is replaced by its default section with a warning, every `decide.*` threshold must be
    a number from 0 to 1, empty model names fall back to the default model, an explicit `SCREEN_CONFIG_FILE` that does not exist warns,
    `gateway.origin` must be https (plain http only for 127.0.0.1, localhost, [::1]) so the key cannot be sent in clear or to an arbitrary
    host, `SCREEN_LLM_ZDR` / `SCREEN_JEV_ZDR` switch zero data retention per path (`SCREEN_ZDR` still sets both), redaction off forces
    `shadow.storeText` off. `tools/screening-report.js --config` with a missing file exits 1.
20. **Redaction** (finding "leaks many surnames and non-UK identifiers"): added international `+` numbers, bare social domains, @handles, NI numbers,
    DOB and age with a keyword, comma-written postcodes and GIR 0AA, particle chains (van der, dos, de la); the input is bounded before any
    pattern runs (a 400 KB single token took 138 s). Not done: masking every capitalised token after the first name (it would delete the job title
    of cards whose title word is not in the role-word list), street addresses, numbers without + or a leading 0. docs/SCREENING.md says so.
21. **Stage 1 and Jev decisions** (engine `jev` only, after promotion): `S1-NA-NONHOSP` no longer treats waiter, bar, hotel, reception or dish titles as
    non-hospitality (still shadow); the injection heuristic folds zero-width and look-alike characters and spaced letters and knows more phrasings (a
    heuristic, the flag only routes to the LLM); `decide()` sends searches with no ladder of their own (tier 0 except `decide.ladder.tier0Titles`:
    Catering Assistant, Kitchen Hand, Food Production) to review, and the thin-information approve now needs no close level mismatch and no
    "not a fit" score. A post-unlock title that reduces to masks only (a postcode) counts as no title. Go-live round 2026-09-30: the shipped list holds
    catering assistant, kitchen hand, food production, waiter, waitress, server, front of house, bartender, dish washer (DECISIONS SCR-28); the
    injection bar `injectionP` is 0.7 (SCR-27); the redaction rank prefix is 1 to 6 digits and lower-case names are removed (SCR-26). Deviation from
    the legacy system: none of these have a legacy equivalent.
22. **Cross-provider fallback (layer 2 of the legacy stack) is not kept, on purpose.** The legacy chain ended in a different provider because a
    self-referential fallback hid the 2026-08-28 to 09-01 OAuth outage (four days of zero CVs). The new backup model is the same vendor through the
    same gateway, so a vendor or gateway outage is an outage of both; that is detected (exit 3, halt, nothing consumed) rather than masked, which is the
    lesson of that incident. A second provider would need a second key and a second data processor; if the owner wants it, add a model from another
    provider as `llm.backupModel` (any gateway model id works) after checking its data terms.

## 4. Not verified here (must be acceptance checks on the real host)

See the `unverifiedLive` list of the package result; in short: the gateway's real answers for the chosen
model (structured output, `max_tokens`, refusal handling), Jev's real response shape and limits through
the gateway, `GET /v1/credits` behaviour, approval-rate parity of the new model with the old one, and the
quality of redaction on real Caterer and Reed cards.

## 5. Test evidence

Windows Node 25.6.1 and Ubuntu 24.04 Node 22.22.1 (WSL): `node --test "tests/screening/*.test.js"` (a bare
directory argument does not work on Node 22 or later). Zero network (fetch and socket guard), fake keys,
synthetic data. Golden fixtures in `tests/screening/fixtures/` were generated by executing the legacy
prompt and tier functions.

## 6. Jev-only engine (2026-09-30, docs/DECISIONS.md OD-I and SCR-17 to SCR-28)

The owner decided that the Vercel AI Gateway carries Jev only (the team blocks every other model with HTTP 403 "Your team has restricted
access to this model") and that other models will later run through the Hermes runtime. Before this build the default engine `jev_shadow`
called the language model for every candidate, escalated the review lane to it in engine `jev`, required its canary in the deep health check
and downgraded engine `jev` unless the thresholds were marked calibrated, so on the owner's team the health check failed and the pipeline halted.

### 6.1 Map

| Was | Now |
|---|---|
| `config.js` `ENGINES`, `DEFAULTS.engine = jev_shadow`, the calibration downgrade in `load()` | `ENGINES` gains `jev_only` (the default); `decide.reviewPolicy` with `SCREEN_REVIEW_PRE` and `SCREEN_REVIEW_POST`, validated with a warning; the downgrade stays for `jev` only; `jev.model` must contain "jev" in `jev_only`; `config/screening.json` follows |
| `engine.js` `processInner` (LLM after Jev, audit, degraded flag) | `decideJevOnly()`, `resolveByPolicy()`, `tally()`, `warnUncalibrated()`; `runLlm()` throws in `jev_only` and the client is never built; audit and shadow comparison skipped; `labelOf()` names Jev and `policy`; `runJev()` hands the failure object to the caller without putting message text into the log row |
| `reasons.js` | `sys_review_policy_reject`, `sys_review_policy_approve` (`POLICY_CODES`, `isPolicyCode`, sentences, coarse groups) |
| (none) | `second-opinion.js`: the extension point (validate, consult with timeout); no provider |
| `screening-health.js` `check({deep})` (LLM canary always) | `jev_only`: credits, then one Jev canary; `engines` is `{jev:{ok}}`; `RESTRICTED_REMEDY` for a 403 that names a restricted model; `REMEDIES.auth` and `REMEDIES.error` reworded; phase 1 and Reed halt remedies name `typesafe-ai/jev` |
| `ai-review.js` | help text; the summary line gains `policy=N (reject=a approve=b share=x) why={...}` in `jev_only`; a policy line in single mode; stdout, markers and exit codes unchanged |
| `tools/screening-report.js` `analyze()` | `jev_only` rows are separated from the comparison; `analyzeJevOnly()`, `renderJevOnly()`, verdict `NOT APPLICABLE` ("not applicable in jev_only mode", `--strict` exit 3); label accuracy and the export sample cover policy rows |

### 6.2 Preserved (verified by `tests/screening/jev-only.test.js` and the unchanged suites)

The CLI contract (one-line stdout, legacy keys, `--with-codes`, exit 0 / 1 / 3, `SCREENING_MODEL` on success and failure, `API_UNAVAILABLE` marker and
prefix, missing key exit 3 with marker `none`, empty list `[]` with marker `unknown`); redaction before Jev and before the log; the shadow row schema
(additions only: `cal`, `policy`, `second`); the halt reasons (a fixed set of five); the engines `llm`, `jev_shadow` and `jev` behave exactly as before (their
suites run unchanged under `jev_shadow`, given by `tests/screening/helpers.js` through a config file that overrides and `SCREEN_ENGINE` still beat).

### 6.3 Deliberate deviations

24. **No request to a chat-completions endpoint in `jev_only`** (per-route counters of the fake gateway in every scenario; the LLM route answers 403 "restricted
    access" so a stray call would fail loudly). `SCREEN_LLM_MODEL` and `SCREEN_LLM_BACKUP_MODEL` are ignored and do not enter the cache signature.
25. **Review policy** replaces the LLM for the review lane, an injection flag (heuristic or Jev's own answer), an empty card and, after the unlock only, an answer that stays
    unusable after `jev.maxInvalidAttempts` (before the unlock that is `sys_invalid_result`, item 35). Defaults reject before and approve after the unlock. A policy reject is
    booked by phase 1 like any rejection (`sys_invalid_result` is not; the mass guard and the streak, below, stop a systemic fault).
26. **Jev failures keep the legacy meaning.** 5xx or 429 after retries, timeouts, network errors, 401, 402, 403 (including "restricted access"), 400 (including the zero-data-retention
    refusal `no_providers_available`), 404 and 422 are `ScreeningUnavailable`: exit 3, marker, halt. A hard failure (401, 402, 403) trips the run at once; the others trip after
    `batch.breakerConsecutive` consecutive candidates or fail the call at the end (all or nothing). Never a fallback, never a per-candidate reject.
27. **Guards apply to Jev**: an unusable answer counts towards `batch.invalidMassMin` and `batch.invalidMassShare`, an all-unusable page of two or more, and the cross-call streak
    (`runtime/screening-invalid-streak.json`); a usable answer (also a policy decision from a valid review-lane answer, a cache hit) resets it; post-unlock calls never touch it.
28. **Uncalibrated thresholds do not downgrade `jev_only`.** One stderr warning per run (per run id when the caller passes `--run-id`, remembered in
    `runtime/screening-uncalibrated-warned.json`; per process otherwise); every row carries `cal`.
29. **Policy decisions are cached only when they come from a valid Jev answer**; an unusable-answer decision is never cached, so a recovered Jev is asked again on the retry.
30. **Label**: `typesafe-ai/jev`, plus `+policy` when the policy decided anything, `+<provider>` for a second opinion, `policy` alone when Jev was never asked (a page of empty or instruction-flagged cards only),
    `none` without a key, `unknown` for an empty batch, and on failure the model that was tried.
31. **Second-opinion extension point**: interface and documentation only, in `jev_only` only; a provider can never make screening unavailable.
32. **Phase 1 copies the reviewer's `WARN screening` lines to its console log** (`WARN screening:` and `WARN screening config:`; `phase1/screen.js`; Reed already copies stderr lines that contain WARN), so the once-per-run
    uncalibrated-thresholds warning is readable in the run log and not only on a terminal. Reed's and phase 1's halt remedies name `typesafe-ai/jev`.
33. **Tests moved, not weakened**: the suites written for the LLM engines get `jev_shadow` from a config file in `tests/screening/helpers.js`; the end-to-end world pins `jev_shadow`
    (`tests/e2e/lib/world.js`, option `engine`) and scenario 13 runs the default. Both opt in to the language-model engines (item 34).
34. **The engines other than `jev_only` are refused without `allowLlm`** (`SCREEN_ALLOW_LLM=1`): `config.js load()` forces `jev_only` with a `WARN screening config:` line and
    `llm-client.js` refuses to be constructed (DECISIONS SCR-23). Tests: `jev-only.test.js` (leftover engines at settings, CLI, health and client level), `e2e/13-jev-only.e2e.js` 13c.
35. **An unusable Jev answer before the unlock is `sys_invalid_result`, not a policy decision** (DECISIONS SCR-24; `engine.js decideJevOnly()` and `resolveByPolicy()`); after the unlock
    the policy decides. An exception inside `decide()` (`ANSWER_UNUSABLE`) counts as an unusable answer. Items 25, 27 and 29 are amended accordingly.
36. **`decide.ladder` is validated when the settings load** (`config.js repairLadder()`, DECISIONS SCR-25).
37. **Halt remedy for an opt-in language-model engine on a team that blocks it** (`screening-health.js`, `LLM_RESTRICTED_REMEDY`): set `SCREEN_ALLOW_LLM 0` and `SCREEN_ENGINE jev_only`.
38. **Report**: section J counts the cards left undecided (`jevOnly.undecided`).
39. **Redaction (go-live round 2026-09-30, DECISIONS SCR-26)**: the rank prefix is 1 to 6 digits and a name in lower case is removed like one in capitals (`redact.js nameForm()`; the text is not re-cased; role words and the surname rules are unchanged). Backtest: 149 of 952 cards had a 4-digit rank and 132 a lower-case name. Test: `tests/screening/redact-rank-case.test.js`.
40. **Injection bar 0.7 (SCR-27)**: `decide.stage1.injectionP` and `decide.stage2.injectionP` (file and `config.js` defaults). Backtest on 326 labelled cards: the uncertain share fell from 53.4 to 45.7 percent and the candidates lost before the unlock from 24 to 14. Test: `tests/screening/ladder-titles-injection.test.js`.
41. **Six non-kitchen titles on the tier-0 ladder (SCR-28)**: waiter, waitress, server, front of house, bartender, dish washer (KNOWN-LIMITS K-SCR12). The tests that pinned Waiter and Bartender as no-ladder titles (`decide.test.js`, `jev-only.test.js`, `config-cache.test.js`) were updated; Barista is the no-ladder example now.

### 6.4 Test evidence (Jev-only build)

Go-live finalizer run, 2026-09-30 (after SCR-26 to SCR-28 and the tick drain): a fresh copy of the repository in WSL Ubuntu 24.04, Node 22.22.1, `npm install` in `resourcer/`, `node --test --test-concurrency=4 "tests/**/*.test.js"` with `NODE_PATH` and a fastapi venv: 1,983 tests, 1,978 pass, 0 fail, 5 skipped (4 real Chromium, 1 that needs the git history). Windows Node 25.6.1: `tests/screening` 283 of 283, `tests/supervision` 274 pass and 92 POSIX-only skips, `tests/docs` all pass (the Reed suites there stop at the missing `ws` module, as do the database suites at the missing `better-sqlite3`). End-to-end scenarios 01 to 13 pass (08 after the one-line fix, run alone; the update note was also replayed against a simulated instance, update and rollback).

WSL Ubuntu 24.04, Node 22.22.1, after the finalizer pass (items 34 to 38): `node --test "tests/screening/*.test.js"` 264 pass (53 in `jev-only.test.js`, 7 in `jev-only-report.test.js`); with `tests/docs` 299 pass;
with `tests/phase1` and `tests/reed` 696 tests, 692 pass, 4 skipped (real Chromium), 0 fail (two new phase 1 tests in `e2e.reallib.test.js`); the whole unit suite (`NODE_PATH` at a `better-sqlite3` install)
1,925 tests, 1,919 pass, 0 fail, 6 skipped. The screening and docs suites also pass on Windows Node 25.6.1 (299 of 299).
End-to-end scenarios 01 to 07 and 09 to 13 (`bash tests/e2e-linux.sh`; scenario 08 needs a fastapi venv and was not run) pass; scenario 13 has a new part 13c (a leftover `SCREEN_ENGINE=jev_shadow` in the `.env`). Scenario 06
failed once on a process-count assertion during its freeze (timing) and passed on the immediate rerun. Mutation checks, each of which fails the suite: turning a Jev failure into a policy
decision; adding a request to the chat route from the review path; switching the engine refusal off; sending a before-unlock unusable answer to the policy; dropping the `decide()` exception mapping; skipping the ladder
validation; reverting the phase 1 warning filter to `WARN screening:`; removing the lock in the language-model client; dropping the restricted-model remedy. UNVERIFIED-LIVE: that the owner's team really answers 403 to a chat call and lets Jev through
(INSTALL 7.2 and 7.4), Jev's real answer shape and the real share of review-lane cards under the placeholder thresholds (ACCEPTANCE SR08).
