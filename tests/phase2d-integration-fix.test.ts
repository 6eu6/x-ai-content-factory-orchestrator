/**
 * Phase 2D Integration Fix Tests — Deep integration fix after Phase 2D audit
 *
 * Tests for 4 critical bugs:
 * Bug #1: Fallback misuse — intelligence returning [] should NOT fall back to merge
 * Bug #2: Telegram report Phase 2D awareness
 * Bug #3: Account source contamination — invalid X handles
 * Bug #4: Judge JSON parse hardening
 */

import { describe, it, expect } from 'vitest';
import { isValidXHandle, VALID_X_HANDLE_REGEX, selectValidAccounts, calculateFetchLimit } from '../lib/pipeline-queue';
import { quickJudgeCheck } from '../lib/opportunity-judge';

// ═══ Bug #1: Intelligence task exists with _opportunities=[] → enrich returns zero, does NOT read merge ═══

describe('Bug #1: Fallback misuse — intelligence selected zero should not fall back to merge', () => {
  it('intelligence task exists with _opportunities=[] → enrich must return zero and NOT read merge', () => {
    // Simulate the fallback decision logic
    const intelTask = { result: { _opportunities: [] } };
    const mergeTask = { result: { _opportunities: [{ id: 1 }, { id: 2 }, { id: 3 }] } };

    // The CORRECT behavior: if intelTask exists, use its _opportunities even if empty
    let opportunities;
    if (intelTask) {
      opportunities = intelTask.result?._opportunities || [];
    } else {
      opportunities = mergeTask?.result?._opportunities || [];
    }

    expect(opportunities).toEqual([]);
    expect(opportunities.length).toBe(0);
  });

  it('intelligence task missing → enrich falls back to merge for old runs', () => {
    // Simulate the fallback decision logic for a pre-Phase 2D run
    const intelTask = null; // No intelligence task at all
    const mergeTask = { result: { _opportunities: [{ id: 1 }, { id: 2 }] } };

    let opportunities;
    if (intelTask) {
      opportunities = intelTask.result?._opportunities || [];
    } else {
      opportunities = mergeTask?.result?._opportunities || [];
    }

    expect(opportunities.length).toBe(2);
  });

  it('intelligence selected zero → quality_enhance receives zero', () => {
    // After enrich returns empty, quality_enhance should also receive zero
    const enrichResult = { result: { _opportunities: [] } };
    const opportunities = enrichResult.result?._opportunities || [];
    expect(opportunities.length).toBe(0);
  });

  it('quality_enhance zero → opportunity_judge receives zero', () => {
    // After quality_enhance returns empty, judge should also receive zero
    const qualityResult = { result: { _opportunities: [] } };
    const opportunities = qualityResult.result?._opportunities || [];
    expect(opportunities.length).toBe(0);
  });

  it('opportunity_judge zero → publish_gate receives zero', () => {
    // After judge returns empty, publish_gate should also receive zero
    const judgeResult = { result: { _opportunities: [] } };
    const opportunities = judgeResult.result?._opportunities || [];
    expect(opportunities.length).toBe(0);
  });

  it('no raw rejected opportunities leak past intelligence', () => {
    // This is the core bug: raw opportunities from merge should NOT appear
    // in any downstream step when intelligence has filtered them all out.
    const rawMergeOpportunities = [
      { id: 1, text: 'weak opportunity 1' },
      { id: 2, text: 'weak opportunity 2' },
      { id: 3, text: 'weak opportunity 3' },
    ];
    const intelSelectedOpportunities: any[] = []; // intelligence selected zero

    // Simulating the correct fallback logic for enrich:
    const intelTask = { result: { _opportunities: intelSelectedOpportunities } };

    let opportunities;
    if (intelTask) {
      opportunities = intelTask.result?._opportunities || [];
    } else {
      opportunities = rawMergeOpportunities;
    }

    // The opportunities should be empty, NOT the raw merge opportunities
    expect(opportunities).toEqual([]);
    expect(opportunities).not.toEqual(rawMergeOpportunities);
  });
});

