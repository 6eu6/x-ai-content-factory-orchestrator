/**
 * trigger-and-run.ts — Trigger a pipeline run and process it locally
 * 
 * This combines the queue enqueue + worker processing into one script.
 * It creates a pipeline run in Supabase, then immediately processes all tasks.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env') });

import { enqueuePipelineRun } from '../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';

async function main() {
  console.log('=== Triggering Pipeline Run ===');
  
  // Cancel any active runs first
  const { supabaseAdmin } = require('../lib/supabase');
  const supabase = supabaseAdmin();
  
  // Cancel stuck/running runs
  const { data: activeRuns } = await supabase
    .from('pipeline_runs')
    .select('id, status')
    .in('status', ['queued', 'running', 'stuck'])
    .limit(5);
  
  if (activeRuns?.length) {
    console.log(`Canceling ${activeRuns.length} active runs...`);
    for (const run of activeRuns) {
      await supabase.from('pipeline_tasks')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('run_id', run.id)
        .in('status', ['queued', 'running', 'stuck']);
      
      await supabase.from('pipeline_runs')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'new_run', updated_at: new Date().toISOString() })
        .eq('id', run.id)
        .in('status', ['queued', 'running', 'stuck']);
    }
    console.log('Active runs cancelled.');
  }
  
  // Enqueue a new pipeline run
  console.log('Enqueueing new pipeline run...');
  const enqueueResult = await enqueuePipelineRun({
    source: 'local_worker',
    accountLimit: 3,  // Start small for testing
    tweetsPerAccount: 8,
    notifyTelegram: true,
    workerMode: 'local_worker'
  });
  
  if (!enqueueResult.ok) {
    console.error('Failed to enqueue:', enqueueResult.message);
    process.exit(1);
  }
  
  console.log(`Pipeline enqueued: run_id=${enqueueResult.run_id}, tasks=${enqueueResult.task_count}`);
  
  if (enqueueResult.task_count === 0) {
    console.error('No tasks created!');
    process.exit(1);
  }
  
  // Process all tasks
  console.log('\n=== Processing Pipeline Tasks ===');
  const runId = enqueueResult.run_id!;
  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  const maxBatches = 50; // Safety limit
  
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await processPipelineTaskBatch({
      workerId: 'local-worker',
      maxTasks: 3,
      maxRuntimeMs: 120000, // 2 minutes per batch
      runId
    });
    
    totalProcessed += result.tasks_processed;
    totalCompleted += result.tasks_completed;
    totalFailed += result.tasks_failed;
    
    if (result.tasks_processed > 0) {
      console.log(`Batch ${batch + 1}: processed ${result.tasks_processed}, completed ${result.tasks_completed}, failed ${result.tasks_failed} (${result.runtime_ms}ms) | ${result.stopped_reason}`);
      if (result.errors.length > 0) {
        for (const err of result.errors.slice(0, 3)) {
          console.error(`  ERROR: ${err.slice(0, 200)}`);
        }
      }
    }
    
    if (result.stopped_reason === 'no_tasks' || result.stopped_reason === 'no_more_tasks') {
      console.log('All tasks processed.');
      break;
    }
    
    if (result.stopped_reason === 'max_runtime' || result.stopped_reason === 'max_tasks') {
      // Small delay between batches
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log(`\n=== Pipeline Complete ===`);
  console.log(`Total: processed=${totalProcessed}, completed=${totalCompleted}, failed=${totalFailed}`);
  
  // Check final results
  const { data: finalRun } = await supabase
    .from('pipeline_runs')
    .select('id, status, current_step, error_message, decision_payload, telegram_payload')
    .eq('id', runId)
    .maybeSingle();
  
  if (finalRun) {
    console.log(`Run status: ${finalRun.status}`);
    console.log(`Decision: selected=${finalRun.decision_payload?.selected || 0}, held=${finalRun.decision_payload?.held || 0}`);
    console.log(`Telegram: delivered=${finalRun.telegram_payload?.delivered || false}`);
    if (finalRun.error_message) console.log(`Error: ${finalRun.error_message.slice(0, 300)}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
