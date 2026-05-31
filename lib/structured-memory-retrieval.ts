/**
 * structured-memory-retrieval.ts — Phase M1: Runtime Memory Retrieval
 *
 * Retrieves the most relevant compact memory items for crafting, polishing, and judging.
 * At runtime, only 5-10 memory items are retrieved — never raw logs.
 *
 * Retrieval rules:
 * - Prefer exact source_author match
 * - Prefer topic_key overlap
 * - Prefer high confidence
 * - Prefer recent last_seen_at
 * - Never return more than 10 total memory items
 * - Return compact text only, not raw logs
 */

import { supabaseAdmin } from './supabase';

// ═══ Types ═══

export type MemoryRetrievalInput = {
  source_author?: string;
  source_text?: string;
  recommended_angle?: string;
  candidate_text?: string;
  task_type: 'craft' | 'polish' | 'judge';
  failure_reasons?: string[];
};

export type CompactMemoryItem = {
  rule_type: string;
  pattern: string;
  when_to_use: string;
  when_to_avoid: string;
  suggested_fix: string;
  example_bad: string;
  example_better: string;
  confidence: number;
  support_count: number;
  source_author?: string;
  topic_key?: string;
};

export type SourceAuthorMemoryItem = {
  source_author: string;
  common_topics: string[];
  good_angles: string[];
  bad_angles: string[];
  typical_failure_reasons: Record<string, number>;
  freshness_behavior: Record<string, any>;
  best_reply_strategy?: string;
  best_quote_strategy?: string;
};

export type StructuredMemoryResult = {
  operator_rules: CompactMemoryItem[];
  source_author_memory: SourceAuthorMemoryItem | null;
  anti_patterns: CompactMemoryItem[];
  suggested_fixes: CompactMemoryItem[];
  _meta: {
    total_items: number;
    rules_retrieved_count: number;
    source_memory_used: boolean;
    anti_patterns_used_count: number;
    topic_key_inferred: string;
  };
};

// ═══ Retrieval ═══

/**
 * Retrieve the most relevant structured memory for crafting, polishing, or judging.
 *
 * Returns:
 * - top_operator_rules max 6
 * - source_author_memory max 1
 * - anti_patterns max 4
 * - suggested_fixes max 4
 *
 * Total never exceeds 10 memory items (excluding source_author_memory which is 1 metadata item).
 */
