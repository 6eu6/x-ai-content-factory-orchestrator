/**
 * S1.4 Source Category Model
 *
 * Implements weighted category allocation for account classification.
 * Maps raw category strings and handle patterns to a fixed set of
 * source categories, then allocates scan slots proportionally.
 */

import { isValidXHandle } from './pipeline-queue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceCategory =
  | 'core_ai_tools'
  | 'builders_founders'
  | 'productivity_work'
  | 'creator_growth'
  | 'digital_culture'
  | 'internet_business'
  | 'experimental_trend'
  | 'noisy_unknown'
  | 'invalid';

export type CategoryAllocation = {
  category: SourceCategory;
  weight: number; // 0-1, sum of all weights = 1
  label: string;
};

export type AccountWithCategory = {
  handle: string;
  category: SourceCategory;
  source_quality_score: number; // default 50 if unknown
  tier?: number;
  last_checked?: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CATEGORY_ALLOCATIONS: CategoryAllocation[] = [
  { category: 'core_ai_tools', weight: 0.40, label: 'Core AI Tools & AI Builders' },
  { category: 'builders_founders', weight: 0.25, label: 'Builders, Founders & Internet Business' },
  { category: 'creator_growth', weight: 0.20, label: 'Creator Growth & Digital Culture' },
  { category: 'experimental_trend', weight: 0.10, label: 'Experimental & Trend Discovery' },
  { category: 'noisy_unknown', weight: 0.05, label: 'Exploration / Unknown Sources' },
];

// ---------------------------------------------------------------------------
// normalizeCategory
// ---------------------------------------------------------------------------

/**
 * Maps a raw category string to a canonical SourceCategory.
 * Matching is case-insensitive substring matching.
 */
export function normalizeCategory(raw: string | null | undefined): SourceCategory {
  if (raw == null || raw.trim() === '') {
    return 'noisy_unknown';
  }

  const lower = raw.toLowerCase();

  if (containsAny(lower, ['ai', 'tool', 'llm', 'ml'])) {
    return 'core_ai_tools';
  }
  if (containsAny(lower, ['builder', 'founder', 'startup', 'indie', 'maker'])) {
    return 'builders_founders';
  }
  if (containsAny(lower, ['productiv', 'work', 'career', 'efficiency'])) {
    return 'productivity_work';
  }
  if (containsAny(lower, ['creator', 'growth', 'audience', 'content'])) {
    return 'creator_growth';
  }
  if (containsAny(lower, ['digital', 'culture', 'internet', 'social', 'memes'])) {
    return 'digital_culture';
  }
  if (containsAny(lower, ['business', 'entrepreneur', 'saas', 'revenue'])) {
    return 'internet_business';
  }
  if (containsAny(lower, ['experiment', 'trend', 'viral', 'emerging'])) {
    return 'experimental_trend';
  }
  if (containsAny(lower, ['noisy', 'spam', 'low', 'invalid'])) {
    return 'noisy_unknown';
  }

  // Default: anything unmatched is treated as noisy/unknown
  return 'noisy_unknown';
}

// ---------------------------------------------------------------------------
// getAllocationCategory
// ---------------------------------------------------------------------------

/**
 * Maps a detailed SourceCategory to its allocation-level category.
 *
 * Several detailed categories roll up into a shared allocation bucket:
 *   productivity_work   -> core_ai_tools
 *   internet_business   -> builders_founders
 *   digital_culture     -> creator_growth
 *   invalid             -> noisy_unknown
 */
export function getAllocationCategory(category: SourceCategory): SourceCategory {
  switch (category) {
    case 'core_ai_tools':
    case 'productivity_work':
      return 'core_ai_tools';

    case 'builders_founders':
    case 'internet_business':
      return 'builders_founders';

    case 'creator_growth':
    case 'digital_culture':
      return 'creator_growth';

    case 'experimental_trend':
      return 'experimental_trend';

    case 'noisy_unknown':
    case 'invalid':
      return 'noisy_unknown';

    default:
      return 'noisy_unknown';
  }
}

// ---------------------------------------------------------------------------
// inferCategoryFromHandle
// ---------------------------------------------------------------------------

/**
 * Light inference of a source category from the text of an X handle.
 * Validates the handle first; invalid handles return 'invalid'.
 */
export function inferCategoryFromHandle(handle: string): SourceCategory {
  if (!isValidXHandle(handle)) {
    return 'invalid';
  }

  const lower = handle.toLowerCase();

  if (containsAny(lower, ['ai', 'gpt', 'llm', 'ml', 'deep', 'neural', 'model'])) {
    return 'core_ai_tools';
  }
  if (containsAny(lower, ['build', 'founder', 'startup', 'maker', 'indie', 'ship'])) {
    return 'builders_founders';
  }
  if (containsAny(lower, ['prod', 'work', 'career', 'efficiency', 'flow'])) {
    return 'productivity_work';
  }
  if (containsAny(lower, ['creator', 'growth', 'audience', 'content'])) {
    return 'creator_growth';
  }
  if (containsAny(lower, ['trend', 'viral', 'emerging', 'future'])) {
    return 'experimental_trend';
  }

  return 'noisy_unknown';
}

// ---------------------------------------------------------------------------
// classifyAccount
// ---------------------------------------------------------------------------

/**
 * Classifies an account into a SourceCategory.
 * Uses an explicit category string if available; otherwise infers from handle.
 */
export function classifyAccount(account: {
  handle: string;
  category?: string | null;
  tier?: number;
}): AccountWithCategory {
  const category: SourceCategory =
    account.category && account.category.trim() !== ''
      ? normalizeCategory(account.category)
      : inferCategoryFromHandle(account.handle);

  return {
    handle: account.handle,
    category,
    source_quality_score: 50,
    tier: account.tier,
    last_checked: null,
  };
}

// ---------------------------------------------------------------------------
// allocateAccountSlots
// ---------------------------------------------------------------------------

/**
 * Selects accounts for scanning based on weighted category allocation.
 *
 * - Filters out 'invalid' accounts.
 * - Deprioritizes very low quality scores (< 20) but does not permanently ban them.
 * - Allocates slots per category proportionally to CATEGORY_ALLOCATIONS weights.
 * - Guarantees a minimum exploration quota from 'noisy_unknown'.
 * - Redistributes unused slots if a category has fewer accounts than its allocation.
 * - Ensures at least 2 categories are represented if enough accounts exist.
 * - Respects totalSlots as a hard limit.
 */
export function allocateAccountSlots(
  accounts: AccountWithCategory[],
  totalSlots: number,
): {
  selected: AccountWithCategory[];
  allocation: Record<string, number>;
  explorationCount: number;
  skippedInvalid: number;
  skippedLowQuality: number;
} {
  // --- Phase 1: Separate invalid accounts ----------------------------------
  const valid = accounts.filter((a) => a.category !== 'invalid');
  const skippedInvalid = accounts.length - valid.length;

  // --- Phase 2: Separate low-quality accounts (< 20) ----------------------
  // We deprioritize them but keep some for diversity.
  const normalQuality = valid.filter((a) => a.source_quality_score >= 20);
  const lowQuality = valid.filter((a) => a.source_quality_score < 20);
  const skippedLowQuality = lowQuality.length;

  // Reserve a small portion of total slots for low-quality exploration
  const lowQualityReserve = Math.min(lowQuality.length, Math.ceil(totalSlots * 0.05));

  // --- Phase 3: Group by allocation category -------------------------------
  const allocCategory = (a: AccountWithCategory) => getAllocationCategory(a.category);

  const groups: Record<string, AccountWithCategory[]> = {};
  for (const a of normalQuality) {
    const key = allocCategory(a);
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }

  // Sort each group by source_quality_score descending
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => b.source_quality_score - a.source_quality_score);
  }

  // --- Phase 4: Calculate raw slot allocation per category -----------------
  const slotsPerCategory: Record<string, number> = {};
  let remainingSlots = totalSlots;

  // Minimum exploration quota from noisy_unknown
  const minExploration = Math.ceil(totalSlots * 0.05);

  // Distribute slots by weight
  const allocMap = new Map<SourceCategory, number>();
  let weightSum = 0;
  for (const ca of CATEGORY_ALLOCATIONS) {
    weightSum += ca.weight;
  }

  for (const ca of CATEGORY_ALLOCATIONS) {
    const raw = Math.floor(totalSlots * (ca.weight / weightSum));
    allocMap.set(ca.category, raw);
  }

  // Adjust for rounding: give remaining fractional slots to the largest category
  let allocated = 0;
  for (const count of allocMap.values()) {
    allocated += count;
  }
  const roundingRemainder = totalSlots - allocated;
  if (roundingRemainder > 0 && allocMap.has('core_ai_tools')) {
    allocMap.set('core_ai_tools', (allocMap.get('core_ai_tools') ?? 0) + roundingRemainder);
  }

  // Copy to slotsPerCategory
  for (const [cat, count] of allocMap.entries()) {
    slotsPerCategory[cat] = count;
  }

  // --- Phase 5: Select accounts per category -------------------------------
  const selected: AccountWithCategory[] = [];
  const allocationResult: Record<string, number> = {};
  let explorationCount = 0;

  // Track which categories actually contributed accounts
  const contributedCategories = new Set<string>();

  // First pass: fill each category up to its allocation
  for (const ca of CATEGORY_ALLOCATIONS) {
    const cat = ca.category;
    const slotsAvailable = slotsPerCategory[cat] ?? 0;
    const pool = groups[cat] ?? [];
    const take = Math.min(slotsAvailable, pool.length);

    for (let i = 0; i < take; i++) {
      selected.push(pool[i]);
    }

    allocationResult[cat] = take;
    if (cat === 'noisy_unknown') {
      explorationCount += take;
    }
    if (take > 0) {
      contributedCategories.add(cat);
    }

    // Mark taken accounts by removing them from the pool
    groups[cat] = pool.slice(take);
  }

  // --- Phase 6: Redistribute unused slots ----------------------------------
  let currentTotal = selected.length;

  if (currentTotal < totalSlots) {
    // Collect remaining accounts across all categories, sorted by quality
    const leftover: AccountWithCategory[] = [];
    for (const key of Object.keys(groups)) {
      leftover.push(...groups[key]);
    }
    leftover.sort((a, b) => b.source_quality_score - a.source_quality_score);

    // Fill remaining slots from the leftover pool
    const needed = totalSlots - currentTotal;
    const extraTake = leftover.slice(0, needed);

    for (const a of extraTake) {
      const cat = allocCategory(a);
      selected.push(a);
      allocationResult[cat] = (allocationResult[cat] ?? 0) + 1;
      if (cat === 'noisy_unknown') {
        explorationCount++;
      }
      contributedCategories.add(cat);
    }
  }

  // --- Phase 7: Ensure minimum exploration quota ---------------------------
  if (explorationCount < minExploration) {
    const deficit = minExploration - explorationCount;
    const noisyPool = lowQuality.filter(
      (a) => allocCategory(a) === 'noisy_unknown' && !selected.some((s) => s.handle === a.handle),
    );

    // Also check normal-quality noisy_unknown not yet selected
    const normalNoisyNotSelected = (groups['noisy_unknown'] ?? []).filter(
      (a) => !selected.some((s) => s.handle === a.handle),
    );

    const explorationPool = [...normalNoisyNotSelected, ...noisyPool];

    let addedFromExploration = 0;
    for (const a of explorationPool) {
      if (addedFromExploration >= deficit || selected.length >= totalSlots) break;

      // Remove the lowest-quality selected account from the largest non-noisy category
      // to make room
      if (selected.length >= totalSlots) {
        // Find the category with the most selections (excluding noisy_unknown)
        let maxCat = '';
        let maxCount = 0;
        for (const [cat, count] of Object.entries(allocationResult)) {
          if (cat !== 'noisy_unknown' && count > maxCount) {
            maxCount = count;
            maxCat = cat;
          }
        }

        if (maxCat) {
          // Remove the last (lowest quality) account from that category
          const removeIdx = selected.findLastIndex((s) => allocCategory(s) === maxCat);
          if (removeIdx !== -1) {
            const removed = selected.splice(removeIdx, 1)[0];
            allocationResult[maxCat] = (allocationResult[maxCat] ?? 1) - 1;
            if (allocCategory(removed) === 'noisy_unknown') {
              explorationCount--;
            }
          }
        }
      }

      selected.push(a);
      allocationResult['noisy_unknown'] = (allocationResult['noisy_unknown'] ?? 0) + 1;
      explorationCount++;
      addedFromExploration++;
    }
  }

  // --- Phase 8: Ensure minimum category diversity --------------------------
  if (contributedCategories.size < 2 && totalSlots >= 2 && valid.length >= 2) {
    // Try to pull at least one account from a different category
    const allCats = new Set(valid.map((a) => allocCategory(a)));
    if (allCats.size >= 2) {
      // Find a category not yet represented
      for (const altCat of allCats) {
        if (contributedCategories.has(altCat)) continue;

        // Find an account from the alt category not already selected
        const altAccount = valid.find(
          (a) => allocCategory(a) === altCat && !selected.some((s) => s.handle === a.handle),
        );

        if (altAccount) {
          // Make room: remove the lowest-quality from the dominant category
          if (selected.length >= totalSlots) {
            const dominantCat = Array.from(contributedCategories)[0];
            const removeIdx = selected.findLastIndex((s) => allocCategory(s) === dominantCat);
            if (removeIdx !== -1) {
              const removed = selected.splice(removeIdx, 1)[0];
              allocationResult[dominantCat] = (allocationResult[dominantCat] ?? 1) - 1;
              if (allocCategory(removed) === 'noisy_unknown') {
                explorationCount--;
              }
            }
          }

          if (selected.length < totalSlots) {
            selected.push(altAccount);
            allocationResult[altCat] = (allocationResult[altCat] ?? 0) + 1;
            if (altCat === 'noisy_unknown') {
              explorationCount++;
            }
            contributedCategories.add(altCat);
            break; // One additional category is enough
          }
        }
      }
    }
  }

  // --- Phase 9: Add low-quality exploration accounts -----------------------
  let lowQualityAdded = 0;
  const lowQualitySorted = [...lowQuality].sort(
    (a, b) => b.source_quality_score - a.source_quality_score,
  );

  for (const a of lowQualitySorted) {
    if (lowQualityAdded >= lowQualityReserve) break;
    if (selected.length >= totalSlots) {
      // Make room by removing lowest quality from the largest category
      let maxCat = '';
      let maxCount = 0;
      for (const [cat, count] of Object.entries(allocationResult)) {
        if (count > maxCount) {
          maxCount = count;
          maxCat = cat;
        }
      }
      if (maxCat) {
        const removeIdx = selected.findLastIndex((s) => allocCategory(s) === maxCat);
        if (removeIdx !== -1) {
          const removed = selected.splice(removeIdx, 1)[0];
          allocationResult[maxCat] = (allocationResult[maxCat] ?? 1) - 1;
          if (allocCategory(removed) === 'noisy_unknown') {
            explorationCount--;
          }
        }
      }
    }

    if (selected.length < totalSlots) {
      const cat = allocCategory(a);
      selected.push(a);
      allocationResult[cat] = (allocationResult[cat] ?? 0) + 1;
      if (cat === 'noisy_unknown') {
        explorationCount++;
      }
      lowQualityAdded++;
    }
  }

  // --- Phase 10: Trim to hard limit ----------------------------------------
  while (selected.length > totalSlots) {
    // Remove the lowest quality overall
    let minIdx = 0;
    let minScore = selected[0].source_quality_score;
    for (let i = 1; i < selected.length; i++) {
      if (selected[i].source_quality_score < minScore) {
        minScore = selected[i].source_quality_score;
        minIdx = i;
      }
    }
    const removed = selected.splice(minIdx, 1)[0];
    const cat = allocCategory(removed);
    allocationResult[cat] = (allocationResult[cat] ?? 1) - 1;
    if (cat === 'noisy_unknown') {
      explorationCount--;
    }
  }

  return {
    selected,
    allocation: allocationResult,
    explorationCount,
    skippedInvalid,
    skippedLowQuality,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `str` contains at least one of the `keywords` as a substring.
 */
function containsAny(str: string, keywords: string[]): boolean {
  return keywords.some((kw) => str.includes(kw));
}
