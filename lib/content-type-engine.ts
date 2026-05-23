import { callModel, TaskType } from './model-router';
import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';

/**
 * Content Type Engine — محرك تنوع أنواع المحتوى
 *
 * بدل ما daily-run ينتج 3 single tweets فقط، هذا المحرك:
 * 1. يقيّم الموضوع بـ 5 أبعاد (Depth, Freshness, Visual, Technical, Uniqueness)
 * 2. يفحص التنوع — أي أنواع أنتجنا آخر 48 ساعة؟
 * 3. يقرر النوع الأنسب حسب Decision Tree
 * 4. يولّد المحتوى بالنوع المحدد مع نموذج مناسب
 */

export type ContentType =
  | 'single_tweet'
  | 'thread'
  | 'article'
  | 'carousel'
  | 'video_script'
  | 'quote_post'
  | 'reply';

export type ContentScore = {
  topic: string;
  depth: number;       // 1-10: كم ممكن نتكلم عن الموضوع؟
  freshness: number;   // 1-10: كم الموضوع جديد/عاجل؟
  visual: number;      // 1-10: ممكن نعرضه بصرياً؟
  technical: number;   // 1-10: يحتاج كود/شرح تقني؟
  uniqueness: number;  // 1-10: أحد غطاه قبلنا؟
  total: number;
  recommended_type: ContentType;
  reasoning: string;
};

export type DailyContentPlan = {
  items: DailyContentItem[];
  variety_check: {
    types_used: ContentType[];
    types_missing: ContentType[];
    recommendation: string;
  };
};

export type DailyContentItem = {
  slot: number;
  content_type: ContentType;
  topic: string;
  score: ContentScore;
  model_task: string;
  priority: 'high' | 'medium' | 'low';
};

/**
 * يسجّل أي نوع أنتجنا آخر 48 ساعة ويقترح التنوع
 */
async function getRecentContentTypes(): Promise<ContentType[]> {
  try {
    const supabase = supabaseAdmin();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('content_log')
      .select('content_type')
      .gte('published_at', twoDaysAgo)
      .neq('publish_status', 'rejected');
    
    return (data || []).map((r: any) => {
      const t = String(r.content_type || '').toLowerCase();
      if (t.includes('thread')) return 'thread';
      if (t.includes('article')) return 'article';
      if (t.includes('carousel')) return 'carousel';
      if (t.includes('video')) return 'video_script';
      if (t.includes('quote')) return 'quote_post';
      if (t.includes('reply')) return 'reply';
      return 'single_tweet';
    });
  } catch {
    return [];
  }
}

/**
 * يقيّم موضوع بـ 5 أبعاد ويقرر النوع الأنسب
 */
async function scoreTopic(topic: string, sourceInfo?: string): Promise<ContentScore> {
  try {
    const response = await callModel('format_decision', [
      {
        role: 'system',
        content: 'You are a content strategy expert for an X/Twitter account about AI x Productivity x Career Growth. Score topics on 5 dimensions and recommend the best content format. Output valid JSON only.'
      },
      {
        role: 'user',
        content: `Score this topic on 5 dimensions (1-10 each):

Topic: "${topic}"
${sourceInfo ? `Source info: ${sourceInfo}` : ''}

Dimensions:
- DEPTH: How much can you say about this? (1-3=quick fact, 4-6=needs explanation, 7-10=deep system)
- FRESHNESS: How new/time-sensitive? (1-3=evergreen, 4-6=weekly topic, 7-10=breaking now)
- VISUAL: Can it be shown visually? (1-3=abstract, 4-6=can screenshot, 7-10=visual demo)
- TECHNICAL: Does it need code/technical explanation? (1-3=no code, 4-6=some code, 7-10=deep technical)
- UNIQUENESS: Are others already covering this? (1-3=everyone's talking, 4-6=some coverage, 7-10=nobody covered yet)

Then recommend the BEST content type based on the scoring matrix:
- Deep(8+) + Technical(7+) + Unique(6+) → "thread" with repo link
- Deep(7+) + Fresh(≤4, evergreen) → "article" (X Article long-form)
- Deep(6+) + Technical(5+) → "thread" (5-15 tweets)
- Fresh(8+) + Visual(5+) → "video_script" (15-60s)
- Visual(7+) + Depth(3-6) → "carousel" (4-8 images)
- Fresh(7+) + Depth(≤4) → "single_tweet" with image
- Depth(≤3) + Fresh(≤3) + Unique(≤3) → SKIP

Return JSON:
{
  "depth": N,
  "freshness": N,
  "visual": N,
  "technical": N,
  "uniqueness": N,
  "total": N,
  "recommended_type": "single_tweet|thread|article|carousel|video_script",
  "reasoning": "why this type works best"
}`
      }
    ]);

    const parsed = JSON.parse(response);
    return {
      topic,
      depth: parsed.depth || 5,
      freshness: parsed.freshness || 5,
      visual: parsed.visual || 5,
      technical: parsed.technical || 5,
      uniqueness: parsed.uniqueness || 5,
      total: (parsed.depth || 5) + (parsed.freshness || 5) + (parsed.visual || 5) + (parsed.technical || 5) + (parsed.uniqueness || 5),
      recommended_type: parseContentType(parsed.recommended_type),
      reasoning: parsed.reasoning || ''
    };
  } catch {
    return {
      topic,
      depth: 5, freshness: 5, visual: 5, technical: 5, uniqueness: 5,
      total: 25,
      recommended_type: 'single_tweet',
      reasoning: 'Fallback: could not score topic'
    };
  }
}

