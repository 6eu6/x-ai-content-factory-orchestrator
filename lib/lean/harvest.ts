/**
 * Lean Core — Harvest
 *
 * Pull recent, high-signal tweets from the niche source accounts. This is the
 * raw material the generator reacts to (for replies and quotes) and draws
 * current context from (for standalone posts).
 *
 * Replaces the legacy multi-task "scan_account -> merge_scan_results" queue
 * machinery with one straightforward fetch+rank pass.
 */

import { getXUserTimeline, scoreXTweet } from '../x';
import type { SourceAccount } from './config';

export type HarvestedTweet = {
  source_handle: string;
  source_tier: number | null;
  source_followers: number | null;
  tweet_id: string;
  tweet_url: string;
  text: string;
  created_at: string | null;
  age_hours: number | null;
  engagement: number;
  is_reply: boolean;
  is_quote: boolean;
};

function ageHours(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

/**
 * Harvest recent original tweets from each source. We skip replies (low reach
 * to react to) and keep originals + thread starters. Returns a flat, ranked
 * list — freshest + most engaging first, which is exactly what converts for
 * early replies.
 */
export async function harvestSources(
  sources: SourceAccount[],
  tweetsPerSource: number,
): Promise<HarvestedTweet[]> {
  const out: HarvestedTweet[] = [];

  for (const src of sources) {
    let tweets: any[] = [];
    try {
      tweets = await getXUserTimeline(src.handle, Math.max(5, tweetsPerSource), false);
    } catch {
      continue; // one bad source must not kill the run
    }

    for (const t of tweets) {
      const text = String(t.text || '').trim();
      if (!text) continue;
      if (t.is_reply) continue; // reacting to someone's reply rarely pays off
      out.push({
        source_handle: src.handle,
        source_tier: src.tier,
        source_followers: src.followers,
        tweet_id: String(t.id || ''),
        tweet_url: `https://x.com/${src.handle.replace(/^@/, '')}/status/${t.id}`,
        text,
        created_at: t.created_at || null,
        age_hours: ageHours(t.created_at || null),
        engagement: scoreXTweet(t),
        is_reply: Boolean(t.is_reply),
        is_quote: Boolean(t.is_quote_tweet),
      });
    }
  }

  // Rank: prefer fresh (< 48h) and high engagement. A reply to a 3-day-old
  // tweet is dead on arrival, so freshness is weighted heavily.
  return out
    .map((t) => {
      const freshBoost = t.age_hours == null ? 0 : t.age_hours < 24 ? 1.5 : t.age_hours < 48 ? 1.0 : 0.4;
      return { t, rank: t.engagement * freshBoost };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((x) => x.t);
}
