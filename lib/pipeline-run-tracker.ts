/**
 * pipeline-run-tracker.ts — Non-destructive pipeline run tracking
 *
 * Every helper catches its own DB errors and never crashes the main pipeline.
 * Tracking is observability, not a dependency.
 */

import { supabaseAdmin } from './supabase';

// ═══ Types ═══

export type PipelineRunCreateInput = {
  source: string;
  account_handle?: string;
  initialStatus?: string;  // Default: 'running' for backward compat, 'queued' for pipeline queue
};

export type PipelineRunUpdateInput = {
  status?: string;
  current_step?: string;
  scan_payload?: Record<string, any>;
  decision_payload?: Record<string, any>;
  telegram_payload?: Record<string, any>;
};

export type PipelineRunLogEntry = {
  ts: string;
  step: string;
  message: string;
  meta?: Record<string, any>;
};

// ═══ Helpers ═══

/**
 * Create a new pipeline_runs row with status 'running'.
 * Returns the run id, or null on failure.
 */
export async function createPipelineRun(input: PipelineRunCreateInput): Promise<string | null> {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_runs')
      .insert({
        source: input.source,
        status: input.initialStatus || 'running',
        current_step: input.initialStatus === 'queued' ? 'queued' : 'init',
        account_handle: input.account_handle || null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) {
      console.error('[pipeline-run-tracker] createPipelineRun DB error:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err: any) {
    console.error('[pipeline-run-tracker] createPipelineRun exception:', err.message);
    return null;
  }
}

/**
 * Update a pipeline_runs row (status, current_step, payloads).
 * Never throws.
 */
export async function updatePipelineRun(runId: string | null, update: PipelineRunUpdateInput): Promise<void> {
  if (!runId) return;
  try {
    const supabase = supabaseAdmin();
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString()
    };
    if (update.status) payload.status = update.status;
    if (update.current_step) payload.current_step = update.current_step;
    if (update.scan_payload) payload.scan_payload = update.scan_payload;
    if (update.decision_payload) payload.decision_payload = update.decision_payload;
    if (update.telegram_payload) payload.telegram_payload = update.telegram_payload;

    const { error } = await supabase
      .from('pipeline_runs')
      .update(payload)
      .eq('id', runId);

    if (error) {
      console.error('[pipeline-run-tracker] updatePipelineRun DB error:', error.message);
    }
  } catch (err: any) {
    console.error('[pipeline-run-tracker] updatePipelineRun exception:', err.message);
  }
}

/**
 * Append a log entry to the pipeline_runs.debug_log JSONB array.
 * Reads the current array, appends, and writes back.
 * Never throws.
 */
export async function appendPipelineRunLog(
  runId: string | null,
  message: string,
  meta?: Record<string, any>
): Promise<void> {
  if (!runId) return;
  try {
    const supabase = supabaseAdmin();
    // Read current debug_log
    const { data: row } = await supabase
      .from('pipeline_runs')
      .select('debug_log')
      .eq('id', runId)
      .maybeSingle();

    const current: PipelineRunLogEntry[] = Array.isArray(row?.debug_log) ? row.debug_log : [];
    const entry: PipelineRunLogEntry = {
      ts: new Date().toISOString(),
      step: '',  // filled by caller context if needed
      message,
      ...(meta ? { meta } : {})
    };

    // Keep only last 100 entries to avoid unbounded growth
    const updated = [...current, entry].slice(-100);

    const { error } = await supabase
      .from('pipeline_runs')
      .update({
        debug_log: updated,
        updated_at: new Date().toISOString()
      })
      .eq('id', runId);

    if (error) {
      console.error('[pipeline-run-tracker] appendPipelineRunLog DB error:', error.message);
    }
  } catch (err: any) {
    console.error('[pipeline-run-tracker] appendPipelineRunLog exception:', err.message);
  }
}

/**
 * Mark pipeline as completed successfully.
 * Never throws.
 */
export async function completePipelineRun(
  runId: string | null,
  payload?: {
    scan_payload?: Record<string, any>;
    decision_payload?: Record<string, any>;
    telegram_payload?: Record<string, any>;
  }
): Promise<void> {
  if (!runId) return;
  try {
    const supabase = supabaseAdmin();
    const update: Record<string, any> = {
      status: 'completed',
      current_step: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (payload?.scan_payload) update.scan_payload = payload.scan_payload;
    if (payload?.decision_payload) update.decision_payload = payload.decision_payload;
    if (payload?.telegram_payload) update.telegram_payload = payload.telegram_payload;

    const { error } = await supabase
      .from('pipeline_runs')
      .update(update)
      .eq('id', runId);

    if (error) {
      console.error('[pipeline-run-tracker] completePipelineRun DB error:', error.message);
    }
  } catch (err: any) {
    console.error('[pipeline-run-tracker] completePipelineRun exception:', err.message);
  }
}

/**
 * Mark pipeline as failed.
 * Never throws.
 */
export async function failPipelineRun(
  runId: string | null,
  error: any,
  currentStep?: string
): Promise<void> {
  if (!runId) return;
  try {
    const supabase = supabaseAdmin();
    const update: Record<string, any> = {
      status: 'failed',
      failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: String(error?.message || error || 'Unknown error').slice(0, 2000),
      error_stack: error?.stack ? String(error.stack).slice(0, 4000) : null
    };
    if (currentStep) update.current_step = currentStep;

    const { error: dbError } = await supabase
      .from('pipeline_runs')
      .update(update)
      .eq('id', runId);

    if (dbError) {
      console.error('[pipeline-run-tracker] failPipelineRun DB error:', dbError.message);
    }
  } catch (err: any) {
    console.error('[pipeline-run-tracker] failPipelineRun exception:', err.message);
  }
}

/**
 * Get a single pipeline run by id.
 * Returns null on failure.
 */
export async function getPipelineRun(runId: string): Promise<any | null> {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();

    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Get latest pipeline runs.
 * Returns empty array on failure.
 */
export async function getLatestPipelineRuns(limit = 10): Promise<any[]> {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('id, source, status, current_step, account_handle, started_at, updated_at, completed_at, failed_at, error_message, scan_payload, decision_payload, telegram_payload')
      .order('started_at', { ascending: false })
      .limit(Math.min(limit, 50));

    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Mark pipeline runs that have been "running" for too long as "stuck".
 * A run is considered stuck if status='running' and updated_at is older than staleMinutes.
 * Returns the number of runs marked as stuck.
 */
export async function markStuckPipelineRuns(staleMinutes = 10): Promise<number> {
  try {
    const supabase = supabaseAdmin();
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

    // Find running runs with stale updated_at
    const { data: stuckRuns, error: findError } = await supabase
      .from('pipeline_runs')
      .select('id, current_step')
      .eq('status', 'running')
      .lt('updated_at', cutoff);

    if (findError || !stuckRuns?.length) return 0;

    // Mark each as stuck with improved diagnostics
    let marked = 0;
    for (const run of stuckRuns) {
      // Phase S1: Look up actual task states for this run to produce better diagnostics
      let taskInfo = '';
      try {
        const { data: runTasks } = await supabase
          .from('pipeline_tasks')
          .select('task_type, status, error_message')
          .eq('run_id', run.id);

        if (runTasks && runTasks.length > 0) {
          // Check for failed tasks first (most actionable)
          const failedTasks = runTasks.filter((t: any) => t.status === 'failed');
          if (failedTasks.length > 0) {
            const failedInfo = failedTasks.map((t: any) =>
              `${t.task_type}${t.error_message ? ': ' + String(t.error_message).slice(0, 80) : ''}`
            ).join(', ');
            taskInfo = ` — failed task(s): ${failedInfo}`;
          } else {
            // No failed tasks — check for running/stuck tasks
            const activeTasks = runTasks.filter((t: any) => t.status === 'running' || t.status === 'stuck');
            if (activeTasks.length > 0) {
              const activeInfo = activeTasks.map((t: any) => `${t.task_type} (${t.status})`).join(', ');
              taskInfo = ` — active task(s): ${activeInfo}`;
            } else {
              // No failed or active tasks — check for stuck tasks
              const stuckTasks = runTasks.filter((t: any) => t.status === 'stuck');
              if (stuckTasks.length > 0) {
                const stuckInfo = stuckTasks.map((t: any) => t.task_type).join(', ');
                taskInfo = ` — stuck task(s): ${stuckInfo}`;
              }
            }
          }
        }
      } catch (taskErr: any) {
        // Don't let task lookup failure prevent marking as stuck
        console.warn(`[pipeline-run-tracker] Failed to look up tasks for stuck run ${run.id}: ${taskErr?.message}`);
      }

      // Build error message based on actual task state
      const currentStep = run.current_step || 'unknown';
      let errorMessage: string;

      if (taskInfo.includes('failed task')) {
        // Actual failed task exists — don't assume timeout
        errorMessage = `Pipeline stuck at step "${currentStep}" for >${staleMinutes}min${taskInfo}`;
      } else if (taskInfo.includes('active task') || taskInfo.includes('stuck task')) {
        // Active or stuck tasks found — likely worker died mid-processing
        errorMessage = `Pipeline stuck at step "${currentStep}" for >${staleMinutes}min — worker may have died${taskInfo}`;
      } else {
        // No task info available — assume timeout (original behavior)
        errorMessage = `Pipeline stuck at step "${currentStep}" for >${staleMinutes}min — likely Vercel serverless timeout`;
      }

      const { error: updateError } = await supabase
        .from('pipeline_runs')
        .update({
          status: 'stuck',
          error_message: errorMessage,
          updated_at: new Date().toISOString()
        })
        .eq('id', run.id);
      if (!updateError) marked++;
    }
    return marked;
  } catch (err: any) {
    console.error('[pipeline-run-tracker] markStuckPipelineRuns exception:', err.message);
    return 0;
  }
}

/**
 * Start a heartbeat that updates pipeline run's updated_at every intervalMs.
 * Returns a stop function to clear the interval.
 * This lets us detect if the serverless function is still alive.
 */
export function startPipelineHeartbeat(runId: string | null, intervalMs = 30000): () => void {
  if (!runId) return () => {};
  const timer = setInterval(async () => {
    try {
      const supabase = supabaseAdmin();
      await supabase
        .from('pipeline_runs')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', runId);
    } catch {
      // heartbeat must never crash the pipeline
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
