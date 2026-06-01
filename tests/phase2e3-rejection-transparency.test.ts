/**
 * phase2e3-rejection-transparency.test.ts — Phase 2E.3: Discovery Rejection Transparency
 *
 * Tests covering:
 * 1. RejectionDebug includes source_tweet_url, blocked_topic_label, why_rejected
 * 2. blocked_topic rejection includes exact blocked topic label
 * 3. blocked_topic rejection includes niche_adjacent flag
 * 4. generic_only rejection includes why_generic and convertibility
 * 5. low_originality_potential rejection includes what_was_missing
 * 6. IntelligenceSummary includes rejection_debug_available
 * 7. IntelligenceSummary includes per-reason example arrays
 * 8. sampled_rejection_debug includes up to 10 items
 * 9. buildRejectionDebug enriches all rejection reasons
 * 10. No threshold changes
 */

import { describe, it, expect } from 'vitest';

import {
  quickNicheFitScore,
  determineRejectionReason,
  buildRejectionDebug,
  type OpportunityBrief,
  type RejectionDebug,
  type IntelligenceSummary,
  CANONICAL_REJECTION_REASONS,
} from '../lib/opportunity-intelligence';

import {
  NEAR_PASS_THRESHOLDS,
} from '../lib/opportunity-judge';

// ═══ Helpers ═══

function makeBlockedTopicBrief(): OpportunityBrief {
  return {
    source_summary: 'Blocked topic: celebrity gossip about Taylor Swift and Travis Kelce',
    source_text: 'Taylor Swift and Travis Kelce drama escalates as new rumors spread about their relationship and breakup',
    source_author: 'gossip_account',
    source_tweet_url: 'https://x.com/gossip_account/status/123456789',
    type: 'reply',
    core_observation: '',
    why_it_matters: '',
    audience_relevance: '',
    niche_fit_score: 1,
    originality_potential_score: 1,
    usefulness_score: 1,
    evidence_risk_score: 10,
    viral_context_score: 3,
    publishability_score: 1,
    recommended_angle: '',
    content_format: 'reply',
    do_not_claim: ['All claims from blocked topic source'],
    required_context: [],
    should_craft: false,
    rejection_reason: 'blocked_topic',
  };
}

function makeGenericOnlyBrief(): OpportunityBrief {
  return {
    source_summary: 'Generic observation about AI being useful',
    source_text: 'AI is really useful and more people should use it in their daily workflows and be more productive with AI tools',
    source_author: 'generic_poster',
    source_tweet_url: 'https://x.com/generic_poster/status/987654321',
    type: 'reply',
    core_observation: 'AI is useful',
    why_it_matters: '',
    audience_relevance: '',
    niche_fit_score: 6,
    originality_potential_score: 2,
    usefulness_score: 4,
    evidence_risk_score: 8,
    viral_context_score: 2,
    publishability_score: 3,
    recommended_angle: 'Share thoughts on AI',
    content_format: 'reply',
    do_not_claim: [],
    required_context: [],
    should_craft: false,
    rejection_reason: 'generic_only',
  };
}

function makeLowOriginalityBrief(): OpportunityBrief {
  return {
    source_summary: 'Another AI tool launch',
    source_text: 'New AI coding assistant launched today with improved code generation capabilities and better integration with existing IDE tools',
    source_author: 'tech_news',
    source_tweet_url: 'https://x.com/tech_news/status/555666777',
    type: 'reply',
    core_observation: 'New AI tool launch',
    why_it_matters: '',
    audience_relevance: '',
    niche_fit_score: 7,
    originality_potential_score: 4,
    usefulness_score: 6,
    evidence_risk_score: 7,
    viral_context_score: 4,
    publishability_score: 5,
    recommended_angle: 'New AI tool launched — might be useful for builders',
    content_format: 'quote',
    do_not_claim: [],
    required_context: [],
    should_craft: false,
    rejection_reason: 'low_originality_potential',
  };
}

// ═══ Test 1: RejectionDebug includes new fields ═══

