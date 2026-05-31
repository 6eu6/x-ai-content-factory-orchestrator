# TEST COVERAGE AUDIT

**Date:** 2026-06-01
**Scope:** 35 test files, 913 tests, all passing
**Runner:** Vitest 3.2.4
**Command:** `npx vitest run`

---

## 1. Test Inventory by Category

### Queue & Infrastructure (4 files, ~80 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `pipeline-contract-replay.test.ts` | 9 | queue | Pipeline contract replay against saved fixtures |
| `retry.test.ts` | 7 | queue | Retry logic with exponential backoff |
| `cron-reliability.test.ts` | 19 | queue | Cron dispatcher timing and dedup |
| `phase2a-ledger.test.ts` | 45 | queue/cost | Cost ledger recording and retrieval |

**Assessment:** Queue infrastructure is well-covered. Pipeline contract replay tests validate that the pipeline produces consistent outputs for given inputs. Retry logic is tested with various failure scenarios. Cron reliability tests cover timing edge cases.

### Scan & Scoring (1 file, 4 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `x-scoring.test.ts` | 4 | scan | X scoring formula for opportunity ranking |

**Assessment:** The scan phase has minimal test coverage. Only the scoring formula is tested. There are no tests for the actual scanning pipeline (account scanning, tweet fetching, engagement filtering, prefilter logic from Phase 2E.1). This is a significant gap given that scanning is the pipeline's entry point and determines the quality of all downstream data.

### Intelligence & Crafting (3 files, ~64 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase2d2-brief-crafting.test.ts` | 17 | intelligence | Brief generation from opportunity |
| `phase2d3-crafting-contract.test.ts` | 19 | intelligence | Crafting contract validation |
| `phase2d-integration-fix.test.ts` | 28 | intelligence | Integration fixes for 2D pipeline |

**Assessment:** The intelligence and crafting phases have moderate coverage. Brief generation and crafting contracts are well-tested. The integration fix tests validate specific bugs that were found and fixed. However, there are no tests for the full intelligence → craft → judge sequence, which is the most critical pipeline path.

### Account Lens (1 file, 40 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase-s1-3-account-growth-lens.test.ts` | 40 | account lens | S1.3 niche broadening, handle validation, source quality |

**Assessment:** The S1.3 Account Growth Lens has good coverage including handle validation, source quality scoring, and niche broadening logic. However, the interaction between S1.3 and S1.2 (post length policy) is not tested, and the S1.3 forced-angle path is only partially covered.

### Quality Enhancement (6 files, ~319 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase2b-quality.test.ts` | 82 | quality | Originality enhancer, numeric claim guard |
| `phase2c-quality.test.ts` | 68 | quality | Quality gate scoring |
| `phase2c1-quality.test.ts` | 59 | quality | Quality sub-gate |
| `phase2c2-quality.test.ts` | 12 | quality | Quality refinement |
| `phase2d-quality.test.ts` | 88 | quality | Phase 2D quality checks |
| `brain-quality.test.ts` | 10 | quality | Brain rule quality validation |

**Assessment:** This is the most heavily tested area, reflecting the system's quality-first design philosophy. Phase 2B through 2D quality checks are thoroughly covered with both positive and negative test cases. Brain quality tests validate that stored rules meet quality thresholds. This category has the strongest test coverage in the entire suite.

### Judge (4 files, ~50 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase2d1-model-routing.test.ts` | 25 | judge | Model routing for different task types |
| `phase2g3-dual-candidate.test.ts` | 10 | judge | Dual candidate selection logic |
| `phase2g3-hotfix-candidate-crash.test.ts` | 7 | judge | Fix for candidate crash bug |
| `phase2g3-hotfix2-near-pass-mismatch.test.ts` | 8 | judge | Fix for near-pass mismatch bug |

**Assessment:** Judge tests focus on model routing and the dual-candidate system. The hotfix tests validate specific crash and mismatch bugs. However, the judge's scoring dimensions (originality, usefulness, brief alignment, evidence safety, clarity) are not individually tested — they are tested indirectly through the quality enhancement tests. There are no tests for the judge's pass/fail threshold behavior or for edge cases like tied scores.

