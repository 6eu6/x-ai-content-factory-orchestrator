import { supabaseAdmin } from './supabase';
import { isValidXHandle } from './pipeline-queue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceQualityRow = {
  source_handle: string;
  scans_count: number;
  tweets_analyzed: number;
  raw_opportunities_count: number;
  selected_count: number;
  rescued_count: number;
  judge_passed_count: number;
  publish_gate_accepted_count: number;
  rejection_reason_counts: Record<string, number>;
  avg_publishability_score: number;
  avg_originality_potential_score: number;
  avg_niche_fit_score: number;
  avg_usefulness_score: number;
  opportunity_yield_rate: number;
  selected_rate: number;
  rejection_rate: number;
  source_quality_score: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Neutral default score for new / unknown sources */
export const UNKNOWN_SOURCE_SCORE = 50;

/** Score at or above this is considered a strong source */
export const STRONG_SOURCE_THRESHOLD = 70;

/** Score at or below this is considered a low-quality source */
export const LOW_SOURCE_THRESHOLD = 35;

/** Below this many scans we regress the score toward the neutral 50 */
export const MIN_SCANS_FOR_CONFIDENCE = 3;

/**
 * Floor for sources with no positive signals (selected=0, judge_passed=0,
 * publish_gate_accepted=0) but with some scan history. Such sources should
 * not be penalized below this threshold unless they have repeated zero-yield
 * scans (scans >= MIN_SCANS_FOR_CONFIDENCE AND raw_opportunities === 0).
 */
