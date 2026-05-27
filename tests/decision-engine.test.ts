import { describe, expect, it } from 'vitest';
import { decideTelegramOpportunities, getDecisionBudget, scoreOpportunity, stageFromFollowerCount } from '../lib/decision-engine';
import type { ContentOpportunity } from '../lib/content-engine-v3';

function baseOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  return {
    type: 'quote',
    source_tweet_url: 'https://x.com/source/status/123',
    source_text: 'A strong source tweet about building systems.',
    source_author: 'source',
    source_metrics: {
      like_count: 120,
      reply_count: 18,
      retweet_count: 22,
      quote_count: 8,
      bookmark_count: 34,
      view_count: 18000
    },
    media_urls: [],
    crafted_text: 'The useful part is not automation. It is forcing a system to wait until the signal is strong enough.',
    why: 'Strong engagement and transferable mechanism',
    brain_rules_used: ['precise_concept', 'psychological_trigger', 'viral_pattern'],
    shield_passed: true,
    shield_issues: [],
    ...overrides
  };
}

describe('decision engine', () => {
  it('maps low follower accounts to strict stages', () => {
    expect(stageFromFollowerCount(0)).toBe('stage_0_new');
    expect(stageFromFollowerCount(250)).toBe('stage_1_under_500');
    expect(stageFromFollowerCount(900)).toBe('stage_2_500_to_2000');
    expect(stageFromFollowerCount(2500)).toBe('stage_3_stable');
  });

  it('selects only a small number of high-quality opportunities', () => {
    const stage = 'stage_1_under_500' as const;
    const result = decideTelegramOpportunities([
      baseOpportunity({ type: 'quote' }),
      baseOpportunity({ type: 'reply', source_tweet_url: 'https://x.com/source/status/456' }),
      baseOpportunity({ type: 'thread', source_tweet_url: '', source_author: 'brain', crafted_text: '1/ A good system should sometimes say nothing.\n---\n2/ Silence is a quality gate, not a failure.' }),
      baseOpportunity({ type: 'quote', source_tweet_url: 'https://x.com/source/status/789' })
    ], stage);

    expect(result.selected.length).toBeLessThanOrEqual(getDecisionBudget(stage).max_total);
    expect(result.selected.filter(o => o.type === 'quote')).toHaveLength(1);
    expect(result.selected.every(o => o.decision_score.final_score >= result.budget.min_final_score)).toBe(true);
  });

  it('holds risky content even when source momentum is high', () => {
    const budget = getDecisionBudget('stage_0_new');
    const risky = baseOpportunity({
      crafted_text: 'Read this now https://example.com #growth',
      shield_passed: false,
      shield_issues: ['link', 'hashtag']
    });
    const score = scoreOpportunity(risky, budget);
    const result = decideTelegramOpportunities([risky], 'stage_0_new');

    expect(score.safety_score).toBeLessThan(6.5);
    expect(result.selected).toHaveLength(0);
    expect(result.held).toHaveLength(1);
    expect(result.held[0].decision_score.rejection_reasons.length).toBeGreaterThan(0);
  });

  it('does not send weak low-signal opportunities', () => {
    const weak = baseOpportunity({
      source_metrics: { like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0, bookmark_count: 0, view_count: 90 },
      brain_rules_used: [],
      why: '',
      crafted_text: 'Interesting point.'
    });
    const result = decideTelegramOpportunities([weak], 'stage_1_under_500');
    expect(result.selected).toHaveLength(0);
    expect(result.held[0].decision_score.final_score).toBeLessThan(result.budget.min_final_score);
  });
});
