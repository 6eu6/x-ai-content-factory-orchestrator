/**
 * Lean Core — Feedback (inward learning)
 *
 * Closes the loop the legacy system never closed: take the posts we actually
 * published, fetch their real engagement from X, score them, and write the
 * lesson back into the brain. Strong posts become positive `outcome` memories;
 * weak ones become `anti_pattern` memories.
 *
 * This is what makes the system improve from THIS account's reality instead of
 * scraped strangers.
 */

import { supabaseAdmin } from '../supabase';
import { getTweetsByIds, tweetIdFromUrl, scoreXTweet } from '../x';
import { recordOutcome } from '../brain';
import { getActiveProfile } from './profile';

export type FeedbackReport = {
  scanned: number;
  measured: number;
  learned: number;
  details: { url: string; engagement: number; outcome: number }[];
};

/** Absolute engagement bands — used as a cold-start fallback. */
export function absoluteOutcomeScore(engagement: number): number {
  if (engagement <= 0) return 1;
  if (engagement < 5) return 3;
  if (engagement < 20) return 5;
  if (engagement < 60) return 7;
  if (engagement < 150) return 8.5;
  return 10;
}

/**
 * Account-relative score: "did this beat MY usual?" — far more meaningful for a
 * small account than absolute counts. Compares against the median of recent
 * posts. Falls back to absolute bands until we have a few measured posts.
 */
export function relativeOutcomeScore(engagement: number, baselineMedian: number | null): number {
  if (baselineMedian == null || baselineMedian <= 0) return absoluteOutcomeScore(engagement);
  const ratio = engagement / baselineMedian;
  if (ratio >= 3) return 10;
  if (ratio >= 2) return 8.5;
  if (ratio >= 1.2) return 7;
  if (ratio >= 0.8) return 5;
  if (ratio >= 0.4) return 3;
  return 1;
}

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export async function runFeedbackScan(opts?: { accountHandle?: string; limit?: number }): Promise<FeedbackReport> {
  const supabase = supabaseAdmin();
  const profile = await getActiveProfile(opts?.accountHandle).catch(() => null);
  const handle = (opts?.accountHandle || profile?.accountHandle || ' 30piq').replace(/^@/, '').trim();
  const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);

  // Published posts that have a URL but no recorded outcome yet, old enough to
  // have accumulated engagement (at least ~24h).
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data } = await supabase
    .from('published_decisions')
    .select('id, published_url, published_text, content_type, created_at')
    .eq('account_handle', handle)
    .is('outcome_score', null)
    .not('published_url', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (data || []) as any[];
  const idMap = new Map<string, any>();
  for (const r of rows) {
    const id = tweetIdFromUrl(r.published_url);
    if (id) idMap.set(id, r);
  }

  const report: FeedbackReport = { scanned: rows.length, measured: 0, learned: 0, details: [] };
  if (!idMap.size) return report;

  // Baseline = median engagement of recent already-measured posts (account-relative).
  const { data: prior } = await supabase
    .from('published_decisions')
    .select('performance_payload')
    .eq('account_handle', handle)
    .not('outcome_score', 'is', null)
    .order('created_at', { ascending: false })
    .limit(30);
  const baseline = median((prior || []).map((p: any) => Number(p?.performance_payload?.engagement)).filter((n: number) => Number.isFinite(n)));

  const tweets = await getTweetsByIds([...idMap.keys()]);

  for (const t of tweets) {
    const row = idMap.get(String(t.id));
    if (!row) continue;
    const engagement = scoreXTweet(t);
    const outcome = relativeOutcomeScore(engagement, baseline);
    report.measured++;

    await supabase
      .from('published_decisions')
      .update({
        outcome_score: outcome,
        outcome_label: outcome >= 7 ? 'success' : outcome <= 3 ? 'weak' : 'average',
        performance_checked_at: new Date().toISOString(),
        performance_payload: { metrics: t.public_metrics, engagement },
        feedback_applied_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    await recordOutcome({
      text: String(row.published_text || t.text || '').slice(0, 240),
      type: String(row.content_type || 'standalone'),
      outcomeScore: outcome,
      niche: profile?.niche ?? null,
      language: profile?.tweetLanguage ?? 'en',
      accountHandle: handle,
    });
    report.learned++;
    report.details.push({ url: row.published_url, engagement: Math.round(engagement), outcome });
  }

  return report;
}
