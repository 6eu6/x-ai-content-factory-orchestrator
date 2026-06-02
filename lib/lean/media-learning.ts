/**
 * Lean Core — Media pattern learning
 *
 * The system cannot create images/videos, but it can LEARN how media correlates
 * with engagement in the niche and feed that back as a brain insight, so the
 * generator's media recommendations get smarter over time.
 *
 * Cheap: pure aggregation over already-harvested tweets, one brain write. No
 * extra model call.
 */

import { remember } from '../brain';
import { harvestSources, type HarvestedTweet } from './harvest';
import { loadSourceAccounts, type LeanConfig } from './config';

export async function learnMediaPatterns(cfg: LeanConfig, pre?: HarvestedTweet[]): Promise<string | null> {
  let tweets = pre;
  if (!tweets) {
    const sources = cfg.sourceHandles.length
      ? cfg.sourceHandles.slice(0, cfg.sourceLimit).map((handle) => ({ handle, tier: null, category: null, followers: null }))
      : await loadSourceAccounts(cfg.sourceLimit);
    tweets = await harvestSources(sources, cfg.tweetsPerSource);
  }
  if (tweets.length < 6) return null;

  const buckets: Record<string, { n: number; sum: number }> = {};
  for (const t of tweets) {
    const b = (buckets[t.media_type] ||= { n: 0, sum: 0 });
    b.n++;
    b.sum += t.engagement;
  }

  const stats = Object.entries(buckets)
    .map(([type, b]) => ({ type, n: b.n, avg: b.sum / b.n }))
    .filter((s) => s.n >= 2)
    .sort((a, b) => b.avg - a.avg);
  if (stats.length < 2) return null;

  const best = stats[0];
  const ratio = best.avg / Math.max(1, stats[stats.length - 1].avg);
  const insight =
    `In the niche "${cfg.niche}", ${best.type} posts currently average the highest engagement ` +
    `(~${Math.round(best.avg)} vs ${stats.map((s) => `${s.type}:${Math.round(s.avg)}`).join(', ')}). ` +
    `When the idea fits, recommend ${best.type === 'text' ? 'a sharp text post' : `attaching ${best.type}`} ` +
    `(roughly ${ratio.toFixed(1)}x signal over the weakest format).`;

  await remember({
    kind: 'insight',
    content: insight,
    weight: 6,
    niche: cfg.niche,
    language: cfg.tweetLanguage,
    source: 'media_pattern_learning',
  });
  return insight;
}
