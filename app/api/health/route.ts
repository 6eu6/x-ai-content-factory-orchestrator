import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/health — lightweight health check for the lean core.
 * Verifies Supabase connectivity and that the (only) live tables exist.
 */
const LEAN_TABLES = [
  'profiles',
  'accounts',
  'brain_memory',
  'opportunities',
  'published_decisions',
  'content_log',
  'telegram_bot_state',
  'model_routing_rules',
];

export async function GET() {
  const supabase = supabaseAdmin();
  const tables: Record<string, { exists: boolean; rows?: number }> = {};

  for (const table of LEAN_TABLES) {
    try {
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      tables[table] = error ? { exists: false } : { exists: true, rows: count ?? 0 };
    } catch {
      tables[table] = { exists: false };
    }
  }

  // Brain readiness: are embeddings backfilled (semantic retrieval on)?
  let brain = { active: 0, with_embedding: 0 };
  try {
    const { count: active } = await supabase.from('brain_memory').select('*', { count: 'exact', head: true }).eq('status', 'active');
    const { count: emb } = await supabase.from('brain_memory').select('*', { count: 'exact', head: true }).not('embedding', 'is', null);
    brain = { active: active ?? 0, with_embedding: emb ?? 0 };
  } catch {
    /* ignore */
  }

  const allExist = Object.values(tables).every((t) => t.exists);
  return Response.json({
    ok: allExist,
    version: 'lean-brain',
    tables,
    brain,
    note: brain.with_embedding === 0
      ? 'Run POST /api/brain?action=backfill&limit=600 to enable semantic retrieval.'
      : 'Semantic retrieval active.',
  });
}
