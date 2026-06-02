/**
 * Lean Core — Auto-detect manually published posts
 *
 * Publishing is manual. This removes the friction of logging it: each worker
 * cycle we read OUR OWN recent timeline and match posts against the
 * opportunities we suggested. A match auto-logs to published_decisions and
 * teaches the brain — no "published <url>" message or ✅ tap required.
 *
 * Matching is robust to edits: the strongest signal is the reply/quote TARGET
 * (your reply carries the source tweet id even if you reworded the text); text
 * similarity is a fallback. Unrelated manual tweets match nothing and are never
 * logged. This module never posts to X.
 */

import { supabaseAdmin } from '../supabase';
import { getXUserTimeline, scoreXTweet } from '../x';
import { remember } from '../brain';
import type { Profile } from './profile';

type OppRow = {
  id: string;
  tweet_id: string;
  source_url: string | null;
  action: string | null;
  suggestion_text: string | null;
};

type OwnPost = {
  id: string;
  text: string;
  is_reply: boolean;
  in_reply_to_tweet_id: string | null;
  is_quote: boolean;
  quoted_tweet_id: string | null;
};

export type Match = { opp: OppRow; confidence: 'strong' | 'medium'; reason: string };

/** Token-overlap similarity in [0,1]. */
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = norm(a); const B = norm(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / Math.max(A.size, B.size);
}

/**
 * Pure matcher: decide whether one of our posts corresponds to a suggested
 * opportunity. Strong = reply/quote target id matches the source tweet. Medium
 * = high text similarity. Returns null when nothing matches confidently.
 */
export function matchPostToOpportunity(post: OwnPost, opps: OppRow[], simThreshold = 0.6): Match | null {
  // Strong: the post is a reply/quote whose target is the opportunity's source tweet.
  for (const o of opps) {
    if (!o.tweet_id) continue;
    if (post.is_reply && post.in_reply_to_tweet_id && String(post.in_reply_to_tweet_id) === String(o.tweet_id)) {
      return { opp: o, confidence: 'strong', reason: 'reply_target_match' };
    }
    if (post.is_quote && post.quoted_tweet_id && String(post.quoted_tweet_id) === String(o.tweet_id)) {
      return { opp: o, confidence: 'strong', reason: 'quote_target_match' };
    }
  }
  // Medium: text similarity to a suggestion.
  let best: Match | null = null;
  let bestSim = simThreshold;
  for (const o of opps) {
    const sim = textSimilarity(post.text, o.suggestion_text || '');
    if (sim >= bestSim) { bestSim = sim; best = { opp: o, confidence: 'medium', reason: `text_sim_${sim.toFixed(2)}` }; }
  }
  return best;
}

export type AutoDetectReport = { scanned: number; matched: number; logged: number };

export async function autoDetectPublished(profile: Profile): Promise<AutoDetectReport> {
  const supabase = supabaseAdmin();
  const handle = profile.accountHandle.replace(/^@/, '');
  const report: AutoDetectReport = { scanned: 0, matched: 0, logged: 0 };

  // Our own recent posts (include replies; that's where reply opportunities land).
  let posts: any[] = [];
  try {
    posts = await getXUserTimeline(handle, 20, true);
  } catch {
    return report;
  }
  const cutoff = Date.now() - 48 * 3_600_000;
  const recentPosts: OwnPost[] = posts
    .filter((t) => {
      const ts = t.created_at ? Date.parse(t.created_at) : NaN;
      return Number.isNaN(ts) || ts >= cutoff; // keep if fresh or unknown date
    })
    .map((t) => ({
      id: String(t.id || ''),
      text: String(t.text || ''),
      is_reply: Boolean(t.is_reply),
      in_reply_to_tweet_id: t.in_reply_to_tweet_id || null,
      is_quote: Boolean(t.is_quote_tweet),
      quoted_tweet_id: t.quoted_tweet_id || null,
      _metrics: t.public_metrics,
      _eng: scoreXTweet(t),
    } as OwnPost & { _metrics: any; _eng: number }));
  report.scanned = recentPosts.length;
  if (!recentPosts.length) return report;

  // Candidate opportunities: recently surfaced, not yet marked published.
  const { data: oppData } = await supabase
    .from('opportunities')
    .select('id, tweet_id, source_url, action, suggestion_text')
    .eq('account_handle', handle)
    .neq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(200);
  const opps = (oppData || []) as OppRow[];
  if (!opps.length) return report;

  // Already-logged URLs (dedupe).
  const { data: loggedRows } = await supabase
    .from('published_decisions')
    .select('published_url')
    .eq('account_handle', handle)
    .order('created_at', { ascending: false })
    .limit(200);
  const loggedUrls = new Set((loggedRows || []).map((r: any) => String(r.published_url || '')));

  for (const post of recentPosts) {
    const match = matchPostToOpportunity(post, opps);
    if (!match) continue;
    report.matched++;

    const url = `https://x.com/${handle}/status/${post.id}`;
    if (loggedUrls.has(url)) continue; // never duplicate

    const { error } = await supabase.from('published_decisions').insert({
      account_handle: handle,
      published_url: url,
      published_text: post.text.slice(0, 500),
      source_tweet_url: match.opp.source_url,
      content_type: match.opp.action || 'reply',
      status: 'published',
      detection_source: 'auto_detected',
      matched_opportunity_id: match.opp.id,
      performance_payload: { initial: (post as any)._metrics, engagement: (post as any)._eng, match: match.reason },
    });
    if (error) continue;

    loggedUrls.add(url);
    await supabase.from('opportunities').update({ status: 'published' }).eq('id', match.opp.id);
    // Teach the brain: the human published from this suggestion → endorsed voice.
    await remember({
      kind: 'voice',
      content: match.opp.suggestion_text || post.text,
      weight: 6,
      niche: profile.niche,
      language: profile.tweetLanguage,
      source: 'auto_detected_publish',
    }).catch(() => {});
    report.logged++;
  }

  return report;
}
