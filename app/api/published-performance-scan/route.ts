import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { scoreXTweet } from '../../../lib/x';

const VERSION = 'published-performance-scan-v2';

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') || 10)));

    // ── Find unchecked published decisions ──
    const { data: unchecked, error: fetchError } = await supabase
      .from('published_decisions')
      .select('id, published_url, created_at, performance_checked_at')
      .is('performance_checked_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (fetchError) {
      return Response.json({ ok: false, version: VERSION, error: fetchError.message }, { status: 500 });
    }

    if (!unchecked || unchecked.length === 0) {
      return Response.json({
        ok: true,
        version: VERSION,
        checked: 0,
        updated: 0,
        failed: [],
        message: 'No published decisions pending performance check'
      });
    }

    // ── Fetch performance for each ──
    let checked = 0;
    let updated = 0;
    const failed: Array<{ id: string; error: string }> = [];

    const { fetchTwitterApiJson, extractTweets, twitterApiBase: getBase } = await import('../../../lib/x');
    const base = getBase();

    for (const pub of unchecked) {
      checked++;

      try {
        // Extract tweet ID from URL
        const statusMatch = pub.published_url.match(/status\/(\d+)/i);
        if (!statusMatch) {
          failed.push({ id: pub.id, error: 'Could not extract tweet ID from URL' });
          continue;
        }

        const tweetId = statusMatch[1];

        // Strategy 1: Try /twitter/tweets?tweet_ids=xxx (batch lookup)
        let tweet: any = null;

        try {
          const batchUrl = `${base}/twitter/tweets?tweet_ids=${tweetId}`;
          const batchJson = await fetchTwitterApiJson(batchUrl);
          const batchTweets = extractTweets(batchJson);
          if (batchTweets && batchTweets.length > 0) {
            tweet = batchTweets[0];
          }
        } catch {
          // batch endpoint failed, try next
        }

        // Strategy 2: Try /twitter/tweet/advanced_search?query=id:xxx
        if (!tweet) {
          try {
            const searchUrl = `${base}/twitter/tweet/advanced_search?query=id:${tweetId}&queryType=Top`;
            const searchJson = await fetchTwitterApiJson(searchUrl);
            const searchTweets = extractTweets(searchJson);
            if (searchTweets && searchTweets.length > 0) {
              tweet = searchTweets[0];
            }
          } catch {
            // search failed too
          }
        }

        if (!tweet) {
          failed.push({ id: pub.id, error: 'Tweet not found via any API endpoint' });
          continue;
        }

        // ── Build performance payload ──
        const m = tweet.public_metrics || {};
        const engagementScore = scoreXTweet(tweet);

        const performancePayload = {
          views: m.view_count || 0,
          likes: m.like_count || 0,
          replies: m.reply_count || 0,
          retweets: m.retweet_count || 0,
          quotes: m.quote_count || 0,
          bookmarks: m.bookmark_count || 0,
          engagement_score: Math.round(engagementScore * 100) / 100,
          checked_at: new Date().toISOString()
        };

        const { error: updateError } = await supabase
          .from('published_decisions')
          .update({
            performance_payload: performancePayload,
            performance_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', pub.id);

        if (updateError) {
          failed.push({ id: pub.id, error: updateError.message });
        } else {
          updated++;
        }
      } catch (e: any) {
        failed.push({ id: pub.id, error: e.message || 'Unknown error' });
      }
    }

    return Response.json({
      ok: true,
      version: VERSION,
      checked,
      updated,
      failed
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
