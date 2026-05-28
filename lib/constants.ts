/**
 * Shared constants — single file for all recurring patterns
 *
 * Instead of repeating the same patterns across multiple files, we define them
 * here once and import them everywhere. This prevents drift between files.
 */

/**
 * Dangerous first-person patterns — only those representing unsourced claims
 * Normal usage like "I think" or "my approach" is allowed
 *
 * Used in:
 * - lib/quality.ts (evaluateContentQuality)
 * - lib/content.ts (containsUnsafeClaim)
 * - lib/account-shield.ts (shieldCheck + quickShieldCheck)
 */
export const FIRST_PERSON_CLAIM_PATTERNS = [
  /i (saved|boosted|increased|improved|doubled|reduced|grew|cut|achieved)\b/i,
  /my (results?|experience|outcome|experiment|test|data|findings?) (show|prove|confirm|suggest|reveal|demonstrate)\b/i,
  /i (found|discovered|tested|proved|confirmed|measured|verified)\b/i,
  /i (got|achieved|reached|hit) \d+/i,
  /my \w+ (increased|improved|grew|doubled|reduced|boosted) (by )?\d+/i,
  // Additions from content.ts that were not in quality.ts
  /from (my )?experience,?\s*\d/i,
  /in my (experience|testing|experiment),?\s*/i,
  /saved (me |you |users? )?\d+/i,
];
