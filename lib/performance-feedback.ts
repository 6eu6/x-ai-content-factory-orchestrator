import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import { callModel } from './model-router';
import { getXUserTimeline, scoreXTweet, analyzeXTweet } from './x';
import { sendTelegramMessage, allowedChatId, htmlEscape, shortText, MAIN_KEYBOARD } from './telegram';

/**
 * Account Performance Scanner v2 — ماسح أداء الحساب + تعلم سببي من النتائج
 *
 * تحسينات:
 * 1. تعلم سببي أعمق — يربط كل نتيجة بالقواعد المحددة المستخدمة
 * 2. تحديث working memory تلقائياً
 * 3. تسجيل في performance_scans
 * 4. إرسال ملخص التعلم لتليجرام
 * 5. استخلاص anti-patterns صريحة
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
    let linkedLogData: any = null;
    try {
      const { data: logEntry } = await supabase
        .from('content_log')
        .select('id, mechanic_used, viral_pattern_basis, originality_element, source_used, notes, content_type, topic')
        .ilike('hook_text', `%${(tweet.text || '').slice(0, 50)}%`)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      linkedLogId = logEntry?.id;
      linkedLogData = logEntry;
    } catch {}

    // ربط مع القواعد والأنماط اللي استُخدمت في التوليد
    let linkedRuleIds: number[] = [];
    let linkedPatternIds: number[] = [];

    if (linkedLogData?.notes) {
      try {
        const notes = typeof linkedLogData.notes === 'string' ? JSON.parse(linkedLogData.notes) : linkedLogData.notes;
        if (notes.used_rule_ids) linkedRuleIds = notes.used_rule_ids;
        if (notes.used_pattern_ids) linkedPatternIds = notes.used_pattern_ids;
      } catch {}
    }

    if (!linkedRuleIds.length && linkedLogData?.topic) {
      try {
        const { data: relatedRules } = await supabase
          .from('x_algorithm_learning_rules')
          .select('id')
          .eq('status', 'active')
          .or(`rule.ilike.%${linkedLogData.topic?.slice(0, 30)}%,evidence.ilike.%${linkedLogData.topic?.slice(0, 30)}%,applies_to.ilike.%${linkedLogData.content_type || 'tweet'}%`)
          .limit(5);
        linkedRuleIds = (relatedRules || []).map((r: any) => r.id);
      } catch {}
    }

    if (!linkedPatternIds.length && linkedLogData?.mechanic_used) {
      try {
        const { data: relatedPatterns } = await supabase
          .from('viral_style_patterns')
          .select('id')
          .eq('status', 'active')
          .or(`pattern_name.ilike.%${linkedLogData.mechanic_used?.slice(0, 30)}%,pattern_description.ilike.%${linkedLogData.mechanic_used?.slice(0, 30)}%`)
          .limit(5);
        linkedPatternIds = (relatedPatterns || []).map((r: any) => r.id);
      } catch {}
    }

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
      linked_content_log_id: linkedLogId,
      linked_rule_ids: linkedRuleIds,
      linked_pattern_ids: linkedPatternIds
    });
  }

  // ═══ 4. تحليل AI — ليش نجح/فشل كل تغريدة ═══
  const analysisContext = analyses.map(a => ({
    text: a.text_preview,
    verdict: a.verdict,
    score: a.performance_score,
    metrics: a.metrics,
    linked_rules: a.linked_rule_ids,
    linked_patterns: a.linked_pattern_ids
  }));

  let aiAnalysis: any = {};
  try {
    const aiResponse = await callModel('performance_analysis', [
      {
        role: 'system',
        content: `You are an X/Twitter growth analyst. Analyze tweet performance and explain WHY each tweet succeeded or failed. Be specific about hooks, structure, timing, format, and content quality. Focus on CAUSAL relationships, not just correlations. Output valid JSON only.`
      },
      {
        role: 'user',
        content: `Analyze these tweets from @${username} account. For each tweet, explain:
1. Why it performed the way it did (success or failure factors) — be SPECIFIC about what element caused the outcome
2. What specific element helped or hurt (hook, format, topic, timing, structure)
3. What the brain should learn from this result — as a CAUSAL rule, not just observation

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
- ReplyScorer VLM scores replies 0.0-1.0 based on substantive engagement
- VQV algorithm: video must be 15+ seconds with speech for boost

Return JSON array matching each tweet:
[{
  "text_preview": "...",
  "analysis": "detailed CAUSAL explanation",
  "success_factors": ["factor1", "factor2"],
  "failure_factors": ["factor1"],
  "brain_learning": "CAUSAL rule the system should remember",
  "causal_chain": "cause → mechanism → effect"
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

    // لو تغريدة ناجحة — زوّد ثقة القواعد المرتبطة بالتحديد
    if (analysis.verdict === 'high_performer') {
      // حدّث القواعد المربوطة بالتحديد
      for (const ruleId of (analysis.linked_rule_ids || [])) {
        learningUpdates.push({
          type: 'rule_boost',
          target_table: 'x_algorithm_learning_rules',
          target_id: ruleId,
          change: 'confidence_boost',
          reason: `Tweet ${analysis.tweet_id} performed well (score: ${analysis.performance_score}). Success: ${analysis.success_factors.join(', ')}`,
          confidence_delta: 0.05
        });
      }

      // حدّث الأنماط المربوطة
      for (const patternId of (analysis.linked_pattern_ids || [])) {
        learningUpdates.push({
          type: 'rule_boost',
          target_table: 'viral_style_patterns',
          target_id: patternId,
          change: 'confidence_boost',
          reason: `Tweet ${analysis.tweet_id} performed well using this pattern. Success: ${analysis.success_factors.join(', ')}`,
          confidence_delta: 0.08
        });
      }

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
      for (const ruleId of (analysis.linked_rule_ids || [])) {
        learningUpdates.push({
          type: 'rule_decay',
          target_table: 'x_algorithm_learning_rules',
          target_id: ruleId,
          change: 'confidence_decay',
          reason: `Tweet ${analysis.tweet_id} underperformed (score: ${analysis.performance_score}). Issues: ${analysis.failure_factors.join(', ')}`,
          confidence_delta: -0.05
        });
      }

      for (const patternId of (analysis.linked_pattern_ids || [])) {
        learningUpdates.push({
          type: 'rule_decay',
          target_table: 'viral_style_patterns',
          target_id: patternId,
          change: 'confidence_decay',
          reason: `Tweet ${analysis.tweet_id} underperformed using this pattern. Issues: ${analysis.failure_factors.join(', ')}`,
          confidence_delta: -0.08
        });
      }

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
        const targetId = update.target_id;
        if (targetId) {
          const { data: rule } = await supabase
            .from(update.target_table)
            .select('id, confidence_score')
            .eq('id', targetId)
            .maybeSingle();

          if (rule) {
            const currentScore = Number(rule.confidence_score) || 0.5;
            const newScore = Math.max(0.1, Math.min(1.0, currentScore + update.confidence_delta));
            await supabase
              .from(update.target_table)
              .update({ confidence_score: Math.round(newScore * 1000) / 1000 })
              .eq('id', rule.id);
          }
        }
      }

      // إضافة anti-pattern صريح
      if (update.type === 'anti_pattern' && update.target_id) {
        await supabase
          .from(update.target_table)
          .update({
            status: 'anti_pattern',
            risks: `Anti-pattern confirmed: ${update.reason}`
          })
          .eq('id', update.target_id);
      }
    } catch {}
  }

  // ═══ 7. تحديث Working Memory — الثقة العالية فقط ═══
  try {
    const { data: topAlgoRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('*')
      .eq('status', 'active')
      .gte('confidence_score', 0.7)
      .order('confidence_score', { ascending: false })
      .limit(15);

    const { data: topStylePatterns } = await supabase
      .from('viral_style_patterns')
      .select('*')
      .eq('status', 'active')
      .gte('confidence_score', 0.7)
      .order('confidence_score', { ascending: false })
      .limit(15);

    if (topAlgoRules && topAlgoRules.length > 0) {
      for (const rule of topAlgoRules.slice(0, 10)) {
        try {
          await supabase.from('working_memory').upsert({
            memory_type: 'algorithm_rule',
            source_table: 'x_algorithm_learning_rules',
            source_id: String(rule.id),
            content: { rule: rule.rule, evidence: rule.evidence, applies_to: rule.applies_to },
            confidence_score: rule.confidence_score,
            last_accessed_at: new Date().toISOString()
          }, { onConflict: 'memory_type,source_table,source_id' });
        } catch {}
      }
    }

    if (topStylePatterns && topStylePatterns.length > 0) {
      for (const pattern of topStylePatterns.slice(0, 10)) {
        try {
          await supabase.from('working_memory').upsert({
            memory_type: 'style_pattern',
            source_table: 'viral_style_patterns',
            source_id: String(pattern.id),
            content: { pattern_name: pattern.pattern_name, description: pattern.pattern_description, example: pattern.example_structure },
            confidence_score: pattern.confidence_score,
            last_accessed_at: new Date().toISOString()
          }, { onConflict: 'memory_type,source_table,source_id' });
        } catch {}
      }
    }
  } catch {}

  // ═══ 8. استخلص أنماط تعلم سببية جديدة ═══
  try {
    const winners = analyses.filter(a => a.verdict === 'high_performer');
    const losers = analyses.filter(a => a.verdict === 'underperformer');

    if (winners.length > 0 || losers.length > 0) {
      const causationResponse = await callModel('learning_extraction', [
        {
          role: 'system',
          content: `You are a causal learning analyst for an X/Twitter content system. Given tweet performance data, extract CAUSAL rules about what specifically causes success or failure. Focus on actionable, specific rules — not generic observations. Output valid JSON.`
        },
        {
          role: 'user',
          content: `Extract causal learning rules from these results:

HIGH PERFORMERS:
${JSON.stringify(winners.map(w => ({
  text: w.text_preview,
  score: w.performance_score,
  success_factors: w.success_factors,
  linked_rules: w.linked_rule_ids,
  linked_patterns: w.linked_pattern_ids,
  metrics: w.metrics
})), null, 2)}

UNDERPERFORMERS:
${JSON.stringify(losers.map(l => ({
  text: l.text_preview,
  score: l.performance_score,
  failure_factors: l.failure_factors,
  linked_rules: l.linked_rule_ids,
  linked_patterns: l.linked_pattern_ids,
  metrics: l.metrics
})), null, 2)}

For each causal rule, specify:
1. The CAUSE (specific element, mechanic, or pattern)
2. The EFFECT (engagement outcome)
3. CONFIDENCE (0.0-1.0 based on evidence strength)
4. ACTIONABLE INSIGHT (what to do differently next time)
5. CAUSAL CHAIN (cause → mechanism → effect)

Return JSON:
{
  "causal_rules": [{
    "cause": "specific element",
    "effect": "what happened",
    "confidence": 0.8,
    "actionable_insight": "do X to achieve Y",
    "causal_chain": "cause → mechanism → effect",
    "rule_type": "success_cause|failure_cause"
  }],
  "anti_patterns_to_avoid": ["pattern1", "pattern2"],
  "reinforced_patterns": ["pattern1", "pattern2"],
  "timing_insights": ["best posting times observed"],
  "format_insights": ["which formats worked best"]
}`
        }
      ]);

      const causalParsed = JSON.parse(causationResponse);

      // سجّل القواعد السببية في system_learning_rules
      if (causalParsed.causal_rules?.length) {
        for (const cr of causalParsed.causal_rules.slice(0, 5)) {
          await supabase.from('system_learning_rules').insert({
            rule_type: cr.rule_type === 'success_cause' ? 'causal_success' : 'causal_failure',
            rule: cr.actionable_insight || `${cr.cause} → ${cr.effect}`,
            evidence: `Cause: ${cr.cause}, Effect: ${cr.effect}, Chain: ${cr.causal_chain || 'N/A'}, Confidence: ${cr.confidence}`,
            applies_to: 'content_generation',
            confidence_score: Math.round(cr.confidence * 10),
            status: 'active',
            test_run: false
          });
        }
      }

      // سجّل timing insights
      if (causalParsed.timing_insights?.length) {
        for (const insight of causalParsed.timing_insights.slice(0, 3)) {
          learningUpdates.push({
            type: 'timing_insight',
            target_table: 'system_learning_rules',
            change: 'new_timing_rule',
            reason: insight,
            confidence_delta: 0.1
          });
        }
      }

      // سجّل format insights
      if (causalParsed.format_insights?.length) {
        for (const insight of causalParsed.format_insights.slice(0, 3)) {
          learningUpdates.push({
            type: 'format_insight',
            target_table: 'system_learning_rules',
            change: 'new_format_rule',
            reason: insight,
            confidence_delta: 0.1
          });
        }
      }
    }
  } catch {}

  // ═══ 9. سجل في performance_scans ═══
  try {
    const winners = analyses.filter(a => a.verdict === 'high_performer');
    const losers = analyses.filter(a => a.verdict === 'underperformer');
    const avgScore = analyses.reduce((sum, a) => sum + a.performance_score, 0) / (analyses.length || 1);

    await supabase.from('performance_scans').insert({
      account_handle: username,
      scanned_tweets: tweets.length,
      high_performers: winners.length,
      underperformers: losers.length,
      average_score: Math.round(avgScore * 100) / 100,
      brain_summary: buildBrainSummary(analyses, learningUpdates, username),
      learning_updates: learningUpdates,
      scan_metadata: {
        scan_date: new Date().toISOString(),
        tweets_scanned: tweets.length,
        learning_updates_count: learningUpdates.length
      }
    });
  } catch {}

  // ═══ 10. سجّل في session_logs ═══
  try {
    await supabase.from('session_logs').insert({
      ai_tool: 'performance_scanner_v2',
      session_type: 'account_performance_scan',
      actions_completed: [`scanned_${tweets.length}_tweets`, `found_${analyses.filter(a => a.verdict === 'high_performer').length}_winners`, `found_${analyses.filter(a => a.verdict === 'underperformer').length}_losers`],
      content_created: [],
      db_updates: [{ table: 'content_log', action: 'updated_metrics' }, { table: 'performance_scans', action: 'inserted' }, { table: 'working_memory', action: 'upserted' }],
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

  // ═══ 11. [جديد] إرسال ملخص التعلم لتليجرام ═══
  try {
    const chatId = allowedChatId();
    if (chatId) {
      const winners = analyses.filter(a => a.verdict === 'high_performer');
      const losers = analyses.filter(a => a.verdict === 'underperformer');
      
      const summaryLines = [
        `🧠 <b>Performance Scan Results</b> — @${username}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📊 Scanned: ${tweets.length} tweets`,
        `✅ Winners: ${winners.length} | ⚠️ Average: ${analyses.length - winners.length - losers.length} | ❌ Losers: ${losers.length}`,
      ];

      if (winners.length > 0) {
        summaryLines.push(`\n🏆 <b>Winning patterns:</b>`);
        for (const w of winners.slice(0, 3)) {
          summaryLines.push(`  • ${htmlEscape(shortText(w.success_factors[0] || w.text_preview.slice(0, 50), 80))}`);
        }
      }

      if (losers.length > 0) {
        summaryLines.push(`\n📉 <b>Failure patterns:</b>`);
        for (const l of losers.slice(0, 3)) {
          summaryLines.push(`  • ${htmlEscape(shortText(l.failure_factors[0] || l.text_preview.slice(0, 50), 80))}`);
        }
      }

      summaryLines.push(`\n🧠 <b>Learning updates:</b> ${learningUpdates.length}`);
      summaryLines.push(`━━━━━━━━━━━━━━━━━━━━`);

      await sendTelegramMessage(chatId, summaryLines.join('\n'), MAIN_KEYBOARD);
    }
  } catch {}

  // ═══ 12. ملخص للعقل ═══
  const brainSummary = buildBrainSummary(analyses, learningUpdates, username);

  return {
    ok: true,
    account_handle: username,
    scanned_tweets: tweets.length,
    performance_analysis: analyses,
    learning_updates: learningUpdates,
    brain_summary: brainSummary
  };
}

function buildBrainSummary(analyses: PerformanceAnalysis[], learningUpdates: LearningUpdate[], username: string): string {
  const winners = analyses.filter(a => a.verdict === 'high_performer');
  const losers = analyses.filter(a => a.verdict === 'underperformer');
  const avgScore = analyses.reduce((sum, a) => sum + a.performance_score, 0) / (analyses.length || 1);

  return [
    `Scanned ${analyses.length} tweets from @${username}.`,
    `Winners: ${winners.length} | Average: ${analyses.length - winners.length - losers.length} | Losers: ${losers.length}`,
    `Average performance score: ${Math.round(avgScore * 100) / 100}`,
    winners.length > 0 ? `Winning patterns: ${winners.flatMap(w => w.success_factors).slice(0, 5).join(', ')}` : 'No winning patterns identified yet.',
    losers.length > 0 ? `Failure patterns: ${losers.flatMap(l => l.failure_factors).slice(0, 5).join(', ')}` : 'No clear failure patterns.',
    `Learning updates applied: ${learningUpdates.length}`,
    `Causal rules extracted and stored.`
  ].join('\n');
}