### Publish Gate (1 file, 30 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `content-policy.test.ts` | 30 | publish gate | Content policy filtering |

**Assessment:** Publish gate tests cover the content policy filter comprehensively. However, there are no tests for the gate's interaction with the decision engine — specifically, no test verifies that a candidate rejected by the publish gate cannot appear in the decision output even if it has a high judge score. This is a critical contract gap.

### Telegram (1 file, 8 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `telegram-parsing.test.ts` | 8 | telegram | Handle extraction, URL parsing |

**Assessment:** Telegram tests only cover parsing utilities. There are no tests for the delivery contract (manual-only enforcement, message format, diagnostic content), the "نشرت" command flow, or the published-decision logging pipeline. This is a significant gap given that the Telegram interface is the system's human-in-the-loop safety mechanism.

### Memory (1 file, 17 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase-m1-structured-memory.test.ts` | 17 | memory | Compaction signal extraction and rule generation |

**Assessment:** Memory tests cover the compaction pipeline (signal extraction, rule compaction, topic key inference). However, the retrieval pipeline (`getRelevantStructuredMemory`, `buildMemoryPromptSection`, `buildPolishMemorySection`) is not tested at all. There are no tests for the scoring function, the max-10-item cap, the category allocation (operator/anti-pattern/fixes), or the prompt formatting. The source_author_memory update logic is also untested.

### Post Length Policy (1 file, 45 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase-s1-2-post-length-policy.test.ts` | 45 | post length | Post length policy computation and enforcement |

**Assessment:** Post length policy is well-tested with comprehensive coverage of policy computation, hard/soft limits, character counting, and validation. However, there are no tests for how S1.2 interacts with S1.3 — specifically, whether the post length policy is correctly propagated when the Account Growth Lens broadens the niche.

### Parser & Utilities (1 file, 6 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `parse-model-json.test.ts` | 6 | parser | JSON repair and parsing from model output |

**Assessment:** Parser tests cover the most common JSON repair scenarios (trailing commas, markdown fences, partial JSON). Edge cases like deeply nested JSON, Unicode issues, and very long model outputs are not tested, but the current coverage is adequate for the known failure modes.

### Other (7 files, ~124 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `decision-engine.test.ts` | 4 | decision | Decision scoring and budget allocation |
| `feedback-loop.test.ts` | 68 | feedback | Feedback loop processing |
| `rule-performance.test.ts` | 25 | rule-perf | Rule performance weight computation |
| `performance-outcome.test.ts` | 20 | perf | Performance outcome tracking |
| `phase2e1-discovery-audit.test.ts` | 19 | discovery | Discovery audit checks |
| `phase2e3-rejection-transparency.test.ts` | 15 | rejection | Rejection reason tracking |
| `phase2f-near-pass-polish.test.ts` | 41 | polish | Near-pass polish logic |

**Assessment:** The feedback loop (68 tests) is exceptionally well-tested. Rule performance and performance outcome tests provide good coverage for the learning subsystem. The near-pass polish tests cover the polish logic including the MAX_POLISH_CANDIDATES_PER_RUN cap. The decision engine only has 4 tests — this is under-tested for a core component.

### Advanced Features (3 files, ~42 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase2g-originality-context.test.ts` | 14 | originality | Originality context retrieval |
| `phase2g1-signature-voice.test.ts` | 15 | signature | Signature voice validation |
| `phase2g2-brief-locked-polish.test.ts` | 13 | polish | Brief-locked polish constraints |

**Assessment:** These Phase 2G features have adequate unit test coverage. Originality context, signature voice, and brief-locked polish are tested for their core logic. Integration between these features (originality + signature + polish) is not tested.

### Freshness Gate (1 file, 16 tests)

| File | Tests | Category | Coverage |
|------|-------|----------|----------|
| `phase-s1-1-freshness-gate.test.ts` | 16 | freshness | Source freshness validation for reply/quote |

