# Quality Pipeline Logic Audit

**Project:** x-ai-content-factory-orchestrator  
**Scope:** End-to-end quality chain from tweet scanning through publish decision  
**Date:** 2025-03-04  
**Status:** Comprehensive logic review — identifies gaps, failure modes, and diagnostic blind spots

---

## Pipeline Quality Chain Overview

The content factory orchestrator processes raw tweet candidates through ten sequential stages, each acting as a filter, enhancer, or gate. Every stage has the potential to reject, transform, or duplicate content. This audit examines each stage against eight diagnostic dimensions and identifies systemic issues that span stage boundaries.

```
Scan Prefilter → Opportunity Intelligence → Multi-Candidate Crafting → Candidate Selection
→ Quality Enhance → Opportunity Judge → Near-Pass Polish → Account Shield → Publish Gate → Decision Engine
```

---

## Stage 1: Scan Prefilter (tweet-candidate-scorer.ts)

### Purpose
The scan prefilter is the first line of defense in the quality chain. It applies pure heuristic scoring to incoming tweet candidates from monitored accounts, selecting only the most promising items for deeper AI evaluation downstream. By filtering at this early stage with deterministic rules rather than AI calls, it controls cost and latency while ensuring that downstream stages only process content with baseline relevance.

### What It Rejects
- Tweets that fail to meet engagement thresholds (likes, retweets, replies)
- Content lacking niche keyword matches against the 10 NICHE_KEYWORDS regex patterns (AI/ML, automation, creator economy, startup, career, algorithms, tech tools)
- Tweets matching any of the 4 GIVEAWAY_PATTERNS (giveaway, announcement, AMA, follow-me) — these are categorically excluded as they represent promotional noise rather than insight opportunities
- Near-duplicate tweets detected by text similarity deduplication, preventing redundant processing of the same viral content across multiple accounts

### What It Allows
- Up to 8 tweets per account per scan cycle (the Top-N selection boundary)
- Any tweet with sufficient engagement signals even if keyword match is partial
- Content that matches hook patterns indicative of original insight or contrarian takes
- Tweets that are substantively distinct even if they reference the same external event or URL

### What Can Pass Incorrectly
- Engagement-farmed content that hits keyword patterns without substantive depth (e.g., a viral thread that mentions "AI" repeatedly but contains no actionable insight)
- Retweets of niche-adjacent accounts that superficially match patterns but lack the originality that downstream stages require
- Content where the hook pattern match is syntactic rather than semantic — regex cannot distinguish "5 AI tools you need" (listicle spam) from genuine tool analysis
- The 8-tweet-per-account ceiling can be too generous for high-volume accounts that tweet frequently, passing marginal content that dilutes the candidate pool

### What Gets Duplicated
- The same viral tweet referenced by multiple monitored accounts can enter the pipeline multiple times before deduplication runs
- Quote-tweet chains referencing the same source tweet produce near-identical candidates
- If deduplication runs per-account rather than globally, cross-account duplicates survive into Stage 2

### What Is Expensive
- The engagement signal computation requires API calls to fetch metrics for each candidate
- Deduplication by text similarity requires pairwise comparison, which is O(n²) in the worst case within an account's candidate set
- Hook pattern matching across 10+ regex patterns on every tweet body adds measurable CPU time at scale

### What Diagnostics Exist
- Candidate counts per account before and after filtering
- NICHE_KEYWORDS match rates (which keywords fire most)
- GIVEAWAY_PATTERNS rejection counts
- Deduplication hit rates

### What Is Missing
- No semantic deduplication — two tweets with different wording but identical claims both pass
- No tracking of which accounts consistently produce candidates that fail downstream, which would enable source-level quality feedback
- No dynamic adjustment of the Top-N ceiling based on account quality history
- No measurement of how many Stage 2 rejections could have been caught at Stage 1 with improved heuristics
- No logging of the specific engagement thresholds that triggered selection, making it impossible to calibrate them

---

## Stage 2: Opportunity Intelligence (opportunity-intelligence.ts)

### Purpose
Opportunity intelligence is the first AI-powered evaluation in the pipeline. It performs a two-phase assessment: a fast heuristic pre-filter (quickNicheFitScore) that short-circuits blocked topics immediately, followed by a full AI evaluation using callModel('opportunity_intelligence') with a JSON schema response. This stage determines whether a tweet candidate contains a genuine content opportunity worth crafting into a post, measuring publishability, originality, niche fit, and usefulness against hard rule thresholds.

### What It Rejects
- Blocked topics caught by quickNicheFitScore — these short-circuit immediately without consuming AI tokens
- Opportunities failing MIN_PUBLISHABILITY_SCORE = 7.5 (relaxed to 7.0 only if originality >= 7.5 AND niche_fit >= 5)
- Opportunities failing MIN_ORIGINALITY_POTENTIAL_SCORE = 7
- Opportunities failing MIN_NICHE_FIT_SCORE = 5
- Opportunities failing MIN_USEFULNESS_SCORE = 6 (relaxed to 5 if viral_context >= 8 AND angle >= 30 chars)
- The 12 CANONICAL_REJECTION_REASONS: blocked_topic, forced_angle, generic_only, intelligence_parse_failed, low_originality_potential, low_niche_fit, low_usefulness, unsupported_claim_risk, no_clear_angle, language_or_context_mismatch, insufficient_context, weak_source

### What It Allows
- Opportunities that meet all threshold requirements, even if some dimensions are borderline
- Rescue pass opportunities: up to 2 per run, requiring niche_fit >= 8 and publishability >= 7 — this catches niche-deep content that may score lower on general publishability
- Relaxation-path opportunities where compensating strengths (high originality compensating for slightly lower publishability, or high viral context compensating for lower usefulness)

