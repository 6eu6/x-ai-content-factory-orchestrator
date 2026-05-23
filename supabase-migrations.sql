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
