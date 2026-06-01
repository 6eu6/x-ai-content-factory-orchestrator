import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
import { enqueuePipelineRun, cancelPipelineRun } from '../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log('=== Pipeline Runner v8 ===');
  
  // Cancel all active/stuck runs
  const { data: activeRuns } = await supabase.from('pipeline_runs').select('id, status').in('status', ['queued', 'running', 'stuck']);
  for (const run of (activeRuns || [])) {
    console.log(`Canceling ${run.status} run ${String(run.id).slice(0,8)}...`);
    await cancelPipelineRun(run.id, 'v8_start');
  }
  
  // Cancel all active tasks
  await supabase.from('pipeline_tasks').update({ status: 'failed', error_message: 'cancelled_v8_start' }).in('status', ['queued', 'running', 'locked', 'stuck']);
  
  await new Promise(r => setTimeout(r, 2000));
  
  // Start fresh run with 3 accounts, 6 tweets each
  console.log('Starting new pipeline (3 accounts, 6 tweets)...');
  const result = await enqueuePipelineRun({
    source: 'v8_runner',
    accountLimit: 3,
    tweetsPerAccount: 6,
    notifyTelegram: true,
    workerMode: 'local_worker'
  });
  
  if (!result.ok) { console.error('Enqueue failed:', result.message); process.exit(1); }
  console.log(`Enqueued: ${String(result.run_id).slice(0,8)}, tasks: ${result.task_count}`);
  
  // Process ALL tasks with aggressive retry — don't break on "no_tasks"
  let totalOk = 0, totalFail = 0;
  let consecutiveNoWork = 0;
  const MAX_CONSECUTIVE_NO_WORK = 8; // Allow up to 8 consecutive no-work before giving up
  
  for (let i = 0; i < 200; i++) {
    try {
      const br = await processPipelineTaskBatch({
        workerId: 'v8-worker',
        maxTasks: 1,
        maxRuntimeMs: 300000, // 5 minutes per task
        runId: result.run_id
      });
      
      totalOk += br.tasks_completed;
      totalFail += br.tasks_failed;
      
      if (br.tasks_processed > 0) {
        consecutiveNoWork = 0; // Reset counter
        console.log(`Batch ${i}: [${br.stopped_reason}] +${br.tasks_processed} ok=${br.tasks_completed} fail=${br.tasks_failed} time=${br.runtime_ms}ms`);
        for (const err of br.errors.slice(0, 3)) console.error(`  ERR: ${err.slice(0, 200)}`);
      } else {
        consecutiveNoWork++;
        console.log(`Batch ${i}: [${br.stopped_reason}] no work (${consecutiveNoWork}/${MAX_CONSECUTIVE_NO_WORK})`);
        
        if (consecutiveNoWork >= MAX_CONSECUTIVE_NO_WORK) {
          console.log('No work for too long — pipeline stalled. Checking remaining tasks...');
          
          // Check what tasks remain
          const { data: remaining } = await supabase
            .from('pipeline_tasks')
            .select('id, task_type, status')
            .eq('run_id', result.run_id)
            .in('status', ['queued', 'running', 'stuck']);
          
          if (remaining && remaining.length > 0) {
            console.log('Remaining stuck tasks:', remaining.map(t => `${t.task_type}:${t.status}`));
            // Force-fail them
            const ids = remaining.map(t => t.id);
            await supabase.from('pipeline_tasks').update({ status: 'failed', error_message: 'stall_timeout' }).in('id', ids);
          }
          
          break;
        }
      }
      
      await new Promise(r => setTimeout(r, 3000)); // 3 second delay between batches
    } catch (err: any) {
      console.error(`Batch ${i} FATAL: ${err.message?.slice(0, 300)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log(`\n=== FINAL: ok=${totalOk} fail=${totalFail} ===`);
  
  // Check final results
  const { data: finalRun } = await supabase.from('pipeline_runs').select('status, decision_payload, telegram_payload, result_payload').eq('id', result.run_id).single();
  console.log(`Status: ${finalRun?.status}`);
  
  // Extract and display selected content
  const dp = finalRun?.result_payload?.decision?._decision;
  if (dp?.selected && dp.selected.length > 0) {
    console.log(`\n=== SELECTED CONTENT (${dp.selected.length} items) ===`);
    for (let i = 0; i < dp.selected.length; i++) {
      const s = dp.selected[i];
      console.log(`\n--- Selected #${i+1} (${s.type}) ---`);
      console.log(`Score: ${s._judge_result?.final_candidate_score}`);
      console.log(`Source: @${s.source_author}`);
      console.log(`URL: ${s.source_tweet_url}`);
      console.log(`Crafted: ${s.crafted_text}`);
    }
  } else {
    console.log('\nNo selected content');
  }
  
  // Show held items for debugging
  if (dp?.held && dp.held.length > 0) {
    console.log(`\n=== HELD ITEMS (${dp.held.length}) ===`);
    for (const h of dp.held.slice(0, 3)) {
      console.log(`[${h.type}] score:${h._judge_result?.final_candidate_score || h.score} shield:${h.shield_passed}`);
      console.log(`  Crafted: ${(h.crafted_text || '').substring(0, 300)}`);
      if (h._judge_result?.failure_reasons) console.log(`  Fail: ${h._judge_result.failure_reasons.join(', ')}`);
    }
  }
  
  console.log(`\nTelegram: ${JSON.stringify(finalRun?.telegram_payload)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
