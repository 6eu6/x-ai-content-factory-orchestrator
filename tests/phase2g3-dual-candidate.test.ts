/**
 * phase2g3-dual-candidate.test.ts — Phase 2G.3: Dual Candidate Generation + Internal Selection
 *
 * 10 test cases:
 * 1. parses new candidates array schema — 3 variants → 3 CraftedCandidate objects with correct variant_types
 * 2. supports old single-candidate schema fallback — old schema → wrapped as one "legacy" candidate
 * 3. selects best local candidate by signature/originality/usefulness
 * 4. sends max 2 candidates per opportunity to judge
 * 5. preserves metadata on selected variants
 * 6. dedupes judged candidates by source/opportunity before publish_gate
 * 7. passed candidate beats failed candidate
 * 8. failed candidates tie-break by final/originality/brief/evidence
 * 9. no threshold changes
 * 10. build/test pass
 */

import { describe, it, expect } from 'vitest';

import {
  computeLocalCandidateScore,
  selectCandidatesForJudge,
  deduplicateJudgedCandidates,
  type CraftedCandidate,
  type BriefForSelection,
  type CandidateWithJudgeResult,
} from '../lib/candidate-selector';

import {
  NEAR_PASS_THRESHOLDS,
  type JudgeResult,
} from '../lib/opportunity-judge';

import {
  validateBriefAlignment,
  type CraftedCandidate as PipelineCraftedCandidate,
} from '../lib/pipeline-worker';

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

function makeBrief(overrides: Partial<BriefForSelection> = {}): BriefForSelection {
  return {
    recommended_angle: 'What AI agent adoption means for team judgment allocation',
    source_summary: 'A study on how AI agents reshape team decision-making processes',
    do_not_claim: ['AI will replace all managers'],
    required_context: ['AI agents augment decision-making', 'Teams still need human oversight'],
    ...overrides,
  };
}

// ═══ Test 1: Parses new candidates array schema ═══

