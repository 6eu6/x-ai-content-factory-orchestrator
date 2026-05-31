# Database Audit Report — x-ai-content-factory-orchestrator

> **Project**: x-ai-content-factory-orchestrator
> **Supabase Project**: `qmoictvgwavhirnexscz`
> **Audit Date**: 2026-06-01
> **Method**: Static analysis of migration files + source code (no live DB access)
> **Auditor**: Automated audit agent

---

## 1. Executive Summary

This report presents a comprehensive database audit for the x-ai-content-factory-orchestrator project, which powers the @30piq X content recommendation engine on Supabase. The audit was performed entirely through static analysis of 13 SQL migration files and 80+ TypeScript source files, since no `.env` credentials exist in the repository (they are managed exclusively via Vercel and Oracle VPS deployment environments).

**Key findings:**

- **55 tables identified** across migration files and source code references (updated from initial count of 48; includes 7 UNKNOWN_NEEDS_REVIEW tables discovered after initial audit). Of these, **21 are active tables** (ACTIVE_RUNTIME + ACTIVE_MEMORY + ACTIVE_TELEGRAM + ACTIVE_COST_LOGGING + ACTIVE_SOURCE_POOL), **14 are legacy**, **13 are experimental** (including `published_decisions` which is actively used and should be promoted to ACTIVE_RUNTIME), and **7 are unknown/needing review**.
- **4+ tables have no `CREATE TABLE` migration** anywhere in the repository: `sources`, `source_performance`, `quality_failure_patterns`, `prompt_improvement_candidates`, and all 7 UNKNOWN_NEEDS_REVIEW tables. These tables were likely created manually via the Supabase SQL editor or through a now-lost migration, creating a dangerous gap in version-controlled schema history.
- **Schema drift is significant**: Multiple `ALTER TABLE` additions are scattered across separate migration files (v3, v5, alignment, pipeline-tasks-queue), making it difficult to reconstruct the canonical schema from any single file. The `confidence_score` column alone appears with three different type declarations: `INTEGER`, `NUMERIC(4,1)`, and `NUMERIC(4,2)`.
- **RLS is enabled but policies are missing** on `pipeline_cost_ledger` and `rejection_ledger`. While the service role bypasses RLS, this creates a false sense of security — if the `anon` or `authenticated` roles ever need access, they would be silently blocked with no policy to guide them.
- **Duplicate source tracking** exists between the old `sources` table (no migration, referenced only in `research-intel-run` and `research-intel-v4`) and the newer `source_quality_scores` table (properly migrated, used by `scripts/source-quality-audit.ts`).

No live data audit was possible due to missing credentials. This report includes 56 recommended SQL audit queries that should be run once read-only DB access is established.

---

## 2. Table Classification

### Classification Legend

| Code | Meaning |
|------|---------|
| **ACTIVE_RUNTIME** | Tables actively read/written by the queue-based pipeline |
| **ACTIVE_MEMORY** | Brain/memory tables used for crafting and learning |
| **ACTIVE_TELEGRAM** | Telegram bot state and content delivery |
| **ACTIVE_COST_LOGGING** | Cost and audit ledger tables |
| **ACTIVE_SOURCE_POOL** | Source account tracking and quality scoring |
| **LEGACY_DO_NOT_TOUCH** | Old pipeline tables — do not modify, may contain historical data |
| **EXPERIMENTAL** | Tables created for experimental features, unclear if in active use |
| **UNKNOWN_NEEDS_REVIEW** | Tables with code references but no migration, or unclear purpose |

### 2.1 ACTIVE_RUNTIME Tables

#### `pipeline_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `source` (TEXT NOT NULL), `status` (TEXT DEFAULT 'running'), `current_step` (TEXT), `account_handle` (TEXT), `started_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ), `completed_at` (TIMESTAMPTZ), `failed_at` (TIMESTAMPTZ), `error_message` (TEXT), `error_stack` (TEXT), `scan_payload` (JSONB), `decision_payload` (JSONB), `telegram_payload` (JSONB), `debug_log` (JSONB), `total_tasks` (INT), `completed_tasks` (INT), `failed_tasks` (INT), `cancelled_at` (TIMESTAMPTZ), `worker_mode` (TEXT), `result_payload` (JSONB), `cancel_reason` (TEXT) |
| **Primary Key** | `id` |
| **Foreign Keys** | None (referenced by `pipeline_tasks`, `pipeline_cost_ledger`, `rejection_ledger`) |
| **Indexes** | `idx_pipeline_runs_status`, `idx_pipeline_runs_source`, `idx_pipeline_runs_started_at` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/pipeline-queue.ts`, `lib/pipeline-run-tracker.ts`, `lib/pipeline-worker.ts`, `lib/cost-ledger.ts`, `scripts/apply-phase2a-migrations.ts`, `scripts/source-quality-audit.ts` |
| **Recommended Action** | Monitor for stuck runs; add index on `account_handle` |

#### `pipeline_tasks`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs, ON DELETE CASCADE), `task_type` (TEXT NOT NULL), `status` (TEXT DEFAULT 'queued'), `step_order` (INT NOT NULL), `account_handle` (TEXT), `payload` (JSONB), `result` (JSONB), `attempts` (INT DEFAULT 0), `max_attempts` (INT DEFAULT 3), `locked_at` (TIMESTAMPTZ), `locked_by` (TEXT), `started_at` (TIMESTAMPTZ), `completed_at` (TIMESTAMPTZ), `failed_at` (TIMESTAMPTZ), `error_message` (TEXT), `error_stack` (TEXT), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `run_id` → `pipeline_runs(id)` ON DELETE CASCADE |
| **Indexes** | `idx_pipeline_tasks_run_id`, `idx_pipeline_tasks_status`, `idx_pipeline_tasks_task_type`, `idx_pipeline_tasks_step_order`, `idx_pipeline_tasks_locked_at`, `idx_pipeline_tasks_account_handle`, `idx_pipeline_tasks_queue_lock` (partial: status IN ('queued','running')) |
| **RLS** | Enabled with "Service role full access on pipeline_tasks" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/pipeline-queue.ts`, `lib/pipeline-worker.ts`, `lib/pipeline-run-tracker.ts`, `lib/structured-memory-compaction.ts`, `scripts/source-quality-audit.ts` |
| **Recommended Action** | Most heavily queried table; indexes are good. Add periodic cleanup for completed tasks >30 days old |

#### `account_state`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `account_handle` (TEXT PK), `x_url` (TEXT), `followers_count` (INTEGER), `following_count` (INTEGER), `posts_count` (INTEGER), `bio_text` (TEXT), `display_name` (TEXT), `profile_image_set` (BOOLEAN DEFAULT false), `verified_status` (TEXT DEFAULT 'unknown'), `last_live_check_at` (TIMESTAMPTZ), `last_known_source` (TEXT), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `account_handle` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/daily-runner.ts`, `lib/pipeline-worker.ts`, `lib/performance-feedback.ts`, `lib/content-type-engine.ts`, `lib/account-shield.ts`, `app/api/check-account/route.ts`, `app/api/weekly-review/route.ts` |
| **Recommended Action** | Add index on `last_live_check_at` for stale-check queries; validate handle format |

#### `decision_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `account_handle` (TEXT NOT NULL), `account_stage` (TEXT NOT NULL), `raw_opportunities` (INTEGER), `selected_count` (INTEGER), `held_count` (INTEGER), `budget` (JSONB), `selected_payload` (JSONB), `held_summary` (JSONB), `run_source` (TEXT DEFAULT 'daily_run'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | Referenced by `published_decisions` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/pipeline-worker.ts`, `lib/daily-runner.ts`, `lib/published-decision-logger.ts`, `app/api/learning-health/route.ts`, `app/api/performance-feedback/attribution-test/route.ts` |
| **Recommended Action** | Add index on `account_handle` and `created_at` |

#### `daily_checkins`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `checkin_date` (TEXT NOT NULL UNIQUE), `execution_mode` (TEXT), `account_checked` (BOOLEAN), `account_check_source` (TEXT), `profile_requirements_checked` (BOOLEAN), `daily_targets_checked` (BOOLEAN), `weekly_targets_checked` (BOOLEAN), `content_pack_created` (BOOLEAN), `tweets_planned` (INTEGER), `replies_planned` (INTEGER), `quotes_planned` (INTEGER), `research_items_reviewed` (INTEGER), `creator_posts_analyzed` (INTEGER), `github_assets_created` (INTEGER), `next_priority` (TEXT), `notes` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `checkin_date` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/daily-runner.ts`, `lib/pipeline-worker.ts`, `app/api/weekly-review/route.ts` |
| **Recommended Action** | Consider adding index on `created_at` for range queries |

#### `model_routing_rules`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `task_type` (TEXT NOT NULL UNIQUE), `model_id` (TEXT NOT NULL), `temperature` (NUMERIC(4,2)), `max_tokens` (INTEGER), `top_p` (NUMERIC(4,2)), `response_format` (TEXT), `description` (TEXT), `active` (BOOLEAN DEFAULT true), `provider` (TEXT DEFAULT 'cloud'), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `task_type` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_RUNTIME |
| **Code References** | `lib/model-router.ts`, `app/api/model-router/route.ts`, `app/api/health/route.ts`, `app/api/db-setup/route.ts` |
| **Recommended Action** | Verify no orphaned model IDs (e.g., `anthropic/claude-sonnet-4` was replaced but may linger); add index on `active` |

---

### 2.2 ACTIVE_MEMORY Tables

