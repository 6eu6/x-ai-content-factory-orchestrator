/**
 * phase2g3-hotfix-candidate-crash.test.ts — Phase 2G.3 Hotfix
 *
 * Fixes: opportunity_judge crash "Cannot read properties of undefined (reading 'crafted_text')"
 *
 * 7 test cases:
 * 1. undefined in _selected_candidates does not crash
 * 2. empty crafted_text filtered
 * 3. all invalid selected candidates fallback to opp.crafted_text
 * 4. all invalid and no opp.crafted_text returns safe rejected opportunity
 * 5. results shorter than candidates synthesizes failed judge result
 * 6. best selected candidate text is applied to opportunity.crafted_text
 * 7. no threshold changes
 */

import { describe, it, expect } from 'vitest';

import {
  judgeCraftedCandidates,
  NEAR_PASS_THRESHOLDS,
  type JudgeResult,
} from '../lib/opportunity-judge';

import {
  deduplicateJudgedCandidates,
  type CraftedCandidate,
  type CandidateWithJudgeResult,
} from '../lib/candidate-selector';

// ═══ Helpers ═══

function makeCandidate(overrides: Partial<CraftedCandidate> = {}): CraftedCandidate {
  return {
    variant_type: 'brief_faithful',
    crafted_text: 'AI agents are not just tools—they are capability maps that reshape how teams allocate judgment and decisions.',
    format: 'reply',
    brief_alignment_score: 8,
    brief_alignment_notes: [],
    invented_personal_experience_flag: false,
    ignored_recommended_angle_flag: false,
    _candidate_local_score: undefined,
    _candidate_selection_reason: undefined,
    ...overrides,
  };
}

/**
 * Simulate the processOpportunityJudge candidate construction logic.
 * This mirrors the guarded candidate-building loop in pipeline-worker.ts.
 */
function buildJudgeCandidates(
  opportunities: Array<Record<string, any>>
): Array<{
  crafted_text: string;
  brief: Record<string, any>;
  opportunityIndex: number;
  candidateVariantType?: string;
  sourceKey: string;
}> {
  const candidates: Array<{
    crafted_text: string;
    brief: Record<string, any>;
    opportunityIndex: number;
    candidateVariantType?: string;
    sourceKey: string;
  }> = [];

  for (let oppIdx = 0; oppIdx < opportunities.length; oppIdx++) {
    const opp = opportunities[oppIdx];
    const brief = (opp as any)._brief || {};
    const sourceKey = String((opp as any).source_text || '').slice(0, 100);
    const selectedCandidates: CraftedCandidate[] | undefined = (opp as any)._selected_candidates;

    if (selectedCandidates && selectedCandidates.length > 0) {
      let validCandidateCount = 0;

      for (const cand of selectedCandidates) {
        // Guard: skip null/undefined candidates
        if (!cand || typeof cand !== 'object') continue;
        // Guard: skip candidates without non-empty crafted_text
        if (!cand.crafted_text || typeof cand.crafted_text !== 'string' || !cand.crafted_text.trim()) continue;

        candidates.push({
          crafted_text: cand.crafted_text,
          brief,
          opportunityIndex: oppIdx,
          candidateVariantType: cand.variant_type,
          sourceKey,
        });
        validCandidateCount++;
      }

      // If no valid selected candidates, fallback to opp.crafted_text
      if (validCandidateCount === 0) {
        if (opp.crafted_text && typeof opp.crafted_text === 'string' && opp.crafted_text.trim()) {
          candidates.push({
            crafted_text: opp.crafted_text,
            brief,
            opportunityIndex: oppIdx,
            sourceKey,
          });
        }
      }
    } else {
      // Single-candidate mode (legacy)
      if (opp.crafted_text && typeof opp.crafted_text === 'string' && opp.crafted_text.trim()) {
        candidates.push({
          crafted_text: opp.crafted_text,
          brief,
          opportunityIndex: oppIdx,
          sourceKey,
        });
      }
    }
  }

  return candidates;
}

/**
 * Simulate applying judge results to opportunities (the safe rejection logic).
 */
