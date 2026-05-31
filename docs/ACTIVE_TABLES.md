# ACTIVE TABLES — x-ai-content-factory-orchestrator

> **Project**: X (Twitter) content opportunity/recommendation engine for **@30piq**
> **Purpose**: Complete classification of all 48 database tables in the Supabase instance
> **Last Updated**: 2026-03-04
> **Audience**: Future agents, maintainers, and anyone modifying DB schema or pipeline code
> **Related Docs**: `DATABASE_AUDIT_REPORT.md`, `ACTIVE_SYSTEM_MAP.md`, `MEMORY_AUDIT.md`

---

## Classification Legend

| Code | Meaning | Data Safety Rule |
|------|---------|------------------|
| **ACTIVE_RUNTIME** | Tables actively read/written by the queue-based pipeline on every run | Never drop, never alter without migration |
| **ACTIVE_MEMORY** | Tables used by the memory/learning system for crafting and compaction | Never drop; schema changes require compaction code review |
| **ACTIVE_TELEGRAM** | Tables for Telegram bot state and content delivery tracking | Low risk; single-user, small data volume |
| **ACTIVE_COST_LOGGING** | Tables for per-call cost tracking and rejection audit | Append-only; never delete rows without archiving |
| **ACTIVE_SOURCE_POOL** | Tables for source account management and quality scoring | Can add columns; don't remove existing without verifying pipeline |
| **LEGACY_DO_NOT_TOUCH** | Old tables from v2/v3 pipeline, no longer actively used but contain historical data | Do NOT modify schema or write new data; read only for audit |
| **EXPERIMENTAL** | Tables for experimental features that may or may not be active | Can be dropped if confirmed empty; verify with live query first |
| **EMPTY_UNUSED** | Tables that exist but appear to have no active readers or writers | Candidates for archival; verify emptiness before dropping |
| **UNKNOWN_NEEDS_REVIEW** | Tables referenced in code but unclear status — need live DB verification | Investigate before any action; may be active or orphaned |

---

## Summary Counts

| Classification | Count | Tables |
|---------------|-------|--------|
| ACTIVE_RUNTIME | 7 | pipeline_runs, pipeline_tasks, account_state, decision_runs, daily_checkins, model_routing_rules, published_decisions |
| ACTIVE_MEMORY | 8 | compact_operator_rules, source_author_memory, memory_compaction_runs, x_algorithm_learning_rules, viral_style_patterns, viral_tweet_analyses, working_memory, system_learning_rules |
| ACTIVE_TELEGRAM | 2 | telegram_bot_state, content_deliveries |
| ACTIVE_COST_LOGGING | 3 | pipeline_cost_ledger, rejection_ledger, session_logs |
| ACTIVE_SOURCE_POOL | 2 | accounts, source_quality_scores |
| LEGACY_DO_NOT_TOUCH | 15 | sources, content_opportunities, original_content_hypotheses, raw_research_items, content_log, action_queue, viral_scan_runs, viral_account_patterns, content_format_decisions, content_production_cards, learning_tweet_queue, learning_cycles, behavior_limits, performance_scans, (source_performance moved to EXPERIMENTAL) |
| EXPERIMENTAL | 12 | source_performance, quality_failure_patterns, prompt_improvement_candidates, mcp_opportunity_map, growth_learning_runs, trends, creator_intel, discovered_items, repo_source_files, repo_extracted_rules, requirement_status, target_plans |
| UNKNOWN_NEEDS_REVIEW | 7 | system_cleanup_registry, system_cleanup_batches, repo_sources, repo_creation_decisions, discovery_sources, discovery_runs, system_reflections |
| **TOTAL** | **48+** | |

---

## 1. ACTIVE_RUNTIME — Pipeline Core Tables

These 7 tables are the backbone of the queue-based pipeline. Every run touches most of them. Schema changes require a migration file and must be tested against the pipeline contracts system.

### 1.1 `pipeline_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Tracks the lifecycle of each pipeline run from enqueue through completion. Each run represents one full execution of the 11-step content recommendation pipeline. The `status` field drives the cron dispatcher's decision to enqueue new runs — if any run is `running`, no new run is started. |
| **Key Columns** | `id` (UUID PK), `source` (TEXT — who triggered it), `status` (running/completed/failed/cancelled), `current_step`, `total_tasks`, `completed_tasks`, `failed_tasks`, `started_at`, `completed_at`, `cancelled_at`, `worker_mode`, `cancel_reason`, `debug_log` (JSONB) |
| **Active Code References** | **Writes**: `lib/pipeline-queue.ts` (creates run on enqueue), `lib/pipeline-run-tracker.ts` (updates status/timestamps non-destructively), `lib/pipeline-worker.ts` (updates step progress). **Reads**: `lib/pipeline-queue.ts` (checks for active runs before enqueuing), `lib/cost-ledger.ts` (links costs to run), `scripts/source-quality-audit.ts` |
| **Notes** | The `scan_payload`, `decision_payload`, and `telegram_payload` columns store legacy JSON from the old daily-runner flow. The queue-based pipeline stores results in `pipeline_tasks.result_payload` instead, but these columns remain for backward compatibility. The `debug_log` JSONB column is valuable for post-mortem analysis of failed runs. Index on `account_handle` is recommended for per-account run queries. |

