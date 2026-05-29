/**
 * opportunity-judge.ts — Phase 2D: Pre-gate Judge step
 *
 * Evaluates crafted candidates BEFORE publish_gate using AI-powered scoring
 * and heuristic checks. This judge does NOT replace publish_gate — it is a
 * pre-gate quality filter that catches low-quality candidates early.
 *
 * Process:
 * 1. Run quickJudgeCheck() — pure heuristic for generic bait & unsupported claims
 * 2. Run judgeCraftedCandidate() — AI-powered multi-dimensional scoring
 * 3. Apply hard pass/fail criteria against score thresholds
 * 4. Return structured JudgeResult with scores, flags, and failure reasons
 *
 * Hard fail criteria (any one triggers passed=false):
 * - final_candidate_score < 7.8
 * - originality_score < 7.8
 * - usefulness_score < 7
 * - evidence_safety_score < 8
 * - generic_bait_flag = true
 * - unsupported_claim_flag = true
 *
 * This module NEVER lowers any threshold or bypasses publish_gate.
 */

import { callModel, parseModelJson, TaskType } from './model-router';

// ═══ Types ═══

export type JudgeResult = {
  originality_score: number;      // 1-10
  usefulness_score: number;        // 1-10
  niche_fit_score: number;         // 1-10
  evidence_safety_score: number;   // 1-10
  clarity_score: number;           // 1-10
  generic_bait_flag: boolean;
  unsupported_claim_flag: boolean;
  final_candidate_score: number;   // 1-10
  passed: boolean;
  failure_reasons: string[];
};

export type JudgeSummary = {
  judge_passed_count: number;
  judge_failed_count: number;
  judge_failure_reasons: Record<string, number>;
  avg_final_candidate_score: number;
  avg_originality_score: number;
};

// ═══ Constants ═══

/** Minimum final_candidate_score to pass judge */
const FINAL_SCORE_THRESHOLD = 7.8;

/** Minimum originality_score to pass judge */
const ORIGINALITY_THRESHOLD = 7.8;

/** Minimum usefulness_score to pass judge */
const USEFULNESS_THRESHOLD = 7;

/** Minimum evidence_safety_score to pass judge */
const EVIDENCE_SAFETY_THRESHOLD = 8;

/**
 * Generic engagement bait patterns — reused concept from originality-enhancer.ts
 * These patterns indicate low-effort engagement bait that should not pass the judge.
 */
const GENERIC_BAIT_PATTERNS = [
  /^yo[,.…!\s]/i,
  /^interesting take/i,
  /^hot take/i,
  /^this\.\s*$/i,
  /^so true/i,
  /^boom\s*$/i,
  /^thoughts\?\s*$/i,
  /\bthis is huge\b/i,
  /\bgame changer\b/i,
  /\bhere is why\b/i,
  /\bthe future of\b/i,
  /\byou need to\b/i,
];

/**
 * Unsupported numeric claim patterns — percentages, multipliers, etc.
 * without a nearby source URL or citation.
 */
