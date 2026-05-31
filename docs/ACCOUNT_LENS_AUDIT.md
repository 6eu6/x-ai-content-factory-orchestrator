# Account Lens / Prompt Consistency Audit

**Project:** x-ai-content-factory-orchestrator
**Date:** 2025-03-04
**Scope:** All prompt-carrying files that encode @30piq's account lens, including scoring logic, guard functions, judge prompts, polish prompts, and publish gates
**Status:** Issues found — two CRITICAL, several MEDIUM

---

## 1. Executive Summary

This audit examines every location in the codebase where @30piq's account focus is defined, referenced, scored, or enforced. After the S1.3 phase transition, the intended account lens was broadened from the narrow "AI × productivity × career growth" framing to a richer, more expressive definition: "AI-native operator / builder / digital culture account" spanning AI tools, productivity, leverage, building/shipping/startups/indie hacking, career growth, skill acquisition, internet business, creator growth, digital behavior, attention, software/automation/systems/tools, future of work, and cultural/viral moments only when they produce useful operator/builder/creator insight.

The audit reveals that this broadened definition was correctly propagated to the pattern-matching layer (`niche-alignment.ts`) and to one critical prompt (`pipeline-worker.ts craftFromBrief`), but **two AI prompts still carry the old narrow wording**: `opportunity-intelligence.ts` and `opportunity-judge.ts`. These stale prompts will cause the AI to evaluate and score opportunities against a narrower lens than the pattern matcher intends, creating a systematic drift where pattern-level scoring allows topics that the AI then undervalues or rejects.

A second critical finding is a **structural gap in the adjacent-topic pattern system**: `ALLOWED_ADJACENT_TOPICS` declares crypto/web3, politics/policy, and gaming as valid adjacent topics with required angles, but `ADJACENT_TOPIC_PATTERNS` contains only 5 entries and is missing pattern definitions for those three topics. This means adjacent-topic detection is partially broken — the system claims to handle these topics but has no regex to match them.

Additionally, the codebase carries significant **naming debt**: function names, type names, and field names throughout use "niche" terminology (e.g., `scoreNicheAlignment`, `is_off_niche`, `NicheAlignmentResult`) rather than the semantically accurate "lens" terminology that S1.3 introduced. While renaming these identifiers would cause unnecessary churn and risk breakage, the debt must be documented so that future contributors understand the semantic mapping.

No threshold changes are recommended. The scoring thresholds and publish gates appear consistent and well-calibrated for the S1.3 lens. The issues are entirely about wording consistency and pattern completeness.

---

## 2. Account Lens Definition (Canonical, Current Intended)

After S1.3, @30piq's account lens is defined as:

> **AI-native operator / builder / digital culture account** focused on:
>
> - AI tools and AI-native workflows
> - Productivity and leverage
> - Building / shipping / startups / indie hacking
> - Career growth and skill acquisition
> - Internet business and creator growth
> - Digital behavior and attention
> - Software / automation / systems / tools
> - Future of work
> - Cultural/viral moments **only when** they produce useful operator/builder/creator insight

This definition is intentionally broader than the original "AI × productivity × career growth" framing. It captures the full spectrum of content that an AI-native operator would find valuable, including the creator economy, internet business models, digital culture analysis, and systems thinking. The key constraint is the final clause: cultural and viral moments are on-lens **only** when they yield actionable insight for operators, builders, or creators. Pure entertainment, empty virality, and culture-war content without operational takeaways remain off-lens.

Every prompt in the pipeline that describes the account focus should use language equivalent to this definition. It does not need to be verbatim, but it must be semantically equivalent — covering the same breadth and the same constraint on cultural content.

---

## 3. Prompt Location Audit

The following table catalogs every file that carries an account-focus definition, scoring logic, or enforcement mechanism, along with the current wording or logic in each.

### 3.1 niche-alignment.ts (522 lines)

**Header:** "Phase 2C / S1.3 — Account Lens Alignment for @30piq"

This file contains the pattern-matching engine for account lens scoring. It defines five pattern categories:

