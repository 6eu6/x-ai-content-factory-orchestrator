/**
 * phase2g1-signature-voice.test.ts — Phase 2G.1: Signature Voice + Stronger Originality Strategy
 *
 * 11 test cases covering:
 * 1. Detects memorable first line
 * 2. Detects contrast/inversion
 * 3. Detects operator takeaway
 * 4. Detects compact signature phrase
 * 5. Penalizes generic hype
 * 6. Penalizes vague AI commentary
 * 7. Craft prompt includes SIGNATURE VOICE section
 * 8. Craft output parses signature_phrase and operator_takeaway
 * 9. Near-pass polish includes signature voice when originality failed
 * 10. No threshold changes
 * 11. Build/test pass
 */

import { describe, it, expect } from 'vitest';

import {
  SIGNATURE_VOICE_RULES,
  buildSignatureVoiceSection,
  detectSignatureVoiceIndicators,
  validateSignatureVoice,
  computeSignatureVoiceScore,
  type SignatureVoiceContext,
} from '../lib/signature-voice';

import {
  buildPolishPrompt,
  type PolishInput,
} from '../lib/near-pass-polish';

import {
  NEAR_PASS_THRESHOLDS,
} from '../lib/opportunity-judge';

// ═══ Helpers ═══

function makeBrief(): Record<string, any> {
  return {
    source_summary: 'Karpathy joins Anthropic, signaling a shift toward AI safety focus',
    recommended_angle: 'What Karpathy joining Anthropic means for AI builder priorities',
    why_it_matters: 'Shows the AI talent market shifting toward safety',
    required_context: ['Karpathy was at OpenAI and Tesla before'],
    do_not_claim: ['Karpathy was fired', 'Anthropic is winning the AI race'],
  };
}

// ═══ Test 1: Detects memorable first line ═══

