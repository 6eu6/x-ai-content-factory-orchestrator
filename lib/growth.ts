export const GROWTH_OPERATOR_VERSION = 'safe-v7-growth-operator-unique';

export function fallbackGrowthReplies() {
  return [
    {
      target_type: 'AI productivity creator',
      reply_angle: 'Workflow-first reply',
      prepared_reply: 'Strong point. The part many people miss is mapping the workflow before picking the AI tool. Otherwise the tool becomes another tab, not real leverage.'
    },
    {
      target_type: 'career growth discussion',
      reply_angle: 'Career leverage caveat',
      prepared_reply: 'The career upside is strongest when AI removes repeatable work but keeps the judgment loop visible. Faster output matters less if the decisions do not improve.'
    },
    {
      target_type: 'AI tools announcement',
      reply_angle: 'Tool evaluation filter',
      prepared_reply: 'Useful launch. The filter I would use is simple: does it reduce a bottleneck, improve quality, or speed up learning? If not, it is probably just novelty.'
    },
    {
      target_type: 'builder or founder post',
      reply_angle: 'Systems perspective',
      prepared_reply: 'This is where AI becomes useful: not as a replacement for the work system, but as a pressure test for the weak steps inside the system.'
    },
    {
      target_type: 'learning or upskilling post',
      reply_angle: 'Learning loop',
      prepared_reply: 'The best use case is turning learning into a loop: ask, apply, review, and refine. AI helps most when it shortens that loop without removing the thinking.'
    },
    {
      target_type: 'AI workflow thread',
      reply_angle: 'Decision quality angle',
      prepared_reply: 'The useful test is not whether AI makes the workflow faster. It is whether the output gets easier to review, improve, and repeat.'
    },
    {
      target_type: 'productivity advice post',
      reply_angle: 'Bottleneck framing',
      prepared_reply: 'A good first step is naming the bottleneck. Once that is clear, AI can help with the repeatable parts instead of adding another layer of complexity.'
    }
  ];
}

function normalizeReplyKey(reply: any) {
  return String(reply?.prepared_reply || '').trim().toLowerCase();
}

function uniqueReplies(primary: any[], fallback: any[]) {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const reply of [...primary, ...fallback]) {
    const key = normalizeReplyKey(reply);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(reply);
    if (result.length === 5) break;
  }
  return result;
}

export function enrichGrowthOperatorPack(pack: any) {
  const tweets = Array.isArray(pack?.single_tweets) ? pack.single_tweets : [];
  const rawReplies = Array.isArray(pack?.reply_targets_strategy) ? pack.reply_targets_strategy : [];
  const replies = uniqueReplies(rawReplies, fallbackGrowthReplies());
  const quotes = Array.isArray(pack?.quote_tweet_strategy) ? pack.quote_tweet_strategy : [];
  const githubNeeded = Boolean(pack?.github_decision?.needed);
  const articleNeeded = Boolean(pack?.article_decision?.needed);

  return {
    ...pack,
    mode: 'growth_operator_daily_mission',
    reply_targets_strategy: replies,
    operator_summary: pack?.operator_summary || {
      account_goal: 'Grow @30piq from zero toward 10K-20K real followers as an English AI x Productivity x Career Growth account, then test monetization with proof-based content.',
      role: 'Growth operator, content strategist, publishing planner, GitHub proof-layer decider, and Supabase logging planner.',
      constraint: 'No fake claims, no copied creator content, no spam, no invented metrics, and no automation that risks account quality.'
    },
    final_recommendation: {
      action: pack?.final_recommendation?.action || 'publish_today_pack',
      reason: pack?.final_recommendation?.reason || 'The account needs consistent high-signal positioning, useful short-form content, and real manual engagement before heavier assets.',
      publish_count: tweets.length,
      reply_count: replies.length,
      quote_count: quotes.length,
      growth_goal_alignment: 'Build trust around practical AI workflows, attract AI/productivity/career-growth followers, and create reusable proof assets only when the topic deserves them.'
    },
    article_decision: {
      needed: articleNeeded,
      reason: pack?.article_decision?.reason || 'No article today unless the topic needs a detailed tutorial, comparison, documentation, or long-form reference that can be reused later.',
      title: pack?.article_decision?.title || '',
      outline: Array.isArray(pack?.article_decision?.outline) ? pack.article_decision.outline : [],
      draft: pack?.article_decision?.draft || ''
    },
    github_decision: {
      needed: githubNeeded,
      reason: pack?.github_decision?.reason || 'No GitHub asset today unless the content needs a public checklist, template, workflow file, dataset, code sample, or proof layer.',
      repo_name: pack?.github_decision?.repo_name || '',
      asset_type: pack?.github_decision?.asset_type || '',
      readme_outline: pack?.github_decision?.readme_outline || ''
    },
    media_plan: pack?.media_plan || {
      needed: false,
      format: 'none',
      visual_prompt: '',
      reason: 'Use text-only unless a diagram, carousel, visual checklist, or demo screenshot would make the idea easier to understand.'
    },
    research_plan: pack?.research_plan || {
      required_before_publish: false,
      search_queries: [],
      sources_to_check: [],
      reason: 'No external factual claim is being made in the default pack. If a future pack mentions tools, pricing, policies, or benchmarks, research is required first.'
    },
    content_scores: pack?.content_scores || {
      content_strength_score: 7,
      originality_score: 7,
      risk_score: 2,
      reason: 'Safe and useful for foundation growth, but should become more specific as creator intel and account metrics accumulate.'
    },
    publishing_plan: pack?.publishing_plan || [
      { item: 'tweet_1', best_time_utc: tweets[0]?.best_time_utc || '13:00', action: 'publish' },
      { item: 'tweet_2', best_time_utc: tweets[1]?.best_time_utc || '15:00', action: 'publish' },
      { item: 'tweet_3', best_time_utc: tweets[2]?.best_time_utc || '17:00', action: 'publish' },
      { item: 'reply_1_to_5', best_time_utc: 'within 30 minutes after finding relevant posts', action: 'manual_reply' },
      { item: 'quote_1', best_time_utc: 'only if source post is high-signal', action: 'manual_quote' }
    ],
    supabase_logging_plan: pack?.supabase_logging_plan || {
      after_publish: ['content_log.tweet_url', 'content_log.publish_status', 'daily_checkins.tweets_posted', 'daily_stats.tweets_posted'],
      after_engagement: ['daily_checkins.replies_posted', 'daily_checkins.quotes_posted', 'action_queue.status'],
      after_metrics: ['content_log.views', 'content_log.likes', 'content_log.replies', 'content_log.reposts', 'content_log.bookmarks', 'content_log.performance_score'],
      after_asset: ['github_repos.repo_url', 'github_repos.status', 'content_log.repo_link']
    },
    next_actions: buildSmartActions(tweets, replies, quotes, githubNeeded, articleNeeded, pack)
  };
}

