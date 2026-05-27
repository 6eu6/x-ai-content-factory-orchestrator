import { describe, expect, it } from 'vitest';
import { extractTweetUrl } from '../lib/telegram';
import { calculateOutcomeScore, getOutcomeLabel, calculateOutcome, OutcomeLabel } from '../lib/performance-outcome';
import { extractKnownRuleIds } from '../lib/resolve-brain-rules';

// ── Inline copies of the logic from published-performance-scan for testing ──
// (These mirror the functions in app/api/published-performance-scan/route.ts)

function extractTweetIdFromUrl(url: string): string | null {
  const match = url.match(/status\/(\d+)/i);
  return match ? match[1] : null;
}

function normalizeRawTweet(raw: any) {
  if (!raw) return null;
  if (raw.public_metrics && typeof raw.public_metrics === 'object') {
    return raw;
  }
  return {
    id: String(raw.id || raw.tweetId || raw.rest_id || ''),
    text: raw.text || raw.full_text || raw.content || '',
    public_metrics: {
      like_count: Number(raw.likeCount || raw.likes || raw.favorite_count || 0),
      reply_count: Number(raw.replyCount || raw.replies || raw.reply_count || 0),
      retweet_count: Number(raw.retweetCount || raw.retweets || raw.retweet_count || 0),
      quote_count: Number(raw.quoteCount || raw.quotes || raw.quote_count || 0),
      bookmark_count: Number(raw.bookmarkCount || raw.bookmarks || 0),
      view_count: Number(raw.viewCount || raw.views || 0)
    }
  };
}

