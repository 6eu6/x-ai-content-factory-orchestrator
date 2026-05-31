# PRE/POST CHANGE DEEP VERIFICATION AUDIT

**Date**: 2026-06-01  
**Auditor**: Automated Audit System  
**Repo**: `6eu6/x-ai-content-factory-orchestrator`  
**Branch**: `main`  
**Commit**: `25cda8f`  
**Verdict**: **NEEDS FOLLOW-UP**

---

## Section A: Repository State

| Item | Value | Status |
|------|-------|--------|
| Branch | `main` | OK |
| HEAD SHA | `25cda8fc66bfc6af9ef34da60a7421aae153b63c` | OK |
| Working tree | Clean (no uncommitted changes) | OK |
| TypeScript check | `npx tsc --noEmit` — PASS | OK |
| Next.js build | `npm run build` — PASS | OK |
| Test suite | 35 test files, 922 tests PASS | OK |
| Last 5 commits | docs, fix, audit, feat(S1.3), fix(S1.2) | OK |

### Environment Keys Verification

| Key | Required | Verified | Status |
|-----|----------|----------|--------|
| `SUPABASE_URL` | Yes | `https://qmoictvgwavhirnexscz.supabase.co` | OK - reachable |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | JWT valid, service_role | OK - auth works |
| `ORCHESTRATOR_SECRET` | Yes | Present | OK |
| `OPENAI_API_KEY` | Yes | `sk-or-v1-*` (OpenRouter) | OK |
| `OPENAI_BASE_URL` | Yes | `https://openrouter.ai/api/v1` | OK |
| `OPENAI_MODEL` | Yes | `openai/gpt-4.1-mini` | OK |
| `TWITTERAPI_IO_KEY` | Yes | Present | OK |
| `X_USERNAME` | Yes | `30piq` | OK |
| `TELEGRAM_BOT_TOKEN` | Yes | Present | OK |
| `TELEGRAM_ALLOWED_CHAT_ID` | Yes | `5654610649` | OK |
| `GITHUB_TOKEN` | Yes | `ghp_*` | OK |
| `SERPER_API_KEY` | Yes | Present | OK |
| `SERPAPI_API_KEY` | Yes | Present | OK |
| `DAILY_SCAN_ACCOUNT_LIMIT` | Yes | `10` | OK |
| `DAILY_SCAN_TWEETS_PER_ACCOUNT` | Yes | `8` | OK |
| `CRON_SCAN_ACCOUNT_LIMIT` | Yes | `2` | OK |
| `CRON_MAX_RUNTIME_MS` | Yes | `45000` | OK |
| `PUBLIC_BASE_URL` | Yes | Vercel URL | OK |

---

## Section B: Dangerous Pattern Scan

### B1: Auto-Posting
**Result: CLEAR** — No auto-posting code found. All X API calls are read-only. Publishing pipeline delivers to Telegram for manual copy/publish only. Line reference: `publishing-pipeline.ts:283` — "Publishing is manual — the user decides".

### B2: Threshold Changes
**Result: OK with WARNING** — All 5 hard thresholds in `opportunity-judge.ts` match spec:

| Threshold | Spec | Code (Line) | Match |
|-----------|------|-------------|-------|
| `final_candidate_score` | >= 7.8 | 7.8 (line 58) | YES |
| `originality_score` | >= 7.8 | 7.8 (line 61) | YES |
| `usefulness_score` | >= 7 | 7 (line 64) | YES |
| `evidence_safety_score` | >= 8 | 8 (line 67) | YES |
| `brief_alignment_score` | >= 7.5 | 7.5 (line 70) | YES |

**WARNING**: `decision-engine.ts` has stage-dependent thresholds (7.0–7.8) that are LOWER than the judge gate. Not a safety hole (judge runs first), but misleading documentation. **Severity: P3**

### B3: Judge/Shield/Publish Gate Bypass
**Result: WARNING** — `lib/daily-runner.ts` (line 115–118) bypasses `opportunity_intelligence`, `quality_enhance`, and `opportunity_judge`. Marked as DEPRECATED but still callable via `app/api/daily-run/route.ts`. **Severity: P2**

