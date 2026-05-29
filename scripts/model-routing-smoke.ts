/**
 * Model Routing Smoke Test — Phase 2D.1
 *
 * Tests one task/model route with a tiny JSON prompt.
 * Verifies that the model is reachable through OpenRouter and returns valid JSON.
 *
 * Usage:
 *   npx tsx scripts/model-routing-smoke.ts [task_type]
 *
 * Examples:
 *   npx tsx scripts/model-routing-smoke.ts opportunity_intelligence
 *   npx tsx scripts/model-routing-smoke.ts opportunity_judge
 *   npx tsx scripts/model-routing-smoke.ts selected_candidate_crafting
 *   npx tsx scripts/model-routing-smoke.ts quality_evaluation
 *
 * This script is NOT part of the pipeline. It is a manual verification tool.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.worker') });
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { callModel, parseModelJson, getModelForTask, getDefaultRouting, type TaskType } from '../lib/model-router';

const VALID_TASK_TYPES = [
  'opportunity_intelligence',
  'opportunity_judge',
  'selected_candidate_crafting',
  'quality_evaluation',
  'content_generation',
  'content_crafting',
  'shield_check',
  'deep_analysis',
  'learning_extraction',
];

async function main() {
  const taskType = (process.argv[2] || 'opportunity_intelligence') as TaskType;

  if (!VALID_TASK_TYPES.includes(taskType)) {
    console.error(`Invalid task type: ${taskType}`);
    console.error(`Valid types: ${VALID_TASK_TYPES.join(', ')}`);
    process.exit(1);
  }

  console.log(`\n═══ Model Routing Smoke Test ═══`);
  console.log(`Task type: ${taskType}`);

  // Show the resolved model config
  const modelConfig = await getModelForTask(taskType);
  console.log(`Model: ${modelConfig.model}`);
  console.log(`Temperature: ${modelConfig.temperature}`);
  console.log(`Max tokens: ${modelConfig.max_tokens}`);
  console.log(`Response format: ${JSON.stringify(modelConfig.response_format)}`);
  console.log(`Provider: ${modelConfig.provider || 'cloud'}`);

  // Also show code default for comparison
  const defaults = getDefaultRouting();
  const defaultConfig = defaults[taskType];
  if (defaultConfig) {
    const isOverride = defaultConfig.model !== modelConfig.model;
    console.log(`Code default model: ${defaultConfig.model}${isOverride ? ' (DB override active)' : ' (using code default)'}`);
  }

  console.log(`\nMaking test call...`);

  try {
    const response = await callModel(taskType, [
      {
        role: 'system',
        content: 'Return a simple JSON object with "ok" set to true and "score" set to 8.',
      },
      {
        role: 'user',
        content: 'Respond with the JSON now.',
      },
    ], {
      temperature: 0.0,
      max_tokens: 100,
      response_format: { type: 'json_object' },
    });

    console.log(`\n═══ Result ═══`);
    console.log(`Raw response: ${response.slice(0, 500)}`);

    try {
      const parsed = parseModelJson(response);
      console.log(`Parsed JSON: ${JSON.stringify(parsed, null, 2)}`);
      console.log(`\n✅ SUCCESS — Model route is working`);
    } catch (parseErr: any) {
      console.error(`Parse error: ${parseErr?.message}`);
      console.log(`\n⚠️  PARTIAL — Model responded but JSON parsing failed`);
    }
  } catch (err: any) {
    console.error(`\n❌ FAILURE — Model call failed: ${err?.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});
