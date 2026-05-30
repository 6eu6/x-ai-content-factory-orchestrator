/**
 * originality-context.ts — Phase 2G: RAG-Guided Originality & Angle Bank
 *
 * Retrieves originality guidance from project memory to help the crafter and
 * polisher produce sharper, more original angles — instead of generic/familiar
 * text that repeatedly fails on originality_score.
 *
 * Data sources:
 * - rejection_ledger: prior rejected candidates with missing_originality
 * - x_algorithm_learning_rules: viral patterns and concepts
 * - viral_style_patterns: structural/style patterns for originality
 * - system_learning_rules: general system rules
 *
 * This module does NOT:
 * - lower thresholds
 * - bypass shield
 * - add generic viral bait
 * - invent unsupported claims
 */

import { supabaseAdmin } from './supabase';

// ═══ Types ═══

export type OriginalityContextInput = {
  source_text: string;
  source_author?: string;
  brief?: {
    recommended_angle?: string;
    content_format?: string;
    niche_fit_score?: number;
    originality_potential_score?: number;
    publishability_score?: number;
  };
  current_text?: string;
  failure_reasons?: string[];
  max_items?: number;
};

export type RejectedExample = {
  text: string;
  reason: string;
};

export type OriginalityContext = {
  angle_patterns: string[];
  anti_patterns: string[];
  rejected_examples: RejectedExample[];
  successful_frames: string[];
  suggested_twist_types: string[];
  forbidden_generic_frames: string[];
  context_summary: string;
};

export type OriginalityDiagnostics = {
  _originality_context_used: boolean;
  _originality_twist_type_used?: string;
  _originality_strategy?: string;
  _originality_context_items_count: number;
  _avoided_originality_anti_patterns?: string[];
};

// ═══ Twist Taxonomy ═══
// Dynamic categories — NOT hardcoded example text. The model picks which twist
// type fits the source material and applies it with specific details.

export type TwistType = {
  id: string;
  label: string;
  description: string;
  when_to_use: string;
};

export const TWIST_TAXONOMY: TwistType[] = [
  {
    id: 'inversion',
    label: 'Inversion',
    description: 'Everyone thinks X, but the real lever is Y. Flip the conventional take.',
    when_to_use: 'When the source or angle has an obvious/expected interpretation that can be flipped.',
  },
  {
    id: 'mechanism',
    label: 'Mechanism',
    description: 'This works because... Reveal the hidden mechanism behind a surface observation.',
    when_to_use: 'When the source states a fact or trend without explaining WHY it works.',
  },
  {
    id: 'operator_heuristic',
    label: 'Operator Heuristic',
    description: 'When evaluating X, use rule Y. Give a decision-making shortcut.',
    when_to_use: 'When the audience needs a practical filter or rule of thumb, not just information.',
  },
  {
    id: 'cost_of_being_stale',
    label: 'Cost of Being Stale',
    description: 'The hidden cost is... Name the price of inaction or outdated thinking.',
    when_to_use: 'When the source implies a shift but people may underestimate the cost of not adapting.',
  },
  {
    id: 'timeline_shift',
    label: 'Timeline Shift',
    description: 'The important thing changed from A to B. Identify a before/after transition.',
    when_to_use: 'When the source describes a change, evolution, or pivot in an industry or tool.',
  },
  {
    id: 'capability_map',
    label: 'Capability Map',
    description: 'Your mental model expires. Point out when an existing framework no longer applies.',
    when_to_use: 'When the source reveals new capabilities that invalidate old assumptions.',
  },
  {
    id: 'distribution_positioning',
    label: 'Distribution / Positioning',
    description: 'How you distribute this matters more than what you build. Emphasize the channel/positioning angle.',
    when_to_use: 'When the source is about content, reach, audience, or platform dynamics.',
  },
  {
    id: 'constraint_insight',
    label: 'Constraint Insight',
    description: 'The binding constraint is... Identify what is actually limiting progress.',
    when_to_use: 'When the source describes a bottleneck, tradeoff, or limiting factor that others miss.',
  },
  {
    id: 'failure_mode_insight',
    label: 'Failure Mode Insight',
    description: 'The common failure mode is... Name the specific way most people get this wrong.',
    when_to_use: 'When the source describes something that often goes wrong or is commonly misunderstood.',
  },
];

// ═══ Rejection reason filters ═══

const ORIGINALITY_RELATED_REASONS = [
  'missing_originality',
  'originality_score',
  'generic_only',
  'low_originality_potential',
  'brief_alignment_failed',
  'generic_bait_flag',
];

