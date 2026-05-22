import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserByUsername } from '../../../lib/x';
import { generateDailyContentPack } from '../../../lib/content';
import { GROWTH_OPERATOR_VERSION, enrichGrowthOperatorPack } from '../../../lib/growth';
import { evaluateContentQuality } from '../../../lib/quality';

const ORCHESTRATOR_VERSION = `${GROWTH_OPERATOR_VERSION}+viral-memory+quality-gate`;

function uniqueActions(actions: string[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = String(action || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualityAwareActions(actions: string[], qualityResults: any[]) {
  const readyCount = qualityResults.filter((q) => q?.status === 'ready').length;
  if (readyCount === 0) {
    const reasons = Array.from(new Set(qualityResults.flatMap((q) => q?.reasons || []))).join(', ') || 'quality gate failed';
    return [
      `Do not publish generated tweets. Quality gate failed: ${reasons}.`,
      'Run research-intel-v4 or add source-backed evidence before regenerating daily-run.',
      'Rewrite needs_review tweets into source-backed or opinion-only content, then re-run daily-run.',
      'Use viral memory only as structure; do not publish factual claims without source URLs.'
    ];
  }
  return uniqueActions(actions).filter((action) => !/publish the 3 approved tweets/i.test(action) || readyCount === 3);
}

export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const username = optionalEnv('X_USERNAME', '30piq');

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

    const [accountState, requirements, targets, recentContent, creatorIntel, trends, viralRuns, viralTweets, viralPatterns] = await Promise.all([
      supabase.from('account_state').select('*').eq('account_handle', username).maybeSingle(),
      supabase.from('requirement_status').select('*').order('priority', { ascending: true }).limit(50),
      supabase.from('target_plans').select('*').eq('active', true).order('priority', { ascending: true }).limit(50),
      supabase.from('content_log').select('*').neq('publish_status', 'rejected').order('published_at', { ascending: false }).limit(30),
      supabase.from('creator_intel').select('*').neq('status', 'rejected').order('created_at', { ascending: false }).limit(20),
      supabase.from('trends').select('*').eq('covered', false).not('notes', 'ilike', 'true%').not('notes', 'ilike', 'false%').order('heat_score', { ascending: false }).limit(20),
      supabase.from('viral_scan_runs').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('viral_tweet_analyses').select('*').not('tweet_type', 'is', null).order('engagement_per_1k_followers', { ascending: false }).limit(30),
      supabase.from('viral_account_patterns').select('*').not('rule', 'in', '(true,false,[object Object])').order('confidence_score', { ascending: false }).order('created_at', { ascending: false }).limit(30)
    ]);

    const viralMemory = {
      recent_scan_runs: viralRuns.data || [],
      high_performing_tweet_analyses: viralTweets.data || [],
      high_confidence_patterns: viralPatterns.data || [],
      usage_rule: 'Use viral memory as mechanics only. Do not copy creator wording, claims, or examples.'
    };

    const rawContentPack = await generateDailyContentPack({
      accountState: { db: accountState.data, xSnapshot },
      targets: targets.data,
      requirements: requirements.data,
      recentContent: recentContent.data,
      creatorIntel: { creator_intel: creatorIntel.data, trends: trends.data, viral_memory: viralMemory }
    });
    const contentPack = enrichGrowthOperatorPack(rawContentPack);

    const singleTweets = Array.isArray(contentPack.single_tweets) ? contentPack.single_tweets : [];
    const replies = Array.isArray(contentPack.reply_targets_strategy) ? contentPack.reply_targets_strategy : [];
    const quotes = Array.isArray(contentPack.quote_tweet_strategy) ? contentPack.quote_tweet_strategy : [];
    const qualityResults = singleTweets.map((tweet: any) => evaluateContentQuality(tweet));
    const readyCount = qualityResults.filter((q) => q.status === 'ready').length;
    const actions = qualityAwareActions(Array.isArray(contentPack.next_actions) ? contentPack.next_actions : [], qualityResults);

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
      notes: `Generated by daily-run API ${ORCHESTRATOR_VERSION}. Ready: ${readyCount}/${singleTweets.length}. Quality statuses: ${qualityResults.map((q) => q.status).join(',')}.`
    }, { onConflict: 'checkin_date' }).select('*').single();
    if (runError) throw runError;

    if (singleTweets.length) {
      const { error: contentError } = await supabase.from('content_log').insert(singleTweets.map((t: any, index: number) => {
        const quality = qualityResults[index] || { status: 'needs_review', reasons: ['missing_quality_result'] };
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

    if (actions.length) {
      await supabase.from('action_queue').insert(actions.map((instruction: string, index: number) => ({
        priority: index + 1,
        action_type: readyCount ? 'human_publish_or_engage' : 'quality_review_or_research',
        title: `Growth daily action ${index + 1}`,
        instruction,
        prepared_content: JSON.stringify({ ...contentPack, quality_gate: qualityResults, ready_count: readyCount }),
        status: 'pending',
        assigned_to: 'human_operator'
      })));
    }

    const { data: pendingActions } = await supabase
      .from('action_queue')
      .select('id,priority,action_type,title,instruction,status,assigned_to,created_at')
      .eq('status', 'pending')
      .ilike('title', 'Growth daily action%')
      .order('created_at', { ascending: false })
      .order('priority', { ascending: true })
      .limit(7);

    const sessionLog = await insertSessionLog({
      actions_completed: ['daily_run', ORCHESTRATOR_VERSION, 'x_check_attempted', 'used_research_intel', 'used_viral_memory', 'quality_gate_applied', 'publish_actions_blocked_when_not_ready'],
      content_created: singleTweets.map((tweet: any, index: number) => ({ ...tweet, quality_gate: qualityResults[index] })),
      db_updates: [{ table: 'daily_checkins', id: runRow.id }, { table: 'content_log', rows: singleTweets.length }],
      pending_tasks: actions,
      next_recommendation: readyCount ? 'Publish only content with publish_status=ready.' : 'Do not publish. Run research-intel-v4 or rewrite into source-backed/opinion-only content first.'
    });

    return Response.json({
      ok: true,
      orchestrator_version: ORCHESTRATOR_VERSION,
      xSnapshot,
      research_context: { trends: trends.data, creator_intel: creatorIntel.data, viral_memory: viralMemory },
      contentPack: { ...contentPack, quality_gate: qualityResults, ready_count: readyCount, safe_to_publish: readyCount > 0 },
      daily_checkin: runRow,
      sessionLog,
      pendingActions: pendingActions || []
    });
  } catch (err: any) {
    return Response.json({ ok: false, orchestrator_version: ORCHESTRATOR_VERSION, error: err.message }, { status: 500 });
  }
}
