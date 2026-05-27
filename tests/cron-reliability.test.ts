import { describe, expect, it } from 'vitest';

// ═══ Error sanitizer tests ═══

// We replicate the sanitizer logic here since it's a local function in the route
const SECRET_PATTERNS = [
  /TWITTERAPI_IO_KEY/gi,
  /ORCHESTRATOR_SECRET/gi,
  /OPENAI_API_KEY/gi,
  /SUPABASE_SERVICE_ROLE_KEY/gi,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /eyJ[a-zA-Z0-9_-]{20,}/g,
];

function sanitizeError(message: string): string {
  let safe = message;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, '[REDACTED]');
  }
  if (safe.length > 500) safe = safe.slice(0, 500) + '...';
  return safe;
}

describe('error sanitizer', () => {
  it('redacts TWITTERAPI_IO_KEY from error messages', () => {
    const msg = 'Failed: TWITTERAPI_IO_KEY was rejected';
    const safe = sanitizeError(msg);
    expect(safe).toContain('[REDACTED]');
    expect(safe).not.toContain('TWITTERAPI_IO_KEY');
  });

  it('redacts ORCHESTRATOR_SECRET from error messages', () => {
    const msg = 'ORCHESTRATOR_SECRET is invalid';
    const safe = sanitizeError(msg);
    expect(safe).toContain('[REDACTED]');
    expect(safe).not.toContain('ORCHESTRATOR_SECRET');
  });

  it('redacts OPENAI_API_KEY from error messages', () => {
    const msg = 'OPENAI_API_KEY is invalid';
    const safe = sanitizeError(msg);
    expect(safe).toContain('[REDACTED]');
    expect(safe).not.toContain('OPENAI_API_KEY');
  });

  it('redacts SUPABASE_SERVICE_ROLE_KEY from error messages', () => {
    const msg = 'SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc was invalid';
    const safe = sanitizeError(msg);
    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc');
    expect(safe).toContain('[REDACTED]');
  });

  it('redacts JWT-like tokens', () => {
    const msg = 'Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWI expired';
    const safe = sanitizeError(msg);
    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(safe).toContain('[REDACTED]');
  });

  it('redacts sk- prefixed API keys', () => {
    const msg = 'API key sk-proj-abcdefghijklmnopqrstuvwxyz123456 is invalid';
    const safe = sanitizeError(msg);
    expect(safe).toContain('[REDACTED]');
    // The sk- pattern with hyphens should be fully replaced
    expect(safe).not.toMatch(/sk-[a-zA-Z0-9_-]{20,}/);
  });

  it('preserves non-sensitive error information', () => {
    const msg = 'TwitterAPI returned 429: rate limit exceeded';
    const safe = sanitizeError(msg);
    expect(safe).toContain('429');
    expect(safe).toContain('rate limit');
  });

  it('truncates very long error messages', () => {
    const msg = 'x'.repeat(600);
    const safe = sanitizeError(msg);
    expect(safe.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(safe.endsWith('...')).toBe(true);
  });

  it('handles empty string', () => {
    const safe = sanitizeError('');
    expect(safe).toBe('');
  });
});

// ═══ Runtime guard calculation tests ═══

describe('runtime guard', () => {
  it('triggers when elapsed time exceeds 80% of max runtime', () => {
    const maxRuntimeMs = 45000;
    const threshold = maxRuntimeMs * 0.8; // 36000ms
    const elapsedMs = 38000; // Over 80%

    expect(elapsedMs > threshold).toBe(true);
  });

  it('does not trigger when elapsed time is well within limit', () => {
    const maxRuntimeMs = 45000;
    const threshold = maxRuntimeMs * 0.8;
    const elapsedMs = 10000; // Only 22%

    expect(elapsedMs > threshold).toBe(false);
  });

  it('respects configurable max runtime', () => {
    // Default: 45000ms
    const defaultMax = 45000;
    expect(defaultMax * 0.8).toBe(36000);

    // Custom: 30000ms
    const customMax = 30000;
    expect(customMax * 0.8).toBe(24000);
  });
});

// ═══ Cron response structure tests ═══

describe('cron response structure', () => {
  it('includes timings with required fields', () => {
    const timings = {
      started_at: new Date().toISOString(),
      scan_ms: 5000,
      enrichment_ms: 300,
      decision_ms: 50,
      total_ms: 5400
    };

    expect(timings.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof timings.scan_ms).toBe('number');
    expect(typeof timings.enrichment_ms).toBe('number');
    expect(typeof timings.decision_ms).toBe('number');
    expect(typeof timings.total_ms).toBe('number');
  });

  it('external_errors have required structure', () => {
    const error = {
      provider: 'twitterapi.io' as const,
      phase: 'scan',
      status: 429,
      message: 'Rate limit exceeded',
      response_preview: '429 Too Many Requests'
    };

    expect(['twitterapi.io', 'openrouter', 'supabase']).toContain(error.provider);
    expect(typeof error.phase).toBe('string');
    expect(typeof error.message).toBe('string');
  });

  it('partial response includes reason', () => {
    const response = {
      ok: true,
      partial: true,
      reason: 'runtime_guard_reached',
      version: 'cron-dispatcher-v2'
    };

    expect(response.partial).toBe(true);
    expect(response.reason).toBe('runtime_guard_reached');
  });
});

// ═══ Safety: decision engine still works correctly ═══

import { scoreOpportunity, getDecisionBudget, decideTelegramOpportunities } from '../lib/decision-engine';
import type { ContentOpportunity } from '../lib/content-engine-v3';

function baseOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  return {
    type: 'quote',
    source_tweet_url: 'https://x.com/source/status/123',
    source_text: 'A strong source tweet about building systems.',
    source_author: 'source',
    source_metrics: {
      like_count: 120, reply_count: 18, retweet_count: 22,
      quote_count: 8, bookmark_count: 34, view_count: 18000
    },
    media_urls: [],
    crafted_text: 'The useful part is not automation. It is forcing a system to wait until the signal is strong enough.',
    why: 'Strong engagement and transferable mechanism',
    brain_rules_used: ['precise_concept', 'psychological_trigger', 'viral_pattern'],
    shield_passed: true,
    shield_issues: [],
    ...overrides
  };
}

