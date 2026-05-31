-- ═══════════════════════════════════════════════════════════════════════════════
-- Source Pool Cleanup — Non-Destructive Classification and Update
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Project: x-ai-content-factory-orchestrator
-- Target: @30piq
-- Date: 2026-06-04
-- Related: docs/SOURCE_STRATEGY_AUDIT.md
--
-- ⚠️  WARNING: DO NOT EXECUTE WITHOUT EXPLICIT APPROVAL AND A DATABASE BACKUP.
-- ⚠️  All statements are non-destructive (UPDATE only, no DELETE).
-- ⚠️  Review each section before running. Comment out sections you want to skip.
--
-- Schema assumptions (based on migration files):
--   accounts.handle        TEXT NOT NULL UNIQUE
--   accounts.category      TEXT (added 2026-05-27, mostly NULL)
--   accounts.tier          INTEGER DEFAULT 2
--   accounts.followers     INTEGER (added 2026-05-27, partially NULL)
--   accounts.notes         TEXT
--   accounts.last_checked  TIMESTAMPTZ (added 2026-05-27)
--   accounts.active        BOOLEAN DEFAULT true
--
--   source_quality_scores.source_handle  TEXT PK
--   source_quality_scores.scans_count    INT DEFAULT 0
--   source_quality_scores.rejection_rate NUMERIC DEFAULT 0
--   source_quality_scores.source_quality_score NUMERIC DEFAULT 0
--
-- ═══════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 1: Classify Invalid Handles
-- ═══════════════════════════════════════════════════════════════════════════════
-- Handles that do not match the valid X handle pattern (1-15 chars, A-Za-z0-9_)
-- are classified as 'invalid'. These handles waste scan slots and over-fetch
-- capacity even though they are filtered out by selectValidAccounts().

-- 1a. Preview: Show handles that will be classified as invalid
-- SELECT handle, category, notes
-- FROM accounts
-- WHERE handle !~ '^[A-Za-z0-9_]{1,15}$'
-- ORDER BY handle;

-- 1b. Update: Classify invalid handles
UPDATE accounts
SET category = 'invalid',
    updated_at = NOW()
WHERE handle !~ '^[A-Za-z0-9_]{1,15}$'
  AND COALESCE(category, '') != 'invalid';

-- 1c. Report: Count of invalid handles
-- SELECT count(*) AS invalid_handle_count
-- FROM accounts
-- WHERE category = 'invalid';


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 2: Heuristic Category Assignment for NULL Categories
-- ═══════════════════════════════════════════════════════════════════════════════
-- For accounts with NULL category, attempt heuristic classification based on
-- handle patterns, notes content, and follower count. These heuristics are
-- approximate — manual review of top accounts is recommended (Phase 1).

-- 2a. Core AI / Tools — handles containing AI/ML/model/tool keywords
UPDATE accounts
SET category = 'core_ai_tools',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(ai|gpt|llm|ml|openai|anthropic|deepmind|stability|hugging|cursor|replit|vercel|supabase|replicate|together|modal|groq|mistral|cohere|perplexity|vllm|ollama|llamaindex|langchain|pinecone|chroma|wandb|weights|tensor|pytorch|keras|onnx|neural|deep_?learn|machine_?learn)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2b. Builders / Founders — handles containing build/ship/founder/startup keywords
UPDATE accounts
SET category = 'builders_founders',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(build|ship|founder|startup|indie|hack|launch|mvp|maker|create|dev|coder|engineer|architect|cto|ceo|vibecoder|vibe_?coder|0x|builder|shipper)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2c. Productivity / Work — handles containing productivity/workflow keywords
UPDATE accounts
SET category = 'productivity_work',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(productiv|workflow|automat|notion|obsidian|roam|todoist|asana|linear|figma|slack|zapier|ifttt|n8n|make_?com|raycast|alfred|1password|fastmail|superhuman|calendar|focus|habit|routine|system|gtd|pk[mn]|second_?brain|knowledge|zettel)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2d. Creator / Growth — handles containing creator/audience/newsletter keywords
UPDATE accounts
SET category = 'creator_growth',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(creator|audience|newsletter|podcast|content|growth|market|brand|social|media|influenc|community|engage|viral|substack|beehiiv|convertkit|mailchimp|patreon|gumroad|kick|youtube|tiktok|instagram|thread|hook|copy|write|author|blogger)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2e. Digital Culture — handles containing culture/internet/tech commentary keywords
UPDATE accounts
SET category = 'digital_culture',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(culture|internet|web|digital|tech|silicon|algorithm|attention|trend|meme|viral|feed|timeline|discourse|essay|thread|analysis|opinion|take|signal|noise|zeitgeist|cyber|pixel|data|info|network|online|screen|scroll)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2f. Internet Business — handles containing business/SaaS/revenue keywords
UPDATE accounts
SET category = 'internet_business',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~* '^(saas|business|revenue|profit|bootstrap|solopreneur|entrepreneur|freelanc|consult|agency|client|customer|pricing|stripe|pay|shop|ecommerce|dropship|fintech|crypto|defi|nft|token|web3|blockchain|decentral|finance|invest|trade|money|income|passive|scal|monetiz|churn|retention|acquisition)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2g. Notes-based classification — scan notes field for category hints
UPDATE accounts
SET category = 'core_ai_tools',
    updated_at = NOW()