export async function getRelevantStructuredMemory(
  input: MemoryRetrievalInput
): Promise<StructuredMemoryResult> {
  const supabase = supabaseAdmin();

  // Infer topic_key from source_text and recommended_angle
  const topicKey = inferTopicKey(input.source_text || '', input.recommended_angle || '');

  // Determine which rule types to prioritize based on task_type and failure_reasons
  const ruleTypes = inferRuleTypes(input.task_type, input.failure_reasons || []);

  // Build retrieval query
  let rulesQuery = supabase
    .from('compact_operator_rules')
    .select('*')
    .in('rule_type', ruleTypes)
    .order('confidence', { ascending: false })
    .order('last_seen_at', { ascending: false })
    .limit(30); // Over-fetch for filtering, then trim

  // Prefer exact source_author match
  if (input.source_author) {
    // First try: exact author match
    const { data: authorRules } = await supabase
      .from('compact_operator_rules')
      .select('*')
      .in('rule_type', ruleTypes)
      .eq('source_author', input.source_author)
      .order('confidence', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(15);

    // Second: general rules (no specific author)
    const { data: generalRules } = await supabase
      .from('compact_operator_rules')
      .select('*')
      .in('rule_type', ruleTypes)
      .is('source_author', null)
      .order('confidence', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(15);

    // Third: other author rules with topic_key match
    const { data: topicRules } = topicKey
      ? await supabase
          .from('compact_operator_rules')
          .select('*')
          .in('rule_type', ruleTypes)
          .neq('source_author', input.source_author)
          .eq('topic_key', topicKey)
          .order('confidence', { ascending: false })
          .limit(10)
      : { data: [] };

    // Combine and score all rules
    const allRules = [
      ...(authorRules || []).map((r: any) => ({ ...r, _score: scoreRule(r, input, topicKey, 3) })),
      ...(generalRules || []).map((r: any) => ({ ...r, _score: scoreRule(r, input, topicKey, 2) })),
      ...(topicRules || []).map((r: any) => ({ ...r, _score: scoreRule(r, input, topicKey, 1) })),
    ];

    // Sort by retrieval score descending
    allRules.sort((a, b) => b._score - a._score);

    var rules: any[] = allRules;
  } else {
    // No source_author — just get general rules
    const { data } = await rulesQuery;
    var rules: any[] = (data || []).map((r: any) => ({ ...r, _score: scoreRule(r, input, topicKey, 1) }));
    rules.sort((a, b) => b._score - a._score);
  }

  // Categorize rules
  const operatorRules: CompactMemoryItem[] = rules
    .filter(r => r.rule_type === 'winning_angle' || r.rule_type === 'source_pattern')
    .slice(0, 6)
    .map(formatRule);

  const antiPatterns: CompactMemoryItem[] = rules
    .filter(r => r.rule_type === 'anti_pattern')
    .slice(0, 4)
    .map(formatRule);

  const suggestedFixes: CompactMemoryItem[] = rules
    .filter(r => r.rule_type === 'originality_failure' || r.rule_type === 'brief_alignment_failure'
      || r.rule_type === 'usefulness_failure' || r.rule_type === 'freshness_pattern')
    .slice(0, 4)
    .map(formatRule);

  // Enforce max 10 total (operator + anti + fixes)
  const totalRules = operatorRules.length + antiPatterns.length + suggestedFixes.length;
  let trimmedOperator = operatorRules;
  let trimmedAnti = antiPatterns;
  let trimmedFixes = suggestedFixes;

  if (totalRules > 10) {
    // Trim from the end of each category proportionally
    const excess = totalRules - 10;
    // Trim fixes first (least valuable for crafting), then anti-patterns
    if (trimmedFixes.length > excess) {
      trimmedFixes = trimmedFixes.slice(0, trimmedFixes.length - excess);
    } else {
      const remaining = excess - trimmedFixes.length;
      trimmedFixes = [];
      if (trimmedAnti.length > remaining) {
        trimmedAnti = trimmedAnti.slice(0, trimmedAnti.length - remaining);
      } else {
        const stillRemaining = remaining - trimmedAnti.length;
        trimmedAnti = [];
        trimmedOperator = trimmedOperator.slice(0, trimmedOperator.length - stillRemaining);
      }
    }
  }

  // Get source_author_memory
  let sourceAuthorMemory: SourceAuthorMemoryItem | null = null;
  if (input.source_author) {
    const { data: authorMem } = await supabase
      .from('source_author_memory')
      .select('*')
      .eq('source_author', input.source_author)
      .maybeSingle();

    if (authorMem) {
      sourceAuthorMemory = {
        source_author: authorMem.source_author,
        common_topics: authorMem.common_topics || [],
        good_angles: authorMem.good_angles || [],
        bad_angles: authorMem.bad_angles || [],
        typical_failure_reasons: authorMem.typical_failure_reasons || {},
        freshness_behavior: authorMem.freshness_behavior || {},
        best_reply_strategy: authorMem.best_reply_strategy || undefined,
        best_quote_strategy: authorMem.best_quote_strategy || undefined,
      };
    }
  }

  const totalItems = trimmedOperator.length + trimmedAnti.length + trimmedFixes.length;

  return {
    operator_rules: trimmedOperator,
    source_author_memory: sourceAuthorMemory,
    anti_patterns: trimmedAnti,
    suggested_fixes: trimmedFixes,
    _meta: {
      total_items: totalItems,
      rules_retrieved_count: totalItems,
      source_memory_used: sourceAuthorMemory !== null,
      anti_patterns_used_count: trimmedAnti.length,
      topic_key_inferred: topicKey,
    },
  };
}

// ═══ Prompt Builder ═══

/**
 * Build a compact memory section for injection into crafting/polishing prompts.
 * Returns a concise string with max 10 memory items, formatted for prompt injection.
 */
export function buildMemoryPromptSection(memory: StructuredMemoryResult): string {
  if (memory._meta.total_items === 0 && !memory.source_author_memory) {
    return '';
  }

  const sections: string[] = ['═══ Relevant Memory Rules ═══'];

  // Source author memory (if available)
  if (memory.source_author_memory) {
    const sam = memory.source_author_memory;
    sections.push(`\nSource author @${sam.source_author} history:`);
    if (sam.bad_angles.length > 0) {
      sections.push(`- Angles that FAILED: ${sam.bad_angles.slice(0, 3).join('; ')}`);
    }
    if (sam.typical_failure_reasons && Object.keys(sam.typical_failure_reasons).length > 0) {
      const topFailures = Object.entries(sam.typical_failure_reasons)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([reason, count]) => `${reason} (${count}x)`);
      sections.push(`- Common failures: ${topFailures.join(', ')}`);
    }
    if (sam.freshness_behavior?.frequently_stale) {
      sections.push(`- WARNING: This source frequently has stale content. Prefer standalone format.`);
    }
    if (sam.best_reply_strategy) {
      sections.push(`- Best reply strategy: ${sam.best_reply_strategy}`);
    }
    if (sam.best_quote_strategy) {
      sections.push(`- Best quote strategy: ${sam.best_quote_strategy}`);
    }
  }

  // Anti-patterns
  if (memory.anti_patterns.length > 0) {
    sections.push('\nAvoid repeating these failed patterns:');
    for (const ap of memory.anti_patterns) {
      sections.push(`- ${ap.pattern}${ap.suggested_fix ? ' → ' + ap.suggested_fix : ''}`);
    }
  }

  // Suggested fixes
  if (memory.suggested_fixes.length > 0) {
    sections.push('\nSuggested fixes for common failures:');
    for (const sf of memory.suggested_fixes) {
      sections.push(`- [${sf.rule_type}] ${sf.suggested_fix}`);
    }
  }

  // Operator rules
  if (memory.operator_rules.length > 0) {
    sections.push('\nWinning patterns:');
    for (const rule of memory.operator_rules) {
      sections.push(`- ${rule.pattern}${rule.when_to_use ? ' (use when: ' + rule.when_to_use + ')' : ''}`);
    }
  }

  return sections.join('\n');
}

/**
 * Build a compact memory section for near-pass polish prompts.
 * Only includes suggested fixes and anti-patterns relevant to the failure reasons.
 */
export function buildPolishMemorySection(memory: StructuredMemoryResult): string {
  if (memory.suggested_fixes.length === 0 && memory.anti_patterns.length === 0) {
    return '';
  }

  const sections: string[] = ['═══ Memory-Suggested Fixes ═══'];

  if (memory.suggested_fixes.length > 0) {
    sections.push('From previous failures with similar patterns:');
    for (const sf of memory.suggested_fixes) {
      sections.push(`- ${sf.suggested_fix}`);
    }
  }

  if (memory.anti_patterns.length > 0) {
    sections.push('Known anti-patterns to avoid:');
    for (const ap of memory.anti_patterns) {
      sections.push(`- ${ap.pattern}`);
    }
  }

  return sections.join('\n');
}

// ═══ Helpers ═══

export function inferTopicKey(sourceText: string, recommendedAngle: string): string {
  const combined = `${sourceText} ${recommendedAngle}`.toLowerCase();

  const topicPatterns: Array<{ pattern: RegExp; key: string }> = [
    { pattern: /\b(ai agents?)\b/i, key: 'ai_agents' },
    { pattern: /\b(llm|large language model)\b/i, key: 'llm' },
    { pattern: /\b(rag|retrieval.?augmented)\b/i, key: 'rag' },
    { pattern: /\b(fine.?tun)/i, key: 'fine_tuning' },
    { pattern: /\b(embedding|vector)\b/i, key: 'embeddings' },
    { pattern: /\b(mcp|model context protocol)\b/i, key: 'mcp' },
    { pattern: /\b(prompt|prompting)\b/i, key: 'prompting' },
    { pattern: /\b(inference)\b/i, key: 'inference' },
    { pattern: /\b(open.?source)\b/i, key: 'open_source' },
    { pattern: /\b(api)\b/i, key: 'api' },
    { pattern: /\b(agent|agentic)\b/i, key: 'agents' },
    { pattern: /\b(token|context.?window)\b/i, key: 'token_economics' },
    { pattern: /\b(benchmark|eval|evaluation)\b/i, key: 'evaluation' },
    { pattern: /\b(pipeline|workflow|automation)\b/i, key: 'automation' },
    { pattern: /\b(startup|product|saas)\b/i, key: 'product' },
    { pattern: /\b(safety|alignment|guardrail)\b/i, key: 'safety' },
  ];

  for (const { pattern, key } of topicPatterns) {
    if (pattern.test(combined)) return key;
  }

  const words = combined.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return words.slice(0, 3).join('_') || 'general';
}

function inferRuleTypes(taskType: string, failureReasons: string[]): string[] {
  const types = new Set<string>(['anti_pattern']);

  switch (taskType) {
    case 'craft':
      types.add('winning_angle');
      types.add('source_pattern');
      types.add('freshness_pattern');
      break;
    case 'polish':
      types.add('originality_failure');
      types.add('brief_alignment_failure');
      types.add('usefulness_failure');
      types.add('freshness_pattern');
      break;
    case 'judge':
      types.add('originality_failure');
      types.add('brief_alignment_failure');
      types.add('usefulness_failure');
      break;
  }

  // Add specific failure-relevant types
  for (const reason of failureReasons) {
    if (reason.includes('originality')) types.add('originality_failure');
    if (reason.includes('brief_alignment')) types.add('brief_alignment_failure');
    if (reason.includes('usefulness')) types.add('usefulness_failure');
    if (reason.includes('freshness') || reason.includes('stale')) types.add('freshness_pattern');
  }

  return [...types];
}

/**
 * Score a rule for retrieval relevance.
 *
 * Factors:
 * - Exact source_author match: +3
 * - Topic key overlap: +2
 * - Confidence: +confidence
 * - Recent last_seen_at: +recency bonus (max 1)
 * - High support_count: +small bonus (max 0.5)
 */
function scoreRule(
  rule: any,
  input: MemoryRetrievalInput,
  inferredTopicKey: string,
  authorMatchBonus: number
): number {
  let score = 0;

  // Source author match (already handled by query, but add bonus)
  score += authorMatchBonus;

  // Topic key overlap
  if (rule.topic_key && inferredTopicKey && rule.topic_key === inferredTopicKey) {
    score += 2;
  }

  // Confidence (0-1 range, add directly)
  score += (rule.confidence || 0.5);

  // Recency bonus (rules seen in last 7 days get a bonus)
  if (rule.last_seen_at) {
    const daysSinceLastSeen = (Date.now() - new Date(rule.last_seen_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastSeen < 7) {
      score += Math.max(0, 1 - daysSinceLastSeen / 7);
    }
  }

  // Support count bonus (logarithmic, max 0.5)
  if (rule.support_count > 1) {
    score += Math.min(0.5, Math.log2(rule.support_count) * 0.1);
  }

  return score;
}

function formatRule(rule: any): CompactMemoryItem {
  return {
    rule_type: rule.rule_type,
    pattern: rule.pattern,
    when_to_use: rule.when_to_use || '',
    when_to_avoid: rule.when_to_avoid || '',
    suggested_fix: rule.suggested_fix || '',
    example_bad: rule.example_bad || '',
    example_better: rule.example_better || '',
    confidence: rule.confidence || 0.5,
    support_count: rule.support_count || 1,
    source_author: rule.source_author || undefined,
    topic_key: rule.topic_key || undefined,
  };
}