### B4: Prompt Drift
**Result: WARNING** — 9 stale prompts still use `"AI x Productivity x Career Growth"` instead of the S1.3 broad account lens definition:

| File | Count | Lines |
|------|-------|-------|
| `content-type-engine.ts` | 4 | 92, 474, 509, 542 |
| `media-pipeline.ts` | 2 | 79, 151 |
| `content.ts` | 1 | 238 |
| `viral-discovery-run/route.ts` | 1 | 56 |
| `growth.ts` | 1 | 73 |

Also: `content-engine-v3.ts` line 990 has overly-broad prompt: "Do NOT assume any specific niche for @30piq — the account covers diverse topics and can tweet about anything" — contradicts S1.3 lens. **Severity: P1**

### B5: Telegram Contract Violations
**Result: CLEAR** — Manual-only text present in Arabic ("انسخ وانشر يدويًا فقط"). No auto-publish button. "نشرت" command only logs URL, does not trigger posting.

### B6: Destructive DB Operations
**Result: CLEAR (INFO)** — `system-cleanup` route has controlled deletion with safeguards (dry_run default, assertAuthorized, confirm parameter). No DROP TABLE or TRUNCATE in migrations.

### B7: Hardcoded Secrets
**Result: CLEAR** — All credentials sourced from environment variables. No hardcoded API keys in source files.

---

## Section C: Pipeline Flow Audit

Expected 12 stages: load_account_state → scan_account → merge_scan_results → opportunity_intelligence → enrich_opportunities → quality_enhance → opportunity_judge → publish_gate → decision → persist_decision → telegram_delivery → memory_compaction

### Stage-by-Stage Verification

| # | Stage | File | Function | Error Handling | Bypass Risk |
|---|-------|------|----------|----------------|-------------|
| 1 | load_account_state | pipeline-worker.ts | processLoadAccountState | try/catch | None |
| 2 | scan_account | pipeline-worker.ts | processScanAccount | try/catch | None |
| 3 | merge_scan_results | pipeline-worker.ts | processMergeScanResults | try/catch | None |
| 4 | opportunity_intelligence | opportunity-intelligence.ts | evaluateOpportunity | try/catch + hard rules | None |
| 5 | enrich_opportunities | pipeline-worker.ts | processEnrichOpportunities | try/catch | None |
| 6 | quality_enhance | pipeline-worker.ts | processQualityEnhance | try/catch | None |
| 7 | opportunity_judge | opportunity-judge.ts | judgeCraftedCandidate | try/catch + hard thresholds | None |
| 8 | publish_gate | pipeline-worker.ts | processPublishGate | try/catch | None |
| 9 | decision | decision-engine.ts | makeDecision | try/catch | None |
| 10 | persist_decision | pipeline-worker.ts | processPersistDecision | try/catch | None |
| 11 | telegram_delivery | pipeline-worker.ts | processTelegramDelivery | try/catch | None |
| 12 | memory_compaction | structured-memory-compaction.ts | compactRunIntoMemory | try/catch (fire-and-forget) | **SKIPPED when notify_telegram=false** |

### Pipeline Findings

**FINDING C1 (P1)**: `memory_compaction` is called inside `processTelegramDelivery()`, after the `notify_telegram=false` early return (line 2935–2938 vs line 3062). When Telegram delivery is disabled, memory compaction is silently skipped. Over time, memory rules go stale, degrading quality.

**FINDING C2 (P2)**: `opportunity_judge` does NOT enforce post length policy. A 500-char text can pass the judge with perfect scores and only get caught at `publish_gate`, wasting expensive near-pass polish compute on text that will ultimately fail on length alone.

**FINDING C3 (P3)**: `near-pass-polish.ts` `buildMicroRepairPrompt()` (lines 880, 908) uses `getDefaultPostLengthPolicy().hard_limit_chars` (280) instead of the injected `post_length_policy` parameter. If @30piq upgrades to Premium, micro-repair would still enforce 280 chars.

---

## Section D: Post Length Policy (S1.2) Audit

### Policy Definition Check

| Parameter | Spec | Code | Match |
|-----------|------|------|-------|
| `hard_limit_chars` | 280 | 280 | YES |
| `target_chars` | 240 | 240 | YES |
| `allow_longform` | false | false | YES |
| `platform` | x | x | YES |
| `subscription_tier` | free | free | YES |

