/**
 * Backfill source_quality_scores from existing pipeline_runs / pipeline_tasks data.
 *
 * Usage:
 *   npx tsx scripts/backfill-source-quality.mts                       # dry-run, accounts-only
 *   npx tsx scripts/backfill-source-quality.mts --write               # actually write to DB
 *   npx tsx scripts/backfill-source-quality.mts --include-external    # include sources not in accounts table
 *   npx tsx scripts/backfill-source-quality.mts --write --include-external
 *
 * Safety:
 *   - By default, only includes sources that exist in public.accounts AND are valid X handles.
 *   - --include-external adds sources discovered from pipeline data but not in the accounts table.
 *   - Invalid X handles (Arabic, emoji, UI labels) are always excluded.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { supabaseAdmin } from '../lib/supabase';
import {
  type SourceQualityRow,
  type AggregationDiagnostics,
  aggregateSourceQualityFromTasks,
  upsertSourceQualityScores,
  computeSourceQualityScore,
} from '../lib/source-quality';
import { isValidXHandle } from '../lib/pipeline-queue';

const DRY_RUN = !process.argv.includes('--write');
const INCLUDE_EXTERNAL = process.argv.includes('--include-external');

async function main() {
  console.log('═══ Source Quality Backfill ═══');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);
  console.log(`Include external sources: ${INCLUDE_EXTERNAL ? 'YES' : 'NO (accounts table only)'}`);
  console.log('');

  const supabase = supabaseAdmin();

  // ─── Step 1: Build valid handle allowlist from accounts table ─────────
  console.log('Fetching accounts from public.accounts...');
  const { data: accountRows, error: accountsError } = await supabase
    .from('accounts')
    .select('handle')
    .limit(5000);

  if (accountsError) {
    console.error('Error fetching accounts:', accountsError.message);
    process.exit(1);
  }

  const accountsAllowlist = new Set<string>();
  let invalidAccountsCount = 0;
  for (const row of accountRows ?? []) {
    if (isValidXHandle(row.handle)) {
      accountsAllowlist.add(row.handle.toLowerCase());
    } else {
      invalidAccountsCount++;
    }
  }
  console.log(`Found ${accountsAllowlist.size} valid accounts in accounts table${invalidAccountsCount > 0 ? ` (${invalidAccountsCount} invalid handles skipped)` : ''}`);
  console.log('');

  // ─── Step 2: Fetch pipeline tasks ─────────────────────────────────────
  console.log('Fetching pipeline tasks...');
  const { data: tasks, error } = await supabase
    .from('pipeline_tasks')
    .select('task_type, account_handle, result, run_id')
    .in('task_type', ['scan_account', 'merge_scan_results', 'opportunity_intelligence', 'opportunity_judge', 'publish_gate'])
    .eq('status', 'completed');

  if (error) {
    console.error('Error fetching tasks:', error.message);
    process.exit(1);
  }

  if (!tasks || tasks.length === 0) {
    console.log('No completed tasks found. Nothing to backfill.');
    process.exit(0);
  }

  console.log(`Found ${tasks.length} completed tasks (including global tasks with null account_handle)`);

  // ─── Step 3: Aggregate ────────────────────────────────────────────────
  const { sources: aggregated, diagnostics } = aggregateSourceQualityFromTasks(
    tasks.map((t) => ({
      task_type: t.task_type,
      account_handle: t.account_handle as string | null,
      result: (typeof t.result === 'object' && t.result !== null ? t.result : {}) as Record<string, any>,
    }))
  );

  console.log(`Aggregated quality data for ${aggregated.size} sources`);
  if (diagnostics.skipped_invalid_source_handles.length > 0) {
    console.log(`Skipped ${diagnostics.skipped_invalid_source_handles.length} invalid source handles: ${diagnostics.skipped_invalid_source_handles.slice(0, 10).join(', ')}${diagnostics.skipped_invalid_source_handles.length > 10 ? ' ...' : ''}`);
  }
  console.log('');

  // ─── Step 4: Filter by accounts allowlist ─────────────────────────────
  let externalSourcesSkipped = 0;
  const filteredRows: SourceQualityRow[] = [];

  for (const row of aggregated.values()) {
    // Always skip invalid X handles (extra safety gate)
    if (!isValidXHandle(row.source_handle)) {
      continue;
    }

    const isInAccounts = accountsAllowlist.has(row.source_handle.toLowerCase());

    if (!isInAccounts && !INCLUDE_EXTERNAL) {
      externalSourcesSkipped++;
      continue;
    }

    filteredRows.push(row);
  }

  const validAccountsSeen = filteredRows.filter(
    (r) => accountsAllowlist.has(r.source_handle.toLowerCase())
  ).length;

  filteredRows.sort((a, b) => b.source_quality_score - a.source_quality_score);

  // ─── Step 5: Display summary ──────────────────────────────────────────
  console.log('═══ Summary ═══');
  console.log('');
  console.log(`valid_accounts_seen:     ${validAccountsSeen}`);
  console.log(`external_sources_skipped: ${externalSourcesSkipped}`);
  console.log(`invalid_sources_skipped:  ${diagnostics.skipped_invalid_source_handles.length}`);
  console.log(`rows_to_upsert:          ${filteredRows.length}`);
  console.log('');

  const scoreBuckets = { strong: 0, neutral: 0, low: 0, veryLow: 0 };
  for (const row of filteredRows) {
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
  if (filteredRows.length > 0) {
    console.log('═══ Top 10 Sources ═══');
    for (const row of filteredRows.slice(0, 10)) {
      console.log(
        `  ${row.source_handle.padEnd(20)} score=${row.source_quality_score.toFixed(1).padStart(6)}  scans=${row.scans_count}  selected_rate=${(row.selected_rate * 100).toFixed(0).padStart(3)}%  judge_passed=${row.judge_passed_count}  gate_accepted=${row.publish_gate_accepted_count}`
      );
    }

    if (filteredRows.length > 10) {
      console.log('');
      console.log('═══ Bottom 5 Sources ═══');
      for (const row of filteredRows.slice(-5)) {
        console.log(
          `  ${row.source_handle.padEnd(20)} score=${row.source_quality_score.toFixed(1).padStart(6)}  scans=${row.scans_count}  selected_rate=${(row.selected_rate * 100).toFixed(0).padStart(3)}%  rejection_rate=${(row.rejection_rate * 100).toFixed(0).padStart(3)}%`
        );
      }
    }
  }

  // ─── Step 6: Write if --write flag is set ─────────────────────────────
  if (DRY_RUN) {
    console.log('');
    console.log('═══ DRY RUN — no data written ═══');
    console.log(`Would upsert ${filteredRows.length} rows into source_quality_scores`);
    if (externalSourcesSkipped > 0) {
      console.log(`${externalSourcesSkipped} external sources skipped (use --include-external to include)`);
    }
    console.log('Run with --write to apply:');
    console.log('  npx tsx scripts/backfill-source-quality.mts --write');
    process.exit(0);
  }

  console.log('');
  console.log('═══ Writing to source_quality_scores ═══');

  const result = await upsertSourceQualityScores(filteredRows);

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
