import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { callModel, parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const username = optionalEnv('X_USERNAME', '30piq');
    const weekStartDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const weekEnd = new Date().toISOString().slice(0, 10);
    const [checkins, content, actions, account, prevReview, performanceScans] = await Promise.all([
      supabase.from('daily_checkins').select('*').gte('checkin_date', weekStart).order('checkin_date', { ascending: false }),
      supabase.from('content_log').select('*').gte('published_at', weekStart).order('published_at', { ascending: false }),
      supabase.from('action_queue').select('*').gte('created_at', weekStart).order('created_at', { ascending: false }),
      supabase.from('account_state').select('*').eq('account_handle', username).maybeSingle(),
      supabase.from('weekly_reviews').select('followers_end').order('week_start', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('performance_scans').select('summary,causal_findings').gte('created_at', weekStart).order('created_at', { ascending: false }).limit(5)
    ]);
    const completedActions = (actions.data || []).filter((a: any) => a.status === 'done').length;
    const pendingActions = (actions.data || []).filter((a: any) => a.status !== 'done').length;
    const postsCount = (content.data || []).length;
    const followersStart = (prevReview?.data as any)?.followers_end ?? account.data?.followers_count ?? null;
    const followersEnd = account.data?.followers_count ?? null;
    const netFollowers = (followersEnd != null && followersStart != null) ? followersEnd - followersStart : null;

    // Generate lessons and strategy using AI
    let lessonsLearned = ['Compare planned actions against published URLs.', 'Use top-performing content as next week seed.'];
    let nextWeekStrategy = `Completed actions: ${completedActions}. Pending actions: ${pendingActions}.`;
    try {
      const aiResponse = await callModel('research_synthesis', [
        { role: 'system', content: `You are a content strategy analyst for @${username}. Analyze the weekly data and provide actionable lessons and strategy. Return JSON only.` },
        { role: 'user', content: `Weekly data:
- Posts: ${postsCount}, Completed actions: ${completedActions}, Pending: ${pendingActions}
- Followers: ${followersStart} → ${followersEnd} (net: ${netFollowers ?? 'unknown'})
- Performance scans: ${JSON.stringify(performanceScans.data?.slice(0, 3))}
- Recent content statuses: ${(content.data || []).slice(0, 5).map((c: any) => `${c.content_type}:${c.publish_status}`).join(', ')}

Return JSON:
{
  "lessons_learned": ["lesson 1", "lesson 2", "lesson 3"],
  "next_week_strategy": "specific strategy based on data"
}` }
      ], { temperature: 0.15, max_tokens: 500 });
      const parsed = parseModelJson(aiResponse);
      if (parsed.lessons_learned?.length) lessonsLearned = parsed.lessons_learned;
      if (parsed.next_week_strategy) nextWeekStrategy = parsed.next_week_strategy;
    } catch {}

    const { data, error } = await supabase.from('weekly_reviews').upsert({
      week_start: weekStart,
      week_end: weekEnd,
      followers_start: followersStart,
      followers_end: followersEnd,
      net_followers: netFollowers ?? 0,
      posts_count: postsCount,
      replies_count: (checkins.data || []).reduce((sum: number, r: any) => sum + (r.replies_posted || 0), 0),
      quotes_count: (checkins.data || []).reduce((sum: number, r: any) => sum + (r.quotes_posted || 0), 0),
      lessons_learned: lessonsLearned,
      next_week_strategy: nextWeekStrategy,
      status: 'open'
    }, { onConflict: 'week_start' }).select('*').single();
    if (error) throw error;
    await insertSessionLog({ actions_completed: ['weekly_review', 'ai_strategy_generated'], db_updates: [{ table: 'weekly_reviews', id: data.id }] });
    return Response.json({ ok: true, weekly_review: data, checkins: checkins.data, actions: actions.data });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