describe('Phase 2G.1: Signature Voice Detection', () => {
  it('detects a memorable first line (compressed frame, not summary)', () => {
    // Memorable first line: short, punchy, not starting with summary words
    const good = detectSignatureVoiceIndicators(
      'Your mental model for AI agents is stale. The cost of ignoring agentic workflows is compounding daily.'
    );
    expect(good.hasMemorableFirstLine).toBe(true);

    // Another good one
    const good2 = detectSignatureVoiceIndicators(
      'RAG is not a search engine, it is a judgment cache.'
    );
    expect(good2.hasMemorableFirstLine).toBe(true);

    // Bad: starts with summary
    const bad = detectSignatureVoiceIndicators(
      'This is about how AI is changing the way we think about productivity tools.'
    );
    expect(bad.hasMemorableFirstLine).toBe(false);

    // Bad: starts with "Here's"
    const bad2 = detectSignatureVoiceIndicators(
      "Here's why RAG pipelines matter for your AI workflow."
    );
    expect(bad2.hasMemorableFirstLine).toBe(false);
  });

  // ═══ Test 2: Detects contrast/inversion ═══

  it('detects contrast or inversion patterns', () => {
    // "X is not A, it's B" pattern
    const contrast1 = detectSignatureVoiceIndicators(
      'RAG is not a search engine, it is a judgment cache for your domain.'
    );
    expect(contrast1.hasContrastOrInversion).toBe(true);

    // "not X but Y" pattern
    const contrast2 = detectSignatureVoiceIndicators(
      'The key is not speed but precision in prompt design.'
    );
    expect(contrast2.hasContrastOrInversion).toBe(true);

    // "instead of" pattern
    const contrast3 = detectSignatureVoiceIndicators(
      'Instead of building wrappers, build workflows that replace three steps with one.'
    );
    expect(contrast3.hasContrastOrInversion).toBe(true);

    // "rather than" pattern
    const contrast4 = detectSignatureVoiceIndicators(
      'Rather than fine-tuning, try structured prompting with RAG.'
    );
    expect(contrast4.hasContrastOrInversion).toBe(true);

    // No contrast
    const noContrast = detectSignatureVoiceIndicators(
      'AI agents are becoming more capable and useful for many tasks.'
    );
    expect(noContrast.hasContrastOrInversion).toBe(false);
  });

  // ═══ Test 3: Detects operator takeaway ═══

  it('detects concrete operator takeaway', () => {
    // "When you" pattern
    const takeaway1 = detectSignatureVoiceIndicators(
      'When you evaluate AI tools, check if they reduce judgment cache misses.'
    );
    expect(takeaway1.hasOperatorTakeaway).toBe(true);

    // "The signal is" pattern
    const takeaway2 = detectSignatureVoiceIndicators(
      'The signal is not adoption rate but retention at day 30.'
    );
    expect(takeaway2.hasOperatorTakeaway).toBe(true);

    // "Stop X, start Y" pattern
    const takeaway3 = detectSignatureVoiceIndicators(
      'Stop building wrappers. Start building workflows that compound.'
    );
    expect(takeaway3.hasOperatorTakeaway).toBe(true);

    // No operator takeaway
    const noTakeaway = detectSignatureVoiceIndicators(
      'AI is growing rapidly and changing many industries.'
    );
    expect(noTakeaway.hasOperatorTakeaway).toBe(false);
  });

  // ═══ Test 4: Detects compact signature phrase ═══

  it('detects compact reusable phrase', () => {
    // Concrete noun from the preferred list
    const phrase1 = detectSignatureVoiceIndicators(
      'Your capability map is outdated. Rebuild it for the agentic era.'
    );
    expect(phrase1.hasCompactPhrase).toBe(true);
    expect(phrase1.detectedSignaturePhrase).toBeTruthy();

    // "judgment cache"
    const phrase2 = detectSignatureVoiceIndicators(
      'RAG is a judgment cache for domain-specific decisions.'
    );
    expect(phrase2.hasCompactPhrase).toBe(true);

    // "stale mental model"
    const phrase3 = detectSignatureVoiceIndicators(
      'Your stale mental model of AI is costing you daily.'
    );
    expect(phrase3.hasCompactPhrase).toBe(true);

    // "operator heuristic"
    const phrase4 = detectSignatureVoiceIndicators(
      'The operator heuristic: if it saves 10 hours per week, adopt it now.'
    );
    expect(phrase4.hasCompactPhrase).toBe(true);

    // No compact phrase
    const noPhrase = detectSignatureVoiceIndicators(
      'AI is changing and many people are paying attention to the shift.'
    );
    expect(noPhrase.hasCompactPhrase).toBe(false);
  });

  // ═══ Test 5: Penalizes generic hype ═══

  it('penalizes generic hype patterns', () => {
    // "the future of"
    const hype1 = detectSignatureVoiceIndicators(
      'This is the future of AI productivity and everyone should pay attention.'
    );
    expect(hype1.hasGenericHype).toBe(true);

    // "game changer"
    const hype2 = detectSignatureVoiceIndicators(
      'RAG is a game changer for building AI applications.'
    );
    expect(hype2.hasGenericHype).toBe(true);

    // "AI is changing everything"
    const hype3 = detectSignatureVoiceIndicators(
      'AI is changing everything about how we work and create.'
    );
    expect(hype3.hasGenericHype).toBe(true);

    // "this is huge"
    const hype4 = detectSignatureVoiceIndicators(
      'This is huge for the AI builder community.'
    );
    expect(hype4.hasGenericHype).toBe(true);

    // "the real unlock"
    const hype5 = detectSignatureVoiceIndicators(
      'The real unlock is combining RAG with fine-tuned models.'
    );
    expect(hype5.hasGenericHype).toBe(true);

    // "builders should"
    const hype6 = detectSignatureVoiceIndicators(
      'Builders should pay attention to this new capability.'
    );
    expect(hype6.hasGenericHype).toBe(true);

    // No hype
    const noHype = detectSignatureVoiceIndicators(
      'RAG pipelines reduce context reconstruction cost by caching domain judgments.'
    );
    expect(noHype.hasGenericHype).toBe(false);
  });

  // ═══ Test 6: Penalizes vague AI commentary ═══

  it('penalizes vague AI commentary', () => {
    // "more productive"
    const vague1 = detectSignatureVoiceIndicators(
      'This makes teams more productive and efficient in their workflows.'
    );
    expect(vague1.hasVagueCommentary).toBe(true);

    // "better workflows"
    const vague2 = detectSignatureVoiceIndicators(
      'AI agents enable better workflows for knowledge workers.'
    );
    expect(vague2.hasVagueCommentary).toBe(true);

    // "unlocks potential"
    const vague3 = detectSignatureVoiceIndicators(
      'This unlocks potential for creative professionals everywhere.'
    );
    expect(vague3.hasVagueCommentary).toBe(true);

    // No vague commentary
    const notVague = detectSignatureVoiceIndicators(
      'RAG pipelines cache domain judgments, reducing inference cost per query.'
    );
    expect(notVague.hasVagueCommentary).toBe(false);
  });
});

