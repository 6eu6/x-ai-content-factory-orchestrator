import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { embedMany, toVectorLiteral } from '../../../lib/brain/embed';
import { recall } from '../../../lib/brain/retrieve';
import { pruneBrain } from '../../../lib/brain/prune';

/**
 * Brain operations endpoint.
 *
 *   GET  /api/brain?action=stats               → memory counts by kind/status
 *   POST /api/brain?action=backfill&limit=200  → embed rows missing embeddings
 *   POST /api/brain?action=prune                → decay + archive (self-forgetting)
 *   GET  /api/brain?action=recall&q=...         → debug retrieval
 *
 * Auth: x-orchestrator-secret header (or ?cron=1 with Vercel cron header).
 */
export const maxDuration = 300;

async function stats() {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from('brain_memory').select('kind, status, embedding');
  const rows = (data || []) as any[];
  const byKind: Record<string, number> = {};
  let active = 0;
  let withEmbedding = 0;
  for (const r of rows) {
    if (r.status === 'active') active++;
    if (r.embedding) withEmbedding++;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  }
  return { total: rows.length, active, with_embedding: withEmbedding, missing_embedding: rows.length - withEmbedding, by_kind: byKind };
}

async function backfill(limit: number) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from('brain_memory')
    .select('id, content')
    .is('embedding', null)
    .eq('status', 'active')
    .limit(limit);
  const rows = (data || []) as any[];
  if (!rows.length) return { embedded: 0, remaining: 0 };

  const vectors = await embedMany(rows.map((r) => r.content));
  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    const { error } = await supabase.from('brain_memory').update({ embedding: toVectorLiteral(v) }).eq('id', rows[i].id);
    if (!error) embedded++;
  }
  const { count } = await supabase
    .from('brain_memory')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null)
    .eq('status', 'active');
  return { embedded, remaining: count ?? 0 };
}

async function handle(req: Request) {
  try {
    assertAuthorized(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'stats';

  try {
    if (action === 'stats') return Response.json({ ok: true, ...(await stats()) });
    if (action === 'recall') {
      const q = url.searchParams.get('q') || '';
      const results = await recall(q, { matchCount: 8 });
      return Response.json({ ok: true, query: q, results });
    }
    if (action === 'backfill') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
      return Response.json({ ok: true, ...(await backfill(limit)) });
    }
    if (action === 'prune') return Response.json({ ok: true, ...(await pruneBrain()) });
    return Response.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'brain op failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
