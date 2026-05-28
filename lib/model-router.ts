import OpenAI from 'openai';
import { requiredEnv, optionalEnv } from './env';
import { supabaseAdmin } from './supabase';
import { withRetry, isTransientError } from './retry';

/**
 * Model Router — Routes each task to the appropriate model via OpenRouter
 *
 * Each endpoint in the project calls getModelForTask(taskType) instead of
 * creating new OpenAI() instances with a single model.
 *
 * The model_routing_rules table in Supabase stores:
 *   task_type → model_id + temperature + max_tokens + priority
 *
 * If no rule exists in the database, defaults are used.
 */

export type TaskType =
  | 'content_generation'      // Daily content generation (tweets, replies, quotes)
  | 'content_crafting'        // Custom content crafting (quotes, replies, threads)
  | 'deep_analysis'           // Deep analysis (repo analysis, algorithm extraction)
  | 'research_synthesis'      // Research synthesis (research-intel, trend analysis)
  | 'quality_evaluation'      // Quality evaluation (quality gate, slop detection)
  | 'media_description'       // Media description (image prompt, video script)
  | 'learning_extraction'     // Learning extraction (pattern extraction, rule mining)
  | 'format_decision'         // Format decision (which content type to produce)
  | 'article_writing'         // Article writing (X Articles, long-form)
  | 'thread_writing'          // Thread writing (5-15 tweet threads)
  | 'performance_analysis'    // Performance analysis (engagement feedback, learning from results)
  | 'shield_check'            // Shield check (slop detection, claim verification)
  | 'repo_artifact'           // Repo artifact writing (README, code, docs)
  | 'casual_generation';      // Quick casual generation (short replies, quick takes)

export type ModelProvider = 'cloud' | 'local';

export type ModelConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  top_p?: number;
  response_format?: { type: 'json_object' | 'text' };
  description?: string;
  /**
   * 'cloud' (default) = OpenRouter/OpenAI via OPENAI_BASE_URL.
   * 'local' = Local model (Ollama/llama.cpp/vLLM) via LOCAL_AI_BASE_URL.
   * To route a task to the local model on Pi: set provider='local' in
   * model_routing_rules — no code changes needed.
   */
  provider?: ModelProvider;
};

/**
 * Available models on OpenRouter (openai/* and anthropic/* are not available in our region)
 * llama-4-maverick: Most powerful open model (400B MoE) — for deep analysis and learning
 * deepseek-chat-v3: Good balance of power and speed — for content generation
 * mistral-small-3.1: Fast and cheap — for simple tasks
 */
const DEFAULT_ROUTING: Record<TaskType, ModelConfig> = {
  content_generation: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.18,
    max_tokens: 2000,
    description: 'Daily content generation — needs precision and strict rule adherence'
  },
  content_crafting: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 2500,
    description: 'Custom content crafting — quotes, replies, threads'
  },
  deep_analysis: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.12,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    description: 'Deep analysis — needs a powerful model that understands complexity'
  },
  research_synthesis: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    description: 'Research synthesis — combines information from multiple sources'
  },
  quality_evaluation: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.05,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    description: 'Quality evaluation — needs high precision without creativity'
  },
  media_description: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.4,
    max_tokens: 1500,
    description: 'Media description — needs visual creativity + technical accuracy'
  },
  learning_extraction: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.15,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    description: 'Learning extraction — needs deep understanding + inference'
  },
  format_decision: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.1,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    description: 'Format decision — needs logic + dimension scoring'
  },
  article_writing: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.25,
    max_tokens: 6000,
    description: 'Article writing — long content needs depth + variety'
  },
  thread_writing: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 4000,
    description: 'Thread writing — needs variety + logical flow'
  },
  performance_analysis: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.1,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    description: 'Performance analysis — needs inference from data + learning'
  },
  shield_check: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    description: 'Shield check — needs strict precision without creativity'
  },
  repo_artifact: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.15,
    max_tokens: 4000,
    description: 'Repo artifact writing — needs technical precision + human-like style'
  },
  casual_generation: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.35,
    max_tokens: 500,
    description: 'Quick generation — short replies + quick takes'
  }
};

let routingCache: Record<string, ModelConfig> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isOpenRouter(): boolean {
  const baseURL = optionalEnv('OPENAI_BASE_URL', '');
  return baseURL.includes('openrouter.ai');
}

function buildClient(config?: ModelConfig): OpenAI {
  // Local model (Raspberry Pi / Ollama / llama.cpp / vLLM) — OpenAI-compatible endpoint
  if (config?.provider === 'local') {
    return new OpenAI({
      apiKey: optionalEnv('LOCAL_AI_API_KEY', 'ollama'),
      baseURL: optionalEnv('LOCAL_AI_BASE_URL', 'http://localhost:11434/v1')
    });
  }

  const baseURL = optionalEnv('OPENAI_BASE_URL') || undefined;
  const headers: Record<string, string> = {};
  if (baseURL && baseURL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = optionalEnv('OPENROUTER_REFERER', 'https://x.com/30piq');
    headers['X-OpenRouter-Title'] = optionalEnv('OPENROUTER_TITLE', 'X AI Content Factory');
  }
  return new OpenAI({
    apiKey: requiredEnv('OPENAI_API_KEY'),
    baseURL,
    defaultHeaders: Object.keys(headers).length ? headers : undefined
  });
}

