import { describe, expect, it } from 'vitest';
import {
  calculateRulePerformanceWeight,
  summarizeRulePerformance,
  calculateRuleWeightAdjustment,
  RulePerformanceInput
} from '../lib/rule-performance';
import { scoreOpportunity, decideTelegramOpportunities, getDecisionBudget } from '../lib/decision-engine';
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

// ═══ calculateRulePerformanceWeight ═══

describe('calculateRulePerformanceWeight', () => {
  it('gives high weight for successful rules with high confidence', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 9.2,
      success_count: 3,
      failure_count: 0,
      status: 'active'
    };
    const weight = calculateRulePerformanceWeight(rule);
    // base = 0.92, success_bonus = min(0.25, 0.15) = 0.15, failure_penalty = 0
    // weight = 0.92 + 0.15 = 1.07
    expect(weight).toBeGreaterThan(0.9);
    expect(weight).toBeLessThanOrEqual(1.25);
  });

  it('gives low weight for rules with many failures and low confidence', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 5,
      success_count: 0,
      failure_count: 3,
      status: 'active'
    };
    const weight = calculateRulePerformanceWeight(rule);
    // base = 0.5, failure_penalty = min(0.35, 0.24) = 0.24
    // weight = 0.5 - 0.24 = 0.26
    expect(weight).toBeLessThan(0.4);
    expect(weight).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for archived rules regardless of other metrics', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 9,
      success_count: 5,
      failure_count: 0,
      status: 'archived'
    };
    expect(calculateRulePerformanceWeight(rule)).toBe(0);
  });

  it('returns 0 for archived_duplicate status', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 8,
      success_count: 2,
      failure_count: 0,
      status: 'archived_duplicate'
    };
    expect(calculateRulePerformanceWeight(rule)).toBe(0);
  });

  it('penalizes watch status rules', () => {
    const watchRule: RulePerformanceInput = {
      confidence_score: 7,
      success_count: 0,
      failure_count: 2,
      status: 'watch'
    };
    const activeRule: RulePerformanceInput = {
      confidence_score: 7,
      success_count: 0,
      failure_count: 2,
      status: 'active'
    };
    const watchWeight = calculateRulePerformanceWeight(watchRule);
    const activeWeight = calculateRulePerformanceWeight(activeRule);
    // Watch gets -0.15 penalty
    expect(watchWeight).toBeLessThan(activeWeight);
    expect(activeWeight - watchWeight).toBeCloseTo(0.15, 1);
  });

  it('uses default confidence of 7 when null', () => {
    const rule: RulePerformanceInput = {
      confidence_score: null,
      success_count: 0,
      failure_count: 0,
      status: 'active'
    };
    const weight = calculateRulePerformanceWeight(rule);
    // base = 7/10 = 0.7
    expect(weight).toBeCloseTo(0.7, 1);
  });

  it('clamps success bonus at 0.25', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 7,
      success_count: 100, // Would be 5.0 without cap
      failure_count: 0,
      status: 'active'
    };
    const weight = calculateRulePerformanceWeight(rule);
    // base = 0.7, success_bonus = min(0.25, 5.0) = 0.25
    // weight = 0.7 + 0.25 = 0.95
    expect(weight).toBeLessThanOrEqual(1.25);
  });

  it('clamps failure penalty at 0.35', () => {
    const rule: RulePerformanceInput = {
      confidence_score: 5,
      success_count: 0,
      failure_count: 100, // Would be 8.0 without cap
      status: 'active'
    };
    const weight = calculateRulePerformanceWeight(rule);
    // base = 0.5, failure_penalty = min(0.35, 8.0) = 0.35
    // weight = 0.5 - 0.35 = 0.15
    expect(weight).toBeGreaterThanOrEqual(0);
  });
});

// ═══ summarizeRulePerformance ═══

describe('summarizeRulePerformance', () => {
  it('returns zeros for empty array', () => {
    const summary = summarizeRulePerformance([]);
    expect(summary.average_weight).toBe(0);
    expect(summary.strongest).toBeNull();
    expect(summary.weakest).toBeNull();
    expect(summary.has_negative_signal).toBe(false);
    expect(summary.matched_rules).toBe(0);
  });

  it('computes correct average and identifies strongest/weakest', () => {
    const rules: RulePerformanceInput[] = [
      { confidence_score: 9, success_count: 3, failure_count: 0, status: 'active' },
      { confidence_score: 5, success_count: 0, failure_count: 2, status: 'active' },
      { confidence_score: 7, success_count: 1, failure_count: 0, status: 'active' }
    ];
    const summary = summarizeRulePerformance(rules);
    expect(summary.matched_rules).toBe(3);
    expect(summary.strongest!.weight).toBeGreaterThan(summary.weakest!.weight);
    expect(summary.average_weight).toBeGreaterThan(0);
    expect(summary.average_weight).toBeLessThanOrEqual(1.25);
  });

  it('detects negative signal from failures', () => {
    const rules: RulePerformanceInput[] = [
      { confidence_score: 7, success_count: 0, failure_count: 3, status: 'active' }
    ];
    const summary = summarizeRulePerformance(rules);
    expect(summary.has_negative_signal).toBe(true);
  });

  it('detects negative signal from watch status', () => {
    const rules: RulePerformanceInput[] = [
      { confidence_score: 7, success_count: 0, failure_count: 0, status: 'watch' }
    ];
    const summary = summarizeRulePerformance(rules);
    expect(summary.has_negative_signal).toBe(true);
  });

  it('no negative signal for healthy rules', () => {
    const rules: RulePerformanceInput[] = [
      { confidence_score: 8, success_count: 2, failure_count: 0, status: 'active' },
      { confidence_score: 7, success_count: 1, failure_count: 1, status: 'active' }
    ];
    const summary = summarizeRulePerformance(rules);
    expect(summary.has_negative_signal).toBe(false);
  });
});

