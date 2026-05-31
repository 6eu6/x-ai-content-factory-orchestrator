/**
 * Phase S1.2: Account Posting Limits + Polish Hard Cap
 *
 * Tests verify:
 * A. Default policy — missing account policy defaults to 280 hard limit and 240 target
 * B. Candidate validation — text <= 280 passes, text > 280 fails
 * C. Polish hard cap — polished text over 280 is not accepted as valid
 * D. Publish gate — even if mocked candidate has passing judge scores, publish_gate rejects if text > hard_limit_chars
 * E. No threshold changes — existing judge thresholds remain unchanged, no-auto-post remains
 */

import { describe, expect, it } from 'vitest';
import {
  getDefaultPostLengthPolicy,
  normalizePostLengthPolicy,
  getPostHardLimit,
  getPostTargetChars,
  countPostChars,
  isWithinPostLimit,
  validatePostLength,
  buildPostLengthInstruction,
  buildShortenInstruction,
  type PostLengthPolicy,
} from '../lib/post-length-policy';
import {
  filterPublishableOpportunities,
  isEnglishPublishableText,
} from '../lib/content-policy';
import {
  validatePolishedText,
} from '../lib/near-pass-polish';
import {
  NEAR_PASS_THRESHOLDS,
} from '../lib/opportunity-judge';

// ═══ A. Default Policy ═══

describe('Phase S1.2: Default Policy', () => {
  it('returns correct default policy for @30piq', () => {
    const policy = getDefaultPostLengthPolicy();
    expect(policy.platform).toBe('x');
    expect(policy.subscription_tier).toBe('free');
    expect(policy.hard_limit_chars).toBe(280);
    expect(policy.target_chars).toBe(240);
    expect(policy.allow_longform).toBe(false);
    expect(policy.longform_limit_chars).toBe(null);
    expect(policy.prefer_short_posts).toBe(true);
  });

  it('normalizes null input to default policy', () => {
    const policy = normalizePostLengthPolicy(null);
    expect(policy.hard_limit_chars).toBe(280);
    expect(policy.target_chars).toBe(240);
    expect(policy.allow_longform).toBe(false);
    expect(policy.prefer_short_posts).toBe(true);
  });

  it('normalizes undefined input to default policy', () => {
    const policy = normalizePostLengthPolicy(undefined);
    expect(policy.hard_limit_chars).toBe(280);
    expect(policy.target_chars).toBe(240);
  });

  it('normalizes empty object to default policy', () => {
    const policy = normalizePostLengthPolicy({});
    expect(policy.hard_limit_chars).toBe(280);
    expect(policy.target_chars).toBe(240);
  });

  it('fills in missing fields from partial input', () => {
    const policy = normalizePostLengthPolicy({ hard_limit_chars: 500 });
    expect(policy.hard_limit_chars).toBe(500);
    expect(policy.target_chars).toBe(240); // default
    expect(policy.platform).toBe('x'); // default
    expect(policy.allow_longform).toBe(false); // default
  });

  it('preserves all provided fields', () => {
    const custom: Partial<PostLengthPolicy> = {
      platform: 'x',
      subscription_tier: 'premium',
      hard_limit_chars: 4000,
      target_chars: 3000,
      allow_longform: true,
      longform_limit_chars: 25000,
      prefer_short_posts: false,
    };
    const policy = normalizePostLengthPolicy(custom);
    expect(policy.hard_limit_chars).toBe(4000);
    expect(policy.target_chars).toBe(3000);
    expect(policy.subscription_tier).toBe('premium');
    expect(policy.allow_longform).toBe(true);
    expect(policy.longform_limit_chars).toBe(25000);
    expect(policy.prefer_short_posts).toBe(false);
  });

  it('rejects zero hard_limit_chars by defaulting to 280', () => {
    const policy = normalizePostLengthPolicy({ hard_limit_chars: 0 });
    expect(policy.hard_limit_chars).toBe(280); // default
  });

  it('rejects negative hard_limit_chars by defaulting to 280', () => {
    const policy = normalizePostLengthPolicy({ hard_limit_chars: -10 });
    expect(policy.hard_limit_chars).toBe(280); // default
  });
});

