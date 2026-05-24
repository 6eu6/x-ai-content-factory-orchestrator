-- ═══════════════════════════════════════════════════════════════
-- X AI Content Factory — Migration v5 (إصلاح شامل)
-- يُشغّل في Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ═══ 1. التأكد من وجود كل الجداول ═══

-- accounts
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

-- model_routing_rules
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

-- viral_tweet_analyses
CREATE TABLE IF NOT EXISTS viral_tweet_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id UUID,
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

-- viral_style_patterns
CREATE TABLE IF NOT EXISTS viral_style_patterns (
  id SERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL DEFAULT 'structure',
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

-- x_algorithm_learning_rules
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

-- working_memory
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

-- telegram_bot_state
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

-- mcp_opportunity_map
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

-- system_learning_rules
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

-- content_opportunities
CREATE TABLE IF NOT EXISTS content_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_cycle_id UUID,
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

-- ═══ 2. إضافة أعمدة مفقودة ═══

DO $$ BEGIN
  -- accounts: last_scanned_at
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

  -- viral_tweet_analyses: الأعمدة الجديدة
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS creator_handle TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS tweet_text TEXT;
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS scan_run_id UUID;
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
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS engagement_score NUMERIC(8,2);
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS engagement_per_1k_followers NUMERIC(8,2);
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{}';
  ALTER TABLE viral_tweet_analyses ADD COLUMN IF NOT EXISTS analysis JSONB DEFAULT '{}';

EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══ 3. نقل البيانات من الأعمدة القديمة للجديدة ═══

-- نسخ username → creator_handle (فقط لو creator_handle فارغ)
UPDATE viral_tweet_analyses
SET creator_handle = username
WHERE creator_handle IS NULL AND username IS NOT NULL;

-- نسخ text → tweet_text (فقط لو tweet_text فارغ)
UPDATE viral_tweet_analyses
SET tweet_text = text
WHERE tweet_text IS NULL AND text IS NOT NULL;

-- ═══ 4. إصلاح أسماء النماذج غير الصالحة في model_routing_rules ═══

UPDATE model_routing_rules
SET model_id = 'deepseek/deepseek-chat-v3-0324', updated_at = now()
WHERE model_id IN ('openai/gpt-4.1-mini', 'openai/gpt-4.1', 'openai/gpt-4o');

UPDATE model_routing_rules
SET model_id = 'meta-llama/llama-4-maverick', updated_at = now()
WHERE model_id = 'anthropic/claude-sonnet-4';

-- ═══ 5. إضافة قواعد التوجيه الافتراضية (upsert) ═══

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

-- ═══ 6. تفعيل RLS + صلاحيات ═══

DO $$ BEGIN
  ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE model_routing_rules ENABLE ROW LEVEL SECURITY;
  ALTER TABLE viral_tweet_analyses ENABLE ROW LEVEL SECURITY;
  ALTER TABLE viral_style_patterns ENABLE ROW LEVEL SECURITY;
  ALTER TABLE x_algorithm_learning_rules ENABLE ROW LEVEL SECURITY;
  ALTER TABLE working_memory ENABLE ROW LEVEL SECURITY;
  ALTER TABLE telegram_bot_state ENABLE ROW LEVEL SECURITY;
  ALTER TABLE mcp_opportunity_map ENABLE ROW LEVEL SECURITY;
  ALTER TABLE system_learning_rules ENABLE ROW LEVEL SECURITY;
  ALTER TABLE content_opportunities ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- إضافة سياسات الوصول (لو ما موجودة)
DO $$ BEGIN
  CREATE POLICY "Service role full access" ON accounts FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON model_routing_rules FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON viral_tweet_analyses FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON viral_style_patterns FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON x_algorithm_learning_rules FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON working_memory FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON telegram_bot_state FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON mcp_opportunity_map FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON system_learning_rules FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role full access" ON content_opportunities FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══ 7. إضافة unique constraint على tweet_id (لو ما موجود) ═══
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS viral_tweet_analyses_tweet_id_key ON viral_tweet_analyses (tweet_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══ تم! ═══
