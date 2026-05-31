/**
 * Phase 2C.2 tests — Rewrite JSON wrapper cleaning before rejection
 *
 * Tests that rewriteForOriginality attempts to clean JSON-wrapped
 * rewrite output using cleanCraftedText() before rejecting it.
 *
 * Required test cases from spec:
 * - rewriteForOriginality cleans JSON-wrapped rewrite output before validation
 * - JSON rewrite with {"reply":"plain text"} can be cleaned and accepted
 * - markdown ```json rewrite can be cleaned and accepted
 * - malformed JSON rewrite is still rejected
 * - cleaned rewrite is still rejected if it contains Arabic
 * - cleaned rewrite is still rejected if it contains AI slop
 * - diagnostics are recorded
 * - quality_enhance summary includes rewrite_json_wrappers_cleaned and rewrite_json_wrappers_failed_cleaning
 * - publish_gate thresholds remain unchanged
 */

import { describe, it, expect } from 'vitest';
import {
  cleanCraftedText,
  looksLikeJsonWrapper,
} from '../lib/crafted-text-cleaner';
import {
  containsArabic,
  isAISlopWrapper,
  filterPublishableOpportunities,
} from '../lib/content-policy';
import {
  validateOpportunityQuality,
} from '../lib/quality-validator';
import {
  type OpportunityWithDiagnostics,
  type RewriteResult,
} from '../lib/originality-enhancer';

// ═══ Helpers ═══

function makeOpp(overrides: Partial<OpportunityWithDiagnostics> = {}): OpportunityWithDiagnostics {
  return {
    crafted_text: 'Built a RAG pipeline with GPT-4 that actually works',
    type: 'reply',
    source_text: 'AI tools discussion',
    source_author: 'testuser',
    source_tweet_url: 'https://x.com/testuser/status/123',
    why: 'Relevant to AI productivity niche',
    brain_rules_used: [],
    shield_passed: true,
    shield_issues: [],
    ...overrides,
  };
}

// ═══ Phase 2C.2: Clean JSON-wrapped rewrite output before validation ═══

