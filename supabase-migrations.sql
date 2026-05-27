-- ═══════════════════════════════════════════════════════════════
-- X AI Content Factory — Database Migration (Complete v3)
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

-- Seed default routing rules — نماذج صالحة على OpenRouter
INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, top_p, response_format, description) VALUES
  ('content_generation', 'deepseek/deepseek-chat-v3-0324', 0.18, 2000, NULL, 'json_object', 'توليد محتوى يومي — دقة + اتباع قواعد صارمة'),
  ('content_crafting', 'deepseek/deepseek-chat-v3-0324', 0.20, 2500, NULL, NULL, 'تصنيع محتوى مخصص — اقتباسات، ردود، ثريدات'),
  ('deep_analysis', 'meta-llama/llama-4-maverick', 0.12, 4000, NULL, 'json_object', 'تحليل عميق — نموذج قوي للتعقيدات'),
  ('research_synthesis', 'deepseek/deepseek-chat-v3-0324', 0.20, 3000, NULL, 'json_object', 'تركيب بحثي — جمع معلومات من مصادر متعددة'),
  ('quality_evaluation', 'mistralai/mistral-small-3.1-24b-instruct', 0.05, 1000, NULL, 'json_object', 'تقييم جودة — دقة عالية بدون إبداع'),
  ('media_description', 'deepseek/deepseek-chat-v3-0324', 0.40, 1500, NULL, NULL, 'وصف وسائط — إبداع بصري + دقة تقنية'),
  ('learning_extraction', 'meta-llama/llama-4-maverick', 0.15, 3000, NULL, 'json_object', 'استخراج تعليمي — فهم عميق + استنتاج'),
  ('format_decision', 'mistralai/mistral-small-3.1-24b-instruct', 0.10, 800, NULL, 'json_object', 'قرار صيغة — منطق + تقييم أبعاد'),
  ('article_writing', 'meta-llama/llama-4-maverick', 0.25, 6000, NULL, NULL, 'كتابة مقالات — محتوى طويل بعمق'),
  ('thread_writing', 'deepseek/deepseek-chat-v3-0324', 0.20, 4000, NULL, NULL, 'كتابة ثريد — تنوع + ارتباط منطقي'),
  ('performance_analysis', 'meta-llama/llama-4-maverick', 0.10, 2000, NULL, 'json_object', 'تحليل أداء — استنتاج + تعلم'),
  ('shield_check', 'mistralai/mistral-small-3.1-24b-instruct', 0.00, 800, NULL, 'json_object', 'فحص حماية — دقة صارمة'),
  ('repo_artifact', 'meta-llama/llama-4-maverick', 0.15, 4000, NULL, NULL, 'كتابة ملفات مستودع — دقة تقنية'),
  ('casual_generation', 'mistralai/mistral-small-3.1-24b-instruct', 0.35, 500, NULL, NULL, 'توليد سريع — ردود قصيرة')
ON CONFLICT (task_type) DO UPDATE SET
  model_id = EXCLUDED.model_id,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  top_p = EXCLUDED.top_p,
  response_format = EXCLUDED.response_format,
  description = EXCLUDED.description,
  updated_at = now();

-- 2. Performance Scans Table
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

-- 3. Content Delivery Log
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

-- 4. Working Memory
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

-- 5. Enable RLS
ALTER TABLE model_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_memory ENABLE ROW LEVEL SECURITY;

-- 6. Allow service role full access
CREATE POLICY "Service role full access" ON model_routing_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON performance_scans FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON content_deliveries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON working_memory FOR ALL USING (true) WITH CHECK (true);

-- 7. Learning Tweet Queue
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

