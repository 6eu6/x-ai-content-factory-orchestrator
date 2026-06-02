import { describe, it, expect } from 'vitest';
import { redditQuery, searchEnabled } from '../lib/lean/web-search';

describe('web search helpers', () => {
  it('builds a reddit-scoped query', () => {
    expect(redditQuery('AI agents')).toBe('site:reddit.com AI agents');
  });
  it('reports disabled when no keys are set', () => {
    const prevA = process.env.SERPER_API_KEY;
    const prevB = process.env.SERPAPI_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    expect(searchEnabled()).toBe(false);
    process.env.SERPER_API_KEY = 'x';
    expect(searchEnabled()).toBe(true);
    if (prevA === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevA;
    if (prevB === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = prevB;
  });
});
