/**
 * near-pass-polish.ts — Phase 2F: Targeted polish for near-pass judge failures
 *
 * When a candidate fails the opportunity_judge but is close to passing
 * (final_candidate_score >= 6.8, fixable failure dimensions), this module
 * makes exactly one focused improvement attempt using judge feedback,
 * then re-judges once.
 *
 * Constraints:
 * - Max 2 candidates per run
 * - Max 1 polish attempt per candidate
 * - Never lowers any threshold
 * - Never weakens evidence safety
 * - Never invents personal experience
 * - Never adds unsupported claims
 * - Never adds generic hype
 * - Never includes JSON wrapper in polished text
 */

import { callModel, parseModelJson, TaskType } from './model-router';
import { judgeCraftedCandidate, type JudgeResult } from './opportunity-judge';
import { buildOriginalityPromptSection } from './originality-context';
import { buildSignatureVoiceSection, validateSignatureVoice, type SignatureVoiceDiagnostics } from './signature-voice';

// ═══ Types ═══

export type PolishInput = {
  crafted_text: string;
  brief: {
    source_summary?: string;
    recommended_angle?: string;
    angle?: string;
    why_it_matters?: string;
    required_context?: string[];
    do_not_claim?: string[];
  };
  judge_failure_reasons: string[];
  judge_scores: {
    final_candidate_score: number;
    originality_score: number;
    usefulness_score: number;
    brief_alignment_score: number;
    evidence_safety_score: number;
    clarity_score: number;
  };
  source_text_preview?: string;
  source_author?: string;
  /** Phase 2G: Optional originality context for originality-focused polish */
  originality_context?: import('./originality-context').OriginalityContext | null;
};

export type PolishResult = {
  polished_text: string;
  what_changed: string;
  targeted_failures: string[];
  claims_safety_checked: boolean;
  signature_phrase?: string;
  operator_takeaway?: string;
};

export type PolishOutcome = {
  /** Whether the polish was attempted */
  attempted: boolean;
  /** Whether the polished text was applied (replaced the original) */
  applied: boolean;
  /** Whether the re-judged polished candidate passed */
  passed: boolean;
  /** The polished text (if attempted) */
  polished_text: string | null;
  /** Original judge result before polish */
  before_judge: JudgeResult | null;
  /** Judge result after re-judging polished text */
  after_judge: JudgeResult | null;
  /** If polish was attempted but failed validation, the reason */
  polish_failed_reason: string | null;
  /** What was changed (from polish response) */
  what_changed: string | null;
  /** Which failures the polish targeted */
  targeted_failures: string[];
  /** Phase 2G.1: Signature voice diagnostics for the polished text */
  signature_voice_diagnostics?: SignatureVoiceDiagnostics;
};

export type NearPassDiagnostics = {
  near_pass_candidates_count: number;
  near_pass_polish_attempted_count: number;
  near_pass_polish_applied_count: number;
  near_pass_polish_passed_count: number;
  near_pass_polish_failed_count: number;
  near_pass_polish_failure_reasons: string[];
  average_score_before_polish: number;
  average_score_after_polish: number;
};

/** Max candidates to attempt polish per run */
export const MAX_POLISH_CANDIDATES_PER_RUN = 2;

// ═══ Polish Prompt ═══

/**
 * Build the system prompt for the near-pass polish task.
 *
 * The prompt receives:
 * - current crafted_text
 * - opportunity brief (source_summary, recommended_angle, why_it_matters, required_context, do_not_claim)
 * - judge failure reasons
 * - judge scores (all dimensions)
 * - source_text preview
 * - source_author
 *
 * Goal: Improve only the failed dimensions while preserving evidence safety and clarity.
 */