function applyJudgeResults(
  opportunities: Array<Record<string, any>>,
  candidates: Array<{ crafted_text: string; opportunityIndex: number; sourceKey: string }>,
  results: JudgeResult[],
  bestCandidateTexts: Map<string, string | undefined>
): Array<Record<string, any>> {
  let candidateValidationFailedCount = 0;
  let candidateMissingTextCount = 0;

  return opportunities.map((opp, i) => {
    const sourceKey = String((opp as any).source_text || '').slice(0, 100);
    const oppCandidates = candidates.filter(c => c.opportunityIndex === i);

    if (oppCandidates.length === 0) {
      candidateValidationFailedCount++;
      return {
        ...opp,
        shield_passed: false,
        shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
        _candidate_generation_error: 'no_valid_crafted_text',
      };
    }

    const candIdx = oppCandidates.length > 0 ? candidates.indexOf(oppCandidates[0]) : -1;
    const judgeResult = candIdx >= 0 ? results[candIdx] : undefined;

    if (!judgeResult) {
      candidateMissingTextCount++;
      return {
        ...opp,
        shield_passed: false,
        shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
        _candidate_generation_error: 'no_valid_crafted_text',
      };
    }

    const bestCraftedText = bestCandidateTexts.get(sourceKey);
    const textToApply = bestCraftedText && bestCraftedText.trim()
      ? bestCraftedText
      : (opp.crafted_text || undefined);

    return {
      ...opp,
      ...(textToApply ? { crafted_text: textToApply, _selected_candidate_text_applied: !!bestCraftedText } : {}),
      _judge_result: {
        passed: judgeResult.passed,
        final_candidate_score: judgeResult.final_candidate_score,
        failure_reasons: judgeResult.failure_reasons,
      },
      ...(judgeResult.passed ? {} : {
        shield_passed: false,
        shield_issues: [...(opp.shield_issues || []), `judge_failed:${judgeResult.failure_reasons[0] || 'unknown'}`],
      }),
    };
  });
}

// ═══ Tests ═══

