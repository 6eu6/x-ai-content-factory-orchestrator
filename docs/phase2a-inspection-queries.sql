-- ═══════════════════════════════════════════════════════════════
-- Phase 2A: Inspection Queries for Cost Ledger + Rejection Ledger
-- ═══════════════════════════════════════════════════════════════

-- 1. Latest run cost summary
SELECT
  run_id,
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE status = 'completed') as completed_events,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_events,
  SUM(estimated_cost_usd) FILTER (WHERE status = 'completed') as total_cost_usd,
  SUM(input_tokens) FILTER (WHERE status = 'completed') as total_input_tokens,
  SUM(output_tokens) FILTER (WHERE status = 'completed') as total_output_tokens
FROM pipeline_cost_ledger
WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1)
GROUP BY run_id;

-- 2. Cost by provider for latest run
SELECT
  provider,
  COUNT(*) as events,
  SUM(estimated_cost_usd) as cost_usd,
  SUM(input_tokens) as input_tokens,
  SUM(output_tokens) as output_tokens
FROM pipeline_cost_ledger
WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1)
  AND status = 'completed'
GROUP BY provider
ORDER BY cost_usd DESC;

-- 3. Cost by model for latest run
SELECT
  model,
  COUNT(*) as events,
  SUM(estimated_cost_usd) as cost_usd,
  SUM(input_tokens) as input_tokens,
  SUM(output_tokens) as output_tokens
FROM pipeline_cost_ledger
WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1)
  AND status = 'completed'
GROUP BY model
ORDER BY cost_usd DESC;

-- 4. Rejection summary for latest run
SELECT
  rejection_reason,
  COUNT(*) as count,
  COUNT(*) FILTER (WHERE numeric_claim_flag = true) as with_numeric_claims
FROM rejection_ledger
WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1)
GROUP BY rejection_reason
ORDER BY count DESC;

-- 5. Shield reasons breakdown
SELECT
  shield_reason,
  COUNT(*) as count
FROM rejection_ledger
WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1)
  AND shield_reason IS NOT NULL
GROUP BY shield_reason
ORDER BY count DESC;

-- 6. Cumulative experiment cost (all runs)
SELECT
  DATE(started_at) as date,
  COUNT(*) as events,
  SUM(estimated_cost_usd) FILTER (WHERE status = 'completed') as daily_cost_usd,
  SUM(input_tokens) FILTER (WHERE status = 'completed') as daily_input_tokens,
  SUM(output_tokens) FILTER (WHERE status = 'completed') as daily_output_tokens
FROM pipeline_cost_ledger
GROUP BY DATE(started_at)
ORDER BY date DESC;

-- 7. Cost by task type across all runs
SELECT
  task_type,
  COUNT(*) as events,
  SUM(estimated_cost_usd) as total_cost_usd,
  AVG(estimated_cost_usd) as avg_cost_usd
FROM pipeline_cost_ledger
WHERE status = 'completed'
GROUP BY task_type
ORDER BY total_cost_usd DESC;

-- 8. Top rejected text patterns (by hash dedup)
SELECT
  rejection_reason,
  crafted_text_preview,
  COUNT(DISTINCT crafted_text_hash) as unique_texts
FROM rejection_ledger
GROUP BY rejection_reason, crafted_text_preview
ORDER BY unique_texts DESC
LIMIT 20;

-- 9. 30-day experiment cost trend
SELECT
  DATE_TRUNC('week', started_at) as week,
  SUM(estimated_cost_usd) FILTER (WHERE status = 'completed') as weekly_cost_usd,
  COUNT(DISTINCT run_id) as runs
FROM pipeline_cost_ledger
WHERE started_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('week', started_at)
ORDER BY week;

-- 10. Failed cost events (API errors)
SELECT
  provider,
  model,
  error,
  COUNT(*) as count,
  MAX(started_at) as last_failure
FROM pipeline_cost_ledger
WHERE status = 'failed'
GROUP BY provider, model, error
ORDER BY count DESC
LIMIT 20;