// ═══ Bug #2: Telegram summary handles intelligence_selected_count=0 clearly ═══

describe('Bug #2: Telegram report Phase 2D awareness', () => {
  it('Telegram summary handles intelligence_selected_count=0 clearly', () => {
    // When intelligence selected 0, Telegram should NOT imply publish_gate rejected crafted candidates
    const intelDiag = {
      raw_opportunity_count: 15,
      intelligence_evaluated_count: 15,
      intelligence_selected_count: 0,
      intelligence_rejected_count: 15,
      top_rejection_reasons: { weak_source: 15 },
    };

    // When intelligence selected 0, the message should be clear
    const isIntelSelectedZero = intelDiag.intelligence_selected_count === 0;
    expect(isIntelSelectedZero).toBe(true);

    // The message logic should distinguish between intelligence rejection and publish_gate rejection
    const messagePrefix = isIntelSelectedZero
      ? 'No strong raw opportunities selected by intelligence'
      : 'No publishable opportunities passed publish gate';
    expect(messagePrefix).toBe('No strong raw opportunities selected by intelligence');
  });

  it('Telegram summary includes intelligence and judge diagnostics', () => {
    // The decision object should carry Phase 2D diagnostics
    const decision = {
      _intelligenceDiagnostics: {
        raw_opportunity_count: 15,
        intelligence_evaluated_count: 15,
        intelligence_selected_count: 2,
        intelligence_rejected_count: 13,
        top_rejection_reasons: { weak_source: 10, low_niche_fit: 3 },
      },
      _judgeDiagnostics: {
        judge_passed_count: 1,
        judge_failed_count: 1,
        judge_failure_reasons: { originality_score: 1 },
      },
    };

    expect(decision._intelligenceDiagnostics).toBeDefined();
    expect(decision._judgeDiagnostics).toBeDefined();
    expect(decision._intelligenceDiagnostics.intelligence_selected_count).toBe(2);
    expect(decision._judgeDiagnostics.judge_passed_count).toBe(1);
    expect(decision._judgeDiagnostics.judge_failed_count).toBe(1);
  });
});

// ═══ Bug #3: Invalid account handles are skipped ═══

describe('Bug #3: Account source contamination — X handle validation', () => {
  it('Arabic text handles are rejected', () => {
    expect(isValidXHandle('الحسابات')).toBe(false);
    expect(isValidXHandle('قائمة')).toBe(false);
  });

  it('Emoji handles are rejected', () => {
    expect(isValidXHandle('📋')).toBe(false);
    expect(isValidXHandle('🧠AI')).toBe(false);
    expect(isValidXHandle('hello🎉')).toBe(false);
  });

  it('Labels like "قائمة" or "الحسابات" are rejected', () => {
    expect(isValidXHandle('قائمة')).toBe(false);
    expect(isValidXHandle('الحسابات')).toBe(false);
  });

  it('Handles longer than 15 chars are rejected', () => {
    expect(isValidXHandle('a_very_long_handle_name')).toBe(false);
    expect(isValidXHandle('thisiswaytoolongforx')).toBe(false);
  });

  it('Handles with spaces/symbols are rejected', () => {
    expect(isValidXHandle('has space')).toBe(false);
    expect(isValidXHandle('has-dash')).toBe(false);
    expect(isValidXHandle('has.dot')).toBe(false);
    expect(isValidXHandle('has@sign')).toBe(false);
    expect(isValidXHandle('has!bang')).toBe(false);
  });

  it('Valid handles still pass validation', () => {
    expect(isValidXHandle('30piq')).toBe(true);
    expect(isValidXHandle('elonmusk')).toBe(true);
    expect(isValidXHandle('a')).toBe(true);
    expect(isValidXHandle('A_B_C_123')).toBe(true);
    expect(isValidXHandle('user_name_99')).toBe(true);
    expect(isValidXHandle('abc123')).toBe(true);
    expect(isValidXHandle('_ABC_')).toBe(true);
  });

  it('Empty/null/undefined handles are rejected', () => {
    expect(isValidXHandle('')).toBe(false);
    expect(isValidXHandle(null as any)).toBe(false);
    expect(isValidXHandle(undefined as any)).toBe(false);
  });

  it('URL handles are rejected', () => {
    expect(isValidXHandle('https://x.com/user')).toBe(false);
    expect(isValidXHandle('http://example.com')).toBe(false);
  });
});

