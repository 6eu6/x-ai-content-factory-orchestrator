/**
 * continue-run.ts — Continue processing remaining tasks for a specific run
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { processPipelineTaskBatch } from '../lib/pipeline-worker';
import { supabaseAdmin } from '../lib/supabase';

const WORKER_ID = `local-debug-continuation-${Date.now()}`;
const MAX_RUNTIME_MS = 600000; // 10 min

async function main() {
  const supabase = supabaseAdmin();
  
  // Get the latest active run
  const { data: run } = await supabase.from('pipeline_runs')
    .select('id, status, total_tasks, completed_tasks, failed_tasks')
    .in('status', ['queued', 'running', 'stuck'])
    .order('started_at', { ascending: false })
    .limit(1)
    .single();
  
  if (!run) {
    // Try the last completed run
    const { data: lastRun } = await supabase.from('pipeline_runs')
      .select('id, status, total_tasks, completed_tasks, failed_tasks')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    
    console.log('No active runs. Latest run:', lastRun);
    if (!lastRun) {
      console.log('No runs found at all');
      return;
    }
    
    // If latest run is completed/failed but has unfinished tasks, resume it
    const { data: unfinishedTasks } = await supabase.from('pipeline_tasks')
      .select('id, status')
      .eq('run_id', lastRun.id)
      .in('status', ['running', 'queued']);
    
    if (unfinishedTasks && unfinishedTasks.length > 0) {
      console.log(`Found ${unfinishedTasks.length} unfinished tasks for run ${lastRun.id}`);
      // Reset running tasks to queued
      for (const t of unfinishedTasks) {
        await supabase.from('pipeline_tasks').update({ status: 'queued', locked_at: null, locked_by: null }).eq('id', t.id);
      }
      await supabase.from('pipeline_runs').update({ status: 'running' }).eq('id', lastRun.id);
      processTasks(lastRun.id);
    } else {
      console.log('All tasks completed for this run');
    }
    return;
  }
  
  processTasks(run.id);
}

async function processTasks(runId: string) {
  console.log(`Processing tasks for run: ${runId}`);
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
      maxRuntimeMs: 180000,
      runId: runId
    });
    
    totalProcessed += result.tasks_processed;
    totalCompleted += result.tasks_completed;
    totalFailed += result.tasks_failed;
    
    console.log(
      `[worker] Batch ${iteration}: ` +
      `processed=${result.tasks_processed} completed=${result.tasks_completed} failed=${result.tasks_failed} ` +
      `total=${totalProcessed}/${totalCompleted} time=${Math.round((Date.now()-startTime)/1000)}s ` +
      `reason=${result.stopped_reason}`
    );
    
    if (result.errors.length > 0) {
      for (const err of result.errors.slice(0, 3)) {
        console.error(`[worker] ERROR: ${err.slice(0, 150)}`);
      }
    }
    
    if (result.stopped_reason === 'no_tasks' || result.stopped_reason === 'no_more_tasks') {
      console.log('[worker] All tasks done!');
      break;
    }
    
    await new Promise(r => setTimeout(r, 3000));
  }
  
  console.log(`\n=== FINAL ===`);
  console.log(`Processed: ${totalProcessed}, Completed: ${totalCompleted}, Failed: ${totalFailed}`);
  console.log(`Runtime: ${Math.round((Date.now()-startTime)/1000)}s`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
