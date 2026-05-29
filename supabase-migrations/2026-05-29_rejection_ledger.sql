-- ═══════════════════════════════════════════════════════════════
-- Rejection Ledger — Publish gate rejection diagnostics
-- Additive migration only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rejection_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  task_id UUID REFERENCES pipeline_tasks(id) ON DELETE SET NULL,
  opportunity_index INT NOT NULL,
  opportunity_type TEXT,                     -- 'original' | 'reply' | 'quote' | 'thread'
  rejection_reason TEXT NOT NULL,            -- e.g. 'shield_not_passed', 'arabic_content_detected'
  shield_reason TEXT,                        -- shield-specific reason if applicable
  source_url_count INT DEFAULT 0,            -- number of source URLs on the opportunity
  numeric_claim_flag BOOLEAN DEFAULT FALSE,  -- whether opportunity contains numeric claims
  crafted_text_preview TEXT,                 -- first 280 chars of crafted_text
  crafted_text_hash TEXT,                    -- SHA-256 hash of full crafted_text for dedup
  module_origin TEXT NOT NULL DEFAULT 'publish_gate',  -- which module rejected it
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_run_id ON rejection_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_task_id ON rejection_ledger(task_id);
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_reason ON rejection_ledger(rejection_reason);
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_module_origin ON rejection_ledger(module_origin);
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_created_at ON rejection_ledger(created_at DESC);

-- Composite index for per-run rejection analysis
CREATE INDEX IF NOT EXISTS idx_rejection_ledger_run_reason
  ON rejection_ledger(run_id, rejection_reason);

-- RLS: Enable with NO policies. Service role bypasses RLS, so the PM2 worker
-- and Vercel API routes can read/write freely. No anon or authenticated role
-- should ever access these internal ledger tables directly.
ALTER TABLE rejection_ledger ENABLE ROW LEVEL SECURITY;

-- Comment for documentation
COMMENT ON TABLE rejection_ledger IS 'Phase 2A: Rejection diagnostics for publish gate — tracks why opportunities are rejected, with preview and hash for pattern analysis';
