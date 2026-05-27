import OpenAI from 'openai';
import { requiredEnv, optionalEnv } from './env';
import { supabaseAdmin } from './supabase';
import { withRetry, isTransientError } from './retry';

/**
 * Model Router — يوجه كل مهمة للنموذج المناسب عبر OpenRouter
 *
 * كل endpoint في المشروع يستدعي getModelForTask(taskType) بدل
 * إنه يسوي new OpenAI() بنفسه بنموذج واحد.
 *
 * جدول model_routing_rules في Supabase يخزن:
 *   task_type → model_id + temperature + max_tokens + priority
 *
 * لو ما في قاعدة في القاعدة بيانات، يستخدم الإعدادات الافتراضية.
 */

export type TaskType =
  | 'content_generation'      // توليد محتوى يومي (tweets, replies, quotes)
  | 'content_crafting'        // تصنيع محتوى مخصص (quotes, replies, threads)
  | 'deep_analysis'           // تحليل عميق (repo analysis, algorithm extraction)
  | 'research_synthesis'      // تركيب بحثي (research-intel, trend analysis)
  | 'quality_evaluation'      // تقييم جودة (quality gate, slop detection)
  | 'media_description'       // وصف وسائط (image prompt, video script)
  | 'learning_extraction'     // استخراج تعليمي (pattern extraction, rule mining)
  | 'format_decision'         // قرار صيغة (which content type to produce)
  | 'article_writing'         // كتابة مقالات (X Articles, long-form)
  | 'thread_writing'          // كتابة ثريد (5-15 tweet threads)
  | 'performance_analysis'    // تحليل أداء (engagement feedback, learning from results)
  | 'shield_check'            // فحص حماية (slop detection, claim verification)
  | 'repo_artifact'           // كتابة ملفات مستودع (README, code, docs)
  | 'casual_generation';      // توليد سريع خفيف (short replies, quick takes)

export type ModelProvider = 'cloud' | 'local';

export type ModelConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  top_p?: number;
  response_format?: { type: 'json_object' | 'text' };
  description?: string;
  /**
   * 'cloud' (افتراضي) = OpenRouter/OpenAI عبر OPENAI_BASE_URL.
   * 'local' = نموذج محلي (Ollama/llama.cpp/vLLM) عبر LOCAL_AI_BASE_URL.
   * لتحويل مهمة للنموذج المحلي على Pi: اضبط provider='local' في
   * جدول model_routing_rules — بلا أي تعديل في الكود.
   */
  provider?: ModelProvider;
};

/**
 * النماذج المتاحة على OpenRouter (محظور openai/* و anthropic/* في منطقتنا)
 * llama-4-maverick: أقوى نموذج مفتوح (400B MoE) — للتحليل العميق والتعلم
 * deepseek-chat-v3: توازن جيد بين القوة والسرعة — لتوليد المحتوى
 * mistral-small-3.1: سريع ورخيص — للمهام البسيطة
 */
const DEFAULT_ROUTING: Record<TaskType, ModelConfig> = {
  content_generation: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.18,
    max_tokens: 2000,
    description: 'توليد محتوى يومي — يحتاج دقة واتباع قواعد صارمة'
  },
  content_crafting: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 2500,
    description: 'تصنيع محتوى مخصص — اقتباسات، ردود، ثريدات'
  },
  deep_analysis: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.12,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    description: 'تحليل عميق — يحتاج نموذج قوي يفهم التعقيدات'
  },
  research_synthesis: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    description: 'تركيب بحثي — يجمع معلومات من مصادر متعددة'
  },
  quality_evaluation: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.05,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    description: 'تقييم جودة — يحتاج دقة عالية بدون إبداع'
  },
  media_description: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.4,
    max_tokens: 1500,
    description: 'وصف وسائط — يحتاج إبداع بصري + دقة تقنية'
  },
  learning_extraction: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.15,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    description: 'استخراج تعليمي — يحتاج فهم عميق + استنتاج'
  },
  format_decision: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.1,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    description: 'قرار صيغة — يحتاج منطق + تقييم أبعاد'
  },
  article_writing: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.25,
    max_tokens: 6000,
    description: 'كتابة مقالات — محتوى طويل يحتاج عمق + تنوع'
  },
  thread_writing: {
    model: 'deepseek/deepseek-chat-v3-0324',
    temperature: 0.2,
    max_tokens: 4000,
    description: 'كتابة ثريد — يحتاج تنوع + ارتباط منطقي'
  },
  performance_analysis: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.1,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    description: 'تحليل أداء — يحتاج استنتاج من بيانات + تعلم'
  },
  shield_check: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    description: 'فحص حماية — يحتاج دقة صارمة بدون إبداع'
  },
  repo_artifact: {
    model: 'meta-llama/llama-4-maverick',
    temperature: 0.15,
    max_tokens: 4000,
    description: 'كتابة ملفات مستودع — يحتاج دقة تقنية + أسلوب بشري'
  },
  casual_generation: {
    model: 'mistralai/mistral-small-3.1-24b-instruct',
    temperature: 0.35,
    max_tokens: 500,
    description: 'توليد سريع — ردود قصيرة + آراء سريعة'
  }
};