### What Can Pass Incorrectly
- intelligence_parse_failed rejections may be masking valid opportunities — if the model returns malformed JSON, the opportunity is rejected regardless of its intrinsic quality. Historically this failure mode was non-trivial in frequency
- generic_only is a high-count rejection reason — the question is whether this represents healthy strictness against bland content or over-rejection of legitimately broad-but-valuable topics
- The relaxation paths (e.g., viral_context >= 8 lowering the usefulness gate) can admit trending-but-shallow content that lacks durable insight
- The rescue pass's niche_fit >= 8 requirement may be too permissive if niche_fit scoring is inflated for certain topic clusters

### What Gets Duplicated
- If the same opportunity enters from two different source tweets (not caught by Stage 1 dedup), it will be evaluated twice, potentially producing two separate opportunity records
- The rescue pass can create overlap with initially-passed opportunities if scoring is borderline

### What Is Expensive
- The AI evaluation call (callModel('opportunity_intelligence')) consumes tokens for every candidate that passes the heuristic pre-filter
- Parse failures waste the full AI call cost without producing a usable result
- The rescue pass adds up to 2 additional AI evaluations per run

### What Diagnostics Exist
- CANONICAL_REJECTION_REASONS distribution — which reasons dominate
- Pass/fail counts with and without relaxation
- Rescue pass utilization (how many of the 2 slots are typically used)
- AI call latency and token consumption metrics

### What Is Missing
- No structured logging of the exact AI output that triggered intelligence_parse_failed, making parser debugging impossible
- No A/B comparison of generic_only rejections against downstream judge scores to determine if they are truly generic
- No feedback loop from Stage 6 (Judge) rejection reasons back to Stage 2 scoring calibration
- No tracking of relaxation-path outcomes — do relaxed-threshold opportunities perform worse at final publish?
- No measurement of quickNicheFitScore false-positive rate (blocked topics that would have passed AI evaluation)

---

## Stage 3: Multi-Candidate Crafting (pipeline-worker.ts craftFromBrief)

### Purpose
Multi-candidate crafting generates three distinct variants of a post for each approved opportunity brief. The three variant types — brief_faithful, signature_original, and operator_heuristic — represent different creative strategies. brief_faithful closely follows the opportunity brief's angle and evidence; signature_original injects the account's unique voice and perspective; operator_heuristic applies operator-defined rules and takeaways. This multi-variant approach increases the probability that at least one candidate will pass downstream quality gates while offering stylistic diversity.

### What It Rejects
- Model outputs that fail local validation: JSON wrapper detection (the model sometimes wraps its response in markdown code blocks or JSON objects), invented personal experience claims (the model hallucinating firsthand stories), generic praise patterns (empty accolades like "this is a great insight"), do_not_claim violations (asserting things the brief explicitly forbids), and length violations (40-character hard limit minimum)
- Candidates with brief alignment scoring below a practical threshold (scored 1-10, with low scores indicating the output drifted from the brief)
- Parse failures where the model output cannot be extracted into the expected candidate structure

### What It Allows
- Up to 3 candidates per opportunity, each with a different variant_type
- Candidates that pass local validation even if they have minor stylistic imperfections
- Variant-specific trade-offs: signature_original may have lower brief alignment but higher originality; brief_faithful may have higher alignment but lower voice

### What Can Pass Incorrectly
- Parse failures are still possible with model output — if the model returns unexpected formatting (e.g., nested JSON, escaped characters, non-UTF8 content), the parser may silently produce a malformed candidate object rather than rejecting it
- Local validation checks are heuristic and can miss subtle invented experiences or generic praise that reads as specific but is actually vacuous
- The 40-character hard limit is a floor, not a quality measure — a 41-character candidate can be just as vacuous as a 39-character one that gets rejected
- do_not_claim violations that are semantically equivalent but phrased differently can evade keyword-based detection

### What Gets Duplicated
- If two variant types converge on similar wording (model collapse), the pipeline produces redundant candidates that downstream dedup must catch
- The same factual claim from the brief may appear in all three variants, creating apparent duplication at the claim level

### What Is Expensive
- Three AI model calls per opportunity (one per variant), using deepseek/deepseek-chat-v3-0324
- Brief alignment scoring requires an additional evaluation pass (or at minimum string similarity computation)
- Parse failure recovery adds latency and potentially retry costs

### What Diagnostics Exist
- Per-variant pass/fail counts from local validation
- Brief alignment score distributions per variant_type
- Model output parse failure rates
- Token consumption per variant

### What Is Missing
- No measurement of variant convergence rate (how often do two variants produce near-identical text?)
- No fallback crafting strategy when all 3 variants fail validation — the opportunity simply has zero candidates
- No logging of the raw model output before parsing, which would enable post-hoc parser improvement
- No comparison of deepseek-chat-v3-0324 against alternative models for crafting quality and parse reliability
- No tracking of which local validation checks fire most frequently, which would indicate where the model needs better prompting

---

## Stage 4: Candidate Selection (candidate-selector.ts)

### Purpose
Candidate selection reduces the candidate pool from up to 3 variants per opportunity to a manageable set for AI judging. It performs local pre-selection using a composite scoring formula: brief_alignment + originality_indicators + signature_voice + operator_takeaway + evidence_safety - generic_hype - abstract_penalty. This formula rewards candidates that are aligned, original, voice-authentic, actionable, and evidence-grounded while penalizing generic hype and abstract vagueness. The stage limits submission to max 2 candidates per opportunity for AI judging, and only admits the second candidate if it is a different variant_type AND within 1.5 points of the first.

### What It Rejects
- The weakest candidate(s) per opportunity when 3 are produced — at most 2 survive to judging
- A second candidate that is the same variant_type as the first (enforcing diversity)
- A second candidate that is more than 1.5 points behind the first in composite score (enforcing quality threshold)
- After the AI judge completes, duplicate candidates from the same source are deduplicated, keeping only the best

