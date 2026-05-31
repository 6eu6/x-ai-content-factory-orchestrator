import { describe, expect, it } from 'vitest';
import {
  containsArabic,
  looksJsonish,
  isValidXStatusUrl,
  isAISlopWrapper,
  isEnglishPublishableText,
  filterPublishableOpportunities
} from '../lib/content-policy';

describe('content-policy: containsArabic', () => {
  it('detects Arabic unicode range', () => {
    expect(containsArabic('هذا نص عربي')).toBe(true);
    expect(containsArabic('مقترح من العقل')).toBe(true);
    expect(containsArabic('اكتب تغريدة')).toBe(true);
  });

  it('passes clean English text', () => {
    expect(containsArabic('The best way to build a system is to start small.')).toBe(false);
    expect(containsArabic('')).toBe(false);
  });

  it('passes text with numbers and symbols only', () => {
    expect(containsArabic('12345 !@#$%')).toBe(false);
  });
});

describe('content-policy: looksJsonish', () => {
  it('detects JSON object wrappers', () => {
    expect(looksJsonish('{"tweet": "hello"}')).toBe(true);
    expect(looksJsonish('{"text": "something"}')).toBe(true);
    expect(looksJsonish('[1, 2, 3]')).toBe(true);
  });

  it('passes clean prose', () => {
    expect(looksJsonish('The most important thing is consistency.')).toBe(false);
    expect(looksJsonish('A simple tweet about productivity.')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(looksJsonish('')).toBe(false);
    expect(looksJsonish('  ')).toBe(false);
  });
});

describe('content-policy: isValidXStatusUrl', () => {
  it('accepts valid x.com and twitter.com status URLs', () => {
    expect(isValidXStatusUrl('https://x.com/naval/status/1234567890')).toBe(true);
    expect(isValidXStatusUrl('https://twitter.com/emollick/status/9876543210')).toBe(true);
    expect(isValidXStatusUrl('https://www.x.com/30piq/status/111222333')).toBe(true);
    expect(isValidXStatusUrl('https://x.com/user_name/status/999?q=1')).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(isValidXStatusUrl('https://x.com/naval')).toBe(false);
    expect(isValidXStatusUrl('https://example.com/status/123')).toBe(false);
    expect(isValidXStatusUrl('not-a-url')).toBe(false);
    expect(isValidXStatusUrl('')).toBe(false);
    expect(isValidXStatusUrl('https://x.com/a/status/123')).toBe(true); // 1-char username is valid
  });

  it('rejects URLs without status path', () => {
    expect(isValidXStatusUrl('https://x.com/naval/likes')).toBe(false);
    expect(isValidXStatusUrl('https://x.com/naval/status/')).toBe(false);
  });
});

describe('content-policy: isAISlopWrapper', () => {
  it('rejects "Here is" patterns', () => {
    expect(isAISlopWrapper("Here is your tweet").ok).toBe(false);
    expect(isAISlopWrapper("Here's the content").ok).toBe(false);
  });

  it('rejects "Sure," patterns', () => {
    expect(isAISlopWrapper('Sure, here is a tweet').ok).toBe(false);
    expect(isAISlopWrapper('Sure. Let me write that').ok).toBe(false);
  });

  it('rejects prefix labels like "Tweet:", "Reply:"', () => {
    expect(isAISlopWrapper('Tweet: This is a tweet').ok).toBe(false);
    expect(isAISlopWrapper('Final tweet: Something').ok).toBe(false);
    expect(isAISlopWrapper('Reply: Good point').ok).toBe(false);
    expect(isAISlopWrapper('Quote: Original insight').ok).toBe(false);
  });

  it('rejects markdown code fences', () => {
    expect(isAISlopWrapper('```\nsome code\n```').ok).toBe(false);
  });

  it('rejects instruction-like text', () => {
    expect(isAISlopWrapper('Write a tweet about AI').ok).toBe(false);
    expect(isAISlopWrapper('Generate a thread on productivity').ok).toBe(false);
    expect(isAISlopWrapper('Create a quote about systems').ok).toBe(false);
  });

  it('accepts clean publishable text', () => {
    expect(isAISlopWrapper('The best systems are the ones you actually follow through on.').ok).toBe(true);
    expect(isAISlopWrapper('Most people overcomplicate their morning routine. A 10-minute walk is enough.').ok).toBe(true);
  });
});

describe('content-policy: isEnglishPublishableText', () => {
  it('rejects Arabic content', () => {
    const result = isEnglishPublishableText('هذا المحتوى العربي لا يجب نشره على حساب إنجليزي');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('arabic_content_detected');
  });

  it('rejects JSON wrappers', () => {
    const result = isEnglishPublishableText('{"tweet": "This is wrapped in JSON"}');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('json_or_metadata_output');
  });

  it('rejects too-short content', () => {
    const result = isEnglishPublishableText('Short');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_short');
  });

  it('rejects too-long content', () => {
    const longText = 'A'.repeat(1201);
    const result = isEnglishPublishableText(longText);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_long');
  });

  it('rejects AI slop patterns', () => {
    const result = isEnglishPublishableText('Here is your tweet about productivity and systems thinking.');
    expect(result.ok).toBe(false);
  });

  it('accepts clean English publishable text', () => {
    const result = isEnglishPublishableText('The best way to build a system is to start small and iterate. Consistency beats intensity.');
    expect(result.ok).toBe(true);
  });
});

describe('content-policy: filterPublishableOpportunities', () => {
  it('rejects opportunities where shield_passed !== true', () => {
    const result = filterPublishableOpportunities([
      { type: 'quote', crafted_text: 'Good content about systems thinking.', shield_passed: false, shield_issues: ['hashtag'] }
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('shield_not_passed');
  });

  it('rejects Arabic content even if shield passed', () => {
    const result = filterPublishableOpportunities([
      { type: 'quote', crafted_text: 'هذا محتوى عربي', shield_passed: true, shield_issues: [] }
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('arabic_content_detected');
  });

  it('rejects JSON wrapper content even if shield passed', () => {
    const result = filterPublishableOpportunities([
      { type: 'quote', crafted_text: '{"tweet": "wrapped content"}', shield_passed: true, shield_issues: [] }
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('json_or_metadata_output');
  });

  it('rejects reply/quote with invalid source_tweet_url', () => {
    const result = filterPublishableOpportunities([
      { type: 'reply', crafted_text: 'Great point about building in public. Consistency matters.', source_tweet_url: 'https://example.com/not-x', shield_passed: true, shield_issues: [] },
      { type: 'quote', crafted_text: 'This is a solid insight about learning curves.', source_tweet_url: 'invalid-url', shield_passed: true, shield_issues: [] }
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every(r => r.reason === 'invalid_source_tweet_url')).toBe(true);
  });

  it('accepts clean English publishable text with valid source URL', () => {
    const result = filterPublishableOpportunities([
      {
        type: 'quote',
        crafted_text: 'The best systems are the ones you actually follow through on. Start simple.',
        source_tweet_url: 'https://x.com/naval/status/1234567890',
        shield_passed: true,
        shield_issues: [],
        source_created_at: new Date().toISOString()
      }
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('accepts original type without requiring source_tweet_url', () => {
    const result = filterPublishableOpportunities([
      {
        type: 'thread',
        crafted_text: '1/ Most people overcomplicate their morning routine.\n---\n2/ A 10-minute walk and a glass of water is enough to start.',
        shield_passed: true,
        shield_issues: []
      }
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('handles empty opportunities array', () => {
    const result = filterPublishableOpportunities([]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('handles undefined opportunities', () => {
    const result = filterPublishableOpportunities(undefined as any);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('mixed batch: accepts valid, rejects invalid', () => {
    const result = filterPublishableOpportunities([
      { type: 'quote', crafted_text: 'Arabic content هنا', shield_passed: true, shield_issues: [], source_tweet_url: 'https://x.com/a/status/1' },
      { type: 'reply', crafted_text: 'Great insight on building systems.', shield_passed: true, shield_issues: [], source_tweet_url: 'https://x.com/naval/status/999', source_created_at: new Date().toISOString() },
      { type: 'quote', crafted_text: 'Shield failed content', shield_passed: false, shield_issues: ['link'], source_tweet_url: 'https://x.com/b/status/2' },
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
  });
});
