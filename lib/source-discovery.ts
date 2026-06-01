/**
 * source-discovery.ts — Dynamic AI-driven source account discovery
 *
 * GATED BEHIND ENABLE_DYNAMIC_SOURCE_DISCOVERY=true (default: false).
 * When disabled, runSourceDiscoveryIfEnabled() returns immediately with a no-op result.
 *
 * Instead of manually curating a fixed list of source accounts, this module
 * uses the AI and X/web search to dynamically discover relevant accounts
 * based on the @30piq niche model.
 *
 * Discovery flow:
 * 1. Analyzes the current account pool — are there enough active sources?
 * 2. Uses AI to generate niche-relevant search queries
 * 3. Searches X and the web for active, relevant accounts
 * 4. Evaluates candidates before adding them to the pool
 * 5. Prunes consistently poor-performing accounts
 *
 * Limits (hardcoded constants, never from DB):
 * - MAX_TOTAL_ACCOUNTS: absolute cap on pool size
 * - MAX_NEW_ACCOUNTS_PER_RUN: how many new accounts can be added per run
 * - MIN_ACCOUNT_POOL_SIZE: trigger discovery if pool drops below this
 * - MAX_DISCOVERY_QUERIES_PER_RUN: limit API calls per run
 */

import { optionalEnv } from './env';
import { supabaseAdmin } from './supabase';
import { callModel, parseModelJson } from './model-router';
import { searchXTweets } from './x';
import { webSearch } from './web-search';
import { isValidXHandle } from './pipeline-queue';
import { computeSourceQualityScore, loadSourceQualityScores } from './source-quality';

// ═══ Feature Flag ═══

/** Whether dynamic source discovery is enabled. Default: false. */
export function isDynamicSourceDiscoveryEnabled(): boolean {
  return optionalEnv('ENABLE_DYNAMIC_SOURCE_DISCOVERY', 'false').toLowerCase() === 'true';
}

// ═══ Constants ═══

/** Absolute maximum accounts in the pool. Never exceeded. */
export const MAX_TOTAL_ACCOUNTS = 40;

/** Maximum new accounts added per discovery run. Prevents runaway growth. */
export const MAX_NEW_ACCOUNTS_PER_RUN = 3;

/** Trigger discovery if pool drops below this size. */
const MIN_ACCOUNT_POOL_SIZE = 5;

/** Maximum AI-generated search queries per discovery run. Limits API cost. */
const MAX_DISCOVERY_QUERIES_PER_RUN = 4;

/** Maximum web search results to evaluate per query. */
const MAX_RESULTS_PER_QUERY = 10;

/** Accounts with quality score below this AND >= 3 scans are candidates for pruning. */
const PRUNE_QUALITY_THRESHOLD = 20;

/** Minimum scans before an account can be pruned. Prevents premature removal. */
const MIN_SCANS_BEFORE_PRUNE = 3;

// ═══ Types ═══

export type DiscoveredAccount = {
  handle: string;
  discovery_reason: string;
  discovery_source: 'x_search' | 'web_search' | 'ai_suggestion';
  estimated_relevance: number; // 1-10
};

export type DiscoveryResult = {
  discovered: DiscoveredAccount[];
  added: string[];           // handles actually added to the pool
  skipped_existing: string[]; // already in pool
  skipped_invalid: string[]; // invalid handles
  pruned: string[];          // handles pruned from pool
  pool_size_before: number;
  pool_size_after: number;
  discovery_triggered: boolean;
  discovery_reason: string;
  queries_used: string[];
  /** True if the feature flag was off and this was a no-op */
  disabled_by_flag?: boolean;
};

// ═══ Niche Context for Discovery ═══

/**
 * The niche context used to guide AI discovery queries.
 * This MUST stay in sync with niche-alignment.ts and opportunity-intelligence.ts.
 */
const NICHE_CONTEXT = `@30piq is an X account focused on:
- AI tools, AI-native workflows, automation, productivity
- Digital leverage, career growth, skill acquisition
- Creator growth, internet business, startups, indie hacking
- Founder/operator workflows, software/product workflows
- Internet behavior, digital culture, attention economy
- Future of work, systems and tools, building, shipping

The account covers broader high-engagement topics when they have a clear
transferable angle for builders/operators/creators/AI-native workers.

We need to discover active X accounts that consistently post about these topics
and have real engagement (not just follower counts — active discussions, replies,
quotes from real people).`;