let routingCache: Record<string, ModelConfig> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق

function isOpenRouter(): boolean {
  const baseURL = optionalEnv('OPENAI_BASE_URL', '');
  return baseURL.includes('openrouter.ai');
}

function buildClient(config?: ModelConfig): OpenAI {
  // نموذج محلي (Raspberry Pi / Ollama / llama.cpp / vLLM) — endpoint متوافق مع OpenAI
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

// أسماء نماذج غير صالحة — تسبب خطأ 400 من OpenRouter
const INVALID_MODELS = new Set([
  'openai/gpt-4.1-mini',       // ← غير موجود! الصحيح: openai/gpt-4o-mini
  'openai/gpt-4.1',            // ← غير موجود!
  'anthropic/claude-sonnet-4',  // ← غير موجود! الصحيح: anthropic/claude-sonnet-4-20250514
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
      // ═══ تجاهل القواعد اللي فيها أسماء نماذج غير صالحة ═══
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
 * يرجع إعدادات النموذج المناسب لنوع المهمة
 * أولاً يفحص Supabase، لو ما في قاعدة يستخدم الافتراضي
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
 * يرجع عميل OpenAI جاهز مع النموذج المناسب
 * يستبدل كل `new OpenAI()` المتناثرة في المشروع
 */
export async function getAIClientForTask(taskType: TaskType): Promise<{ client: OpenAI; config: ModelConfig }> {
  const config = await getModelForTask(taskType);
  const client = buildClient(config);
  return { client, config };
}

/**
 * استدعاء نموذج مبسط — يختار النموذج تلقائياً حسب نوع المهمة
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
 * يرجع كل الإعدادات الافتراضية (للفحص والإدارة)
 */
export function getDefaultRouting(): Record<TaskType, ModelConfig> {
  return { ...DEFAULT_ROUTING };
}

/**
 * يمسح الكاش (بعد تحديث القواعد)
 */
export function clearRoutingCache(): void {
  routingCache = null;
  cacheExpiry = 0;
}

/**
 * parseModelJson — يحلل رد النموذج الذكي بأمان
 *
 * المشكلة: بعض النماذج (خاصة عبر OpenRouter) ترجع JSON ملفوف بـ markdown code blocks:
 *   ```json
 *   {"key": "value"}
 *   ```
 *
 * JSON.parse() العادية تفشل مع هذا التنسيق.
 *
 * هذه الدالة:
 * 1. تنزع أغلفة markdown code blocks (```json ... ```)
 * 2. تنزع أي نص قبل أو بعد الـ JSON
 * 3. تحلل الـ JSON بأمان
 */
export function parseModelJson(text: string): any {
  if (!text || typeof text !== 'string') return {};

  let cleaned = text.trim();

  // خطوة 1: نزع أغلفة markdown code blocks
  // يتعامل مع: ```json\n{...}\n``` أو ```\n{...}\n```
  const codeBlockMatch = cleaned.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // خطوة 2: نزع أي نص قبل أول { أو [
  const jsonStart = Math.min(
    ...[cleaned.indexOf('{'), cleaned.indexOf('[')].filter(i => i !== -1)
  );
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }

  // خطوة 3: نزع أي نص بعد آخر } أو ]
  const jsonEnd = Math.max(
    ...[cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']')].filter(i => i !== -1)
  );
  if (jsonEnd !== -1 && jsonEnd < cleaned.length - 1) {
    cleaned = cleaned.slice(0, jsonEnd + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // خطوة أخيرة: محاولة استخراج أي JSON صالح
    try {
      // جرّب العثور على أول كائن JSON صالح
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