**Assessment:** The S1.1 freshness gate is well-tested with coverage for reply (72h), quote (7d), and standalone (no freshness check) formats. Edge cases like missing timestamps and downgrade-to-standalone are covered.

---

## 2. Gap Analysis

### Gap 1: End-to-End Pipeline Test

**Status: MISSING ❌**

There is no test that runs the full pipeline from scan input to Telegram delivery output. The `pipeline-contract-replay.test.ts` tests contract consistency for individual phases, but no test validates the complete scan → intelligence → craft → judge → gate → decision → delivery sequence.

**Risk: HIGH.** Integration bugs between phases (e.g., data shape mismatches, missing fields) can only be caught by running the full pipeline. The current test strategy assumes that if each phase works independently, the pipeline works end-to-end — but this assumption has been disproven multiple times (see the hotfix tests in the judge category).

**Recommendation:** Create a `pipeline-e2e.test.ts` that uses saved fixtures to simulate a full pipeline run with known inputs and expected outputs. This test should validate: (1) all task types execute in sequence, (2) data flows correctly between tasks, (3) the final Telegram message contains expected content, and (4) no candidates bypass gates.

### Gap 2: No Recommendation Test

**Status: MISSING ❌**

There is no test for the "no recommendation" scenario — when the pipeline produces zero selected candidates. This is a common real-world scenario (estimated 30–50% of runs in early account stages) and should be tested to ensure: (1) the Telegram message is informative, (2) no empty/null candidates leak into the output, and (3) the decision engine handles the empty case gracefully.

**Risk: MEDIUM.** The "no recommendation" path is the default for new accounts with low follower counts. If it breaks, the operator gets no feedback.

### Gap 3: Forced Angle Full-Path Test

**Status: PARTIAL ⚠️**

S1.3 has unit tests for the Account Growth Lens, but there is no test for the full forced-angle path from intelligence (where the recommended_angle diverges from the obvious take) through craft (where the model must follow the forced angle) to judge (where the judge must evaluate whether the forced angle was followed). This is the most complex pipeline path and the most likely to produce unexpected behavior.

**Risk: MEDIUM-HIGH.** The forced-angle path is where the system adds the most value (finding unique angles that a human operator might miss). If this path breaks, the system produces generic content.

### Gap 4: Source Strategy Test

**Status: MISSING ❌**

There are no tests for the source scanning strategy — which accounts to scan, how many tweets to fetch per account, how to prioritize high-value sources, and how to handle rate limits or API failures. The `scanXAccounts` function's source selection logic is untested.

**Risk: MEDIUM.** Source strategy determines the quality of input data. If the strategy is flawed (e.g., always scanning the same accounts, missing high-value sources), the entire pipeline suffers.

### Gap 5: Memory Retrieval Test

**Status: PARTIAL ⚠️**

The compaction pipeline has 17 tests, but the retrieval pipeline has zero tests. The `getRelevantStructuredMemory`, `buildMemoryPromptSection`, `buildPolishMemorySection`, and `scoreRule` functions are all untested. This means the most impactful part of the memory system (what gets injected into prompts) has no automated validation.

**Risk: HIGH.** If retrieval returns wrong rules (e.g., low-confidence rules, irrelevant rules, too many rules), the craft and polish phases will be misdirected. Without tests, retrieval regressions will go undetected.

### Gap 6: S1.2 + S1.3 Interaction Test

**Status: MISSING ❌**

S1.2 (post length policy) and S1.3 (account growth lens) are tested independently but never together. There is no test that verifies: (1) the post length policy is correctly applied when the Account Growth Lens broadens the niche, (2) longer posts from S1.3's broader niche are not rejected by S1.2's hard limit, and (3) the interaction between niche broadening and post length produces valid content.

**Risk: MEDIUM.** The two features were developed in separate phases and may have implicit assumptions that conflict when combined.

### Gap 7: Publish Gate Rejects Over-Limit Even If Judge Passes

**Status: MISSING ❌**

There is no test that verifies the publish gate can reject a candidate that the judge passed. If a candidate has a high judge score but violates a publish gate rule (e.g., content policy, freshness), the gate should still reject it. This is a critical safety invariant.