#### `compact_operator_rules`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `rule_type` (TEXT NOT NULL), `pattern` (TEXT NOT NULL), `when_to_use` (TEXT), `when_to_avoid` (TEXT), `suggested_fix` (TEXT), `example_bad` (TEXT), `example_better` (TEXT), `source_author` (TEXT), `topic_key` (TEXT), `confidence` (NUMERIC DEFAULT 0.5), `support_count` (INTEGER DEFAULT 1), `last_seen_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | `idx_compact_rules_type_topic`, `idx_compact_rules_source_author`, `idx_compact_rules_confidence`, `idx_compact_rules_last_seen`, `idx_compact_rules_dedup` (UNIQUE on rule_type+pattern+source_author+topic_key) |
| **RLS** | Not enabled (no RLS statement in migration) |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/structured-memory-retrieval.ts`, `lib/structured-memory-compaction.ts` |
| **Recommended Action** | Enable RLS + service role policy; audit for duplicate rules despite dedup index |

#### `source_author_memory`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `source_author` (TEXT UNIQUE NOT NULL), `common_topics` (JSONB), `good_angles` (JSONB), `bad_angles` (JSONB), `freshness_behavior` (JSONB), `typical_failure_reasons` (JSONB), `best_reply_strategy` (TEXT), `best_quote_strategy` (TEXT), `confidence` (NUMERIC DEFAULT 0.5), `support_count` (INTEGER DEFAULT 1), `last_seen_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | `idx_source_author_memory_author` |
| **RLS** | Not enabled |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/structured-memory-retrieval.ts`, `lib/structured-memory-compaction.ts` |
| **Recommended Action** | Enable RLS; check for memory bias toward single authors |

#### `memory_compaction_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `run_id` (UUID), `source` (TEXT NOT NULL), `rules_created` (INTEGER), `rules_updated` (INTEGER), `source_memories_created` (INTEGER), `source_memories_updated` (INTEGER), `input_items` (INTEGER), `status` (TEXT), `error_message` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | `idx_memory_compaction_runs_run_id` |
| **RLS** | Not enabled |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/structured-memory-compaction.ts` |
| **Recommended Action** | Enable RLS; low priority audit table |

#### `x_algorithm_learning_rules`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `rule_type` (TEXT NOT NULL), `rule` (TEXT NOT NULL), `evidence` (TEXT), `source_type` (TEXT), `source_url` (TEXT), `applies_to` (TEXT), `confidence_score` (NUMERIC(4,1) — originally INTEGER, migrated), `status` (TEXT DEFAULT 'active'), `test_run` (BOOLEAN DEFAULT true), `success_count` (INTEGER DEFAULT 0), `failure_count` (INTEGER DEFAULT 0), `last_used_at` (TIMESTAMPTZ), `last_success_at` (TIMESTAMPTZ), `last_failure_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/content-engine-v3.ts`, `lib/brain-query.ts`, `lib/resolve-brain-rules.ts`, `lib/performance-feedback.ts`, `lib/enrich-opportunities-with-rule-performance.ts`, `lib/originality-context.ts`, `lib/account-shield.ts`, `app/api/brain-viewer/route.ts`, `app/api/brain-maintenance/route.ts`, `app/api/rule-performance-report/route.ts`, `app/api/growth-learning-run/route.ts` |
| **Recommended Action** | **CRITICAL**: Add index on `(status, rule_type, confidence_score DESC)` for brain queries; audit for duplicate rules |

#### `viral_style_patterns`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `pattern_type` (TEXT NOT NULL), `pattern_name` (TEXT NOT NULL UNIQUE), `pattern_description` (TEXT), `example_structure` (JSONB), `why_it_works` (TEXT), `risks` (TEXT), `adaptation_for_30piq` (TEXT), `source_handles` (JSONB), `source_tweet_urls` (JSONB), `confidence_score` (NUMERIC(4,1) — originally INTEGER, migrated), `status` (TEXT DEFAULT 'active'), `test_run` (BOOLEAN DEFAULT true), `success_count` (INTEGER DEFAULT 0), `failure_count` (INTEGER DEFAULT 0), `last_used_at` (TIMESTAMPTZ), `last_success_at` (TIMESTAMPTZ), `last_failure_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `pattern_name` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/content-engine-v3.ts`, `lib/brain-query.ts`, `lib/resolve-brain-rules.ts`, `lib/performance-feedback.ts`, `lib/enrich-opportunities-with-rule-performance.ts`, `lib/originality-context.ts`, `app/api/brain-viewer/route.ts`, `app/api/brain-maintenance/route.ts`, `app/api/growth-learning-run/route.ts` |
| **Recommended Action** | Add index on `(status, pattern_type, confidence_score DESC)`; audit for near-duplicate patterns |

#### `viral_tweet_analyses`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `scan_run_id` (UUID FK → viral_scan_runs), `creator_handle` (TEXT), `tweet_id` (TEXT), `tweet_url` (TEXT), `tweet_text` (TEXT), `created_at_x` (TIMESTAMPTZ), `hour_utc` (INTEGER), `weekday_utc` (INTEGER), `username` (TEXT), `text` (TEXT), `tweet_type` (TEXT), `hook_formula` (TEXT), `claim_type` (TEXT), `tone` (TEXT), `format_pattern` (TEXT), `timing_pattern` (TEXT), `audience_pain` (TEXT), `why_replies` (TEXT), `why_quotes` (TEXT), `why_bookmarks` (TEXT), `why_views` (TEXT), `adaptation_for_30piq` (TEXT), `originality_risk` (TEXT), `role_in_sample` (TEXT DEFAULT 'sample'), `engagement_per_1k_followers` (NUMERIC(8,2)), `engagement_score` (NUMERIC(8,2)), `metrics` (JSONB), `analysis` (JSONB), `analysis_payload` (JSONB), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `scan_run_id` → `viral_scan_runs(id)` |
| **Indexes** | UNIQUE on `tweet_id` (`viral_tweet_analyses_tweet_id_key`) |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/content-engine-v3.ts`, `lib/pipeline-worker.ts`, `app/api/learning-cycle/route.ts`, `app/api/learning-health/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/viral-account-scan/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Add index on `(creator_handle, created_at DESC)`; note duplicate column pairs (`username`/`creator_handle`, `text`/`tweet_text`) from v5 migration data copy |

#### `working_memory`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `memory_type` (TEXT NOT NULL), `source_table` (TEXT NOT NULL), `source_id` (TEXT NOT NULL), `content` (JSONB NOT NULL), `confidence_score` (NUMERIC(4,2) DEFAULT 0.5), `access_count` (INTEGER DEFAULT 0), `last_accessed_at` (TIMESTAMPTZ), `expires_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `(memory_type, source_table, source_id)` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/performance-feedback.ts`, `app/api/brain-viewer/route.ts` |
| **Recommended Action** | Add index on `expires_at` for cleanup queries; add index on `memory_type` |

#### `system_learning_rules`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `rule_type` (TEXT NOT NULL), `rule` (TEXT NOT NULL), `evidence` (TEXT), `applies_to` (TEXT), `confidence_score` (NUMERIC(4,2) DEFAULT 7), `status` (TEXT DEFAULT 'active'), `test_run` (BOOLEAN DEFAULT true), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_MEMORY |
| **Code References** | `lib/brain-query.ts`, `lib/performance-feedback.ts`, `lib/originality-context.ts`, `app/api/brain-viewer/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-build-planner/route.ts`, `app/api/repo-artifact-writer/route.ts` |
| **Recommended Action** | Add index on `(status, rule_type, confidence_score DESC)`; note `confidence_score` uses NUMERIC(4,2) vs NUMERIC(4,1) in other brain tables — inconsistency |

---

### 2.3 ACTIVE_TELEGRAM Tables

#### `telegram_bot_state`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `chat_id` (TEXT PK), `user_id` (TEXT), `username` (TEXT), `current_flow` (TEXT), `flow_payload` (JSONB), `last_message` (TEXT), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `chat_id` |
| **Foreign Keys** | None |
| **Indexes** | PK only |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_TELEGRAM |
| **Code References** | `app/api/telegram/webhook/route.ts` |
| **Recommended Action** | Low risk; small table with single user |

#### `content_deliveries`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `content_log_id` (INTEGER), `content_type` (TEXT NOT NULL), `delivery_type` (TEXT DEFAULT 'telegram'), `delivery_status` (TEXT DEFAULT 'pending'), `telegram_message_id` (TEXT), `telegram_chat_id` (TEXT), `delivered_at` (TIMESTAMPTZ), `delivery_payload` (JSONB), `user_action` (TEXT), `published_at` (TIMESTAMPTZ), `performance_scan_id` (UUID), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None enforced (loose reference to `content_log` and `performance_scans`) |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_TELEGRAM |
| **Code References** | `lib/publishing-pipeline.ts`, `lib/media-pipeline.ts` |
| **Recommended Action** | Add index on `delivery_status`; add index on `created_at DESC` |

---

### 2.4 ACTIVE_COST_LOGGING Tables

#### `pipeline_cost_ledger`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs ON DELETE SET NULL), `task_id` (UUID FK → pipeline_tasks ON DELETE SET NULL), `task_type` (TEXT NOT NULL), `provider` (TEXT NOT NULL), `model` (TEXT), `input_tokens` (INT), `output_tokens` (INT), `total_tokens` (INT), `estimated_cost_usd` (NUMERIC(12,8) DEFAULT 0), `status` (TEXT DEFAULT 'pending'), `error` (TEXT), `request_url` (TEXT), `started_at` (TIMESTAMPTZ), `completed_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `run_id` → `pipeline_runs(id)` ON DELETE SET NULL; `task_id` → `pipeline_tasks(id)` ON DELETE SET NULL |
| **Indexes** | `idx_cost_ledger_run_id`, `idx_cost_ledger_task_type`, `idx_cost_ledger_provider`, `idx_cost_ledger_started_at`, `idx_cost_ledger_status`, `idx_cost_ledger_model`, `idx_cost_ledger_run_provider` (composite) |
| **RLS** | **Enabled with NO policies** |
| **Classification** | ACTIVE_COST_LOGGING |
| **Code References** | `lib/cost-ledger.ts`, `scripts/apply-phase2a-migrations.ts` |
| **Recommended Action** | **HIGH**: Add "Service role full access" policy or document intentional policy-less RLS design |

#### `rejection_ledger`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `run_id` (UUID FK → pipeline_runs ON DELETE SET NULL), `task_id` (UUID FK → pipeline_tasks ON DELETE SET NULL), `opportunity_index` (INT NOT NULL), `opportunity_type` (TEXT), `rejection_reason` (TEXT NOT NULL), `shield_reason` (TEXT), `source_url_count` (INT DEFAULT 0), `numeric_claim_flag` (BOOLEAN DEFAULT FALSE), `crafted_text_preview` (TEXT), `crafted_text_hash` (TEXT), `module_origin` (TEXT DEFAULT 'publish_gate'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `run_id` → `pipeline_runs(id)` ON DELETE SET NULL; `task_id` → `pipeline_tasks(id)` ON DELETE SET NULL |
| **Indexes** | `idx_rejection_ledger_run_id`, `idx_rejection_ledger_task_id`, `idx_rejection_ledger_reason`, `idx_rejection_ledger_module_origin`, `idx_rejection_ledger_created_at`, `idx_rejection_ledger_run_reason` (composite) |
| **RLS** | **Enabled with NO policies** |
| **Classification** | ACTIVE_COST_LOGGING |
| **Code References** | `lib/rejection-ledger.ts`, `lib/originality-context.ts` |
| **Recommended Action** | **HIGH**: Add "Service role full access" policy or document intentional design |

#### `session_logs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `ai_tool` (TEXT DEFAULT 'orchestrator'), `session_type` (TEXT DEFAULT 'api_run'), `actions_completed` (JSONB), `decisions_made` (JSONB), `content_created` (JSONB), `db_updates` (JSONB), `github_updates` (JSONB), `pending_tasks` (JSONB), `next_recommendation` (TEXT), `notes` (TEXT), `ended_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_COST_LOGGING |
| **Code References** | `lib/supabase.ts`, `lib/performance-feedback.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/system-cleanup/route.ts` |
| **Recommended Action** | Add index on `created_at DESC` for recent session queries |

---

### 2.5 ACTIVE_SOURCE_POOL Tables

#### `accounts`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `handle` (TEXT NOT NULL UNIQUE), `username` (TEXT), `tier` (INTEGER DEFAULT 2), `active` (BOOLEAN DEFAULT true), `notes` (TEXT), `category` (TEXT — added by alignment migration), `followers` (INTEGER — added by alignment migration), `avg_engagement` (NUMERIC — added by alignment migration), `our_reply_count` (INTEGER DEFAULT 0 — added by alignment migration), `last_reply_date` (TIMESTAMPTZ — added by alignment migration), `last_checked` (TIMESTAMPTZ — added by alignment migration), `discovered_at` (TIMESTAMPTZ), `last_scanned_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `handle` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | ACTIVE_SOURCE_POOL |
| **Code References** | `lib/content-engine-v3.ts`, `lib/pipeline-queue.ts`, `lib/pipeline-worker.ts`, `app/api/learning-cycle/route.ts`, `app/api/learning-health/route.ts`, `app/api/research-intel-run/route.ts`, `app/api/viral-account-scan/route.ts`, `app/api/telegram/webhook/route.ts`, `app/api/db-setup/route.ts` |
| **Recommended Action** | **CRITICAL**: Validate handle format (no emoji, Arabic, punctuation); add index on `(active, tier)` for pool queries |