### Enforcement Coverage

| Pipeline Stage | Enforced | How |
|----------------|----------|-----|
| Content crafting | YES | `buildPostLengthInstruction()` in craft prompts |
| Candidate selection | YES | `validatePostLength()` in selector |
| Near-pass polish | YES | `buildShortenInstruction()` + length check |
| Micro-repair | PARTIAL | Uses `getDefaultPostLengthPolicy()` instead of injected policy (P3) |
| **Opportunity judge** | **NO** | No length check before expensive AI judge call (P2) |
| Publish gate | YES | Final `validatePostLength()` check |

### Test Coverage
45 tests in `phase-s1-2-post-length-policy.test.ts` — ALL PASS

---

## Section E: Account Growth Lens (S1.3) Audit

### S1.3 Definition Alignment

The account lens definition is now: **"AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture."**

### ALLOWED_ADJACENT_TOPICS Coverage

| Adjacent Topic | In ALLOWED_ADJACENT_TOPICS | In ADJACENT_TOPIC_PATTERNS | Status |
|---------------|---------------------------|---------------------------|--------|
| entertainment | YES | YES | OK |
| sports/boxing | YES | YES | OK |
| anime/comics/movies | YES | YES | OK |
| internet trends | YES | YES | OK |
| social media behavior | YES | YES | OK |
| **crypto/web3** | YES | YES (added in audit commit 2fc0616) | FIXED |
| **politics/policy** | YES | YES (added in audit commit 2fc0616) | FIXED |
| **gaming** | YES | YES (added in audit commit 2fc0616) | FIXED |

**Previous mismatch (crypto/web3, politics/policy, gaming in ALLOWED but not in PATTERNS) is now FIXED.**

### BLOCKED_TOPICS Coverage

All blocked topics from spec are present: pure gossip, pure fandom, pure sports commentary, political ragebait, crypto speculation, memes without insight, forced/generic AI angles.

### Forced Angle Detection
`FORCED_ANGLE_PATTERNS` in `niche-alignment.ts` correctly detects generic AI angle force-fitting. 9 patterns covering "means AI will...", "AI lesson from...", etc.

### Test Coverage
49 tests in `phase-s1-3-account-growth-lens.test.ts` — ALL PASS

---

## Section F: Source Pool & Strategy Audit

### Active Accounts (27 total)

| Handle | Tier | Category | Last Checked |
|--------|------|----------|-------------|
| karpathy | 1 | AI researcher | 2026-05-31 |
| levelsio | 1 | Indie hacker + AI | 2026-05-31 |
| steipete | 1 | AI builder | 2026-05-31 |
| thegreatest_sv | 1 | AI tools + deep guides | 2026-05-31 |
| AIHighlight | 1 | AI tools daily | 2026-05-31 |
| emollick | 1 | AI researcher | 2026-05-31 |
| icrptd | 1 | Tech tool discoveries | 2026-05-31 |
| AIFrontliner | 2 | AI news | 2026-05-31 |
| corbin_braun | 2 | AI builder | 2026-05-31 |
| gregisenberg | 2 | Startup ideas + AI | 2026-05-31 |
| TomSolidPM | 2 | AI Productivity systems | 2026-05-31 |
| KeepProductive | 2 | Tool reviews | 2026-05-31 |
| MengTo | 2 | Design + AI | 2026-05-31 |
| godofprompt | 2 | AI prompts | 2026-05-31 |
| TheAIColony | 2 | AI education | 2026-05-31 |
| ... + 7 more tier 2/3 accounts | | | |

### Corrupted Accounts (3 entries — NOT real handles)

| Handle | Issue |
|--------|-------|
| `📋` | Emoji — not a valid X handle |
| `قائمة` | Arabic for "list" — not a valid handle |
| `الحسابات` | Arabic for "accounts" — not a valid handle |

**Action needed**: Delete these 3 corrupted entries. They were likely inserted during a UI or test artifact.

### `source_quality_scores` Table
**CRITICAL: MISSING from production database.** The migration file exists (`supabase-migrations/2026-05-31_source_quality_scores.sql`) but was never applied. This means the entire source quality feedback loop is non-functional.