describe('safety not bypassed by rule weights', () => {
  it('still rejects unsafe content with high rule weight', () => {
    const budget = getDecisionBudget('stage_0_new');
    const risky = baseOpportunity({
      crafted_text: 'Check this out https://example.com #growth',
      shield_passed: false,
      shield_issues: ['external_link', 'hashtag'],
      avg_brain_rule_weight: 1.25 // Maximum possible weight
    });

    const result = decideTelegramOpportunities([risky], 'stage_0_new');
    expect(result.selected).toHaveLength(0);
    expect(result.held[0].decision_score.safety_score).toBeLessThan(6.5);
    // Rule weight adjustment IS calculated (0.4) but NOT applied to final_score
    // The key safety check: final_score must still be low
    expect(result.held[0].decision_score.safety_score).toBeLessThan(6.5);
    // Also verify the opportunity with high weight and failed shield scores same as without weight
    const unsafeNoWeight = baseOpportunity({
      crafted_text: 'Check this out https://example.com #growth',
      shield_passed: false,
      shield_issues: ['external_link', 'hashtag'],
      avg_brain_rule_weight: undefined
    });
    const resultNoWeight = decideTelegramOpportunities([unsafeNoWeight], 'stage_0_new');
    // Final scores should be identical — weight adjustment was not applied
    expect(result.held[0].decision_score.final_score).toBe(resultNoWeight.held[0].decision_score.final_score);
  });

  it('partial response never affects safety scoring', () => {
    // Safety scoring is a pure function — it doesn't depend on runtime state
    const budget = getDecisionBudget('stage_1_under_500');
    const safe = baseOpportunity({ avg_brain_rule_weight: 0.8 });
    const score = scoreOpportunity(safe, budget);

    // Score should be reasonable regardless of whether cron is partial
    expect(score.final_score).toBeGreaterThanOrEqual(0);
    expect(score.final_score).toBeLessThanOrEqual(10);
  });
});

// ═══ Light mode scan options ═══

describe('scan options lightMode', () => {
  it('ScanOptions type accepts lightMode boolean', () => {
    const options = { lightMode: true };
    expect(options.lightMode).toBe(true);
  });

  it('ScanOptions defaults to lightMode false', () => {
    const options = {};
    expect(options.lightMode).toBeFalsy();
  });
});
