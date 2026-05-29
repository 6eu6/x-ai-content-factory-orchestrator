import { assertAuthorized } from '../../../lib/env';
import { getRunCostSummary, formatSummaryText, formatSummaryJson } from '../../../lib/run-cost-summary';

/**
 * GET /api/cost-summary
 *
 * Phase 2A: Authenticated cost + rejection summary for a pipeline run.
 *
 * Query params:
 *   ?id=<uuid>     — run ID (required)
 *   ?format=json   — return JSON (default)
 *   ?format=text   — return plain text (for Telegram/console)
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const runId = url.searchParams.get('id');

    if (!runId) {
      return Response.json({ ok: false, error: 'Missing required param: id' }, { status: 400 });
    }

    const summary = await getRunCostSummary(runId);

    // Fill accepted_count from decision_payload if available
    try {
      const { getPipelineRun } = await import('../../../lib/pipeline-run-tracker');
      const run = await getPipelineRun(runId);
      if (run?.decision_payload?.gate_accepted) {
        summary.accepted_count = run.decision_payload.gate_accepted;
      }
    } catch {}

    const format = url.searchParams.get('format') || 'json';
    if (format === 'text') {
      return new Response(formatSummaryText(summary), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    return Response.json({ ok: true, ...formatSummaryJson(summary) });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