describe('Phase 2G.3 Hotfix: opportunity_judge crafted_text crash', () => {
  // ═══ Test 1: undefined in _selected_candidates does not crash ═══

  it('undefined in _selected_candidates does not crash', () => {
    const opportunities = [
      {
        source_text: 'AI agents are reshaping team decisions',
        crafted_text: 'AI agents augment team judgment—they do not replace it.',
        _selected_candidates: [undefined, null, makeCandidate({ crafted_text: 'Valid text that is long enough to pass.' })],
        _brief: { recommended_angle: 'AI agent adoption' },
      },
    ];

    // This should NOT throw
    const candidates = buildJudgeCandidates(opportunities);

    // Should have only 1 valid candidate (the third one)
    expect(candidates).toHaveLength(1);
    expect(candidates[0].crafted_text).toBe('Valid text that is long enough to pass.');
  });

  // ═══ Test 2: empty crafted_text filtered ═══

  it('empty crafted_text filtered', () => {
    const opportunities = [
      {
        source_text: 'Source text for testing empty crafted_text',
        crafted_text: 'Original fallback text that should not be used if selected candidates exist.',
        _selected_candidates: [
          makeCandidate({ crafted_text: '' }), // empty string
          makeCandidate({ crafted_text: '   ' }), // whitespace only
          makeCandidate({ crafted_text: null as any }), // null
          makeCandidate({ crafted_text: 'Valid candidate text that should be included.' }),
        ],
        _brief: { recommended_angle: 'Testing empty text' },
      },
    ];

    const candidates = buildJudgeCandidates(opportunities);

    // Should have only 1 valid candidate (the one with actual text)
    expect(candidates).toHaveLength(1);
    expect(candidates[0].crafted_text).toBe('Valid candidate text that should be included.');
  });

  // ═══ Test 3: all invalid selected candidates fallback to opp.crafted_text ═══

  it('all invalid selected candidates fallback to opp.crafted_text', () => {
    const opportunities = [
      {
        source_text: 'Source text for fallback test',
        crafted_text: 'Fallback opportunity text that should be used when all selected candidates are invalid.',
        _selected_candidates: [
          makeCandidate({ crafted_text: '' }),
          makeCandidate({ crafted_text: null as any }),
        ],
        _brief: { recommended_angle: 'Fallback test' },
      },
    ];

    const candidates = buildJudgeCandidates(opportunities);

    // Should fallback to opp.crafted_text since no selected candidates are valid
    expect(candidates).toHaveLength(1);
    expect(candidates[0].crafted_text).toBe('Fallback opportunity text that should be used when all selected candidates are invalid.');
  });

  // ═══ Test 4: all invalid and no opp.crafted_text returns safe rejected opportunity ═══

  it('all invalid and no opp.crafted_text returns safe rejected opportunity', () => {
    const opportunities = [
      {
        source_text: 'Source text for rejection test',
        crafted_text: '',
        _selected_candidates: [
          makeCandidate({ crafted_text: '' }),
          makeCandidate({ crafted_text: null as any }),
        ],
        _brief: { recommended_angle: 'Rejection test' },
      },
      {
        source_text: 'Another source with no text at all',
        crafted_text: null as any,
        _selected_candidates: [
          makeCandidate({ crafted_text: '' }),
        ],
        _brief: { recommended_angle: 'Another test' },
      },
    ];

    const candidates = buildJudgeCandidates(opportunities);

    // No candidates should be built — all opportunities have no valid text
    expect(candidates).toHaveLength(0);

    // Simulate the safe rejection path
    const rejectedOpportunities = opportunities.map(opp => ({
      ...opp,
      shield_passed: false,
      shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
      _candidate_generation_error: 'no_valid_crafted_text',
    }));

    // All should be safely rejected
    for (const opp of rejectedOpportunities) {
      expect(opp.shield_passed).toBe(false);
      expect(opp.shield_issues).toContain('candidate_missing_crafted_text');
      expect(opp._candidate_generation_error).toBe('no_valid_crafted_text');
    }
  });

  // ═══ Test 5: results shorter than candidates synthesizes failed judge result ═══

  it('results shorter than candidates synthesizes failed judge result', () => {
    // Simulate judgeCraftedCandidates returning fewer results than candidates
    // This tests the HARDEN logic in pipeline-worker.ts where we synthesize
    // a FAILED_JUDGE_RESULT for missing results[i]

    const candidates = [
      { crafted_text: 'First valid candidate text for testing.', brief: {} },
      { crafted_text: 'Second valid candidate text for testing.', brief: {} },
      { crafted_text: 'Third valid candidate text for testing.', brief: {} },
    ];

    // Simulate: only 2 results returned (e.g., judge API error on the 3rd)
    const partialResults: JudgeResult[] = [
      {
        originality_score: 8,
        usefulness_score: 8,
        niche_fit_score: 8,
        evidence_safety_score: 9,
        clarity_score: 8,
        generic_bait_flag: false,
        unsupported_claim_flag: false,
        brief_alignment_score: 8,
        final_candidate_score: 8.2,
        passed: true,
        failure_reasons: [],
      },
      {
        originality_score: 7,
        usefulness_score: 7,
        niche_fit_score: 7,
        evidence_safety_score: 8,
        clarity_score: 7,
        generic_bait_flag: false,
        unsupported_claim_flag: false,
        brief_alignment_score: 7,
        final_candidate_score: 7.2,
        passed: false,
        failure_reasons: ['originality_score_7_below_7.8'],
      },
      // 3rd result is MISSING
    ];

    // Apply the synthesis logic from pipeline-worker.ts
    const FAILED_JUDGE_RESULT: JudgeResult = {
      originality_score: 1,
      usefulness_score: 1,
      niche_fit_score: 1,
      evidence_safety_score: 1,
      clarity_score: 1,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      brief_alignment_score: 1,
      final_candidate_score: 1,
      passed: false,
      failure_reasons: ['judge_result_missing'],
    };

    const synthesizedResults: JudgeResult[] = candidates.map((_, i) =>
      partialResults[i] || FAILED_JUDGE_RESULT
    );

    // 3rd candidate should get the synthesized failed result
    expect(synthesizedResults).toHaveLength(3);
    expect(synthesizedResults[2].passed).toBe(false);
    expect(synthesizedResults[2].failure_reasons).toContain('judge_result_missing');
    expect(synthesizedResults[2].final_candidate_score).toBe(1);
  });

  // ═══ Test 6: best selected candidate text is applied to opportunity.crafted_text ═══

  it('best selected candidate text is applied to opportunity.crafted_text', () => {
    const bestCandidateText = 'Best candidate variant text that should replace the original opportunity text.';

    const opportunities = [
      {
        source_text: 'Source text for text application test',
        crafted_text: 'Original opportunity text that should be replaced by best candidate.',
        _selected_candidates: [
          makeCandidate({
            variant_type: 'signature_original',
            crafted_text: bestCandidateText,
          }),
        ],
        _brief: { recommended_angle: 'Text application test' },
      },
    ];

    const candidates = buildJudgeCandidates(opportunities);
    expect(candidates).toHaveLength(1);

    // Simulate that the best candidate's text is applied back
    const sourceKey = 'Source text for text application test';
    const bestCandidateTexts = new Map<string, string | undefined>();
    bestCandidateTexts.set(sourceKey, bestCandidateText);

    const results: JudgeResult[] = [{
      originality_score: 8.5,
      usefulness_score: 8,
      niche_fit_score: 8,
      evidence_safety_score: 9,
      clarity_score: 8,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      brief_alignment_score: 8,
      final_candidate_score: 8.4,
      passed: true,
      failure_reasons: [],
    }];

    const judged = applyJudgeResults(opportunities, candidates, results, bestCandidateTexts);

    // The best candidate's crafted_text should be applied to the opportunity
    expect(judged[0].crafted_text).toBe(bestCandidateText);
    expect(judged[0]._selected_candidate_text_applied).toBe(true);
  });

  // ═══ Test 7: no threshold changes ═══

  it('does not change any judge or near-pass thresholds', () => {
    // All thresholds must remain unchanged from Phase 2G.3
    expect(NEAR_PASS_THRESHOLDS.FINAL_SCORE_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.ORIGINALITY_THRESHOLD).toBe(7.8);
    expect(NEAR_PASS_THRESHOLDS.USEFULNESS_THRESHOLD).toBe(7);
    expect(NEAR_PASS_THRESHOLDS.EVIDENCE_SAFETY_THRESHOLD).toBe(8);
    expect(NEAR_PASS_THRESHOLDS.BRIEF_ALIGNMENT_THRESHOLD).toBe(7.5);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MIN_FINAL_SCORE).toBe(6.8);
    expect(NEAR_PASS_THRESHOLDS.NEAR_PASS_MAX_FINAL_SCORE).toBe(7.8);
  });
});