| Category | Count | Purpose |
|---|---|---|
| `ALIGNED_PATTERNS` | ~45 regex | Topics directly on-lens (AI/ML, productivity, career, building, creator economy, etc.) |
| `OFF_LENS_PATTERNS` | 14 regex | Topics off-lens (comics, anime, movies, sports, gaming, lifestyle, fashion, travel, politics, crypto) |
| `TRANSFERABLE_ANGLE_PATTERNS` | 14 regex | Adjacent topics that can be brought on-lens with the right angle |
| `FORCED_ANGLE_PATTERNS` | 9 regex | Patterns that detect forced/unnatural AI framing |
| `ALLOWED_ADJACENT_PATTERNS` | 8 entries | Adjacent topics with declared per-topic required angles |

Scoring starts at 5.0 and adjusts upward for aligned pattern matches and downward for off-lens matches. An `off_niche` flag is set when the final score falls below 4.0. Transferable angles can rescue a topic if the required angle is detected. Forced-angle detection penalizes content that shoehorns AI relevance where it does not genuinely exist.

**Status:** Pattern content was updated for S1.3. The pattern layer is the most complete implementation of the account lens. However, function and type names still use "niche" terminology (see Section 5).

### 3.2 opportunity-intelligence.ts (1533 lines)

This file handles opportunity discovery, scoring, and pre-filtering. It contains two key account-focus references:

**`ALLOWED_TOPICS`** (24 items): A curated list starting from "AI tools" through "systems and tools." This list appears to have been updated for S1.3 and covers the broadened lens scope.

**`ALLOWED_ADJACENT_TOPICS`** (8 entries with required angles): Declares entertainment, sports, anime, movies, crypto/web3, politics/policy, gaming, and internet_trends as adjacent topics, each with a required angle that must be present for the topic to be considered on-lens.

**`BLOCKED_TOPICS`** (12 items): Includes "empty viral bait" and "forced/generic AI angle" — correctly blocking the two main categories of content that violate the lens.

**`ADJACENT_TOPIC_PATTERNS`** (5 entries only): Pattern definitions for adjacent-topic detection. **CRITICAL:** Only 5 of the 8 declared adjacent topics have pattern entries. Missing: crypto/web3, politics/policy, gaming. See Section 6 for full analysis.

**`MIN_NICHE_FIT_SCORE`**: Hardcoded at 5. This is the threshold for the `quickNicheFitScore` pre-filter.

**Main AI prompt wording:** `"focused on AI × productivity × career growth"` — **OLD narrow wording, not updated for S1.3.** This is the prompt that guides the AI's evaluation of opportunity fit. Using the old narrow framing means the AI will systematically undervalue opportunities in creator growth, internet business, digital behavior, and systems/tools that the pattern layer would score as on-lens.

### 3.3 opportunity-judge.ts (601 lines)

The judge AI evaluates whether a drafted opportunity passes quality and alignment thresholds. The judge prompt describes @30piq as:

`"focused on AI × productivity × career growth"` — **OLD narrow wording, not updated for S1.3.**

This is the same stale framing as `opportunity-intelligence.ts`. Because the judge determines whether content is published or rejected, this mismatch directly affects content output. Opportunities that the intelligence layer scores as on-lens (because the patterns were updated) may be rejected by the judge because the judge's AI prompt defines the account focus more narrowly.

**Thresholds:**
- `final >= 7.8`
- `originality >= 7.8`
- `usefulness >= 7`
- `evidence_safety >= 8`
- `brief_alignment >= 7.5`

These thresholds appear well-calibrated and are not affected by the wording issue. The issue is purely in the AI's understanding of what "alignment" means.

### 3.4 near-pass-polish.ts (941 lines)

The polish function handles near-pass content — opportunities that scored close to the threshold but need improvement. The polish prompt does **not** explicitly define the account focus. Instead, it references the "brief" (which carries the angle from upstream), so the account focus is transmitted indirectly.

This is acceptable because the brief is constructed upstream using the (correct) pattern layer. However, the lack of an explicit account focus definition in the polish prompt means that if the brief is vague or if the polish AI drifts, there is no anchor to pull it back. Some comments in this file reference "niche" terminology.

**Status:** No wording mismatch, but indirect reliance on upstream correctness makes this fragile.

### 3.5 pipeline-worker.ts (3080 lines)

The pipeline worker orchestrates the full content generation flow. The `craftFromBrief` system prompt says:

