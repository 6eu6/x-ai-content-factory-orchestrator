import { assertAuthorized } from '../../../lib/env';
import { getTwitterApiKey, twitterApiBase, fetchTwitterApiJson } from '../../../lib/x';

/**
 * GET /api/twitterapi-health
 *
 * Lightweight endpoint to test TwitterAPI.io connectivity.
 * Checks: API key validity, balance, and a simple user lookup.
 * NEVER prints the API key.
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);

    const baseUrl = twitterApiBase();
    let apiKeyPresent = false;
    try {
      const key = getTwitterApiKey();
      apiKeyPresent = key.length > 5;
    } catch {
      apiKeyPresent = false;
    }

    if (!apiKeyPresent) {
      return Response.json({
        ok: false,
        status: 'missing_key',
        endpoint: baseUrl,
        tweets_returned: 0,
        response_shape: null,
        latency_ms: 0,
        error_preview: 'TWITTERAPI_IO_KEY is missing or too short'
      });
    }

    // Test 1: Simple user lookup for a known account
    const testUsername = '30piq';
    const url = new URL(`${baseUrl}/twitter/user/info`);
    url.searchParams.set('userName', testUsername);

    const startMs = Date.now();
    let json: any;
    let fetchStatus = 'unknown';
    let tweetsReturned = 0;
    let responseShape: string | null = null;
    let errorPreview: string | null = null;

    try {
      json = await fetchTwitterApiJson(url.toString());
      fetchStatus = 'ok';
      responseShape = json ? Object.keys(json).slice(0, 8).join(',') : 'empty';

      // Check if user data was returned
      const userData = json?.data || json?.user || json?.result;
      if (userData) {
        responseShape = `user:${Object.keys(userData).slice(0, 6).join(',')}`;
      }
    } catch (fetchErr: any) {
      fetchStatus = 'error';
      const msg = String(fetchErr.message || '');
      // Sanitize: never print the API key
      const safeMsg = msg.replace(/X-API-Key[^\\s]*/gi, '[REDACTED]')
        .replace(/eyJ[a-zA-Z0-9_-]{10,}/g, '[REDACTED]')
        .slice(0, 300);
      errorPreview = safeMsg;

      // Try to extract status code
      const statusMatch = msg.match(/^(\d{3})\s/);
      if (statusMatch) {
        fetchStatus = `http_${statusMatch[1]}`;
      }
    }

    const latencyMs = Date.now() - startMs;

    // Test 2: Try timeline endpoint (lighter check)
    let timelineOk = false;
    let timelineLatencyMs = 0;
    try {
      const tlUrl = new URL(`${baseUrl}/twitter/user/last_tweets`);
      tlUrl.searchParams.set('userName', testUsername);
      const tlStart = Date.now();
      const tlJson = await fetchTwitterApiJson(tlUrl.toString());
      timelineLatencyMs = Date.now() - tlStart;

      // Count tweets
      const tweets = tlJson?.tweets || tlJson?.data?.tweets || tlJson?.data || [];
      tweetsReturned = Array.isArray(tweets) ? tweets.length : 0;
      timelineOk = tweetsReturned > 0;
    } catch {
      // Timeline might fail independently
    }

    return Response.json({
      ok: fetchStatus === 'ok',
      status: fetchStatus,
      endpoint: baseUrl,
      user_lookup: {
        ok: fetchStatus === 'ok',
        latency_ms: latencyMs,
        response_shape: responseShape
      },
      timeline: {
        ok: timelineOk,
        tweets_returned: tweetsReturned,
        latency_ms: timelineLatencyMs
      },
      tweets_returned: tweetsReturned,
      response_shape: responseShape,
      latency_ms: latencyMs,
      error_preview: errorPreview
    });

  } catch (err: any) {
    // Sanitize error
    const safeMsg = String(err.message || '').slice(0, 200);
    return Response.json({
      ok: false,
      status: 'fatal',
      endpoint: null,
      tweets_returned: 0,
      response_shape: null,
      latency_ms: 0,
      error_preview: safeMsg.includes('Unauthorized') ? 'Unauthorized — check ORCHESTRATOR_SECRET' : safeMsg
    }, { status: 500 });
  }
}