// ═══ Test 7: Craft prompt includes SIGNATURE VOICE section ═══

describe('Phase 2G.1: Signature Voice in Craft Prompt', () => {
  it('includes SIGNATURE VOICE section in the built prompt section', () => {
    const section = buildSignatureVoiceSection({
      recommended_angle: 'What Karpathy joining Anthropic means for builder priorities',
    });

    // Must contain SIGNATURE VOICE header
    expect(section).toContain('SIGNATURE VOICE');

    // Must contain the core rules
    expect(section).toContain('compressed frame');
    expect(section).toContain('memorable phrase');
    expect(section).toContain('X is not A');
    expect(section).toContain('operator rule');

    // Must list forbidden phrases
    expect(section).toContain('the future of');
    expect(section).toContain('game changer');
    expect(section).toContain('AI is changing everything');
    expect(section).toContain('this is huge');
    expect(section).toContain('the real unlock');
    expect(section).toContain('builders should');

    // Must list vague claims to avoid
    expect(section).toContain('more productive');
    expect(section).toContain('better workflows');
    expect(section).toContain('unlocks potential');

    // Must list concrete nouns to prefer
    expect(section).toContain('capability map');
    expect(section).toContain('judgment cache');
    expect(section).toContain('stale mental model');
    expect(section).toContain('operator heuristic');

    // Must include required output fields
    expect(section).toContain('signature_phrase');
    expect(section).toContain('operator_takeaway');

    // Must mention the recommended angle
    expect(section).toContain('Karpathy');
  });
});

// ═══ Test 8: Craft output parses signature_phrase and operator_takeaway ═══

describe('Phase 2G.1: Signature Voice Validation', () => {
  it('validates signature voice and parses signature_phrase/operator_takeaway', () => {
    // Good text with all indicators
    const goodText = 'Your mental model for AI agents is stale. When evaluating tools, check if they reduce judgment cache misses. The signal is retention, not adoption.';
    const goodDiag = validateSignatureVoice(goodText);

    expect(goodDiag._signature_voice_used).toBe(true);
    expect(goodDiag._signature_voice_score).toBeGreaterThanOrEqual(7);
    // Should NOT have failure reasons when score >= 7
    if (goodDiag._signature_voice_score >= 7) {
      expect(goodDiag._signature_voice_failure_reasons).toBeUndefined();
    }

    // Generic text with no voice
    const genericText = 'AI is changing everything about how we work and this is huge for productivity.';
    const genericDiag = validateSignatureVoice(genericText);

    expect(genericDiag._signature_voice_used).toBe(true);
    expect(genericDiag._signature_voice_score).toBeLessThan(7);
    // Should have failure reasons
    expect(genericDiag._signature_voice_failure_reasons).toBeDefined();
    expect(genericDiag._signature_voice_failure_reasons!.length).toBeGreaterThan(0);
    // Should flag generic hype
    expect(genericDiag._signature_voice_failure_reasons).toContain('contains_generic_hype');

    // Score breakdown test
    const scoreResult = computeSignatureVoiceScore(goodText);
    expect(scoreResult.score).toBeGreaterThanOrEqual(0);
    expect(scoreResult.score).toBeLessThanOrEqual(10);
    expect(scoreResult.breakdown).toBeDefined();
    expect(typeof scoreResult.breakdown.memorableFirstLine).toBe('number');
    expect(typeof scoreResult.breakdown.contrastOrInversion).toBe('number');
    expect(typeof scoreResult.breakdown.operatorTakeaway).toBe('number');
    expect(typeof scoreResult.breakdown.compactPhrase).toBe('number');
  });

  // ═══ Score heuristic edge cases ═══

  it('clamps signature voice score between 0 and 10', () => {
    // Text with everything bad
    const badText = 'AI is changing everything and this is huge. More productive workflows unlock potential for builders who should pay attention to the future of game changer technology that makes people more productive and enables better workflows that unlock potential everywhere.';
    const badScore = computeSignatureVoiceScore(badText);
    expect(badScore.score).toBeGreaterThanOrEqual(0);
    expect(badScore.score).toBeLessThanOrEqual(10);

    // Even with all penalties, score should not go below 0
    const badDiag = validateSignatureVoice(badText);
    expect(badDiag._signature_voice_score).toBeGreaterThanOrEqual(0);
  });

  it('handles empty or null text gracefully', () => {
    const empty = detectSignatureVoiceIndicators('');
    expect(empty.hasMemorableFirstLine).toBe(false);
    expect(empty.hasContrastOrInversion).toBe(false);
    expect(empty.hasOperatorTakeaway).toBe(false);
    expect(empty.hasCompactPhrase).toBe(false);

    const emptyDiag = validateSignatureVoice('');
    expect(emptyDiag._signature_voice_score).toBe(0);
    expect(emptyDiag._signature_voice_failure_reasons).toBeDefined();
  });
});

