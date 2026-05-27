import { describe, expect, it } from 'vitest';
import { evaluateBrainRule, evaluateStylePattern } from '../lib/brain-quality';

describe('brain quality scoring', () => {
  it('archives very generic weak rules', () => {
    const result = evaluateBrainRule({
      rule_type: 'generic_advice',
      rule: 'Post valuable content with a clear hook.',
      evidence: '',
      source_type: 'manual',
      confidence_score: 4,
      status: 'active'
    });

    expect(result.recommended_status).toBe('archived');
    expect(result.quality_score).toBeLessThan(3.5);
  });

  it('keeps specific evidence-backed rules active', () => {
    const result = evaluateBrainRule({
      rule_type: 'viral_pattern',
      rule: 'Build-in-public posts that contrast automation vs judgment work when framed as a specific system failure and fix.',
      evidence: '@source tweet score: 84, high replies and bookmarks; users discussed the tradeoff rather than liking passively.',
      source_type: 'real_time_crawl',
      source_url: 'https://x.com/source/status/123',
      applies_to: 'content_strategy,engagement_crafting',
      confidence_score: 8,
      status: 'active',
      updated_at: new Date().toISOString()
    });

    expect(result.recommended_status).toBe('active');
    expect(result.quality_score).toBeGreaterThanOrEqual(6.5);
  });

  it('moves incomplete style patterns to watch', () => {
    const result = evaluateStylePattern({
      pattern_type: 'hook',
      pattern_name: 'Contrast hook',
      pattern_description: 'Use a contrast.',
      adaptation_for_30piq: '',
      confidence_score: 6,
      status: 'active',
      updated_at: new Date().toISOString()
    });

    expect(result.recommended_status).toBe('watch');
  });
});
