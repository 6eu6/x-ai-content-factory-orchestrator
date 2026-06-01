import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Get the running task details
  const { data: runs } = await supabase.from('pipeline_runs').select('id, status, current_step').eq('status', 'running').limit(1);
  if (!runs?.length) { console.log('No running runs'); return; }
  const runId = runs[0].id!;
  
  const { data: tasks } = await supabase.from('pipeline_tasks').select('*').eq('run_id', runId).eq('status', 'running').limit(5);
  for (const t of (tasks || [])) {
    console.log(`Task ${t.task_type} (@${t.account_handle})`);
    console.log(`  status: ${t.status}`);
    console.log(`  attempts: ${t.attempts}`);
    console.log(`  locked_at: ${t.locked_at}`);
    console.log(`  locked_by: ${t.locked_by}`);
    console.log(`  error: ${(t.error_message || 'none').slice(0,200)}`);
  }
  
  // Also check log
  try {
    const fs = await import('fs');
    const logContent = fs.readFileSync('/home/z/my-project/pipeline-v7.log', 'utf-8').slice(-3000);
    console.log(logContent);
  } catch { console.log('(no log file)'); }
}
main().catch(e => console.error(e));
