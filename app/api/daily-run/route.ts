import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { runDailyPipeline } from '../../../lib/daily-runner';

/**
 * GET/POST /api/daily-run
 *
 * Thin authenticated wrapper around the shared daily pipeline.
 * All orchestration logic lives in lib/daily-runner.ts.
 * Telegram and other internal callers use runDailyPipeline() directly — no HTTP self-fetch.
 */
export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'daily_run';

    const result = await runDailyPipeline({
      source,
      notifyTelegram: true
    });

    if (!result.ok) {
      return Response.json({
        ok: false,
        error: result.error,
        pipeline_run_id: result.pipeline_run_id,
        step_timings: result.step_timings
      }, { status: 500 });
    }

    return Response.json({
      ok: true,
      version: result.version,
      pipeline_run_id: result.pipeline_run_id,
      xSnapshot: result.xSnapshot,
      decision: {
        stage: result.stage,
        selected: result.decision.selected,
        held: result.decision.held,
        min_final_score: result.decision.min_final_score,
        rule_performance: result.decision.rule_performance,
        publish_gate: result.publishGate
      },
      scan: result.scan,
      step_timings: result.step_timings
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
