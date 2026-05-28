-- ═══════════════════════════════════════════════════════════════
-- Pipeline Runs — Run tracking table for observability
-- Additive migration only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_step TEXT,
  account_handle TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  error_stack TEXT,
  scan_payload JSONB DEFAULT '{}',
  decision_payload JSONB DEFAULT '{}',
  telegram_payload JSONB DEFAULT '{}',
  debug_log JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_source ON pipeline_runs(source);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at ON pipeline_runs(started_at DESC);

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON pipeline_runs FOR ALL USING (true) WITH CHECK (true);
