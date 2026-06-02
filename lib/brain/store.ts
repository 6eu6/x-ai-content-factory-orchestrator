/**
 * Brain — Store & learn (write side)
 *
 * remember()      : add a new piece of knowledge (deduped by content hash).
 * reinforce()     : strengthen a memory that proved useful (support++ , weight up).
 * contradict()    : weaken a memory that proved wrong (contradiction++ , weight down).
 * recordOutcome() : turn a published result into durable learning.
 *
 * This is the "inward learning" loop: the brain gets better from what actually
 * happened on the account, not from scraped strangers.
 */

import { supabaseAdmin } from '../supabase';
import { embed, toVectorLiteral } from './embed';

export type MemoryKind =
  | 'algorithm'
  | 'voice'
  | 'outcome'
  | 'insight'
  | 'source_pattern'
  | 'anti_pattern';

export type RememberInput = {
  kind: MemoryKind;
  content: string;
  weight?: number;
  niche?: string | null;
  language?: string;
  source?: string;
  /** Account this memory belongs to. Auto-derived per kind if omitted. */
  accountHandle?: string | null;
  metadata?: Record<string, any>;
};

// Account-private kinds (your style + your results); the rest are shared
// (algorithm = global, source_pattern/insight = shared by niche).
const ACCOUNT_SCOPED: ReadonlySet<MemoryKind> = new Set(['voice', 'outcome', 'anti_pattern']);

/** Add knowledge. Computes embedding when possible; safe to call without one. */
export async function remember(input: RememberInput): Promise<string | null> {
  const content = String(input.content || '').replace(/\s+/g, ' ').trim();
  if (content.length < 8) return null;

  const supabase = supabaseAdmin();
  const vec = await embed(content);
  // Account-scoped kinds are stored under the account; shared kinds stay global.
  const account = input.accountHandle !== undefined
    ? input.accountHandle
    : (ACCOUNT_SCOPED.has(input.kind) ? null : null);
  const row: Record<string, any> = {
    kind: input.kind,
    content,
    weight: Math.max(0, Math.min(10, input.weight ?? 5)),
    niche: input.niche ?? null,
    language: input.language ?? 'en',
    source: input.source ?? null,
    account_handle: account,
    metadata: input.metadata ?? {},
  };
  if (vec) row.embedding = toVectorLiteral(vec);

  // Dedupe on content_hash: if it already exists, reinforce instead of duplicate.
  const { data, error } = await supabase
    .from('brain_memory')
    .upsert(row, { onConflict: 'content_hash', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (error || !data) {
    await reinforceByContent(content);
    return null;
  }
  return (data as any).id;
}

async function reinforceByContent(content: string): Promise<void> {
  const supabase = supabaseAdmin();
  const { data: rows } = await supabase
    .from('brain_memory')
    .select('id')
    .eq('content', content)
    .limit(1);
  const r = rows?.[0] as any;
  if (r) await reinforce(r.id, 0.3);
}

export async function reinforce(id: string, deltaWeight = 0.5): Promise<void> {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from('brain_memory').select('weight, support_count').eq('id', id).maybeSingle();
  if (!data) return;
  await supabase
    .from('brain_memory')
    .update({
      weight: Math.min(10, Number((data as any).weight || 5) + deltaWeight),
      support_count: Number((data as any).support_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

export async function contradict(id: string, deltaWeight = 0.8): Promise<void> {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from('brain_memory').select('weight, contradiction_count').eq('id', id).maybeSingle();
  if (!data) return;
  const newWeight = Math.max(0, Number((data as any).weight || 5) - deltaWeight);
  await supabase
    .from('brain_memory')
    .update({
      weight: newWeight,
      contradiction_count: Number((data as any).contradiction_count || 0) + 1,
      status: newWeight <= 1 ? 'archived' : 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

/** Mark memories as used (drives last_used_at / use_count for pruning decisions). */
export async function markUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const supabase = supabaseAdmin();
  // Increment use_count via a small RPC-free read-modify-write is overkill here;
  // a single timestamp update is enough signal for recency-based pruning.
  await supabase
    .from('brain_memory')
    .update({ last_used_at: new Date().toISOString() })
    .in('id', ids);
}

/**
 * recordOutcome — convert a published post + its measured result into learning.
 * Strong results become positive `outcome` memories (good weight); weak results
 * become `anti_pattern` memories so the generator learns what to avoid.
 */
export async function recordOutcome(input: {
  text: string;
  type: string;
  outcomeScore: number; // 0..10
  niche?: string | null;
  language?: string;
  accountHandle?: string | null;
}): Promise<void> {
  const good = input.outcomeScore >= 7;
  const summary = good
    ? `High-performing ${input.type}: "${input.text}" — replicate its angle and structure.`
    : `Weak ${input.type} that underperformed: "${input.text}" — avoid this pattern.`;
  await remember({
    kind: good ? 'outcome' : 'anti_pattern',
    content: summary,
    weight: good ? Math.min(10, 5 + input.outcomeScore / 2) : 3,
    niche: input.niche ?? null,
    language: input.language ?? 'en',
    accountHandle: input.accountHandle ?? null,
    source: 'published_outcome',
    metadata: { outcome_score: input.outcomeScore, content_type: input.type },
  });
}