#### `source_quality_scores`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `source_handle` (TEXT PK), `scans_count` (INT DEFAULT 0), `tweets_analyzed` (INT DEFAULT 0), `raw_opportunities_count` (INT DEFAULT 0), `selected_count` (INT DEFAULT 0), `rescued_count` (INT DEFAULT 0), `judge_passed_count` (INT DEFAULT 0), `publish_gate_accepted_count` (INT DEFAULT 0), `rejection_reason_counts` (JSONB), `avg_publishability_score` (NUMERIC), `avg_originality_potential_score` (NUMERIC), `avg_niche_fit_score` (NUMERIC), `avg_usefulness_score` (NUMERIC), `opportunity_yield_rate` (NUMERIC), `selected_rate` (NUMERIC), `rejection_rate` (NUMERIC), `source_quality_score` (NUMERIC), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `source_handle` |
| **Foreign Keys** | None (logically references `accounts.handle`) |
| **Indexes** | PK only |
| **RLS** | Not mentioned in migrations |
| **Classification** | ACTIVE_SOURCE_POOL |
| **Code References** | `scripts/source-quality-audit.ts` |
| **Recommended Action** | Enable RLS; add FK to `accounts(handle)` or document intentional loose coupling; verify no orphan scores |

---

### 2.6 LEGACY_DO_NOT_TOUCH Tables

#### `sources`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — **no CREATE TABLE migration exists**. Referenced as `sources` in `research-intel-run` and `research-intel-v4` with `select('*')`. Presumed to have `tier`, `handle`, and similar source-tracking columns. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/research-intel-run/route.ts`, `app/api/research-intel-v4/route.ts` |
| **Recommended Action** | **HIGH**: Document schema from live DB; determine if this duplicates `accounts`; migrate references to `accounts` |

#### `content_opportunities`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `learning_cycle_id` (UUID FK → learning_cycles), `opportunity_type` (TEXT DEFAULT 'post'), `topic` (TEXT NOT NULL), `angle` (TEXT), `audience_pain` (TEXT), `source_urls` (JSONB), `viral_pattern_ids` (JSONB), `evidence_notes` (TEXT), `originality_notes` (TEXT), `risk_notes` (TEXT), `confidence_score` (NUMERIC(4,2)), `priority_score` (NUMERIC(4,2)), `selected_format` (TEXT), `format_decision_reason` (TEXT), `depth_score` (NUMERIC(4,2)), `freshness_score` (NUMERIC(4,2)), `visual_score` (NUMERIC(4,2)), `technical_score` (NUMERIC(4,2)), `uniqueness_score` (NUMERIC(4,2)), `status` (TEXT DEFAULT 'candidate'), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `learning_cycle_id` → `learning_cycles(id)` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/format-decision/route.ts`, `app/api/learning-cycle/route.ts`, `app/api/repo-ingest/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Do not modify; data may be referenced by old format_decision rows |

#### `original_content_hypotheses`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `learning_cycle_id` (UUID FK → learning_cycles), `content_opportunity_id` (UUID FK → content_opportunities), `format` (TEXT DEFAULT 'single_tweet'), `hook_formula` (TEXT), `draft_text` (TEXT), `source_urls` (JSONB), `viral_mechanic` (TEXT), `why_original` (TEXT), `why_replyable` (TEXT), `why_bookmarkable` (TEXT), `quality_status` (TEXT), `quality_reasons` (JSONB), `status` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `learning_cycle_id` → `learning_cycles(id)`, `content_opportunity_id` → `content_opportunities(id)` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/learning-cycle/route.ts`, `app/api/production-cycle/route.ts` |
| **Recommended Action** | Do not modify |

#### `raw_research_items`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `learning_cycle_id` (UUID FK → learning_cycles), `query` (TEXT), `title` (TEXT), `url` (TEXT UNIQUE), `snippet` (TEXT), `source_provider` (TEXT), `source_host` (TEXT), `source_quality_score` (INTEGER DEFAULT 5), `freshness_score` (INTEGER DEFAULT 5), `status` (TEXT DEFAULT 'new'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `learning_cycle_id` → `learning_cycles(id)` |
| **Indexes** | UNIQUE on `url` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/learning-cycle/route.ts` |
| **Recommended Action** | Do not modify |

#### `content_log`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `content_type` (TEXT DEFAULT 'single_tweet'), `topic` (TEXT), `hook_text` (TEXT), `final_text` (TEXT), `target_audience` (TEXT), `originality_element` (TEXT), `source_used` (TEXT), `source_urls` (JSONB), `quality_reasons` (JSONB), `content_opportunity_id` (UUID), `publish_status` (TEXT DEFAULT 'draft'), `notes` (JSONB), `tweet_url` (TEXT), `views` (INTEGER), `likes` (INTEGER), `replies` (INTEGER), `reposts` (INTEGER), `bookmarks` (INTEGER), `performance_score` (NUMERIC(6,2)), `published_at` (TIMESTAMPTZ), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` (SERIAL, not UUID!) |
| **Foreign Keys** | None enforced |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `lib/content-type-engine.ts`, `lib/performance-feedback.ts`, `app/api/weekly-review/route.ts`, `app/api/publish-pack/route.ts`, `app/api/format-decision/route.ts`, `app/api/production-cycle/route.ts`, `app/api/research-intel-run/route.ts` |
| **Recommended Action** | Do not modify; heavily referenced but part of old flow |

#### `action_queue`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `priority` (INTEGER DEFAULT 5), `action_type` (TEXT NOT NULL), `title` (TEXT), `instruction` (TEXT), `prepared_content` (JSONB), `status` (TEXT DEFAULT 'pending'), `assigned_to` (TEXT DEFAULT 'human_operator'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` (SERIAL) |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/weekly-review/route.ts` |
| **Recommended Action** | Do not modify; likely has no active writers |

#### `viral_scan_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `creator_handle` (TEXT), `scan_version` (TEXT), `tweets_requested` (INTEGER), `tweets_analyzed` (INTEGER), `data_quality` (TEXT), `tweet_ids_hash` (TEXT), `best_tweet_url` (TEXT), `weakest_tweet_url` (TEXT), `timing_summary` (JSONB), `budget` (JSONB), `raw_summary` (JSONB), `model_used` (TEXT), `reused_cached_result` (BOOLEAN), `handles_scanned` (JSONB), `patterns_found` (INTEGER), `status` (TEXT DEFAULT 'started'), `error` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | Referenced by `viral_tweet_analyses`, `viral_account_patterns` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/viral-account-scan/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Do not modify; still written by viral-account-scan API |

#### `viral_account_patterns`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `scan_run_id` (UUID FK → viral_scan_runs), `creator_handle` (TEXT), `username` (TEXT), `pattern_type` (TEXT), `pattern_name` (TEXT), `rule` (TEXT), `evidence` (TEXT), `confidence_score` (NUMERIC(4,2)), `apply_to_30piq` (TEXT), `avoid_copying_note` (TEXT), `status` (TEXT DEFAULT 'new'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `scan_run_id` → `viral_scan_runs(id)` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/viral-account-scan/route.ts`, `app/api/format-decision/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Do not modify; still written by viral-account-scan API |

#### `content_format_decisions`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `learning_cycle_id` (UUID FK → learning_cycles), `opportunity_id` (UUID FK → content_opportunities), `content_opportunity_id` (UUID FK → content_opportunities), `chosen_format` (TEXT), `selected_format` (TEXT), `format_reason` (TEXT), `reasoning` (TEXT), `depth_score` (NUMERIC(4,2)), `freshness_score` (NUMERIC(4,2)), `visual_score` (NUMERIC(4,2)), `technical_score` (NUMERIC(4,2)), `uniqueness_score` (NUMERIC(4,2)), `source_quality_score` (NUMERIC(4,2)), `viral_fit_score` (NUMERIC(4,2)), `low_follower_risk` (TEXT DEFAULT 'medium'), `expected_primary_signal` (TEXT), `expected_secondary_signal` (TEXT), `production_requirements` (JSONB), `decision_payload` (JSONB), `status` (TEXT DEFAULT 'pending'), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `learning_cycle_id` → `learning_cycles(id)`, `opportunity_id` → `content_opportunities(id)`, `content_opportunity_id` → `content_opportunities(id)` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/format-decision/route.ts`, `app/api/production-cycle/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Do not modify; note duplicate FK columns (`opportunity_id` + `content_opportunity_id`) |

#### `content_production_cards`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `format_decision_id` (UUID FK → content_format_decisions), `content_opportunity_id` (UUID FK → content_opportunities), `production_type` (TEXT), `final_text` (TEXT), `thread_items` (JSONB), `article_outline` (JSONB), `repo_plan` (JSONB), `video_script` (JSONB), `carousel_plan` (JSONB), `source_urls` (JSONB), `viral_mechanic` (TEXT), `original_angle` (TEXT), `audience_pain` (TEXT), `algorithm_basis` (TEXT), `source_basis` (TEXT), `format_basis` (TEXT), `quality_basis` (TEXT), `quality_status` (TEXT), `quality_reasons` (JSONB), `publish_status` (TEXT), `status` (TEXT), `notes` (JSONB), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `format_decision_id` → `content_format_decisions(id)`, `content_opportunity_id` → `content_opportunities(id)` |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/launch-content-repair/route.ts`, `app/api/launch-content-repair-v2/route.ts`, `app/api/launch-content-repair-strict/route.ts`, `app/api/repo-investment-run/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-build-planner/route.ts` |
| **Recommended Action** | Do not modify; still read by several repair/growth routes |

#### `learning_tweet_queue`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `tweet_url` (TEXT NOT NULL), `source` (TEXT DEFAULT 'telegram'), `status` (TEXT DEFAULT 'pending'), `notes` (TEXT), `learning_cycle_id` (UUID), `fetched_data` (JSONB), `error` (TEXT), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/learning-cycle/route.ts`, `app/api/db-setup/route.ts` |
| **Recommended Action** | Do not modify |

#### `learning_cycles`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `cycle_type` (TEXT DEFAULT 'research_viral_fusion'), `status` (TEXT DEFAULT 'started'), `inputs` (JSONB), `summary` (JSONB), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None (referenced by `content_opportunities`, `original_content_hypotheses`, `content_format_decisions`) |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/learning-cycle/route.ts` |
| **Recommended Action** | Do not modify |

#### `behavior_limits`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `account_handle` (TEXT NOT NULL), `stage` (TEXT NOT NULL), `max_original_posts_per_day` (INTEGER DEFAULT 2), `max_replies_per_day` (INTEGER DEFAULT 8), `max_quotes_per_day` (INTEGER DEFAULT 2), `min_minutes_between_actions` (INTEGER DEFAULT 35), `max_same_author_interactions_per_day` (INTEGER DEFAULT 2), `links_allowed` (BOOLEAN DEFAULT false), `hashtags_allowed` (BOOLEAN DEFAULT false), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ), UNIQUE on `(account_handle, stage)` |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | UNIQUE on `(account_handle, stage)` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `app/api/2026-05-27_alignment.sql` (migration only) |
| **Recommended Action** | Do not modify; could be reactivated for stage-aware safety |

#### `performance_scans`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `account_handle` (TEXT NOT NULL), `scanned_tweets` (INTEGER), `high_performers` (INTEGER), `underperformers` (INTEGER), `average_score` (NUMERIC(6,2)), `brain_summary` (TEXT), `learning_updates` (JSONB), `scan_metadata` (JSONB), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | LEGACY_DO_NOT_TOUCH |
| **Code References** | `lib/performance-feedback.ts`, `app/api/weekly-review/route.ts` |
| **Recommended Action** | Do not modify; still written by performance-feedback |

---

### 2.7 EXPERIMENTAL Tables

#### `source_performance`

| Attribute | Detail |
|-----------|--------|
| **Columns** | **No CREATE TABLE migration**. Referenced in `learning-reflection-run/route.ts` with `.upsert()` implying columns like `source_handle`, `performance_data`, etc. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | **HIGH**: Document schema from live DB; determine relationship to `source_quality_scores`; likely duplicate |

#### `quality_failure_patterns`

| Attribute | Detail |
|-----------|--------|
| **Columns** | **No CREATE TABLE migration**. Referenced in `learning-reflection-run/route.ts` with `.upsert()` on `(failure_reason, production_type)`. Implied columns: `failure_reason`, `production_type`, `count`, `examples`, etc. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | **HIGH**: Document schema; add migration file |