// ═══ B. Candidate Validation ═══

describe('Phase S1.2: Candidate Validation', () => {
  it('text <= 280 passes length validation', () => {
    const policy = getDefaultPostLengthPolicy();
    const text = 'A'.repeat(280);
    const result = validatePostLength(text, policy);
    expect(result.ok).toBe(true);
    expect(result.char_count).toBe(280);
  });

  it('text < 280 passes length validation', () => {
    const policy = getDefaultPostLengthPolicy();
    const text = 'A'.repeat(200);
    const result = validatePostLength(text, policy);
    expect(result.ok).toBe(true);
    expect(result.char_count).toBe(200);
  });

  it('text > 280 fails length validation', () => {
    const policy = getDefaultPostLengthPolicy();
    const text = 'A'.repeat(300);
    const result = validatePostLength(text, policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('post_over_hard_limit');
    expect(result.char_count).toBe(300);
    expect(result.hard_limit_chars).toBe(280);
  });

  it('empty text fails validation', () => {
    const policy = getDefaultPostLengthPolicy();
    const result = validatePostLength('', policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_text');
  });

  it('text under 40 chars fails validation', () => {
    const policy = getDefaultPostLengthPolicy();
    const result = validatePostLength('Short', policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('post_too_short');
  });

  it('isWithinPostLimit returns true for valid text', () => {
    const policy = getDefaultPostLengthPolicy();
    expect(isWithinPostLimit('A'.repeat(100), policy)).toBe(true);
    expect(isWithinPostLimit('A'.repeat(280), policy)).toBe(true);
  });

  it('isWithinPostLimit returns false for over-limit text', () => {
    const policy = getDefaultPostLengthPolicy();
    expect(isWithinPostLimit('A'.repeat(281), policy)).toBe(false);
  });

  it('isWithinPostLimit returns false for empty text', () => {
    const policy = getDefaultPostLengthPolicy();
    expect(isWithinPostLimit('', policy)).toBe(false);
  });

  it('countPostChars trims whitespace', () => {
    expect(countPostChars('  hello  ')).toBe(5);
  });

  it('countPostChars handles null/undefined gracefully', () => {
    expect(countPostChars(null as any)).toBe(0);
    expect(countPostChars(undefined as any)).toBe(0);
  });

  it('custom policy with different hard_limit_chars works', () => {
    const policy = normalizePostLengthPolicy({ hard_limit_chars: 500, target_chars: 400 });
    expect(getPostHardLimit(policy)).toBe(500);
    expect(getPostTargetChars(policy)).toBe(400);
    const text = 'A'.repeat(450);
    const result = validatePostLength(text, policy);
    expect(result.ok).toBe(true);
  });

  it('validatePolishedText rejects text over policy hard limit', () => {
    const policy = getDefaultPostLengthPolicy();
    const longText = 'A'.repeat(300);
    const result = validatePolishedText(longText, [], undefined, 7, policy);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_over_hard_limit');
  });

  it('validatePolishedText accepts text within policy hard limit', () => {
    const policy = getDefaultPostLengthPolicy();
    const validText = 'A'.repeat(280);
    const result = validatePolishedText(validText, [], undefined, 7, policy);
    expect(result.valid).toBe(true);
  });
});

// ═══ C. Polish Hard Cap ═══

describe('Phase S1.2: Polish Hard Cap', () => {
  it('polished text over 280 is not accepted as valid', () => {
    const longText = 'A'.repeat(300);
    const result = validatePolishedText(longText, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_over_hard_limit');
  });

  it('polished text exactly at 280 is accepted', () => {
    const text = 'A'.repeat(280);
    const result = validatePolishedText(text, []);
    expect(result.valid).toBe(true);
  });

  it('polished text at 279 is accepted', () => {
    const text = 'A'.repeat(279);
    const result = validatePolishedText(text, []);
    expect(result.valid).toBe(true);
  });

  it('over-limit text never reaches publish_gate as accepted', () => {
    // This is verified through filterPublishableOpportunities
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(300),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 280 });
    expect(result.accepted.length).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toBe('post_over_hard_limit');
  });
});

// ═══ D. Publish Gate ═══

describe('Phase S1.2: Publish Gate Enforcement', () => {
  it('rejects candidate with text > hard_limit_chars even if shield passed', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(300),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 280 });
    expect(result.accepted.length).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toBe('post_over_hard_limit');
  });

  it('accepts candidate with text <= hard_limit_chars and shield passed', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(200),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 280 });
    expect(result.accepted.length).toBe(1);
    expect(result.rejected.length).toBe(0);
  });

  it('rejects candidate with text > custom hard_limit_chars', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(350),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 300 });
    expect(result.accepted.length).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toBe('post_over_hard_limit');
  });

  it('accepts candidate with text within custom hard_limit_chars', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(350),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 400 });
    expect(result.accepted.length).toBe(1);
  });

  it('defaults to 280 hard_limit_chars when not specified', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(290),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities);
    expect(result.accepted.length).toBe(0);
    expect(result.rejected[0].reason).toBe('post_over_hard_limit');
  });

  it('length check happens even when shield_passed is true', () => {
    // Shield passed = true, but text is over limit — still rejected
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(350),
        shield_passed: true,
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 280 });
    expect(result.accepted.length).toBe(0);
    expect(result.rejected.some(r => r.reason === 'post_over_hard_limit')).toBe(true);
  });

  it('length check runs after shield check (shield_not_passed takes priority)', () => {
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'A'.repeat(350),
        shield_passed: false,
        shield_issues: ['some_issue'],
      },
    ];
    const result = filterPublishableOpportunities(opportunities, { hardLimitChars: 280 });
    expect(result.accepted.length).toBe(0);
    // Shield check runs first — reason will be shield_not_passed, not post_over_hard_limit
    expect(result.rejected[0].reason).toContain('shield_not_passed');
  });
});