### What It Allows
- Up to 2 candidates per opportunity to proceed to judging
- Candidates with high composite scores even if individual dimensions are weak (a candidate with strong brief_alignment and originality but weak operator_takeaway can still pass)
- Variant diversity: brief_faithful + signature_original combinations are preferred over two brief_faithful candidates

### What Can Pass Incorrectly
- The composite scoring formula weights are fixed and may not reflect actual downstream judge preferences — brief_alignment may be over/under-weighted relative to its actual predictive power for final publish quality
- The 1.5-point threshold for the second candidate is arbitrary and may be too tight (rejecting a legitimately different but slightly lower-scoring variant) or too loose (wasting judge tokens on a clearly inferior candidate)
- The generic_hype penalty may be insufficient for subtle hype patterns that the judge later catches
- abstract_penalty requires detecting abstract language, which is difficult with heuristic rules and may both over-penalize conceptual content and under-penalize vague language

### What Gets Duplicated
- Post-judge deduplication keeps the best per source, but if two opportunities from different sources reference the same core claim, both candidates may survive
- The variant_type constraint prevents type duplication but not content duplication between variant types

### What Is Expensive
- Composite scoring computation is lightweight (local heuristics)
- The real cost is downstream — submitting 2 candidates instead of 1 doubles the AI judge cost for that opportunity
- Deduplication after judging requires comparing judged candidates, which involves text similarity computation

### What Diagnostics Exist
- Composite score distributions per candidate
- How often the second candidate is selected vs. rejected by the 1.5-point rule
- Variant_type pair distributions (which combinations reach judging)
- Post-judge deduplication hit rates

### What Is Missing
- No correlation analysis between composite scores and downstream judge scores — are the scoring formula weights actually predictive?
- No tracking of whether the second selected candidate ever wins over the first in the final decision — if it never does, the second-slot policy wastes resources
- No measurement of post-selection deduplication effectiveness at the claim level
- No dynamic adjustment of the 1.5-point threshold based on observed judge score deltas
- No accounting for post length policy in the composite score — a candidate that is excellent but 300 characters may be penalized differently than one at 200 characters, but the selection formula doesn't explicitly model this

---

## Stage 5: Quality Enhance (pipeline-worker.ts processQualityEnhance)

### Purpose
Quality enhance is a multi-sub-stage processing step that transforms raw crafted candidates into polished, validated content ready for final judging. It runs five sequential sub-processes: text cleaning (crafted-text-cleaner.ts) strips JSON artifacts and extracts from wrappers; niche guard (niche-alignment.ts) scores and guards niche alignment; brief alignment gate (validateBriefAlignment) enforces a minimum score of 7.0; originality enhancer (originality-enhancer.ts) runs AI self-critique and rewrite for candidates scoring below 7.8 in originality; and numeric claim guard (numeric-claim-guard.ts) detects, verifies against source, and rewrites or rejects unsupported numeric claims. Finally, quality validation (quality-validator.ts) runs 8 comprehensive checks.

### What It Rejects
- Text that cannot be cleaned from JSON wrappers or malformed model output
- Content failing niche alignment guard (scoreNicheAlignment + guardNicheAlignment)
- Candidates with brief alignment score below 7.0 (hard gate)
- Numeric claims that cannot be verified against the source and cannot be successfully AI-rewritten
- Quality validation failures across 8 checks: JSON wrapper presence, Arabic text detection, AI slop patterns, length violations, niche score below 4, and unsupported numeric claims

### What It Allows
- Candidates that pass all 5 sub-stages, even if some required AI-assisted repair
- Originality-enhanced content that was rewritten by AI to improve from below 7.8 to above threshold
- Numeric claims that are verified against source text or successfully rewritten to be source-grounded
- Brief-aligned content at the 7.0 threshold boundary

### What Can Pass Incorrectly
- The text cleaner may strip valid content that happens to resemble JSON formatting (e.g., a tweet about programming that includes JSON examples)
- The originality enhancer's AI self-critique may introduce new claims or subtly alter the meaning while improving the originality score — the brief alignment check runs before the enhancer, so post-enhancement drift is undetected
- The numeric claim guard's source verification is limited to the source text provided — if the source itself contains incorrect numbers, the guard will validate against incorrect data
- The niche alignment score threshold of 4 in quality validation is very low, potentially allowing content that is only tangentially niche-relevant
- AI slop detection patterns may have false negatives for novel slop patterns not in the detection set

### What Gets Duplicated
- If the originality enhancer rewrites a candidate, both the original and rewritten versions may briefly exist in memory, though only the rewritten version should proceed
- Numeric claim guard may produce multiple rewrite attempts for the same claim, though only the last should survive

### What Is Expensive
- The originality enhancer requires an AI call (self-critique + rewrite) for every candidate below the 7.8 threshold — this is potentially the majority of candidates
- The numeric claim guard requires AI calls for claim verification and rewriting when unsupported claims are detected
- Multiple AI calls within a single enhance step increase latency and token consumption significantly

### What Diagnostics Exist
- Per sub-stage pass/fail counts
- Originality score before and after enhancement
- Numeric claim detection rates and verification outcomes
- Quality validator check-level failure breakdown (which of the 8 checks fire most)
- Brief alignment score distributions

### What Is Missing
- No end-to-end timing breakdown per sub-stage — it's unclear which sub-stage dominates latency
- No measurement of originality enhancer side effects — does the rewrite introduce brief alignment drift or new unsupported claims?
- No tracking of the rate at which quality-validator catches issues that earlier sub-stages should have caught (indicating sub-stage gaps)
- No comparison of niche-alignment scores between the niche guard and the judge's niche_fit score to calibrate consistency
- No logging of the specific AI slop patterns that fire, which would help expand the detection set
- No measurement of whether the brief alignment threshold of 7.0 is too permissive — do candidates at 7.0-7.5 pass the judge's brief_alignment gate (7.5) in Stage 6?

