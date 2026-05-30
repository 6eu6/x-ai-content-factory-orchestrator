/**
 * source-quality-audit.ts — Phase 2E.1: Source Quality Analytics
 *
 * Reads pipeline run history and computes per-source quality metrics.
 * Helps identify which accounts produce the best opportunities and which
 * are wasting AI analysis budget.
 *
 * Usage:
 *   npx tsx scripts/source-quality-audit.ts [--runs N] [--json] [--write]
 *
 * Flags:
 *   --runs N   Number of recent pipeline runs to analyze (default: 10)
 *   --json     Output raw JSON instead of formatted table
 *   --write    Upsert results to source_quality_scores table (requires DB access)
 */

import { supabaseAdmin } from '../lib/supabase';

// ═══ Types ═══

export type SourceQualityRow = {
  account_handle: string;
  scans_count: number;
  tweets_analyzed: number;
  raw_opportunities_count: number;
  selected_count: number;
  rescued_count: number;
  publish_gate_accepted_count: number;
  judge_passed_count: number;
  rejection_reason_counts: Record<string, number>;
  generic_only_count: number;
  blocked_topic_count: number;
  low_originality_count: number;
  low_niche_fit_count: number;
  language_or_context_mismatch_count: number;
  intelligence_parse_failed_count: number;
  avg_publishability_score: number;
  avg_originality_potential_score: number;
  avg_niche_fit_score: number;
  avg_usefulness_score: number;
  opportunity_yield_rate: number;
  selected_rate: number;
  rejection_rate: number;
  source_quality_score: number;
};

// ═══ Pure Scoring Function (exported for testing) ═══

/**
 * Compute source quality score (0-100) from aggregated metrics.
 *
 * Formula:
 *   score = 50  // base
 *   + selected_count * 8
 *   + rescued_count * 5
 *   + judge_passed_count * 6
 *   + (avg_niche_fit - 5) * 3    // reward high niche fit
 *   + (avg_usefulness - 5) * 2   // reward high usefulness
 *   - generic_only_count * 4
 *   - blocked_topic_count * 4
 *   - language_or_context_mismatch_count * 3
 *   - (intelligence_parse_failed_count * 1) // light penalty
 *   - (scans_count > 0 && raw_opportunities_count === 0 ? 10 : 0) // zero-yield penalty
 *   clamp to 0-100
 */