`"focused on AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture"` — **CORRECT (S1.3 updated).**

This is the only AI prompt in the pipeline that uses the broadened S1.3 wording. It is also the prompt closest to final content generation, so it has the most direct impact on output. The fact that this prompt is correct while the upstream intelligence and judge prompts are not creates an inconsistency: the system discovers and judges opportunities against a narrow lens but generates content against a broad one.

Various comments in this file still reference "niche" terminology.

### 3.6 account-shield.ts (479 lines)

The account shield applies content-agnostic quality rules. It does not define account focus in any prompt. The `SLOP_FORBIDDEN_WORDS` list and low-follower rules are entirely content-agnostic — they filter based on language quality and source credibility, not topic alignment.

**Status:** No account-lens wording to audit. Correctly content-agnostic.

### 3.7 content-policy.ts (546 lines)

The content policy enforces 10 rules in `ENGLISH_ACCOUNT_CONTENT_POLICY`. These are content-agnostic (no misinformation, no hate speech, etc.) and do not reference the account lens.

**Status:** No account-lens wording to audit. Correctly content-agnostic.

### 3.8 Tests: phase-s1-3-account-growth-lens.test.ts

Contains 40 tests covering the S1.3 account growth lens. Tests use new "lens" terminology in some places and old "niche" terminology in others, reflecting the partial migration that occurred during S1.3.

**Status:** Mixed terminology, mirrors the codebase's naming debt.

---

## 4. Inconsistent Wording Found (Old Narrow vs. New Broad)

The core inconsistency is a split between two different account focus definitions circulating in the codebase:

| Definition | Files Using It |
|---|---|
| **Old (narrow):** "focused on AI × productivity × career growth" | `opportunity-intelligence.ts`, `opportunity-judge.ts` |
| **New (broad, S1.3):** "focused on AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture" | `pipeline-worker.ts` (craftFromBrief) |

### Impact Analysis

The old narrow wording excludes several topics that are on the S1.3 lens:

1. **Creator growth / internet business** — The old wording has no mention of creator economy, internet business models, or audience building. These are core S1.3 topics.
2. **Digital leverage / systems / tools** — The old wording implies productivity but doesn't explicitly call out the broader "digital leverage" framing that captures automation, no-code, and systems thinking.
3. **Useful digital culture** — The old wording has no cultural component at all. Under S1.3, cultural moments are on-lens when they yield operator/builder/creator insight.
4. **Builder / indie hacking framing** — The old wording says "productivity" which could mean anything, vs. the explicit "operators, builders" language that signals the target audience.

The practical effect is that the **intelligence layer** (which discovers opportunities) and the **judge layer** (which approves/rejects them) operate on a narrower understanding of the account than the **generation layer** (which writes the content). This creates a pipeline where:

- Some on-lens opportunities in creator growth, internet business, or digital culture may be scored lower or rejected by the AI in `opportunity-intelligence.ts`
- Some opportunities that pass the pattern scorer may be rejected by `opportunity-judge.ts` because the judge's AI prompt defines alignment more narrowly
- Content that makes it through to `pipeline-worker.ts` will be generated with the correct broad framing, creating a quality mismatch where the content is broader than the opportunity was evaluated for

---

## 5. Naming Debt Inventory (All Legacy "Niche" References)

The S1.3 transition introduced "account lens" terminology but did not rename existing code identifiers that use "niche." This creates a semantic gap where the code says "niche" but the intent is "account lens." The following inventory captures every known instance.

### 5.1 Function Names

| Current Name | Semantic Equivalent |
|---|---|
| `scoreNicheAlignment` | `scoreAccountLensAlignment` |
| `guardNicheAlignment` | `guardAccountLensAlignment` |
| `quickNicheFitScore` | `quickAccountLensFitScore` |

### 5.2 Type Names

| Current Name | Semantic Equivalent |
|---|---|
| `NicheAlignmentResult` | `AccountLensAlignmentResult` |

### 5.3 Type Fields

| Current Field | Semantic Equivalent |
|---|---|
| `is_off_niche` | `is_off_lens` |
| `off_niche_topics` | `off_lens_topics` |

### 5.4 Variable / Constant Names