### 1.2 `pipeline_tasks`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | The task queue that drives the 11-step pipeline. Each run creates one task per step (plus additional `scan_account` tasks per tracked account). Tasks are processed in `step_order` by workers that acquire a CAS lock before processing. This is the most heavily queried table in the system — every worker cycle reads from it, and every step writes its `result_payload` back to it. |
| **Key Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs, CASCADE), `task_type` (TEXT — e.g., 'load_account_state', 'scan_account'), `status` (queued/running/completed/failed), `step_order` (INT — 10/20+N/50/55/60/65/68/70/80/90/100), `account_handle`, `payload` (JSONB input), `result` (JSONB output), `attempts` (INT, max 3), `locked_at`, `locked_by` |
| **Active Code References** | **Writes**: `lib/pipeline-queue.ts` (creates 11+ tasks per run), `lib/pipeline-worker.ts` (updates status, writes result_payload). **Reads**: `lib/pipeline-queue.ts` (finds next queued task), `lib/pipeline-worker.ts` (reads previous step's result as input), `lib/pipeline-run-tracker.ts`, `lib/structured-memory-compaction.ts` (reads judge/gate results for compaction) |
| **Notes** | The CAS-based locking protocol uses the `locked_at` and `locked_by` fields to prevent duplicate processing. The `idx_pipeline_tasks_queue_lock` partial index (status IN ('queued','running')) is critical for worker performance. Completed tasks older than 30 days should be periodically cleaned up to prevent table bloat, but no cleanup job currently exists. |

### 1.3 `account_state`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Stores the latest snapshot of the @30piq X profile — follower count, following count, posts count, bio text, and verification status. The `load_account_state` pipeline step upserts this table using the X API. Downstream steps (decision, shield) use follower count to determine posting budget and stage classification. |
| **Key Columns** | `account_handle` (TEXT PK), `followers_count`, `following_count`, `posts_count`, `bio_text`, `display_name`, `verified_status`, `last_live_check_at`, `post_length_policy` (derived — stored in task result_payload, not in this table directly) |
| **Active Code References** | **Writes**: `lib/pipeline-worker.ts` (upsert on load_account_state step). **Reads**: `lib/pipeline-worker.ts` (loads state for downstream steps), `lib/daily-runner.ts` (legacy), `lib/account-shield.ts` (uses follower count for stage), `lib/performance-feedback.ts`, `lib/content-type-engine.ts`, `app/api/check-account/route.ts`, `app/api/weekly-review/route.ts` |
| **Notes** | Only one row should exist (for @30piq). The `last_live_check_at` column should have an index for stale-check queries but currently doesn't. The `post_length_policy` is not stored here — it's inferred at runtime from the account's X Premium subscription status (free tier = 280 char limit). |

### 1.4 `decision_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Persists the final decision output of each pipeline run: how many opportunities were selected vs. held, the budget used, and the full payload of selected/held items. This is the audit trail for "what did the system recommend and why." The `published_decisions` table links back to this for tracking which recommendations were actually published by the human operator. |
| **Key Columns** | `id` (UUID PK), `account_handle`, `account_stage`, `raw_opportunities`, `selected_count`, `held_count`, `budget` (JSONB), `selected_payload` (JSONB), `held_summary` (JSONB), `run_source` (daily_run/telegram/manual), `created_at` |
| **Active Code References** | **Writes**: `lib/pipeline-worker.ts` (persist_decision step), `lib/daily-runner.ts` (legacy). **Reads**: `lib/published-decision-logger.ts`, `app/api/learning-health/route.ts`, `app/api/performance-feedback/attribution-test/route.ts` |
| **Notes** | The `held_summary` is valuable for understanding why content was held back. Needs index on `(account_handle, created_at DESC)` for historical queries. Currently has no indexes beyond PK. |

### 1.5 `daily_checkins`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Tracks daily execution state — whether the account was checked, whether content was created, how many tweets/replies/quotes were planned. Used by the weekly review API to summarize the week's activity. The `checkin_date` column has a UNIQUE constraint ensuring one checkin per day. |
| **Key Columns** | `id` (UUID PK), `checkin_date` (TEXT UNIQUE), `execution_mode`, `account_checked`, `content_pack_created`, `tweets_planned`, `replies_planned`, `quotes_planned`, `next_priority`, `notes` |
| **Active Code References** | **Writes**: `lib/pipeline-worker.ts` (persist_decision step upserts), `lib/daily-runner.ts` (legacy). **Reads**: `app/api/weekly-review/route.ts` |
| **Notes** | Low-volume table (one row per day). The `checkin_date` as TEXT (not DATE) is a minor schema smell but works fine for the UNIQUE constraint. Consider adding `created_at DESC` index for range queries. |

### 1.6 `model_routing_rules`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Configuration table that maps task types to LLM models. When the model router receives a call (e.g., `opportunity_judge`), it looks up the corresponding `model_id`, `temperature`, `max_tokens`, and `provider` from this table. The `active` flag allows disabling models without deletion. This is the single source of truth for which model handles which task. |
| **Key Columns** | `id` (UUID PK), `task_type` (TEXT UNIQUE), `model_id` (TEXT — OpenRouter model ID), `temperature`, `max_tokens`, `top_p`, `response_format`, `provider` (cloud/openrouter), `active` (BOOLEAN), `description` |
| **Active Code References** | **Reads**: `lib/model-router.ts` (looks up model for every AI call), `app/api/model-router/route.ts` (admin endpoint), `app/api/health/route.ts`, `app/api/db-setup/route.ts` |
| **Notes** | After the Claude Sonnet 4 migration, old model IDs (e.g., `anthropic/claude-sonnet-4`) may linger as inactive rows. Verify no orphaned model IDs are being accidentally selected. The UNIQUE constraint on `task_type` is critical — duplicate task types would cause non-deterministic model selection. |

### 1.7 `published_decisions`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_RUNTIME |
| **Primary Purpose** | Tracks which recommended content was actually published by the human operator. When the operator uses the Telegram `/log_published` command, a row is inserted linking to the original `decision_run_id`. This enables the performance feedback loop — the system can later correlate published content with engagement metrics from X. |
| **Key Columns** | `id` (UUID PK), `decision_run_id` (UUID FK → decision_runs), `tweet_url`, `published_at`, `content_preview`, `performance_checked` (BOOLEAN) |
| **Active Code References** | **Writes**: `lib/published-decision-logger.ts` (inserts on manual log), `app/api/log-published-decision/route.ts`. **Reads**: `lib/performance-outcome.ts`, `app/api/published-performance-scan/route.ts`, `app/api/performance-feedback/attribution-test/route.ts`, `app/api/learning-health/route.ts` |
| **Notes** | The performance feedback loop is incomplete — `performance_checked` tracks whether engagement metrics were fetched, but the full loop (publish → measure engagement → update memory/rules) is not yet closed. This table will become increasingly important as the feedback loop matures. |

---

## 2. ACTIVE_MEMORY — Learning & Memory Tables

These 8 tables support the structured memory system (compaction + retrieval). They are written by `structured-memory-compaction.ts` and read by `structured-memory-retrieval.ts` and the `enrich_opportunities` pipeline step. Schema changes here directly affect prompt construction and AI output quality.

### 2.1 `compact_operator_rules`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | The primary structured memory store. Each row is a deterministic rule extracted from pipeline failure signals: anti-patterns (what NOT to do), winning angles (what works), and source patterns (author-specific quirks). The compaction pipeline upserts rules with deduplication on `(rule_type, pattern, source_author, topic_key)`. The retrieval pipeline queries this table at craft time, scoring rules by author match, topic match, confidence, recency, and support count. |
| **Key Columns** | `id` (UUID PK), `rule_type` (TEXT — anti_pattern/winning_angle/source_pattern), `pattern` (TEXT — the rule itself), `when_to_use`, `when_to_avoid`, `suggested_fix`, `example_bad`, `example_better`, `source_author`, `topic_key`, `confidence` (NUMERIC, default 0.5), `support_count` (INT, default 1), `last_seen_at` |
| **Active Code References** | **Writes**: `lib/structured-memory-compaction.ts` (upsert rules). **Reads**: `lib/structured-memory-retrieval.ts` (queries for craft/polish prompts) |
| **Notes** | **Critical issue**: No confidence floor in retrieval — rules with confidence 0.1 can be injected into prompts. **Critical issue**: No decay mechanism — stale rules persist forever. **Issue**: `example_better` is always empty for compacted rules, giving the model no positive examples. **Issue**: Anti-patterns dominate because compaction only reads failure signals. See `MEMORY_AUDIT.md` for proposed M1.1 fixes. |

### 2.2 `source_author_memory`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Per-author aggregated memory: what topics an author commonly covers, which angles work well, which angles consistently fail, freshness behavior (how quickly their content becomes stale), and typical failure reasons. The retrieval pipeline gives a +3 bonus for exact author match, making this the highest-priority memory source for craft prompts. |
| **Key Columns** | `id` (UUID PK), `source_author` (TEXT UNIQUE), `common_topics` (JSONB), `good_angles` (JSONB), `bad_angles` (JSONB), `freshness_behavior` (JSONB), `typical_failure_reasons` (JSONB), `best_reply_strategy`, `best_quote_strategy`, `confidence`, `support_count`, `last_seen_at` |
| **Active Code References** | **Writes**: `lib/structured-memory-compaction.ts` (upserts author-level memory). **Reads**: `lib/structured-memory-retrieval.ts` (queries at craft time) |
| **Notes** | A single prolific but low-quality source author could dominate this table, creating biased memory. The UNIQUE constraint on `source_author` prevents duplicate rows but doesn't prevent quality imbalance. Consider adding a source quality modifier from `source_quality_scores` during retrieval. |

### 2.3 `memory_compaction_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Audit log for memory compaction runs. Each time the compaction pipeline runs (triggered after telegram_delivery step or via `/api/memory-compact-run`), a row is inserted recording how many rules were created/updated, how many source memories were created/updated, input item count, and any errors. This is a debugging/diagnostics table, not used in any active pipeline logic. |
| **Key Columns** | `id` (UUID PK), `run_id` (UUID), `source` (TEXT — what triggered compaction), `rules_created`, `rules_updated`, `source_memories_created`, `source_memories_updated`, `input_items`, `status`, `error_message`, `created_at` |
| **Active Code References** | **Writes**: `lib/structured-memory-compaction.ts`. **Reads**: None in active pipeline |
| **Notes** | Low-priority audit table. RLS is not enabled (no policy in migration). Should be enabled but is low risk since this is append-only diagnostic data. No cleanup job exists — rows accumulate indefinitely. |

### 2.4 `x_algorithm_learning_rules`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Stores rules learned from viral tweet analysis during the `scan_account` step. Each rule captures a pattern about how the X algorithm works (e.g., "Threads with a hook in the first tweet get 3x more engagement"). These rules are read by the brain query system (`brain-query.ts`) and injected into various prompts including originality context and account shield deep analysis. |
| **Key Columns** | `id` (SERIAL PK), `rule_type`, `rule` (TEXT), `evidence`, `source_type`, `source_url`, `applies_to`, `confidence_score` (NUMERIC 4,1), `status` (active/inactive), `test_run` (BOOLEAN), `success_count`, `failure_count`, `last_used_at`, `last_success_at`, `last_failure_at` |
| **Active Code References** | **Writes**: `lib/content-engine-v3.ts` (scan_account step inserts new rules). **Reads**: `lib/brain-query.ts`, `lib/resolve-brain-rules.ts`, `lib/performance-feedback.ts`, `lib/enrich-opportunities-with-rule-performance.ts`, `lib/originality-context.ts`, `lib/account-shield.ts`, `app/api/brain-viewer/route.ts`, `app/api/brain-maintenance/route.ts`, `app/api/rule-performance-report/route.ts` |
| **Notes** | **Missing critical index** on `(status, rule_type, confidence_score DESC)` — brain queries currently do full table scans. The `confidence_score` column was migrated from INTEGER to NUMERIC(4,1), but inconsistency remains with other brain tables that use NUMERIC(4,2). The `test_run` flag is set to `true` by default but never systematically promoted to `false`, meaning most rules remain in "test" status indefinitely. |

### 2.5 `viral_style_patterns`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Stores named viral content patterns discovered during scanning — e.g., "Contrarian take with evidence", "Thread with progressive revelation", "Quote tweet with value add". Each pattern includes why it works, risks, and how to adapt it for @30piq. These patterns are read by the brain query system and injected into craft prompts as structural templates. |
| **Key Columns** | `id` (SERIAL PK), `pattern_type`, `pattern_name` (TEXT UNIQUE), `pattern_description`, `example_structure` (JSONB), `why_it_works`, `risks`, `adaptation_for_30piq`, `source_handles` (JSONB), `confidence_score`, `status`, `test_run`, `success_count`, `failure_count` |
| **Active Code References** | **Writes**: `lib/content-engine-v3.ts` (scan_account step). **Reads**: `lib/brain-query.ts`, `lib/resolve-brain-rules.ts`, `lib/performance-feedback.ts`, `lib/enrich-opportunities-with-rule-performance.ts`, `lib/originality-context.ts` |
| **Notes** | Same missing index issue as `x_algorithm_learning_rules` — needs `(status, pattern_type, confidence_score DESC)`. The UNIQUE constraint on `pattern_name` prevents exact duplicates but not near-duplicate patterns with slightly different names. The `adaptation_for_30piq` field is the most valuable for craft prompts but may contain generic advice. |

### 2.6 `viral_tweet_analyses`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Cache of analyzed viral tweets from source accounts. Each row is a detailed analysis of a single tweet: hook formula, claim type, tone, format pattern, timing pattern, audience pain point, engagement metrics, and how it could be adapted for @30piq. The `scan_account` step writes these analyses, and they serve as the raw input for the learning extraction that populates `x_algorithm_learning_rules` and `viral_style_patterns`. |
| **Key Columns** | `id` (UUID PK), `creator_handle`, `tweet_id` (TEXT UNIQUE), `tweet_url`, `tweet_text`, `hook_formula`, `claim_type`, `tone`, `format_pattern`, `timing_pattern`, `audience_pain`, `adaptation_for_30piq`, `originality_risk`, `engagement_per_1k_followers`, `metrics` (JSONB), `analysis` (JSONB), `analysis_payload` (JSONB) |
| **Active Code References** | **Writes**: `lib/content-engine-v3.ts`, `lib/pipeline-worker.ts` (scan_account step). **Reads**: `app/api/learning-cycle/route.ts`, `app/api/learning-health/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/viral-account-scan/route.ts` |
| **Notes** | **Schema smell**: Duplicate column pairs from the v5 migration data copy — `username`/`creator_handle` and `text`/`tweet_text` store the same data. The FK to `viral_scan_runs` is a legacy reference — the queue-based pipeline writes analyses without creating a scan_run. Needs index on `(creator_handle, created_at DESC)` for per-author queries. |

### 2.7 `working_memory`

| Attribute | Detail |
|----------- |--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | Generic key-value memory store keyed by `(memory_type, source_table, source_id)`. Used by the performance feedback system to cache intermediate results and by the brain viewer for display. Unlike `compact_operator_rules` which stores structured rules, working memory stores arbitrary JSON blobs with TTL support (`expires_at`). |
| **Key Columns** | `id` (UUID PK), `memory_type` (TEXT), `source_table` (TEXT), `source_id` (TEXT), `content` (JSONB), `confidence_score` (NUMERIC 4,2), `access_count`, `last_accessed_at`, `expires_at` (TIMESTAMPTZ) |
| **Active Code References** | **Writes/Reads**: `lib/performance-feedback.ts`, `app/api/brain-viewer/route.ts` |
| **Notes** | The `expires_at` column supports TTL-based cleanup but no cleanup job exists. The UNIQUE constraint on `(memory_type, source_table, source_id)` prevents duplicates. This is the least-used memory table in the active pipeline — it's more of a cache than a first-class memory store. |

### 2.8 `system_learning_rules`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_MEMORY |
| **Primary Purpose** | General-purpose learning rules that aren't tied to a specific source author or viral pattern. These rules are broader than `x_algorithm_learning_rules` and cover system-level patterns (e.g., "AI content gets more engagement on weekdays"). Read by the brain query system, originality context, and various learning/reflection API routes. |
| **Key Columns** | `id` (SERIAL PK), `rule_type`, `rule` (TEXT), `evidence`, `applies_to`, `confidence_score` (NUMERIC 4,2 — note: differs from 4,1 in other brain tables), `status`, `test_run`, `created_at`, `updated_at` |
| **Active Code References** | **Reads**: `lib/brain-query.ts`, `lib/performance-feedback.ts`, `lib/originality-context.ts`, `app/api/brain-viewer/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-build-planner/route.ts` |
| **Notes** | **Schema inconsistency**: `confidence_score` uses NUMERIC(4,2) here vs NUMERIC(4,1) in `x_algorithm_learning_rules` and `viral_style_patterns`. This should be standardized. No index on `(status, rule_type, confidence_score DESC)` — same missing index problem as other brain tables. The `success_count` and `failure_count` columns present in other brain tables are missing here, making it impossible to track rule performance. |

---

## 3. ACTIVE_TELEGRAM — Bot State & Delivery

### 3.1 `telegram_bot_state`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_TELEGRAM |
| **Primary Purpose** | Tracks the Telegram bot's conversational state per chat. When the operator initiates a multi-step flow (e.g., adding a new account, which requires handle + category input), the `current_flow` and `flow_payload` fields track where in the flow the user is and what data has been collected so far. This enables the webhook handler to resume conversations across multiple messages. |
| **Key Columns** | `chat_id` (TEXT PK), `user_id`, `username`, `current_flow` (TEXT — e.g., 'add_account'), `flow_payload` (JSONB — partial data collected), `last_message`, `created_at`, `updated_at` |
| **Active Code References** | **Writes/Reads**: `app/api/telegram/webhook/route.ts` |
| **Notes** | Single-user table (one row for the operator's chat). Very low risk. The `current_flow` field should be cleared after flow completion or timeout to prevent stale state from interfering with new commands. |

### 3.2 `content_deliveries`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_TELEGRAM |
| **Primary Purpose** | Tracks the delivery status of content recommendations sent via Telegram. Each delivery is linked to a content item (via `content_log_id` — legacy FK to `content_log` table), records the delivery type (telegram), status (pending/delivered/failed), and the Telegram message/chat IDs for reference. The `user_action` and `published_at` fields enable tracking whether the operator actually published the recommended content. |
| **Key Columns** | `id` (UUID PK), `content_log_id` (INT — loose FK to content_log), `content_type`, `delivery_type`, `delivery_status`, `telegram_message_id`, `telegram_chat_id`, `delivered_at`, `user_action`, `published_at`, `performance_scan_id` (UUID) |
| **Active Code References** | **Writes**: `lib/publishing-pipeline.ts` (legacy), `lib/media-pipeline.ts`. **Reads**: None in active queue-based pipeline |
| **Notes** | **Important**: This table is primarily written by the legacy `publishing-pipeline.ts`, NOT by the active queue-based pipeline. The active pipeline sends Telegram messages directly without recording a `content_deliveries` row. This means delivery tracking is incomplete for the current pipeline path. The FK references to `content_log` (legacy) and `performance_scans` (legacy) are not enforced. Needs index on `delivery_status` and `created_at DESC`. |

---

## 4. ACTIVE_COST_LOGGING — Cost & Audit Tables

### 4.1 `pipeline_cost_ledger`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_COST_LOGGING |
| **Primary Purpose** | Records every LLM API call made by the pipeline with full cost attribution: which run, which task, which model, how many tokens, and the estimated cost in USD. This is the authoritative source for "how much does each pipeline run cost" and "which model is most expensive." The cost summary API (`/api/cost-summary`) aggregates from this table. |
| **Key Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs, ON DELETE SET NULL), `task_id` (UUID FK → pipeline_tasks, ON DELETE SET NULL), `task_type`, `provider`, `model`, `input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost_usd` (NUMERIC 12,8), `status` (pending/completed/failed), `error`, `started_at`, `completed_at` |
| **Active Code References** | **Writes**: `lib/cost-ledger.ts` (called by `lib/model-router.ts` after every API call). **Reads**: `lib/run-cost-summary.ts`, `app/api/cost-summary/route.ts` |
| **Notes** | **RLS issue**: RLS is enabled but NO policies exist. The service role bypasses RLS, so this works in production, but it creates a false sense of security. If `anon` or `authenticated` roles ever need access, they'll be silently blocked. The 6 indexes on this table are well-designed for common query patterns (by run, by task type, by provider, by date). The `ON DELETE SET NULL` for FKs means deleting a pipeline run won't cascade-delete its cost records. |

### 4.2 `rejection_ledger`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_COST_LOGGING |
| **Primary Purpose** | Records every content rejection with the specific reason, the module that rejected it (publish_gate, judge, quality_enhance), and a preview of the rejected text. This is the primary diagnostic tool for understanding why content is being rejected. The rejection transparency system (Phase 2e3) writes detailed rejection reasons here, and the `/api/learning-health` endpoint summarizes them. |
| **Key Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs), `task_id` (UUID FK → pipeline_tasks), `opportunity_index`, `opportunity_type`, `rejection_reason` (TEXT — the specific reason), `shield_reason` (TEXT — from account shield), `source_url_count`, `numeric_claim_flag`, `crafted_text_preview`, `crafted_text_hash`, `module_origin` (publish_gate/judge/quality_enhance), `created_at` |
| **Active Code References** | **Writes**: `lib/rejection-ledger.ts` (called from publish_gate step). **Reads**: `lib/originality-context.ts` (reads recent rejections for originality context) |
| **Notes** | **RLS issue**: Same as `pipeline_cost_ledger` — RLS enabled with no policies. The `crafted_text_hash` enables privacy-preserving deduplication (checking if the same text was rejected before without storing the full text). The `module_origin` column is critical for the proposed P1 fix (shield per-check breakdown diagnostics). |

