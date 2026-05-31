/**
 * pipeline-contracts.ts — Phase S1: Runtime validators for pipeline stage contracts
 *
 * These validators never throw. They return { valid, normalized, errors, warnings }
 * and convert malformed items into safe rejected diagnostics where possible.
 *
 * Official text rule:
 * - Before judge: official text = selected candidate crafted_text if present, else opportunity.crafted_text
 * - After judge: opportunity.crafted_text must match judged best candidate
 * - After polish: opportunity.crafted_text must match polished_text if applied
 * - publish_gate must only use opportunity.crafted_text
 *
 * Phase S1.1: Source timestamp preservation rule:
 * - source_created_at is the canonical timestamp field
 * - Normalized from: created_at, tweet_created_at, published_at, createdAt, tweetCreatedAt
 * - Must be preserved through ALL pipeline stages
 * - Used by freshness gate in publish_gate
 */

import type { CraftedCandidate } from './candidate-selector';
import { normalizeSourceCreatedAt, computeSourceAgeHours } from './content-policy';

// ═══ Types ═══

export type ValidationResult = {
  valid: boolean;
  normalized: Record<string, any>;
  errors: string[];
  warnings: string[];
};

// ═══ Helpers ═══

/**
 * Safely get a string field from an object, returning '' if missing/invalid.
 */
function safeString(obj: any, field: string): string {
  const val = obj?.[field];
  if (typeof val === 'string') return val;
  return '';
}

/**
 * Safely get a number field from an object, returning 0 if missing/invalid.
 */
function safeNumber(obj: any, field: string): number {
  const val = obj?.[field];
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  return 0;
}

/**
 * Safely get an array field from an object, returning [] if missing/invalid.
 */
function safeArray(obj: any, field: string): any[] {
  const val = obj?.[field];
  if (Array.isArray(val)) return val;
  return [];
}

/**
 * Safely get a boolean field from an object, returning defaultValue if missing.
 */
function safeBoolean(obj: any, field: string, defaultValue: boolean = false): boolean {
  const val = obj?.[field];
  if (typeof val === 'boolean') return val;
  return defaultValue;
}

/**
 * Safely get an object field, returning {} if missing/invalid.
 */
function safeObject(obj: any, field: string): Record<string, any> {
  const val = obj?.[field];
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  return {};
}

// ═══ Official Text Rule ═══

/**
 * normalizeOfficialText — Implements the Official Text Rule.
 *
 * Determines the canonical text for an opportunity based on its state:
 * 1. If _selected_candidates exists and has valid candidates with crafted_text,
 *    use the best (first) candidate's text.
 * 2. Otherwise, use opportunity.crafted_text.
 * 3. If neither exists, return empty string (safe rejection should be applied).
 *
 * This function never throws.
 */
export function normalizeOfficialText(opportunity: Record<string, any>): {
  text: string;
  source: 'selected_candidate' | 'opportunity_crafted_text' | 'none';
  warnings: string[];
} {
  const warnings: string[] = [];

  // Try selected candidates first
  const selectedCandidates = opportunity._selected_candidates;
  if (Array.isArray(selectedCandidates) && selectedCandidates.length > 0) {
    for (const cand of selectedCandidates) {
      if (!cand || typeof cand !== 'object') continue;
      if (cand.crafted_text && typeof cand.crafted_text === 'string' && cand.crafted_text.trim()) {
        return {
          text: cand.crafted_text.trim(),
          source: 'selected_candidate',
          warnings,
        };
      }
    }
    warnings.push('_selected_candidates present but no valid crafted_text found in any candidate');
  }

  // Fallback to opportunity.crafted_text
  const oppText = opportunity.crafted_text;
  if (oppText && typeof oppText === 'string' && oppText.trim()) {
    return {
      text: oppText.trim(),
      source: 'opportunity_crafted_text',
      warnings,
    };
  }

  // No text at all
  return {
    text: '',
    source: 'none',
    warnings: [...warnings, 'no valid official text found — opportunity should be safely rejected'],
  };
}

// ═══ Validators ═══

/**
 * validateOpportunityForEnrich — Validate an opportunity before the enrich step.
 *
 * Required fields: crafted_text (or _selected_candidates with text), source_text, type
 * Optional fields: _brief, shield_passed, shield_issues
 *
 * Never throws. Returns normalized opportunity with errors/warnings.
 */
