/**
 * candidate-selector.ts — Phase 2G.3: Local pre-selection before expensive AI judge
 *
 * When craftFromBrief generates multiple candidate variants, this module
 * scores each candidate locally using cheap heuristics and selects the
 * strongest candidates for the expensive AI judge step.
 *
 * Key constraints:
 * - Never send more than 2 candidates per opportunity to the AI judge
 * - Never lower any threshold
 * - Never bypass judge or publish_gate
 * - Never weaken evidence safety
 * - Never invent unsupported claims
 */

import { validateBriefAlignment, GENERIC_PRAISE_PATTERNS, INVENTED_EXPERIENCE_PATTERNS } from './pipeline-worker';
import { detectOriginalityIndicators } from './originality-context';
import { validateSignatureVoice, type SignatureVoiceDiagnostics } from './signature-voice';
import type { OriginalityDiagnostics } from './originality-context';

// ═══ Types ═══

export type CraftedCandidate = {
  variant_type: string; // "brief_faithful" | "signature_original" | "operator_heuristic" | "legacy"
  crafted_text: string | null;
  format: string;
  brief_alignment_score: number;
  brief_alignment_notes: string[];
  invented_personal_experience_flag: boolean;
  ignored_recommended_angle_flag: boolean;
  _brief_crafting_parse_failed?: boolean;
  _brief_crafting_repair_attempted?: boolean;
  _brief_crafting_repair_applied?: boolean;
  _brief_crafting_failure_reason?: string;
  _originality_diagnostics?: OriginalityDiagnostics;
  _signature_voice_diagnostics?: SignatureVoiceDiagnostics;
  // Per-candidate multi-generation diagnostics
  _candidate_local_score?: number;
  _candidate_selection_reason?: string;
};

export type BriefForSelection = {
  recommended_angle: string;
  source_summary: string;
  do_not_claim: string[];
  required_context: string[];
};

export type SelectionResult = {
  selected: CraftedCandidate[];
  dropped: number;
  reason: string;
};

export type JudgeResultForDedupe = {
  passed: boolean;
  final_candidate_score: number;
  originality_score: number;
  brief_alignment_score: number;
  evidence_safety_score: number;
  [key: string]: any;
};

export type CandidateWithJudgeResult = {
  candidate: CraftedCandidate;
  judgeResult: JudgeResultForDedupe;
  sourceKey: string; // identifies the source/opportunity for deduping
  _candidateIndex?: number; // explicit index for safe mapping (replaces fragile indexOf)
};

// ═══ Local Validators ═══

/**
 * Check if crafted text passes local length requirements.
 * Phase S1.2: Accepts optional hard_limit_chars from post_length_policy (defaults to 280).
 */
function passesLengthCheck(text: string, hardLimitChars?: number): boolean {
  const limit = hardLimitChars ?? 280;
  return text.length >= 40 && text.length <= limit;
}

/**
 * Check if crafted text looks like JSON wrapper.
 */