#### `prompt_improvement_candidates`

| Attribute | Detail |
|-----------|--------|
| **Columns** | **No CREATE TABLE migration**. Referenced in `learning-reflection-run/route.ts` with `.insert()`. Implied columns: `prompt_type`, `current_prompt`, `suggested_improvement`, etc. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | **HIGH**: Document schema; add migration file |

#### `mcp_opportunity_map`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `opportunity_area` (TEXT NOT NULL), `mcp_use_case` (TEXT NOT NULL), `audience_segment` (TEXT), `pain_point` (TEXT), `content_angles` (JSONB), `repo_or_tool_ideas` (JSONB), `monetization_notes` (TEXT), `proof_required` (JSONB), `priority_score` (NUMERIC(4,2) DEFAULT 7), `confidence_score` (NUMERIC(4,2) DEFAULT 7), `status` (TEXT DEFAULT 'active'), `test_run` (BOOLEAN DEFAULT true), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `lib/brain-query.ts`, `app/api/brain-viewer/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/memory-maintenance-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/launch-content-repair/route.ts` |
| **Recommended Action** | Actively read by brain-query; add index on `(status, priority_score DESC)` |

#### `growth_learning_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `run_type` (TEXT NOT NULL), `mode` (TEXT DEFAULT 'trial'), `summary` (TEXT), `evidence` (JSONB), `status` (TEXT DEFAULT 'completed'), `test_run` (BOOLEAN DEFAULT true), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `lib/learning-memory.ts`, `app/api/growth-learning-run/route.ts`, `app/api/memory-maintenance-run/route.ts`, `app/api/repo-deep-learn/route.ts`, `app/api/repo-deep-learn-excerpt/route.ts` |
| **Recommended Action** | Add index on `created_at DESC`; actively written |

#### `trends`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `topic` (TEXT NOT NULL), `title` (TEXT), `source` (TEXT), `heat_score` (NUMERIC(4,2) DEFAULT 5), `content_type_suggestion` (TEXT), `covered` (BOOLEAN DEFAULT false), `notes` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/viral-account-scan/route.ts`, `app/api/research-intel-run/route.ts`, `app/api/viral-discovery-run/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Add index on `(covered, heat_score DESC)` for trend queries |

#### `creator_intel`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `creator_handle` (TEXT), `post_url` (TEXT), `topic` (TEXT), `hook_pattern` (TEXT), `format_pattern` (TEXT), `why_it_worked` (TEXT), `adaptation_idea` (TEXT), `tweet_url` (TEXT), `content_type` (TEXT), `insight` (TEXT), `status` (TEXT DEFAULT 'new'), `notes` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/viral-account-scan/route.ts`, `app/api/viral-discovery-run/route.ts`, `app/api/research-intel-run/route.ts`, `app/api/health/route.ts` |
| **Recommended Action** | Add index on `creator_handle`; actively written by viral scan routes |

#### `discovered_items`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `item_type` (TEXT NOT NULL), `title` (TEXT), `url` (TEXT), `description` (TEXT), `relevance_score` (NUMERIC(4,2) DEFAULT 5), `status` (TEXT DEFAULT 'new'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/discovery-run/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | Add index on `(status, relevance_score DESC)` |

#### `repo_source_files`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `repo_url` (TEXT NOT NULL), `file_path` (TEXT NOT NULL), `content` (TEXT), `language` (TEXT), `status` (TEXT DEFAULT 'ingested'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/repo-ingest/route.ts`, `app/api/repo-deep-learn/route.ts`, `app/api/repo-deep-learn-excerpt/route.ts`, `app/api/repo-style-learn/route.ts` |
| **Recommended Action** | Note: code uses different column names than migration (`repo_source_id`, `path`, `content_sha`, `content_excerpt`, `file_role`, `analysis_status` vs `repo_url`, `file_path`, `content`, `language`, `status`). Schema drift confirmed. |

#### `repo_extracted_rules`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `repo_url` (TEXT NOT NULL), `rule_type` (TEXT), `rule` (TEXT NOT NULL), `evidence` (TEXT), `confidence_score` (NUMERIC(4,2) DEFAULT 5), `status` (TEXT DEFAULT 'active'), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/repo-ingest/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-build-planner/route.ts`, `app/api/repo-artifact-writer/route.ts` |
| **Recommended Action** | Add index on `(status, confidence_score DESC)` |

#### `requirement_status`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `requirement` (TEXT NOT NULL), `status` (TEXT DEFAULT 'pending'), `priority` (INTEGER DEFAULT 5), `notes` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | `app/api/log-user-action/route.ts` |
| **Recommended Action** | Low priority; rarely written |

#### `target_plans`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (SERIAL PK), `target_type` (TEXT NOT NULL), `description` (TEXT), `active` (BOOLEAN DEFAULT true), `priority` (INTEGER DEFAULT 5), `deadline` (TEXT), `created_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | None |
| **Indexes** | None beyond PK |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL |
| **Code References** | None found in active code |
| **Recommended Action** | Consider archiving; no active code references |

#### `published_decisions`

| Attribute | Detail |
|-----------|--------|
| **Columns** | `id` (UUID PK), `decision_run_id` (UUID FK → decision_runs), `account_handle` (TEXT NOT NULL), `published_url` (TEXT NOT NULL UNIQUE), `published_text` (TEXT), `source_tweet_url` (TEXT), `content_type` (TEXT), `decision_score` (NUMERIC), `brain_rules_used` (JSONB), `status` (TEXT DEFAULT 'published'), `performance_checked_at` (TIMESTAMPTZ), `performance_payload` (JSONB), `outcome_label` (TEXT), `outcome_score` (NUMERIC), `feedback_applied_at` (TIMESTAMPTZ), `feedback_payload` (JSONB), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ) |
| **Primary Key** | `id` |
| **Foreign Keys** | `decision_run_id` → `decision_runs(id)` |
| **Indexes** | UNIQUE on `published_url` |
| **RLS** | Enabled with "Service role full access" policy |
| **Classification** | EXPERIMENTAL (actively used by feedback loop but classification is borderline) |
| **Code References** | `lib/published-decision-logger.ts`, `app/api/performance-feedback/route.ts`, `app/api/learning-health/route.ts`, `app/api/published-performance-scan/route.ts`, `app/api/performance-feedback/attribution-test/route.ts` |
| **Recommended Action** | Promote to ACTIVE_RUNTIME; add index on `(account_handle, created_at DESC)` |

---

### 2.8 UNKNOWN_NEEDS_REVIEW Tables

#### `system_cleanup_registry`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no migration found. Referenced in `system-cleanup/route.ts` with `cleanup_status`, `created_at` columns implied. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/system-cleanup/route.ts` |
| **Recommended Action** | Document schema from live DB; add migration file |

#### `system_cleanup_batches`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no migration found. Referenced in `system-cleanup/route.ts` with `cleanup_type`, `mode`, `status`, `target_scope`, `summary`, `completed_at` columns implied. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/system-cleanup/route.ts` |
| **Recommended Action** | Document schema from live DB; add migration file |

#### `repo_sources`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no CREATE TABLE migration in repo. Referenced extensively in repo routes with columns like `github_full_name`, `status`, `content_potential_score`, `last_ingested_at`. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/repo-ingest/route.ts`, `app/api/repo-deep-learn/route.ts`, `app/api/repo-deep-learn-excerpt/route.ts`, `app/api/repo-style-learn/route.ts`, `app/api/growth-learning-run/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-artifact-writer/route.ts` |
| **Recommended Action** | **HIGH**: Document schema; add migration file; actively used by repo pipeline |

#### `repo_creation_decisions`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no CREATE TABLE migration. Referenced in `repo-ingest/route.ts` and `repo-artifact-writer/route.ts` with `status` column. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/repo-ingest/route.ts`, `app/api/learning-reflection-run/route.ts`, `app/api/repo-artifact-writer/route.ts`, `app/api/repo-build-planner/route.ts` |
| **Recommended Action** | Document schema; add migration file |

#### `discovery_sources`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no CREATE TABLE migration. Referenced in `discovery-run/route.ts` with `active`, `priority`, `last_run_at` columns. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/discovery-run/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | Document schema; add migration file |

#### `discovery_runs`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no CREATE TABLE migration. Referenced in `discovery-run/route.ts` with `run_type`, `status`, `inputs`, `finished_at`, `summary` columns. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/discovery-run/route.ts`, `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | Document schema; add migration file |

#### `system_reflections`

| Attribute | Detail |
|-----------|--------|
| **Columns** | Unknown — no CREATE TABLE migration. Referenced in `learning-reflection-run/route.ts` with implied columns for reflection output. |
| **Primary Key** | Unknown |
| **Foreign Keys** | Unknown |
| **Indexes** | Unknown |
| **RLS** | Unknown |
| **Classification** | UNKNOWN_NEEDS_REVIEW |
| **Code References** | `app/api/learning-reflection-run/route.ts` |
| **Recommended Action** | Document schema; add migration file |

---

## 3. Schema Drift Issues

### 3.1 Tables Without Versioned CREATE TABLE Migrations

Four tables referenced in source code have no corresponding `CREATE TABLE` statement in any migration file within the repository. This means either they were created manually in the Supabase SQL editor (outside version control) or the migration was part of a previous commit that has since been lost or overwritten.

| Table | Referenced By | Risk |
|-------|---------------|------|
| `sources` | `research-intel-run`, `research-intel-v4` | Unknown schema; duplicates `accounts` |
| `source_performance` | `learning-reflection-run` | Duplicates `source_quality_scores` |
| `quality_failure_patterns` | `learning-reflection-run` | No schema control |
| `prompt_improvement_candidates` | `learning-reflection-run` | No schema control |

Additionally, 7 tables in the UNKNOWN_NEEDS_REVIEW category have no migrations: `system_cleanup_registry`, `system_cleanup_batches`, `repo_sources`, `repo_creation_decisions`, `discovery_sources`, `discovery_runs`, `system_reflections`.

### 3.2 Scattered ALTER TABLE Additions

The canonical schema for several tables is spread across multiple files. For example, `accounts` was defined in `supabase-migrations.sql` with 9 columns, then had 6 more columns added via the `2026-05-27_alignment.sql` migration. Similarly, `pipeline_runs` has 7 additional columns added in the `2026-05-29_pipeline_tasks_queue.sql` file. And `viral_tweet_analyses` was redefined from scratch in `supabase-migration-v5.sql` with a completely different column set, then had columns added via ALTER TABLE blocks.

This scattered approach makes it extremely difficult to answer the question "what is the current schema of table X?" without replaying all migrations in order. It also increases the risk of conflicts when multiple developers modify the same table across different migration files.

### 3.3 confidence_score Type Inconsistency

The `confidence_score` column is one of the most widely used columns across brain tables, yet it has three different type declarations depending on the table and migration version:

| Table | Declaration | Migration Source |
|-------|------------|-----------------|
| `x_algorithm_learning_rules` | Originally `INTEGER DEFAULT 7`, migrated to `NUMERIC(4,1)` | `2026-05-28_confidence_numeric.sql` |
| `viral_style_patterns` | Originally `INTEGER DEFAULT 7`, migrated to `NUMERIC(4,1)` | `2026-05-28_confidence_numeric.sql` |
| `working_memory` | `NUMERIC(4,2) DEFAULT 0.5` | `supabase-migrations.sql` |
| `system_learning_rules` | `NUMERIC(4,2) DEFAULT 7` | `supabase-migrations.sql` |
| `content_opportunities` | `NUMERIC(4,2) DEFAULT 5` | `supabase-migrations.sql` |
| `viral_account_patterns` | `NUMERIC(4,2) DEFAULT 5` | `supabase-migrations.sql` |
| `compact_operator_rules` | `NUMERIC DEFAULT 0.5` (no precision) | `2026-05-31_structured_memory_compaction.sql` |
| `source_author_memory` | `NUMERIC DEFAULT 0.5` (no precision) | `2026-05-31_structured_memory_compaction.sql` |