WHERE category IS NULL
  AND notes ~* '(AI|GPT|LLM|machine learning|deep learning|ChatGPT|Claude|Gemini|Copilot|model|API provider)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

UPDATE accounts
SET category = 'builders_founders',
    updated_at = NOW()
WHERE category IS NULL
  AND notes ~* '(founder|builder|indie hacker|startup|ship|launch|MVP|side project|bootstrapped)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

UPDATE accounts
SET category = 'creator_growth',
    updated_at = NOW()
WHERE category IS NULL
  AND notes ~* '(creator|audience|newsletter|podcast|content strategy|growth|substack)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

UPDATE accounts
SET category = 'internet_business',
    updated_at = NOW()
WHERE category IS NULL
  AND notes ~* '(SaaS|business|revenue|profit|bootstrapping|solopreneur|pricing|stripe)'
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2h. Remaining unclassified valid handles → noisy_unknown
UPDATE accounts
SET category = 'noisy_unknown',
    updated_at = NOW()
WHERE category IS NULL
  AND handle ~ '^[A-Za-z0-9_]{1,15}$';

-- 2i. Report: Category distribution after classification
-- SELECT category, count(*) AS account_count
-- FROM accounts
-- GROUP BY category
-- ORDER BY count(*) DESC;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 3: Flag Noisy Accounts (High Rejection Rate)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Accounts with high rejection rates in source_quality_scores should be
-- classified as noisy_unknown, regardless of their current category.
-- This uses the existing source_quality_scores table.

-- 3a. Preview: Show accounts with high rejection rates
-- SELECT a.handle, a.category, s.scans_count, s.rejection_rate, s.source_quality_score
-- FROM accounts a
-- JOIN source_quality_scores s ON a.handle = s.source_handle
-- WHERE s.scans_count >= 3
--   AND s.rejection_rate >= 0.80
-- ORDER BY s.rejection_rate DESC;

-- 3b. Update: Reclassify high-rejection accounts as noisy_unknown
UPDATE accounts
SET category = 'noisy_unknown',
    updated_at = NOW()
FROM source_quality_scores s
WHERE accounts.handle = s.source_handle
  AND s.scans_count >= 3
  AND s.rejection_rate >= 0.80
  AND accounts.category NOT IN ('invalid', 'noisy_unknown');


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 4: Update Tiers Based on Follower Count
-- ═══════════════════════════════════════════════════════════════════════════════
-- Assign tier values based on follower count for accounts where tier is NULL
-- or default (2). This provides a more meaningful priority signal.
--
-- Tier 1 (HIGH):   >100K followers — major accounts, likely high-signal
-- Tier 2 (STANDARD): 10K-100K followers — established accounts
-- Tier 3 (LOW):    <10K followers — smaller accounts, lower priority
--
-- Note: Only updates accounts where followers is not NULL.

-- 4a. Preview: Current tier distribution
-- SELECT tier, count(*) AS account_count, count(followers) AS has_followers
-- FROM accounts
-- GROUP BY tier
-- ORDER BY tier;

-- 4b. Update: Tier 1 for major accounts (100K+ followers)
UPDATE accounts
SET tier = 1,
    updated_at = NOW()
WHERE followers IS NOT NULL
  AND followers >= 100000
  AND tier != 1;

-- 4c. Update: Tier 2 for established accounts (10K-100K followers)
UPDATE accounts
SET tier = 2,
    updated_at = NOW()
WHERE followers IS NOT NULL
  AND followers >= 10000
  AND followers < 100000
  AND tier != 2;

-- 4d. Update: Tier 3 for smaller accounts (<10K followers)
UPDATE accounts
SET tier = 3,
    updated_at = NOW()
WHERE followers IS NOT NULL
  AND followers < 10000
  AND tier != 3;

-- 4e. Report: Tier distribution after update
-- SELECT tier, count(*) AS account_count
-- FROM accounts
-- GROUP BY tier
-- ORDER BY tier;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 5: Add Cooldown Support Column
-- ═══════════════════════════════════════════════════════════════════════════════
-- Add a cooldown_until column to accounts for source cooldown support.
-- When set to a future timestamp, the account is skipped during selection.
-- NULL means the account is eligible for scanning.

ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;

