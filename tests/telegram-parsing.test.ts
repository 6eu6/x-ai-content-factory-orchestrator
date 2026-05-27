import { describe, it, expect } from 'vitest';
import { extractHandle, extractHandles, extractTweetUrl, extractGitHubRepo, shortText } from '../lib/telegram';

describe('extractHandle', () => {
  it('strips @ and url prefixes', () => {
    expect(extractHandle('@naval')).toBe('naval');
    expect(extractHandle('https://x.com/sama')).toBe('sama');
    expect(extractHandle('https://twitter.com/paulg/status/1')).toBe('paulg');
  });
});

describe('extractHandles', () => {
  it('parses mixed separators and dedupes', () => {
    expect(extractHandles('@naval emollick, paulg https://x.com/sama'))
      .toEqual(['naval', 'emollick', 'paulg', 'sama']);
  });

  it('dedupes case-insensitively', () => {
    expect(extractHandles('Naval naval NAVAL')).toEqual(['Naval']);
  });

  it('drops too-short tokens', () => {
    expect(extractHandles('a bb ccc')).toEqual(['bb', 'ccc']);
  });
});

describe('extractTweetUrl', () => {
  it('extracts a status url', () => {
    expect(extractTweetUrl('look: https://x.com/foo/status/12345 nice'))
      .toBe('https://x.com/foo/status/12345');
  });

  it('returns empty string when no tweet url', () => {
    expect(extractTweetUrl('https://x.com/foo')).toBe('');
  });
});

describe('extractGitHubRepo', () => {
  it('accepts full url and owner/repo shorthand', () => {
    expect(extractGitHubRepo('https://github.com/6eu6/x')).toBe('https://github.com/6eu6/x');
    expect(extractGitHubRepo('6eu6/repo')).toBe('6eu6/repo');
    expect(extractGitHubRepo('just text')).toBe('');
  });
});

describe('shortText', () => {
  it('truncates with ellipsis', () => {
    expect(shortText('a'.repeat(300), 10)).toHaveLength(10);
    expect(shortText('short', 10)).toBe('short');
  });
});
