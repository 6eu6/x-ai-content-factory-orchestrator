/**
 * debug-queue.ts — Debug why no tasks are being picked up
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  const runId = '74296ee6-6eff-4922-bd97-a4b77279fc80';
  
  // All tasks
  const { data: tasks } = await supabase
    .from('pipeline_tasks')
    .select('id, task_type, status, step_order, locked_at, locked_by, attempts, max_attempts')
    .eq('run_id', runId)
    .order('step_order');
  
  console.log(`All tasks for run ${runId}:`);
  tasks?.forEach(t => {
    console.log(`  ${t.status.padEnd(12)} step=${t.step_order} attempts=${t.attempts}/${t.max_attempts} locked_by=${t.locked_by || 'null'} ${t.task_type}`);
  });
  
  // Run status
  const { data: run } = await supabase.from('pipeline_runs').select('id, status, total_tasks, completed_tasks, failed_tasks').eq('id', runId).single();
  console.log(`\nRun: status=${run?.status} completed=${run?.completed_tasks}/${run?.total_tasks}`);
  
  // Try manually finding queued tasks
  const { data: queued } = await supabase
    .from('pipeline_tasks')
    .select('id, task_type')
    .eq('run_id', runId)
    .in('status', ['queued']);
  
  console.log(`\nQueued tasks: ${queued?.length}`);
  queued?.forEach(t => console.log(`  ${t.task_type} (${t.id.slice(0,8)})`));
  
  // Try to manually lock enrich_opportunities
  const { data: enrichTask } = await supabase
    .from('pipeline_tasks')
    .select('id, status, step_order')
    .eq('run_id', runId)
    .eq('task_type', 'enrich_opportunities')
    .single();
  
  if (enrichTask) {
    console.log(`\nenrich_opportunities task: status=${enrichTask.status} step=${enrichTask.step_order}`);
    
    if (enrichTask.status === 'queued') {
      console.log('Attempting manual lock...');
      const now = new Date().toISOString();
      const { data: locked, error } = await supabase
        .from('pipeline_tasks')
        .update({
          status: 'running',
          locked_at: now,
          locked_by: 'manual-debug',
          started_at: now,
          attempts: enrichTask.attempts + 1
        })
        .eq('id', enrichTask.id)
        .eq('status', 'queued')
        .select('id, status')
        .maybeSingle();
      
      console.log('Lock result:', error?.message || JSON.stringify(locked));
      
      if (locked) {
        // Unlock it back
        await supabase.from('pipeline_tasks').update({ status: 'queued', locked_at: null, locked_by: null, attempts: enrichTask.attempts }).eq('id', enrichTask.id);
        console.log('Unlocked back to queued');
      }
    }
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