export function validateOpportunityForEnrich(opportunity: Record<string, any>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!opportunity || typeof opportunity !== 'object') {
    return {
      valid: false,
      normalized: {
        shield_passed: false,
        shield_issues: ['invalid_opportunity_object'],
        _candidate_generation_error: 'not_an_object',
        crafted_text: '',
        source_text: '',
        type: '',
      },
      errors: ['opportunity is not a valid object'],
      warnings: [],
    };
  }

  // Determine official text
  const { text, source, warnings: textWarnings } = normalizeOfficialText(opportunity);
  warnings.push(...textWarnings);

  // Validate required fields
  const sourceText = safeString(opportunity, 'source_text');
  if (!sourceText) {
    warnings.push('source_text is empty — opportunity may not be processable');
  }

  const type = safeString(opportunity, 'type');
  if (!type) {
    warnings.push('type is empty — defaulting to empty string');
  }

  // Build normalized opportunity
  // Phase S1.1: Normalize source_created_at from various possible field names
  const sourceCreatedAt = normalizeSourceCreatedAt(opportunity);
  if (!sourceCreatedAt && (type === 'reply' || type === 'quote')) {
    warnings.push('source_created_at is missing for reply/quote — freshness gate will reject');
  }
  const sourceAgeHours = computeSourceAgeHours(sourceCreatedAt);

  const normalized: Record<string, any> = {
    ...opportunity,
    crafted_text: text || safeString(opportunity, 'crafted_text'),
    source_text: sourceText,
    type: type,
    shield_passed: safeBoolean(opportunity, 'shield_passed', true),
    shield_issues: safeArray(opportunity, 'shield_issues'),
    // Phase S1.1: Preserve canonical source timestamp
    source_created_at: sourceCreatedAt,
    source_age_hours: sourceAgeHours,
    // Preserve _brief if present
    ...(opportunity._brief ? { _brief: opportunity._brief } : {}),
    // Preserve _selected_candidates if present
    ...(opportunity._selected_candidates ? { _selected_candidates: opportunity._selected_candidates } : {}),
    // Apply official text rule
    ...(source === 'selected_candidate' ? { _official_text_source: 'selected_candidate' } : {}),
    ...(source === 'none' ? {
      shield_passed: false,
      shield_issues: [...safeArray(opportunity, 'shield_issues'), 'candidate_missing_crafted_text'],
      _candidate_generation_error: 'no_valid_crafted_text',
    } : {}),
  };

  const valid = text.length > 0;

  if (!valid) {
    errors.push('no valid official text — opportunity will be safely rejected');
  }

  return { valid, normalized, errors, warnings };
}

/**
 * validateOpportunityForJudge — Validate an opportunity before the judge step.
 *
 * Required: crafted_text (official text rule), source_text for source key
 * Optional: _selected_candidates, _brief, _judge_result (should not exist pre-judge)
 *
 * Never throws.
 */
export function validateOpportunityForJudge(opportunity: Record<string, any>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!opportunity || typeof opportunity !== 'object') {
    return {
      valid: false,
      normalized: {
        shield_passed: false,
        shield_issues: ['invalid_opportunity_object'],
        _candidate_generation_error: 'not_an_object',
        crafted_text: '',
        source_text: '',
      },
      errors: ['opportunity is not a valid object'],
      warnings: [],
    };
  }

  // Determine official text
  const { text, source, warnings: textWarnings } = normalizeOfficialText(opportunity);
  warnings.push(...textWarnings);

  // Check for _selected_candidates validity
  const selectedCandidates = safeArray(opportunity, '_selected_candidates');
  let validCandidateCount = 0;
  let nullCandidateCount = 0;
  let missingTextCount = 0;

  for (const cand of selectedCandidates) {
    if (!cand || typeof cand !== 'object') {
      nullCandidateCount++;
      continue;
    }
    if (!cand.crafted_text || typeof cand.crafted_text !== 'string' || !cand.crafted_text.trim()) {
      missingTextCount++;
      continue;
    }
    validCandidateCount++;
  }

  if (nullCandidateCount > 0) {
    warnings.push(`_selected_candidates contains ${nullCandidateCount} null/undefined entries`);
  }
  if (missingTextCount > 0) {
    warnings.push(`_selected_candidates contains ${missingTextCount} candidates with missing/empty crafted_text`);
  }

  // Check for stale _judge_result (shouldn't exist pre-judge)
  if (opportunity._judge_result) {
    warnings.push('_judge_result already exists — will be overwritten by judge');
  }

  // Build normalized
  // Phase S1.1: Normalize source_created_at
  const sourceCreatedAt = normalizeSourceCreatedAt(opportunity);
  if (!sourceCreatedAt && (safeString(opportunity, 'type') === 'reply' || safeString(opportunity, 'type') === 'quote')) {
    warnings.push('source_created_at is missing for reply/quote — freshness gate will reject');
  }

  const normalized: Record<string, any> = {
    ...opportunity,
    crafted_text: text || safeString(opportunity, 'crafted_text'),
    shield_passed: safeBoolean(opportunity, 'shield_passed', true),
    shield_issues: safeArray(opportunity, 'shield_issues'),
    _brief: safeObject(opportunity, '_brief'),
    // Phase S1.1: Preserve canonical source timestamp
    source_created_at: sourceCreatedAt,
    ...(source === 'selected_candidate' ? { _official_text_source: 'selected_candidate' } : {}),
    ...(validCandidateCount > 0 ? { _valid_candidate_count: validCandidateCount } : {}),
    ...(source === 'none' || validCandidateCount === 0 && selectedCandidates.length > 0 ? {
      shield_passed: false,
      shield_issues: [...safeArray(opportunity, 'shield_issues'), 'candidate_missing_crafted_text'],
      _candidate_generation_error: 'no_valid_crafted_text',
    } : {}),
  };

  const valid = text.length > 0;

  if (!valid) {
    errors.push('no valid official text for judge — opportunity will be safely rejected');
  }

  return { valid, normalized, errors, warnings };
}