---

## Stage 6: Opportunity Judge (opportunity-judge.ts)

### Purpose
The opportunity judge is the definitive AI evaluation of a crafted candidate, scoring it across six dimensions on a 1-10 scale: originality (25% weight), usefulness (20%), niche_fit (15%), evidence_safety (15%), clarity (10%), and brief_alignment (15%). The weighted composite produces a final score, but hard pass thresholds must also be met independently: final >= 7.8, originality >= 7.8, usefulness >= 7, evidence_safety >= 8, and brief_alignment >= 7.5. Before the AI judge runs, a heuristic pre-check screens for generic bait patterns and unsupported numeric claims, providing a fast rejection path that avoids AI judge costs for clearly problematic content.

### What It Rejects
- Heuristic pre-check failures: content matching any of the 12 generic bait patterns (yo, hot take, this., game changer, etc.) or any of the 8 unsupported numeric claim patterns
- Candidates failing any hard pass threshold, even if the composite score is above 7.8
- Content flagged with UNFIXABLE_FAILURE_REASONS: generic_bait, unsupported_claim, judge_parse_failed, malformed_json, text_is_json_wrapper — these cannot be recovered by polishing
- AI judge outputs that cannot be parsed (judge_parse_failed) — these are treated as rejections

### What It Allows
- Candidates that meet all hard pass thresholds and composite score requirements
- Content that passes the heuristic pre-check even if it has borderline generic patterns
- Candidates with low clarity (only 10% weight) if other dimensions are strong enough to compensate

### What Can Pass Incorrectly
- The 12 generic bait patterns are a fixed set — novel bait patterns not in the list will pass the heuristic pre-check, and the AI judge may not catch subtle bait either
- judge_parse_failed converts a potentially excellent candidate into a rejection — this is a parser fragility issue, not a quality issue
- The evidence_safety threshold of 8 is the highest absolute threshold (tied with originality), which is appropriate for safety but may be overly conservative if the judge model inflates risk perception for certain claim types
- The brief_alignment hard threshold of 7.5 is higher than the quality enhance gate of 7.0, creating a gap where candidates that pass Stage 5 are rejected at Stage 6 for the same dimension — this is intentional but should be monitored for gap magnitude
- AI model scoring may exhibit anchoring bias where the first dimension scored influences subsequent scores

### What Gets Duplicated
- If the same candidate enters judging from parallel processing paths (unlikely but possible in concurrent execution), duplicate judge scores may be produced
- The generic bait heuristic and the AI judge may both flag the same content, producing redundant rejection signals

### What Is Expensive
- The AI judge call is one of the most expensive per-candidate operations in the pipeline
- Heuristic pre-check rejections save the AI judge cost, making pre-check coverage critical for cost efficiency
- judge_parse_failed wastes the full AI judge cost without producing a usable score

### What Diagnostics Exist
- Per-dimension score distributions
- Hard pass threshold violation breakdown (which thresholds reject most)
- Heuristic pre-check rejection rates and pattern-level breakdown
- UNFIXABLE_FAILURE_REASONS distribution
- Judge parse failure rates

### What Is Missing
- No calibration of AI judge scores against human evaluations — it's unknown whether the 1-10 scale maps consistently to human quality judgments
- No measurement of inter-judge consistency (if the same candidate were judged twice, would scores be within 0.5 points?)
- No tracking of the heuristic pre-check false-positive rate (content rejected as generic bait that would have scored well)
- No analysis of which dimension thresholds reject the most candidates and whether any should be adjusted
- No logging of the raw AI judge output before parsing to enable parser debugging and improvement
- No detection of score compression (e.g., the model only using the 6-8 range rather than the full 1-10 scale)

---

## Stage 7: Near-Pass Polish (near-pass-polish.ts)

### Purpose
Near-pass polish attempts to rescue candidates that scored close to the judge's pass threshold but fell short. It targets candidates with final scores between 6.8 and 7.8, evidence_safety >= 7.5, niche_fit >= 7, text length between 40 and 400 characters, and no unfixable flags. This stage represents the pipeline's commitment to not wasting good opportunities that are only slightly below bar. It uses AI-powered polishing with targeted failure instructions, originality enhancement, signature voice injection, brief lock enforcement, and memory context. After polishing, the candidate is re-judged, and the polished version replaces the original only if improvement >= 0.5 points, evidence safety does not decrease, and no new hard failures are introduced. A micro-repair sub-path handles brief_alignment-only issues with stricter requirements.

### What It Rejects
- Candidates outside the eligibility window (final < 6.8 or > 7.8, evidence < 7.5, niche_fit < 7, text outside 40-400 chars)
- Candidates with any unfixable flags (generic_bait, unsupported_claim, judge_parse_failed, malformed_json, text_is_json_wrapper)
- Polished candidates that fail the improvement threshold (< 0.5 points gain)
- Polished candidates where evidence_safety decreased
- Polished candidates that introduce new hard failures
- Micro-repair candidates failing the stricter requirements (brief_alignment 6.8-7.5 only, final >= 7.8, originality >= 7.8, evidence >= 8 required)
- More than 2 polish attempts per run (hard budget)

### What It Allows
- Polished candidates with >= 0.5 point improvement over original
- Micro-repaired candidates that fix brief_alignment in isolation
- Content that gains originality or voice quality through the polish, even if the improvement comes primarily from one dimension