function parseContentType(raw: string): ContentType {
  const t = String(raw || '').toLowerCase();
  if (t.includes('thread')) return 'thread';
  if (t.includes('article')) return 'article';
  if (t.includes('carousel')) return 'carousel';
  if (t.includes('video')) return 'video_script';
  if (t.includes('quote')) return 'quote_post';
  if (t.includes('reply')) return 'reply';
  return 'single_tweet';
}

/**
 * يخطط محتوى اليوم — 4-6 أنواع متنوعة
 */
export async function planDailyContent(
  topics: Array<{ topic: string; source?: string; heat_score?: number }>
): Promise<DailyContentPlan> {
  const recentTypes = await getRecentContentTypes();
  const typeCounts: Record<string, number> = {};
  for (const t of recentTypes) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  // قيم كل موضوع
  const scored: ContentScore[] = [];
  for (const item of topics.slice(0, 8)) {
    const score = await scoreTopic(item.topic, item.source);
    scored.push(score);
  }

  // رتب حسب total score
  scored.sort((a, b) => b.total - a.total);

  // اختر أنواع متنوعة — أولوية: فيديو > ثريد > كاروسيل > تغريدة
  const desiredTypes: ContentType[] = ['video_script', 'thread', 'carousel', 'single_tweet', 'article'];
  const plannedItems: DailyContentItem[] = [];
  const typesPlanned: ContentType[] = [];

  for (const score of scored) {
    if (plannedItems.length >= 5) break;
    if (score.total < 15) continue; // موضوع ضعيف

    // لو النوع الموصى موجود كثير آخر 48 ساعة، جرب نوع ثاني
    let chosenType = score.recommended_type;
    if ((typeCounts[chosenType] || 0) >= 2) {
      // جرب نوع بديل
      for (const alt of desiredTypes) {
        if ((typeCounts[alt] || 0) < 2 && !typesPlanned.includes(alt)) {
          chosenType = alt;
          break;
        }
      }
    }

    // تحقق من قواعد الحساب الصغير — لا روابط خارجية
    const followerCount = await getFollowerCount();
    if (followerCount < 500) {
      // لا مقالات مع روابط خارجية، أفضل كاروسيل وتغريدات
      if (chosenType === 'article') chosenType = 'thread';
    }

    plannedItems.push({
      slot: plannedItems.length + 1,
      content_type: chosenType,
      topic: score.topic,
      score,
      model_task: getModelTaskForType(chosenType),
      priority: score.total >= 35 ? 'high' : score.total >= 25 ? 'medium' : 'low'
    });

    typesPlanned.push(chosenType);
    typeCounts[chosenType] = (typeCounts[chosenType] || 0) + 1;
  }

  // أضف رد + اقتباس دائماً
  if (!typesPlanned.includes('reply')) {
    plannedItems.push({
      slot: plannedItems.length + 1,
      content_type: 'reply',
      topic: 'Smart reply to Tier 1 account',
      score: { topic: 'reply', depth: 3, freshness: 7, visual: 2, technical: 4, uniqueness: 6, total: 22, recommended_type: 'reply', reasoning: 'Daily reply engagement' },
      model_task: 'casual_generation',
      priority: 'high'
    });
  }

  if (!typesPlanned.includes('quote_post')) {
    plannedItems.push({
      slot: plannedItems.length + 1,
      content_type: 'quote_post',
      topic: 'Quote with original insight',
      score: { topic: 'quote_post', depth: 4, freshness: 6, visual: 2, technical: 3, uniqueness: 5, total: 20, recommended_type: 'quote_post', reasoning: 'Daily quote engagement' },
      model_task: 'casual_generation',
      priority: 'medium'
    });
  }

  const allTypes: ContentType[] = ['single_tweet', 'thread', 'article', 'carousel', 'video_script', 'reply', 'quote_post'];
  const typesMissing = allTypes.filter(t => !typesPlanned.includes(t) && !recentTypes.includes(t));

  return {
    items: plannedItems,
    variety_check: {
      types_used: typesPlanned,
      types_missing: typesMissing,
      recommendation: typesMissing.length > 3
        ? `Missing content types: ${typesMissing.join(', ')}. Consider producing these soon for algorithm diversity.`
        : 'Good variety this cycle.'
    }
  };
}

