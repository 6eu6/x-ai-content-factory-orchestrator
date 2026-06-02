import { describe, it, expect } from 'vitest';
import { relativeOutcomeScore, absoluteOutcomeScore } from '../lib/lean/feedback';
import { dailyKey, utcDate } from '../lib/lean/daily-guard';

describe('account-relative outcome scoring', () => {
  it('falls back to absolute bands with no baseline', () => {
    expect(relativeOutcomeScore(100, null)).toBe(absoluteOutcomeScore(100));
    expect(relativeOutcomeScore(0, null)).toBe(1);
  });
  it('rewards beating the account baseline, penalizes underperforming it', () => {
    expect(relativeOutcomeScore(30, 10)).toBe(10);   // 3x baseline
    expect(relativeOutcomeScore(12, 10)).toBe(7);    // 1.2x
    expect(relativeOutcomeScore(9, 10)).toBe(5);     // ~at baseline
    expect(relativeOutcomeScore(2, 10)).toBe(1);     // far below
  });
  it('is account-relative: same raw engagement scores differently by baseline', () => {
    expect(relativeOutcomeScore(20, 5)).toBeGreaterThan(relativeOutcomeScore(20, 40));
  });
});

describe('daily guard key', () => {
  it('builds a stable per-account/per-day/per-task key', () => {
    expect(dailyKey('30piq', 'digest', '2026-06-10')).toBe('digest:30piq:2026-06-10');
    expect(dailyKey('@30piq', 'snapshot', '2026-06-10')).toBe('snapshot:30piq:2026-06-10');
  });
  it('utcDate is YYYY-MM-DD', () => {
    expect(utcDate(new Date('2026-06-10T23:59:00Z'))).toBe('2026-06-10');
  });
});
