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

    // Verify near_pass_polish routes to a capable model (not a downgrade)
    expect(source).toMatch(/near_pass_polish.*anthropic\/claude-sonnet/s);

    // Verify the temperature is set correctly for near_pass_polish
    expect(source).toMatch(/near_pass_polish.*temperature.*0\.15/s);
  });
});