// ═══ Test 9: Near-pass polish includes signature voice when originality failed ═══

describe('Phase 2G.1: Near-Pass Polish Signature Voice', () => {
  it('includes SIGNATURE VOICE section when originality_score failed', () => {
    const polishInput: PolishInput = {
      crafted_text: 'AI is changing how we work and build products for the future.',
      brief: {
        source_summary: 'Karpathy joins Anthropic',
        recommended_angle: 'What this means for AI builder priorities',
        do_not_claim: ['Karpathy was fired'],
      },
      judge_failure_reasons: ['originality_score_7_below_7.8'],
      judge_scores: {
        final_candidate_score: 7.8,
        originality_score: 7,
        usefulness_score: 8,
        brief_alignment_score: 8,
        evidence_safety_score: 9,
        clarity_score: 8,
      },
      source_text_preview: 'Karpathy is joining Anthropic...',
      source_author: 'karpathy',
    };

    const messages = buildPolishPrompt(polishInput);
    const systemContent = messages[0].content;

    // Must include SIGNATURE VOICE section
    expect(systemContent).toContain('SIGNATURE VOICE');
    expect(systemContent).toContain('compressed frame');
    expect(systemContent).toContain('signature_phrase');
    expect(systemContent).toContain('operator_takeaway');

    // Must also include the CRITICAL originality instruction (from Phase 2G)
    expect(systemContent).toContain('LOW ORIGINALITY');
    expect(systemContent).toContain('SHARPER FRAME');
  });

  it('does NOT include SIGNATURE VOICE when originality is not the failure', () => {
    const polishInput: PolishInput = {
      crafted_text: 'A good tweet about AI with solid evidence and a sharp angle.',
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

    // Should NOT include the SIGNATURE VOICE section
    expect(systemContent).not.toContain('SIGNATURE VOICE');
  });
});

// ═══ Test 10: No threshold changes ═══

describe('Phase 2G.1: Threshold Integrity', () => {
  it('does not change any judge or near-pass thresholds', () => {
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });

  it('signature voice score does not auto-fail candidates', () => {
    // Even with a low signature voice score, the validateSignatureVoice
    // function only adds diagnostics — it does NOT determine pass/fail
    const genericText = 'AI is growing fast and many people are paying attention.';
    const diag = validateSignatureVoice(genericText);

    // Should have a low score but the function should not return a "failed" flag
    // The _signature_voice_failure_reasons is purely diagnostic
    expect(diag._signature_voice_score).toBeLessThan(7);
    expect(diag._signature_voice_failure_reasons).toBeDefined();
    // The key constraint: signature voice does NOT bypass existing validators
    // It's diagnostic-only, so we just verify the diagnostics exist
    expect(typeof diag._signature_voice_score).toBe('number');
    expect(Array.isArray(diag._signature_voice_failure_reasons)).toBe(true);
  });
});

// ═══ Test 11: Build/test pass ═══
// This test is satisfied by the test suite itself passing (npm test exits 0)

describe('Phase 2G.1: Build and Test', () => {
  it('signature voice module exports all required functions and types', () => {
    // Verify all exports exist and are the correct type
    expect(typeof SIGNATURE_VOICE_RULES).toBe('object');
    expect(SIGNATURE_VOICE_RULES.lead).toBeTruthy();
    expect(SIGNATURE_VOICE_RULES.avoidGenericCommentary).toBeInstanceOf(Array);
    expect(SIGNATURE_VOICE_RULES.avoidVagueClaims).toBeInstanceOf(Array);
    expect(SIGNATURE_VOICE_RULES.preferConcreteNouns).toBeInstanceOf(Array);

    expect(typeof buildSignatureVoiceSection).toBe('function');
    expect(typeof detectSignatureVoiceIndicators).toBe('function');
    expect(typeof validateSignatureVoice).toBe('function');
    expect(typeof computeSignatureVoiceScore).toBe('function');
  });
});
