# ROADMAP REPAIR PLAN — x-ai-content-factory-orchestrator

> **Project**: X (Twitter) content opportunity/recommendation engine for **@30piq**
> **Purpose**: Prioritized repair roadmap based on the full system audit (DATABASE_AUDIT_REPORT, MEMORY_AUDIT, ACTIVE_SYSTEM_MAP, ACCOUNT_LENS_AUDIT, QUALITY_PIPELINE_AUDIT, SOURCE_STRATEGY_AUDIT)
> **Last Updated**: 2026-03-04
> **Audience**: Maintainers and future agents who need to understand what needs fixing and in what order
> **Related Docs**: `ACTIVE_TABLES.md`, `DATABASE_AUDIT_REPORT.md`, `MEMORY_AUDIT.md`, `OPERATIONS_RUNBOOK.md`

---

## Priority Framework

| Priority | Meaning | Time Horizon | Risk if Deferred |
|----------|---------|-------------|-----------------|
| **P0** | Must fix before more runs | Immediate | Broken runs, weak recommendations, bypass of safety checks, stale recommendations |
| **P1** | Should fix before scaling | 1–2 weeks | Poor source selection, missed diagnostics, accumulated technical debt |
| **P2** | Improve quality | 2–4 weeks | Suboptimal recommendations, wasted AI calls, memory degradation |
| **P3** | Cleanup | 1–2 months | Maintenance burden, code readability, onboarding difficulty |
| **P4** | Future | 2+ months | No immediate risk, but important for long-term viability |

---

## P0 — Must Fix Before More Runs

These items can cause broken pipeline runs, weak recommendations that slip through quality gates, bypass of safety mechanisms, or delivery of stale content. Every additional run with these issues active risks wasted AI spend and poor recommendations reaching the operator.

---

### P0-1: Adjacent Topic Pattern Mismatch ✅ ALREADY FIXED

| Attribute | Detail |
|-----------|--------|
| **Problem** | `ALLOWED_ADJACENT_TOPICS` in constants declared crypto/web3, politics/policy, and gaming as valid adjacent topics, but `ADJACENT_TOPIC_PATTERNS` in `opportunity-intelligence.ts` had no corresponding regex patterns for them. This meant that when the intelligence step evaluated an opportunity about "DeFi yield strategies" or "gaming industry layoffs", the topic scoring would classify it as off-lens despite being explicitly allowed by the topic list. The two configuration arrays were silently out of sync — one said "these topics are OK" and the other said "I don't know how to recognize these topics." |
| **Evidence** | Direct code comparison between `ALLOWED_ADJACENT_TOPICS` array in `lib/constants.ts` and `ADJACENT_TOPIC_PATTERNS` object in `lib/opportunity-intelligence.ts`. The pattern object had entries for AI, tech, and career topics but was missing entries for crypto/web3, politics/policy, and gaming. This was found during the ACCOUNT_LENS_AUDIT when tracing how adjacent topic scoring works end-to-end. |
| **Files** | `lib/opportunity-intelligence.ts` |
| **Risk** | Valid adjacent-topic opportunities were incorrectly scored as off-lens, causing the intelligence step to reject legitimate content. This directly reduced the diversity and quantity of recommendations, potentially leading to "no recommendation" days when only adjacent-topic content was available. The system's ability to broaden its niche coverage (S1.3 Account Growth Lens) was fundamentally undermined because the recognition layer couldn't identify the topics it was supposed to allow. |
| **Proposed Fix** | Add 3 missing `ADJACENT_TOPIC_PATTERNS` entries for crypto/web3, politics/policy, and gaming with appropriate regex patterns. Each entry should include primary keywords, related terms, and disambiguation patterns. For example, crypto/web3 should match "blockchain", "DeFi", "NFT", "token", "smart contract", "Web3", "crypto" but NOT "cryptic" or "encryption". — **DONE** |
| **Tests Needed** | 9 new tests covering: (1) crypto topic recognition, (2) politics topic recognition, (3) gaming topic recognition, (4) disambiguation between gaming and gambling, (5) crypto vs. encryption security topics, (6) politics vs. corporate politics, (7) mixed-topic opportunity scoring, (8) adjacent topic boost calculation with new patterns, (9) regression test for existing AI/tech/career patterns — **DONE** |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes — **DONE** |
| **Status** | ✅ **COMPLETE** — Patterns added, tests passing, deployed |

---

### P0-2: Forced Angle Warning Not Hard Gate

