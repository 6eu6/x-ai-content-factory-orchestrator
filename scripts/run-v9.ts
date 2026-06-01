import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
import { enqueuePipelineRun } from '../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const LOG = '/home/z/my-project/run-v9.log';

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  require('fs').appendFileSync(LOG, line);
}

async function main() {
  try {
    log('=== Pipeline v9 Start ===');
    
    // Cancel active
    const { data: activeRuns } = await supabase.from('pipeline_runs').select('id').in('status', ['queued', 'running']);
    if (activeRuns?.length) {
      for (const r of activeRuns) await supabase.from('pipeline_runs').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', r.id);
      log(`Cancelled ${activeRuns.length} runs`);
    }
    await supabase.from('pipeline_tasks').update({ status: 'failed', error_message: 'pre_start_v9' }).in('status', ['queued', 'running', 'locked', 'stuck']);
    
    await new Promise(r => setTimeout(r, 2000));
    
    const result = await enqueuePipelineRun({ source: 'v9', accountLimit: 3, tweetsPerAccount: 5, notifyTelegram: true, workerMode: 'local_worker' });
    if (!result.ok) { log('Enqueue failed: ' + result.message); return; }
    log(`Run: ${result.run_id!.substring(0,8)} Tasks: ${result.task_count}`);
    
    let ok = 0, fail = 0, noWork = 0;
    
    for (let i = 0; i < 100; i++) {
      try {
        log(`Batch ${i}: starting...`);
        const br = await processPipelineTaskBatch({ workerId: 'v9', maxTasks: 1, maxRuntimeMs: 300000, runId: result.run_id });
        
        ok += br.tasks_completed;
        fail += br.tasks_failed;
        
        if (br.tasks_processed > 0) {
          noWork = 0;
          log(`Batch ${i}: [${br.stopped_reason}] ok=${br.tasks_completed} fail=${br.tasks_failed} time=${br.runtime_ms}ms`);
          if (br.errors.length) log(`  ERR: ${br.errors[0]?.substring(0, 200)}`);
        } else {
          noWork++;
          log(`Batch ${i}: no work (${noWork}/10)`);
          if (noWork >= 10) break;
        }
        
        await new Promise(r => setTimeout(r, 2000));
      } catch(err: any) {
        log(`Batch ${i} FATAL: ${err.message?.substring(0, 300)}`);
        log(`Stack: ${err.stack?.substring(0, 500)}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    
    log(`\nDONE: ok=${ok} fail=${fail}`);
    
    // Results
    const { data: run } = await supabase.from('pipeline_runs').select('status, result_payload').eq('id', result.run_id).single();
    const sel = run?.result_payload?.decision?._decision?.selected || [];
    log(`Selected: ${sel.length}`);
    for (const s of sel) log(`[${s.type}] @${s.source_author} score:${s._judge_result?.final_candidate_score} orig:${s._judge_result?.originality_score} TEXT:${s.crafted_text}`);
    
    const held = run?.result_payload?.decision?._decision?.held || [];
    log(`Held: ${held.length}`);
    for (const h of held.slice(0, 5)) log(`[${h.type}] score:${h._judge_result?.final_candidate_score||h.score} orig:${h._judge_result?.originality_score||'?'} TEXT:${(h.crafted_text||'').substring(0,300)}`);
    
    log(`Telegram: ${JSON.stringify(run?.result_payload?.telegram_delivery)}`);
    
  } catch(err: any) {
    log(`FATAL: ${err.message}`);
    log(`Stack: ${err.stack}`);
  }
}

main();