### 4.3 `session_logs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_COST_LOGGING |
| **Primary Purpose** | General session audit trail. Records what actions were completed, decisions made, content created, and pending tasks for each orchestrator session. Used by the weekly review and system cleanup APIs to understand system activity over time. |
| **Key Columns** | `id` (UUID PK), `ai_tool` (default 'orchestrator'), `session_type` (default 'api_run'), `actions_completed` (JSONB), `decisions_made` (JSONB), `content_created` (JSONB), `db_updates` (JSONB), `github_updates` (JSONB), `pending_tasks` (JSONB), `next_recommendation`, `notes`, `ended_at` |
| **Active Code References** | **Writes**: `lib/supabase.ts` (generic logging), `lib/performance-feedback.ts`. **Reads**: `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | Low-priority audit table. No indexes beyond PK. The JSONB columns can grow large if not cleaned. The `ended_at` column is nullable, meaning sessions can remain "open" indefinitely if the system crashes before writing the end timestamp. |

---

## 5. ACTIVE_SOURCE_POOL — Account Management

### 5.1 `accounts`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_SOURCE_POOL |
| **Primary Purpose** | The source account pool. Each row represents an X account that the pipeline scans for viral content. The `tier` column controls scan priority (tier 1 = most valuable, scanned first), `active` controls whether the account is included in scans, and `category` enables category-based scan allocation (a proposed P1 improvement). The `last_checked` and `last_scanned_at` columns track when the account was last processed, used for cooldown logic. |
| **Key Columns** | `id` (UUID PK), `handle` (TEXT UNIQUE), `username`, `tier` (INT, default 2), `active` (BOOLEAN, default true), `category` (TEXT — added by alignment migration), `followers`, `avg_engagement`, `our_reply_count`, `last_reply_date`, `last_checked`, `discovered_at`, `last_scanned_at` |
| **Active Code References** | **Writes**: `lib/content-engine-v3.ts`, `lib/pipeline-queue.ts` (updates last_checked), `app/api/telegram/webhook/route.ts` (add account command). **Reads**: `lib/pipeline-queue.ts` (selects accounts for scan), `lib/pipeline-worker.ts`, `app/api/learning-cycle/route.ts`, `app/api/viral-account-scan/route.ts` |
| **Notes** | **Critical gap**: The `selectValidAccounts` function uses only `tier + last_checked` for selection — no category weighting, no quality feedback from `source_quality_scores`. This is the primary motivation for the P1 Source Strategy fix. The `category` column was added but never populated for most accounts. Need index on `(active, tier)` for pool queries. |

### 5.2 `source_quality_scores`

| Attribute | Detail |
|-----------|--------|
| **Classification** | ACTIVE_SOURCE_POOL |
| **Primary Purpose** | Aggregated quality metrics per source account. Tracks how many scans were done, how many opportunities were found, selected, rescued, judge-passed, and publish-gate-accepted. Computes yield rates, rejection rates, and an overall `source_quality_score`. This data should feed back into account selection (P1 fix) but currently is only used by the `scripts/source-quality-audit.ts` offline script. |
| **Key Columns** | `source_handle` (TEXT PK), `scans_count`, `tweets_analyzed`, `raw_opportunities_count`, `selected_count`, `rescued_count`, `judge_passed_count`, `publish_gate_accepted_count`, `rejection_reason_counts` (JSONB), `avg_publishability_score`, `avg_originality_potential_score`, `avg_niche_fit_score`, `opportunity_yield_rate`, `selected_rate`, `rejection_rate`, `source_quality_score` |
| **Active Code References** | **Writes**: `scripts/source-quality-audit.ts`. **Reads**: `scripts/source-quality-audit.ts` |
| **Notes** | **Not integrated into the live pipeline**. The scores are computed offline and not used by `selectValidAccounts`. This is the key gap in the source strategy. No FK to `accounts(handle)` — intentional loose coupling, but means orphan scores can exist for deleted accounts. RLS is not enabled. |

---

## 6. LEGACY_DO_NOT_TOUCH — Old Pipeline Tables

These 15 tables are from the v2/v3 pipeline architecture (before the queue-based system). They may contain valuable historical data and some still have active writers from legacy API routes. **Do not modify schema, do not write new data, read only for audit purposes.**

### 6.1 `sources`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old source tracking table from v2. No CREATE TABLE migration exists in the repository — the table was likely created manually via the Supabase SQL editor. Still referenced by `research-intel-run` and `research-intel-v4` API routes with `select('*')`. This table likely duplicates data that now lives in `accounts`. |
| **Key Columns** | Unknown — no migration to inspect. Presumed to have `tier`, `handle`, and similar source-tracking columns. |
| **Active Code References** | **Reads**: `app/api/research-intel-run/route.ts`, `app/api/research-intel-v4/route.ts` |
| **Notes** | **HIGH PRIORITY**: Schema must be documented from live DB. Determine if this duplicates `accounts` and migrate references to use `accounts` instead. The two research-intel routes are the only remaining readers. |

### 6.2 `content_opportunities`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old v2 content opportunity format. Each row represented a content opportunity with topic, angle, audience pain, scoring dimensions, and status. This table was the output of the v2 learning cycle pipeline, which has been replaced by the `opportunity_intelligence` step in the queue-based pipeline. |
| **Key Columns** | `id` (UUID PK), `learning_cycle_id` (FK → learning_cycles), `opportunity_type`, `topic`, `angle`, `audience_pain`, `confidence_score`, `priority_score`, `depth_score`, `freshness_score`, `visual_score`, `technical_score`, `uniqueness_score`, `status` |
| **Active Code References** | **Reads**: `app/api/format-decision/route.ts`, `app/api/learning-cycle/route.ts`, `app/api/repo-ingest/route.ts`, `app/api/health/route.ts` |
| **Notes** | Still read by format-decision and learning-cycle routes. Do not modify. The multi-dimensional scoring (depth, freshness, visual, technical, uniqueness) was an interesting approach that was simplified in the current pipeline. |

### 6.3 `original_content_hypotheses`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old v2 content hypothesis format. Each row was a draft tweet with hook formula, draft text, viral mechanic, and quality assessment. This was the output of the v2 crafting step, replaced by the `enrich_opportunities` and `quality_enhance` steps. |
| **Key Columns** | `id` (UUID PK), `learning_cycle_id` (FK), `content_opportunity_id` (FK), `format`, `hook_formula`, `draft_text`, `viral_mechanic`, `why_original`, `why_replyable`, `why_bookmarkable`, `quality_status`, `quality_reasons` |
| **Active Code References** | **Reads**: `app/api/learning-cycle/route.ts`, `app/api/production-cycle/route.ts` |
| **Notes** | Do not modify. The "why_original / why_replyable / why_bookmarkable" structure was a good idea that could inform future prompt improvements. |

### 6.4 `raw_research_items`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old research pipeline cache. Stored web search results (title, URL, snippet, source quality, freshness) from the v2 research cycle. The queue-based pipeline doesn't use web search as a discovery mechanism. |
| **Key Columns** | `id` (UUID PK), `learning_cycle_id` (FK), `query`, `title`, `url` (UNIQUE), `snippet`, `source_provider`, `source_quality_score`, `freshness_score`, `status` |
| **Active Code References** | **Reads**: `app/api/learning-cycle/route.ts` |
| **Notes** | Do not modify. The `source_quality_score` and `freshness_score` INTEGER columns were predecessors to the more sophisticated scoring in the current pipeline. |

### 6.5 `content_log`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old content logging table. Tracked every piece of content from draft through published, including engagement metrics. The SERIAL PK (not UUID) indicates this is from the earliest version of the system. Still heavily referenced by legacy routes, making it risky to remove. |
| **Key Columns** | `id` (SERIAL PK), `content_type`, `topic`, `hook_text`, `final_text`, `target_audience`, `publish_status`, `tweet_url`, `views`, `likes`, `replies`, `reposts`, `bookmarks`, `performance_score`, `published_at` |
| **Active Code References** | **Reads**: `lib/content-type-engine.ts`, `lib/performance-feedback.ts`, `app/api/weekly-review/route.ts`, `app/api/publish-pack/route.ts`, `app/api/format-decision/route.ts`, `app/api/production-cycle/route.ts`, `app/api/research-intel-run/route.ts` |
| **Notes** | Despite being classified as legacy, this is the most-referenced legacy table. The `content_deliveries` table has a loose FK (`content_log_id`) pointing here. The SERIAL PK is a schema smell that indicates the table predates the UUID standard. The engagement metric columns (views, likes, etc.) are from the performance feedback system. |

### 6.6 `action_queue`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old action system. Stored human-operator tasks with priority, action type, instructions, and prepared content. The current pipeline replaced this with Telegram recommendations — instead of queueing actions for the operator, the system sends a recommendation and waits for manual action. |
| **Key Columns** | `id` (SERIAL PK), `priority`, `action_type`, `title`, `instruction`, `prepared_content` (JSONB), `status`, `assigned_to` |
| **Active Code References** | **Reads**: `app/api/weekly-review/route.ts` (only) |
| **Notes** | Likely has no active writers. The weekly-review route may still read from it but probably returns empty results. Safe to ignore but don't drop without verifying emptiness via live query. |

### 6.7 `viral_scan_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old scan run tracking. Each row represents a viral scan execution with metadata about which handles were scanned, patterns found, and the model used. Still written by the `viral-account-scan` API route. The FK from `viral_tweet_analyses` points here, creating a dependency. |
| **Key Columns** | `id` (UUID PK), `creator_handle`, `scan_version`, `tweets_requested`, `tweets_analyzed`, `data_quality`, `patterns_found`, `status`, `error`, `model_used` |
| **Active Code References** | **Writes/Reads**: `app/api/viral-account-scan/route.ts`, `app/api/health/route.ts` |
| **Notes** | Still actively written by the viral-account-scan route (which is separate from the main pipeline). The FK from `viral_tweet_analyses.scan_run_id` points here, but the queue-based pipeline writes analyses without creating a corresponding scan_run — this means the FK constraint is either not enforced or analyses from the current pipeline have NULL scan_run_id. |