export function computeSourceQualityScore(metrics: {
  selected_count: number;
  rescued_count: number;
  judge_passed_count: number;
  avg_niche_fit: number;
  avg_usefulness: number;
  generic_only_count: number;
  blocked_topic_count: number;
  language_or_context_mismatch_count: number;
  intelligence_parse_failed_count: number;
  scans_count: number;
  raw_opportunities_count: number;
}): number {
  let score = 50;
  score += metrics.selected_count * 8;
  score += metrics.rescued_count * 5;
  score += metrics.judge_passed_count * 6;
  score += (metrics.avg_niche_fit - 5) * 3;
  score += (metrics.avg_usefulness - 5) * 2;
  score -= metrics.generic_only_count * 4;
  score -= metrics.blocked_topic_count * 4;
  score -= metrics.language_or_context_mismatch_count * 3;
  score -= metrics.intelligence_parse_failed_count * 1;
  score -= (metrics.scans_count > 0 && metrics.raw_opportunities_count === 0 ? 10 : 0);

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══ Main Audit Logic ═══

async function runAudit(runCount: number = 10, writeMode: boolean = false, jsonMode: boolean = false): Promise<SourceQualityRow[]> {
  const supabase = supabaseAdmin();

  // 1. Fetch last N pipeline runs
  const { data: runs, error: runsError } = await supabase
    .from('pipeline_runs')
    .select('id, created_at')
    .order('created_at', { ascending: false })
    .limit(runCount);

  if (runsError) {
    console.error('Failed to fetch pipeline runs:', runsError.message);
    return [];
  }

  if (!runs || runs.length === 0) {
    console.log('No pipeline runs found.');
    return [];
  }

  const runIds = runs.map((r: any) => r.id);

  // 2. Fetch completed tasks for these runs
  const taskTypes = [
    'scan_account',
    'merge_scan_results',
    'opportunity_intelligence',
    'publish_gate',
    'opportunity_judge',
  ];

  const { data: tasks, error: tasksError } = await supabase
    .from('pipeline_tasks')
    .select('run_id, task_type, account_handle, result, status')
    .in('run_id', runIds)
    .in('task_type', taskTypes)
    .eq('status', 'completed');

  if (tasksError) {
    console.error('Failed to fetch pipeline tasks:', tasksError.message);
    return [];
  }

  if (!tasks || tasks.length === 0) {
    console.log('No completed tasks found for the selected runs.');
    return [];
  }

  // 3. Aggregate by source_author/source_account
  const sourceMap = new Map<string, {
    scans_count: number;
    tweets_analyzed: number;
    raw_opportunities_count: number;
    selected_count: number;
    rescued_count: number;
    publish_gate_accepted_count: number;
    judge_passed_count: number;
    rejection_reason_counts: Record<string, number>;
    publishability_scores: number[];
    originality_potential_scores: number[];
    niche_fit_scores: number[];
    usefulness_scores: number[];
  }>();

  function getOrCreate(handle: string) {
    if (!sourceMap.has(handle)) {
      sourceMap.set(handle, {
        scans_count: 0,
        tweets_analyzed: 0,
        raw_opportunities_count: 0,
        selected_count: 0,
        rescued_count: 0,
        publish_gate_accepted_count: 0,
        judge_passed_count: 0,
        rejection_reason_counts: {},
        publishability_scores: [],
        originality_potential_scores: [],
        niche_fit_scores: [],
        usefulness_scores: [],
      });
    }
    return sourceMap.get(handle)!;
  }

  // Process scan_account tasks
  const scanTasks = tasks.filter((t: any) => t.task_type === 'scan_account');
  for (const task of scanTasks) {
    const handle = task.account_handle || task.result?.account_handle || '';
    if (!handle) continue;
    const entry = getOrCreate(handle);
    entry.scans_count++;
    entry.tweets_analyzed += task.result?.tweets_analyzed || 0;
  }

  // Process merge_scan_results tasks
  const mergeTasks = tasks.filter((t: any) => t.task_type === 'merge_scan_results');
  for (const task of mergeTasks) {
    const result = task.result || {};
    // Merge tasks don't have per-source data directly, but we can count raw_opportunities
    // from the opportunities array
    const opportunities: any[] = result._opportunities || [];
    for (const opp of opportunities) {
      const handle = opp.source_author || '';
      if (!handle) continue;
      const entry = getOrCreate(handle);
      entry.raw_opportunities_count++;
    }
  }

  // Process opportunity_intelligence tasks
  const intelTasks = tasks.filter((t: any) => t.task_type === 'opportunity_intelligence');
  for (const task of intelTasks) {
    const result = task.result || {};
    const briefs: any[] = result._briefs || [];

    for (const brief of briefs) {
      const handle = brief.source_author || '';
      if (!handle) continue;
      const entry = getOrCreate(handle);

      // Ensure raw_opportunities is counted even if merge didn't have it
      if (entry.raw_opportunities_count === 0 && entry.scans_count > 0) {
        entry.raw_opportunities_count++;
      }

      // Collect scores
      if (typeof brief.publishability_score === 'number') {
        entry.publishability_scores.push(brief.publishability_score);
      }
      if (typeof brief.originality_potential_score === 'number') {
        entry.originality_potential_scores.push(brief.originality_potential_score);
      }
      if (typeof brief.niche_fit_score === 'number') {
        entry.niche_fit_scores.push(brief.niche_fit_score);
      }
      if (typeof brief.usefulness_score === 'number') {
        entry.usefulness_scores.push(brief.usefulness_score);
      }

      // Track selected vs rejected
      if (brief.should_craft) {
        entry.selected_count++;
      } else if (brief.rejection_reason) {
        const reason = brief.rejection_reason;
        entry.rejection_reason_counts[reason] = (entry.rejection_reason_counts[reason] || 0) + 1;
      }

      // Track rescued
      if (brief.rescue_applied && brief.should_craft) {
        entry.rescued_count++;
      }
    }
  }

  // Process opportunity_judge tasks
  const judgeTasks = tasks.filter((t: any) => t.task_type === 'opportunity_judge');
  for (const task of judgeTasks) {
    const result = task.result || {};
    const scoredCandidates: any[] = result._scored_candidates || [];

    for (const candidate of scoredCandidates) {
      const handle = candidate.source_author || '';
      if (!handle) continue;
      const entry = getOrCreate(handle);

      if (candidate.judge_passed) {
        entry.judge_passed_count++;
      }
    }
  }

  // Process publish_gate tasks
  const gateTasks = tasks.filter((t: any) => t.task_type === 'publish_gate');
  for (const task of gateTasks) {
    const result = task.result || {};
    const accepted: any[] = result.accepted || [];

    for (const item of accepted) {
      const handle = item.source_author || '';
      if (!handle) continue;
      const entry = getOrCreate(handle);
      entry.publish_gate_accepted_count++;
    }
  }

  // 4. Compute final metrics
  const results: SourceQualityRow[] = [];

  for (const [handle, data] of sourceMap.entries()) {
    const rejectedCount = Object.values(data.rejection_reason_counts).reduce((a, b) => a + b, 0);

    const avgPub = data.publishability_scores.length > 0
      ? data.publishability_scores.reduce((a, b) => a + b, 0) / data.publishability_scores.length
      : 0;
    const avgOrig = data.originality_potential_scores.length > 0
      ? data.originality_potential_scores.reduce((a, b) => a + b, 0) / data.originality_potential_scores.length
      : 0;
    const avgNiche = data.niche_fit_scores.length > 0
      ? data.niche_fit_scores.reduce((a, b) => a + b, 0) / data.niche_fit_scores.length
      : 0;
    const avgUse = data.usefulness_scores.length > 0
      ? data.usefulness_scores.reduce((a, b) => a + b, 0) / data.usefulness_scores.length
      : 0;

    const yieldRate = data.tweets_analyzed > 0
      ? data.raw_opportunities_count / data.tweets_analyzed
      : 0;
    const selectedRate = data.raw_opportunities_count > 0
      ? data.selected_count / data.raw_opportunities_count
      : 0;
    const rejectionRate = data.raw_opportunities_count > 0
      ? rejectedCount / data.raw_opportunities_count
      : 0;

    const qualityScore = computeSourceQualityScore({
      selected_count: data.selected_count,
      rescued_count: data.rescued_count,
      judge_passed_count: data.judge_passed_count,
      avg_niche_fit: avgNiche,
      avg_usefulness: avgUse,
      generic_only_count: data.rejection_reason_counts['generic_only'] || 0,
      blocked_topic_count: data.rejection_reason_counts['blocked_topic'] || 0,
      language_or_context_mismatch_count: data.rejection_reason_counts['language_or_context_mismatch'] || 0,
      intelligence_parse_failed_count: data.rejection_reason_counts['intelligence_parse_failed'] || 0,
      scans_count: data.scans_count,
      raw_opportunities_count: data.raw_opportunities_count,
    });

    results.push({
      account_handle: handle,
      scans_count: data.scans_count,
      tweets_analyzed: data.tweets_analyzed,
      raw_opportunities_count: data.raw_opportunities_count,
      selected_count: data.selected_count,
      rescued_count: data.rescued_count,
      publish_gate_accepted_count: data.publish_gate_accepted_count,
      judge_passed_count: data.judge_passed_count,
      rejection_reason_counts: data.rejection_reason_counts,
      generic_only_count: data.rejection_reason_counts['generic_only'] || 0,
      blocked_topic_count: data.rejection_reason_counts['blocked_topic'] || 0,
      low_originality_count: data.rejection_reason_counts['low_originality_potential'] || 0,
      low_niche_fit_count: data.rejection_reason_counts['low_niche_fit'] || 0,
      language_or_context_mismatch_count: data.rejection_reason_counts['language_or_context_mismatch'] || 0,
      intelligence_parse_failed_count: data.rejection_reason_counts['intelligence_parse_failed'] || 0,
      avg_publishability_score: Math.round(avgPub * 100) / 100,
      avg_originality_potential_score: Math.round(avgOrig * 100) / 100,
      avg_niche_fit_score: Math.round(avgNiche * 100) / 100,
      avg_usefulness_score: Math.round(avgUse * 100) / 100,
      opportunity_yield_rate: Math.round(yieldRate * 1000) / 1000,
      selected_rate: Math.round(selectedRate * 1000) / 1000,
      rejection_rate: Math.round(rejectionRate * 1000) / 1000,
      source_quality_score: qualityScore,
    });
  }

  // Sort by source_quality_score descending
  results.sort((a, b) => b.source_quality_score - a.source_quality_score);

  // 5. Output
  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }

  // 6. Write to DB if --write flag
  if (writeMode) {
    for (const row of results) {
      const { error: upsertError } = await supabase
        .from('source_quality_scores')
        .upsert({
          source_handle: row.account_handle,
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
        }, { onConflict: 'source_handle' });

      if (upsertError) {
        console.error(`Failed to upsert ${row.account_handle}:`, upsertError.message);
      }
    }
    console.log(`\n✅ Wrote ${results.length} rows to source_quality_scores`);
  }

  return results;
}

