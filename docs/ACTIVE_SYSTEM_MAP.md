# ACTIVE SYSTEM MAP — x-ai-content-factory-orchestrator

> **Project**: X (Twitter) content opportunity/recommendation engine for **@30piq**
> **Purpose**: Scans X accounts, discovers viral content, evaluates opportunities, crafts tweets, judges them strictly, and sends only **Telegram recommendations for manual publishing**. **No auto-posting.**
> **Last Updated**: 2025-03-04
> **Audience**: Future agents, maintainers, and contributors who need a full mental model of the active system.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Two Pipeline Execution Paths](#2-two-pipeline-execution-paths)
3. [Entrypoints](#3-entrypoints)
4. [Active Pipeline Steps (Queue-Based)](#4-active-pipeline-steps-queue-based)
5. [Active Files (Core Runtime)](#5-active-files-core-runtime)
6. [Active DB Tables](#6-active-db-tables)
7. [Legacy / Experimental Tables](#7-legacy--experimental-tables)
8. [DO NOT TOUCH Invariants](#8-do-not-touch-invariants)
9. [Identified Issues & Technical Debt](#9-identified-issues--technical-debt)
10. [Architecture Diagram](#10-architecture-diagram)
11. [Key Data Flows](#11-key-data-flows)
12. [Model Usage Summary](#12-model-usage-summary)

---

## 1. Project Overview

This system is a **recommendation-only** content engine. It never posts to X directly. The full lifecycle is:

```
Scan accounts → Discover viral content → Evaluate opportunities → Craft tweets
→ Judge strictly → Gate with quality/shield checks → Send Telegram recommendation
→ Human manually copies and publishes
```

The system is designed around the principle that **"no recommendation" is acceptable and often preferred** over a weak one. Every piece of recommended content must pass through a strict sequential quality chain: shield → judge → publish_gate → decision → delivery.

---

## 2. Two Pipeline Execution Paths

### 2.1 Legacy Path — `lib/daily-runner.ts` (DO NOT USE)

| Attribute | Detail |
|-----------|--------|
| **File** | `lib/daily-runner.ts` (576 lines) |
| **Style** | Synchronous monolithic pipeline |
| **Invocation** | Called directly from API routes |
| **Steps** | account_state → scan → enrich → gate → decide → persist → Telegram |
| **Missing** | `opportunity_intelligence`, `quality_enhance`, `opportunity_judge` steps |
| **Status** | **LEGACY — DO NOT ACTIVATE** |
| **Risk** | Could be accidentally called via old API routes |

### 2.2 Queue-Based Path — `lib/pipeline-queue.ts` + `lib/pipeline-worker.ts` (ACTIVE)

| Attribute | Detail |
|-----------|--------|
| **Files** | `lib/pipeline-queue.ts` (1200+ lines), `lib/pipeline-worker.ts` (3080 lines) |
| **Style** | Asynchronous task-queue with granular steps |
| **Features** | CAS-based locking, retry logic (3 max), persistent worker |
| **Steps** | 11 granular steps (see Section 4) |
| **Status** | **ACTIVE — THIS IS THE ONLY PATH** |

> **⚠️ Critical Rule**: Always use the queue-based path. The legacy `daily-runner.ts` bypasses `opportunity_intelligence`, `quality_enhance`, and `opportunity_judge`, meaning unjudged text could reach the publish gate.

---

## 3. Entrypoints

### 3.1 Telegram Endpoints

| Route | File | Purpose |
|-------|------|---------|
| Telegram Webhook | `app/api/telegram/webhook/route.ts` | Handles bot commands: run pipeline, check status, restart, stop, add account, list accounts, log published |

**Auth**: Uses `x-telegram-bot-api-secret-token` for webhook verification.

**Supported Commands** (via Telegram bot):
- Run pipeline
- Check pipeline status
- Restart a stuck run
- Stop an active run
- Add a new account to scan
- List tracked accounts
- Log a published decision (manual publish tracking)

### 3.2 Cron Dispatcher

| Route | File | Purpose |
|-------|------|---------|
| Cron Dispatcher | `app/api/cron-dispatcher/route.ts` | Vercel cron trigger |

**Behavior**:
1. **Housekeeping**: Mark stuck tasks/runs
2. **Active check**: Check for active run
3. **Enqueue**: If idle, enqueue a new pipeline run
4. **Batch process**: Optionally process 1–3 tasks (40s max wall time)

### 3.3 Daily Run Endpoint

| Route | File | Purpose |
|-------|------|---------|
| Daily Run | `app/api/daily-run/route.ts` | Enqueue-only endpoint |

**Behavior**: Calls `enqueuePipelineRun()` with `notifyTelegram` flag. Does NOT process tasks — just enqueues.

### 3.4 Pipeline Worker API (Fallback)

| Route | File | Purpose |
|-------|------|---------|
| Pipeline Worker API | `app/api/pipeline-worker/route.ts` | Manual/fallback task processing endpoint |

### 3.5 Persistent Worker Script (Oracle VPS)

| File | Purpose |
|------|---------|
| `scripts/pipeline-worker.ts` (179 lines) | Oracle VPS persistent worker |

**Configuration**:
- **Batch size**: 5 tasks per batch
- **Runtime**: 5 minutes max
- **Work sleep**: 5 seconds after each processed task
- **Idle sleep**: 30 seconds when no tasks available
- **Process manager**: PM2

### 3.6 Other API Routes

30+ routes including:

| Route Category | Examples |
|----------------|----------|
| Health | `/api/health` |
| Brain Maintenance | `/api/brain-maintenance` |
| Learning Cycle | `/api/learning-cycle` |
| Viral Discovery | `/api/viral-discovery-run` |
| Research Intel | `/api/research-intel` |
| Repo Deep Learn | `/api/repo-deep-learn` |
| Shield Check | `/api/shield-check` |

---

## 4. Active Pipeline Steps (Queue-Based)

The active pipeline consists of **11 granular steps**, each processed independently via the task queue. Steps execute in `step_order` sequence. Each step reads from the previous step's `result_payload` and produces its own `result_payload` for downstream consumption.

### Step Execution Order

```
load_account_state (10)
       ↓
scan_account (20+N, one per account)
       ↓
merge_scan_results (50)
       ↓
opportunity_intelligence (55)
       ↓
enrich_opportunities (60)
       ↓
quality_enhance (65)
       ↓
opportunity_judge (68)
       ↓
publish_gate (70)
       ↓
decision (80)
       ↓
persist_decision (90)
       ↓
telegram_delivery (100)
```

### Detailed Step Reference

#### Step 1: `load_account_state` (step_order: 10)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processLoadAccountState` in `pipeline-worker.ts` |
| **Input Source** | `task.payload` (username) |
| **Output Shape** | `{username, followers, following, tweets, post_length_policy}` |
| **Required Previous** | None (first step) |
| **result_payload Keys** | `username`, `followers`, `following`, `tweets`, `post_length_policy` |
| **Failure Behavior** | Returns error |
| **Retry** | Yes (3 max) |
| **DB Read** | `account_state` (upsert) |
| **DB Write** | `account_state` (upsert) |
| **Model Calls** | X API (`getXUserByUsername`) |
| **Diagnostics** | None |

#### Step 2: `scan_account` (step_order: 20+N, one per tracked account)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processScanAccount` in `pipeline-worker.ts` |
| **Input Source** | `task.account_handle`, `task.payload` |
| **Output Shape** | `{account_handle, tweets_analyzed, viral_found, _analyzed_data, _media, prefilter stats}` |
| **Required Previous** | `load_account_state` |
| **result_payload Keys** | `account_handle`, `tweets_analyzed`, `viral_found`, `_analyzed_data`, `brain_updates`, `empty_reason` |
| **Failure Behavior** | `AccountScanError` → fail; empty → success with metadata |
| **Retry** | Yes (3 max) |
| **DB Read** | `accounts` (update `last_checked`) |
| **DB Write** | `viral_tweet_analyses` (upsert), `x_algorithm_learning_rules` (insert), `viral_style_patterns` (insert) |
| **Model Calls** | `learning_extraction`, `content_crafting`, `deep_analysis` |
| **Diagnostics** | prefilter stats, skipped counts, top_candidate_scores |

> **Note**: Multiple `scan_account` tasks run in parallel (one per account). The `step_order` is `20 + N` where N is the account index.

#### Step 3: `merge_scan_results` (step_order: 50)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processMergeScanResults` in `pipeline-worker.ts` |
| **Input Source** | All `scan_account` results |
| **Output Shape** | `{_opportunities, accounts_scanned, raw_opportunities, brain_updates}` |
| **Required Previous** | All `scan_account` tasks |
| **result_payload Keys** | `accounts_scanned`, `tweets_analyzed`, `viral_found`, `raw_opportunities`, `_opportunities` |
| **Failure Behavior** | Error if no scan tasks found |
| **Retry** | Yes (3 max) |
| **DB Read** | `pipeline_tasks` (read scan results) |
| **DB Write** | None |
| **Model Calls** | `content_crafting`, `learning_extraction` |
| **Diagnostics** | prefilter totals |

#### Step 4: `opportunity_intelligence` (step_order: 55)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processOpportunityIntelligence` in `pipeline-worker.ts` |
| **Input Source** | `merge_scan_results._opportunities` |
| **Output Shape** | `{_briefs, _selected_opportunities, intelligence_summary}` |
| **Required Previous** | `merge_scan_results` |
| **result_payload Keys** | `briefs`, `selected_count`, `rejected_count`, `rescue_count`, `intelligence_summary` |
| **Failure Behavior** | Error if no opportunities |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | None |
| **Model Calls** | `opportunity_intelligence` (Claude Sonnet) |
| **Diagnostics** | parse_failure_rate, rescue stats, rejection debug |

> **Purpose**: Generates AI briefs for each opportunity and selects the most promising ones. This step adds strategic intelligence layer — identifying *why* an opportunity matters and *how* to approach it.

#### Step 5: `enrich_opportunities` (step_order: 60)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processEnrichOpportunities` in `pipeline-worker.ts` |
| **Input Source** | `intelligence._briefs` + `intelligence._selected_opportunities` |
| **Output Shape** | `{_enriched_opportunities with crafted candidates}` |
| **Required Previous** | `opportunity_intelligence` |
| **result_payload Keys** | `enriched_count`, `candidates_per_opp`, `memory_retrieval_count` |
| **Failure Behavior** | Error if no briefs |
| **Retry** | Yes (3 max) |
| **DB Read** | `x_algorithm_learning_rules`, `viral_style_patterns`, `compact_operator_rules`, `source_author_memory` |
| **DB Write** | None |
| **Model Calls** | `selected_candidate_crafting` (DeepSeek) |
| **Diagnostics** | rule performance, memory retrieval |

> **Purpose**: Enriches selected opportunities with crafted tweet candidates. Retrieves structured memory (rules, patterns, author memory) to inform crafting.

#### Step 6: `quality_enhance` (step_order: 65)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processQualityEnhance` in `pipeline-worker.ts` |
| **Input Source** | `enrich._enriched_opportunities` |
| **Output Shape** | `{_enhanced_opportunities}` |
| **Required Previous** | `enrich_opportunities` |
| **result_payload Keys** | `enhanced_count`, `niche_guard_count`, `originality_rewrites`, `numeric_claim_rewrites`, `brief_alignment_gates` |
| **Failure Behavior** | Error if no opportunities |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | None |
| **Model Calls** | `quality_evaluation`, `content_crafting` (for rewrites) |
| **Diagnostics** | quality scores before/after, niche stats, validation stats |

> **Purpose**: Self-critique and rewrite cycle. Applies niche alignment guard, originality enhancement, numeric claim rewrites, and brief alignment gates. This is where content quality is actively improved (not just judged).

#### Step 7: `opportunity_judge` (step_order: 68)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processOpportunityJudge` in `pipeline-worker.ts` |
| **Input Source** | `quality_enhance._enhanced_opportunities` |
| **Output Shape** | `{_judged_opportunities, judge_summary}` |
| **Required Previous** | `quality_enhance` |
| **result_payload Keys** | `judged_count`, `passed_count`, `near_pass_count`, `polish_stats`, `micro_repair_stats` |
| **Failure Behavior** | Error if no opportunities |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | None |
| **Model Calls** | `opportunity_judge` (Claude Sonnet), `near_pass_polish` (Claude Sonnet 4.6) |
| **Diagnostics** | judge scores, near-pass diagnostics, polish outcomes |

> **Purpose**: AI judge evaluates across 6 dimensions. Near-pass candidates get a polish attempt with micro-repairs. Only candidates that pass the judge proceed to publish_gate.

#### Step 8: `publish_gate` (step_order: 70)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processPublishGate` in `pipeline-worker.ts` |
| **Input Source** | `judge._judged_opportunities` |
| **Output Shape** | `{_publishable, _rejected, gate_summary}` |
| **Required Previous** | `opportunity_judge` |
| **result_payload Keys** | `publishable_count`, `rejected_count`, `freshness_gate_stats`, `post_length_diagnostics` |
| **Failure Behavior** | Error if no opportunities |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | `rejection_ledger` (insert) |
| **Model Calls** | None |
| **Diagnostics** | shield stats, freshness stats, rejection reasons |

> **Purpose**: Final deterministic gate. Applies account shield (11 checks + optional AI deep), freshness gates (Reply <72h, Quote <168h), post length hard limit (280 chars for @30piq free tier). No AI calls — purely rule-based.

#### Step 9: `decision` (step_order: 80)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processDecision` in `pipeline-worker.ts` |
| **Input Source** | `publish_gate._publishable` + `load_account_state.followers` |
| **Output Shape** | `{selected, held, decision_label}` |
| **Required Previous** | `publish_gate` + `load_account_state` |
| **result_payload Keys** | `selected_count`, `held_count`, `budget`, `stage` |
| **Failure Behavior** | Error if no publishable |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | None |
| **Model Calls** | None |
| **Diagnostics** | decision scores, stage |

> **Purpose**: Stage-based budget selection. Uses follower count and posting stage to determine how many recommendations to make. May hold back candidates for later.

#### Step 10: `persist_decision` (step_order: 90)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processPersistDecision` in `pipeline-worker.ts` |
| **Input Source** | `decision` output + previous payloads |
| **Output Shape** | `{decision_run_id}` |
| **Required Previous** | `decision` |
| **result_payload Keys** | `decision_run_id`, `daily_checkin_id` |
| **Failure Behavior** | Error if no decision |
| **Retry** | Yes (3 max) |
| **DB Read** | `decision_runs` (insert), `daily_checkins` (upsert) |
| **DB Write** | `decision_runs` (insert), `daily_checkins` (upsert) |
| **Model Calls** | None |
| **Diagnostics** | None |

> **Purpose**: Persists the decision to the database for audit trail and daily tracking.

#### Step 11: `telegram_delivery` (step_order: 100)

| Attribute | Detail |
|-----------|--------|
| **Processor** | `processTelegramDelivery` in `pipeline-worker.ts` |
| **Input Source** | `persist_decision` output |
| **Output Shape** | `{telegram_sent, chat_id}` |
| **Required Previous** | `persist_decision` |
| **result_payload Keys** | `telegram_sent`, `chat_id`, `message_id` |
| **Failure Behavior** | Error if Telegram API fails |
| **Retry** | Yes (3 max) |
| **DB Read** | None |
| **DB Write** | None |
| **Model Calls** | None (+ memory compaction after delivery) |
| **Diagnostics** | None |

> **Purpose**: Sends the recommendation to Telegram for manual review and publishing. After delivery, triggers memory compaction (signal→rule) to update structured memory.

---

## 5. Active Files (Core Runtime)

### 5.1 Pipeline Infrastructure

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/pipeline-worker.ts` | 3080 | Main task processing (all 11 steps) | **ACTIVE** |
| `lib/pipeline-queue.ts` | 1200+ | Queue management, enqueue, CAS locking | **ACTIVE** |
| `lib/pipeline-contracts.ts` | 459 | Validation between pipeline steps | **ACTIVE** |
| `lib/pipeline-run-tracker.ts` | 366 | Non-destructive run tracking | **ACTIVE** |
| `scripts/pipeline-worker.ts` | 179 | Oracle VPS persistent worker (PM2) | **ACTIVE** |

### 5.2 Content Engine & Analysis

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/content-engine-v3.ts` | 2696 | Scan, analyze, discover, craft | **ACTIVE** |
| `lib/opportunity-intelligence.ts` | 1533 | AI brief generation + selection | **ACTIVE** |
| `lib/opportunity-judge.ts` | 601 | AI judge with 6 dimensions | **ACTIVE** |
| `lib/near-pass-polish.ts` | 941 | Polish near-pass, shorten, micro-repair | **ACTIVE** |
| `lib/niche-alignment.ts` | 522 | Heuristic niche/lens scoring (no AI) | **ACTIVE** |
| `lib/candidate-selector.ts` | 388 | Local pre-select max 2 for judge | **ACTIVE** |
| `lib/tweet-candidate-scorer.ts` | 305 | Smart tweet prefiltering | **ACTIVE** |
| `lib/crafted-text-cleaner.ts` | varies | JSON/malformed text cleanup | **ACTIVE** |
| `lib/signature-voice.ts` | 429 | @30piq voice enforcement | **ACTIVE** |

### 5.3 Quality & Safety

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/account-shield.ts` | 479 | 11-check shield + optional AI deep | **ACTIVE** |
| `lib/content-policy.ts` | 546 | Publish gate + freshness + hard limit | **ACTIVE** |
| `lib/originality-enhancer.ts` | 1123 | Self-critique/rewrite for quality | **ACTIVE** |
| `lib/originality-context.ts` | 484 | RAG-guided originality | **ACTIVE** |
| `lib/numeric-claim-guard.ts` | varies | Detect + rewrite numeric claims | **ACTIVE** |
| `lib/quality-validator.ts` | varies | Pre-gate quality validation (8 checks) | **ACTIVE** |
| `lib/post-length-policy.ts` | 198 | Deterministic length policy | **ACTIVE** |

### 5.4 Decision & Delivery

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/decision-engine.ts` | 250 | Stage-based budget selection | **ACTIVE** |
| `lib/telegram.ts` | 184 | Telegram Bot API | **ACTIVE** |

### 5.5 Memory & Learning

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/structured-memory-compaction.ts` | 824 | Signal→rule compaction | **ACTIVE** |
| `lib/structured-memory-retrieval.ts` | 453 | Memory retrieval for crafting | **ACTIVE** |

### 5.6 Cost & Audit

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/model-router.ts` | 439 | OpenRouter routing + cost tracking | **ACTIVE** |
| `lib/cost-ledger.ts` | 289 | Durable cost tracking per call | **ACTIVE** |
| `lib/rejection-ledger.ts` | 229 | Persist every rejection | **ACTIVE** |

### 5.7 Infrastructure

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/supabase.ts` | 29 | Supabase admin client | **ACTIVE** |
| `lib/env.ts` | 34 | Environment helpers + auth | **ACTIVE** |
| `lib/constants.ts` | 28 | Shared patterns | **ACTIVE** |

### 5.8 Legacy Files (DO NOT USE AS PRIMARY)

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `lib/daily-runner.ts` | 576 | Legacy monolithic pipeline | **LEGACY** |
| `lib/publishing-pipeline.ts` | 462 | Legacy publishing pack builder | **LEGACY** |

---

## 6. Active DB Tables

### 6.1 Source Pool

| Table | Classification | Key Purpose |
|-------|---------------|-------------|
| `accounts` | ACTIVE_SOURCE_POOL | X account handles for scanning |
| `source_quality_scores` | ACTIVE_SOURCE_POOL | Source performance tracking |

### 6.2 Runtime

| Table | Classification | Key Purpose |
|-------|---------------|-------------|
| `account_state` | ACTIVE_RUNTIME | X user snapshots (followers, etc.) |
| `pipeline_runs` | ACTIVE_RUNTIME | Pipeline run tracking |
| `pipeline_tasks` | ACTIVE_RUNTIME | Task queue with CAS locking |
| `decision_runs` | ACTIVE_RUNTIME | Decision results |
| `published_decisions` | ACTIVE_RUNTIME | Manual publish tracking |
| `daily_checkins` | ACTIVE_RUNTIME | Daily execution log |
| `model_routing_rules` | ACTIVE_RUNTIME | Model routing config |

### 6.3 Cost Logging

| Table | Classification | Key Purpose |
|-------|---------------|-------------|
| `pipeline_cost_ledger` | ACTIVE_COST_LOGGING | Per-call cost tracking |
| `rejection_ledger` | ACTIVE_COST_LOGGING | Every rejection persisted |
| `session_logs` | ACTIVE_COST_LOGGING | Session audit trail |

### 6.4 Memory

| Table | Classification | Key Purpose |
|-------|---------------|-------------|
| `compact_operator_rules` | ACTIVE_MEMORY | Structured memory rules |
| `source_author_memory` | ACTIVE_MEMORY | Per-author memory |
| `memory_compaction_runs` | ACTIVE_MEMORY | Compaction run logs |
| `x_algorithm_learning_rules` | ACTIVE_MEMORY | Viral pattern rules |
| `viral_style_patterns` | ACTIVE_MEMORY | Style pattern rules |
| `viral_tweet_analyses` | ACTIVE_MEMORY | Tweet analysis cache |
| `working_memory` | ACTIVE_MEMORY | Generic working memory |
| `system_learning_rules` | ACTIVE_MEMORY | General learning rules |

### 6.5 Telegram

| Table | Classification | Key Purpose |
|-------|---------------|-------------|
| `telegram_bot_state` | ACTIVE_TELEGRAM | Bot state tracking |
| `content_deliveries` | ACTIVE_TELEGRAM | Delivery tracking |

---

## 7. Legacy / Experimental Tables

### 7.1 Legacy Tables — DO NOT TOUCH

| Table | Classification | Note |
|-------|---------------|------|
| `sources` | LEGACY_DO_NOT_TOUCH | Old source table, referenced but unclear role |
| `source_performance` | LEGACY_DO_NOT_TOUCH | Similar to `source_quality_scores`, may be duplicate |
| `content_opportunities` | LEGACY_DO_NOT_TOUCH | Old v2 content format |
| `original_content_hypotheses` | LEGACY_DO_NOT_TOUCH | Old v2 content format |
| `raw_research_items` | LEGACY_DO_NOT_TOUCH | Old research pipeline |
| `content_log` | LEGACY_DO_NOT_TOUCH | Old content logging |
| `action_queue` | LEGACY_DO_NOT_TOUCH | Old action system |
| `viral_scan_runs` | LEGACY_DO_NOT_TOUCH | Old scan run tracking |
| `viral_account_patterns` | LEGACY_DO_NOT_TOUCH | Old pattern tracking |
| `content_format_decisions` | LEGACY_DO_NOT_TOUCH | Old v2 format system |
| `content_production_cards` | LEGACY_DO_NOT_TOUCH | Old v2 production system |
| `behavior_limits` | LEGACY_DO_NOT_TOUCH | Account behavior limits |
| `performance_scans` | LEGACY_DO_NOT_TOUCH | Old performance scanning |
| `learning_tweet_queue` | LEGACY_DO_NOT_TOUCH | Old learning pipeline |
| `learning_cycles` | LEGACY_DO_NOT_TOUCH | Old learning pipeline |

### 7.2 Experimental Tables — Use With Caution

| Table | Classification | Note |
|-------|---------------|------|
| `quality_failure_patterns` | EXPERIMENTAL | Failure pattern tracking, unclear if active |
| `prompt_improvement_candidates` | EXPERIMENTAL | Prompt improvement tracking, unclear if active |
| `mcp_opportunity_map` | EXPERIMENTAL | MCP/workflow opportunity map |
| `growth_learning_runs` | EXPERIMENTAL | Growth learning logs |
| `trends` | EXPERIMENTAL | Trend tracking |
| `creator_intel` | EXPERIMENTAL | Creator intelligence |
| `discovered_items` | EXPERIMENTAL | Discovery tracking |
| `repo_source_files` | EXPERIMENTAL | Repo analysis |
| `repo_extracted_rules` | EXPERIMENTAL | Repo rule extraction |
| `requirement_status` | EXPERIMENTAL | Requirement tracking |
| `target_plans` | EXPERIMENTAL | Target planning |

---

## 8. DO NOT TOUCH Invariants

These are hard rules that must never be violated by any code change, pipeline modification, or configuration update.

### 8.1 Publishing Rules

| # | Invariant | Rationale |
|---|-----------|-----------|
| 1 | **No auto-posting** — Telegram is recommendation only, manual copy/publish | Human oversight is non-negotiable |
| 2 | **No unjudged text reaches publish_gate** — Judge must pass before gate | Quality chain must be sequential |
| 3 | **No candidate bypasses shield, judge, or publish_gate** — Sequential quality chain | No shortcuts around safety |

### 8.2 Quality Thresholds (MUST NOT WEAKEN)

| Metric | Minimum Threshold | Notes |
|--------|-------------------|-------|
| `final_candidate_score` | **≥ 7.8** | Overall candidate quality |
| `originality_score` | **≥ 7.8** | Must be original, not derivative |
| `usefulness_score` | **≥ 7** | Must provide real value |
| `evidence_safety_score` | **≥ 8** | Claims must be safe/unverifiable-free |
| `brief_alignment_score` | **≥ 7.5** | Must align with intelligence brief |

> **Rule**: Do not "fix" quality by lowering standards. Fix the content or reject it.

### 8.3 Content Rules

| # | Invariant | Rationale |
|---|-----------|-----------|
| 5 | **"No recommendation" is acceptable and often preferred** — Weak content must be rejected | Silence > noise |
| 6 | **Do not "fix" quality by lowering standards** — Fix the content or reject it | Standards only go up |
| 7 | **No forced AI/productivity angles** — Broader lens must have concrete transferable mechanism | Avoid cliché angles |
| 8 | **Post length hard limit: 280 chars for @30piq (free tier)** — Never exceed | Free tier constraint |

### 8.4 Freshness & Safety Rules

| # | Invariant | Rationale |
|---|-----------|-----------|
| 9 | **Freshness gates: Reply <72h, Quote <168h** — Unless downgrade to standalone | Stale content is low-value |
| 10 | **Shield must pass before publish_gate** — 11 checks + optional AI deep | Safety first |

---

## 9. Identified Issues & Technical Debt

### 9.1 Critical

| # | Issue | Risk | Recommendation |
|---|-------|------|----------------|
| 1 | **Legacy `daily-runner.ts` still exists** | Could be accidentally called via old API routes, bypassing judge/intelligence/quality_enhance | Add deprecation warnings; consider removing API routes that invoke it |
| 2 | **`publishing-pipeline.ts` uses legacy flow** | Shield + deliver without judge/intelligence | Mark as deprecated, ensure no active code path calls it |

### 9.2 High Priority

| # | Issue | Risk | Recommendation |
|---|-------|------|----------------|
| 3 | **40+ DB tables, many legacy/experimental** | Operational confusion, accidental reads/writes to stale tables | Audit and archive legacy tables |
| 4 | **Duplicate source tracking** — `source_performance` vs `source_quality_scores` | Data inconsistency, confusion about which is canonical | Consolidate into one table |
| 5 | **No live DB access from local environment** — No .env files in repo | Cannot validate assumptions against real data | Document how to get read-only DB access |

### 9.3 Medium Priority

| # | Issue | Risk | Recommendation |
|---|-------|------|----------------|
| 6 | **Inconsistent naming** — `niche_fit` vs `account_lens` (S1.3 partial rename) | Code confusion, grep difficulty | Complete the rename to `account_lens` everywhere |
| 7 | **`pipeline-worker.ts` is 3080 lines** | Hard to maintain, difficult to test individual steps | Refactor into per-step modules |
| 8 | **`content-engine-v3.ts` is 2696 lines** | Hard to maintain, monolithic | Refactor into focused modules |
| 9 | **`opportunity-intelligence.ts` is 1533 lines** | Large but manageable | Consider splitting brief generation from selection |
| 10 | **Multiple Arabic strings in code** | Original project was Arabic; now English-focused | Audit and translate/remove Arabic strings |

---

## 10. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ENTRYPOINTS                                      │
│                                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────────┐  │
│  │  Telegram    │  │ Cron         │  │ Daily Run │  │ Worker API     │  │
│  │  Webhook     │  │ Dispatcher   │  │ Endpoint  │  │ (fallback)     │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  └───────┬────────┘  │
│         │                │                │                 │            │
│         ▼                ▼                ▼                 ▼            │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              pipeline-queue.ts (enqueue, CAS lock)              │    │
│  └─────────────────────────────┬───────────────────────────────────┘    │
│                                │                                        │
│                                ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              pipeline-worker.ts (task processing)               │    │
│  │                                                                 │    │
│  │  ┌──────────────────────────────────────────────────────────┐  │    │
│  │  │              11-STEP PIPELINE (sequential)               │  │    │
│  │  │                                                          │  │    │
│  │  │  10  load_account_state                                  │  │    │
│  │  │  │                                                       │  │    │
│  │  │  20+N  scan_account (parallel per account)               │  │    │
│  │  │  │                                                       │  │    │
│  │  │  50  merge_scan_results                                 │  │    │
│  │  │  │                                                       │  │    │
│  │  │  55  opportunity_intelligence ◄── Claude Sonnet          │  │    │
│  │  │  │                                                       │  │    │
│  │  │  60  enrich_opportunities ◄── DeepSeek                   │  │    │
│  │  │  │                                                       │  │    │
│  │  │  65  quality_enhance ◄── quality_eval + content_craft   │  │    │
│  │  │  │                                                       │  │    │
│  │  │  68  opportunity_judge ◄── Claude Sonnet + Sonnet 4.6   │  │    │
│  │  │  │                                                       │  │    │
│  │  │  70  publish_gate (deterministic, no AI)                 │  │    │
│  │  │  │                                                       │  │    │
│  │  │  80  decision (deterministic, no AI)                     │  │    │
│  │  │  │                                                       │  │    │
│  │  │  90  persist_decision                                    │  │    │
│  │  │  │                                                       │  │    │
│  │  │  100 telegram_delivery → + memory compaction             │  │    │
│  │  └──────────────────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    SUPPORTING MODULES                             │   │
│  │                                                                  │   │
│  │  content-engine-v3.ts    │  opportunity-intelligence.ts          │   │
│  │  opportunity-judge.ts    │  near-pass-polish.ts                  │   │
│  │  niche-alignment.ts      │  account-shield.ts                    │   │
│  │  content-policy.ts       │  originality-enhancer.ts              │   │
│  │  candidate-selector.ts   │  decision-engine.ts                   │   │
│  │  tweet-candidate-scorer.ts │ post-length-policy.ts              │   │
│  │  signature-voice.ts      │  crafted-text-cleaner.ts              │   │
│  │  numeric-claim-guard.ts  │  quality-validator.ts                 │   │
│  │  originality-context.ts  │  model-router.ts                      │   │
│  │  cost-ledger.ts          │  rejection-ledger.ts                  │   │
│  │  structured-memory-compaction.ts │ structured-memory-retrieval.ts │   │
│  │  pipeline-contracts.ts   │  pipeline-run-tracker.ts              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    EXTERNAL SERVICES                             │   │
│  │                                                                  │   │
│  │  X API (user data, tweets)  │  OpenRouter (LLM routing)         │   │
│  │  Telegram Bot API           │  Supabase (database)              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Key Data Flows

### 11.1 Pipeline Run Lifecycle

```
1. Trigger (cron/telegram/manual) calls enqueuePipelineRun()
2. pipeline-queue.ts creates a pipeline_runs entry + 11 pipeline_tasks
3. Worker picks up tasks in step_order
4. Each task:
   a. Acquires CAS lock (compare-and-swap on task version)
   b. Reads input from previous step's result_payload
   c. Processes via step-specific function
   d. Writes result_payload to pipeline_tasks
   e. Releases lock (increments version, sets status=completed)
5. On failure: retry up to 3 times with CAS-based re-acquisition
6. After step 11 (telegram_delivery): memory compaction runs
7. Pipeline run marked as completed
```

### 11.2 Content Quality Flow (The Quality Chain)

```
scan_account (discover viral content)
       ↓
merge_scan_results (aggregate opportunities)
       ↓
opportunity_intelligence (AI brief + select best)
       ↓
enrich_opportunities (craft candidates with memory)
       ↓
quality_enhance (self-critique + rewrite)
       ↓
opportunity_judge (6-dimension AI evaluation)
       ↓    ↘ near-pass → polish attempt → re-judge
publish_gate (deterministic: shield + freshness + length)
       ↓
decision (stage-based budget selection)
       ↓
persist_decision (audit trail)
       ↓
telegram_delivery (human review + manual publish)
```

### 11.3 Memory Flow

```
scan_account
  → writes viral_tweet_analyses (upsert)
  → writes x_algorithm_learning_rules (insert)
  → writes viral_style_patterns (insert)

enrich_opportunities
  → reads compact_operator_rules
  → reads x_algorithm_learning_rules
  → reads viral_style_patterns
  → reads source_author_memory

telegram_delivery (after)
  → triggers structured-memory-compaction
  → signal → rule compaction
  → writes compact_operator_rules (updated)
  → writes memory_compaction_runs (log)
```

### 11.4 Cost & Audit Flow

```
Every model call
  → model-router.ts routes to OpenRouter
  → cost-ledger.ts logs per-call cost to pipeline_cost_ledger

Every rejection (publish_gate, judge, quality_enhance)
  → rejection-ledger.ts persists to rejection_ledger

Every pipeline run
  → pipeline-run-tracker.ts tracks status non-destructively
  → session_logs records session audit trail
```

---

## 12. Model Usage Summary

| Step | Model Call | Provider/Model | Purpose |
|------|-----------|----------------|---------|
| `scan_account` | `learning_extraction` | OpenRouter | Extract learning rules from viral content |
| `scan_account` | `content_crafting` | OpenRouter | Craft tweet candidates from viral patterns |
| `scan_account` | `deep_analysis` | OpenRouter | Deep analysis of viral tweets |
| `merge_scan_results` | `content_crafting` | OpenRouter | Merge-time content crafting |
| `merge_scan_results` | `learning_extraction` | OpenRouter | Merge-time learning extraction |
| `opportunity_intelligence` | `opportunity_intelligence` | Claude Sonnet | AI brief generation + opportunity selection |
| `enrich_opportunities` | `selected_candidate_crafting` | DeepSeek | Craft tweet candidates with memory |
| `quality_enhance` | `quality_evaluation` | OpenRouter | Quality evaluation for self-critique |
| `quality_enhance` | `content_crafting` | OpenRouter | Rewrite content based on critique |
| `opportunity_judge` | `opportunity_judge` | Claude Sonnet | 6-dimension judge evaluation |
| `opportunity_judge` | `near_pass_polish` | Claude Sonnet 4.6 | Polish near-pass candidates |
| `publish_gate` | (none — deterministic) | — | Rule-based gate only |
| `decision` | (none — deterministic) | — | Stage-based selection only |
| `telegram_delivery` | (none + memory compaction) | — | Delivery + compaction trigger |

> **Note**: All model calls are routed through `model-router.ts` which uses OpenRouter for routing and `cost-ledger.ts` for cost tracking. Claude models are accessed via OpenRouter.

---

## Appendix A: CAS-Based Locking Protocol

The pipeline uses **Compare-And-Swap (CAS)** locking to prevent concurrent processing of the same task:

1. Task has a `version` field (integer)
2. Worker reads task + version
3. On processing, worker issues: `UPDATE pipeline_tasks SET status='processing', version=version+1 WHERE id=? AND version=?`
4. If affected rows = 0, another worker already acquired the lock
5. After processing: `UPDATE pipeline_tasks SET status='completed', result_payload=?, version=version+1 WHERE id=? AND version=?`
6. On retry: CAS re-acquisition with version check

This ensures exactly-once processing semantics even with multiple workers.

## Appendix B: Oracle VPS Worker Configuration

```typescript
// scripts/pipeline-worker.ts
const BATCH_SIZE = 5;          // tasks per batch
const MAX_RUNTIME = 5 * 60e3;  // 5 minutes max
const WORK_SLEEP = 5e3;        // 5s after each processed task
const IDLE_SLEEP = 30e3;       // 30s when no tasks available
// Managed by PM2
```

## Appendix C: Pipeline Contracts

`pipeline-contracts.ts` (459 lines) provides validation between pipeline steps. Every step's `result_payload` is validated against expected shapes before being passed to downstream steps. This prevents silent data corruption from step to step.

## Appendix D: Environment Dependencies

The system requires these environment variables (managed via `lib/env.ts`):

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin key |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM routing |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Target Telegram chat ID |
| `X_API_KEY` / `X_API_SECRET` | X API credentials |
| `x-telegram-bot-api-secret-token` | Telegram webhook secret |

> **Note**: No `.env` files exist in the repo. Environment is configured at deployment level (Vercel for API routes, Oracle VPS for persistent worker).

---

*End of ACTIVE_SYSTEM_MAP.md. This document should be updated whenever the pipeline steps, file structure, DB tables, or invariants change.*
