/**
 * pipeline-worker.ts — Durable worker that processes pipeline tasks from the Supabase queue
 *
 * This module implements the actual task processing logic. It is designed to be called
 * by either:
 *   1. The persistent scripts/pipeline-worker.ts (Oracle VPS, runs forever)
 *   2. The fallback app/api/pipeline-worker/route.ts (Vercel, small batch)
 *
 * Each task type maps to a specific pipeline step:
 *   - load_account_state: Load X account state and store in account_state table
 *   - scan_account: Scan a single X account (ONE account per task, FULL quality)
 *   - merge_scan_results: Merge all scan_account results + discover opportunities
 *   - enrich_opportunities: Enrich opportunities with rule performance data
 *   - publish_gate: Filter opportunities through English publish gate
 *   - decision: Apply decision engine to publishable opportunities
 *   - persist_decision: Log the decision to decision_runs table
 *   - telegram_delivery: Deliver selected recommendations to Telegram
 *
 * Critical: scan_account processes ONE account per task.
 * This is not a quality reduction. It is execution partitioning.
 *
 * Quality guarantee: All content-engine-v3 logic is preserved.
 * The worker uses scanSingleAccountForPipeline and mergeAndDiscoverOpportunities
 * from content-engine-v3 — the SAME quality logic as scanXAccounts.
 * No placeholder opportunities with empty crafted_text or shield_passed=false.
 */

import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import {
  lockNextTask,
  completeTask,
  failTask,
  markStuckTasks,
  type PipelineTaskRow,
  type PipelineTaskType
} from './pipeline-queue';
import {
  updatePipelineRun,
  appendPipelineRunLog
} from './pipeline-run-tracker';
import {
  scanSingleAccountForPipeline,
  mergeAndDiscoverOpportunities,
  type SingleAccountScanResult
} from './content-engine-v3';

// ═══ Types ═══

export type ProcessBatchOptions = {
  workerId: string;
  maxTasks?: number;       // Max tasks to process in this batch (default 1)
  maxRuntimeMs?: number;   // Stop processing before this runtime (default 60000)
  runId?: string;          // Only process tasks for this specific run
};

export type ProcessBatchResult = {
  ok: boolean;
  worker_id: string;
  tasks_processed: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_retried: number;
  runtime_ms: number;
  errors: string[];
  stopped_reason: string;  // 'max_tasks' | 'max_runtime' | 'no_tasks' | 'error'
};

// ═══ Main entry: processPipelineTaskBatch ═══

/**
 * Process a batch of pipeline tasks from the queue.
 * Locks one task at a time, processes it, saves result, updates run progress.
 * Stops before maxRuntimeMs to avoid Vercel timeout or worker overrun.
 * Returns a structured summary.
 */
