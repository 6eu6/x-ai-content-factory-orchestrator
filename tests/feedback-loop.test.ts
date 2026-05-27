import { describe, expect, it } from 'vitest';
import { extractTweetUrl } from '../lib/telegram';

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
    // Simulate the sorting/filtering logic
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
