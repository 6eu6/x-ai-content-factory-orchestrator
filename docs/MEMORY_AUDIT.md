# MEMORY AUDIT — Phase M1 Structured Memory System

**Date:** 2026-06-01
**Scope:** `lib/structured-memory-compaction.ts` (824 lines), `lib/structured-memory-retrieval.ts` (453 lines)
**DB Tables:** `compact_operator_rules`, `source_author_memory`, `memory_compaction_runs`
**Memory Injection Points:** craft (enrich step), near-pass polish
**Memory Non-Injection Points:** judge (by design — judge must be independent)

---

## 1. System Overview

The structured memory system is a two-phase pipeline: **compaction** converts raw pipeline failure signals into deterministic rules, and **retrieval** fetches the most relevant rules at craft and polish time. The system is entirely deterministic — no AI calls are used during compaction or retrieval. Rules are stored in Supabase and injected into prompts as compact text sections (never raw logs). The design intentionally avoids injecting memory into the judge phase to preserve judge independence and prevent circular feedback loops where memory rules could bias scoring in favor of patterns that previously failed.

The compaction pipeline reads from `pipeline_tasks` results for `opportunity_judge` and `publish_gate` task types, extracts structured failure signals (originality, brief alignment, usefulness, evidence safety, freshness), and maps each failure type to a deterministic rule with `rule_type`, `pattern`, `when_to_use`, `when_to_avoid`, and `suggested_fix`. Rules are upserted with deduplication on `(rule_type, pattern, source_author, topic_key)`. Source-author-level memory aggregates common topics, bad angles, failure reason distributions, and freshness behavior per author.

Retrieval uses a scoring function that weights exact source-author match (+3), topic-key overlap (+2), confidence (0–1), recency bonus (max +1 for rules seen in last 7 days), and support-count bonus (logarithmic, max +0.5). The system queries three pools — author-specific rules, general rules (null source_author), and topic-key-matched rules from other authors — then sorts by combined score. Output is capped at 10 items total: max 6 operator rules, max 4 anti-patterns, max 4 suggested fixes, with proportional trimming if the total exceeds 10.

---

## 2. Key Audit Questions

### Q1: Is memory source-author-specific only?

**Finding: NO — it is broader than source-author-specific.** Retrieval queries three pools: (1) exact `source_author` match, (2) general rules where `source_author IS NULL`, and (3) other-author rules where `topic_key` matches the inferred key. This means a craft step for source author `@naval` can receive rules originally derived from failures on `@emollick` content if they share the same `topic_key` (e.g., `ai_agents`). This cross-author transfer is by design and can be valuable, but it risks importing rules that are misaligned with the specific author's style.

**Risk: MEDIUM.** Cross-author rules may suggest fixes that don't apply to a different author's content pattern. The confidence scoring partially mitigates this, but there is no explicit "cross-author discount" in the scoring function — a general rule with high confidence from one author's failures will score identically to a rule from the current author.

### Q2: Is memory too biased toward one author?

**Finding: POSSIBLE.** If one source author dominates the scan pool (e.g., a high-output account that generates many failures), that author will accumulate more rules with higher support counts. Since retrieval orders by confidence and support count, dominant-author rules will surface more frequently even for other authors' content. The scoring function gives a +3 bonus for exact author match, but the general pool (source_author IS NULL) and topic-key pool have no author-balance normalization.

**Risk: MEDIUM.** A single prolific but low-quality source author could flood the rule database with anti-patterns that are overly specific to that author's content style, polluting retrieval for all other authors.

### Q3: Are low-confidence rules being retrieved?

**Finding: YES.** Confidence is a scoring factor (+confidence to score, range 0–1) but NOT a hard filter. A rule with confidence 0.1 can be retrieved if it has a strong source-author match (+3) and topic-key overlap (+2), giving it a total score of 5.1 — potentially outranking a confidence-0.8 rule with no author match (score 0.8). The initial query does order by `confidence DESC` and limits to 30, but this is applied per-pool before combining, so low-confidence author-specific rules enter the combined pool.

