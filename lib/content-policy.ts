/**
 * Content Policy — Final publishability gate
 *
 * This gate runs AFTER account-shield checks. It validates that publishable content:
 * - Is English-only (no Arabic)
 * - Is not JSON/metadata/wrapper output
 * - Is not AI conversation slop ("Here is...", "Sure...")
 * - Has valid source URLs for reply/quote types
 * - Has passed shield checks
 * - Is not too short or too long
 * - Is not instruction text instead of publishable text
 * - Has fresh source timestamps for reply/quote (Phase S1.1)
 *
 * This gate does NOT replace account-shield. Both must pass.
 */

export type PublishPolicyRejection = {
  index: number;
  type?: string;
  reason: string;
  preview: string;
};

export type PublishPolicyResult<T> = {
  accepted: T[];
  rejected: PublishPolicyRejection[];
};

// ═══ Phase S1.1: Freshness Gate Types ═══

export type FreshnessDiagnostics = {
  source_created_at: string | null;
  source_age_hours: number | null;
  freshness_passed: boolean;
  freshness_rejection_reason: string | null;
  original_recommendation_type: string | null;
  downgraded_to_standalone: boolean;
};

export type FreshnessGateStats = {
  freshness_checked_count: number;
  freshness_rejected_count: number;
  freshness_missing_timestamp_count: number;
  freshness_too_old_reply_count: number;
  freshness_too_old_quote_count: number;
  freshness_downgraded_to_standalone_count: number;
};

// ═══ Phase S1.1: Freshness Thresholds ═══

/** Maximum age in hours for a reply source tweet. Beyond this, the reply looks late. */
export const REPLY_MAX_AGE_HOURS = 72;

/** Maximum age in hours for a quote source tweet. Beyond this, the quote loses momentum. */
export const QUOTE_MAX_AGE_HOURS = 168; // 7 days

// ═══ Constants ═══

