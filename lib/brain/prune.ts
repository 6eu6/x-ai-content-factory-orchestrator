/**
 * Brain — Self-pruning (intelligent forgetting)
 *
 * A real brain forgets on purpose. Criterion for "what matters":
 *   importance = weight (raised by reinforcement + good outcomes, lowered by
 *   time decay + contradictions) + recency of use.
 *
 * Forgetting is KIND-AWARE:
 *   - durable kinds (algorithm, voice) barely decay — proven, timeless.
 *   - time-sensitive kinds (source_pattern, insight) decay fast — niche trends
 *     go stale quickly.
 *   - outcome / anti_pattern decay moderately.
 * Plus a per-kind cap so no layer grows unbounded: beyond the cap we archive the
 * weakest. Heavily contradicted memories are archived regardless.
 *
 * Run on a schedule (the worker does this weekly).
 */

import { supabaseAdmin } from '../supabase';

export type PruneReport = {
  decayed: number;
  archived_low_weight: number;
  archived_contradicted: number;
  archived_over_cap: number;
  active_remaining: number;
};

type KindPolicy = { staleDays: number; decay: number; cap: number; protect: boolean };

// Tuned per layer. protect = never decays purely from age (only contradictions).
export const KIND_POLICY: Record<string, KindPolicy> = {
  algorithm:      { staleDays: 365, decay: 0.0, cap: 800, protect: true },
  voice:          { staleDays: 120, decay: 0.1, cap: 150, protect: false },
  outcome:        { staleDays: 60,  decay: 0.3, cap: 200, protect: false },
  anti_pattern:   { staleDays: 60,  decay: 0.3, cap: 200, protect: false },
  source_pattern: { staleDays: 14,  decay: 0.8, cap: 150, protect: false },
  insight:        { staleDays: 14,  decay: 0.8, cap: 80,  protect: false },
};
const DEFAULT_POLICY: KindPolicy = { staleDays: 30, decay: 0.3, cap: 200, protect: false };
const ARCHIVE_BELOW = 1.5;

export async function pruneBrain(): Promise<PruneReport> {
  const supabase = supabaseAdmin();
  const report: PruneReport = { decayed: 0, archived_low_weight: 0, archived_contradicted: 0, archived_over_cap: 0, active_remaining: 0 };

  for (const [kind, policy] of Object.entries(KIND_POLICY) as [string, KindPolicy][]) {
    if (policy.protect) continue; // durable layers: skip age decay
    const staleCutoff = new Date(Date.now() - policy.staleDays * 86_400_000).toISOString();
    // Decay stale, never-reinforced memories of this kind.
    const { data: stale } = await supabase
      .from('brain_memory')
      .select('id, weight')
      .eq('status', 'active')
      .eq('kind', kind)
      .eq('support_count', 0)
      .or(`last_used_at.is.null,last_used_at.lt.${staleCutoff}`)
      .lt('created_at', staleCutoff)
      .limit(2000);
    for (const r of (stale || []) as any[]) {
      await supabase.from('brain_memory')
        .update({ weight: Math.max(0, Number(r.weight || 0) - policy.decay), updated_at: new Date().toISOString() })
        .eq('id', r.id);
      report.decayed++;
    }
  }

  // Archive anything that decayed below the floor.
  const { data: low } = await supabase
    .from('brain_memory')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .lt('weight', ARCHIVE_BELOW)
    .select('id');
  report.archived_low_weight = (low || []).length;

  // Archive heavily contradicted memories regardless of weight.
  const { data: contradicted } = await supabase
    .from('brain_memory')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .gte('contradiction_count', 3)
    .select('id');
  report.archived_contradicted = (contradicted || []).length;

  // Per-kind cap: keep the strongest, archive the weakest beyond the cap.
  for (const kind of Object.keys({ ...KIND_POLICY })) {
    const cap = (KIND_POLICY[kind] || DEFAULT_POLICY).cap;
    const { data: rows } = await supabase
      .from('brain_memory')
      .select('id')
      .eq('status', 'active')
      .eq('kind', kind)
      .order('weight', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .range(cap, cap + 2000);
    const overflow = (rows || []).map((r: any) => r.id);
    if (overflow.length) {
      await supabase.from('brain_memory').update({ status: 'archived', updated_at: new Date().toISOString() }).in('id', overflow);
      report.archived_over_cap += overflow.length;
    }
  }

  const { count } = await supabase
    .from('brain_memory')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');
  report.active_remaining = count ?? 0;
  return report;
}
