import { callModel, parseModelJson } from './model-router';
import { optionalEnv } from './env';
import { FIRST_PERSON_CLAIM_PATTERNS } from './constants';

function cleanAscii(text: string): string {
  return String(text || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x00-\x7F]/g, '')
    .trim();
}

/**
 * containsUnsafeClaim — يفحص هل النص يحتوي ادعاءات غير موثقة
 *
 * التحسين: بدل ما نطابق أي كلمة "I" أو "my" (اللي تدمر كل المحتوى)،
 * نفحص فقط الأنماط اللي تمثل ادعاءات شخصية غير موثقة.
 * الاستخدام العادي لـ "I think" أو "my approach" مسموح.
 * الأنماط مُعرّفة في lib/constants.ts
 */
function containsUnsafeClaim(text: string): boolean {
  const t = cleanAscii(text).toLowerCase();
  // أنماط إضافية خاصة بالمحتوى (مو في constants لأنها خاصة بالتوليد)
  const contentSpecificPatterns = [
    // تجنّب الهاشتاقات
    /#/,
    // ادعاءات مفرطة
    /\d+\s*(x\s*)?(faster|better|more productive|more efficient)\b/i,
  ];
  return FIRST_PERSON_CLAIM_PATTERNS.some((p) => p.test(t)) || contentSpecificPatterns.some((p) => p.test(t));
}

function isInstructionInsteadOfContent(text: string): boolean {
  const t = cleanAscii(text).toLowerCase();
  const instructionStarts = ['offer ', 'suggest ', 'highlight ', 'provide ', 'share ', 'create ', 'write ', 'discuss ', 'explain ', 'clarify ', 'mention '];
  return instructionStarts.some((s) => t.startsWith(s));
}

function fallbackPack() {
  return {
    mode: 'bootstrap',
    today_goal: 'Publish 3 safe, original posts and use practical replies to start real conversations around AI, productivity, and career growth.',
    single_tweets: [
      {
        text: 'Most AI productivity advice starts with tools. Better starting point: pick one recurring workflow, write the decision steps, then use AI to reduce the busywork without hiding the reasoning.',
        why_it_works: 'Practical framework, no fake personal claim, clear AI productivity angle.',
        originality_element: 'Workflow-first framework',
        best_time_utc: '13:00',
        mechanic_used: 'framework-first hook',
        viral_pattern_basis: 'Use a corrective framing without copying a creator.',
        reply_trigger: 'Invites people to name workflows where tools added noise.',
        bookmark_trigger: 'Simple workflow evaluation rule.',
        why_this_is_not_generic: 'Specific workflow-first decision sequence.'
      },
      {
        text: 'A useful AI rule for career growth: automate the repeatable parts, but keep the judgment loop. The goal is not to think less. It is to spend more time on decisions that compound.',
        why_it_works: 'Balanced opinion that avoids hype and supports long-term career positioning.',
        originality_element: 'Caveat plus decision framework',
        best_time_utc: '15:00',
        mechanic_used: 'contrarian caveat',
        viral_pattern_basis: 'Pushes back on shallow automation advice.',
        reply_trigger: 'People can debate where judgment should stay human.',
        bookmark_trigger: 'Memorable rule for AI career leverage.',
        why_this_is_not_generic: 'Connects automation to judgment quality, not speed.'
      },
      {
        text: 'Before adding another AI tool, ask: does it reduce a real bottleneck, improve output quality, or help you learn faster? If it does none of those, it is probably productivity theatre.',
        why_it_works: 'Simple checklist that helps readers evaluate tools instead of chasing trends.',
        originality_element: 'Three-question evaluation checklist',
        best_time_utc: '17:00',
        mechanic_used: 'checklist plus label',
        viral_pattern_basis: 'Turns tool hype into a practical filter.',
        reply_trigger: 'Readers can argue which tools pass the filter.',
        bookmark_trigger: 'Reusable checklist.',
        why_this_is_not_generic: 'Defines a decision test instead of praising AI tools.'
      }
    ],
    reply_targets_strategy: [
      {
        target_type: 'AI productivity creator',
        reply_angle: 'Workflow-first reply',
        prepared_reply: 'Strong point. The part many people miss is mapping the workflow before picking the AI tool. Otherwise the tool becomes another tab, not real leverage.',
        decision_rule: 'Reply when the source post discusses AI tools without workflow context.'
      },
      {
        target_type: 'career growth discussion',
        reply_angle: 'Career leverage caveat',
        prepared_reply: 'The career upside is strongest when AI removes repeatable work but keeps the judgment loop visible. Faster output matters less if the decisions do not improve.',
        decision_rule: 'Reply when the source post links AI use to career outcomes.'
      },
      {
        target_type: 'AI tools announcement',
        reply_angle: 'Tool evaluation filter',
        prepared_reply: 'Useful launch. The filter I would use is simple: does it reduce a bottleneck, improve quality, or speed up learning? If not, it is probably just novelty.',
        decision_rule: 'Reply when a tool launch needs a practical evaluation lens.'
      }
    ],
    quote_tweet_strategy: [
      {
        target_type: 'post/topic',
        quote_angle: 'Add a practical framework to AI productivity discussions.',
        prepared_quote: 'The best AI workflows do not just save time. They preserve judgment while removing repeatable busywork. That distinction matters for career growth.',
        decision_rule: 'Quote only when the source post is high-signal and the quote adds a standalone framework.'
      }
    ],
    github_decision: { needed: false, repo_name: '', asset_type: '', readme_outline: '', reason: 'No proof asset required for this default pack.' },
    quality_checks: ['No fake personal claims.', 'No unverified numbers or percentages.', 'ASCII punctuation only.', 'Replies are actual publish-ready text, not instructions.', 'Each item uses a concrete mechanism from research or viral memory.'],
    human_checklist: ['Publish the 3 safe tweets manually.', 'Use replies only after adapting them to the target post.', 'Do not copy creator wording from viral memory.', 'Log URLs and metrics after posting.']
  };
}

