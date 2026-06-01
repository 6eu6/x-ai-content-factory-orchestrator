/**
 * Brain — Self-pruning (forgetting)
 *
 * A real brain forgets. This decays the weight of memories that have not been
 * useful, archives the weakest and the contradicted ones, and keeps the proven
 * core. Run on a schedule (cron) so the memory stays sharp instead of bloating
 * into the 3,000-row noise pile the legacy system became.
 */

import { supabaseAdmin } from '../supabase';

export type PruneReport = {
  decayed: number;
  archived_low_weight: number;
  archived_contradicted: number;
  active_remaining: number;
};

export async function pruneBrain(opts?: {
  decayPerRun?: number;     // weight subtracted from stale memories
  staleDays?: number;       // not used in N days = stale
  archiveBelow?: number;    // weight threshold to archive
}): Promise<PruneReport> {
  const supabase = supabaseAdmin();
  const decay = opts?.decayPerRun ?? 0.3;
  const staleDays = opts?.staleDays ?? 30;
  const archiveBelow = opts?.archiveBelow ?? 1.5;

  const staleCutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

  // 1) Decay stale, never-reinforced memories (protect proven ones: support_count>0).
  const { data: stale } = await supabase
    .from('brain_memory')
    .select('id, weight')
    .eq('status', 'active')
    .eq('support_count', 0)
    .or(`last_used_at.is.null,last_used_at.lt.${staleCutoff}`)
    .lt('created_at', staleCutoff)
    .limit(1000);

  let decayed = 0;
  for (const r of (stale || []) as any[]) {
    await supabase
      .from('brain_memory')
      .update({ weight: Math.max(0, Number(r.weight || 0) - decay), updated_at: new Date().toISOString() })
      .eq('id', r.id);
    decayed++;
  }

  // 2) Archive anything that decayed below the floor.
  const { data: low } = await supabase
    .from('brain_memory')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .lt('weight', archiveBelow)
    .select('id');

  // 3) Archive heavily contradicted memories regardless of weight.
  const { data: contradicted } = await supabase
    .from('brain_memory')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .gte('contradiction_count', 3)
    .select('id');

  const { count } = await supabase
    .from('brain_memory')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  return {
    decayed,
    archived_low_weight: (low || []).length,
    archived_contradicted: (contradicted || []).length,
    active_remaining: count ?? 0,
  };
}
