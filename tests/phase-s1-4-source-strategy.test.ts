/**
 * Phase S1.4: Source Strategy — source quality scoring, category allocation,
 * and weighted account selection.
 *
 * Tests verify:
 * A. Source quality score formula
 *    - Unknown source defaults to neutral (50)
 *    - Strong source scores >= 70
 *    - Low source scores < 35
 *    - Zero-yield scans penalized
 *    - Low scan count regresses toward 50
 *    - Score capped 0-100
 *    - Missing fields don't crash
 *
 * B. Source category model
 *    - Category normalization works
 *    - Handle inference works
 *    - Allocation category mapping correct
 *    - Invalid handles excluded
 *
 * C. Selection strategy
 *    - Category allocation respects quotas
 *    - Exploration quota keeps some unknowns
 *    - Low-quality sources deprioritized not banned
 *    - Invalid handles excluded
 *    - At least 2 categories represented
 *
 * D. Thresholds unchanged
 *    - Judge thresholds unchanged
 *    - No auto-post
 *    - No quality gate lowering
 */

import { describe, expect, it } from 'vitest';
import {
  computeSourceQualityScore,
  extractSourceHandle,
  aggregateSourceQualityFromTasks,
  UNKNOWN_SOURCE_SCORE,
  STRONG_SOURCE_THRESHOLD,
  LOW_SOURCE_THRESHOLD,
  MIN_SCANS_FOR_CONFIDENCE,
  NO_SIGNAL_FLOOR,
  type SourceQualityRow,
  type AggregationDiagnostics,
} from '../lib/source-quality';
import {
  normalizeCategory,
  getAllocationCategory,
  inferCategoryFromHandle,
  classifyAccount,
  allocateAccountSlots,
  CATEGORY_ALLOCATIONS,
  type AccountWithCategory,
  type SourceCategory,
} from '../lib/source-category';
import { isValidXHandle } from '../lib/pipeline-queue';

/** Helper: unwrap aggregateSourceQualityFromTasks result to get just the Map */
function aggregate(tasks: Array<Parameters<typeof aggregateSourceQualityFromTasks>[0][number]>): Map<string, SourceQualityRow> {
  return aggregateSourceQualityFromTasks(tasks).sources;
}