The inconsistency between `NUMERIC(4,1)` (1 decimal place, range -999.9 to 999.9) and `NUMERIC(4,2)` (2 decimal places, range -99.99 to 99.99) means that code expecting to increment by 0.2 (as mentioned in the confidence_numeric migration comment) would silently truncate values in `NUMERIC(4,1)` tables but preserve them in `NUMERIC(4,2)` tables. The bare `NUMERIC` type (no precision) in compact_operator_rules and source_author_memory allows unlimited precision, which is yet another inconsistency.

**Recommended fix**: Standardize all brain table `confidence_score` columns to `NUMERIC(5,2)` with a range of 0.00–10.00 and a consistent DEFAULT.

### 3.4 Duplicate Columns in viral_tweet_analyses

The v5 migration copied data from `username` → `creator_handle` and `text` → `tweet_text`, but both the old and new columns remain in the table. This creates confusion about which column is canonical and wastes storage.

### 3.5 Duplicate FK Columns in content_format_decisions

The table has both `opportunity_id` and `content_opportunity_id` referencing `content_opportunities(id)`. This was likely added during an incremental migration where the column was renamed, but the old column was never dropped.

---

## 4. Data Quality Concerns

Since we cannot query the live database, the following are data quality checks that **SHOULD be run** once read-only DB access is established. Each item represents a potential data integrity issue identified through static code analysis.

### 4.1 Account/Source Data Quality

1. **Invalid X handles in accounts table**: The code upserts handles from Telegram messages and auto-discovery without validation. Handles containing emoji, Arabic characters, or punctuation would be invalid on X. Check: `SELECT handle FROM accounts WHERE handle !~ '^[A-Za-z0-9_]{1,15}$';`

2. **Missing categories in accounts**: The `category` column was added by the alignment migration but existing accounts won't have it set. Check: `SELECT count(*) FROM accounts WHERE category IS NULL;`

3. **Null tier values**: The tier column defaults to 2, but if rows were inserted before the default was added, they may have NULL. Check: `SELECT count(*) FROM accounts WHERE tier IS NULL;`

4. **Duplicate handles across accounts and sources tables**: If both tables track the same handle, data may be inconsistent. Check: `SELECT a.handle FROM accounts a JOIN sources s ON a.handle = s.handle;`

5. **Stale last_checked dates**: Accounts not checked in 7+ days may have stale state. Check: `SELECT handle, last_checked FROM accounts WHERE last_checked < now() - interval '7 days' OR last_checked IS NULL;`

6. **Accounts with zero followers**: May indicate deleted or suspended accounts. Check: `SELECT handle, followers FROM accounts WHERE followers = 0 OR followers IS NULL;`

7. **Sources not used in any pipeline run**: Orphan source entries that were never scanned. Check: `SELECT s.handle FROM accounts s LEFT JOIN pipeline_tasks t ON t.account_handle = s.handle WHERE t.id IS NULL;`

### 4.2 Pipeline Health

8. **Stuck pipeline runs**: Runs in 'running' status for >1 hour. Check: `SELECT id, source, started_at FROM pipeline_runs WHERE status = 'running' AND started_at < now() - interval '1 hour';`

9. **Failed tasks at max attempts**: Tasks that exhausted retries. Check: `SELECT id, task_type, error_message FROM pipeline_tasks WHERE status = 'failed' AND attempts >= max_attempts;`

10. **Orphan tasks without parent run**: Tasks referencing deleted pipeline_runs. Check: `SELECT t.id FROM pipeline_tasks t LEFT JOIN pipeline_runs r ON t.run_id = r.id WHERE r.id IS NULL;`

11. **Tasks stuck in 'running' with stale locks**: Locked tasks where locked_at is >30 minutes old. Check: `SELECT id, task_type, locked_at, locked_by FROM pipeline_tasks WHERE status = 'running' AND locked_at < now() - interval '30 minutes';`

12. **Zero-completed pipeline runs**: Runs where all tasks failed. Check: `SELECT id, total_tasks, completed_tasks, failed_tasks FROM pipeline_runs WHERE total_tasks > 0 AND completed_tasks = 0;`

### 4.3 Quality Diagnostics

13. **Rejection patterns by reason**: Most common rejection reasons. Check: `SELECT rejection_reason, count(*) FROM rejection_ledger GROUP BY rejection_reason ORDER BY count(*) DESC LIMIT 20;`

14. **High-rejection sources**: Sources with >80% rejection rate. Check: `SELECT source_handle, rejection_rate FROM source_quality_scores WHERE rejection_rate > 0.8;`

15. **Zero-publish sources**: Sources that never produce publishable content. Check: `SELECT source_handle FROM source_quality_scores WHERE publish_gate_accepted_count = 0 AND scans_count > 3;`

16. **Numeric claim flag patterns**: Content rejected for numeric claims. Check: `SELECT count(*) FROM rejection_ledger WHERE numeric_claim_flag = true;`

### 4.4 Memory Health

17. **Memory bias toward one author**: Check if compact_operator_rules is dominated by a single source_author. Check: `SELECT source_author, count(*) FROM compact_operator_rules GROUP BY source_author ORDER BY count(*) DESC LIMIT 10;`

18. **Duplicate/near-duplicate rules**: Rules with the same pattern text. Check: `SELECT rule_type, pattern, count(*) FROM compact_operator_rules GROUP BY rule_type, pattern HAVING count(*) > 1;`

19. **Low-confidence rules still active**: Rules with confidence < 0.3 that should be archived. Check: `SELECT count(*) FROM compact_operator_rules WHERE confidence < 0.3 AND status = 'active';`

20. **Expired working memory**: Memory items past their expiration. Check: `SELECT count(*) FROM working_memory WHERE expires_at < now();`

21. **Brain rule confidence drift**: Rules where confidence has been incrementally adjusted many times without reset. Check: `SELECT id, rule, confidence_score, success_count, failure_count FROM x_algorithm_learning_rules WHERE confidence_score > 9.5 OR confidence_score < 3;`

22. **Unused brain rules**: Active rules never used in crafting. Check: `SELECT count(*) FROM x_algorithm_learning_rules WHERE last_used_at IS NULL AND status = 'active';`

### 4.5 Cost Concerns

23. **Cost anomalies**: Runs with abnormally high cost. Check: `SELECT run_id, sum(estimated_cost_usd) as total FROM pipeline_cost_ledger GROUP BY run_id ORDER BY total DESC LIMIT 10;`

24. **Failed API calls still charging**: Costs logged for failed calls. Check: `SELECT count(*), sum(estimated_cost_usd) FROM pipeline_cost_ledger WHERE status = 'failed' AND estimated_cost_usd > 0;`

---

## 5. Recommended SQL Audits

The following SQL blocks are designed to be run directly in the Supabase SQL Editor once read-only access is established. Each query includes comments explaining what it checks and why.

### A. Account/Source Data Quality (10 queries)

```sql
-- A1: Find accounts with invalid X handles
-- X handles must be 1-15 alphanumeric/underscore characters only
-- Invalid handles will fail during scanning and waste API calls
SELECT id, handle, notes, discovered_at
FROM accounts
WHERE handle !~ '^[A-Za-z0-9_]{1,15}$'
ORDER BY discovered_at DESC;

-- A2: Find accounts with missing category
-- The alignment migration added 'category' but existing rows have NULL
-- Missing categories prevent niche-based filtering
SELECT id, handle, tier, category
FROM accounts
WHERE category IS NULL
ORDER BY tier ASC;

-- A3: Find accounts with NULL tier
-- Tier determines scanning priority; NULL causes unexpected behavior
SELECT id, handle, tier
FROM accounts
WHERE tier IS NULL;

-- A4: Find duplicate handles between accounts and sources tables
-- Both tables track X handles but may have conflicting data
SELECT a.handle, a.tier as accounts_tier, a.followers as accounts_followers
FROM accounts a
WHERE EXISTS (SELECT 1 FROM sources s WHERE s.handle = a.handle);

-- A5: Find stale accounts (not checked in 7+ days)
-- Stale accounts produce outdated recommendations
SELECT handle, last_checked, last_scanned_at, tier
FROM accounts
WHERE last_checked < now() - interval '7 days'
   OR last_scanned_at < now() - interval '7 days'
   OR (last_checked IS NULL AND last_scanned_at IS NULL)
ORDER BY tier ASC;

-- A6: Find accounts with zero followers
-- May indicate deleted, suspended, or incorrectly added accounts
SELECT a.handle, a.followers, a.tier
FROM accounts a
WHERE a.followers = 0 OR a.followers IS NULL;

-- A7: Find inactive accounts still in pool
-- Active=false accounts should not be scanned
SELECT handle, tier, active, notes
FROM accounts
WHERE active = false OR active IS NULL;

-- A8: Find source_quality_scores with no matching account
-- Orphan scores indicate accounts that were removed but scores remain
SELECT sqs.source_handle
FROM source_quality_scores sqs
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.handle = sqs.source_handle);

-- A9: Find accounts with no source_quality_scores entry
-- Missing scores mean these sources have never been evaluated
SELECT a.handle, a.tier
FROM accounts a
WHERE a.active = true
  AND NOT EXISTS (SELECT 1 FROM source_quality_scores sqs WHERE sqs.source_handle = a.handle);

-- A10: Find account_state rows with no matching account
-- Orphan state rows waste storage and may confuse queries
SELECT ast.account_handle
FROM account_state ast
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.handle = ast.account_handle);
```

### B. Pipeline Health (10 queries)

```sql
-- B1: Find stuck pipeline runs (running > 1 hour)
-- These runs need manual intervention or cancellation
SELECT id, source, account_handle, started_at,
       now() - started_at as duration,
       current_step
FROM pipeline_runs
WHERE status = 'running'
  AND started_at < now() - interval '1 hour'
ORDER BY started_at ASC;

-- B2: Find failed tasks at max retries
-- These tasks will never recover automatically
SELECT t.id, t.run_id, t.task_type, t.step_order,
       t.attempts, t.max_attempts, t.error_message
FROM pipeline_tasks t
WHERE t.status = 'failed'
  AND t.attempts >= t.max_attempts
ORDER BY t.created_at DESC;

-- B3: Find tasks with stale locks (> 30 minutes)
-- The worker may have crashed without releasing the lock
SELECT t.id, t.task_type, t.locked_at, t.locked_by,
       now() - t.locked_at as lock_duration
FROM pipeline_tasks t
WHERE t.status = 'running'
  AND t.locked_at < now() - interval '30 minutes'
ORDER BY t.locked_at ASC;

-- B4: Find orphan tasks (no matching pipeline_run)
-- These are caused by CASCADE not being applied correctly
SELECT t.id, t.run_id, t.task_type, t.created_at
FROM pipeline_tasks t
LEFT JOIN pipeline_runs r ON t.run_id = r.id
WHERE r.id IS NULL;

-- B5: Pipeline run success rate (last 30 days)
-- Low success rate indicates systemic issues
SELECT
  count(*) as total_runs,
  count(*) FILTER (WHERE status = 'completed') as completed,
  count(*) FILTER (WHERE status = 'failed') as failed,
  count(*) FILTER (WHERE status = 'running') as stuck,
  ROUND(count(*) FILTER (WHERE status = 'completed')::numeric / NULLIF(count(*), 0) * 100, 1) as success_pct
FROM pipeline_runs
WHERE started_at > now() - interval '30 days';

-- B6: Task type failure distribution
-- Shows which pipeline steps fail most often
SELECT task_type,
       count(*) as total,
       count(*) FILTER (WHERE status = 'failed') as failed,
       ROUND(count(*) FILTER (WHERE status = 'failed')::numeric / count(*) * 100, 1) as fail_pct
FROM pipeline_tasks
WHERE created_at > now() - interval '30 days'
GROUP BY task_type
ORDER BY fail_pct DESC;

-- B7: Average task duration by type
-- Long-running tasks may need optimization
SELECT task_type,
       avg(completed_at - started_at) as avg_duration,
       max(completed_at - started_at) as max_duration
FROM pipeline_tasks
WHERE status = 'completed'
  AND started_at > now() - interval '7 days'
GROUP BY task_type
ORDER BY avg_duration DESC;

-- B8: Find runs that completed zero tasks
-- These represent completely failed pipeline runs
SELECT r.id, r.source, r.started_at, r.total_tasks,
       r.completed_tasks, r.failed_tasks, r.error_message
FROM pipeline_runs r
WHERE r.total_tasks > 0
  AND r.completed_tasks = 0
  AND r.status != 'running'
ORDER BY r.started_at DESC
LIMIT 20;

-- B9: Daily pipeline run count (last 14 days)
-- Shows scheduling consistency
SELECT date(started_at) as day,
       count(*) as runs,
       count(*) FILTER (WHERE status = 'completed') as completed
FROM pipeline_runs
WHERE started_at > now() - interval '14 days'
GROUP BY date(started_at)
ORDER BY day DESC;

-- B10: Find runs with cancelled_at set
-- Cancelled runs may indicate operator intervention
SELECT id, source, cancel_reason, started_at, cancelled_at
FROM pipeline_runs
WHERE cancelled_at IS NOT NULL
ORDER BY cancelled_at DESC
LIMIT 20;
```

