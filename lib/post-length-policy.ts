/**
 * post-length-policy.ts — Phase S1.2: Account Posting Limits + Polish Hard Cap
 *
 * Provides a deterministic posting length policy so that every final candidate
 * and polished candidate respects the configured X posting limit before it can
 * pass publish_gate.
 *
 * Key constraints:
 * - Simple deterministic character count (no complex X weighted URL rules yet)
 * - Policy is loaded at the account config level with safe defaults
 * - No UI, no longform/thread mode, no Premium-as-unlimited
 * - @30piq defaults: hard_limit_chars=280, target_chars=240, allow_longform=false
 */

// ═══ Types ═══

export type PostLengthPolicy = {
  platform: 'x';
  subscription_tier: 'free' | 'basic' | 'premium' | 'premium_plus' | 'verified_org';
  hard_limit_chars: number;
  target_chars: number;
  allow_longform: boolean;
  longform_limit_chars: number | null;
  prefer_short_posts: boolean;
};

export type PostLengthValidationResult = {
  ok: boolean;
  char_count: number;
  hard_limit_chars: number;
  target_chars: number;
  reason?: 'post_over_hard_limit' | 'post_over_target' | 'empty_text' | 'post_too_short';
};

// ═══ Default Policy ═══

/**
 * Returns the default post length policy for @30piq (free tier, 280 char limit).
 */
export function getDefaultPostLengthPolicy(): PostLengthPolicy {
  return {
    platform: 'x',
    subscription_tier: 'free',
    hard_limit_chars: 280,
    target_chars: 240,
    allow_longform: false,
    longform_limit_chars: null,
    prefer_short_posts: true,
  };
}

// ═══ Normalization ═══

/**
 * Normalize a partial or missing post_length_policy input into a valid PostLengthPolicy.
 * If input is null/undefined, returns the default policy.
 * If input is partial, fills in defaults for missing fields.
 */
export function normalizePostLengthPolicy(input: Partial<PostLengthPolicy> | null | undefined): PostLengthPolicy {
  const defaults = getDefaultPostLengthPolicy();

  if (!input || typeof input !== 'object') {
    return defaults;
  }

  return {
    platform: input.platform || defaults.platform,
    subscription_tier: input.subscription_tier || defaults.subscription_tier,
    hard_limit_chars: typeof input.hard_limit_chars === 'number' && input.hard_limit_chars > 0
      ? input.hard_limit_chars
      : defaults.hard_limit_chars,
    target_chars: typeof input.target_chars === 'number' && input.target_chars > 0
      ? input.target_chars
      : defaults.target_chars,
    allow_longform: typeof input.allow_longform === 'boolean'
      ? input.allow_longform
      : defaults.allow_longform,
    longform_limit_chars: input.longform_limit_chars ?? defaults.longform_limit_chars,
    prefer_short_posts: typeof input.prefer_short_posts === 'boolean'
      ? input.prefer_short_posts
      : defaults.prefer_short_posts,
  };
}

// ═══ Accessors ═══

/**
 * Get the hard limit in characters from a policy.
 */
export function getPostHardLimit(policy: PostLengthPolicy): number {
  return policy.hard_limit_chars;
}

/**
 * Get the target character count from a policy.
 */
export function getPostTargetChars(policy: PostLengthPolicy): number {
  return policy.target_chars;
}

// ═══ Character Counting ═══

/**
 * Count characters in a text string using simple deterministic character count.
 * Does NOT implement complex X weighted URL rules — that's intentional per spec.
 */
export function countPostChars(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().length;
}

// ═══ Validation ═══

/**
 * Check if text is within the post length limit.
 * Returns true only if text is within the hard limit.
 */
export function isWithinPostLimit(text: string, policy: PostLengthPolicy): boolean {
  const count = countPostChars(text);
  return count > 0 && count <= policy.hard_limit_chars;
}

/**
 * Validate post text against the full length policy.
 *
 * Returns a structured result with:
 * - ok: whether the text is acceptable for posting
 * - char_count: the character count of the text
 * - hard_limit_chars: the hard limit from the policy
 * - target_chars: the target from the policy
 * - reason: if not ok, why (post_over_hard_limit, post_over_target, empty_text, post_too_short)
 */
export function validatePostLength(text: string, policy: PostLengthPolicy): PostLengthValidationResult {
  const count = countPostChars(text);

  // Empty text
  if (count === 0) {
    return {
      ok: false,
      char_count: 0,
      hard_limit_chars: policy.hard_limit_chars,
      target_chars: policy.target_chars,
      reason: 'empty_text',
    };
  }

  // Over hard limit
  if (count > policy.hard_limit_chars) {
    return {
      ok: false,
      char_count: count,
      hard_limit_chars: policy.hard_limit_chars,
      target_chars: policy.target_chars,
      reason: 'post_over_hard_limit',
    };
  }

  // Under minimum (40 chars — same as existing localCraftingChecks)
  if (count < 40) {
    return {
      ok: false,
      char_count: count,
      hard_limit_chars: policy.hard_limit_chars,
      target_chars: policy.target_chars,
      reason: 'post_too_short',
    };
  }

  // Over target but under hard limit — still ok, but note it
  // (We return ok=true, no reason. The caller can check char_count > target_chars for advisory.)
  return {
    ok: true,
    char_count: count,
    hard_limit_chars: policy.hard_limit_chars,
    target_chars: policy.target_chars,
  };
}

// ═══ Prompt Instruction Builder ═══

/**
 * Build a concise instruction string for craft/polish prompts.
 *
 * Example output for @30piq (free tier):
 *   "Write under 240 characters. Never exceed 280 characters."
 */
export function buildPostLengthInstruction(policy: PostLengthPolicy): string {
  return `Write under ${policy.target_chars} characters. Never exceed ${policy.hard_limit_chars} characters.`;
}

/**
 * Build a more detailed length instruction for polish/repair prompts
 * where the candidate is already over limit and needs shortening.
 */
export function buildShortenInstruction(policy: PostLengthPolicy, currentCharCount: number): string {
  return `CRITICAL: Current text is ${currentCharCount} characters, exceeding the hard limit of ${policy.hard_limit_chars}. Shorten to under ${policy.hard_limit_chars} characters (target: ${policy.target_chars}). Preserve the original angle, evidence, and key insight. Remove filler words, redundancy, or less important details. Do NOT change the meaning or invent new claims.`;
}