### 6.8 `viral_account_patterns`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old pattern tracking from viral scans. Stored per-creator patterns with confidence scores and adaptation notes. The current pipeline stores this data in `x_algorithm_learning_rules` and `viral_style_patterns` instead. |
| **Key Columns** | `id` (UUID PK), `scan_run_id` (FK → viral_scan_runs), `creator_handle`, `pattern_type`, `pattern_name`, `rule`, `evidence`, `confidence_score`, `apply_to_30piq`, `avoid_copying_note` |
| **Active Code References** | **Reads**: `app/api/viral-account-scan/route.ts`, `app/api/format-decision/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/health/route.ts` |
| **Notes** | Still read by growth-learning-run. The `apply_to_30piq` and `avoid_copying_note` fields are useful — consider whether this data should be migrated to `viral_style_patterns` before deprecating. |

### 6.9 `content_format_decisions`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old v2 format decision tracking. Stored the chosen content format (single_tweet, thread, etc.) with multi-dimensional scoring and production requirements. The current pipeline simplifies this — format is determined during crafting, not as a separate decision step. |
| **Key Columns** | `id` (UUID PK), `learning_cycle_id` (FK), `opportunity_id` (FK), `content_opportunity_id` (FK), `chosen_format`, `format_reason`, `depth_score`, `freshness_score`, `visual_score`, `technical_score`, `uniqueness_score`, `production_requirements` (JSONB), `status` |
| **Active Code References** | **Reads**: `app/api/format-decision/route.ts`, `app/api/production-cycle/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Notes** | **Schema smell**: Has both `opportunity_id` and `content_opportunity_id` FK columns pointing to `content_opportunities` — a duplicate FK from a migration error. Do not modify. |

### 6.10 `content_production_cards`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old v2 production system. Stored the final production-ready content (text, thread items, article outline, repo plan) with quality assessment. The current pipeline replaces this with the `enrich_opportunities` → `quality_enhance` → `opportunity_judge` chain. |
| **Key Columns** | `id` (UUID PK), `format_decision_id` (FK), `content_opportunity_id` (FK), `production_type`, `final_text`, `thread_items` (JSONB), `article_outline` (JSONB), `repo_plan` (JSONB), `quality_status`, `publish_status` |
| **Active Code References** | **Reads**: `app/api/launch-content-repair/route.ts`, `app/api/launch-content-repair-v2/route.ts`, `app/api/launch-content-repair-strict/route.ts`, `app/api/repo-investment-run/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-build-planner/route.ts` |
| **Notes** | Still read by many repair/growth routes. This is the most-referenced legacy table after `content_log`. The repair routes may still be useful for manual content fixes, but they operate outside the main pipeline. |

### 6.11 `learning_tweet_queue`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old learning pipeline queue. Stored tweet URLs submitted for learning analysis (from Telegram or other sources). The current pipeline discovers tweets automatically during the scan step, making manual submission unnecessary. |
| **Key Columns** | `id` (UUID PK), `tweet_url`, `source`, `status`, `notes`, `learning_cycle_id`, `fetched_data` (JSONB), `error` |
| **Active Code References** | **Reads**: `app/api/learning-cycle/route.ts`, `app/api/db-setup/route.ts` |
| **Notes** | Do not modify. Likely empty or contains stale entries from early testing. |

### 6.12 `learning_cycles`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old learning cycle tracking. Each row represents a research+analysis cycle with inputs and summary. The current pipeline doesn't use explicit cycles — learning happens continuously through the structured memory system. |
| **Key Columns** | `id` (UUID PK), `cycle_type` (default 'research_viral_fusion'), `status`, `inputs` (JSONB), `summary` (JSONB) |
| **Active Code References** | **Reads**: `app/api/learning-cycle/route.ts` |
| **Notes** | Referenced by FKs from `content_opportunities`, `original_content_hypotheses`, and `content_format_decisions`. This is the root of the v2 learning cycle hierarchy. Do not modify. |

### 6.13 `behavior_limits`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Account behavior limits by stage (max posts per day, max replies per day, min minutes between actions, etc.). Designed for auto-posting safety, but since the current system is recommendation-only, these limits are not enforced. Could be reactivated if auto-posting is ever implemented. |
| **Key Columns** | `id` (UUID PK), `account_handle`, `stage`, `max_original_posts_per_day`, `max_replies_per_day`, `max_quotes_per_day`, `min_minutes_between_actions`, `max_same_author_interactions_per_day`, `links_allowed`, `hashtags_allowed` |
| **Active Code References** | Only in migration file (`2026-05-27_alignment.sql`) |
| **Notes** | No active code references beyond the migration. Could be reactivated for stage-aware safety if auto-posting is ever considered. The UNIQUE constraint on `(account_handle, stage)` is well-designed. |

### 6.14 `performance_scans`

| Attribute | Detail |
|-----------|--------|
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Primary Purpose** | Old performance scanning results. Stored tweet performance analysis results (high performers, underperformers, average score, brain summary). The current performance feedback system uses `published_decisions` + the X API instead. |
| **Key Columns** | `id` (UUID PK), `account_handle`, `scanned_tweets`, `high_performers`, `underperformers`, `average_score`, `brain_summary`, `learning_updates` (JSONB) |
| **Active Code References** | **Writes/Reads**: `lib/performance-feedback.ts`, `app/api/weekly-review/route.ts` |
| **Notes** | Still written by `performance-feedback.ts`. This table should eventually be migrated to the new performance feedback system, but it's not urgent. |

---

## 7. EXPERIMENTAL — Tables for Features Under Development

These 12 tables support experimental features that are not part of the core pipeline. Some may be actively written by API routes; others may be empty. **Verify with live DB query before dropping any of these.**

### 7.1 `source_performance`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Alternative source performance tracking, similar to `source_quality_scores`. Referenced by `learning-reflection-run` with `.upsert()`. May have been an earlier attempt at source quality scoring before `source_quality_scores` was formalized. **No CREATE TABLE migration exists** — schema is unknown without live DB access. |
| **Key Columns** | Unknown — no migration file. Presumed to have `source_handle` and performance metric columns. |
| **Active Code References** | **Writes**: `app/api/learning-reflection-run/route.ts`. **Reads**: `app/api/system-cleanup/route.ts` |
| **Notes** | **Likely duplicates `source_quality_scores`**. Should be investigated and consolidated. The fact that it has no migration is a red flag — it was likely created ad-hoc and never formalized. |

### 7.2 `quality_failure_patterns`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Tracks patterns in quality failures (e.g., "70% of rejected content has unverifiable numeric claims"). No CREATE TABLE migration exists. Referenced in learning-reflection and system-cleanup routes. |
| **Key Columns** | Unknown — no migration file. |
| **Active Code References** | **Reads**: `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | If this table is empty, it can be safely dropped. If it contains data, the data should be migrated to `compact_operator_rules` (which already stores failure patterns). |

