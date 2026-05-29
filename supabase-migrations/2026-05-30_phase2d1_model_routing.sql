-- Phase 2D.1: Add dedicated model routing rules for opportunity_intelligence, opportunity_judge, selected_candidate_crafting
-- These routes ensure the pipeline uses the strongest model for high-value judgment tasks.
--
-- Models:
--   opportunity_intelligence: anthropic/claude-sonnet-4-20250514 (Sonnet — strategic judgment)
--   opportunity_judge: anthropic/claude-sonnet-4-20250514 (Sonnet — strict scoring)
--   selected_candidate_crafting: deepseek/deepseek-chat-v3-0324 (DeepSeek V3 — cost-efficient drafting)
--
-- All are DB-switchable: update model_routing_rules to change model/params without code changes.
-- To switch opportunity_intelligence to DeepSeek V3 as fallback:
--   UPDATE model_routing_rules SET model_id = 'deepseek/deepseek-chat-v3-0324' WHERE task_type = 'opportunity_intelligence';

INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, response_format, provider, active, description)
VALUES
  ('opportunity_intelligence', 'anthropic/claude-sonnet-4-20250514', 0.05, 2600, 'json_object', 'cloud', true,
   'Opportunity intelligence — structured opportunity scoring and brief generation')
ON CONFLICT (task_type) DO UPDATE SET
  model_id = EXCLUDED.model_id,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  response_format = EXCLUDED.response_format,
  provider = EXCLUDED.provider,
  active = EXCLUDED.active,
  description = EXCLUDED.description;

INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, response_format, provider, active, description)
VALUES
  ('opportunity_judge', 'anthropic/claude-sonnet-4-20250514', 0.02, 1200, 'json_object', 'cloud', true,
   'Opportunity judge — strict pre-gate scoring')
ON CONFLICT (task_type) DO UPDATE SET
  model_id = EXCLUDED.model_id,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  response_format = EXCLUDED.response_format,
  provider = EXCLUDED.provider,
  active = EXCLUDED.active,
  description = EXCLUDED.description;

INSERT INTO model_routing_rules (task_type, model_id, temperature, max_tokens, response_format, provider, active, description)
VALUES
  ('selected_candidate_crafting', 'deepseek/deepseek-chat-v3-0324', 0.20, 2000, 'json_object', 'cloud', true,
   'Selected candidate crafting from opportunity brief')
ON CONFLICT (task_type) DO UPDATE SET
  model_id = EXCLUDED.model_id,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  response_format = EXCLUDED.response_format,
  provider = EXCLUDED.provider,
  active = EXCLUDED.active,
  description = EXCLUDED.description;