// Invalid model names — cause 400 error from OpenRouter
const INVALID_MODELS = new Set([
  'openai/gpt-4.1-mini',       // Does not exist! Correct: openai/gpt-4o-mini
  'openai/gpt-4.1',            // Does not exist!
  'anthropic/claude-sonnet-4',  // Does not exist! Correct: anthropic/claude-sonnet-4-20250514
]);

async function loadRoutingRules(): Promise<Record<string, ModelConfig>> {
  const now = Date.now();
  if (routingCache && now < cacheExpiry) return routingCache;

  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('model_routing_rules')
      .select('*')
      .eq('active', true);

    if (error || !data?.length) {
      routingCache = {};
      cacheExpiry = now + CACHE_TTL_MS;
      return routingCache;
    }

    const rules: Record<string, ModelConfig> = {};
    for (const row of data) {
      // Skip DB rules with invalid model names
      if (INVALID_MODELS.has(row.model_id)) {
        console.warn(`[model-router] Skipping DB rule '${row.task_type}' with invalid model '${row.model_id}' — using code defaults instead`);
        continue;
      }
      rules[row.task_type] = {
        model: row.model_id,
        temperature: row.temperature ?? 0.18,
        max_tokens: row.max_tokens ?? 2000,
        top_p: row.top_p ?? undefined,
        response_format: row.response_format === 'json_object' ? { type: 'json_object' } : undefined,
        description: row.description ?? undefined,
        provider: row.provider === 'local' ? 'local' : undefined
      };
    }

    routingCache = rules;
    cacheExpiry = now + CACHE_TTL_MS;
    return rules;
  } catch {
    routingCache = {};
    cacheExpiry = now + CACHE_TTL_MS;
    return routingCache;
  }
}

/**
 * Returns the appropriate model config for a task type
 * First checks Supabase, falls back to code defaults
 */
export async function getModelForTask(taskType: TaskType): Promise<ModelConfig> {
  const rules = await loadRoutingRules();
  if (rules[taskType]) return rules[taskType];
  const defaults = DEFAULT_ROUTING[taskType] || DEFAULT_ROUTING.content_generation;
  if (!isOpenRouter()) {
    return {
      ...defaults,
      model: defaults.model.replace(/^(openai|anthropic|google)\//, '')
    };
  }
  return defaults;
}

/**
 * Returns a ready OpenAI client with the appropriate model
 * Replaces all scattered new OpenAI() instances in the project
 */
export async function getAIClientForTask(taskType: TaskType): Promise<{ client: OpenAI; config: ModelConfig }> {
  const config = await getModelForTask(taskType);
  const client = buildClient(config);
  return { client, config };
}

/**
 * Simplified model call — automatically selects model by task type
 */
export async function callModel(
  taskType: TaskType,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  overrides?: Partial<ModelConfig>
): Promise<string> {
  const { client, config } = await getAIClientForTask(taskType);
  const merged = { ...config, ...overrides };

  const response = await withRetry(
    () => client.chat.completions.create({
      model: merged.model,
      temperature: merged.temperature,
      max_tokens: merged.max_tokens,
      top_p: merged.top_p,
      response_format: merged.response_format as any,
      messages
    }),
    { attempts: 3, baseDelayMs: 1200, label: `callModel:${taskType}:${merged.model}`, shouldRetry: isTransientError }
  );

  return response.choices[0]?.message?.content || '';
}

/**
 * Returns all default routing (for inspection and management)
 */
export function getDefaultRouting(): Record<TaskType, ModelConfig> {
  return { ...DEFAULT_ROUTING };
}

/**
 * Clears the routing cache (after rule updates)
 */
export function clearRoutingCache(): void {
  routingCache = null;
  cacheExpiry = 0;
}

/**
 * parseModelJson — Safely parses AI model response
 *
 * Problem: Some models (especially via OpenRouter) return JSON wrapped in markdown code blocks:
 *   ```json
 *   {"key": "value"}
 *   ```
 *
 * Standard JSON.parse() fails with this format.
 *
 * This function:
 * 1. Strips markdown code block wrappers (```json ... ```)
 * 2. Strips any text before or after the JSON
 * 3. Parses the JSON safely
 */
export function parseModelJson(text: string): any {
  if (!text || typeof text !== 'string') return {};

  let cleaned = text.trim();

  // Step 1: Strip markdown code block wrappers
  // Handles: ```json\n{...}\n``` or ```\n{...}\n```
  const codeBlockMatch = cleaned.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Step 2: Strip any text before first { or [
  const jsonStart = Math.min(
    ...[cleaned.indexOf('{'), cleaned.indexOf('[')].filter(i => i !== -1)
  );
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }

  // Step 3: Strip any text after last } or ]
  const jsonEnd = Math.max(
    ...[cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']')].filter(i => i !== -1)
  );
  if (jsonEnd !== -1 && jsonEnd < cleaned.length - 1) {
    cleaned = cleaned.slice(0, jsonEnd + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Final attempt: try to extract any valid JSON
    try {
      // Try to find the first valid JSON object
      const deepMatch = cleaned.match(/\{[\s\S]*\}/);
      if (deepMatch) {
        return JSON.parse(deepMatch[0]);
      }
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        return JSON.parse(arrMatch[0]);
      }
    } catch {}
    throw firstErr;
  }
}
