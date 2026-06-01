/**
 * check-results.ts — Quick database state check after pipeline run
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  
  // Latest pipeline run
  const { data: run } = await supabase.from('pipeline_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();
  
  console.log('=== LATEST PIPELINE RUN ===');
  console.log('ID:', run.id);
  console.log('Status:', run.status);
  console.log('Source:', run.source);
  console.log('Total/Completed/Failed tasks:', run.total_tasks, run.completed_tasks, run.failed_tasks);
  console.log('Worker mode:', run.worker_mode);
  
  if (run.result_payload) {
    const rp = run.result_payload;
    console.log('\nResult payload:');
    console.log('  opportunities_found:', rp.opportunities_found || rp.raw_opportunities || 'N/A');
    console.log('  gate_accepted:', rp.gate_accepted ?? 'N/A');
    console.log('  gate_rejected:', rp.gate_rejected ?? 'N/A');
    console.log('  selected:', rp.selected ?? 'N/A');
  }
  
  // Tasks for this run
  const { data: tasks } = await supabase.from('pipeline_tasks')
    .select('task_type, status, account_handle, error_message')
    .eq('run_id', run.id)
    .order('step_order');
  
  console.log('\n=== TASKS (' + (tasks?.length || 0) + ') ===');
  tasks?.forEach(t => {
    const err = t.error_message ? ' ❌ ' + t.error_message.slice(0, 80) : '';
    console.log('  ' + t.task_type.padEnd(28) + t.status.padEnd(12) + (t.account_handle || 'global').padEnd(18) + err);
  });
  
  // Decision runs
  const { data: decisions } = await supabase.from('decision_runs')
    .select('id, selected_count, held_count, decision_score, run_source, created_at')
    .order('created_at', { ascending: false })
    .limit(3);
  console.log('\n=== DECISION RUNS ===');
  decisions?.forEach(d => console.log(`  ${d.created_at?.slice(0,19)} | selected=${d.selected_count} held=${d.held_count} score=${d.decision_score} source=${d.run_source}`));
  
  // Published decisions
  const { data: published } = await supabase.from('published_decisions')
    .select('id, published_text, source_tweet_url, content_type, decision_score, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('\n=== PUBLISHED DECISIONS (latest 5) ===');
  if (published?.length) {
    published.forEach(p => {
      console.log(`  ID: ${p.id?.slice(0,8)} | Score: ${p.decision_score} | Status: ${p.status} | Type: ${p.content_type}`);
      console.log(`  Text: ${(p.published_text || '').slice(0, 200)}`);
      console.log(`  Source: ${p.source_tweet_url || 'N/A'}`);
      console.log('');
    });
  } else {
    console.log('  (none)');
  }
  
  // Rejections
  const { data: rejections } = await supabase.from('rejection_ledger')
    .select('rejection_reason, opportunity_type, crafted_text_preview')
    .eq('run_id', run.id)
    .limit(15);
  console.log('=== REJECTIONS (' + (rejections?.length || 0) + ') ===');
  rejections?.forEach(r => {
    console.log(`  ${r.rejection_reason}: ${(r.crafted_text_preview || '').slice(0, 100)}`);
  });
  
  // Cost ledger
  const { data: costs } = await supabase.from('pipeline_cost_ledger')
    .select('task_type, model, input_tokens, output_tokens, estimated_cost_usd, status, error')
    .eq('run_id', run.id);
  console.log('\n=== COST LEDGER (' + (costs?.length || 0) + ' entries) ===');
  let totalCost = 0;
  let totalIn = 0, totalOut = 0;
  costs?.forEach(c => {
    const cost = parseFloat(c.estimated_cost_usd || 0);
    totalCost += cost;
    totalIn += c.input_tokens || 0;
    totalOut += c.output_tokens || 0;
    const errTag = c.error ? ' ❌' : '';
    console.log(`  ${c.task_type.padEnd(30)} ${c.model || 'N/A'} in=${c.input_tokens} out=${c.output_tokens} $${c.estimated_cost_usd} ${c.status}${errTag}`);
  });
  console.log(`  TOTAL: in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(6)}`);
  
  // Telegram payload
  if (run.telegram_payload) {
    console.log('\n=== TELEGRAM DELIVERY ===');
    console.log(JSON.stringify(run.telegram_payload, null, 2).slice(0, 500));
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