// ═══ calculateRuleWeightAdjustment ═══

describe('calculateRuleWeightAdjustment', () => {
  it('gives positive adjustment for strong rules', () => {
    const adj = calculateRuleWeightAdjustment(1.0);
    // (1.0 - 0.6) * 1.0 = 0.4
    expect(adj).toBe(0.4);
  });

  it('gives negative adjustment for weak rules', () => {
    const adj = calculateRuleWeightAdjustment(0.2);
    // (0.2 - 0.6) * 1.0 = -0.4
    expect(adj).toBe(-0.4);
  });

  it('gives zero adjustment at neutral weight', () => {
    const adj = calculateRuleWeightAdjustment(0.6);
    expect(adj).toBe(0);
  });

  it('clamps at +0.4 maximum', () => {
    const adj = calculateRuleWeightAdjustment(1.25);
    // (1.25 - 0.6) = 0.65, clamped to 0.4
    expect(adj).toBe(0.4);
  });

  it('clamps at -0.4 minimum', () => {
    const adj = calculateRuleWeightAdjustment(0);
    // (0 - 0.6) = -0.6, clamped to -0.4
    expect(adj).toBe(-0.4);
  });
});

// ═══ Decision engine with rule weight ═══

describe('decision engine with rule weight', () => {
  it('boosts score slightly when avg_brain_rule_weight is high', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const withWeight = baseOpportunity({ avg_brain_rule_weight: 1.0 });
    const withoutWeight = baseOpportunity({ avg_brain_rule_weight: undefined });

    const scoreWith = scoreOpportunity(withWeight, budget);
    const scoreWithout = scoreOpportunity(withoutWeight, budget);

    // With high weight, score should be higher
    expect(scoreWith.final_score).toBeGreaterThan(scoreWithout.final_score);
    // But the difference should be small (max 0.4)
    expect(scoreWith.final_score - scoreWithout.final_score).toBeLessThanOrEqual(0.5);
    expect(scoreWith.rule_weight_adjustment).toBeGreaterThan(0);
    expect(scoreWithout.rule_weight_adjustment).toBe(0);
  });

  it('penalizes score slightly when avg_brain_rule_weight is low', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const withLowWeight = baseOpportunity({ avg_brain_rule_weight: 0.2 });
    const withoutWeight = baseOpportunity({ avg_brain_rule_weight: undefined });

    const scoreLow = scoreOpportunity(withLowWeight, budget);
    const scoreWithout = scoreOpportunity(withoutWeight, budget);

    expect(scoreLow.final_score).toBeLessThan(scoreWithout.final_score);
    expect(scoreLow.final_score - scoreWithout.final_score).toBeGreaterThanOrEqual(-0.5);
    expect(scoreLow.rule_weight_adjustment).toBeLessThan(0);
  });

  it('safety shield still rejects dangerous content regardless of rule weight', () => {
    const budget = getDecisionBudget('stage_0_new');
    const risky = baseOpportunity({
      crafted_text: 'Read this now https://example.com #growth',
      shield_passed: false,
      shield_issues: ['link', 'hashtag'],
      avg_brain_rule_weight: 1.25 // Highest possible weight
    });

    const result = decideTelegramOpportunities([risky], 'stage_0_new');
    expect(result.selected).toHaveLength(0);
    expect(result.held).toHaveLength(1);
    expect(result.held[0].decision_score.safety_score).toBeLessThan(6.5);
  });

  it('does not apply weight adjustment when shield fails', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const unsafeWithWeight = baseOpportunity({
      shield_passed: false,
      shield_issues: ['risky'],
      avg_brain_rule_weight: 1.0
    });
    const unsafeNoWeight = baseOpportunity({
      shield_passed: false,
      shield_issues: ['risky'],
      avg_brain_rule_weight: undefined
    });

    const scoreWith = scoreOpportunity(unsafeWithWeight, budget);
    const scoreWithout = scoreOpportunity(unsafeNoWeight, budget);

    // Weight adjustment should NOT be applied when shield fails
    expect(scoreWith.final_score).toBe(scoreWithout.final_score);
  });

  it('neutral weight (0.6) produces zero adjustment', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const neutral = baseOpportunity({ avg_brain_rule_weight: 0.6 });
    const score = scoreOpportunity(neutral, budget);

    expect(score.rule_weight_adjustment).toBe(0);
  });

  it('includes rule weight in reasons when non-zero', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const withWeight = baseOpportunity({ avg_brain_rule_weight: 1.0 });
    const score = scoreOpportunity(withWeight, budget);

    const weightReason = score.reasons.find(r => r.includes('Rule weight'));
    expect(weightReason).toBeDefined();
    expect(weightReason).toContain('+0.4');
  });

  it('does not include rule weight reason when adjustment is zero', () => {
    const budget = getDecisionBudget('stage_1_under_500');
    const noWeight = baseOpportunity({ avg_brain_rule_weight: undefined });
    const score = scoreOpportunity(noWeight, budget);

    const weightReason = score.reasons.find(r => r.includes('Rule weight'));
    expect(weightReason).toBeUndefined();
  });
});
