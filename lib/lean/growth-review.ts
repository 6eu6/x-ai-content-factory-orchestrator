/**
 * Lean Core — Growth engine (performance review + strategy)
 *
 * Turns the system from a suggestion maker into a growth engine: it tracks the
 * true-north metric (followers over time), studies what actually worked on the
 * account, and writes a STRATEGY memo back into the brain that steers future
 * generation. This is the "review its decisions, analyse, plan" layer.
 *
 * Cheap: one daily profile read + one weekly model call.
 */

import { supabaseAdmin } from '../supabase';
import { getXUserByUsername } from '../x';
import { remember } from '../brain';
import { callModel, parseModelJson } from '../model-router';
import type { Profile } from './profile';

/** Daily: record the account's follower/posts counts so we can see real growth. */
export async function snapshotAccount(profile: Profile): Promise<void> {
  const handle = profile.accountHandle.replace(/^@/, '');
  try {
    const u = await getXUserByUsername(handle);
    await supabaseAdmin().from('growth_snapshots').insert({
      account_handle: handle,
      followers: u.followers_count ?? null,
      following: u.following_count ?? null,
      posts_count: u.tweet_count ?? null,
    });
  } catch {
    /* non-fatal */
  }
}

export type ReviewReport = { measured_posts: number; follower_delta: number | null; strategy: string | null };

/**
 * Weekly: aggregate the last 14 days of measured outcomes by type, read the
 * follower delta, and write (a) a deterministic per-type signal and (b) a model
 * strategy memo — both as account-private `insight` memories the generator recalls.
 */
export async function runPerformanceReview(profile: Profile): Promise<ReviewReport> {
  const supabase = supabaseAdmin();
  const handle = profile.accountHandle.replace(/^@/, '');
  const report: ReviewReport = { measured_posts: 0, follower_delta: null, strategy: null };

  // Outcomes by content type (last 14 days).
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data: decisions } = await supabase
    .from('published_decisions')
    .select('content_type, outcome_score, published_text, performance_payload, created_at')
    .eq('account_handle', handle)
    .not('outcome_score', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);
  const rows = (decisions || []) as any[];
  report.measured_posts = rows.length;

  const byType: Record<string, { n: number; sum: number }> = {};
  for (const r of rows) {
    const tp = String(r.content_type || 'unknown');
    const b = (byType[tp] ||= { n: 0, sum: 0 });
    b.n++;
    b.sum += Number(r.outcome_score) || 0;
  }
  const typeStats = Object.entries(byType).map(([type, b]) => ({ type, n: b.n, avg: b.sum / b.n }));

  // Follower delta over ~7 days from snapshots.
  const { data: snaps } = await supabase
    .from('growth_snapshots')
    .select('followers, captured_at')
    .eq('account_handle', handle)
    .order('captured_at', { ascending: false })
    .limit(30);
  const snapRows = (snaps || []) as any[];
  if (snapRows.length >= 2) {
    const latest = Number(snapRows[0]?.followers);
    const weekAgo = snapRows.find((s) => Date.parse(s.captured_at) <= Date.now() - 6 * 86_400_000);
    const base = weekAgo ? Number(weekAgo.followers) : Number(snapRows[snapRows.length - 1]?.followers);
    if (Number.isFinite(latest) && Number.isFinite(base)) report.follower_delta = latest - base;
  }

  // (a) Deterministic per-type signal (no model needed).
  if (typeStats.length >= 2) {
    typeStats.sort((a, b) => b.avg - a.avg);
    const best = typeStats[0];
    const worst = typeStats[typeStats.length - 1];
    await remember({
      kind: 'insight',
      content: `For @${handle}, ${best.type} posts outperform (avg ${best.avg.toFixed(1)}, n=${best.n}) while ${worst.type} underperform (avg ${worst.avg.toFixed(1)}, n=${worst.n}) over the last 14 days — favour ${best.type}, do less ${worst.type}.`,
      weight: 7,
      niche: profile.niche,
      language: profile.tweetLanguage,
      accountHandle: handle,
      source: 'performance_review',
    });
  }

  // (b) Model strategy memo — only when there is something to learn from.
  if (rows.length >= 3) {
    const sample = rows.slice(0, 12).map((r) => `(${r.content_type}, score ${r.outcome_score}) ${String(r.published_text || '').slice(0, 120)}`).join('\n');
    const system = [
      `You are a growth strategist reviewing the X account @${handle} in niche "${profile.niche}".`,
      `Follower change in the last week: ${report.follower_delta == null ? 'unknown' : report.follower_delta}.`,
      'Given the account\'s own recent posts and their outcome scores, write a SHORT strategy for the next week.',
      'Be specific and operator-like: what angle/type/source to do MORE of, what to STOP, how to sharpen positioning. No fluff, no generic advice.',
      'Return ONLY JSON: {"strategy":"<2-4 crisp sentences the generator can follow>"}',
    ].join('\n');
    try {
      const raw = await callModel('performance_analysis', [
        { role: 'system', content: system },
        { role: 'user', content: sample },
      ], { response_format: { type: 'json_object' }, max_tokens: 500 });
      const strategy = String(parseModelJson(raw)?.strategy || '').trim();
      if (strategy.length > 20) {
        report.strategy = strategy;
        await remember({
          kind: 'insight',
          content: `WEEKLY STRATEGY for @${handle}: ${strategy}`,
          weight: 8, // high — this steers generation
          niche: profile.niche,
          language: profile.tweetLanguage,
          accountHandle: handle,
          source: 'weekly_strategy',
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  return report;
}