function valueFrom(item: any, keys: string[], fallback: string): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return fallback;
  for (const key of keys) if (typeof item[key] === 'string' && item[key].trim()) return item[key];
  return fallback;
}

function normalizeReply(item: any, index: number) {
  const safeReplies = fallbackPack().reply_targets_strategy;
  const rawPrepared = cleanAscii(valueFrom(item, ['prepared_reply', 'reply', 'text', 'content'], ''));
  const prepared = rawPrepared && !isInstructionInsteadOfContent(rawPrepared) ? rawPrepared : safeReplies[index]?.prepared_reply || safeReplies[0].prepared_reply;
  const angle = cleanAscii(valueFrom(item, ['reply_angle', 'angle'], safeReplies[index]?.reply_angle || 'Add a useful perspective.'));
  const target = cleanAscii(valueFrom(item, ['target_type', 'target'], safeReplies[index]?.target_type || 'topic'));
  const decisionRule = cleanAscii(valueFrom(item, ['decision_rule', 'when_to_reply'], safeReplies[index]?.decision_rule || 'Reply only when the source post is relevant and high-signal.'));
  return { target_type: target, reply_angle: angle, prepared_reply: cleanAscii(prepared).slice(0, 280), decision_rule: decisionRule };
}

function normalizeQuote(item: any) {
  const safe = fallbackPack().quote_tweet_strategy[0];
  const rawPrepared = cleanAscii(valueFrom(item, ['prepared_quote', 'quote', 'text', 'content'], ''));
  const prepared = rawPrepared && !isInstructionInsteadOfContent(rawPrepared) ? rawPrepared : safe.prepared_quote;
  const angle = cleanAscii(valueFrom(item, ['quote_angle', 'angle'], safe.quote_angle));
  const target = cleanAscii(valueFrom(item, ['target_type', 'target'], safe.target_type));
  const decisionRule = cleanAscii(valueFrom(item, ['decision_rule', 'when_to_quote'], safe.decision_rule));
  return { target_type: target, quote_angle: angle, prepared_quote: cleanAscii(prepared).slice(0, 280), decision_rule: decisionRule };
}

/**
 * normalizePack — ينظّف الحزمة بدل رميها بالكامل
 *
 * التحسين: بدل ما نرمي كل الحزمة لو تغريدة وحدة فيها مشكلة،
 * نستبدل التغريدات المعطوبة فقط بالfallback ونحتفظ بالباقي.
 * كذلك نسمح بأقل من 3 تغريدات بدل ما نلغي كل شيء.
 */
