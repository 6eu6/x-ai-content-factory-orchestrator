import { describe, it, expect } from 'vitest';
import { scoreXTweet, cleanTwitterApiKey } from '../lib/x';

describe('scoreXTweet', () => {
  it('weights engagement types correctly', () => {
    const tweet = {
      public_metrics: {
        like_count: 10,
        reply_count: 2,
        retweet_count: 3,
        quote_count: 1,
        bookmark_count: 5,
        view_count: 10000
      }
    };
    // 10 + 2*2 + 3*3 + 1*4 + 5*2 + min(10000,100000)/1000
    expect(scoreXTweet(tweet)).toBe(10 + 4 + 9 + 4 + 10 + 10);
  });

  it('handles missing metrics', () => {
    expect(scoreXTweet({})).toBe(0);
  });

  it('caps view contribution at 100k views', () => {
    const a = scoreXTweet({ public_metrics: { view_count: 100000 } });
    const b = scoreXTweet({ public_metrics: { view_count: 500000 } });
    expect(a).toBe(b);
  });
});

describe('cleanTwitterApiKey', () => {
  it('strips Bearer prefix and quotes', () => {
    expect(cleanTwitterApiKey('Bearer abc123')).toBe('abc123');
    expect(cleanTwitterApiKey('"abc123"')).toBe('abc123');
    expect(cleanTwitterApiKey("  'key' ")).toBe('key');
  });
});
