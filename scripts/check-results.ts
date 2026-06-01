import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  // Get latest completed run ID
  const { data: runs } = await supabase.from('pipeline_runs')
    .select('id, status')
    .eq('status', 'completed')
    .order('started_at', { ascending: false }).limit(1);
  if (!runs?.length) { console.log('No completed runs'); return; }
  const runId = runs[0].id;
  console.log('Latest completed run:', String(runId).slice(0,8));

  // Check decision task result
  const { data: tasks } = await supabase.from('pipeline_tasks')
    .select('task_type, result')
    .eq('run_id', runId)
    .in('task_type', ['decision', 'telegram_delivery', 'publish_gate', 'opportunity_judge', 'quality_enhance']);
  
  for (const t of (tasks || [])) {
    const r = t.result || {};
    console.log('\n=== ' + t.task_type + ' ===');
    if (t.task_type === 'decision') {
      console.log('Selected:', r.selected_count, 'Held:', r.held_count);
      if (r.selected_items?.length) {
        for (const item of r.selected_items.slice(0,3)) {
          console.log(`  Score: ${item.final_score}/10 | Type: ${item.type}`);
          console.log(`  Text: ${(item.crafted_text || '').slice(0, 200)}`);
          console.log(`  Source: ${item.source_tweet_url}`);
          console.log(`  Reasons: ${(item.reasons || []).join(', ')}`);
        }
      }
    }
    if (t.task_type === 'publish_gate') {
      console.log('Accepted:', r.accepted_count, 'Rejected:', r.rejected_count);
      if (r.rejection_reasons?.length) {
        console.log('Top rejection reasons:', r.rejection_reasons.slice(0, 5));
      }
    }
    if (t.task_type === 'opportunity_judge') {
      console.log('Judge passed:', r.judge_passed_count, 'Failed:', r.judge_failed_count);
    }
    if (t.task_type === 'telegram_delivery') {
      console.log('Delivered:', r.delivered, 'Message length:', (r.message || '').length);
    }
  }

  // Check decision_runs
  const { data: decisions } = await supabase.from('decision_runs')
    .select('id, selected_count, held_count, run_source, created_at')
    .order('created_at', { ascending: false }).limit(3);
  console.log('\nRecent decision_runs:', decisions?.map(d => ({
    id: String(d.id).slice(0,8), selected: d.selected_count, held: d.held_count, source: d.run_source
  })));
}
check().catch(e => console.error('Fatal:', e));
