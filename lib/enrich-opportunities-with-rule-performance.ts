/**
 * enrich-opportunities-with-rule-performance.ts
 *
 * Takes ContentOpportunity[], reads brain_rules_used, resolves refs,
 * fetches performance metrics from Supabase, calculates avg_brain_rule_weight,
 * and attaches rule_performance_summary to each opportunity.
 *
 * This is the bridge between rule performance data and the decision engine.
 * It enriches opportunities BEFORE they enter decideTelegramOpportunities,
 * keeping the decision engine pure (no direct Supabase calls).
 */

import { supabaseAdmin } from './supabase';
import { resolveBrainRuleRefs, ResolvedBrainRuleRef } from './resolve-brain-rules';
import { calculateRulePerformanceWeight, summarizeRulePerformance, RulePerformanceInput } from './rule-performance';
import type { ContentOpportunity } from './content-engine-v3';

export type EnrichmentResult = {
  enriched_opportunities: number;
  avg_weight: number;
  boosted_count: number;
  penalized_count: number;
};

/**
 * Enrich opportunities with rule performance data.
 *
 * For each opportunity:
 * 1. Read brain_rules_used (can be text strings, UUIDs, or resolved objects)
 * 2. Resolve text refs to IDs using resolveBrainRuleRefs
 * 3. Fetch confidence_score, success_count, failure_count, status from DB
 * 4. Calculate avg_brain_rule_weight
 * 5. Attach avg_brain_rule_weight and rule_performance_summary
 *
 * Returns enrichment stats for the response.
 */
export async function enrichOpportunitiesWithRulePerformance(
  opportunities: ContentOpportunity[]
): Promise<EnrichmentResult> {
  if (!opportunities || opportunities.length === 0) {
    return { enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0 };
  }

  const supabase = supabaseAdmin();
  let enrichedCount = 0;
  let totalWeight = 0;
  let boostedCount = 0;
  let penalizedCount = 0;

  // Pre-fetch active rules for bulk lookup (avoid N+1 queries)
  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('id, confidence_score, success_count, failure_count, status')
    .eq('status', 'active')
    .limit(500);

  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('id, confidence_score, success_count, failure_count, status')
    .eq('status', 'active')
    .limit(500);

  // Build lookup maps for fast access
  const algoMap = new Map<string, RulePerformanceInput>();
  for (const r of (algoRules || [])) {
    algoMap.set(String(r.id), {
      confidence_score: r.confidence_score,
      success_count: r.success_count,
      failure_count: r.failure_count,
      status: r.status
    });
  }

  const styleMap = new Map<string, RulePerformanceInput>();
  for (const p of (stylePatterns || [])) {
    styleMap.set(String(p.id), {
      confidence_score: p.confidence_score,
      success_count: p.success_count,
      failure_count: p.failure_count,
      status: p.status
    });
  }

  for (const opp of opportunities) {
    const brainRulesUsed = opp.brain_rules_used || [];
    if (!brainRulesUsed.length) {
      // No brain rules used — leave avg_brain_rule_weight undefined
      continue;
    }

    try {
      // Resolve refs (handles text strings, UUIDs, objects)
      let resolvedRefs: ResolvedBrainRuleRef[] = [];
      try {
        resolvedRefs = await resolveBrainRuleRefs(brainRulesUsed);
      } catch {
        // If resolution fails, try extracting known IDs
        const knownIds = brainRulesUsed.filter((r: any) => {
          if (typeof r === 'string') {
            return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.trim()) || /^\d+$/.test(r.trim());
          }
          return typeof r === 'object' && r !== null && (r.id || r.rule_id);
        }).map(r => {
          if (typeof r === 'object' && r !== null) {
            const table = (r as any).table === 'viral_style_patterns' ? 'viral_style_patterns' : 'x_algorithm_learning_rules';
            return { id: String((r as any).id || (r as any).rule_id), table: table as 'x_algorithm_learning_rules' | 'viral_style_patterns', rule_preview: '' };
          }
          // Default assumption: algorithm rules
          return { id: String(r).trim(), table: 'x_algorithm_learning_rules' as const, rule_preview: '' };
        });
        resolvedRefs = knownIds;
      }

      if (!resolvedRefs.length) continue;

      // Collect performance data for each resolved rule
      const rulePerformances: RulePerformanceInput[] = [];
      for (const ref of resolvedRefs) {
        const map = ref.table === 'viral_style_patterns' ? styleMap : algoMap;
        const perf = map.get(String(ref.id));
        if (perf) {
          rulePerformances.push(perf);
        } else {
          // Rule not in pre-fetched batch — use default values
          rulePerformances.push({
            confidence_score: 7,
            success_count: 0,
            failure_count: 0,
            status: 'active'
          });
        }
      }

      // Calculate summary
      const summary = summarizeRulePerformance(rulePerformances);

      // Attach to opportunity
      opp.avg_brain_rule_weight = summary.average_weight;
      opp.rule_performance_summary = {
        matched_rules: summary.matched_rules,
        avg_weight: summary.average_weight,
        strongest_rule: summary.strongest ? (summary.strongest.status || 'active') : null,
        weakest_rule: summary.weakest ? (summary.weakest.status || 'active') : null
      };

      enrichedCount++;
      totalWeight += summary.average_weight;

      // Track boost/penalize
      if (summary.average_weight > 0.6) boostedCount++;
      else if (summary.average_weight < 0.5) penalizedCount++;

    } catch {
      // If enrichment fails for one opportunity, skip it silently
    }
  }

  const avgWeight = enrichedCount > 0
    ? Math.round((totalWeight / enrichedCount) * 100) / 100
    : 0;

  return {
    enriched_opportunities: enrichedCount,
    avg_weight: avgWeight,
    boosted_count: boostedCount,
    penalized_count: penalizedCount
  };
}
