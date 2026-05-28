import { assertAuthorized } from '../../../lib/env';
import { logPublishedDecision } from '../../../lib/published-decision-logger';

/**
 * POST /api/log-published-decision
 *
 * Thin authenticated wrapper around the shared logPublishedDecision function.
 * All core logic lives in lib/published-decision-logger.ts.
 * Telegram and other internal callers use logPublishedDecision() directly — no HTTP self-fetch.
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();

    const result = await logPublishedDecision({
      published_url: body.published_url,
      decision_run_id: body.decision_run_id || null,
      source_tweet_url: body.source_tweet_url || null,
      content_type: body.content_type || null,
      published_text: body.published_text || null,
      recommendation_index: body.recommendation_index || null
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error, version: result.version }, { status: result.status || 500 });
    }

    return Response.json(result);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