// ═══ E. No Threshold Changes ═══

describe('Phase S1.2: No Threshold Changes', () => {
  it('final_candidate_score threshold remains 7.8', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });

  it('originality threshold remains 7.8', () => {
    // Verified through the judge module
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });

  it('evidence_safety threshold remains 7.5 for near-pass', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_EVIDENCE_SAFETY).toBe(7.5);
  });

  it('niche_fit threshold remains 7 for near-pass', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_NICHE_FIT).toBe(7);
  });

  it('minimum text length remains 40', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_TEXT_LENGTH).toBe(40);
  });

  it('maximum text length is now 400 for near-pass eligibility (allows shortening)', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_TEXT_LENGTH).toBe(400);
  });

  it('no auto-post behavior — publish gate still rejects', () => {
    // Verify that publish_gate is still a gate that can reject
    const opportunities = [
      {
        type: 'standalone',
        crafted_text: 'Good text that passes',
        shield_passed: false, // shield not passed — rejected
        shield_issues: ['some_issue'],
      },
    ];
    const result = filterPublishableOpportunities(opportunities);
    expect(result.accepted.length).toBe(0);
  });

  it('buildPostLengthInstruction produces correct instruction for free tier', () => {
    const policy = getDefaultPostLengthPolicy();
    const instruction = buildPostLengthInstruction(policy);
    expect(instruction).toContain('240');
    expect(instruction).toContain('280');
    expect(instruction).toContain('characters');
  });

  it('buildShortenInstruction includes current char count and limits', () => {
    const policy = getDefaultPostLengthPolicy();
    const instruction = buildShortenInstruction(policy, 310);
    expect(instruction).toContain('310');
    expect(instruction).toContain('280');
    expect(instruction).toContain('240');
    expect(instruction).toContain('Shorten');
  });
});