### C. Quality Diagnostics (10 queries)

```sql
-- C1: Top rejection reasons (last 30 days)
-- Identifies the most common quality gate failures
SELECT rejection_reason, count(*) as cnt,
       ROUND(count(*)::numeric / SUM(count(*)) OVER () * 100, 1) as pct
FROM rejection_ledger
WHERE created_at > now() - interval '30 days'
GROUP BY rejection_reason
ORDER BY cnt DESC;

-- C2: Rejection reasons by module_origin
-- Shows which module rejects most content
SELECT module_origin, rejection_reason, count(*) as cnt
FROM rejection_ledger
WHERE created_at > now() - interval '30 days'
GROUP BY module_origin, rejection_reason
ORDER BY module_origin, cnt DESC;

-- C3: Sources with highest rejection rate
-- These sources consistently produce low-quality opportunities
SELECT source_handle, scans_count, publish_gate_accepted_count,
       rejection_rate, source_quality_score
FROM source_quality_scores
WHERE scans_count > 2
ORDER BY rejection_rate DESC
LIMIT 20;

-- C4: Numeric claim flag frequency
-- Shows how often numeric claims cause rejections
SELECT count(*) as total_rejections,
       count(*) FILTER (WHERE numeric_claim_flag = true) as numeric_claim_rejections,
       ROUND(count(*) FILTER (WHERE numeric_claim_flag = true)::numeric / count(*) * 100, 1) as pct
FROM rejection_ledger
WHERE created_at > now() - interval '30 days';

-- C5: Rejection trend over time (weekly)
-- Increasing rejections may indicate degrading source quality
SELECT date_trunc('week', created_at) as week,
       count(*) as rejections
FROM rejection_ledger
WHERE created_at > now() - interval '90 days'
GROUP BY week
ORDER BY week DESC;

-- C6: Shield-specific rejection reasons
-- Shield checks are the first quality gate
SELECT rejection_reason, count(*)
FROM rejection_ledger
WHERE module_origin = 'shield_check'
  AND created_at > now() - interval '30 days'
GROUP BY rejection_reason
ORDER BY count(*) DESC;

-- C7: Opportunity yield by source
-- How many raw opportunities become published content per source
SELECT source_handle,
       raw_opportunities_count,
       selected_count,
       publish_gate_accepted_count,
       opportunity_yield_rate
FROM source_quality_scores
WHERE scans_count > 0
ORDER BY opportunity_yield_rate DESC;

-- C8: Content type distribution in rejections
-- Shows which content types are rejected most
SELECT opportunity_type, count(*)
FROM rejection_ledger
WHERE created_at > now() - interval '30 days'
GROUP BY opportunity_type
ORDER BY count(*) DESC;

-- C9: Average scores by source
-- Compares source quality across dimensions
SELECT source_handle,
       avg_publishability_score,
       avg_originality_potential_score,
       avg_niche_fit_score,
       avg_usefulness_score
FROM source_quality_scores
WHERE scans_count > 0
ORDER BY avg_publishability_score DESC;

-- C10: Duplicate rejection patterns (same crafted_text_hash)
-- Identifies the same content being rejected multiple times
SELECT crafted_text_hash, count(*) as times_rejected,
       array_agg(DISTINCT rejection_reason) as reasons
FROM rejection_ledger
WHERE crafted_text_hash IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY crafted_text_hash
HAVING count(*) > 1
ORDER BY times_rejected DESC
LIMIT 20;
```

### D. Memory Health (10 queries)

```sql
-- D1: Memory bias — rule count by source_author
-- Heavy bias toward one author limits content diversity
SELECT source_author, count(*) as rule_count,
       ROUND(count(*)::numeric / (SELECT count(*) FROM compact_operator_rules) * 100, 1) as pct
FROM compact_operator_rules
GROUP BY source_author
ORDER BY rule_count DESC
LIMIT 10;

-- D2: Duplicate patterns in compact_operator_rules
-- Despite dedup index, similar patterns may exist with slight wording differences
SELECT rule_type, pattern, count(*)
FROM compact_operator_rules
GROUP BY rule_type, pattern
HAVING count(*) > 1;

-- D3: Low-confidence active rules
-- Rules below 0.3 confidence may be harmful noise
SELECT count(*) as low_confidence_active_rules
FROM compact_operator_rules
WHERE confidence < 0.3;

-- D4: Expired working memory items
-- Should be cleaned up automatically
SELECT memory_type, count(*)
FROM working_memory
WHERE expires_at < now()
GROUP BY memory_type;

-- D5: Never-used brain rules
-- Active rules that have never been applied in crafting
SELECT count(*) as unused_active_rules
FROM x_algorithm_learning_rules
WHERE last_used_at IS NULL AND status = 'active';

-- D6: Brain rule confidence distribution
-- Shows if rules cluster at defaults or have meaningful variance
SELECT
  CASE
    WHEN confidence_score < 3 THEN 'low (<3)'
    WHEN confidence_score < 5 THEN 'medium (3-5)'
    WHEN confidence_score < 7 THEN 'good (5-7)'
    WHEN confidence_score < 9 THEN 'high (7-9)'
    ELSE 'very_high (9+)'
  END as bucket,
  count(*)
FROM x_algorithm_learning_rules
WHERE status = 'active'
GROUP BY bucket
ORDER BY bucket;

-- D7: Success/failure ratio for brain rules
-- Rules with many failures and few successes should be demoted
SELECT id, rule_type, LEFT(rule, 50) as rule_preview,
       confidence_score, success_count, failure_count,
       CASE WHEN success_count + failure_count > 0
            THEN ROUND(success_count::numeric / (success_count + failure_count) * 100, 1)
            ELSE NULL END as success_pct
FROM x_algorithm_learning_rules
WHERE status = 'active'
  AND (success_count + failure_count) > 0
ORDER BY success_pct ASC
LIMIT 20;

-- D8: Viral style pattern freshness
-- Old patterns may no longer be effective
SELECT pattern_type, pattern_name, confidence_score,
       last_used_at, created_at,
       now() - last_used_at as time_since_use
FROM viral_style_patterns
WHERE status = 'active'
ORDER BY last_used_at ASC NULLS FIRST
LIMIT 20;

-- D9: Memory compaction run health
-- Shows if compaction is running successfully
SELECT date(created_at) as day,
       count(*) as runs,
       sum(rules_created) as total_rules_created,
       sum(rules_updated) as total_rules_updated,
       sum(input_items) as total_input_items
FROM memory_compaction_runs
WHERE created_at > now() - interval '14 days'
GROUP BY day
ORDER BY day DESC;

-- D10: System learning rules growth rate
-- Unbounded growth may indicate compaction not working
SELECT date_trunc('week', created_at) as week, count(*) as new_rules
FROM system_learning_rules
GROUP BY week
ORDER BY week DESC
LIMIT 12;
```

### E. Cost Analysis (8 queries)

```sql
-- E1: Total spend by provider (last 30 days)
-- Shows cost distribution across API providers
SELECT provider,
       count(*) as calls,
       sum(estimated_cost_usd) as total_cost,
       avg(estimated_cost_usd) as avg_cost_per_call
FROM pipeline_cost_ledger
WHERE started_at > now() - interval '30 days'
GROUP BY provider
ORDER BY total_cost DESC;

-- E2: Cost by model (last 30 days)
-- Identifies the most expensive models
SELECT model,
       count(*) as calls,
       sum(estimated_cost_usd) as total_cost,
       sum(input_tokens) as total_input_tokens,
       sum(output_tokens) as total_output_tokens
FROM pipeline_cost_ledger
WHERE started_at > now() - interval '30 days'
  AND model IS NOT NULL
GROUP BY model
ORDER BY total_cost DESC;

-- E3: Cost per pipeline run (last 30 days)
-- Identifies unusually expensive runs
SELECT run_id,
       count(*) as calls,
       sum(estimated_cost_usd) as total_cost
FROM pipeline_cost_ledger
WHERE started_at > now() - interval '30 days'
  AND run_id IS NOT NULL
GROUP BY run_id
ORDER BY total_cost DESC
LIMIT 20;

-- E4: Failed API calls with non-zero cost
-- These represent waste — failed calls that still incurred charges
SELECT count(*) as wasted_calls,
       sum(estimated_cost_usd) as wasted_cost
FROM pipeline_cost_ledger
WHERE status = 'failed'
  AND estimated_cost_usd > 0
  AND started_at > now() - interval '30 days';

-- E5: Daily cost trend (last 14 days)
-- Shows whether costs are increasing over time
SELECT date(started_at) as day,
       count(*) as calls,
       sum(estimated_cost_usd) as daily_cost
FROM pipeline_cost_ledger
WHERE started_at > now() - interval '14 days'
GROUP BY day
ORDER BY day DESC;

-- E6: Cost per task type
-- Shows which pipeline steps are most expensive
SELECT task_type,
       count(*) as calls,
       sum(estimated_cost_usd) as total_cost,
       avg(estimated_cost_usd) as avg_cost
FROM pipeline_cost_ledger
WHERE started_at > now() - interval '30 days'
GROUP BY task_type
ORDER BY total_cost DESC;

-- E7: Token usage efficiency
-- Shows average tokens per call by model
SELECT model,
       avg(input_tokens) as avg_input,
       avg(output_tokens) as avg_output,
       avg(estimated_cost_usd) as avg_cost
FROM pipeline_cost_ledger
WHERE model IS NOT NULL
  AND started_at > now() - interval '30 days'
GROUP BY model
ORDER BY avg_cost DESC;

-- E8: Cost per published decision
-- The key efficiency metric: how much does each recommendation cost?
SELECT
  (SELECT COALESCE(sum(estimated_cost_usd), 0)
   FROM pipeline_cost_ledger
   WHERE started_at > now() - interval '30 days') as total_cost_30d,
  (SELECT count(*)
   FROM published_decisions
   WHERE created_at > now() - interval '30 days') as published_count_30d,
  CASE WHEN (SELECT count(*) FROM published_decisions WHERE created_at > now() - interval '30 days') > 0
    THEN ROUND(
      (SELECT COALESCE(sum(estimated_cost_usd), 0) FROM pipeline_cost_ledger WHERE started_at > now() - interval '30 days')
      / (SELECT count(*) FROM published_decisions WHERE created_at > now() - interval '30 days'),
      4)
    ELSE NULL
  END as cost_per_published;
```