export const NO_SIGNAL_FLOOR = 35;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeNum(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// computeSourceQualityScore
// ---------------------------------------------------------------------------

/**
 * Conservative source quality score (0-100).
 *
 * Formula overview:
 *  - Base: 50 (neutral)
 *  - Reward selected_rate
 *  - Reward judge_passed_count
 *  - Reward publish_gate_accepted_count
 *  - Reward average quality scores (publishability, originality, usefulness)
 *    — when no actual score data exists, treat as neutral (5.0) not zero
 *  - Penalise rejection_rate (mildly)
 *  - Penalise zero-yield scans (when scans >= 3 but raw_opportunities === 0)
 *  - Regress strongly toward 50 when scans < MIN_SCANS_FOR_CONFIDENCE
 *  - NO_SIGNAL_FLOOR: sources with no positive signals (selected=0, judge=0,
 *    gate=0) but some scan history should not drop below 35 unless they have
 *    repeated zero-yield scans. This prevents the strict gate pipeline from
 *    penalizing almost every source as "very low" before enough data exists.
 *  - Cap 0-100, round to 1 decimal
 *  - Never crashes: missing / NaN values are treated as 0 / default
 */
export function computeSourceQualityScore(row: Partial<SourceQualityRow> | null | undefined): number {
  if (row == null || typeof row !== 'object') {
    return UNKNOWN_SOURCE_SCORE;
  }

  const scansCount = safeNum(row.scans_count, 0);
  const selectedRate = safeNum(row.selected_rate, 0);
  const judgePassedCount = safeNum(row.judge_passed_count, 0);
  const publishGateAcceptedCount = safeNum(row.publish_gate_accepted_count, 0);
  const avgPublishability = safeNum(row.avg_publishability_score, 0);
  const avgOriginality = safeNum(row.avg_originality_potential_score, 0);
  const avgUsefulness = safeNum(row.avg_usefulness_score, 0);
  const rejectionRate = safeNum(row.rejection_rate, 0);
  const rawOpportunitiesCount = safeNum(row.raw_opportunities_count, 0);

  // Detect whether we have actual score data (vs. defaults of 0 meaning "no data")
  const hasScoreData = avgPublishability > 0 || avgOriginality > 0 || avgUsefulness > 0;
  // When no score data exists, treat averages as neutral (5.0) so they contribute
  // zero instead of penalizing: (0 - 5) * weight = -5 * weight (wrong)
  const neutralPublishability = hasScoreData ? avgPublishability : 5;
  const neutralOriginality = hasScoreData ? avgOriginality : 5;
  const neutralUsefulness = hasScoreData ? avgUsefulness : 5;

  // Detect whether any positive downstream signal exists
  const hasPositiveSignal = selectedRate > 0 || judgePassedCount > 0 || publishGateAcceptedCount > 0;
  // Proven zero-yield: scanned multiple times, found nothing at all
  const isProvenZeroYield = scansCount >= MIN_SCANS_FOR_CONFIDENCE && rawOpportunitiesCount === 0;

  let score = 50; // neutral base

  // Reward selected_rate: +selected_rate * 15 (max +15 at 100%)
  score += selectedRate * 15;

  // Reward judge_passed_count: +min(judge_passed_count, 10) * 1.5 (max +15)
  score += Math.min(judgePassedCount, 10) * 1.5;

  // Reward publish_gate_accepted_count: +min(publish_gate_accepted_count, 5) * 3 (max +15)
  score += Math.min(publishGateAcceptedCount, 5) * 3;

  // Reward avg scores (using neutral defaults when no data exists)
  score += (neutralPublishability - 5) * 2;
  score += (neutralOriginality - 5) * 1.5;
  score += (neutralUsefulness - 5) * 1;

  // Penalize rejection_rate mildly: -rejection_rate * 5 (max -5, reduced from -10)
  // The strict gate pipeline means many legitimate sources have high rejection
  // rates. We should not over-penalize for this systemic characteristic.
  score -= rejectionRate * 5;

  // Penalize zero-yield scans: if scans_count >= 3 and raw_opportunities_count === 0
  // Apply a progressive penalty that gets stronger with more scans
  if (isProvenZeroYield) {
    const zeroYieldPenalty = 10 + Math.min(scansCount - MIN_SCANS_FOR_CONFIDENCE, 5) * 3;
    score -= zeroYieldPenalty;
  }

  // Regress strongly toward 50 if scans_count < MIN_SCANS_FOR_CONFIDENCE
  if (scansCount < MIN_SCANS_FOR_CONFIDENCE) {
    score = 50 + (score - 50) * (scansCount / MIN_SCANS_FOR_CONFIDENCE);
  }

  // NO_SIGNAL_FLOOR: sources with no positive signals but some scan history
  // should not drop below 35 unless they have proven zero-yield.
  // This prevents the strict pipeline from making almost every source "very low"
  // before enough reliable data exists. Proven zero-yield sources (scans >= 3
  // and raw_opportunities === 0) are allowed to drop below 35.
  if (!hasPositiveSignal && !isProvenZeroYield && scansCount > 0) {
    score = Math.max(score, NO_SIGNAL_FLOOR);
  }

  // Cap 0-100
  score = clamp(score, 0, 100);

  // Round to 1 decimal
  return Math.round(score * 10) / 10;
}

// ---------------------------------------------------------------------------
// extractSourceHandle — extract source handle from an opportunity/brief/candidate
// ---------------------------------------------------------------------------

/**
 * Extracts the source handle from an opportunity, brief, or candidate object.
 * Tries source_author first (the primary field on ContentOpportunity), then
 * falls back to author, username, and account_handle.
 * Validates the extracted handle using isValidXHandle.
 * Returns null if no valid handle can be extracted (including invalid X handles
 * such as Arabic text, emoji, UI labels, etc.).
 */
export function extractSourceHandle(obj: Record<string, any> | null | undefined): string | null {
  if (obj == null || typeof obj !== 'object') return null;

  const candidates = [obj.source_author, obj.author, obj.username, obj.account_handle];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') {
      const handle = c.trim().replace(/^@/, '');
      // Validate the handle — reject Arabic, emoji, UI labels, etc.
      if (isValidXHandle(handle)) {
        return handle;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// aggregateSourceQualityFromTasks
// ---------------------------------------------------------------------------

type TaskInput = {
  task_type: string;
  account_handle: string | null;
  result: Record<string, any>;
};

type AccountAccumulator = {
  scans_count: number;
  tweets_analyzed: number;
  raw_opportunities_count: number;
  selected_count: number;
  rescued_count: number;
  judge_passed_count: number;
  publish_gate_accepted_count: number;
  rejection_reason_counts: Record<string, number>;
  publishability_scores: number[];
  originality_potential_scores: number[];
  niche_fit_scores: number[];
  usefulness_scores: number[];
};

/**
 * Aggregates pipeline task data into per-account SourceQualityRow objects.
 *
 * REAL PIPELINE SHAPE:
 *   - scan_account tasks have account_handle set (per-account scan)
 *   - merge_scan_results, opportunity_intelligence, opportunity_judge,
 *     publish_gate are GLOBAL tasks with account_handle = null
 *   - Source attribution lives inside result payloads:
 *     source_author on each opportunity/brief/candidate
 *
 * ALGORITHM:
 *   1. Pass 1 — scan_account tasks: establish per-account base metrics
 *      (scans_count, tweets_analyzed, raw_opportunities_count)
 *   2. Pass 2 — merge_scan_results (global): attribute raw opportunities
 *      to source_author from _opportunities[]
 *   3. Pass 3 — opportunity_intelligence (global): attribute selected_count,
 *      scores, rescued_count, rejection_reasons from _opportunities[]
 *   4. Pass 4 — opportunity_judge (global): attribute judge_passed_count
 *      from _opportunities[]._judge_result
 *   5. Pass 5 — publish_gate (global): attribute publish_gate_accepted_count
 *      from _accepted[] and rejection reasons from _rejected[]
 *   6. Build final SourceQualityRow map with computed rates and scores
 *
 * If attribution to a specific source is impossible, we do not invent counts.
 * We leave neutral (0) rather than guessing.
 */
export type AggregationDiagnostics = {
  skipped_invalid_source_handles: string[];
};

export function aggregateSourceQualityFromTasks(
  tasks: Array<TaskInput>
): { sources: Map<string, SourceQualityRow>; diagnostics: AggregationDiagnostics } {
  // -----------------------------------------------------------------------
  // Accumulator map: source_handle → AccountAccumulator
  // -----------------------------------------------------------------------
  const accounts = new Map<string, AccountAccumulator>();
  const skippedInvalidHandles = new Set<string>();

  function ensureAccount(handle: string): AccountAccumulator | null {
    // Validate the handle before allowing it into the accumulator
    if (!isValidXHandle(handle)) {
      skippedInvalidHandles.add(handle);
      return null;
    }
    if (!accounts.has(handle)) {
      accounts.set(handle, {
        scans_count: 0,
        tweets_analyzed: 0,
        raw_opportunities_count: 0,
        selected_count: 0,
        rescued_count: 0,
        judge_passed_count: 0,
        publish_gate_accepted_count: 0,
        rejection_reason_counts: {},
        publishability_scores: [],
        originality_potential_scores: [],
        niche_fit_scores: [],
        usefulness_scores: [],
      });
    }
    return accounts.get(handle)!;
  }

  // -----------------------------------------------------------------------
  // Pass 1: scan_account tasks — establish accounts & base metrics
  // These tasks have account_handle set to the scanned account's handle.
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (task.task_type !== 'scan_account') continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const handle = task.account_handle;
    if (!handle) continue;

    const acc = ensureAccount(handle);
    if (!acc) continue; // invalid handle
    acc.scans_count += 1;
    acc.tweets_analyzed += safeNum(task.result.tweets_analyzed, 0);

    // raw_opportunities_count: try opportunities_found, raw_opportunity_count,
    // then fall back to viral_found (common in real scan_account results)
    const rawOpp = safeNum(
      task.result.opportunities_found ?? task.result.raw_opportunity_count,
      -1
    );
    if (rawOpp >= 0) {
      acc.raw_opportunities_count += rawOpp;
    } else {
      // Fall back to viral_found when opportunities_found/raw_opportunity_count
      // are absent (real scan results commonly expose viral_found)
      acc.raw_opportunities_count += safeNum(task.result.viral_found, 0);
    }
  }

  // -----------------------------------------------------------------------
  // Pass 2: merge_scan_results (global task, account_handle = null)
  // Attribute raw opportunities to source_author from _opportunities[]
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (task.task_type !== 'merge_scan_results') continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const opportunities: Array<Record<string, any>> = Array.isArray(task.result._opportunities)
      ? task.result._opportunities
      : [];

    // Count opportunities per source_author
    for (const opp of opportunities) {
      const sourceHandle = extractSourceHandle(opp);
      if (!sourceHandle) continue; // cannot attribute or invalid handle — leave neutral
      const acc = ensureAccount(sourceHandle);
      if (!acc) continue; // invalid handle
      // Only add raw_opportunities if scan_account didn't already provide them
      // (avoid double-counting for accounts that also had scan_account tasks)
      if (acc.scans_count === 0) {
        acc.raw_opportunities_count += 1;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass 3: opportunity_intelligence (global task, account_handle = null)
  // Attribute selected_count, scores, rescued, rejection_reasons
  // from _opportunities[] (each has source_author and _brief)
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (task.task_type !== 'opportunity_intelligence') continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const opportunities: Array<Record<string, any>> = Array.isArray(task.result._opportunities)
      ? task.result._opportunities
      : [];

    // Legacy path: if _opportunities is empty but briefs[] exists (old format)
    const briefs: Array<Record<string, any>> = Array.isArray(task.result.briefs)
      ? task.result.briefs
      : [];

    if (opportunities.length > 0) {
      // Modern path: _opportunities[] with _brief attached
      for (const opp of opportunities) {
        const sourceHandle = extractSourceHandle(opp);
        if (!sourceHandle) continue;
        const acc = ensureAccount(sourceHandle);
        if (!acc) continue; // invalid handle

        // Check _brief for should_craft and scores
        const brief = opp._brief;
        if (brief && typeof brief === 'object') {
          if (brief.should_craft === true) {
            acc.selected_count += 1;
          }

          // Collect individual scores from brief
          const pub = safeNum(brief.publishability_score, 0);
          const orig = safeNum(brief.originality_potential_score, 0);
          const niche = safeNum(brief.niche_fit_score, 0);
          const useful = safeNum(brief.usefulness_score, 0);
          if (pub > 0 || orig > 0 || niche > 0 || useful > 0) {
            acc.publishability_scores.push(pub);
            acc.originality_potential_scores.push(orig);
            acc.niche_fit_scores.push(niche);
            acc.usefulness_scores.push(useful);
          }

          // Rejection reason from brief
          if (brief.rejection_reason && typeof brief.rejection_reason === 'string') {
            acc.rejection_reason_counts[brief.rejection_reason] =
              (acc.rejection_reason_counts[brief.rejection_reason] ?? 0) + 1;
          }
        }
      }
    } else if (briefs.length > 0) {
      // Legacy path: briefs[] with source_author on each brief
      for (const brief of briefs) {
        const sourceHandle = extractSourceHandle(brief);
        if (!sourceHandle) continue;
        const acc = ensureAccount(sourceHandle);
        if (!acc) continue; // invalid handle

        if (brief.should_craft === true) {
          acc.selected_count += 1;
        }

        const pub = safeNum(brief.publishability_score, 0);
        const orig = safeNum(brief.originality_potential_score, 0);
        const niche = safeNum(brief.niche_fit_score, 0);
        const useful = safeNum(brief.usefulness_score, 0);
        if (pub > 0 || orig > 0 || niche > 0 || useful > 0) {
          acc.publishability_scores.push(pub);
          acc.originality_potential_scores.push(orig);
          acc.niche_fit_scores.push(niche);
          acc.usefulness_scores.push(useful);
        }

        if (brief.rejection_reason && typeof brief.rejection_reason === 'string') {
          acc.rejection_reason_counts[brief.rejection_reason] =
            (acc.rejection_reason_counts[brief.rejection_reason] ?? 0) + 1;
        }
      }
    }

    // rescued_count from top-level result (cannot attribute per-source)
    const totalRescued = safeNum(
      task.result.rescued_opportunity_count ?? task.result.rescue_count,
      0
    );
    if (totalRescued > 0) {
      // Distribute rescued count proportionally among sources with selected > 0
      const sourcesWithSelected = Array.from(accounts.entries())
        .filter(([, a]) => a.selected_count > 0);
      if (sourcesWithSelected.length > 0) {
        const totalSelected = sourcesWithSelected.reduce((s, [, a]) => s + a.selected_count, 0);
        for (const [, a] of sourcesWithSelected) {
          a.rescued_count += Math.round(totalRescued * (a.selected_count / totalSelected));
        }
      }
    }

    // top_rejection_reasons from top-level result (attribute to all active sources)
    const topReasons: Record<string, any> =
      task.result.top_rejection_reasons ?? task.result.rejection_reason_counts ?? {};
    if (Object.keys(topReasons).length > 0) {
      // Merge into every account that had activity this run
      for (const [, acc] of accounts) {
        if (acc.selected_count > 0 || acc.raw_opportunities_count > 0) {
          for (const [reason, count] of Object.entries(topReasons)) {
            acc.rejection_reason_counts[reason] =
              (acc.rejection_reason_counts[reason] ?? 0) + safeNum(count, 0);
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass 4: opportunity_judge (global task, account_handle = null)
  // Attribute judge_passed_count from _opportunities[]._judge_result
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (task.task_type !== 'opportunity_judge') continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const opportunities: Array<Record<string, any>> = Array.isArray(task.result._opportunities)
      ? task.result._opportunities
      : [];

    if (opportunities.length > 0) {
      // Per-opportunity attribution
      for (const opp of opportunities) {
        const sourceHandle = extractSourceHandle(opp);
        if (!sourceHandle) continue;
        const acc = ensureAccount(sourceHandle);
        if (!acc) continue; // invalid handle

        const judgeResult = opp._judge_result;
        if (judgeResult && typeof judgeResult === 'object' && judgeResult.passed === true) {
          acc.judge_passed_count += 1;
        }
      }
    } else {
      // Fallback: use top-level judge_passed_count and distribute proportionally
      const totalPassed = safeNum(task.result.judge_passed_count, 0);
      if (totalPassed > 0) {
        const sourcesWithSelected = Array.from(accounts.entries())
          .filter(([, a]) => a.selected_count > 0);
        if (sourcesWithSelected.length > 0) {
          const totalSelected = sourcesWithSelected.reduce((s, [, a]) => s + a.selected_count, 0);
          for (const [, a] of sourcesWithSelected) {
            a.judge_passed_count += Math.round(totalPassed * (a.selected_count / totalSelected));
          }
        }
      }
    }

    // judge_failure_reasons: merge into active accounts
    const judgeReasons: Record<string, any> = task.result.judge_failure_reasons ?? {};
    if (Object.keys(judgeReasons).length > 0) {
      for (const [, acc] of accounts) {
        if (acc.selected_count > 0 || acc.raw_opportunities_count > 0) {
          for (const [reason, count] of Object.entries(judgeReasons)) {
            acc.rejection_reason_counts[reason] =
              (acc.rejection_reason_counts[reason] ?? 0) + safeNum(count, 0);
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass 5: publish_gate (global task, account_handle = null)
  // Attribute publish_gate_accepted_count from _accepted[].source_author
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (task.task_type !== 'publish_gate') continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const accepted: Array<Record<string, any>> = Array.isArray(task.result._accepted)
      ? task.result._accepted
      : [];

    if (accepted.length > 0) {
      // Per-opportunity attribution from _accepted[]
      for (const opp of accepted) {
        const sourceHandle = extractSourceHandle(opp);
        if (!sourceHandle) continue;
        const acc = ensureAccount(sourceHandle);
        if (!acc) continue; // invalid handle
        acc.publish_gate_accepted_count += 1;
      }
    } else {
      // Fallback: use top-level accepted count and distribute proportionally
      const totalAccepted = safeNum(task.result.accepted ?? task.result.gate_accepted, 0);
      if (totalAccepted > 0) {
        const sourcesWithJudgePassed = Array.from(accounts.entries())
          .filter(([, a]) => a.judge_passed_count > 0);
        if (sourcesWithJudgePassed.length > 0) {
          const totalJudgePassed = sourcesWithJudgePassed.reduce(
            (s, [, a]) => s + a.judge_passed_count, 0
          );
          for (const [, a] of sourcesWithJudgePassed) {
            a.publish_gate_accepted_count += Math.round(
              totalAccepted * (a.judge_passed_count / totalJudgePassed)
            );
          }
        }
      }
    }

    // Rejection reasons from _rejected[] or top-level reasons
    const rejected: Array<Record<string, any>> = Array.isArray(task.result._rejected)
      ? task.result._rejected
      : [];
    if (rejected.length > 0) {
      for (const rej of rejected) {
        const sourceHandle = extractSourceHandle(rej);
        const reason = typeof rej.reason === 'string' ? rej.reason : null;
        if (reason) {
          if (sourceHandle) {
            // Attribute to specific source
            const acc = ensureAccount(sourceHandle);
            if (!acc) continue; // invalid handle
            acc.rejection_reason_counts[reason] =
              (acc.rejection_reason_counts[reason] ?? 0) + 1;
          } else {
            // Cannot attribute — merge into all active accounts
            for (const [, acc] of accounts) {
              if (acc.selected_count > 0 || acc.raw_opportunities_count > 0) {
                acc.rejection_reason_counts[reason] =
                  (acc.rejection_reason_counts[reason] ?? 0) + 1;
              }
            }
          }
        }
      }
    } else {
      // Top-level reasons array (publish_gate stores reasons as string[])
      const gateReasons: string[] = Array.isArray(task.result.reasons) ? task.result.reasons : [];
      for (const reason of gateReasons) {
        for (const [, acc] of accounts) {
          if (acc.selected_count > 0 || acc.raw_opportunities_count > 0) {
            acc.rejection_reason_counts[reason] =
              (acc.rejection_reason_counts[reason] ?? 0) + 1;
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass 6: Build final SourceQualityRow map
  // -----------------------------------------------------------------------
  const result = new Map<string, SourceQualityRow>();

  for (const [handle, acc] of accounts) {
    // Final validation gate: never emit a row for an invalid handle
    if (!isValidXHandle(handle)) {
      skippedInvalidHandles.add(handle);
      continue;
    }

    const tweetsAnalyzed = acc.tweets_analyzed || 1;
    const rawOppCount = acc.raw_opportunities_count || 1;

    const avgPublishability =
      acc.publishability_scores.length > 0
        ? acc.publishability_scores.reduce((a, b) => a + b, 0) /
          acc.publishability_scores.length
        : 0;
    const avgOriginality =
      acc.originality_potential_scores.length > 0
        ? acc.originality_potential_scores.reduce((a, b) => a + b, 0) /
          acc.originality_potential_scores.length
        : 0;
    const avgNicheFit =
      acc.niche_fit_scores.length > 0
        ? acc.niche_fit_scores.reduce((a, b) => a + b, 0) / acc.niche_fit_scores.length
        : 0;
    const avgUsefulness =
      acc.usefulness_scores.length > 0
        ? acc.usefulness_scores.reduce((a, b) => a + b, 0) / acc.usefulness_scores.length
        : 0;

    const row: SourceQualityRow = {
      source_handle: handle,
      scans_count: acc.scans_count,
      tweets_analyzed: acc.tweets_analyzed,
      raw_opportunities_count: acc.raw_opportunities_count,
      selected_count: acc.selected_count,
      rescued_count: acc.rescued_count,
      judge_passed_count: acc.judge_passed_count,
      publish_gate_accepted_count: acc.publish_gate_accepted_count,
      rejection_reason_counts: acc.rejection_reason_counts,
      avg_publishability_score: Math.round(avgPublishability * 10) / 10,
      avg_originality_potential_score: Math.round(avgOriginality * 10) / 10,
      avg_niche_fit_score: Math.round(avgNicheFit * 10) / 10,
      avg_usefulness_score: Math.round(avgUsefulness * 10) / 10,
      opportunity_yield_rate: acc.raw_opportunities_count / tweetsAnalyzed,
      selected_rate: acc.selected_count / rawOppCount,
      rejection_rate: (acc.raw_opportunities_count - acc.selected_count) / rawOppCount,
      source_quality_score: 0, // placeholder, computed below
    };

    row.source_quality_score = computeSourceQualityScore(row);
    result.set(handle, row);
  }

  return {
    sources: result,
    diagnostics: {
      skipped_invalid_source_handles: Array.from(skippedInvalidHandles),
    },
  };
}

// ---------------------------------------------------------------------------
// upsertSourceQualityScores
// ---------------------------------------------------------------------------

/**
 * Upserts an array of SourceQualityRow objects into the source_quality_scores
 * Supabase table. Never throws; returns an error string instead.
 */
export async function upsertSourceQualityScores(
  rows: SourceQualityRow[]
): Promise<{ upserted: number; error?: string }> {
  if (rows.length === 0) return { upserted: 0 };

  try {
    const payload = rows.map((row) => ({
      source_handle: row.source_handle,
      scans_count: row.scans_count,
      tweets_analyzed: row.tweets_analyzed,
      raw_opportunities_count: row.raw_opportunities_count,
      selected_count: row.selected_count,
      rescued_count: row.rescued_count,
      judge_passed_count: row.judge_passed_count,
      publish_gate_accepted_count: row.publish_gate_accepted_count,
      rejection_reason_counts: row.rejection_reason_counts,
      avg_publishability_score: row.avg_publishability_score,
      avg_originality_potential_score: row.avg_originality_potential_score,
      avg_niche_fit_score: row.avg_niche_fit_score,
      avg_usefulness_score: row.avg_usefulness_score,
      opportunity_yield_rate: row.opportunity_yield_rate,
      selected_rate: row.selected_rate,
      rejection_rate: row.rejection_rate,
      source_quality_score: row.source_quality_score,
      updated_at: new Date().toISOString(),
    }));

    const supabase = supabaseAdmin();
    const { error, count } = await supabase
      .from('source_quality_scores')
      .upsert(payload, { onConflict: 'source_handle' })
      .select('source_handle');

    if (error) {
      console.error('[source-quality] upsert error:', error.message);
      return { upserted: 0, error: error.message };
    }

    const upserted = rows.length;
    return { upserted };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[source-quality] upsert exception:', message);
    return { upserted: 0, error: message };
  }
}

// ---------------------------------------------------------------------------
// loadSourceQualityScores
// ---------------------------------------------------------------------------

/**
 * Reads source_quality_scores from Supabase.
 * Optionally filters by an array of handles.
 * Never throws; returns an empty Map on error.
 */
export async function loadSourceQualityScores(
  handles?: string[]
): Promise<Map<string, SourceQualityRow>> {
  try {
    const supabase = supabaseAdmin();
    let query = supabase.from('source_quality_scores').select('*');

    if (handles && handles.length > 0) {
      query = query.in('source_handle', handles);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[source-quality] load error:', error.message);
      return new Map();
    }

    const map = new Map<string, SourceQualityRow>();
    if (Array.isArray(data)) {
      for (const rec of data) {
        map.set(rec.source_handle, {
          source_handle: rec.source_handle,
          scans_count: safeNum(rec.scans_count, 0),
          tweets_analyzed: safeNum(rec.tweets_analyzed, 0),
          raw_opportunities_count: safeNum(rec.raw_opportunities_count, 0),
          selected_count: safeNum(rec.selected_count, 0),
          rescued_count: safeNum(rec.rescued_count, 0),
          judge_passed_count: safeNum(rec.judge_passed_count, 0),
          publish_gate_accepted_count: safeNum(rec.publish_gate_accepted_count, 0),
          rejection_reason_counts:
            typeof rec.rejection_reason_counts === 'object' && rec.rejection_reason_counts !== null
              ? rec.rejection_reason_counts
              : {},
          avg_publishability_score: safeNum(rec.avg_publishability_score, 0),
          avg_originality_potential_score: safeNum(rec.avg_originality_potential_score, 0),
          avg_niche_fit_score: safeNum(rec.avg_niche_fit_score, 0),
          avg_usefulness_score: safeNum(rec.avg_usefulness_score, 0),
          opportunity_yield_rate: safeNum(rec.opportunity_yield_rate, 0),
          selected_rate: safeNum(rec.selected_rate, 0),
          rejection_rate: safeNum(rec.rejection_rate, 0),
          source_quality_score: safeNum(rec.source_quality_score, UNKNOWN_SOURCE_SCORE),
        });
      }
    }

    return map;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[source-quality] load exception:', message);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// updateSourceQualityFromRun
// ---------------------------------------------------------------------------

/**
 * End-to-end helper: reads pipeline_tasks for a given run, aggregates source
 * quality metrics, and upserts them. Never throws.
 */
export async function updateSourceQualityFromRun(
  runId: string
): Promise<{ updated: number; error?: string }> {
  try {
    const supabase = supabaseAdmin();

    // Read all pipeline tasks for the given run
    const { data, error } = await supabase
      .from('pipeline_tasks')
      .select('task_type, account_handle, result')
      .eq('run_id', runId);

    if (error) {
      console.error('[source-quality] load tasks error:', error.message);
      return { updated: 0, error: error.message };
    }

    if (!Array.isArray(data) || data.length === 0) {
      return { updated: 0 };
    }

    // Cast results to the expected shape — include ALL tasks, even those with
    // account_handle = null (global tasks like opportunity_intelligence,
    // opportunity_judge, publish_gate). The aggregation function handles
    // source attribution via source_author inside result payloads.
    const tasks: Array<TaskInput> = data.map((r) => ({
      task_type: r.task_type ?? '',
      account_handle: r.account_handle as string | null,
      result: (typeof r.result === 'object' && r.result !== null ? r.result : {}) as Record<
        string,
        any
      >,
    }));

    const { sources: aggregated, diagnostics } = aggregateSourceQualityFromTasks(tasks);

    // Filter: only upsert rows for valid X handles (extra safety gate)
    const rows = Array.from(aggregated.values()).filter(
      (row) => isValidXHandle(row.source_handle)
    );

    if (rows.length === 0) {
      return { updated: 0 };
    }

    const upsertResult = await upsertSourceQualityScores(rows);
    return { updated: upsertResult.upserted, error: upsertResult.error };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[source-quality] updateFromRun exception:', message);
    return { updated: 0, error: message };
  }
}