function isOriginalityRelated(reason: string): boolean {
  return ORIGINALITY_RELATED_REASONS.some(filter =>
    reason.toLowerCase().includes(filter.toLowerCase())
  );
}

// ═══ Twist Selection ═══

/**
 * Suggest 2–3 twist types based on the brief and source context.
 * Not random — picks based on relevance to the content type and angle.
 */
export function suggestTwistTypes(
  brief?: OriginalityContextInput['brief'],
  failureReasons?: string[]
): TwistType[] {
  const reasons = (failureReasons || []).join(' ').toLowerCase();
  const angle = (brief?.recommended_angle || '').toLowerCase();
  const format = (brief?.content_format || '').toLowerCase();

  const scored = TWIST_TAXONOMY.map(twist => {
    let score = 0;

    // If failed on originality, prioritize the most originality-inducing twists
    if (reasons.includes('originality')) {
      if (twist.id === 'inversion') score += 3;
      if (twist.id === 'mechanism') score += 2;
      if (twist.id === 'failure_mode_insight') score += 2;
      if (twist.id === 'constraint_insight') score += 2;
      if (twist.id === 'capability_map') score += 1;
      if (twist.id === 'timeline_shift') score += 1;
    }

    // If generic_bait, prioritize mechanism and constraint (most analytical)
    if (reasons.includes('generic_bait') || reasons.includes('generic_only')) {
      if (twist.id === 'mechanism') score += 3;
      if (twist.id === 'constraint_insight') score += 2;
      if (twist.id === 'operator_heuristic') score += 2;
    }

    // Angle-based relevance
    if (angle.includes('shift') || angle.includes('change') || angle.includes('pivot')) {
      if (twist.id === 'timeline_shift') score += 2;
    }
    if (angle.includes('why') || angle.includes('because') || angle.includes('mechanism')) {
      if (twist.id === 'mechanism') score += 2;
    }
    if (angle.includes('cost') || angle.includes('risk') || angle.includes('danger')) {
      if (twist.id === 'cost_of_being_stale') score += 2;
    }
    if (angle.includes('wrong') || angle.includes('mistake') || angle.includes('fail')) {
      if (twist.id === 'failure_mode_insight') score += 2;
    }
    if (angle.includes('distribut') || angle.includes('reach') || angle.includes('platform')) {
      if (twist.id === 'distribution_positioning') score += 2;
    }

    // Format-based: quotes benefit from inversion, replies from heuristics
    if (format === 'quote') {
      if (twist.id === 'inversion') score += 1;
      if (twist.id === 'capability_map') score += 1;
    }
    if (format === 'reply') {
      if (twist.id === 'operator_heuristic') score += 1;
      if (twist.id === 'failure_mode_insight') score += 1;
    }

    return { twist, score };
  });

  // Return top 3 by score, with minimum score of 1
  return scored
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.twist);
}

// ═══ Forbidden Generic Frames ═══
// These are frames that consistently produce low-originality content.
// NOT hardcoded examples — these are structural patterns to avoid.

export const FORBIDDEN_GENERIC_FRAMES = [
  'X is changing everything about Y',
  'The future of X is Y',
  'X is a game changer for Y',
  'X just got real',
  'Here is why X matters',
  'X is the new Y',
  'If you are in X, pay attention',
  'X is not just about Y anymore',
  'This changes everything',
  'The real story behind X',
];

// ═══ Core Retriever ═══

/**
 * getOriginalityContext — Retrieves originality guidance from project memory.
 *
 * Queries:
 * 1. rejection_ledger for recent originality-related rejections (anti-patterns)
 * 2. x_algorithm_learning_rules for relevant viral patterns (angle patterns)
 * 3. viral_style_patterns for structural patterns that boost originality
 * 4. system_learning_rules for general guidance
 *
 * All queries are bounded by max_items, ordered by recency/confidence.
 * Never throws — returns empty context on DB errors.
 */
