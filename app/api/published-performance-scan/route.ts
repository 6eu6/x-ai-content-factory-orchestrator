import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { scoreXTweet } from '../../../lib/x';

const VERSION = 'published-performance-scan-v3';

/**
 * Normalize raw tweet data from any TwitterAPI.io response shape
 * into a consistent format with public_metrics.
 *
 * TwitterAPI.io returns different shapes depending on endpoint:
 * - /twitter/tweets → raw keys: likeCount, viewCount, replyCount, etc.
 * - /twitter/tweet/advanced_search → same raw keys
 * - /twitter/user/last_tweets → data.tweets array with same raw keys
 *
 * This function unifies them into the shape scoreXTweet expects.
 */
function normalizeRawTweet(raw: any) {
  if (!raw) return null;

  // Already normalized (has public_metrics object)
  if (raw.public_metrics && typeof raw.public_metrics === 'object') {
    return raw;
  }

  return {
    id: String(raw.id || raw.tweetId || raw.rest_id || ''),
    text: raw.text || raw.full_text || raw.content || '',
    public_metrics: {
      like_count: Number(raw.likeCount || raw.likes || raw.favorite_count || 0),
      reply_count: Number(raw.replyCount || raw.replies || raw.reply_count || 0),
      retweet_count: Number(raw.retweetCount || raw.retweets || raw.retweet_count || 0),
      quote_count: Number(raw.quoteCount || raw.quotes || raw.quote_count || 0),
      bookmark_count: Number(raw.bookmarkCount || raw.bookmarks || 0),
      view_count: Number(raw.viewCount || raw.views || 0)
    }
  };
}

/**
 * Extract tweets from any TwitterAPI.io response shape.
 * Handles: top-level .tweets, nested .data.tweets, .data array, direct array, etc.
 */
function extractTweetsFromResponse(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json)) return json;

  const candidates = [
    json.tweets,                        // /twitter/tweets → { tweets: [...] }
    json.data?.tweets,                  // /twitter/user/last_tweets → { data: { tweets: [...] } }
    json.result?.tweets,
    json.results,
    json.data,                          // /twitter/tweet/advanced_search sometimes wraps in data
    json.result
  ];

  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }

  return [];
}

function extractTweetIdFromUrl(url: string): string | null {
  const match = url.match(/status\/(\d+)/i);
  return match ? match[1] : null;
}

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
    const failed: Array<{
      id: string;
      published_url: string;
      tweet_id: string | null;
      endpoint: string | null;
      status: number | null;
      error: string;
      response_preview: string | null;
    }> = [];

    const { fetchTwitterApiJson, twitterApiBase: getBase } = await import('../../../lib/x');
    const base = getBase();

    for (const pub of unchecked) {
      checked++;

      try {
        // ── Extract tweet ID from URL ──
        const tweetId = extractTweetIdFromUrl(pub.published_url);
        if (!tweetId) {
          failed.push({
            id: pub.id,
            published_url: pub.published_url,
            tweet_id: null,
            endpoint: null,
            status: null,
            error: 'Could not extract tweet ID from URL',
            response_preview: null
          });
          continue;
        }

        // ── Strategy 1: /twitter/tweets?tweet_ids=xxx (batch lookup) ──
        let normalizedTweet: any = null;
        let usedEndpoint: string | null = null;

        try {
          const batchUrl = `${base}/twitter/tweets?tweet_ids=${tweetId}`;
          const batchJson = await fetchTwitterApiJson(batchUrl);
          const rawTweets = extractTweetsFromResponse(batchJson);
          if (rawTweets && rawTweets.length > 0) {
            normalizedTweet = normalizeRawTweet(rawTweets[0]);
            usedEndpoint = '/twitter/tweets';
          }
        } catch {
          // batch endpoint failed, try next
        }

        // ── Strategy 2: /twitter/tweet/advanced_search?query=id:xxx ──
        if (!normalizedTweet) {
          try {
            const searchUrl = `${base}/twitter/tweet/advanced_search?query=id:${tweetId}&queryType=Top`;
            const searchJson = await fetchTwitterApiJson(searchUrl);
            const rawTweets = extractTweetsFromResponse(searchJson);
            if (rawTweets && rawTweets.length > 0) {
              normalizedTweet = normalizeRawTweet(rawTweets[0]);
              usedEndpoint = '/twitter/tweet/advanced_search';
            }
          } catch {
            // search failed too
          }
        }

        if (!normalizedTweet) {
          failed.push({
            id: pub.id,
            published_url: pub.published_url,
            tweet_id: tweetId,
            endpoint: null,
            status: null,
            error: 'Tweet not found via any API endpoint',
            response_preview: null
          });
          continue;
        }

        // ── Build performance payload ──
        const m = normalizedTweet.public_metrics || {};
        const engagementScore = scoreXTweet(normalizedTweet);

        const performancePayload = {
          views: m.view_count || 0,
          likes: m.like_count || 0,
          replies: m.reply_count || 0,
          retweets: m.retweet_count || 0,
          quotes: m.quote_count || 0,
          bookmarks: m.bookmark_count || 0,
          engagement_score: Math.round(engagementScore * 100) / 100,
          checked_at: new Date().toISOString(),
          source_endpoint: usedEndpoint
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
          failed.push({
            id: pub.id,
            published_url: pub.published_url,
            tweet_id: tweetId,
            endpoint: usedEndpoint,
            status: null,
            error: updateError.message,
            response_preview: null
          });
        } else {
          updated++;
        }
      } catch (e: any) {
        // Extract error details without leaking secrets
        const safeMessage = String(e.message || 'Unknown error')
          .replace(/X-API-Key[=:]\s*\S+/gi, '[REDACTED]')
          .replace(/api[_-]?key[=:]\s*\S+/gi, '[REDACTED]');

        failed.push({
          id: pub.id,
          published_url: pub.published_url,
          tweet_id: extractTweetIdFromUrl(pub.published_url),
          endpoint: null,
          status: e.status || null,
          error: safeMessage,
          response_preview: null
        });
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