ALTER TABLE learning_tweet_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON learning_tweet_queue FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 8. Accounts Table
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
-- 10. Telegram Bot State
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
-- 11. Content Opportunities (ENHANCED v3 — matches format-decision code)
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
  selected_format TEXT,
  format_decision_reason TEXT,
  depth_score NUMERIC(4,2),
  freshness_score NUMERIC(4,2),
  visual_score NUMERIC(4,2),
  technical_score NUMERIC(4,2),
  uniqueness_score NUMERIC(4,2),
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
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
-- 14. Content Log (ENHANCED v3 — matches production-cycle code)
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
  source_urls JSONB DEFAULT '[]',
  quality_reasons JSONB DEFAULT '[]',
  content_opportunity_id UUID,
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
-- 19. Viral Scan Runs (ENHANCED — matches viral-account-scan code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_handle TEXT,
  scan_version TEXT,
  tweets_requested INTEGER DEFAULT 0,
  tweets_analyzed INTEGER DEFAULT 0,
  data_quality TEXT,
  tweet_ids_hash TEXT,
  best_tweet_url TEXT,
  weakest_tweet_url TEXT,
  timing_summary JSONB DEFAULT '{}',
  budget JSONB DEFAULT '{}',
  raw_summary JSONB DEFAULT '{}',
  model_used TEXT,
  reused_cached_result BOOLEAN DEFAULT false,
  handles_scanned JSONB DEFAULT '[]',
  patterns_found INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_scan_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_scan_runs FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 20. Viral Tweet Analyses (ENHANCED — matches viral-account-scan code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_tweet_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id UUID REFERENCES viral_scan_runs(id),
  creator_handle TEXT,
  tweet_id TEXT,
  tweet_url TEXT,
  tweet_text TEXT,
  created_at_x TIMESTAMPTZ,
  hour_utc INTEGER,
  weekday_utc INTEGER,
  username TEXT,
  text TEXT,
  tweet_type TEXT,
  hook_formula TEXT,
  claim_type TEXT,
  tone TEXT,
  format_pattern TEXT,
  timing_pattern TEXT,
  audience_pain TEXT,
  why_replies TEXT,
  why_quotes TEXT,
  why_bookmarks TEXT,
  why_views TEXT,
  adaptation_for_30piq TEXT,
  originality_risk TEXT,
  role_in_sample TEXT DEFAULT 'sample',
  engagement_per_1k_followers NUMERIC(8,2),
  engagement_score NUMERIC(8,2),
  metrics JSONB DEFAULT '{}',
  analysis JSONB DEFAULT '{}',
  analysis_payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE viral_tweet_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON viral_tweet_analyses FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 21. Viral Account Patterns (ENHANCED — matches viral-account-scan code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS viral_account_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id UUID REFERENCES viral_scan_runs(id),
  creator_handle TEXT,
  username TEXT,
  pattern_type TEXT,
  pattern_name TEXT,
  rule TEXT,
  evidence TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 5,
  apply_to_30piq TEXT,
  avoid_copying_note TEXT,
  status TEXT NOT NULL DEFAULT 'new',
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
-- 27. Content Format Decisions (ENHANCED v3 — matches format-decision code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_format_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_cycle_id UUID REFERENCES learning_cycles(id),
  opportunity_id UUID REFERENCES content_opportunities(id),
  content_opportunity_id UUID REFERENCES content_opportunities(id),
  chosen_format TEXT NOT NULL,
  selected_format TEXT,
  format_reason TEXT,
  reasoning TEXT,
  depth_score NUMERIC(4,2),
  freshness_score NUMERIC(4,2),
  visual_score NUMERIC(4,2),
  technical_score NUMERIC(4,2),
  uniqueness_score NUMERIC(4,2),
  source_quality_score NUMERIC(4,2),
  viral_fit_score NUMERIC(4,2),
  low_follower_risk TEXT DEFAULT 'medium',
  expected_primary_signal TEXT,
  expected_secondary_signal TEXT,
  production_requirements JSONB DEFAULT '{}',
  decision_payload JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_format_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_format_decisions FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 28. Content Production Cards (ENHANCED v3 — matches production-cycle code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_production_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  format_decision_id UUID REFERENCES content_format_decisions(id),
  content_opportunity_id UUID REFERENCES content_opportunities(id),
  production_type TEXT NOT NULL,
  final_text TEXT,
  thread_items JSONB DEFAULT '[]',
  article_outline JSONB DEFAULT '{}',
  repo_plan JSONB DEFAULT '{}',
  video_script JSONB DEFAULT '{}',
  carousel_plan JSONB DEFAULT '{}',
  source_urls JSONB DEFAULT '[]',
  viral_mechanic TEXT,
  original_angle TEXT,
  audience_pain TEXT,
  algorithm_basis TEXT,
  source_basis TEXT,
  format_basis TEXT,
  quality_basis TEXT,
  quality_status TEXT NOT NULL DEFAULT 'needs_review',
  quality_reasons JSONB DEFAULT '[]',
  publish_status TEXT DEFAULT 'needs_review',
  status TEXT DEFAULT 'needs_review',
  notes JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_production_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON content_production_cards FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 29. Trends (ENHANCED — content_type_suggestion column)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  title TEXT,
  source TEXT,
  heat_score NUMERIC(4,2) DEFAULT 5,
  content_type_suggestion TEXT,
  covered BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE trends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON trends FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- 30. Creator Intel (ENHANCED — matches code columns)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS creator_intel (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_handle TEXT,
  post_url TEXT,
  topic TEXT,
  hook_pattern TEXT,
  format_pattern TEXT,
  why_it_worked TEXT,
  adaptation_idea TEXT,
  tweet_url TEXT,
  content_type TEXT,
  insight TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
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

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION FIXES: Add missing columns to existing tables
-- ═══════════════════════════════════════════════════════════════

-- viral_scan_runs: add columns used by viral-account-scan code
DO $$ BEGIN
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS creator_handle TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS scan_version TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS tweets_requested INTEGER DEFAULT 0;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS data_quality TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS tweet_ids_hash TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS best_tweet_url TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS weakest_tweet_url TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS timing_summary JSONB DEFAULT '{}';
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS budget JSONB DEFAULT '{}';
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS raw_summary JSONB DEFAULT '{}';
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS model_used TEXT;
  ALTER TABLE viral_scan_runs ADD COLUMN IF NOT EXISTS reused_cached_result BOOLEAN DEFAULT false;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- viral_tweet_analyses: add columns used by viral-account-scan code
DO $$ BEGIN
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS scan_run_id UUID REFERENCES viral_scan_runs(id);
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS creator_handle TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS tweet_text TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS created_at_x TIMESTAMPTZ;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS hour_utc INTEGER;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS weekday_utc INTEGER;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS hook_formula TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS claim_type TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS tone TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS format_pattern TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS timing_pattern TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS audience_pain TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS why_replies TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS why_quotes TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS why_bookmarks TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS why_views TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS adaptation_for_30piq TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS originality_risk TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS role_in_sample TEXT DEFAULT 'sample';
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS analysis_payload JSONB DEFAULT '{}';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- viral_account_patterns: add columns used by viral-account-scan code
DO $$ BEGIN
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS scan_run_id UUID REFERENCES viral_scan_runs(id);
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS creator_handle TEXT;
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS evidence TEXT;
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS apply_to_30piq TEXT;
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS avoid_copying_note TEXT;
  ALTER TABLE viral_account_patterns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- creator_intel: add columns used by viral-account-scan code
DO $$ BEGIN
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS creator_handle TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS post_url TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS topic TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS hook_pattern TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS format_pattern TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS why_it_worked TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS adaptation_idea TEXT;
  ALTER TABLE creator_intel ADD COLUMN IF NOT EXISTS notes TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- trends: add content_type_suggestion
DO $$ BEGIN
  ALTER TABLE trends ADD COLUMN IF NOT EXISTS content_type_suggestion TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- accounts: ensure all columns exist
DO $$ BEGIN
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v4: Fix invalid model names in model_routing_rules
-- الأسماء القديمة كانت تسبب خطأ 400 من OpenRouter
-- ═══════════════════════════════════════════════════════════════

-- تحديث أسماء النماذج غير الصالحة
UPDATE model_routing_rules SET model_id = 'deepseek/deepseek-chat-v3-0324', updated_at = now() WHERE model_id IN ('openai/gpt-4.1-mini', 'openai/gpt-4.1');
UPDATE model_routing_rules SET model_id = 'meta-llama/llama-4-maverick', updated_at = now() WHERE model_id = 'anthropic/claude-sonnet-4';
UPDATE model_routing_rules SET model_id = 'deepseek/deepseek-chat-v3-0324', updated_at = now() WHERE model_id = 'openai/gpt-4o';

-- إضافة content_crafting لو ما موجود
INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, response_format, description, active)
VALUES ('content_crafting', 'deepseek/deepseek-chat-v3-0324', 0.20, 2500, NULL, 'تصنيع محتوى مخصص', true)
ON CONFLICT (task_type) DO UPDATE SET model_id = EXCLUDED.model_id, temperature = EXCLUDED.temperature, max_tokens = EXCLUDED.max_tokens, updated_at = now();

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v3: Add missing columns for production-cycle & format-decision
-- ═══════════════════════════════════════════════════════════════

-- content_opportunities: add columns used by format-decision code
DO $$ BEGIN
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS selected_format TEXT;
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS format_decision_reason TEXT;
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS depth_score NUMERIC(4,2);
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS freshness_score NUMERIC(4,2);
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS visual_score NUMERIC(4,2);
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS technical_score NUMERIC(4,2);
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS uniqueness_score NUMERIC(4,2);
  ALTER TABLE content_opportunities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- content_log: add columns used by production-cycle code
DO $$ BEGIN
  ALTER TABLE content_log ADD COLUMN IF NOT EXISTS source_urls JSONB DEFAULT '[]';
  ALTER TABLE content_log ADD COLUMN IF NOT EXISTS quality_reasons JSONB DEFAULT '[]';
  ALTER TABLE content_log ADD COLUMN IF NOT EXISTS content_opportunity_id UUID;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- content_format_decisions: add columns used by format-decision code
DO $$ BEGIN
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS learning_cycle_id UUID REFERENCES learning_cycles(id);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS content_opportunity_id UUID REFERENCES content_opportunities(id);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS selected_format TEXT;
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS format_reason TEXT;
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS depth_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS freshness_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS visual_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS technical_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS uniqueness_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS source_quality_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS viral_fit_score NUMERIC(4,2);
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS low_follower_risk TEXT DEFAULT 'medium';
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS expected_primary_signal TEXT;
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS expected_secondary_signal TEXT;
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS production_requirements JSONB DEFAULT '{}';
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS decision_payload JSONB DEFAULT '{}';
  ALTER TABLE content_format_decisions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- content_production_cards: add columns used by production-cycle code
DO $$ BEGIN
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS format_decision_id UUID REFERENCES content_format_decisions(id);
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS content_opportunity_id UUID REFERENCES content_opportunities(id);
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS source_urls JSONB DEFAULT '[]';
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS viral_mechanic TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS original_angle TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS audience_pain TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS algorithm_basis TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS source_basis TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS format_basis TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS quality_basis TEXT;
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS quality_reasons JSONB DEFAULT '[]';
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS publish_status TEXT DEFAULT 'needs_review';
  ALTER TABLE content_production_cards ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'needs_review';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v5: Alignment for decision-gated content runs
-- (Same as supabase-migrations/2026-05-27_alignment.sql)
-- ═══════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v6: Add scan_account_limit and scan_tweets_per_account to decision_runs
-- ═══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE decision_runs ADD COLUMN IF NOT EXISTS scan_account_limit INTEGER;
  ALTER TABLE decision_runs ADD COLUMN IF NOT EXISTS scan_tweets_per_account INTEGER;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

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

-- ═══════════════════════════════════════════════════════════════
-- Phase 5.1: Change confidence_score from INTEGER to NUMERIC(4,1)
-- Allows +0.2 increments for attribution feedback
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE x_algorithm_learning_rules
  ALTER COLUMN confidence_score TYPE NUMERIC(4,1) USING confidence_score::NUMERIC(4,1);

ALTER TABLE viral_style_patterns
  ALTER COLUMN confidence_score TYPE NUMERIC(4,1) USING confidence_score::NUMERIC(4,1);
