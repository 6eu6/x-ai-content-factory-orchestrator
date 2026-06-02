import { describe, it, expect } from 'vitest';
import { matchPostToOpportunity, textSimilarity } from '../lib/lean/auto-detect';

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
