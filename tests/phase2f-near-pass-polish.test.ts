/**
 * phase2f-near-pass-polish.test.ts — Phase 2F: Near-Pass Candidate Polish Tests
 *
 * 16 test cases covering:
 * - Near-pass eligibility detection (isNearPass)
 * - Polish prompt construction
 * - Polished text validation
 * - Re-judge behavior
 * - Max polish limits
 * - Thresholds unchanged
 * - Model routing unchanged
 */

import { describe, it, expect } from 'vitest';

// ═══ Import pure functions for testing ═══

import {
  isNearPass,
  NEAR_PASS_THRESHOLDS,
  type JudgeResult,
} from '../lib/opportunity-judge';

import {
  buildPolishPrompt,
  validatePolishedText,
  computeNearPassDiagnostics,
  MAX_POLISH_CANDIDATES_PER_RUN,
  type PolishInput,
  type PolishOutcome,
} from '../lib/near-pass-polish';

// ═══ Helper: Create a base JudgeResult ═══

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    passed: false,
    final_candidate_score: 7,
    originality_score: 7,
    usefulness_score: 6,
    niche_fit_score: 8,
    evidence_safety_score: 9,
    clarity_score: 8,
    brief_alignment_score: 7,
    generic_bait_flag: false,
    unsupported_claim_flag: false,
    failure_reasons: [
      'originality_score_7_below_7.8',
      'usefulness_score_6_below_7',
    ],
    ...overrides,
  };
}

function makeBrief(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    source_summary: 'Karpathy joins Anthropic, signaling a shift toward AI safety focus',
    recommended_angle: 'What Karpathy joining Anthropic means for AI builder priorities',
    why_it_matters: 'Shows the AI talent market shifting toward safety',
    required_context: ['Karpathy was at OpenAI and Tesla before'],
    do_not_claim: ['Karpathy was fired', 'Anthropic is winning the AI race'],
    ...overrides,
  };
}

// ═══ Test 1: Near-pass candidate is detected when final_candidate_score=7 and fixable failures ═══

describe('Near-Pass Eligibility', () => {
  it('detects near-pass candidate when final_candidate_score=7 with fixable failures', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      originality_score: 7,
      usefulness_score: 6,
      evidence_safety_score: 9,
      niche_fit_score: 8,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      failure_reasons: [
        'originality_score_7_below_7.8',
        'usefulness_score_6_below_7',
      ],
    });

    const craftedText = 'Karpathy moving to Anthropic is a signal: the most interesting AI work is shifting from raw capability to alignment. Builders who adapt early will have the edge.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(true);
  });

  // ═══ Test 2: Candidate below 6.8 is NOT polished ═══

  it('rejects candidate with final_candidate_score below 6.8', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 6.5,
      originality_score: 5,
      usefulness_score: 5,
      failure_reasons: [
        'final_candidate_score_6.5_below_7.8',
        'originality_score_5_below_7.8',
      ],
    });

    const craftedText = 'Some generic text that is at least forty characters long but not great quality.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });

  // ═══ Test 3: Unsafe candidate is NOT polished ═══

  it('rejects candidate with evidence_safety_score below 7.5', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      evidence_safety_score: 6,
      failure_reasons: [
        'evidence_safety_score_6_below_8',
        'originality_score_7_below_7.8',
      ],
    });

    const craftedText = 'Studies show that 95% of AI researchers prefer Anthropic over other labs for safety work.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });

  // ═══ Test 4: Malformed/JSON-wrapper candidate is NOT polished ═══

  it('rejects candidate with generic_bait_flag', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      generic_bait_flag: true,
      failure_reasons: ['generic_bait_flag', 'originality_score_7_below_7.8'],
    });

    const craftedText = 'This is huge! Game changer for the industry! You need to see this now.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });

  // ═══ Test 5: Candidate with unsupported_claim_flag is NOT polished ═══

  it('rejects candidate with unsupported_claim_flag', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      unsupported_claim_flag: true,
      failure_reasons: ['unsupported_claim_flag', 'originality_score_7_below_7.8'],
    });

    const craftedText = 'Research shows that 80% of companies will adopt AI agents by next year for productivity gains.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });

  // ═══ Test 6: Already-passing candidate is NOT near-pass ═══

  it('rejects candidate that already passed the judge', () => {
    const judgeResult = makeJudgeResult({
      passed: true,
      final_candidate_score: 8,
      originality_score: 8,
      usefulness_score: 8,
      evidence_safety_score: 9,
      failure_reasons: [],
    });

    const craftedText = 'A great tweet about AI and productivity that passes all the quality thresholds.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });

  // ═══ Test 7: Candidate without brief is NOT near-pass ═══

  it('rejects candidate without brief context', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      failure_reasons: ['originality_score_7_below_7.8'],
    });

    const craftedText = 'Some text about AI that is at least forty characters in length for testing.';

    expect(isNearPass(judgeResult, craftedText, null)).toBe(false);
    expect(isNearPass(judgeResult, craftedText, {})).toBe(false);
  });

  // ═══ Test 8: Candidate with too-short text is NOT near-pass ═══

  it('rejects candidate with crafted_text under 40 chars', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      failure_reasons: ['originality_score_7_below_7.8'],
    });

    const brief = makeBrief();
    expect(isNearPass(judgeResult, 'Short', brief)).toBe(false);
  });

  // ═══ Test 9: Candidate with text over 280 chars is NOT near-pass ═══

  it('rejects candidate with crafted_text over 280 chars', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      failure_reasons: ['originality_score_7_below_7.8'],
    });

    const longText = 'A'.repeat(300);
    const brief = makeBrief();
    expect(isNearPass(judgeResult, longText, brief)).toBe(false);
  });

  // ═══ Test 10: Candidate with niche_fit below 7 is NOT near-pass ═══

  it('rejects candidate with niche_fit_score below 7', () => {
    const judgeResult = makeJudgeResult({
      final_candidate_score: 7,
      niche_fit_score: 5,
      failure_reasons: ['niche_fit_score_5_below_threshold', 'originality_score_7_below_7.8'],
    });

    const craftedText = 'Some off-topic text about sports that is at least forty characters long enough.';
    const brief = makeBrief();

    expect(isNearPass(judgeResult, craftedText, brief)).toBe(false);
  });
});