### F. Security/Performance (8 queries)

```sql
-- F1: Tables with RLS enabled but no policies
-- These tables block all non-service-role access silently
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    SELECT DISTINCT tablename FROM pg_policies
  ) = false
ORDER BY tablename;

-- More direct check for RLS-enabled tables without policies:
SELECT t.tablename,
       CASE WHEN p.policyname IS NULL THEN 'NO POLICIES' ELSE 'Has policies' END as policy_status
FROM pg_tables t
LEFT JOIN LATERAL (
  SELECT policyname FROM pg_policies WHERE tablename = t.tablename LIMIT 1
) p ON true
WHERE t.schemaname = 'public'
  AND t.rowsecurity = true
ORDER BY t.tablename;

-- F2: Tables without RLS enabled
-- Any table accessible via anon/authenticated role without RLS is a potential data leak
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = false
ORDER BY tablename;

-- F3: Unused indexes (requires pg_stat_user_indexes)
-- Indexes that are never used waste storage and slow writes
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- F4: Table sizes (row count and disk usage)
-- Large tables may need archiving or partitioning
SELECT relname as table_name,
       pg_size_pretty(pg_total_relation_size(relid)) as total_size,
       n_live_tup as row_count
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC;

-- F5: Dead tuples (requires vacuum analysis)
-- High dead tuples indicate need for VACUUM
SELECT relname, n_dead_tup, last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND n_dead_tup > 1000
ORDER BY n_dead_tup DESC;

-- F6: Foreign key constraints without indexes on the referencing column
-- Missing FK indexes cause slow CASCADE operations and JOIN queries
SELECT
  con.conname AS constraint_name,
  conrelid::regclass AS table_name,
  att2.attname AS column_name,
  'NO INDEX ON FK COLUMN' as issue
FROM pg_constraint con
JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
JOIN pg_attribute att2 ON att2.attrelid = con.conrelid AND att2.attnum = con.conkey[1]
WHERE con.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index idx
    WHERE idx.indrelid = con.conrelid
      AND idx.indkey[0] = con.conkey[1]
  )
  AND con.connamespace = 'public'::regnamespace;

-- F7: Policy review — all RLS policies
-- Lists all policies to verify only service role has access
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- F8: Active connections and long-running queries
-- Detects potential connection leaks or stuck queries
SELECT pid, state, usename, application_name,
       now() - query_start as duration,
       LEFT(query, 100) as query_preview
FROM pg_stat_activity
WHERE state != 'idle'
  AND query NOT LIKE '%pg_stat_activity%'
ORDER BY duration DESC
LIMIT 10;
```

---

## 6. Recommended DB Cleanup Plan

### 6.1 Non-Destructive Actions (Safe Now)

These actions can be performed without risk to data integrity or application behavior. They are purely additive or diagnostic.

| # | Action | Table(s) | Risk | Priority |
|---|--------|----------|------|----------|
| 1 | Add missing migration files for 11 unversioned tables | All UNKNOWN_NEEDS_REVIEW + `sources`, `source_performance`, `quality_failure_patterns`, `prompt_improvement_candidates` | Zero risk (documentation only) | **HIGH** |
| 2 | Add "Service role full access" RLS policies to `pipeline_cost_ledger` and `rejection_ledger` | `pipeline_cost_ledger`, `rejection_ledger` | Zero risk (service role bypasses anyway) | **HIGH** |
| 3 | Enable RLS on `compact_operator_rules`, `source_author_memory`, `memory_compaction_runs` | ACTIVE_MEMORY tables | Zero risk (service role bypasses) | **MEDIUM** |
| 4 | Document `sources` table schema from live DB | `sources` | Zero risk (documentation only) | **HIGH** |
| 5 | Add indexes for frequently queried columns (see Section 7) | Various | Near-zero risk (additive only) | **MEDIUM** |
| 6 | Standardize `confidence_score` type to `NUMERIC(5,2)` across all brain tables | All ACTIVE_MEMORY + EXPERIMENTAL | Low risk (wider type, no data loss) | **MEDIUM** |
| 7 | Create a single canonical `schema.sql` that represents the current state of all tables | All | Zero risk (documentation only) | **HIGH** |
| 8 | Add COMMENT ON TABLE for all tables missing descriptions | All | Zero risk (metadata only) | **LOW** |

### 6.2 Actions Requiring Approval

These actions modify data or schema in ways that could affect application behavior. They require explicit approval and should be tested on a staging environment first.

| # | Action | Table(s) | Risk | Priority |
|---|--------|----------|------|----------|
| 9 | Drop `username` and `text` columns from `viral_tweet_analyses` (replaced by `creator_handle` and `tweet_text`) | `viral_tweet_analyses` | Medium (old code may reference them) | **MEDIUM** |
| 10 | Drop `opportunity_id` column from `content_format_decisions` (duplicate of `content_opportunity_id`) | `content_format_decisions` | Low (legacy table) | **LOW** |
| 11 | Migrate `sources` references to `accounts` table | `sources`, `accounts` | Medium (code changes required) | **MEDIUM** |
| 12 | Consolidate `source_performance` into `source_quality_scores` | `source_performance`, `source_quality_scores` | Medium (code changes required) | **MEDIUM** |
| 13 | Promote `published_decisions` from EXPERIMENTAL to ACTIVE_RUNTIME | `published_decisions` | Low (classification only) | **LOW** |
| 14 | Add FK from `source_quality_scores.source_handle` to `accounts.handle` | `source_quality_scores` | Medium (may fail if orphan scores exist) | **MEDIUM** |

### 6.3 Data Archiving Strategy

For legacy tables with growing data that is no longer actively queried:

1. **Archive to `_archived` suffixed tables**: `CREATE TABLE content_log_archived AS SELECT * FROM content_log WHERE created_at < now() - interval '90 days';`
2. **Delete archived data from live tables**: `DELETE FROM content_log WHERE created_at < now() - interval '90 days';`
3. **Set retention policies per table classification**:
   - `pipeline_runs` / `pipeline_tasks`: Keep 90 days, archive older
   - `session_logs`: Keep 30 days, archive older
   - `rejection_ledger`: Keep 90 days, archive older
   - `pipeline_cost_ledger`: Keep 90 days, archive older
   - `viral_tweet_analyses`: Keep 180 days (memory value)
   - `content_log`: Keep 180 days, archive older (legacy)
   - `working_memory`: Auto-delete expired items daily

### 6.4 No Destructive SQL Without Explicit Approval

**The following actions are explicitly FORBIDDEN without written approval:**

- `DROP TABLE` on any table
- `TRUNCATE` on any table
- `DELETE` without a `WHERE` clause
- `ALTER COLUMN TYPE` that could cause data loss (e.g., narrowing `NUMERIC(5,2)` to `NUMERIC(4,1)`)
- Disabling RLS on any table
- Dropping any index that has `idx_scan > 0` in `pg_stat_user_indexes`

---

## 7. Missing Indexes

Based on code analysis of query patterns in TypeScript source files, the following indexes are recommended for frequently queried columns that currently lack indexes. All recommendations are additive (no existing indexes need to be dropped).

```sql
-- 7.1: Brain rule retrieval (used by brain-query.ts, resolve-brain-rules.ts)
-- Currently: full table scan on x_algorithm_learning_rules with status='active' filter
CREATE INDEX IF NOT EXISTS idx_xalgo_rules_status_type_confidence
  ON x_algorithm_learning_rules (status, rule_type, confidence_score DESC)
  WHERE status = 'active';

-- 7.2: Viral style pattern retrieval (used by brain-query.ts, resolve-brain-rules.ts)
-- Currently: full table scan on viral_style_patterns with status='active' filter
CREATE INDEX IF NOT EXISTS idx_vsp_status_type_confidence
  ON viral_style_patterns (status, pattern_type, confidence_score DESC)
  WHERE status = 'active';

-- 7.3: System learning rules retrieval (used by brain-query.ts)
-- Currently: full table scan with status filter
CREATE INDEX IF NOT EXISTS idx_slr_status_type_confidence
  ON system_learning_rules (status, rule_type, confidence_score DESC)
  WHERE status = 'active';

-- 7.4: Account pool queries (used by pipeline-queue.ts, viral-account-scan)
-- Currently: sequential scan for active accounts by tier
CREATE INDEX IF NOT EXISTS idx_accounts_active_tier
  ON accounts (active, tier)
  WHERE active = true;

-- 7.5: Decision run lookups (used by published-decision-logger.ts, learning-health)
-- Currently: sequential scan by account_handle
CREATE INDEX IF NOT EXISTS idx_decision_runs_handle_created
  ON decision_runs (account_handle, created_at DESC);

-- 7.6: Published decisions by account (used by learning-health, performance-feedback)
-- Currently: sequential scan by account_handle
CREATE INDEX IF NOT EXISTS idx_published_decisions_handle_created
  ON published_decisions (account_handle, created_at DESC);

-- 7.7: Account state stale-check (used by account-shield.ts, daily-runner.ts)
-- Currently: PK lookup only, but stale checks filter on last_live_check_at
CREATE INDEX IF NOT EXISTS idx_account_state_last_check
  ON account_state (last_live_check_at DESC);

-- 7.8: Working memory expiration cleanup
-- Currently: no index on expires_at for cleanup queries
CREATE INDEX IF NOT EXISTS idx_working_memory_expires
  ON working_memory (expires_at)
  WHERE expires_at IS NOT NULL;

-- 7.9: Working memory by type (used by brain-viewer.ts)
CREATE INDEX IF NOT EXISTS idx_working_memory_type
  ON working_memory (memory_type);

-- 7.10: Viral tweet analyses by creator (used by content-engine-v3.ts, learning-health)
-- Currently: no index on creator_handle
CREATE INDEX IF NOT EXISTS idx_vta_creator_handle_created
  ON viral_tweet_analyses (creator_handle, created_at DESC);

-- 7.11: Source quality scores by quality (used by source-quality-audit.ts)
CREATE INDEX IF NOT EXISTS idx_sqs_quality_score
  ON source_quality_scores (source_quality_score DESC);

-- 7.12: MCP opportunity map by status (used by brain-query.ts, growth-learning-run)
CREATE INDEX IF NOT EXISTS idx_mcp_status_priority
  ON mcp_opportunity_map (status, priority_score DESC)
  WHERE status = 'active';

-- 7.13: Trends uncovered (used by research-intel-run, viral-discovery-run)
CREATE INDEX IF NOT EXISTS idx_trends_uncovered_heat
  ON trends (covered, heat_score DESC)
  WHERE covered = false;

-- 7.14: Creator intel by handle (used by viral-account-scan, viral-discovery-run)
CREATE INDEX IF NOT EXISTS idx_creator_intel_handle
  ON creator_intel (creator_handle);

-- 7.15: Content log by published date (used by weekly-review, research-intel)
CREATE INDEX IF NOT EXISTS idx_content_log_published
  ON content_log (published_at DESC);

-- 7.16: Daily checkins by date range (used by weekly-review)
-- Already has UNIQUE on checkin_date, but range queries benefit from this
CREATE INDEX IF NOT EXISTS idx_daily_checkins_date
  ON daily_checkins (checkin_date DESC);
```

---

## 8. RLS/Policy Plan

### 8.1 Current RLS Status

