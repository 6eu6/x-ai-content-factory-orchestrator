/**
 * pipeline-queue.ts — Idempotent queue helpers for the durable pipeline architecture
 *
 * All heavy pipeline execution is moved out of Vercel/Telegram request lifecycle.
 * This module provides queue operations that are safe to call from Telegram webhook,
 * /api/daily-run, cron-dispatcher, and the persistent worker.
 *
 * Uses Supabase service role. Avoids double-processing via locked_at, locked_by,
 * attempts, and safe status transitions.
 */

import { supabaseAdmin } from './supabase';
import { optionalEnv, envNumber } from './env';
import {
  createPipelineRun,
  updatePipelineRun,
  completePipelineRun,
  failPipelineRun,
  appendPipelineRunLog,
  markStuckPipelineRuns
} from './pipeline-run-tracker';

// ═══ Types ═══

export type EnqueuePipelineRunOptions = {
  source?: string;
  accountLimit?: number;
  tweetsPerAccount?: number;
  notifyTelegram?: boolean;
  username?: string;
  runSource?: string;
  workerMode?: string;
};

export type PipelineTaskType =
  | 'load_account_state'
  | 'scan_account'
  | 'merge_scan_results'
  | 'opportunity_intelligence'  // Phase 2D: AI opportunity intelligence + candidate selection
  | 'enrich_opportunities'
  | 'quality_enhance'       // Phase 2B: Originality enhancer + numeric claim guard
  | 'opportunity_judge'     // Phase 2D: Pre-gate judge
  | 'publish_gate'
  | 'decision'
  | 'persist_decision'
  | 'telegram_delivery';

export type PipelineTaskRow = {
  id: string;
  run_id: string;
  task_type: PipelineTaskType;
  status: string;
  step_order: number;
  account_handle: string | null;
  payload: Record<string, any>;
  result: Record<string, any>;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_message: string | null;
  error_stack: string | null;
  created_at: string;
  updated_at: string;
};

export type LockNextTaskOptions = {
  /** Only lock tasks for this specific run_id */
  runId?: string;
  /** Only lock tasks of these types */
  taskTypes?: PipelineTaskType[];
  /** Lock duration in minutes before the task is considered stuck (default 10) */
  lockDurationMinutes?: number;
};

export type LockResult = {
  locked: boolean;
  task: PipelineTaskRow | null;
  reason?: string;
};

export type CancelResult = {
  ok: boolean;
  cancelled_run: boolean;
  cancelled_tasks: number;
  reason?: string;
};

export type RunStatusResult = {
  ok: boolean;
  run: Record<string, any> | null;
  tasks: PipelineTaskRow[];
  task_summary: {
    total: number;
    completed: number;
    failed: number;
    queued: number;
    running: number;
    stuck: number;
    cancelled: number;
  };
  current_account: string | null;
  selected: number | null;
  rejected: number | null;
};

// ═══ Constants ═══

const VALID_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'stuck'] as const;

/** Safe status transitions: from -> set of allowed to statuses */
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'stuck', 'cancelled']),
  stuck: new Set(['queued', 'failed', 'cancelled']),  // stuck -> queued = retry
  failed: new Set(['queued']),  // failed -> queued = retry
  completed: new Set([]),       // terminal
  cancelled: new Set([]),       // terminal
};

// ═══ Helper: safe status transition check ═══

function canTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

// ═══ 1. enqueuePipelineRun ═══

/**
 * Idempotently enqueue a new pipeline run.
 * If an active (queued/running/stuck) run already exists, return its status instead.
 * Creates the pipeline_runs row and then creates all pipeline_tasks.
 */