**Risk: HIGH.** Low-confidence rules are essentially unvalidated hypotheses. Injecting them into craft/polish prompts wastes token budget and may mislead the model. A hard confidence floor of 0.4 would eliminate the worst offenders while preserving the scoring dynamics for medium-to-high confidence rules.

### Q4: Are duplicate rules accumulating?

**Finding: PARTIALLY MITIGATED.** Dedup uses exact match on `(rule_type, pattern, source_author, topic_key)`. The `upsertCompactRules` function checks for existing rules with these exact fields and increments `support_count` + recalculates `confidence` as a weighted average. However, **near-duplicates** are not detected. Two rules like "Restating the source as a summary without adding a mechanism" and "Summarizing the source without a tradeoff or operator rule" would be stored as separate rules even though they describe the same anti-pattern. The deterministic compaction logic uses fixed `pattern` strings per failure type (e.g., originality failures always map to "Restating the source as a summary..."), which limits the near-duplicate problem for standard failure types. But the `final_score_below_7.8` catch-all case generates dynamic patterns that can accumulate near-duplicates.

**Risk: LOW-MEDIUM.** Standard failure types are well-deduplicated. The `final_score_below_7.8` catch-all is the main near-duplicate risk.

### Q5: Are rules actionable or generic?

**Finding: MIXED.** Standard failure types produce specific, actionable rules with concrete `suggested_fix` values (e.g., "Add a concrete action, checklist, decision rule, or when-to-use condition. Avoid pure observation." for usefulness failures). However, the `final_score_below_7.8` catch-all produces rules like "Focus on improving: originality, usefulness" which is generic and provides no specific guidance. The `example_better` field is always empty for compacted rules — a significant gap, since the model receives anti-patterns but no positive examples.

**Risk: MEDIUM.** Generic rules waste prompt tokens. Empty `example_better` means the model gets told what NOT to do but not what TO do, reducing the effectiveness of memory injection.

### Q6: Does memory help avoid repeated mistakes?

**Finding: SHOULD IN THEORY, NEEDS EMPIRICAL VALIDATION.** The compaction pipeline extracts signals from judge failures and freshness rejections, creating rules that warn against the same patterns. The retrieval pipeline injects these warnings into craft and polish prompts. However, there is no feedback loop that measures whether rules actually reduce failure rates. The `memory_compaction_runs` table tracks compaction metadata but not downstream outcomes. Without an A/B comparison (craft with memory vs. craft without memory), it is impossible to say definitively whether memory improves quality.

**Risk: MEDIUM.** The system may be generating and injecting rules that have no measurable impact, consuming tokens and complexity without benefit.

### Q7: Are anti-patterns overrepresented?

**Finding: POSSIBLE.** The compaction pipeline only extracts signals from failures (judge rejections, freshness rejections, publish_gate rejections). There is no mechanism to extract positive signals from passed opportunities. This means the `anti_pattern` rule type will always dominate, and `winning_angle` and `source_pattern` rules (which are queried in the `operatorRules` category) will never have entries from compaction. The retrieval code filters for these types, but if they don't exist in the database, the operator rules section of the memory prompt will always be empty.

**Risk: HIGH.** An entirely negative memory system (only anti-patterns, no winning patterns) creates a punitive framing that may cause the model to be overly conservative, avoiding risks that could lead to high-quality content.

### Q8: Does memory support broad Account Growth Lens after S1.3?

**Finding: NEEDS VERIFICATION.** The `inferTopicKey` function uses a fixed list of 16 regex patterns (ai_agents, llm, rag, fine_tuning, etc.) with a fallback to the first 3 words from combined text. This list is narrow and AI-centric. After S1.3 (Account Growth Lens), the system can broaden niche coverage, but the topic key inference cannot detect topics outside the regex list. A tweet about "remote work culture" or "personal finance automation" would fall to the word-based fallback, producing keys like `remote_work_culture` or `personal_finance_automation` that won't match any existing rules (since rules from similar topics would have different fallback keys).

