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
import { optionalEnv } from '../env';
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

/** Reply / quote / standalone from a post's flags. */
export function postContentType(post: { is_reply: boolean; is_quote: boolean }): 'reply' | 'quote' | 'standalone' {
  if (post.is_quote) return 'quote';
  if (post.is_reply) return 'reply';
  return 'standalone';
}

export type AutoDetectReport = {
  scanned: number;
  matched: number;
  inserted: number;
  skipped_duplicates: number;
  unmatched: number;
  manual_logged: number;
};

function logManualEnabled(): boolean {
  const v = (optionalEnv('LEAN_LOG_MANUAL_POSTS', 'true')).toLowerCase().trim();
  return v !== 'false' && v !== '0';
}

/**
 * Reads our own recent timeline and logs published posts so the learning loop
 * can score them. A post that matches a suggested opportunity (radar OR daily
 * digest) is logged as auto_detected; any other recent original/reply/quote we
 * posted is logged as manual_timeline so free posts are learned from too.
 * Dedupes by published_url. Never posts to X.
 */
export async function autoDetectPublished(profile: Profile): Promise<AutoDetectReport> {
  const supabase = supabaseAdmin();
  const handle = profile.accountHandle.replace(/^@/, '');
  const report: AutoDetectReport = { scanned: 0, matched: 0, inserted: 0, skipped_duplicates: 0, unmatched: 0, manual_logged: 0 };

  let posts: any[] = [];
  try {
    posts = await getXUserTimeline(handle, 20, true);
  } catch {
    return report;
  }
  const cutoff = Date.now() - 48 * 3_600_000;
  const recentPosts = posts
    .filter((t) => {
      const ts = t.created_at ? Date.parse(t.created_at) : NaN;
      return Number.isNaN(ts) || ts >= cutoff;
    })
    .map((t) => ({
      id: String(t.id || ''),
      text: String(t.text || ''),
      is_reply: Boolean(t.is_reply),
      in_reply_to_tweet_id: t.in_reply_to_tweet_id || null,
      is_quote: Boolean(t.is_quote_tweet),
      quoted_tweet_id: t.quoted_tweet_id || null,
      metrics: t.public_metrics,
      eng: scoreXTweet(t),
    }));
  report.scanned = recentPosts.length;
  if (!recentPosts.length) return report;

  // Suggested opportunities (radar + daily digest), not yet published.
  const { data: oppData } = await supabase
    .from('opportunities')
    .select('id, tweet_id, source_url, action, suggestion_text')
    .eq('account_handle', handle)
    .neq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(200);
  const opps = (oppData || []) as OppRow[];

  // Already-logged URLs (dedupe).
  const { data: loggedRows } = await supabase
    .from('published_decisions')
    .select('published_url')
    .eq('account_handle', handle)
    .order('created_at', { ascending: false })
    .limit(300);
  const loggedUrls = new Set((loggedRows || []).map((r: any) => String(r.published_url || '')));
  const allowManual = logManualEnabled();

  for (const post of recentPosts) {
    if (!post.id || post.text.trim().length < 8) continue;
    const url = `https://x.com/${handle}/status/${post.id}`;
    if (loggedUrls.has(url)) { report.skipped_duplicates++; continue; }

    const match = opps.length ? matchPostToOpportunity(post, opps) : null;
    const ctype = postContentType(post);

    if (match) {
      report.matched++;
      const { error } = await supabase.from('published_decisions').insert({
        account_handle: handle,
        published_url: url,
        published_text: post.text.slice(0, 500),
        source_tweet_url: match.opp.source_url,
        content_type: match.opp.action || ctype,
        status: 'published',
        detection_source: 'auto_detected',
        matched_opportunity_id: match.opp.id,
        performance_payload: { initial: post.metrics, engagement: post.eng, match: match.reason },
      });
      if (error) continue;
      loggedUrls.add(url);
      report.inserted++;
      await supabase.from('opportunities').update({ status: 'published' }).eq('id', match.opp.id);
      await remember({
        kind: 'voice', content: match.opp.suggestion_text || post.text, weight: 6,
        niche: profile.niche, language: profile.tweetLanguage, accountHandle: handle, source: 'auto_detected_publish',
      }).catch(() => {});
    } else {
      report.unmatched++;
      if (!allowManual) continue;
      const { error } = await supabase.from('published_decisions').insert({
        account_handle: handle,
        published_url: url,
        published_text: post.text.slice(0, 500),
        content_type: ctype,
        status: 'published',
        detection_source: 'manual_timeline',
        matched_opportunity_id: null,
        performance_payload: { initial: post.metrics, engagement: post.eng },
      });
      if (error) continue;
      loggedUrls.add(url);
      report.inserted++;
      report.manual_logged++;
      // The account's own published text is genuine voice — lower weight than a
      // suggestion the human picked, but still a real signal.
      await remember({
        kind: 'voice', content: post.text, weight: 4,
        niche: profile.niche, language: profile.tweetLanguage, accountHandle: handle, source: 'manual_timeline',
      }).catch(() => {});
    }
  }

  return report;
}
