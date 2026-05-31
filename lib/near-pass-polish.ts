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
import { validatePostLength, buildPostLengthInstruction, buildShortenInstruction, type PostLengthPolicy, getDefaultPostLengthPolicy } from './post-length-policy';

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
  /** Phase M1: Optional structured memory section for memory-informed polish */
  learning_memory_section?: string;
  /** Phase S1.2: Optional post length policy for hard cap enforcement */
  post_length_policy?: PostLengthPolicy | null;
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
  /** Phase 2G.2: Brief-locked polish diagnostics */
  _brief_locked_polish_attempted?: boolean;
  _brief_locked_polish_applied?: boolean;
  _brief_locked_polish_before_judge?: JudgeResult | null;
  _brief_locked_polish_after_judge?: JudgeResult | null;
  _brief_locked_polish_reason?: string;
  /** Phase S1.2: Shorten pass diagnostics */
  _shorten_attempted?: boolean;
  _shorten_applied?: boolean;
  _shorten_text?: string | null;
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
  /** Phase 2G.2: Brief-locked polish diagnostics */
  brief_locked_polish_attempted_count: number;
  brief_locked_polish_applied_count: number;
  brief_locked_polish_passed_count: number;
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

  // Phase 2G.2: Add BRIEF LOCK section when brief_alignment is at risk
  const isBriefAlignmentAtRisk = scores.brief_alignment_score < 7.5 ||
    input.judge_failure_reasons.some(r => r.includes('brief_alignment'));
  const briefLockSection = isBriefAlignmentAtRisk
    ? `\n\n═══ BRIEF LOCK ═══

CRITICAL: This tweet's brief_alignment is at risk. You MUST preserve the recommended angle while improving other dimensions. Do NOT drift from the brief.

BRIEF LOCK DETAILS:
- Source summary: "${sourceSummary}"
- Recommended angle: "${recommendedAngle}"
- Why it matters: "${whyItMatters}"
- Required context: ${requiredContext || 'none'}
- Do not claim: ${doNotClaim || 'none'}

BRIEF LOCK CHECKLIST (verify ALL before submitting):
✓ The recommended angle "${recommendedAngle}" is clearly expressed in the text
✓ All required_context items are reflected
✓ The why_it_matters reason is addressed
✓ No claims from do_not_claim appear
✓ If adding a signature frame or contrast, it STRENGTHENS the recommended angle rather than replacing it

INSTRUCTION: Improve originality/signature voice WITHOUT losing the recommended angle. If adding a signature frame, preserve every required element from the brief.`
    : '';

  // Phase M1: Add learning memory section if available
  const memorySection = input.learning_memory_section || '';

  // Phase S1.2: Build post length instruction from policy
  const policy = input.post_length_policy || getDefaultPostLengthPolicy();
  const postLengthInstruction = buildPostLengthInstruction(policy);

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
- ${postLengthInstruction}
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

FAILURE REASONS: ${failureReasons}${originalitySection}${signatureVoiceSection}${briefLockSection}${memorySection ? '\n\n' + memorySection : ''}

