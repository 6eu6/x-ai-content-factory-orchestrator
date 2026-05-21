import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const weekStartDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const weekEnd = new Date().toISOString().slice(0, 10);
    const [checkins, content, actions, account] = await Promise.all([
      supabase.from('daily_checkins').select('*').gte('checkin_date', weekStart).order('checkin_date', { ascending: false }),
      supabase.from('content_log').select('*').gte('published_at', weekStart).order('published_at', { ascending: false }),
      supabase.from('action_queue').select('*').gte('created_at', weekStart).order('created_at', { ascending: false }),
      supabase.from('account_state').select('*').eq('account_handle', '30piq').maybeSingle()
    ]);
    const completedActions = (actions.data || []).filter((a: any) => a.status === 'done').length;
    const pendingActions = (actions.data || []).filter((a: any) => a.status !== 'done').length;
    const postsCount = (content.data || []).length;
    const { data, error } = await supabase.from('weekly_reviews').upsert({
      week_start: weekStart,
      week_end: weekEnd,
      followers_start: account.data?.followers_count ?? null,
      followers_end: account.data?.followers_count ?? null,
      net_followers: 0,
      posts_count: postsCount,
      replies_count: (checkins.data || []).reduce((sum: number, r: any) => sum + (r.replies_posted || 0), 0),
      quotes_count: (checkins.data || []).reduce((sum: number, r: any) => sum + (r.quotes_posted || 0), 0),
      lessons_learned: ['Compare planned actions against published URLs.', 'Use top-performing content as next week seed.'],
      next_week_strategy: `Completed actions: ${completedActions}. Pending actions: ${pendingActions}.`,
      status: 'open'
    }, { onConflict: 'week_start' }).select('*').single();
    if (error) throw error;
    await insertSessionLog({ actions_completed: ['weekly_review'], db_updates: [{ table: 'weekly_reviews', id: data.id }] });
    return Response.json({ ok: true, weekly_review: data, checkins: checkins.data, actions: actions.data });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