function getModelTaskForType(type: ContentType): TaskType {
  switch (type) {
    case 'article': return 'article_writing';
    case 'thread': return 'thread_writing';
    case 'video_script': return 'media_description';
    case 'carousel': return 'media_description';
    case 'reply': return 'casual_generation';
    case 'quote_post': return 'casual_generation';
    default: return 'content_generation';
  }
}

async function getFollowerCount(): Promise<number> {
  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('account_state')
      .select('followers_count')
      .eq('account_handle', optionalEnv('X_USERNAME', '30piq'))
      .maybeSingle();
    return data?.followers_count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * يولّد محتوى حسب النوع المحدد باستخدام النموذج المناسب
 */
export async function generateContentByType(
  type: ContentType,
  context: {
    topic: string;
    score?: ContentScore;
    accountState?: any;
    learningMemory?: any;
    viralMemory?: any;
    sources?: string[];
  }
): Promise<any> {
  const taskType = getModelTaskForType(type);
  
  switch (type) {
    case 'single_tweet':
      return generateSingleTweet(context, taskType);
    case 'thread':
      return generateThread(context, taskType);
    case 'article':
      return generateArticle(context, taskType);
    case 'carousel':
      return generateCarousel(context, taskType);
    case 'video_script':
      return generateVideoScript(context, taskType);
    case 'reply':
      return generateReply(context, taskType);
    case 'quote_post':
      return generateQuotePost(context, taskType);
    default:
      return generateSingleTweet(context, taskType);
  }
}

async function generateSingleTweet(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write a single tweet for @${optionalEnv('X_USERNAME', '30piq')} about AI x Productivity x Career Growth.
Rules: Under 240 chars. No hashtags. No first-person claims unless true. No Slop words (Delve, Crucial, Leverage, etc). 
Include: why_it_works, originality_element, reply_trigger, bookmark_trigger, mechanic_used.
Vary sentence length. Sound like a smart friend in tech. Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}
${ctx.learningMemory ? `Learning context: ${JSON.stringify(ctx.learningMemory.algorithm_rules?.slice(0, 5))}` : ''}
${ctx.viralMemory ? `Viral mechanics: ${JSON.stringify(ctx.viralMemory.high_confidence_patterns?.slice(0, 3))}` : ''}
Return: {"text":"...","why_it_works":"...","originality_element":"...","reply_trigger":"...","bookmark_trigger":"...","mechanic_used":"...","best_time_utc":"..."}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { text: response, why_it_works: '', originality_element: '' }; }
}

async function generateThread(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write a 5-8 tweet thread for @${optionalEnv('X_USERNAME', '30piq')} about AI x Productivity x Career Growth.

CRITICAL RULES (Anti-Slop):
- NEVER start with "Thread" or "A thread on X" or "Let me show you"
- Start with a PERSONAL framing: "I spent [time] reading [X]..." or "Found something nobody's talking about..."
- VARY tweet lengths: some 2 lines, some full 280 chars
- Include at least 1 specific reference (tool name, file path, function name, number)
- Add a personal reaction: "this surprised me", "honestly didn't expect this"
- Break the flow: add a parenthetical aside or question to reader
- End with YOUR original insight, not just a summary
- Each tweet under 280 chars. No hashtags. No Slop words.

Output valid JSON array of tweets.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}
${ctx.learningMemory ? `Algorithm rules: ${JSON.stringify(ctx.learningMemory.algorithm_rules?.slice(0, 5))}` : ''}
${ctx.sources?.length ? `Sources: ${ctx.sources.join(', ')}` : ''}

Return JSON:
{
  "hook": "first tweet text",
  "tweets": [{"text":"...","why_important":"..."}],
  "conclusion": "final insight tweet",
  "why_it_works": "...",
  "originality_element": "...",
  "reply_trigger": "...",
  "bookmark_trigger": "..."
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { hook: response, tweets: [] }; }
}

