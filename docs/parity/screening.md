# Parity: screening (work package "screening")

Legacy sources (read-only): `scripts/ai-review.js`, `scripts/caterer-ai-review.js`,
`scripts/lib/screening-health.js`, `scripts/ai-review-abtest.js`; callers `phase1-scrape.ps1`,
`reed-phase1.js`. New code: `resourcer/scripts/ai-review.js`, `caterer-ai-review.js`,
`lib/screening-health.js`, `lib/screening/*`, `config/screening.json`, `tools/screening-report.js`.
Tests: `tests/screening/*.test.js`, `tests/fake-gateway/*` (203 tests after the review-fix pass; see the end of this file).

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
10. **Engines.** Default `jev_shadow` (LLM decides, Jev logged). `jev` decides only when
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
    "not a fit" score. A post-unlock title that reduces to masks only (a postcode) counts as no title.
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