const UNSUPPORTED_NUMERIC_PATTERNS = [
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

// ═══ Pure Heuristic Functions (testable without AI) ═══

/**
 * Quick heuristic pre-check for generic bait and unsupported numeric claims.
 * Runs BEFORE the AI call as a fast, cheap filter.
 *
 * Returns flags that feed into the final JudgeResult.
 */
export function quickJudgeCheck(text: string): { generic_bait_flag: boolean; unsupported_claim_flag: boolean } {
  if (!text || typeof text !== 'string') {
    return { generic_bait_flag: false, unsupported_claim_flag: false };
  }

  const trimmed = text.trim();

  // Check for generic engagement bait patterns
  let genericBaitFlag = false;
  for (const pattern of GENERIC_BAIT_PATTERNS) {
    if (pattern.test(trimmed)) {
      genericBaitFlag = true;
      break;
    }
  }

  // Check for unsupported numeric claims
  // A claim is "unsupported" if numeric patterns exist but no URL/citation is nearby
  let unsupportedClaimFlag = false;
  const hasUrl = /https?:\/\//i.test(trimmed);
  const hasCitation = /\b(source|citation|according to|per |via |ref:|cite)\b/i.test(trimmed);

  if (!hasUrl && !hasCitation) {
    for (const pattern of UNSUPPORTED_NUMERIC_PATTERNS) {
      if (pattern.test(trimmed)) {
        unsupportedClaimFlag = true;
        break;
      }
    }
  }

  return { generic_bait_flag: genericBaitFlag, unsupported_claim_flag: unsupportedClaimFlag };
}

// ═══ AI-Powered Judging ═══

/**
 * Clamp a score value to the 1-10 range.
 */
function clampScore(value: any): number {
  const num = Number(value);
  if (Number.isNaN(num)) return 1;
  return Math.max(1, Math.min(10, Math.round(num * 10) / 10));
}

/**
 * AI-powered evaluation of a crafted candidate against its brief.
 *
 * Uses the quality_evaluation task type with a detailed system prompt
 * that scores the text across five dimensions. After AI scoring,
 * hard pass/fail criteria are applied.
 *
 * If the AI call fails, returns a failed result with all scores at baseline.
 */
export async function judgeCraftedCandidate(
  craftedText: string,
  brief: Record<string, any>
): Promise<JudgeResult> {
  // Step 1: Run quick heuristic pre-check
  const { generic_bait_flag, unsupported_claim_flag } = quickJudgeCheck(craftedText);

  // Step 2: AI-powered scoring
  const recommendedAngle = brief?.recommended_angle || brief?.angle || 'general AI/productivity insight';
  const briefContext = brief?.why || brief?.context || '';

  let aiScores: {
    originality_score: number;
    usefulness_score: number;
    niche_fit_score: number;
    evidence_safety_score: number;
    clarity_score: number;
    final_candidate_score: number;
  };

  try {
    const response = await callModel('quality_evaluation' as TaskType, [
      {
        role: 'system',
        content: `You are a content quality judge for an X account (@30piq) focused on AI × productivity × career growth.

You are evaluating a crafted tweet BEFORE it goes to the publish gate. Your job is to score it rigorously.

The tweet was crafted with this recommended angle: "${recommendedAngle}"
Brief context: "${briefContext}"

Score the crafted text on five dimensions (1-10 each):

1. "originality_score": Does this offer a specific, non-obvious angle? Or is it generic AI-style content anyone could write?
   - Generic = 1-4 (vague, templated, no personal angle, sounds like any AI output)
   - Decent = 5-7 (has some specificity but still feels template-ish or surface-level)
   - Original = 8-10 (unique angle, personal insight, counterintuitive framing, specific reference that surprises)

2. "usefulness_score": Is this actionable and valuable for a high-value English-speaking audience interested in AI and productivity?
   - Useless = 1-4 (vague platitude, no actionability, no takeaway)
   - Somewhat useful = 5-7 (interesting but not directly actionable or too generic)
   - Very useful = 8-10 (specific, actionable, save-worthy, the reader can apply this today)

3. "niche_fit_score": Does this fit the @30piq niche (AI × productivity × career growth)?
   - Off-niche = 1-4 (unrelated to AI/productivity/career, or forced AI angle)
   - Borderline = 5-7 (tangentially related, could be stronger)
   - Niche-perfect = 8-10 (directly relevant, clearly belongs on this account)

4. "evidence_safety_score": Are numeric claims (percentages, stats, "studies show", multipliers) properly sourced? Are there fabricated-seeming statistics?
   - Unsafe = 1-4 (fabricated statistics, unsourced "studies show", invented percentages, fabricated rankings)
   - Borderline = 5-7 (has some numbers that could use a source, or vaguely attributed claims)
   - Safe = 8-10 (no unverified numbers, all numbers have sources, or no numeric claims at all)

5. "clarity_score": Is the text clear, well-structured, and easy to understand in one read?
   - Unclear = 1-4 (confusing, rambling, poor structure, hard to parse)
   - Adequate = 5-7 (understandable but could be tighter or better structured)
   - Crystal clear = 8-10 (sharp, concise, immediately understood, well-structured)

Also compute "final_candidate_score" (1-10): A weighted overall score reflecting whether this candidate should proceed to publish_gate.
Weighting: originality 30%, usefulness 25%, niche_fit 15%, evidence_safety 20%, clarity 10%.

IMPORTANT: Be strict. Most content should score 5-7. Only genuinely excellent content should score 8+.
If the text contains generic engagement bait, unsupported claims, or AI slop, penalize heavily.

Return JSON only: {"originality_score": N, "usefulness_score": N, "niche_fit_score": N, "evidence_safety_score": N, "clarity_score": N, "final_candidate_score": N}`
      },
      {
        role: 'user',
        content: `Judge this crafted tweet:\n\n"${craftedText}"`
      }
    ], { temperature: 0.0, max_tokens: 300, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(response);

    // Bug #4 fix: Validate parsed result has required numeric fields
    // If parseModelJson returns an empty/broken object, treat as judge_parse_failed
    if (!parsed || typeof parsed !== 'object') {
      return {
        originality_score: 1,
        usefulness_score: 1,
        niche_fit_score: 1,
        evidence_safety_score: 1,
        clarity_score: 1,
        generic_bait_flag,
        unsupported_claim_flag,
        final_candidate_score: 1,
        passed: false,
        failure_reasons: ['judge_parse_failed'],
      };
    }

    // Verify at least final_candidate_score is a number; if not, it's a parse failure
    const hasValidScores = typeof parsed.final_candidate_score === 'number' ||
                           typeof parsed.originality_score === 'number';
    if (!hasValidScores) {
      return {
        originality_score: 1,
        usefulness_score: 1,
        niche_fit_score: 1,
        evidence_safety_score: 1,
        clarity_score: 1,
        generic_bait_flag,
        unsupported_claim_flag,
        final_candidate_score: 1,
        passed: false,
        failure_reasons: ['judge_parse_failed'],
      };
    }

    aiScores = {
      originality_score: clampScore(parsed.originality_score),
      usefulness_score: clampScore(parsed.usefulness_score),
      niche_fit_score: clampScore(parsed.niche_fit_score),
      evidence_safety_score: clampScore(parsed.evidence_safety_score),
      clarity_score: clampScore(parsed.clarity_score),
      final_candidate_score: clampScore(parsed.final_candidate_score),
    };
  } catch (err: any) {
    // Bug #4 fix: AI failure — return clean judge_parse_failed diagnostic, NOT raw parser error
    // This prevents noisy publish_gate reasons like "ai_judge_failed:Unexpected end of JSON input"
    // The raw error is logged to console but NOT propagated to shield_issues/publish_gate
    console.warn(`[opportunity-judge] AI judge call failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return {
      originality_score: 1,
      usefulness_score: 1,
      niche_fit_score: 1,
      evidence_safety_score: 1,
      clarity_score: 1,
      generic_bait_flag,
      unsupported_claim_flag,
      final_candidate_score: 1,
      passed: false,
      failure_reasons: ['judge_parse_failed'],
    };
  }

  // Step 3: Build result with AI scores
  const result: JudgeResult = {
    originality_score: aiScores.originality_score,
    usefulness_score: aiScores.usefulness_score,
    niche_fit_score: aiScores.niche_fit_score,
    evidence_safety_score: aiScores.evidence_safety_score,
    clarity_score: aiScores.clarity_score,
    generic_bait_flag,
    unsupported_claim_flag,
    final_candidate_score: aiScores.final_candidate_score,
    passed: true,  // Will be set to false by hard criteria below
    failure_reasons: [],
  };

  // Step 4: Apply hard pass/fail criteria
  const failureReasons: string[] = [];

  if (result.final_candidate_score < FINAL_SCORE_THRESHOLD) {
    failureReasons.push(`final_candidate_score_${result.final_candidate_score}_below_${FINAL_SCORE_THRESHOLD}`);
  }

  if (result.originality_score < ORIGINALITY_THRESHOLD) {
    failureReasons.push(`originality_score_${result.originality_score}_below_${ORIGINALITY_THRESHOLD}`);
  }

  if (result.usefulness_score < USEFULNESS_THRESHOLD) {
    failureReasons.push(`usefulness_score_${result.usefulness_score}_below_${USEFULNESS_THRESHOLD}`);
  }

  if (result.evidence_safety_score < EVIDENCE_SAFETY_THRESHOLD) {
    failureReasons.push(`evidence_safety_score_${result.evidence_safety_score}_below_${EVIDENCE_SAFETY_THRESHOLD}`);
  }

  if (result.generic_bait_flag) {
    failureReasons.push('generic_bait_flag');
  }

  if (result.unsupported_claim_flag) {
    failureReasons.push('unsupported_claim_flag');
  }

  result.failure_reasons = failureReasons;
  result.passed = failureReasons.length === 0;

  return result;
}

// ═══ Batch Judging ═══

/**
 * Judge a batch of crafted candidates.
 *
 * Evaluates each candidate individually, then computes summary statistics
 * across all results.
 *
 * Returns both individual results and aggregate summary.
 */
export async function judgeCraftedCandidates(
  candidates: Array<{ crafted_text: string; brief?: Record<string, any> }>
): Promise<{ results: JudgeResult[]; summary: JudgeSummary }> {
  if (!candidates?.length) {
    return {
      results: [],
      summary: {
        judge_passed_count: 0,
        judge_failed_count: 0,
        judge_failure_reasons: {},
        avg_final_candidate_score: 0,
        avg_originality_score: 0,
      }
    };
  }

  const results: JudgeResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  const failureReasons: Record<string, number> = {};
  let totalFinalScore = 0;
  let totalOriginalityScore = 0;

  for (const candidate of candidates) {
    const result = await judgeCraftedCandidate(
      candidate.crafted_text,
      candidate.brief || {}
    );
    results.push(result);

    if (result.passed) {
      passedCount++;
    } else {
      failedCount++;
      // Track each failure reason
      for (const reason of result.failure_reasons) {
        // Bug #4 fix: Use the full reason for known clean diagnostics like "judge_parse_failed"
        // Only normalize compound reasons like "originality_score_6_below_7.8" → "originality_score"
        const key = reason === 'judge_parse_failed' ? reason
          : reason.split('_')[0] + '_' + reason.split('_')[1];
        failureReasons[key] = (failureReasons[key] || 0) + 1;
      }
    }

    totalFinalScore += result.final_candidate_score;
    totalOriginalityScore += result.originality_score;
  }

  const count = results.length;

  return {
    results,
    summary: {
      judge_passed_count: passedCount,
      judge_failed_count: failedCount,
      judge_failure_reasons: failureReasons,
      avg_final_candidate_score: Math.round((totalFinalScore / count) * 10) / 10,
      avg_originality_score: Math.round((totalOriginalityScore / count) * 10) / 10,
    }
  };
}
