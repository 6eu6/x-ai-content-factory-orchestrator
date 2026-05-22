import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserByUsername } from '../../../lib/x';
import { generateDailyContentPack } from '../../../lib/content';

const ORCHESTRATOR_VERSION = 'safe-v5-operator-pack';

export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

function enrichOperatorPack(pack: any) {
  return {
    ...pack,
    operator_summary: pack.operator_summary || {
      account_goal: 'Grow @30piq as an English AI x Productivity x Career Growth account with real engagement and original content.',
      role: 'AI content factory operator, not only tweet generator.',
      constraint: 'No fake claims, no copied creator content, no spam, no invented metrics.'
    },
    final_recommendation: pack.final_recommendation || {
      action: 'publish_today_pack',
      reason: 'The current account phase needs consistent positioning, useful short-form content, and manual engagement logging.',
      publish_count: Array.isArray(pack.single_tweets) ? pack.single_tweets.length : 0,
      reply_count: Array.isArray(pack.reply_targets_strategy) ? pack.reply_targets_strategy.length : 0,
      quote_count: Array.isArray(pack.quote_tweet_strategy) ? pack.quote_tweet_strategy.length : 0
    },
    article_decision: pack.article_decision || {
      needed: false,
      reason: 'No long-form article is required today unless a topic needs a detailed tutorial, documentation, or a public reference asset.',
      title: '',
      outline: [],
      draft: ''
    },
    github_decision: pack.github_decision || {
      needed: false,
      reason: 'No GitHub asset is required today unless the content needs a public checklist, template, workflow, dataset, code sample, or proof layer.',
      repo_name: '',
      asset_type: '',
      readme_outline: ''
    },
    media_plan: pack.media_plan || {
      needed: false,
      format: 'none',
      visual_prompt: '',
      reason: 'Text-only is enough unless the content needs a diagram, visual checklist, or demo screenshot.'
    },
    research_plan: pack.research_plan || {
      required_before_publish: false,
      search_queries: [],
      sources_to_check: [],
      reason: 'No external factual claim is being made in the default pack.'
    },
    publishing_plan: pack.publishing_plan || [
      { item: 'tweet_1', best_time_utc: pack.single_tweets?.[0]?.best_time_utc || '13:00', action: 'publish' },
      { item: 'tweet_2', best_time_utc: pack.single_tweets?.[1]?.best_time_utc || '15:00', action: 'publish' },
      { item: 'tweet_3', best_time_utc: pack.single_tweets?.[2]?.best_time_utc || '17:00', action: 'publish' }
    ],
    supabase_logging_plan: pack.supabase_logging_plan || {
      after_publish: ['content_log.tweet_url', 'content_log.publish_status', 'daily_checkins.tweets_posted', 'daily_stats.tweets_posted'],
      after_engagement: ['daily_checkins.replies_posted', 'daily_checkins.quotes_posted'],
      after_metrics: ['content_log.views', 'content_log.likes', 'content_log.replies', 'content_log.reposts', 'content_log.bookmarks', 'content_log.performance_score']
    },
    next_actions: pack.next_actions || [
      'Review final_recommendation before publishing.',
      'Publish approved tweets manually.',
      'Use prepared replies only on relevant creator posts.',
      'Create GitHub asset only if github_decision.needed is true.',
      'Write or publish article only if article_decision.needed is true.',
      'Log URLs and metrics after publishing.'
    ]
  };
}

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
        last_known_source: 'daily_run_x_api'
      }, { onConflict: 'account_handle' });
    } catch (e: any) {
      xSnapshot = { warning: 'X live check failed or skipped', error: e.message };
    }

    const [accountState, requirements, targets, recentContent, creatorIntel] = await Promise.all([
      supabase.from('account_state').select('*').eq('account_handle', username).maybeSingle(),
      supabase.from('requirement_status').select('*').order('priority', { ascending: true }).limit(50),
      supabase.from('target_plans').select('*').eq('active', true).order('priority', { ascending: true }).limit(50),
      supabase.from('content_log').select('*').order('published_at', { ascending: false }).limit(20),
      supabase.from('creator_intel').select('*').order('created_at', { ascending: false }).limit(20)
    ]);

    const rawContentPack = await generateDailyContentPack({
      accountState: { db: accountState.data, xSnapshot },
      targets: targets.data,
      requirements: requirements.data,
      recentContent: recentContent.data,
      creatorIntel: creatorIntel.data
    });
    const contentPack = enrichOperatorPack(rawContentPack);

    const singleTweets = Array.isArray(contentPack.single_tweets) ? contentPack.single_tweets : [];
    const replies = Array.isArray(contentPack.reply_targets_strategy) ? contentPack.reply_targets_strategy : [];
    const quotes = Array.isArray(contentPack.quote_tweet_strategy) ? contentPack.quote_tweet_strategy : [];

    const { data: runRow, error: runError } = await supabase.from('daily_checkins').upsert({
      checkin_date: new Date().toISOString().slice(0, 10),
      execution_mode: contentPack.mode || 'partial',
      account_checked: Boolean(xSnapshot),
      account_check_source: xSnapshot?.warning ? 'skipped_or_failed' : 'x_api',
      profile_requirements_checked: true,
      daily_targets_checked: true,
      weekly_targets_checked: true,
      content_pack_created: true,
      tweets_planned: singleTweets.length,
      replies_planned: replies.length,
      quotes_planned: quotes.length,
      github_assets_created: contentPack.github_decision?.needed ? 1 : 0,
      next_priority: contentPack.today_goal || 'Publish prepared content and log URLs.',
      notes: `Generated by daily-run API ${ORCHESTRATOR_VERSION}.`
    }, { onConflict: 'checkin_date' }).select('*').single();
    if (runError) throw runError;

    if (singleTweets.length) {
      await supabase.from('content_log').insert(singleTweets.map((t: any) => ({
        content_type: 'single_tweet',
        topic: contentPack.today_goal || 'AI productivity career growth',
        hook_text: t.text?.slice(0, 240) || null,
        final_text: t.text || null,
        target_audience: 'English-speaking AI productivity career growth audience',
        originality_element: t.originality_element || 'Original safe angle',
        source_used: ORCHESTRATOR_VERSION,
        publish_status: 'ready',
        created_by_ai_tool: ORCHESTRATOR_VERSION,
        notes: t.why_it_works || null
      })));
    }

    const actions = Array.isArray(contentPack.human_checklist) ? contentPack.human_checklist : [];
    if (actions.length) {
      await supabase.from('action_queue').insert(actions.map((instruction: string, index: number) => ({
        priority: index + 1,
        action_type: 'human_publish_or_engage',
        title: `Safe daily action ${index + 1}`,
        instruction,
        prepared_content: JSON.stringify(contentPack),
        status: 'pending',
        assigned_to: 'human_operator'
      })));
    }

    const { data: pendingActions } = await supabase
      .from('action_queue')
      .select('id,priority,action_type,title,instruction,status,assigned_to,created_at')
      .eq('status', 'pending')
      .ilike('title', 'Safe daily action%')
      .order('created_at', { ascending: false })
      .order('priority', { ascending: true })
      .limit(4);

    const sessionLog = await insertSessionLog({
      actions_completed: ['daily_run', ORCHESTRATOR_VERSION, 'x_check_attempted', 'generated_content_pack', 'updated_daily_checkin'],
      content_created: singleTweets,
      db_updates: [{ table: 'daily_checkins', id: runRow.id }],
      pending_tasks: actions,
      next_recommendation: 'Review final_recommendation, publish approved assets, then log URLs and metrics.'
    });

    return Response.json({ ok: true, orchestrator_version: ORCHESTRATOR_VERSION, xSnapshot, contentPack, daily_checkin: runRow, sessionLog, pendingActions: pendingActions || [] });
  } catch (err: any) {
    return Response.json({ ok: false, orchestrator_version: ORCHESTRATOR_VERSION, error: err.message }, { status: 500 });
  }
}