// ═══ Gated Entry Point ═══

/** No-op result returned when the feature flag is disabled. */
const DISABLED_RESULT: DiscoveryResult = {
  discovered: [],
  added: [],
  skipped_existing: [],
  skipped_invalid: [],
  pruned: [],
  pool_size_before: 0,
  pool_size_after: 0,
  discovery_triggered: false,
  discovery_reason: 'feature_flag_disabled',
  queries_used: [],
  disabled_by_flag: true,
};

/**
 * Gate function: only runs source discovery if ENABLE_DYNAMIC_SOURCE_DISCOVERY=true.
 * Returns a no-op result when disabled. Safe to call from any pipeline step.
 */
export async function runSourceDiscoveryIfEnabled(options?: {
  forceDiscovery?: boolean;
  maxNewAccounts?: number;
}): Promise<DiscoveryResult> {
  if (!isDynamicSourceDiscoveryEnabled()) {
    console.log('[source-discovery] DISABLED — ENABLE_DYNAMIC_SOURCE_DISCOVERY not set to true');
    return { ...DISABLED_RESULT };
  }
  return runSourceDiscovery(options);
}

// ═══ Main Discovery Function ═══

/**
 * Run the dynamic source discovery process.
 *
 * Steps:
 * 1. Check current pool size and health
 * 2. If pool is too small or stale, trigger discovery
 * 3. Generate search queries via AI
 * 4. Search X and web for candidate accounts
 * 5. Evaluate and add valid candidates
 * 6. Prune consistently poor-performing accounts
 *
 * Returns a DiscoveryResult with full diagnostics.
 * Never throws — errors are caught and returned in the result.
 */
