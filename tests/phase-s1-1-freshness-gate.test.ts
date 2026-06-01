/**
 * phase-s1-1-freshness-gate.test.ts — Phase S1.1: Source Freshness Gate Tests
 *
 * 11 test cases:
 * 1. Reply with source_created_at within 72h passes freshness
 * 2. Reply older than 72h is rejected
 * 3. Reply missing source_created_at is rejected
 * 4. Quote within 7d passes freshness
 * 5. Quote older than 7d is rejected
 * 6. Standalone evergreen can pass with old source
 * 7. Old reply can be downgraded to standalone only when safe
 * 8. source_created_at is preserved through pipeline stages
 * 9. publish_gate rejects old/missing source timestamps
 * 10. no threshold changes
 * 11. build/test pass (verified by CI)
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeSourceCreatedAt,
  computeSourceAgeHours,
  computeSourceAgeHoursFromReference,
  checkFreshness,
  canDowngradeToStandalone,
  filterPublishableOpportunities,
  REPLY_MAX_AGE_HOURS,
  QUOTE_MAX_AGE_HOURS,
  type FreshnessDiagnostics,
  type FreshnessGateStats,
} from '../lib/content-policy';

import {
  validateOpportunityForEnrich,
  validateOpportunityForJudge,
  validateOpportunityForPublishGate,
} from '../lib/pipeline-contracts';

import { NEAR_PASS_THRESHOLDS } from '../lib/opportunity-judge';

// ═══ Helpers ═══

function makeOpportunity(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    type: 'reply',
    source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    source_text: 'AI agents are reshaping how teams make decisions',
    source_author: 'karpathy',
    source_metrics: { like_count: 5000, reply_count: 200 },
    crafted_text: 'The real shift with AI agents is not automation — it is reallocating where judgment lives in a team.',
    why: 'High engagement reply opportunity',
    brain_rules_used: ['pattern_a'],
    shield_passed: true,
    shield_issues: [],
    source_created_at: new Date().toISOString(), // default: just now
    ...overrides,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// ═══ Tests ═══

describe('Phase S1.1: Source Freshness Gate', () => {
  // ═══ Test 1: Reply with source_created_at within 72h passes freshness ═══

  it('reply with source_created_at within 72h passes freshness', () => {
    const opp = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(24), // 24 hours ago — within 72h
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness_passed).toBe(true);
    expect(result.accepted[0].freshness_rejection_reason).toBeNull();
    expect(result.freshnessStats.freshness_checked_count).toBe(1);
    expect(result.freshnessStats.freshness_rejected_count).toBe(0);
  });

  // ═══ Test 2: Reply older than 72h is rejected ═══

  it('reply older than 72h is rejected', () => {
    // Use a reply with "just said" dependency pattern — cannot be downgraded
    // Keep valid source_tweet_url so it doesn't fail URL validation first
    const opp = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100), // 100 hours ago — beyond 72h
      crafted_text: 'Karpathy just said what everyone was thinking about AI agents.',
      source_author: 'karpathy',
      source_text: 'AI agents are reshaping team decisions',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('source_too_old_for_reply');
    expect(result.freshnessStats.freshness_too_old_reply_count).toBe(1);
    expect(result.freshnessStats.freshness_rejected_count).toBe(1);
  });

  // ═══ Test 3: Reply missing source_created_at is rejected ═══

  it('reply missing source_created_at is rejected', () => {
    const opp = makeOpportunity({
      type: 'reply',
      source_created_at: null,
      created_at: undefined,
      tweet_created_at: undefined,
      published_at: undefined,
      createdAt: undefined,
      tweetCreatedAt: undefined,
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('missing_source_created_at_for_reply');
    expect(result.freshnessStats.freshness_missing_timestamp_count).toBe(1);
  });

  // ═══ Test 4: Quote within 7d passes freshness ═══

  it('quote within 7d passes freshness', () => {
    const opp = makeOpportunity({
      type: 'quote',
      source_created_at: hoursAgo(120), // 5 days ago — within 7 days
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness_passed).toBe(true);
  });

  // ═══ Test 5: Quote older than 7d is rejected ═══

  it('quote older than 7d is rejected', () => {
    // Use a quote with dependency pattern that prevents downgrade
    const opp = makeOpportunity({
      type: 'quote',
      source_created_at: hoursAgo(200), // 8.3 days ago — beyond 7 days
      crafted_text: 'This was exactly what Karpathy just said about the future of AI.',
      source_author: 'karpathy',
      source_text: 'AI agents are reshaping team decisions',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('source_too_old_for_quote');
    expect(result.freshnessStats.freshness_too_old_quote_count).toBe(1);
  });

  // ═══ Test 6: Standalone evergreen can pass with old source ═══

  it('standalone evergreen can pass with old source', () => {
    const opp = makeOpportunity({
      type: 'standalone',
      source_created_at: hoursAgo(720), // 30 days ago — very old
      // Standalone doesn't need source_tweet_url
      source_tweet_url: '',
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness_passed).toBe(true);
    expect(result.accepted[0].freshness_rejection_reason).toBeNull();
  });

  // ═══ Test 7: Old reply can be downgraded to standalone only when safe ═══

  it('old reply can be downgraded to standalone only when safe', () => {
    // Case A: Reply that CAN be downgraded (no direct dependency on source)
    const canDowngrade = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100), // beyond 72h
      crafted_text: 'The real shift with AI agents is not automation — it is reallocating where judgment lives in a team.',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
      source_author: 'karpathy',
      source_text: 'AI agents are reshaping team decisions',
    });

    const freshnessA = checkFreshness(canDowngrade);
    expect(freshnessA.freshness_passed).toBe(false);
    expect(freshnessA.freshness_rejection_reason).toBe('source_too_old_for_reply');
    expect(freshnessA.downgraded_to_standalone).toBe(true);

    // Case B: Reply that CANNOT be downgraded (no source credit)
    const cannotDowngrade = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100), // beyond 72h
      crafted_text: 'This just shows how out of touch they are with the real problem.',
      source_author: '',
      source_text: '',
      source_tweet_url: 'https://x.com/someone/status/999', // valid URL but no source credit
    });

    const freshnessB = checkFreshness(cannotDowngrade);
    expect(freshnessB.freshness_passed).toBe(false);
    expect(freshnessB.downgraded_to_standalone).toBe(false); // no source credit

    // Case C: Reply with "just said" pattern cannot be downgraded
    const replyDependency = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100),
      crafted_text: 'Karpathy just said what everyone was thinking about AI agents.',
      source_author: 'karpathy',
      source_text: 'AI agents...',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });

    const freshnessC = checkFreshness(replyDependency);
    expect(freshnessC.freshness_passed).toBe(false);
    expect(freshnessC.downgraded_to_standalone).toBe(false); // "just said" dependency
  });

  // ═══ Test 8: source_created_at is preserved through pipeline stages ═══

  it('source_created_at is preserved through pipeline stages', () => {
    const timestamp = hoursAgo(5);

    // Stage: Enrich
    const enrichResult = validateOpportunityForEnrich(makeOpportunity({
      source_created_at: timestamp,
    }));
    expect(enrichResult.normalized.source_created_at).toBe(timestamp);

    // Stage: Judge
    const judgeResult = validateOpportunityForJudge(makeOpportunity({
      source_created_at: timestamp,
    }));
    expect(judgeResult.normalized.source_created_at).toBe(timestamp);

    // Stage: Publish Gate
    const gateResult = validateOpportunityForPublishGate(makeOpportunity({
      source_created_at: timestamp,
      shield_passed: true,
      _judge_result: { passed: true },
    }));
    expect(gateResult.normalized.source_created_at).toBe(timestamp);
  });

  // ═══ Test 9: publish_gate rejects old/missing source timestamps ═══

  it('publish_gate rejects old/missing source timestamps', () => {
    // Old reply with dependency pattern (cannot be downgraded)
    const oldReply = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100),
      crafted_text: 'This was exactly what Karpathy just said about AI agents.',
      source_author: 'karpathy',
      source_text: 'AI agents are reshaping team decisions',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });
    const result1 = filterPublishableOpportunities([oldReply], { enableFreshnessGate: true });
    expect(result1.rejected).toHaveLength(1);
    expect(result1.rejected[0].reason).toBe('source_too_old_for_reply');

    // Missing timestamp reply
    const noTimestamp = makeOpportunity({
      type: 'reply',
      source_created_at: null,
    });
    const result2 = filterPublishableOpportunities([noTimestamp], { enableFreshnessGate: true });
    expect(result2.rejected).toHaveLength(1);
    expect(result2.rejected[0].reason).toBe('missing_source_created_at_for_reply');

    // Old quote with dependency pattern (cannot be downgraded)
    const oldQuote = makeOpportunity({
      type: 'quote',
      source_created_at: hoursAgo(200),
      crafted_text: 'Karpathy just said something everyone needed to hear about AI agents.',
      source_author: 'karpathy',
      source_text: 'AI agents are reshaping team decisions',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });
    const result3 = filterPublishableOpportunities([oldQuote], { enableFreshnessGate: true });
    expect(result3.rejected).toHaveLength(1);
    expect(result3.rejected[0].reason).toBe('source_too_old_for_quote');

    // Freshness gate disabled — should pass
    const result4 = filterPublishableOpportunities([oldReply], { enableFreshnessGate: false });
    expect(result4.accepted).toHaveLength(1);
  });

  // ═══ Test 10: no threshold changes ═══

  it('does not change any judge or near-pass thresholds', () => {
    // All thresholds must remain unchanged from Phase 2G.3
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });

  // ═══ Supplementary: Timestamp normalization and age computation ═══

  it('normalizes source_created_at from various field names', () => {
    // source_created_at (canonical)
    expect(normalizeSourceCreatedAt({ source_created_at: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // created_at
    expect(normalizeSourceCreatedAt({ created_at: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // tweet_created_at
    expect(normalizeSourceCreatedAt({ tweet_created_at: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // published_at
    expect(normalizeSourceCreatedAt({ published_at: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // createdAt (camelCase)
    expect(normalizeSourceCreatedAt({ createdAt: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // tweetCreatedAt (camelCase)
    expect(normalizeSourceCreatedAt({ tweetCreatedAt: '2026-05-30T10:00:00Z' }))
      .toBe('2026-05-30T10:00:00Z');

    // Priority: source_created_at takes precedence
    expect(normalizeSourceCreatedAt({
      source_created_at: '2026-05-30T10:00:00Z',
      created_at: '2026-05-29T10:00:00Z',
    })).toBe('2026-05-30T10:00:00Z');

    // No timestamp at all
    expect(normalizeSourceCreatedAt({})).toBeNull();
    expect(normalizeSourceCreatedAt(null)).toBeNull();

    // Invalid timestamp
    expect(normalizeSourceCreatedAt({ source_created_at: 'not-a-date' })).toBeNull();
  });

  it('computes source age in hours correctly', () => {
    const now = new Date();

    // Null input
    expect(computeSourceAgeHours(null)).toBeNull();

    // Recent timestamp
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const age1 = computeSourceAgeHours(oneHourAgo);
    expect(age1).not.toBeNull();
    expect(age1!).toBeCloseTo(1, 0);

    // Using reference time for deterministic testing
    const refTime = new Date('2026-05-31T12:00:00Z');
    const sourceTime = '2026-05-31T00:00:00Z'; // 12 hours before ref
    const age2 = computeSourceAgeHoursFromReference(sourceTime, refTime);
    expect(age2).toBe(12);

    // 3 days before reference (72 hours)
    const sourceTime3d = '2026-05-28T12:00:00Z';
    const age3 = computeSourceAgeHoursFromReference(sourceTime3d, refTime);
    expect(age3).toBe(72);

    // Future timestamp → 0
    const futureSource = '2026-06-01T12:00:00Z';
    const age4 = computeSourceAgeHoursFromReference(futureSource, refTime);
    expect(age4).toBe(0);
  });

  it('uses correct freshness thresholds', () => {
    expect(REPLY_MAX_AGE_HOURS).toBe(72);
    expect(QUOTE_MAX_AGE_HOURS).toBe(168);
  });

  it('stale reply is always rejected — never downgraded to standalone', () => {
    // A reply that's too old — even though it could theoretically be standalone,
    // the system NO LONGER downgrades. Stale content is always rejected.
    const opp = makeOpportunity({
      type: 'reply',
      source_created_at: hoursAgo(100),
      crafted_text: 'The real insight here is about capability redistribution, not replacement.',
      source_author: 'karpathy',
      source_text: 'Original AI agent tweet...',
      source_tweet_url: 'https://x.com/karpathy/status/1234567890',
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    // Must be rejected — never downgraded to standalone
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('source_too_old_for_reply');
    expect(result.freshnessStats.freshness_downgraded_to_standalone_count).toBe(0);
  });

  it('thread type always passes freshness regardless of source age', () => {
    const opp = makeOpportunity({
      type: 'thread',
      source_created_at: hoursAgo(1000), // very old
      source_tweet_url: '',
    });

    const result = filterPublishableOpportunities([opp], { enableFreshnessGate: true });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness_passed).toBe(true);
  });

  it('freshness stats are correctly computed for mixed opportunities', () => {
    const opportunities = [
      // Fresh reply → accepted as reply
      makeOpportunity({ type: 'reply', source_created_at: hoursAgo(12) }),
      // Old reply → REJECTED (no downgrade)
      makeOpportunity({ type: 'reply', source_created_at: hoursAgo(100) }),
      // Missing timestamp reply → rejected
      makeOpportunity({ type: 'reply', source_created_at: null }),
      // Fresh quote → accepted as quote
      makeOpportunity({ type: 'quote', source_created_at: hoursAgo(48) }),
      // Old quote → REJECTED (no downgrade)
      makeOpportunity({ type: 'quote', source_created_at: hoursAgo(200) }),
      // Old standalone (beyond 7d) → REJECTED
      makeOpportunity({ type: 'standalone', source_created_at: hoursAgo(200), source_tweet_url: '' }),
    ];

    const result = filterPublishableOpportunities(opportunities, { enableFreshnessGate: true });

    expect(result.freshnessStats.freshness_checked_count).toBe(6);
    // Rejected by freshness: old reply (1) + missing timestamp (1) + old quote (1) + old standalone (1) = 4
    expect(result.freshnessStats.freshness_rejected_count).toBe(4);
    expect(result.freshnessStats.freshness_missing_timestamp_count).toBe(1);
    expect(result.freshnessStats.freshness_too_old_reply_count).toBe(1);
    expect(result.freshnessStats.freshness_too_old_quote_count).toBe(1);
    // No downgrades anymore
    expect(result.freshnessStats.freshness_downgraded_to_standalone_count).toBe(0);
    // Accepted: fresh reply + fresh quote = 2
    expect(result.accepted).toHaveLength(2);
    // Rejected: old reply + missing timestamp reply + old quote + old standalone = 4
    expect(result.rejected).toHaveLength(4);
  });
});
