import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { getTwitterApiKey, twitterApiBase, fetchTwitterApiJson } from '../../../lib/x';

const VERSION = 'debug-twitterapi-v1';

function mask(key: string) {
  if (!key) return null;
  return { length: key.length, prefix: key.slice(0, 4), suffix: key.slice(-4) };
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const key = getTwitterApiKey();
    const base = twitterApiBase();
    const url = new URL(`${base}/twitter/user/last_tweets`);
    url.searchParams.set('userName', 'emollick');
    url.searchParams.set('includeReplies', 'false');
    let apiResult: any = null;
    try {
      const json = await fetchTwitterApiJson(url.toString());
      apiResult = {
        ok: true,
        keys: Object.keys(json || {}),
        tweets_count: Array.isArray(json?.tweets) ? json.tweets.length : null,
        first_tweet_keys: Array.isArray(json?.tweets) && json.tweets[0] ? Object.keys(json.tweets[0]) : []
      };
    } catch (e: any) {
      apiResult = { ok: false, error: e.message };
    }
    return Response.json({
      ok: true,
      version: VERSION,
      env: {
        base,
        TWITTERAPI_IO_KEY: mask(key),
        TWITTERAPI_IO_BASE_URL: optionalEnv('TWITTERAPI_IO_BASE_URL', ''),
        TWITTERAPI_IO_MIN_DELAY_MS: optionalEnv('TWITTERAPI_IO_MIN_DELAY_MS', '')
      },
      apiResult
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message });
  }
}
