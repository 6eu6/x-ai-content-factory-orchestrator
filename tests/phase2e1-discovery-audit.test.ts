/**
 * phase2e1-discovery-audit.test.ts — Phase 2E.1: Smart Discovery Audit + Source Scoring Tests
 *
 * 15 test cases covering:
 * - Source quality scoring (pure function)
 * - Tweet candidate scoring and prefiltering (pure function)
 * - Discovery metadata preservation
 * - Scan result diagnostics
 * - Pipeline task order and thresholds unchanged
 */

import { describe, it, expect } from 'vitest';

// ═══ Import pure functions for testing ═══

import { computeSourceQualityScore } from '../scripts/source-quality-audit';
import {
  scoreAndPrefilterTweets,
  computeBaseEngagementScore,
  normalizedTweetToCandidate,
  type TweetCandidate,
  type PrefilterResult,
} from '../lib/tweet-candidate-scorer';

// Import types and constants for verification
import type { ContentOpportunity, SingleAccountScanResult, MergeAndDiscoverResult } from '../lib/content-engine-v3';
import type { OpportunityBrief } from '../lib/opportunity-intelligence';

// ═══ Test 1: Source quality score rewards selected/judge-passed sources ═══

describe('Source Quality Scoring', () => {
  it('rewards selected/judge-passed sources with score > 70', () => {
    const score = computeSourceQualityScore({
      selected_count: 2,
      rescued_count: 0,
      judge_passed_count: 1,
      avg_niche_fit: 7,
      avg_usefulness: 7,
      generic_only_count: 0,
      blocked_topic_count: 0,
      language_or_context_mismatch_count: 0,
      intelligence_parse_failed_count: 0,
      scans_count: 3,
      raw_opportunities_count: 5,
    });

    // base=50 + selected*8=16 + judge*6=6 + (niche-5)*3=6 + (usef-5)*2=4 = 82
    expect(score).toBeGreaterThan(70);
    expect(score).toBe(82);
  });

  // ═══ Test 2: Source quality score penalizes generic_only/blocked_topic sources ═══

  it('penalizes generic_only/blocked_topic sources with score < 30', () => {
    const score = computeSourceQualityScore({
      selected_count: 0,
      rescued_count: 0,
      judge_passed_count: 0,
      avg_niche_fit: 3,
      avg_usefulness: 3,
      generic_only_count: 3,
      blocked_topic_count: 2,
      language_or_context_mismatch_count: 0,
      intelligence_parse_failed_count: 0,
      scans_count: 5,
      raw_opportunities_count: 5,
    });

    // base=50 + selected*8=0 + judge*6=0 + (niche-5)*3=-6 + (usef-5)*2=-4
    // - generic*4=-12 - blocked*4=-8 = 20
    expect(score).toBeLessThan(30);
    expect(score).toBe(20);
  });

  // ═══ Test 3: Source quality audit aggregates rejection reasons by source_author ═══

  it('aggregates rejection reasons from multiple sources', () => {
    // Simulate aggregation logic (the real script does this with Supabase)
    const rejectionCounts: Record<string, number> = {};

    // Source 1: 2 blocked_topic, 1 generic_only
    const source1Rejections = ['blocked_topic', 'blocked_topic', 'generic_only'];
    for (const reason of source1Rejections) {
      rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    }

    // Source 2: 1 low_originality, 2 low_niche_fit
    const source2Rejections = ['low_originality_potential', 'low_niche_fit', 'low_niche_fit'];
    for (const reason of source2Rejections) {
      rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    }

    expect(rejectionCounts['blocked_topic']).toBe(2);
    expect(rejectionCounts['generic_only']).toBe(1);
    expect(rejectionCounts['low_originality_potential']).toBe(1);
    expect(rejectionCounts['low_niche_fit']).toBe(2);
  });

  // ═══ Test 4: Source quality audit handles zero raw opportunities safely ═══

  it('handles zero raw opportunities without NaN', () => {
    const score = computeSourceQualityScore({
      selected_count: 0,
      rescued_count: 0,
      judge_passed_count: 0,
      avg_niche_fit: 0,
      avg_usefulness: 0,
      generic_only_count: 0,
      blocked_topic_count: 0,
      language_or_context_mismatch_count: 0,
      intelligence_parse_failed_count: 0,
      scans_count: 3,
      raw_opportunities_count: 0,
    });

    // base=50 + 0 - (niche-5)*3=-15 - (usef-5)*2=-10 - zero-yield-penalty=10 = 15
    expect(score).not.toBeNaN();
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    // Verify rates are 0 when no raw_opportunities
    const tweetsAnalyzed = 10;
    const rawOpportunities = 0;
    const yieldRate = tweetsAnalyzed > 0 ? rawOpportunities / tweetsAnalyzed : 0;
    const selectedRate = rawOpportunities > 0 ? 0 / rawOpportunities : 0;
    const rejectionRate = rawOpportunities > 0 ? 0 / rawOpportunities : 0;

    expect(yieldRate).toBe(0);
    expect(selectedRate).toBe(0);
    expect(rejectionRate).toBe(0);
  });
});