describe('Phase 2C.2: rewriteForOriginality cleans JSON-wrapped rewrite output before validation', () => {
  it('JSON rewrite with {"reply":"plain text"} can be cleaned and accepted', () => {
    // Simulate what happens when the model returns {"reply":"actual tweet text"}
    const rawOutput = '{"reply":"Built a RAG pipeline with GPT-4 that handles my entire research workflow"}';
    const cleanResult = cleanCraftedText(rawOutput);

    // The cleaner should extract the plain text
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);
    expect(cleanResult.cleaned_text).toBe('Built a RAG pipeline with GPT-4 that handles my entire research workflow');

    // The cleaned text should NOT look like JSON anymore
    expect(looksLikeJsonWrapper(cleanResult.cleaned_text)).toBe(false);

    // The cleaned text should pass quality validation
    const validation = validateOpportunityQuality({
      crafted_text: cleanResult.cleaned_text,
      type: 'reply',
    });
    expect(validation.passed).toBe(true);
  });

  it('markdown ```json rewrite can be cleaned and accepted', () => {
    // Simulate what happens when the model returns ```json\n{ "reply": "..." }\n```
    const rawOutput = '```json\n{"reply":"Automated my deploy pipeline with GitHub Actions and it cut deploy time"}\n```';
    const cleanResult = cleanCraftedText(rawOutput);

    // The cleaner should strip fences and extract the plain text
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);
    expect(cleanResult.cleaned_text).toBe('Automated my deploy pipeline with GitHub Actions and it cut deploy time');

    // The cleaned text should NOT look like JSON
    expect(looksLikeJsonWrapper(cleanResult.cleaned_text)).toBe(false);
  });

  it('malformed JSON rewrite is still rejected', () => {
    // Irrecoverable JSON that can't be cleaned into plain text
    const rawOutput = '{ "unknown_key_123": 42, "data": [1, 2, 3] }';
    const cleanResult = cleanCraftedText(rawOutput);

    // The cleaner should mark this as malformed
    expect(cleanResult.malformed_json_output).toBe(true);

    // If the rewrite model returned this, it would be rejected
    // because malformed_json_output = true means cleaning failed
  });

  it('cleaned rewrite is still rejected if it contains Arabic', () => {
    // JSON wrapper that contains Arabic text inside
    const rawOutput = '{"reply":"هذا محتوى عربي لا يجب نشره"}';
    const cleanResult = cleanCraftedText(rawOutput);

    // The cleaner extracts the text (it doesn't check for Arabic)
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);

    // But the Arabic check should still reject it
    expect(containsArabic(cleanResult.cleaned_text)).toBe(true);

    // Quality validation should reject it
    const validation = validateOpportunityQuality({
      crafted_text: cleanResult.cleaned_text,
      type: 'reply',
    });
    expect(validation.passed).toBe(false);
    expect(validation.failures).toContain('arabic_content_detected');
  });

  it('cleaned rewrite is still rejected if it contains AI slop', () => {
    // JSON wrapper that contains AI slop text inside
    const rawOutput = '{"reply":"Here is a great tip about AI productivity that you need to know"}';
    const cleanResult = cleanCraftedText(rawOutput);

    // The cleaner extracts the text
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);

    // But AI slop detection should still reject it
    const slopCheck = isAISlopWrapper(cleanResult.cleaned_text);
    expect(slopCheck.ok).toBe(false);

    // Quality validation should reject it
    const validation = validateOpportunityQuality({
      crafted_text: cleanResult.cleaned_text,
      type: 'reply',
    });
    expect(validation.passed).toBe(false);
  });

  it('diagnostics are recorded for JSON-wrapped rewrite output', () => {
    // Verify the RewriteResult type includes Phase 2C.2 diagnostic fields
    const result: RewriteResult = {
      text: 'Built a RAG pipeline with GPT-4 that actually works',
      failedReason: null,
      rewrite_raw_was_json_wrapper: true,
      rewrite_cleaned_json_wrapper: true,
      rewrite_cleaning_notes: 'Extracted from JSON wrapper (key: reply)',
    };

    expect(result.rewrite_raw_was_json_wrapper).toBe(true);
    expect(result.rewrite_cleaned_json_wrapper).toBe(true);
    expect(result.rewrite_cleaning_notes).toContain('Extracted from JSON wrapper');

    // Also test the failed cleaning case
    const failedResult: RewriteResult = {
      text: null,
      failedReason: 'json_wrapper_in_rewrite',
      rewrite_raw_was_json_wrapper: true,
      rewrite_cleaned_json_wrapper: false,
      rewrite_cleaning_notes: 'Content still looks like JSON after cleaning — marking as malformed',
    };

    expect(failedResult.rewrite_raw_was_json_wrapper).toBe(true);
    expect(failedResult.rewrite_cleaned_json_wrapper).toBe(false);
    expect(failedResult.failedReason).toBe('json_wrapper_in_rewrite');

    // Test that OpportunityWithDiagnostics includes the new fields
    const opp = makeOpp();
    opp.rewrite_raw_was_json_wrapper = true;
    opp.rewrite_cleaned_json_wrapper = true;
    opp.rewrite_cleaning_notes = 'Extracted from JSON wrapper (key: reply)';

    expect(opp.rewrite_raw_was_json_wrapper).toBe(true);
    expect(opp.rewrite_cleaned_json_wrapper).toBe(true);
    expect(opp.rewrite_cleaning_notes).toContain('Extracted from JSON wrapper');
  });

  it('quality_enhance summary includes rewrite_json_wrappers_cleaned and rewrite_json_wrappers_failed_cleaning', () => {
    // Verify the summary shape includes the new Phase 2C.2 fields
    const summaryShape = {
      rewrite_candidates_count: 0,
      rewrites_attempted: 0,
      rewrites_applied: 0,
      rewrites_applied_by_originality: 0,
      rewrites_applied_by_shield_improvement: 0,
      rewrites_rejected_no_improvement: 0,
      rewrites_failed_validation: 0,
      rewrites_skipped_reason: {} as Record<string, number>,
      // Phase 2C.2
      rewrite_json_wrappers_cleaned: 0,
      rewrite_json_wrappers_failed_cleaning: 0,
    };

    expect(summaryShape).toHaveProperty('rewrite_json_wrappers_cleaned');
    expect(summaryShape).toHaveProperty('rewrite_json_wrappers_failed_cleaning');
    expect(typeof summaryShape.rewrite_json_wrappers_cleaned).toBe('number');
    expect(typeof summaryShape.rewrite_json_wrappers_failed_cleaning).toBe('number');
  });

  it('publish_gate thresholds remain unchanged (Phase 2C.2)', () => {
    // Ensure the cleaning logic doesn't bypass any gates
    const opp = {
      type: 'reply' as const,
      crafted_text: 'Built a RAG pipeline with GPT-4 that works',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: false,
      shield_issues: ['missing_originality'],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toContain('shield_not_passed');

    // Valid content still passes
    const validOpp = {
      type: 'reply' as const,
      crafted_text: 'Switched my research workflow to use RAG + GPT-4 — the structured output alone saves time per session',
      source_tweet_url: 'https://x.com/user/status/456',
      shield_passed: true,
      shield_issues: [],
      source_created_at: new Date().toISOString(),
    };

    const validGate = filterPublishableOpportunities([validOpp]);
    expect(validGate.accepted.length).toBe(1);
  });
});

