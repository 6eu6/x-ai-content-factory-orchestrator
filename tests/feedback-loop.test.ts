import { describe, expect, it } from 'vitest';
import { extractTweetUrl } from '../lib/telegram';

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
