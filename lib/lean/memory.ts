/**
 * Lean Core — Real learning memory (lightweight RAG)
 *
 * The legacy system "learned" from 3,000+ rules scraped off OTHER people's
 * viral tweets, while the account's own published results table stayed empty.
 * That is learning theater: it never closes the loop on what actually worked
 * for THIS account.
 *
 * This module does the opposite and only that:
 *   - getWinningExamples(): retrieve the account's own best-performing posts
 *     to use as few-shot exemplars for the generator (retrieval-augmented).
 *   - getRecentlyPublished(): avoid suggesting near-duplicates of what was
 *     just posted.
 *
 * As the account publishes and outcomes are recorded (published_decisions /
 * content_log), the generator's few-shot context gets steadily better — a real,
 * compounding learning loop with zero extra infrastructure.
 */

import { supabaseAdmin } from '../supabase';

export type WinningExample = {
  text: string;
  type: string;
  score: number;
  source: 'published_decisions' | 'content_log';
};

/**
 * Returns the account's own best posts as exemplars. Falls back to an empty
 * list (cold start) — the generator handles that gracefully with its persona.
 */
export async function getWinningExamples(accountHandle: string, limit = 6): Promise<WinningExample[]> {
  const supabase = supabaseAdmin();
  const examples: WinningExample[] = [];

  // 1) Decisions we published that have a recorded outcome score.
  try {
    const { data } = await supabase
      .from('published_decisions')
      .select('published_text, content_type, outcome_score, outcome_label')
      .eq('account_handle', accountHandle)
      .not('outcome_score', 'is', null)
      .order('outcome_score', { ascending: false })
      .limit(limit);
    for (const row of data || []) {
      const text = String((row as any).published_text || '').trim();
      if (text) {
        examples.push({
          text,
          type: String((row as any).content_type || 'standalone'),
          score: Number((row as any).outcome_score) || 0,
          source: 'published_decisions',
        });
      }
    }
  } catch {
    /* table optional — ignore */
  }

  // 2) Content log entries with real engagement (views/performance).
  if (examples.length < limit) {
    try {
      const { data } = await supabase
        .from('content_log')
        .select('final_text, content_type, performance_score, views')
        .order('performance_score', { ascending: false, nullsFirst: false })
        .limit(limit);
      for (const row of data || []) {
        const text = String((row as any).final_text || '').trim();
        const views = Number((row as any).views) || 0;
        const perf = Number((row as any).performance_score) || 0;
        // Only count it as a "winner" if it actually got traction.
        if (text && (perf > 0 || views > 0)) {
          examples.push({
            text,
            type: String((row as any).content_type || 'standalone'),
            score: perf || views / 1000,
            source: 'content_log',
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Dedupe by normalized text, keep highest score, cap to limit.
  const seen = new Map<string, WinningExample>();
  for (const ex of examples) {
    const key = ex.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    const prev = seen.get(key);
    if (!prev || ex.score > prev.score) seen.set(key, ex);
  }
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Recently published text (any outcome), so the generator can avoid repeating
 * itself. Cheap dedupe signal — keeps the feed feeling fresh.
 */
export async function getRecentlyPublished(accountHandle: string, limit = 25): Promise<string[]> {
  const supabase = supabaseAdmin();
  try {
    const { data } = await supabase
      .from('published_decisions')
      .select('published_text')
      .eq('account_handle', accountHandle)
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || [])
      .map((r: any) => String(r.published_text || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