### 7.3 `prompt_improvement_candidates`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Tracks potential prompt improvements identified during learning reflection runs. No CREATE TABLE migration exists. Likely stores observations like "the crafting prompt produces overly long tweets" with suggested prompt modifications. |
| **Key Columns** | Unknown — no migration file. |
| **Active Code References** | **Reads**: `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | Interesting concept but never formalized. If data exists, it could inform the proposed P2 near-pass polish effectiveness audit. Otherwise, can be dropped. |

### 7.4 `mcp_opportunity_map`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Maps MCP (Model Context Protocol) opportunities — identifying where external tool integration could improve the pipeline. Part of the broader "repo intelligence" experimental feature set. |
| **Key Columns** | From `supabase-migrations.sql`: `id` (UUID PK), `opportunity_type`, `description`, `source`, `status`, `created_at` |
| **Active Code References** | **Reads**: `app/api/system-cleanup/route.ts` |
| **Notes** | Low usage. Likely empty or contains test data from early MCP exploration. Can be dropped if confirmed empty. |

### 7.5 `growth_learning_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Logs from growth learning runs — an experimental feature that tries to identify growth opportunities from published content performance data. Each run tracks which rules were evaluated, which were promoted/demoted, and overall learning outcomes. |
| **Key Columns** | `id` (UUID PK), `run_type`, `rules_evaluated`, `rules_promoted`, `rules_demoted`, `summary` (JSONB), `status`, `error`, `created_at` |
| **Active Code References** | **Writes**: `app/api/growth-learning-run/route.ts`. **Reads**: `app/api/health/route.ts`, `app/api/memory-maintenance-run/route.ts`, `app/api/db-setup/route.ts`, `lib/learning-memory.ts` |
| **Notes** | More actively used than other experimental tables. The growth learning feature is a precursor to the proposed P4 performance feedback loop. This table may eventually be promoted to ACTIVE_MEMORY if the feature stabilizes. |

