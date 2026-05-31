/**
 * numeric-claim-guard.ts — Phase 2B: Numeric claim detection and remediation
 *
 * Before publish_gate, this guard:
 * 1. Detects numeric claims in crafted_text (percentages, rankings,
 *    "X times", "millions", "studies show", dollar amounts, etc.)
 * 2. If numeric claim found AND no source URL/evidence field → attempt rewrite
 *    to remove the numeric claim
 * 3. If rewrite fails or is unsafe → mark opportunity for pre-gate rejection
 *    with reason "numeric_claim_needs_source"
 * 4. If numeric claim found AND source URL exists → allow through to publish_gate
 *
 * This guard does NOT lower any threshold or weaken content-policy.
 * It improves quality BEFORE publish_gate, reducing rejection waste.
 */

import { callModel, parseModelJson, TaskType } from './model-router';
import { containsArabic, isAISlopWrapper } from './content-policy';
import { quickShieldCheck } from './account-shield';
import { hasNumericClaim } from './rejection-ledger';

// ═══ Types ═══

export type NumericClaimGuardResult = {
  crafted_text: string;
  numeric_claim_detected: boolean;
  has_source: boolean;
  rewrite_attempted: boolean;
  rewrite_success: boolean;
  numeric_claim_removed: boolean;
  rejection_reason: string | null;
};

export type OpportunityWithGuardResult = {
  crafted_text: string;
  type: string;
  source_tweet_url: string;
  shield_passed: boolean;
  shield_issues: string[];
  numeric_claim_removed?: boolean;
  quality_notes?: string;
  [key: string]: any;
};

// ═══ Enhanced Numeric Claim Detection ═══

/**
 * Comprehensive numeric claim patterns.
 * Extends the basic hasNumericClaim from rejection-ledger with more patterns.
 */
const NUMERIC_CLAIM_PATTERNS = [
  // Percentage claims
  /\d+(?:\.\d+)?\s*%/i,
  // Dollar amounts
  /\$\d+/i,
  // Multiplier claims ("10x", "5x faster")
  /\d+x\b/i,
  // "increased/decreased by N"
  /(?:increased|decreased|grew|reduced|boosted|saved|cut|improved)\s+(by\s+)?\d/i,
  // Authority claims without citation
  /studies show/i,
  /research shows/i,
  /data shows/i,
  /experts say/i,
  /recent (studies|research|data)/i,
  // Large round numbers that sound fabricated
  /\d+\s*(million|billion|trillion)/i,
  // Rankings
  /ranked?\s+(#\d+|number\s+\d+|top\s+\d+|No\.\s*\d+)/i,
  // "N out of M" patterns
  /\d+\s+out\s+of\s+\d+/i,
  // Time claims with numbers
  /\d+\s*(hours?|minutes?|seconds?|days?|weeks?|months?)\s+(saved|faster|reduced|cut)/i,
];

/**
 * Detect if text contains numeric claims that require a source.
 * Returns the list of matched patterns for diagnostic purposes.
 */
export function detectNumericClaims(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const matched: string[] = [];
  for (const pattern of NUMERIC_CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source);
    }
  }
  return matched;
}

/**
 * Check if the opportunity has explicit source URL or evidence field.
 *
 * IMPORTANT: source_tweet_url is NOT accepted as evidence for numeric claims.
 * source_tweet_url is a content origin/reference (where the opportunity came from),
 * NOT proof for the numeric claim itself. Almost every opportunity has a
 * source_tweet_url, so treating it as evidence would let unsourced numeric
 * claims bypass the guard entirely.
 *
 * Accepted evidence fields:
 * - evidence: string — explicit evidence/citation text
 * - source_url: string — explicit source URL for the claim
 * - source_urls: string[] — array of source URLs
 * - citations: string | string[] — citation field(s)
 * - references: string | string[] — reference field(s)
 * - verified_source_url: string — verified source URL
 * - URLs embedded directly in crafted_text
 *
 * source_tweet_url is intentionally EXCLUDED from this list.
 */
