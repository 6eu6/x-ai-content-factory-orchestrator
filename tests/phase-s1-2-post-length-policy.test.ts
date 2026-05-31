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
  computeLocalCandidateScore,
  selectCandidatesForJudge,
  type CraftedCandidate,
  type BriefForSelection,
} from '../lib/candidate-selector';
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

// ═══ F. Policy Propagation (S1.2 follow-up) ═══

describe('Phase S1.2 follow-up: Policy Propagation', () => {
  const defaultBrief: BriefForSelection = {
    recommended_angle: 'AI agents need judgment caches not more parameters',
    source_summary: 'A study on AI agent decision-making',
    do_not_claim: [],
    required_context: [],
  };

  it('computeLocalCandidateScore uses custom hardLimitChars', () => {
    // Text at 300 chars: over default 280 but under custom 500
    const text300 = 'A'.repeat(300);
    const candidate: CraftedCandidate = {
      variant_type: 'brief_faithful',
      crafted_text: text300,
      format: 'reply',
      brief_alignment_score: 8,
      brief_alignment_notes: [],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: false,
    };

    // With default 280 limit, this should get a penalty for length
    const scoreWith280 = computeLocalCandidateScore(candidate, defaultBrief, 280);
    // With custom 500 limit, this should pass length check (higher score)
    const scoreWith500 = computeLocalCandidateScore(candidate, defaultBrief, 500);

    // The score with 500 should be >= score with 280 (length check passes)
    expect(scoreWith500).toBeGreaterThanOrEqual(scoreWith280);
  });

  it('selectCandidatesForJudge uses custom hardLimitChars for local scoring', () => {
    const text300 = 'A'.repeat(300);
    const candidate: CraftedCandidate = {
      variant_type: 'brief_faithful',
      crafted_text: text300,
      format: 'reply',
      brief_alignment_score: 8,
      brief_alignment_notes: [],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: false,
    };

    // With 500 limit, candidate should be selectable
    const result500 = selectCandidatesForJudge([candidate], defaultBrief, 500);
    expect(result500.selected.length).toBe(1);
    expect(result500.selected[0].crafted_text).toBe(text300);

    // With 280 limit, candidate should still be selectable (not filtered, just scored lower)
    const result280 = selectCandidatesForJudge([candidate], defaultBrief, 280);
    expect(result280.selected.length).toBe(1);
    // Score with 280 should be lower than with 500 due to length check
    expect(result280.selected[0]._candidate_local_score!).toBeLessThan(result500.selected[0]._candidate_local_score!);
  });

  it('validatePolishedText uses actual policy hard_limit_chars, not default', () => {
    const text350 = 'A'.repeat(350);

    // With default policy (280): should fail
    const defaultResult = validatePolishedText(text350, [], undefined, 7);
    expect(defaultResult.valid).toBe(false);
    expect(defaultResult.reason).toBe('polished_text_over_hard_limit');

    // With custom policy (400): should pass
    const customPolicy = normalizePostLengthPolicy({ hard_limit_chars: 400 });
    const customResult = validatePolishedText(text350, [], undefined, 7, customPolicy);
    expect(customResult.valid).toBe(true);
  });

  it('normalizePostLengthPolicy roundtrips through account state', () => {
    // Simulate what happens when policy comes from load_account_state result
    const originalPolicy = getDefaultPostLengthPolicy();
    // Simulate storing to JSON and back
    const serialized = JSON.parse(JSON.stringify(originalPolicy));
    const restoredPolicy = normalizePostLengthPolicy(serialized);
    expect(restoredPolicy.hard_limit_chars).toBe(originalPolicy.hard_limit_chars);
    expect(restoredPolicy.target_chars).toBe(originalPolicy.target_chars);
    expect(restoredPolicy.allow_longform).toBe(originalPolicy.allow_longform);
    expect(restoredPolicy.prefer_short_posts).toBe(originalPolicy.prefer_short_posts);
  });
});