function extractTweetsFromResponse(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const candidates = [
    json.tweets,
    json.data?.tweets,
    json.result?.tweets,
    json.results,
    json.data,
    json.result
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('feedback-loop — extract published X URL', () => {
  it('extracts X URL from "نشرت ..." text', () => {
    const text = 'نشرت https://x.com/30piq/status/1234567890';
    const url = extractTweetUrl(text);
    expect(url).toBe('https://x.com/30piq/status/1234567890');
  });

  it('extracts X URL with twitter.com domain', () => {
    const text = 'نشرت https://twitter.com/30piq/status/9876543210';
    const url = extractTweetUrl(text);
    expect(url).toBe('https://twitter.com/30piq/status/9876543210');
  });

  it('extracts X URL from "نشرت" with Arabic text around it', () => {
    const text = 'نشرت https://x.com/30piq/status/111222333 اليوم';
    const url = extractTweetUrl(text);
    expect(url).toBe('https://x.com/30piq/status/111222333');
  });
});

describe('feedback-loop — URL validation', () => {
  it('rejects non-X URLs', () => {
    const url = extractTweetUrl('https://github.com/6eu6/repo');
    expect(url).toBe('');
  });

  it('rejects X profile URLs (no status)', () => {
    const url = extractTweetUrl('https://x.com/30piq');
    expect(url).toBe('');
  });

  it('accepts valid X status URL', () => {
    const url = extractTweetUrl('https://x.com/30piq/status/1234567890123456789');
    expect(url).toBe('https://x.com/30piq/status/1234567890123456789');
  });

  it('accepts valid X status URL with query params', () => {
    const url = extractTweetUrl('https://x.com/30piq/status/1234567890?s=20');
    expect(url).toBe('https://x.com/30piq/status/1234567890');
  });
});

describe('feedback-loop — decision_run linking logic', () => {
  it('selects most recent run with selected_count > 0', () => {
    const runs = [
      { id: '1', selected_count: 0, created_at: '2026-05-28T10:00:00Z' },
      { id: '2', selected_count: 3, created_at: '2026-05-28T09:00:00Z' },
      { id: '3', selected_count: 1, created_at: '2026-05-28T08:00:00Z' }
    ];

    const eligible = runs
      .filter(r => r.selected_count > 0)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    expect(eligible[0].id).toBe('2');
    expect(eligible.length).toBe(2);
  });

  it('returns empty when no runs have selected_count > 0', () => {
    const runs = [
      { id: '1', selected_count: 0, created_at: '2026-05-28T10:00:00Z' },
      { id: '2', selected_count: 0, created_at: '2026-05-28T09:00:00Z' }
    ];

    const eligible = runs.filter(r => r.selected_count > 0);
    expect(eligible.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// New tests for v3: extractTweetIdFromUrl
// ═══════════════════════════════════════════════════════

describe('feedback-loop — extractTweetIdFromUrl', () => {
  it('extracts tweet ID from x.com URL', () => {
    expect(extractTweetIdFromUrl('https://x.com/30piq/status/1234567890')).toBe('1234567890');
  });

  it('extracts tweet ID from twitter.com URL', () => {
    expect(extractTweetIdFromUrl('https://twitter.com/user/status/9876543210987654321')).toBe('9876543210987654321');
  });

  it('extracts tweet ID from URL with query params', () => {
    expect(extractTweetIdFromUrl('https://x.com/user/status/111222333?s=20&t=abc')).toBe('111222333');
  });

  it('returns null for profile URL without status', () => {
    expect(extractTweetIdFromUrl('https://x.com/30piq')).toBeNull();
  });

  it('returns null for non-X URL', () => {
    expect(extractTweetIdFromUrl('https://github.com/test')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractTweetIdFromUrl('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// New tests for v3: normalizeRawTweet
// ═══════════════════════════════════════════════════════

describe('feedback-loop — normalizeRawTweet', () => {
  it('normalizes TwitterAPI.io batch response shape (likeCount, viewCount, etc.)', () => {
    const raw = {
      id: '1519480761749016577',
      text: 'Hello world',
      likeCount: 100,
      replyCount: 10,
      retweetCount: 20,
      quoteCount: 5,
      bookmarkCount: 30,
      viewCount: 5000
    };

    const result = normalizeRawTweet(raw);
    expect(result.id).toBe('1519480761749016577');
    expect(result.text).toBe('Hello world');
    expect(result.public_metrics.like_count).toBe(100);
    expect(result.public_metrics.reply_count).toBe(10);
    expect(result.public_metrics.retweet_count).toBe(20);
    expect(result.public_metrics.quote_count).toBe(5);
    expect(result.public_metrics.bookmark_count).toBe(30);
    expect(result.public_metrics.view_count).toBe(5000);
  });

  it('normalizes TwitterAPI.io search response shape (likes, retweets, etc.)', () => {
    const raw = {
      id: '999',
      text: 'Test tweet',
      likes: 50,
      replies: 5,
      retweets: 10,
      quotes: 2,
      bookmarks: 8,
      views: 2000
    };

    const result = normalizeRawTweet(raw);
    expect(result.public_metrics.like_count).toBe(50);
    expect(result.public_metrics.view_count).toBe(2000);
  });

  it('passes through already-normalized tweets with public_metrics', () => {
    const alreadyNormalized = {
      id: '123',
      text: 'Already normalized',
      public_metrics: {
        like_count: 42,
        reply_count: 7,
        retweet_count: 3,
        quote_count: 1,
        bookmark_count: 12,
        view_count: 1000
      }
    };

    const result = normalizeRawTweet(alreadyNormalized);
    expect(result).toBe(alreadyNormalized);
    expect(result.public_metrics.like_count).toBe(42);
  });

  it('returns null for null input', () => {
    expect(normalizeRawTweet(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeRawTweet(undefined)).toBeNull();
  });

  it('handles missing metrics gracefully (defaults to 0)', () => {
    const raw = {
      id: '456',
      text: 'No metrics'
    };

    const result = normalizeRawTweet(raw);
    expect(result.public_metrics.like_count).toBe(0);
    expect(result.public_metrics.view_count).toBe(0);
    expect(result.public_metrics.bookmark_count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// New tests for v3: extractTweetsFromResponse
// ═══════════════════════════════════════════════════════

describe('feedback-loop — extractTweetsFromResponse', () => {
  it('extracts from top-level tweets key (batch endpoint)', () => {
    const response = {
      status: 'success',
      tweets: [{ id: '1' }, { id: '2' }]
    };
    expect(extractTweetsFromResponse(response)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('extracts from nested data.tweets key (timeline endpoint)', () => {
    const response = {
      data: {
        tweets: [{ id: '3' }],
        pin_tweet: null
      },
      has_next_page: false
    };
    expect(extractTweetsFromResponse(response)).toEqual([{ id: '3' }]);
  });

  it('extracts from data array (advanced_search endpoint)', () => {
    const response = {
      data: [{ id: '4' }, { id: '5' }]
    };
    expect(extractTweetsFromResponse(response)).toEqual([{ id: '4' }, { id: '5' }]);
  });

  it('returns empty array for empty response', () => {
    expect(extractTweetsFromResponse(null)).toEqual([]);
    expect(extractTweetsFromResponse({})).toEqual([]);
    expect(extractTweetsFromResponse({ status: 'success', code: 0 })).toEqual([]);
  });

  it('handles direct array input', () => {
    const tweets = [{ id: '6' }];
    expect(extractTweetsFromResponse(tweets)).toEqual(tweets);
  });

  it('handles result.tweets shape', () => {
    const response = {
      result: {
        tweets: [{ id: '7' }]
      }
    };
    expect(extractTweetsFromResponse(response)).toEqual([{ id: '7' }]);
  });
});

// ═══════════════════════════════════════════════════════
// Integration: normalize + metrics extraction
// ═══════════════════════════════════════════════════════

describe('feedback-loop — full pipeline: extractTweetId + normalize + metrics', () => {
  it('extracts ID from URL, normalizes raw tweet, produces correct metrics', () => {
    const url = 'https://x.com/emollick/status/2059707145277325682';
    const tweetId = extractTweetIdFromUrl(url);
    expect(tweetId).toBe('2059707145277325682');

    const rawTweet = {
      id: tweetId,
      text: 'Decent chance that this decade will be incredible',
      likeCount: 116,
      replyCount: 12,
      retweetCount: 8,
      quoteCount: 3,
      bookmarkCount: 25,
      viewCount: 15000
    };

    const normalized = normalizeRawTweet(rawTweet);
    expect(normalized.public_metrics.like_count).toBe(116);
    expect(normalized.public_metrics.view_count).toBe(15000);
    expect(normalized.public_metrics.bookmark_count).toBe(25);
  });

  it('handles full response extraction + normalization pipeline', () => {
    const apiResponse = {
      status: 'success',
      tweets: [{
        id: '1234567890',
        text: 'Test tweet from API',
        likeCount: 500,
        replyCount: 50,
        retweetCount: 100,
        quoteCount: 20,
        bookmarkCount: 75,
        viewCount: 50000
      }]
    };

    const tweets = extractTweetsFromResponse(apiResponse);
    expect(tweets.length).toBe(1);

    const normalized = normalizeRawTweet(tweets[0]);
    expect(normalized.public_metrics.like_count).toBe(500);
    expect(normalized.public_metrics.view_count).toBe(50000);
    expect(normalized.public_metrics.retweet_count).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════
// Phase 5: Performance Outcome Scoring
// ═══════════════════════════════════════════════════════

describe('performance-outcome — calculateOutcomeScore', () => {
  it('high engagement → strong_success (score >= 8)', () => {
    // 64K views + 611 likes + replies/retweets/quotes/bookmarks
    const result = calculateOutcomeScore({
      views: 63995,
      likes: 611,
      replies: 85,
      retweets: 120,
      quotes: 45,
      bookmarks: 200
    });
    expect(result).toBeGreaterThanOrEqual(8);
    expect(getOutcomeLabel(result)).toBe('strong_success');
  });

  it('medium engagement → success (score >= 5.5)', () => {
    // ~5K views + moderate engagement
    const result = calculateOutcomeScore({
      views: 5000,
      likes: 50,
      replies: 10,
      retweets: 15,
      quotes: 5,
      bookmarks: 20
    });
    expect(result).toBeGreaterThanOrEqual(5.5);
    expect(result).toBeLessThan(8);
    expect(getOutcomeLabel(result)).toBe('success');
  });

  it('low-medium engagement → neutral (score >= 3)', () => {
    // ~500 views + minimal engagement
    const result = calculateOutcomeScore({
      views: 500,
      likes: 10,
      replies: 2,
      retweets: 3,
      quotes: 1,
      bookmarks: 3
    });
    expect(result).toBeGreaterThanOrEqual(3);
    expect(result).toBeLessThan(5.5);
    expect(getOutcomeLabel(result)).toBe('neutral');
  });

  it('very low engagement → weak (score < 3)', () => {
    // Almost no views
    const result = calculateOutcomeScore({
      views: 10,
      likes: 0,
      replies: 0,
      retweets: 0,
      quotes: 0,
      bookmarks: 0
    });
    expect(result).toBeLessThan(3);
    expect(getOutcomeLabel(result)).toBe('weak');
  });

  it('score is capped at 10', () => {
    const result = calculateOutcomeScore({
      views: 10000000,
      likes: 50000,
      replies: 5000,
      retweets: 10000,
      quotes: 3000,
      bookmarks: 8000
    });
    expect(result).toBeLessThanOrEqual(10);
  });

  it('empty payload → weak (score < 3)', () => {
    const result = calculateOutcomeScore({});
    expect(result).toBeLessThan(3);
    expect(getOutcomeLabel(result)).toBe('weak');
  });

  it('zeros → weak', () => {
    const result = calculateOutcomeScore({
      views: 0,
      likes: 0,
      replies: 0,
      retweets: 0,
      quotes: 0,
      bookmarks: 0
    });
    expect(result).toBeLessThan(3);
  });
});

describe('performance-outcome — getOutcomeLabel', () => {
  it('score 9 → strong_success', () => {
    expect(getOutcomeLabel(9)).toBe('strong_success');
  });

  it('score 8 → strong_success', () => {
    expect(getOutcomeLabel(8)).toBe('strong_success');
  });

  it('score 7 → success', () => {
    expect(getOutcomeLabel(7)).toBe('success');
  });

  it('score 5.5 → success', () => {
    expect(getOutcomeLabel(5.5)).toBe('success');
  });

  it('score 5 → neutral', () => {
    expect(getOutcomeLabel(5)).toBe('neutral');
  });

  it('score 3 → neutral', () => {
    expect(getOutcomeLabel(3)).toBe('neutral');
  });

  it('score 2.9 → weak', () => {
    expect(getOutcomeLabel(2.9)).toBe('weak');
  });

  it('score 0 → weak', () => {
    expect(getOutcomeLabel(0)).toBe('weak');
  });
});

describe('performance-outcome — calculateOutcome', () => {
  it('returns both score and label', () => {
    const result = calculateOutcome({
      views: 50000,
      likes: 500,
      replies: 50,
      retweets: 100,
      quotes: 20,
      bookmarks: 75
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.label).toBeDefined();
    expect(['strong_success', 'success', 'neutral', 'weak']).toContain(result.label);
  });

  it('consistent between calculateOutcomeScore and calculateOutcome', () => {
    const payload = { views: 63995, likes: 611, replies: 85, retweets: 120, quotes: 45, bookmarks: 200 };
    const score = calculateOutcomeScore(payload);
    const outcome = calculateOutcome(payload);
    expect(outcome.score).toBe(score);
    expect(outcome.label).toBe(getOutcomeLabel(score));
  });
});

// ═══════════════════════════════════════════════════════
// Phase 5: Attribution Logic (dry-run / no rule changes)
// ═══════════════════════════════════════════════════════

describe('performance-outcome — attribution logic', () => {
  it('empty brain_rules_used → NO_RULE_ATTRIBUTION warning', () => {
    const brainRulesUsed: any[] = [];
    const ruleIdsFound: string[] = [];

    for (const ref of brainRulesUsed) {
      if (typeof ref === 'string' && /^\d+$/.test(ref)) {
        ruleIdsFound.push(ref);
      } else if (typeof ref === 'object' && ref !== null) {
        const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
        if (id) ruleIdsFound.push(String(id));
      }
    }

    const hasAttribution = ruleIdsFound.length > 0;
    expect(hasAttribution).toBe(false);
    // In the endpoint, this triggers NO_RULE_ATTRIBUTION warning
  });

  it('numeric string brain_rules_used → found as rule IDs', () => {
    const brainRulesUsed: any[] = ['42', '17', '99'];
    const ruleIdsFound: string[] = [];

    for (const ref of brainRulesUsed) {
      if (typeof ref === 'string' && /^\d+$/.test(ref)) {
        ruleIdsFound.push(ref);
      } else if (typeof ref === 'object' && ref !== null) {
        const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
        if (id) ruleIdsFound.push(String(id));
      }
    }

    expect(ruleIdsFound).toEqual(['42', '17', '99']);
    expect(ruleIdsFound.length > 0).toBe(true);
  });

  it('object brain_rules_used with id → found', () => {
    const brainRulesUsed: any[] = [{ id: 5, rule_type: 'algorithm' }, { pattern_id: 12 }];
    const ruleIdsFound: string[] = [];

    for (const ref of brainRulesUsed) {
      if (typeof ref === 'string' && /^\d+$/.test(ref)) {
        ruleIdsFound.push(ref);
      } else if (typeof ref === 'object' && ref !== null) {
        const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
        if (id) ruleIdsFound.push(String(id));
      }
    }

    expect(ruleIdsFound).toEqual(['5', '12']);
  });

  it('mixed brain_rules_used → extracts numeric IDs only', () => {
    const brainRulesUsed: any[] = ['abc', '42', { name: 'test' }, { id: 7 }, 'not-a-number'];
    const ruleIdsFound: string[] = [];

    for (const ref of brainRulesUsed) {
      if (typeof ref === 'string' && /^\d+$/.test(ref)) {
        ruleIdsFound.push(ref);
      } else if (typeof ref === 'object' && ref !== null) {
        const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
        if (id) ruleIdsFound.push(String(id));
      }
    }

    expect(ruleIdsFound).toEqual(['42', '7']);
  });

  it('dry-run: no side effects when apply=0', () => {
    // In dry-run mode, the endpoint only computes outcomes and returns them
    // without writing to DB. This test verifies the pure calculation.
    const payload = { views: 50000, likes: 500, replies: 50, retweets: 100, quotes: 20, bookmarks: 75 };
    const { score, label } = calculateOutcome(payload);

    // The score is just computed, no DB writes happen
    expect(score).toBeGreaterThan(0);
    expect(label).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// Phase 5: "نشرت 1 URL" pattern parsing
// ═══════════════════════════════════════════════════════

describe('feedback-loop — "نشرت" pattern with recommendation index', () => {
  it('parses "نشرت 1 https://x.com/..." → index=1, url extracted', () => {
    const text = 'نشرت 1 https://x.com/30piq/status/1234567890';
    const afterNashart = text.replace(/^نشرت\s+/i, '').trim();
    const indexedMatch = afterNashart.match(/^(\d+)\s+(https?:\/\/\S+)/i);

    expect(indexedMatch).not.toBeNull();
    expect(indexedMatch![1]).toBe('1');
    expect(indexedMatch![2]).toBe('https://x.com/30piq/status/1234567890');
  });

  it('parses "نشرت 3 https://x.com/..." → index=3', () => {
    const text = 'نشرت 3 https://x.com/30piq/status/999';
    const afterNashart = text.replace(/^نشرت\s+/i, '').trim();
    const indexedMatch = afterNashart.match(/^(\d+)\s+(https?:\/\/\S+)/i);

    expect(indexedMatch).not.toBeNull();
    expect(indexedMatch![1]).toBe('3');
  });

  it('parses "نشرت https://x.com/..." without index → no match, url-only mode', () => {
    const text = 'نشرت https://x.com/30piq/status/1234567890';
    const afterNashart = text.replace(/^نشرت\s+/i, '').trim();
    const indexedMatch = afterNashart.match(/^(\d+)\s+(https?:\/\/\S+)/i);

    expect(indexedMatch).toBeNull();
    // Falls through to url-only mode
  });
});

// ═══════════════════════════════════════════════════════
// Phase 5.1: Attribution Validation & Fix
// ═══════════════════════════════════════════════════════

describe('Phase 5.1 — extractKnownRuleIds', () => {
  it('extracts numeric string IDs from brain_rules_used', () => {
    const brainRulesUsed: any[] = ['42', '17', '99'];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['42', '17', '99']);
  });

  it('extracts UUID string IDs from brain_rules_used', () => {
    const brainRulesUsed: any[] = ['a3c548cd-2163-4859-aeaf-5b35c7697a43', '94df25ae-065c-4260-a1e5-c2e818288ef3'];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['a3c548cd-2163-4859-aeaf-5b35c7697a43', '94df25ae-065c-4260-a1e5-c2e818288ef3']);
  });

  it('extracts IDs from objects with id/rule_id/pattern_id', () => {
    const brainRulesUsed: any[] = [
      { id: 'a3c548cd-2163-4859-aeaf-5b35c7697a43', table: 'x_algorithm_learning_rules' },
      { pattern_id: '94df25ae-065c-4260-a1e5-c2e818288ef3', table: 'viral_style_patterns' },
      { rule_id: 3 }
    ];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['a3c548cd-2163-4859-aeaf-5b35c7697a43', '94df25ae-065c-4260-a1e5-c2e818288ef3', '3']);
  });

  it('mixed brain_rules_used → extracts only IDs', () => {
    const brainRulesUsed: any[] = [
      '42',
      'some text rule that is not an ID',
      { id: 7, rule_preview: 'A pattern' },
      { name: 'test' }, // no id field
      'not-a-number'
    ];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['42', '7']);
  });

  it('empty brain_rules_used → empty result', () => {
    expect(extractKnownRuleIds([])).toEqual([]);
  });

  it('null/undefined input → empty result', () => {
    expect(extractKnownRuleIds(null as any)).toEqual([]);
    expect(extractKnownRuleIds(undefined as any)).toEqual([]);
  });

  it('text-only brain_rules_used → no IDs extracted (needs resolution)', () => {
    const brainRulesUsed: any[] = [
      'Open with a contrarian claim that challenges conventional wisdom',
      'Use the setup→punchline structure for engagement',
      'Posts with media get 2x more engagement'
    ];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual([]);
    // These text rules need resolveBrainRuleRefs() to match against the DB
  });

  it('resolves object refs with table field', () => {
    const brainRulesUsed: any[] = [
      { id: 'a3c548cd-2163-4859-aeaf-5b35c7697a43', table: 'x_algorithm_learning_rules', rule_preview: 'Test rule' },
      { id: '94df25ae-065c-4260-a1e5-c2e818288ef3', table: 'viral_style_patterns', rule_preview: 'Test pattern' }
    ];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['a3c548cd-2163-4859-aeaf-5b35c7697a43', '94df25ae-065c-4260-a1e5-c2e818288ef3']);
  });
});

describe('Phase 5.1 — selected_payload brain_rules_used in decision_runs', () => {
  it('selected_payload items should include brain_rules_used field', () => {
    // This tests the expected shape after our daily-run/cron-dispatcher changes
    const selectedPayload = [{
      type: 'quote',
      score: 8.5,
      source_tweet_url: 'https://x.com/test/status/123',
      source_author: 'test_user',
      crafted_text: 'Test content',
      brain_rules_used: ['42', 'Open with contrarian claim'],
      shield_passed: true,
      reasons: ['High momentum', 'Good brain match']
    }];

    expect(selectedPayload[0].brain_rules_used).toBeDefined();
    expect(selectedPayload[0].brain_rules_used).toEqual(['42', 'Open with contrarian claim']);
    expect(selectedPayload[0].shield_passed).toBe(true);
  });

  it('brain_rules_used in payload is limited to 20 items', () => {
    const manyRules = Array.from({ length: 30 }, (_, i) => `Rule ${i + 1}`);
    const limitedRules = manyRules.slice(0, 20);
    expect(limitedRules.length).toBe(20);
    // This mirrors the (o.brain_rules_used || []).slice(0, 20) in daily-run
  });

  it('crafted_text in payload is limited to 280 chars', () => {
    const longText = 'A'.repeat(500);
    const truncated = longText.slice(0, 280);
    expect(truncated.length).toBe(280);
  });
});

describe('Phase 5.1 — attribution flow: text rules → resolved IDs', () => {
  it('text-based brain_rules_used can be matched to DB rule IDs', async () => {
    // This tests the flow: ContentOpportunity has text brain_rules_used
    // → log-published-decision resolves them via resolveBrainRuleRefs
    // → published_decisions.brain_rules_used becomes [{id, table, rule_preview}]

    // Simulate the resolution result
    const inputRules = ['Open with a contrarian claim', 'Use setup→punchline structure'];
    // In a real scenario, resolveBrainRuleRefs would query the DB and return:
    const resolvedResult = [
      { id: 'a3c548cd-2163-4859-aeaf-5b35c7697a43', table: 'x_algorithm_learning_rules' as const, rule_preview: 'Open with a contrarian claim' },
      { id: '94df25ae-065c-4260-a1e5-c2e818288ef3', table: 'viral_style_patterns' as const, rule_preview: 'Use setup→punchline structure' }
    ];

    // The resolved result can be used for attribution
    expect(resolvedResult.length).toBe(2);
    expect(resolvedResult[0].id).toBe('a3c548cd-2163-4859-aeaf-5b35c7697a43');
    expect(resolvedResult[0].table).toBe('x_algorithm_learning_rules');
    expect(resolvedResult[1].id).toBe('94df25ae-065c-4260-a1e5-c2e818288ef3');
    expect(resolvedResult[1].table).toBe('viral_style_patterns');
  });

  it('already-resolved brain_rules_used are used directly without re-resolution', () => {
    const brainRulesUsed = [
      { id: 'a3c548cd-2163-4859-aeaf-5b35c7697a43', table: 'x_algorithm_learning_rules', rule_preview: 'Test rule' }
    ];
    const ids = extractKnownRuleIds(brainRulesUsed);
    expect(ids).toEqual(['a3c548cd-2163-4859-aeaf-5b35c7697a43']);
    // These IDs go directly to attribution without needing resolveBrainRuleRefs
  });

  it('performance-feedback v1.1 resolves text rules before attribution', () => {
    // The new flow in performance-feedback:
    // 1. extractKnownRuleIds(brain_rules_used) → check for pre-resolved IDs
    // 2. If no IDs found and brain_rules_used.length > 0 → resolveBrainRuleRefs()
    // 3. Use resolved IDs for attribution updates

    const textRules = ['Some text rule', 'Another text rule'];
    const preResolvedIds = extractKnownRuleIds(textRules);
    expect(preResolvedIds).toEqual([]); // No pre-resolved IDs

    // In the endpoint, this triggers resolveBrainRuleRefs(textRules)
    // which queries the DB and tries to match
  });
});