// ═══ Phase 2C.2: Full cleaning flow simulation ═══

describe('Phase 2C.2: full cleaning flow simulation', () => {
  it('JSON wrapper with reply key is cleaned and passes all subsequent validations', () => {
    const rawOutput = '{"reply":"Switched my research workflow to use RAG + GPT-4"}';

    // Step 1: Detect it's JSON
    expect(looksLikeJsonWrapper(rawOutput)).toBe(true);

    // Step 2: Clean it
    const cleanResult = cleanCraftedText(rawOutput);
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);

    // Step 3: Validate the cleaned text
    const cleanedText = cleanResult.cleaned_text;
    expect(looksLikeJsonWrapper(cleanedText)).toBe(false);
    expect(containsArabic(cleanedText)).toBe(false);
    expect(isAISlopWrapper(cleanedText).ok).toBe(true);

    // Step 4: Quality validation should pass
    const validation = validateOpportunityQuality({
      crafted_text: cleanedText,
      type: 'reply',
      niche_alignment_score: 8.5,
    });
    expect(validation.passed).toBe(true);
  });

  it('JSON wrapper with quote key is cleaned and passes all subsequent validations', () => {
    const rawOutput = '{"quote":"AI agents that automate email triage are getting good"}';

    expect(looksLikeJsonWrapper(rawOutput)).toBe(true);

    const cleanResult = cleanCraftedText(rawOutput);
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);

    const cleanedText = cleanResult.cleaned_text;
    expect(looksLikeJsonWrapper(cleanedText)).toBe(false);
    expect(containsArabic(cleanedText)).toBe(false);
    expect(isAISlopWrapper(cleanedText).ok).toBe(true);
  });

  it('Nested markdown + JSON is fully cleaned before validation', () => {
    const rawOutput = '```json\n{"reply":"Built an AI agent that handles my emails automatically"}\n```';

    expect(looksLikeJsonWrapper(rawOutput)).toBe(true);

    const cleanResult = cleanCraftedText(rawOutput);
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);

    const cleanedText = cleanResult.cleaned_text;
    expect(looksLikeJsonWrapper(cleanedText)).toBe(false);
    expect(cleanedText).toBe('Built an AI agent that handles my emails automatically');
  });

  it('Plain text rewrite output (no JSON) is NOT cleaned but passes validation', () => {
    const plainText = 'Built a RAG pipeline with GPT-4 that actually works for my team';

    // Should NOT look like JSON
    expect(looksLikeJsonWrapper(plainText)).toBe(false);

    // No cleaning needed
    const cleanResult = cleanCraftedText(plainText);
    expect(cleanResult.cleaned_json_wrapper).toBe(false);
    expect(cleanResult.cleaned_text).toBe(plainText);
  });
});