| Current Name | Semantic Equivalent |
|---|---|
| `MIN_NICHE_FIT_SCORE` | `MIN_ACCOUNT_LENS_FIT_SCORE` |
| `niche_fit_score` (appears in opportunity-intelligence, opportunity-judge, pipeline-worker, candidate-selector) | `account_lens_fit_score` |

### 5.5 Rejection Reasons

| Current Value | Semantic Equivalent |
|---|---|
| `low_niche_fit` | `low_account_lens_fit` |

### 5.6 Recommendation

**Do NOT rename these identifiers now.** Renaming would cause churn across multiple files, test suites, and potentially database-stored rejection reasons. The risk of introducing bugs outweighs the benefit of naming consistency. Instead:

1. Add inline comments at each declaration site mapping "niche" → "account lens"
2. Update new code to use "lens" terminology going forward
3. Plan a dedicated renaming pass in a future cleanup sprint with full test coverage

---

## 6. Adjacent Topic Pattern Mismatch (Critical S1.3 Gap)

### 6.1 The Problem

`opportunity-intelligence.ts` declares `ALLOWED_ADJACENT_TOPICS` with 8 entries, each specifying a topic and a required angle:

| # | Topic | Required Angle | Has Pattern? |
|---|---|---|---|
| 1 | entertainment | ✅ | ✅ |
| 2 | sports | ✅ | ✅ |
| 3 | anime | ✅ | ✅ |
| 4 | movies | ✅ | ✅ |
| 5 | crypto/web3 | ✅ | ❌ **MISSING** |
| 6 | politics/policy | ✅ | ❌ **MISSING** |
| 7 | gaming | ✅ | ❌ **MISSING** |
| 8 | internet_trends | ✅ | ✅ |

`ADJACENT_TOPIC_PATTERNS` contains only 5 entries. The three missing pattern definitions (crypto/web3, politics/policy, gaming) mean that the system declares these as valid adjacent topics but has no regex patterns to detect them in opportunity text.

### 6.2 Impact

When an opportunity touches crypto/web3, politics/policy, or gaming:

1. The `ALLOWED_ADJACENT_TOPICS` list says the topic is allowed if the required angle is present
2. But `ADJACENT_TOPIC_PATTERNS` has no entry, so the pattern matcher cannot identify the topic as adjacent
3. The topic may then fall through to the off-lens pattern matcher, which categorizes crypto, politics, and gaming as off-lens
4. Result: **opportunities with valid adjacent-topic angles in crypto, politics, or gaming are incorrectly scored as off-lens**, even when they have the required angle

This is a structural bug, not a configuration issue. The pattern system is incomplete relative to its own declared adjacent-topic list.

### 6.3 Required Fix

Add pattern entries to `ADJACENT_TOPIC_PATTERNS` for the three missing topics:

- **crypto/web3**: Regex patterns for cryptocurrency, blockchain, DeFi, NFT, token, web3, etc.
- **politics/policy**: Regex patterns for regulation, legislation, policy, government, political, etc.
- **gaming**: Regex patterns for game, gaming, esports, streamer, etc.

