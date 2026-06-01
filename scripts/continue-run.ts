import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
import { processPipelineTaskBatch } from '../lib/pipeline-worker';
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: run } = await supabase.from('pipeline_runs').select('id').eq('status', 'running').order('started_at', { ascending: false }).limit(1).single();
  if (!run) { console.log('No running run'); return; }
  const runId = run.id!;
  console.log(`Processing run ${runId.slice(0,8)}...`);
  
  // Unlock any stuck tasks
  const { data: unlocked } = await supabase.from('pipeline_tasks')
    .update({ status: 'queued', locked_by: null, locked_at: null })
    .eq('run_id', runId)
    .in('status', ['locked', 'running', 'stuck'])
    .select();
  if (unlocked?.length) console.log(`Unlocked ${unlocked.length} tasks`);
  
  let totalOk = 0, totalFail = 0;
  for (let i = 0; i < 100; i++) {
    try {
      const br = await processPipelineTaskBatch({
        workerId: 'continue-worker',
        maxTasks: 1,
        maxRuntimeMs: 300000,
        runId
      });
      totalOk += br.tasks_completed;
      totalFail += br.tasks_failed;
      console.log(`[${br.stopped_reason}] +${br.tasks_processed} ok=${br.tasks_completed} fail=${br.tasks_failed} ms=${br.runtime_ms}`);
      for (const err of br.errors.slice(0, 3)) console.error(`  ERR: ${err.slice(0, 200)}`);
      if (br.stopped_reason === 'no_tasks' || br.stopped_reason === 'no_more_tasks') break;
      await new Promise(r => setTimeout(r, 2000));
    } catch (err: any) {
      console.error(`FATAL: ${err.message?.slice(0, 300)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`\nTOTAL: ok=${totalOk} fail=${totalFail}`);
  
  // Final results
  const { data: finalRun } = await supabase.from('pipeline_runs').select('status, decision_payload, telegram_payload').eq('id', runId).single();
  console.log(`Status: ${finalRun?.status}`);
  const dp = finalRun?.decision_payload as any;
  console.log(`Selected: ${dp?.selected}`);
  console.log(`Held: ${dp?.held}`);
  const tp = finalRun?.telegram_payload as any;
  console.log(`Telegram delivered: ${tp?.delivered}`);
  
  // Check individual decision
  const { data: decTask } = await supabase.from('pipeline_tasks').select('result').eq('run_id', runId).eq('task_type', 'decision').maybeSingle();
  const decision = decTask?.result?._decision;
  if (decision) {
    console.log(`\nDecision stage: ${decision.stage}`);
    if (decision.selected?.length) {
      console.log('\n✅ SELECTED CONTENT:');
      for (const s of decision.selected) {
        console.log(`  Score: ${s.decision_score?.final_score}`);
        console.log(`  Text: ${s.crafted_text}`);
        console.log();
      }
    }
    if (decision.held?.length) {
      console.log(`\n⏸ HELD (${decision.held.length}):`);
      for (const h of decision.held.slice(0, 3)) {
        console.log(`  Score: ${h.decision_score?.final_score} | ${String(h.crafted_text).slice(0, 100)}`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