---

## Section G: Live Run / Dry-Run Test

### Recent Pipeline Runs (last 5)

| Run ID | Source | Status | Duration |
|--------|--------|--------|----------|
| 1d897c41 | telegram-unified | completed | ~20 min |
| b8247625 | telegram-unified | completed | ~21 min |
| fbc32a31 | telegram-unified | completed | ~17 min |
| b73bd8a5 | telegram-unified | completed | ~21 min |
| 15aed484 | telegram-unified | completed | ~27 min |

All recent runs completed successfully. Average runtime: ~21 minutes.

### Published Decisions (6 total)

| Account | Type | Status | URL |
|---------|------|--------|-----|
| emollick | single_tweet | published | x.com/emollick/status/2059... |
| emollick | quote | published | x.com/emollick/status/2059... |
| emollick | quote | published | x.com/emollick/status/2059... |
| 30piq | single_tweet | published | x.com/30piq/status/1925... |
| 30piq | reply | published | twitter.com/30piq/status/1934... |
| 30piq | single_tweet | published | x.com/30piq/status/1934... |

---

## Section H: Memory Compaction Audit

### compact_operator_rules (33 entries)

Sample entries show anti-pattern rules with:
- `rule_type`: "anti_pattern"
- `confidence`: 0.4 (low — needs more data)
- `source_author`: Mostly "karpathy" (only author with memory so far)
- Topics: judging, product, fireside_chat_sequoia

### source_author_memory (1 entry)

| Author | Topics | Bad Angles | Typical Failures |
|--------|--------|------------|-----------------|
| karpathy | 7 topics | 13 bad angles | originality_below_7.8 (18), final_score_below_7.8 (13), brief_alignment_below_7.5 (8), usefulness_below_7 (7), evidence_safety_below_8 (3) |

### memory_compaction_runs (5 entries, all completed successfully)

All runs show `status: completed` with no errors. Rules created range from 4–11 per run.

### FINDING H1 (P1): Memory compaction skipped when `notify_telegram=false`
As noted in Section C, the `compactRunIntoMemory()` call is inside `processTelegramDelivery()` after the early return. This means non-Telegram runs do not compact memory, causing stale rules over time.

---

## Section I: Cost & API Key Audit

### Model Routing Rules

| Task Type | Model | Temp | Max Tokens |
|-----------|-------|------|------------|
| performance_analysis | meta-llama/llama-4-maverick | 0.1 | 2000 |
| content_crafting | deepseek/deepseek-chat-v3-0324 | 0.2 | 2500 |
| casual_generation | mistralai/mistral-small-3.1-24b-instruct | 0.4 | 600 |
| opportunity_intelligence | anthropic/claude-opus-4.8 | 0.03 | 2600 |
| opportunity_judge | anthropic/claude-sonnet-4.6 | 0.02 | 1200 |

### Cost Ledger
- 3,802 rows in `pipeline_cost_ledger`
- No anomalous cost patterns detected
- Model routing uses cost-appropriate models per task type

### API Key Security
- No hardcoded keys in source files
- All keys sourced from environment variables via `requiredEnv()` and `optionalEnv()`
- OpenRouter key format correct (`sk-or-v1-*`)
- Supabase key is service_role (appropriate for server-side)

---

## Section J: Database Schema & Active Tables Audit

### Critical Tables

| Table | Rows | Status |
|-------|------|--------|
| pipeline_cost_ledger | 3,802 | ACTIVE |
| x_algorithm_learning_rules | 2,582 | ACTIVE |
| viral_style_patterns | 1,307 | ACTIVE |
| viral_tweet_analyses | 810 | ACTIVE |
| pipeline_tasks | 644 | ACTIVE |
| rejection_ledger | 397 | ACTIVE |
| compact_operator_rules | 33 | ACTIVE |
| pipeline_runs | 35 | ACTIVE |
| source_author_memory | 1 | ACTIVE |
| **source_quality_scores** | **MISSING** | **NOT APPLIED** |
| memory_compaction_runs | 5 | ACTIVE |
| published_decisions | 6 | ACTIVE |
| accounts | 27 | ACTIVE (3 corrupted) |