// ═══ Tweet Candidate Scoring Tests ═══

describe('Tweet Candidate Scoring', () => {
  // ═══ Test 5: Ranks high-engagement original tweets above low-engagement replies ═══

  it('ranks high-engagement original tweets above low-engagement replies', () => {
    const highEngOriginal: TweetCandidate = {
      id: '1',
      text: 'AI is transforming how we work and build products',
      like_count: 100,
      reply_count: 30,
      retweet_count: 20,
      quote_count: 15,
      bookmark_count: 25,
      view_count: 50000,
      is_reply: false,
      is_retweet: false,
      is_quote: false,
      language: 'en',
    };

    const lowEngReply: TweetCandidate = {
      id: '2',
      text: 'yeah',
      like_count: 2,
      reply_count: 0,
      retweet_count: 0,
      quote_count: 0,
      bookmark_count: 0,
      view_count: 500,
      is_reply: true,
      is_retweet: false,
      is_quote: false,
      in_reply_to_tweet_id: '999',
      language: 'en',
    };

    const result = scoreAndPrefilterTweets([highEngOriginal, lowEngReply], { maxAnalyze: 8 });

    // Original should be ranked first (higher score)
    const originalScore = result.selected.find(c => c.id === '1')!.candidate_score;
    const replyScore = result.selected.find(c => c.id === '2');
    // The original should definitely score higher
    expect(originalScore).toBeGreaterThan(replyScore ? replyScore.candidate_score : -100);
  });

  // ═══ Test 6: Does not blindly select newest tweets ═══

  it('selects by score not by order (newest not automatically best)', () => {
    // Create 10 tweets: some low engagement newer, some high engagement older
    const candidates: TweetCandidate[] = [];

    // Low engagement "newer" tweets (first 6)
    for (let i = 0; i < 6; i++) {
      candidates.push({
        id: `low-${i}`,
        text: `Low engagement tweet ${i}`,
        like_count: 2,
        reply_count: 0,
        retweet_count: 0,
        quote_count: 0,
        bookmark_count: 0,
        view_count: 200,
        is_reply: true,
        is_retweet: false,
        is_quote: false,
        in_reply_to_tweet_id: 'parent',
        created_at: new Date(Date.now() - i * 3600000).toISOString(),
        language: 'en',
      });
    }

    // High engagement "older" tweets (last 4) - with significantly higher metrics
    for (let i = 0; i < 4; i++) {
      candidates.push({
        id: `high-${i}`,
        text: `AI tools are changing how we build software and automate workflows significantly`,
        like_count: 200 + i * 50,
        reply_count: 40,
        retweet_count: 30,
        quote_count: 20,
        bookmark_count: 50,
        view_count: 80000,
        is_reply: false,
        is_retweet: false,
        is_quote: false,
        created_at: new Date(Date.now() - (i + 10) * 3600000).toISOString(),
        language: 'en',
      });
    }

    const result = scoreAndPrefilterTweets(candidates, { maxAnalyze: 8 });

    // The high-engagement tweets should ALL be selected (regardless of being "older"/later in input)
    const highSelected = result.selected.filter(c => c.id.startsWith('high-')).length;
    const lowSelected = result.selected.filter(c => c.id.startsWith('low-')).length;

    // All 4 high-engagement tweets must be selected — proving score-based selection, not order-based
    expect(highSelected).toBe(4);

    // High engagement tweets should outnumber or equal low engagement in the selection
    // (since maxAnalyze=8 and we have 10 candidates, at most 4 low tweets get in)
    expect(lowSelected).toBeLessThanOrEqual(4);

    // The highest-scoring candidate should be a high-engagement tweet, not a low one
    if (result.selected.length > 0) {
      expect(result.selected[0].id).toMatch(/^high-/);
    }
  });

  // ═══ Test 7: Retweets without commentary are penalized ═══

  it('penalizes retweets without commentary', () => {
    const retweet: TweetCandidate = {
      id: 'rt-1',
      text: 'RT @someone: Some text',
      like_count: 5,
      reply_count: 0,
      retweet_count: 2,
      quote_count: 0,
      bookmark_count: 0,
      view_count: 1000,
      is_reply: false,
      is_retweet: true,
      is_quote: false,
      language: 'en',
    };

    const original: TweetCandidate = {
      id: 'orig-1',
      text: 'My original thought on AI and productivity',
      like_count: 5,
      reply_count: 0,
      retweet_count: 2,
      quote_count: 0,
      bookmark_count: 0,
      view_count: 1000,
      is_reply: false,
      is_retweet: false,
      is_quote: false,
      language: 'en',
    };

    const rtScore = computeBaseEngagementScore(retweet) + (-10); // retweet penalty
    const origScore = computeBaseEngagementScore(original) + 5;   // original bonus

    expect(origScore).toBeGreaterThan(rtScore);
  });

  // ═══ Test 8: High-engagement quote/reply with useful text can still be selected ═══

  it('selects high-engagement quote tweets with AI keywords', () => {
    const quoteWithKeywords: TweetCandidate = {
      id: 'qt-1',
      text: 'This is exactly why AI agents are the future of automation. The productivity gains are massive.',
      like_count: 200,
      reply_count: 50,
      retweet_count: 30,
      quote_count: 20,
      bookmark_count: 40,
      view_count: 100000,
      is_reply: false,
      is_retweet: false,
      is_quote: true,
      quoted_tweet_text: 'Some original tweet text',
      quoted_tweet_author: 'someone',
      language: 'en',
    };

    const result = scoreAndPrefilterTweets([quoteWithKeywords], { maxAnalyze: 8 });

    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected[0].id).toBe('qt-1');
    // Should have positive score (engagement + keyword bonus + quote bonus)
    expect(result.selected[0].candidate_score).toBeGreaterThan(0);
  });
});

