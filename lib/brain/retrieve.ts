/**
 * Brain — Recall (read side)
 *
 * Semantic retrieval via pgvector (match_brain_memory RPC) with a lexical
 * fallback (pg_trgm / ILIKE) so recall still works for rows without embeddings
 * or when the embeddings endpoint is unavailable.
 *
 * recall() returns the most relevant knowledge for a given context, blended
 * across kinds, ranked by relevance and weight. This is what makes generated
 * content follow the brain instead of being generic model output.
 */

import { supabaseAdmin } from '../supabase';
import { embed, toVectorLiteral } from './embed';
import { markUsed } from './store';

export type Recalled = {
  id: string;
  kind: string;
  content: string;
  weight: number;
  similarity: number;
};

export type RecallOptions = {
  kind?: string;
  niche?: string | null;
  account?: string | null;
  matchCount?: number;
  minWeight?: number;
  markUsage?: boolean;
};

export async function recall(query: string, opts: RecallOptions = {}): Promise<Recalled[]> {
  const supabase = supabaseAdmin();
  const matchCount = opts.matchCount ?? 8;
  const minWeight = opts.minWeight ?? 0;

  const vec = await embed(query);

  let results: Recalled[] = [];

  if (vec) {
    const { data, error } = await supabase.rpc('match_brain_memory', {
      query_embedding: toVectorLiteral(vec) as any,
      match_count: matchCount,
      filter_kind: opts.kind ?? null,
      filter_niche: opts.niche ?? null,
      min_weight: minWeight,
      filter_account: opts.account ?? null,
    });
    if (!error && data) {
      results = (data as any[]).map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        weight: Number(r.weight) || 0,
        similarity: Number(r.similarity) || 0,
      }));
    }
  }

  // Lexical fallback (no embeddings, or empty semantic result).
  if (!results.length) {
    results = await lexicalRecall(query, opts, matchCount, minWeight);
  }

  if (opts.markUsage !== false && results.length) {
    await markUsed(results.map((r) => r.id)).catch(() => {});
  }
  return results;
}

async function lexicalRecall(
  query: string,
  opts: RecallOptions,
  matchCount: number,
  minWeight: number,
): Promise<Recalled[]> {
  const supabase = supabaseAdmin();
  // Pull a candidate set scoped by kind/niche/weight, then rank by keyword overlap.
  let q = supabase
    .from('brain_memory')
    .select('id, kind, content, weight')
    .eq('status', 'active')
    .gte('weight', minWeight)
    .order('weight', { ascending: false })
    .limit(200);
  if (opts.kind) q = q.eq('kind', opts.kind);

  const { data } = await q;
  const rows = (data || []) as any[];
  const keywords = new Set(
    String(query || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  return rows
    .map((r) => {
      const text = String(r.content).toLowerCase();
      let hits = 0;
      for (const k of keywords) if (text.includes(k)) hits++;
      const score = hits + Number(r.weight || 0) / 20;
      return { row: r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, matchCount)
    .map((x) => ({
      id: x.row.id,
      kind: x.row.kind,
      content: x.row.content,
      weight: Number(x.row.weight) || 0,
      similarity: 0,
    }));
}

/**
 * recallBrainContext — the high-level helper the generator uses. Pulls a
 * balanced slice across the kinds that matter for writing on-brand, original
 * content, and returns it grouped.
 */
export async function recallBrainContext(query: string, niche?: string | null, account?: string | null): Promise<{
  algorithm: Recalled[];
  patterns: Recalled[];
  voice: Recalled[];
  winners: Recalled[];
  avoid: Recalled[];
}> {
  // account scoping: global rows (null) + this account's rows are returned;
  // other accounts' private voice/outcome/anti_pattern never leak in.
  const [algorithm, patterns, voice, winners, avoid] = await Promise.all([
    recall(query, { kind: 'algorithm', niche, account, matchCount: 5, minWeight: 3, markUsage: false }),
    recall(query, { kind: 'source_pattern', niche, account, matchCount: 4, markUsage: false }),
    recall(query, { kind: 'voice', niche, account, matchCount: 3, markUsage: false }),
    recall(query, { kind: 'outcome', niche, account, matchCount: 4, markUsage: false }),
    recall(query, { kind: 'anti_pattern', niche, account, matchCount: 3, markUsage: false }),
  ]);
  return { algorithm, patterns, voice, winners, avoid };
}
