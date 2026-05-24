import { optionalEnv } from '../../../lib/env';
import { getTwitterApiKey, twitterApiBase } from '../../../lib/x';

/**
 * GET /api/debug-tweet-raw?tweet_id=xxx
 * Returns the RAW response from TwitterAPI.io for a single tweet
 * مؤقت — للتشخيص فقط (مفتوح بدون سر)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tweetId = url.searchParams.get('tweet_id');
    if (!tweetId) return Response.json({ ok: false, error: 'tweet_id required' }, { status: 400 });

    const key = getTwitterApiKey();
    const base = twitterApiBase();

    // Try both endpoint formats
    const results: Record<string, any> = {};

    // Format 1: /twitter/tweets?tweet_ids=xxx
    try {
      const res1 = await fetch(`${base}/twitter/tweets?tweet_ids=${tweetId}`, {
        headers: { 'X-API-Key': key }
      });
      const json1 = await res1.json();
      results.format1_tweets = {
        status: res1.status,
        topLevelKeys: Object.keys(json1 || {}),
        body: json1
      };
    } catch (e: any) {
      results.format1_error = e.message;
    }

    // Format 2: /twitter/tweet/xxx (the old broken one)
    try {
      const res2 = await fetch(`${base}/twitter/tweet/${tweetId}`, {
        headers: { 'X-API-Key': key }
      });
      const json2 = await res2.json();
      results.format2_tweet = {
        status: res2.status,
        topLevelKeys: Object.keys(json2 || {}),
        body: json2
      };
    } catch (e: any) {
      results.format2_error = e.message;
    }

    return Response.json({ ok: true, tweet_id: tweetId, results });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
