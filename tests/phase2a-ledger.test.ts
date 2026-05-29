/**
 * Phase 2A tests — Cost Ledger + Rejection Ledger
 *
 * Tests the pure logic functions that don't require Supabase.
 * DB-dependent functions are tested via integration (manual or Supabase test instance).
 */

import { describe, it, expect } from 'vitest';
import {
  estimateCostUsd,
  type CostProvider
} from '../lib/cost-ledger';
import {
  hashCraftedText,
  craftTextPreview,
  countSourceUrls,
  hasNumericClaim
} from '../lib/rejection-ledger';
import {
  formatSummaryText,
  formatSummaryJson,
  type RunCostSummary
} from '../lib/run-cost-summary';

// ═══ Cost Ledger: estimateCostUsd ═══

describe('estimateCostUsd', () => {
  it('returns 0 for twitterapi_io provider', () => {
    expect(estimateCostUsd('twitterapi_io', null, 0, 0)).toBe(0);
  });

  it('returns 0 for local provider', () => {
    expect(estimateCostUsd('local', 'ollama/llama3', 1000, 500)).toBe(0);
  });

  it('calculates cost for known deepseek model', () => {
    // deepseek: input $0.30/1M, output $1.10/1M
    const cost = estimateCostUsd('openrouter', 'deepseek/deepseek-chat-v3-0324', 1000, 500);
    const expected = (1000 * 0.30 / 1_000_000) + (500 * 1.10 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('calculates cost for llama-4-maverick', () => {
    // maverick: input $0.20/1M, output $0.80/1M
    const cost = estimateCostUsd('openrouter', 'meta-llama/llama-4-maverick', 2000, 1000);
    const expected = (2000 * 0.20 / 1_000_000) + (1000 * 0.80 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('calculates cost for mistral-small', () => {
    // mistral: input $0.10/1M, output $0.30/1M
    const cost = estimateCostUsd('openrouter', 'mistralai/mistral-small-3.1-24b-instruct', 500, 200);
    const expected = (500 * 0.10 / 1_000_000) + (200 * 0.30 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('uses default pricing for unknown model', () => {
    // default: input $0.50/1M, output $1.50/1M
    const cost = estimateCostUsd('openrouter', 'unknown/model', 1000, 500);
    const expected = (1000 * 0.50 / 1_000_000) + (500 * 1.50 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('returns 0 when tokens are 0', () => {
    expect(estimateCostUsd('openrouter', 'deepseek/deepseek-chat-v3-0324', 0, 0)).toBe(0);
  });

  it('handles null/undefined tokens gracefully', () => {
    expect(estimateCostUsd('openrouter', 'deepseek/deepseek-chat-v3-0324', null, undefined)).toBe(0);
  });
});

// ═══ Rejection Ledger: hashCraftedText ═══

describe('hashCraftedText', () => {
  it('returns null for null input', () => {
    expect(hashCraftedText(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(hashCraftedText(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(hashCraftedText('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(hashCraftedText('   ')).toBeNull();
  });

  it('returns a 64-character hex string for valid text', () => {
    const hash = hashCraftedText('Hello world');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('produces consistent hashes for same input', () => {
    const hash1 = hashCraftedText('Test content');
    const hash2 = hashCraftedText('Test content');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different input', () => {
    const hash1 = hashCraftedText('Content A');
    const hash2 = hashCraftedText('Content B');
    expect(hash1).not.toBe(hash2);
  });

  it('trims before hashing', () => {
    const hash1 = hashCraftedText('Test');
    const hash2 = hashCraftedText('  Test  ');
    expect(hash1).toBe(hash2);
  });
});

// ═══ Rejection Ledger: craftTextPreview ═══

describe('craftTextPreview', () => {
  it('returns null for null input', () => {
    expect(craftTextPreview(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(craftTextPreview('')).toBeNull();
  });

  it('returns full text if under 280 chars', () => {
    expect(craftTextPreview('Short text')).toBe('Short text');
  });

  it('truncates to 280 chars', () => {
    const longText = 'A'.repeat(500);
    expect(craftTextPreview(longText)).toBe('A'.repeat(280));
  });

  it('trims before truncating', () => {
    expect(craftTextPreview('  hello  ')).toBe('hello');
  });
});

// ═══ Rejection Ledger: countSourceUrls ═══

describe('countSourceUrls', () => {
  it('returns 0 for null', () => {
    expect(countSourceUrls(null)).toBe(0);
  });

  it('returns 0 for empty object', () => {
    expect(countSourceUrls({})).toBe(0);
  });

  it('counts source_tweet_url', () => {
    expect(countSourceUrls({ source_tweet_url: 'https://x.com/user/status/123' })).toBe(1);
  });

  it('counts entity URLs', () => {
    expect(countSourceUrls({ entities: { urls: ['url1', 'url2'] } })).toBe(2);
  });

  it('counts extended entity URLs', () => {
    expect(countSourceUrls({ extended_entities: { urls: ['url1'] } })).toBe(1);
  });

  it('counts all URL sources combined', () => {
    expect(countSourceUrls({
      source_tweet_url: 'https://x.com/user/status/123',
      entities: { urls: ['url1'] },
      extended_entities: { urls: ['url2', 'url3'] }
    })).toBe(4);
  });
});

// ═══ Rejection Ledger: hasNumericClaim ═══

describe('hasNumericClaim', () => {
  it('returns false for null', () => {
    expect(hasNumericClaim(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasNumericClaim('')).toBe(false);
  });

  it('returns false for text without numeric claims', () => {
    expect(hasNumericClaim('This is a regular tweet about coding')).toBe(false);
  });

  it('detects percentage claims', () => {
    expect(hasNumericClaim('Revenue grew by 40%')).toBe(true);
  });

  it('detects dollar amounts', () => {
    expect(hasNumericClaim('Saved $500 on cloud costs')).toBe(true);
  });

  it('detects multiplier claims', () => {
    expect(hasNumericClaim('Performance improved 10x')).toBe(true);
  });

  it('detects "increased by N" pattern', () => {
    expect(hasNumericClaim('Users increased by 200 overnight')).toBe(true);
  });

  it('detects "reduced by" pattern', () => {
    expect(hasNumericClaim('Latency reduced by 50ms')).toBe(true);
  });
});

// ═══ Run Cost Summary: formatting ═══

describe('formatSummaryText', () => {
  it('formats a basic summary', () => {
    const summary: RunCostSummary = {
      run_id: '12345678-1234-1234-1234-123456789012',
      total_cost_usd: 0.0456,
      cost_by_provider: { openrouter: 0.0456 },
      cost_by_task_type: { content_generation: 0.03, quality_evaluation: 0.0156 },
      cost_by_model: { 'deepseek/deepseek-chat-v3-0324': 0.03, 'mistralai/mistral-small-3.1-24b-instruct': 0.0156 },
      total_events: 2,
      completed_events: 2,
      failed_events: 0,
      total_input_tokens: 3000,
      total_output_tokens: 1500,
      accepted_count: 3,
      rejected_count: 2,
      top_rejection_reasons: [{ reason: 'shield_not_passed', count: 1 }, { reason: 'arabic_content_detected', count: 1 }]
    };

    const text = formatSummaryText(summary);
    expect(text).toContain('$0.0456');
    expect(text).toContain('openrouter');
    expect(text).toContain('deepseek');
    expect(text).toContain('shield_not_passed');
    expect(text).toContain('arabic_content_detected');
  });
});

describe('formatSummaryJson', () => {
  it('formats a basic summary as JSON', () => {
    const summary: RunCostSummary = {
      run_id: '12345678-1234-1234-1234-123456789012',
      total_cost_usd: 0.05,
      cost_by_provider: { openrouter: 0.05 },
      cost_by_task_type: {},
      cost_by_model: {},
      total_events: 1,
      completed_events: 1,
      failed_events: 0,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      accepted_count: 0,
      rejected_count: 0,
      top_rejection_reasons: []
    };

    const json = formatSummaryJson(summary);
    expect(json.run_id).toBe(summary.run_id);
    expect(json.total_cost_usd).toBe(0.05);
    expect(json.events.total).toBe(1);
    expect(json.tokens.input).toBe(1000);
  });
});