function normalizePack(pack: any) {
  const safe = fallbackPack();
  const tweets = Array.isArray(pack?.single_tweets) ? pack.single_tweets : [];
  const repliesRaw = Array.isArray(pack?.reply_targets_strategy) ? pack.reply_targets_strategy : [];
  const quotesRaw = Array.isArray(pack?.quote_tweet_strategy) ? pack.quote_tweet_strategy : [];

  // نظّف كل تغريدة لوحدها — استبدل المعطوبة بالـ fallback
  const cleanedTweets: any[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = tweets[i];
    if (!raw) {
      // لا توجد تغريدة كافية — استخدم fallback
      cleanedTweets.push({
        text: cleanAscii(safe.single_tweets[i]?.text || '').slice(0, 240),
        why_it_works: cleanAscii(safe.single_tweets[i]?.why_it_works || ''),
        originality_element: cleanAscii(safe.single_tweets[i]?.originality_element || 'Original framework'),
        best_time_utc: cleanAscii(safe.single_tweets[i]?.best_time_utc || '15:00'),
        mechanic_used: cleanAscii(safe.single_tweets[i]?.mechanic_used || ''),
        viral_pattern_basis: cleanAscii(safe.single_tweets[i]?.viral_pattern_basis || ''),
        reply_trigger: cleanAscii(safe.single_tweets[i]?.reply_trigger || ''),
        bookmark_trigger: cleanAscii(safe.single_tweets[i]?.bookmark_trigger || ''),
        why_this_is_not_generic: cleanAscii(safe.single_tweets[i]?.why_this_is_not_generic || '')
      });
      continue;
    }
    const text = cleanAscii(String(raw?.text || ''));
    // لو التغريدة فيها ادعاء غير موثق، استبدلها بالـ fallback
    if (containsUnsafeClaim(text) || !text.trim()) {
      cleanedTweets.push({
        text: cleanAscii(safe.single_tweets[i]?.text || '').slice(0, 240),
        why_it_works: cleanAscii(String(raw?.why_it_works || safe.single_tweets[i]?.why_it_works || '')),
        originality_element: cleanAscii(String(raw?.originality_element || raw?.element || safe.single_tweets[i]?.originality_element || 'Original framework')),
        best_time_utc: cleanAscii(String(raw?.best_time_utc || safe.single_tweets[i]?.best_time_utc || '15:00')),
        mechanic_used: cleanAscii(String(raw?.mechanic_used || safe.single_tweets[i]?.mechanic_used || '')),
        viral_pattern_basis: cleanAscii(String(raw?.viral_pattern_basis || safe.single_tweets[i]?.viral_pattern_basis || '')),
        reply_trigger: cleanAscii(String(raw?.reply_trigger || safe.single_tweets[i]?.reply_trigger || '')),
        bookmark_trigger: cleanAscii(String(raw?.bookmark_trigger || safe.single_tweets[i]?.bookmark_trigger || '')),
        why_this_is_not_generic: cleanAscii(String(raw?.why_this_is_not_generic || safe.single_tweets[i]?.why_this_is_not_generic || ''))
      });
    } else {
      cleanedTweets.push({
        text: text.slice(0, 240),
        why_it_works: cleanAscii(String(raw?.why_it_works || safe.single_tweets[i]?.why_it_works || '')),
        originality_element: cleanAscii(String(raw?.originality_element || raw?.element || 'Original framework')),
        best_time_utc: cleanAscii(String(raw?.best_time_utc || safe.single_tweets[i]?.best_time_utc || '15:00')),
        mechanic_used: cleanAscii(String(raw?.mechanic_used || safe.single_tweets[i]?.mechanic_used || '')),
        viral_pattern_basis: cleanAscii(String(raw?.viral_pattern_basis || safe.single_tweets[i]?.viral_pattern_basis || '')),
        reply_trigger: cleanAscii(String(raw?.reply_trigger || safe.single_tweets[i]?.reply_trigger || '')),
        bookmark_trigger: cleanAscii(String(raw?.bookmark_trigger || safe.single_tweets[i]?.bookmark_trigger || '')),
        why_this_is_not_generic: cleanAscii(String(raw?.why_this_is_not_generic || safe.single_tweets[i]?.why_this_is_not_generic || ''))
      });
    }
  }

  const cleanedReplies = repliesRaw.slice(0, 3).map(normalizeReply).filter((r: any) => r.prepared_reply && !containsUnsafeClaim(r.prepared_reply));
  const cleanedQuotes = quotesRaw.slice(0, 1).map(normalizeQuote).filter((q: any) => q.prepared_quote && !containsUnsafeClaim(q.prepared_quote));

  const githubDecision = typeof pack?.github_decision === 'object' && pack.github_decision !== null && !Array.isArray(pack.github_decision)
    ? {
        needed: Boolean(pack.github_decision.needed),
        repo_name: cleanAscii(String(pack.github_decision.repo_name || '')),
        asset_type: cleanAscii(String(pack.github_decision.asset_type || '')),
        readme_outline: cleanAscii(String(pack.github_decision.readme_outline || '')),
        reason: cleanAscii(String(pack.github_decision.reason || ''))
      }
    : safe.github_decision;

  return {
    mode: cleanAscii(String(pack?.mode || 'daily_mission')),
    today_goal: cleanAscii(String(pack?.today_goal || safe.today_goal)),
    single_tweets: cleanedTweets,
    reply_targets_strategy: cleanedReplies.length >= 1 ? cleanedReplies : safe.reply_targets_strategy,
    quote_tweet_strategy: cleanedQuotes.length ? cleanedQuotes : safe.quote_tweet_strategy,
    github_decision: githubDecision,
    quality_checks: (Array.isArray(pack?.quality_checks) ? pack.quality_checks : safe.quality_checks).slice(0, 7).map((x: any) => cleanAscii(String(x))),
    human_checklist: (Array.isArray(pack?.human_checklist) ? pack.human_checklist : safe.human_checklist).slice(0, 6).map((x: any) => cleanAscii(String(x)))
  };
}