| Attribute | Detail |
|-----------|--------|
| **Problem** | When the niche alignment scorer detects that a recommended angle diverges significantly from the source's obvious take (setting `forced_angle_flag=true`), the current code only adds a `forced_angle_warning` string to the `shield_issues` array. The content continues through the pipeline and can still reach the opportunity judge and potentially pass if the judge doesn't catch the forced angle. This is a soft warning where a hard gate is warranted. The intent of the forced angle flag is to signal that the angle was artificially constructed rather than naturally emerging from the source content — a significant quality concern that should at minimum require a strong transferable mechanism to justify the angle shift. Currently, a candidate with `forced_angle_flag=true` and `transferable_angle_score=1` (no real transferable mechanism) can still reach the publish gate if the judge gives it a high score on other dimensions. |
| **Evidence** | In `lib/niche-alignment.ts` lines 494–498, the code checks `if (forced_angle_flag && transferable_angle_score < 4)` and adds a `'forced_angle_warning'` string to `shield_issues`. But `shield_issues` is only informational — it doesn't trigger a rejection. The publish gate's shield check reads `shield_issues` but treats them as warnings, not hard blocks. The only way forced-angle content gets stopped is if the judge independently identifies the angle problem, which is unreliable since the judge evaluates on 6 dimensions and may weight other factors more heavily. |
| **Files** | `lib/niche-alignment.ts`, `lib/account-shield.ts`, `lib/content-policy.ts` |
| **Risk** | Forced-angle content that reaches publish represents a quality risk: the recommendation may present an angle that the source author never intended, which could mislead the operator or result in content that feels disconnected from the original source. More critically, forced angles with low transferable scores (meaning there's no clear mechanism for the audience to act on the angle) represent the exact type of "cliché AI angle" the system was designed to avoid. If this content gets published, it undermines the account's credibility. |
| **Proposed Fix** | Implement a pre-gate rejection when `forced_angle_flag=true AND transferable_angle_score < 2`. This means: if the angle is forced AND there's no real transferable mechanism (score 0–1 out of 10), the content should be rejected at the niche alignment stage before it even reaches the judge. This is a conservative threshold — score 2 means there's at least a weak transferable mechanism, which may justify the forced angle. The rejection should be logged to `rejection_ledger` with reason "forced_angle_no_transferable_mechanism". For scores 2–3 (weak but present mechanism), the warning should be escalated from informational to a shield hard-issue that the judge must explicitly address. |
| **Tests Needed** | (1) Forced angle + transferable_score=0 → hard rejection, (2) Forced angle + transferable_score=1 → hard rejection, (3) Forced angle + transferable_score=2 → warning (not rejection), (4) Forced angle + transferable_score=5 → no warning, (5) Not forced angle + transferable_score=0 → no forced-angle action, (6) Full pipeline path test: forced angle content rejected before judge, (7) Regression: non-forced content not affected by new logic |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes, but needs careful design to not over-block. The threshold of `< 2` for hard rejection is conservative — it only blocks content with truly no transferable mechanism. However, the definition of "transferable mechanism" should be reviewed to ensure the scoring is accurate. If `transferable_angle_score` is unreliable (e.g., always returns 3–5 regardless of actual transferability), the threshold may need adjustment. **Recommendation**: implement with `< 2` threshold, monitor rejection rates for 1 week, then consider adjusting to `< 3` if too many false positives. |
| **Status** | 🔴 **NOT STARTED** |

---

## P1 — Should Fix Before Scaling

These items won't break runs immediately but will degrade quality and increase costs as the system scales. Fixing them before scaling prevents compounding technical debt and ensures that increased run frequency doesn't amplify existing weaknesses.

---

### P1-1: Source Strategy (S1.4)

| Attribute | Detail |
|-----------|--------|
| **Problem** | The source account selection strategy is fundamentally naive. `selectValidAccounts` in `lib/pipeline-queue.ts` uses only `tier` and `last_checked` to determine which accounts to scan — it sorts by tier (lower = higher priority) and last_checked (older = higher priority) and takes the first N. There is no category-based allocation (e.g., "scan 2 AI accounts, 1 crypto account, 1 career account per run"), no quality feedback loop from `source_quality_scores` (which tracks yield rates and rejection rates per source), and no mechanism to skip invalid handles (accounts that no longer exist on X but still have rows in the `accounts` table). This means the pipeline may waste scan slots on: (1) low-quality sources that consistently produce rejected content, (2) inactive or deleted X accounts, (3) an unbalanced category mix that misses topic diversity. |
| **Evidence** | In `lib/pipeline-queue.ts`, the `selectValidAccounts` function queries `accounts` with `eq('active', true)`, orders by `tier` and `last_checked`, and limits to the configured batch size. No join to `source_quality_scores`, no WHERE clause on `category`, no validation that the handle still exists on X. The `scripts/source-quality-audit.ts` script computes per-source quality scores but these are never read by the pipeline. The `category` column on `accounts` exists (added by the alignment migration) but is NULL for most accounts. |
| **Files** | `lib/pipeline-queue.ts`, `lib/pipeline-worker.ts`, `scripts/source-quality-audit.ts` |
| **Risk** | Poor source selection leads directly to low-quality opportunities, wasted AI calls on scanning accounts that never produce viable content, and a lack of topic diversity in recommendations. If the same 5 high-tier accounts are always scanned first, the system develops tunnel vision — always seeing the same authors' content and never discovering new perspectives. Without quality feedback integration, accounts that were useful months ago but have since changed posting patterns continue to receive scan slots. Each wasted scan slot costs approximately $0.02–0.05 in AI calls, which compounds over hundreds of runs. |
| **Proposed Fix** | Three-part improvement: (1) **Category-based allocation**: Populate the `category` column for all accounts. Implement a `category_budget` configuration (e.g., {ai: 3, tech: 2, career: 1, crypto: 1}) and select accounts proportionally. Fall back to tier-based selection if categories are unpopulated. (2) **Quality feedback loop**: Join `accounts` with `source_quality_scores` during selection. Add a quality threshold (e.g., `source_quality_score < 0.2` → demote to tier 3). Add a cooldown for sources that have been scanned 5+ times with <10% yield rate. (3) **Handle validation**: Before scanning, verify the handle still exists on X (can be done cheaply via the user lookup API). Mark invalid handles as `active=false` automatically. |
| **Tests Needed** | (1) Category allocation respects configured budget, (2) Quality feedback demotes low-quality sources, (3) Cooldown skips recently-scanned sources, (4) Invalid handle detection and deactivation, (5) Fallback to tier-based selection when categories unpopulated, (6) Integration test: full source selection with mixed quality sources |
| **DB Migration Required** | Yes — need to populate `accounts.category` for existing accounts, and potentially add `source_quality_score_last_updated` column to `accounts` for caching the quality score timestamp |
| **Can Be Done Safely Now** | Requires careful design. The category allocation is straightforward. The quality feedback loop needs a threshold tuning period — start conservative (only demote very low quality) and tighten over time. Handle validation adds an extra X API call per account per run, which has rate limit implications. **Recommendation**: implement category allocation first (low risk), then quality feedback (medium risk), then handle validation (requires rate limit analysis). |
| **Status** | 🔴 **NOT STARTED** |

---

### P1-2: Parser Hardening

| Attribute | Detail |
|-----------|--------|
| **Problem** | Model output parsing failures occur with non-trivial frequency. The `intelligence_parse_failed` counter in pipeline diagnostics shows that a meaningful percentage of AI responses fail to parse correctly. Common failure modes include: (1) Model wraps JSON in markdown code fences (` ```json ... ``` `) despite being asked for raw JSON, (2) Model adds explanatory text before or after the JSON block, (3) Model produces truncated JSON when hitting token limits, (4) Model uses single quotes instead of double quotes, (5) Model includes trailing commas in arrays/objects. The `crafted-text-cleaner.ts` handles some of these cases (stripping code fences, extracting JSON boundaries), and `parseModelJson` in `model-router.ts` provides fallback parsing, but failures still occur and result in lost opportunities — the entire scan or craft output for that account is discarded when parsing fails. |
| **Evidence** | The `crafted-text-cleaner.ts` file exists specifically to handle malformed model output, which is itself evidence that parsing failures are expected. The `parseModelJson` function in `model-router.ts` has multiple fallback strategies (direct parse → extract JSON → try repair → fail). The `opportunity_intelligence` step tracks `parse_failure_rate` in its diagnostics. The `tests/parse-model-json.test.ts` file contains 30+ edge case tests, indicating the problem has been encountered repeatedly. |
| **Files** | `lib/crafted-text-cleaner.ts`, `lib/model-router.ts`, `lib/opportunity-intelligence.ts`, `lib/opportunity-judge.ts`, `lib/near-pass-polish.ts` |
| **Risk** | Every parse failure represents a lost opportunity — the AI spent money generating a response that the system couldn't use. At $0.01–0.05 per call, a 5% parse failure rate across 20 AI calls per run means ~$0.01–0.05 wasted per run, plus the opportunity cost of missed content. More importantly, parse failures that affect the judge step could mean a valid candidate is silently dropped rather than being evaluated, leading to false "no recommendation" results. Persistent parse failures in the intelligence step could mean the system never selects the best opportunities, instead falling back to whatever survived the parse. |
| **Proposed Fix** | (1) **Parse failure sampling**: Add a diagnostic that saves the first N (e.g., 5) parse-failed raw model outputs per run to the pipeline run's `debug_log`, so the specific failure modes can be analyzed. (2) **Improved JSON boundary detection**: The current `extractJsonFromText` function looks for `{` and `[` brackets but doesn't handle nested brackets correctly in all cases. Improve the algorithm to track bracket depth and find the outermost valid JSON structure. (3) **Pre-emptive prompt instruction**: Add explicit "Return ONLY valid JSON with no markdown formatting, no explanatory text, no trailing commas" instructions to every system prompt that expects JSON output. (4) **Retry with simplified prompt**: On parse failure, retry the AI call with a simplified prompt that emphasizes JSON formatting. This adds cost but may recover otherwise lost opportunities. |
| **Tests Needed** | (1) JSON wrapped in markdown code fences, (2) JSON with explanatory text prefix, (3) Truncated JSON (token limit hit), (4) JSON with single quotes, (5) JSON with trailing commas, (6) Nested JSON objects, (7) JSON with unicode escapes, (8) JSON with comments (not valid JSON but some models add them), (9) Empty response, (10) Multiple JSON objects in one response |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes. The parser improvements are backward-compatible — better parsing only means fewer failures, not different behavior for successfully parsed output. The retry-with-simplified-prompt feature should be behind a flag (`PARSER_RETRY_ENABLED`) and capped at 1 retry per call to control costs. |
| **Status** | 🔴 **NOT STARTED** |

---

### P1-3: Diagnostics Gap — Shield Per-Check Breakdown

| Attribute | Detail |
|-----------|--------|
| **Problem** | The account shield performs 11 distinct checks on each candidate (similarity, following ratio, reply frequency, quote frequency, numeric claims, evidence safety, freshness, source diversity, forced angle, length compliance, and the optional AI deep check). When a candidate is shield-rejected, the system knows that "shield rejected it" but not which of the 11 checks was the primary cause. The `shield_not_passed` metric is tracked in pipeline run diagnostics, but there's no aggregation of which checks dominate rejections. This means that if 80% of rejections are due to the freshness check, the operator has no way to know this — they just see "shield rejected 8 of 10 candidates" without understanding why. Without per-check diagnostics, it's impossible to tune the shield (e.g., adjusting freshness thresholds, relaxing similarity checks) or identify systematic problems (e.g., a source that always fails the numeric claims check). |
| **Evidence** | In `lib/account-shield.ts`, the `shieldCheck` function returns a `checks` array where each element has `name`, `passed`, and optional `reason`. The `processPublishGate` function in `lib/pipeline-worker.ts` reads this array and adds failed checks to `shield_issues`, but doesn't aggregate per-check statistics across all candidates in a run. The `quality_enhance` step's diagnostics include `niche_guard_count` and `validation_stats` but not shield per-check counts. |
| **Files** | `lib/pipeline-worker.ts`, `lib/account-shield.ts`, `lib/content-policy.ts` |
| **Risk** | Without per-check diagnostics, shield tuning is blind guesswork. If the freshness gate is too strict (rejecting content that's 73 hours old when the threshold is 72h), the operator can't see this pattern and adjust. If the similarity check is too lenient (letting near-duplicate content through), the operator can't see this either. The shield is a critical safety mechanism, and the inability to monitor its behavior in detail is a significant operational gap. |
| **Proposed Fix** | Add a `shield_check_stats` object to the `quality_enhance` step's `result_payload` that aggregates per-check pass/fail counts across all candidates. Structure: `{ similarity: {passed: 5, failed: 2}, freshness: {passed: 3, failed: 4}, ... }`. Also add a `top_shield_rejection_reasons` array showing the top 3 rejection reasons by frequency. This data should be included in the Telegram delivery message so the operator can see at a glance why content was rejected. |
| **Tests Needed** | (1) Shield stats correctly aggregate across multiple candidates, (2) Stats include all 11 check types even if some had zero failures, (3) Top rejection reasons sorted by frequency, (4) Empty candidates case (no shield checks run), (5) All-pass case (all checks pass for all candidates), (6) Integration: stats appear in quality_enhance result_payload |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes. This is purely additive — adding diagnostics doesn't change any rejection logic, it only makes existing behavior observable. The data flows through `result_payload` which is JSONB, so no schema changes needed. |
| **Status** | 🔴 **NOT STARTED** |

---

### P1-4: Prompt Wording Consistency

| Attribute | Detail |
|-----------|--------|
| **Problem** | The ACCOUNT_LENS_AUDIT found that some prompts and comments still reference the old niche framing "AI × productivity × career growth" instead of the current broader Account Growth Lens framing. This isn't a runtime issue — the old wording appears in comments, doc strings, and some prompt template descriptions rather than in the actual scoring logic. However, it creates confusion for future agents who read the code and try to understand the system's intent. If a future maintainer sees "AI × productivity × career growth" in a comment and assumes that's the current niche, they may make incorrect modifications. Additionally, some prompt instructions to the AI models may contain vestigial language that narrows the model's understanding of what's acceptable content, even though the scoring logic has been broadened. |
| **Evidence** | The ACCOUNT_LENS_AUDIT identified specific files and line numbers where old wording persists. The rename from `niche_fit` to `account_lens` was only partially completed (S1.3 was a partial rename), leaving some variables, comments, and log messages using the old terminology. The `ALLOWED_ADJACENT_TOPICS` list was expanded but some prompt templates still describe the niche in the old narrower terms. |
| **Files** | Multiple files across `lib/` — primarily `lib/niche-alignment.ts`, `lib/opportunity-intelligence.ts`, `lib/account-shield.ts`, `lib/candidate-selector.ts`, and various prompt template strings |
| **Risk** | Not a runtime risk — old wording in comments doesn't affect pipeline behavior. The risk is maintainability and correctness of future modifications. A future agent that trusts comments over code may build features based on the old niche understanding, creating inconsistencies. If old wording appears in AI prompts, it may subtly constrain the model's output in ways that don't match the updated scoring logic, creating a disconnect between what the system scores as acceptable and what the AI generates. |
| **Proposed Fix** | (1) Add inline naming-debt comments (`// NAMING DEBT: was "niche_fit", now "account_lens"`) at every location where the old terminology persists but can't be immediately renamed (e.g., variable names that would break imports). (2) Update all comments and doc strings to use current terminology. (3) Update prompt template descriptions to match the current Account Growth Lens framing. (4) Create a `grep` command that future agents can use to find remaining old-terminology instances: `rg 'niche_fit|AI.*productivity.*career' lib/`. (5) Plan a full variable rename in a future P3 cleanup pass. |
| **Tests Needed** | None — this is comment-only and prompt-wording-only. No logic changes, no test changes required. |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes. Comment and prompt wording changes are zero-risk. They don't affect runtime behavior and can be reverted instantly if any wording turns out to be important. |
| **Status** | 🔴 **NOT STARTED** |

---

## P2 — Improve Quality

These items represent opportunities to improve recommendation quality, reduce wasted AI spend, and make the memory system more effective. They're not urgent but will compound in value over time.

---

### P2-1: Memory System Tuning (M1.1)

| Attribute | Detail |
|-----------|--------|
| **Problem** | The structured memory system has several interconnected issues that reduce its effectiveness: (1) **No confidence floor**: Rules with confidence as low as 0.1 are retrieved and injected into craft/polish prompts, wasting token budget on unvalidated hypotheses that may mislead the model. (2) **No decay**: Rules accumulate forever with no TTL or confidence decay. A rule from 6 months ago about "fine_tuning" is equally weighted as a rule from yesterday about "reasoning models", even though the discourse has moved on. (3) **Anti-patterns dominate**: Compaction only extracts signals from failures (judge rejections, freshness rejections), never from successes. The memory system is entirely negative — it tells the model what NOT to do but never what TO do. This creates a punitive framing that may cause overly conservative content. (4) **Topic key inference too narrow**: The `inferTopicKey` function uses only 16 regex patterns (all AI-centric) with a word-based fallback, meaning memory rules for new topic areas (e.g., personal finance, remote work) will never be retrieved because the topic keys won't match. |
| **Evidence** | The MEMORY_AUDIT.md documents these findings in detail (Q3: low-confidence rules retrieved, Q7: anti-patterns overrepresented, Q8: topic key inference too narrow, Q9: no cleanup/decay strategy). The audit identified HIGH severity for three of the four issues. The `compact_operator_rules` table has a `confidence` column but no minimum threshold filter in the retrieval queries. The `last_seen_at` column exists but is never used for filtering or scoring adjustment. |
| **Files** | `lib/structured-memory-retrieval.ts`, `lib/structured-memory-compaction.ts` |
| **Risk** | Low-quality memory polluting prompts is a compounding problem — each run adds more rules without cleaning old ones, so the signal-to-noise ratio degrades over time. Anti-pattern-only memory creates a pessimistic craft model that avoids risks (potentially avoiding novel content angles that would score well). Narrow topic key inference means the memory system becomes less useful as the niche broadens (S1.3), creating a scaling ceiling. |
| **Proposed Fix** | (1) **Confidence floor**: Add `.gte('confidence', 0.4)` to all three retrieval queries in `getRelevantStructuredMemory`. Estimated 20–40% reduction in retrieved rules for new/low-activity topic areas. (2) **Decay**: Add a `decayStaleMemoryRules` function that multiplies confidence by 0.9 for rules not seen in 30+ days, and soft-deletes rules below confidence 0.1. Trigger via `/api/memory-maintenance-run`. Add `active` boolean column to `compact_operator_rules`. (3) **Positive signal extraction**: Extend compaction to read from `published_decisions` and `content_deliveries` where `user_action = 'published'`, extracting "winning angle" rules from content that passed all gates and was actually published. (4) **Broader topic keys**: Expand `inferTopicKey` with additional regex patterns for adjacent topics (crypto/web3, politics/policy, gaming, personal finance, remote work). Use a fallback that maps to the closest known topic key rather than generating a novel key from word combinations. |
| **Tests Needed** | (1) Confidence floor: no rule with confidence < 0.4 is returned, (2) Decay: rules not seen in 30+ days have confidence reduced, (3) Decay: rules below 0.1 after decay are soft-deleted, (4) Positive signal extraction: published content generates winning_angle rules, (5) Topic key inference: new adjacent topics correctly mapped, (6) Topic key fallback: unknown topics mapped to closest known key, (7) Regression: existing memory retrieval still works after changes |
| **DB Migration Required** | No for confidence floor and topic keys. Yes for decay (need `active` column on `compact_operator_rules`). Yes for positive signal extraction (may need new rule_type values, but existing schema supports them). |
| **Can Be Done Safely Now** | Confidence floor: yes, immediately, zero risk. Topic key expansion: yes, additive only. Decay: needs design — the decay rate (0.9x per 30 days) and minimum threshold (0.1) need tuning. Positive signal extraction: needs careful design to avoid creating rules from published content that happened to pass but wasn't actually good (the operator may publish mediocre content when nothing better is available). **Recommendation**: implement confidence floor first, then topic key expansion, then decay, then positive signal extraction. |
| **Status** | 🔴 **NOT STARTED** |

---

### P2-2: Near-Pass Polish Effectiveness Audit

| Attribute | Detail |
|-----------|--------|
| **Problem** | The near-pass polish system spends Claude Sonnet 4.6 calls (the most expensive model in the pipeline) attempting to improve candidates that scored just below the judge threshold. However, there is no measurement of whether polish actually works. The system tracks `polish_stats` (how many candidates were polished, how many passed after polish) but doesn't compare against a baseline (what would have happened without polish) or break down effectiveness by failure reason. If polish succeeds 10% of the time overall but 0% for originality failures and 30% for brevity failures, the system should stop polishing for originality and focus on brevity — but currently it can't make this distinction. Each wasted polish call costs ~$0.03–0.08, and with 2–4 near-pass candidates per run, that's $0.06–0.32 per run that may be entirely wasted. |
| **Evidence** | `lib/near-pass-polish.ts` (941 lines) implements micro-repair strategies for different failure types (originality, brevity, usefulness, evidence safety). The `processOpportunityJudge` step tracks `polish_stats` in its result_payload. However, no API route or diagnostic aggregates these stats across runs. There is no A/B comparison mechanism — no way to compare "what if we hadn't polished" vs. "what we got after polishing." The `rejection_ledger` doesn't distinguish between pre-polish and post-polish rejections. |
| **Files** | `lib/near-pass-polish.ts`, `lib/opportunity-judge.ts`, `lib/pipeline-worker.ts` |
| **Risk** | Wasting Claude Sonnet 4.6 calls on unfixable candidates is a direct cost issue. More subtly, if polish is consistently ineffective for certain failure types, the model may be learning that "near-pass polish doesn't work" and generating increasingly conservative polish suggestions, creating a negative feedback loop. Alternatively, if polish is highly effective for certain failure types but the system doesn't know this, it may under-invest in polish for those types (e.g., only attempting 1 polish when 2 would be beneficial). |
| **Proposed Fix** | (1) **Polish success/failure diagnostics**: Add a `polish_effectiveness` object to the judge step's result_payload that tracks: `{by_failure_reason: {originality: {attempted: 5, passed: 0, still_failed: 5}, brevity: {attempted: 3, passed: 2, still_failed: 1}}, overall_pass_rate: 0.25}`. (2) **Skip polish for hopeless cases**: If a candidate's primary failure reason is originality (which requires fundamentally different content, not a touch-up), skip the polish attempt entirely and save the Claude 4.6 call. (3) **Polish budget per failure type**: Instead of a flat "polish all near-pass candidates", implement a per-failure-type budget: always polish brevity and usefulness failures (high success rate expected), sometimes polish evidence safety, never polish originality failures. (4) **Aggregate reporting**: Add a `/api/polish-effectiveness` endpoint that aggregates polish stats across the last N runs. |
| **Tests Needed** | (1) Polish effectiveness tracking for each failure reason, (2) Skip polish for originality failures, (3) Polish budget enforcement, (4) Aggregate reporting endpoint returns correct data, (5) Regression: existing polish behavior unchanged for non-skipped candidates |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes for diagnostics (additive only, no behavior change). The skip-polish-for-originality change alters behavior but is conservative — it only skips cases where polish is unlikely to help. The budget system requires more design work. **Recommendation**: implement diagnostics first, collect data for 1–2 weeks, then make data-driven decisions about which failure types to skip. |
| **Status** | 🔴 **NOT STARTED** |

---

### P2-3: Candidate Scoring Length Fitness

| Attribute | Detail |
|-----------|--------|
| **Problem** | The `computeLocalCandidateScore` function in `lib/candidate-selector.ts` evaluates candidates on niche fit, originality potential, and publishability, but does NOT consider whether the candidate's text length complies with the post length policy. This means a candidate that scores 9/10 on all dimensions but is 350 characters long (exceeding the 280-character free tier limit for @30piq) can be selected as one of the top 2 candidates sent to the judge. The judge will then either reject it for length (wasting a judge AI call) or pass it, only for the publish gate to hard-reject it (wasting the judge call AND potentially a polish call). The length check happens too late in the pipeline — it should be factored into the local scoring to prevent over-limit candidates from consuming downstream AI budget. |
| **Evidence** | In `lib/candidate-selector.ts`, the `computeLocalCandidateScore` formula combines `publishabilityScore * 0.4 + originalityPotential * 0.3 + nicheFitScore * 0.3` with no length component. The post length hard limit check happens in `lib/content-policy.ts` during the publish_gate step, which is step 8 of 11 — after 5 AI-heavy steps have already processed the candidate. The `post-length-policy.ts` module (198 lines) provides deterministic length checking that could be used earlier. |
| **Files** | `lib/candidate-selector.ts`, `lib/post-length-policy.ts`, `lib/content-policy.ts` |
| **Risk** | Each over-limit candidate that reaches the judge costs ~$0.02–0.05 for the judge call. If the judge passes it, the publish gate rejects it, but the cost is already sunk. If the judge fails it, the near-pass polish may attempt to shorten it (another ~$0.03–0.08), which may or may not succeed. In the worst case, an over-limit candidate consumes: candidate selection + crafting + quality evaluation + judge evaluation + near-pass polish + publish gate rejection = 6 AI calls totaling ~$0.15–0.30, all of which could have been avoided by a simple character count check at the local scoring stage. |
| **Proposed Fix** | Add a length fitness component to `computeLocalCandidateScore`: if the candidate text exceeds the post length limit, apply a penalty proportional to the overshoot. For example: `lengthFitness = text.length <= limit ? 1.0 : max(0, 1.0 - (text.length - limit) / limit)`. Then include lengthFitness in the score: `score = publishability * 0.35 + originality * 0.25 + nicheFit * 0.25 + lengthFitness * 0.15`. This doesn't eliminate over-limit candidates entirely (they can still be selected if other scores are very high) but makes them less likely to be chosen over length-compliant alternatives. |
| **Tests Needed** | (1) Under-limit candidate gets lengthFitness = 1.0, (2) Exactly-at-limit candidate gets lengthFitness = 1.0, (3) 10% over-limit gets lengthFitness = 0.9, (4) 50% over-limit gets lengthFitness = 0.5, (5) 100% over-limit gets lengthFitness = 0.0, (6) Over-limit candidate with perfect other scores still ranks below under-limit candidate, (7) Regression: existing scoring behavior unchanged for length-compliant candidates |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes. The length fitness component is additive and conservative — it only penalizes over-limit candidates, never boosts under-limit ones. The weight (0.15) can be adjusted if it proves too aggressive or too lenient. No downstream behavior changes are needed — this is a pure scoring improvement. |
| **Status** | 🔴 **NOT STARTED** |

---

### P2-4: Better No-Recommendation Messages

| Attribute | Detail |
|-----------|--------|
| **Problem** | When the pipeline produces no recommendation (all candidates were rejected by the judge, shield, or publish gate), the Telegram message simply says something like "No recommendation for today" without explaining why. The operator has no visibility into why content was rejected — was it because the sources produced low-quality content, because the judge was too strict, because the shield blocked everything, or because there simply weren't enough opportunities? The decision engine returns held items with reasons, and the rejection ledger records every rejection, but this information doesn't reach the operator's Telegram message. This means the operator can't take corrective action (e.g., adding better sources, adjusting thresholds) because they don't know what went wrong. |
| **Evidence** | The `processTelegramDelivery` function in `lib/pipeline-worker.ts` constructs the Telegram message. When the decision step returns no selected candidates, the message is a simple "no recommendation" text. The `decision.result_payload` contains `held_summary` with reasons, and the `publish_gate.result_payload` contains rejection reasons, but neither is included in the "no recommendation" message. |
| **Files** | `lib/pipeline-worker.ts`, `lib/daily-runner.ts`, `lib/telegram.ts` |
| **Risk** | Not a technical risk, but an operational one. Without knowing why content was rejected, the operator can't improve the system. Repeated "no recommendation" days without explanation lead to frustration and loss of trust in the system. The operator may assume the system is broken when it's actually working correctly (rejecting genuinely low-quality content), or may fail to notice when it's genuinely broken (e.g., a bug causing all content to be shield-rejected). |
| **Proposed Fix** | Include top rejection reasons in the "no recommendation" Telegram message. Structure: "📋 No recommendation — [N] opportunities analyzed, [M] candidates crafted, [K] rejected\n\nTop rejection reasons:\n• Shield: freshness (3 candidates)\n• Judge: originality below 7.8 (2 candidates)\n• Gate: post length exceeded (1 candidate)\n\n💡 Suggestion: Consider adding fresher sources or adjusting scan timing." The message should be concise (Telegram has message length limits) but informative. Use the rejection ledger and shield stats to generate the summary. |
| **Tests Needed** | None required — this is a message formatting change. Manual testing via Telegram is sufficient. |
| **DB Migration Required** | No |
| **Can Be Done Safely Now** | Yes. Message formatting changes have zero risk — they don't affect pipeline logic, only the information presented to the operator. The worst case is a poorly formatted message that's still readable. |
| **Status** | 🔴 **NOT STARTED** |

---

## P3 — Cleanup

These items address technical debt, code organization, and documentation. They're important for maintainability but don't affect pipeline correctness or quality.

---

### P3-1: Docs Organization ✅ ALREADY DONE

| Attribute | Detail |
|-----------|--------|
| **Status** | ✅ **COMPLETE** — Documentation reorganized into `docs/` with consistent naming, cross-references, and purpose statements. This file (`ROADMAP_REPAIR_PLAN.md`) and `ACTIVE_TABLES.md` are part of this effort. |

---

### P3-2: Legacy Table Classification ✅ ALREADY DONE

| Attribute | Detail |
|-----------|--------|
| **Status** | ✅ **COMPLETE** — All 48+ tables classified in `ACTIVE_TABLES.md` with categories, key columns, code references, and recommended actions. |

---

### P3-3: Indexes

| Attribute | Detail |
|-----------|--------|
| **Problem** | Several heavily-queried tables are missing critical indexes. The brain tables (`x_algorithm_learning_rules`, `viral_style_patterns`, `system_learning_rules`) need composite indexes on `(status, rule_type, confidence_score DESC)` for the queries that `brain-query.ts` and `structured-memory-retrieval.ts` execute. The `accounts` table needs an index on `(active, tier)` for pool selection queries. The `decision_runs` table needs indexes on `account_handle` and `created_at DESC`. The `compact_operator_rules` table needs an index on `(rule_type, confidence DESC)` for retrieval queries. Without these indexes, the queries perform full table scans, which is acceptable at current data volumes but will degrade significantly as the tables grow. |
| **Evidence** | The DATABASE_AUDIT_REPORT.md identifies specific missing indexes for each table. The `pipeline_tasks` table is well-indexed (7 indexes), but brain tables and audit tables have minimal indexing. |
| **Files** | SQL migration file to add indexes |
| **Proposed Fix** | Add the following indexes: (1) `idx_brain_rules_status_type_confidence` on `x_algorithm_learning_rules(status, rule_type, confidence_score DESC)`, (2) `idx_brain_patterns_status_type_confidence` on `viral_style_patterns(status, pattern_type, confidence_score DESC)`, (3) `idx_system_rules_status_type_confidence` on `system_learning_rules(status, rule_type, confidence_score DESC)`, (4) `idx_accounts_active_tier` on `accounts(active, tier)`, (5) `idx_decision_runs_handle_created` on `decision_runs(account_handle, created_at DESC)`, (6) `idx_compact_rules_type_confidence` on `compact_operator_rules(rule_type, confidence DESC)`. All indexes should be created CONCURRENTLY to avoid locking the tables. |
| **DB Migration Required** | Yes — new SQL migration file with `CREATE INDEX CONCURRENTLY` statements |
| **Status** | 🔴 **NOT STARTED** — Proposed indexes documented in `DATABASE_AUDIT_REPORT.md` |

---

### P3-4: RLS (Row Level Security)

| Attribute | Detail |
|-----------|--------|
| **Problem** | Two cost logging tables (`pipeline_cost_ledger`, `rejection_ledger`) have RLS enabled but no policies. This means `anon` and `authenticated` roles are silently blocked (the service role bypasses RLS, so it works in production). This creates a false sense of security — someone looking at the RLS status would think the tables are protected, but the reality is that they're inaccessible to non-service roles with no documented policy to guide future access needs. Additionally, several memory tables (`compact_operator_rules`, `source_author_memory`, `memory_compaction_runs`) have no RLS at all, meaning any role can read/write them if they have basic Supabase access. |
| **Evidence** | DATABASE_AUDIT_REPORT.md Section 2.4 and 2.5 document the RLS gaps. The migration files for `pipeline_cost_ledger` and `rejection_ledger` enable RLS but don't create policies. |
| **Files** | SQL migration file to add RLS policies |
| **Proposed Fix** | (1) Add "Service role full access" policies to `pipeline_cost_ledger` and `rejection_ledger` (matching the pattern used by other tables). (2) Enable RLS on `compact_operator_rules`, `source_author_memory`, and `memory_compaction_runs` with service role policies. (3) Document the intentional RLS design: all tables use service role access from the pipeline, with no direct user-facing access. |
| **DB Migration Required** | Yes — SQL migration to create policies and enable RLS |
| **Status** | 🔴 **NOT STARTED** — Plan documented in `DATABASE_AUDIT_REPORT.md` |

---

### P3-5: Refactor pipeline-worker.ts

| Attribute | Detail |
|-----------|--------|
| **Problem** | `lib/pipeline-worker.ts` is 3080 lines long, containing all 11 step processors plus helper functions. This makes it difficult to navigate, test individual steps in isolation, and review changes. A modification to the `processTelegramDelivery` function requires opening a 3000-line file and navigating to line ~2900. The step processors are logically independent — `processOpportunityJudge` doesn't call `processPublishGate` — but they're physically coupled in the same file, meaning any change to any step risks introducing bugs in unrelated steps through accidental edits or merge conflicts. |
| **Evidence** | The file is the largest in the project at 3080 lines. It contains 11 exported step processor functions plus numerous helper functions. The ACTIVE_SYSTEM_MAP.md identifies this as a medium-priority issue (#7 in Section 9.3). |
| **Files** | `lib/pipeline-worker.ts` → split into `lib/pipeline-steps/load-account-state.ts`, `lib/pipeline-steps/scan-account.ts`, ..., `lib/pipeline-steps/telegram-delivery.ts`, plus `lib/pipeline-steps/index.ts` for the step registry |
| **Proposed Fix** | Split `pipeline-worker.ts` into per-step modules under `lib/pipeline-steps/`. Each module exports its processor function and any step-specific helpers. The main `pipeline-worker.ts` becomes a thin dispatcher that imports all step modules and routes tasks to the appropriate processor. This is a pure refactoring with no behavioral changes. |
| **Status** | 🔴 **NOT STARTED** |

---

### P3-6: Refactor content-engine-v3.ts

| Attribute | Detail |
|-----------|--------|
| **Problem** | `lib/content-engine-v3.ts` is 2696 lines long, containing scan logic, analysis functions, discovery mechanisms, and crafting utilities. Similar to `pipeline-worker.ts`, its size makes maintenance and testing difficult. The file has at least 4 distinct responsibilities: (1) viral tweet scanning and analysis, (2) content discovery from scan results, (3) tweet crafting from opportunities, (4) brain/learning integration during scans. These should be separate modules. |
| **Evidence** | The file is the second-largest in the project. The ACTIVE_SYSTEM_MAP.md identifies this as a medium-priority issue (#8 in Section 9.3). |
| **Files** | `lib/content-engine-v3.ts` → split into `lib/scan-engine.ts`, `lib/discovery-engine.ts`, `lib/crafting-engine.ts`, `lib/brain-integration.ts` |
| **Proposed Fix** | Split `content-engine-v3.ts` into focused modules by responsibility. The `scan-engine` handles the scan_account pipeline step's content analysis. The `discovery-engine` handles opportunity discovery from scan results. The `crafting-engine` handles tweet crafting. The `brain-integration` handles learning rule extraction and style pattern detection. This is a pure refactoring with no behavioral changes. |
| **Status** | 🔴 **NOT STARTED** |

---

### P3-7: Arabic Strings

| Attribute | Detail |
|-----------|--------|
| **Problem** | The project was originally designed for an Arabic-speaking audience and some Arabic strings remain in the codebase, particularly in the Telegram keyboard layout and some inline comments. Since the system now operates in English for @30piq, these Arabic strings are confusing for English-speaking maintainers and may cause rendering issues in non-Arabic Telegram clients. The Arabic keyboard labels are the most visible issue — they appear in the operator's Telegram interface. |
| **Evidence** | The ACTIVE_SYSTEM_MAP.md identifies this as a medium-priority issue (#10 in Section 9.3). Arabic strings appear in `lib/telegram.ts` (keyboard layout) and scattered comments in various files. |
| **Files** | `lib/telegram.ts`, various files with Arabic comments |
| **Proposed Fix** | (1) Translate all Arabic Telegram keyboard labels to English. (2) Add English translations as inline comments for any remaining Arabic strings that serve a purpose (e.g., content targeting for Arabic audiences if that feature is ever re-enabled). (3) Document the original Arabic context in a `CULTURAL_NOTES.md` file so the history isn't lost. |
| **Status** | 🔴 **NOT STARTED** |

---

## P4 — Future

These items represent long-term feature development. They're important for the system's evolution but require significant design work and shouldn't be attempted until P0–P2 are complete.

---

### P4-1: Dashboard — Web UI for Run Monitoring

| Attribute | Detail |
|-----------|--------|
| **Problem** | Currently, the only way to monitor pipeline runs is through Telegram (which shows only the latest run's results) or by querying the Supabase database directly. There's no visual dashboard showing run history, cost trends, rejection patterns, or memory system health over time. |
| **Proposed Fix** | Build a Next.js web dashboard with pages for: (1) Run history with status timeline, (2) Cost tracking with per-model breakdown, (3) Rejection analytics with per-reason charts, (4) Memory system health (rule count, confidence distribution, decay status), (5) Source quality scores with trend lines. Use the existing `app/` Next.js structure and Supabase client. |
| **Dependencies** | P1-3 (shield per-check diagnostics), P2-2 (polish effectiveness data), P3-3 (indexes for query performance) |
| **Status** | 🔴 **NOT STARTED** |

---

### P4-2: UI Controls — Account Profile Editor, Source Management

| Attribute | Detail |
|-----------|--------|
| **Problem** | Currently, account management (adding sources, changing tiers, updating categories) is done through Telegram commands, which are limited in expressiveness. There's no way to edit source categories in bulk, view source quality scores side-by-side, or adjust model routing rules without direct database access. |
| **Proposed Fix** | Build admin UI pages for: (1) Account/source pool management (add, remove, tier, category, quality score display), (2) Model routing configuration (change models, temperatures, toggle active), (3) Memory browser (view/search/delete rules), (4) Shield threshold adjustment with live preview. These should be protected by authentication and accessible only to the operator. |
| **Dependencies** | P1-1 (source strategy with category support), P3-4 (RLS policies for security), P4-1 (dashboard as foundation) |
| **Status** | 🔴 **NOT STARTED** |

---

### P4-3: Premium/Longform Support

| Attribute | Detail |
|-----------|--------|
| **Problem** | The current system enforces a hard 280-character limit based on @30piq's free X tier. If the account upgrades to X Premium (8,000 character limit for tweets, or 25,000 for Premium+), the entire length policy system needs to be reconfigured. Currently, the length limit is hardcoded in `post-length-policy.ts` and referenced by the publish gate, candidate scoring, and near-pass polish. Supporting longer posts would also require new crafting strategies (thread-style single posts, structured long-form content) and new quality criteria (is a 2,000-character post actually better than a 280-character one?). |
| **Proposed Fix** | (1) Make the post length limit configurable per account (read from `account_state` or a config table). (2) Add crafting strategies for long-form content (structured sections, progressive disclosure, list format). (3) Add quality criteria for longer posts (information density, readability, section transitions). (4) Update judge prompts to evaluate long-form content appropriately. (5) Update the candidate scoring length fitness to use the account-specific limit. |
| **Dependencies** | P2-3 (length fitness in candidate scoring), P1-4 (prompt wording for new content types) |
| **Status** | 🔴 **NOT STARTED** |

---

### P4-4: Multi-Account Support

| Attribute | Detail |
|-----------|--------|
| **Problem** | The system currently supports only one X account (@30piq). The `account_state` table has `account_handle` as primary key, suggesting multi-account was considered, but the pipeline hardcodes the single account in many places. Supporting multiple accounts would require: separate source pools per account, separate quality thresholds, separate Telegram delivery targets, and careful isolation of memory/rules between accounts. |
| **Proposed Fix** | (1) Add `account_id` as a first-class parameter throughout the pipeline (currently implicit). (2) Support multiple `account_state` rows. (3) Add per-account source pool configuration. (4) Add per-account Telegram delivery routing. (5) Add account-level isolation for memory/rules (or shared memory with account-specific weighting). (6) Add account-level cost tracking. |
| **Dependencies** | Nearly all P0–P2 items (the system must be robust for one account before scaling to multiple) |
| **Status** | 🔴 **NOT STARTED** |

---

### P4-5: Performance Feedback Loop

| Attribute | Detail |
|-----------|--------|
| **Problem** | The system currently has no way to measure whether published content actually performed well on X. The `published_decisions` table tracks what was published, and `lib/performance-feedback.ts` exists to fetch engagement metrics, but the loop is not closed: there's no mechanism to correlate published content with engagement metrics and feed that back into the memory/rules system. This means the system can't learn from its successes — it only learns from its failures (via the rejection ledger). A content piece that gets 10,000 views and 500 likes should generate "winning pattern" rules, but currently there's no mechanism for this. |
| **Proposed Fix** | (1) Implement a scheduled job (via cron) that checks `published_decisions` where `performance_checked = false`, fetches engagement metrics from the X API, and updates the decision with performance data. (2) When a published piece has above-average engagement (e.g., top 20% of published content), extract positive signals and create "winning_angle" rules in `compact_operator_rules`. (3) When a published piece has below-average engagement, analyze why and create anti-pattern rules. (4) Add `performance_feedback` as a new pipeline step that runs periodically (not on every run). (5) Surface performance trends in the dashboard (P4-1). |
| **Dependencies** | P2-1 (memory system with positive signal extraction), P4-1 (dashboard for visualization), X API access for engagement metrics |
| **Status** | 🔴 **NOT STARTED** |

---

### P4-6: A/B Testing Framework

| Attribute | Detail |
|-----------|--------|
| **Problem** | The system currently has no way to systematically test whether changes to prompts, scoring weights, or thresholds actually improve outcomes. When a change is made (e.g., adjusting the judge threshold from 7.8 to 8.0), the only way to evaluate it is to run the pipeline with the new settings and compare subjectively against historical results. There's no controlled comparison — too many variables change between runs (different source content, different model outputs, different time of day). |
| **Proposed Fix** | (1) Implement an A/B testing framework where alternate configurations (prompts, weights, thresholds) can be defined and randomly assigned to runs. (2) Track outcomes (rejection rates, judge scores, operator publish decisions, engagement metrics) for each configuration. (3) Provide statistical significance testing to determine when a configuration change is genuinely better. (4) Support gradual rollout (e.g., 10% of runs use the new config, 90% use the old). (5) Surface A/B test results in the dashboard. |
| **Dependencies** | P4-5 (performance feedback loop for outcome measurement), P1-3 (diagnostics for comparison), P4-1 (dashboard for test visualization) |
| **Status** | 🔴 **NOT STARTED** |

---

## Implementation Priority Matrix

| Item | Priority | Effort | Impact | Dependencies | Status |
|------|----------|--------|--------|-------------|--------|
| P0-1: Adjacent topic patterns | P0 | S | H | None | ✅ DONE |
| P0-2: Forced angle hard gate | P0 | M | H | None | 🔴 TODO |
| P1-1: Source strategy | P1 | L | H | DB migration | 🔴 TODO |
| P1-2: Parser hardening | P1 | M | M | None | 🔴 TODO |
| P1-3: Shield diagnostics | P1 | M | M | None | 🔴 TODO |
| P1-4: Prompt wording | P1 | S | L | None | 🔴 TODO |
| P2-1: Memory tuning | P2 | L | H | DB migration for decay | 🔴 TODO |
| P2-2: Polish audit | P2 | M | M | None | 🔴 TODO |
| P2-3: Length fitness | P2 | S | M | None | 🔴 TODO |
| P2-4: Better messages | P2 | S | M | None | 🔴 TODO |
| P3-1: Docs organization | P3 | S | L | None | ✅ DONE |
| P3-2: Legacy table classification | P3 | S | L | None | ✅ DONE |
| P3-3: Indexes | P3 | S | M | DB migration | 🔴 TODO |
| P3-4: RLS | P3 | S | L | DB migration | 🔴 TODO |
| P3-5: Refactor pipeline-worker | P3 | L | M | None | 🔴 TODO |
| P3-6: Refactor content-engine | P3 | L | M | None | 🔴 TODO |
| P3-7: Arabic strings | P3 | S | L | None | 🔴 TODO |
| P4-1: Dashboard | P4 | L | H | P1-3, P2-2, P3-3 | 🔴 TODO |
| P4-2: UI controls | P4 | L | H | P1-1, P3-4, P4-1 | 🔴 TODO |
| P4-3: Premium/longform | P4 | M | M | P2-3, P1-4 | 🔴 TODO |
| P4-4: Multi-account | P4 | XL | H | All P0–P2 | 🔴 TODO |
| P4-5: Performance feedback | P4 | L | H | P2-1, P4-1 | 🔴 TODO |
| P4-6: A/B testing | P4 | L | H | P4-5, P1-3, P4-1 | 🔴 TODO |

**Effort**: S = Small (< 1 day), M = Medium (1–3 days), L = Large (3–7 days), XL = Extra Large (2+ weeks)
**Impact**: L = Low, M = Medium, H = High

---

## Recommended Implementation Order

Based on the priority matrix, here's the suggested implementation sequence:

```
Week 1:  P0-2 (forced angle) → P1-4 (prompt wording) → P1-3 (shield diagnostics)
Week 2:  P1-2 (parser hardening) → P2-3 (length fitness) → P2-4 (better messages)
Week 3:  P2-1 (memory tuning — confidence floor first) → P2-2 (polish audit — diagnostics first)
Week 4:  P1-1 (source strategy) → P3-3 (indexes) → P3-4 (RLS)
Month 2: P3-5 (refactor pipeline-worker) → P3-6 (refactor content-engine) → P3-7 (Arabic strings)
Month 3: P2-1 (memory tuning — decay + positive signals) → P1-1 (source strategy — full implementation)
Month 4+: P4 items (dashboard, UI controls, performance feedback, A/B testing)
```

---

## How to Use This Document

1. **Before starting any fix**: Read the relevant section completely, including the "Can Be Done Safely Now" assessment
2. **During implementation**: Create a branch named `fix/P0-2-forced-angle-gate` (or similar), write tests first, then implement
3. **After implementation**: Update the status emoji in this document (🔴 → 🟡 → ✅), add a completion date
4. **When new issues are discovered**: Add them to the appropriate priority level with full detail
5. **Periodically (monthly)**: Review P3/P4 items and promote any that have become more urgent

---

*End of ROADMAP_REPAIR_PLAN.md. This document should be updated whenever fixes are implemented, new issues are discovered, or priorities change.*