### 7.6 `trends`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Trend tracking — stores trending topics, hashtags, or content patterns discovered from X or web search. Part of the research-intel feature set. |
| **Key Columns** | From migrations: `id` (UUID PK), `topic`, `source`, `relevance_score`, `discovered_at` |
| **Active Code References** | **Writes/Reads**: `app/api/research-intel-v4/route.ts`, `app/api/research-intel-run/route.ts`, `app/api/viral-account-scan/route.ts`, `app/api/viral-discovery-run/route.ts`, `app/api/health/route.ts`, `app/api/db-setup/route.ts` |
| **Notes** | Referenced by several routes. The `research-intel` feature appears to be semi-active. Verify whether any data exists before dropping. |

### 7.7 `creator_intel`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Creator intelligence — stores insights about specific content creators (their typical topics, posting patterns, engagement strategies). Part of the viral discovery feature set. |
| **Key Columns** | From migrations: `id` (UUID PK), `creator_handle`, `intel_type`, `intel_data` (JSONB), `confidence`, `created_at` |
| **Active Code References** | **Writes/Reads**: `app/api/viral-account-scan/route.ts`, `app/api/viral-discovery-run/route.ts`, `app/api/research-intel-run/route.ts`, `app/api/research-intel-v4/route.ts`, `app/api/health/route.ts`, `app/api/db-setup/route.ts` |
| **Notes** | If populated, this data could enrich the `source_author_memory` table. Consider migrating rather than dropping. |

