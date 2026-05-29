/**
 * cost-context.ts — Phase 2A: AsyncLocalStorage-based cost context propagation
 *
 * Problem: callModel() and fetchTwitterApiJson() are called 3-4 levels deep
 * from processTask() in pipeline-worker.ts. The task has run_id and task_id,
 * but passing them through every function signature (content-engine-v3,
 * discoverOpportunities, craftEngagement, etc.) would require modifying
 * 44+ call sites and change function signatures across many files.
 *
 * Solution: AsyncLocalStorage holds the current cost context (run_id, task_id).
 * The pipeline worker sets the context when it starts processing a task.
 * callModel() and fetchTwitterApiJson() read it automatically.
 * Non-pipeline callers (API routes, daily-runner) still work — they just
 * don't set the context, and cost rows will have null run_id/task_id.
 *
 * This is the same pattern used by Next.js for request context, and by
 * observability libraries (OpenTelemetry) for trace propagation.
 */

import { AsyncLocalStorage } from 'async_hooks';

// ═══ Types ═══

export type CostContext = {
  run_id: string | null;
  task_id: string | null;
  task_type: string | null;
};

// ═══ Storage ═══

const costContextStore = new AsyncLocalStorage<CostContext>();

// ═══ API ═══

/**
 * Get the current cost context from AsyncLocalStorage.
 * Returns a default empty context if no context is set (non-pipeline callers).
 */
export function getCostContext(): CostContext {
  const store = costContextStore.getStore();
  return store || { run_id: null, task_id: null, task_type: null };
}

/**
 * Run a function within a cost context. All callModel() and fetchTwitterApiJson()
 * calls within `fn` (and its async descendants) will pick up this context.
 *
 * Usage in pipeline-worker.ts:
 *   const result = await withCostContext(
 *     { run_id: task.run_id, task_id: task.id, task_type: task.task_type },
 *     () => processTask(task)
 *   );
 */
export function withCostContext<T>(context: CostContext, fn: () => Promise<T>): Promise<T> {
  return costContextStore.run(context, fn);
}

/**
 * Set a specific field on the current cost context.
 * Useful when the context needs to be updated mid-task (e.g. after lockNextTask
 * provides the task details).
 */
export function updateCostContext(patch: Partial<CostContext>): void {
  const store = costContextStore.getStore();
  if (store) {
    if (patch.run_id !== undefined) store.run_id = patch.run_id;
    if (patch.task_id !== undefined) store.task_id = patch.task_id;
    if (patch.task_type !== undefined) store.task_type = patch.task_type;
  }
}