export async function enqueuePipelineRun(options: EnqueuePipelineRunOptions = {}): Promise<{
  ok: boolean;
  run_id: string | null;
  status: string;
  task_count: number;
  message: string;
  already_active?: boolean;
}> {
  const source = options.source || 'queue';
  const username = options.username || optionalEnv('X_USERNAME', '30piq');
  const accountLimit = options.accountLimit ?? envNumber('DAILY_SCAN_ACCOUNT_LIMIT', 10, 1, 30);
  const tweetsPerAccount = options.tweetsPerAccount ?? envNumber('DAILY_SCAN_TWEETS_PER_ACCOUNT', 8, 1, 25);
  const notifyTelegram = options.notifyTelegram ?? true;
  const runSource = options.runSource || source;
  const workerMode = options.workerMode || 'supabase_queue';

  // Check for active runs (queued, running, or stuck)
  const active = await getActivePipelineRun();
  if (active) {
    return {
      ok: true,
      run_id: active.id,
      status: active.status,
      task_count: 0,
      message: `Active run already exists (${active.status})`,
      already_active: true
    };
  }

  // Create the pipeline_runs row with status='queued' (not 'running')
  // The status transitions to 'running' when a worker locks the first task
  const runId = await createPipelineRun({
    source: runSource,
    account_handle: username,
    initialStatus: 'queued'
  });

  if (!runId) {
    return {
      ok: false,
      run_id: null,
      status: 'failed',
      task_count: 0,
      message: 'Failed to create pipeline run'
    };
  }

  // Set worker_mode on the run
  const supabase = supabaseAdmin();
  await supabase
    .from('pipeline_runs')
    .update({ worker_mode: workerMode, updated_at: new Date().toISOString() })
    .eq('id', runId);

  // Create all pipeline tasks
  const taskCount = await createPipelineTasks(runId, {
    accountLimit,
    tweetsPerAccount,
    notifyTelegram,
    username,
    source: runSource
  });

  // Update run with total_tasks
  await supabase
    .from('pipeline_runs')
    .update({ total_tasks: taskCount, updated_at: new Date().toISOString() })
    .eq('id', runId);

  return {
    ok: true,
    run_id: runId,
    status: 'queued',
    task_count: taskCount,
    message: `Pipeline run enqueued with ${taskCount} tasks`
  };
}

// ═══ 2. createPipelineTasks ═══

/**
 * Create all pipeline_tasks rows for a given run.
 * The task structure follows the required pipeline:
 *   1. load_account_state (global, step 10)
 *   2. scan_account (one per account, step 20+N)
 *   3. merge_scan_results (global, step 50, depends on all scan_account)
 *   4. opportunity_intelligence (global, step 55) — Phase 2D
 *   5. enrich_opportunities (global, step 60)
 *   6. quality_enhance (global, step 65) — Phase 2B
 *   7. opportunity_judge (global, step 68) — Phase 2D
 *   8. publish_gate (global, step 70)
 *   9. decision (global, step 80)
 *  10. persist_decision (global, step 90)
 *  11. telegram_delivery (global, step 100)
 *
 * Returns the number of tasks created.
 */
