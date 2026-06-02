/**
 * cost-ledger.ts — Phase 2A: Durable cost tracking for the 30-day @30piq experiment
 *
 * Records every provider call (TwitterAPI.io, OpenRouter) as a cost event in
 * the pipeline_cost_ledger table. Designed to be non-blocking: all DB writes
 * catch their own errors and never crash the pipeline.
 *
 * Usage:
 *   1. startCostEvent() → returns an event ID + records pending row
 *   2. completeCostEvent() → updates with tokens, cost, status='completed'
 *   3. failCostEvent() → updates with error, status='failed'
 *   4. recordCostEvent() → one-shot helper for simple cases
 *
 * Pricing reference (approximate, per 1M tokens):
 *   deepseek/deepseek-chat-v3-0324:    input $0.30, output $1.10
 *   meta-llama/llama-4-maverick:        input $0.20, output $0.80
 *   mistralai/mistral-small-3.1-24b:    input $0.10, output $0.30
 *   twitterapi_io:                      $0.00 per request (flat subscription)
 */

import { supabaseAdmin } from './supabase';

/**
 * Cost ledger is OFF by default in Lean Core — the legacy pipeline_cost_ledger
 * table lives in the `legacy` schema now, so writing to it would only produce
 * noise. Set COST_LEDGER_ENABLED=true (and provide the table) to re-enable.
 */
export function ledgerEnabled(): boolean {
  const v = (process.env.COST_LEDGER_ENABLED || '').toLowerCase().trim();
  return v === 'true' || v === '1';
}

// ═══ Types ═══

export type CostProvider = 'twitterapi_io' | 'openrouter' | 'openai' | 'local';

export type CostEventInput = {
  run_id?: string | null;
  task_id?: string | null;
  task_type: string;
  provider: CostProvider;
  model?: string | null;
  request_url?: string | null;
};

export type CostEventComplete = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost_usd?: number;
  error?: string | null;
};

// ═══ Pricing Table (USD per 1M tokens) ═══

const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek/deepseek-chat-v3-0324':       { input: 0.30,  output: 1.10 },
  'meta-llama/llama-4-maverick':          { input: 0.20,  output: 0.80 },
  'mistralai/mistral-small-3.1-24b-instruct': { input: 0.10, output: 0.30 },
  // Fallback for unknown models
  'default':                               { input: 0.50,  output: 1.50 },
};

/**
 * Estimate cost in USD based on model, input/output token counts.
 * Returns 0 for providers without token-based pricing (e.g. twitterapi_io).
 */
