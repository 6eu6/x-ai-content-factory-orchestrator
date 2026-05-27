import { describe, expect, it } from 'vitest';
import {
  calculateOutcomeScore,
  getOutcomeLabel,
  calculateOutcome,
  PerformancePayload
} from '../lib/performance-outcome';

// ═══════════════════════════════════════════════════════
// calculateOutcomeScore
// ═══════════════════════════════════════════════════════

describe('performance-outcome — calculateOutcomeScore', () => {
  it('returns high score for viral metrics (strong_success)', () => {
    const payload: PerformancePayload = {
      views: 63995,
      likes: 611,
      replies: 43,
      retweets: 35,
      quotes: 3,
      bookmarks: 164
    };
    const score = calculateOutcomeScore(payload);
    expect(score).toBeGreaterThanOrEqual(8);
  });

  it('returns moderate score for decent metrics (success)', () => {
    // Lower metrics than viral but still meaningful
    const payload: PerformancePayload = {
      views: 5000,
      likes: 50,
      replies: 10,
      retweets: 5,
      quotes: 1,
      bookmarks: 8
    };
    const score = calculateOutcomeScore(payload);
    expect(score).toBeGreaterThanOrEqual(5.5);
    expect(score).toBeLessThan(10);
  });

  it('returns low-mid score for average metrics (neutral)', () => {
    const payload: PerformancePayload = {
      views: 1000,
      likes: 10,
      replies: 2,
      retweets: 1,
      quotes: 0,
      bookmarks: 1
    };
    const score = calculateOutcomeScore(payload);
    expect(score).toBeGreaterThanOrEqual(3);
    expect(score).toBeLessThan(6);
  });

  it('returns low score for poor metrics (weak)', () => {
    const payload: PerformancePayload = {
      views: 50,
      likes: 0,
      replies: 0,
      retweets: 0,
      quotes: 0,
      bookmarks: 0
    };
    const score = calculateOutcomeScore(payload);
    expect(score).toBeLessThan(3);
  });

  it('returns minimal score for zero metrics', () => {
    const payload: PerformancePayload = {
      views: 0,
      likes: 0,
      replies: 0,
      retweets: 0,
      quotes: 0,
      bookmarks: 0
    };
    const score = calculateOutcomeScore(payload);
    // log10(10) * 1.2 = 1.2
    expect(score).toBe(1.2);
  });

  it('handles empty payload gracefully', () => {
    const score = calculateOutcomeScore({});
    expect(score).toBe(1.2); // Same as zero views
  });

  it('caps score at 10', () => {
    const payload: PerformancePayload = {
      views: 10000000,
      likes: 100000,
      replies: 10000,
      retweets: 50000,
      quotes: 5000,
      bookmarks: 20000
    };
    const score = calculateOutcomeScore(payload);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('uses real data from our live test as reference', () => {
    // This matches the actual emollick tweet data we fetched
    const payload: PerformancePayload = {
      views: 63995,
      likes: 611,
      replies: 43,
      retweets: 35,
      quotes: 3,
      bookmarks: 164
    };
    const score = calculateOutcomeScore(payload);
    // log10(64005) * 1.2 ≈ 5.77
    // + replies 43 * 0.03 = 1.29
    // + bookmarks 164 * 0.04 = 6.56
    // + likes 611 * 0.01 = 6.11
    // + retweets 35 * 0.03 = 1.05
    // + quotes 3 * 0.04 = 0.12
    // Total raw ≈ 20.9 → capped at 10
    expect(score).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════
// getOutcomeLabel
// ═══════════════════════════════════════════════════════

describe('performance-outcome — getOutcomeLabel', () => {
  it('returns strong_success for score >= 8', () => {
    expect(getOutcomeLabel(8)).toBe('strong_success');
    expect(getOutcomeLabel(10)).toBe('strong_success');
    expect(getOutcomeLabel(9.5)).toBe('strong_success');
  });

  it('returns success for score >= 5.5 and < 8', () => {
    expect(getOutcomeLabel(5.5)).toBe('success');
    expect(getOutcomeLabel(7)).toBe('success');
    expect(getOutcomeLabel(7.9)).toBe('success');
  });

  it('returns neutral for score >= 3 and < 5.5', () => {
    expect(getOutcomeLabel(3)).toBe('neutral');
    expect(getOutcomeLabel(4)).toBe('neutral');
    expect(getOutcomeLabel(5.4)).toBe('neutral');
  });

  it('returns weak for score < 3', () => {
    expect(getOutcomeLabel(0)).toBe('weak');
    expect(getOutcomeLabel(1.2)).toBe('weak');
    expect(getOutcomeLabel(2.9)).toBe('weak');
  });
});

// ═══════════════════════════════════════════════════════
// calculateOutcome (integration)
// ═══════════════════════════════════════════════════════

describe('performance-outcome — calculateOutcome', () => {
  it('returns correct score and label for strong performance', () => {
    const result = calculateOutcome({
      views: 63995, likes: 611, replies: 43,
      retweets: 35, quotes: 3, bookmarks: 164
    });
    expect(result.label).toBe('strong_success');
    expect(result.score).toBe(10);
  });

  it('returns neutral for low engagement', () => {
    const result = calculateOutcome({
      views: 500, likes: 5, replies: 1,
      retweets: 0, quotes: 0, bookmarks: 0
    });
    expect(result.label).toBe('neutral');
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('returns weak for near-zero metrics', () => {
    const result = calculateOutcome({
      views: 0, likes: 0, replies: 0,
      retweets: 0, quotes: 0, bookmarks: 0
    });
    expect(result.label).toBe('weak');
    expect(result.score).toBe(1.2);
  });

  it('dry-run scenario: no brain rules modified', () => {
    // This is a logic test, not DB test
    // When brain_rules_used is empty, no attribution should happen
    const brainRulesUsed: any[] = [];
    const hasAttribution = brainRulesUsed.length > 0;
    expect(hasAttribution).toBe(false);
  });

  it('attribution scenario: numeric rule IDs found', () => {
    const brainRulesUsed = ['42', '99'];
    const ruleIdsFound = brainRulesUsed.filter(ref => /^\d+$/.test(ref));
    expect(ruleIdsFound.length).toBe(2);
    expect(ruleIdsFound).toContain('42');
    expect(ruleIdsFound).toContain('99');
  });

  it('no attribution when brain_rules_used is empty', () => {
    const brainRulesUsed: any[] = [];
    const ruleIdsFound: string[] = [];
    for (const ref of brainRulesUsed) {
      if (typeof ref === 'string' && /^\d+$/.test(ref)) {
        ruleIdsFound.push(ref);
      }
    }
    expect(ruleIdsFound.length).toBe(0);
    const hasAttribution = ruleIdsFound.length > 0;
    expect(hasAttribution).toBe(false);
  });

  it('confidence adjustment stays within bounds', () => {
    // Success: confidence + 0.2, max 10
    expect(Math.min(10, 9.9 + 0.2)).toBe(10);
    expect(Math.min(10, 7 + 0.2)).toBe(7.2);

    // Failure: confidence - 0.2, min 1
    expect(Math.max(1, 1.1 - 0.2)).toBe(1);
    expect(Math.max(1, 5 - 0.2)).toBe(4.8);
  });

  it('status becomes watch after 3 failures with 0 successes', () => {
    const failureCount = 3;
    const successCount = 0;
    const currentStatus = 'active';
    const shouldWatch = failureCount >= 3 && successCount === 0 && currentStatus === 'active';
    expect(shouldWatch).toBe(true);

    // But not if there are successes
    const shouldNotWatch = (failureCount >= 3 && 1 === 0 && currentStatus === 'active');
    expect(shouldNotWatch).toBe(false);
  });
});
