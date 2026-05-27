-- Phase 5.1: Change confidence_score from INTEGER to NUMERIC(4,1)
-- This allows +0.2 increments for successful attribution feedback
-- The original migration said NUMERIC(4,2) but actual DB has INTEGER

ALTER TABLE x_algorithm_learning_rules
  ALTER COLUMN confidence_score TYPE NUMERIC(4,1) USING confidence_score::NUMERIC(4,1);

ALTER TABLE viral_style_patterns
  ALTER COLUMN confidence_score TYPE NUMERIC(4,1) USING confidence_score::NUMERIC(4,1);