### What Can Pass Incorrectly
- The polish AI may subtly alter factual claims or introduce new unsupported assertions while improving style — the re-judge may not catch these if the judge model has blind spots consistent with the polish model's tendencies
- The 0.5-point improvement threshold is arbitrary — a candidate that improves by 0.49 points but crosses the 7.8 threshold is rejected, while a candidate that improves by 0.5 points from 6.8 to 7.3 still fails the hard threshold. The improvement metric should be contextualized against the pass threshold
- The controlled shorten attempt (for over-limit text) may lose critical content or nuance
- Memory context may introduce inconsistent voice if memory entries contradict each other or the current brief
- The 2-attempt budget may be insufficient for candidates with multiple near-miss dimensions, or may be wasted on candidates that are fundamentally unrecoverable

### What Gets Duplicated
- Both the original and polished versions exist during comparison, though only one should be retained
- If re-judging produces a score that qualifies for another polish attempt, the same content may enter a second polish cycle

### What Is Expensive
- AI polish call + re-judge call = 2 AI evaluations per polish attempt
- With up to 2 attempts per candidate, that's up to 4 AI calls per near-pass candidate
- Micro-repair adds an additional evaluation path
- The re-judge call is as expensive as the original judge call

### What Diagnostics Exist
- Polish eligibility rates (what fraction of judge failures are near-pass)
- Improvement distributions (how much polish typically gains)
- Polish success rate (fraction of polished candidates that pass re-judge)
- Micro-repair utilization and success rates
- Budget utilization (how many of the 2 slots are typically used)

### What Is Missing
- No breakdown of polish failure reasons — is failure primarily due to insufficient improvement, evidence_safety decrease, or new hard failures?
- No tracking of whether polished content maintains quality after publication (post-publish performance metrics)
- No measurement of memory context impact — does memory actually improve polish outcomes?
- No analysis of the relationship between polish eligibility window (6.8-7.8) and actual improvement rates — would narrowing or widening the window improve efficiency?
- No tracking of the controlled shorten attempt success rate and content loss
- No comparison of polish outcomes by failure dimension — are brief_alignment failures more recoverable than originality failures?

---

## Stage 8: Account Shield (account-shield.ts)

### Purpose
Account shield is the last line of defense before content reaches the publish gate, performing 11 distinct safety and quality checks to protect the account's reputation and comply with platform norms. The checks cover: slop words (overused AI-typical vocabulary), slop patterns (structural AI artifacts), symmetry (overly balanced sentence structures), emoji count (>2), hashtags, first-person claims (asserting personal experiences the account hasn't had), unsourced claims, originality gate (minimum originality threshold), engagement mechanics (calls to action that feel manipulative), low-follower rules (stricter standards for accounts with fewer followers), and tweet length (280 characters hard limit for @30piq). A deep AI check is optionally triggered when warnings accumulate, providing a more thorough evaluation of flagged content.

### What It Rejects
- Content failing any of the 11 checks at danger level
- Content with accumulated warnings that trigger the deep AI check and fail it
- Content with >2 emojis, hashtags, or first-person claims deemed inauthentic
- Content exceeding the 280-character hard limit for @30piq
- Content classified as risk level "danger" (vs. "safe" or "warning")
- shield_not_passed is historically a high-count failure, meaning many candidates that survive through Stage 7 are still caught here

### What It Allows
- Content at "safe" risk level passes without further review
- Content at "warning" level may pass if it doesn't trigger the deep AI check
- Content with minor slop word usage (< threshold) is tolerated
- Content with 0-2 emojis passes the emoji check

### What Can Pass Incorrectly
- The slop word list is finite and may miss emerging AI-typical vocabulary that becomes common after the list was last updated
- Symmetry detection based on structural heuristics may miss sophisticated AI patterns that avoid obvious structural regularity
- First-person claim detection may have false negatives for indirect claims ("we've all been there" implying shared experience)
- The deep AI check is optional and may not be triggered for content that accumulates borderline warnings across multiple checks
- Low-follower rules may be inappropriately strict or lenient depending on the account's actual audience engagement patterns
- shield_not_passed being historically high raises the question: which of the 11 checks dominate rejections? If one check (e.g., slop words) is responsible for 80% of rejections, the other 10 checks may be under-tuned or the dominant check may be over-sensitive

