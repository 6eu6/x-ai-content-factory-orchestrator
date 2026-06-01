/**
 * trigger-and-run.ts — One-shot script to enqueue a pipeline run then process all tasks.
 * Used for debugging: triggers a small pipeline run (2 accounts, 5 tweets each),
 * then runs the worker until all tasks complete or max runtime exceeded.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { enqueuePipelineRun } from '../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';
import { markStuckTasks } from '../lib/pipeline-queue';
import { markStuckPipelineRuns } from '../lib/pipeline-run-tracker';

const WORKER_ID = `local-debug-worker-${Date.now()}`;
const MAX_RUNTIME_MS = 600000; // 10 minutes max

async function main() {
  console.log('[trigger-and-run] Step 1: Enqueuing pipeline run...');
  
  const enqueueResult = await enqueuePipelineRun({
    source: 'manual_debug',
    accountLimit: 2,  // Small: just 2 accounts for debugging
    tweetsPerAccount: 5,
    notifyTelegram: true,
    username: '30piq',
    runSource: 'manual_debug',
    workerMode: 'local_debug'
  });
  
  console.log('[trigger-and-run] Enqueue result:', JSON.stringify(enqueueResult));
  
  if (!enqueueResult.ok || !enqueueResult.run_id) {
    console.error('[trigger-and-run] Failed to enqueue pipeline run');
    process.exit(1);
  }
  
  const runId = enqueueResult.run_id;
  console.log(`[trigger-and-run] Pipeline run created: ${runId}`);
  console.log(`[trigger-and-run] Tasks created: ${enqueueResult.task_count}`);
  
  console.log('\n[trigger-and-run] Step 2: Processing tasks...');
  const startTime = Date.now();
  let iteration = 0;
  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  
  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    iteration++;
    
    const result = await processPipelineTaskBatch({
      workerId: WORKER_ID,
      maxTasks: 3,
      maxRuntimeMs: 120000,  // 2 min per batch
      runId: runId
    });
    
    totalProcessed += result.tasks_processed;
    totalCompleted += result.tasks_completed;
    totalFailed += result.tasks_failed;
    
    console.log(
      `[trigger-and-run] Batch ${iteration}: ` +
      `processed=${result.tasks_processed} completed=${result.tasks_completed} failed=${result.tasks_failed} ` +
      `total_processed=${totalProcessed} total_completed=${totalCompleted} total_failed=${totalFailed} ` +
      `runtime=${Date.now() - startTime}ms stopped=${result.stopped_reason}`
    );
    
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`[trigger-and-run] ERROR: ${err}`);
      }
    }
    
    // Check if all tasks are done
    if (result.stopped_reason === 'no_tasks' || result.stopped_reason === 'no_more_tasks') {
      console.log('[trigger-and-run] No more tasks to process');
      break;
    }
    
    if (result.stopped_reason === 'max_runtime') {
      console.log('[trigger-and-run] Batch hit max runtime, starting next batch...');
    }
    
    // Small delay between batches
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log('\n[trigger-and-run] === FINAL RESULTS ===');
  console.log(`[trigger-and-run] Total iterations: ${iteration}`);
  console.log(`[trigger-and-run] Total tasks processed: ${totalProcessed}`);
  console.log(`[trigger-and-run] Total completed: ${totalCompleted}`);
  console.log(`[trigger-and-run] Total failed: ${totalFailed}`);
  console.log(`[trigger-and-run] Total runtime: ${Date.now() - startTime}ms`);
  console.log(`[trigger-and-run] Run ID: ${runId}`);
}

main().catch(err => {
  console.error('[trigger-and-run] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