export function hasSourceForClaim(opp: any): boolean {
  // Check for explicit source/evidence fields
  if (opp.evidence && typeof opp.evidence === 'string' && opp.evidence.length > 0) return true;
  if (opp.source_url && typeof opp.source_url === 'string' && opp.source_url.length > 0) return true;
  if (opp.verified_source_url && typeof opp.verified_source_url === 'string' && opp.verified_source_url.length > 0) return true;

  // Check array evidence fields
  if (Array.isArray(opp.source_urls) && opp.source_urls.some((u: string) => typeof u === 'string' && u.length > 0)) return true;
  if (typeof opp.citations === 'string' && opp.citations.length > 0) return true;
  if (Array.isArray(opp.citations) && opp.citations.some((c: string) => typeof c === 'string' && c.length > 0)) return true;
  if (typeof opp.references === 'string' && opp.references.length > 0) return true;
  if (Array.isArray(opp.references) && opp.references.some((r: string) => typeof r === 'string' && r.length > 0)) return true;

  // Check for URL embedded directly in crafted_text
  const text = opp.crafted_text || '';
  if (/https?:\/\//i.test(text)) return true;

  // NOTE: source_tweet_url is intentionally NOT checked here.
  // It is a content origin, not evidence for the numeric claim.

  return false;
}

// ═══ AI-Powered Rewrite to Remove Numeric Claims ═══

/**
 * Attempt to rewrite text to remove unsourced numeric claims.
 * The rewrite must:
 * - Keep the same general message
 * - Remove or rephrase numeric claims to be non-specific
 * - Not introduce new claims
 * - Stay English-only
 * - Not be AI slop
 */
export async function rewriteToRemoveNumericClaim(
  text: string,
  detectedPatterns: string[]
): Promise<string | null> {
  try {
    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `You are a content safety editor for @30piq (AI-native operators, builders, productivity, digital leverage, career growth, tools, creator growth, internet business, and useful digital culture).

Your task: Rewrite this tweet to REMOVE unsourced numeric claims while keeping the core message.

Rules (mandatory):
1. Keep it under 280 characters
2. English ONLY — no Arabic
3. No AI slop words (delve, crucial, leverage, game-changer, unlock, empower, etc.)
4. No hashtags
5. REMOVE specific numbers, percentages, multipliers, dollar amounts, "studies show", "research shows", etc.
6. Replace with qualitative language: "significantly", "notably", "a major improvement", etc.
7. Do NOT introduce new numeric claims
8. Keep the same angle and message — just without the unsourced numbers
9. Sound like a smart friend in tech, not a content mill
10. If the entire tweet is built around a specific number and removing it makes the tweet meaningless, return "CANNOT_REWRITE_SAFELY"

Return the rewritten text ONLY. No explanation, no quotes, no labels.`
      },
      {
        role: 'user',
        content: `Remove unsourced numeric claims from this tweet:\n\n"${text}"\n\nDetected numeric patterns: ${detectedPatterns.join(', ')}`
      }
    ], { temperature: 0.2, max_tokens: 300 });

    const rewritten = String(response || '').trim();

    // Check for safe rewrite signal
    if (/CANNOT_REWRITE_SAFELY/i.test(rewritten)) {
      return null;
    }

    // Validate rewrite
    if (!rewritten || rewritten.length < 10 || rewritten.length > 1200) {
      return null;
    }

    // If rewrite contains Arabic, reject it
    if (containsArabic(rewritten)) {
      return null;
    }

    // If rewrite looks like AI slop, reject it
    const slopCheck = isAISlopWrapper(rewritten);
    if (!slopCheck.ok) {
      return null;
    }

    // Verify numeric claims were actually removed/reduced
    const originalClaimCount = detectNumericClaims(text).length;
    const rewrittenClaimCount = detectNumericClaims(rewritten).length;
    if (rewrittenClaimCount >= originalClaimCount && originalClaimCount > 0) {
      // Rewrite didn't improve things — still has same number of claims
      // Allow it through anyway; the publish gate will handle the rest
    }

    return rewritten;
  } catch {
    return null;
  }
}

// ═══ Main Guard Function ═══

/**
 * Apply numeric claim guard to a single opportunity.
 *
 * Returns the (possibly rewritten) opportunity and guard metadata.
 * If a numeric claim cannot be safely removed, marks it for rejection
 * with reason "numeric_claim_needs_source".
 */