const ARABIC_RE = /[\u0600-\u06FF]/;
const VALID_X_STATUS_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\?.*)?$/i;
const JSONISH_RE = /^\s*[\{\[]|"(?:tweet|text|quote)"\s*:/i;

// Patterns that indicate the crafted text is a direct reply dependent on the source
const REPLY_DEPENDENCY_PATTERNS = [
  /\bsays?\b/i,
  /\bjust (?:said|posted|tweeted|shared)\b/i,
  /\bthis (?:is|was|just)\b/i,
  /^@\w+/,  // starts with a mention
  /\b(?:agreed?|exactly|right|yes|no|wrong|disagree)\b/i,
];

export const ENGLISH_ACCOUNT_CONTENT_POLICY = [
  'Audience: English-speaking markets: US, UK, Canada, Australia, and similar.',
  'Publishable content language: English only. Never write Arabic in content meant for X.',
  'Telegram interface can be Arabic; model instructions and publishable output must be English.',
  'No hashtags, no decorative emojis, no inflated claims, no invented statistics.',
  'Write direct, specific, concise content. Avoid generic AI-style phrasing.',
  'Reject output that looks like JSON, metadata, explanations, or formatting wrappers.',
  'Reject output that contains AI conversation patterns like "Here is", "Sure,", "Final tweet:", "Tweet:".',
  'Reject output that contains markdown code fences or instruction text instead of publishable content.',
  'Only publish recommendations that pass account shield and source validation.',
  'This gate is the final publishability gate, not a replacement for account-shield.'
].join('\n');

export function containsArabic(text: string): boolean {
  return ARABIC_RE.test(text || '');
}

export function looksJsonish(text: string): boolean {
  return JSONISH_RE.test(String(text || '').trim());
}

export function isValidXStatusUrl(url: string): boolean {
  return VALID_X_STATUS_RE.test(String(url || '').trim());
}

/**
 * Detects AI wrapper / slop patterns that indicate the text is not
 * publishable content but rather an AI conversation artifact.
 */
export function isAISlopWrapper(text: string): { ok: boolean; reason?: string } {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reason: 'empty' };

  // "Here is" or "Here's" at start (case-insensitive)
  if (/^here(?:\s+is|'s)\b/i.test(value)) {
    return { ok: false, reason: 'ai_slop_here_is' };
  }

  // "Sure," or "Sure." at start
  if (/^sure[,.]/i.test(value)) {
    return { ok: false, reason: 'ai_slop_sure' };
  }

  // Prefix patterns: "Final tweet:", "Tweet:", "Reply:", "Quote:"
  if (/\b(?:final\s+tweet|tweet|reply|quote)\s*:/i.test(value)) {
    return { ok: false, reason: 'ai_slop_prefix_label' };
  }

  // Markdown code fences (``` at start)
  if (/^```/.test(value)) {
    return { ok: false, reason: 'ai_slop_code_fence' };
  }

  // Instruction-like text at start: "Write a", "Generate a", "Create a"
  if (/^(?:write|generate|create)\s+a\b/i.test(value)) {
    return { ok: false, reason: 'ai_slop_instruction' };
  }

  // Conversational AI patterns: "I can help" or "I'll write"
  if (/i\s+(?:can\s+help|'ll\s+write)\b/i.test(value)) {
    return { ok: false, reason: 'ai_slop_conversational' };
  }

  return { ok: true };
}

export function isEnglishPublishableText(text: string): { ok: boolean; reason?: string } {
  const value = String(text || '').trim();
  if (value.length < 10) return { ok: false, reason: 'too_short' };
  if (value.length > 1200) return { ok: false, reason: 'too_long' };
  if (containsArabic(value)) return { ok: false, reason: 'arabic_content_detected' };
  if (looksJsonish(value)) return { ok: false, reason: 'json_or_metadata_output' };

  const slopCheck = isAISlopWrapper(value);
  if (!slopCheck.ok) return { ok: false, reason: slopCheck.reason || 'ai_slop_wrapper' };

  return { ok: true };
}

// ═══ Phase S1.1: Source Timestamp Normalization ═══

/**
 * normalizeSourceCreatedAt — Extract the canonical source_created_at timestamp
 * from an opportunity object.
 *
 * Tries multiple possible field names in priority order:
 * 1. source_created_at (canonical, Phase S1.1+)
 * 2. created_at (from TwitterAPI.io tweet normalization)
 * 3. tweet_created_at (alternative naming)
 * 4. source_created_at (redundant but safe)
 * 5. published_at (if from published tweet)
 * 6. createdAt (camelCase variant)
 * 7. tweetCreatedAt (camelCase variant)
 *
 * Returns null if no valid timestamp is found.
 * Never throws.
 */
export function normalizeSourceCreatedAt(opportunity: Record<string, any>): string | null {
  if (!opportunity || typeof opportunity !== 'object') return null;

  const candidates = [
    opportunity.source_created_at,
    opportunity.created_at,
    opportunity.tweet_created_at,
    opportunity.published_at,
    opportunity.createdAt,
    opportunity.tweetCreatedAt,
  ];

  for (const val of candidates) {
    if (typeof val === 'string' && val.trim()) {
      // Validate it parses as a date
      const parsed = new Date(val.trim());
      if (!isNaN(parsed.getTime())) {
        return val.trim();
      }
    }
  }

  return null;
}

/**
 * computeSourceAgeHours — Compute the age of a source tweet in hours.
 * Returns null if the timestamp is missing or unparseable.
 * Never throws.
 */
export function computeSourceAgeHours(sourceCreatedAt: string | null): number | null {
  if (!sourceCreatedAt) return null;

  try {
    const parsed = new Date(sourceCreatedAt);
    if (isNaN(parsed.getTime())) return null;
    const now = new Date();
    const diffMs = now.getTime() - parsed.getTime();
    if (diffMs < 0) return 0; // future timestamp — treat as 0 (just posted)
    return diffMs / (1000 * 60 * 60);
  } catch {
    return null;
  }
}

/**
 * computeSourceAgeHoursFromReference — Compute age using a reference time (for deterministic testing).
 * Returns null if the timestamp is missing or unparseable.
 * Never throws.
 */
export function computeSourceAgeHoursFromReference(
  sourceCreatedAt: string | null,
  referenceTime: Date
): number | null {
  if (!sourceCreatedAt) return null;

  try {
    const parsed = new Date(sourceCreatedAt);
    if (isNaN(parsed.getTime())) return null;
    const diffMs = referenceTime.getTime() - parsed.getTime();
    if (diffMs < 0) return 0;
    return diffMs / (1000 * 60 * 60);
  } catch {
    return null;
  }
}

// ═══ Phase S1.1: Freshness Gate Logic ═══

/**
 * checkFreshness — Evaluate the freshness of an opportunity based on its type
 * and source_created_at timestamp.
 *
 * Rules:
 * - Reply: must have source_created_at, must be within REPLY_MAX_AGE_HOURS (72h)
 * - Quote: must have source_created_at, must be within QUOTE_MAX_AGE_HOURS (7 days)
 * - Standalone/thread/article/repo_tweet: freshness is optional, evergreen allowed
 *
 * For reply/quote that fail freshness:
 * - If the idea is still useful and the crafted text doesn't depend on the source
 *   being fresh, it can be downgraded to standalone.
 * - Downgrade conditions:
 *   1. Source is still credited in metadata (source_created_at is preserved)
 *   2. Crafted text does not sound like a direct reply (no "says", "just posted", etc.)
 *   3. No "X says" style dependency unless source is included as context
 *   4. publish_gate re-checks it as standalone
 *
 * Never throws. Always returns a FreshnessDiagnostics object.
 */
export function checkFreshness(
  opportunity: Record<string, any>,
  referenceTime?: Date
): FreshnessDiagnostics {
  const type = String(opportunity?.type || 'unknown');
  const sourceCreatedAt = normalizeSourceCreatedAt(opportunity);
  const sourceAgeHours = referenceTime
    ? computeSourceAgeHoursFromReference(sourceCreatedAt, referenceTime)
    : computeSourceAgeHours(sourceCreatedAt);

  // Standalone types: freshness is not required (evergreen allowed)
  if (type === 'standalone' || type === 'thread' || type === 'article' || type === 'repo_tweet') {
    return {
      source_created_at: sourceCreatedAt,
      source_age_hours: sourceAgeHours,
      freshness_passed: true,
      freshness_rejection_reason: null,
      original_recommendation_type: type,
      downgraded_to_standalone: false,
    };
  }

  // Reply: must have source_created_at, must be within REPLY_MAX_AGE_HOURS
  if (type === 'reply') {
    if (!sourceCreatedAt) {
      return {
        source_created_at: null,
        source_age_hours: null,
        freshness_passed: false,
        freshness_rejection_reason: 'missing_source_created_at_for_reply',
        original_recommendation_type: 'reply',
        downgraded_to_standalone: false,
      };
    }

    if (sourceAgeHours !== null && sourceAgeHours > REPLY_MAX_AGE_HOURS) {
      // Check if downgrade to standalone is possible
      const canDowngrade = canDowngradeToStandalone(opportunity);
      return {
        source_created_at: sourceCreatedAt,
        source_age_hours: sourceAgeHours,
        freshness_passed: false,
        freshness_rejection_reason: 'source_too_old_for_reply',
        original_recommendation_type: 'reply',
        downgraded_to_standalone: canDowngrade,
      };
    }

    return {
      source_created_at: sourceCreatedAt,
      source_age_hours: sourceAgeHours,
      freshness_passed: true,
      freshness_rejection_reason: null,
      original_recommendation_type: 'reply',
      downgraded_to_standalone: false,
    };
  }

  // Quote: must have source_created_at, must be within QUOTE_MAX_AGE_HOURS
  if (type === 'quote') {
    if (!sourceCreatedAt) {
      return {
        source_created_at: null,
        source_age_hours: null,
        freshness_passed: false,
        freshness_rejection_reason: 'missing_source_created_at_for_quote',
        original_recommendation_type: 'quote',
        downgraded_to_standalone: false,
      };
    }

    if (sourceAgeHours !== null && sourceAgeHours > QUOTE_MAX_AGE_HOURS) {
      // Check if downgrade to standalone is possible
      const canDowngrade = canDowngradeToStandalone(opportunity);
      return {
        source_created_at: sourceCreatedAt,
        source_age_hours: sourceAgeHours,
        freshness_passed: false,
        freshness_rejection_reason: 'source_too_old_for_quote',
        original_recommendation_type: 'quote',
        downgraded_to_standalone: canDowngrade,
      };
    }

    return {
      source_created_at: sourceCreatedAt,
      source_age_hours: sourceAgeHours,
      freshness_passed: true,
      freshness_rejection_reason: null,
      original_recommendation_type: 'quote',
      downgraded_to_standalone: false,
    };
  }

  // Unknown type: treat as standalone (no freshness requirement)
  return {
    source_created_at: sourceCreatedAt,
    source_age_hours: sourceAgeHours,
    freshness_passed: true,
    freshness_rejection_reason: null,
    original_recommendation_type: type,
    downgraded_to_standalone: false,
  };
}

/**
 * canDowngradeToStandalone — Check if a reply/quote opportunity can be safely
 * downgraded to standalone type.
 *
 * Conditions (ALL must be true):
 * 1. Source is still credited in metadata (source_created_at is preserved)
 * 2. Crafted text does not sound like a direct reply (no "says", "just posted", etc.)
 * 3. No "X says" style dependency unless source is included as context
 */
export function canDowngradeToStandalone(opportunity: Record<string, any>): boolean {
  const craftedText = String(opportunity?.crafted_text || '').trim();

  // Condition 1: Source must be credited in metadata
  const hasSourceCredit = Boolean(
    opportunity?.source_tweet_url ||
    opportunity?.source_author ||
    opportunity?.source_text
  );

  if (!hasSourceCredit) return false;

  // Condition 2: Crafted text must not sound like a direct reply
  // If it matches reply dependency patterns, it can't be standalone
  const replyDependencyMatches = REPLY_DEPENDENCY_PATTERNS.filter(
    pattern => pattern.test(craftedText)
  );

  // Allow up to 1 mild pattern (like starting with @mention), but not strong ones
  // like "just said" or "this is" which indicate direct conversational dependency
  const strongDependencyPatterns = [
    /\bjust (?:said|posted|tweeted|shared)\b/i,
    /\bthis (?:is|was|just)\b/i,
  ];

  for (const pattern of strongDependencyPatterns) {
    if (pattern.test(craftedText)) return false;
  }

  // Condition 3: No "X says" style dependency unless source is included as context
  const sourceAuthor = String(opportunity?.source_author || '').replace(/^@/, '');
  if (sourceAuthor && craftedText.toLowerCase().includes(sourceAuthor.toLowerCase())) {
    // The crafted text references the source author by name — it depends on the source context
    // This is OK for standalone ONLY if the source text or context is included
    if (!opportunity?.source_text && !opportunity?.quote_context && !opportunity?.parent_context) {
      return false;
    }
  }

  return true;
}

// ═══ Main Filter Function ═══

export function filterPublishableOpportunities<T extends {
  type?: string;
  crafted_text?: string;
  source_tweet_url?: string;
  shield_passed?: boolean;
  shield_issues?: string[];
  source_created_at?: string | null;
  source_age_hours?: number | null;
  freshness_passed?: boolean;
  freshness_rejection_reason?: string;
  original_recommendation_type?: string;
  downgraded_to_standalone?: boolean;
}>(opportunities: T[] = [], options?: {
  referenceTime?: Date;
  enableFreshnessGate?: boolean;
}): PublishPolicyResult<T> & { freshnessStats: FreshnessGateStats } {
  const accepted: T[] = [];
  const rejected: PublishPolicyRejection[] = [];
  const enableFreshness = options?.enableFreshnessGate !== false; // default true

  const freshnessStats: FreshnessGateStats = {
    freshness_checked_count: 0,
    freshness_rejected_count: 0,
    freshness_missing_timestamp_count: 0,
    freshness_too_old_reply_count: 0,
    freshness_too_old_quote_count: 0,
    freshness_downgraded_to_standalone_count: 0,
  };

  opportunities.forEach((opp, index) => {
    const preview = String(opp?.crafted_text || '').slice(0, 140);
    const type = String(opp?.type || 'unknown');

    if (opp?.shield_passed !== true) {
      rejected.push({ index, type, reason: `shield_not_passed:${(opp?.shield_issues || []).join(',') || 'unknown'}`, preview });
      return;
    }

    const textCheck = isEnglishPublishableText(opp?.crafted_text || '');
    if (!textCheck.ok) {
      rejected.push({ index, type, reason: textCheck.reason || 'text_policy_failed', preview });
      return;
    }

    if ((type === 'reply' || type === 'quote') && !isValidXStatusUrl(opp?.source_tweet_url || '')) {
      rejected.push({ index, type, reason: 'invalid_source_tweet_url', preview });
      return;
    }

    // ═══ Phase S1.1: Freshness Gate ═══
    if (enableFreshness) {
      freshnessStats.freshness_checked_count++;

      const freshness = checkFreshness(opp as Record<string, any>, options?.referenceTime);

      // Attach freshness diagnostics to the opportunity
      (opp as any).source_created_at = freshness.source_created_at;
      (opp as any).source_age_hours = freshness.source_age_hours;
      (opp as any).freshness_passed = freshness.freshness_passed;
      (opp as any).freshness_rejection_reason = freshness.freshness_rejection_reason;
      (opp as any).original_recommendation_type = freshness.original_recommendation_type;
      (opp as any).downgraded_to_standalone = freshness.downgraded_to_standalone;

      if (!freshness.freshness_passed) {
        freshnessStats.freshness_rejected_count++;

        // Track specific rejection reasons
        if (freshness.freshness_rejection_reason === 'missing_source_created_at_for_reply' ||
            freshness.freshness_rejection_reason === 'missing_source_created_at_for_quote') {
          freshnessStats.freshness_missing_timestamp_count++;
        }
        if (freshness.freshness_rejection_reason === 'source_too_old_for_reply') {
          freshnessStats.freshness_too_old_reply_count++;
        }
        if (freshness.freshness_rejection_reason === 'source_too_old_for_quote') {
          freshnessStats.freshness_too_old_quote_count++;
        }

        // Check if we can downgrade to standalone
        if (freshness.downgraded_to_standalone) {
          freshnessStats.freshness_downgraded_to_standalone_count++;

          // Downgrade: convert type to standalone, remove source_tweet_url requirement
          const downgradedOpp = {
            ...opp,
            type: 'standalone' as any,
            original_recommendation_type: freshness.original_recommendation_type,
            downgraded_to_standalone: true as boolean,
            // Keep source metadata for credit but clear the reply/quote URL
            // so it doesn't fail the source_tweet_url validation
            source_tweet_url: '' as string,
            // Add shield issue for the downgrade
            shield_issues: [...(opp?.shield_issues || []), `freshness_downgraded_from_${freshness.original_recommendation_type}`],
          };

          // Re-check as standalone: must still pass text policy
          const downgradeTextCheck = isEnglishPublishableText(downgradedOpp.crafted_text || '');
          if (downgradeTextCheck.ok) {
            accepted.push(downgradedOpp as T);
            return;
          }
        }

        // Cannot downgrade — reject with freshness reason
        rejected.push({
          index,
          type,
          reason: freshness.freshness_rejection_reason || 'freshness_gate_failed',
          preview,
        });
        return;
      }
    }

    accepted.push(opp);
  });

  return { accepted, rejected, freshnessStats };
}