describe('Phase 2E.3: RejectionDebug Type', () => {
  it('includes source_tweet_url, blocked_topic_label, why_rejected fields', () => {
    const debug: RejectionDebug = {
      source_author: 'test',
      source_tweet_url: 'https://x.com/test/status/1',
      source_text_preview: 'preview text',
      rejection_reason: 'blocked_topic',
      blocked_topic_label: 'pure celebrity gossip',
      why_rejected: 'Content matched blocked topic pattern(s): pure celebrity gossip',
      niche_adjacent: false,
      publishability_score: 1,
      originality_potential_score: 1,
      usefulness_score: 1,
      niche_fit_score: 1,
      content_format: 'reply',
      recommended_angle: '',
      recommended_angle_preview: '',
    };

    expect(debug.source_tweet_url).toBeTruthy();
    expect(debug.blocked_topic_label).toBeTruthy();
    expect(debug.why_rejected).toBeTruthy();
    expect(debug.rejection_reason).toBe('blocked_topic');
  });
});

// ═══ Test 2: blocked_topic includes exact blocked topic label ═══

describe('Phase 2E.3: Blocked Topic Transparency', () => {
  it('includes exact blocked topic label from heuristic', () => {
    const brief = makeBlockedTopicBrief();
    const debug = buildRejectionDebug(brief);

    expect(debug.rejection_reason).toBe('blocked_topic');
    expect(debug.blocked_topic_label).toBeTruthy();
    // Should contain "celebrity gossip" or similar
    expect(debug.blocked_topic_label!.toLowerCase()).toContain('celebrity');
    expect(debug.why_rejected).toBeTruthy();
    expect(debug.why_rejected!).toContain('blocked topic');
  });

  // ═══ Test 3: blocked_topic includes niche_adjacent flag ═══

  it('includes niche_adjacent flag indicating adjacency potential', () => {
    const brief = makeBlockedTopicBrief();
    const debug = buildRejectionDebug(brief);
    expect(debug.niche_adjacent).toBeDefined();
    // This particular example should NOT be adjacent (pure gossip)
    expect(debug.niche_adjacent).toBe(false);

    // Test with adjacent content — sports with brand/leverage angle
    const adjacentBrief: OpportunityBrief = {
      ...brief,
      source_text: 'How Jake Paul leveraged boxing into a personal brand empire worth millions — lessons for creators on distribution and attention',
      rejection_reason: 'blocked_topic',
    };
    const adjacentDebug = buildRejectionDebug(adjacentBrief);
    expect(adjacentDebug.niche_adjacent).toBeDefined();
  });
});

// ═══ Test 4: generic_only includes why_generic and convertibility ═══

describe('Phase 2E.3: Generic Only Transparency', () => {
  it('includes why_generic explanation and operator heuristic convertibility', () => {
    const brief = makeGenericOnlyBrief();
    const debug = buildRejectionDebug(brief);

    expect(debug.rejection_reason).toBe('generic_only');
    expect(debug.why_rejected).toBeTruthy();
    expect(debug.why_rejected!).toContain('generic');
    expect(debug.why_rejected!).toContain('usefulness');
    expect(debug.could_convert_to_operator_heuristic).toBeDefined();

    // With niche_fit=6 and source_text > 50 chars, could be convertible
    expect(debug.could_convert_to_operator_heuristic).toBe(true);
  });

  it('marks short or off-niche sources as not convertible', () => {
    const shortBrief: OpportunityBrief = {
      ...makeGenericOnlyBrief(),
      source_text: 'AI is useful',
      niche_fit_score: 3,
    };
    const debug = buildRejectionDebug(shortBrief);
    expect(debug.could_convert_to_operator_heuristic).toBe(false);
  });
});

// ═══ Test 5: low_originality_potential includes what_was_missing ═══

