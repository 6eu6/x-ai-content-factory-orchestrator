import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import { callModel } from './model-router';
import { getXUserTimeline, scoreXTweet, analyzeXTweet } from './x';

/**
 * Account Performance Scanner — ماسح أداء الحساب + تعلم من النتائج
 *
 * بعد كل نشر يدوي، هذا النظام:
 * 1. يفحص حساب @30piq ويجيب التغريدات + المقاييس
 * 2. يحلل: أي تغريدة جابت تفاعل؟ أي واحدة فشلت؟ ليش؟
 * 3. يعلّم العقل من النتائج:
 *    - يزيد ثقة القواعد اللي نتج عنها محتوى ناجح
 *    - ينقص ثقة القواعد اللي نتج عنها محتوى فاشل
 *    - يستخلص أنماط جديدة من النجاح/الفشل
 *    - يحدّث working memory
 */

export type PerformanceScanResult = {
  ok: boolean;
  account_handle: string;
  scanned_tweets: number;
  performance_analysis: PerformanceAnalysis[];
  learning_updates: LearningUpdate[];
  brain_summary: string;
};

export type PerformanceAnalysis = {
  tweet_id: string;
  tweet_url: string;
  text_preview: string;
  metrics: {
    views: number;
    likes: number;
    replies: number;
    retweets: number;
    quotes: number;
    bookmarks: number;
  };
  performance_score: number;
  verdict: 'high_performer' | 'average' | 'underperformer';
  analysis: string;
  success_factors: string[];
  failure_factors: string[];
  linked_content_log_id?: number;
  linked_rule_ids?: number[];
  linked_pattern_ids?: number[];
};

export type LearningUpdate = {
  type: 'rule_boost' | 'rule_decay' | 'new_pattern' | 'anti_pattern' | 'timing_insight' | 'format_insight';
  target_table: string;
  target_id?: number;
  change: string;
  reason: string;
  confidence_delta: number;
};

/**
 * المسح الرئيسي — يفحص حساب @30piq ويتعلم من النتائج
 */