async function generateArticle(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write an X Article outline for @${optionalEnv('X_USERNAME', '30piq')} about AI x Productivity x Career Growth.

Rules:
- Headline: Specific number/claim + what they'll learn (NOT generic)
- Include: hook, fact-check, why this matters, step-by-step, reality check, disclaimer
- Mix long paragraphs with short punchy ones
- Add honest caveats
- No Slop words. Sound like you DISCOVERED this, not teaching from above.
- Include cost/pricing table suggestion somewhere (bookmarkable)

Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}
${ctx.learningMemory ? `MCP opportunities: ${JSON.stringify(ctx.learningMemory.mcp_opportunities?.slice(0, 3))}` : ''}

Return JSON:
{
  "headline": "...",
  "subheadline": "...",
  "sections": [{"title":"...","key_points":["..."],"estimated_words":N}],
  "bookmark_trigger": "...",
  "why_it_works": "...",
  "originality_element": "..."
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { headline: response }; }
}

async function generateCarousel(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Design a 4-6 slide carousel for @${optionalEnv('X_USERNAME', '30piq')} about AI x Productivity x Career Growth.

Rules:
- Slide 1 = HOOK (catch attention, don't reveal everything)
- Each slide = ONE idea only
- Include visual description for each slide (for AI image generation)
- Last slide = CTA or key takeaway
- No Slop words. Casual expert tone.

Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}

Return JSON:
{
  "slides": [{"slide_number":1,"text":"...","visual_description":"...","layout_hint":"..."}],
  "hook_slide": "...",
  "cta_slide": "...",
  "why_it_works": "...",
  "originality_element": "...",
  "image_generation_prompts": ["prompt for slide 1", "prompt for slide 2", ...]
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { slides: [] }; }
}

async function generateVideoScript(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write a 15-60 second video script for @${optionalEnv('X_USERNAME', '30piq')} about AI x Productivity x Career Growth.

CRITICAL ALGORITHM RULES:
- Video MUST be 15+ seconds (shorter = ZERO VQV algorithm boost)
- Speech is MANDATORY — ASR extracts audio for embedding. No speech = "a person talking" embedding = NO topic match
- Front-load KEYWORDS verbally in FIRST 3 seconds
- Always add descriptive text alongside video for Grok summarization
- Hook in first 2 seconds
- Vary formats: sometimes raw screen recording, sometimes edited
- Auto-captions ALWAYS

Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}

Return JSON:
{
  "title": "...",
  "duration_seconds": N,
  "asr_keywords": ["keyword1","keyword2"],
  "script": [{"seconds":"0-3","visual":"...","audio":"..."},{"seconds":"3-15","visual":"...","audio":"..."}],
  "first_3_seconds_keywords": "...",
  "descriptive_text_for_grok": "...",
  "hook": "...",
  "cta": "...",
  "tweet_text": "... (under 240 chars, no hashtags)",
  "video_type": "screen_recording|face_to_camera|pip|text_animated",
  "why_it_works": "...",
  "originality_element": "..."
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { title: response }; }
}

async function generateReply(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write a value-adding reply for @${optionalEnv('X_USERNAME', '30piq')} to a high-profile X account.

CRITICAL REPLY RULES (ReplyScorer VLM scores replies 0.0-1.0):
- Generic "Great post!" → score ~0.1 → BURIED
- Substantive technical engagement → score ~0.9 → VISIBLE
- Must reference specific concepts from parent post
- Add new facts, counter-arguments, or practical angle
- Keep under 240 chars. No hashtags. No Slop words.

Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic to reply about: ${ctx.topic}

Return JSON:
{
  "target_type": "AI productivity creator",
  "reply_angle": "...",
  "prepared_reply": "... (under 240 chars)",
  "decision_rule": "Reply when..."
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { prepared_reply: response }; }
}

async function generateQuotePost(ctx: any, taskType: TaskType): Promise<any> {
  const response = await callModel(taskType, [
    {
      role: 'system',
      content: `Write a quote post comment for @${optionalEnv('X_USERNAME', '30piq')}.

Rules:
- Add ORIGINAL insight, not just agreement
- Make the quote standalone valuable even without original tweet
- Under 240 chars. No hashtags. No Slop words.

Output valid JSON.`
    },
    {
      role: 'user',
      content: `Topic: ${ctx.topic}

Return JSON:
{
  "target_type": "post/topic",
  "quote_angle": "...",
  "prepared_quote": "... (under 240 chars)",
  "decision_rule": "Quote when..."
}`
    }
  ]);
  try { return JSON.parse(response); } catch { return { prepared_quote: response }; }
}