export async function processPipelineTaskBatch(options: ProcessBatchOptions): Promise<ProcessBatchResult> {
  const workerId = options.workerId;
  const maxTasks = options.maxTasks ?? 1;
  const maxRuntimeMs = options.maxRuntimeMs ?? 60000;
  const startTime = Date.now();

  let tasksProcessed = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let tasksRetried = 0;
  const errors: string[] = [];

  while (tasksProcessed < maxTasks) {
    // Check runtime
    if (Date.now() - startTime > maxRuntimeMs * 0.9) {
      return buildBatchResult('max_runtime', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
    }

    // Lock next eligible task
    const lockResult = await lockNextTask(workerId, {
      runId: options.runId
    });

    if (!lockResult.locked || !lockResult.task) {
      // No more tasks available
      if (tasksProcessed > 0) {
        return buildBatchResult('no_more_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
      }
      return buildBatchResult('no_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
    }

    const task = lockResult.task;
    tasksProcessed++;

    // Process the task
    try {
      const result = await processTask(task);

      if (result.ok) {
        await completeTask(task.id, result.result);
        tasksCompleted++;

        // Log progress
        if (task.run_id) {
          await appendPipelineRunLog(task.run_id, `task completed: ${task.task_type}`, {
            task_id: task.id,
            account_handle: task.account_handle,
            result_summary: Object.keys(result.result)
          });
        }
      } else {
        const failResult = await failTask(task.id, new Error(result.error || 'Task processing failed'));
        if (failResult.retried) {
          tasksRetried++;
        } else {
          tasksFailed++;
        }

        errors.push(`${task.task_type} (${task.account_handle || 'global'}): ${result.error}`);

        if (task.run_id) {
          await appendPipelineRunLog(task.run_id, `task failed: ${task.task_type} — ${result.error}`, {
            task_id: task.id,
            account_handle: task.account_handle
          });
        }
      }
    } catch (err: any) {
      const failResult = await failTask(task.id, err);
      if (failResult.retried) {
        tasksRetried++;
      } else {
        tasksFailed++;
      }

      errors.push(`${task.task_type} (${task.account_handle || 'global'}): ${err.message}`);
    }
  }

  return buildBatchResult('max_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
}

// ═══ Task Processing Logic ═══

type TaskResult = {
  ok: boolean;
  result: Record<string, any>;
  error?: string;
};

/**
 * Process a single pipeline task based on its type.
 * Each task type uses the real content-engine-v3 logic — no simplified rewrites.
 */
async function processTask(task: PipelineTaskRow): Promise<TaskResult> {
  switch (task.task_type) {
    case 'load_account_state':
      return processLoadAccountState(task);
    case 'scan_account':
      return processScanAccount(task);
    case 'merge_scan_results':
      return processMergeScanResults(task);
    case 'enrich_opportunities':
      return processEnrichOpportunities(task);
    case 'publish_gate':
      return processPublishGate(task);
    case 'decision':
      return processDecision(task);
    case 'persist_decision':
      return processPersistDecision(task);
    case 'telegram_delivery':
      return processTelegramDelivery(task);
    default:
      return { ok: false, result: {}, error: `Unknown task type: ${task.task_type}` };
  }
}

// ═══ load_account_state ═══

async function processLoadAccountState(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const username = task.payload.username || task.account_handle || optionalEnv('X_USERNAME', '30piq');
    const { getXUserByUsername } = await import('./x');
    const xSnapshot = await getXUserByUsername(username);

    // Store in account_state
    const supabase = supabaseAdmin();
    await supabase.from('account_state').upsert({
      account_handle: username,
      x_url: `https://x.com/${username}`,
      followers_count: xSnapshot.followers_count ?? null,
      following_count: xSnapshot.following_count ?? null,
      posts_count: xSnapshot.tweet_count ?? null,
      last_live_check_at: new Date().toISOString(),
      last_known_source: task.payload.source || 'queue_worker'
    }, { onConflict: 'account_handle' });

    return {
      ok: true,
      result: {
        username,
        followers: xSnapshot.followers_count || 0,
        following: xSnapshot.following_count || 0,
        tweets: xSnapshot.tweet_count || 0
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ scan_account (ONE account per task, FULL content-engine-v3 quality) ═══

async function processScanAccount(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const handle = task.account_handle || task.payload.account_handle;
    const tweetsPerAccount = task.payload.tweets_per_account || 8;

    if (!handle) {
      return { ok: false, result: {}, error: 'No account_handle specified for scan_account task' };
    }

    // Use the REAL content-engine-v3 per-account function — same quality as scanXAccounts
    const scanResult = await scanSingleAccountForPipeline(handle, tweetsPerAccount);

    // Store the full scan result as JSONB for the merge step to pick up
    return {
      ok: true,
      result: {
        account_handle: scanResult.account_handle,
        tweets_analyzed: scanResult.tweets_analyzed,
        viral_found: scanResult.viral_found,
        brain_updates: scanResult.brain_updates,
        // Store the full analyzed_data for merge step — this is critical
        _analyzed_data: scanResult.analyzed_data,
        _media: scanResult.media,
        _debug_log: scanResult.debug_log
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ merge_scan_results (FULL content-engine-v3 quality) ═══

async function processMergeScanResults(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Fetch all completed scan_account task results
    const { data: scanTasks, error } = await supabase
      .from('pipeline_tasks')
      .select('result, account_handle')
      .eq('run_id', runId)
      .eq('task_type', 'scan_account')
      .eq('status', 'completed');

    if (error) {
      return { ok: false, result: {}, error: `Failed to fetch scan results: ${error.message}` };
    }

    if (!scanTasks?.length) {
      return { ok: false, result: {}, error: 'No completed scan_account tasks found — cannot merge' };
    }

    // Reconstruct SingleAccountScanResult[] from stored task results
    const accountScanResults: SingleAccountScanResult[] = [];
    for (const scanTask of scanTasks) {
      const r = scanTask.result || {};
      accountScanResults.push({
        account_handle: r.account_handle || scanTask.account_handle || '',
        tweets_analyzed: r.tweets_analyzed || 0,
        viral_found: r.viral_found || 0,
        analyzed_data: r._analyzed_data || [],
        media: r._media || [],
        brain_updates: r.brain_updates || { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
        debug_log: r._debug_log || []
      });
    }

    // Use the REAL content-engine-v3 merge+discover function
    // This produces real ContentOpportunity objects with crafted_text, shield_passed, etc.
    const mergeResult = await mergeAndDiscoverOpportunities(accountScanResults);

    return {
      ok: true,
      result: {
        accounts_scanned: mergeResult.accounts_scanned,
        tweets_analyzed: mergeResult.tweets_analyzed,
        viral_found: mergeResult.viral_found,
        raw_opportunities: mergeResult.raw_opportunities,
        brain_updates: mergeResult.brain_updates,
        media_downloaded: mergeResult.media_downloaded,
        // Store the FULL opportunities for subsequent steps
        _opportunities: mergeResult.opportunities,
        _debug_log: mergeResult.debug_log
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ enrich_opportunities ═══

async function processEnrichOpportunities(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get merge results
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    const opportunities = mergeTask?.result?._opportunities || [];

    if (!opportunities.length) {
      return {
        ok: true,
        result: {
          enriched_opportunities: 0,
          avg_weight: 0,
          boosted_count: 0,
          penalized_count: 0,
          _opportunities: []
        }
      };
    }

    const { enrichOpportunitiesWithRulePerformance } = await import('./enrich-opportunities-with-rule-performance');
    const rulePerformanceStats = await enrichOpportunitiesWithRulePerformance(opportunities);

    return {
      ok: true,
      result: {
        enriched_opportunities: rulePerformanceStats.enriched_opportunities,
        avg_weight: rulePerformanceStats.avg_weight,
        boosted_count: rulePerformanceStats.boosted_count,
        penalized_count: rulePerformanceStats.penalized_count,
        _opportunities: opportunities,
        _rule_performance: rulePerformanceStats
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ publish_gate ═══

async function processPublishGate(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get enrich results
    const { data: enrichTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'enrich_opportunities')
      .eq('status', 'completed')
      .maybeSingle();

    const opportunities = enrichTask?.result?._opportunities || [];

    const { filterPublishableOpportunities } = await import('./content-policy');
    const publishGate = filterPublishableOpportunities(opportunities);

    return {
      ok: true,
      result: {
        accepted: publishGate.accepted.length,
        rejected: publishGate.rejected.length,
        reasons: publishGate.rejected.slice(0, 5).map((r: any) => r.reason),
        _accepted: publishGate.accepted,
        _rejected: publishGate.rejected
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ decision ═══

async function processDecision(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get publish_gate results
    const { data: gateTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'publish_gate')
      .eq('status', 'completed')
      .maybeSingle();

    const accepted = gateTask?.result?._accepted || [];

    // Get load_account_state results for follower count
    const { data: accountTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'load_account_state')
      .eq('status', 'completed')
      .maybeSingle();

    const followers = accountTask?.result?.followers || 0;

    const { decideTelegramOpportunities, stageFromFollowerCount } = await import('./decision-engine');
    const stage = stageFromFollowerCount(followers);
    const decision = decideTelegramOpportunities(accepted, stage);

    // Attach metadata
    (decision as any)._publishGate = {
      accepted: gateTask?.result?.accepted ?? 0,
      rejected: gateTask?.result?.rejected ?? 0,
      reasons: gateTask?.result?.reasons || []
    };

    // Get enrich results for rule performance
    const { data: enrichTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'enrich_opportunities')
      .eq('status', 'completed')
      .maybeSingle();

    (decision as any)._rulePerformance = enrichTask?.result?._rule_performance || {
      enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0
    };

    return {
      ok: true,
      result: {
        selected: decision.selected.length,
        held: decision.held.length,
        min_final_score: decision.budget.min_final_score,
        stage: decision.stage,
        _decision: decision,
        followers
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ persist_decision ═══

async function processPersistDecision(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get decision results
    const { data: decisionTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'decision')
      .eq('status', 'completed')
      .maybeSingle();

    const decision = decisionTask?.result?._decision;
    if (!decision) {
      return { ok: false, result: {}, error: 'No decision result found' };
    }

    // Get merge results for scan data
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    // Get gate results
    const { data: gateTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'publish_gate')
      .eq('status', 'completed')
      .maybeSingle();

    const { shortText } = await import('./telegram');

    // Insert into decision_runs
    let decisionRunId: string | null = null;
    try {
      const { data: insertedRun } = await supabase.from('decision_runs').insert({
        account_handle: username,
        account_stage: decision.stage,
        raw_opportunities: mergeTask?.result?.raw_opportunities || 0,
        selected_count: decision.selected.length,
        held_count: decision.held.length,
        budget: { ...decision.budget, publish_gate: (decision as any)._publishGate },
        selected_payload: decision.selected.slice(0, 5).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          source_author: o.source_author,
          crafted_text: shortText(o.crafted_text || '', 280),
          brain_rules_used: (o.brain_rules_used || []).slice(0, 20),
          shield_passed: o.shield_passed ?? null,
          reasons: o.decision_score?.reasons || []
        })),
        held_summary: decision.held.slice(0, 10).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          rejection_reasons: o.decision_score?.rejection_reasons || []
        })),
        run_source: task.payload.source || 'queue_worker'
      }).select('id').single();
      decisionRunId = insertedRun?.id || null;
    } catch (dbErr: any) {
      console.error('[pipeline-worker] persist_decision DB error:', dbErr.message);
    }

    // Log daily checkin
    try {
      await supabase.from('daily_checkins').upsert({
        checkin_date: new Date().toISOString().slice(0, 10),
        execution_mode: 'v7_queue_worker',
        account_checked: true,
        tweets_planned: decision.selected.length,
        creator_posts_analyzed: mergeTask?.result?.tweets_analyzed || 0,
        notes: `v7 queue: raw ${mergeTask?.result?.raw_opportunities || 0}, gate_ok ${gateTask?.result?.accepted || 0}, selected ${decision.selected.length}, held ${decision.held.length}, stage ${decision.stage}`
      }, { onConflict: 'checkin_date' });
    } catch {}

    return {
      ok: true,
      result: {
        decision_run_id: decisionRunId,
        selected_count: decision.selected.length,
        held_count: decision.held.length,
        _decision: decision
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ telegram_delivery ═══

async function processTelegramDelivery(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const notifyTelegram = task.payload.notify_telegram !== false;

    if (!notifyTelegram) {
      return { ok: true, result: { delivered: false, reason: 'notify_telegram=false' } };
    }

    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get persist_decision results
    const { data: persistTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'persist_decision')
      .eq('status', 'completed')
      .maybeSingle();

    const decision = persistTask?.result?._decision;
    if (!decision) {
      return { ok: false, result: {}, error: 'No decision result found for Telegram delivery' };
    }

    // Get merge results for scan data
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    // Get account state
    const { data: accountTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'load_account_state')
      .eq('status', 'completed')
      .maybeSingle();

    const followers = accountTask?.result?.followers || 0;

    // Build a scan-like result for the delivery function
    const scanResult = {
      actual_accounts_scanned: mergeTask?.result?.accounts_scanned || 0,
      accounts_scanned: mergeTask?.result?.accounts_scanned || 0,
      manual_tweets_loaded: 0,
      tweets_analyzed: mergeTask?.result?.tweets_analyzed || 0,
      viral_tweets_found: mergeTask?.result?.viral_found || 0,
      opportunities: mergeTask?.result?._opportunities || [],
      brain_updates: mergeTask?.result?.brain_updates || { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
      media_downloaded: mergeTask?.result?.media_downloaded || 0,
      debug_log: []
    };

    // Set the decision run ID
    const decisionRunId = persistTask?.result?.decision_run_id;
    (decision as any)._runId = decisionRunId;

    // Deliver to Telegram
    const { deliverDecisionToTelegram } = await import('./daily-runner');
    const { allowedChatId } = await import('./telegram');
    const chatId = allowedChatId();

    if (chatId) {
      await deliverDecisionToTelegram(chatId, scanResult, username, decision, followers);
    }

    return {
      ok: true,
      result: {
        delivered: Boolean(chatId),
        selected_count: decision.selected?.length || 0,
        chat_id: chatId || null
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ Helper: Build batch result ═══

function buildBatchResult(
  stoppedReason: string,
  workerId: string,
  tasksProcessed: number,
  tasksCompleted: number,
  tasksFailed: number,
  tasksRetried: number,
  startTime: number,
  errors: string[]
): ProcessBatchResult {
  return {
    ok: true,
    worker_id: workerId,
    tasks_processed: tasksProcessed,
    tasks_completed: tasksCompleted,
    tasks_failed: tasksFailed,
    tasks_retried: tasksRetried,
    runtime_ms: Date.now() - startTime,
    errors,
    stopped_reason: stoppedReason
  };
}
