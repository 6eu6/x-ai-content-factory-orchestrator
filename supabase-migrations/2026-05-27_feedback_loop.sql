-- ═══════════════════════════════════════════════════════════════
-- Phase 4: Feedback Loop — published_decisions table
-- Tracks manually published content and its performance
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS published_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_run_id UUID REFERENCES decision_runs(id),
  account_handle TEXT NOT NULL,
  published_url TEXT NOT NULL UNIQUE,
  published_text TEXT,
  source_tweet_url TEXT,
  content_type TEXT,
  decision_score NUMERIC,
  brain_rules_used JSONB DEFAULT '[]',
  status TEXT DEFAULT 'published',
  performance_checked_at TIMESTAMPTZ,
  performance_payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE published_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON published_decisions FOR ALL USING (true) WITH CHECK (true);
