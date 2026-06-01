/**
 * reset-stuck.ts — Reset stuck/running tasks to queued for reprocessing
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  
  // Reset all running tasks to queued
  const { data: stuckTasks, error: findError } = await supabase
    .from('pipeline_tasks')
    .select('id, task_type, status, run_id')
    .in('status', ['running', 'stuck']);
  
  console.log(`Found ${stuckTasks?.length || 0} stuck/running tasks`);
  
  if (stuckTasks?.length) {
    for (const t of stuckTasks) {
      console.log(`  Resetting: ${t.task_type} (${t.status}) in run ${t.run_id}`);
    }
    
    const { error: updateError } = await supabase
      .from('pipeline_tasks')
      .update({ 
        status: 'queued', 
        locked_at: null, 
        locked_by: null,
        attempts: 0,
        error_message: null,
        error_stack: null
      })
      .in('status', ['running', 'stuck']);
    
    if (updateError) {
      console.error('Update error:', updateError.message);
    } else {
      console.log('All stuck tasks reset to queued');
    }
  }
  
  // Also ensure the run is in running status
  const { data: run } = await supabase.from('pipeline_runs')
    .select('id, status')
    .eq('id', '74296ee6-6eff-4922-bd97-a4b77279fc80')
    .single();
  
  if (run && run.status !== 'running' && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    await supabase.from('pipeline_runs').update({ status: 'running' }).eq('id', run.id);
    console.log('Run status updated to running');
  }
  
  console.log('Done!');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
