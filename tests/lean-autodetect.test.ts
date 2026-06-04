import { describe, it, expect } from 'vitest';
import { matchPostToOpportunity, textSimilarity, postContentType } from '../lib/lean/auto-detect';
import { digestTweetId } from '../lib/lean/run';

const mkSuggestion = (over: any) => ({ type: 'standalone', text: 't', source_url: null, source_handle: null, source_age_hours: null, rationale: '', ...over });

const opps = [
  { id: 'o1', tweet_id: '111', source_url: 'https://x.com/a/status/111', action: 'reply', suggestion_text: 'API key tracking is the floor. Cost prediction before execution is the useful part.' },
  { id: 'o2', tweet_id: '222', source_url: 'https://x.com/b/status/222', action: 'quote', suggestion_text: 'Specificity beats broad appeal for early audiences.' },
];

describe('auto-detect matcher', () => {
  it('strong-matches a reply by target tweet id even when text was edited', () => {
    const post = { id: '999', text: 'totally reworded take that shares nothing', is_reply: true, in_reply_to_tweet_id: '111', is_quote: false, quoted_tweet_id: null };
    const m = matchPostToOpportunity(post, opps);
    expect(m?.opp.id).toBe('o1');
    expect(m?.confidence).toBe('strong');
  });

  it('strong-matches a quote by quoted tweet id', () => {
    const post = { id: '998', text: 'my own spin', is_reply: false, in_reply_to_tweet_id: null, is_quote: true, quoted_tweet_id: '222' };
    expect(matchPostToOpportunity(post, opps)?.opp.id).toBe('o2');
  });

  it('medium-matches by text similarity when no target id', () => {
    const post = { id: '997', text: 'API key tracking is the floor. Cost prediction before execution is the useful part.', is_reply: false, in_reply_to_tweet_id: null, is_quote: false, quoted_tweet_id: null };
    const m = matchPostToOpportunity(post, opps);
    expect(m?.opp.id).toBe('o1');
    expect(m?.confidence).toBe('medium');
  });

  it('does not match an unrelated manual tweet', () => {
    const post = { id: '996', text: 'good morning, coffee then code', is_reply: false, in_reply_to_tweet_id: null, is_quote: false, quoted_tweet_id: null };
    expect(matchPostToOpportunity(post, opps)).toBeNull();
  });

  it('similarity is 1 for identical text and 0 for disjoint', () => {
    expect(textSimilarity('hello world foo', 'hello world foo')).toBe(1);
    expect(textSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
});

describe('digest suggestion tracking', () => {
  it('classifies a published post type from flags', () => {
    expect(postContentType({ is_reply: true, is_quote: false })).toBe('reply');
    expect(postContentType({ is_reply: false, is_quote: true })).toBe('quote');
    expect(postContentType({ is_reply: false, is_quote: false })).toBe('standalone');
  });

  it('digest reply/quote uses the source tweet id (enables strong match after publish)', () => {
    expect(digestTweetId(mkSuggestion({ type: 'reply', source_url: 'https://x.com/a/status/12345' }))).toBe('12345');
  });

  it('digest standalone uses a stable content hash (dedupe), not the source', () => {
    const a = digestTweetId(mkSuggestion({ type: 'standalone', text: 'A sharp original take' }));
    const b = digestTweetId(mkSuggestion({ type: 'standalone', text: 'A sharp original take' }));
    expect(a).toBe(b);
    expect(a.startsWith('digest:')).toBe(true);
    expect(a).not.toBe(digestTweetId(mkSuggestion({ type: 'standalone', text: 'A different take' })));
  });

  it('a published digest reply then strong-matches its opportunity', () => {
    // opportunity persisted from a digest reply carries the source tweet id
    const oppFromDigest = [{ id: 'd1', tweet_id: digestTweetId(mkSuggestion({ type: 'reply', source_url: 'https://x.com/a/status/999' })), source_url: 'https://x.com/a/status/999', action: 'reply', suggestion_text: 'my take' }];
    const post = { id: 'p1', text: 'my edited take', is_reply: true, in_reply_to_tweet_id: '999', is_quote: false, quoted_tweet_id: null };
    expect(matchPostToOpportunity(post, oppFromDigest)?.opp.id).toBe('d1');
  });
});