export async function scanAccountPerformance(
  maxTweets = 10,
  username = optionalEnv('X_USERNAME', '30piq')
): Promise<PerformanceScanResult> {
  const supabase = supabaseAdmin();

  // ═══ 1. سحب تغريدات الحساب + المقاييس ═══
  let tweets: any[] = [];
  try {
    tweets = await getXUserTimeline(username, maxTweets, true);
  } catch (e: any) {
    return {
      ok: false,
      account_handle: username,
      scanned_tweets: 0,
      performance_analysis: [],
      learning_updates: [],
      brain_summary: `Failed to fetch timeline: ${e.message}`
    };
  }

  if (!tweets.length) {
    return {
      ok: true,
      account_handle: username,
      scanned_tweets: 0,
      performance_analysis: [],
      learning_updates: [],
      brain_summary: 'No tweets found on account timeline. Publish content first, then scan.'
    };
  }

  // ═══ 2. تحديث حالة الحساب ═══
  try {
    const latestMetrics = tweets[0]?.public_metrics || {};
    await supabase.from('account_state').upsert({
      account_handle: username,
      x_url: `https://x.com/${username}`,
      last_live_check_at: new Date().toISOString(),
      last_known_source: 'performance_scan'
    }, { onConflict: 'account_handle' });
  } catch {}

  // ═══ 3. تحليل كل تغريدة ═══
  const analyses: PerformanceAnalysis[] = [];

  for (const tweet of tweets) {
    const m = tweet.public_metrics || {};
    const views = m.view_count || 0;
    const likes = m.like_count || 0;
    const replies = m.reply_count || 0;
    const retweets = m.retweet_count || 0;
    const quotes = m.quote_count || 0;
    const bookmarks = m.bookmark_count || 0;

    // حساب performance_score
    const engagementScore = scoreXTweet(tweet);
    const viewAdjustedScore = views > 0 ? (engagementScore / views) * 1000 : 0;

    let verdict: PerformanceAnalysis['verdict'] = 'average';
    if (viewAdjustedScore > 50 || (likes > 5 && bookmarks > 2)) verdict = 'high_performer';
    if (viewAdjustedScore < 5 && views > 100) verdict = 'underperformer';

    // ربط مع content_log
    let linkedLogId: number | undefined;
    try {
      const { data: logEntry } = await supabase
        .from('content_log')
        .select('id, mechanic_used, viral_pattern_basis, originality_element, source_used')
        .ilike('hook_text', `%${(tweet.text || '').slice(0, 50)}%`)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      linkedLogId = logEntry?.id;
    } catch {}

    analyses.push({
      tweet_id: tweet.id,
      tweet_url: `https://x.com/${username}/status/${tweet.id}`,
      text_preview: (tweet.text || '').slice(0, 200),
      metrics: { views, likes, replies, retweets, quotes, bookmarks },
      performance_score: Math.round(viewAdjustedScore * 100) / 100,
      verdict,
      analysis: '',
      success_factors: [],
      failure_factors: [],
      linked_content_log_id: linkedLogId
    });
  }

  // ═══ 4. تحليل AI — ليش نجح/فشل كل تغريدة ═══
  const analysisContext = analyses.map(a => ({
    text: a.text_preview,
    verdict: a.verdict,
    score: a.performance_score,
    metrics: a.metrics
  }));

  let aiAnalysis: any = {};
  try {
    const aiResponse = await callModel('performance_analysis', [
      {
        role: 'system',
        content: `You are an X/Twitter growth analyst. Analyze tweet performance and explain WHY each tweet succeeded or failed. Be specific about hooks, structure, timing, format, and content quality. Output valid JSON only.`
      },
      {
        role: 'user',
        content: `Analyze these tweets from @${username} account. For each tweet, explain:
1. Why it performed the way it did (success or failure factors)
2. What specific element helped or hurt (hook, format, topic, timing, structure)
3. What the brain should learn from this result

Tweets with metrics:
${JSON.stringify(analysisContext, null, 2)}

Algorithm rules we follow:
- Favorite/like has highest weight (1.0)
- Reply weight is 0.5, retweet 0.3
- Bookmark signal is strong for long-term distribution
- Video > Thread > Carousel > Single tweet in algorithm value
- OON penalty: non-followers see content with 25% penalty
- Author diversity decay: posting too fast kills reach
- Low-follower accounts (<500) trigger spam classifier with links

Return JSON array matching each tweet:
[{
  "text_preview": "...",
  "analysis": "detailed explanation",
  "success_factors": ["factor1", "factor2"],
  "failure_factors": ["factor1"],
  "brain_learning": "what the system should remember from this"
}]`
      }
    ]);

    const parsed = JSON.parse(aiResponse);
    if (Array.isArray(parsed)) {
      for (let i = 0; i < analyses.length && i < parsed.length; i++) {
        analyses[i].analysis = parsed[i]?.analysis || '';
        analyses[i].success_factors = parsed[i]?.success_factors || [];
        analyses[i].failure_factors = parsed[i]?.failure_factors || [];
      }
    }
  } catch {}

  // ═══ 5. تعلم العقل — تحديث الثقة والأنماط ═══
  const learningUpdates: LearningUpdate[] = [];

  for (const analysis of analyses) {
    // تحديث content_log بالمقاييس الحقيقية
    if (analysis.linked_content_log_id) {
      try {
        await supabase
          .from('content_log')
          .update({
            views: analysis.metrics.views,
            likes: analysis.metrics.likes,
            replies: analysis.metrics.replies,
            reposts: analysis.metrics.retweets,
            bookmarks: analysis.metrics.bookmarks,
            performance_score: analysis.performance_score,
            notes: JSON.stringify({
              verdict: analysis.verdict,
              analysis: analysis.analysis,
              success_factors: analysis.success_factors,
              failure_factors: analysis.failure_factors,
              last_measured_at: new Date().toISOString()
            })
          })
          .eq('id', analysis.linked_content_log_id);
      } catch {}
    }

    // لو تغريدة ناجحة — زوّد ثقة القواعد المرتبطة
    if (analysis.verdict === 'high_performer') {
      learningUpdates.push({
        type: 'rule_boost',
        target_table: 'x_algorithm_learning_rules',
        change: 'confidence_boost',
        reason: `Tweet ${analysis.tweet_id} performed well (score: ${analysis.performance_score}). Success: ${analysis.success_factors.join(', ')}`,
        confidence_delta: 0.05
      });

      // استخلص نمط جديد من النجاح
      if (analysis.success_factors.length > 0) {
        learningUpdates.push({
          type: 'new_pattern',
          target_table: 'viral_style_patterns',
          change: 'extract_success_pattern',
          reason: `From high-performer ${analysis.tweet_id}: ${analysis.success_factors.join(' + ')}`,
          confidence_delta: 0.1
        });
      }
    }

    // لو تغريدة فاشلة — نقّص ثقة القواعد المرتبطة
    if (analysis.verdict === 'underperformer') {
      learningUpdates.push({
        type: 'rule_decay',
        target_table: 'x_algorithm_learning_rules',
        change: 'confidence_decay',
        reason: `Tweet ${analysis.tweet_id} underperformed (score: ${analysis.performance_score}). Issues: ${analysis.failure_factors.join(', ')}`,
        confidence_delta: -0.05
      });

      if (analysis.failure_factors.length > 0) {
        learningUpdates.push({
          type: 'anti_pattern',
          target_table: 'viral_style_patterns',
          change: 'mark_as_anti_pattern',
          reason: `From underperformer ${analysis.tweet_id}: ${analysis.failure_factors.join(' + ')} — avoid this combination`,
          confidence_delta: -0.1
        });
      }
    }
  }

  // ═══ 6. تطبيق تحديثات التعلم على القاعدة ═══
  for (const update of learningUpdates) {
    try {
      if (update.type === 'rule_boost' || update.type === 'rule_decay') {
        // زوّد أو نقّص ثقة القواعد النشطة الأخيرة
        // جلب القواعد ثم تحديثها يدوياً (بدون RPC)
        const { data: recentRules } = await supabase
          .from(update.target_table)
          .select('id, confidence_score')
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(5);

        if (recentRules && recentRules.length > 0) {
          for (const rule of recentRules) {
            const currentScore = Number(rule.confidence_score) || 0.5;
            const newScore = Math.max(0.1, Math.min(1.0, currentScore + update.confidence_delta));
            await supabase
              .from(update.target_table)
              .update({ confidence_score: Math.round(newScore * 1000) / 1000 })
              .eq('id', rule.id);
          }
        }
      }
    } catch {}
  }

  // ═══ 7. سجل تحليل الأداء ═══
  try {
    await supabase.from('session_logs').insert({
      ai_tool: 'performance_scanner',
      session_type: 'account_performance_scan',
      actions_completed: [`scanned_${tweets.length}_tweets`, `found_${analyses.filter(a => a.verdict === 'high_performer').length}_winners`, `found_${analyses.filter(a => a.verdict === 'underperformer').length}_losers`],
      content_created: [],
      db_updates: [{ table: 'content_log', action: 'updated_metrics' }],
      decisions_made: learningUpdates.map(u => `${u.type}: ${u.reason}`),
      pending_tasks: [],
      next_recommendation: analyses.filter(a => a.verdict === 'high_performer').length > 0
        ? 'Study the winning tweets and double down on their patterns.'
        : 'No high-performing tweets yet. Focus on originality and engagement mechanics.',
      notes: JSON.stringify({
        scan_date: new Date().toISOString(),
        account: username,
        tweets_scanned: tweets.length,
        learning_updates_count: learningUpdates.length
      })
    });
  } catch {}

  // ═══ 8. ملخص للعقل ═══
  const winners = analyses.filter(a => a.verdict === 'high_performer');
  const losers = analyses.filter(a => a.verdict === 'underperformer');
  const avgScore = analyses.reduce((sum, a) => sum + a.performance_score, 0) / (analyses.length || 1);

  const brainSummary = [
    `Scanned ${tweets.length} tweets from @${username}.`,
    `Winners: ${winners.length} | Average: ${analyses.length - winners.length - losers.length} | Losers: ${losers.length}`,
    `Average performance score: ${Math.round(avgScore * 100) / 100}`,
    winners.length > 0 ? `Winning patterns: ${winners.flatMap(w => w.success_factors).slice(0, 5).join(', ')}` : 'No winning patterns identified yet.',
    losers.length > 0 ? `Failure patterns: ${losers.flatMap(l => l.failure_factors).slice(0, 5).join(', ')}` : 'No clear failure patterns.',
    `Learning updates applied: ${learningUpdates.length}`
  ].join('\n');

  return {
    ok: true,
    account_handle: username,
    scanned_tweets: tweets.length,
    performance_analysis: analyses,
    learning_updates: learningUpdates,
    brain_summary: brainSummary
  };
}