describe('Phase 2E.3: Low Originality Transparency', () => {
  it('includes what_was_missing for low originality score', () => {
    const brief = makeLowOriginalityBrief();
    // originality_potential_score is 4, which is < 5
    const debug = buildRejectionDebug(brief);

    expect(debug.rejection_reason).toBe('low_originality_potential');
    expect(debug.why_rejected).toBeTruthy();
    expect(debug.why_rejected!).toContain('4/10');
    expect(debug.what_was_missing).toBeTruthy();
    // Score < 5 → "No unique angle" message
    expect(debug.what_was_missing!).toContain('No unique angle');
  });

  it('differentiates very low vs borderline low originality', () => {
    // Borderline: score 6 (>= 5)
    const borderlineBrief: OpportunityBrief = {
      ...makeLowOriginalityBrief(),
      originality_potential_score: 6,
      rejection_reason: 'low_originality_potential',
    };
    const debug = buildRejectionDebug(borderlineBrief);
    // Score >= 5 → "lacks specificity" message
    expect(debug.what_was_missing).toContain('specificity');
  });
});

// ═══ Test 6: IntelligenceSummary includes rejection_debug_available ═══

describe('Phase 2E.3: IntelligenceSummary Fields', () => {
  it('includes rejection_debug_available and per-reason example arrays', () => {
    const summary: IntelligenceSummary = {
      raw_opportunity_count: 16,
      intelligence_evaluated_count: 16,
      intelligence_rejected_count: 16,
      intelligence_selected_count: 0,
      selected_opportunity_scores: [],
      top_rejection_reasons: { blocked_topic: 9, generic_only: 6, low_originality_potential: 1 },
      avg_publishability_score: 2.5,
      avg_originality_potential_score: 2.0,
      sampled_rejection_debug: [],
      intelligence_parse_failed_count: 0,
      parse_failure_rate: 0,
      rescue_attempted_count: 0,
      rescue_succeeded_count: 0,
      rescue_failed_count: 0,
      rescued_opportunity_count: 0,
      rescue_reasons: [],
      sampled_rescue_debug: [],
      // Phase 2E.3
      rejection_debug_available: true,
      blocked_topic_examples: [],
      generic_only_examples: [],
      low_originality_examples: [],
    };

    expect(summary.rejection_debug_available).toBe(true);
    expect(summary.blocked_topic_examples).toBeDefined();
    expect(summary.generic_only_examples).toBeDefined();
    expect(summary.low_originality_examples).toBeDefined();
    expect(Array.isArray(summary.blocked_topic_examples)).toBe(true);
    expect(Array.isArray(summary.generic_only_examples)).toBe(true);
    expect(Array.isArray(summary.low_originality_examples)).toBe(true);
  });

  // ═══ Test 7: Per-reason example arrays have correct items ═══

  it('per-reason example arrays are populated by buildRejectionDebug', () => {
    const blockedDebug = buildRejectionDebug(makeBlockedTopicBrief());
    const genericDebug = buildRejectionDebug(makeGenericOnlyBrief());
    const lowOrigDebug = buildRejectionDebug(makeLowOriginalityBrief());

    const allDebug = [blockedDebug, genericDebug, lowOrigDebug];

    const blockedTopicExamples = allDebug.filter(d => d.rejection_reason === 'blocked_topic');
    const genericOnlyExamples = allDebug.filter(d => d.rejection_reason === 'generic_only');
    const lowOriginalityExamples = allDebug.filter(d => d.rejection_reason === 'low_originality_potential');

    expect(blockedTopicExamples).toHaveLength(1);
    expect(blockedTopicExamples[0].blocked_topic_label).toBeTruthy();

    expect(genericOnlyExamples).toHaveLength(1);
    expect(genericOnlyExamples[0].could_convert_to_operator_heuristic).toBeDefined();

    expect(lowOriginalityExamples).toHaveLength(1);
    expect(lowOriginalityExamples[0].what_was_missing).toBeTruthy();
  });
});

// ═══ Test 8: sampled_rejection_debug includes up to 10 items ═══

