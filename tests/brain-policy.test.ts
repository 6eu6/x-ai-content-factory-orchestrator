import { describe, it, expect } from 'vitest';
import { KIND_POLICY } from '../lib/brain/prune';

describe('brain kind-aware forgetting policy', () => {
  it('protects durable algorithm mechanics from age decay', () => {
    expect(KIND_POLICY.algorithm.protect).toBe(true);
    expect(KIND_POLICY.algorithm.decay).toBe(0);
  });

  it('forgets time-sensitive niche patterns faster than durable layers', () => {
    expect(KIND_POLICY.source_pattern.staleDays).toBeLessThan(KIND_POLICY.voice.staleDays);
    expect(KIND_POLICY.insight.staleDays).toBeLessThan(KIND_POLICY.outcome.staleDays);
    expect(KIND_POLICY.source_pattern.decay).toBeGreaterThan(KIND_POLICY.outcome.decay);
  });

  it('every kind has a positive cap', () => {
    for (const k of Object.keys(KIND_POLICY)) expect(KIND_POLICY[k].cap).toBeGreaterThan(0);
  });
});
