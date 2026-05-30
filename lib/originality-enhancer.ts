/**
 * originality-enhancer.ts — Phase 2B → 2C.1: Self-critique/rewrite loop for crafted_text
 *
 * This module improves the quality of generated opportunities BEFORE publish_gate.
 * It does NOT lower thresholds or bypass any gate.
 *
 * Phase 2C.1 fix: The original code only triggered rewrites when
 * originality_score < 7.8. But opportunities with shield_issues like
 * missing_originality or slop_forbidden_words, or generic bait text,
 * also need rewrite attempts. The previous version produced
 * rewrites_applied=0 because:
 *
 * BUG 1: Rewrite was ONLY triggered by originality score, not by
 *         shield_issues or generic bait detection.
 * BUG 2: When rewriteForOriginality returned null (model output caught
 *         by its own AI slop validator), no diagnostic was recorded —
 *         just "Rewrite returned null or identical text" which tells
 *         us nothing about WHY.
 * BUG 3: After a failed rewrite, the original text kept its
 *         shield_issues (missing_originality, slop_forbidden_words)
 *         with no second-chance validation.
 *
 * Fix:
 * - shouldTriggerRewrite() checks ALL conditions (score, shield_issues,
 *   generic bait, slop words)
 * - rewrite_attempted and rewrite_trigger_reason are always set when a
 *   rewrite is tried
 * - rewrite_failed_reason explains exactly why the rewrite was rejected
 * - After rewrite (success or fail), re-run quickShieldCheck
 * - Enhanced summary tracks candidates, attempts, failures, skips
 */

import { callModel, parseModelJson, TaskType } from './model-router';
import { containsArabic, isAISlopWrapper } from './content-policy';
import { quickShieldCheck } from './account-shield';
import { looksLikeJsonWrapper, cleanCraftedText } from './crafted-text-cleaner';
import { scoreNicheAlignment } from './niche-alignment';
import { detectNumericClaims, hasSourceForClaim } from './numeric-claim-guard';
import { validateOpportunityQuality } from './quality-validator';

// ═══ Types ═══

export type QualityScores = {
  originality: number;
  evidence_safety: number;
  usefulness: number;
};

export type EnhancerResult = {
  crafted_text: string;
  scores_before: QualityScores;
  scores_after: QualityScores | null;
  rewrite_applied: boolean;
  quality_notes: string;
};

export type OpportunityWithDiagnostics = {
  crafted_text: string;
  type: string;
  source_text: string;
  source_author: string;
  source_tweet_url: string;
  why: string;
  brain_rules_used: string[];
  shield_passed: boolean;
  shield_issues: string[];
  // Phase 2B diagnostic fields
  originality_score_before?: number;
  originality_score_after?: number;
  evidence_safety_score?: number;
  rewrite_applied?: boolean;
  numeric_claim_removed?: boolean;
  quality_notes?: string;
  // Phase 2C diagnostic fields
  niche_alignment_score?: number;
  niche_alignment_reason?: string;
  cleaned_json_wrapper?: boolean;
  malformed_json_output?: boolean;
  pre_gate_rejection_reason?: string;
  final_quality_validation_passed?: boolean;
  final_quality_validation_notes?: string;
  // Phase 2C.1 diagnostic fields
  rewrite_trigger_reason?: string;
  rewrite_attempted?: boolean;
  rewrite_failed_reason?: string;
  // Phase 2C.1 expanded diagnostic fields
  rewrite_apply_reason?: string;
  rewrite_rejected_reason?: string;
  shield_issues_before?: string[];
  shield_issues_after?: string[];
  // Phase 2C.2 diagnostic fields: JSON wrapper cleaning in rewrite output
  rewrite_raw_was_json_wrapper?: boolean;
  rewrite_cleaned_json_wrapper?: boolean;
  rewrite_cleaning_notes?: string;
  // Existing fields from enrich step
  avg_brain_rule_weight?: number;
  rule_performance_summary?: {
    matched_rules: number;
    avg_weight: number;
    strongest_rule: string | null;
    weakest_rule: string | null;
  };
  [key: string]: any;
};

// ═══ Constants ═══

/** Minimum originality score to avoid rewrite */
const ORIGINALITY_THRESHOLD = 7.8;

/** Maximum length for crafted_text to be eligible for rewrite */
const MAX_REWRITE_LENGTH = 1200;

/** Generic engagement bait patterns that indicate a rewrite is needed */
const GENERIC_BAIT_PATTERNS = [
  { pattern: /^yo[,.…!\s]/i, name: 'yo_bait' },
  { pattern: /^interesting take/i, name: 'interesting_take_bait' },
  { pattern: /^hot take/i, name: 'hot_take_bait' },
  { pattern: /^this\.\s*$/i, name: 'this_bait' },
  { pattern: /^so true/i, name: 'so_true_bait' },
  { pattern: /^boom\s*$/i, name: 'boom_bait' },
  { pattern: /^thoughts\?\s*$/i, name: 'thoughts_bait' },
  { pattern: /\bthis is huge\b/i, name: 'this_is_huge_bait' },
  { pattern: /\bgame changer\b/i, name: 'game_changer_bait' },
  { pattern: /\bhere is why\b/i, name: 'here_is_why_bait' },
  { pattern: /\bthe future of\b/i, name: 'future_of_bait' },
  { pattern: /\byou need to\b/i, name: 'you_need_to_bait' },
];

// ═══ Pure Scoring Functions (testable without AI) ═══

/**
 * Heuristic originality pre-check.
 * Returns 1-10 estimate based on structural signals.
 * This is NOT the final score — the AI scores it more precisely.
 * Used for quick filtering before the expensive AI call.
 */
