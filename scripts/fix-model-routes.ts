/**
 * fix-model-routes.ts — Update DB model_routing_rules to use region-available models
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const supabase = supabaseAdmin();
  
  // First, deactivate ALL existing rules
  const { error: deactivateError } = await supabase
    .from('model_routing_rules')
    .update({ active: false })
    .eq('active', true);
  
  if (deactivateError) {
    console.error('Failed to deactivate rules:', deactivateError.message);
    process.exit(1);
  }
  console.log('Deactivated all existing model routing rules');
  
  // Insert correct rules using models that work in this region
  const rules = [
    { task_type: 'content_generation', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.18, max_tokens: 2000, response_format: null, description: 'Daily content generation' },
    { task_type: 'content_crafting', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.20, max_tokens: 2500, response_format: null, description: 'Custom content crafting' },
    { task_type: 'deep_analysis', model_id: 'meta-llama/llama-4-maverick', temperature: 0.12, max_tokens: 4000, response_format: 'json_object', description: 'Deep analysis' },
    { task_type: 'research_synthesis', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.20, max_tokens: 3000, response_format: 'json_object', description: 'Research synthesis' },
    { task_type: 'quality_evaluation', model_id: 'mistralai/mistral-small-3.1-24b-instruct', temperature: 0.05, max_tokens: 1000, response_format: 'json_object', description: 'Quality evaluation' },
    { task_type: 'media_description', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.40, max_tokens: 1500, response_format: null, description: 'Media description' },
    { task_type: 'learning_extraction', model_id: 'meta-llama/llama-4-maverick', temperature: 0.15, max_tokens: 3000, response_format: 'json_object', description: 'Learning extraction' },
    { task_type: 'format_decision', model_id: 'mistralai/mistral-small-3.1-24b-instruct', temperature: 0.10, max_tokens: 800, response_format: 'json_object', description: 'Format decision' },
    { task_type: 'article_writing', model_id: 'meta-llama/llama-4-maverick', temperature: 0.25, max_tokens: 6000, response_format: null, description: 'Article writing' },
    { task_type: 'thread_writing', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.20, max_tokens: 4000, response_format: null, description: 'Thread writing' },
    { task_type: 'performance_analysis', model_id: 'meta-llama/llama-4-maverick', temperature: 0.10, max_tokens: 2000, response_format: 'json_object', description: 'Performance analysis' },
    { task_type: 'shield_check', model_id: 'mistralai/mistral-small-3.1-24b-instruct', temperature: 0.00, max_tokens: 800, response_format: 'json_object', description: 'Shield check' },
    { task_type: 'repo_artifact', model_id: 'meta-llama/llama-4-maverick', temperature: 0.15, max_tokens: 4000, response_format: null, description: 'Repo artifact writing' },
    { task_type: 'casual_generation', model_id: 'mistralai/mistral-small-3.1-24b-instruct', temperature: 0.35, max_tokens: 500, response_format: null, description: 'Quick casual generation' },
    // Phase 2D: Use strongest available models for high-value judgment tasks
    { task_type: 'opportunity_intelligence', model_id: 'meta-llama/llama-4-maverick', temperature: 0.05, max_tokens: 2600, response_format: 'json_object', description: 'Opportunity intelligence' },
    { task_type: 'opportunity_judge', model_id: 'meta-llama/llama-4-maverick', temperature: 0.02, max_tokens: 1200, response_format: 'json_object', description: 'Opportunity judge' },
    { task_type: 'selected_candidate_crafting', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.20, max_tokens: 2000, response_format: 'json_object', description: 'Candidate crafting' },
    { task_type: 'near_pass_polish', model_id: 'deepseek/deepseek-chat-v3-0324', temperature: 0.15, max_tokens: 900, response_format: 'json_object', description: 'Near-pass polish' },
  ];
  
  // Upsert each rule
  for (const rule of rules) {
    const { error } = await supabase
      .from('model_routing_rules')
      .upsert({
        ...rule,
        active: true,
        provider: 'cloud',
        top_p: null,
      }, { onConflict: 'task_type' });
    
    if (error) {
      console.error(`  Failed to upsert ${rule.task_type}:`, error.message);
    } else {
      console.log(`  ✅ ${rule.task_type} → ${rule.model_id}`);
    }
  }
  
  console.log('\nAll model routing rules updated successfully!');
  
  // Verify
  const { data: activeRules } = await supabase
    .from('model_routing_rules')
    .select('task_type, model_id, active')
    .eq('active', true)
    .order('task_type');
  
  console.log(`\nActive rules (${activeRules?.length}):`);
  activeRules?.forEach(r => console.log(`  ${r.task_type} → ${r.model_id}`));
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
