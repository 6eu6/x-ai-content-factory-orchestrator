/**
 * run-cost-summary.ts — Phase 2A: Lightweight per-run cost and rejection summary
 *
 * Provides formatted summaries for a pipeline run's cost and rejection data.
 * Used by status API endpoints and Telegram reporting.
 *
 * Never throws. Returns graceful empty summaries on DB errors.
 */

import { getCostEventsByRun, getRunCostUsd } from './cost-ledger';
import { getRejectionsByRun } from './rejection-ledger';

// ═══ Types ═══

export type RunCostSummary = {
  run_id: string;
  total_cost_usd: number;
  cost_by_provider: Record<string, number>;
  cost_by_task_type: Record<string, number>;
  cost_by_model: Record<string, number>;
  total_events: number;
  completed_events: number;
  failed_events: number;
  total_input_tokens: number;
  total_output_tokens: number;
  accepted_count: number;
  rejected_count: number;
  top_rejection_reasons: Array<{ reason: string; count: number }>;
};

// ═══ Core Functions ═══

/**
 * Build a structured summary for a pipeline run.
 * Returns a summary even on partial DB errors.
 */
export async function getRunCostSummary(runId: string): Promise<RunCostSummary> {
  const [events, rejections] = await Promise.all([
    getCostEventsByRun(runId),
    getRejectionsByRun(runId)
  ]);

  const totalCostUsd = await getRunCostUsd(runId);

  // Aggregate cost by provider
  const costByProvider: Record<string, number> = {};
  const costByTaskType: Record<string, number> = {};
  const costByModel: Record<string, number> = {};
  let completedEvents = 0;
  let failedEvents = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const event of events) {
    const cost = Number(event.estimated_cost_usd) || 0;

    // By provider
    const provider = event.provider || 'unknown';
    costByProvider[provider] = (costByProvider[provider] || 0) + cost;

    // By task_type
    const taskType = event.task_type || 'unknown';
    costByTaskType[taskType] = (costByTaskType[taskType] || 0) + cost;

    // By model
    const model = event.model || 'unknown';
    costByModel[model] = (costByModel[model] || 0) + cost;

    // Counters
    if (event.status === 'completed') {
      completedEvents++;
      totalInputTokens += Number(event.input_tokens) || 0;
      totalOutputTokens += Number(event.output_tokens) || 0;
    } else if (event.status === 'failed') {
      failedEvents++;
    }
  }

  // Aggregate rejections
  const reasonCounts: Record<string, number> = {};
  for (const rej of rejections) {
    const reason = rej.rejection_reason || 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  const topRejectionReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    run_id: runId,
    total_cost_usd: totalCostUsd,
    cost_by_provider: costByProvider,
    cost_by_task_type: costByTaskType,
    cost_by_model: costByModel,
    total_events: events.length,
    completed_events: completedEvents,
    failed_events: failedEvents,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    accepted_count: 0,  // Filled by caller from publish_gate result
    rejected_count: rejections.length,
    top_rejection_reasons: topRejectionReasons
  };
}

/**
 * Format a run cost summary as a human-readable text block.
 * Suitable for Telegram or console output.
 */
export function formatSummaryText(summary: RunCostSummary): string {
  const lines: string[] = [];

  lines.push(`=== Run Cost Summary: ${summary.run_id.slice(0, 8)}... ===`);
  lines.push(`Total Cost: $${summary.total_cost_usd.toFixed(4)}`);
  lines.push(`Events: ${summary.completed_events} completed, ${summary.failed_events} failed`);

  if (Object.keys(summary.cost_by_provider).length > 0) {
    lines.push('');
    lines.push('Cost by Provider:');
    for (const [provider, cost] of Object.entries(summary.cost_by_provider)) {
      lines.push(`  ${provider}: $${cost.toFixed(4)}`);
    }
  }

  if (Object.keys(summary.cost_by_model).length > 0) {
    lines.push('');
    lines.push('Cost by Model:');
    for (const [model, cost] of Object.entries(summary.cost_by_model)) {
      lines.push(`  ${model}: $${cost.toFixed(4)}`);
    }
  }

  if (summary.total_input_tokens > 0 || summary.total_output_tokens > 0) {
    lines.push('');
    lines.push(`Tokens: ${summary.total_input_tokens.toLocaleString()} in, ${summary.total_output_tokens.toLocaleString()} out`);
  }

  if (summary.rejected_count > 0) {
    lines.push('');
    lines.push(`Rejections: ${summary.rejected_count}`);
    if (summary.accepted_count > 0) {
      lines.push(`Accepted: ${summary.accepted_count}`);
    }
    if (summary.top_rejection_reasons.length > 0) {
      lines.push('Top Rejection Reasons:');
      for (const { reason, count } of summary.top_rejection_reasons.slice(0, 5)) {
        lines.push(`  ${reason}: ${count}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a run cost summary as a JSON API response.
 */
export function formatSummaryJson(summary: RunCostSummary): Record<string, any> {
  return {
    run_id: summary.run_id,
    total_cost_usd: Number(summary.total_cost_usd.toFixed(6)),
    cost_by_provider: summary.cost_by_provider,
    cost_by_task_type: summary.cost_by_task_type,
    cost_by_model: summary.cost_by_model,
    events: {
      total: summary.total_events,
      completed: summary.completed_events,
      failed: summary.failed_events
    },
    tokens: {
      input: summary.total_input_tokens,
      output: summary.total_output_tokens
    },
    rejections: {
      accepted: summary.accepted_count,
      rejected: summary.rejected_count,
      top_reasons: summary.top_rejection_reasons
    }
  };
}