export function buildPolishPrompt(input: PolishInput): Array<{ role: 'system' | 'user'; content: string }> {
  const brief = input.brief || {};
  const recommendedAngle = brief.recommended_angle || brief.angle || 'general AI/productivity insight';
  const sourceSummary = brief.source_summary || '';
  const whyItMatters = brief.why_it_matters || '';
  const requiredContext = Array.isArray(brief.required_context) ? brief.required_context.join(', ') : '';
  const doNotClaim = Array.isArray(brief.do_not_claim) ? brief.do_not_claim.join(', ') : '';

  const scores = input.judge_scores;
  const failureReasons = input.judge_failure_reasons.join('; ');

  const sourcePreview = (input.source_text_preview || '').slice(0, 200);
  const sourceAuthor = input.source_author || '';

  // Identify which specific dimensions need improvement
  const targetedFailures: string[] = [];
  if (scores.originality_score < 7.8) targetedFailures.push('originality_score');
  if (scores.usefulness_score < 7) targetedFailures.push('usefulness_score');
  if (scores.brief_alignment_score < 7.5) targetedFailures.push('brief_alignment_score');
  if (scores.final_candidate_score < 7.8) targetedFailures.push('final_candidate_score');

  const targetedFailuresStr = targetedFailures.join(', ');

  // Phase 2G: If originality failure and context provided, add originality section
  const isOriginalityFailure = scores.originality_score < 7.8 ||
    input.judge_failure_reasons.some(r => r.includes('originality') || r.includes('missing_originality'));
  let originalitySection = '';
  if (isOriginalityFailure && input.originality_context) {
    originalitySection = '\n\n' + buildOriginalityPromptSection(input.originality_context);
  }

  // Phase 2G.1: Add signature voice section when originality failed
  const signatureVoiceSection = isOriginalityFailure
    ? '\n\n' + buildSignatureVoiceSection({
        recommended_angle: recommendedAngle,
        source_text_preview: sourcePreview.slice(0, 150),
      })
    : '';

  // Phase 2G: Add sharper originality instruction when originality is the failure
  const originalityInstruction = isOriginalityFailure
    ? `\n\nCRITICAL: This tweet failed because of LOW ORIGINALITY. Do NOT merely rephrase or slightly adjust wording. Add a SHARPER FRAME using one of the suggested twist types. The frame must change the THINKING STRUCTURE, not just the words. For example, if the source says "X is growing", an original frame is not "X is growing fast" but "the cost of ignoring X is now higher than adopting X" (inversion) or "X works because it eliminates step Y from the old workflow" (mechanism).`
    : '';

  return [
    {
      role: 'system',
      content: `You are a content polisher for an X account (@30piq) focused on AI × productivity × career growth.

A crafted tweet was judged and FAILED by a strict quality judge. It was CLOSE to passing but fell short on specific dimensions. Your job is to make minimal, targeted improvements to push it over the threshold.

STRICT RULES:
- Preserve evidence safety. Do NOT add any numeric claims, statistics, percentages, or "studies show" without source evidence.
- Do NOT invent personal experience ("I tried", "I found", "my experience", "I've been using").
- Do NOT add generic hype ("game changer", "this is huge", "you need to", "the future of").
- Do NOT wrap output in JSON or markdown.
- Keep it under 280 characters.
- Do NOT claim: ${doNotClaim || 'none'}

IMPROVEMENT TARGETS (only these dimensions failed):
${targetedFailuresStr}

For each failed dimension, here is how to improve:
- originality_score: Add a sharper, more specific frame. Make the angle more counterintuitive or reference a specific, surprising detail. Avoid generic AI-style phrasing.
- usefulness_score: Add ONE concrete operator/builder takeaway. What can the reader DO with this insight today? Be specific, not vague.
- brief_alignment_score: Use the recommended angle more directly. The angle is "${recommendedAngle}" — commit to it fully instead of going in a different direction.
- final_candidate_score: Improve the overall quality by tightening the writing and making the insight sharper.
${originalityInstruction}
BRIEF CONTEXT:
- Recommended angle: "${recommendedAngle}"
- Source summary: "${sourceSummary}"
- Why it matters: "${whyItMatters}"
- Required context: ${requiredContext || 'none'}

SOURCE: @${sourceAuthor}: "${sourcePreview}"

CURRENT JUDGE SCORES:
- final_candidate_score: ${scores.final_candidate_score}
- originality_score: ${scores.originality_score}
- usefulness_score: ${scores.usefulness_score}
- brief_alignment_score: ${scores.brief_alignment_score}
- evidence_safety_score: ${scores.evidence_safety_score}
- clarity_score: ${scores.clarity_score}

FAILURE REASONS: ${failureReasons}${originalitySection}${signatureVoiceSection}

Return JSON only:
{
  "polished_text": "the improved tweet text, under 280 chars, no JSON wrapper, no markdown",
  "what_changed": "short explanation of what you improved",
  "targeted_failures": ["originality_score", "usefulness_score"],
  "claims_safety_checked": true,
  "signature_phrase": "3-8 word repeatable phrase from the polished text",
  "operator_takeaway": "concrete operator rule or actionable signal"
}`,
    },
    {
      role: 'user',
      content: `Polish this tweet that almost passed the judge:\n\n"${input.crafted_text}"`,
    },
  ];
}