export async function runSourceDiscovery(options?: {
  forceDiscovery?: boolean;
  maxNewAccounts?: number;
}): Promise<DiscoveryResult> {
  const supabase = supabaseAdmin();
  const maxNew = options?.maxNewAccounts ?? MAX_NEW_ACCOUNTS_PER_RUN;
  const forceDiscovery = options?.forceDiscovery ?? false;

  const emptyResult: DiscoveryResult = {
    discovered: [],
    added: [],
    skipped_existing: [],
    skipped_invalid: [],
    pruned: [],
    pool_size_before: 0,
    pool_size_after: 0,
    discovery_triggered: false,
    discovery_reason: '',
    queries_used: [],
  };

  try {
    // ── Step 1: Check current pool ──
    const { data: existingAccounts, error: fetchError } = await supabase
      .from('accounts')
      .select('handle, tier, category, last_checked, followers')
      .order('tier', { ascending: true });

    if (fetchError || !existingAccounts?.length) {
      emptyResult.discovery_triggered = true;
      emptyResult.discovery_reason = 'no_accounts_in_pool';
      console.log('[source-discovery] No accounts in pool — triggering discovery');
      // Continue with discovery even if pool is empty
    }

    const validExisting = (existingAccounts || []).filter(
      (a: any) => isValidXHandle(a.handle)
    );
    const existingHandles = new Set(validExisting.map((a: any) => a.handle.toLowerCase()));

    emptyResult.pool_size_before = validExisting.length;

    // ── Step 2: Decide whether to trigger discovery ──
    const poolTooSmall = validExisting.length < MIN_ACCOUNT_POOL_SIZE;
    const shouldDiscover = forceDiscovery || poolTooSmall;

    if (!shouldDiscover && validExisting.length >= MIN_ACCOUNT_POOL_SIZE) {
      // Check if accounts are stale (none checked in 7 days)
      const now = Date.now();
      const staleThreshold = 7 * 24 * 60 * 60 * 1000;
      const staleCount = validExisting.filter((a: any) => {
        if (!a.last_checked) return true;
        return now - new Date(a.last_checked).getTime() > staleThreshold;
      }).length;

      if (staleCount < Math.ceil(validExisting.length * 0.5)) {
        console.log(`[source-discovery] Pool healthy (${validExisting.length} accounts, ${staleCount} stale) — skipping discovery`);
        emptyResult.discovery_reason = `pool_healthy_${validExisting.length}_accounts`;
        return {
          ...emptyResult,
          pool_size_before: validExisting.length,
          pool_size_after: validExisting.length,
        };
      }
    }

    console.log(`[source-discovery] Triggering discovery (pool: ${validExisting.length}, force: ${forceDiscovery})`);
    emptyResult.discovery_triggered = true;

    if (poolTooSmall) {
      emptyResult.discovery_reason = `pool_too_small_${validExisting.length}_accounts`;
    } else {
      emptyResult.discovery_reason = 'forced_discovery';
    }

    // ── Step 3: Generate discovery queries via AI ──
    const queries = await generateDiscoveryQueries(existingHandles);
    emptyResult.queries_used = queries;

    if (queries.length === 0) {
      console.log('[source-discovery] No discovery queries generated');
      return {
        ...emptyResult,
        pool_size_after: validExisting.length,
      };
    }

    // ── Step 4: Search for candidate accounts ──
    const allCandidates = new Map<string, DiscoveredAccount>();

    for (const query of queries.slice(0, MAX_DISCOVERY_QUERIES_PER_RUN)) {
      try {
        // Search X tweets to find relevant accounts
        const tweets = await searchXTweets(query, 'Top', MAX_RESULTS_PER_QUERY);
        for (const tweet of tweets) {
          const handle = extractHandleFromTweet(tweet);
          if (handle && !existingHandles.has(handle.toLowerCase())) {
            if (!allCandidates.has(handle.toLowerCase())) {
              allCandidates.set(handle.toLowerCase(), {
                handle,
                discovery_reason: `Found in X search: "${query}"`,
                discovery_source: 'x_search',
                estimated_relevance: 0, // Will be scored below
              });
            }
          }
        }
      } catch (searchErr: any) {
        console.warn(`[source-discovery] X search failed for "${query}": ${searchErr.message}`);
      }

      try {
        // Also search the web for "best X accounts" type queries
        const webResults = await webSearch(
          `site:x.com OR site:twitter.com ${query} best accounts AI 2025 2026`,
          MAX_RESULTS_PER_QUERY
        );
        for (const result of webResults) {
          const handle = extractHandleFromUrl(result.url);
          if (handle && !existingHandles.has(handle.toLowerCase())) {
            if (!allCandidates.has(handle.toLowerCase())) {
              allCandidates.set(handle.toLowerCase(), {
                handle,
                discovery_reason: `Found in web search: "${query}"`,
                discovery_source: 'web_search',
                estimated_relevance: 0,
              });
            }
          }
        }
      } catch (webErr: any) {
        console.warn(`[source-discovery] Web search failed for "${query}": ${webErr.message}`);
      }
    }

    console.log(`[source-discovery] Found ${allCandidates.size} candidate accounts`);

    // ── Step 5: Evaluate candidates with AI ──
    const evaluated = await evaluateCandidateAccounts(
      Array.from(allCandidates.values()),
      existingHandles
    );

    // ── Step 6: Add valid candidates to the pool ──
    let addedCount = 0;
    for (const candidate of evaluated) {
      if (addedCount >= maxNew) break;
      if (!isValidXHandle(candidate.handle)) {
        emptyResult.skipped_invalid.push(candidate.handle);
        continue;
      }
      if (existingHandles.has(candidate.handle.toLowerCase())) {
        emptyResult.skipped_existing.push(candidate.handle);
        continue;
      }

      // Only add candidates with decent relevance (>= 5/10)
      if (candidate.estimated_relevance < 5) continue;

      // Check total pool size
      if (validExisting.length + addedCount >= MAX_TOTAL_ACCOUNTS) {
        console.log(`[source-discovery] Pool at capacity (${MAX_TOTAL_ACCOUNTS}) — stopping additions`);
        break;
      }

      try {
        const { error: insertError } = await supabase
          .from('accounts')
          .insert({
            handle: candidate.handle,
            tier: 3, // Start at lowest tier — will be promoted by quality performance
            category: 'discovered',
            notes: `Auto-discovered: ${candidate.discovery_reason}`,
            created_at: new Date().toISOString(),
          });

        if (insertError) {
          // Handle duplicate (race condition) — just skip
          if (insertError.message.includes('duplicate') || insertError.code === '23505') {
            emptyResult.skipped_existing.push(candidate.handle);
          } else {
            console.warn(`[source-discovery] Failed to add @${candidate.handle}: ${insertError.message}`);
          }
          continue;
        }

        emptyResult.added.push(candidate.handle);
        addedCount++;
        console.log(`[source-discovery] Added @${candidate.handle} (relevance: ${candidate.estimated_relevance}/10, source: ${candidate.discovery_source})`);
      } catch (insertErr: any) {
        console.warn(`[source-discovery] Insert exception for @${candidate.handle}: ${insertErr.message}`);
      }
    }

    // ── Step 7: Prune consistently poor-performing accounts ──
    const pruned = await prunePoorPerformingAccounts(validExisting);
    emptyResult.pruned = pruned;

    // Calculate final pool size
    const { count: finalCount } = await supabase
      .from('accounts')
      .select('handle', { count: 'exact', head: true });

    emptyResult.pool_size_after = finalCount ?? validExisting.length;

    console.log(`[source-discovery] Complete: added=${emptyResult.added.length}, pruned=${pruned.length}, pool=${emptyResult.pool_size_after}`);
    return emptyResult;

  } catch (err: any) {
    console.error(`[source-discovery] Discovery failed: ${err.message}`);
    return {
      ...emptyResult,
      discovery_triggered: true,
      discovery_reason: `error: ${err.message}`,
    };
  }
}

