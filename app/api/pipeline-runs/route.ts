import { assertAuthorized } from '../../../lib/env';
import { getLatestPipelineRuns, getPipelineRun } from '../../../lib/pipeline-run-tracker';

/**
 * GET /api/pipeline-runs
 *
 * Authenticated status route for pipeline run observability.
 *
 * Query params:
 *   ?limit=10    — latest N runs (default 10, max 50)
 *   ?id=<uuid>   — single run by ID
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);

    const id = url.searchParams.get('id');
    if (id) {
      const run = await getPipelineRun(id);
      if (!run) {
        return Response.json({ ok: false, error: 'Pipeline run not found' }, { status: 404 });
      }
      return Response.json({ ok: true, run });
    }

    const limit = Math.min(Number(url.searchParams.get('limit') || '10'), 50);
    const runs = await getLatestPipelineRuns(limit);
    return Response.json({ ok: true, count: runs.length, runs });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