export async function createPipelineTasks(
  runId: string,
  options: {
    accountLimit: number;
    tweetsPerAccount: number;
    notifyTelegram: boolean;
    username: string;
    source: string;
  }
): Promise<number> {
  const supabase = supabaseAdmin();

  // Fetch accounts that will be scanned
  let accounts: { handle: string }[] = [];
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('handle')
      .order('last_checked', { ascending: true, nullsFirst: true })
      .order('tier', { ascending: true })
      .limit(options.accountLimit);

    if (!error && data?.length) {
      accounts = data;
    }
  } catch {}

  // If no accounts found, still create global tasks (they will detect no accounts and handle gracefully)
  if (!accounts.length) {
    accounts = [{ handle: options.username }];
  }

  const tasks: Record<string, any>[] = [];
  let stepOrder = 10;

  // Global: load_account_state
  tasks.push({
    run_id: runId,
    task_type: 'load_account_state',
    status: 'queued',
    step_order: stepOrder,
    account_handle: options.username,
    payload: {
      username: options.username,
      source: options.source
    }
  });
  stepOrder += 10;

  // Per-account: scan_account (one task per account)
  for (const account of accounts) {
    tasks.push({
      run_id: runId,
      task_type: 'scan_account',
      status: 'queued',
      step_order: stepOrder,
      account_handle: account.handle,
      payload: {
        account_handle: account.handle,
        tweets_per_account: options.tweetsPerAccount,
        source: options.source
      }
    });
    stepOrder += 1;
  }

  // Ensure global steps have enough gap
  stepOrder = Math.max(stepOrder, 50);

  // Global: merge_scan_results
  tasks.push({
    run_id: runId,
    task_type: 'merge_scan_results',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: {
      account_count: accounts.length,
      source: options.source
    }
  });
  stepOrder += 10;

  // Global: opportunity_intelligence (Phase 2D: after merge, before enrich)
  tasks.push({
    run_id: runId,
    task_type: 'opportunity_intelligence',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: { source: options.source }
  });
  stepOrder += 5;

  // Global: enrich_opportunities
  tasks.push({
    run_id: runId,
    task_type: 'enrich_opportunities',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: { source: options.source }
  });
  stepOrder += 5;

  // Global: quality_enhance (Phase 2B: after enrich, before judge)
  tasks.push({
    run_id: runId,
    task_type: 'quality_enhance',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: { source: options.source }
  });
  stepOrder += 3;

  // Global: opportunity_judge (Phase 2D: after quality_enhance, before publish_gate)
  tasks.push({
    run_id: runId,
    task_type: 'opportunity_judge',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: { source: options.source }
  });
  stepOrder += 2;

  // Global: publish_gate
  tasks.push({
    run_id: runId,
    task_type: 'publish_gate',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: { source: options.source }
  });
  stepOrder += 10;

  // Global: decision
  tasks.push({
    run_id: runId,
    task_type: 'decision',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: {
      username: options.username,
      source: options.source
    }
  });
  stepOrder += 10;

  // Global: persist_decision
  tasks.push({
    run_id: runId,
    task_type: 'persist_decision',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: {
      username: options.username,
      source: options.source
    }
  });
  stepOrder += 10;

  // Global: telegram_delivery
  tasks.push({
    run_id: runId,
    task_type: 'telegram_delivery',
    status: 'queued',
    step_order: stepOrder,
    account_handle: null,
    payload: {
      username: options.username,
      notify_telegram: options.notifyTelegram,
      source: options.source
    }
  });

  // Insert all tasks
  try {
    const { error } = await supabase
      .from('pipeline_tasks')
      .insert(tasks);

    if (error) {
      console.error('[pipeline-queue] createPipelineTasks insert error:', error.message);
      return 0;
    }
  } catch (err: any) {
    console.error('[pipeline-queue] createPipelineTasks exception:', err.message);
    return 0;
  }

  return tasks.length;
}

// ═══ 3. getActivePipelineRun ═══

/**
 * Get the currently active pipeline run (queued, running, or stuck).
 * Returns null if no active run exists.
 */