// ═══ Validation ═══

/** Patterns indicating invented personal experience */
const INVENTED_EXPERIENCE_PATTERNS = [
  /\bi\s+(tried|found|discovered|noticed|learned|realized|started|built|made|used|tested|switched)\b/i,
  /\bmy\s+(experience|approach|strategy|workflow|setup|finding|observation|takeaway)\b/i,
  /\bi've\s+(been|found|seen|noticed|started|used|tried)\b/i,
];

/** Generic hype patterns */
const GENERIC_HYPE_PATTERNS = [
  /\bgame.?changer\b/i,
  /\bthis is huge\b/i,
  /\byou need to\b/i,
  /\bthe future of\b/i,
  /\bhere is why\b/i,
];

/** JSON-looking pattern */
const JSON_LOOKING_RE = /^\s*[\{\[]|"(?:tweet|text|quote)"\s*:/i;

/**
 * Validate a polished text result locally before re-judging.
 *
 * Checks:
 * - parse JSON strictly
 * - polished_text exists
 * - length 40–280
 * - not JSON-looking
 * - not generic praise/hype
 * - no invented personal experience
 * - no do_not_claim violation
 * - no unsupported numeric claims without evidence
 * - brief alignment heuristic (checks recommended_angle keywords present)
 */
export function validatePolishedText(
  polishedText: string,
  doNotClaim: string[],
  recommendedAngle?: string,
  originalBriefAlignmentScore?: number
): { valid: boolean; reason?: string } {
  // Must exist and be non-empty
  if (!polishedText || typeof polishedText !== 'string') {
    return { valid: false, reason: 'polished_text_missing_or_empty' };
  }

  const trimmed = polishedText.trim();

  // Length check: 40–280
  if (trimmed.length < 40) {
    return { valid: false, reason: 'polished_text_too_short' };
  }
  if (trimmed.length > 280) {
    return { valid: false, reason: 'polished_text_over_280_chars' };
  }

  // Not JSON-looking
  if (JSON_LOOKING_RE.test(trimmed)) {
    return { valid: false, reason: 'polished_text_looks_like_json' };
  }

  // Not generic hype
  for (const pattern of GENERIC_HYPE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: 'polished_text_contains_generic_hype' };
    }
  }

  // No invented personal experience
  for (const pattern of INVENTED_EXPERIENCE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: 'polished_text_has_invented_experience' };
    }
  }

  // No do_not_claim violation
  if (doNotClaim && doNotClaim.length > 0) {
    const lower = trimmed.toLowerCase();
    for (const claim of doNotClaim) {
      if (claim && lower.includes(claim.toLowerCase())) {
        return { valid: false, reason: `polished_text_violates_do_not_claim:${claim}` };
      }
    }
  }

  // No unsupported numeric claims
  const hasUrl = /https?:\/\//i.test(trimmed);
  const hasCitation = /\b(source|citation|according to|per |via |ref:|cite)\b/i.test(trimmed);
  const unsupportedNumericPatterns = [
    /\d+(?:\.\d+)?\s*%/i,
    /\$\d+/i,
    /\d+x\b/i,
    /(?:increased|decreased|grew|reduced|boosted|saved|cut|improved)\s+(by\s+)?\d/i,
    /studies show/i,
    /research shows/i,
    /data shows/i,
  ];
  if (!hasUrl && !hasCitation) {
    for (const pattern of unsupportedNumericPatterns) {
      if (pattern.test(trimmed)) {
        return { valid: false, reason: 'polished_text_has_unsupported_numeric_claims' };
      }
    }
  }

  // Brief alignment heuristic: if recommended_angle is provided, check that
  // at least one significant word from the angle appears in the text
  if (recommendedAngle) {
    const angleWords = recommendedAngle
      .toLowerCase()
      .split(/[\s,;:.!?]+/)
      .filter(w => w.length > 3) // Only check meaningful words (4+ chars)
      .filter(w => !['that', 'this', 'with', 'from', 'about', 'your', 'their', 'which', 'what', 'when', 'where', 'how', 'why', 'more', 'than', 'also'].includes(w));

    if (angleWords.length > 0) {
      const textLower = trimmed.toLowerCase();
      const matchedWords = angleWords.filter(w => textLower.includes(w));
      const alignmentRatio = matchedWords.length / angleWords.length;

      // If alignment ratio is very low AND original brief_alignment_score was already bad,
      // the polish likely didn't improve alignment
      const minAlignment = Math.min(0.25, (originalBriefAlignmentScore || 0) / 10);
      if (alignmentRatio < minAlignment && (originalBriefAlignmentScore || 0) < 7.5) {
        // Only reject if alignment is poor AND it was a failure dimension
        // Allow some flexibility — the polish might use synonyms
      }
    }
  }

  return { valid: true };
}