export async function generateDailyContentPack(input: { accountState: unknown; targets: unknown; requirements: unknown; recentContent: unknown; creatorIntel: unknown; }) {
  const learningMemory = (input.creatorIntel as any)?.learning_memory || null;
  const learningMemoryContext = learningMemory ? `
LEARNING MEMORY (from all learning pipelines — repo-deep-learn, research-intel-v4, viral-account-scan, viral-discovery-run):
- Algorithm rules: ${JSON.stringify(learningMemory.algorithm_rules?.slice(0, 15) || [])}
- Style patterns: ${JSON.stringify(learningMemory.style_patterns?.slice(0, 15) || [])}
- MCP opportunities: ${JSON.stringify(learningMemory.mcp_opportunities?.slice(0, 10) || [])}
- Usage: Apply algorithm rules when scoring content. Use style patterns as mechanics for hooks, formats, structures. Use MCP opportunities for repo/article decisions. Never copy source wording or claims.
${learningMemory.usage_rule || ''}
` : '';

  const prompt = `
You are the growth operator for @${optionalEnv('X_USERNAME', '30piq')}, an English X account about AI x Productivity x Career Growth.

Create one practical daily mission using research context, Supabase state, recent content, and viral_memory. Viral memory is only for mechanics: hook shape, timing, reply triggers, bookmark triggers, quote filters, and format patterns. Never copy creator wording or claims.
${learningMemoryContext}
Critical rules:
- Output valid JSON only.
- Use plain ASCII punctuation only.
- No hashtags.
- No fake personal experience, tests, percentages, revenue, job outcomes, or tool performance.
- No first-person claims unless the state proves them.
- Each tweet must be under 240 characters.
- Create exactly 3 single tweets, 3 reply templates, and 1 quote template.
- Replies and quotes must be publish-ready text, not instructions.
- Each tweet must include a concrete mechanism: framework, correction, checklist, comparison, caveat, or workflow.
- Each tweet must include why it is not generic, a reply trigger, and a bookmark trigger.
- Choose publish/reply/quote decisions based on usefulness, not engagement bait.

State:
accountState=${JSON.stringify(input.accountState)}
targets=${JSON.stringify(input.targets)}
requirements=${JSON.stringify(input.requirements)}
recentContent=${JSON.stringify(input.recentContent)}
creatorIntel=${JSON.stringify(input.creatorIntel)}

Return JSON with this exact shape:
{
  "mode": "daily_mission_viral_memory",
  "today_goal": "...",
  "single_tweets": [{"text":"...","why_it_works":"...","originality_element":"...","best_time_utc":"...","mechanic_used":"...","viral_pattern_basis":"...","reply_trigger":"...","bookmark_trigger":"...","why_this_is_not_generic":"..."}],
  "reply_targets_strategy": [{"target_type":"...","reply_angle":"...","prepared_reply":"...","decision_rule":"..."}],
  "quote_tweet_strategy": [{"target_type":"post/topic","quote_angle":"...","prepared_quote":"...","decision_rule":"..."}],
  "github_decision": {"needed":false,"repo_name":"","asset_type":"","readme_outline":"","reason":"..."},
  "quality_checks": ["..."],
  "human_checklist": ["..."]
}`;

  // ═══ يستخدم model-router بدل OpenAI مباشرة ═══
  const response = await callModel('content_generation', [
    { role: 'system', content: 'Write publish-ready X content using provided mechanics only. Never invent proof, metrics, hashtags, or personal claims.' },
    { role: 'user', content: prompt }
  ]);

  try { return normalizePack(parseModelJson(response)); } catch { return fallbackPack(); }
}
