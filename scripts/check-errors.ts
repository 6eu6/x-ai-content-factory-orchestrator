/**
 * check-errors.ts — Check detailed errors from pipeline run
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  const runId = '1d2d6ca2-00b4-4c47-832c-ecc31883468e';
  
  // Cost ledger errors
  const { data: costErrors } = await supabase
    .from('pipeline_cost_ledger')
    .select('task_type, error, request_url, model')
    .eq('run_id', runId)
    .not('error', 'is', null)
    .limit(5);
  
  console.log('=== COST LEDGER ERRORS (sample) ===');
  costErrors?.forEach(r => {
    console.log(`\n${r.task_type} (${r.model}):`);
    console.log(`  Error: ${r.error}`);
    console.log(`  URL: ${r.request_url || 'N/A'}`);
  });
  
  // Merge results - check what opportunities were found
  const { data: mergeTask } = await supabase
    .from('pipeline_tasks')
    .select('result')
    .eq('run_id', runId)
    .eq('task_type', 'merge_scan_results')
    .single();
  
  if (mergeTask?.result) {
    console.log('\n=== MERGE SCAN RESULTS ===');
    const r = mergeTask.result;
    console.log('accounts_scanned:', r.accounts_scanned);
    console.log('tweets_analyzed:', r.tweets_analyzed);
    console.log('viral_found:', r.viral_found);
    console.log('raw_opportunities:', r.raw_opportunities);
    if (r._opportunities) {
      console.log('opportunities count:', r._opportunities.length);
      r._opportunities.forEach((o: any, i: number) => {
        console.log(`\n  Opportunity ${i+1}:`);
        console.log(`    topic: ${o.topic || o.crafted_text?.slice(0, 80) || 'N/A'}`);
        console.log(`    shield_passed: ${o.shield_passed}`);
        console.log(`    source_author: ${o.source_author || o.username || 'N/A'}`);
        console.log(`    crafted_text length: ${o.crafted_text?.length || 0}`);
        console.log(`    niche_fit: ${o.niche_fit_score || 'N/A'}`);
      });
    }
  }
  
  // Decision task result
  const { data: decisionTask } = await supabase
    .from('pipeline_tasks')
    .select('result')
    .eq('run_id', runId)
    .eq('task_type', 'decision')
    .single();
  
  if (decisionTask?.result) {
    console.log('\n=== DECISION TASK RESULT ===');
    console.log(JSON.stringify(decisionTask.result, null, 2).slice(0, 1500));
  }
  
  // Publish gate result
  const { data: gateTask } = await supabase
    .from('pipeline_tasks')
    .select('result')
    .eq('run_id', runId)
    .eq('task_type', 'publish_gate')
    .single();
  
  if (gateTask?.result) {
    console.log('\n=== PUBLISH GATE RESULT ===');
    console.log(JSON.stringify(gateTask.result, null, 2).slice(0, 1000));
  }
  
  // Run result_payload
  const { data: run } = await supabase
    .from('pipeline_runs')
    .select('result_payload')
    .eq('id', runId)
    .single();
  
  if (run?.result_payload) {
    console.log('\n=== RUN RESULT PAYLOAD ===');
    console.log(JSON.stringify(run.result_payload, null, 2).slice(0, 2000));
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