### Orphaned Tables (0 rows, not referenced in code)

- monthly_reviews
- problem_solution_opportunities
- repo_growth_snapshots
- repo_maintenance_events
- repos
- research_refs
- system_health_checks
- target_status
- x_publication_metrics

### Code vs DB Discrepancies

- **DB-only (not in code)**: 12 tables including `daily_stats`, `monthly_reviews`, etc.
- **Code-only (not in DB)**: `source_quality_scores` — migration exists but was never applied

---

## Section K: Docs Accuracy Audit

### Existing Documentation Files

| Doc | Present | Last Updated | Accuracy |
|-----|---------|-------------|----------|
| AUDIT_BASELINE.md | YES | 2026-06-01 | Needs update with current SHA |
| ACTIVE_SYSTEM_MAP.md | YES | 2026-06-01 | Should reflect S1.3 changes |
| DATABASE_AUDIT_REPORT.md | YES | 2026-06-01 | Missing source_quality_scores note |
| SOURCE_STRATEGY_AUDIT.md | YES | 2026-06-01 | Should note corrupted accounts |
| ACCOUNT_LENS_AUDIT.md | YES | 2026-06-01 | Should reflect fixed S1.3 patterns |
| QUALITY_PIPELINE_AUDIT.md | YES | 2026-06-01 | Should note judge length gap |
| MEMORY_AUDIT.md | YES | 2026-06-01 | Should note compaction skip issue |
| TELEGRAM_DECISION_CONTRACT_AUDIT.md | YES | 2026-06-01 | OK |
| TEST_COVERAGE_AUDIT.md | YES | 2026-06-01 | 922 tests |
| OPERATIONS_RUNBOOK.md | YES | 2026-06-01 | OK |
| ACTIVE_TABLES.md | YES | 2026-06-01 | Missing source_quality_scores |
| ROADMAP_REPAIR_PLAN.md | YES | 2026-06-01 | Should update P0/P1 status |
| sql/proposed_source_pool_cleanup.sql | YES | Present | Should include corrupted account cleanup |

---

## Summary of Findings

### P0 — Critical (Must Fix Immediately)

| ID | Finding | Impact |
|----|---------|--------|
| J1 | `source_quality_scores` table missing from production DB | Source quality feedback loop is completely non-functional. Migration file exists but was never applied. |

### P1 — High Priority

| ID | Finding | Impact |
|----|---------|--------|
| C1/H1 | Memory compaction skipped when `notify_telegram=false` | Memory rules go stale over time, degrading craft/polish quality |
| B4 | 9 stale "AI x Productivity x Career Growth" prompts | Prompt drift — content generation uses outdated narrow lens |
| B4b | content-engine-v3.ts overly-broad prompt | Contradicts S1.3 lens, could produce off-lens content |

### P2 — Medium Priority

| ID | Finding | Impact |
|----|---------|--------|
| C2 | Judge doesn't enforce post length policy | Wastes compute on text that will fail at publish_gate |
| B3 | Legacy daily-runner bypasses judge/shield | Still callable via API route, could produce unjudged content |

### P3 — Low Priority

| ID | Finding | Impact |
|----|---------|--------|
| C3 | Micro-repair uses getDefaultPostLengthPolicy() instead of injected | Won't adapt if @30piq upgrades to Premium |
| B2 | Decision engine thresholds (7.0–7.8) lower than judge (7.8) | Misleading but not a safety hole |
| F1 | 3 corrupted accounts in DB (emoji/Arabic) | Harmless but messy |

---

## VERDICT: **NEEDS FOLLOW-UP**

The system is **NOT in a dangerous state** — no auto-posting, no threshold violations, no security holes. However, there are 1 P0 and 3 P1 issues that must be addressed before the system can be considered fully operational:

1. **P0**: Apply `source_quality_scores` migration to production DB immediately
2. **P1**: Fix memory compaction placement in pipeline-worker.ts
3. **P1**: Update 9 stale prompts to S1.3 broad account lens
4. **P1**: Fix overly-broad prompt in content-engine-v3.ts

After these fixes are applied, run the POST-CHANGE verification audit using the shorthand template to confirm all changes are clean.