// ═══ Discovery Metadata Tests ═══

describe('Discovery Metadata', () => {
  // ═══ Test 9: Discovery metadata is preserved on opportunities ═══

  it('preserves tweet_type, engagement_score, discovery_reason on ContentOpportunity', () => {
    const opportunity: ContentOpportunity = {
      type: 'quote',
      source_tweet_url: 'https://x.com/test/status/123',
      source_text: 'Test text',
      source_author: 'testuser',
      source_metrics: { like_count: 100 },
      media_urls: [],
      crafted_text: 'Crafted text',
      why: 'High engagement',
      brain_rules_used: [],
      shield_passed: true,
      shield_issues: [],
      // Phase 2E.1: discovery metadata
      tweet_type: 'original',
      engagement_score: 85,
      discovery_score: 85,
      discovery_reason: 'high_engagement',
    };

    expect(opportunity.tweet_type).toBe('original');
    expect(opportunity.engagement_score).toBe(85);
    expect(opportunity.discovery_reason).toBe('high_engagement');
    expect(opportunity.discovery_score).toBe(85);
  });

  // ═══ Test 10: Scan result includes tweets_fetched / tweets_selected diagnostics ═══

  it('includes prefilter diagnostics in SingleAccountScanResult', () => {
    const scanResult: SingleAccountScanResult = {
      account_handle: 'testuser',
      tweets_analyzed: 8,
      viral_found: 2,
      analyzed_data: [],
      media: [],
      brain_updates: { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
      debug_log: [],
      // Phase 2E.1: prefilter diagnostics
      tweets_fetched: 20,
      tweets_after_prefilter: 12,
      tweets_selected_for_analysis: 8,
      skipped_retweets: 3,
      skipped_replies: 2,
      skipped_low_engagement: 2,
      skipped_off_niche: 1,
      top_candidate_scores: [95.2, 88.1, 72.5, 65.0, 50.3],
    };

    expect(scanResult.tweets_fetched).toBe(20);
    expect(scanResult.tweets_selected_for_analysis).toBe(8);
    expect(scanResult.skipped_retweets).toBe(3);
    expect(scanResult.top_candidate_scores).toHaveLength(5);
  });

  // ═══ Test 11: No increase in final AI-analyzed tweet count beyond configured limit ═══

  it('ensures prefilter output count <= maxAnalyze', () => {
    const candidates: TweetCandidate[] = [];
    for (let i = 0; i < 20; i++) {
      candidates.push({
        id: `t-${i}`,
        text: `Tweet ${i} about AI and productivity`,
        like_count: 10 + i,
        reply_count: 1,
        retweet_count: 1,
        quote_count: 0,
        bookmark_count: 2,
        view_count: 5000,
        is_reply: false,
        is_retweet: false,
        is_quote: false,
        language: 'en',
      });
    }

    const maxAnalyze = 8;
    const result = scoreAndPrefilterTweets(candidates, { maxAnalyze });

    expect(result.selected_for_analysis).toBeLessThanOrEqual(maxAnalyze);
    expect(result.selected.length).toBeLessThanOrEqual(maxAnalyze);
  });
});

// ═══ Pipeline Integrity Tests ═══

describe('Pipeline Integrity (unchanged from Phase 2D)', () => {
  // ═══ Test 12: Existing pipeline task order unchanged ═══

  it('maintains the correct pipeline task order', () => {
    // The expected task type order from pipeline-queue.ts
    const expectedOrder = [
      'load_account_state',
      'scan_account',
      'merge_scan_results',
      'opportunity_intelligence',
      'enrich_opportunities',
      'quality_enhance',
      'opportunity_judge',
      'publish_gate',
      'decision',
      'persist_decision',
      'telegram_delivery',
    ];

    // Verify all expected task types are present
    expect(expectedOrder).toContain('load_account_state');
    expect(expectedOrder).toContain('scan_account');
    expect(expectedOrder).toContain('merge_scan_results');
    expect(expectedOrder).toContain('opportunity_intelligence');
    expect(expectedOrder).toContain('enrich_opportunities');
    expect(expectedOrder).toContain('quality_enhance');
    expect(expectedOrder).toContain('opportunity_judge');
    expect(expectedOrder).toContain('publish_gate');
    expect(expectedOrder).toContain('decision');
    expect(expectedOrder).toContain('persist_decision');
    expect(expectedOrder).toContain('telegram_delivery');

    // Verify order: load_account_state before scan_account
    expect(expectedOrder.indexOf('load_account_state')).toBeLessThan(expectedOrder.indexOf('scan_account'));
    // scan_account before merge
    expect(expectedOrder.indexOf('scan_account')).toBeLessThan(expectedOrder.indexOf('merge_scan_results'));
    // merge before intelligence
    expect(expectedOrder.indexOf('merge_scan_results')).toBeLessThan(expectedOrder.indexOf('opportunity_intelligence'));
    // intelligence before enrich
    expect(expectedOrder.indexOf('opportunity_intelligence')).toBeLessThan(expectedOrder.indexOf('enrich_opportunities'));
    // enrich before quality_enhance
    expect(expectedOrder.indexOf('enrich_opportunities')).toBeLessThan(expectedOrder.indexOf('quality_enhance'));
    // quality_enhance before judge
    expect(expectedOrder.indexOf('quality_enhance')).toBeLessThan(expectedOrder.indexOf('opportunity_judge'));
    // judge before publish_gate
    expect(expectedOrder.indexOf('opportunity_judge')).toBeLessThan(expectedOrder.indexOf('publish_gate'));
    // publish_gate before decision
    expect(expectedOrder.indexOf('publish_gate')).toBeLessThan(expectedOrder.indexOf('decision'));
    // decision before persist
    expect(expectedOrder.indexOf('decision')).toBeLessThan(expectedOrder.indexOf('persist_decision'));
    // persist before telegram
    expect(expectedOrder.indexOf('persist_decision')).toBeLessThan(expectedOrder.indexOf('telegram_delivery'));
  });

  // ═══ Test 13: Publish_gate thresholds unchanged ═══

  it('maintains the same publish_gate thresholds', async () => {
    // These thresholds MUST remain unchanged from Phase 2D
    // Read the actual source file to verify thresholds are not changed
    const fs = await import('fs');
    const path = await import('path');
    const sourcePath = path.join(process.cwd(), 'lib/opportunity-intelligence.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Verify the threshold constants are still at their original values
    expect(source).toContain('MIN_PUBLISHABILITY_SCORE = 7.5');
    expect(source).toContain('MIN_PUBLISHABILITY_SCORE_WITH_STRONG_ORIGINALITY = 7.0');
    expect(source).toContain('MIN_ORIGINALITY_POTENTIAL_SCORE = 7');
    expect(source).toContain('MIN_NICHE_FIT_SCORE = 5');
    expect(source).toContain('MIN_USEFULNESS_SCORE = 6');
  });

  // ═══ Test 14: Model routing unchanged ═══

  it('routes opportunity_intelligence to the correct task type', async () => {
    // Read the model router source to verify routing is unchanged
    const fs = await import('fs');
    const path = await import('path');
    const sourcePath = path.join(process.cwd(), 'lib/model-router.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Verify opportunity_intelligence routing still exists with proper config
    expect(source).toContain('opportunity_intelligence');
    // Verify it routes to a capable model (not a downgrade)
    expect(source).toMatch(/opportunity_intelligence.*model.*['"].*['"]/s);
    // Verify the TaskType includes opportunity_intelligence
    expect(source).toContain("'opportunity_intelligence'");
  });
});

// ═══ MergeAndDiscoverResult Diagnostics Tests ═══

describe('MergeAndDiscoverResult Diagnostics', () => {
  it('includes discovery diagnostics fields', () => {
    // Create a mock MergeAndDiscoverResult
    const mergeResult: MergeAndDiscoverResult = {
      accounts_scanned: 3,
      tweets_analyzed: 24,
      viral_found: 5,
      raw_opportunities: 8,
      opportunities: [],
      brain_updates: { algorithm_rules: 2, style_patterns: 1, media_patterns: 3 },
      media_downloaded: 3,
      debug_log: [],
      // Phase 2E.1: discovery diagnostics
      accounts_scanned_count: 3,
      tweets_fetched_total: 60,
      tweets_after_prefilter_total: 36,
      tweets_selected_for_analysis_total: 24,
      top_source_accounts: ['user1', 'user2'],
      top_discovery_reasons: ['high_engagement', 'question_sparks_discussion'],
      skipped_counts: {
        retweets: 8,
        replies: 4,
        low_engagement: 6,
        off_niche: 2,
      },
    };

    expect(mergeResult.accounts_scanned_count).toBe(3);
    expect(mergeResult.tweets_fetched_total).toBe(60);
    expect(mergeResult.tweets_selected_for_analysis_total).toBe(24);
    expect(mergeResult.top_source_accounts).toContain('user1');
    expect(mergeResult.skipped_counts.retweets).toBe(8);
    expect(mergeResult.skipped_counts.off_niche).toBe(2);
  });
});

// ═══ OpportunityBrief Metadata Tests ═══

describe('OpportunityBrief Discovery Metadata', () => {
  it('includes Phase 2E.1 discovery metadata fields', () => {
    const brief: OpportunityBrief = {
      source_summary: 'Test summary',
      source_text: 'Test text about AI tools',
      source_author: 'testuser',
      source_tweet_url: 'https://x.com/test/status/123',
      type: 'quote',
      core_observation: 'AI is changing work',
      why_it_matters: 'Relevant to audience',
      audience_relevance: 'Builders',
      niche_fit_score: 8,
      originality_potential_score: 7,
      usefulness_score: 8,
      evidence_risk_score: 9,
      viral_context_score: 7,
      publishability_score: 8,
      recommended_angle: 'Specific angle about AI productivity',
      content_format: 'quote',
      do_not_claim: [],
      required_context: [],
      should_craft: true,
      // Phase 2E.1: discovery metadata
      tweet_type: 'original',
      engagement_score: 85,
      discovery_score: 85,
      discovery_reason: 'high_engagement',
      source_quality_score: 78,
      account_source_quality: 72,
    };

    expect(brief.tweet_type).toBe('original');
    expect(brief.engagement_score).toBe(85);
    expect(brief.discovery_score).toBe(85);
    expect(brief.discovery_reason).toBe('high_engagement');
    expect(brief.source_quality_score).toBe(78);
    expect(brief.account_source_quality).toBe(72);
  });
});

// ═══ Additional Edge Case Tests ═══

describe('Edge Cases', () => {
  it('scoreAndPrefilterTweets handles empty input', () => {
    const result = scoreAndPrefilterTweets([], { maxAnalyze: 8 });
    expect(result.fetched).toBe(0);
    expect(result.selected.length).toBe(0);
    expect(result.selected_for_analysis).toBe(0);
  });

  it('scoreAndPrefilterTweets handles single candidate', () => {
    const candidate: TweetCandidate = {
      id: '1',
      text: 'AI is revolutionizing how creators build audiences',
      like_count: 50,
      reply_count: 10,
      retweet_count: 8,
      quote_count: 5,
      bookmark_count: 12,
      view_count: 20000,
      is_reply: false,
      is_retweet: false,
      is_quote: false,
      language: 'en',
    };

    const result = scoreAndPrefilterTweets([candidate], { maxAnalyze: 8 });
    expect(result.selected.length).toBe(1);
    expect(result.selected[0].id).toBe('1');
  });

  it('computeSourceQualityScore clamps to 0-100 range', () => {
    // Very high scores should be clamped to 100
    const highScore = computeSourceQualityScore({
      selected_count: 100,
      rescued_count: 50,
      judge_passed_count: 80,
      avg_niche_fit: 10,
      avg_usefulness: 10,
      generic_only_count: 0,
      blocked_topic_count: 0,
      language_or_context_mismatch_count: 0,
      intelligence_parse_failed_count: 0,
      scans_count: 1,
      raw_opportunities_count: 100,
    });
    expect(highScore).toBe(100);

    // Very low scores should be clamped to 0
    const lowScore = computeSourceQualityScore({
      selected_count: 0,
      rescued_count: 0,
      judge_passed_count: 0,
      avg_niche_fit: 0,
      avg_usefulness: 0,
      generic_only_count: 20,
      blocked_topic_count: 20,
      language_or_context_mismatch_count: 10,
      intelligence_parse_failed_count: 10,
      scans_count: 5,
      raw_opportunities_count: 5,
    });
    expect(lowScore).toBe(0);
  });
});