export async function getOriginalityContext(
  input: OriginalityContextInput
): Promise<OriginalityContext> {
  const maxItems = input.max_items || 8;
  const supabase = supabaseAdmin();

  // Run all queries in parallel for efficiency, wrapped in try/catch for safety
  const [rejectionResult, rulesResult, patternsResult, systemRulesResult] = await Promise.all([
    // 1. Rejection ledger — recent originality-related rejections
    supabase
      .from('rejection_ledger')
      .select('crafted_text_preview, rejection_reason, shield_reason, created_at')
      .or(ORIGINALITY_RELATED_REASONS.map(r => `rejection_reason.ilike.%${r}%`).join(','))
      .order('created_at', { ascending: false })
      .limit(maxItems)
      .then(r => r, () => ({ data: null }) as any),

    // 2. Algorithm learning rules — relevant concepts
    supabase
      .from('x_algorithm_learning_rules')
      .select('rule, rule_type, evidence, confidence_score, applies_to')
      .eq('status', 'active')
      .or('applies_to.ilike.%content_strategy%,applies_to.ilike.%engagement_crafting%,applies_to.ilike.%viral_mechanics%')
      .order('confidence_score', { ascending: false })
      .limit(maxItems)
      .then(r => r, () => ({ data: null }) as any),

    // 3. Viral style patterns — structural patterns
    supabase
      .from('viral_style_patterns')
      .select('pattern_name, pattern_type, pattern_description, why_it_works, adaptation_for_30piq, confidence_score')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(Math.min(maxItems, 5))
      .then(r => r, () => ({ data: null }) as any),

    // 4. System learning rules
    supabase
      .from('system_learning_rules')
      .select('rule, rule_type, evidence, applies_to')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(Math.min(maxItems, 4))
      .then(r => r, () => ({ data: null }) as any),
  ]);

  // Build rejected examples (anti-patterns from rejection ledger)
  const rejectedExamples: RejectedExample[] = (rejectionResult?.data || []).map((row: any) => ({
    text: String(row.crafted_text_preview || '').slice(0, 200),
    reason: String(row.rejection_reason || row.shield_reason || 'unknown'),
  }));

  // Build anti-patterns from rejection reasons
  const antiPatterns: string[] = [];
  const seenReasons = new Set<string>();
  for (const ex of rejectedExamples) {
    const normalizedReason = ex.reason.split('_').slice(0, 2).join('_');
    if (!seenReasons.has(normalizedReason)) {
      seenReasons.add(normalizedReason);
      antiPatterns.push(ex.reason);
    }
  }

  // Build angle patterns from algorithm rules
  const anglePatterns: string[] = (rulesResult?.data || []).map((row: any) => {
    const rule = String(row.rule || '');
    const evidence = String(row.evidence || '');
    return evidence ? `${rule} — because: ${evidence.slice(0, 100)}` : rule;
  });

  // Build successful frames from style patterns
  const successfulFrames: string[] = (patternsResult?.data || []).map((row: any) => {
    const name = String(row.pattern_name || '');
    const why = String(row.why_it_works || '');
    const adaptation = String(row.adaptation_for_30piq || '');
    return adaptation ? `${name}: ${adaptation.slice(0, 120)}` : (why ? `${name}: ${why.slice(0, 120)}` : name);
  });

  // Add system rules as additional angle patterns
  const systemRules = (systemRulesResult?.data || []).map((row: any) =>
    String(row.rule || '')
  );
  anglePatterns.push(...systemRules);

  // Suggest twist types based on brief and failure reasons
  const suggestedTwistTypes = suggestTwistTypes(input.brief, input.failure_reasons);

  // Build context summary — concise paragraph for the prompt
  const twistLabels = suggestedTwistTypes.map(t => t.label).join(', ');
  const contextSummary = [
    `Originality context: ${anglePatterns.length} patterns, ${rejectedExamples.length} rejection examples, ${successfulFrames.length} style frames.`,
    suggestedTwistTypes.length > 0
      ? `Suggested twist types: ${twistLabels}.`
      : 'No specific twist type suggested — use your best judgment.',
    antiPatterns.length > 0
      ? `Known anti-patterns: ${antiPatterns.slice(0, 3).join('; ')}.`
      : '',
    successfulFrames.length > 0
      ? `Effective frames: ${successfulFrames.slice(0, 2).join('; ')}.`
      : '',
  ].filter(Boolean).join(' ');

  return {
    angle_patterns: anglePatterns.slice(0, maxItems),
    anti_patterns: antiPatterns.slice(0, maxItems),
    rejected_examples: rejectedExamples.slice(0, maxItems),
    successful_frames: successfulFrames.slice(0, maxItems),
    suggested_twist_types: suggestedTwistTypes.map(t => `${t.id}: ${t.description}`),
    forbidden_generic_frames: FORBIDDEN_GENERIC_FRAMES,
    context_summary: contextSummary,
  };
}

// ═══ Prompt Builder ═══

/**
 * Build an ORIGINALITY CONTEXT section for insertion into crafting or polish prompts.
 * This is a ready-to-insert prompt block, not raw data.
 */
