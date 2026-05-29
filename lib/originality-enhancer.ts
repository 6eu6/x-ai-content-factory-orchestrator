/**
 * originality-enhancer.ts — Phase 2B: Self-critique/rewrite loop for crafted_text
 *
 * This module improves the quality of generated opportunities BEFORE publish_gate.
 * It does NOT lower thresholds or bypass any gate.
 *
 * For every opportunity:
 * 1. Score originality 1-10, evidence safety 1-10, usefulness 1-10
 * 2. If originality < 7.8, rewrite once using AI
 * 3. Re-score after rewrite
 * 4. If still below threshold, let publish_gate reject it naturally
 *
 * Diagnostic fields are persisted into the opportunity object for downstream
 * inspection: originality_score_before, originality_score_after,
 * evidence_safety_score, rewrite_applied, quality_notes.
 */

import { callModel, parseModelJson, TaskType } from './model-router';
import { containsArabic, isAISlopWrapper } from './content-policy';
import { quickShieldCheck } from './account-shield';

// ═══ Types ═══

export type QualityScores = {
  originality: number;
  evidence_safety: number;
  usefulness: number;
};

export type EnhancerResult = {
  crafted_text: string;
  scores_before: QualityScores;
  scores_after: QualityScores | null;
  rewrite_applied: boolean;
  quality_notes: string;
};

export type OpportunityWithDiagnostics = {
  crafted_text: string;
  type: string;
  source_text: string;
  source_author: string;
  source_tweet_url: string;
  why: string;
  brain_rules_used: string[];
  shield_passed: boolean;
  shield_issues: string[];
  // Phase 2B diagnostic fields
  originality_score_before?: number;
  originality_score_after?: number;
  evidence_safety_score?: number;
  rewrite_applied?: boolean;
  numeric_claim_removed?: boolean;
  quality_notes?: string;
  // Existing fields from enrich step
  avg_brain_rule_weight?: number;
  rule_performance_summary?: {
    matched_rules: number;
    avg_weight: number;
    strongest_rule: string | null;
    weakest_rule: string | null;
  };
  [key: string]: any;
};

// ═══ Constants ═══

/** Minimum originality score to avoid rewrite */
const ORIGINALITY_THRESHOLD = 7.8;

/** Maximum length for crafted_text to be eligible for rewrite */
const MAX_REWRITE_LENGTH = 1200;

// ═══ Pure Scoring Functions (testable without AI) ═══

/**
 * Heuristic originality pre-check.
 * Returns 1-10 estimate based on structural signals.
 * This is NOT the final score — the AI scores it more precisely.
 * Used for quick filtering before the expensive AI call.
 */