describe('Phase 2E.3: Sample Size', () => {
  it('RejectionDebug array supports up to 10 items (was 3)', () => {
    // Build 12 rejection debugs to verify we can store more than 3
    const debugs: RejectionDebug[] = [];
    for (let i = 0; i < 12; i++) {
      const brief: OpportunityBrief = {
        ...makeGenericOnlyBrief(),
        source_author: `account_${i}`,
        source_tweet_url: `https://x.com/account_${i}/status/${i}`,
      };
      debugs.push(buildRejectionDebug(brief));
    }

    // Should be able to slice to 10
    const sampled = debugs.slice(0, 10);
    expect(sampled).toHaveLength(10);
    // All items should have the enriched fields
    for (const d of sampled) {
      expect(d.source_tweet_url).toBeTruthy();
      expect(d.source_text_preview).toBeTruthy();
      expect(d.why_rejected).toBeTruthy();
    }
  });
});

// ═══ Test 9: buildRejectionDebug enriches all rejection reasons ═══

describe('Phase 2E.3: buildRejectionDebug Coverage', () => {
  it('enriches blocked_topic, generic_only, and low_originality_potential reasons', () => {
    // blocked_topic
    const blockedDebug = buildRejectionDebug(makeBlockedTopicBrief());
    expect(blockedDebug.blocked_topic_label).toBeDefined();
    expect(blockedDebug.why_rejected).toContain('blocked topic');
    expect(blockedDebug.niche_adjacent).toBeDefined();

    // generic_only
    const genericDebug = buildRejectionDebug(makeGenericOnlyBrief());
    expect(genericDebug.why_rejected).toContain('generic');
    expect(genericDebug.could_convert_to_operator_heuristic).toBeDefined();

    // low_originality_potential
    const lowOrigDebug = buildRejectionDebug(makeLowOriginalityBrief());
    expect(lowOrigDebug.why_rejected).toContain('originality');
    expect(lowOrigDebug.what_was_missing).toBeDefined();
  });

  it('handles other rejection reasons gracefully', () => {
    const lowNicheBrief: OpportunityBrief = {
      ...makeGenericOnlyBrief(),
      rejection_reason: 'low_niche_fit',
      niche_fit_score: 2,
    };
    const debug = buildRejectionDebug(lowNicheBrief);
    expect(debug.rejection_reason).toBe('low_niche_fit');
    expect(debug.source_tweet_url).toBeTruthy();
    expect(debug.source_text_preview).toBeTruthy();
    // Other reasons don't get why_rejected (it's optional)
  });
});

// ═══ Test 10: No threshold changes ═══

describe('Phase 2E.3: Threshold Integrity', () => {
  it('does not change any judge or near-pass thresholds', () => {
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
  });

  it('quickNicheFitScore returns blocked_topic_labels and adjacent_matches', () => {
    // Blocked topic
    const blocked = quickNicheFitScore('Kardashian family drama with Taylor Swift');
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked_topic_labels.length).toBeGreaterThan(0);
    expect(blocked.blocked_topic_labels).toContain('pure celebrity gossip');

    // AI content (not blocked)
    const ai = quickNicheFitScore('Built a RAG pipeline with GPT-4 for my workflow');
    expect(ai.blocked).toBe(false);
    expect(ai.blocked_topic_labels).toHaveLength(0);
    expect(ai.adjacent_matches).toBeDefined();
    expect(Array.isArray(ai.adjacent_matches)).toBe(true);
  });

  it('canonical rejection reasons are unchanged', () => {
    expect(CANONICAL_REJECTION_REASONS).toContain('blocked_topic');
    expect(CANONICAL_REJECTION_REASONS).toContain('generic_only');
    expect(CANONICAL_REJECTION_REASONS).toContain('low_originality_potential');
    // Phase S1.3: Added 'forced_angle' as a canonical rejection reason
    expect(CANONICAL_REJECTION_REASONS).toContain('forced_angle');
    // P1: Added 'schema_missing_required_fields' as a canonical rejection reason
    expect(CANONICAL_REJECTION_REASONS).toContain('schema_missing_required_fields');
    expect(CANONICAL_REJECTION_REASONS).toHaveLength(13);
  });
});