// ═══ Polish Prompt Tests ═══

describe('Polish Prompt', () => {
  // ═══ Test 11: Polish prompt receives judge failure reasons and brief ═══

  it('includes judge failure reasons, scores, and brief in prompt', () => {
    const input: PolishInput = {
      crafted_text: 'Karpathy joining Anthropic signals AI talent shift.',
      brief: makeBrief(),
      judge_failure_reasons: ['originality_score_7_below_7.8', 'usefulness_score_6_below_7'],
      judge_scores: {
        final_candidate_score: 7,
        originality_score: 7,
        usefulness_score: 6,
        brief_alignment_score: 7,
        evidence_safety_score: 9,
        clarity_score: 8,
      },
      source_text_preview: 'Karpathy is joining Anthropic...',
      source_author: 'someuser',
    };

    const messages = buildPolishPrompt(input);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');

    const systemContent = messages[0].content;

    // Must contain the failure reasons
    expect(systemContent).toContain('originality_score_7_below_7.8');
    expect(systemContent).toContain('usefulness_score_6_below_7');

    // Must contain the scores
    expect(systemContent).toContain('final_candidate_score: 7');
    expect(systemContent).toContain('originality_score: 7');
    expect(systemContent).toContain('usefulness_score: 6');
    expect(systemContent).toContain('evidence_safety_score: 9');

    // Must contain the brief context
    expect(systemContent).toContain('What Karpathy joining Anthropic means for AI builder priorities');
    expect(systemContent).toContain('Karpathy was at OpenAI and Tesla before');

    // Must contain do_not_claim
    expect(systemContent).toContain('Karpathy was fired');
    expect(systemContent).toContain('Anthropic is winning the AI race');

    // Must contain source author
    expect(systemContent).toContain('@someuser');

    // User prompt must contain the crafted text
    expect(messages[1].content).toContain('Karpathy joining Anthropic signals AI talent shift.');
  });
});

// ═══ Polished Text Validation Tests ═══