export function heuristicOriginality(text: string): number {
  if (!text || text.length < 10) return 1;

  let score = 5.0;

  // Positive signals
  if (text.includes('?')) score += 0.3;  // Questions engage
  if (/[""]/.test(text)) score += 0.3;   // Direct quotes show specificity
  if (/specific|exactly|precisely/i.test(text)) score += 0.2;
  if (/i (found|noticed|learned|discovered|tested|built)/i.test(text)) score += 0.5;  // Personal experience
  if (/\b(AI|GPT|LLM|prompt|agent|RAG|workflow|automation)\b/i.test(text)) score += 0.3;  // @30piq niche
  if (text.length > 40 && text.length < 280) score += 0.3;  // Good tweet length

  // Negative signals (generic/AI-slop patterns)
  // These carry heavy penalties because they indicate AI-generated generic content
  const genericPatterns = [
    { pattern: /in today'?s/i, penalty: 1.0 },
    { pattern: /it'?s (important|crucial|essential) (to|that)/i, penalty: 1.0 },
    { pattern: /whether you'?re/i, penalty: 0.7 },
    { pattern: /the (key|secret) to/i, penalty: 0.7 },
    { pattern: /here'?s (the thing|how|what)/i, penalty: 0.7 },
    { pattern: /let'?s (dive|explore|look)/i, penalty: 1.0 },
    { pattern: /game.?chang/i, penalty: 0.5 },
    { pattern: /leverag/i, penalty: 0.5 },
    { pattern: /streamlin/i, penalty: 0.5 },
    { pattern: /synerg/i, penalty: 0.5 },
    { pattern: /empower/i, penalty: 0.5 },
    { pattern: /elevat/i, penalty: 0.5 },
    { pattern: /foster/i, penalty: 0.5 },
    { pattern: /navigat.*landscape/i, penalty: 0.5 },
    { pattern: /cutting.?edge/i, penalty: 0.5 },
    { pattern: /state.?of.?the.?art/i, penalty: 0.5 },
    { pattern: /paradigm shift/i, penalty: 0.5 },
    { pattern: /unlock/i, penalty: 0.5 },
  ];

  for (const { pattern, penalty } of genericPatterns) {
    if (pattern.test(text)) score -= penalty;
  }

  // Very short = likely generic
  if (text.length < 30) score -= 1.0;

  // Numbered/bullet list pattern = AI-like
  if (/^\d+\.\s/m.test(text) && /^[-•]\s/m.test(text)) score -= 0.5;

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

/**
 * Heuristic evidence safety pre-check.
 * Returns 1-10 estimate based on presence of unsourced numeric claims.
 */
export function heuristicEvidenceSafety(text: string): number {
  if (!text || text.length < 10) return 5;

  let score = 8.0;  // Start high, penalize for claims

  // Unsourced numeric claims lower the score
  const numericClaimPatterns = [
    /\d+(?:\.\d+)?\s*%/i,
    /\$\d+/i,
    /\d+x\b/i,
    /(?:increased|decreased|grew|reduced|boosted|saved|cut|improved)\s+(by\s+)?\d/i,
    /studies show/i,
    /research shows/i,
    /data shows/i,
    /experts say/i,
    /millions?\s+(of|users|people)/i,
    /billions?\s+(of|users|people)/i,
  ];

  for (const pattern of numericClaimPatterns) {
    if (pattern.test(text)) {
      // Check if there's a source URL nearby
      if (!/https?:\/\//i.test(text)) {
        score -= 1.5;
      }
    }
  }

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

/**
 * Heuristic usefulness pre-check.
 * Returns 1-10 estimate based on actionable content signals.
 */
export function heuristicUsefulness(text: string): number {
  if (!text || text.length < 10) return 3;

  let score = 5.0;

  // Positive: actionable signals for @30piq niche (AI × productivity × career growth)
  const usefulPatterns = [
    /\b(try|use|build|create|automate|setup|install|run|deploy|test|ship|launch)\b/i,
    /\b(workflow|pipeline|system|framework|tool|app|script|template)\b/i,
    /\b(save|cut|reduce|speed|faster|better|improv)\b/i,
    /\b(prompt|agent|RAG|LLM|GPT|Claude|API|model)\b/i,
    /\b(career|hire|job|skill|learn|grow|salary)\b/i,
    /\b(productiv|automat|efficien|scale|outsource)\b/i,
    /\?/,  // Questions invite engagement
  ];

  for (const pattern of usefulPatterns) {
    if (pattern.test(text)) score += 0.4;
  }

  // Negative: vague/not useful
  if (/^(this|that|it|the)\s/i.test(text) && text.length < 50) score -= 1.0;
  if (/^(so|well|basically|honestly)\s/i.test(text)) score -= 0.5;

  return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
}

// ═══ AI-Powered Scoring ═══

/**
 * Score crafted_text quality using AI.
 * Returns originality, evidence_safety, usefulness on 1-10 scales.
 */
export async function scoreWithAI(text: string): Promise<QualityScores> {
  try {
    const response = await callModel('quality_evaluation' as TaskType, [
      {
        role: 'system',
        content: `You are a content quality evaluator for an X account (@30piq) focused on AI × productivity × career growth.

Score this text on three dimensions (1-10 each):

1. "originality": Does this offer a specific angle, personal/strategic insight, or non-generic framing? Or is it generic AI-style content that could be written by anyone?
   - Generic = 1-4 (vague, could come from any AI, no personal angle)
   - Decent = 5-7 (has some specificity but still feels template-ish)
   - Original = 8-10 (unique angle, personal insight, surprising framing, specific reference)

2. "evidence_safety": Are numeric claims (percentages, statistics, "studies show", rankings, multipliers) properly sourced? Are there any fabricated-seeming statistics?
   - Sourced/safe = 8-10 (no unverified numbers, or all numbers have sources)
   - Borderline = 5-7 (has some numbers that could use a source)
   - Unsafe = 1-4 (fabricated statistics, unsourced "studies show", invented percentages)

3. "usefulness": Is this actionable and useful for a high-value English-speaking audience interested in AI and productivity?
   - Useless = 1-4 (vague platitude, no actionability)
   - Somewhat useful = 5-7 (interesting but not directly actionable)
   - Very useful = 8-10 (specific, actionable, save-worthy)

Return JSON only: {"originality": N, "evidence_safety": N, "usefulness": N}`
      },
      {
        role: 'user',
        content: `Score this text:\n\n"${text}"`
      }
    ], { temperature: 0.0, max_tokens: 200, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(response);
    return {
      originality: clampScore(parsed.originality),
      evidence_safety: clampScore(parsed.evidence_safety),
      usefulness: clampScore(parsed.usefulness)
    };
  } catch {
    // Fallback to heuristic scores if AI fails
    return {
      originality: heuristicOriginality(text),
      evidence_safety: heuristicEvidenceSafety(text),
      usefulness: heuristicUsefulness(text)
    };
  }
}

// ═══ AI-Powered Rewrite ═══

/**
 * Rewrite crafted_text to improve originality.
 * The rewrite must NOT:
 * - Lower any gate threshold
 * - Weaken content-policy
 * - Introduce Arabic text
 * - Add unsourced numeric claims
 */
export async function rewriteForOriginality(
  text: string,
  currentScores: QualityScores
): Promise<string | null> {
  try {
    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `You are a content improvement specialist for @30piq (AI × productivity × career growth niche).

Your task: Rewrite this tweet to be MORE ORIGINAL while keeping it truthful.

Rules (mandatory):
1. Keep it under 280 characters
2. English ONLY — no Arabic
3. No AI slop words (delve, crucial, leverage, game-changer, unlock, empower, etc.)
4. No hashtags
5. No unsourced numeric claims — if there are numbers without a source, remove or rephrase them
6. Add a SPECIFIC angle: personal experience, surprising framing, counterintuitive take, or niche reference
7. Make it actionable for AI/productivity professionals
8. Vary sentence length — not all the same
9. Sound like a smart friend in tech, not a content mill
10. Do NOT add numbers/percentages that weren't in the original

Current scores: originality=${currentScores.originality}/10, evidence_safety=${currentScores.evidence_safety}/10, usefulness=${currentScores.usefulness}/10

Return the rewritten text ONLY. No explanation, no quotes, no labels.`
      },
      {
        role: 'user',
        content: `Rewrite this to be more original:\n\n"${text}"`
      }
    ], { temperature: 0.3, max_tokens: 300 });

    const rewritten = String(response || '').trim();

    // Validate rewrite
    if (!rewritten || rewritten.length < 10 || rewritten.length > MAX_REWRITE_LENGTH) {
      return null;
    }

    // If the rewrite contains Arabic, reject it
    if (containsArabic(rewritten)) {
      return null;
    }

    // If the rewrite looks like AI slop wrapper, reject it
    const slopCheck = isAISlopWrapper(rewritten);
    if (!slopCheck.ok) {
      return null;
    }

    return rewritten;
  } catch {
    return null;
  }
}

// ═══ Main Enhancement Function ═══

/**
 * Enhance a single opportunity's crafted_text.
 *
 * Process:
 * 1. AI-score the text (originality, evidence_safety, usefulness)
 * 2. If originality < 7.8, attempt one rewrite
 * 3. Re-score after rewrite
 * 4. Return enhanced opportunity with diagnostic fields
 *
 * This NEVER bypasses publish_gate. If the rewrite doesn't help,
 * the opportunity goes to publish_gate with its low scores and
 * gets rejected naturally.
 */
export async function enhanceOpportunity(
  opp: OpportunityWithDiagnostics
): Promise<OpportunityWithDiagnostics> {
  const text = opp.crafted_text || '';

  // Skip if no text to enhance
  if (!text || text.length < 10) {
    return {
      ...opp,
      originality_score_before: 0,
      originality_score_after: null,
      evidence_safety_score: 0,
      rewrite_applied: false,
      quality_notes: 'Empty or too short to enhance'
    };
  }

  // Skip if Arabic content — let publish_gate reject it
  if (containsArabic(text)) {
    return {
      ...opp,
      originality_score_before: 0,
      originality_score_after: null,
      evidence_safety_score: 0,
      rewrite_applied: false,
      quality_notes: 'Arabic content detected — cannot enhance, will be rejected by publish gate'
    };
  }

  // Step 1: Score with AI
  const scoresBefore = await scoreWithAI(text);

  const notes: string[] = [];

  // Step 2: Rewrite if originality is below threshold
  let rewriteApplied = false;
  let scoresAfter: QualityScores | null = null;
  let finalText = text;

  if (scoresBefore.originality < ORIGINALITY_THRESHOLD) {
    notes.push(`Originality ${scoresBefore.originality}/10 < ${ORIGINALITY_THRESHOLD} threshold`);

    const rewritten = await rewriteForOriginality(text, scoresBefore);
    if (rewritten && rewritten !== text) {
      // Re-score the rewrite
      scoresAfter = await scoreWithAI(rewritten);

      if (scoresAfter.originality > scoresBefore.originality) {
        finalText = rewritten;
        rewriteApplied = true;
        notes.push(`Rewritten: originality ${scoresBefore.originality} → ${scoresAfter.originality}`);

        // Re-run shield check on rewritten text
        const shieldResult = quickShieldCheck(finalText, opp);
        opp.shield_passed = shieldResult.safe;
        opp.shield_issues = shieldResult.reasons;
      } else {
        notes.push(`Rewrite did not improve originality (${scoresAfter.originality} ≤ ${scoresBefore.originality})`);
      }
    } else {
      notes.push('Rewrite returned null or identical text');
    }
  } else {
    notes.push(`Originality ${scoresBefore.originality}/10 meets threshold`);
  }

  // Step 3: Track evidence safety
  if (scoresBefore.evidence_safety < 6) {
    notes.push(`Evidence safety ${scoresBefore.evidence_safety}/10 — numeric claims may need sources`);
  }

  return {
    ...opp,
    crafted_text: finalText,
    originality_score_before: scoresBefore.originality,
    originality_score_after: scoresAfter?.originality ?? null,
    evidence_safety_score: scoresBefore.evidence_safety,
    rewrite_applied: rewriteApplied,
    quality_notes: notes.join('; ')
  };
}

/**
 * Batch enhance all opportunities.
 * Returns enhanced opportunities with diagnostic fields.
 */
export async function enhanceOpportunities(
  opportunities: OpportunityWithDiagnostics[]
): Promise<{
  enhanced: OpportunityWithDiagnostics[];
  rewrites_applied: number;
  scores_summary: {
    avg_originality_before: number;
    avg_originality_after: number;
    avg_evidence_safety: number;
    avg_usefulness: number;
    below_threshold_before: number;
    below_threshold_after: number;
  };
}> {
  if (!opportunities?.length) {
    return {
      enhanced: [],
      rewrites_applied: 0,
      scores_summary: {
        avg_originality_before: 0,
        avg_originality_after: 0,
        avg_evidence_safety: 0,
        avg_usefulness: 0,
        below_threshold_before: 0,
        below_threshold_after: 0
      }
    };
  }

  const enhanced: OpportunityWithDiagnostics[] = [];
  let rewritesApplied = 0;

  for (const opp of opportunities) {
    const result = await enhanceOpportunity(opp);
    enhanced.push(result);
    if (result.rewrite_applied) rewritesApplied++;
  }

  // Compute summary
  const count = enhanced.length;
  const originalityBefore = enhanced.reduce((sum, o) => sum + (o.originality_score_before || 0), 0) / count;
  const originalityAfter = enhanced.reduce((sum, o) => sum + (o.originality_score_after ?? o.originality_score_before ?? 0), 0) / count;
  const evidenceSafety = enhanced.reduce((sum, o) => sum + (o.evidence_safety_score || 0), 0) / count;
  const usefulness = enhanced.reduce((sum, o) => {
    // Use after if available, otherwise before
    const before = o.originality_score_before || 0;
    const after = o.originality_score_after;
    return sum + (after !== null && after !== undefined ? after : before);
  }, 0) / count;

  const belowThresholdBefore = enhanced.filter(o => (o.originality_score_before || 0) < ORIGINALITY_THRESHOLD).length;
  const belowThresholdAfter = enhanced.filter(o => {
    const score = o.originality_score_after ?? o.originality_score_before ?? 0;
    return score < ORIGINALITY_THRESHOLD;
  }).length;

  return {
    enhanced,
    rewrites_applied: rewritesApplied,
    scores_summary: {
      avg_originality_before: Math.round(originalityBefore * 10) / 10,
      avg_originality_after: Math.round(originalityAfter * 10) / 10,
      avg_evidence_safety: Math.round(evidenceSafety * 10) / 10,
      avg_usefulness: Math.round(usefulness * 10) / 10,
      below_threshold_before: belowThresholdBefore,
      below_threshold_after: belowThresholdAfter
    }
  };
}

// ═══ Helper ═══

function clampScore(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n * 10) / 10));
}
