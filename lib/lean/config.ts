/**
 * Lean Core — Configuration
 *
 * This is the single source of truth for the simplified growth loop.
 * It intentionally replaces the sprawling multi-table strategy config of the
 * legacy pipeline with one small, editable file + a live read of the active
 * source accounts from Supabase.
 *
 * Philosophy: prove the loop on ONE account in ONE niche before adding any
 * generalization (multi-account / multi-language / SaaS). See docs/LEAN_ARCHITECTURE.md.
 */

import { optionalEnv, envNumber } from '../env';
import { supabaseAdmin } from '../supabase';

export type LeanMix = {
  replies: number;
  quotes: number;
  standalone: number;
};

export type LeanConfig = {
  /** The account we are growing. */
  accountHandle: string;
  /** One narrow niche. Broad niches give no identity and do not grow. */
  niche: string;
  /** The voice the suggestions must be written in. Edit this as the account develops a real voice. */
  voice: string;
  /** Hard rules every suggestion must obey (kept short on purpose). */
  rules: string[];
  /** Daily suggestion mix. */
  mix: LeanMix;
  /** How many source accounts to harvest per run. */
  sourceLimit: number;
  /** How many recent tweets to pull per source account. */
  tweetsPerSource: number;
};

/**
 * The default persona. The account @30piq currently has no established voice,
 * so this defines a strong starting persona for the AI niche. Tighten it over
 * time using what actually performs (the RAG memory layer feeds real winners back in).
 */
const DEFAULT_VOICE = [
  'A sharp, specific builder who lives in the AI/tools space.',
  'Writes like a real person, not a brand: concrete, opinionated, occasionally contrarian.',
  'Adds one genuine insight, mechanism, or counter-take — never a generic "this is huge" reaction.',
  'No hashtags. At most one emoji, and only if it adds meaning. No threads.',
].join(' ');

const DEFAULT_RULES = [
  'English only.',
  'Max 280 characters.',
  'One clear idea per post — specific, not vague.',
  'No engagement-bait openers ("hot take", "this is huge", "game changer", "thoughts?").',
  'No invented statistics. If a number is not in the source, do not state it as fact.',
  'A reply must add value to the original tweet, not just agree with it.',
];

export function getLeanConfig(): LeanConfig {
  return {
    accountHandle: optionalEnv('X_USERNAME', '30piq').replace(/^@/, ''),
    niche: optionalEnv('LEAN_NICHE', 'AI tools, AI workflows, and building with AI'),
    voice: optionalEnv('LEAN_VOICE', DEFAULT_VOICE),
    rules: DEFAULT_RULES,
    mix: {
      replies: envNumber('LEAN_REPLIES', 6, 0, 30),
      quotes: envNumber('LEAN_QUOTES', 3, 0, 30),
      standalone: envNumber('LEAN_STANDALONE', 4, 0, 30),
    },
    sourceLimit: envNumber('LEAN_SOURCE_LIMIT', 8, 1, 40),
    tweetsPerSource: envNumber('LEAN_TWEETS_PER_SOURCE', 5, 1, 20),
  };
}

export type SourceAccount = {
  handle: string;
  tier: number | null;
  category: string | null;
  followers: number | null;
};

/**
 * Loads the active source accounts to harvest from, ordered so we rotate
 * across tiers instead of always hitting the same mega-accounts. Replies to
 * mid-size accounts (tier 2/3) convert far better for a new account than
 * replies buried under a 2M-follower post.
 */
export async function loadSourceAccounts(limit: number): Promise<SourceAccount[]> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from('accounts')
    .select('handle, tier, category, followers')
    .eq('active', true);

  if (error || !data?.length) return [];

  // Prioritise accounts we have replied to least recently is ideal, but keep it
  // simple here: interleave by tier so a run mixes reach (tier 1) with
  // reply-visibility (tier 2/3).
  const byTier: Record<number, SourceAccount[]> = {};
  for (const a of data as SourceAccount[]) {
    const t = a.tier ?? 3;
    (byTier[t] ||= []).push(a);
  }
  for (const t of Object.keys(byTier)) {
    byTier[Number(t)].sort(() => Math.random() - 0.5);
  }

  const interleaved: SourceAccount[] = [];
  const tiers = Object.keys(byTier).map(Number).sort();
  let added = true;
  while (added && interleaved.length < limit) {
    added = false;
    for (const t of tiers) {
      const next = byTier[t].shift();
      if (next) {
        interleaved.push(next);
        added = true;
        if (interleaved.length >= limit) break;
      }
    }
  }
  return interleaved.slice(0, limit);
}