/**
 * validateCandidateForJudge — Validate a single candidate before AI judging.
 *
 * Required: crafted_text (non-empty string)
 * Optional: variant_type, brief_alignment_score
 *
 * Never throws. Returns safe fallback if candidate is invalid.
 */
export function validateCandidateForJudge(candidate: Record<string, any>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!candidate || typeof candidate !== 'object') {
    return {
      valid: false,
      normalized: {
        crafted_text: '',
        variant_type: 'invalid',
        _candidate_validation_error: 'not_an_object',
      },
      errors: ['candidate is not a valid object'],
      warnings: [],
    };
  }

  const craftedText = candidate.crafted_text;
  if (!craftedText || typeof craftedText !== 'string' || !craftedText.trim()) {
    return {
      valid: false,
      normalized: {
        ...candidate,
        crafted_text: '',
        variant_type: safeString(candidate, 'variant_type') || 'legacy',
        _candidate_validation_error: 'missing_crafted_text',
      },
      errors: ['candidate crafted_text is missing, empty, or not a string'],
      warnings: [],
    };
  }

  const trimmed = craftedText.trim();

  // Check for JSON wrapper
  if (/^\s*\{/.test(trimmed) || /^```/.test(trimmed)) {
    warnings.push('crafted_text looks like JSON wrapper — should have been cleaned earlier');
  }

  // Check length constraints
  if (trimmed.length < 40) {
    warnings.push(`crafted_text is ${trimmed.length} chars — below minimum 40`);
  }
  if (trimmed.length > 280) {
    warnings.push(`crafted_text is ${trimmed.length} chars — above maximum 280`);
  }

  const normalized: Record<string, any> = {
    ...candidate,
    crafted_text: trimmed,
    variant_type: safeString(candidate, 'variant_type') || 'legacy',
    brief_alignment_score: safeNumber(candidate, 'brief_alignment_score'),
  };

  return { valid: true, normalized, errors, warnings };
}

/**
 * validateOpportunityForPublishGate — Validate an opportunity before publish_gate.
 *
 * Required: crafted_text (official text, post-judge/post-polish)
 * Required: shield_passed (must be boolean)
 * Required: _judge_result.passed (must be true for publishable)
 *
 * Never throws. Safely rejects invalid opportunities.
 */
export function validateOpportunityForPublishGate(opportunity: Record<string, any>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!opportunity || typeof opportunity !== 'object') {
    return {
      valid: false,
      normalized: {
        shield_passed: false,
        shield_issues: ['invalid_opportunity_object'],
        crafted_text: '',
        _publish_gate_error: 'not_an_object',
      },
      errors: ['opportunity is not a valid object'],
      warnings: [],
    };
  }

  // Official text: after judge/polish, opportunity.crafted_text is the canonical source
  const craftedText = safeString(opportunity, 'crafted_text');
  if (!craftedText.trim()) {
    errors.push('crafted_text is empty — opportunity cannot pass publish_gate');
  }

  // Check shield_passed
  const shieldPassed = safeBoolean(opportunity, 'shield_passed', true);
  if (!shieldPassed) {
    errors.push('shield_passed is false — opportunity already rejected before publish_gate');
  }

  // Check _judge_result
  const judgeResult = opportunity._judge_result;
  if (!judgeResult) {
    warnings.push('no _judge_result found — opportunity may not have been judged');
  } else if (!judgeResult.passed) {
    errors.push('_judge_result.passed is false — opportunity was rejected by judge');
  }

  // Check for raw candidate text leaking past judge
  if (opportunity._selected_candidates && !opportunity._selected_candidate_text_applied) {
    warnings.push('_selected_candidates present but _selected_candidate_text_applied is not set — official text may not have been applied');
  }

  // Phase S1.1: Normalize source_created_at for freshness gate
  const sourceCreatedAt = normalizeSourceCreatedAt(opportunity);
  const sourceAgeHours = computeSourceAgeHours(sourceCreatedAt);
  const oppType = safeString(opportunity, 'type');
  if (!sourceCreatedAt && (oppType === 'reply' || oppType === 'quote')) {
    warnings.push('source_created_at is missing for reply/quote — freshness gate will reject');
  }

  const normalized: Record<string, any> = {
    ...opportunity,
    crafted_text: craftedText.trim(),
    shield_passed: shieldPassed,
    shield_issues: safeArray(opportunity, 'shield_issues'),
    // Phase S1.1: Preserve canonical source timestamp for freshness gate
    source_created_at: sourceCreatedAt,
    source_age_hours: sourceAgeHours,
  };

  const valid = craftedText.trim().length > 0 && shieldPassed && (!judgeResult || judgeResult.passed);

  if (!valid && !shieldPassed) {
    normalized._publish_gate_error = 'shield_already_failed';
  } else if (!valid && judgeResult && !judgeResult.passed) {
    normalized._publish_gate_error = 'judge_rejected';
  } else if (!valid && !craftedText.trim()) {
    normalized._publish_gate_error = 'missing_crafted_text';
  }

  return { valid, normalized, errors, warnings };
}
