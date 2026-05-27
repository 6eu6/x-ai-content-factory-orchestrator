/**
 * resolve-brain-rules.ts — Resolve text-based brain_rules_used references to DB IDs
 *
 * ContentOpportunity.brain_rules_used is string[] (rule text, not IDs).
 * This module resolves those text references to actual rule IDs from
 * x_algorithm_learning_rules and viral_style_patterns tables.
 *
 * Strategy:
 * 1. Exact match on `rule` column first
 * 2. ILIKE match on first 80 chars of the rule
 * 3. For patterns: match on `pattern_name` or `pattern_description`
 *
 * Output: array of { id, table, rule_preview } objects
 */

import { supabaseAdmin } from './supabase';

export type ResolvedBrainRuleRef = {
  id: number;
  table: 'x_algorithm_learning_rules' | 'viral_style_patterns';
  rule_preview: string;
};

/**
 * Resolve an array of brain_rules_used (strings or objects) into
 * concrete { id, table, rule_preview } references.
 *
 * If a reference is already an object with `id` and `table`, use directly.
 * If it's a numeric string, treat it as an x_algorithm_learning_rules ID.
 * If it's a text string, try to match against rules in the DB.
 */
export async function resolveBrainRuleRefs(
  brainRulesUsed: any[],
  maxRefs = 20
): Promise<ResolvedBrainRuleRef[]> {
  if (!Array.isArray(brainRulesUsed) || brainRulesUsed.length === 0) {
    return [];
  }

  const refs = brainRulesUsed.slice(0, maxRefs);
  const resolved: ResolvedBrainRuleRef[] = [];
  const supabase = supabaseAdmin();

  // Pre-fetch active rules for matching (batch, one query)
  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('id, rule, rule_type, confidence_score')
    .eq('status', 'active')
    .limit(200);

  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('id, pattern_name, pattern_description, confidence_score')
    .eq('status', 'active')
    .limit(200);

  for (const ref of refs) {
    // ── Already resolved object with id + table ──
    if (typeof ref === 'object' && ref !== null) {
      const id = ref.id || ref.rule_id || ref.pattern_id;
      if (id) {
        const table: ResolvedBrainRuleRef['table'] =
          ref.table === 'viral_style_patterns' ? 'viral_style_patterns' : 'x_algorithm_learning_rules';
        resolved.push({
          id: Number(id),
          table,
          rule_preview: String(ref.rule_preview || ref.rule || ref.pattern_name || `ID ${id}`).slice(0, 120)
        });
        continue;
      }
    }

    // ── Numeric string → direct ID lookup ──
    if (typeof ref === 'string' && /^\d+$/.test(ref.trim())) {
      const numId = Number(ref.trim());
      // Try algorithm rules first
      const algoMatch = (algoRules || []).find((r: any) => r.id === numId);
      if (algoMatch) {
        resolved.push({
          id: numId,
          table: 'x_algorithm_learning_rules',
          rule_preview: String(algoMatch.rule || '').slice(0, 120)
        });
        continue;
      }
      // Try style patterns
      const styleMatch = (stylePatterns || []).find((p: any) => p.id === numId);
      if (styleMatch) {
        resolved.push({
          id: numId,
          table: 'viral_style_patterns',
          rule_preview: String(styleMatch.pattern_name || '').slice(0, 120)
        });
        continue;
      }
      // ID not found — skip (don't error)
      continue;
    }

    // ── Text string → fuzzy matching ──
    if (typeof ref === 'string' && ref.trim().length > 0) {
      const text = ref.trim();

      // 1. Exact match on rule column
      const exactAlgo = (algoRules || []).find((r: any) =>
        r.rule === text
      );
      if (exactAlgo) {
        resolved.push({
          id: exactAlgo.id,
          table: 'x_algorithm_learning_rules',
          rule_preview: String(exactAlgo.rule).slice(0, 120)
        });
        continue;
      }

      // 2. ILIKE on first 80 chars
      const prefix = text.slice(0, 80).toLowerCase();
      const prefixAlgo = (algoRules || []).find((r: any) =>
        String(r.rule || '').toLowerCase().startsWith(prefix)
      );
      if (prefixAlgo) {
        resolved.push({
          id: prefixAlgo.id,
          table: 'x_algorithm_learning_rules',
          rule_preview: String(prefixAlgo.rule).slice(0, 120)
        });
        continue;
      }

      // 3. Substring match (contains)
      const substrAlgo = (algoRules || []).find((r: any) =>
        String(r.rule || '').toLowerCase().includes(prefix.slice(0, 40))
      );
      if (substrAlgo) {
        resolved.push({
          id: substrAlgo.id,
          table: 'x_algorithm_learning_rules',
          rule_preview: String(substrAlgo.rule).slice(0, 120)
        });
        continue;
      }

      // 4. Match against style patterns (pattern_name or pattern_description)
      const exactStyle = (stylePatterns || []).find((p: any) =>
        p.pattern_name === text || p.pattern_name?.toLowerCase() === text.toLowerCase()
      );
      if (exactStyle) {
        resolved.push({
          id: exactStyle.id,
          table: 'viral_style_patterns',
          rule_preview: String(exactStyle.pattern_name).slice(0, 120)
        });
        continue;
      }

      const substrStyle = (stylePatterns || []).find((p: any) =>
        String(p.pattern_name || '').toLowerCase().includes(prefix.slice(0, 40)) ||
        String(p.pattern_description || '').toLowerCase().includes(prefix.slice(0, 40))
      );
      if (substrStyle) {
        resolved.push({
          id: substrStyle.id,
          table: 'viral_style_patterns',
          rule_preview: String(substrStyle.pattern_name).slice(0, 120)
        });
        continue;
      }

      // No match found — this text rule doesn't have a DB entry yet.
      // We skip it silently (it may be a transient rule from AI analysis).
    }
  }

  // Deduplicate by (id, table)
  const seen = new Set<string>();
  const unique = resolved.filter(r => {
    const key = `${r.table}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique;
}

/**
 * Pure function: extract resolvable IDs from brain_rules_used without DB access.
 * Used for quick checks where we don't need full resolution.
 */
export function extractKnownRuleIds(brainRulesUsed: any[]): string[] {
  if (!Array.isArray(brainRulesUsed)) return [];

  const ids: string[] = [];
  for (const ref of brainRulesUsed) {
    if (typeof ref === 'string' && /^\d+$/.test(ref.trim())) {
      ids.push(ref.trim());
    } else if (typeof ref === 'object' && ref !== null) {
      const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
      if (id) ids.push(String(id));
    }
  }
  return ids;
}