export function buildOriginalityPromptSection(context: OriginalityContext): string {
  const twistSection = context.suggested_twist_types.length > 0
    ? `SUGGESTED TWIST TYPES (pick ONE that fits best — do NOT force a twist that does not fit the source):\n${context.suggested_twist_types.map(t => `- ${t}`).join('\n')}`
    : 'Use your best judgment for an original angle.';

  const antiPatternSection = context.anti_patterns.length > 0
    ? `KNOWN ANTI-PATTERNS (these frames have been rejected before — do NOT reproduce them):\n${context.anti_patterns.slice(0, 5).map(a => `- ${a}`).join('\n')}`
    : '';

  const rejectedSection = context.rejected_examples.length > 0
    ? `REJECTED EXAMPLES (these tweets were rejected for low originality — study what went wrong, do NOT imitate):\n${context.rejected_examples.slice(0, 3).map(e => `- "${e.text.slice(0, 120)}" → reason: ${e.reason}`).join('\n')}`
    : '';

  const forbiddenSection = context.forbidden_generic_frames.length > 0
    ? `FORBIDDEN GENERIC FRAMES (do NOT use these sentence structures — they are originality killers):\n${context.forbidden_generic_frames.map(f => `- "${f}"`).join('\n')}`
    : '';

  const framesSection = context.successful_frames.length > 0
    ? `EFFECTIVE FRAMES (these patterns have worked — adapt their STRUCTURE, not their words):\n${context.successful_frames.slice(0, 3).map(f => `- ${f}`).join('\n')}`
    : '';

  return `═══ ORIGINALITY CONTEXT ═══

${context.context_summary}

${twistSection}

${antiPatternSection}

${rejectedSection}

${forbiddenSection}

${framesSection}

ORIGINALITY RULES:
- Your crafted text must include at least ONE of: a contrast, a mechanism, a heuristic, or a specific operator takeaway.
- Do NOT simply summarize the source or rephrase the brief angle.
- Do NOT use any of the forbidden generic frames above.
- Use the chosen twist type to add a SHARPER frame — not just different words, but a different THINKING STRUCTURE.
- Keep evidence safe: do NOT invent claims not supported by the source or required_context.`;
}

// ═══ Validation ═══

/**
 * Check if a crafted text includes at least one originality indicator.
 * Returns the detected indicators, or empty if none found.
 */
export function detectOriginalityIndicators(text: string): string[] {
  const indicators: string[] = [];
  const lower = text.toLowerCase();

  // Contrast indicators
  if (/\b(but|however|actually|instead of|rather than|not.*but|contrary to|the opposite)\b/i.test(text)) {
    indicators.push('contrast');
  }

  // Mechanism indicators
  if (/\b(because|works by|mechanism|the reason|underlying|driven by|comes from|caused by|root cause)\b/i.test(text)) {
    indicators.push('mechanism');
  }

  // Heuristic indicators
  if (/\b(rule of thumb|heuristic|when you|if you|always|never|the key is|the trick|the signal|watch for)\b/i.test(text)) {
    indicators.push('heuristic');
  }

  // Operator takeaway indicators
  if (/\b(do this|try|start|stop|switch|build|use|avoid|skip|your move|your play|the play|the move)\b/i.test(text)) {
    indicators.push('operator_takeaway');
  }

  // Cost/negative consequence indicators
  if (/\b(cost|penalty|risk|downside|trap|pitfall|danger|the catch|the hidden|expensive)\b/i.test(text)) {
    indicators.push('cost_insight');
  }

  // Specificity indicators — contains specific technical terms, numbers with context, or named concepts
  if (/\b(RAG|LLM|API|MCP|fine-tun|embed|vector|prompt|agent|token|inference|batch|pipeline|workflow)\b/i.test(text)) {
    indicators.push('technical_specificity');
  }

  return indicators;
}

/**
 * Validate originality-related output fields from crafting response.
 */
export function validateOriginalityOutput(parsed: any): {
  originality_strategy: string;
  twist_type_used: string;
  avoided_anti_patterns: string[];
  missing_originality_diagnostic?: string;
} {
  const originality_strategy = String(parsed.originality_strategy || parsed.originality_strategy || '').trim();
  const twist_type_used = String(parsed.twist_type_used || '').trim();
  const avoided_anti_patterns = Array.isArray(parsed.avoided_anti_patterns)
    ? parsed.avoided_anti_patterns.map(String)
    : [];

  const result: any = {
    originality_strategy,
    twist_type_used,
    avoided_anti_patterns,
  };

  // Diagnostic: if no twist type and no strategy, flag it
  if (!twist_type_used && !originality_strategy) {
    result.missing_originality_diagnostic = 'no_twist_type_or_strategy_declared';
  }

  return result;
}