| Table | RLS Enabled | Has Policy | Policy Name | Notes |
|-------|:-----------:|:----------:|-------------|-------|
| `pipeline_runs` | ✅ | ✅ | "Service role full access" | Good |
| `pipeline_tasks` | ✅ | ✅ | "Service role full access on pipeline_tasks" | Good |
| `pipeline_cost_ledger` | ✅ | ❌ | — | **NO POLICY — intentional?** |
| `rejection_ledger` | ✅ | ❌ | — | **NO POLICY — intentional?** |
| `accounts` | ✅ | ✅ | "Service role full access" | Good |
| `account_state` | ✅ | ✅ | "Service role full access" | Good |
| `model_routing_rules` | ✅ | ✅ | "Service role full access" | Good |
| `daily_checkins` | ✅ | ✅ | "Service role full access" | Good |
| `decision_runs` | ✅ | ✅ | "Service role full access" | Good |
| `published_decisions` | ✅ | ✅ | "Service role full access" | Good |
| `x_algorithm_learning_rules` | ✅ | ✅ | "Service role full access" | Good |
| `viral_style_patterns` | ✅ | ✅ | "Service role full access" | Good |
| `viral_tweet_analyses` | ✅ | ✅ | "Service role full access" | Good |
| `working_memory` | ✅ | ✅ | "Service role full access" | Good |
| `system_learning_rules` | ✅ | ✅ | "Service role full access" | Good |
| `mcp_opportunity_map` | ✅ | ✅ | "Service role full access" | Good |
| `telegram_bot_state` | ✅ | ✅ | "Service role full access" | Good |
| `content_deliveries` | ✅ | ✅ | "Service role full access" | Good |
| `session_logs` | ✅ | ✅ | "Service role full access" | Good |
| `performance_scans` | ✅ | ✅ | "Service role full access" | Good |
| `content_opportunities` | ✅ | ✅ | "Service role full access" | Good |
| `original_content_hypotheses` | ✅ | ✅ | "Service role full access" | Good |
| `raw_research_items` | ✅ | ✅ | "Service role full access" | Good |
| `content_log` | ✅ | ✅ | "Service role full access" | Good |
| `action_queue` | ✅ | ✅ | "Service role full access" | Good |
| `viral_scan_runs` | ✅ | ✅ | "Service role full access" | Good |
| `viral_account_patterns` | ✅ | ✅ | "Service role full access" | Good |
| `learning_tweet_queue` | ✅ | ✅ | "Service role full access" | Good |
| `learning_cycles` | ✅ | ✅ | "Service role full access" | Good |
| `behavior_limits` | ✅ | ✅ | "Service role full access" | Good |
| `content_format_decisions` | ✅ | ✅ | "Service role full access" | Good |
| `content_production_cards` | ✅ | ✅ | "Service role full access" | Good |
| `trends` | ✅ | ✅ | "Service role full access" | Good |
| `creator_intel` | ✅ | ✅ | "Service role full access" | Good |
| `discovered_items` | ✅ | ✅ | "Service role full access" | Good |
| `repo_source_files` | ✅ | ✅ | "Service role full access" | Good |
| `repo_extracted_rules` | ✅ | ✅ | "Service role full access" | Good |
| `requirement_status` | ✅ | ✅ | "Service role full access" | Good |
| `target_plans` | ✅ | ✅ | "Service role full access" | Good |
| `growth_learning_runs` | ✅ | ✅ | "Service role full access" | Good |
| `compact_operator_rules` | ❌ | — | — | **NO RLS** |
| `source_author_memory` | ❌ | — | — | **NO RLS** |
| `memory_compaction_runs` | ❌ | — | — | **NO RLS** |
| `source_quality_scores` | ❌ | — | — | **NO RLS** |
| `sources` | ? | ? | ? | Unknown — no migration |
| `source_performance` | ? | ? | ? | Unknown — no migration |
| `quality_failure_patterns` | ? | ? | ? | Unknown — no migration |
| `prompt_improvement_candidates` | ? | ? | ? | Unknown — no migration |

### 8.2 Tables with RLS but No Policies

Two tables have RLS enabled but no access policies:

1. **`pipeline_cost_ledger`**: The migration comment states "Service role bypasses RLS, so the PM2 worker and Vercel API routes can read/write freely. No anon or authenticated role should ever access these internal ledger tables directly." This is a reasonable design decision, but it should be explicitly documented. If the `anon` role ever needs read access for a dashboard, a SELECT policy would need to be added.

2. **`rejection_ledger`**: Same design pattern as `pipeline_cost_ledger`. No policies, relying on service role bypass.

**Recommendation**: Either add "Service role full access" policies for consistency with all other tables, or add a comment documenting the intentional policy-less design. Adding the policy is safer because it costs nothing and ensures the table follows the same pattern as every other RLS-enabled table in the system.

```sql
-- Recommended: Add consistent policies for cost and rejection ledgers
CREATE POLICY "Service role full access" ON pipeline_cost_ledger
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON rejection_ledger
  FOR ALL USING (true) WITH CHECK (true);
```

### 8.3 Tables That Should Have RLS but Don't

Three ACTIVE_MEMORY tables and one ACTIVE_SOURCE_POOL table lack RLS entirely:

```sql
-- Enable RLS on active tables currently without it
ALTER TABLE compact_operator_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON compact_operator_rules
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE source_author_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON source_author_memory
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE memory_compaction_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON memory_compaction_runs
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE source_quality_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON source_quality_scores
  FOR ALL USING (true) WITH CHECK (true);
```

### 8.4 Current Security Posture Assessment

The current RLS configuration follows a "defense in breadth" approach: every table has RLS enabled (except 4), and every enabled table has a single "Service role full access" policy that grants `USING (true) WITH CHECK (true)`. This means:

- **Service role** (`SUPABASE_SERVICE_ROLE_KEY`): Full access to all RLS-enabled tables. This is the key used by the pipeline worker and API routes.
- **anon role**: Blocked from all RLS-enabled tables (no policies for anon). This is correct — no public access should exist.
- **authenticated role**: Also blocked from all RLS-enabled tables. If a future dashboard or user-facing feature needs read access, specific SELECT policies would need to be created.

**Risk assessment**: The current posture is **adequate but not granular**. All tables use the same blanket "service role full access" policy. If finer-grained access control is needed (e.g., a read-only dashboard that should see `pipeline_cost_ledger` but not `accounts`), individual policies would need to be crafted per table per role. For now, the blanket approach is appropriate given that all access is via the service role from trusted backend code.

**One concern**: The 4 tables without RLS (`compact_operator_rules`, `source_author_memory`, `memory_compaction_runs`, `source_quality_scores`) are accessible to the `anon` role by default. While the Supabase project likely has the anon key disabled or restricted, this should be verified. Enabling RLS on these tables is a zero-risk hardening step.

---

## Appendix A: Migration File Inventory

| File | Date | Tables Created/Modified |
|------|------|------------------------|
| `supabase-migrations.sql` | Initial | 35 tables (v3 complete schema) |
| `supabase-migration-v5.sql` | Post-v3 | 10 tables (IF NOT EXISTS), column additions, model name fixes |
| `2026-05-27_alignment.sql` | 2026-05-27 | `decision_runs`, `behavior_limits`; ALTER accounts, model_routing_rules |
| `2026-05-27_feedback_loop.sql` | 2026-05-27 | `published_decisions` |
| `2026-05-27_performance_feedback.sql` | 2026-05-27 | ALTER `published_decisions`, `x_algorithm_learning_rules`, `viral_style_patterns` |
| `2026-05-28_confidence_numeric.sql` | 2026-05-28 | ALTER `x_algorithm_learning_rules`, `viral_style_patterns` (confidence → NUMERIC(4,1)) |
| `2026-05-28_pipeline_runs.sql` | 2026-05-28 | `pipeline_runs` |
| `2026-05-29_pipeline_cost_ledger.sql` | 2026-05-29 | `pipeline_cost_ledger` |
| `2026-05-29_pipeline_tasks_queue.sql` | 2026-05-29 | `pipeline_tasks`; ALTER `pipeline_runs` (7 columns) |
| `2026-05-29_rejection_ledger.sql` | 2026-05-29 | `rejection_ledger` |
| `2026-05-30_phase2d1_model_routing.sql` | 2026-05-30 | INSERT into `model_routing_rules` (3 new task types) |
| `2026-05-31_structured_memory_compaction.sql` | 2026-05-31 | `compact_operator_rules`, `source_author_memory`, `memory_compaction_runs` |
| `2026-05-31_source_quality_scores.sql` | 2026-05-31 | `source_quality_scores` |

## Appendix B: Tables Referenced in Code But Not in Migrations

The following tables are referenced in TypeScript source code but have no corresponding `CREATE TABLE` migration in the repository. They were likely created manually or via a lost migration.

| Table | Referenced In | Estimated Columns |
|-------|--------------|-------------------|
| `sources` | `research-intel-run`, `research-intel-v4` | `handle`, `tier`, similar to `accounts` |
| `source_performance` | `learning-reflection-run` | `source_handle`, `performance_data` |
| `quality_failure_patterns` | `learning-reflection-run` | `failure_reason`, `production_type`, `count` |
| `prompt_improvement_candidates` | `learning-reflection-run` | `prompt_type`, `suggested_improvement` |
| `system_cleanup_registry` | `system-cleanup` | `cleanup_status`, `created_at` |
| `system_cleanup_batches` | `system-cleanup` | `cleanup_type`, `mode`, `status`, `summary` |
| `repo_sources` | `repo-ingest`, `repo-deep-learn`, `repo-style-learn`, `growth-learning-run`, `learning-reflection-run`, `repo-artifact-writer` | `github_full_name`, `status`, `content_potential_score`, `last_ingested_at` |
| `repo_creation_decisions` | `repo-ingest`, `learning-reflection-run`, `repo-artifact-writer`, `repo-build-planner` | `status`, `repo_plan` |
| `discovery_sources` | `discovery-run`, `learning-reflection-run` | `active`, `priority`, `last_run_at` |
| `discovery_runs` | `discovery-run`, `learning-reflection-run` | `run_type`, `status`, `inputs`, `summary` |
| `system_reflections` | `learning-reflection-run` | Reflection output columns |
| `repo_build_plans` | Multiple repo API routes | Build plan columns |
| `repo_build_artifacts` | Multiple repo API routes | Artifact columns |
| `repo_artifact_requirements` | `repo-artifact-repair`, `repo-artifact-writer`, `repo-validation-run` | Requirement columns |
| `repo_validation_runs` | `repo-validation-run`, `repo-post-push-validation`, `repo-create-and-push`, `repo-artifact-repair` | Validation run columns |
| `repo_investment_decisions` | `repo-investment-run` | Investment decision columns |
| `owned_repo_projects` | `repo-investment-run`, `repo-create-and-push`, `repo-post-push-validation`, `launch-content-from-repo`, `growth-learning-run` | Owned project columns |
| `github_repos` | `github-create-repo` | GitHub repo columns |
| `repo_style_templates` | `repo-style-learn`, `repo-artifact-writer`, `growth-learning-run` | Style template columns |
| `repo_writer_quality_rules` | `repo-artifact-writer` | Quality rule columns |
| `repo_publication_events` | `launch-content-from-repo` | Publication event columns |
| `verification_events` | `log-user-action` | Verification event columns |
| `weekly_reviews` | `weekly-review` | `week_start`, `followers_end`, etc. |
| `x_timeline_scan_targets` | `growth-learning-run` | Timeline scan target columns |
| `growth_experiment_backlog` | `growth-learning-run` | Experiment backlog columns |
| `x_publication_metrics` | `system-cleanup` (TABLES list) | Publication metric columns |
| `repo_growth_snapshots` | `system-cleanup` (TABLES list) | Growth snapshot columns |

---

*End of DATABASE_AUDIT_REPORT.md. This document should be updated whenever the schema changes or after running the recommended SQL audits against the live database.*
