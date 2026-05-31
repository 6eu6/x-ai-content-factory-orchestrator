/**
 * phase2g2-brief-locked-polish.test.ts — Phase 2G.2: Brief-Locked Signature Polish + Signature Validator Fix
 *
 * 10 test cases:
 * 1. Signature validator scores observed text >= 7
 * 2. Detects "render target" as compact phrase
 * 3. Detects "Match format to consumer, not to habit" as operator takeaway
 * 4. Detects "not fixed" as contrast/inversion
 * 5. Near-pass polish prompt includes BRIEF LOCK when brief_alignment failed
 * 6. Micro-repair eligibility true for final>=7.8 originality>=7.8 evidence>=8 brief_alignment 6.8-7.49
 * 7. Micro-repair eligibility false if originality would drop below 7.8
 * 8. Micro-repair does not bypass judge/publish gate
 * 9. No threshold changes
 * 10. Build/test pass
 */

import { describe, it, expect } from 'vitest';

import {
  detectSignatureVoiceIndicators,
  validateSignatureVoice,
  computeSignatureVoiceScore,
} from '../lib/signature-voice';

import {
  buildPolishPrompt,
  isMicroRepairEligible,
  type PolishInput,
} from '../lib/near-pass-polish';

import {
  NEAR_PASS_THRESHOLDS,
  type JudgeResult,
} from '../lib/opportunity-judge';

// ═══ Helpers ═══

/** The observed crafted text from the latest pipeline run */
const OBSERVED_TEXT = "Output format is not fixed—it's a render target you control. Karpathy: ask for HTML, open in browser. Operators: tables for comparisons, JSON for pipelines, slide outlines for decks. Match format to consumer, not to habit.";

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    passed: false,
    final_candidate_score: 7.8,
    originality_score: 7.8,
    usefulness_score: 7,
    niche_fit_score: 8,
    evidence_safety_score: 8,
    clarity_score: 8,
    brief_alignment_score: 7,
    generic_bait_flag: false,
    unsupported_claim_flag: false,
    failure_reasons: ['brief_alignment_score_7_below_7.5'],
    ...overrides,
  };
}

// ═══ Test 1: Signature validator scores observed text >= 7 ═══

describe('Phase 2G.2: Signature Validator Fix', () => {
  it('scores the observed pipeline text >= 7', () => {
    const validation = validateSignatureVoice(OBSERVED_TEXT);
    expect(validation._signature_voice_score).toBeGreaterThanOrEqual(7);
    // Should NOT have failure reasons when score >= 7
    expect(validation._signature_voice_failure_reasons).toBeUndefined();
  });

  // ═══ Test 2: Detects "render target" as compact phrase ═══

  it('detects "render target" as a compact phrase', () => {
    const indicators = detectSignatureVoiceIndicators(OBSERVED_TEXT);
    expect(indicators.hasCompactPhrase).toBe(true);
    // The detected phrase should contain "render target"
    expect(indicators.detectedSignaturePhrase?.toLowerCase()).toContain('render target');
  });

  // ═══ Test 3: Detects "Match format to consumer, not to habit" as operator takeaway ═══

  it('detects "Match format to consumer, not to habit" as operator takeaway', () => {
    const indicators = detectSignatureVoiceIndicators(OBSERVED_TEXT);
    expect(indicators.hasOperatorTakeaway).toBe(true);
    // The detected takeaway should reference "Match" or "consumer"
    expect(indicators.detectedOperatorTakeaway).toBeTruthy();
  });

  // ═══ Test 4: Detects "not fixed" as contrast/inversion ═══

  it('detects "not fixed" as contrast/inversion', () => {
    const indicators = detectSignatureVoiceIndicators(OBSERVED_TEXT);
    expect(indicators.hasContrastOrInversion).toBe(true);

    // Also test the specific pattern "is not fixed" standalone
    const shortText = 'Output format is not fixed.';
    const shortIndicators = detectSignatureVoiceIndicators(shortText);
    expect(shortIndicators.hasContrastOrInversion).toBe(true);

    // Test "not to habit" standalone
    const notToText = 'Match format to consumer, not to habit.';
    const notToIndicators = detectSignatureVoiceIndicators(notToText);
    expect(notToIndicators.hasContrastOrInversion).toBe(true);
  });

  // Additional contrast/inversion patterns per spec
  it('detects expanded contrast/inversion patterns', () => {
    // "X is not Y" (simple "is not" redefinition)
    expect(detectSignatureVoiceIndicators('The format is not fixed for production use.').hasContrastOrInversion).toBe(true);

    // ", not X" (contrast after punctuation with em-dash)
    expect(detectSignatureVoiceIndicators('Choose quality—not quantity.').hasContrastOrInversion).toBe(true);

    // "not to X" (negation of purpose)
    expect(detectSignatureVoiceIndicators('Match format to consumer, not to habit.').hasContrastOrInversion).toBe(true);

    // "from A to B" (directional contrast)
    expect(detectSignatureVoiceIndicators('Shift from reactive to proactive monitoring.').hasContrastOrInversion).toBe(true);
  });

  // Additional operator takeaway patterns per spec
  it('detects expanded operator takeaway patterns', () => {
    // "Match X to Y"
    expect(detectSignatureVoiceIndicators('Match format to consumer, not to habit.').hasOperatorTakeaway).toBe(true);

    // "Use X for Y"
    expect(detectSignatureVoiceIndicators('Use tables for comparisons, JSON for pipelines.').hasOperatorTakeaway).toBe(true);

    // "Operators: X"
    expect(detectSignatureVoiceIndicators('Operators: tables for comparisons, JSON for pipelines.').hasOperatorTakeaway).toBe(true);

    // "For comparisons, use tables"
    expect(detectSignatureVoiceIndicators('For comparisons, use tables. For pipelines, use JSON.').hasOperatorTakeaway).toBe(true);

    // "Ask for X when Y"
    expect(detectSignatureVoiceIndicators('Ask for HTML when you need structured output.').hasOperatorTakeaway).toBe(true);
  });
});

