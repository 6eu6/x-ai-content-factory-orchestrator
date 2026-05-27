/**
 * rule-performance.ts — Pure functions for calculating rule performance weights
 *
 * Converts brain rule metrics (confidence_score, success_count, failure_count, status)
 * into a weight that can influence decision scoring.
 *
 * Design principles:
 * - Conservative adjustments: max ±0.4 influence on final_score
 * - Archived rules get zero weight (they're disabled)
 * - Watch rules get a penalty
 * - Success signals boost slightly, failure signals penalize slightly
 * - Final weight is clamped to [0, 1.25]
 */

export type RulePerformanceInput = {
  confidence_score?: number | null;
  success_count?: number | null;
  failure_count?: number | null;
  status?: string | null;
};

export type RulePerformanceSummary = {
  average_weight: number;
  strongest: RulePerformanceInput & { weight: number } | null;
  weakest: RulePerformanceInput & { weight: number } | null;
  has_negative_signal: boolean;
  matched_rules: number;
};

/**
 * Calculate a performance weight for a single brain rule.
 *
 * Formula:
 *   base = confidence_score / 10
 *   success_bonus = min(0.25, success_count * 0.05)
 *   failure_penalty = min(0.35, failure_count * 0.08)
 *   status penalty:
 *     archived => 0
 *     watch => -0.15
 *     active => 0
 *   final = clamp(base + success_bonus - failure_penalty + status_penalty, 0, 1.25)
 *
 * Pure function — no side effects, no DB access.
 */
export function calculateRulePerformanceWeight(rule: RulePerformanceInput): number {
  const status = String(rule.status || 'active').toLowerCase().trim();

  // Archived rules contribute nothing
  if (status === 'archived' || status.startsWith('archived')) {
    return 0;
  }

  const confidence = Number(rule.confidence_score ?? 7);
  const successCount = Number(rule.success_count ?? 0);
  const failureCount = Number(rule.failure_count ?? 0);

  const base = confidence / 10;
  const successBonus = Math.min(0.25, successCount * 0.05);
  const failurePenalty = Math.min(0.35, failureCount * 0.08);
  const statusPenalty = status === 'watch' ? -0.15 : 0;

  const raw = base + successBonus - failurePenalty + statusPenalty;
  return Math.max(0, Math.min(1.25, Math.round(raw * 100) / 100));
}

/**
 * Summarize performance across multiple rules.
 *
 * Returns average weight, strongest/weakest rules, and whether there's
 * a negative signal (any rule with failure_count >= 2 or status === 'watch').
 */
export function summarizeRulePerformance(rules: RulePerformanceInput[]): RulePerformanceSummary {
  if (!rules.length) {
    return {
      average_weight: 0,
      strongest: null,
      weakest: null,
      has_negative_signal: false,
      matched_rules: 0
    };
  }

  const weighted = rules.map(r => ({
    ...r,
    weight: calculateRulePerformanceWeight(r)
  }));

  const totalWeight = weighted.reduce((sum, r) => sum + r.weight, 0);
  const averageWeight = Math.round((totalWeight / weighted.length) * 100) / 100;

  // Sort by weight descending for strongest, ascending for weakest
  const sorted = [...weighted].sort((a, b) => b.weight - a.weight);
  const strongest = sorted[0] || null;
  const weakest = sorted[sorted.length - 1] || null;

  // Negative signal: any rule with failures >= 2 or status watch
  const hasNegativeSignal = weighted.some(r =>
    (Number(r.failure_count ?? 0) >= 2) ||
    String(r.status || '').toLowerCase() === 'watch'
  );

  return {
    average_weight: averageWeight,
    strongest: strongest ? { confidence_score: strongest.confidence_score, success_count: strongest.success_count, failure_count: strongest.failure_count, status: strongest.status, weight: strongest.weight } : null,
    weakest: weakest ? { confidence_score: weakest.confidence_score, success_count: weakest.success_count, failure_count: weakest.failure_count, status: weakest.status, weight: weakest.weight } : null,
    has_negative_signal: hasNegativeSignal,
    matched_rules: weighted.length
  };
}

/**
 * Calculate the decision score adjustment based on average rule weight.
 *
 * The adjustment is conservative:
 *   adjustment = clamp((avg_weight - 0.6) * 1.0, -0.4, +0.4)
 *
 * This means:
 * - avg_weight 1.0 → +0.4 (strong rules boost slightly)
 * - avg_weight 0.6 → 0 (neutral, no change)
 * - avg_weight 0.2 → -0.4 (weak rules penalize slightly)
 *
 * IMPORTANT: This adjustment must NEVER override safety_score.
 * If shield_passed=false, the opportunity should still be rejected.
 */
export function calculateRuleWeightAdjustment(avgWeight: number): number {
  const raw = (avgWeight - 0.6) * 1.0;
  return Math.max(-0.4, Math.min(0.4, Math.round(raw * 100) / 100));
}