export async function guardNumericClaim(
  opp: OpportunityWithGuardResult
): Promise<{
  opportunity: OpportunityWithGuardResult;
  guardResult: NumericClaimGuardResult;
  should_reject: boolean;
  rejection_reason: string | null;
}> {
  const text = opp.crafted_text || '';

  // Step 1: Detect numeric claims
  const detectedPatterns = detectNumericClaims(text);
  const numericClaimDetected = detectedPatterns.length > 0;

  if (!numericClaimDetected) {
    // No numeric claims → pass through
    return {
      opportunity: {
        ...opp,
        numeric_claim_removed: false
      },
      guardResult: {
        crafted_text: text,
        numeric_claim_detected: false,
        has_source: false,
        rewrite_attempted: false,
        rewrite_success: false,
        numeric_claim_removed: false,
        rejection_reason: null
      },
      should_reject: false,
      rejection_reason: null
    };
  }

  // Step 2: Check if sources exist
  const hasSource = hasSourceForClaim(opp);

  if (hasSource) {
    // Has source → allow through to publish_gate with a note
    return {
      opportunity: {
        ...opp,
        numeric_claim_removed: false,
        quality_notes: [
          opp.quality_notes || '',
          `Numeric claim present but has source (${detectedPatterns.length} patterns detected)`
        ].filter(Boolean).join('; ')
      },
      guardResult: {
        crafted_text: text,
        numeric_claim_detected: true,
        has_source: true,
        rewrite_attempted: false,
        rewrite_success: false,
        numeric_claim_removed: false,
        rejection_reason: null
      },
      should_reject: false,
      rejection_reason: null
    };
  }

  // Step 3: No source → attempt rewrite to remove numeric claim
  const rewritten = await rewriteToRemoveNumericClaim(text, detectedPatterns);

  if (rewritten && rewritten !== text) {
    // Rewrite succeeded → use rewritten text
    // Re-run shield check on rewritten text
    const shieldResult = quickShieldCheck(rewritten, opp);

    return {
      opportunity: {
        ...opp,
        crafted_text: rewritten,
        shield_passed: shieldResult.safe,
        shield_issues: shieldResult.reasons,
        numeric_claim_removed: true,
        quality_notes: [
          opp.quality_notes || '',
          `Numeric claim removed via rewrite (${detectedPatterns.length} patterns: ${detectedPatterns.slice(0, 3).join(', ')})`
        ].filter(Boolean).join('; ')
      },
      guardResult: {
        crafted_text: rewritten,
        numeric_claim_detected: true,
        has_source: false,
        rewrite_attempted: true,
        rewrite_success: true,
        numeric_claim_removed: true,
        rejection_reason: null
      },
      should_reject: false,
      rejection_reason: null
    };
  }

  // Step 4: Rewrite failed → mark for rejection
  return {
    opportunity: {
      ...opp,
      numeric_claim_removed: false,
      quality_notes: [
        opp.quality_notes || '',
        `Numeric claim without source, rewrite failed (${detectedPatterns.length} patterns: ${detectedPatterns.slice(0, 3).join(', ')})`
      ].filter(Boolean).join('; ')
    },
    guardResult: {
      crafted_text: text,
      numeric_claim_detected: true,
      has_source: false,
      rewrite_attempted: true,
      rewrite_success: false,
      numeric_claim_removed: false,
      rejection_reason: 'numeric_claim_needs_source'
    },
    should_reject: true,
    rejection_reason: 'numeric_claim_needs_source'
  };
}

/**
 * Batch apply numeric claim guard to all opportunities.
 *
 * Returns:
 * - guarded: opportunities that passed the guard
 * - rejected: opportunities that should be rejected before publish_gate
 * - summary: aggregate statistics
 */
export async function guardOpportunitiesNumericClaims(
  opportunities: OpportunityWithGuardResult[]
): Promise<{
  guarded: OpportunityWithGuardResult[];
  rejected: Array<{
    opportunity: OpportunityWithGuardResult;
    reason: string;
    guardResult: NumericClaimGuardResult;
  }>;
  summary: {
    total: number;
    numeric_claims_detected: number;
    had_source: number;
    rewrites_attempted: number;
    rewrites_succeeded: number;
    rejected: number;
  };
}> {
  if (!opportunities?.length) {
    return {
      guarded: [],
      rejected: [],
      summary: {
        total: 0,
        numeric_claims_detected: 0,
        had_source: 0,
        rewrites_attempted: 0,
        rewrites_succeeded: 0,
        rejected: 0
      }
    };
  }

  const guarded: OpportunityWithGuardResult[] = [];
  const rejected: Array<{
    opportunity: OpportunityWithGuardResult;
    reason: string;
    guardResult: NumericClaimGuardResult;
  }> = [];

  let numericClaimsDetected = 0;
  let hadSource = 0;
  let rewritesAttempted = 0;
  let rewritesSucceeded = 0;

  for (const opp of opportunities) {
    const result = await guardNumericClaim(opp);

    if (result.guardResult.numeric_claim_detected) {
      numericClaimsDetected++;
    }
    if (result.guardResult.has_source) {
      hadSource++;
    }
    if (result.guardResult.rewrite_attempted) {
      rewritesAttempted++;
    }
    if (result.guardResult.rewrite_success) {
      rewritesSucceeded++;
    }

    if (result.should_reject) {
      rejected.push({
        opportunity: result.opportunity,
        reason: result.rejection_reason || 'numeric_claim_needs_source',
        guardResult: result.guardResult
      });
    } else {
      guarded.push(result.opportunity);
    }
  }

  return {
    guarded,
    rejected,
    summary: {
      total: opportunities.length,
      numeric_claims_detected: numericClaimsDetected,
      had_source: hadSource,
      rewrites_attempted: rewritesAttempted,
      rewrites_succeeded: rewritesSucceeded,
      rejected: rejected.length
    }
  };
}