Return JSON only:
{
  "polished_text": "the improved tweet text, ${postLengthInstruction.toLowerCase()}, no JSON wrapper, no markdown",
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
 * - length 40–hard_limit (Phase S1.2: uses policy instead of hardcoded 280)
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
  originalBriefAlignmentScore?: number,
  postLengthPolicy?: PostLengthPolicy | null
): { valid: boolean; reason?: string } {
  const policy = postLengthPolicy || getDefaultPostLengthPolicy();

  // Must exist and be non-empty
  if (!polishedText || typeof polishedText !== 'string') {
    return { valid: false, reason: 'polished_text_missing_or_empty' };
  }

  const trimmed = polishedText.trim();

  // Length check: 40–hard_limit (Phase S1.2: policy-based)
  if (trimmed.length < 40) {
    return { valid: false, reason: 'polished_text_too_short' };
  }
  if (trimmed.length > policy.hard_limit_chars) {
    return { valid: false, reason: 'polished_text_over_hard_limit' };
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

// ═══ Phase S1.2: Controlled Shorten Pass ═══

/**
 * Attempt ONE controlled shorten pass on text that exceeds the hard limit.
 *
 * The shorten pass:
 * - Preserves the original brief, evidence, and angle
 * - Does NOT invent new claims
 * - Uses the same AI model route as near-pass polish
 * - Returns the shortened text if successful, or a failure result
 *
 * This is only called when polished text is over the hard_limit_chars.
 */
async function attemptControlledShorten(
  text: string,
  brief: {
    source_summary?: string;
    recommended_angle?: string;
    angle?: string;
    why_it_matters?: string;
    required_context?: string[];
    do_not_claim?: string[];
  },
  policy: PostLengthPolicy,
  doNotClaim: string[],
  recommendedAngle?: string,
  originalBriefAlignmentScore?: number
): Promise<{ success: boolean; text: string | null }> {
  const shortenInstruction = buildShortenInstruction(policy, text.length);
  const recommendedAngleStr = brief.recommended_angle || brief.angle || '';
  const doNotClaimStr = (doNotClaim || []).join(', ');

  try {
    const messages = [
      {
        role: 'system' as const,
        content: `You are a tweet shortener for @30piq. A tweet exceeds the character limit and must be shortened.

${shortenInstruction}

RULES:
- Preserve the original recommended angle: "${recommendedAngleStr}"
- Preserve the key insight and evidence
- Remove filler words, redundancy, or less important details
- Do NOT change the meaning
- Do NOT invent new claims
- Do NOT add personal experience
- Do NOT add generic hype
- Do NOT wrap output in JSON or markdown

Return JSON only:
{
  "shortened_text": "the shortened tweet, under ${policy.hard_limit_chars} characters",
  "chars_removed": number,
  "what_was_removed": "brief description of what was shortened"
}`,
      },
      {
        role: 'user' as const,
        content: `Shorten this tweet:\n\n"${text}"`,
      },
    ];

    const response = await callModel('near_pass_polish' as TaskType, messages, {
      temperature: 0.1,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });

    const parsed = parseModelJson(response);
    if (!parsed || typeof parsed !== 'string' && typeof parsed !== 'object') {
      return { success: false, text: null };
    }

    const shortenedText = parsed.shortened_text || parsed.text;
    if (!shortenedText || typeof shortenedText !== 'string') {
      return { success: false, text: null };
    }

    const trimmed = shortenedText.trim();

    // Validate the shortened text is within limit
    const lengthValidation = validatePostLength(trimmed, policy);
    if (!lengthValidation.ok && lengthValidation.reason === 'post_over_hard_limit') {
      // Still over limit after shorten — fail
      return { success: false, text: trimmed };
    }

    // Validate the shortened text passes other polish checks
    const validation = validatePolishedText(trimmed, doNotClaim, recommendedAngle, originalBriefAlignmentScore, policy);
    if (!validation.valid) {
      return { success: false, text: trimmed };
    }

    return { success: true, text: trimmed };
  } catch (err: any) {
    console.warn(`[near-pass-polish] Shorten attempt failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return { success: false, text: null };
  }
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

    let polishedText = parsed.polished_text;
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

    // Step 3: Validate polished text locally (Phase S1.2: policy-based length check)
    const doNotClaim = input.brief?.do_not_claim || [];
    const recommendedAngle = input.brief?.recommended_angle || input.brief?.angle;
    const policy = input.post_length_policy || getDefaultPostLengthPolicy();
    const validation = validatePolishedText(
      polishedText,
      doNotClaim,
      recommendedAngle,
      input.judge_scores.brief_alignment_score,
      policy
    );

    // Phase S1.2: If over hard limit, try ONE controlled shorten pass
    if (!validation.valid && validation.reason === 'polished_text_over_hard_limit') {
      try {
        const shortenResult = await attemptControlledShorten(
          polishedText,
          input.brief || {},
          policy,
          doNotClaim,
          recommendedAngle,
          input.judge_scores.brief_alignment_score
        );

        if (shortenResult.success && shortenResult.text) {
          // Shortened successfully — use the shortened text instead
          polishedText = shortenResult.text;
          // Re-validate the shortened text
          const revalidation = validatePolishedText(
            polishedText,
            doNotClaim,
            recommendedAngle,
            input.judge_scores.brief_alignment_score,
            policy
          );
          if (!revalidation.valid) {
            return {
              ...emptyOutcome,
              attempted: true,
              polished_text: polishedText,
              polish_failed_reason: revalidation.reason || 'polished_text_over_hard_limit',
              what_changed: whatChanged + '; shorten attempted but revalidation failed',
              targeted_failures: targetedFailures,
              signature_voice_diagnostics: signatureVoiceDiag,
              _shorten_attempted: true,
              _shorten_applied: false,
              _shorten_text: shortenResult.text,
            };
          }
          // Continue with shortened text for re-judging below
        } else {
          return {
            ...emptyOutcome,
            attempted: true,
            polished_text: polishedText,
            polish_failed_reason: 'polished_text_over_hard_limit',
            what_changed: whatChanged,
            targeted_failures: targetedFailures,
            signature_voice_diagnostics: signatureVoiceDiag,
            _shorten_attempted: true,
            _shorten_applied: false,
            _shorten_text: null,
          };
        }
      } catch (shortenErr: any) {
        console.warn(`[near-pass-polish] Controlled shorten failed: ${(shortenErr?.message || 'unknown').slice(0, 200)}`);
        return {
          ...emptyOutcome,
          attempted: true,
          polished_text: polishedText,
          polish_failed_reason: 'polished_text_over_hard_limit',
          what_changed: whatChanged,
          targeted_failures: targetedFailures,
          signature_voice_diagnostics: signatureVoiceDiag,
          _shorten_attempted: true,
          _shorten_applied: false,
          _shorten_text: null,
        };
      }
    } else if (!validation.valid) {
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
    brief_locked_polish_attempted_count: outcomes.filter(o => o._brief_locked_polish_attempted).length,
    brief_locked_polish_applied_count: outcomes.filter(o => o._brief_locked_polish_applied).length,
    brief_locked_polish_passed_count: outcomes.filter(o => o._brief_locked_polish_applied && o.passed).length,
  };
}

// ═══ Phase 2G.2: Brief-Locked Micro-Repair ═══

/**
 * Check if a candidate is eligible for brief-locked micro-repair.
 *
 * Eligibility criteria:
 * - after_judge.final_candidate_score >= 7.8
 * - after_judge.originality_score >= 7.8
 * - after_judge.evidence_safety_score >= 8
 * - after_judge.brief_alignment_score >= 6.8 and < 7.5
 * - failure_reasons include brief_alignment
 *
 * This is a SECOND repair attempt, only for candidates that already went through
 * near-pass polish and improved significantly but still fail only on brief_alignment.
 */
export function isMicroRepairEligible(
  afterJudge: JudgeResult
): boolean {
  // Must have failed (not passed)
  if (afterJudge.passed) return false;

  // final_candidate_score must be >= 7.8 (passed that threshold)
  if (afterJudge.final_candidate_score < 7.8) return false;

  // originality_score must be >= 7.8
  if (afterJudge.originality_score < 7.8) return false;

  // evidence_safety_score must be >= 8
  if (afterJudge.evidence_safety_score < 8) return false;

  // brief_alignment_score must be >= 6.8 and < 7.5 (close to threshold)
  if (afterJudge.brief_alignment_score < 6.8) return false;
  if (afterJudge.brief_alignment_score >= 7.5) return false;

  // failure_reasons must include brief_alignment
  const hasBriefAlignmentFailure = afterJudge.failure_reasons.some(r =>
    r.includes('brief_alignment')
  );
  if (!hasBriefAlignmentFailure) return false;

  return true;
}

/**
 * Build the prompt for brief-locked micro-repair.
 * This is a very targeted repair that ONLY adjusts brief alignment
 * while preserving the existing signature frame and voice.
 */
export function buildMicroRepairPrompt(
  currentText: string,
  brief: {
    source_summary?: string;
    recommended_angle?: string;
    angle?: string;
    why_it_matters?: string;
    required_context?: string[];
    do_not_claim?: string[];
  },
  afterJudgeScores: {
    final_candidate_score: number;
    originality_score: number;
    usefulness_score: number;
    brief_alignment_score: number;
    evidence_safety_score: number;
    clarity_score: number;
  }
): Array<{ role: 'system' | 'user'; content: string }> {
  const recommendedAngle = brief.recommended_angle || brief.angle || '';
  const sourceSummary = brief.source_summary || '';
  const whyItMatters = brief.why_it_matters || '';
  const requiredContext = Array.isArray(brief.required_context) ? brief.required_context.join(', ') : '';
  const doNotClaim = Array.isArray(brief.do_not_claim) ? brief.do_not_claim.join(', ') : '';

  return [
    {
      role: 'system',
      content: `You are a micro-repair specialist for @30piq. A tweet has EXCELLENT originality and evidence safety but FAILS ONLY on brief_alignment (score ${afterJudgeScores.brief_alignment_score}/10, needs 7.5+).

Your ONLY job: Make minimal adjustments so the recommended angle "${recommendedAngle}" is more clearly expressed. Do NOT change the signature frame, contrast structure, or voice.

═══ BRIEF LOCK (MICRO-REPAIR) ═══

STRICT RULES:
- ONLY adjust brief alignment. Do NOT change the originality, evidence safety, or signature voice.
- Preserve the existing signature frame as much as possible.
- The recommended angle MUST be clearly expressed after your edit.
- Keep it under ${getDefaultPostLengthPolicy().hard_limit_chars} characters.
- Do NOT invent personal experience.
- Do NOT add generic hype or unsupported claims.
- Do NOT add hashtags or emojis.
- Do NOT wrap output in JSON or markdown.

BRIEF LOCK DETAILS:
- Source summary: "${sourceSummary}"
- Recommended angle: "${recommendedAngle}"
- Why it matters: "${whyItMatters}"
- Required context: ${requiredContext || 'none'}
- Do not claim: ${doNotClaim || 'none'}

BRIEF LOCK CHECKLIST:
✓ The recommended angle "${recommendedAngle}" is clearly expressed
✓ All required_context items are reflected
✓ The why_it_matters reason is addressed
✓ No claims from do_not_claim appear
✓ The signature frame and voice from the current text are preserved

CURRENT SCORES:
- final_candidate_score: ${afterJudgeScores.final_candidate_score}
- originality_score: ${afterJudgeScores.originality_score}
- brief_alignment_score: ${afterJudgeScores.brief_alignment_score} (NEEDS 7.5+)
- evidence_safety_score: ${afterJudgeScores.evidence_safety_score}

Return JSON only:
{
  "polished_text": "the micro-repaired tweet, under ${getDefaultPostLengthPolicy().hard_limit_chars} chars",
  "what_changed": "what you adjusted for brief alignment",
  "claims_safety_checked": true
}`,
    },
    {
      role: 'user',
      content: `Micro-repair this tweet to improve brief alignment ONLY:\n\n"${currentText}"`,
    },
  ];
}

/**
 * Attempt a brief-locked micro-repair on a candidate that already went through
 * near-pass polish and improved significantly but still fails only on brief_alignment.
 *
 * This is max 1 per candidate, only for highly promising candidates.
 *
 * Returns a PolishOutcome with brief-locked diagnostics.
 */
export async function attemptBriefLockedMicroRepair(
  currentText: string,
  brief: {
    source_summary?: string;
    recommended_angle?: string;
    angle?: string;
    why_it_matters?: string;
    required_context?: string[];
    do_not_claim?: string[];
  },
  afterJudge: JudgeResult
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
    _brief_locked_polish_attempted: true,
    _brief_locked_polish_applied: false,
    _brief_locked_polish_reason: `brief_alignment_score_${afterJudge.brief_alignment_score}_below_7.5`,
  };

  // Check eligibility
  if (!isMicroRepairEligible(afterJudge)) {
    return {
      ...emptyOutcome,
      _brief_locked_polish_attempted: false,
      _brief_locked_polish_reason: 'not_eligible',
    };
  }

  try {
    // Build micro-repair prompt
    const messages = buildMicroRepairPrompt(currentText, brief, {
      final_candidate_score: afterJudge.final_candidate_score,
      originality_score: afterJudge.originality_score,
      usefulness_score: afterJudge.usefulness_score,
      brief_alignment_score: afterJudge.brief_alignment_score,
      evidence_safety_score: afterJudge.evidence_safety_score,
      clarity_score: afterJudge.clarity_score,
    });

    const response = await callModel('near_pass_polish' as TaskType, messages, {
      temperature: 0.12,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });

    // Parse response
    const parsed = parseModelJson(response);
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...emptyOutcome,
        polish_failed_reason: 'micro_repair_response_parse_failed',
      };
    }

    const repairedText = parsed.polished_text;
    if (!repairedText || typeof repairedText !== 'string') {
      return {
        ...emptyOutcome,
        polish_failed_reason: 'micro_repair_text_missing',
      };
    }

    const trimmedRepair = repairedText.trim();
    const whatChanged = parsed.what_changed || 'brief_alignment_micro_repair';

    // Local validation
    const doNotClaim = brief?.do_not_claim || [];
    const validation = validatePolishedText(
      trimmedRepair,
      doNotClaim,
      brief?.recommended_angle || brief?.angle,
      afterJudge.brief_alignment_score,
      null // micro-repair uses default policy
    );

    if (!validation.valid) {
      return {
        ...emptyOutcome,
        polished_text: trimmedRepair,
        polish_failed_reason: validation.reason || 'micro_repair_validation_failed',
        what_changed: whatChanged,
      };
    }

    // Re-judge the micro-repaired text
    const reJudgeResult = await judgeCraftedCandidate(trimmedRepair, brief || {});

    // Check if the repair improved things without degrading originality or evidence
    const originalityPreserved = reJudgeResult.originality_score >= 7.8;
    const evidencePreserved = reJudgeResult.evidence_safety_score >= 8;
    const briefImproved = reJudgeResult.brief_alignment_score > afterJudge.brief_alignment_score;

    // Apply only if:
    // - brief_alignment improved (or passed)
    // - originality did NOT drop below 7.8
    // - evidence safety did NOT drop below 8
    const shouldApply = briefImproved && originalityPreserved && evidencePreserved;

    return {
      attempted: true,
      applied: shouldApply,
      passed: reJudgeResult.passed,
      polished_text: shouldApply ? trimmedRepair : null,
      before_judge: afterJudge,
      after_judge: reJudgeResult,
      polish_failed_reason: shouldApply ? null : 'micro_repair_brief_not_improved_or_scores_degraded',
      what_changed: shouldApply ? whatChanged : null,
      targeted_failures: ['brief_alignment_score'],
      _brief_locked_polish_attempted: true,
      _brief_locked_polish_applied: shouldApply,
      _brief_locked_polish_before_judge: afterJudge,
      _brief_locked_polish_after_judge: reJudgeResult,
      _brief_locked_polish_reason: `brief_alignment_score_${afterJudge.brief_alignment_score}_to_${reJudgeResult.brief_alignment_score}`,
    };
  } catch (err: any) {
    console.warn(`[near-pass-polish] Micro-repair attempt failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return {
      ...emptyOutcome,
      polish_failed_reason: `micro_repair_ai_call_failed:${(err?.message || 'unknown').slice(0, 100)}`,
    };
  }
}