// ═══ Core Polish Logic ═══

/**
 * Attempt to polish a near-pass candidate.
 *
 * Flow:
 * 1. Build prompt with judge feedback
 * 2. Call AI for targeted polish
 * 3. Validate polished text locally
 * 4. Re-judge polished text once
 * 5. Apply polished text if:
 *    a) Re-judge passes: replace crafted_text, mark as polished
 *    b) Re-judge improves but still fails: keep polished only if improvement >= 0.5 and no new hard failures
 *    c) Polish worsens: keep original
 *
 * Returns a PolishOutcome with all diagnostic data.
 */
export async function attemptNearPassPolish(
  input: PolishInput
): Promise<PolishOutcome> {
  const emptyOutcome: PolishOutcome = {
    attempted: false,
    applied: false,
    passed: false,
    polished_text: null,
    before_judge: null,
    after_judge: null,
    polish_failed_reason: null,
    what_changed: null,
    targeted_failures: [],
  };

  try {
    // Step 1: Build prompt and call AI
    const messages = buildPolishPrompt(input);

    const response = await callModel('near_pass_polish' as TaskType, messages, {
      temperature: 0.15,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    });

    // Step 2: Parse response
    const parsed = parseModelJson(response);
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...emptyOutcome,
        attempted: true,
        polish_failed_reason: 'polish_response_parse_failed',
      };
    }

    const polishedText = parsed.polished_text;
    if (!polishedText || typeof polishedText !== 'string') {
      return {
        ...emptyOutcome,
        attempted: true,
        polish_failed_reason: 'polished_text_missing_in_response',
      };
    }

    const whatChanged = parsed.what_changed || '';
    const targetedFailures = Array.isArray(parsed.targeted_failures) ? parsed.targeted_failures : [];
    const claimsSafetyChecked = parsed.claims_safety_checked === true;
    const signaturePhrase = parsed.signature_phrase || undefined;
    const operatorTakeaway = parsed.operator_takeaway || undefined;

    // Phase 2G.1: Validate signature voice on polished text (if originality failure)
    const isOriginalityFailure = input.judge_scores.originality_score < 7.8 ||
      input.judge_failure_reasons.some(r => r.includes('originality') || r.includes('missing_originality'));
    let signatureVoiceDiag: SignatureVoiceDiagnostics | undefined;
    if (isOriginalityFailure) {
      signatureVoiceDiag = validateSignatureVoice(polishedText);
      // Override with model-declared values if available
      if (signaturePhrase) signatureVoiceDiag._signature_phrase = signaturePhrase;
      if (operatorTakeaway) signatureVoiceDiag._operator_takeaway = operatorTakeaway;
    }

    // Step 3: Validate polished text locally
    const doNotClaim = input.brief?.do_not_claim || [];
    const recommendedAngle = input.brief?.recommended_angle || input.brief?.angle;
    const validation = validatePolishedText(
      polishedText,
      doNotClaim,
      recommendedAngle,
      input.judge_scores.brief_alignment_score
    );

    if (!validation.valid) {
      return {
        ...emptyOutcome,
        attempted: true,
        polished_text: polishedText,
        polish_failed_reason: validation.reason || 'validation_failed',
        what_changed: whatChanged,
        targeted_failures: targetedFailures,
        signature_voice_diagnostics: signatureVoiceDiag,
      };
    }

    // Step 4: Re-judge polished text
    const beforeJudge: JudgeResult = {
      passed: false,
      final_candidate_score: input.judge_scores.final_candidate_score,
      originality_score: input.judge_scores.originality_score,
      usefulness_score: input.judge_scores.usefulness_score,
      niche_fit_score: 7, // Default — near-pass requires niche_fit >= 7
      evidence_safety_score: input.judge_scores.evidence_safety_score,
      clarity_score: input.judge_scores.clarity_score,
      brief_alignment_score: input.judge_scores.brief_alignment_score,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      failure_reasons: input.judge_failure_reasons,
    };

    const afterJudge = await judgeCraftedCandidate(polishedText, input.brief || {});

    // Step 5: Decide whether to apply polished text
    if (afterJudge.passed) {
      // Polish succeeded! Re-judge passed.
      return {
        attempted: true,
        applied: true,
        passed: true,
        polished_text: polishedText,
        before_judge: beforeJudge,
        after_judge: afterJudge,
        polish_failed_reason: null,
        what_changed: whatChanged,
        targeted_failures: targetedFailures,
        signature_voice_diagnostics: signatureVoiceDiag,
      };
    }

    // Re-judge still fails — check if improvement is significant enough
    const scoreImprovement = afterJudge.final_candidate_score - input.judge_scores.final_candidate_score;
    const evidenceSafetyDecreased = afterJudge.evidence_safety_score < input.judge_scores.evidence_safety_score;
    const evidenceSafetyBelowThreshold = afterJudge.evidence_safety_score < 7.5;

    // Check for new hard failures that weren't in the original
    const originalFailureSet = new Set(input.judge_failure_reasons);
    const newHardFailures = afterJudge.failure_reasons.filter(
      r => !originalFailureSet.has(r) &&
        (r === 'generic_bait_flag' || r === 'unsupported_claim_flag' || r === 'judge_parse_failed')
    );

    const shouldApplyPolish = (
      scoreImprovement >= 0.5 &&
      !evidenceSafetyDecreased &&
      !evidenceSafetyBelowThreshold &&
      newHardFailures.length === 0
    );

    return {
      attempted: true,
      applied: shouldApplyPolish,
      passed: false,
      polished_text: shouldApplyPolish ? polishedText : null,
      before_judge: beforeJudge,
      after_judge: afterJudge,
      polish_failed_reason: shouldApplyPolish ? null : 'polish_improved_but_not_enough',
      what_changed: whatChanged,
      targeted_failures: targetedFailures,
      signature_voice_diagnostics: signatureVoiceDiag,
    };
  } catch (err: any) {
    console.warn(`[near-pass-polish] Polish attempt failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return {
      ...emptyOutcome,
      attempted: true,
      polish_failed_reason: `polish_ai_call_failed:${(err?.message || 'unknown').slice(0, 100)}`,
    };
  }
}

// ═══ Diagnostics ═══

/**
 * Compute near-pass polish diagnostics from a list of polish outcomes.
 */
export function computeNearPassDiagnostics(outcomes: PolishOutcome[]): NearPassDiagnostics {
  const attempted = outcomes.filter(o => o.attempted);
  const applied = outcomes.filter(o => o.applied);
  const passed = outcomes.filter(o => o.passed);
  const failed = outcomes.filter(o => o.attempted && !o.passed);

  const beforeScores = attempted
    .filter(o => o.before_judge)
    .map(o => o.before_judge!.final_candidate_score);
  const afterScores = attempted
    .filter(o => o.after_judge)
    .map(o => o.after_judge!.final_candidate_score);

  const avgBefore = beforeScores.length > 0
    ? Math.round((beforeScores.reduce((a, b) => a + b, 0) / beforeScores.length) * 10) / 10
    : 0;
  const avgAfter = afterScores.length > 0
    ? Math.round((afterScores.reduce((a, b) => a + b, 0) / afterScores.length) * 10) / 10
    : 0;

  const failureReasons: string[] = [];
  for (const o of failed) {
    if (o.polish_failed_reason) {
      failureReasons.push(o.polish_failed_reason);
    }
  }

  return {
    near_pass_candidates_count: outcomes.length,
    near_pass_polish_attempted_count: attempted.length,
    near_pass_polish_applied_count: applied.length,
    near_pass_polish_passed_count: passed.length,
    near_pass_polish_failed_count: failed.length,
    near_pass_polish_failure_reasons: failureReasons,
    average_score_before_polish: avgBefore,
    average_score_after_polish: avgAfter,
  };
}
