-- ═══════════════════════════════════════════════════════════════
-- X AI Content Factory — Database Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

-- 1. Model Routing Rules Table
CREATE TABLE IF NOT EXISTS model_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  temperature NUMERIC(4,2) DEFAULT 0.18,
  max_tokens INTEGER DEFAULT 2000,
  top_p NUMERIC(4,2),
  response_format TEXT DEFAULT 'json_object',
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default routing rules
INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, top_p, response_format, description) VALUES
  ('content_generation', 'openai/gpt-4.1-mini', 0.18, 2000, NULL, 'json_object', 'توليد محتوى يومي — دقة + اتباع قواعد صارمة'),
  ('deep_analysis', 'anthropic/claude-sonnet-4', 0.12, 4000, NULL, 'json_object', 'تحليل عميق — نموذج قوي للتعقيدات'),
  ('research_synthesis', 'openai/gpt-4.1-mini', 0.20, 3000, NULL, 'json_object', 'تركيب بحثي — جمع معلومات من مصادر متعددة'),
  ('quality_evaluation', 'openai/gpt-4.1-mini', 0.05, 1000, NULL, 'json_object', 'تقييم جودة — دقة عالية بدون إبداع'),
  ('media_description', 'openai/gpt-4o', 0.40, 1500, NULL, NULL, 'وصف وسائط — إبداع بصري + دقة تقنية'),
  ('learning_extraction', 'anthropic/claude-sonnet-4', 0.15, 3000, NULL, 'json_object', 'استخراج تعليمي — فهم عميق + استنتاج'),
  ('format_decision', 'openai/gpt-4.1-mini', 0.10, 800, NULL, 'json_object', 'قرار صيغة — منطق + تقييم أبعاد'),
  ('article_writing', 'anthropic/claude-sonnet-4', 0.25, 6000, NULL, NULL, 'كتابة مقالات — محتوى طويل بعمق'),
  ('thread_writing', 'openai/gpt-4.1-mini', 0.20, 4000, NULL, 'json_object', 'كتابة ثريد — تنوع + ارتباط منطقي'),
  ('performance_analysis', 'anthropic/claude-sonnet-4', 0.10, 2000, NULL, 'json_object', 'تحليل أداء — استنتاج + تعلم'),
  ('shield_check', 'openai/gpt-4.1-mini', 0.00, 800, NULL, 'json_object', 'فحص حماية — دقة صارمة'),
  ('repo_artifact', 'anthropic/claude-sonnet-4', 0.15, 4000, NULL, NULL, 'كتابة ملفات مستودع — دقة تقنية'),
  ('casual_generation', 'openai/gpt-4.1-mini', 0.35, 500, NULL, NULL, 'توليد سريع — ردود قصيرة')
ON CONFLICT (task_type) DO UPDATE SET
  model_id = EXCLUDED.model_id,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  top_p = EXCLUDED.top_p,
  response_format = EXCLUDED.response_format,
  description = EXCLUDED.description,
  updated_at = now();

-- 2. Performance Scans Table (for tracking account scan results over time)
CREATE TABLE IF NOT EXISTS performance_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_handle TEXT NOT NULL,
  scanned_tweets INTEGER DEFAULT 0,
  high_performers INTEGER DEFAULT 0,
  underperformers INTEGER DEFAULT 0,
  average_score NUMERIC(6,2),
  brain_summary TEXT,
  learning_updates JSONB DEFAULT '[]',
  scan_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Content Delivery Log (tracks what was delivered to Telegram and when)
CREATE TABLE IF NOT EXISTS content_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_log_id INTEGER,
  content_type TEXT NOT NULL,
  delivery_type TEXT NOT NULL DEFAULT 'telegram',
  delivery_status TEXT DEFAULT 'pending',
  telegram_message_id TEXT,
  telegram_chat_id TEXT,
  delivered_at TIMESTAMPTZ,
  delivery_payload JSONB DEFAULT '{}',
  user_action TEXT,
  published_at TIMESTAMPTZ,
  performance_scan_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Working Memory (high-confidence subset for fast access)
CREATE TABLE IF NOT EXISTS working_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content JSONB NOT NULL,
  confidence_score NUMERIC(4,2) DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(memory_type, source_table, source_id)
);

-- 5. Enable RLS (Row Level Security) — optional but recommended
ALTER TABLE model_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_memory ENABLE ROW LEVEL SECURITY;

-- 6. Allow service role full access (since we use supabaseAdmin)
CREATE POLICY "Service role full access" ON model_routing_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON performance_scans FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON content_deliveries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON working_memory FOR ALL USING (true) WITH CHECK (true);

-- 7. Learning Tweet Queue (tweets manually added for learning via Telegram bot)
CREATE TABLE IF NOT EXISTS learning_tweet_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tweet_url TEXT NOT NULL,
  source TEXT DEFAULT 'telegram',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  learning_cycle_id UUID,
  fetched_data JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add missing columns if table already existed without them
