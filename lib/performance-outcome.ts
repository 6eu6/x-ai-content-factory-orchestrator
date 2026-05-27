/**
 * performance-outcome.ts — Pure functions for calculating performance outcomes
 * from published_decisions performance_payload data.
 *
 * Formula:
 *   score = min(10,
 *     log10(views + 10) * 1.2
 *     + replies * 0.03
 *     + bookmarks * 0.04
 *     + likes * 0.01
 *     + retweets * 0.03
 *     + quotes * 0.04
 *   )
 *
 * Labels:
 *   score >= 8    → strong_success
 *   score >= 5.5  → success
 *   score >= 3    → neutral
 *   else          → weak
 */

export type OutcomeLabel = 'strong_success' | 'success' | 'neutral' | 'weak';

export interface PerformancePayload {
  views?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  quotes?: number;
  bookmarks?: number;
  engagement_score?: number;
}

export interface OutcomeResult {
  score: number;
  label: OutcomeLabel;
}

/**
 * Calculate outcome score from performance payload.
 * Pure function — no side effects, no DB access.
 */
export function calculateOutcomeScore(payload: PerformancePayload): number {
  const views = Number(payload.views || 0);
  const likes = Number(payload.likes || 0);
  const replies = Number(payload.replies || 0);
  const retweets = Number(payload.retweets || 0);
  const quotes = Number(payload.quotes || 0);
  const bookmarks = Number(payload.bookmarks || 0);

  // log10(views + 10) * 1.2 gives a gradual curve:
  //   0 views → 1.2, 100 → 3.6, 1K → 4.8, 10K → 6.0, 100K → 7.2
  const raw =
    Math.log10(views + 10) * 1.2
    + replies * 0.03
    + bookmarks * 0.04
    + likes * 0.01
    + retweets * 0.03
    + quotes * 0.04;

  const score = Math.min(10, Math.round(raw * 100) / 100);
  return score;
}

/**
 * Determine outcome label from score.
 * Pure function.
 */
export function getOutcomeLabel(score: number): OutcomeLabel {
  if (score >= 8) return 'strong_success';
  if (score >= 5.5) return 'success';
  if (score >= 3) return 'neutral';
  return 'weak';
}

/**
 * Calculate full outcome (score + label) from performance payload.
 * Pure function.
 */
export function calculateOutcome(payload: PerformancePayload): OutcomeResult {
  const score = calculateOutcomeScore(payload);
  const label = getOutcomeLabel(score);
  return { score, label };
}