export function heuristicOriginality(text: string): number {
  if (!text || text.length < 10) return 1;

  let score = 5.0;

  // Positive signals
  if (text.includes('?')) score += 0.3;  // Questions engage
  if (/[""]/.test(text)) score += 0.3;   // Direct quotes show specificity
  if (/specific|exactly|precisely/i.test(text)) score += 0.2;
  if (/i (found|noticed|learned|discovered|tested|built)/i.test(text)) score += 0.5;  // Personal experience
  if (/\b(AI|GPT|LLM|prompt|agent|RAG|workflow|automation)\b/i.test(text)) score += 0.3;  // @30piq niche
  if (text.length > 40 && text.length < 280) score += 0.3;  // Good tweet length

  // Negative signals (generic/AI-slop patterns)
  // These carry heavy penalties because they indicate AI-generated generic content
  const genericPatterns = [
    { pattern: /in today'?s/i, penalty: 1.0 },
    { pattern: /it'?s (important|crucial|essential) (to|that)/i, penalty: 1.0 },
    { pattern: /whether you'?re/i, penalty: 0.7 },
    { pattern: /the (key|secret) to/i, penalty: 0.7 },
    { pattern: /here'?s (the thing|how|what)/i, penalty: 0.7 },
    { pattern: /let'?s (dive|explore|look)/i, penalty: 1.0 },
    { pattern: /game.?chang/i, penalty: 0.5 },
    { pattern: /leverag/i, penalty: 0.5 },
    { pattern: /streamlin/i, penalty: 0.5 },
    { pattern: /synerg/i, penalty: 0.5 },
    { pattern: /empower/i, penalty: 0.5 },
    { pattern: /elevat/i, penalty: 0.5 },
    { pattern: /foster/i, penalty: 0.5 },
    { pattern: /navigat.*landscape/i, penalty: 0.5 },
    { pattern: /cutting.?edge/i, penalty: 0.5 },
    { pattern: /state.?of.?the.?art/i, penalty: 0.5 },
    { pattern: /paradigm shift/i, penalty: 0.5 },
    { pattern: /unlock/i, penalty: 0.5 },
  ];

  for (const { pattern, penalty } of genericPatterns) {
    if (pattern.test(text)) score -= penalty;
  }

  // Very short = likely generic
  if (text.length < 30) score -= 1.0;

  // Numbered/bullet list pattern = AI-like
  if (/^\d+\.\s/m.test(text) && /^[-•]\s/m.test(text)) score -= 0.5;

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

/**
 * Heuristic evidence safety pre-check.
 * Returns 1-10 estimate based on presence of unsourced numeric claims.
 */
export function heuristicEvidenceSafety(text: string): number {
  if (!text || text.length < 10) return 5;

  let score = 8.0;  // Start high, penalize for claims

  // Unsourced numeric claims lower the score
  const numericClaimPatterns = [
    /\d+(?:\.\d+)?\s*%/i,
    /\$\d+/i,
    /\d+x\b/i,
    /(?:increased|decreased|grew|reduced|boosted|saved|cut|improved)\s+(by\s+)?\d/i,
    /studies show/i,
    /research shows/i,
    /data shows/i,
    /experts say/i,
    /millions?\s+(of|users|people)/i,
    /billions?\s+(of|users|people)/i,
  ];

  for (const pattern of numericClaimPatterns) {
    if (pattern.test(text)) {
      // Check if there's a source URL nearby
      if (!/https?:\/\//i.test(text)) {
        score -= 1.5;
      }
    }
  }

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

/**
 * Heuristic usefulness pre-check.
 * Returns 1-10 estimate based on actionable content signals.
 */
export function heuristicUsefulness(text: string): number {
  if (!text || text.length < 10) return 3;

  let score = 5.0;

  // Positive: actionable signals for @30piq niche (AI × productivity × career growth)
  const usefulPatterns = [
    /\b(try|use|build|create|automate|setup|install|run|deploy|test|ship|launch)\b/i,
    /\b(workflow|pipeline|system|framework|tool|app|script|template)\b/i,
    /\b(save|cut|reduce|speed|faster|better|improv)\b/i,
    /\b(prompt|agent|RAG|LLM|GPT|Claude|API|model)\b/i,
    /\b(career|hire|job|skill|learn|grow|salary)\b/i,
    /\b(productiv|automat|efficien|scale|outsource)\b/i,
    /\?/,  // Questions invite engagement
  ];

  for (const pattern of usefulPatterns) {
    if (pattern.test(text)) score += 0.4;
  }

  // Negative: vague/not useful
  if (/^(this|that|it|the)\s/i.test(text) && text.length < 50) score -= 1.0;
  if (/^(so|well|basically|honestly)\s/i.test(text)) score -= 0.5;

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

// ═══ Rewrite Trigger Logic (Phase 2C.1) ═══

/**
 * Determine whether an opportunity should trigger a rewrite attempt.
 *
 * Phase 2C.1: This function expands the rewrite trigger conditions beyond
 * just originality score. A rewrite should happen if ANY of these are true:
 * - originality_score_before < 7.8
 * - shield_issues includes missing_originality
 * - shield_issues includes slop_forbidden_words
 * - crafted_text contains generic bait patterns
 * - crafted_text is clean plain text but still too generic
 *
 * Returns the trigger reason(s) or null if no rewrite is needed.
 */
export function shouldTriggerRewrite(
  text: string,
  scoresBefore: QualityScores,
  opp: OpportunityWithDiagnostics
): string | null {
  const reasons: string[] = [];

  // Condition 1: Originality score below threshold
  if (scoresBefore.originality < ORIGINALITY_THRESHOLD) {
    reasons.push(`originality_${scoresBefore.originality}_below_${ORIGINALITY_THRESHOLD}`);
  }

  // Condition 2: shield_issues include missing_originality
  const shieldIssues = opp.shield_issues || [];
  if (shieldIssues.includes('missing_originality')) {
    reasons.push('shield_missing_originality');
  }

  // Condition 3: shield_issues include slop_forbidden_words
  if (shieldIssues.includes('slop_forbidden_words')) {
    reasons.push('shield_slop_forbidden_words');
  }

  // Condition 4: Generic engagement bait in text
  for (const { pattern, name } of GENERIC_BAIT_PATTERNS) {
    if (pattern.test(text.trim())) {
      reasons.push(`generic_bait:${name}`);
      break;  // One match is enough
    }
  }

  // Condition 5: Text is clean but still too generic (heuristic check)
  const heuristicScore = heuristicOriginality(text);
  if (heuristicScore < 5.0 && scoresBefore.originality < ORIGINALITY_THRESHOLD) {
    reasons.push('heuristic_generic');
  }

  return reasons.length > 0 ? reasons.join(',') : null;
}

/**
 * Detect generic bait patterns in text. Exported for testing.
 */
export function detectGenericBait(text: string): string | null {
  for (const { pattern, name } of GENERIC_BAIT_PATTERNS) {
    if (pattern.test(text.trim())) {
      return name;
    }
  }
  return null;
}

// ═══ Rewrite Apply Decision Logic (Phase 2C.1) ═══

/**
 * Result of the shouldApplyRewrite decision.
 * Exported for testing.
 */
export type ApplyRewriteDecision = {
  shouldApply: boolean;
  applyReasons: string[];
  rejectedReason: string | null;
};

/**
 * Pure function to decide whether a rewrite should be applied.
 *
 * Phase 2C.1 fix: The old code only applied rewrites when
 * scoresAfter.originality > scoresBefore.originality. This was too narrow —
 * a rewrite may fix slop_forbidden_words, generic bait, shield issues, or
 * quality validation even if the originality score stays the same.
 *
 * Safety checks (reject rewrite if ANY of these are true):
 * - Rewrite is off-niche
 * - Rewrite introduces unsourced numeric claims
 * - Rewrite fails quality validation
 *
 * Improvement checks (apply rewrite if ANY of these are true):
 * - Originality score improved
 * - Shield now passes (was false before)
 * - Fewer shield issues after rewrite
 * - Removed slop_forbidden_words
 * - Removed generic bait
 * - Removed missing_originality
 * - Rewrite passes quality validation while original did not
 */
export function shouldApplyRewrite(params: {
  scoresBefore: QualityScores;
  scoresAfter: QualityScores;
  shieldIssuesBefore: string[];
  shieldIssuesAfter: string[];
  shieldPassedBefore: boolean;
  shieldPassedAfter: boolean;
  originalText: string;
  rewrittenText: string;
  originalValidationPassed: boolean;
  rewriteValidationPassed: boolean;
  rewriteIsOffNiche: boolean;
  rewriteIntroducesUnsourcedNumericClaims: boolean;
  hasBrief?: boolean;
  briefAlignmentScoreBefore?: number;
  briefAlignmentScoreAfter?: number;
}): ApplyRewriteDecision {
  const {
    scoresBefore, scoresAfter,
    shieldIssuesBefore, shieldIssuesAfter,
    shieldPassedBefore, shieldPassedAfter,
    originalText, rewrittenText,
    originalValidationPassed, rewriteValidationPassed,
    rewriteIsOffNiche,
    rewriteIntroducesUnsourcedNumericClaims,
    hasBrief,
    briefAlignmentScoreBefore,
    briefAlignmentScoreAfter,
  } = params;

  // ─── Safety checks: reject rewrite if it introduces problems ───

  if (rewriteIsOffNiche) {
    return { shouldApply: false, applyReasons: [], rejectedReason: 'rewrite_is_off_niche' };
  }

  if (rewriteIntroducesUnsourcedNumericClaims) {
    return { shouldApply: false, applyReasons: [], rejectedReason: 'rewrite_introduces_unsourced_numeric_claims' };
  }

  if (!rewriteValidationPassed) {
    return { shouldApply: false, applyReasons: [], rejectedReason: 'rewrite_fails_quality_validation' };
  }

  // ─── Phase 2D.3: Brief-backed opportunity protection ───
  // If the opportunity has a _brief, do NOT apply a rewrite that lowers originality
  // solely due to fewer_shield_issues unless it also improves brief_alignment_score
  // or removes a hard failure (e.g., shield now passes, removed slop/bait/missing_originality).

  // ─── Improvement checks: apply if ANY improvement detected ───

  const applyReasons: string[] = [];

  // Condition 1: Originality score improved
  if (scoresAfter.originality > scoresBefore.originality) {
    applyReasons.push('originality_improved');
  }

  // Condition 2: Shield now passes but didn't before
  if (shieldPassedAfter && !shieldPassedBefore) {
    applyReasons.push('shield_now_passes');
  }

  // Condition 3: Fewer shield issues after rewrite
  if (shieldIssuesAfter.length < shieldIssuesBefore.length) {
    applyReasons.push('fewer_shield_issues');
  }

  // Condition 4: Removed slop_forbidden_words
  if (shieldIssuesBefore.includes('slop_forbidden_words') && !shieldIssuesAfter.includes('slop_forbidden_words')) {
    applyReasons.push('removed_slop_forbidden_words');
  }

  // Condition 5: Removed generic bait
  if (detectGenericBait(originalText) && !detectGenericBait(rewrittenText)) {
    applyReasons.push('removed_generic_bait');
  }

  // Condition 6: Removed missing_originality
  if (shieldIssuesBefore.includes('missing_originality') && !shieldIssuesAfter.includes('missing_originality')) {
    applyReasons.push('removed_missing_originality');
  }

  // Condition 7: Rewrite passes quality validation but original did not
  if (!originalValidationPassed && rewriteValidationPassed) {
    applyReasons.push('passes_quality_validation_original_did_not');
  }

  // Condition 8: Brief alignment score improved (Phase 2D.3)
  if (hasBrief && briefAlignmentScoreAfter != null && briefAlignmentScoreBefore != null && briefAlignmentScoreAfter > briefAlignmentScoreBefore) {
    applyReasons.push('brief_alignment_improved');
  }

  // ─── Phase 2D.3: Brief-backed guard ───
  // For brief-backed opportunities, if the only improvement is "fewer_shield_issues"
  // AND originality went DOWN, do NOT apply — this degrades the content.
  const hasHardFailureRemoval = applyReasons.some(r =>
    r === 'shield_now_passes' ||
    r === 'removed_slop_forbidden_words' ||
    r === 'removed_generic_bait' ||
    r === 'removed_missing_originality' ||
    r === 'passes_quality_validation_original_did_not' ||
    r === 'brief_alignment_improved'
  );

  if (hasBrief && scoresAfter.originality < scoresBefore.originality) {
    // Rewrite lowers originality for a brief-backed opportunity.
    // Only allow if there's a hard failure removal or brief alignment improvement.
    if (!hasHardFailureRemoval) {
      return { shouldApply: false, applyReasons: [], rejectedReason: 'brief_backed_rewrite_lowers_originality_without_hard_fix' };
    }
  }

  // ─── Decision ───

  if (applyReasons.length > 0) {
    return { shouldApply: true, applyReasons, rejectedReason: null };
  }

  return { shouldApply: false, applyReasons: [], rejectedReason: 'no_improvement_detected' };
}

// ═══ AI-Powered Scoring ═══

/**
 * Score crafted_text quality using AI.
 * Returns originality, evidence_safety, usefulness on 1-10 scales.
 */
export async function scoreWithAI(text: string): Promise<QualityScores> {
  try {
    const response = await callModel('quality_evaluation' as TaskType, [
      {
        role: 'system',
        content: `You are a content quality evaluator for an X account (@30piq) focused on AI × productivity × career growth.

Score this text on three dimensions (1-10 each):

1. "originality": Does this offer a specific angle, personal/strategic insight, or non-generic framing? Or is it generic AI-style content that could be written by anyone?
   - Generic = 1-4 (vague, could come from any AI, no personal angle)
   - Decent = 5-7 (has some specificity but still feels template-ish)
   - Original = 8-10 (unique angle, personal insight, surprising framing, specific reference)

2. "evidence_safety": Are numeric claims (percentages, statistics, "studies show", rankings, multipliers) properly sourced? Are there any fabricated-seeming statistics?
   - Sourced/safe = 8-10 (no unverified numbers, or all numbers have sources)
   - Borderline = 5-7 (has some numbers that could use a source)
   - Unsafe = 1-4 (fabricated statistics, unsourced "studies show", invented percentages)

3. "usefulness": Is this actionable and useful for a high-value English-speaking audience interested in AI and productivity?
   - Useless = 1-4 (vague platitude, no actionability)
   - Somewhat useful = 5-7 (interesting but not directly actionable)
   - Very useful = 8-10 (specific, actionable, save-worthy)

Return JSON only: {"originality": N, "evidence_safety": N, "usefulness": N}`
      },
      {
        role: 'user',
        content: `Score this text:\n\n"${text}"`
      }
    ], { temperature: 0.0, max_tokens: 200, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(response);
    return {
      originality: clampScore(parsed.originality),
      evidence_safety: clampScore(parsed.evidence_safety),
      usefulness: clampScore(parsed.usefulness)
    };
  } catch {
    // Fallback to heuristic scores if AI fails
    return {
      originality: heuristicOriginality(text),
      evidence_safety: heuristicEvidenceSafety(text),
      usefulness: heuristicUsefulness(text)
    };
  }
}

// ═══ AI-Powered Rewrite ═══

/**
 * Rewrite crafted_text to improve originality.
 * Phase 2C.1: Strengthened rewrite that produces genuinely original angles.
 *
 * The rewrite must:
 * - Produce plain text only, NEVER JSON
 * - Be under 280 characters
 * - Be English only, no Arabic
 * - Avoid AI slop, generic engagement bait, "Yo…", "Interesting take"
 * - Add a specific non-obvious insight
 * - Connect to AI/productivity/career only when source genuinely supports it
 * - NOT invent unsupported facts or introduce unsourced numeric claims
 * - Sound like a smart builder/operator, not a content mill
 * - If a niche-aligned original angle cannot be produced, return null
 *
 * Phase 2C.1 change: Returns { text, failedReason } instead of just string | null
 * so the caller can diagnose WHY the rewrite failed.
 */
export type RewriteResult = {
  text: string | null;
  failedReason: string | null;
  // Phase 2C.2 diagnostics: JSON wrapper cleaning in rewrite output
  rewrite_raw_was_json_wrapper?: boolean;
  rewrite_cleaned_json_wrapper?: boolean;
  rewrite_cleaning_notes?: string;
};

export async function rewriteForOriginality(
  text: string,
  currentScores: QualityScores,
  briefContext?: {
    recommended_angle: string;
    do_not_claim: string[];
    required_context: string[];
  }
): Promise<RewriteResult> {
  try {
    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `You are a content improvement specialist for @30piq (AI × productivity × career growth niche).

Your task: Rewrite this tweet to be GENUINELY ORIGINAL with a specific @30piq-style angle.

Rules (mandatory — violation = rejected rewrite):
1. Return PLAIN TEXT ONLY — no JSON, no markdown, no code fences, no labels, no prefixes
2. Keep it under 280 characters
3. English ONLY — no Arabic, no other languages
4. No AI slop words (delve, crucial, leverage, game-changer, unlock, empower, elevate, foster, streamline, harness, cutting-edge, paradigm, synergy, navigate the landscape, etc.)
5. No hashtags
6. No unsourced numeric claims — remove or rephrase numbers without a source
7. No generic engagement bait: avoid "Yo…", "Interesting take", "Hot take", "Thoughts?", "This.", "So true", "Boom"
8. Add a SPECIFIC, NON-OBVIOUS insight: personal experience, counterintuitive framing, niche tool reference, or operator perspective
9. Only connect to AI/productivity/career if the SOURCE CONTENT genuinely supports such an angle — do NOT force a fake AI angle onto unrelated entertainment content
10. Vary sentence length — mix short punchy fragments with longer explanatory sentences
11. Sound like a smart builder/operator, not a content mill, not a life coach
12. Do NOT add numbers/percentages that weren't in the original unless you have a source
13. Do NOT start with "Here's", "Sure,", or "I'll" — those are AI conversation artifacts${briefContext ? `
14. CRITICAL: Follow the recommended angle: "${briefContext.recommended_angle}". The rewrite MUST adopt this perspective.
15. DO NOT invent personal experience ("I tried", "I found", "my experience") unless the source explicitly supports it.
16. AVOID these specific claims: ${briefContext.do_not_claim.join(', ') || 'none'}
17. INCLUDE this context: ${briefContext.required_context.join(', ') || 'none'}` : ''}

Current scores: originality=${currentScores.originality}/10, evidence_safety=${currentScores.evidence_safety}/10, usefulness=${currentScores.usefulness}/10

If you cannot produce a genuinely original, niche-aligned angle, return "CANNOT_REWRITE_ORIGINALITY".

Return the rewritten text ONLY. No explanation, no quotes, no labels, no JSON.`
      },
      {
        role: 'user',
        content: `Rewrite this to be more original:\n\n"${text}"`
      }
    ], { temperature: 0.4, max_tokens: 300 });

    const rewritten = String(response || '').trim();

    // Check for safe rewrite signal
    if (/CANNOT_REWRITE_ORIGINALITY/i.test(rewritten)) {
      return { text: null, failedReason: 'model_declined_cannot_rewrite' };
    }

    // Validate rewrite — plain text only
    if (!rewritten || rewritten.length < 10 || rewritten.length > MAX_REWRITE_LENGTH) {
      return { text: null, failedReason: `invalid_length:${rewritten?.length || 0}` };
    }

    // If the rewrite contains Arabic, reject it
    if (containsArabic(rewritten)) {
      return { text: null, failedReason: 'arabic_content_in_rewrite' };
    }

    // Phase 2C.2: If the rewrite looks like JSON/markdown wrapper, attempt cleaning
    // before rejecting. The model often returns valid content inside JSON wrappers.
    let rewriteText = rewritten;
    let rewriteRawWasJsonWrapper = false;
    let rewriteCleanedJsonWrapper = false;
    let rewriteCleaningNotes: string | undefined;

    if (looksLikeJsonWrapper(rewritten)) {
      rewriteRawWasJsonWrapper = true;
      const cleanResult = cleanCraftedText(rewritten);

      if (!cleanResult.malformed_json_output && cleanResult.cleaned_text.length >= 10) {
        // Cleaning succeeded — use the cleaned text for further validation
        rewriteText = cleanResult.cleaned_text;
        rewriteCleanedJsonWrapper = true;
        rewriteCleaningNotes = cleanResult.cleaning_notes;
      } else {
        // Cleaning failed — still malformed after attempt
        return {
          text: null,
          failedReason: 'json_wrapper_in_rewrite',
          rewrite_raw_was_json_wrapper: true,
          rewrite_cleaned_json_wrapper: false,
          rewrite_cleaning_notes: cleanResult.cleaning_notes,
        };
      }
    }

    // Validate cleaned rewrite — use rewriteText (may be cleaned from JSON)
    // If the text was cleaned from JSON, use the cleaned version for all subsequent checks
    const textToValidate = rewriteText;

    // Double-check: if the cleaned text STILL looks like JSON, reject it
    if (looksLikeJsonWrapper(textToValidate)) {
      return {
        text: null,
        failedReason: 'json_wrapper_in_rewrite',
        rewrite_raw_was_json_wrapper: true,
        rewrite_cleaned_json_wrapper: rewriteCleanedJsonWrapper || undefined,
        rewrite_cleaning_notes: rewriteCleaningNotes,
      };
    }

    // If the rewrite looks like AI slop wrapper, reject it
    const slopCheck = isAISlopWrapper(textToValidate);
    if (!slopCheck.ok) {
      return {
        text: null,
        failedReason: `ai_slop_in_rewrite:${slopCheck.reason || 'detected'}`,
        rewrite_raw_was_json_wrapper: rewriteRawWasJsonWrapper || undefined,
        rewrite_cleaned_json_wrapper: rewriteCleanedJsonWrapper || undefined,
        rewrite_cleaning_notes: rewriteCleaningNotes,
      };
    }

    // Reject generic engagement bait patterns
    for (const { pattern, name } of GENERIC_BAIT_PATTERNS) {
      if (pattern.test(textToValidate.trim())) {
        return {
          text: null,
          failedReason: `generic_bait_in_rewrite:${name}`,
          rewrite_raw_was_json_wrapper: rewriteRawWasJsonWrapper || undefined,
          rewrite_cleaned_json_wrapper: rewriteCleanedJsonWrapper || undefined,
          rewrite_cleaning_notes: rewriteCleaningNotes,
        };
      }
    }

    return {
      text: textToValidate,
      failedReason: null,
      rewrite_raw_was_json_wrapper: rewriteRawWasJsonWrapper || undefined,
      rewrite_cleaned_json_wrapper: rewriteCleanedJsonWrapper || undefined,
      rewrite_cleaning_notes: rewriteCleaningNotes,
    };
  } catch (err: any) {
    return { text: null, failedReason: `rewrite_exception:${err?.message || 'unknown'}` };
  }
}

// ═══ Main Enhancement Function ═══

/**
 * Enhance a single opportunity's crafted_text.
 *
 * Phase 2C.1 Process:
 * 1. AI-score the text (originality, evidence_safety, usefulness)
 * 2. Determine if rewrite should be triggered (expanded conditions)
 * 3. If triggered, attempt one rewrite
 * 4. Validate rewrite result (plain text, no JSON, no Arabic, no AI slop)
 * 5. Run shield check on rewritten text, compare with original shield state
 * 6. Apply rewrite if ANY improvement detected (originality, shield, bait, validation)
 * 7. Reject rewrite if it introduces problems (off-niche, unsourced claims, fails validation)
 * 8. Record diagnostic fields (rewrite_apply_reason, rewrite_rejected_reason, shield_issues_before/after)
 * 9. Re-run quickShieldCheck after any rewrite attempt
 * 10. Return enhanced opportunity with full diagnostic fields
 *
 * This NEVER bypasses publish_gate. If the rewrite doesn't help,
 * the opportunity goes to publish_gate with its low scores and
 * gets rejected naturally.
 */
export async function enhanceOpportunity(
  opp: OpportunityWithDiagnostics
): Promise<OpportunityWithDiagnostics> {
  const text = opp.crafted_text || '';

  // Skip if no text to enhance
  if (!text || text.length < 10) {
    return {
      ...opp,
      originality_score_before: 0,
      originality_score_after: null,
      evidence_safety_score: 0,
      rewrite_applied: false,
      rewrite_attempted: false,
      quality_notes: 'Empty or too short to enhance'
    };
  }

  // Skip if Arabic content — let publish_gate reject it
  if (containsArabic(text)) {
    return {
      ...opp,
      originality_score_before: 0,
      originality_score_after: null,
      evidence_safety_score: 0,
      rewrite_applied: false,
      rewrite_attempted: false,
      quality_notes: 'Arabic content detected — cannot enhance, will be rejected by publish gate'
    };
  }

  // Skip if off-niche pre-gate rejection already set — do not rewrite off-niche content
  if (opp.pre_gate_rejection_reason === 'off_niche') {
    return {
      ...opp,
      originality_score_before: opp.originality_score_before,
      originality_score_after: opp.originality_score_after,
      evidence_safety_score: opp.evidence_safety_score,
      rewrite_applied: false,
      rewrite_attempted: false,
      rewrite_trigger_reason: 'skipped_off_niche',
      quality_notes: (opp.quality_notes || '') + '; Skipped rewrite: off-niche content'
    };
  }

  // Step 1: Score with AI
  const scoresBefore = await scoreWithAI(text);

  const notes: string[] = [];

  // Step 2: Determine if rewrite should be triggered (expanded conditions)
  const triggerReason = shouldTriggerRewrite(text, scoresBefore, opp);

  let rewriteApplied = false;
  let rewriteAttempted = false;
  let rewriteFailedReason: string | null = null;
  let rewriteApplyReason: string | null = null;
  let rewriteRejectedReason: string | null = null;
  let scoresAfter: QualityScores | null = null;
  let finalText = text;

  // Phase 2C.2: Track rewrite cleaning diagnostics
  let rewriteRawWasJsonWrapper: boolean | undefined;
  let rewriteCleanedJsonWrapper: boolean | undefined;
  let rewriteCleaningNotes: string | undefined;

  // Capture original shield state for before/after comparison
  const shieldIssuesBefore = [...(opp.shield_issues || [])];
  const shieldPassedBefore = opp.shield_passed;
  let shieldIssuesAfter: string[] | null = null;

  if (triggerReason) {
    // Rewrite is warranted — attempt exactly one rewrite
    rewriteAttempted = true;
    notes.push(`Rewrite triggered: ${triggerReason}`);

    const rewriteResult = await rewriteForOriginality(text, scoresBefore, opp._brief ? {
      recommended_angle: opp._brief.recommended_angle || '',
      do_not_claim: opp._brief.do_not_claim || [],
      required_context: opp._brief.required_context || [],
    } : undefined);

    // Phase 2C.2: Capture rewrite cleaning diagnostics from result
    rewriteRawWasJsonWrapper = rewriteResult.rewrite_raw_was_json_wrapper;
    rewriteCleanedJsonWrapper = rewriteResult.rewrite_cleaned_json_wrapper;
    rewriteCleaningNotes = rewriteResult.rewrite_cleaning_notes;

    if (rewriteResult.rewrite_raw_was_json_wrapper) {
      if (rewriteResult.rewrite_cleaned_json_wrapper) {
        notes.push(`Rewrite output was JSON wrapper — cleaned successfully: ${rewriteResult.rewrite_cleaning_notes || ''}`);
      } else {
        notes.push(`Rewrite output was JSON wrapper — cleaning failed`);
      }
    }

    if (rewriteResult.text && rewriteResult.text !== text) {
      // Rewrite produced a non-null, non-identical result
      // Re-score the rewrite
      scoresAfter = await scoreWithAI(rewriteResult.text);

      // Run shield check on the rewritten text to compare with original
      const shieldAfterRewrite = quickShieldCheck(rewriteResult.text, opp);
      shieldIssuesAfter = shieldAfterRewrite.reasons;

      // Run niche alignment on the rewritten text (safety check + for validation)
      const nicheResult = scoreNicheAlignment({ ...opp, crafted_text: rewriteResult.text });

      // Check if rewrite introduces unsourced numeric claims
      const originalNumericClaims = detectNumericClaims(text).length;
      const rewriteNumericClaims = detectNumericClaims(rewriteResult.text).length;
      const rewriteIntroducesUnsourcedClaims = rewriteNumericClaims > originalNumericClaims && !hasSourceForClaim(opp);

      // Run quality validation on both original and rewritten text
      const originalValidation = validateOpportunityQuality({
        ...opp,
        crafted_text: text,
      });
      const rewriteValidation = validateOpportunityQuality({
        ...opp,
        crafted_text: rewriteResult.text,
        niche_alignment_score: nicheResult.niche_alignment_score,
      });

      // Phase 2D.3: Compute brief alignment scores for the rewrite decision
      const hasBrief = Boolean(opp._brief);
      const briefAlignmentScoreBefore = opp._brief_alignment_score;
      let briefAlignmentScoreAfter: number | undefined;
      if (hasBrief && opp._brief) {
        // Import validateBriefAlignment from pipeline-worker for consistency
        // Since we can't import across modules easily, use a simple heuristic:
        // check if the rewritten text contains key angle concepts
        try {
          const { validateBriefAlignment } = require('./pipeline-worker');
          const alignmentAfter = validateBriefAlignment(rewriteResult.text, opp._brief, opp.source_text);
          briefAlignmentScoreAfter = alignmentAfter.score;
        } catch {
          // If import fails, leave undefined
        }
      }

      // Use the pure decision function to determine whether to apply the rewrite
      const decision = shouldApplyRewrite({
        scoresBefore,
        scoresAfter,
        shieldIssuesBefore,
        shieldIssuesAfter: shieldAfterRewrite.reasons,
        shieldPassedBefore,
        shieldPassedAfter: shieldAfterRewrite.safe,
        originalText: text,
        rewrittenText: rewriteResult.text,
        originalValidationPassed: originalValidation.passed,
        rewriteValidationPassed: rewriteValidation.passed,
        rewriteIsOffNiche: nicheResult.is_off_niche,
        rewriteIntroducesUnsourcedNumericClaims: rewriteIntroducesUnsourcedClaims,
        hasBrief,
        briefAlignmentScoreBefore,
        briefAlignmentScoreAfter,
      });

      if (decision.shouldApply) {
        finalText = rewriteResult.text;
        rewriteApplied = true;
        rewriteApplyReason = decision.applyReasons.join(',');
        notes.push(`Rewrite applied (${decision.applyReasons.join(', ')}): originality ${scoresBefore.originality} → ${scoresAfter.originality}`);
      } else {
        rewriteRejectedReason = decision.rejectedReason;
        notes.push(`Rewrite rejected: ${decision.rejectedReason} (originality ${scoresAfter.originality} vs ${scoresBefore.originality}, shield issues ${shieldAfterRewrite.reasons.length} vs ${shieldIssuesBefore.length})`);
      }
    } else if (rewriteResult.text === text) {
      // Rewrite returned identical text
      rewriteFailedReason = 'rewrite_identical_to_original';
      notes.push('Rewrite returned identical text');
    } else {
      // Rewrite returned null — record the exact reason
      rewriteFailedReason = rewriteResult.failedReason || 'rewrite_returned_null';
      notes.push(`Rewrite failed: ${rewriteFailedReason}`);
    }

    // After rewrite attempt (success or fail), update shield on final text
    if (rewriteApplied && shieldIssuesAfter) {
      // Use the shield result from the rewritten text (already computed)
      opp.shield_passed = shieldIssuesAfter.length === 0;
      opp.shield_issues = shieldIssuesAfter;
      notes.push(`Post-rewrite shield: ${opp.shield_passed ? 'passed' : 'failed'} (${shieldIssuesAfter.join(',') || 'no issues'})`);
    } else {
      // Re-run shield check on original text (no rewrite applied)
      const shieldResult = quickShieldCheck(finalText, opp);
      opp.shield_passed = shieldResult.safe;
      opp.shield_issues = shieldResult.reasons;
      shieldIssuesAfter = shieldResult.reasons;
      notes.push(`Post-attempt shield on original: ${shieldResult.safe ? 'passed' : 'failed'} (${shieldResult.reasons.join(',') || 'no issues'})`);
    }
  } else {
    notes.push(`No rewrite needed (originality ${scoresBefore.originality}/10, no shield issues, no bait)`);
  }

  // Step 4: Track evidence safety
  if (scoresBefore.evidence_safety < 6) {
    notes.push(`Evidence safety ${scoresBefore.evidence_safety}/10 — numeric claims may need sources`);
  }

  return {
    ...opp,
    crafted_text: finalText,
    originality_score_before: scoresBefore.originality,
    originality_score_after: scoresAfter?.originality ?? null,
    evidence_safety_score: scoresBefore.evidence_safety,
    rewrite_applied: rewriteApplied,
    rewrite_attempted: rewriteAttempted,
    rewrite_trigger_reason: triggerReason || undefined,
    rewrite_failed_reason: rewriteFailedReason || undefined,
    rewrite_apply_reason: rewriteApplyReason || undefined,
    rewrite_rejected_reason: rewriteRejectedReason || undefined,
    shield_issues_before: shieldIssuesBefore.length > 0 ? shieldIssuesBefore : undefined,
    shield_issues_after: shieldIssuesAfter || undefined,
    // Phase 2C.2: Rewrite cleaning diagnostics
    rewrite_raw_was_json_wrapper: rewriteRawWasJsonWrapper,
    rewrite_cleaned_json_wrapper: rewriteCleanedJsonWrapper,
    rewrite_cleaning_notes: rewriteCleaningNotes,
    quality_notes: notes.join('; ')
  };
}

/**
 * Batch enhance all opportunities.
 * Returns enhanced opportunities with diagnostic fields.
 *
 * Phase 2C.1: Enhanced summary includes rewrite candidates, attempts,
 * failures, and skipped reasons for full diagnostic visibility.
 */
export async function enhanceOpportunities(
  opportunities: OpportunityWithDiagnostics[]
): Promise<{
  enhanced: OpportunityWithDiagnostics[];
  rewrites_applied: number;
  scores_summary: {
    avg_originality_before: number;
    avg_originality_after: number;
    avg_evidence_safety: number;
    avg_usefulness: number;
    below_threshold_before: number;
    below_threshold_after: number;
  };
  // Phase 2C.1: Rewrite diagnostics summary
  rewrite_summary: {
    rewrite_candidates_count: number;
    rewrites_attempted: number;
    rewrites_applied: number;
    rewrites_applied_by_originality: number;
    rewrites_applied_by_shield_improvement: number;
    rewrites_rejected_no_improvement: number;
    rewrites_failed_validation: number;
    rewrites_skipped_reason: Record<string, number>;
    // Phase 2C.2: Rewrite JSON wrapper cleaning stats
    rewrite_json_wrappers_cleaned: number;
    rewrite_json_wrappers_failed_cleaning: number;
  };
}> {
  if (!opportunities?.length) {
    return {
      enhanced: [],
      rewrites_applied: 0,
      scores_summary: {
        avg_originality_before: 0,
        avg_originality_after: 0,
        avg_evidence_safety: 0,
        avg_usefulness: 0,
        below_threshold_before: 0,
        below_threshold_after: 0
      },
      rewrite_summary: {
        rewrite_candidates_count: 0,
        rewrites_attempted: 0,
        rewrites_applied: 0,
        rewrites_applied_by_originality: 0,
        rewrites_applied_by_shield_improvement: 0,
        rewrites_rejected_no_improvement: 0,
        rewrites_failed_validation: 0,
        rewrites_skipped_reason: {},
        rewrite_json_wrappers_cleaned: 0,
        rewrite_json_wrappers_failed_cleaning: 0,
      }
    };
  }

  const enhanced: OpportunityWithDiagnostics[] = [];
  let rewritesApplied = 0;
  let rewritesAttempted = 0;
  let rewritesFailedValidation = 0;
  let rewritesAppliedByOriginality = 0;
  let rewritesAppliedByShieldImprovement = 0;
  let rewritesRejectedNoImprovement = 0;
  let rewriteCandidatesCount = 0;
  const skippedReasons: Record<string, number> = {};
  // Phase 2C.2: Rewrite JSON wrapper cleaning stats
  let rewriteJsonWrappersCleaned = 0;
  let rewriteJsonWrappersFailedCleaning = 0;

  for (const opp of opportunities) {
    const result = await enhanceOpportunity(opp);
    enhanced.push(result);

    // Track rewrite diagnostics
    if (result.rewrite_attempted) {
      rewritesAttempted++;
      rewriteCandidatesCount++;
      // Phase 2C.2: Track JSON wrapper cleaning in rewrite output
      if (result.rewrite_raw_was_json_wrapper) {
        if (result.rewrite_cleaned_json_wrapper) {
          rewriteJsonWrappersCleaned++;
        } else {
          rewriteJsonWrappersFailedCleaning++;
        }
      }
      if (result.rewrite_applied) {
        rewritesApplied++;
        // Track WHY the rewrite was applied
        const applyReason = result.rewrite_apply_reason || '';
        if (applyReason.includes('originality_improved')) {
          rewritesAppliedByOriginality++;
        }
        if (applyReason.includes('shield_now_passes') ||
            applyReason.includes('fewer_shield_issues') ||
            applyReason.includes('removed_slop_forbidden_words') ||
            applyReason.includes('removed_generic_bait') ||
            applyReason.includes('removed_missing_originality')) {
          rewritesAppliedByShieldImprovement++;
        }
      } else {
        rewritesFailedValidation++;
        // Track specific rejection reason
        if (result.rewrite_rejected_reason === 'no_improvement_detected') {
          rewritesRejectedNoImprovement++;
        }
        // Track the specific failure reason
        const reason = result.rewrite_failed_reason || result.rewrite_rejected_reason || 'unknown';
        const reasonKey = reason.split(':')[0]; // Normalize "ai_slop_in_rewrite:ai_slop_here_is" → "ai_slop_in_rewrite"
        skippedReasons[reasonKey] = (skippedReasons[reasonKey] || 0) + 1;
      }
    } else if (result.rewrite_trigger_reason) {
      // Trigger reason exists but rewrite wasn't attempted (shouldn't happen, but track it)
      rewriteCandidatesCount++;
      const reasonKey = 'triggered_but_not_attempted';
      skippedReasons[reasonKey] = (skippedReasons[reasonKey] || 0) + 1;
    }
  }

  // Compute summary
  const count = enhanced.length;
  const originalityBefore = enhanced.reduce((sum, o) => sum + (o.originality_score_before || 0), 0) / count;
  const originalityAfter = enhanced.reduce((sum, o) => sum + (o.originality_score_after ?? o.originality_score_before ?? 0), 0) / count;
  const evidenceSafety = enhanced.reduce((sum, o) => sum + (o.evidence_safety_score || 0), 0) / count;
  const usefulness = enhanced.reduce((sum, o) => {
    // Use after if available, otherwise before
    const before = o.originality_score_before || 0;
    const after = o.originality_score_after;
    return sum + (after !== null && after !== undefined ? after : before);
  }, 0) / count;

  const belowThresholdBefore = enhanced.filter(o => (o.originality_score_before || 0) < ORIGINALITY_THRESHOLD).length;
  const belowThresholdAfter = enhanced.filter(o => {
    const score = o.originality_score_after ?? o.originality_score_before ?? 0;
    return score < ORIGINALITY_THRESHOLD;
  }).length;

  return {
    enhanced,
    rewrites_applied: rewritesApplied,
    scores_summary: {
      avg_originality_before: Math.round(originalityBefore * 10) / 10,
      avg_originality_after: Math.round(originalityAfter * 10) / 10,
      avg_evidence_safety: Math.round(evidenceSafety * 10) / 10,
      avg_usefulness: Math.round(usefulness * 10) / 10,
      below_threshold_before: belowThresholdBefore,
      below_threshold_after: belowThresholdAfter
    },
    rewrite_summary: {
      rewrite_candidates_count: rewriteCandidatesCount,
      rewrites_attempted: rewritesAttempted,
      rewrites_applied: rewritesApplied,
      rewrites_applied_by_originality: rewritesAppliedByOriginality,
      rewrites_applied_by_shield_improvement: rewritesAppliedByShieldImprovement,
      rewrites_rejected_no_improvement: rewritesRejectedNoImprovement,
      rewrites_failed_validation: rewritesFailedValidation,
      rewrites_skipped_reason: skippedReasons,
      // Phase 2C.2: Rewrite JSON wrapper cleaning stats
      rewrite_json_wrappers_cleaned: rewriteJsonWrappersCleaned,
      rewrite_json_wrappers_failed_cleaning: rewriteJsonWrappersFailedCleaning,
    }
  };
}

// ═══ Helper ═══

function clampScore(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n * 10) / 10));
}