**Risk: HIGH.** The topic key inference is too narrow for the broader niche coverage that S1.3 enables. Memory rules for new topic areas will never be retrieved because the topic keys won't match.

### Q9: Is there a cleanup/decay strategy?

**Finding: NO.** There is no TTL, no auto-pruning, and no confidence decay. Rules accumulate forever. The `last_seen_at` field is updated on dedup upsert, but it is never used for cleanup. A rule created in week 1 that hasn't been seen in 6 months still has the same confidence and can still be retrieved. The retrieval scoring gives a recency bonus for rules seen in the last 7 days, but this only affects ranking, not filtering — stale rules are still retrieved, just ranked slightly lower.

**Risk: HIGH.** Without decay, the rule database will grow unboundedly. Stale rules that no longer reflect the current content landscape will pollute retrieval and waste prompt tokens. A rule about "fine_tuning" from 6 months ago may be irrelevant if the discourse has moved on to "reasoning models."

### Q10: Is there a promotion strategy from low to high confidence?

**Finding: YES, BUT PASSIVE.** The `upsertCompactRules` function recalculates confidence as a weighted average when a rule is seen again: `newConfidence = min(0.95, (existingConfidence * existingSupportCount + rule.confidence) / newSupportCount)`. This means a rule with initial confidence 0.5 will increase to ~0.67 after 2 observations, ~0.75 after 3, etc. However, confidence never increases without re-observing the same exact failure. There is no mechanism to promote a rule based on downstream success (e.g., "this rule prevented 5 failures this week"). The promotion is purely frequency-based, not outcome-based.

**Risk: MEDIUM.** Rules that are correct but rare (low support count) will remain at low confidence. Conversely, rules that are wrong but frequently re-observed (because the model keeps making the same mistake) will gain high confidence through sheer repetition.

---

## 3. Proposed M1.1 Improvements

### M1.1-1: Confidence Floor for Retrieval

**Change:** Add a hard filter `confidence >= 0.4` to all retrieval queries. This eliminates unvalidated rules from the prompt while preserving the scoring dynamics for medium-to-high confidence rules. The `inferRuleTypes` function should also filter by minimum confidence when building the query.

**Implementation:** In `getRelevantStructuredMemory`, add `.gte('confidence', 0.4)` to all three Supabase queries (authorRules, generalRules, topicRules).

**Impact:** Reduces noise in memory prompts. Estimated 20–40% reduction in retrieved rules for new/low-activity topic areas.

### M1.1-2: Near-Duplicate Detection

**Change:** Before inserting a new rule, check for existing rules with the same `rule_type` and `source_author` where the `pattern` field has Jaccard similarity > 0.7. If found, merge into the existing rule (increment support_count, average confidence) instead of inserting a new row.

**Implementation:** Add a `findNearDuplicateRule` function that queries `compact_operator_rules` with `rule_type` and `source_author` filters, computes Jaccard similarity on word sets, and returns the best match if similarity exceeds threshold.

**Impact:** Prevents rule table bloat. Estimated 10–20% reduction in total rules after cleanup.

### M1.1-3: Confidence Decay

**Change:** Auto-decrease confidence for rules not seen in 30+ days. A daily maintenance job (triggered via `/api/memory-maintenance-run`) should scan `compact_operator_rules` where `last_seen_at < now() - interval '30 days'` and multiply confidence by 0.9 (minimum 0.1). Rules below confidence 0.1 after decay should be soft-deleted (set `active = false`).

**Implementation:** Add a `decayStaleMemoryRules` function. Add `active` boolean column to `compact_operator_rules` (default true). Update retrieval queries to filter `active = true`.

**Impact:** Prevents stale rule accumulation. Ensures memory reflects recent patterns.

### M1.1-4: Global vs Source-Specific Separation

