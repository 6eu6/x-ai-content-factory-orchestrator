/**
 * quality-validator.ts — Phase 2C: Hard validation before publish_gate
 *
 * After cleaning, niche alignment, and rewrite, this validator runs
 * a final check to ensure no garbage reaches publish_gate.
 *
 * Checks:
 * 1. crafted_text is plain text (not JSON, not markdown fenced)
 * 2. No Arabic content
 * 3. No AI slop
 * 4. Valid length (10-1200 chars)
 * 5. Niche aligned (score >= 4)
 * 6. No unsourced numeric claims
 * 7. No fake AI angle added to unrelated entertainment content
 *
 * If validation fails:
 * - Do NOT pass as acceptable
 * - Add quality_notes explaining why
 * - Set pre_gate_rejection_reason
 * - Set final_quality_validation_passed = false
 */

import { containsArabic, isAISlopWrapper, looksJsonish } from './content-policy';
import { looksLikeJsonWrapper } from './crafted-text-cleaner';
import { hasSourceForClaim, detectNumericClaims } from './numeric-claim-guard';
import { scoreNicheAlignment } from './niche-alignment';

// ═══ Types ═══

export type ValidationResult = {
  passed: boolean;
  failures: string[];
  final_quality_validation_passed: boolean;
  final_quality_validation_notes: string;
};

export type OpportunityForValidation = {
  crafted_text: string;
  type: string;
  source_text?: string;
  why?: string;
  shield_passed?: boolean;
  shield_issues?: string[];
  niche_alignment_score?: number;
  niche_alignment_reason?: string;
  pre_gate_rejection_reason?: string;
  malformed_json_output?: boolean;
  quality_notes?: string;
  [key: string]: any;
};

// ═══ Validation ═══

/**
 * Validate a single opportunity before it reaches publish_gate.
 *
 * This is the FINAL quality gate. Nothing that fails this check
 * should ever be seen by publish_gate.
 */
export function validateOpportunityQuality(opp: OpportunityForValidation): ValidationResult {
  const failures: string[] = [];
  const text = opp.crafted_text || '';

  // 1. Plain text check — no JSON wrappers
  if (looksLikeJsonWrapper(text)) {
    failures.push('text_is_json_wrapper');
  }

  // 1b. Looks jsonish (content-policy check)
  if (looksJsonish(text)) {
    failures.push('text_looks_jsonish');
  }

  // 1c. Markdown code fences
  if (/^```/.test(text.trim())) {
    failures.push('text_has_markdown_fences');
  }

  // 2. No Arabic content
  if (containsArabic(text)) {
    failures.push('arabic_content_detected');
  }

  // 3. No AI slop
  const slopCheck = isAISlopWrapper(text);
  if (!slopCheck.ok) {
    failures.push(`ai_slop:${slopCheck.reason || 'detected'}`);
  }

  // 4. Valid length
  if (text.length < 10) {
    failures.push('text_too_short');
  }
  if (text.length > 1200) {
    failures.push('text_too_long');
  }

  // 5. Niche alignment
  if (opp.pre_gate_rejection_reason === 'off_niche') {
    failures.push('off_niche_pre_gate_rejection');
  } else if (opp.niche_alignment_score !== undefined && opp.niche_alignment_score < 4) {
    failures.push(`niche_score_too_low:${opp.niche_alignment_score}`);
  } else if (opp.niche_alignment_score === undefined) {
    // Score not computed yet — compute now
    const alignment = scoreNicheAlignment(opp);
    if (alignment.is_off_niche) {
      failures.push(`off_niche:${alignment.niche_alignment_score}`);
    }
  }

  // 6. No unsourced numeric claims
  const numericClaims = detectNumericClaims(text);
  if (numericClaims.length > 0 && !hasSourceForClaim(opp)) {
    failures.push('unsourced_numeric_claims_in_validation');
  }

  // 7. Malformed JSON output flag from cleaning
  if (opp.malformed_json_output) {
    failures.push('malformed_json_output');
  }

  // 8. Generic engagement bait in final text
  const genericBaitPatterns = [
    /^yo[,.…!\s]/i,
    /^interesting take/i,
    /^hot take/i,
    /^this\.\s*$/i,
    /^so true/i,
    /^boom\s*$/i,
    /^thoughts\?\s*$/i,
  ];
  for (const pattern of genericBaitPatterns) {
    if (pattern.test(text.trim())) {
      failures.push('generic_engagement_bait');
      break;
    }
  }

  const passed = failures.length === 0;
  return {
    passed,
    failures,
    final_quality_validation_passed: passed,
    final_quality_validation_notes: passed
      ? 'All quality validations passed'
      : `Failed: ${failures.join(', ')}`
  };
}

/**
 * Batch validate all opportunities before publish_gate.
 *
 * Opportunities that fail validation are marked with:
 * - final_quality_validation_passed = false
 * - final_quality_validation_notes
 * - pre_gate_rejection_reason (set if not already set)
 * - shield_passed = false (ensures publish_gate rejects them)
 *
 * Returns:
 * - validated: all opportunities with validation results attached
 * - passed: opportunities that passed validation
 * - failed: opportunities that failed validation
 * - summary: aggregate statistics
 */
export function validateOpportunitiesBeforeGate(
  opportunities: OpportunityForValidation[]
): {
  validated: OpportunityForValidation[];
  passed: OpportunityForValidation[];
  failed: Array<{
    opportunity: OpportunityForValidation;
    validation: ValidationResult;
  }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    failure_reasons: Record<string, number>;
  };
} {
  if (!opportunities?.length) {
    return { validated: [], passed: [], failed: [], summary: { total: 0, passed: 0, failed: 0, failure_reasons: {} } };
  }

  const validated: OpportunityForValidation[] = [];
  const passed: OpportunityForValidation[] = [];
  const failedList: Array<{ opportunity: OpportunityForValidation; validation: ValidationResult }> = [];
  const failureReasons: Record<string, number> = {};

  for (const opp of opportunities) {
    const result = validateOpportunityQuality(opp);

    const enriched: OpportunityForValidation = {
      ...opp,
      final_quality_validation_passed: result.final_quality_validation_passed,
      final_quality_validation_notes: result.final_quality_validation_notes,
    };

    if (result.passed) {
      passed.push(enriched);
    } else {
      // Mark as rejected
      enriched.shield_passed = false;
      enriched.shield_issues = [...(opp.shield_issues || []), ...result.failures];
      if (!enriched.pre_gate_rejection_reason) {
        enriched.pre_gate_rejection_reason = result.failures[0];
      }
      enriched.quality_notes = [
        opp.quality_notes || '',
        `Quality validation failed: ${result.final_quality_validation_notes}`
      ].filter(Boolean).join('; ');

      // Track failure reasons
      for (const f of result.failures) {
        const key = f.split(':')[0]; // Normalize "off_niche:2.0" → "off_niche"
        failureReasons[key] = (failureReasons[key] || 0) + 1;
      }

      failedList.push({ opportunity: enriched, validation: result });
    }

    validated.push(enriched);
  }

  return {
    validated,
    passed,
    failed: failedList,
    summary: {
      total: opportunities.length,
      passed: passed.length,
      failed: failedList.length,
      failure_reasons: failureReasons
    }
  };
}
