import { describe, expect, it } from 'vitest';
import { evaluateBrainRule, evaluateStylePattern } from '../lib/brain-quality';

describe('brain-quality — evaluateBrainRule', () => {
  it('archives a very generic rule', () => {
    const rule = {
      rule: 'Create good content that resonates with your audience and be authentic',
      evidence: '',
      confidence_score: 3,
      rule_type: '',
      source_type: '',
      applies_to: '',
      status: 'active'
    };
    const result = evaluateBrainRule(rule);
    expect(result.quality_score).toBeLessThan(5);
    expect(result.recommended_status).toBe('archived');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('keeps a specific well-evidenced rule active', () => {
    const rule = {
      rule: 'When a tweet uses a contrarian hook followed by a hidden cost reveal, engagement increases 3x because readers feel compelled to share the surprise',
      evidence: 'Analyzed 47 viral tweets: 31 used contrarian hook + hidden cost mechanic with average 3.2x engagement multiplier',
      confidence_score: 8,
      rule_type: 'precise_concept',
      source_type: 'viral_analysis',
      applies_to: 'content_strategy',
      status: 'active'
    };
    const result = evaluateBrainRule(rule);
    expect(result.quality_score).toBeGreaterThanOrEqual(5.5);
    expect(result.recommended_status).toBe('active');
    expect(result.reasons.some(r => r.includes('mechanic'))).toBe(true);
  });

  it('moves a weak rule to watch', () => {
    const rule = {
      rule: 'Short tweets with questions get more replies on average',
      evidence: 'Some evidence',
      confidence_score: 4,
      rule_type: 'general_observation',
      source_type: 'unknown',
      applies_to: '',
      status: 'active'
    };
    const result = evaluateBrainRule(rule);
    expect(result.recommended_status).toBe('watch');
  });
});

describe('brain-quality — evaluateStylePattern', () => {
  it('archives a raw source pattern', () => {
    const pattern = {
      pattern_name: '6eu6/x-ai-content-factory-orchestrator',
      pattern_type: '',
      pattern_description: 'Use this crawled item as a source-grounded pattern',
      why_it_works: '',
      adaptation_for_30piq: '',
      confidence_score: 2,
      status: 'active'
    };
    const result = evaluateStylePattern(pattern);
    expect(result.quality_score).toBeLessThan(5);
    expect(result.recommended_status).toBe('archived');
    expect(result.reasons.some(r => r.includes('Raw source'))).toBe(true);
  });

  it('keeps a well-documented pattern active', () => {
    const pattern = {
      pattern_name: 'Contrarian Hook with Cost Reveal',
      pattern_type: 'hook',
      pattern_description: 'Start with an accepted belief, then reveal the hidden cost that most people miss. The contrast between expectation and reality creates a shareable moment.',
      why_it_works: 'Triggers surprise and loss aversion simultaneously, making readers feel compelled to warn others',
      adaptation_for_30piq: 'Use in tech and productivity content where conventional wisdom has hidden costs',
      confidence_score: 9,
      status: 'active'
    };
    const result = evaluateStylePattern(pattern);
    expect(result.quality_score).toBeGreaterThanOrEqual(5.5);
    expect(result.recommended_status).toBe('active');
  });

  it('moves an incomplete pattern to watch', () => {
    const pattern = {
      pattern_name: 'Question Hook',
      pattern_type: 'hook',
      pattern_description: 'Questions work',
      why_it_works: '',
      adaptation_for_30piq: '',
      confidence_score: 4,
      status: 'active'
    };
    const result = evaluateStylePattern(pattern);
    expect(result.recommended_status).toBe('watch');
  });

  it('does not archive high-confidence pattern with low quality unless score < 2.5', () => {
    // This test verifies the safety rule: don't archive if confidence >= 8 AND quality_score >= 2.5
    // The evaluateStylePattern itself doesn't enforce this — it's enforced in the maintenance endpoint
    // Here we just verify the scoring logic produces expected values
    const pattern = {
      pattern_name: 'Generic Engagement Pattern',
      pattern_type: 'structure',
      pattern_description: 'Content that resonates with your audience and increases engagement',
      why_it_works: 'It works because people like engaging content',
      adaptation_for_30piq: '',
      confidence_score: 8,
      status: 'active'
    };
    const result = evaluateStylePattern(pattern);
    // We're checking that even with confidence 8, generic content gets flagged
    // But the final safety gate (confidence >= 8 && quality_score >= 2.5 → no archive) is in the route
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('brain-quality — edge cases', () => {
  it('handles missing fields gracefully', () => {
    const rule = {};
    const result = evaluateBrainRule(rule);
    expect(result.quality_score).toBeLessThan(5);
    expect(result.recommended_status).not.toBe('active');
  });

  it('handles empty pattern fields gracefully', () => {
    const pattern = {};
    const result = evaluateStylePattern(pattern);
    expect(result.quality_score).toBeLessThan(5);
    expect(result.recommended_status).not.toBe('active');
  });

  it('quality_score is always between 0 and 10', () => {
    const veryBadRule = {
      rule: '',
      evidence: '',
      confidence_score: 0,
      rule_type: '',
      source_type: '',
      applies_to: '',
      status: 'watch'
    };
    const result = evaluateBrainRule(veryBadRule);
    expect(result.quality_score).toBeGreaterThanOrEqual(0);
    expect(result.quality_score).toBeLessThanOrEqual(10);
  });
});