**Change:** Add a `scope` field to `compact_operator_rules`: `source_specific` (has source_author), `global` (no source_author but high support_count >= 3), or `cross_author` (no source_author, low support_count). Retrieval should prefer `global` rules first (they've been validated across authors), then `source_specific`, then `cross_author`.

**Implementation:** Add `scope` column. Update `upsertCompactRules` to set scope based on source_author and support_count. Update `scoreRule` to add scope-based bonus.

**Impact:** Better retrieval quality. Global rules (validated across multiple authors) should be weighted higher than author-specific rules that haven't been generalized.

### M1.1-5: Account-Lens Memory (Topic Coverage Tracking)

**Change:** Extend `source_author_memory` to include a `topic_coverage` field that tracks which topic_keys have been successfully crafted vs. failed. This enables the system to identify topic blind spots — areas where the account consistently fails to produce quality content.

**Implementation:** Add `topic_coverage` JSONB column to `source_author_memory`. Update `updateSourceAuthorMemory` to track per-topic success/failure counts from judge results.

**Impact:** Enables S1.3 Account Growth Lens to identify which new topic areas need more source diversity vs. which are already well-covered.

### M1.1-6: Forced-Angle Memory

**Change:** Track which source authors trigger forced angles (i.e., the recommended_angle diverges significantly from the obvious take). Store a `forced_angle_patterns` field in `source_author_memory` with the angle types and their success rates.

**Implementation:** Add `forced_angle_patterns` JSONB column. Extract forced-angle signals from `opportunity_intelligence` task results during compaction.

**Impact:** Helps the system learn which authors consistently require angle reframing vs. which produce content where the obvious take works.

### M1.1-7: Source-Performance Memory Integration

**Change:** Integrate `source_quality_scores` (from the S1.3 phase) into the retrieval scoring function. A source author with consistently low quality scores should have their rules ranked lower, since failures from low-quality sources may reflect source problems rather than craft problems.

**Implementation:** Query `source_quality_scores` during retrieval. Add a `sourceQualityModifier` to `scoreRule` that reduces the score for rules from low-quality sources.

**Impact:** Prevents memory from being polluted by rules derived from low-quality source content that was doomed to fail regardless of the craft approach.

---

## 4. Summary Risk Matrix

| Risk | Severity | Current Mitigation | Proposed Fix |
|------|----------|--------------------|-------------|
| Low-confidence rules retrieved | HIGH | Confidence is scoring factor, not filter | M1.1-1: Hard floor at 0.4 |
| No confidence decay | HIGH | `last_seen_at` exists but unused | M1.1-3: 30-day decay + soft delete |
| Anti-patterns only, no winning patterns | HIGH | None — compaction only reads failures | Add positive signal extraction |
| Topic key inference too narrow | HIGH | 16 regex patterns + word fallback | M1.1-5: Topic coverage tracking |
| Near-duplicate accumulation | LOW-MEDIUM | Exact dedup exists | M1.1-2: Jaccard similarity merge |
| Cross-author rule pollution | MEDIUM | Author match bonus in scoring | M1.1-4: Scope-based separation |
| Author dominance bias | MEDIUM | Author match bonus helps | M1.1-7: Source quality modifier |
| Generic catch-all rules | MEDIUM | Fixed patterns for standard types | Improve catch-all rule quality |
| No empirical validation | MEDIUM | Compaction runs logged | Add outcome tracking |
| Passive confidence promotion | MEDIUM | Support-count-based averaging | Add outcome-based promotion |

---

## 5. Acceptance Criteria for M1.1

1. No rule with `confidence < 0.4` is returned by `getRelevantStructuredMemory`
2. Rules not seen in 30+ days have confidence decayed by 0.9x daily
3. Rules with `confidence < 0.1` after decay are soft-deleted (`active = false`)
4. Near-duplicate detection prevents insertion of rules with >70% Jaccard similarity to existing rules
5. Global rules (high support, no author) are weighted higher than cross-author rules
6. Topic coverage tracking exists in `source_author_memory`
7. All existing tests pass after changes
8. New tests cover confidence floor, decay, near-duplicate, and scope logic