function passesJsonWrapperCheck(text: string): boolean {
  return !/^\s*\{/.test(text) && !/^```/.test(text);
}

/**
 * Check if crafted text contains do_not_claim terms.
 */
function passesDoNotClaimCheck(text: string, doNotClaim: string[]): boolean {
  const lower = text.toLowerCase();
  for (const claim of doNotClaim) {
    const claimLower = claim.toLowerCase();
    if (claimLower.length > 3 && lower.includes(claimLower)) {
      return false;
    }
  }
  return true;
}

/**
 * Check if crafted text contains invented personal experience (without source support).
 */
function passesInventedExperienceCheck(text: string, sourceText?: string): boolean {
  const sourceLower = (sourceText || '').toLowerCase();
  for (const pattern of INVENTED_EXPERIENCE_PATTERNS) {
    if (pattern.test(text)) {
      if (!sourceLower.includes('i tried') && !sourceLower.includes('i found') &&
          !sourceLower.includes('i tested') && !sourceLower.includes('i used')) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Check if crafted text contains generic hype patterns.
 */
function hasGenericHype(text: string): boolean {
  for (const pattern of GENERIC_PRAISE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  // Also check signature voice's generic hype patterns
  const GENERIC_HYPE_PATTERNS = [
    /\bthe future of\b/i,
    /\bgame.?changer\b/i,
    /\bai is changing everything\b/i,
    /\bthis is huge\b/i,
    /\bthe real unlock\b/i,
    /\bbuilders should\b/i,
  ];
  for (const pattern of GENERIC_HYPE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Check if crafted text is too abstract (no concrete details).
 */
function isTooAbstract(text: string): boolean {
  const hasConcreteDetail = /\b\d+\b/.test(text) ||
    /\b(RAG|LLM|API|MCP|fine-tun|embed|vector|prompt|agent|token|inference|batch|pipeline|workflow)\b/i.test(text) ||
    // Check for concrete nouns from signature voice rules
    /\b(capability map|judgment cache|documented reasoning|stale mental model|second-model critic|render target|operator heuristic|training set|format prompt|output format|context window|token budget|inference cost|prompt budget)\b/i.test(text);
  return !hasConcreteDetail && text.length > 60;
}

/**
 * Check if crafted text is missing required context from the brief.
 */
function isMissingRequiredContext(text: string, requiredContext: string[]): boolean {
  if (!requiredContext || requiredContext.length === 0) return false;
  const lower = text.toLowerCase();
  // Check if at least some required context keywords appear
  const matched = requiredContext.filter(ctx => {
    const words = ctx.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return words.some(w => lower.includes(w));
  });
  // If fewer than half of required context items are reflected, flag as missing
  return matched.length < Math.ceil(requiredContext.length * 0.5);
}

// ═══ Core Scoring ═══

/**
 * Compute a local candidate score for pre-selection before the expensive AI judge.
 *
 * Scoring formula:
 *   + brief_alignment_heuristic (0-2, based on score: >=8 → 2, >=7 → 1, else 0)
 *   + originality_indicators_count * 0.5 (max 2)
 *   + signature_voice_score * 0.2 (max 2)
 *   + has_operator_takeaway ? 1 : 0
 *   + evidence_safety_local_checks_pass ? 1 : 0
 *   - generic_hype ? 2 : 0
 *   - too_abstract ? 1 : 0
 *   - missing_required_context ? 1.5 : 0
 */
export function computeLocalCandidateScore(
  candidate: CraftedCandidate,
  brief: BriefForSelection,
  hardLimitChars?: number
): number {
  const text = candidate.crafted_text || '';

  // If no text, score is very low
  if (!text || text.length < 10) return -5;

  // 1. Brief alignment heuristic (0-2)
  let briefAlignmentHeuristic = 0;
  if (candidate.brief_alignment_score >= 8) {
    briefAlignmentHeuristic = 2;
  } else if (candidate.brief_alignment_score >= 7) {
    briefAlignmentHeuristic = 1;
  }

  // 2. Originality indicators count * 0.5 (max 2)
  const originalityIndicators = detectOriginalityIndicators(text);
  const originalityScore = Math.min(originalityIndicators.length * 0.5, 2);

  // 3. Signature voice score * 0.2 (max 2)
  const signatureVoiceDiags = candidate._signature_voice_diagnostics ||
    validateSignatureVoice(text);
  const signatureVoiceScore = Math.min(signatureVoiceDiags._signature_voice_score * 0.2, 2);

  // 4. Has operator takeaway
  const hasOperatorTakeaway = !!(
    signatureVoiceDiags._operator_takeaway ||
    candidate._signature_voice_diagnostics?._operator_takeaway
  );

  // 5. Evidence safety local checks pass
  const evidenceSafetyChecksPass =
    passesLengthCheck(text, hardLimitChars) &&
    passesJsonWrapperCheck(text) &&
    passesDoNotClaimCheck(text, brief.do_not_claim || []) &&
    passesInventedExperienceCheck(text, brief.source_summary);

  // Penalties
  const genericHypePenalty = hasGenericHype(text) ? 2 : 0;
  const tooAbstractPenalty = isTooAbstract(text) ? 1 : 0;
  const missingContextPenalty = isMissingRequiredContext(text, brief.required_context || []) ? 1.5 : 0;

  const score =
    briefAlignmentHeuristic +
    originalityScore +
    signatureVoiceScore +
    (hasOperatorTakeaway ? 1 : 0) +
    (evidenceSafetyChecksPass ? 1 : 0) -
    genericHypePenalty -
    tooAbstractPenalty -
    missingContextPenalty;

  return Math.round(score * 100) / 100;
}

// ═══ Selection ═══

/**
 * Select max 2 candidates per opportunity for the expensive AI judge.
 *
 * Selection rules:
 * 1. Always include the best overall (highest local_candidate_score)
 * 2. Include second only if it is meaningfully different in variant_type
 *    AND local score is within 1.5 points of the best
 * 3. Never send more than 2 per opportunity to judge
 *
 * Sets _candidate_local_score and _candidate_selection_reason on each candidate.
 */
export function selectCandidatesForJudge(
  candidates: CraftedCandidate[],
  brief: BriefForSelection,
  hardLimitChars?: number
): SelectionResult {
  if (!candidates || candidates.length === 0) {
    return { selected: [], dropped: 0, reason: 'no_candidates' };
  }

  // Compute local scores for all candidates
  const scored = candidates.map(c => {
    const localScore = computeLocalCandidateScore(c, brief, hardLimitChars);
    return {
      candidate: { ...c, _candidate_local_score: localScore },
      localScore,
    };
  });

  // Sort by local score descending
  scored.sort((a, b) => b.localScore - a.localScore);

  // Always select the best
  const best = scored[0];
  best.candidate._candidate_selection_reason = 'best_local_score';

  if (candidates.length === 1) {
    return { selected: [best.candidate], dropped: 0, reason: 'single_candidate' };
  }

  // Try to include second candidate if meaningfully different and close in score
  const bestVariantType = best.candidate.variant_type;
  let secondCandidate: typeof best | null = null;

  for (let i = 1; i < scored.length; i++) {
    const current = scored[i];
    // Must be different variant_type
    if (current.candidate.variant_type === bestVariantType) continue;
    // Must be within 1.5 points of best
    if (best.localScore - current.localScore > 1.5) continue;

    secondCandidate = current;
    break;
  }

  if (secondCandidate) {
    secondCandidate.candidate._candidate_selection_reason = 'different_variant_within_range';
    const dropped = candidates.length - 2;
    return {
      selected: [best.candidate, secondCandidate.candidate],
      dropped,
      reason: dropped > 0 ? `dropped_${dropped}_lower_scoring_or_same_variant` : 'selected_best_two',
    };
  }

  // Only one selected
  const dropped = candidates.length - 1;
  return {
    selected: [best.candidate],
    dropped,
    reason: dropped > 0
      ? `dropped_${dropped}_same_variant_or_score_gap_too_large`
      : 'single_candidate',
  };
}

// ═══ Dedupe ═══

/**
 * Dedupe judged candidates from the SAME source/opportunity before publish_gate.
 *
 * Selection priority:
 * 1. Keep only the best judged candidate for the same source/opportunity
 * 2. Choose passed candidate first
 * 3. Otherwise choose highest final_candidate_score
 * 4. Tie-break: originality_score, then brief_alignment_score, then evidence_safety_score
 */
export function deduplicateJudgedCandidates(
  candidatesWithResults: CandidateWithJudgeResult[]
): CandidateWithJudgeResult[] {
  if (!candidatesWithResults || candidatesWithResults.length === 0) {
    return [];
  }

  // Group by source key
  const groups = new Map<string, CandidateWithJudgeResult[]>();
  for (const item of candidatesWithResults) {
    const existing = groups.get(item.sourceKey) || [];
    existing.push(item);
    groups.set(item.sourceKey, existing);
  }

  // For each group, select the best candidate
  const result: CandidateWithJudgeResult[] = [];
  for (const [sourceKey, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Sort by priority:
    // 1. passed first
    // 2. highest final_candidate_score
    // 3. highest originality_score
    // 4. highest brief_alignment_score
    // 5. highest evidence_safety_score
    const sorted = [...group].sort((a, b) => {
      // Passed first
      if (a.judgeResult.passed && !b.judgeResult.passed) return -1;
      if (!a.judgeResult.passed && b.judgeResult.passed) return 1;

      // final_candidate_score
      if (a.judgeResult.final_candidate_score !== b.judgeResult.final_candidate_score) {
        return b.judgeResult.final_candidate_score - a.judgeResult.final_candidate_score;
      }

      // originality_score
      if (a.judgeResult.originality_score !== b.judgeResult.originality_score) {
        return b.judgeResult.originality_score - a.judgeResult.originality_score;
      }

      // brief_alignment_score
      if (a.judgeResult.brief_alignment_score !== b.judgeResult.brief_alignment_score) {
        return b.judgeResult.brief_alignment_score - a.judgeResult.brief_alignment_score;
      }

      // evidence_safety_score
      return b.judgeResult.evidence_safety_score - a.judgeResult.evidence_safety_score;
    });

    // Keep only the best
    result.push(sorted[0]);
  }

  return result;
}
