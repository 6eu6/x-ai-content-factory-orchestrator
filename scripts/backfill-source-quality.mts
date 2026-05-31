/**
 * Backfill source_quality_scores from existing pipeline_runs / pipeline_tasks data.
 *
 * Usage:
 *   npx tsx scripts/backfill-source-quality.mts            # dry-run (no writes)
 *   npx tsx scripts/backfill-source-quality.mts --write    # actually write to DB
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { supabaseAdmin } from '../lib/supabase';
import {
  type SourceQualityRow,
  aggregateSourceQualityFromTasks,
  upsertSourceQualityScores,
  computeSourceQualityScore,
} from '../lib/source-quality';

const DRY_RUN = !process.argv.includes('--write');

async function main() {
  console.log('═══ Source Quality Backfill ═══');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);
  console.log('');

  const supabase = supabaseAdmin();

  // 1. Fetch all completed pipeline tasks that have results
  console.log('Fetching pipeline tasks...');
  const { data: tasks, error } = await supabase
    .from('pipeline_tasks')
    .select('task_type, account_handle, result, run_id')
    .in('task_type', ['scan_account', 'opportunity_intelligence', 'opportunity_judge', 'publish_gate'])
    .eq('status', 'completed')
    .not('account_handle', 'is', null);

  if (error) {
    console.error('Error fetching tasks:', error.message);
    process.exit(1);
  }

  if (!tasks || tasks.length === 0) {
    console.log('No completed tasks found. Nothing to backfill.');
    process.exit(0);
  }

  console.log(`Found ${tasks.length} completed tasks with account_handle`);

  // 2. Aggregate source quality from tasks
  const aggregated = aggregateSourceQualityFromTasks(
    tasks.map((t) => ({
      task_type: t.task_type,
      account_handle: t.account_handle as string,
      result: (typeof t.result === 'object' && t.result !== null ? t.result : {}) as Record<string, any>,
    }))
  );

  console.log(`Aggregated quality data for ${aggregated.size} accounts`);
  console.log('');

  // 3. Display summary
  const rows = Array.from(aggregated.values());
  rows.sort((a, b) => b.source_quality_score - a.source_quality_score);

  console.log('═══ Summary ═══');
  console.log('');

  const scoreBuckets = { strong: 0, neutral: 0, low: 0, veryLow: 0 };
  for (const row of rows) {
    if (row.source_quality_score >= 70) scoreBuckets.strong++;
    else if (row.source_quality_score >= 35) scoreBuckets.neutral++;
    else if (row.source_quality_score >= 20) scoreBuckets.low++;
    else scoreBuckets.veryLow++;
  }

  console.log(`Strong sources (>= 70):  ${scoreBuckets.strong}`);
  console.log(`Neutral sources (35-69): ${scoreBuckets.neutral}`);
  console.log(`Low sources (20-34):     ${scoreBuckets.low}`);
  console.log(`Very low (< 20):         ${scoreBuckets.veryLow}`);
  console.log('');

  // Show top 10 and bottom 5
  console.log('═══ Top 10 Sources ═══');
  for (const row of rows.slice(0, 10)) {
    console.log(
      `  ${row.source_handle.padEnd(20)} score=${row.source_quality_score.toFixed(1).padStart(6)}  scans=${row.scans_count}  selected_rate=${(row.selected_rate * 100).toFixed(0).padStart(3)}%  judge_passed=${row.judge_passed_count}  gate_accepted=${row.publish_gate_accepted_count}`
    );
  }

  if (rows.length > 10) {
    console.log('');
    console.log('═══ Bottom 5 Sources ═══');
    for (const row of rows.slice(-5)) {
      console.log(
        `  ${row.source_handle.padEnd(20)} score=${row.source_quality_score.toFixed(1).padStart(6)}  scans=${row.scans_count}  selected_rate=${(row.selected_rate * 100).toFixed(0).padStart(3)}%  rejection_rate=${(row.rejection_rate * 100).toFixed(0).padStart(3)}%`
      );
    }
  }

  // 4. Write if --write flag is set
  if (DRY_RUN) {
    console.log('');
    console.log('═══ DRY RUN — no data written ═══');
    console.log(`Would upsert ${rows.length} rows into source_quality_scores`);
    console.log('Run with --write to apply:');
    console.log('  npx tsx scripts/backfill-source-quality.mts --write');
    process.exit(0);
  }

  console.log('');
  console.log('═══ Writing to source_quality_scores ═══');

  const result = await upsertSourceQualityScores(rows);

  if (result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`Successfully upserted ${result.upserted} rows`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