function printTable(results: SourceQualityRow[]) {
  if (results.length === 0) {
    console.log('No source quality data found.');
    return;
  }

  // Header
  const cols = [
    'handle'.padEnd(20),
    'score'.padStart(5),
    'scans'.padStart(5),
    'tweets'.padStart(6),
    'raw'.padStart(4),
    'sel'.padStart(4),
    'resc'.padStart(4),
    'judge'.padStart(5),
    'yield'.padStart(6),
    'sel%'.padStart(6),
    'rej%'.padStart(6),
    'niche'.padStart(6),
    'usef'.padStart(6),
    'gen'.padStart(3),
    'blk'.padStart(3),
  ];

  console.log(cols.join(' │ '));
  console.log('─'.repeat(cols.join(' │ ').length));

  for (const r of results) {
    const row = [
      r.account_handle.slice(0, 20).padEnd(20),
      String(r.source_quality_score).padStart(5),
      String(r.scans_count).padStart(5),
      String(r.tweets_analyzed).padStart(6),
      String(r.raw_opportunities_count).padStart(4),
      String(r.selected_count).padStart(4),
      String(r.rescued_count).padStart(4),
      String(r.judge_passed_count).padStart(5),
      r.opportunity_yield_rate.toFixed(2).padStart(6),
      (r.selected_rate * 100).toFixed(0).padStart(5) + '%',
      (r.rejection_rate * 100).toFixed(0).padStart(5) + '%',
      r.avg_niche_fit_score.toFixed(1).padStart(6),
      r.avg_usefulness_score.toFixed(1).padStart(6),
      String(r.generic_only_count).padStart(3),
      String(r.blocked_topic_count).padStart(3),
    ];
    console.log(row.join(' │ '));
  }

  console.log(`\nTotal sources: ${results.length}`);
  console.log(`Avg quality score: ${(results.reduce((a, r) => a + r.source_quality_score, 0) / results.length).toFixed(1)}`);
}

// ═══ CLI Entry ═══

async function main() {
  const args = process.argv.slice(2);
  let runCount = 10;
  let jsonMode = false;
  let writeMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs' && args[i + 1]) {
      runCount = parseInt(args[i + 1], 10) || 10;
      i++;
    } else if (args[i] === '--json') {
      jsonMode = true;
    } else if (args[i] === '--write') {
      writeMode = true;
    }
  }

  console.log(`Running source quality audit (last ${runCount} runs)...\n`);
  await runAudit(runCount, writeMode, jsonMode);
}

// Only run main() when executed directly (via tsx/node), not when imported for testing.
// Vitest sets IS_VITEST or we can check if process.argv[1] contains this script's name.
const scriptName = 'source-quality-audit';
const isDirectRun = process.argv[1]?.includes(scriptName);

if (isDirectRun) {
  main().catch(err => {
    console.error('Source quality audit failed:', err.message);
    process.exit(1);
  });
}