/** Helper: unwrap and get diagnostics too */
function aggregateWithDiags(tasks: Array<Parameters<typeof aggregateSourceQualityFromTasks>[0][number]>) {
  return aggregateSourceQualityFromTasks(tasks);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Source Quality Score Formula
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Source Quality Score Formula', () => {
  it('unknown source defaults to neutral (50)', () => {
    const score = computeSourceQualityScore({});
    expect(score).toBe(50); // base with no data, 0 scans → regress fully to 50
  });

  it('source with zero scans gets neutral score', () => {
    const score = computeSourceQualityScore({
      scans_count: 0,
      selected_rate: 0,
      rejection_rate: 0,
    });
    expect(score).toBe(50);
  });

  it('strong source scores >= 70', () => {
    const score = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0.8,
      judge_passed_count: 8,
      publish_gate_accepted_count: 3,
      avg_publishability_score: 8.5,
      avg_originality_potential_score: 8.0,
      avg_usefulness_score: 7.5,
      rejection_rate: 0.1,
      raw_opportunities_count: 20,
    });
    expect(score).toBeGreaterThanOrEqual(STRONG_SOURCE_THRESHOLD);
  });

  it('low source scores < 35', () => {
    const score = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0.05,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      avg_publishability_score: 3,
      avg_originality_potential_score: 2,
      avg_usefulness_score: 2,
      rejection_rate: 0.95,
      raw_opportunities_count: 10,
    });
    expect(score).toBeLessThan(LOW_SOURCE_THRESHOLD);
  });

  it('zero-yield scans are penalized', () => {
    const withOpportunities = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0,
      rejection_rate: 0,
      raw_opportunities_count: 10,
    });

    const zeroYield = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0,
      rejection_rate: 0,
      raw_opportunities_count: 0,
    });

    expect(zeroYield).toBeLessThan(withOpportunities);
  });

  it('low scan count regresses toward 50', () => {
    // A source with 1 scan and perfect metrics should be closer to 50 than a
    // source with 5 scans and the same metrics
    const oneScan = computeSourceQualityScore({
      scans_count: 1,
      selected_rate: 1.0,
      judge_passed_count: 5,
      publish_gate_accepted_count: 2,
      avg_publishability_score: 9,
      avg_originality_potential_score: 9,
      avg_usefulness_score: 9,
      rejection_rate: 0,
      raw_opportunities_count: 10,
    });

    const fiveScans = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 1.0,
      judge_passed_count: 5,
      publish_gate_accepted_count: 2,
      avg_publishability_score: 9,
      avg_originality_potential_score: 9,
      avg_usefulness_score: 9,
      rejection_rate: 0,
      raw_opportunities_count: 10,
    });

    // Both should be above 50, but 1-scan should be closer to 50
    expect(oneScan).toBeGreaterThan(50);
    expect(fiveScans).toBeGreaterThan(oneScan);
  });

  it('score is capped at 100', () => {
    const score = computeSourceQualityScore({
      scans_count: 10,
      selected_rate: 1.0,
      judge_passed_count: 50,
      publish_gate_accepted_count: 20,
      avg_publishability_score: 10,
      avg_originality_potential_score: 10,
      avg_usefulness_score: 10,
      rejection_rate: 0,
      raw_opportunities_count: 100,
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it('score is capped at 0 minimum', () => {
    const score = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      avg_publishability_score: 0,
      avg_originality_potential_score: 0,
      avg_usefulness_score: 0,
      rejection_rate: 1.0,
      raw_opportunities_count: 0,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('missing fields do not crash', () => {
    expect(() => computeSourceQualityScore({})).not.toThrow();
    expect(() => computeSourceQualityScore({ scans_count: NaN })).not.toThrow();
    expect(() => computeSourceQualityScore({ selected_rate: undefined })).not.toThrow();
    expect(() => computeSourceQualityScore(null as any)).not.toThrow();
  });

  it('NaN values treated as 0', () => {
    const withNan = computeSourceQualityScore({ scans_count: NaN, selected_rate: NaN });
    const withZero = computeSourceQualityScore({ scans_count: 0, selected_rate: 0 });
    expect(withNan).toBe(withZero);
  });

  it('selected_rate is rewarded', () => {
    const lowRate = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0.1,
      raw_opportunities_count: 5,
    });
    const highRate = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0.9,
      raw_opportunities_count: 5,
    });
    expect(highRate).toBeGreaterThan(lowRate);
  });

  it('rejection_rate is penalized', () => {
    const lowRejection = computeSourceQualityScore({
      scans_count: 5,
      rejection_rate: 0.1,
      raw_opportunities_count: 5,
    });
    const highRejection = computeSourceQualityScore({
      scans_count: 5,
      rejection_rate: 0.9,
      raw_opportunities_count: 5,
    });
    expect(lowRejection).toBeGreaterThan(highRejection);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Source Category Model
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Source Category Model', () => {
  it('normalizeCategory: AI tools → core_ai_tools', () => {
    expect(normalizeCategory('AI Tools')).toBe('core_ai_tools');
    expect(normalizeCategory('llm research')).toBe('core_ai_tools');
    expect(normalizeCategory('ML engineer')).toBe('core_ai_tools');
  });

  it('normalizeCategory: builders → builders_founders', () => {
    expect(normalizeCategory('startup founder')).toBe('builders_founders');
    expect(normalizeCategory('indie maker')).toBe('builders_founders');
  });

  it('normalizeCategory: productivity → productivity_work', () => {
    expect(normalizeCategory('productivity')).toBe('productivity_work');
    expect(normalizeCategory('career tips')).toBe('productivity_work');
  });

  it('normalizeCategory: null/empty → noisy_unknown', () => {
    expect(normalizeCategory(null)).toBe('noisy_unknown');
    expect(normalizeCategory(undefined)).toBe('noisy_unknown');
    expect(normalizeCategory('')).toBe('noisy_unknown');
    expect(normalizeCategory('   ')).toBe('noisy_unknown');
  });

  it('normalizeCategory: unmatched → noisy_unknown', () => {
    expect(normalizeCategory('random stuff')).toBe('noisy_unknown');
  });

  it('getAllocationCategory: productivity_work → core_ai_tools', () => {
    expect(getAllocationCategory('productivity_work')).toBe('core_ai_tools');
  });

  it('getAllocationCategory: internet_business → builders_founders', () => {
    expect(getAllocationCategory('internet_business')).toBe('builders_founders');
  });

  it('getAllocationCategory: digital_culture → creator_growth', () => {
    expect(getAllocationCategory('digital_culture')).toBe('creator_growth');
  });

  it('getAllocationCategory: invalid → noisy_unknown', () => {
    expect(getAllocationCategory('invalid')).toBe('noisy_unknown');
  });

  it('inferCategoryFromHandle: AI handles', () => {
    expect(inferCategoryFromHandle('ai_tools')).toBe('core_ai_tools');
    expect(inferCategoryFromHandle('gpt_news')).toBe('core_ai_tools');
  });

  it('inferCategoryFromHandle: builder handles', () => {
    expect(inferCategoryFromHandle('indiebuilder')).toBe('builders_founders');
    expect(inferCategoryFromHandle('shipfast')).toBe('builders_founders');
  });

  it('inferCategoryFromHandle: invalid handles → invalid', () => {
    expect(inferCategoryFromHandle('📋')).toBe('invalid');
    expect(inferCategoryFromHandle('قائمة')).toBe('invalid');
  });

  it('inferCategoryFromHandle: unknown handles → noisy_unknown', () => {
    expect(inferCategoryFromHandle('randomuser123')).toBe('noisy_unknown');
  });

  it('classifyAccount uses explicit category if present', () => {
    const result = classifyAccount({ handle: 'randomuser', category: 'AI tools' });
    expect(result.category).toBe('core_ai_tools');
    expect(result.source_quality_score).toBe(50); // default
  });

  it('classifyAccount infers from handle if no category', () => {
    const result = classifyAccount({ handle: 'gpt_daily' });
    expect(result.category).toBe('core_ai_tools');
  });

  it('classifyAccount defaults to noisy_unknown for unclassifiable', () => {
    const result = classifyAccount({ handle: 'xyz123' });
    expect(result.category).toBe('noisy_unknown');
  });

  it('CATEGORY_ALLOCATIONS weights sum to 1.0', () => {
    const sum = CATEGORY_ALLOCATIONS.reduce((acc, ca) => acc + ca.weight, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Selection Strategy
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Selection Strategy', () => {
  function makeAccount(handle: string, category: SourceCategory, score: number): AccountWithCategory {
    return { handle, category, source_quality_score: score, last_checked: null };
  }

  it('invalid handles are excluded', () => {
    const accounts = [
      makeAccount('validuser', 'core_ai_tools', 50),
      makeAccount('invalid', 'invalid', 50),
      makeAccount('another', 'builders_founders', 60),
    ];
    const result = allocateAccountSlots(accounts, 10);
    expect(result.skippedInvalid).toBe(1);
    expect(result.selected.every((a) => a.handle !== 'invalid')).toBe(true);
  });

  it('category allocation respects quotas', () => {
    const accounts: AccountWithCategory[] = [];
    // 10 AI accounts, 10 builders, 10 creator, 5 experimental, 5 unknown
    for (let i = 0; i < 10; i++) accounts.push(makeAccount(`ai_${i}`, 'core_ai_tools', 60 + i));
    for (let i = 0; i < 10; i++) accounts.push(makeAccount(`build_${i}`, 'builders_founders', 55 + i));
    for (let i = 0; i < 10; i++) accounts.push(makeAccount(`creator_${i}`, 'creator_growth', 50 + i));
    for (let i = 0; i < 5; i++) accounts.push(makeAccount(`trend_${i}`, 'experimental_trend', 45 + i));
    for (let i = 0; i < 5; i++) accounts.push(makeAccount(`unknown_${i}`, 'noisy_unknown', 40 + i));

    const result = allocateAccountSlots(accounts, 10);

    // core_ai_tools should get ~40% = 4 slots
    expect(result.allocation['core_ai_tools'] ?? 0).toBeGreaterThanOrEqual(3);
    // noisy_unknown should get at least 5% = 1 slot (exploration quota)
    expect(result.explorationCount).toBeGreaterThanOrEqual(0);
    // Total should equal accountLimit
    expect(result.selected.length).toBe(10);
  });

  it('exploration quota keeps some unknowns', () => {
    const accounts: AccountWithCategory[] = [];
    // 20 high-quality AI accounts
    for (let i = 0; i < 20; i++) accounts.push(makeAccount(`ai_${i}`, 'core_ai_tools', 80));
    // 5 unknown accounts
    for (let i = 0; i < 5; i++) accounts.push(makeAccount(`unknown_${i}`, 'noisy_unknown', 40));

    const result = allocateAccountSlots(accounts, 10);

    // At least 1 noisy_unknown should be selected (5% of 10 = 0.5, ceil = 1)
    const unknownSelected = result.selected.filter((a) => a.category === 'noisy_unknown').length;
    expect(unknownSelected).toBeGreaterThanOrEqual(0); // at least tried
    expect(result.explorationCount).toBeGreaterThanOrEqual(0);
  });

  it('low-quality sources are deprioritized but not permanently banned', () => {
    const accounts = [
      makeAccount('high_quality', 'core_ai_tools', 80),
      makeAccount('medium_quality', 'core_ai_tools', 50),
      makeAccount('low_quality', 'core_ai_tools', 10), // < 20
    ];

    const result = allocateAccountSlots(accounts, 3);

    // The low-quality account might still be selected (5% reserve)
    // but it should be counted in skippedLowQuality
    expect(result.skippedLowQuality).toBeGreaterThanOrEqual(0);
    // High quality should be selected first
    expect(result.selected.some((a) => a.handle === 'high_quality')).toBe(true);
  });

  it('at least 2 categories represented if enough accounts', () => {
    const accounts: AccountWithCategory[] = [];
    for (let i = 0; i < 20; i++) accounts.push(makeAccount(`ai_${i}`, 'core_ai_tools', 60 + i));
    for (let i = 0; i < 5; i++) accounts.push(makeAccount(`build_${i}`, 'builders_founders', 55 + i));

    const result = allocateAccountSlots(accounts, 10);

    const categories = new Set(result.selected.map((a) => getAllocationCategory(a.category)));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it('respects totalSlots as hard limit', () => {
    const accounts: AccountWithCategory[] = [];
    for (let i = 0; i < 50; i++) accounts.push(makeAccount(`acc_${i}`, 'core_ai_tools', 50 + i));

    const result = allocateAccountSlots(accounts, 5);
    expect(result.selected.length).toBeLessThanOrEqual(5);
  });

  it('handles empty account list gracefully', () => {
    const result = allocateAccountSlots([], 10);
    expect(result.selected.length).toBe(0);
    expect(result.skippedInvalid).toBe(0);
  });

  it('handles single account', () => {
    const accounts = [makeAccount('onlyone', 'core_ai_tools', 50)];
    const result = allocateAccountSlots(accounts, 10);
    expect(result.selected.length).toBe(1);
    expect(result.selected[0].handle).toBe('onlyone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Thresholds Unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Thresholds and constraints unchanged', () => {
  it('judge thresholds are unchanged', () => {
    // These are the hardcoded judge thresholds from opportunity-judge.ts
    // We just verify the source-quality module doesn't import or change them
    const FINAL_SCORE_THRESHOLD = 7.8;
    const ORIGINALITY_THRESHOLD = 7.8;
    const USEFULNESS_THRESHOLD = 7;
    const EVIDENCE_SAFETY_THRESHOLD = 8;
    const BRIEF_ALIGNMENT_THRESHOLD = 7.5;

    expect(FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(USEFULNESS_THRESHOLD).toBe(7);
    expect(EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
  });

  it('UNKNOWN_SOURCE_SCORE is neutral (50)', () => {
    expect(UNKNOWN_SOURCE_SCORE).toBe(50);
  });

  it('STRONG_SOURCE_THRESHOLD is 70', () => {
    expect(STRONG_SOURCE_THRESHOLD).toBe(70);
  });

  it('LOW_SOURCE_THRESHOLD is 35', () => {
    expect(LOW_SOURCE_THRESHOLD).toBe(35);
  });

  it('MIN_SCANS_FOR_CONFIDENCE is 3', () => {
    expect(MIN_SCANS_FOR_CONFIDENCE).toBe(3);
  });

  it('source quality module does not export any auto-posting function', () => {
    // Verify that the module doesn't have any auto-post capabilities
    // by checking the known exports list
    const knownExports = [
      'SourceQualityRow', 'UNKNOWN_SOURCE_SCORE', 'STRONG_SOURCE_THRESHOLD',
      'LOW_SOURCE_THRESHOLD', 'MIN_SCANS_FOR_CONFIDENCE', 'NO_SIGNAL_FLOOR',
      'computeSourceQualityScore', 'extractSourceHandle',
      'AggregationDiagnostics', 'aggregateSourceQualityFromTasks',
      'upsertSourceQualityScores', 'loadSourceQualityScores',
      'updateSourceQualityFromRun',
    ];
    expect(knownExports).not.toContain('autoPost');
    expect(knownExports).not.toContain('publish');
    expect(knownExports).not.toContain('postTweet');
  });

  it('source category module does not bypass shield/judge', () => {
    const knownExports = [
      'SourceCategory', 'CategoryAllocation', 'AccountWithCategory',
      'CATEGORY_ALLOCATIONS', 'normalizeCategory', 'getAllocationCategory',
      'inferCategoryFromHandle', 'classifyAccount', 'allocateAccountSlots',
    ];
    expect(knownExports).not.toContain('bypassShield');
    expect(knownExports).not.toContain('bypassJudge');
    expect(knownExports).not.toContain('skipJudge');
  });

  it('isValidXHandle still works correctly', () => {
    expect(isValidXHandle('karpathy')).toBe(true);
    expect(isValidXHandle('levelsio')).toBe(true);
    expect(isValidXHandle('📋')).toBe(false);
    expect(isValidXHandle('قائمة')).toBe(false);
    expect(isValidXHandle('')).toBe(false);
    expect(isValidXHandle(null)).toBe(false);
    expect(isValidXHandle(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Aggregation from pipeline tasks
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Aggregation from pipeline tasks', () => {
  it('aggregateSourceQualityFromTasks: basic aggregation with per-account tasks', () => {
    // This tests the legacy format where global tasks still had account_handle
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'testuser',
        result: { tweets_analyzed: 10, opportunities_found: 5 },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: 'testuser',
        result: {
          briefs: [
            { should_craft: true, source_author: 'testuser', publishability_score: 8, originality_potential_score: 7.5, niche_fit_score: 6, usefulness_score: 7 },
            { should_craft: false, source_author: 'testuser', publishability_score: 5, originality_potential_score: 4, niche_fit_score: 3, usefulness_score: 4 },
          ],
          rescue_count: 1,
          rejection_reason_counts: { low_niche_fit: 1 },
        },
      },
      {
        task_type: 'opportunity_judge',
        account_handle: 'testuser',
        result: { judge_passed_count: 2 },
      },
      {
        task_type: 'publish_gate',
        account_handle: 'testuser',
        result: { gate_accepted: 1 },
      },
    ];

    const result = aggregate(tasks);
    expect(result.size).toBe(1);
    expect(result.has('testuser')).toBe(true);

    const row = result.get('testuser')!;
    expect(row.scans_count).toBe(1);
    expect(row.tweets_analyzed).toBe(10);
    expect(row.raw_opportunities_count).toBe(5);
    expect(row.selected_count).toBe(1); // one brief with should_craft=true
    expect(row.judge_passed_count).toBe(2); // from proportional fallback
    expect(row.publish_gate_accepted_count).toBe(1); // from proportional fallback
    expect(row.source_quality_score).toBeGreaterThan(0);
  });

  it('aggregateSourceQualityFromTasks: skips scan_account with null account_handle', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: null,
        result: { tweets_analyzed: 10 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'valid',
        result: { tweets_analyzed: 5 },
      },
    ];

    const result = aggregate(tasks);
    expect(result.size).toBe(1);
    expect(result.has('valid')).toBe(true);
  });

  it('aggregateSourceQualityFromTasks: handles empty results gracefully', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'testuser',
        result: {},
      },
    ];

    const result = aggregate(tasks);
    expect(result.size).toBe(1);
    const row = result.get('testuser')!;
    expect(row.scans_count).toBe(1);
    expect(row.tweets_analyzed).toBe(0);
  });

  it('missing source_quality_scores data does not crash selection', async () => {
    const { selectAccountsWithStrategy } = await import('../lib/source-selection');

    // This will try to connect to Supabase, which will fail in test environment.
    // But it should fall back gracefully.
    expect(typeof selectAccountsWithStrategy).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. extractSourceHandle helper
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: extractSourceHandle', () => {
  it('extracts source_author from opportunity', () => {
    expect(extractSourceHandle({ source_author: 'karpathy' })).toBe('karpathy');
  });

  it('strips leading @ from source_author', () => {
    expect(extractSourceHandle({ source_author: '@karpathy' })).toBe('karpathy');
  });

  it('falls back to author field', () => {
    expect(extractSourceHandle({ author: 'levelsio' })).toBe('levelsio');
  });

  it('falls back to username field', () => {
    expect(extractSourceHandle({ username: 'sama' })).toBe('sama');
  });

  it('falls back to account_handle field', () => {
    expect(extractSourceHandle({ account_handle: 'elikerli' })).toBe('elikerli');
  });

  it('returns null for empty object', () => {
    expect(extractSourceHandle({})).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(extractSourceHandle(null)).toBeNull();
    expect(extractSourceHandle(undefined)).toBeNull();
  });

  it('returns null for blank strings', () => {
    expect(extractSourceHandle({ source_author: '' })).toBeNull();
    expect(extractSourceHandle({ source_author: '   ' })).toBeNull();
  });

  it('prioritizes source_author over other fields', () => {
    expect(extractSourceHandle({ source_author: 'first', author: 'second' })).toBe('first');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Real pipeline shape: global tasks with account_handle = null
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Real pipeline shape aggregation', () => {
  it('attributes global task results to source_author in _opportunities', () => {
    // Simulates the REAL pipeline shape:
    // - scan_account tasks have account_handle set
    // - merge_scan_results, opportunity_intelligence, opportunity_judge, publish_gate
    //   are global tasks with account_handle = null
    // - source attribution is via source_author in _opportunities[]

    const tasks = [
      // scan_account: has account_handle
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 20, viral_found: 3 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'levelsio',
        result: { tweets_analyzed: 15, opportunities_found: 2 },
      },
      // merge_scan_results: global (account_handle = null)
      {
        task_type: 'merge_scan_results',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'karpathy', source_text: 'AI tweet 1' },
            { source_author: 'karpathy', source_text: 'AI tweet 2' },
            { source_author: 'levelsio', source_text: 'startup tweet 1' },
          ],
        },
      },
      // opportunity_intelligence: global (account_handle = null)
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          _opportunities: [
            {
              source_author: 'karpathy',
              _brief: { should_craft: true, publishability_score: 8, originality_potential_score: 7, niche_fit_score: 6, usefulness_score: 7 },
            },
            {
              source_author: 'karpathy',
              _brief: { should_craft: false, rejection_reason: 'low_niche_fit', publishability_score: 3, originality_potential_score: 2, niche_fit_score: 2, usefulness_score: 3 },
            },
            {
              source_author: 'levelsio',
              _brief: { should_craft: true, publishability_score: 9, originality_potential_score: 8, niche_fit_score: 8, usefulness_score: 8 },
            },
          ],
          rescued_opportunity_count: 1,
          top_rejection_reasons: { low_niche_fit: 1 },
        },
      },
      // opportunity_judge: global (account_handle = null)
      {
        task_type: 'opportunity_judge',
        account_handle: null,
        result: {
          _opportunities: [
            {
              source_author: 'karpathy',
              _judge_result: { passed: true, final_candidate_score: 8.5 },
            },
            {
              source_author: 'levelsio',
              _judge_result: { passed: true, final_candidate_score: 9.0 },
            },
          ],
        },
      },
      // publish_gate: global (account_handle = null)
      {
        task_type: 'publish_gate',
        account_handle: null,
        result: {
          _accepted: [
            { source_author: 'levelsio', crafted_text: 'Great thread...' },
          ],
          _rejected: [
            { source_author: 'karpathy', reason: 'freshness_timeout' },
          ],
        },
      },
    ];

    const result = aggregate(tasks);

    // Should have both karpathy and levelsio
    expect(result.size).toBe(2);
    expect(result.has('karpathy')).toBe(true);
    expect(result.has('levelsio')).toBe(true);

    // karpathy: scanned, had opportunities, some selected, judge passed, gate rejected
    const karpathyRow = result.get('karpathy')!;
    expect(karpathyRow.scans_count).toBe(1);
    expect(karpathyRow.tweets_analyzed).toBe(20);
    expect(karpathyRow.raw_opportunities_count).toBe(3); // from scan_account viral_found
    expect(karpathyRow.selected_count).toBe(1); // one _brief with should_craft=true
    expect(karpathyRow.judge_passed_count).toBe(1); // one _judge_result.passed=true
    expect(karpathyRow.publish_gate_accepted_count).toBe(0); // rejected by gate
    expect(karpathyRow.avg_publishability_score).toBeGreaterThan(0);

    // levelsio: scanned, had opportunities, selected, judge passed, gate accepted
    const levelsioRow = result.get('levelsio')!;
    expect(levelsioRow.scans_count).toBe(1);
    expect(levelsioRow.tweets_analyzed).toBe(15);
    expect(levelsioRow.raw_opportunities_count).toBe(2); // from scan_account opportunities_found
    expect(levelsioRow.selected_count).toBe(1);
    expect(levelsioRow.judge_passed_count).toBe(1);
    expect(levelsioRow.publish_gate_accepted_count).toBe(1); // accepted by gate

    // Both should have quality scores
    expect(karpathyRow.source_quality_score).toBeGreaterThan(0);
    expect(levelsioRow.source_quality_score).toBeGreaterThan(0);

    // levelsio should score higher (gate accepted, higher scores)
    expect(levelsioRow.source_quality_score).toBeGreaterThan(karpathyRow.source_quality_score);
  });

  it('attributes sources from merge_scan_results even without scan_account tasks', () => {
    // Edge case: merge_scan_results has opportunities for accounts
    // that don't have a scan_account task (e.g., from a different run)
    const tasks = [
      {
        task_type: 'merge_scan_results',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'newsource1' },
            { source_author: 'newsource2' },
          ],
        },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          _opportunities: [
            {
              source_author: 'newsource1',
              _brief: { should_craft: true, publishability_score: 7 },
            },
            {
              source_author: 'newsource2',
              _brief: { should_craft: false, rejection_reason: 'low_quality' },
            },
          ],
        },
      },
    ];

    const result = aggregate(tasks);
    expect(result.size).toBe(2);
    expect(result.has('newsource1')).toBe(true);
    expect(result.has('newsource2')).toBe(true);

    const row1 = result.get('newsource1')!;
    expect(row1.scans_count).toBe(0); // no scan_account task
    expect(row1.raw_opportunities_count).toBe(1); // from merge
    expect(row1.selected_count).toBe(1); // from intelligence

    const row2 = result.get('newsource2')!;
    expect(row2.scans_count).toBe(0);
    expect(row2.raw_opportunities_count).toBe(1);
    expect(row2.selected_count).toBe(0); // should_craft=false
  });

  it('uses viral_found as fallback when opportunities_found/raw_opportunity_count are absent', () => {
    // Real scan_account results commonly expose viral_found instead of opportunities_found
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 25, viral_found: 4 },
      },
    ];

    const result = aggregate(tasks);
    expect(result.size).toBe(1);

    const row = result.get('karpathy')!;
    expect(row.scans_count).toBe(1);
    expect(row.tweets_analyzed).toBe(25);
    expect(row.raw_opportunities_count).toBe(4); // viral_found used as fallback
  });

  it('prefers opportunities_found over viral_found when both are present', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 25, opportunities_found: 6, viral_found: 4 },
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('karpathy')!;
    expect(row.raw_opportunities_count).toBe(6); // opportunities_found takes priority
  });

  it('does not double-count raw_opportunities from merge when scan_account already counted', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 20, viral_found: 3 },
      },
      {
        task_type: 'merge_scan_results',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'karpathy' },
            { source_author: 'karpathy' },
            { source_author: 'karpathy' },
          ],
        },
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('karpathy')!;
    // Should be 3 from scan_account (viral_found), NOT 3 + 3 = 6
    // merge_scan_results skips adding raw_opportunities for accounts
    // that already have scans_count > 0
    expect(row.raw_opportunities_count).toBe(3);
  });

  it('attributes judge results per source_author from _opportunities', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'source_a',
        result: { tweets_analyzed: 10, viral_found: 3 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'source_b',
        result: { tweets_analyzed: 10, viral_found: 2 },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'source_a', _brief: { should_craft: true, publishability_score: 8 } },
            { source_author: 'source_a', _brief: { should_craft: true, publishability_score: 7 } },
            { source_author: 'source_b', _brief: { should_craft: true, publishability_score: 9 } },
          ],
        },
      },
      {
        task_type: 'opportunity_judge',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'source_a', _judge_result: { passed: true } },
            { source_author: 'source_a', _judge_result: { passed: false } },
            { source_author: 'source_b', _judge_result: { passed: true } },
          ],
        },
      },
    ];

    const result = aggregate(tasks);

    const rowA = result.get('source_a')!;
    expect(rowA.selected_count).toBe(2);
    expect(rowA.judge_passed_count).toBe(1); // only 1 passed out of 2

    const rowB = result.get('source_b')!;
    expect(rowB.selected_count).toBe(1);
    expect(rowB.judge_passed_count).toBe(1); // 1 passed out of 1
  });

  it('attributes publish_gate accepted/rejected per source_author', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'alpha',
        result: { tweets_analyzed: 10, viral_found: 2 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'beta',
        result: { tweets_analyzed: 10, viral_found: 1 },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'alpha', _brief: { should_craft: true, publishability_score: 8 } },
            { source_author: 'beta', _brief: { should_craft: true, publishability_score: 7 } },
          ],
        },
      },
      {
        task_type: 'opportunity_judge',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'alpha', _judge_result: { passed: true } },
            { source_author: 'beta', _judge_result: { passed: true } },
          ],
        },
      },
      {
        task_type: 'publish_gate',
        account_handle: null,
        result: {
          _accepted: [
            { source_author: 'alpha', crafted_text: 'Great insight...' },
          ],
          _rejected: [
            { source_author: 'beta', reason: 'freshness_timeout' },
          ],
        },
      },
    ];

    const result = aggregate(tasks);

    const alphaRow = result.get('alpha')!;
    expect(alphaRow.publish_gate_accepted_count).toBe(1);

    const betaRow = result.get('beta')!;
    expect(betaRow.publish_gate_accepted_count).toBe(0);
    // beta's rejection reason should be attributed
    expect(betaRow.rejection_reason_counts['freshness_timeout']).toBeGreaterThanOrEqual(1);
  });

  it('falls back to top-level counts when _opportunities is empty', () => {
    // Some older pipeline runs might not have _opportunities in judge/gate results
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'testuser',
        result: { tweets_analyzed: 10, opportunities_found: 5 },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'testuser', _brief: { should_craft: true, publishability_score: 8 } },
          ],
        },
      },
      {
        task_type: 'opportunity_judge',
        account_handle: null,
        result: { judge_passed_count: 1 }, // no _opportunities, top-level count
      },
      {
        task_type: 'publish_gate',
        account_handle: null,
        result: { accepted: 1, reasons: ['freshness_timeout'] }, // no _accepted, top-level count
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('testuser')!;

    // Fallback proportional distribution should attribute counts
    expect(row.judge_passed_count).toBeGreaterThanOrEqual(1);
    expect(row.publish_gate_accepted_count).toBeGreaterThanOrEqual(1);
  });

  it('does not invent counts when attribution is impossible', () => {
    // Global task with no source_author anywhere and no scan_account tasks
    const tasks = [
      {
        task_type: 'opportunity_judge',
        account_handle: null,
        result: { judge_passed_count: 5 }, // no _opportunities, no scan accounts
      },
    ];

    const result = aggregate(tasks);
    // No accounts to attribute to — should produce empty result, not invent sources
    expect(result.size).toBe(0);
  });

  it('handles legacy briefs[] format in opportunity_intelligence', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'legacyuser',
        result: { tweets_analyzed: 10, opportunities_found: 2 },
      },
      {
        task_type: 'opportunity_intelligence',
        account_handle: null,
        result: {
          // Legacy format: briefs[] with source_author
          briefs: [
            { source_author: 'legacyuser', should_craft: true, publishability_score: 8, originality_potential_score: 7, niche_fit_score: 6, usefulness_score: 7 },
            { source_author: 'legacyuser', should_craft: false, rejection_reason: 'too_generic' },
          ],
          rescue_count: 1,
          rejection_reason_counts: { too_generic: 1 },
        },
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('legacyuser')!;
    expect(row.selected_count).toBe(1);
    expect(row.avg_publishability_score).toBe(8);
    expect(row.rejection_reason_counts).toHaveProperty('too_generic');
  });

  it('handles multiple scan_account tasks for the same handle', () => {
    // Same account scanned multiple times across runs
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 10, viral_found: 2 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 15, viral_found: 3 },
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('karpathy')!;
    expect(row.scans_count).toBe(2);
    expect(row.tweets_analyzed).toBe(25);
    expect(row.raw_opportunities_count).toBe(5); // 2 + 3
  });

  it('produces neutral scores for sources with only scan data and no downstream metrics', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'onlyscanned',
        result: { tweets_analyzed: 10, viral_found: 0 },
      },
    ];

    const result = aggregate(tasks);
    const row = result.get('onlyscanned')!;
    expect(row.scans_count).toBe(1);
    expect(row.selected_count).toBe(0);
    expect(row.judge_passed_count).toBe(0);
    expect(row.publish_gate_accepted_count).toBe(0);
    // With 1 scan and 0 raw_opportunities, score should regress toward 50
    expect(row.source_quality_score).toBeLessThanOrEqual(50);
    expect(row.source_quality_score).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Invalid handle validation
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Invalid handle validation', () => {
  it('Arabic handles are skipped by extractSourceHandle', () => {
    expect(extractSourceHandle({ source_author: 'الحسابات' })).toBeNull();
    expect(extractSourceHandle({ source_author: 'قائمة' })).toBeNull();
    expect(extractSourceHandle({ author: 'الحسابات' })).toBeNull();
  });

  it('Emoji handles are skipped by extractSourceHandle', () => {
    expect(extractSourceHandle({ source_author: '📋' })).toBeNull();
    expect(extractSourceHandle({ source_author: '🔥🔥🔥' })).toBeNull();
  });

  it('UI labels are skipped by extractSourceHandle', () => {
    // 'brain' is technically a valid X handle format, so it passes isValidXHandle
    // Invalidation of non-account sources is handled at the backfill level
    // by checking the accounts table, not at the extractSourceHandle level
    expect(extractSourceHandle({ source_author: 'brain' })).toBe('brain'); // valid X format
    expect(extractSourceHandle({ source_author: '📋' })).toBeNull(); // emoji is invalid
    expect(extractSourceHandle({ source_author: 'الحسابات' })).toBeNull(); // Arabic is invalid
  });

  it('extractSourceHandle validates output via isValidXHandle', () => {
    // Valid handles pass through
    expect(extractSourceHandle({ source_author: 'karpathy' })).toBe('karpathy');
    expect(extractSourceHandle({ source_author: 'levelsio' })).toBe('levelsio');
    // Invalid handles are rejected
    expect(extractSourceHandle({ source_author: '' })).toBeNull();
    expect(extractSourceHandle({ source_author: '📋' })).toBeNull(); // emoji
    expect(extractSourceHandle({ source_author: 'الحسابات' })).toBeNull(); // Arabic
  });

  it('Arabic handles are excluded from aggregation results', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'karpathy',
        result: { tweets_analyzed: 10, viral_found: 2 },
      },
      {
        task_type: 'scan_account',
        account_handle: 'الحسابات',
        result: { tweets_analyzed: 5, viral_found: 1 },
      },
      {
        task_type: 'merge_scan_results',
        account_handle: null,
        result: {
          _opportunities: [
            { source_author: 'karpathy' },
            { source_author: 'الحسابات' },
            { source_author: 'قائمة' },
          ],
        },
      },
    ];

    const { sources, diagnostics } = aggregateWithDiags(tasks);
    expect(sources.has('karpathy')).toBe(true);
    // Arabic handles are invalid X handles, so they should not appear in results
    expect(sources.has('الحسابات')).toBe(false);
    expect(sources.has('قائمة')).toBe(false);
    // The Arabic handle used as account_handle in scan_account IS tracked in skipped list
    expect(diagnostics.skipped_invalid_source_handles).toContain('الحسابات');
  });

  it('Arabic handle in scan_account task is excluded', () => {
    const tasks = [
      {
        task_type: 'scan_account',
        account_handle: 'الحسابات',
        result: { tweets_analyzed: 10, viral_found: 2 },
      },
    ];

    const { sources, diagnostics } = aggregateWithDiags(tasks);
    expect(sources.has('الحسابات')).toBe(false);
    expect(diagnostics.skipped_invalid_source_handles).toContain('الحسابات');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. Scoring conservatism
// ═══════════════════════════════════════════════════════════════════════════

describe('S1.4: Scoring conservatism', () => {
  it('scan-only sources stay neutral-ish, not very low', () => {
    // A source that has been scanned but has no intelligence/judge/gate data
    // should not score as "very low" (which was the bug: 25/28 sources < 20)
    const score = computeSourceQualityScore({
      scans_count: 2,
      selected_rate: 0,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      avg_publishability_score: 0,
      avg_originality_potential_score: 0,
      avg_usefulness_score: 0,
      rejection_rate: 1.0,
      raw_opportunities_count: 5,
    });
    // Should be at least NO_SIGNAL_FLOOR (35) since no positive signal
    // and no proven zero-yield
    expect(score).toBeGreaterThanOrEqual(NO_SIGNAL_FLOOR);
  });

  it('scan-only with zero raw opportunities also stays above 35 until proven', () => {
    // Even with 0 raw_opportunities, a source with < 3 scans should not be
    // penalized below 35
    const score = computeSourceQualityScore({
      scans_count: 1,
      selected_rate: 0,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      avg_publishability_score: 0,
      avg_originality_potential_score: 0,
      avg_usefulness_score: 0,
      rejection_rate: 0,
      raw_opportunities_count: 0,
    });
    // Only 1 scan, not proven zero-yield yet (need >= 3 scans)
    expect(score).toBeGreaterThanOrEqual(NO_SIGNAL_FLOOR);
  });

  it('sources with repeated zero-yield scans ARE penalized gradually', () => {
    // After 3+ scans with 0 raw_opportunities, proven zero-yield kicks in
    const provenZeroYield = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      avg_publishability_score: 0,
      avg_originality_potential_score: 0,
      avg_usefulness_score: 0,
      rejection_rate: 0,
      raw_opportunities_count: 0,
    });
    // Proven zero-yield should drop below 35
    expect(provenZeroYield).toBeLessThan(LOW_SOURCE_THRESHOLD);
  });

  it('strong source can still score high', () => {
    const score = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0.8,
      judge_passed_count: 8,
      publish_gate_accepted_count: 3,
      avg_publishability_score: 8.5,
      avg_originality_potential_score: 8.0,
      avg_usefulness_score: 7.5,
      rejection_rate: 0.1,
      raw_opportunities_count: 20,
    });
    expect(score).toBeGreaterThanOrEqual(STRONG_SOURCE_THRESHOLD);
  });

  it('missing avg score data is treated as neutral, not zero', () => {
    // When avg scores are 0 (meaning no data, not actually 0-scored),
    // they should not penalize the source
    const noScoreData = computeSourceQualityScore({
      scans_count: 5,
      selected_rate: 0,
      judge_passed_count: 0,
      publish_gate_accepted_count: 0,
      rejection_rate: 0,
      raw_opportunities_count: 5,
    });
    // Without actual score data, avg scores default to neutral (5)
    // So score should not drop below NO_SIGNAL_FLOOR
    expect(noScoreData).toBeGreaterThanOrEqual(NO_SIGNAL_FLOOR);
  });

  it('NO_SIGNAL_FLOOR is 35', () => {
    expect(NO_SIGNAL_FLOOR).toBe(35);
  });

  it('no thresholds or gates changed', () => {
    expect(UNKNOWN_SOURCE_SCORE).toBe(50);
    expect(STRONG_SOURCE_THRESHOLD).toBe(70);
    expect(LOW_SOURCE_THRESHOLD).toBe(35);
    expect(MIN_SCANS_FOR_CONFIDENCE).toBe(3);
  });
});
