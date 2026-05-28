import { assertAuthorized, optionalEnv, envNumber } from '../../../lib/env';
import { markStuckPipelineRuns } from '../../../lib/pipeline-run-tracker';
import { markStuckTasks, enqueuePipelineRun, getActivePipelineRun } from '../../../lib/pipeline-queue';
import { processPipelineTaskBatch } from '../../../lib/pipeline-worker';

/**
 * GET /api/cron-dispatcher
 *
 * Vercel cron-safe dispatcher. Does NOT scan X accounts directly.
 * Does NOT use lightMode/low limits as the permanent solution.
 *
 * Allowed operations:
 *   1. Mark stuck tasks/runs (housekeeping)
 *   2. Enqueue a scheduled run if no active run exists
 *   3. Optionally process a tiny batch through processPipelineTaskBatch
 */
export async function GET(req: Request) {
  const startedAt = Date.now();

  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'cron';
    const processBatch = url.searchParams.get('process') !== '0';  // default: process tiny batch

    // ═══ Housekeeping: mark stuck tasks and runs ═══
    let stuckTasksMarked = 0;
    let stuckRunsMarked = 0;
    try {
      stuckTasksMarked = await markStuckTasks(10);
      stuckRunsMarked = await markStuckPipelineRuns(10);
    } catch {}

    // ═══ Check for active run ═══
    const activeRun = await getActivePipelineRun();

    // ═══ If no active run, enqueue a new one ═══
    let enqueueResult = null;
    if (!activeRun) {
      try {
        enqueueResult = await enqueuePipelineRun({
          source: `cron_dispatcher:${source}`,
          notifyTelegram: true,
          runSource: `cron_dispatcher:${source}`
        });
      } catch (err: any) {
        enqueueResult = { ok: false, message: err.message };
      }
    }

    // ═══ Optionally process a tiny batch (1-3 tasks max) ═══
    let batchResult = null;
    if (processBatch) {
      try {
        const maxRuntimeMs = envNumber('CRON_MAX_RUNTIME_MS', 45000, 10000, 120000);
        batchResult = await processPipelineTaskBatch({
          workerId: `cron-dispatcher-${Date.now()}`,
          maxTasks: 3,
          maxRuntimeMs: Math.min(maxRuntimeMs, 40000)  // Leave buffer for response
        });
      } catch (err: any) {
        batchResult = { ok: false, error: err.message };
      }
    }

    return Response.json({
      ok: true,
      version: 'cron-dispatcher-v3-queue',
      source,
      housekeeping: {
        stuck_tasks_marked: stuckTasksMarked,
        stuck_runs_marked: stuckRunsMarked
      },
      active_run: activeRun ? {
        id: activeRun.id,
        status: activeRun.status,
        current_step: activeRun.current_step
      } : null,
      enqueue: enqueueResult ? {
        ok: enqueueResult.ok,
        run_id: enqueueResult.run_id,
        status: enqueueResult.status,
        task_count: enqueueResult.task_count
      } : null,
      batch: batchResult,
      runtime_ms: Date.now() - startedAt
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      error: err.message,
      runtime_ms: Date.now() - startedAt
    }, { status: 500 });
  }
}