### 7.8 `discovered_items`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Tracks items discovered during discovery runs — URLs, content, or topics found through web search or viral scanning. Part of the discovery feature set. |
| **Key Columns** | `id` (UUID PK), `source_type`, `url`, `title`, `content_preview`, `relevance_score`, `status`, `created_at` |
| **Active Code References** | **Writes/Reads**: `app/api/system-cleanup/route.ts`, `app/api/discovery-run/route.ts`, `app/api/health/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Notes** | Referenced by the discovery-run route which appears semi-active. Verify data volume before deciding to keep or drop. |

### 7.9 `repo_source_files`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Stores source code files from GitHub repos ingested for analysis. Part of the repo intelligence feature set that learns from code repositories. |
| **Key Columns** | `id` (UUID PK), `repo_url`, `file_path`, `content` (TEXT), `language`, `size_bytes`, `ingested_at` |
| **Active Code References** | **Writes/Reads**: `app/api/repo-ingest/route.ts`, `app/api/repo-build-planner/route.ts`, `app/api/repo-style-learn/route.ts`, `app/api/repo-artifact-writer/route.ts`, `app/api/repo-deep-learn/route.ts`, `app/api/repo-deep-learn-excerpt/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | Heavily referenced by repo-related routes. The repo intelligence feature appears to be actively developed despite being experimental. Large table due to stored file contents. |

### 7.10 `repo_extracted_rules`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Stores rules extracted from GitHub repo analysis — coding patterns, best practices, architectural decisions. These rules could inform content about software development topics. |
| **Key Columns** | `id` (UUID PK), `repo_url`, `rule_type`, `rule`, `evidence`, `confidence`, `created_at` |
| **Active Code References** | **Writes/Reads**: Same routes as `repo_source_files` |
| **Notes** | Could be migrated to `system_learning_rules` or `x_algorithm_learning_rules` if the repo intelligence feature is formalized. Currently experimental and separate from the brain system. |

### 7.11 `requirement_status`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Tracks requirement status for account profile compliance (e.g., "profile image uploaded", "bio contains keywords"). Part of the growth and account optimization feature set. |
| **Key Columns** | `id` (UUID PK), `requirement_type`, `status`, `details` (JSONB), `checked_at` |
| **Active Code References** | **Reads**: `app/api/log-user-action/route.ts`, `app/api/db-setup/route.ts`, `app/api/health/route.ts` |
| **Notes** | Low usage. Likely created for the `check-account` feature but never fully implemented. Can be dropped if confirmed empty. |

### 7.12 `target_plans`

| Attribute | Detail |
|-----------|--------|
| **Classification** | EXPERIMENTAL |
| **Primary Purpose** | Stores target growth plans — follower milestones, engagement targets, content frequency goals. Part of the growth planning feature set. |
| **Key Columns** | `id` (UUID PK), `plan_type`, `target_metric`, `target_value`, `current_value`, `deadline`, `status`, `created_at` |
| **Active Code References** | **Reads**: `app/api/health/route.ts`, `app/api/db-setup/route.ts` |
| **Notes** | Very low usage — only referenced by health and db-setup routes for listing. Likely empty. Can be dropped if confirmed empty. |

---

## 8. UNKNOWN_NEEDS_REVIEW — Requires Live DB Verification

These 7 tables are referenced in code but their current status is unclear. They may be active, empty, or orphaned. **Do not modify until live DB verification is complete.**