DO $$ BEGIN
  ALTER TABLE learning_tweet_queue ADD COLUMN IF NOT EXISTS learning_cycle_id UUID;
  ALTER TABLE learning_tweet_queue ADD COLUMN IF NOT EXISTS fetched_data JSONB;
  ALTER TABLE learning_tweet_queue ADD COLUMN IF NOT EXISTS error TEXT;
  ALTER TABLE learning_tweet_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE learning_tweet_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON learning_tweet_queue FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 8. Accounts Table (learning accounts — added via Telegram or auto-discovered)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle TEXT NOT NULL UNIQUE,
  username TEXT,
  tier INTEGER DEFAULT 2,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  last_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON accounts FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 9. Learning Cycles Table
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS learning_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_type TEXT NOT NULL DEFAULT 'research_viral_fusion',
  status TEXT NOT NULL DEFAULT 'started',
  inputs JSONB DEFAULT '{}',
  summary JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE learning_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON learning_cycles FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 10. Telegram Bot State (tracks conversation flows per chat)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS telegram_bot_state (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  current_flow TEXT,
  flow_payload JSONB DEFAULT '{}',
  last_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE telegram_bot_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON telegram_bot_state FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 11. Content Opportunities
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_cycle_id UUID REFERENCES learning_cycles(id),
  opportunity_type TEXT NOT NULL DEFAULT 'post',
  topic TEXT NOT NULL,
  angle TEXT,
  audience_pain TEXT,
  source_urls JSONB DEFAULT '[]',
  viral_pattern_ids JSONB DEFAULT '[]',
  evidence_notes TEXT,
  originality_notes TEXT,
  risk_notes TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 5,
  priority_score NUMERIC(4,2) DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_opportunities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_opportunities FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 12. Original Content Hypotheses
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS original_content_hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_cycle_id UUID REFERENCES learning_cycles(id),
  content_opportunity_id UUID REFERENCES content_opportunities(id),
  format TEXT NOT NULL DEFAULT 'single_tweet',
  hook_formula TEXT,
  draft_text TEXT,
  source_urls JSONB DEFAULT '[]',
  viral_mechanic TEXT,
  why_original TEXT,
  why_replyable TEXT,
  why_bookmarkable TEXT,
  quality_status TEXT NOT NULL DEFAULT 'needs_review',
  quality_reasons JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'needs_review',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE original_content_hypotheses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON original_content_hypotheses FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 13. Raw Research Items
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS raw_research_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_cycle_id UUID REFERENCES learning_cycles(id),
  query TEXT,
  title TEXT,
  url TEXT UNIQUE,
  snippet TEXT,
  source_provider TEXT,
  source_host TEXT,
  source_quality_score INTEGER DEFAULT 5,
  freshness_score INTEGER DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE raw_research_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON raw_research_items FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 14. Content Log
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_log (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL DEFAULT 'single_tweet',
  topic TEXT,
  hook_text TEXT,
  final_text TEXT,
  target_audience TEXT,
  originality_element TEXT,
  source_used TEXT,
  publish_status TEXT NOT NULL DEFAULT 'draft',
  notes JSONB DEFAULT '{}',
  tweet_url TEXT,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  bookmarks INTEGER DEFAULT 0,
  performance_score NUMERIC(6,2),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_log FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 15. Session Logs
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS session_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_tool TEXT NOT NULL DEFAULT 'orchestrator',
  session_type TEXT NOT NULL DEFAULT 'api_run',
  actions_completed JSONB DEFAULT '[]',
  decisions_made JSONB DEFAULT '[]',
  content_created JSONB DEFAULT '[]',
  db_updates JSONB DEFAULT '[]',
  github_updates JSONB DEFAULT '[]',
  pending_tasks JSONB DEFAULT '[]',
  next_recommendation TEXT,
  notes TEXT,
  ended_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE session_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON session_logs FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 16. Account State
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS account_state (
  account_handle TEXT PRIMARY KEY,
  x_url TEXT,
  followers_count INTEGER,
  following_count INTEGER,
  posts_count INTEGER,
  bio_text TEXT,
  display_name TEXT,
  profile_image_set BOOLEAN DEFAULT false,
  verified_status TEXT DEFAULT 'unknown',
  last_live_check_at TIMESTAMPTZ,
  last_known_source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE account_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON account_state FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 17. Daily Checkins
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_date TEXT NOT NULL UNIQUE,
  execution_mode TEXT,
  account_checked BOOLEAN DEFAULT false,
  account_check_source TEXT,
  profile_requirements_checked BOOLEAN DEFAULT false,
  daily_targets_checked BOOLEAN DEFAULT false,
  weekly_targets_checked BOOLEAN DEFAULT false,
  content_pack_created BOOLEAN DEFAULT false,
  tweets_planned INTEGER DEFAULT 0,
  replies_planned INTEGER DEFAULT 0,
  quotes_planned INTEGER DEFAULT 0,
  research_items_reviewed INTEGER DEFAULT 0,
  creator_posts_analyzed INTEGER DEFAULT 0,
  github_assets_created INTEGER DEFAULT 0,
  next_priority TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE daily_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON daily_checkins FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 18. Action Queue
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS action_queue (
  id SERIAL PRIMARY KEY,
  priority INTEGER DEFAULT 5,
  action_type TEXT NOT NULL,
  title TEXT,
  instruction TEXT,
  prepared_content JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_to TEXT DEFAULT 'human_operator',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE action_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON action_queue FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 19. Viral Scan Runs
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handles_scanned JSONB DEFAULT '[]',
  tweets_analyzed INTEGER DEFAULT 0,
  patterns_found INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_scan_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_scan_runs FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 20. Viral Tweet Analyses
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_tweet_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tweet_id TEXT,
  tweet_url TEXT,
  username TEXT,
  text TEXT,
  tweet_type TEXT,
  engagement_per_1k_followers NUMERIC(8,2),
  engagement_score NUMERIC(8,2),
  metrics JSONB DEFAULT '{}',
  analysis JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_tweet_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_tweet_analyses FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 21. Viral Account Patterns
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_account_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT,
  pattern_type TEXT,
  pattern_name TEXT,
  rule TEXT,
  evidence JSONB,
  confidence_score NUMERIC(4,2) DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_account_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_account_patterns FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 22. X Algorithm Learning Rules
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS x_algorithm_learning_rules (
  id SERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL,
  rule TEXT NOT NULL,
  evidence TEXT,
  source_type TEXT,
  source_url TEXT,
  applies_to TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  test_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE x_algorithm_learning_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON x_algorithm_learning_rules FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 23. Viral Style Patterns
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_style_patterns (
  id SERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  pattern_name TEXT NOT NULL UNIQUE,
  pattern_description TEXT,
  example_structure JSONB DEFAULT '{}',
  why_it_works TEXT,
  risks TEXT,
  adaptation_for_30piq TEXT,
  source_handles JSONB DEFAULT '[]',
  source_tweet_urls JSONB DEFAULT '[]',
  confidence_score NUMERIC(4,2) DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  test_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_style_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_style_patterns FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 24. MCP Opportunity Map
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mcp_opportunity_map (
  id SERIAL PRIMARY KEY,
  opportunity_area TEXT NOT NULL,
  mcp_use_case TEXT NOT NULL,
  audience_segment TEXT,
  pain_point TEXT,
  content_angles JSONB DEFAULT '[]',
  repo_or_tool_ideas JSONB DEFAULT '[]',
  monetization_notes TEXT,
  proof_required JSONB DEFAULT '[]',
  priority_score NUMERIC(4,2) DEFAULT 7,
  confidence_score NUMERIC(4,2) DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  test_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE mcp_opportunity_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON mcp_opportunity_map FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 25. Growth Learning Runs
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS growth_learning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'trial',
  summary TEXT,
  evidence JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'completed',
  test_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE growth_learning_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON growth_learning_runs FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 26. System Learning Rules
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS system_learning_rules (
  id SERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL,
  rule TEXT NOT NULL,
  evidence TEXT,
  applies_to TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  test_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE system_learning_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON system_learning_rules FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 27. Content Format Decisions
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_format_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID REFERENCES content_opportunities(id),
  chosen_format TEXT NOT NULL,
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_format_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_format_decisions FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 28. Content Production Cards
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_production_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_type TEXT NOT NULL,
  final_text TEXT,
  thread_items JSONB DEFAULT '[]',
  article_outline JSONB DEFAULT '{}',
  repo_plan JSONB DEFAULT '{}',
  video_script JSONB DEFAULT '{}',
  carousel_plan JSONB DEFAULT '{}',
  quality_status TEXT NOT NULL DEFAULT 'needs_review',
  notes JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_production_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_production_cards FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 29. Trends
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  title TEXT,
  source TEXT,
  heat_score NUMERIC(4,2) DEFAULT 5,
  covered BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE trends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON trends FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 30. Creator Intel
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS creator_intel (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT,
  tweet_url TEXT,
  content_type TEXT,
  insight TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE creator_intel ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON creator_intel FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 31. Discovered Items
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS discovered_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type TEXT NOT NULL,
  title TEXT,
  url TEXT,
  description TEXT,
  relevance_score NUMERIC(4,2) DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE discovered_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON discovered_items FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 32. Repo Source Files
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS repo_source_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'ingested',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE repo_source_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON repo_source_files FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 33. Repo Extracted Rules
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS repo_extracted_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT NOT NULL,
  rule_type TEXT,
  rule TEXT NOT NULL,
  evidence TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE repo_extracted_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON repo_extracted_rules FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 34. Requirement Status
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS requirement_status (
  id SERIAL PRIMARY KEY,
  requirement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 5,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE requirement_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON requirement_status FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 35. Target Plans
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS target_plans (
  id SERIAL PRIMARY KEY,
  target_type TEXT NOT NULL,
  description TEXT,
  active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 5,
  deadline TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE target_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON target_plans FOR ALL USING (true) WITH CHECK (true);