Each pattern entry must also specify the required angle (matching what's in `ALLOWED_ADJACENT_TOPICS`) so that the transferable-angle detection can verify the angle is present.

---

## 7. Forced Angle Enforcement Verification

Forced angles are detected by `FORCED_ANGLE_PATTERNS` in `niche-alignment.ts` (9 regex patterns) and by the `BLOCKED_TOPICS` entry "forced/generic AI angle" in `opportunity-intelligence.ts`.

### 7.1 How Forced Angle Detection Works

1. When an off-lens topic is detected but a transferable angle is found, the system checks whether the angle is genuine or forced
2. `FORCED_ANGLE_PATTERNS` matches common forced-angle formulations like "how AI will change [off-lens topic]" or "what [off-lens topic] teaches us about AI"
3. If a forced angle is detected, the rescuing bonus from the transferable angle is negated, and the topic remains off-lens
4. In `opportunity-intelligence.ts`, the "forced/generic AI angle" blocked topic prevents the AI from even generating opportunities that rely on a forced AI framing

### 7.2 Verification Result

The forced-angle enforcement appears sound. The two-layer approach (pattern detection + AI blocked topic) provides robust coverage. The 9 regex patterns in `FORCED_ANGLE_PATTERNS` cover common forced-angle formulations, and the blocked topic in the intelligence layer prevents the AI from proposing forced-angle content in the first place.

**No issues found.** The forced angle system is consistent between the pattern layer and the AI layer.

---

## 8. Judge Strictness Verification

The judge in `opportunity-judge.ts` applies five thresholds:

| Metric | Threshold |
|---|---|
| `final` | >= 7.8 |
| `originality` | >= 7.8 |
| `usefulness` | >= 7 |
| `evidence_safety` | >= 8 |
| `brief_alignment` | >= 7.5 |

### 8.1 Threshold Consistency

These thresholds are appropriately stringent. The `final` and `originality` thresholds at 7.8 ensure that only high-quality, non-derivative content passes. The `usefulness` threshold at 7 is slightly lower, reflecting that usefulness is harder to score precisely. The `evidence_safety` threshold at 8 is the highest, reflecting the importance of factual accuracy. The `brief_alignment` threshold at 7.5 ensures that content stays on-lens.

### 8.2 The Wording Issue's Effect on Judge Strictness

The judge's AI prompt uses the old narrow wording, which means `brief_alignment` will be evaluated against a narrower lens than intended. This effectively makes the judge **more strict** than it should be for S1.3 content. Topics that are on the broadened lens (creator growth, internet business, digital culture) may score lower on `brief_alignment` because the AI's understanding of "alignment" is narrower.

This does not make the judge less strict — it makes it **wrongly strict** in the direction of the old narrow lens. The fix is to update the prompt wording, not to lower thresholds.

### 8.3 Near-Pass Handling

Near-pass content (scores just below threshold) is routed to `near-pass-polish.ts` for improvement. The near-pass flow does not re-define the account focus, relying instead on the brief. This is acceptable but fragile — see Section 3.4.

---

## 9. Publish Gate Verification

The publish gate is the final check before content is published. It operates at the intersection of:

1. **Account lens scoring** (`niche-alignment.ts`): Sets `off_niche = true` when score < 4
2. **Judge approval** (`opportunity-judge.ts`): Requires all thresholds met
3. **Account shield** (`account-shield.ts`): Content-agnostic quality gates
4. **Content policy** (`content-policy.ts`): Content-agnostic safety gates

### 9.1 Gate Consistency

The publish gate is enforced through the `guardNicheAlignment` function, which uses the pattern-level scoring from `niche-alignment.ts`. Because the pattern layer was updated for S1.3, this gate is correctly calibrated for the broadened lens.

However, the guard function name uses "niche" terminology, and the `off_niche` flag it sets uses the old naming. This is naming debt only — the logic is correct.

### 9.2 Gap: Judge Gate vs. Pattern Gate

There is a potential inconsistency between the judge gate and the pattern gate:

- The pattern gate uses the S1.3-broadened patterns (correct)
- The judge gate uses the old narrow AI prompt wording (incorrect)

This means a piece of content could pass the pattern gate (on-lens by S1.3 standards) but fail the judge gate (the judge AI evaluates alignment against the narrow old lens). This is the most impactful consequence of the wording inconsistency: **valid S1.3 content may be rejected at the judge gate.**

---

## 10. Recommended Consistency Fixes

The following fixes address the issues found in this audit. **No threshold changes are recommended** — the scoring thresholds are well-calibrated for S1.3 once the wording is corrected.

### 10.1 CRITICAL: Update AI Prompt Wording in opportunity-intelligence.ts

**Location:** Main AI prompt in `opportunity-intelligence.ts`
**Current:** `"focused on AI × productivity × career growth"`
**Change to:** `"focused on AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture"`
**Risk:** Low. This is a prompt string change, not a logic change. The AI will simply evaluate opportunities against the correct broadened lens.

### 10.2 CRITICAL: Update AI Prompt Wording in opportunity-judge.ts

**Location:** Judge AI prompt in `opportunity-judge.ts`
**Current:** `"focused on AI × productivity × career growth"`
**Change to:** `"focused on AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture"`
**Risk:** Low. Same rationale as 10.1. After this fix, the judge will evaluate alignment against the correct broadened lens, and the judge/pattern gate inconsistency will be resolved.

### 10.3 CRITICAL: Add Missing Adjacent Topic Patterns in opportunity-intelligence.ts

**Location:** `ADJACENT_TOPIC_PATTERNS` in `opportunity-intelligence.ts`
**Add:**
- `crypto/web3` pattern with required angle matching `ALLOWED_ADJACENT_TOPICS`
- `politics/policy` pattern with required angle matching `ALLOWED_ADJACENT_TOPICS`
- `gaming` pattern with required angle matching `ALLOWED_ADJACENT_TOPICS`
**Risk:** Medium. New regex patterns must be tested to ensure they match the intended topics without over-matching. Recommend adding corresponding test cases in `phase-s1-3-account-growth-lens.test.ts`.

### 10.4 MEDIUM: Add Account Focus Anchor to near-pass-polish.ts

**Location:** Polish AI prompt in `near-pass-polish.ts`
**Change:** Add an explicit account focus definition matching the S1.3 wording. Currently the polish prompt relies on the brief to carry the lens, but an explicit anchor would prevent drift when the brief is vague.
**Risk:** Low. Additive change; does not alter existing logic.

### 10.5 LOW: Add Inline Comments for Naming Debt

**Locations:** All identifiers listed in Section 5
**Change:** Add comments of the form `// Semantic: account lens (legacy: "niche")` at each declaration site.
**Risk:** None. Documentation-only change.

### 10.6 LOW: Update Diagnostic Messages

**Locations:** Any user-facing or log-facing messages that reference "niche fit" or "off niche"
**Change:** Update wording to use "account lens fit" / "off lens" while maintaining backward-compatible field names.
**Risk:** Low. Changes display text only; does not alter logic or data structures.

---

## 11. Semantic Name Mapping (Niche → Lens)

For future contributors, the following table provides the definitive mapping between legacy "niche" identifiers and their intended "account lens" semantics. When reading or modifying code that uses "niche" terminology, substitute the "lens" equivalent mentally to understand the intent.

### 11.1 Complete Mapping

| Legacy Identifier | Semantic Meaning | Notes |
|---|---|---|
| `scoreNicheAlignment()` | Account lens alignment scoring function | Scores topic fit against the account lens |
| `guardNicheAlignment()` | Account lens guard function | Blocks content that falls off the account lens |
| `quickNicheFitScore()` | Quick account lens fit pre-filter | Fast pre-check before full scoring |
| `NicheAlignmentResult` | Account lens alignment result type | Return type for alignment scoring |
| `is_off_niche` | Whether content is off the account lens | `true` when lens fit score < 4.0 |
| `off_niche_topics` | Topics that fall off the account lens | List of detected off-lens topic names |
| `MIN_NICHE_FIT_SCORE` | Minimum account lens fit score | Hardcoded threshold = 5 |
| `niche_fit_score` | Account lens fit score | Numeric score from alignment evaluation |
| `low_niche_fit` | Low account lens fit (rejection reason) | Canonical rejection reason enum value |
| `ALIGNED_PATTERNS` | On-lens patterns | No rename needed — "aligned" is lens-agnostic |
| `OFF_LENS_PATTERNS` | Off-lens patterns | Already uses "lens" — correct |
| `ALLOWED_ADJACENT_PATTERNS` | Allowed adjacent-to-lens patterns | Already lens-agnostic |

### 11.2 Database / Stored Values

Any rejection reasons stored in the database as `low_niche_fit` should be considered semantically equivalent to `low_account_lens_fit`. When querying or reporting on rejection reasons, map `low_niche_fit` → "Low Account Lens Fit" in user-facing displays.

### 11.3 Future Renaming Guidelines

When a dedicated renaming sprint is scheduled:

1. Start with type definitions (`NicheAlignmentResult` → `AccountLensAlignmentResult`)
2. Then update function names (`scoreNicheAlignment` → `scoreAccountLensAlignment`)
3. Then update field names (`is_off_niche` → `is_off_lens`)
4. Then update constants (`MIN_NICHE_FIT_SCORE` → `MIN_ACCOUNT_LENS_FIT_SCORE`)
5. Update rejection reason enum values last (requires database migration)
6. Run full test suite after each step
7. Update this audit document to reflect the completed renames

---

*End of Account Lens / Prompt Consistency Audit*