**Risk: HIGH.** Without this test, a regression that allows judge-passed but gate-failing content to reach the operator could go undetected.

### Gap 8: Unjudged Text Cannot Publish

**Status: MISSING ❌**

There is no test that verifies content that was never evaluated by the judge cannot appear in the published output. This is a safety contract — all content must pass through the quality evaluation before reaching the operator.

**Risk: HIGH.** If a bug allows unjudged content to bypass the judge and reach the decision engine, the quality guarantee is broken.

### Gap 9: Telegram Manual-Only Contract Test

**Status: MISSING ❌**

There is no test that verifies the Telegram delivery pipeline never calls X write APIs. This is the system's most important safety invariant, and it has zero automated enforcement.

**Risk: CRITICAL.** A regression that introduces auto-posting would violate the fundamental design contract and could post unreviewed content to the operator's X account.

---

## 3. Coverage Summary Matrix

| Category | Files | Tests | Gap Level |
|----------|-------|-------|-----------|
| Queue & Infrastructure | 4 | ~80 | LOW |
| Scan & Scoring | 1 | 4 | **CRITICAL** |
| Intelligence & Crafting | 3 | ~64 | MEDIUM |
| Account Lens | 1 | 40 | LOW |
| Quality Enhancement | 6 | ~319 | LOW |
| Judge | 4 | ~50 | MEDIUM |
| Publish Gate | 1 | 30 | MEDIUM (contract gaps) |
| Telegram | 1 | 8 | **CRITICAL** |
| Memory | 1 | 17 | **HIGH** (retrieval untested) |
| Post Length Policy | 1 | 45 | LOW |
| Parser & Utilities | 1 | 6 | LOW |
| Decision Engine | 1 | 4 | **HIGH** |
| Feedback & Learning | 3 | ~113 | LOW |
| Advanced Features | 3 | ~42 | MEDIUM |
| Freshness Gate | 1 | 16 | LOW |

---

## 4. Priority Test Additions

### Priority 1 — Critical (Must Have)

1. **`pipeline-e2e.test.ts`** — End-to-end pipeline test with saved fixtures (Gap 1)
2. **`telegram-contract.test.ts`** — Manual-only enforcement, message format, "نشرت" command (Gap 9)
3. **`publish-gate-contract.test.ts`** — Gate rejects over judge, unjudged cannot publish (Gaps 7, 8)
4. **`memory-retrieval.test.ts`** — Retrieval scoring, max-10 cap, confidence floor, prompt formatting (Gap 5)

### Priority 2 — High (Should Have)

5. **`scan-strategy.test.ts`** — Source selection, account prioritization, API failure handling (Gap 4)
6. **`decision-engine-expanded.test.ts`** — Decision scoring edge cases, budget enforcement, tie-breaking (under-tested at 4 tests)
7. **`forced-angle-full-path.test.ts`** — Full intelligence → craft → judge path for forced angles (Gap 3)
8. **`no-recommendation.test.ts`** — Zero-selected-candidate scenario (Gap 2)

### Priority 3 — Medium (Nice to Have)

9. **`s1-2-s1-3-interaction.test.ts`** — Post length policy with Account Growth Lens (Gap 6)
10. **`judge-dimensions.test.ts`** — Individual judge scoring dimensions
11. **`source-author-memory.test.ts`** — Source author memory update and retrieval
12. **`model-routing-edge-cases.test.ts`** — Fallback routing, unknown task types, rate limit handling

---

## 5. Acceptance Criteria for Test Coverage Improvement

1. All Priority 1 tests pass
2. Test count increases from 913 to 1000+
3. No category has "CRITICAL" gap level
4. End-to-end pipeline test validates the full scan → delivery sequence
5. Contract tests enforce the manual-only Telegram invariant
6. Memory retrieval has at least 20 tests covering scoring, capping, and prompt formatting
7. Decision engine has at least 15 tests covering scoring, budget, and edge cases
8. All new tests use the existing Vitest + fixture-based pattern (no external dependencies)