### What Gets Duplicated
- Some checks may overlap with earlier stages (e.g., the originality gate overlaps with judge's originality threshold, emoji checks may overlap with quality-validator checks)
- The deep AI check may reproduce evaluations already done by the judge

### What Is Expensive
- The deep AI check is an additional model call triggered on warning accumulation
- Running 11 heuristic checks per candidate adds computational overhead, though each individual check is lightweight
- The high shield_not_passed rate means significant downstream processing cost (Stages 5-7) is wasted on content that would fail shield

### What Diagnostics Exist
- Per-check pass/fail/warning counts
- Risk level distributions (safe/warning/danger)
- Deep AI check trigger rates and outcomes
- shield_not_passed aggregate count

### What Is Missing
- **Critical: No breakdown of shield_not_passed by individual check** — this is the most important diagnostic gap. Without knowing which checks dominate, it's impossible to determine whether the high rejection rate represents genuine quality protection or over-rejection
- No measurement of overlap between shield rejections and earlier-stage rejections (would earlier-stage checks catch the same issues more cheaply?)
- No tracking of false-positive rates for each check (content rejected by shield that human reviewers would approve)
- No dynamic adjustment of check thresholds based on account performance data
- No measurement of the correlation between shield risk levels and post-publish engagement/quality signals
- No analysis of whether the deep AI check adds value beyond the heuristic checks or whether it primarily confirms heuristic findings

---

## Stage 9: Publish Gate (content-policy.ts)

### Purpose
The publish gate enforces the final content policy checks before a tweet is approved for publication. It validates language (English only via isEnglishPublishableText: length 10-1200, no Arabic characters, not JSON, not AI slop), freshness (replies must reference tweets <72 hours old, quotes <168 hours old; otherwise downgrade to standalone if possible), hard character limits (280 characters for @30piq), and URL validity for reply/quote targets. All rejections are recorded to the rejection_ledger for auditability.

### What It Rejects
- Non-English text or text containing Arabic characters
- JSON-formatted content (model output that wasn't properly cleaned)
- AI slop patterns at the final gate
- Text shorter than 10 characters or longer than 1200 characters
- Replies to tweets older than 72 hours (unless downgradable to standalone)
- Quotes of tweets older than 168 hours (unless downgradable to standalone)
- Content exceeding the 280-character hard limit for @30piq
- Reply/quote targets with invalid or unreachable URLs
- Any content that cannot be classified as publishable by isEnglishPublishableText

### What It Allows
- English text within the 10-1200 character range that passes slop and JSON checks
- Fresh replies (<72h) and quotes (<168h) with valid target URLs
- Content that is successfully downgraded from reply/quote to standalone when freshness gates fail
- Content at exactly the 280-character limit for @30piq

### What Can Pass Incorrectly
- The isEnglishPublishableText check may miss mixed-language content that is primarily English but contains non-English phrases or loan words
- The freshness downgrade from reply/quote to standalone changes the context of the tweet — a standalone version of a reply may not make sense without the original context
- The 280-character hard limit is enforced at this stage, but content may have been crafted and enhanced with a different length assumption, making the rejection feel arbitrary rather than a design feature
- URL validation for reply/quote targets checks reachability at gate time, but the target may become unavailable between validation and actual publication
- The rejection_ledger records rejections but may not capture the full context (e.g., which specific check failed, what the threshold was, what the measured value was)

### What Gets Duplicated
- Language and slop checks overlap with quality-validator (Stage 5) and account shield (Stage 8)
- Length checks overlap with account shield's tweet length check
- This redundancy is intentional defense-in-depth but should be monitored for inconsistency

### What Is Expensive
- URL reachability checks for reply/quote targets require HTTP requests
- Minimal other costs — most checks are deterministic

### What Diagnostics Exist
- rejection_ledger entries for all rejected content
- Freshness gate statistics (reply age distributions, quote age distributions)
- Downgrade rates (reply → standalone, quote → standalone)
- isEnglishPublishableText failure rates

### What Is Missing
- No measurement of the time gap between gate approval and actual publication — if the gap is significant, freshness guarantees weaken
- No tracking of downgrade quality — do standalone-converted tweets perform worse than natively standalone ones?
- No logging of URL validation failures with specific error codes (DNS failure, HTTP 404, timeout, etc.)
- No analysis of whether the 72h/168h freshness thresholds are optimal — do older replies perform worse?
- The rejection_ledger should include more structured metadata (check name, threshold, measured value) to enable systematic analysis

---

## Stage 10: Decision Engine (decision-engine.ts)

### Purpose
The decision engine is the final arbiter that determines which approved candidates actually get published, respecting stage-based budgets and optimizing for multi-factor quality. It assigns stage-based publication budgets: stage_0 allows 2 posts max, stage_1 allows 3, stage_2 allows 4, and stage_3 allows 5. Candidates are scored using a weighted multi-factor formula: momentum (30%), brain_match (25%), audience_fit (15%), safety (15%), originality (10%), and media_fit (5%). Budget-constrained selection produces two sets: {selected} (to be published) and {held} (qualified but budget-exceeded). Critically, "no recommendation" is a valid and often preferred outcome — the system is designed to publish nothing rather than publish low-quality content.

### What It Rejects
- Candidates that exceed the stage budget for their assigned stage
- Candidates with lower composite scores than budget-allowable alternatives
- All candidates if the overall quality bar is not met — "no recommendation" is the default, not a failure
- Candidates with insufficient momentum or brain_match scores that don't justify publication

### What It Allows
- Up to the stage budget number of top-scoring candidates per stage
- Candidates with strong momentum and brain_match even if some other factors are weaker
- "No recommendation" as a deliberate, correct decision when quality doesn't justify publication

### What Can Pass Incorrectly
- The stage-based budget system is rigid — if stage_0 has 3 excellent candidates and stage_3 has 0, the budget prevents publishing the 3rd stage_0 candidate even though it's objectively better than publishing nothing
- The 30% momentum weight may over-prioritize trending content over evergreen quality
- The 25% brain_match weight reflects the operator's cognitive alignment, which is subjective and may not correlate with audience reception
- Safety at 15% may be underweighted for an account where reputation risk is high
- Originality at only 10% may under-reward novel content relative to safe, momentum-riding content
- The held set provides no mechanism for delayed publication — held candidates expire unused

### What Gets Duplicated
- If the same opportunity produces candidates in different stages (unlikely but possible with scoring variations), budget may be consumed by duplicate content
- The multi-factor scoring is independent of the judge scores, creating potential inconsistency — a candidate that scored 8.5 on the judge may score lower on the decision engine's composite

### What Is Expensive
- The decision engine itself is computationally lightweight (scoring is local)
- The real cost is the upstream pipeline that feeds it — every candidate that reaches the decision engine has consumed significant AI and processing resources

### What Diagnostics Exist
- Selected vs. held counts per stage
- "No recommendation" frequency
- Composite score distributions for selected vs. held candidates
- Per-factor score contributions

### What Is Missing
- No feedback loop from post-publication engagement metrics back to scoring weights — the 30/25/15/15/10/5 split is fixed
- No mechanism for budget carry-over between stages or runs
- No tracking of held candidate quality over time — are we consistently holding high-quality content?
- No analysis of "no recommendation" outcomes — is the pipeline too strict upstream, or are the budgets too tight?
- No measurement of whether stage-based budgets align with actual content availability — do some stages consistently have more qualified candidates than budget allows?
- No A/B framework for testing alternative weight configurations
- No logging of the composite score breakdown per candidate to enable weight optimization

---

## Cross-Cutting Concerns

### Concern 1: intelligence_parse_failed Count — Parser Robustness

**Observation:** The intelligence_parse_failed rejection reason in Stage 2 has historically been non-trivial in frequency. This means the AI model (callModel('opportunity_intelligence')) is returning output that cannot be parsed into the expected JSON schema.

**Root Causes:**
1. The model may return valid JSON wrapped in markdown code blocks (```json ... ```) that the parser doesn't strip
2. The model may return JSON with unexpected keys or value types that fail schema validation
3. The model may return natural language explanations instead of structured JSON
4. The model may return truncated JSON due to token limits or timeout
5. The JSON schema may be ambiguous, leading the model to produce technically valid but structurally unexpected output

**Recommendations:**
- Implement a multi-layer parsing strategy: first attempt direct JSON parse, then try extracting JSON from markdown wrappers, then attempt fuzzy key matching, then fall back to regex extraction of individual fields
- Log the raw model output for every parse failure to enable post-hoc analysis and parser improvement
- Add schema validation that reports which specific fields failed, not just a binary pass/fail
- Consider adding a model output repair step that uses a smaller/faster model to fix common formatting issues before formal parsing
- Track parse failure rates by model version to detect regressions
- Add a retry mechanism with a more explicit prompting format for parse failures (e.g., "Respond with ONLY valid JSON matching this schema: ...")

### Concern 2: generic_only High Count — Good Strictness or Over-Rejection?

**Observation:** The generic_only rejection reason is high-count in Stage 2, indicating many opportunities are rejected because the AI evaluator determines they can only support generic, non-specific content angles.

**Analysis:**
- If generic_only rejections are genuinely filtering out topics that would produce bland content, this is healthy strictness that protects the account from publishing forgettable posts
- However, if some of these "generic" opportunities could have been crafted into specific, original takes with the right angle, then the intelligence stage is over-rejecting by confusing "topic is broad" with "angle must be generic"
- Stage 1's NICHE_KEYWORDS and hook patterns should theoretically reduce generic candidates before they reach Stage 2, but the pipeline currently lacks measurement of this reduction effect
- The 3-variant crafting approach in Stage 3 is designed to find non-generic angles, but generic_only rejection happens before crafting — the system never gives crafting a chance to find a specific angle on a broad topic

**Recommendations:**
- Audit a sample of generic_only rejections to determine what fraction could have produced specific content with creative crafting
- Add a "generic but rescuable" category that allows borderline opportunities through to crafting with a warning flag
- Measure the rate at which Stage 1's prefiltering reduces generic_only candidates — if the reduction is minimal, Stage 1's keyword/hook patterns need expansion
- Track the downstream performance of content from opportunities that were initially flagged as generic-only but rescued (if any rescue mechanism exists)
- Consider relaxing generic_only rejection for opportunities with very high niche_fit scores, as deep niche expertise may enable specific angles on broad topics

### Concern 3: shield_not_passed High Count — Which Shield Issues Dominate?

**Observation:** shield_not_passed is historically high-count in Stage 8, meaning many candidates that survive the entire quality enhance → judge → polish pipeline are still rejected at the shield.

**Critical Gap:** There is currently no breakdown of shield_not_passed by individual check. Without this data, it's impossible to determine whether the high rejection rate is caused by one dominant check (suggesting that check may be over-sensitive) or distributed across many checks (suggesting genuine quality issues in the pipeline's output).

**Hypotheses:**
1. **Slop words dominate:** The AI crafting and enhancement stages consistently produce AI-typical vocabulary that the shield catches. This would indicate that the crafting prompts need better anti-slop instructions, or that a slop-word-removal step should be added to quality enhance
2. **First-person claims dominate:** The crafting model frequently invents personal experience claims. This would indicate that the do_not_claim validation in Stage 3 is insufficient
3. **Tweet length dominates:** Candidates consistently exceed 280 characters. This would indicate that the crafting and enhancement stages don't enforce the length constraint early enough
4. **Distributed across checks:** Multiple checks each contribute a moderate number of rejections. This would indicate that the shield is doing valuable, multi-dimensional quality protection

**Recommendations:**
- **Immediate priority:** Add per-check breakdown logging to account-shield.ts. Track which checks fire, at what rate, and at what severity level
- Cross-reference shield rejections with earlier stage scores to determine if any upstream signals predict shield failure
- If slop words dominate, add a slop-word removal pass in quality enhance (before the judge) to catch these issues earlier and more cheaply
- If first-person claims dominate, strengthen the do_not_claim validation in Stage 3 and add explicit anti-first-person instructions to the crafting prompt
- Consider whether certain shield checks should be moved upstream (e.g., length enforcement in Stage 3) to reduce wasted processing

### Concern 4: Near-Pass Polish — Is It Actually Improving?

**Observation:** Near-pass polish in Stage 7 is designed to rescue candidates scoring 6.8-7.8 on the judge, but there's no systematic measurement of whether polishing actually produces publishable content.

**Key Questions:**
1. **Polish failure breakdown:** What fraction of polish attempts fail due to insufficient improvement vs. evidence_safety decrease vs. new hard failures vs. micro-repair ineligibility? Without this breakdown, it's unclear whether the polish strategy itself is flawed or whether specific failure modes need targeted fixes.
2. **Length issues:** Does the polish frequently produce content that exceeds the 280-character limit? If the original was near 280 chars and polish adds content, length may be a dominant failure mode that should be explicitly constrained in the polish prompt.
3. **Originality maintenance:** Does polish maintain or improve originality? The polish prompt emphasizes originality, but adding brief_alignment or voice elements may dilute the original insight.
4. **Brief mismatch:** Does polish improve brief_alignment but at the cost of other dimensions? The micro-repair path targets brief_alignment specifically, but the standard polish may trade brief_alignment for other qualities.
5. **Memory usage:** Is the memory context actually utilized in the polish prompt, and does it improve outcomes? If memory is included but has no measurable effect, it's adding prompt token cost without benefit.

**Recommendations:**
- Add structured logging of polish attempt outcomes: original scores, polished scores, delta per dimension, failure reason (if any)
- Track post-polish judge scores separately from initial judge scores to measure polish effectiveness
- If length is a frequent polish failure, add explicit character budget constraints to the polish prompt
- Measure the impact of memory context by running A/B comparisons (with and without memory) on a sample of near-pass candidates
- Consider adjusting the eligibility window based on observed improvement rates — if candidates at 6.8-7.0 almost never improve enough, narrow the window to 7.0-7.8 to save polish costs
- Track whether polished content that passes the judge also passes the account shield and publish gate — polish may be improving judge scores while introducing shield-detectable issues

### Concern 5: Candidate Scoring — Length Policy Alignment

**Observation:** The candidate selection scoring formula in Stage 4 (brief_alignment + originality_indicators + signature_voice + operator_takeaway + evidence_safety - generic_hype - abstract_penalty) does not explicitly account for the 280-character hard limit enforced in Stages 8 and 9.

**Problems:**
1. **Over-penalization of long content is missing:** A candidate that scores well on all formula dimensions but is 350 characters will be selected, judged, polished, and shield-checked before being rejected for length. This wastes resources across 4 stages.
2. **Under-penalization of short content:** A very short candidate (e.g., 50 characters) may score well on the formula but lack the substance to pass the judge's usefulness threshold. The formula doesn't penalize brevity.
3. **No length-aware scoring:** The composite score should include a length fitness component that penalizes candidates too far from the optimal range (say 150-250 characters for @30piq).

**Recommendations:**
- Add a length_fitness term to the candidate scoring formula: maximum score for candidates in the optimal range, decreasing penalty for candidates that are too short or too long
- Enforce the 280-character hard limit as a pre-selection filter in Stage 4 rather than deferring it to Stage 8/9 — candidates exceeding 280 characters should be immediately rejected or sent for shortening
- Track the rate at which candidates are rejected for length at the shield/publish gate to quantify the waste from missing this check earlier
- Consider adding a "length budget" to the crafting prompt so that variants are produced within the target range from the start

---

## Pipeline-Wide Systemic Issues

### 1. Scoring Inconsistency Across Stages

The pipeline uses different scoring scales and thresholds at each stage:
- Stage 2: 7.5 publishability (1-10 scale)
- Stage 5: 7.0 brief alignment gate
- Stage 6: 7.8 final, 7.8 originality, 7.5 brief alignment
- Stage 7: 6.8-7.8 eligibility window

These thresholds create a "scoring staircase" where content must clear progressively higher bars. This is by design, but the gaps between thresholds (e.g., brief alignment 7.0 in Stage 5 vs. 7.5 in Stage 6) should be explicitly documented and periodically audited for whether they represent appropriate increasing selectivity or calibration drift.

### 2. Redundant Checks Without Coordination

Multiple stages check overlapping properties:
- JSON wrapper detection: Stage 3 (local validation), Stage 5 (text cleaner, quality validator), Stage 6 (unfixable failure), Stage 9 (publish gate)
- AI slop detection: Stage 5 (quality validator), Stage 8 (account shield), Stage 9 (publish gate)
- Length enforcement: Stage 3 (40-char minimum), Stage 7 (40-400 eligibility), Stage 8 (280 hard limit), Stage 9 (10-1200 + 280)

Defense-in-depth is good, but without coordination, these checks may use different detection logic and produce inconsistent results. A unified detection library would ensure consistency and reduce maintenance burden.

### 3. No End-to-End Quality Feedback Loop

The pipeline has no mechanism for post-publication quality signals to flow back into scoring thresholds and weights. Currently:
- Judge scores don't correlate with engagement metrics
- Decision engine weights are fixed, not learned
- Shield check thresholds are static, not calibrated
- No A/B testing framework exists for threshold or weight changes

Without feedback, the pipeline's quality parameters can only be improved by manual inspection, which doesn't scale.

### 4. Parse Failures as Silent Quality Loss

Across Stages 2 (intelligence_parse_failed), 3 (crafting parse failures), and 6 (judge_parse_failed), model output that cannot be parsed is treated as a rejection. This converts potentially high-quality content into rejections not because the content is bad but because the parser is fragile. The aggregate rate of parse failures across all stages represents a direct quality loss that could be recovered with more robust parsing.

### 5. Budget and Resource Waste from Late-Stage Rejections

Candidates that pass Stages 1-5 but fail at Stage 6 (judge), Stage 7 (polish), Stage 8 (shield), or Stage 9 (publish gate) have consumed significant AI processing resources. The cost per candidate increases dramatically at each stage:
- Stage 1-2: ~1-2 AI calls
- Stage 3: +3 AI calls (crafting)
- Stage 5: +1-3 AI calls (enhance)
- Stage 6: +1 AI call (judge)
- Stage 7: +2-4 AI calls (polish + re-judge)

A candidate rejected at Stage 8 after polishing has consumed ~10 AI calls. Moving the most common late-stage rejection reasons (especially shield checks) earlier in the pipeline would significantly reduce cost.

### 6. Missing Observability

The most critical diagnostic gap across the entire pipeline is the lack of structured, per-reason rejection logging at every stage. Without knowing exactly why content is rejected at each stage, it's impossible to:
- Identify which stages are over- or under-selective
- Optimize threshold values
- Detect regressions from model or prompt changes
- Measure the cost-effectiveness of each stage

**Recommendation:** Implement a unified rejection ledger that records every rejection across all stages with: stage name, rejection reason, candidate ID, scores (all dimensions), and timestamps. This should be the highest-priority infrastructure investment for pipeline quality improvement.