// ═══ AI Query Generation ═══

/**
 * Use AI to generate niche-relevant search queries for discovering X accounts.
 * The AI is given the niche context and existing pool (to avoid duplicates).
 *
 * Returns 2-4 search queries as strings.
 */
async function generateDiscoveryQueries(existingHandles: Set<string>): Promise<string[]> {
  try {
    const handleList = Array.from(existingHandles).slice(0, 20).join(', ');

    const response = await callModel('learning_extraction' as any, [
      {
        role: 'system',
        content: `You are a social media research analyst. Generate search queries to find active X (Twitter) accounts that post about a specific niche.

${NICHE_CONTEXT}

IMPORTANT RULES:
1. Generate 2-4 search queries that would find ACTIVE X accounts posting about these topics TODAY
2. Each query should target a different sub-niche angle (e.g., one for AI tools, one for creator growth, one for building/startups)
3. Queries should find accounts with REAL engagement, not just big follower counts
4. Do NOT include the names of already-known accounts: ${handleList}
5. Focus on accounts that post ORIGINAL content (not just retweeting)
6. Keep queries concise (3-8 words each)

Return JSON only: {"queries": ["query1", "query2", "query3"]}`
      },
      {
        role: 'user',
        content: `Generate search queries to discover new X accounts for the @30piq niche. Known accounts to avoid: ${handleList || 'none'}.`
      }
    ], { temperature: 0.3, max_tokens: 300, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(String(response || ''));
    if (!parsed || !Array.isArray(parsed.queries)) {
      console.warn('[source-discovery] Failed to parse AI queries:', String(response).slice(0, 200));
      return [];
    }

    return parsed.queries.filter((q: any) => typeof q === 'string' && q.trim().length > 0).slice(0, MAX_DISCOVERY_QUERIES_PER_RUN);
  } catch (err: any) {
    console.warn(`[source-discovery] AI query generation failed: ${err.message}`);
    return [];
  }
}

// ═══ Candidate Evaluation ═══

/**
 * Evaluate discovered candidate accounts using AI.
 *
 * For each candidate, the AI checks:
 * 1. Is this account relevant to the @30piq niche?
 * 2. Does it post original content (not just retweets)?
 * 3. Is it likely to produce engagement opportunities?
 *
 * Returns candidates with estimated_relevance scores (1-10).
 */
async function evaluateCandidateAccounts(
  candidates: DiscoveredAccount[],
  existingHandles: Set<string>
): Promise<DiscoveredAccount[]> {
  if (candidates.length === 0) return [];

  try {
    const candidateList = candidates.map(c => `@${c.handle} (${c.discovery_source}: ${c.discovery_reason})`).join('\n');

    const response = await callModel('learning_extraction' as any, [
      {
        role: 'system',
        content: `You are evaluating X (Twitter) accounts for their relevance to the @30piq content strategy.

${NICHE_CONTEXT}

Rate each account on relevance (1-10) based on:
- Topical fit: Does this account regularly post about AI tools, productivity, building, creator growth, or internet business?
- Content quality: Is it likely to post original insights (not just retweets/news aggregation)?
- Engagement potential: Would this account's tweets provide good reply/quote opportunities?

RATING GUIDE:
8-10: Core niche account — regularly posts exactly about our topics with original insights
6-7: Relevant account — sometimes posts about our topics, mixed with other content
4-5: Peripheral — tangentially related, may occasionally provide useful content
1-3: Not relevant — does not match our niche at all

Return JSON: {"evaluations": [{"handle": "...", "relevance": N, "reason": "short reason"}, ...]}`
      },
      {
        role: 'user',
        content: `Evaluate these discovered X accounts for @30piq relevance:\n\n${candidateList}`
      }
    ], { temperature: 0.15, max_tokens: 1500, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(String(response || ''));
    if (!parsed || !Array.isArray(parsed.evaluations)) {
      console.warn('[source-discovery] Failed to parse AI evaluations');
      return candidates.map(c => ({ ...c, estimated_relevance: 3 })); // Default low score
    }

    // Merge AI scores into candidates
    const evalMap = new Map<string, { relevance: number; reason: string }>();
    for (const ev of parsed.evaluations) {
      if (ev.handle && typeof ev.relevance === 'number') {
        evalMap.set(ev.handle.replace('@', '').toLowerCase(), {
          relevance: Math.max(1, Math.min(10, Math.round(ev.relevance))),
          reason: ev.reason || '',
        });
      }
    }

    return candidates.map(c => {
      const eval_ = evalMap.get(c.handle.toLowerCase());
      return {
        ...c,
        estimated_relevance: eval_?.relevance ?? 3,
        discovery_reason: eval_?.reason
          ? `${c.discovery_reason} — AI: ${eval_.reason}`
          : c.discovery_reason,
      };
    });
  } catch (err: any) {
    console.warn(`[source-discovery] AI evaluation failed: ${err.message}`);
    return candidates.map(c => ({ ...c, estimated_relevance: 3 }));
  }
}

// ═══ Pruning ═══

/**
 * Prune consistently poor-performing accounts from the pool.
 *
 * An account is pruned if ALL of:
 * 1. It has been scanned >= MIN_SCANS_BEFORE_PRUNE times
 * 2. Its source_quality_score < PRUNE_QUALITY_THRESHOLD
 * 3. It was auto-discovered (tier 3) — never prune manually added accounts (tier 1-2)
 * 4. Pool size > MIN_ACCOUNT_POOL_SIZE (never prune below minimum)
 *
 * Returns handles of pruned accounts.
 */
async function prunePoorPerformingAccounts(existingAccounts: any[]): Promise<string[]> {
  const supabase = supabaseAdmin();
  const pruned: string[] = [];

  if (existingAccounts.length <= MIN_ACCOUNT_POOL_SIZE) {
    console.log(`[source-discovery] Pool too small (${existingAccounts.length}) — skipping pruning`);
    return pruned;
  }

  // Load quality scores
  const handles = existingAccounts.map((a: any) => a.handle).filter(isValidXHandle);
  const qualityMap = await loadSourceQualityScores(handles);

  // Find tier 3 (discovered) accounts with poor quality
  const tier3Accounts = existingAccounts.filter((a: any) =>
    isValidXHandle(a.handle) && a.tier === 3
  );

  for (const account of tier3Accounts) {
    const handle = account.handle;
    const quality = qualityMap.get(handle);

    if (quality && quality.scans_count >= MIN_SCANS_BEFORE_PRUNE) {
      const score = computeSourceQualityScore(quality);
      if (score < PRUNE_QUALITY_THRESHOLD) {
        // Prune this account
        try {
          const { error } = await supabase
            .from('accounts')
            .delete()
            .eq('handle', handle);

          if (!error) {
            pruned.push(handle);
            console.log(`[source-discovery] Pruned @${handle} (quality: ${score.toFixed(1)}, scans: ${quality.scans_count})`);
          }
        } catch (delErr: any) {
          console.warn(`[source-discovery] Failed to prune @${handle}: ${delErr.message}`);
        }
      }
    }
  }

  return pruned;
}

// ═══ Helpers ═══

/**
 * Extract an X handle from a tweet object.
 * Tries multiple field paths that TwitterAPI.io might return.
 */
function extractHandleFromTweet(tweet: any): string | null {
  if (!tweet || typeof tweet !== 'object') return null;

  const candidates = [
    tweet.username,
    tweet.user?.username,
    tweet.author_id,
    tweet.screen_name,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const handle = c.trim().replace(/^@/, '');
      if (isValidXHandle(handle)) return handle;
    }
  }

  return null;
}

/**
 * Extract an X handle from a URL string.
 * Handles patterns like:
 *   https://x.com/username
 *   https://twitter.com/username
 *   https://x.com/username/status/123
 */
function extractHandleFromUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;

  const match = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
  if (match && match[1]) {
    const handle = match[1];
    if (isValidXHandle(handle)) return handle;
  }

  return null;
}