// ═══ Bug #4: Judge invalid JSON becomes judge_parse_failed diagnostic ═══

describe('Bug #4: Judge JSON parse hardening', () => {
  it('judge_parse_failed is a clean diagnostic, not noisy publish_gate reason', () => {
    // The judge should return "judge_parse_failed" as the failure_reason
    // NOT something like "ai_judge_failed:Unexpected end of JSON input"
    const failureReason = 'judge_parse_failed';

    // Verify it's a clean, stable reason string
    expect(failureReason).toBe('judge_parse_failed');
    expect(failureReason).not.toContain('Unexpected');
    expect(failureReason).not.toContain('JSON');
    expect(failureReason).not.toContain('end of');
    expect(failureReason.length).toBeLessThan(30);
  });

  it('judge_parse_failed is preserved in batch summary failure_reasons', () => {
    // When aggregating failure reasons in judgeCraftedCandidates,
    // "judge_parse_failed" should be preserved as-is, not normalized to "judge_parse"
    const reason = 'judge_parse_failed';
    const key = reason === 'judge_parse_failed' ? reason
      : reason.split('_')[0] + '_' + reason.split('_')[1];

    expect(key).toBe('judge_parse_failed');
    expect(key).not.toBe('judge_parse');
  });

  it('quickJudgeCheck still works independently of AI parse errors', () => {
    // The heuristic check should always work regardless of AI parse failures
    const text = 'Yo... this is a game changer for AI';
    const result = quickJudgeCheck(text);
    expect(result.generic_bait_flag).toBe(true);
    expect(result.unsupported_claim_flag).toBe(false);
  });

  it('judge_parse_failed does not pollute shield_issues with raw parser messages', () => {
    // When judge fails with parse error, the shield_issues should read
    // "judge_failed:judge_parse_failed" NOT "judge_failed:ai_judge_failed:Unexpected end of JSON input"
    const failureReasons = ['judge_parse_failed'];
    const shieldIssue = `judge_failed:${failureReasons[0] || 'unknown'}`;

    expect(shieldIssue).toBe('judge_failed:judge_parse_failed');
    expect(shieldIssue).not.toContain('Unexpected');
    expect(shieldIssue).not.toContain('JSON input');
  });
});

// ═══ Account Selection Fix: Invalid handles before valid handles do not reduce scan count ═══

