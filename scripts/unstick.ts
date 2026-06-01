import { config } from 'dotenv'; import { resolve } from 'path'; config({ path: resolve(process.cwd(), '.env') });
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Mark stuck running tasks
  const { error } = await supabase
    .from('pipeline_tasks')
    .update({ status: 'stuck', error_message: 'manually unstuck by new session' })
    .eq('status', 'running');
  console.log('Unstuck tasks:', error?.message || 'done');

  // Mark stuck runs
  const { error: rerr } = await supabase
    .from('pipeline_runs')
    .update({ status: 'stuck', current_step: 'manually_unstuck' })
    .eq('status', 'running');
  console.log('Unstuck runs:', rerr?.message || 'done');
}
main().catch(e => console.error(e));
