-- ═══════════════════════════════════════════════════════════════
-- Phase 5: Performance → Brain Confidence Update
-- Adds outcome columns to published_decisions and success/failure tracking to brain tables
-- ═══════════════════════════════════════════════════════════════

-- published_decisions: add outcome tracking columns
DO $$ BEGIN
  ALTER TABLE published_decisions ADD COLUMN IF NOT EXISTS outcome_label TEXT;
  ALTER TABLE published_decisions ADD COLUMN IF NOT EXISTS outcome_score NUMERIC;
  ALTER TABLE published_decisions ADD COLUMN IF NOT EXISTS feedback_applied_at TIMESTAMPTZ;
  ALTER TABLE published_decisions ADD COLUMN IF NOT EXISTS feedback_payload JSONB DEFAULT '{}';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- x_algorithm_learning_rules: add success/failure tracking
DO $$ BEGIN
  ALTER TABLE x_algorithm_learning_rules ADD COLUMN IF NOT EXISTS success_count INTEGER DEFAULT 0;
  ALTER TABLE x_algorithm_learning_rules ADD COLUMN IF NOT EXISTS failure_count INTEGER DEFAULT 0;
  ALTER TABLE x_algorithm_learning_rules ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
  ALTER TABLE x_algorithm_learning_rules ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
  ALTER TABLE x_algorithm_learning_rules ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- viral_style_patterns: add success/failure tracking
DO $$ BEGIN
  ALTER TABLE viral_style_patterns ADD COLUMN IF NOT EXISTS success_count INTEGER DEFAULT 0;
  ALTER TABLE viral_style_patterns ADD COLUMN IF NOT EXISTS failure_count INTEGER DEFAULT 0;
  ALTER TABLE viral_style_patterns ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
  ALTER TABLE viral_style_patterns ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
  ALTER TABLE viral_style_patterns ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