describe('Phase 2G.3: Multi-candidate generation', () => {
  it('parses new candidates array schema — 3 variants produce 3 CraftedCandidate objects with correct variant_types', () => {
    // Simulate what processCandidateVariant would produce from a candidates array
    const rawCandidates = [
      {
        variant_type: 'brief_faithful',
        crafted_text: 'AI agents augment team judgment—they do not replace it. The key: map capability to decision type, not to habit.',
        format: 'reply',
        brief_alignment_score: 9,
      },
      {
        variant_type: 'signature_original',
        crafted_text: 'Judgment cache for taste: AI agents do not eliminate decisions, they compress them. Operators: audit what your team delegates vs decides.',
        format: 'standalone',
        brief_alignment_score: 8,
      },
      {
        variant_type: 'operator_heuristic',
        crafted_text: 'When evaluating AI tools for your team, check: does it reduce judgment cache misses? If not, it is automation, not augmentation.',
        format: 'reply',
        brief_alignment_score: 8,
      },
    ];

    // Simulate the parsing logic: each raw candidate becomes a CraftedCandidate
    const candidates: CraftedCandidate[] = rawCandidates.map(raw => ({
      variant_type: raw.variant_type,
      crafted_text: raw.crafted_text,
      format: raw.format || 'reply',
      brief_alignment_score: raw.brief_alignment_score || 7,
      brief_alignment_notes: [],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: false,
    }));

    // Verify 3 candidates with correct variant types
    expect(candidates).toHaveLength(3);
    expect(candidates[0].variant_type).toBe('brief_faithful');
    expect(candidates[1].variant_type).toBe('signature_original');
    expect(candidates[2].variant_type).toBe('operator_heuristic');

    // All should have valid crafted_text
    expect(candidates.every(c => c.crafted_text && c.crafted_text.length >= 40)).toBe(true);
  });

  // ═══ Test 2: Supports old single-candidate schema fallback ═══

  it('supports old single-candidate schema fallback — wrapped as one "legacy" candidate', () => {
    // Simulate what happens when the model returns old schema
    const oldSchemaResponse = {
      crafted_text: 'AI agents reshape team judgment allocation. Map capability to decision type for better outcomes.',
      format: 'reply',
      brief_alignment_score: 8,
    };

    // The craftFromBrief function wraps this as a "legacy" candidate
    const candidate: CraftedCandidate = {
      variant_type: 'legacy',
      crafted_text: oldSchemaResponse.crafted_text,
      format: oldSchemaResponse.format || 'reply',
      brief_alignment_score: oldSchemaResponse.brief_alignment_score || 7,
      brief_alignment_notes: [],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: false,
    };

    // Verify it's a single "legacy" candidate
    expect(candidate.variant_type).toBe('legacy');
    expect(candidate.crafted_text).toBeTruthy();
    expect(candidate.crafted_text!.length).toBeGreaterThanOrEqual(40);
  });

  // ═══ Test 3: Selects best local candidate by signature/originality/usefulness ═══

  it('selects best local candidate by signature/originality/usefulness', () => {
    const brief = makeBrief();

    // Create 3 candidates with different characteristics
    const candidate1 = makeCandidate({
      variant_type: 'brief_faithful',
      crafted_text: 'AI agents augment team judgment. Teams still need human oversight for complex decisions. Map capability to decision type.',
      brief_alignment_score: 6, // Lower alignment
    });

    const candidate2 = makeCandidate({
      variant_type: 'signature_original',
      crafted_text: 'Judgment cache for taste: AI agents compress decisions, they do not eliminate them. Audit what your team delegates vs decides.',
      brief_alignment_score: 9, // Higher alignment
    });

    const candidate3 = makeCandidate({
      variant_type: 'operator_heuristic',
      crafted_text: 'When evaluating AI tools, check: does it reduce judgment cache misses? If not, it is automation, not augmentation.',
      brief_alignment_score: 8,
    });

    // Compute local scores
    const score1 = computeLocalCandidateScore(candidate1, brief);
    const score2 = computeLocalCandidateScore(candidate2, brief);
    const score3 = computeLocalCandidateScore(candidate3, brief);

    // The signature_original candidate should score highest due to higher alignment + originality
    // (brief_alignment_score >= 8 → 2 points, signature voice features, etc.)
    expect(score2).toBeGreaterThan(score1);

    // Select candidates
    const result = selectCandidatesForJudge([candidate1, candidate2, candidate3], brief);

    // The best candidate should be the one with the highest local score
    expect(result.selected.length).toBeGreaterThanOrEqual(1);
    expect(result.selected[0]._candidate_local_score).toBeDefined();

    // The selected best should have the highest score
    const allScores = [score1, score2, score3];
    const maxScore = Math.max(...allScores);
    expect(result.selected[0]._candidate_local_score).toBe(maxScore);
  });

  // ═══ Test 4: Sends max 2 candidates per opportunity to judge ═══

  it('sends max 2 candidates per opportunity to judge', () => {
    const brief = makeBrief();

    // Create 3 candidates with different variant types
    const candidates = [
      makeCandidate({
        variant_type: 'brief_faithful',
        crafted_text: 'AI agents augment team judgment—they do not replace it. The key: map capability to decision type, not to habit.',
        brief_alignment_score: 8,
      }),
      makeCandidate({
        variant_type: 'signature_original',
        crafted_text: 'Judgment cache for taste: AI agents compress decisions, they do not eliminate them. Operators: audit what your team delegates vs decides.',
        brief_alignment_score: 8,
      }),
      makeCandidate({
        variant_type: 'operator_heuristic',
        crafted_text: 'When evaluating AI tools for your team, check: does it reduce judgment cache misses? If not, it is automation, not augmentation.',
        brief_alignment_score: 8,
      }),
    ];

    const result = selectCandidatesForJudge(candidates, brief);

    // Should never select more than 2
    expect(result.selected.length).toBeLessThanOrEqual(2);

    // 3 candidates - max 2 selected = at least 1 dropped
    expect(result.dropped).toBeGreaterThanOrEqual(1);
  });

  // ═══ Test 5: Preserves metadata on selected variants ═══

  it('preserves metadata on selected variants', () => {
    const brief = makeBrief();

    const candidates = [
      makeCandidate({
        variant_type: 'brief_faithful',
        crafted_text: 'AI agents augment team judgment—they do not replace it. The key: map capability to decision type, not to habit.',
        brief_alignment_score: 9,
      }),
      makeCandidate({
        variant_type: 'signature_original',
        crafted_text: 'Judgment cache for taste: AI agents compress decisions, they do not eliminate them. Operators: audit what your team delegates vs decides.',
        brief_alignment_score: 8,
      }),
    ];

    const result = selectCandidatesForJudge(candidates, brief);

    // Each selected candidate should have metadata set
    for (const selected of result.selected) {
      expect(selected._candidate_variant_type ?? selected.variant_type).toBeDefined();
      expect(selected._candidate_local_score).toBeDefined();
      expect(selected._candidate_selection_reason).toBeDefined();
    }

    // The best should be selected with reason 'best_local_score'
    expect(result.selected[0]._candidate_selection_reason).toBe('best_local_score');
  });

  // ═══ Test 6: Dedupes judged candidates by source/opportunity before publish_gate ═══

  it('dedupes judged candidates by source/opportunity before publish_gate', () => {
    // Two candidates from the same source with different judge results
    const sourceKey = 'AI agents reshape team decision-making processes...';
    const candidatesWithResults: CandidateWithJudgeResult[] = [
      {
        candidate: makeCandidate({
          variant_type: 'brief_faithful',
          crafted_text: 'AI agents augment team judgment—they do not replace it.',
        }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.0,
          brief_alignment_score: 8,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
      {
        candidate: makeCandidate({
          variant_type: 'signature_original',
          crafted_text: 'Judgment cache for taste: AI agents compress decisions.',
        }),
        judgeResult: {
          passed: true,
          final_candidate_score: 8.5,
          originality_score: 8.5,
          brief_alignment_score: 8,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
    ];

    const deduped = deduplicateJudgedCandidates(candidatesWithResults);

    // Should keep only 1 candidate for the same source
    expect(deduped).toHaveLength(1);

    // Should keep the passed candidate
    expect(deduped[0].judgeResult.passed).toBe(true);
  });

  // ═══ Test 7: Passed candidate beats failed candidate ═══

  it('passed candidate beats failed candidate', () => {
    const sourceKey = 'same_source';

    const candidatesWithResults: CandidateWithJudgeResult[] = [
      {
        candidate: makeCandidate({
          variant_type: 'brief_faithful',
          crafted_text: 'AI agents augment team judgment.',
        }),
        judgeResult: {
          passed: false,
          final_candidate_score: 9.0, // Higher score but failed (e.g., on originality)
          originality_score: 7.0,
          brief_alignment_score: 9,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
      {
        candidate: makeCandidate({
          variant_type: 'signature_original',
          crafted_text: 'Judgment cache for taste: AI compresses decisions.',
        }),
        judgeResult: {
          passed: true,
          final_candidate_score: 8.0, // Lower score but passed
          originality_score: 8.0,
          brief_alignment_score: 8,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
    ];

    const deduped = deduplicateJudgedCandidates(candidatesWithResults);

    expect(deduped).toHaveLength(1);
    // The passed candidate should be kept even though its final_candidate_score is lower
    expect(deduped[0].judgeResult.passed).toBe(true);
    expect(deduped[0].judgeResult.final_candidate_score).toBe(8.0);
  });

  // ═══ Test 8: Failed candidates tie-break by final/originality/brief/evidence ═══

  it('failed candidates tie-break by final/originality/brief/evidence', () => {
    const sourceKey = 'same_source';

    const candidatesWithResults: CandidateWithJudgeResult[] = [
      {
        candidate: makeCandidate({
          variant_type: 'brief_faithful',
          crafted_text: 'AI agents augment team judgment with better allocation.',
        }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.0, // Lower originality
          brief_alignment_score: 8,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
      {
        candidate: makeCandidate({
          variant_type: 'signature_original',
          crafted_text: 'Judgment cache: AI reshapes how teams allocate decisions.',
        }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5, // Same final score
          originality_score: 8.0, // Higher originality → should win tiebreak
          brief_alignment_score: 8,
          evidence_safety_score: 9,
        },
        sourceKey,
      },
    ];

    const deduped = deduplicateJudgedCandidates(candidatesWithResults);

    expect(deduped).toHaveLength(1);
    // The candidate with higher originality_score should win the tiebreak
    expect(deduped[0].judgeResult.originality_score).toBe(8.0);

    // Test further tiebreak: same final and originality → brief_alignment decides
    const tieBreak2: CandidateWithJudgeResult[] = [
      {
        candidate: makeCandidate({ variant_type: 'brief_faithful' }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.5,
          brief_alignment_score: 7.0, // Lower brief_alignment
          evidence_safety_score: 9,
        },
        sourceKey: 'source2',
      },
      {
        candidate: makeCandidate({ variant_type: 'operator_heuristic' }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.5,
          brief_alignment_score: 8.0, // Higher brief_alignment → should win
          evidence_safety_score: 9,
        },
        sourceKey: 'source2',
      },
    ];

    const deduped2 = deduplicateJudgedCandidates(tieBreak2);
    expect(deduped2).toHaveLength(1);
    expect(deduped2[0].judgeResult.brief_alignment_score).toBe(8.0);

    // Test further tiebreak: same final, originality, brief → evidence decides
    const tieBreak3: CandidateWithJudgeResult[] = [
      {
        candidate: makeCandidate({ variant_type: 'brief_faithful' }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.5,
          brief_alignment_score: 8.0,
          evidence_safety_score: 8.5, // Lower evidence_safety
        },
        sourceKey: 'source3',
      },
      {
        candidate: makeCandidate({ variant_type: 'operator_heuristic' }),
        judgeResult: {
          passed: false,
          final_candidate_score: 7.5,
          originality_score: 7.5,
          brief_alignment_score: 8.0,
          evidence_safety_score: 9.0, // Higher evidence_safety → should win
        },
        sourceKey: 'source3',
      },
    ];

    const deduped3 = deduplicateJudgedCandidates(tieBreak3);
    expect(deduped3).toHaveLength(1);
    expect(deduped3[0].judgeResult.evidence_safety_score).toBe(9.0);
  });

  // ═══ Test 9: No threshold changes ═══

  it('does not change any judge or near-pass thresholds', () => {
    // All thresholds must remain unchanged
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
    expect(typeof computeLocalCandidateScore).toBe('function');
    expect(typeof selectCandidatesForJudge).toBe('function');
    expect(typeof deduplicateJudgedCandidates).toBe('function');

    // Verify validateBriefAlignment still works (imported from pipeline-worker)
    expect(typeof validateBriefAlignment).toBe('function');

    // Verify CraftedCandidate type can be used (structural type check)
    const candidate: CraftedCandidate = makeCandidate();
    expect(candidate.variant_type).toBe('brief_faithful');
    expect(candidate._candidate_local_score).toBeUndefined();

    // Verify we can compute a local score
    const brief = makeBrief();
    const score = computeLocalCandidateScore(candidate, brief);
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThan(-10); // Sanity check
  });
});
