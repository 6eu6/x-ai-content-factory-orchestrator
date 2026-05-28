import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { enqueuePipelineRun } from '../../../lib/pipeline-queue';

/**
 * GET/POST /api/daily-run
 *
 * ENQUEUE-ONLY: Creates a pipeline run with tasks in the Supabase queue.
 * Does NOT call runDailyPipeline directly.
 * The persistent worker (scripts/pipeline-worker.ts) processes the tasks.
 */
export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'daily_run';

    const result = await enqueuePipelineRun({
      source,
      notifyTelegram: true,
      runSource: source
    });

    if (!result.ok) {
      return Response.json({
        ok: false,
        error: result.message,
        run_id: result.run_id,
        already_active: result.already_active
      }, { status: result.already_active ? 409 : 500 });
    }

    return Response.json({
      ok: true,
      run_id: result.run_id,
      status: result.status,
      worker_mode: 'supabase_queue',
      task_count: result.task_count,
      message: result.message,
      already_active: result.already_active
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