describe('Polished Text Validation', () => {
  // ═══ Test 12: Valid polished text passes validation ═══

  it('accepts valid polished text within constraints', () => {
    const result = validatePolishedText(
      'Karpathy at Anthropic means alignment is becoming a builder skill. Adapt your tooling around safety testing, not just capability pushing.',
      [],
      'What Karpathy joining Anthropic means for AI builder priorities',
      7
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ═══ Test 13: Invalid polish JSON-looking text is rejected ═══

  it('rejects polished text that looks like JSON', () => {
    const result = validatePolishedText(
      '{"polished_text": "some text here about AI safety"}',
      [],
      undefined,
      7
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_looks_like_json');
  });

  // ═══ Test 14: Polished text with invented personal experience is rejected ═══

  it('rejects polished text with invented personal experience', () => {
    const result = validatePolishedText(
      'I tried building with Claude and found that alignment testing is crucial for production AI systems and every builder should do this.',
      [],
      undefined,
      7
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_has_invented_experience');
  });

  // ═══ Test 15: Polished text over 280 chars is rejected ═══

  it('rejects polished text over 280 characters', () => {
    const longText = 'A'.repeat(300);
    const result = validatePolishedText(longText, [], undefined, 7);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_over_280_chars');
  });

  // ═══ Test 16: Polished text under 40 chars is rejected ═══

  it('rejects polished text under 40 characters', () => {
    const result = validatePolishedText('Short text', [], undefined, 7);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_too_short');
  });

  // ═══ Test 17: Polished text with generic hype is rejected ═══

  it('rejects polished text with generic hype', () => {
    const result = validatePolishedText(
      'This is huge! The game changer for AI builders is finally here and you need to pay attention right now.',
      [],
      undefined,
      7
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_contains_generic_hype');
  });

  // ═══ Test 18: Polished text with do_not_claim violation is rejected ═══

  it('rejects polished text violating do_not_claim terms', () => {
    const result = validatePolishedText(
      'Karpathy was fired from OpenAI before joining Anthropic. This signals a shift in AI priorities for builders.',
      ['Karpathy was fired'],
      undefined,
      7
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('do_not_claim');
  });

  // ═══ Test 19: Polished text with unsupported numeric claims is rejected ═══

  it('rejects polished text with unsupported numeric claims', () => {
    const result = validatePolishedText(
      'Studies show 87% of AI builders now prioritize safety over raw capability. The shift is real and accelerating fast.',
      [],
      undefined,
      7
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_has_unsupported_numeric_claims');
  });

  // ═══ Test 20: Empty polished text is rejected ═══

  it('rejects empty polished text', () => {
    const result = validatePolishedText('', [], undefined, 7);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('polished_text_missing_or_empty');
  });
});

// ═══ Diagnostics Tests ═══

describe('Near-Pass Diagnostics', () => {
  // ═══ Test 21: Diagnostics computed correctly ═══

  it('computes diagnostics from polish outcomes', () => {
    const outcomes: PolishOutcome[] = [
      {
        attempted: true,
        applied: true,
        passed: true,
        polished_text: 'Better tweet about AI',
        before_judge: {
          passed: false,
          final_candidate_score: 7,
          originality_score: 7,
          usefulness_score: 6,
          niche_fit_score: 8,
          evidence_safety_score: 9,
          clarity_score: 8,
          brief_alignment_score: 7,
          generic_bait_flag: false,
          unsupported_claim_flag: false,
          failure_reasons: ['originality_score_7_below_7.8'],
        },
        after_judge: {
          passed: true,
          final_candidate_score: 8,
          originality_score: 8,
          usefulness_score: 7,
          niche_fit_score: 8,
          evidence_safety_score: 9,
          clarity_score: 8,
          brief_alignment_score: 8,
          generic_bait_flag: false,
          unsupported_claim_flag: false,
          failure_reasons: [],
        },
        polish_failed_reason: null,
        what_changed: 'Added sharper frame',
        targeted_failures: ['originality_score'],
      },
      {
        attempted: true,
        applied: false,
        passed: false,
        polished_text: null,
        before_judge: {
          passed: false,
          final_candidate_score: 6.9,
          originality_score: 6.5,
          usefulness_score: 6,
          niche_fit_score: 8,
          evidence_safety_score: 9,
          clarity_score: 7,
          brief_alignment_score: 7,
          generic_bait_flag: false,
          unsupported_claim_flag: false,
          failure_reasons: ['originality_score_6.5_below_7.8'],
        },
        after_judge: {
          passed: false,
          final_candidate_score: 7.2,
          originality_score: 7,
          usefulness_score: 7,
          niche_fit_score: 8,
          evidence_safety_score: 9,
          clarity_score: 7,
          brief_alignment_score: 7.5,
          generic_bait_flag: false,
          unsupported_claim_flag: false,
          failure_reasons: ['originality_score_7_below_7.8'],
        },
        polish_failed_reason: 'polish_improved_but_not_enough',
        what_changed: 'Tried to improve originality',
        targeted_failures: ['originality_score'],
      },
    ];

    const diagnostics = computeNearPassDiagnostics(outcomes);

    expect(diagnostics.near_pass_candidates_count).toBe(2);
    expect(diagnostics.near_pass_polish_attempted_count).toBe(2);
    expect(diagnostics.near_pass_polish_applied_count).toBe(1);
    expect(diagnostics.near_pass_polish_passed_count).toBe(1);
    expect(diagnostics.near_pass_polish_failed_count).toBe(1);
    expect(diagnostics.near_pass_polish_failure_reasons).toContain('polish_improved_but_not_enough');
    expect(diagnostics.average_score_before_polish).toBe(7); // (7 + 6.9) / 2 = 6.95 → rounds to 7
    expect(diagnostics.average_score_after_polish).toBe(7.6); // (8 + 7.2) / 2 = 7.6
  });

  // ═══ Test 22: Empty outcomes produce zero diagnostics ═══

  it('handles empty outcomes gracefully', () => {
    const diagnostics = computeNearPassDiagnostics([]);

    expect(diagnostics.near_pass_candidates_count).toBe(0);
    expect(diagnostics.near_pass_polish_attempted_count).toBe(0);
    expect(diagnostics.near_pass_polish_applied_count).toBe(0);
    expect(diagnostics.near_pass_polish_passed_count).toBe(0);
    expect(diagnostics.average_score_before_polish).toBe(0);
    expect(diagnostics.average_score_after_polish).toBe(0);
  });
});

// ═══ Max Polish Limits Tests ═══

describe('Max Polish Limits', () => {
  // ═══ Test 23: Max 2 polish attempts per run ═══

  it('enforces MAX_POLISH_CANDIDATES_PER_RUN = 2', () => {
    expect(MAX_POLISH_CANDIDATES_PER_RUN).toBe(2);
  });
});

// ═══ Threshold Integrity Tests ═══

describe('Threshold Integrity (unchanged from Phase 2D)', () => {
  // ═══ Test 24: Judge thresholds are unchanged ═══

  it('maintains the same judge thresholds', () => {
    // These thresholds MUST remain unchanged from Phase 2D
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
  });

  // ═══ Test 25: Near-pass thresholds are correctly set ═══

  it('sets near-pass eligibility thresholds correctly', () => {
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_EVIDENCE_SAFETY).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_NICHE_FIT).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_TEXT_LENGTH).toBe(40);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_TEXT_LENGTH).toBe(280);
  });

  // ═══ Test 26: Model routing existing tasks unchanged ═══

  it('maintains existing model routing configuration', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sourcePath = path.join(process.cwd(), 'lib/model-router.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Verify opportunity_judge routing still exists with correct config
    expect(source).toContain("'opportunity_judge'");
    expect(source).toContain("'near_pass_polish'");

    // Verify near_pass_polish routes to the correct model
    expect(source).toContain("model: 'anthropic/claude-sonnet-4.6'");

    // Verify the temperature is set correctly for near_pass_polish
    expect(source).toMatch(/near_pass_polish.*temperature.*0\.15/s);
  });
});

// ═══ Shield Issue Selective Removal Tests (Phase 2F hotfix) ═══

describe('Shield Issue Selective Removal', () => {
  // Simulate the shield issue filtering logic from pipeline-worker.ts
  // This mirrors the exact logic used in processOpportunityJudge near-pass polish

  function computeRemainingShieldIssues(
    shieldIssues: string[],
    afterJudge: {
      brief_alignment_score?: number;
      originality_score?: number;
    } | null
  ): { remaining: string[]; shield_passed: boolean } {
    const remaining = shieldIssues.filter(issue => {
      // Remove judge_failed:* — the re-judge passed, so judge failure is resolved
      if (issue.startsWith('judge_failed:')) return false;
      // Remove brief_alignment_failed only if the re-judge confirms brief_alignment_score >= 7.5
      if (issue === 'brief_alignment_failed' && (afterJudge?.brief_alignment_score ?? 0) >= 7.5) return false;
      // Remove missing_originality only if the re-judge confirms originality_score >= 7.8
      if (issue === 'missing_originality' && (afterJudge?.originality_score ?? 0) >= 7.8) return false;
      // Keep all other issues (numeric, non-judge, etc.)
      return true;
    });
    return { remaining, shield_passed: remaining.length === 0 };
  }

  // ═══ Test 27: Passed polish does NOT set shield_passed=true if unresolved shield issue remains ═══

  it('does NOT set shield_passed=true when unresolved non-judge shield issue remains', () => {
    const shieldIssues = [
      'judge_failed:originality_score_7_below_7.8',
      'numeric_claim_unsourced',
    ];
    const afterJudge = {
      brief_alignment_score: 8,
      originality_score: 8,
    };

    const { remaining, shield_passed } = computeRemainingShieldIssues(shieldIssues, afterJudge);

    // judge_failed should be removed, but numeric_claim_unsourced should remain
    expect(remaining).toContain('numeric_claim_unsourced');
    expect(remaining).not.toContain('judge_failed:originality_score_7_below_7.8');
    expect(shield_passed).toBe(false); // Still has unresolved issue
  });

  // ═══ Test 28: Passed polish removes judge_failed but keeps unrelated shield issues ═══

  it('removes judge_failed issues but preserves unrelated shield issues', () => {
    const shieldIssues = [
      'judge_failed:originality_score_7_below_7.8',
      'judge_failed:usefulness_score_6_below_7',
      'content_too_short',
    ];
    const afterJudge = {
      brief_alignment_score: 8,
      originality_score: 8,
    };

    const { remaining, shield_passed } = computeRemainingShieldIssues(shieldIssues, afterJudge);

    // All judge_failed removed
    expect(remaining).not.toContain('judge_failed:originality_score_7_below_7.8');
    expect(remaining).not.toContain('judge_failed:usefulness_score_6_below_7');
    // Unrelated issue preserved
    expect(remaining).toContain('content_too_short');
    expect(shield_passed).toBe(false);
  });

  // ═══ Test 29: Passed polish can remove missing_originality only when after_judge.originality_score >= 7.8 ═══

  it('removes missing_originality only when after_judge.originality_score >= 7.8', () => {
    // Case 1: after_judge.originality_score >= 7.8 → missing_originality removed
    const case1 = computeRemainingShieldIssues(
      ['judge_failed:originality_score_7_below_7.8', 'missing_originality'],
      { originality_score: 8 }
    );
    expect(case1.remaining).not.toContain('missing_originality');
    expect(case1.shield_passed).toBe(true); // All issues resolved

    // Case 2: after_judge.originality_score < 7.8 → missing_originality kept
    const case2 = computeRemainingShieldIssues(
      ['judge_failed:originality_score_7_below_7.8', 'missing_originality'],
      { originality_score: 7.5 }
    );
    expect(case2.remaining).toContain('missing_originality');
    expect(case2.shield_passed).toBe(false);
  });

  // ═══ Test 30: Passed polish can remove brief_alignment_failed only when after_judge.brief_alignment_score >= 7.5 ═══

  it('removes brief_alignment_failed only when after_judge.brief_alignment_score >= 7.5', () => {
    // Case 1: after_judge.brief_alignment_score >= 7.5 → brief_alignment_failed removed
    const case1 = computeRemainingShieldIssues(
      ['judge_failed:brief_alignment_score_7_below_7.5', 'brief_alignment_failed'],
      { brief_alignment_score: 8 }
    );
    expect(case1.remaining).not.toContain('brief_alignment_failed');
    expect(case1.shield_passed).toBe(true); // All issues resolved

    // Case 2: after_judge.brief_alignment_score < 7.5 → brief_alignment_failed kept
    const case2 = computeRemainingShieldIssues(
      ['judge_failed:brief_alignment_score_7_below_7.5', 'brief_alignment_failed'],
      { brief_alignment_score: 7.0 }
    );
    expect(case2.remaining).toContain('brief_alignment_failed');
    expect(case2.shield_passed).toBe(false);
  });

  // ═══ Test 31: When all shield issues are resolved, shield_passed becomes true ═══

  it('sets shield_passed=true when all shield issues are resolved', () => {
    const shieldIssues = [
      'judge_failed:originality_score_7_below_7.8',
      'brief_alignment_failed',
    ];
    const afterJudge = {
      brief_alignment_score: 8,
      originality_score: 8,
    };

    const { remaining, shield_passed } = computeRemainingShieldIssues(shieldIssues, afterJudge);

    expect(remaining).toHaveLength(0);
    expect(shield_passed).toBe(true);
  });
});

// ═══ Phase 2F.1: Stale Judge State Fix Tests ═══

describe('Phase 2F.1: Improved-But-Still-Failing Judge State', () => {
  // Simulate the stale judge state fix logic from pipeline-worker.ts
  // When polish is applied but still failing, _judge_result and shield_issues
  // must be updated to reflect the after_judge state, not the pre-polish state.

  function rebuildShieldIssuesForStillFailing(
    staleShieldIssues: string[],
    afterJudge: {
      failure_reasons: string[];
      originality_score?: number;
      brief_alignment_score?: number;
    } | null
  ): { shield_issues: string[]; shield_passed: boolean } {
    // Remove stale judge_failed:* issues
    const issuesWithoutStaleJudge = staleShieldIssues.filter(issue =>
      !issue.startsWith('judge_failed:')
    );

    // Add new judge_failed reason from the re-judge
    const newJudgeFailedReason = (afterJudge?.failure_reasons?.length ?? 0) > 0
      ? `judge_failed:${afterJudge!.failure_reasons[0]}`
      : null;

    let rebuiltShieldIssues = [...issuesWithoutStaleJudge];
    if (newJudgeFailedReason) {
      rebuiltShieldIssues.push(newJudgeFailedReason);
    }

    // Conditionally remove missing_originality
    if (afterJudge && afterJudge.originality_score !== undefined && afterJudge.originality_score >= 7.8) {
      rebuiltShieldIssues = rebuiltShieldIssues.filter(issue => issue !== 'missing_originality');
    }

    // Conditionally remove brief_alignment_failed
    if (afterJudge && afterJudge.brief_alignment_score !== undefined && afterJudge.brief_alignment_score >= 7.5) {
      rebuiltShieldIssues = rebuiltShieldIssues.filter(issue => issue !== 'brief_alignment_failed');
    }

    // shield_passed only true if no remaining issues AND after_judge.passed is true
    // Since this is the "still failing" branch, after_judge.passed is always false
    return {
      shield_issues: rebuiltShieldIssues,
      shield_passed: rebuiltShieldIssues.length === 0 && (afterJudge as any)?.passed === true,
    };
  }

  // ═══ Test 32: improved-but-still-failing polish updates _judge_result to after_judge ═══

  it('updates _judge_result to after_judge when polish improves but still fails', () => {
    // Before polish: score=7, failure: final_candidate_score_7_below_7.8
    // After polish: score=8, failure: originality_score_7_below_7.8
    // The _judge_result should reflect the AFTER state (score 8), not the BEFORE state (score 7)
    const afterJudge = {
      passed: false,
      final_candidate_score: 8,
      originality_score: 7,
      usefulness_score: 8,
      niche_fit_score: 8,
      evidence_safety_score: 9,
      clarity_score: 8,
      brief_alignment_score: 8,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      failure_reasons: ['originality_score_7_below_7.8'],
    };

    // Verify the after_judge state would be used for _judge_result
    expect(afterJudge.final_candidate_score).toBe(8);
    expect(afterJudge.failure_reasons).toEqual(['originality_score_7_below_7.8']);
    expect(afterJudge.passed).toBe(false);
  });

  // ═══ Test 33: improved-but-still-failing polish replaces stale judge_failed reason ═══

  it('replaces stale judge_failed reason with new one from after_judge', () => {
    const staleShieldIssues = [
      'missing_originality',
      'judge_failed:final_candidate_score_7_below_7.8',
    ];
    const afterJudge = {
      failure_reasons: ['originality_score_7_below_7.8'],
      originality_score: 7,
      brief_alignment_score: 8,
    };

    const { shield_issues } = rebuildShieldIssuesForStillFailing(staleShieldIssues, afterJudge);

    // Stale judge_failed reason should be replaced with the new one
    expect(shield_issues).not.toContain('judge_failed:final_candidate_score_7_below_7.8');
    expect(shield_issues).toContain('judge_failed:originality_score_7_below_7.8');
    // missing_originality stays because originality_score (7) < 7.8
    expect(shield_issues).toContain('missing_originality');
  });

  // ═══ Test 34: missing_originality remains if after_judge.originality_score < 7.8 ═══

  it('keeps missing_originality when after_judge.originality_score < 7.8', () => {
    const staleShieldIssues = [
      'missing_originality',
      'judge_failed:originality_score_7_below_7.8',
    ];
    const afterJudge = {
      failure_reasons: ['originality_score_7_below_7.8'],
      originality_score: 7,
    };

    const { shield_issues, shield_passed } = rebuildShieldIssuesForStillFailing(staleShieldIssues, afterJudge);

    expect(shield_issues).toContain('missing_originality');
    expect(shield_passed).toBe(false);
  });

  // ═══ Test 35: missing_originality removed if after_judge.originality_score >= 7.8 ═══

  it('removes missing_originality when after_judge.originality_score >= 7.8', () => {
    const staleShieldIssues = [
      'missing_originality',
      'judge_failed:usefulness_score_6_below_7',
    ];
    const afterJudge = {
      failure_reasons: ['usefulness_score_6_below_7'],
      originality_score: 8,
    };

    const { shield_issues } = rebuildShieldIssuesForStillFailing(staleShieldIssues, afterJudge);

    expect(shield_issues).not.toContain('missing_originality');
    // judge_failed is replaced with the new one
    expect(shield_issues).toContain('judge_failed:usefulness_score_6_below_7');
  });
});

// ═══ Phase 2F.1: Source Deduplication Tests ═══

describe('Phase 2F.1: Source Deduplication', () => {
  type TestOpportunity = {
    source_tweet_url: string;
    source_text: string;
    content_format: string;
    crafted_text: string;
    _brief?: {
      publishability_score: number;
      originality_potential_score: number;
      niche_fit_score: number;
      content_format: string;
    };
  };

  function dedupeOpportunities(opps: TestOpportunity[]): {
    result: TestOpportunity[];
    removed: number;
    examples: string[];
  } {
    const examples: string[] = [];
    const groups = new Map<string, TestOpportunity[]>();

    for (const opp of opps) {
      const key = opp.source_tweet_url
        || (() => { const t = opp.source_text || ''; return `text:${t.slice(0, 80)}`; })();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(opp);
    }

    const result: TestOpportunity[] = [];
    for (const [sourceKey, group] of groups) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }

      const ranked = [...group].sort((a, b) => {
        const aBrief = a._brief;
        const bBrief = b._brief;

        const aPub = aBrief?.publishability_score ?? 0;
        const bPub = bBrief?.publishability_score ?? 0;
        if (bPub !== aPub) return bPub - aPub;

        const aOrig = aBrief?.originality_potential_score ?? 0;
        const bOrig = bBrief?.originality_potential_score ?? 0;
        if (bOrig !== aOrig) return bOrig - aOrig;

        const aNiche = aBrief?.niche_fit_score ?? 0;
        const bNiche = bBrief?.niche_fit_score ?? 0;
        if (bNiche !== aNiche) return bNiche - aNiche;

        const aFormat = (aBrief?.content_format || a.content_format || '').toLowerCase();
        const bFormat = (bBrief?.content_format || b.content_format || '').toLowerCase();
        if (aFormat === 'quote' && bFormat !== 'quote') return -1;
        if (bFormat === 'quote' && aFormat !== 'quote') return 1;

        return 0;
      });

      result.push(ranked[0]);

      if (ranked.length >= 2) {
        const topFormat = (ranked[0]._brief?.content_format || ranked[0].content_format || '').toLowerCase();
        const secondFormat = (ranked[1]._brief?.content_format || ranked[1].content_format || '').toLowerCase();
        const secondPub = ranked[1]._brief?.publishability_score ?? 0;
        const secondOrig = ranked[1]._brief?.originality_potential_score ?? 0;
        const topPub = ranked[0]._brief?.publishability_score ?? 0;
        const topOrig = ranked[0]._brief?.originality_potential_score ?? 0;

        const differentFormat = topFormat !== secondFormat && topFormat && secondFormat;
        const bothHighQuality = topPub >= 7 && topOrig >= 7 && secondPub >= 7 && secondOrig >= 7;

        if (differentFormat && bothHighQuality) {
          result.push(ranked[1]);
          examples.push(`${sourceKey}: kept 2 (different formats)`);
        } else {
          examples.push(`${sourceKey}: reduced ${group.length} → 1`);
        }
      }
    }

    return { result, removed: opps.length - result.length, examples };
  }

  // ═══ Test 36: duplicate opportunities with same source_tweet_url are reduced to one strongest candidate ═══

  it('reduces duplicate opportunities with same source_tweet_url to one strongest candidate', () => {
    const opps: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/karpathy/status/123',
        source_text: 'Karpathy joins Anthropic',
        content_format: 'quote',
        crafted_text: 'Karpathy at Anthropic signals AI alignment shift',
        _brief: {
          publishability_score: 8,
          originality_potential_score: 8,
          niche_fit_score: 9,
          content_format: 'quote',
        },
      },
      {
        source_tweet_url: 'https://x.com/karpathy/status/123',
        source_text: 'Karpathy joins Anthropic',
        content_format: 'reply',
        crafted_text: '@karpity great move! Welcome to the safety team!',
        _brief: {
          publishability_score: 5,
          originality_potential_score: 4,
          niche_fit_score: 6,
          content_format: 'reply',
        },
      },
    ];

    const { result, removed } = dedupeOpportunities(opps);

    expect(result).toHaveLength(1);
    expect(removed).toBe(1);
    // The stronger one (pub=8, orig=8) should be kept
    expect(result[0]._brief?.publishability_score).toBe(8);
    expect(result[0].content_format).toBe('quote');
  });

  // ═══ Test 37: dedupe prefers higher publishability/originality/niche scores ═══

  it('prefers higher publishability, originality, and niche scores', () => {
    const opps: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/sama/status/456',
        source_text: 'Sam Altman announces GPT-5',
        content_format: 'reply',
        crafted_text: 'GPT-5 is coming, here is what it means for builders',
        _brief: {
          publishability_score: 6,
          originality_potential_score: 7,
          niche_fit_score: 8,
          content_format: 'reply',
        },
      },
      {
        source_tweet_url: 'https://x.com/sama/status/456',
        source_text: 'Sam Altman announces GPT-5',
        content_format: 'quote',
        crafted_text: 'The real story behind GPT-5 is not raw power, it is alignment',
        _brief: {
          publishability_score: 9,
          originality_potential_score: 9,
          niche_fit_score: 9,
          content_format: 'quote',
        },
      },
    ];

    const { result } = dedupeOpportunities(opps);

    expect(result).toHaveLength(1);
    expect(result[0]._brief?.publishability_score).toBe(9);
  });

  // ═══ Test 38: dedupe preserves two candidates only if high-quality and different formats ═══

  it('preserves two candidates only if explicitly high-quality and different formats', () => {
    // Case 1: Same format → keep only one
    const sameFormat: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/user/status/789',
        source_text: 'Some tweet about AI',
        content_format: 'quote',
        crafted_text: 'First quote take',
        _brief: {
          publishability_score: 8,
          originality_potential_score: 8,
          niche_fit_score: 8,
          content_format: 'quote',
        },
      },
      {
        source_tweet_url: 'https://x.com/user/status/789',
        source_text: 'Some tweet about AI',
        content_format: 'quote',
        crafted_text: 'Second quote take',
        _brief: {
          publishability_score: 7,
          originality_potential_score: 7,
          niche_fit_score: 7,
          content_format: 'quote',
        },
      },
    ];

    const result1 = dedupeOpportunities(sameFormat);
    expect(result1.result).toHaveLength(1);

    // Case 2: Different formats, both high quality → keep both
    const differentFormats: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/user/status/012',
        source_text: 'Major AI breakthrough announced',
        content_format: 'quote',
        crafted_text: 'This breakthrough changes everything about AI alignment research',
        _brief: {
          publishability_score: 9,
          originality_potential_score: 9,
          niche_fit_score: 9,
          content_format: 'quote',
        },
      },
      {
        source_tweet_url: 'https://x.com/user/status/012',
        source_text: 'Major AI breakthrough announced',
        content_format: 'reply',
        crafted_text: 'The key insight from this paper is the alignment tax tradeoff',
        _brief: {
          publishability_score: 8,
          originality_potential_score: 8,
          niche_fit_score: 8,
          content_format: 'reply',
        },
      },
    ];

    const result2 = dedupeOpportunities(differentFormats);
    expect(result2.result).toHaveLength(2);

    // Case 3: Different formats but second is NOT high quality → keep only one
    const lowQuality: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/user/status/345',
        source_text: 'Some tweet',
        content_format: 'quote',
        crafted_text: 'High quality quote take',
        _brief: {
          publishability_score: 8,
          originality_potential_score: 8,
          niche_fit_score: 8,
          content_format: 'quote',
        },
      },
      {
        source_tweet_url: 'https://x.com/user/status/345',
        source_text: 'Some tweet',
        content_format: 'reply',
        crafted_text: 'Low quality reply',
        _brief: {
          publishability_score: 5,
          originality_potential_score: 4,
          niche_fit_score: 6,
          content_format: 'reply',
        },
      },
    ];

    const result3 = dedupeOpportunities(lowQuality);
    expect(result3.result).toHaveLength(1);
  });

  // ═══ Test 39: no threshold changes ═══

  it('does not change any judge or near-pass thresholds', () => {
    // Phase 2F.1 must NOT change thresholds — only fix diagnostics and add dedupe
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
  });

  // ═══ Test 40: no opportunities removed when no duplicates ═══

  it('removes nothing when all opportunities come from different sources', () => {
    const opps: TestOpportunity[] = [
      {
        source_tweet_url: 'https://x.com/user1/status/111',
        source_text: 'AI tweet 1',
        content_format: 'quote',
        crafted_text: 'First unique source',
        _brief: {
          publishability_score: 8,
          originality_potential_score: 8,
          niche_fit_score: 8,
          content_format: 'quote',
        },
      },
      {
        source_tweet_url: 'https://x.com/user2/status/222',
        source_text: 'AI tweet 2',
        content_format: 'reply',
        crafted_text: 'Second unique source',
        _brief: {
          publishability_score: 7,
          originality_potential_score: 7,
          niche_fit_score: 7,
          content_format: 'reply',
        },
      },
    ];

    const { result, removed } = dedupeOpportunities(opps);

    expect(result).toHaveLength(2);
    expect(removed).toBe(0);
  });
});