### 8.1 `system_cleanup_registry`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Registry for the system cleanup feature — tracks which tables/records have been cleaned up and when. Referenced by the system-cleanup API route. |
| **Key Columns** | Unknown — no migration file in repository |
| **Active Code References** | **Writes/Reads**: `app/api/system-cleanup/route.ts` |
| **Notes** | The system-cleanup route appears to be a maintenance utility. If this table exists and contains data, it records which cleanup operations were performed. If it doesn't exist, the cleanup route will fail silently (Supabase returns empty results for non-existent tables with service role). |

### 8.2 `system_cleanup_batches`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Tracks batches of cleanup operations — likely groups related cleanup actions (e.g., "delete all legacy content_opportunities from before 2025-01-01"). Referenced alongside `system_cleanup_registry`. |
| **Key Columns** | Unknown — no migration file in repository |
| **Active Code References** | **Writes/Reads**: `app/api/system-cleanup/route.ts` |
| **Notes** | Likely companion to `system_cleanup_registry`. If the system-cleanup feature was never activated, these tables may not exist in the live DB despite being referenced in code. |

### 8.3 `repo_sources`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Tracks GitHub repos as sources for content. Referenced by many repo-related API routes. May be a parent table for `repo_source_files` — storing repo-level metadata while `repo_source_files` stores individual files. |
| **Key Columns** | Unknown — likely `id` (UUID PK), `repo_url`, `status`, `last_ingested_at` |
| **Active Code References** | **Writes/Reads**: `app/api/repo-ingest/route.ts`, `app/api/repo-build-planner/route.ts`, `app/api/repo-deep-learn-excerpt/route.ts`, `app/api/repo-style-learn/route.ts`, `app/api/repo-artifact-writer/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/repo-deep-learn/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | Heavily referenced. If the repo intelligence feature is active, this table likely has data and should be reclassified as EXPERIMENTAL or ACTIVE depending on usage patterns. The fact that it has no migration file suggests it was created ad-hoc. |

### 8.4 `repo_creation_decisions`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Tracks decisions about repo creation — whether a new repo should be created from learned content, what the repo should contain, and the outcome of the creation process. Referenced by repo-ingest, repo-build-planner, and artifact routes. |
| **Key Columns** | Unknown — no migration file in repository |
| **Active Code References** | **Writes/Reads**: `app/api/repo-ingest/route.ts`, `app/api/repo-build-planner/route.ts`, `app/api/repo-artifact-writer/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Notes** | Part of the experimental repo intelligence feature. The `github-create-repo` and `repo-create-and-push` API routes suggest this feature can actually create GitHub repos, making it higher-risk than other experimental tables. |

### 8.5 `discovery_sources`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Tracks sources for the discovery feature — where discovered items come from (web search, viral scan, manual submission). Companion to `discovered_items` and `discovery_runs`. |
| **Key Columns** | Unknown — no migration file in repository |
| **Active Code References** | **Writes/Reads**: `app/api/learning-reflection-run/route.ts`, `app/api/discovery-run/route.ts` |
| **Notes** | If the discovery-run feature is active, this table may contain source tracking data. Otherwise, likely empty. Verify before modifying. |

### 8.6 `discovery_runs`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Logs from discovery runs — execution metadata for the content discovery feature. Similar to `growth_learning_runs` but for the discovery pipeline. |
| **Key Columns** | Unknown — likely `id` (UUID PK), `status`, `items_discovered`, `created_at` |
| **Active Code References** | **Writes/Reads**: `app/api/system-cleanup/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/discovery-run/route.ts` |
| **Notes** | The discovery-run API route appears to be a standalone feature. If it has been run, this table may contain execution logs. Verify data volume before deciding to keep or archive. |

### 8.7 `system_reflections`

| Attribute | Detail |
|-----------|--------|
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Primary Purpose** | Stores system-level reflections — self-assessments of the pipeline's performance, weaknesses, and improvement areas. Generated by the learning-reflection-run feature. Could be valuable for understanding the system's self-awareness capabilities. |
| **Key Columns** | Unknown — no migration file in repository |
| **Active Code References** | **Writes/Reads**: `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Notes** | If populated, this could contain valuable insights about pipeline performance trends. Before dropping, check if any reflections have been generated and review their content. The learning-reflection feature is one of the more interesting experimental capabilities. |

---

## 9. Cross-Reference: Tables by Active Code File

This section maps which files interact with which table classifications, useful for impact analysis when modifying any file.

| File | ACTIVE_RUNTIME | ACTIVE_MEMORY | ACTIVE_COST | ACTIVE_SOURCE | LEGACY | EXPERIMENTAL | UNKNOWN |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `lib/pipeline-worker.ts` | ✓✓ | ✓✓ | ✓ | ✓ | | | |
| `lib/pipeline-queue.ts` | ✓✓ | | | ✓ | | | |
| `lib/content-engine-v3.ts` | | ✓✓ | | ✓ | | | |
| `lib/structured-memory-compaction.ts` | ✓ | ✓✓ | | | | | |
| `lib/structured-memory-retrieval.ts` | | ✓✓ | | | | | |
| `lib/cost-ledger.ts` | ✓✓ | | ✓✓ | | | | |
| `lib/rejection-ledger.ts` | | | ✓✓ | | | | |
| `lib/model-router.ts` | ✓ | | ✓✓ | | | | |
| `lib/account-shield.ts` | ✓ | ✓ | | | | | |
| `lib/performance-feedback.ts` | ✓ | ✓✓ | ✓ | | ✓ | | |
| `lib/published-decision-logger.ts` | ✓ | | | | | | |
| `lib/brain-query.ts` | | ✓✓ | | | | | |
| `lib/daily-runner.ts` | ✓✓ | | | | ✓ | | |

✓ = reads, ✓✓ = reads + writes

---

## 10. Recommended Actions Summary

### Immediate (before next run)
1. Verify `pipeline_runs` and `pipeline_tasks` have no stuck entries from previous failed runs
2. Confirm `model_routing_rules` has correct model IDs (no orphaned `anthropic/claude-sonnet-4`)

### Short-term (before scaling)
3. Add missing indexes: `(status, rule_type, confidence_score DESC)` on brain tables, `(active, tier)` on accounts, `(account_handle, created_at DESC)` on decision_runs
4. Fix RLS policies on `pipeline_cost_ledger` and `rejection_ledger`
5. Integrate `source_quality_scores` into `selectValidAccounts`
6. Document schemas for tables with no migration file (`sources`, `source_performance`, `quality_failure_patterns`, `prompt_improvement_candidates`, and all UNKNOWN tables)

### Medium-term (cleanup)
7. Consolidate `source_performance` into `source_quality_scores` or vice versa
8. Add `active` boolean column to `compact_operator_rules` for soft-delete support
9. Standardize `confidence_score` type across all brain tables (currently NUMERIC(4,1) vs NUMERIC(4,2))
10. Add periodic cleanup jobs for `pipeline_tasks` (>30 days), `memory_compaction_runs`, and `session_logs`

### Long-term (archival)
11. Archive or drop confirmed-empty experimental tables
12. Migrate remaining `sources` references to `accounts`
13. Consider whether repo intelligence tables should be promoted to EXPERIMENTAL or dropped

---

*End of ACTIVE_TABLES.md. This document should be updated whenever tables are created, dropped, or reclassified.*
