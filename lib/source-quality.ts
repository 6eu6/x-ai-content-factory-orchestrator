import { supabaseAdmin } from './supabase';

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
 *  - Penalise rejection_rate
 *  - Penalise zero-yield scans (when scans >= 3 but raw_opportunities === 0)
 *  - Regress toward 50 when scans < MIN_SCANS_FOR_CONFIDENCE
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

  let score = 50; // neutral base

  // Reward selected_rate: +selected_rate * 15 (max +15 at 100%)
  score += selectedRate * 15;

  // Reward judge_passed_count: +min(judge_passed_count, 10) * 1.5 (max +15)
  score += Math.min(judgePassedCount, 10) * 1.5;

  // Reward publish_gate_accepted_count: +min(publish_gate_accepted_count, 5) * 3 (max +15)
  score += Math.min(publishGateAcceptedCount, 5) * 3;

  // Reward avg scores: +(avg_publishability - 5) * 2 + (avg_originality - 5) * 1.5 + (avg_usefulness - 5) * 1 (max ~+15)
  score += (avgPublishability - 5) * 2;
  score += (avgOriginality - 5) * 1.5;
  score += (avgUsefulness - 5) * 1;

  // Penalize rejection_rate: -rejection_rate * 10 (max -10)
  score -= rejectionRate * 10;

  // Penalize zero-yield scans: if scans_count >= 3 and raw_opportunities_count === 0, -10
  if (scansCount >= 3 && rawOpportunitiesCount === 0) {
    score -= 10;
  }

  // Regress toward 50 if scans_count < MIN_SCANS_FOR_CONFIDENCE
  if (scansCount < MIN_SCANS_FOR_CONFIDENCE) {
    score = 50 + (score - 50) * (scansCount / MIN_SCANS_FOR_CONFIDENCE);
  }

  // Cap 0-100
  score = clamp(score, 0, 100);

  // Round to 1 decimal
  return Math.round(score * 10) / 10;
}

// ---------------------------------------------------------------------------
// aggregateSourceQualityFromTasks
// ---------------------------------------------------------------------------

type TaskInput = {
  task_type: string;
  account_handle: string | null;
  result: Record<string, any>;
};

/**
 * Aggregates pipeline task data into per-account SourceQualityRow objects.
 *
 * - Groups by account_handle (derived from scan_account tasks).
 * - Collects metrics from opportunity_intelligence, opportunity_judge, and
 *   publish_gate task results.
 * - Safe: skips tasks with missing/empty results or null account_handle.
 */
export function aggregateSourceQualityFromTasks(
  tasks: Array<TaskInput>
): Map<string, SourceQualityRow> {
  // -----------------------------------------------------------------------
  // 1. Collect the set of account handles from scan_account tasks
  // -----------------------------------------------------------------------
  const accounts = new Map<
    string,
    {
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
    }
  >();

  function ensureAccount(handle: string) {
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
  // 2. First pass: scan_account tasks to establish accounts & base metrics
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (!task.account_handle) continue;
    if (!task.result || typeof task.result !== 'object') continue;

    if (task.task_type === 'scan_account') {
      const acc = ensureAccount(task.account_handle);
      acc.scans_count += 1;
      acc.tweets_analyzed += safeNum(task.result.tweets_analyzed, 0);
      acc.raw_opportunities_count += safeNum(
        task.result.opportunities_found ?? task.result.raw_opportunity_count,
        0
      );
    }
  }

  // -----------------------------------------------------------------------
  // 3. Second pass: opportunity_intelligence, opportunity_judge, publish_gate
  // -----------------------------------------------------------------------
  for (const task of tasks) {
    if (!task.account_handle) continue;
    if (!task.result || typeof task.result !== 'object') continue;

    const acc = accounts.get(task.account_handle);
    // Only process if we have already seen a scan_account for this handle
    if (!acc) continue;

    if (task.task_type === 'opportunity_intelligence') {
      // selected_count: count of briefs where should_craft === true
      const briefs: Array<Record<string, any>> = Array.isArray(task.result.briefs)
        ? task.result.briefs
        : [];
      let selected = 0;
      for (const brief of briefs) {
        if (brief.should_craft === true) {
          selected += 1;
        }
        // Collect individual scores
        const pub = safeNum(brief.publishability_score, 0);
        const orig = safeNum(brief.originality_potential_score, 0);
        const niche = safeNum(brief.niche_fit_score, 0);
        const useful = safeNum(brief.usefulness_score, 0);
        // Only push if at least one is non-zero (avoid padding with zeroes for
        // briefs that lack score data)
        if (pub > 0 || orig > 0 || niche > 0 || useful > 0) {
          acc.publishability_scores.push(pub);
          acc.originality_potential_scores.push(orig);
          acc.niche_fit_scores.push(niche);
          acc.usefulness_scores.push(useful);
        }
      }
      acc.selected_count += selected;

      // rescued_count
      acc.rescued_count += safeNum(task.result.rescue_count, 0);

      // rejection_reason_counts: merge
      const reasons: Record<string, any> = task.result.rejection_reason_counts ?? {};
      for (const [reason, count] of Object.entries(reasons)) {
        acc.rejection_reason_counts[reason] =
          (acc.rejection_reason_counts[reason] ?? 0) + safeNum(count, 0);
      }
    }

    if (task.task_type === 'opportunity_judge') {
      acc.judge_passed_count += safeNum(task.result.judge_passed_count, 0);
    }

    if (task.task_type === 'publish_gate') {
      const accepted = safeNum(task.result.accepted ?? task.result.gate_accepted, 0);
      acc.publish_gate_accepted_count += accepted;
    }
  }

  // -----------------------------------------------------------------------
  // 4. Build final SourceQualityRow map
  // -----------------------------------------------------------------------
  const result = new Map<string, SourceQualityRow>();

  for (const [handle, acc] of accounts) {
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

  return result;
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

    // Cast results to the expected shape
    const tasks: Array<TaskInput> = data
      .filter((r) => r.account_handle !== null)
      .map((r) => ({
        task_type: r.task_type ?? '',
        account_handle: r.account_handle as string,
        result: (typeof r.result === 'object' && r.result !== null ? r.result : {}) as Record<
          string,
          any
        >,
      }));

    const aggregated = aggregateSourceQualityFromTasks(tasks);
    const rows = Array.from(aggregated.values());

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