-- Add an index for efficient cooldown checks in selection queries
CREATE INDEX IF NOT EXISTS idx_accounts_cooldown_until
ON accounts (cooldown_until)
WHERE cooldown_until IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 6: Add Failure Tracking Columns to source_quality_scores
-- ═══════════════════════════════════════════════════════════════════════════════
-- Track API failures per source handle to avoid wasting scan slots on
-- consistently failing accounts.

ALTER TABLE source_quality_scores
ADD COLUMN IF NOT EXISTS api_failure_count INT DEFAULT 0;

ALTER TABLE source_quality_scores
ADD COLUMN IF NOT EXISTS last_api_failure_at TIMESTAMPTZ;

-- Add index for failure tracking queries
CREATE INDEX IF NOT EXISTS idx_source_quality_api_failure
ON source_quality_scores (api_failure_count, last_api_failure_at)
WHERE api_failure_count > 0;


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 7: Create Source Exploration Log Table
-- ═══════════════════════════════════════════════════════════════════════════════
-- Log exploration scans to track the effectiveness of the experimental quota
-- and provide an audit trail for auto-promotion/demotion decisions.

CREATE TABLE IF NOT EXISTS source_exploration_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_handle TEXT NOT NULL,
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  discovered_via TEXT NOT NULL DEFAULT 'random_exploration',
  initial_quality_score NUMERIC DEFAULT NULL,
  initial_category TEXT DEFAULT NULL,
  promotion_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (promotion_status IN ('pending', 'promoted', 'demoted', 'neutral')),
  promotion_category TEXT DEFAULT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for exploration log queries
CREATE INDEX IF NOT EXISTS idx_exploration_log_source_handle
ON source_exploration_log (source_handle);

CREATE INDEX IF NOT EXISTS idx_exploration_log_promotion_status
ON source_exploration_log (promotion_status)
WHERE promotion_status != 'neutral';

CREATE INDEX IF NOT EXISTS idx_exploration_log_created_at
ON source_exploration_log (created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- SECTION 8: Verification Queries (Read-Only)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run these queries after executing the above to verify the cleanup results.

-- 8a. Category distribution
-- SELECT category, count(*) AS account_count,
--        round(count(*)::numeric / (SELECT count(*) FROM accounts) * 100, 1) AS pct
-- FROM accounts
-- GROUP BY category
-- ORDER BY count(*) DESC;

-- 8b. Invalid handles detail
-- SELECT handle, notes
-- FROM accounts
-- WHERE category = 'invalid'
-- ORDER BY handle;

-- 8c. Tier distribution by category
-- SELECT category, tier, count(*) AS account_count
-- FROM accounts
-- WHERE category != 'invalid'
-- GROUP BY category, tier
-- ORDER BY category, tier;

-- 8d. Accounts still missing categories (should be 0 for valid handles)
-- SELECT handle, category, tier, followers
-- FROM accounts
-- WHERE category IS NULL
--   AND handle ~ '^[A-Za-z0-9_]{1,15}$'
-- ORDER BY handle;

-- 8e. Accounts with cooldown_until set
-- SELECT handle, category, cooldown_until
-- FROM accounts
-- WHERE cooldown_until IS NOT NULL
-- ORDER BY cooldown_until;

-- 8f. Source quality scores with high failure counts
-- SELECT source_handle, scans_count, api_failure_count, last_api_failure_at,
--        rejection_rate, source_quality_score
-- FROM source_quality_scores
-- WHERE api_failure_count > 0
-- ORDER BY api_failure_count DESC;

-- 8g. Exploration log summary (empty after initial cleanup)
-- SELECT discovered_via, promotion_status, count(*) AS exploration_count
-- FROM source_exploration_log
-- GROUP BY discovered_via, promotion_status
-- ORDER BY count(*) DESC;

-- 8h. Overall source pool health summary
-- SELECT
--   (SELECT count(*) FROM accounts) AS total_accounts,
--   (SELECT count(*) FROM accounts WHERE category = 'invalid') AS invalid_count,
--   (SELECT count(*) FROM accounts WHERE category IS NULL) AS unclassified_count,
--   (SELECT count(*) FROM accounts WHERE category != 'invalid' AND category IS NOT NULL) AS classified_count,
--   (SELECT count(*) FROM accounts WHERE handle ~ '^[A-Za-z0-9_]{1,15}$' AND category != 'invalid') AS scannable_count,
--   (SELECT count(*) FROM source_quality_scores) AS scored_count,
--   (SELECT count(*) FROM source_quality_scores WHERE scans_count >= 3) AS sufficiently_scored_count;
