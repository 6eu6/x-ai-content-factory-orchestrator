import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
import { enqueuePipelineRun } from '../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log('=== Pipeline v8 Direct ===');
  
  // Cancel all active
  const { data: activeRuns } = await supabase.from('pipeline_runs').select('id').in('status', ['queued', 'running']);
  if (activeRuns?.length) {
    for (const r of activeRuns) {
      await supabase.from('pipeline_runs').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', r.id);
    }
    console.log('Cancelled', activeRuns.length, 'runs');
  }
  await supabase.from('pipeline_tasks').update({ status: 'failed', error_message: 'pre_start_cleanup' }).in('status', ['queued', 'running', 'locked', 'stuck']);
  
  await new Promise(r => setTimeout(r, 1000));
  
  const result = await enqueuePipelineRun({
    source: 'direct_v8',
    accountLimit: 3,
    tweetsPerAccount: 5,
    notifyTelegram: true,
    workerMode: 'local_worker'
  });
  
  if (!result.ok) { console.error('Enqueue failed:', result.message); return; }
  console.log('Run:', result.run_id?.substring(0,8), 'Tasks:', result.task_count);
  
  let ok = 0, fail = 0, noWork = 0;
  
  for (let i = 0; i < 100; i++) {
    try {
      const br = await processPipelineTaskBatch({
        workerId: 'direct-v8',
        maxTasks: 1,
        maxRuntimeMs: 300000,
        runId: result.run_id
      });
      
      ok += br.tasks_completed;
      fail += br.tasks_failed;
      
      if (br.tasks_processed > 0) {
        noWork = 0;
        console.log(`[${br.stopped_reason}] ok=${br.tasks_completed} fail=${br.tasks_failed} time=${br.runtime_ms}ms`);
        if (br.errors.length) console.error('  ERR:', br.errors[0]?.substring(0, 200));
      } else {
        noWork++;
        console.log(`[${br.stopped_reason}] no work (${noWork}/10)`);
        if (noWork >= 10) {
          console.log('Pipeline stalled');
          break;
        }
      }
      
      await new Promise(r => setTimeout(r, 2000));
    } catch(err: any) {
      console.error(`Batch ${i} FATAL:`, err.message?.substring(0, 200));
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  console.log(`\n=== DONE: ok=${ok} fail=${fail} ===`);
  
  // Show results
  const { data: run } = await supabase.from('pipeline_runs').select('status, result_payload, telegram_payload').eq('id', result.run_id).single();
  const sel = run?.result_payload?.decision?._decision?.selected || [];
  console.log('\nSelected:', sel.length);
  for (const s of sel) {
    console.log(`\n[${s.type}] @${s.source_author}`);
    console.log('Score:', s._judge_result?.final_candidate_score);
    console.log('Originality:', s._judge_result?.originality_score);
    console.log('Text:', s.crafted_text);
  }
  
  const held = run?.result_payload?.decision?._decision?.held || [];
  console.log('\nHeld:', held.length);
  for (const h of held.slice(0, 5)) {
    console.log(`  [${h.type}] score:${h._judge_result?.final_candidate_score} orig:${h._judge_result?.originality_score} shield:${h.shield_passed}`);
    console.log(`  Text: ${(h.crafted_text || '').substring(0, 300)}`);
    if (h._judge_result?.failure_reasons?.length) console.log(`  Fail: ${h._judge_result.failure_reasons.join(', ')}`);
  }
  
  console.log('\nTelegram:', JSON.stringify(run?.result_payload?.telegram_delivery || run?.telegram_payload));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