/**
 * بناء مهام ذكية ديناميكية بدل المهام الثابتة
 * كل مهمة تحمل بيانات فعلية (أوقات، أعداد، أنواع) بدل نص عام
 */
function buildSmartActions(
  tweets: any[],
  replies: any[],
  quotes: any[],
  githubNeeded: boolean,
  articleNeeded: boolean,
  pack: any
): Array<{ action_type: string; instruction: string; priority: number }> {
  const actions: Array<{ action_type: string; instruction: string; priority: number }> = [];

  // ═══ مهام النشر ═══
  if (tweets.length > 0) {
    const times = tweets.map((t, i) => `${t.best_time_utc || ['13:00','15:00','17:00'][i]}`).join(', ');
    actions.push({
      action_type: 'publish',
      instruction: `Publish ${tweets.length} tweet${tweets.length > 1 ? 's' : ''} at UTC times: ${times}. Copy text from the content pack delivered to Telegram.`,
      priority: 1
    });
  }

  // ═══ مهام التفاعل ═══
  if (replies.length > 0) {
    actions.push({
      action_type: 'engage',
      instruction: `Use ${replies.length} prepared repl${replies.length > 1 ? 'ies' : 'y'} on high-signal posts. Only reply when the source post matches the reply angle — do not spam.`,
      priority: 2
    });
  }

  if (quotes.length > 0) {
    actions.push({
      action_type: 'engage',
      instruction: `Post ${quotes.length} quote tweet${quotes.length > 1 ? 's' : ''} only if the source post is relevant and adds standalone value.`,
      priority: 3
    });
  }

  // ═══ مهام GitHub ═══
  if (githubNeeded) {
    const repoName = pack?.github_decision?.repo_name || '';
    const assetType = pack?.github_decision?.asset_type || 'asset';
    actions.push({
      action_type: 'create_asset',
      instruction: `Create GitHub ${assetType}${repoName ? `: ${repoName}` : ''} as described in github_decision. This provides proof layer for the content.`,
      priority: 4
    });
  }

  // ═══ مهام المقال ═══
  if (articleNeeded) {
    const title = pack?.article_decision?.title || '';
    actions.push({
      action_type: 'create_asset',
      instruction: `Write X Article${title ? `: "${title}"` : ''} as described in article_decision. Validate the topic with short-form content first.`,
      priority: 5
    });
  }

  // ═══ مهمة التسجيل ═══
  actions.push({
    action_type: 'log_results',
    instruction: 'After publishing, run "📊 مسح الأداء" to measure results and update learning memory.',
    priority: 6
  });

  return actions;
}
