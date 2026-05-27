-- Alignment migration for decision-gated content runs
-- Run in Supabase SQL Editor after the main supabase-migrations.sql file.

-- Model router: support cloud/local routing used by lib/model-router.ts
ALTER TABLE model_routing_rules
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'cloud';

-- Accounts: align current Telegram/content-engine code with database schema.
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS category TEXT,
ADD COLUMN IF NOT EXISTS followers INTEGER,
ADD COLUMN IF NOT EXISTS avg_engagement NUMERIC,
ADD COLUMN IF NOT EXISTS our_reply_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_reply_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_checked TIMESTAMPTZ;

-- Decision audit: optional storage for final Telegram decisions.
CREATE TABLE IF NOT EXISTS decision_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_handle TEXT NOT NULL,
  account_stage TEXT NOT NULL,
  raw_opportunities INTEGER DEFAULT 0,
  selected_count INTEGER DEFAULT 0,
  held_count INTEGER DEFAULT 0,
  budget JSONB DEFAULT '{}',
  selected_payload JSONB DEFAULT '[]',
  held_summary JSONB DEFAULT '[]',
  run_source TEXT DEFAULT 'daily_run',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE decision_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON decision_runs FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Behavior limits: stage-aware safety budget for future runs.
CREATE TABLE IF NOT EXISTS behavior_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_handle TEXT NOT NULL,
  stage TEXT NOT NULL,
  max_original_posts_per_day INTEGER DEFAULT 2,
  max_replies_per_day INTEGER DEFAULT 8,
  max_quotes_per_day INTEGER DEFAULT 2,
  min_minutes_between_actions INTEGER DEFAULT 35,
  max_same_author_interactions_per_day INTEGER DEFAULT 2,
  links_allowed BOOLEAN DEFAULT false,
  hashtags_allowed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_handle, stage)
);

ALTER TABLE behavior_limits ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON behavior_limits FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
