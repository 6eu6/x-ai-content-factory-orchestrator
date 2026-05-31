-- Phase M1: Structured Memory Compaction Tables
-- Converts raw pipeline history into compact structured memory rules.
-- At runtime, only the most relevant 5-10 memory items are retrieved for crafting, polishing, and judging.

-- ═══ Table 1: compact_operator_rules ═══
-- Deterministic rules extracted from repeated pipeline failures and successes.
-- Each rule captures a pattern, when to use/avoid it, and a suggested fix.

CREATE TABLE IF NOT EXISTS compact_operator_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type TEXT NOT NULL,
  -- Examples: originality_failure, brief_alignment_failure, usefulness_failure,
  --           source_pattern, winning_angle, anti_pattern, freshness_pattern
  pattern TEXT NOT NULL,
  when_to_use TEXT DEFAULT '',
  when_to_avoid TEXT DEFAULT '',
  suggested_fix TEXT DEFAULT '',
  example_bad TEXT DEFAULT '',
  example_better TEXT DEFAULT '',
  source_author TEXT,
  topic_key TEXT,
  confidence NUMERIC DEFAULT 0.5,
  support_count INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for retrieval: rule_type + topic_key + source_author
CREATE INDEX IF NOT EXISTS idx_compact_rules_type_topic
  ON compact_operator_rules (rule_type, topic_key);

CREATE INDEX IF NOT EXISTS idx_compact_rules_source_author
  ON compact_operator_rules (source_author);

CREATE INDEX IF NOT EXISTS idx_compact_rules_confidence
  ON compact_operator_rules (confidence DESC);

CREATE INDEX IF NOT EXISTS idx_compact_rules_last_seen
  ON compact_operator_rules (last_seen_at DESC);

-- Unique constraint for deduplication: same rule_type + pattern + source_author + topic_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_compact_rules_dedup
  ON compact_operator_rules (rule_type, pattern, source_author, topic_key);

-- ═══ Table 2: source_author_memory ═══
-- Per-source-author memory: what works, what fails, freshness behavior.

CREATE TABLE IF NOT EXISTS source_author_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_author TEXT UNIQUE NOT NULL,
  common_topics JSONB DEFAULT '[]',
  good_angles JSONB DEFAULT '[]',
  bad_angles JSONB DEFAULT '[]',
  freshness_behavior JSONB DEFAULT '{}',
  typical_failure_reasons JSONB DEFAULT '{}',
  best_reply_strategy TEXT,
  best_quote_strategy TEXT,
  confidence NUMERIC DEFAULT 0.5,
  support_count INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_author_memory_author
  ON source_author_memory (source_author);

-- ═══ Table 3: memory_compaction_runs ═══
-- Audit log for compaction runs: what was processed, what was created/updated.

CREATE TABLE IF NOT EXISTS memory_compaction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  source TEXT NOT NULL,
  rules_created INTEGER DEFAULT 0,
  rules_updated INTEGER DEFAULT 0,
  source_memories_created INTEGER DEFAULT 0,
  source_memories_updated INTEGER DEFAULT 0,
  input_items INTEGER DEFAULT 0,
  status TEXT DEFAULT 'completed',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_compaction_runs_run_id
  ON memory_compaction_runs (run_id);
