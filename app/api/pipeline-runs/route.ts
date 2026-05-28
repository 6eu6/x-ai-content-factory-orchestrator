import { assertAuthorized } from '../../../lib/env';
import { getLatestPipelineRuns, getPipelineRun, markStuckPipelineRuns } from '../../../lib/pipeline-run-tracker';
import { getPipelineRunStatus, markStuckTasks } from '../../../lib/pipeline-queue';

/**
 * GET /api/pipeline-runs
 *
 * Authenticated status route for pipeline run observability.
 *
 * Query params:
 *   ?limit=10         — latest N runs (default 10, max 50)
 *   ?id=<uuid>        — single run by ID (includes task details)
 *   ?includeTasks=1   — include task summary and latest tasks
 *   ?cleanup=1        — auto-mark stuck runs/tasks before returning results
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);

    // Auto-mark stuck runs/tasks if requested
    let stuckMarked = 0;
    if (url.searchParams.get('cleanup') === '1') {
      stuckMarked = await markStuckPipelineRuns(10);
      stuckMarked += await markStuckTasks(10);
    }

    const id = url.searchParams.get('id');
    const includeTasks = url.searchParams.get('includeTasks') === '1';

    if (id) {
      const run = await getPipelineRun(id);
      if (!run) {
        return Response.json({ ok: false, error: 'Pipeline run not found' }, { status: 404 });
      }

      // If includeTasks, fetch task details from the queue
      if (includeTasks) {
        const status = await getPipelineRunStatus(id);
        return Response.json({
          ok: true,
          run,
          task_summary: status.task_summary,
          tasks: status.tasks.slice(-20),  // Latest 20 tasks
          current_account: status.current_account,
          selected: status.selected,
          rejected: status.rejected,
          stuck_marked: stuckMarked
        });
      }

      return Response.json({ ok: true, run, stuck_marked: stuckMarked });
    }

    const limit = Math.min(Number(url.searchParams.get('limit') || '10'), 50);
    const runs = await getLatestPipelineRuns(limit);

    // If includeTasks, add task summary for each run
    if (includeTasks) {
      const runsWithTasks = await Promise.all(
        runs.map(async (run: any) => {
          try {
            const status = await getPipelineRunStatus(run.id);
            return {
              ...run,
              task_summary: status.task_summary,
              current_account: status.current_account
            };
          } catch {
            return run;
          }
        })
      );
      return Response.json({ ok: true, count: runsWithTasks.length, runs: runsWithTasks, stuck_marked: stuckMarked });
    }

    return Response.json({ ok: true, count: runs.length, runs, stuck_marked: stuckMarked });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