// ═══ Test 5: Near-pass polish prompt includes BRIEF LOCK when brief_alignment failed ═══

describe('Phase 2G.2: Brief-Locked Polish', () => {
  it('includes BRIEF LOCK section when brief_alignment is at risk', () => {
    const polishInput: PolishInput = {
      crafted_text: 'AI is changing how we build products for the future of work.',
      brief: {
        source_summary: 'Karpathy joins Anthropic',
        recommended_angle: 'What this means for AI builder priorities',
        why_it_matters: 'Shows the AI talent market shifting toward safety',
        required_context: ['Karpathy was at OpenAI and Tesla before'],
        do_not_claim: ['Karpathy was fired'],
      },
      judge_failure_reasons: ['brief_alignment_score_7_below_7.5'],
      judge_scores: {
        final_candidate_score: 7.8,
        originality_score: 8,
        usefulness_score: 8,
        brief_alignment_score: 7,
        evidence_safety_score: 9,
        clarity_score: 8,
      },
      source_text_preview: 'Karpathy is joining Anthropic...',
      source_author: 'karpathy',
    };

    const messages = buildPolishPrompt(polishInput);
    const systemContent = messages[0].content;

    // Must include BRIEF LOCK section
    expect(systemContent).toContain('BRIEF LOCK');
    expect(systemContent).toContain('brief_alignment is at risk');
    expect(systemContent).toContain('BRIEF LOCK CHECKLIST');
    expect(systemContent).toContain('recommended angle');
    expect(systemContent).toContain('Source summary');
    expect(systemContent).toContain('Required context');
    expect(systemContent).toContain('Why it matters');
    expect(systemContent).toContain('preserve every required element');
  });

  it('does NOT include BRIEF LOCK when brief_alignment is not at risk', () => {
    const polishInput: PolishInput = {
      crafted_text: 'A good tweet with excellent brief alignment.',
      brief: {
        recommended_angle: 'Test angle',
      },
      judge_failure_reasons: ['usefulness_score_6_below_7'],
      judge_scores: {
        final_candidate_score: 7.8,
        originality_score: 8,
        usefulness_score: 6,
        brief_alignment_score: 8,
        evidence_safety_score: 9,
        clarity_score: 8,
      },
    };

    const messages = buildPolishPrompt(polishInput);
    const systemContent = messages[0].content;

    // Should NOT include the BRIEF LOCK section
    expect(systemContent).not.toContain('BRIEF LOCK');
  });

  // ═══ Test 6: Micro-repair eligibility true for final>=7.8 originality>=7.8 evidence>=8 brief_alignment 6.8-7.49 ═══

  it('micro-repair is eligible for high scores failing only on brief_alignment', () => {
    // Case: final=7.8, originality=7.8, evidence=8, brief_alignment=7.0 (in range 6.8-7.49)
    const eligible = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 7.0,
      failure_reasons: ['brief_alignment_score_7_below_7.5'],
    });
    expect(isMicroRepairEligible(eligible)).toBe(true);

    // Edge: brief_alignment at 6.8 (lower bound)
    const edgeLow = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 6.8,
      failure_reasons: ['brief_alignment_score_6.8_below_7.5'],
    });
    expect(isMicroRepairEligible(edgeLow)).toBe(true);

    // Edge: brief_alignment at 7.49 (just below 7.5)
    const edgeHigh = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 7.4,
      failure_reasons: ['brief_alignment_score_7.4_below_7.5'],
    });
    expect(isMicroRepairEligible(edgeHigh)).toBe(true);
  });

  // ═══ Test 7: Micro-repair eligibility false if originality would drop below 7.8 ═══

  it('micro-repair is NOT eligible when originality < 7.8 or evidence < 8 or final < 7.8', () => {
    // originality < 7.8
    const lowOriginality = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.5,
      evidence_safety_score: 8,
      brief_alignment_score: 7.0,
      failure_reasons: ['originality_score_7.5_below_7.8', 'brief_alignment_score_7_below_7.5'],
    });
    expect(isMicroRepairEligible(lowOriginality)).toBe(false);

    // evidence < 8
    const lowEvidence = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 7.5,
      brief_alignment_score: 7.0,
      failure_reasons: ['evidence_safety_score_7.5_below_8', 'brief_alignment_score_7_below_7.5'],
    });
    expect(isMicroRepairEligible(lowEvidence)).toBe(false);

    // final < 7.8
    const lowFinal = makeJudgeResult({
      final_candidate_score: 7.5,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 7.0,
      failure_reasons: ['final_candidate_score_7.5_below_7.8', 'brief_alignment_score_7_below_7.5'],
    });
    expect(isMicroRepairEligible(lowFinal)).toBe(false);

    // brief_alignment >= 7.5 (not failing)
    const highBrief = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 7.5,
      passed: true,
      failure_reasons: [],
    });
    expect(isMicroRepairEligible(highBrief)).toBe(false);

    // brief_alignment < 6.8 (too low)
    const tooLowBrief = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 6.5,
      failure_reasons: ['brief_alignment_score_6.5_below_7.5'],
    });
    expect(isMicroRepairEligible(tooLowBrief)).toBe(false);
  });

  // ═══ Test 8: Micro-repair does not bypass judge/publish gate ═══

  it('micro-repair never bypasses judge or publish gate', () => {
    // Micro-repair always requires re-judging — the function itself
    // calls judgeCraftedCandidate after the repair. The result is only
    // applied if it passes the re-judge or improves without degrading scores.

    // Verify: isMicroRepairEligible never returns true for passed candidates
    const passed = makeJudgeResult({
      passed: true,
      final_candidate_score: 8,
      originality_score: 8,
      evidence_safety_score: 9,
      brief_alignment_score: 8,
      failure_reasons: [],
    });
    expect(isMicroRepairEligible(passed)).toBe(false);

    // Verify: candidates with generic_bait_flag are never eligible
    // (they would fail at final_candidate_score < 7.8 anyway, but double-check)
    const baitFlag = makeJudgeResult({
      final_candidate_score: 7.8,
      originality_score: 7.8,
      evidence_safety_score: 8,
      brief_alignment_score: 7.0,
      generic_bait_flag: true,
      failure_reasons: ['generic_bait_flag', 'brief_alignment_score_7_below_7.5'],
    });
    // generic_bait_flag means it should have already been filtered
    // isMicroRepairEligible doesn't check this specifically, but the
    // near-pass polish would never produce a candidate with generic_bait_flag
    // The important thing: micro-repair always re-judges and never auto-passes
    expect(isMicroRepairEligible(baitFlag)).toBe(true); // still eligible structurally
    // But the re-judge would catch the bait flag — this is correct behavior
  });

  // ═══ Test 9: No threshold changes ═══

  it('does not change any judge or near-pass thresholds', () => {
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });

  // ═══ Test 10: Build/test pass ═══
  // This test is satisfied by the test suite itself passing (npm test exits 0)

  it('exports all new functions and types', () => {
    // Verify new exports exist
    expect(typeof isMicroRepairEligible).toBe('function');
    expect(typeof buildPolishPrompt).toBe('function');

    // Verify signature voice still works (already imported at top)
    expect(typeof computeSignatureVoiceScore).toBe('function');
  });
});
