import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { getXUserByUsername } from '../../../lib/x';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const username = body.username || optionalEnv('X_USERNAME', '30piq');
    const snapshot = await getXUserByUsername(username);
    const supabase = supabaseAdmin();
    const accountPayload = {
      account_handle: snapshot.username,
      x_url: `https://x.com/${snapshot.username}`,
      followers_count: snapshot.followers_count ?? null,
      following_count: snapshot.following_count ?? null,
      posts_count: snapshot.tweet_count ?? null,
      bio_text: snapshot.description ?? null,
      display_name: snapshot.name ?? null,
      profile_image_set: Boolean(snapshot.profile_image_url),
      verified_status: snapshot.verified === undefined ? 'unknown' : String(snapshot.verified),
      last_live_check_at: new Date().toISOString(),
      last_known_source: 'x_api'
    };
    const { data, error } = await supabase.from('account_state').upsert(accountPayload, { onConflict: 'account_handle' }).select('*').single();
    if (error) throw error;
    await insertSessionLog({ actions_completed: ['checked_x_account'], db_updates: [{ table: 'account_state', id: data.id }] });
    return Response.json({ ok: true, snapshot, account_state: data });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
