-- ═══════════════════════════════════════════════════════════════
-- Pipeline Cost Ledger — Durable cost tracking for 30-day @30piq experiment
-- Additive migration only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_cost_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  task_id UUID REFERENCES pipeline_tasks(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL,
  provider TEXT NOT NULL,           -- 'twitterapi_io' | 'openrouter' | 'openai' | 'local'
  model TEXT,                       -- e.g. 'deepseek/deepseek-chat-v3-0324', null for TwitterAPI
  input_tokens INT,                 -- null for non-AI providers
  output_tokens INT,                -- null for non-AI providers
  total_tokens INT,                 -- null for non-AI providers
  estimated_cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed'
  error TEXT,
  request_url TEXT,                 -- the endpoint called
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_cost_ledger_run_id ON pipeline_cost_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_task_type ON pipeline_cost_ledger(task_type);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_provider ON pipeline_cost_ledger(provider);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_started_at ON pipeline_cost_ledger(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_status ON pipeline_cost_ledger(status);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_model ON pipeline_cost_ledger(model);

-- Composite index for per-run cost aggregation
CREATE INDEX IF NOT EXISTS idx_cost_ledger_run_provider
  ON pipeline_cost_ledger(run_id, provider);

-- RLS: Enable with NO policies. Service role bypasses RLS, so the PM2 worker
-- and Vercel API routes can read/write freely. No anon or authenticated role
-- should ever access these internal ledger tables directly.
ALTER TABLE pipeline_cost_ledger ENABLE ROW LEVEL SECURITY;

-- Comment for documentation
COMMENT ON TABLE pipeline_cost_ledger IS 'Phase 2A: Durable cost ledger for tracking per-run, per-task, per-provider costs during the 30-day @30piq experiment';