export async function getActivePipelineRun(): Promise<Record<string, any> | null> {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_runs')
      .select('id, source, status, current_step, account_handle, started_at, updated_at, worker_mode, total_tasks, completed_tasks, failed_tasks')
      .in('status', ['queued', 'running', 'stuck'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

// ═══ 4. cancelPipelineRun ═══

/**
 * Cancel an active/stuck/queued/running run and all its unfinished tasks.
 * Returns the number of tasks cancelled.
 */
export async function cancelPipelineRun(runId: string, reason: string = 'manual_cancel'): Promise<CancelResult> {
  const supabase = supabaseAdmin();
  let cancelledTasks = 0;

  try {
    // Cancel unfinished tasks for this run
    const unfinishedStatuses = ['queued', 'running', 'stuck'];
    const { data: tasks, error: findError } = await supabase
      .from('pipeline_tasks')
      .select('id, status')
      .eq('run_id', runId)
      .in('status', unfinishedStatuses);

    if (!findError && tasks?.length) {
      const { error: updateError } = await supabase
        .from('pipeline_tasks')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runId)
        .in('status', unfinishedStatuses);

      if (!updateError) {
        cancelledTasks = tasks.length;
      }
    }

    // Cancel the run itself
    const { error: runError } = await supabase
      .from('pipeline_runs')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', runId)
      .in('status', ['queued', 'running', 'stuck']);

    if (runError) {
      return {
        ok: false,
        cancelled_run: false,
        cancelled_tasks: cancelledTasks,
        reason: `Failed to cancel run: ${runError.message}`
      };
    }

    // Update run progress
    await updateRunProgress(runId);

    return {
      ok: true,
      cancelled_run: true,
      cancelled_tasks: cancelledTasks,
      reason
    };
  } catch (err: any) {
    return {
      ok: false,
      cancelled_run: false,
      cancelled_tasks: 0,
      reason: err.message
    };
  }
}

// ═══ 5. getPipelineRunStatus ═══

/**
 * Get the status of a pipeline run, including task summary.
 * If no runId is provided, returns the latest run.
 */
export async function getPipelineRunStatus(runId?: string): Promise<RunStatusResult> {
  const supabase = supabaseAdmin();

  try {
    // Get the run
    let run: Record<string, any> | null = null;
    if (runId) {
      const { data } = await supabase
        .from('pipeline_runs')
        .select('*')
        .eq('id', runId)
        .maybeSingle();
      run = data;
    } else {
      const { data } = await supabase
        .from('pipeline_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      run = data;
    }

    if (!run) {
      return {
        ok: false,
        run: null,
        tasks: [],
        task_summary: { total: 0, completed: 0, failed: 0, queued: 0, running: 0, stuck: 0, cancelled: 0 },
        current_account: null,
        selected: null,
        rejected: null
      };
    }

    // Get tasks for this run
    const { data: tasks, error: taskError } = await supabase
      .from('pipeline_tasks')
      .select('*')
      .eq('run_id', run.id)
      .order('step_order', { ascending: true });

    const taskList: PipelineTaskRow[] = (tasks || []) as PipelineTaskRow[];

    // Build task summary
    const taskSummary = {
      total: taskList.length,
      completed: taskList.filter(t => t.status === 'completed').length,
      failed: taskList.filter(t => t.status === 'failed').length,
      queued: taskList.filter(t => t.status === 'queued').length,
      running: taskList.filter(t => t.status === 'running').length,
      stuck: taskList.filter(t => t.status === 'stuck').length,
      cancelled: taskList.filter(t => t.status === 'cancelled').length
    };

    // Current account = the account_handle of the currently running/last scanned task
    const currentTask = taskList.find(t => t.status === 'running') ||
                        taskList.filter(t => t.task_type === 'scan_account' && t.status === 'completed').pop();
    const currentAccount = currentTask?.account_handle || null;

    // Extract selected/rejected from decision_payload or result_payload
    const dp = run.decision_payload || run.result_payload || {};
    const selected = dp.selected ?? dp.gate_accepted ?? null;
    const rejected = dp.rejected ?? dp.gate_rejected ?? null;

    return {
      ok: true,
      run,
      tasks: taskList,
      task_summary: taskSummary,
      current_account: currentAccount,
      selected: typeof selected === 'number' ? selected : null,
      rejected: typeof rejected === 'number' ? rejected : null
    };
  } catch (err: any) {
    return {
      ok: false,
      run: null,
      tasks: [],
      task_summary: { total: 0, completed: 0, failed: 0, queued: 0, running: 0, stuck: 0, cancelled: 0 },
      current_account: null,
      selected: null,
      rejected: null
    };
  }
}

// ═══ 6. lockNextTask ═══

/**
 * Lock the next eligible task for a worker to process.
 * Uses safe locking: only transitions from 'queued' or 'stuck' (retry) to 'running'.
 * Skips tasks for cancelled runs.
 * Skips global tasks (merge, enrich, etc.) if their prerequisites (scan_account) are not all completed.
 * Returns the locked task or null if no eligible task found.
 */
export async function lockNextTask(workerId: string, options: LockNextTaskOptions = {}): Promise<LockResult> {
  const supabase = supabaseAdmin();
  const lockDurationMinutes = options.lockDurationMinutes || 10;
  const lockCutoff = new Date(Date.now() - lockDurationMinutes * 60 * 1000).toISOString();

  try {
    // Build query for eligible tasks
    let query = supabase
      .from('pipeline_tasks')
      .select('id, run_id, task_type, status, step_order, account_handle, payload, attempts, max_attempts')
      .in('status', ['queued', 'stuck'])  // Only lock queued or stuck (for retry) tasks
      .order('step_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(20);  // Fetch a batch, we'll filter in code

    if (options.runId) {
      query = query.eq('run_id', options.runId);
    }
    if (options.taskTypes?.length) {
      query = query.in('task_type', options.taskTypes);
    }

    const { data: candidates, error: findError } = await query;

    if (findError || !candidates?.length) {
      return { locked: false, task: null, reason: 'No eligible tasks found' };
    }

    // Filter out tasks for cancelled runs
    for (const candidate of candidates) {
      // Check if the run is still active (not cancelled/completed/failed)
      const { data: runData } = await supabase
        .from('pipeline_runs')
        .select('status')
        .eq('id', candidate.run_id)
        .maybeSingle();

      if (!runData || ['cancelled', 'completed', 'failed'].includes(runData.status)) {
        continue;  // Skip tasks for inactive runs
      }

      // For global tasks (step_order >= 50 and no account_handle), check prerequisites
      const isGlobalTask = !candidate.account_handle && candidate.step_order >= 50;
      if (isGlobalTask) {
        const prerequisitesComplete = await areGlobalPrerequisitesMet(candidate.run_id, candidate.task_type);
        if (!prerequisitesComplete) {
          continue;  // Skip global task if prerequisites not met
        }
      }

      // Try to lock this task atomically using CAS (Compare-And-Swap)
      const now = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from('pipeline_tasks')
        .update({
          status: 'running',
          locked_at: now,
          locked_by: workerId,
          started_at: now,
          attempts: candidate.attempts + 1,
          updated_at: now
        })
        .eq('id', candidate.id)
        .in('status', ['queued', 'stuck'])  // CAS: only update if still in expected status
        .select('*')
        .maybeSingle();

      if (updateError || !updated) {
        // Another worker likely locked it, try next candidate
        continue;
      }

      // Transition pipeline_runs from 'queued' to 'running' on first task lock
      if (runData && runData.status === 'queued') {
        await supabase
          .from('pipeline_runs')
          .update({
            status: 'running',
            current_step: candidate.task_type,
            updated_at: now
          })
          .eq('id', candidate.run_id)
          .eq('status', 'queued');  // CAS: only transition if still queued
      }

      return {
        locked: true,
        task: updated as PipelineTaskRow,
        reason: 'Task locked successfully'
      };
    }

    return { locked: false, task: null, reason: 'No lockable tasks available after filtering' };
  } catch (err: any) {
    return { locked: false, task: null, reason: `Lock error: ${err.message}` };
  }
}

// ═══ Helper: Check if global task prerequisites are met ═══

async function areGlobalPrerequisitesMet(runId: string, taskType: string): Promise<boolean> {
  const supabase = supabaseAdmin();

  try {
    const { data: tasks, error } = await supabase
      .from('pipeline_tasks')
      .select('task_type, status')
      .eq('run_id', runId);

    if (error || !tasks) return false;

    // All scan_account tasks must be completed (or failed/cancelled) before global steps
    const scanTasks = tasks.filter((t: any) => t.task_type === 'scan_account');
    if (scanTasks.length === 0) return false;  // No scan tasks created yet

    const allScansDone = scanTasks.every((t: any) =>
      ['completed', 'failed', 'cancelled'].includes(t.status)
    );

    if (!allScansDone) return false;

    // For tasks after merge, check merge is done
    if (['opportunity_intelligence', 'enrich_opportunities', 'quality_enhance', 'opportunity_judge', 'publish_gate', 'decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const mergeTask = tasks.find((t: any) => t.task_type === 'merge_scan_results');
      if (mergeTask && mergeTask.status !== 'completed') return false;
    }

    // For tasks after opportunity_intelligence, check intelligence is done
    if (['enrich_opportunities', 'quality_enhance', 'opportunity_judge', 'publish_gate', 'decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const intelTask = tasks.find((t: any) => t.task_type === 'opportunity_intelligence');
      if (intelTask && intelTask.status !== 'completed') return false;
    }

    // For tasks after enrich, check enrich is done
    if (['quality_enhance', 'opportunity_judge', 'publish_gate', 'decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const enrichTask = tasks.find((t: any) => t.task_type === 'enrich_opportunities');
      if (enrichTask && enrichTask.status !== 'completed') return false;
    }

    // For tasks after quality_enhance, check quality_enhance is done
    if (['opportunity_judge', 'publish_gate', 'decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const qualityTask = tasks.find((t: any) => t.task_type === 'quality_enhance');
      if (qualityTask && qualityTask.status !== 'completed') return false;
    }

    // For tasks after opportunity_judge, check judge is done
    if (['publish_gate', 'decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const judgeTask = tasks.find((t: any) => t.task_type === 'opportunity_judge');
      if (judgeTask && judgeTask.status !== 'completed') return false;
    }

    // For tasks after publish_gate, check publish_gate is done
    if (['decision', 'persist_decision', 'telegram_delivery'].includes(taskType)) {
      const gateTask = tasks.find((t: any) => t.task_type === 'publish_gate');
      if (gateTask && gateTask.status !== 'completed') return false;
    }

    // For tasks after decision, check decision is done
    if (['persist_decision', 'telegram_delivery'].includes(taskType)) {
      const decisionTask = tasks.find((t: any) => t.task_type === 'decision');
      if (decisionTask && decisionTask.status !== 'completed') return false;
    }

    // For telegram_delivery, check persist is done
    if (taskType === 'telegram_delivery') {
      const persistTask = tasks.find((t: any) => t.task_type === 'persist_decision');
      if (persistTask && persistTask.status !== 'completed') return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ═══ 7. completeTask ═══

/**
 * Mark a task as completed with its result.
 * Only transitions from 'running' to 'completed'.
 * Updates the run progress after completing.
 */
export async function completeTask(taskId: string, result: Record<string, any>): Promise<{
  ok: boolean;
  error?: string;
}> {
  const supabase = supabaseAdmin();

  try {
    // CAS: only update if currently running
    const { data: updated, error } = await supabase
      .from('pipeline_tasks')
      .update({
        status: 'completed',
        result: result,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .eq('status', 'running')  // CAS guard
      .select('run_id')
      .maybeSingle();

    if (error) {
      return { ok: false, error: error.message };
    }
    if (!updated) {
      return { ok: false, error: 'Task not found or not in running status' };
    }

    // Update run progress
    await updateRunProgress(updated.run_id);

    // Check if run should be finalized
    await finalizeRunIfReady(updated.run_id);

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ═══ 8. failTask ═══

/**
 * Mark a task as failed.
 * If attempts < max_attempts, the task is re-queued for retry.
 * If attempts >= max_attempts, the task stays failed.
 * Updates the run progress after failing.
 */
export async function failTask(taskId: string, error: any): Promise<{
  ok: boolean;
  retried: boolean;
  error_message?: string;
}> {
  const supabase = supabaseAdmin();
  const errorMessage = String(error?.message || error || 'Unknown error').slice(0, 2000);
  const errorStack = error?.stack ? String(error.stack).slice(0, 4000) : null;

  try {
    // First, read the task to check attempts
    const { data: task, error: readError } = await supabase
      .from('pipeline_tasks')
      .select('id, run_id, attempts, max_attempts, status, locked_at, locked_by')
      .eq('id', taskId)
      .maybeSingle();

    if (readError || !task) {
      return { ok: false, retried: false, error_message: 'Task not found' };
    }

    if (task.status !== 'running') {
      return { ok: false, retried: false, error_message: `Task status is ${task.status}, not running` };
    }

    // Decide: retry or permanent failure
    const shouldRetry = task.attempts < task.max_attempts;
    const newStatus = shouldRetry ? 'queued' : 'failed';

    const { error: updateError } = await supabase
      .from('pipeline_tasks')
      .update({
        status: newStatus,
        error_message: errorMessage,
        error_stack: errorStack,
        failed_at: shouldRetry ? null : new Date().toISOString(),
        locked_at: shouldRetry ? null : task.locked_at,
        locked_by: shouldRetry ? null : task.locked_by,
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .eq('status', 'running');  // CAS guard

    if (updateError) {
      return { ok: false, retried: false, error_message: updateError.message };
    }

    // Update run progress
    await updateRunProgress(task.run_id);

    // If task is permanently failed, check if the run should be finalized
    if (!shouldRetry) {
      await finalizeRunIfReady(task.run_id);
    }

    return { ok: true, retried: shouldRetry };
  } catch (err: any) {
    return { ok: false, retried: false, error_message: err.message };
  }
}

// ═══ 9. markStuckTasks ═══

/**
 * Mark tasks that have been "running" for too long as "stuck".
 * A task is stuck if status='running' and locked_at is older than stuckAfterMinutes.
 * Also marks the corresponding run as stuck if it has stuck tasks.
 * Returns the number of tasks marked as stuck.
 */
export async function markStuckTasks(stuckAfterMinutes: number = 10): Promise<number> {
  const supabase = supabaseAdmin();

  try {
    const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000).toISOString();

    // Find running tasks with stale locked_at
    const { data: stuckTasks, error: findError } = await supabase
      .from('pipeline_tasks')
      .select('id, run_id')
      .eq('status', 'running')
      .lt('locked_at', cutoff);

    if (findError || !stuckTasks?.length) return 0;

    // Mark each as stuck
    let marked = 0;
    for (const task of stuckTasks) {
      const { error: updateError } = await supabase
        .from('pipeline_tasks')
        .update({
          status: 'stuck',
          error_message: `Task stuck for >${stuckAfterMinutes}min — worker likely died`,
          updated_at: new Date().toISOString()
        })
        .eq('id', task.id)
        .eq('status', 'running');  // CAS guard

      if (!updateError) marked++;
    }

    // Also mark pipeline runs as stuck if they have stuck tasks
    await markStuckPipelineRuns(stuckAfterMinutes);

    return marked;
  } catch (err: any) {
    console.error('[pipeline-queue] markStuckTasks error:', err.message);
    return 0;
  }
}

// ═══ 10. updateRunProgress ═══

/**
 * Update the pipeline_runs row with current task progress counts.
 * Called after each task completion or failure.
 */
export async function updateRunProgress(runId: string): Promise<void> {
  if (!runId) return;

  try {
    const supabase = supabaseAdmin();

    // Count tasks by status
    const { data: tasks, error } = await supabase
      .from('pipeline_tasks')
      .select('status')
      .eq('run_id', runId);

    if (error || !tasks) return;

    const total = tasks.length;
    const completed = tasks.filter((t: any) => t.status === 'completed').length;
    const failed = tasks.filter((t: any) => t.status === 'failed').length;
    const cancelled = tasks.filter((t: any) => t.status === 'cancelled').length;

    // Determine current step from the latest running/queued task
    const { data: latestTask } = await supabase
      .from('pipeline_tasks')
      .select('task_type, account_handle')
      .eq('run_id', runId)
      .eq('status', 'running')
      .order('step_order', { ascending: true })
      .limit(1)
      .maybeSingle();

    const currentStep = latestTask?.task_type || null;
    const currentAccount = latestTask?.account_handle || null;

    // Update run
    await supabase
      .from('pipeline_runs')
      .update({
        total_tasks: total,
        completed_tasks: completed,
        failed_tasks: failed,
        current_step: currentStep,
        account_handle: currentAccount,
        updated_at: new Date().toISOString()
      })
      .eq('id', runId);

  } catch (err: any) {
    console.error('[pipeline-queue] updateRunProgress error:', err.message);
  }
}

// ═══ 11. finalizeRunIfReady ═══

/**
 * Check if all tasks for a run are in terminal states (completed, failed, cancelled).
 * If so, finalize the pipeline_runs row with appropriate status.
 * Also aggregates results from tasks into the run's result_payload.
 */
export async function finalizeRunIfReady(runId: string): Promise<void> {
  if (!runId) return;

  try {
    const supabase = supabaseAdmin();

    const { data: tasks, error } = await supabase
      .from('pipeline_tasks')
      .select('status, task_type, result, error_message')
      .eq('run_id', runId);

    if (error || !tasks) return;

    const total = tasks.length;
    const completed = tasks.filter((t: any) => t.status === 'completed').length;
    const failed = tasks.filter((t: any) => t.status === 'failed').length;
    const cancelled = tasks.filter((t: any) => t.status === 'cancelled').length;
    const inProgress = total - completed - failed - cancelled;

    // If there are still tasks in progress, don't finalize yet
    if (inProgress > 0) return;

    // Determine run status
    let runStatus: string;
    const failedScanTasks = tasks.filter((t: any) => t.task_type === 'scan_account' && t.status === 'failed');
    const hasFailedScans = failedScanTasks.length > 0;

    if (completed === total) {
      runStatus = 'completed';
    } else if (completed === 0) {
      runStatus = 'failed';
    } else if (hasFailedScans && completed > 0) {
      // Partial completion: some scans failed but global steps completed
      // Mark as completed_with_warnings to signal partial failure
      runStatus = 'completed_with_warnings';
    } else {
      runStatus = 'completed';  // Partial success still counts as completed
    }

    // Aggregate results from tasks into result_payload
    const resultPayload: Record<string, any> = {};
    for (const task of tasks) {
      if ((task as any).status === 'completed' && (task as any).result) {
        resultPayload[(task as any).task_type] = (task as any).result;
      }
    }

    // Build decision_payload from task results
    const decisionTask = tasks.find((t: any) => t.task_type === 'decision');
    const publishGateTask = tasks.find((t: any) => t.task_type === 'publish_gate');

    const decisionPayload: Record<string, any> = {};
    if (decisionTask && (decisionTask as any).status === 'completed' && (decisionTask as any).result) {
      const dr = (decisionTask as any).result;
      decisionPayload.selected = dr.selected ?? dr.selected_count;
      decisionPayload.held = dr.held ?? dr.held_count;
      decisionPayload.min_final_score = dr.min_final_score;
      decisionPayload.decision_run_id = dr.decision_run_id;
    }
    if (publishGateTask && (publishGateTask as any).status === 'completed' && (publishGateTask as any).result) {
      const gr = (publishGateTask as any).result;
      decisionPayload.gate_accepted = gr.accepted ?? gr.gate_accepted;
      decisionPayload.gate_rejected = gr.rejected ?? gr.gate_rejected;
    }

    // Add failed scan account info for partial failure visibility
    if (hasFailedScans) {
      decisionPayload.failed_scan_accounts = failedScanTasks.map((t: any) => ({
        account: t.account_handle,
        error: (t.error_message || '').slice(0, 200)
      }));
      decisionPayload.failed_scan_count = failedScanTasks.length;
    }

    // Update the run
    const updatePayload: Record<string, any> = {
      status: runStatus,
      result_payload: resultPayload,
      decision_payload: decisionPayload,
      total_tasks: total,
      completed_tasks: completed,
      failed_tasks: failed,
      updated_at: new Date().toISOString()
    };

    if (runStatus === 'completed') {
      updatePayload.completed_at = new Date().toISOString();
      updatePayload.current_step = 'completed';
    } else if (runStatus === 'completed_with_warnings') {
      updatePayload.completed_at = new Date().toISOString();
      updatePayload.current_step = 'completed_with_warnings';
      updatePayload.error_message = `${failedScanTasks.length} scan_account task(s) failed: ${failedScanTasks.map((t: any) => t.account_handle || '?').join(', ')}`;
    } else if (runStatus === 'failed') {
      const failedTask = tasks.find((t: any) => t.status === 'failed');
      updatePayload.failed_at = new Date().toISOString();
      updatePayload.error_message = failedTask ? (failedTask as any).error_message : 'One or more tasks failed';
      updatePayload.current_step = failedTask ? (failedTask as any).task_type : 'unknown';
    }

    await supabase
      .from('pipeline_runs')
      .update(updatePayload)
      .eq('id', runId);

    // Also update the pipeline run using the tracker for consistency
    if (runStatus === 'completed' || runStatus === 'completed_with_warnings') {
      await completePipelineRun(runId, {
        scan_payload: resultPayload.merge_scan_results || resultPayload.load_account_state,
        decision_payload: decisionPayload,
        telegram_payload: resultPayload.telegram_delivery ? { delivered: true } : undefined
      });
      // For completed_with_warnings, override the status set by completePipelineRun
      if (runStatus === 'completed_with_warnings') {
        await supabase
          .from('pipeline_runs')
          .update({
            status: 'completed_with_warnings',
            current_step: 'completed_with_warnings',
            error_message: `${failedScanTasks.length} scan_account task(s) failed: ${failedScanTasks.map((t: any) => t.account_handle || '?').join(', ')}`
          })
          .eq('id', runId);
      }
    } else if (runStatus === 'failed') {
      const failedTask = tasks.find((t: any) => t.status === 'failed');
      await failPipelineRun(runId, new Error(failedTask ? (failedTask as any).error_message : 'Tasks failed'), failedTask ? (failedTask as any).task_type : undefined);
    }

  } catch (err: any) {
    console.error('[pipeline-queue] finalizeRunIfReady error:', err.message);
  }
}
