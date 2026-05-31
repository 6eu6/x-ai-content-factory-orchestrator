/**
 * S1.4 Source Selection — integrates source quality scores and category allocation
 * into the account selection pipeline.
 *
 * This module is the bridge between source-quality.ts (scoring) and
 * source-category.ts (classification + allocation). It loads current scores,
 * classifies accounts, allocates slots, and returns the final selection
 * with full diagnostics.
 */

import { supabaseAdmin } from './supabase';
import {
  type SourceQualityRow,
  loadSourceQualityScores,
  UNKNOWN_SOURCE_SCORE,
} from './source-quality';
import {
  type AccountWithCategory,
  type SourceCategory,
  classifyAccount,
  allocateAccountSlots,
  getAllocationCategory,
} from './source-category';
import { isValidXHandle } from './pipeline-queue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceSelectionDiagnostics = {
  source_strategy_enabled: boolean;
  source_quality_scores_loaded: number;
  source_quality_scores_updated: number;
  source_category_allocation: Record<string, number>;
  selected_source_quality_scores: number[];
  skipped_invalid_handles: string[];
  skipped_low_quality_sources: number;
  exploration_sources_selected: number;
  source_strategy_fallback_used: boolean;
};

export type SourceSelectionResult = {
  accounts: { handle: string }[];
  diagnostics: SourceSelectionDiagnostics;
};

// ---------------------------------------------------------------------------
// selectAccountsWithStrategy
// ---------------------------------------------------------------------------

/**
 * Select accounts for scanning using the S1.4 source strategy.
 *
 * 1. Fetch candidate accounts from Supabase (over-fetch for filtering)
 * 2. Load source_quality_scores for the candidate handles
 * 3. Classify each account into a source category
 * 4. Enrich with quality scores
 * 5. Allocate slots by weighted category
 * 6. Return selected accounts + diagnostics
 *
 * Falls back to simple last_checked/tier ordering if source strategy fails,
 * so the pipeline never stops because of a source strategy error.
 */
export async function selectAccountsWithStrategy(
  accountLimit: number,
  fallbackUsername?: string
): Promise<SourceSelectionResult> {
  const diagnostics: SourceSelectionDiagnostics = {
    source_strategy_enabled: true,
    source_quality_scores_loaded: 0,
    source_quality_scores_updated: 0,
    source_category_allocation: {},
    selected_source_quality_scores: [],
    skipped_invalid_handles: [],
    skipped_low_quality_sources: 0,
    exploration_sources_selected: 0,
    source_strategy_fallback_used: false,
  };

  try {
    const supabase = supabaseAdmin();

    // --- Step 1: Fetch candidate accounts (over-fetch) ---
    const fetchLimit = Math.min(Math.max(accountLimit * 4, accountLimit + 10), 100);
    const { data: rawAccounts, error: fetchError } = await supabase
      .from('accounts')
      .select('handle, tier, category, last_checked')
      .order('last_checked', { ascending: true, nullsFirst: true })
      .order('tier', { ascending: true })
      .limit(fetchLimit);

    if (fetchError || !rawAccounts?.length) {
      // Fallback: no accounts found, return empty (pipeline-queue will use fallbackUsername)
      diagnostics.source_strategy_fallback_used = true;
      const fallback = fallbackUsername && isValidXHandle(fallbackUsername)
        ? [{ handle: fallbackUsername }]
        : [];
      return { accounts: fallback, diagnostics };
    }

    // --- Step 2: Filter invalid handles ---
    const validRaw = rawAccounts.filter((a) => isValidXHandle(a.handle));
    const invalidHandles = rawAccounts
      .filter((a) => !isValidXHandle(a.handle))
      .map((a) => a.handle);
    diagnostics.skipped_invalid_handles = invalidHandles;

    if (validRaw.length === 0) {
      diagnostics.source_strategy_fallback_used = true;
      const fallback = fallbackUsername && isValidXHandle(fallbackUsername)
        ? [{ handle: fallbackUsername }]
        : [];
      return { accounts: fallback, diagnostics };
    }

    // --- Step 3: Load source quality scores ---
    const handles = validRaw.map((a) => a.handle);
    const qualityMap: Map<string, SourceQualityRow> = await loadSourceQualityScores(handles);
    diagnostics.source_quality_scores_loaded = qualityMap.size;

    // --- Step 4: Classify accounts and enrich with quality scores ---
    const classified: AccountWithCategory[] = validRaw.map((a) => {
      const classifiedAcc = classifyAccount({
        handle: a.handle,
        category: a.category,
        tier: a.tier,
      });

      // Enrich with quality score from DB (or default 50)
      const qualityRow = qualityMap.get(a.handle);
      classifiedAcc.source_quality_score = qualityRow?.source_quality_score ?? UNKNOWN_SOURCE_SCORE;
      classifiedAcc.last_checked = a.last_checked ?? null;

      return classifiedAcc;
    });

    // --- Step 5: Allocate slots by weighted category ---
    const allocation = allocateAccountSlots(classified, accountLimit);

    // --- Step 6: Build result ---
    const selected = allocation.selected.map((a) => ({ handle: a.handle }));

    diagnostics.source_category_allocation = allocation.allocation;
    diagnostics.selected_source_quality_scores = allocation.selected.map(
      (a) => a.source_quality_score
    );
    diagnostics.skipped_low_quality_sources = allocation.skippedLowQuality;
    diagnostics.exploration_sources_selected = allocation.explorationCount;
    diagnostics.source_strategy_fallback_used = false;

    return { accounts: selected, diagnostics };
  } catch (err: any) {
    // NEVER crash the pipeline because of source strategy failure
    console.error('[source-selection] Strategy failed, using fallback:', err?.message ?? err);
    diagnostics.source_strategy_fallback_used = true;

    // Fallback: simple last_checked/tier order (the original behavior)
    try {
      const supabase = supabaseAdmin();
      const fetchLimit = Math.min(Math.max(accountLimit * 4, accountLimit + 10), 100);
      const { data: rawAccounts } = await supabase
        .from('accounts')
        .select('handle')
        .order('last_checked', { ascending: true, nullsFirst: true })
        .order('tier', { ascending: true })
        .limit(fetchLimit);

      const validHandles = (rawAccounts || [])
        .filter((a) => isValidXHandle(a.handle))
        .slice(0, accountLimit)
        .map((a) => ({ handle: a.handle }));

      if (validHandles.length === 0 && fallbackUsername && isValidXHandle(fallbackUsername)) {
        validHandles.push({ handle: fallbackUsername });
      }

      return { accounts: validHandles, diagnostics };
    } catch {
      const fallback = fallbackUsername && isValidXHandle(fallbackUsername)
        ? [{ handle: fallbackUsername }]
        : [];
      return { accounts: fallback, diagnostics };
    }
  }
}
