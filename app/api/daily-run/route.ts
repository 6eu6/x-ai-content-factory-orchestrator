import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserByUsername } from '../../../lib/x';
import { generateDailyContentPack } from '../../../lib/content';
import { GROWTH_OPERATOR_VERSION, enrichGrowthOperatorPack } from '../../../lib/growth';
import { evaluateContentQuality } from '../../../lib/quality';
import { shieldCheck } from '../../../lib/account-shield';
import { planDailyContent, generateContentByType, ContentType } from '../../../lib/content-type-engine';
import { prepareAndDeliverDailyPack } from '../../../lib/publishing-pipeline';

const ORCHESTRATOR_VERSION = `${GROWTH_OPERATOR_VERSION}+model-router+shield-v2+content-types-v2+media-pipeline-v2+publishing-v2+learning-loop-v2`;

/**
 * نوع المهمة الذكي — يحمل action_type صحيح حسب المحتوى
 */
type SmartAction = {
  action_type: string;
  instruction: string;
  priority: number;
};

function uniqueSmartActions(actions: SmartAction[]): SmartAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = String(action.instruction || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * qualityAwareSmartActions — يولد مهام ذكية حسب نتيجة الجودة
 *
 * التحسينات:
 * 1. لا يكرر مهام النشر اللي buildSmartActions يولدها
 * 2. التعليمات بالعربي للمستخدم
 * 3. مشاكل الجودة مترجمة ومفهومة
 * 4. لا يعرض أكواد داخلية
 */
function qualityAwareSmartActions(
  rawActions: any[],
  qualityResults: any[],
  singleTweets: any[],
  shieldResults: any[],
  contentPack: any
): SmartAction[] {
  const readyCount = qualityResults.filter((q) => q?.status === 'ready').length;
  const needsReviewCount = qualityResults.filter((q) => q?.status === 'needs_review').length;
  const actions: SmartAction[] = [];

  // ═══ لو كل شيء فشل — أضف خطوات عملية ═══
  if (readyCount === 0 && needsReviewCount > 0) {
    const allReasons = Array.from(new Set(qualityResults.flatMap((q: any) => q?.reasons || [])));
    const translatedReasons = allReasons.map((r: string) => translateQualityReason(r));
    actions.push({
      action_type: 'research',
      instruction: `لم تجتز أي تغريدة فحص الجودة. المشاكل: ${translatedReasons.join('، ')}. شغّل 🔎 اكتشاف تلقائي لجمع أبحاث موثقة، ثم أعد 🧪 تشغيل خطة اليوم.`,
      priority: 1
    });
  }

  // ═══ لو فيه محتوى يحتاج مراجعة، أضف مهمة مراجعة واحدة فقط ═══
  if (needsReviewCount > 0 && readyCount > 0) {
    const allReasons = Array.from(new Set(qualityResults.filter((q: any) => q?.status === 'needs_review').flatMap((q: any) => q?.reasons || [])));
    const translatedReasons = allReasons.map((r: string) => translateQualityReason(r));
    actions.push({
      action_type: 'review',
      instruction: `راجع ${needsReviewCount} تغريدة تحتاج تعديل. المشاكل: ${translatedReasons.join('، ')}. عدّلها وانشر يدوياً.`,
      priority: 2
    });
  }

  // ═══ أضف مهام من content pack — فقط الأنواع اللي ما أضفناها ═══
  const existingTypes = new Set(actions.map(a => a.action_type));
  if (Array.isArray(rawActions)) {
    for (const raw of rawActions) {
      // الشكل الجديد: كائن فيه action_type + instruction
      if (typeof raw === 'object' && raw.instruction) {
        const rawType = String(raw.action_type || 'engage').toLowerCase();
        // لا نكرر أنواع المهام اللي أضفناها بالفعل
        const normalizedType = rawType === 'human_publish_or_engage' ? 'publish' : rawType === 'quality_review_or_research' ? 'review' : rawType;
        if (existingTypes.has(normalizedType)) continue;
        // تنظيف التعليمة من الأكواد الداخلية
        const cleanInstr = cleanInstructionText(String(raw.instruction));
        actions.push({
          action_type: normalizedType,
          instruction: cleanInstr,
          priority: raw.priority || actions.length + 3
        });
        existingTypes.add(normalizedType);
      }
      // الشكل القديم: نص فقط
      else if (typeof raw === 'string' && raw.trim()) {
        // لا نضيف مهام نشر عامة لو أضفناها بالفعل
        if (/publish the \d+ (approved|safe|ready) tweets/i.test(raw) && existingTypes.has('publish')) continue;
        const cleanInstr = cleanInstructionText(raw);
        const type = existingTypes.has('engage') ? 'research' : 'engage';
        actions.push({
          action_type: type,
          instruction: cleanInstr,
          priority: actions.length + 3
        });
        existingTypes.add(type);
      }
    }
  }

  return uniqueSmartActions(actions).slice(0, 6);
}

/**
 * ترجمة أسباب فشل الجودة للعربي
 */
function translateQualityReason(reason: string): string {
  const map: Record<string, string> = {
    'claim_needs_source': 'يحتاج مصدر موثق',
    'generic_or_engagement_bait': 'محتوى عام',
    'first_person_claim': 'ادعاء شخصي غير موثق',
    'unsourced_claim': 'بدون مصدر',
    'hashtag_violation': 'يحتوي هاشتاقات',
    'too_short': 'قصير جداً',
    'instruction_instead_of_content': 'تعليمات بدل محتوى',
    'empty_content': 'محتوى فارغ',
    'missing_mechanics': 'بدون آلية واضحة',
  };
  return map[String(reason || '').toLowerCase().trim()] || String(reason || '');
}

/**
 * تنظيف نص التعليمة من الأكواد الداخلية
 */
function cleanInstructionText(raw: string): string {
  let text = raw.trim();
  // إزالة الأكواد بين أقواس مربعة
  text = text.replace(/\[(\w+)\]\s*/g, '');
  // إزالة بادئات الأكواد التقنية
  text = text.replace(/^(human_publish_or_engage|quality_review_or_research|publish|engage|review|research|create_asset|log_results)\s*[:\-—]?\s*/i, '');
  return text.trim();
}

export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const username = optionalEnv('X_USERNAME', '30piq');

    // ═══ 1. فحص الحساب ═══
    let xSnapshot: any = null;
    try {
      xSnapshot = await getXUserByUsername(username);
      await supabase.from('account_state').upsert({
        account_handle: username,
        x_url: `https://x.com/${username}`,
        followers_count: xSnapshot.followers_count ?? null,
        following_count: xSnapshot.following_count ?? null,
        posts_count: xSnapshot.tweet_count ?? null,
        bio_text: xSnapshot.description ?? null,
        display_name: xSnapshot.name ?? null,
        profile_image_set: Boolean(xSnapshot?.profile_image_url),
        verified_status: xSnapshot.verified === undefined ? 'unknown' : String(xSnapshot.verified),
        last_live_check_at: new Date().toISOString(),
        last_known_source: 'daily_run_twitterapi'
      }, { onConflict: 'account_handle' });
    } catch (e: any) {
      xSnapshot = { warning: 'X live check failed or skipped', error: e.message };
    }

    // ═══ 2. سحب كل البيانات ═══
    const [accountState, requirements, targets, recentContent, creatorIntel, trends, viralRuns, viralTweets, viralPatterns, algoRules, stylePatterns, mcpOpportunities] = await Promise.all([
      supabase.from('account_state').select('*').eq('account_handle', username).maybeSingle(),
      supabase.from('requirement_status').select('*').order('priority', { ascending: true }).limit(50),
      supabase.from('target_plans').select('*').eq('active', true).order('priority', { ascending: true }).limit(50),
      supabase.from('content_log').select('*').neq('publish_status', 'rejected').order('published_at', { ascending: false }).limit(30),
      supabase.from('creator_intel').select('*').neq('status', 'rejected').order('created_at', { ascending: false }).limit(20),
      supabase.from('trends').select('*').eq('covered', false).not('notes', 'ilike', 'true%').not('notes', 'ilike', 'false%').order('heat_score', { ascending: false }).limit(20),
      supabase.from('viral_scan_runs').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('viral_tweet_analyses').select('*').not('tweet_type', 'is', null).order('engagement_per_1k_followers', { ascending: false }).limit(30),
      supabase.from('viral_account_patterns').select('*').not('rule', 'in', '(true,false,[object Object])').order('confidence_score', { ascending: false }).order('created_at', { ascending: false }).limit(30),
      supabase.from('x_algorithm_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(25),
      supabase.from('viral_style_patterns').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(25),
      supabase.from('mcp_opportunity_map').select('*').eq('status', 'active').order('priority_score', { ascending: false }).limit(15)
    ]);

    const viralMemory = {
      recent_scan_runs: viralRuns.data || [],
      high_performing_tweet_analyses: viralTweets.data || [],
      high_confidence_patterns: viralPatterns.data || [],
      usage_rule: 'Use viral memory as mechanics only. Do not copy creator wording, claims, or examples.'
    };

    const learningMemory = {
      algorithm_rules: (algoRules.data || []).map((r: any) => ({
        rule_type: r.rule_type, rule: r.rule, evidence: r.evidence,
        applies_to: r.applies_to, confidence_score: r.confidence_score, source_type: r.source_type
      })),
      style_patterns: (stylePatterns.data || []).map((p: any) => ({
        pattern_type: p.pattern_type, pattern_name: p.pattern_name,
        pattern_description: p.pattern_description, example_structure: p.example_structure,
        why_it_works: p.why_it_works, risks: p.risks,
        adaptation_for_30piq: p.adaptation_for_30piq, confidence_score: p.confidence_score
      })),
      mcp_opportunities: (mcpOpportunities.data || []).map((m: any) => ({
        opportunity_area: m.opportunity_area, mcp_use_case: m.mcp_use_case,
        audience_segment: m.audience_segment, pain_point: m.pain_point,
        content_angles: m.content_angles, priority_score: m.priority_score, confidence_score: m.confidence_score
      })),
      usage_rule: 'Use algorithm rules to score and plan content. Use style patterns as mechanics for hooks, formats, and structures. Use MCP opportunities for repo/article decisions. Never copy source wording or claims.'
    };

    // ═══ 3. تخطيط محتوى متنوع (Content Type Engine) ═══
    const trendTopics = (trends.data || []).map((t: any) => ({
      topic: t.topic || t.title || 'AI productivity',
      source: t.source || '',
      heat_score: t.heat_score || 5
    }));

    let contentPlan: any = null;
    let diverseContent: any[] = [];
    try {
      contentPlan = await planDailyContent(trendTopics.length ? trendTopics : [{ topic: 'AI tools productivity career growth' }]);
      
      // ولّد محتوى لكل نوع في الخطة
      for (const item of contentPlan.items.slice(0, 6)) {
        try {
          const content = await generateContentByType(item.content_type, {
            topic: item.topic,
            score: item.score,
            accountState: accountState.data,
            learningMemory,
            viralMemory,
            sources: []
          });
          diverseContent.push({
            content_type: item.content_type,
            content,
            priority: item.priority,
            model_task: item.model_task
          });
        } catch (e: any) {
          diverseContent.push({
            content_type: item.content_type,
            content: { error: e.message },
            priority: item.priority,
            model_task: item.model_task
          });
        }
      }
    } catch (e: any) {
      contentPlan = { items: [], variety_check: { types_used: [], types_missing: [], recommendation: `Content planning failed: ${e.message}` } };
    }

    // ═══ 4. التوليد القديم (backward compatible) ═══
    const rawContentPack = await generateDailyContentPack({
      accountState: { db: accountState.data, xSnapshot },
      targets: targets.data,
      requirements: requirements.data,
      recentContent: recentContent.data,
      creatorIntel: { creator_intel: creatorIntel.data, trends: trends.data, viral_memory: viralMemory, learning_memory: learningMemory }
    });
    const contentPack = enrichGrowthOperatorPack(rawContentPack);

    // ═══ 5. Quality Gate + Account Shield ═══
    const singleTweets = Array.isArray(contentPack.single_tweets) ? contentPack.single_tweets : [];
    const replies = Array.isArray(contentPack.reply_targets_strategy) ? contentPack.reply_targets_strategy : [];
    const quotes = Array.isArray(contentPack.quote_tweet_strategy) ? contentPack.quote_tweet_strategy : [];
    
    // Quality gate قديم
    const qualityResults = singleTweets.map((tweet: any) => evaluateContentQuality(tweet));
    
    // Shield فحص جديد
    const shieldResults = await Promise.all(
      singleTweets.map((tweet: any) => shieldCheck({
        text: tweet.text || '',
        type: 'tweet',
        originality_element: tweet.originality_element,
        mechanic_used: tweet.mechanic_used,
        reply_trigger: tweet.reply_trigger,
        bookmark_trigger: tweet.bookmark_trigger
      }))
    );

    // دمج النتائج
    const combinedResults = qualityResults.map((q: any, i: number) => {
      const shield = shieldResults[i];
      if (!shield.passed) {
        return {
          ...q,
          status: 'needs_review' as const,
          reasons: [...(q.reasons || []), ...shield.checks.filter(c => !c.passed).map(c => c.name)]
        };
      }
      return q;
    });

    const readyCount = combinedResults.filter((q) => q.status === 'ready').length;
    const actions = qualityAwareSmartActions(
      Array.isArray(contentPack.next_actions) ? contentPack.next_actions : [],
      combinedResults,
      singleTweets,
      shieldResults,
      contentPack
    );

    // ═══ 6. تسجيل ═══
    const { data: runRow, error: runError } = await supabase.from('daily_checkins').upsert({
      checkin_date: new Date().toISOString().slice(0, 10),
      execution_mode: contentPack.mode || 'partial',
      account_checked: Boolean(xSnapshot),
      account_check_source: xSnapshot?.warning ? 'skipped_or_failed' : 'twitterapi',
      profile_requirements_checked: true,
      daily_targets_checked: true,
      weekly_targets_checked: true,
      content_pack_created: true,
      tweets_planned: readyCount,
      replies_planned: readyCount ? replies.length : 0,
      quotes_planned: readyCount ? quotes.length : 0,
      research_items_reviewed: Array.isArray(trends.data) ? trends.data.length : 0,
      creator_posts_analyzed: (Array.isArray(creatorIntel.data) ? creatorIntel.data.length : 0) + (Array.isArray(viralTweets.data) ? viralTweets.data.length : 0),
      github_assets_created: contentPack.github_decision?.needed ? 1 : 0,
      next_priority: readyCount ? contentPack.today_goal : 'No content is ready. Add source-backed research or rewrite needs_review items.',
      notes: `Generated by daily-run API ${ORCHESTRATOR_VERSION}. Ready: ${readyCount}/${singleTweets.length}. Quality: ${combinedResults.map((q) => q.status).join(',')}. Content types planned: ${contentPlan?.items?.map((i: any) => i.content_type).join(',') || 'none'}.`
    }, { onConflict: 'checkin_date' }).select('*').single();
    if (runError) throw runError;

    if (singleTweets.length) {
      const { error: contentError } = await supabase.from('content_log').insert(singleTweets.map((t: any, index: number) => {
        const quality = combinedResults[index] || { status: 'needs_review', reasons: ['missing_quality_result'] };
        const shield = shieldResults[index];
        return {
          content_type: 'single_tweet',
          topic: contentPack.today_goal || 'AI productivity career growth',
          hook_text: t.text?.slice(0, 240) || null,
          final_text: t.text || null,
          target_audience: 'English-speaking AI productivity career growth audience',
          originality_element: t.originality_element || t.why_this_is_not_generic || 'Original safe angle',
          source_used: ORCHESTRATOR_VERSION,
          publish_status: quality.status,
          notes: JSON.stringify({
            quality_gate: quality,
            shield_check: shield ? { passed: shield.passed, risk_level: shield.risk_level, summary: shield.summary } : null,
            why_it_works: t.why_it_works || null,
            mechanic_used: t.mechanic_used || null,
            viral_pattern_basis: t.viral_pattern_basis || null,
            reply_trigger: t.reply_trigger || null,
            bookmark_trigger: t.bookmark_trigger || null
          })
        };
      }));
      if (contentError) throw contentError;
    }

    // سجل المحتوى المتنوع
    if (diverseContent.length) {
      for (const item of diverseContent) {
        try {
          await supabase.from('content_log').insert({
            content_type: item.content_type,
            topic: item.content?.topic || item.content?.headline || item.content?.hook?.slice(0, 80) || 'diverse content',
            hook_text: (item.content?.text || item.content?.hook || item.content?.headline || '').slice(0, 240),
            final_text: JSON.stringify(item.content).slice(0, 2000),
            target_audience: 'English-speaking AI productivity career growth audience',
            originality_element: item.content?.originality_element || 'Generated via content type engine',
            source_used: `${ORCHESTRATOR_VERSION}+${item.model_task}`,
            publish_status: 'needs_review',
            notes: JSON.stringify({ content_type: item.content_type, priority: item.priority, model_task: item.model_task })
          });
        } catch {}
      }
    }

    if (actions.length) {
      // حذف ALL المهام المعلقة القديمة — مو بس القديمة أكثر من ساعتين
      // هذا يمنع تراكم المهام من تشغيلات سابقة
      try {
        await supabase.from('action_queue').delete().eq('status', 'pending');
      } catch {}
      // إدراج المهام الجديدة — كل مهمة بنوعها الصحيح + عنوان بالعربي
      const actionTypeLabels: Record<string, string> = {
        publish: 'نشر المحتوى',
        engage: 'التفاعل والردود',
        review: 'مراجعة الجودة',
        research: 'بحث وإكتشاف',
        create_asset: 'إنشاء أصل (GitHub/مقال)',
        log_results: 'تسجيل النتائج',
      };
      await supabase.from('action_queue').insert(actions.map((action: SmartAction, index: number) => ({
        priority: action.priority || index + 1,
        action_type: action.action_type,
        title: actionTypeLabels[action.action_type] || `مهمة: ${action.action_type}`,
        instruction: action.instruction,
        prepared_content: JSON.stringify({ ready_count: readyCount, quality_issues: combinedResults.filter(q => q.status === 'needs_review').flatMap((q: any) => q.reasons || []) }),
        status: 'pending',
        assigned_to: 'human_operator'
      })));
    }

    const { data: pendingActions } = await supabase
      .from('action_queue')
      .select('id,priority,action_type,title,instruction,status,assigned_to,created_at')
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .limit(8);

    const sessionLog = await insertSessionLog({
      actions_completed: ['daily_run', ORCHESTRATOR_VERSION, 'x_check_attempted', 'used_research_intel', 'used_viral_memory', 'quality_gate_applied', 'shield_applied', 'content_type_engine', 'model_router_active', 'media_pipeline', 'publishing_pipeline'],
      content_created: singleTweets.map((tweet: any, index: number) => ({ ...tweet, quality_gate: combinedResults[index], shield: shieldResults[index]?.passed })),
      db_updates: [{ table: 'daily_checkins', id: runRow.id }, { table: 'content_log', rows: singleTweets.length + diverseContent.length }],
      pending_tasks: actions,
      next_recommendation: readyCount ? 'Content delivered to Telegram. Publish manually. Then run account-performance-scan to measure results.' : 'Do not publish. Run research-intel-v4 or rewrite into source-backed/opinion-only content first.'
    });

    // ═══ 7. Publishing Pipeline — تسليم المحتوى المنسق لتليجرام ═══
    // تحسين: لا نرسل المحتوى المكرر — لو diverseContent يغطي النوع، لا نضيفه من النظام القديم
    // فلترة: لا نرسل العناصر اللي فيها أخطاء
    const diverseTypes = new Set(diverseContent.filter(d => !d.content?.error).map(d => d.content_type));
    const cleanDiverseContent = diverseContent.filter(d => !d.content?.error);
    const filteredContentPack = {
      ...contentPack,
      // لو diverseContent عنده single_tweet، لا نضيف تغريدات النظام القديم
      single_tweets: diverseTypes.has('single_tweet') ? [] : contentPack.single_tweets,
      // لو diverseContent عنده reply، لا نضيف ردود النظام القديم
      reply_targets_strategy: diverseTypes.has('reply') ? [] : contentPack.reply_targets_strategy,
      // لو diverseContent عنده quote_post، لا نضيف اقتباسات النظام القديم
      quote_tweet_strategy: diverseTypes.has('quote_post') ? [] : contentPack.quote_tweet_strategy,
    };
    let publishResult = null;
    try {
      publishResult = await prepareAndDeliverDailyPack(cleanDiverseContent, filteredContentPack);
    } catch (e: any) {
      publishResult = { ok: false, error: e.message };
    }

    // ═══ 8. Auto Performance Scan — مسح أداء الحساب بعد التوليد ═══
    let autoScanResult = null;
    const url = new URL(req.url);
    const shouldAutoScan = url.searchParams.get('auto_scan') === '1' || url.searchParams.get('scan') === '1';
    if (shouldAutoScan) {
      try {
        const { scanAccountPerformance } = await import('../../../lib/performance-feedback');
        autoScanResult = await scanAccountPerformance(10, username);
      } catch (e: any) {
        autoScanResult = { ok: false, error: e.message };
      }
    }

    return Response.json({
      ok: true,
      orchestrator_version: ORCHESTRATOR_VERSION,
      xSnapshot,
      research_context: { trends: trends.data, creator_intel: creatorIntel.data, viral_memory: viralMemory, learning_memory: learningMemory },
      contentPack: { ...contentPack, quality_gate: combinedResults, shield_results: shieldResults.map(s => ({ passed: s.passed, risk_level: s.risk_level, summary: s.summary, suggestions: s.suggestions })), ready_count: readyCount, safe_to_publish: readyCount > 0 },
      diverse_content: diverseContent,
      content_plan: contentPlan?.variety_check || null,
      publish_pack: publishResult,
      auto_performance_scan: autoScanResult,
      daily_checkin: runRow,
      sessionLog,
      pendingActions: pendingActions || []
    });
  } catch (err: any) {
    return Response.json({ ok: false, orchestrator_version: ORCHESTRATOR_VERSION, error: err.message }, { status: 500 });
  }
}
