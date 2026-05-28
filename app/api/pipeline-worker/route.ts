import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { processPipelineTaskBatch } from '../../../lib/pipeline-worker';

/**
 * GET/POST /api/pipeline-worker
 *
 * Fallback/manual worker endpoint. Processes a small batch of tasks from the queue.
 * Protected by assertAuthorized (ORCHESTRATOR_SECRET).
 *
 * This is NOT the main worker — the persistent scripts/pipeline-worker.ts is.
 * This endpoint is for manual intervention or Vercel cron-based micro-batches.
 *
 * Query params:
 *   ?maxTasks=1    — Max tasks to process (default 1, max 10)
 *   ?maxRuntime=30000  — Max runtime in ms (default 30000, max 120000)
 *   ?runId=<uuid>  — Only process tasks for this specific run
 */
export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);

    const maxTasks = Math.min(Number(url.searchParams.get('maxTasks') || '1'), 10);
    const maxRuntimeMs = Math.min(Number(url.searchParams.get('maxRuntime') || '30000'), 120000);
    const runId = url.searchParams.get('runId') || undefined;

    const workerId = `api-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await processPipelineTaskBatch({
      workerId,
      maxTasks,
      maxRuntimeMs,
      runId
    });

    return Response.json({
      ok: result.ok,
      worker_id: result.worker_id,
      tasks_processed: result.tasks_processed,
      tasks_completed: result.tasks_completed,
      tasks_failed: result.tasks_failed,
      tasks_retried: result.tasks_retried,
      runtime_ms: result.runtime_ms,
      stopped_reason: result.stopped_reason,
      errors: result.errors
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