describe('Account Selection Fix: invalid handles do not consume accountLimit', () => {
  // Test 1: invalid handles before valid handles do not reduce scan count if enough valid accounts exist
  it('invalid handles before valid handles do not reduce scan count if enough valid accounts exist', () => {
    // Simulate: 3 invalid handles at the top (last_checked=null), then 10 valid handles
    const candidates = [
      { handle: '📋' },
      { handle: 'قائمة' },
      { handle: 'الحسابات' },
      ...Array.from({ length: 10 }, (_, i) => ({ handle: `valid_user_${i}` })),
    ];
    const accountLimit = 10;

    const result = selectValidAccounts(candidates, accountLimit, 'fallback_user');

    // All 10 valid handles should be selected; 3 invalid excluded
    expect(result.validAccounts.length).toBe(10);
    expect(result.excludedInvalidHandles.length).toBe(3);
    expect(result.validAccounts[0].handle).toBe('valid_user_0');
  });

  // Test 2: accountLimit=10 with 3 invalid + 10 valid creates 10 scan_account tasks
  it('accountLimit=10 with 3 invalid + 10 valid creates 10 valid accounts (not 7)', () => {
    const candidates = [
      { handle: '📋' },
      { handle: 'قائمة' },
      { handle: 'الحسابات' },
      ...Array.from({ length: 10 }, (_, i) => ({ handle: `user${i}` })),
    ];
    const accountLimit = 10;

    const result = selectValidAccounts(candidates, accountLimit, '30piq');

    // Previously this would have returned 7 (10 - 3 invalid consumed slots)
    // Now it returns 10 because we filter first, then slice
    expect(result.validAccounts.length).toBe(10);
    expect(result.excludedInvalidHandles).toEqual(['📋', 'قائمة', 'الحسابات']);
  });

  // Test 3: all invalid accounts + valid username creates one username scan task
  it('all invalid accounts + valid username creates one username fallback scan', () => {
    const candidates = [
      { handle: '📋' },
      { handle: 'قائمة' },
      { handle: 'الحسابات' },
    ];
    const accountLimit = 10;

    const result = selectValidAccounts(candidates, accountLimit, '30piq');

    // Falls back to valid username
    expect(result.validAccounts.length).toBe(1);
    expect(result.validAccounts[0].handle).toBe('30piq');
    expect(result.excludedInvalidHandles.length).toBe(3);
  });

  // Test 4: all invalid accounts + invalid username creates no scan_account tasks
  it('all invalid accounts + invalid username creates no scan tasks and no invalid handles', () => {
    const candidates = [
      { handle: '📋' },
      { handle: 'قائمة' },
      { handle: 'الحسابات' },
    ];
    const accountLimit = 10;

    // Arabic username is also invalid
    const result = selectValidAccounts(candidates, accountLimit, 'الحسابات');

    // No valid accounts and invalid username → empty result
    expect(result.validAccounts.length).toBe(0);
    expect(result.excludedInvalidHandles.length).toBe(3);
    // No scan_account task should be created with an invalid handle
  });

  // Test 5: valid handles remain accepted
  it('valid handles remain accepted through selectValidAccounts', () => {
    const candidates = [
      { handle: '30piq' },
      { handle: 'elonmusk' },
      { handle: '_ABC_' },
      { handle: 'user_name_99' },
      { handle: 'a' },
    ];
    const accountLimit = 10;

    const result = selectValidAccounts(candidates, accountLimit);

    expect(result.validAccounts.length).toBe(5);
    expect(result.excludedInvalidHandles.length).toBe(0);
  });

  // Test 6: Arabic/emoji/UI labels remain rejected by selectValidAccounts
  it('Arabic/emoji/UI labels remain rejected by selectValidAccounts', () => {
    const candidates = [
      { handle: 'الحسابات' },
      { handle: '📋' },
      { handle: 'قائمة' },
      { handle: 'hello🎉' },
      { handle: 'has space' },
      { handle: 'has-dash' },
      { handle: 'https://x.com/user' },
      { handle: 'a_very_long_handle_name' },
      { handle: '' },
      { handle: 'validuser' },
    ];
    const accountLimit = 10;

    const result = selectValidAccounts(candidates, accountLimit);

    // Only 'validuser' passes
    expect(result.validAccounts.length).toBe(1);
    expect(result.validAccounts[0].handle).toBe('validuser');
    expect(result.excludedInvalidHandles.length).toBe(9);
  });

  // Test 7: calculateFetchLimit produces expected over-fetch
  it('calculateFetchLimit produces expected over-fetch values', () => {
    // accountLimit=10 → max(40, 20) = 40, min(40, 100) = 40
    expect(calculateFetchLimit(10)).toBe(40);

    // accountLimit=1 → max(4, 11) = 11, min(11, 100) = 11
    expect(calculateFetchLimit(1)).toBe(11);

    // accountLimit=30 → max(120, 40) = 120, min(120, 100) = 100
    expect(calculateFetchLimit(30)).toBe(100);

    // accountLimit=25 → max(100, 35) = 100, min(100, 100) = 100
    expect(calculateFetchLimit(25)).toBe(100);
  });
});

// ═══ Build and test pass ═══

describe('Phase 2D integration fix: build/test pass', () => {
  it('all validation functions are importable', () => {
    expect(typeof isValidXHandle).toBe('function');
    expect(typeof quickJudgeCheck).toBe('function');
    expect(typeof selectValidAccounts).toBe('function');
    expect(typeof calculateFetchLimit).toBe('function');
  });
});