export function estimateCostUsd(
  provider: CostProvider,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number {
  if (provider === 'twitterapi_io') return 0;
  if (provider === 'local') return 0;

  const inT = inputTokens || 0;
  const outT = outputTokens || 0;

  const modelKey = model && PRICING[model] ? model : 'default';
  const pricing = PRICING[modelKey] || PRICING['default'];

  return (inT * pricing.input / 1_000_000) + (outT * pricing.output / 1_000_000);
}

// ═══ Core Functions ═══

/**
 * Start a cost event — inserts a row with status='pending'.
 * Returns the row ID for later completion, or null on DB error.
 * Never throws.
 */
export async function startCostEvent(input: CostEventInput): Promise<string | null> {
  if (!ledgerEnabled()) return null;
  try {
    const supabase = supabaseAdmin();
    const row = {
      run_id: input.run_id || null,
      task_id: input.task_id || null,
      task_type: input.task_type,
      provider: input.provider,
      model: input.model || null,
      request_url: input.request_url || null,
      status: 'pending',
      estimated_cost_usd: 0,
      started_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('pipeline_cost_ledger')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[cost-ledger] startCostEvent DB error:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err: any) {
    console.error('[cost-ledger] startCostEvent exception:', err.message);
    return null;
  }
}

/**
 * Complete a cost event — updates with token counts, cost, status='completed'.
 * If estimated_cost_usd is not provided, it is calculated from the model and tokens.
 * Never throws.
 */
export async function completeCostEvent(
  eventId: string | null,
  completion: CostEventComplete
): Promise<void> {
  if (!eventId || !ledgerEnabled()) return;
  try {
    // Calculate cost if not provided
    let costUsd = completion.estimated_cost_usd;
    if (costUsd === undefined || costUsd === null) {
      // Need to read the event to get provider + model
      const supabase = supabaseAdmin();
      const { data: event } = await supabase
        .from('pipeline_cost_ledger')
        .select('provider, model')
        .eq('id', eventId)
        .maybeSingle();

      costUsd = estimateCostUsd(
        (event?.provider as CostProvider) || 'openrouter',
        event?.model,
        completion.input_tokens,
        completion.output_tokens
      );
    }

    const supabase = supabaseAdmin();
    const { error } = await supabase
      .from('pipeline_cost_ledger')
      .update({
        input_tokens: completion.input_tokens ?? null,
        output_tokens: completion.output_tokens ?? null,
        total_tokens: completion.total_tokens ?? ((completion.input_tokens || 0) + (completion.output_tokens || 0) || null),
        estimated_cost_usd: costUsd,
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', eventId);

    if (error) {
      console.error('[cost-ledger] completeCostEvent DB error:', error.message);
    }
  } catch (err: any) {
    console.error('[cost-ledger] completeCostEvent exception:', err.message);
  }
}

/**
 * Fail a cost event — updates with error message, status='failed'.
 * Never throws.
 */
export async function failCostEvent(
  eventId: string | null,
  errorMessage: string
): Promise<void> {
  if (!eventId || !ledgerEnabled()) return;
  try {
    const supabase = supabaseAdmin();
    const { error } = await supabase
      .from('pipeline_cost_ledger')
      .update({
        status: 'failed',
        error: errorMessage.slice(0, 2000),
        completed_at: new Date().toISOString()
      })
      .eq('id', eventId);

    if (error) {
      console.error('[cost-ledger] failCostEvent DB error:', error.message);
    }
  } catch (err: any) {
    console.error('[cost-ledger] failCostEvent exception:', err.message);
  }
}

/**
 * One-shot: Record a completed cost event in a single call.
 * Useful for simple cases where start/complete lifecycle is unnecessary.
 * Never throws.
 */
export async function recordCostEvent(
  input: CostEventInput & {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    estimated_cost_usd?: number;
    error?: string | null;
    status?: 'completed' | 'failed';
  }
): Promise<string | null> {
  if (!ledgerEnabled()) return null;
  try {
    const status = input.status || (input.error ? 'failed' : 'completed');
    const costUsd = input.estimated_cost_usd ?? estimateCostUsd(
      input.provider,
      input.model,
      input.input_tokens,
      input.output_tokens
    );

    const row = {
      run_id: input.run_id || null,
      task_id: input.task_id || null,
      task_type: input.task_type,
      provider: input.provider,
      model: input.model || null,
      input_tokens: input.input_tokens ?? null,
      output_tokens: input.output_tokens ?? null,
      total_tokens: input.total_tokens ?? ((input.input_tokens || 0) + (input.output_tokens || 0) || null),
      estimated_cost_usd: costUsd,
      status,
      error: input.error?.slice(0, 2000) || null,
      request_url: input.request_url || null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    };

    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_cost_ledger')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[cost-ledger] recordCostEvent DB error:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err: any) {
    console.error('[cost-ledger] recordCostEvent exception:', err.message);
    return null;
  }
}

// ═══ Query Helpers ═══

/**
 * Get all cost events for a specific run.
 * Returns empty array on failure.
 */
export async function getCostEventsByRun(runId: string): Promise<any[]> {
  if (!ledgerEnabled()) return [];
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('pipeline_cost_ledger')
      .select('*')
      .eq('run_id', runId)
      .order('started_at', { ascending: true });

    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * Get the total cost for a specific run.
 * Returns 0 on failure.
 */
export async function getRunCostUsd(runId: string): Promise<number> {
  try {
    const events = await getCostEventsByRun(runId);
    return events
      .filter(e => e.status === 'completed')
      .reduce((sum, e) => sum + (Number(e.estimated_cost_usd) || 0), 0);
  } catch {
    return 0;
  }
}
