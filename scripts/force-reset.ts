import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });
import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  
  // Force reset enrich_opportunities using raw ID
  const { data: task } = await supabase
    .from('pipeline_tasks')
    .select('id, task_type, status')
    .eq('run_id', '74296ee6-6eff-4922-bd97-a4b77279fc80')
    .eq('task_type', 'enrich_opportunities')
    .single();
  
  console.log('Before:', JSON.stringify(task));
  
  if (task) {
    const { error } = await supabase
      .from('pipeline_tasks')
      .update({ 
        status: 'queued', 
        locked_at: null, 
        locked_by: null,
        attempts: 0,
        started_at: null,
        error_message: null,
        error_stack: null
      })
      .eq('id', task.id);
    
    console.log('Update error:', error?.message || 'success');
    
    const { data: after } = await supabase.from('pipeline_tasks').select('status').eq('id', task.id).single();
    console.log('After status:', after?.status);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
