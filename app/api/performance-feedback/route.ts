import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { calculateOutcome, OutcomeLabel } from '../../../lib/performance-outcome';
import { resolveBrainRuleRefs, extractKnownRuleIds, ResolvedBrainRuleRef } from '../../../lib/resolve-brain-rules';

const VERSION = 'performance-feedback-v1.1';

const MAX_RULE_UPDATES_PER_RUN = 50;

/**
 * Safe update for brain rule confidence_score.
 * Tries NUMERIC first, falls back to INTEGER if column is INTEGER.
 * Returns true if update succeeded.
 */
async function safeUpdateRuleConfidence(
  supabase: any,
  table: 'x_algorithm_learning_rules' | 'viral_style_patterns',
  ruleId: string,
  updates: {
    confidence_score?: number;
    success_count?: number;
    failure_count?: number;
    last_success_at?: string;
    last_failure_at?: string;
    last_used_at?: string;
    status?: string;
  }
): Promise<boolean> {
  // Try with NUMERIC confidence + updated_at
  const fullUpdates = { ...updates, updated_at: new Date().toISOString() };
  const { error: err1 } = await supabase
    .from(table)
    .update(fullUpdates)
    .eq('id', ruleId);

  if (!err1) return true;

  // If failed, try with rounded integer confidence (column might be INTEGER)
  if (updates.confidence_score !== undefined) {
    const roundedUpdates = { ...updates, confidence_score: Math.round(updates.confidence_score), updated_at: new Date().toISOString() };
    const { error: err2 } = await supabase
      .from(table)
      .update(roundedUpdates)
      .eq('id', ruleId);

    if (!err2) return true;

    // Last resort: skip confidence update, only update counts/timestamps
    const countOnlyUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (updates.success_count !== undefined) countOnlyUpdates.success_count = updates.success_count;
    if (updates.failure_count !== undefined) countOnlyUpdates.failure_count = updates.failure_count;
    if (updates.last_success_at) countOnlyUpdates.last_success_at = updates.last_success_at;
    if (updates.last_failure_at) countOnlyUpdates.last_failure_at = updates.last_failure_at;
    if (updates.last_used_at) countOnlyUpdates.last_used_at = updates.last_used_at;
    if (updates.status) countOnlyUpdates.status = updates.status;

    const { error: err3 } = await supabase
      .from(table)
      .update(countOnlyUpdates)
      .eq('id', ruleId);

    return !err3;
  }

  // Non-confidence update: just retry without updated_at
  const { error: err4 } = await supabase
    .from(table)
    .update(updates)
    .eq('id', ruleId);

  return !err4;
}

interface OutcomeEntry {
  id: string;
  published_url: string;
  outcome_score: number;
  outcome_label: OutcomeLabel;
  has_attribution: boolean;
  rule_ids_found: string[];
  warning?: string;
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const apply = url.searchParams.get('apply') === '1';
    const mode = apply ? 'apply' : 'dry_run';

    // ── Find published_decisions with performance data but no feedback yet ──
    const { data: checked, error: fetchError } = await supabase
      .from('published_decisions')
      .select('id, published_url, account_handle, performance_payload, brain_rules_used, decision_run_id, content_type, decision_score')
      .not('performance_checked_at', 'is', null)
      .is('feedback_applied_at', null)
      .order('created_at', { ascending: true })
      .limit(20);

    if (fetchError) {
      return Response.json({ ok: false, version: VERSION, error: fetchError.message }, { status: 500 });
    }

    if (!checked || checked.length === 0) {
      return Response.json({
        ok: true,
        version: VERSION,
        mode,
        inspected: 0,
        outcomes: [],
        applied: 0,
        rule_updates: 0,
        warnings: []
      });
    }

    const warnings: string[] = [];
    const outcomes: OutcomeEntry[] = [];
    let applied = 0;
    let totalRuleUpdates = 0;

    for (const pub of checked) {
      const payload = pub.performance_payload || {};
      const hasEngagement = payload.engagement_score !== undefined || payload.views !== undefined;

      if (!hasEngagement) {
        continue; // Skip entries without real performance data
      }

      const { score, label } = calculateOutcome(payload);
      const brainRulesUsed = Array.isArray(pub.brain_rules_used) ? pub.brain_rules_used : [];

      // Try to find rule IDs from brain_rules_used — first check pre-resolved IDs
      let ruleIdsFound: string[] = extractKnownRuleIds(brainRulesUsed);
      let resolvedRefs: ResolvedBrainRuleRef[] = [];
      let hasAttribution = false;

      // If no pre-resolved IDs found, try to resolve text-based rules via DB matching
      if (ruleIdsFound.length === 0 && brainRulesUsed.length > 0) {
        try {
          resolvedRefs = await resolveBrainRuleRefs(brainRulesUsed);
          ruleIdsFound = resolvedRefs.map(r => String(r.id));
        } catch {}
      }

      hasAttribution = ruleIdsFound.length > 0;

      const entry: OutcomeEntry = {
        id: pub.id,
        published_url: pub.published_url,
        outcome_score: score,
        outcome_label: label,
        has_attribution: hasAttribution,
        rule_ids_found: ruleIdsFound
      };

      if (!hasAttribution) {
        entry.warning = 'NO_RULE_ATTRIBUTION';
      }

      // Store resolved refs for later use in apply mode
      const entryResolvedRefs = resolvedRefs;

      outcomes.push(entry);

      // ── Apply mode: update published_decisions ──
      if (apply) {
        const feedbackPayload: Record<string, any> = {
          outcome_score: score,
          outcome_label: label,
          has_attribution: hasAttribution,
          rule_ids_found: ruleIdsFound,
          applied_at: new Date().toISOString()
        };

        const { error: updateError } = await supabase
          .from('published_decisions')
          .update({
            outcome_score: score,
            outcome_label: label,
            feedback_applied_at: new Date().toISOString(),
            feedback_payload: feedbackPayload
          })
          .eq('id', pub.id);

        if (!updateError) {
          applied++;

          // ── Attribution: update brain rules if we have clear IDs ──
          if (hasAttribution && totalRuleUpdates < MAX_RULE_UPDATES_PER_RUN) {
            const isSuccess = label === 'strong_success' || label === 'success';
            const isWeak = label === 'weak';
            const now = new Date().toISOString();

            // Build lookup from resolved refs to determine table per ruleId
            const resolvedByTable = new Map<string, ResolvedBrainRuleRef>();
            for (const rf of entryResolvedRefs) {
              resolvedByTable.set(`${rf.table}:${rf.id}`, rf);
            }

            for (const ruleId of ruleIdsFound) {
              if (totalRuleUpdates >= MAX_RULE_UPDATES_PER_RUN) {
                warnings.push(`MAX_RULE_UPDATES_REACHED: ${MAX_RULE_UPDATES_PER_RUN}`);
                break;
              }

              // ruleId can be UUID or numeric — use as string directly
              // Determine which table(s) this ID belongs to
              // Check resolved refs first (most accurate)
              const algoRef = resolvedByTable.get(`x_algorithm_learning_rules:${ruleId}`);
              const styleRef = resolvedByTable.get(`viral_style_patterns:${ruleId}`);

              // Try x_algorithm_learning_rules
              if (algoRef || !styleRef) {
                const { data: rule } = await supabase
                  .from('x_algorithm_learning_rules')
                  .select('id, confidence_score, success_count, failure_count, status')
                  .eq('id', ruleId)
                  .maybeSingle();

                if (rule) {
                  if (isSuccess) {
                    const newConfidence = Math.min(10, Number(rule.confidence_score || 7) + 0.2);
                    const ok = await safeUpdateRuleConfidence(supabase, 'x_algorithm_learning_rules', String(rule.id), {
                      confidence_score: newConfidence,
                      success_count: (rule.success_count || 0) + 1,
                      last_success_at: now,
                      last_used_at: now
                    });
                    if (ok) totalRuleUpdates++;
                  } else if (isWeak) {
                    const newConfidence = Math.max(1, Number(rule.confidence_score || 7) - 0.2);
                    const newFailureCount = (rule.failure_count || 0) + 1;
                    const newSuccessCount = rule.success_count || 0;
                    const updates: Record<string, any> = {
                      confidence_score: newConfidence,
                      failure_count: newFailureCount,
                      last_failure_at: now,
                      last_used_at: now
                    };
                    if (newFailureCount >= 3 && newSuccessCount === 0 && rule.status === 'active') {
                      updates.status = 'watch';
                    }
                    const ok = await safeUpdateRuleConfidence(supabase, 'x_algorithm_learning_rules', String(rule.id), updates);
                    if (ok) totalRuleUpdates++;
                  } else {
                    const ok = await safeUpdateRuleConfidence(supabase, 'x_algorithm_learning_rules', String(rule.id), {
                      last_used_at: now
                    });
                    if (ok) totalRuleUpdates++;
                  }
                  continue; // Found in algo rules, skip style pattern check for same ID
                }
              }

              // Try viral_style_patterns
              if (styleRef || !algoRef) {
                const { data: pattern } = await supabase
                  .from('viral_style_patterns')
                  .select('id, confidence_score, success_count, failure_count, status')
                  .eq('id', ruleId)
                  .maybeSingle();

                if (pattern) {
                  if (isSuccess) {
                    const newConfidence = Math.min(10, Number(pattern.confidence_score || 7) + 0.2);
                    const ok = await safeUpdateRuleConfidence(supabase, 'viral_style_patterns', String(pattern.id), {
                      confidence_score: newConfidence,
                      success_count: (pattern.success_count || 0) + 1,
                      last_success_at: now,
                      last_used_at: now
                    });
                    if (ok) totalRuleUpdates++;
                  } else if (isWeak) {
                    const newConfidence = Math.max(1, Number(pattern.confidence_score || 7) - 0.2);
                    const newFailureCount = (pattern.failure_count || 0) + 1;
                    const newSuccessCount = pattern.success_count || 0;
                    const updates: Record<string, any> = {
                      confidence_score: newConfidence,
                      failure_count: newFailureCount,
                      last_failure_at: now,
                      last_used_at: now
                    };
                    if (newFailureCount >= 3 && newSuccessCount === 0 && pattern.status === 'active') {
                      updates.status = 'watch';
                    }
                    const ok = await safeUpdateRuleConfidence(supabase, 'viral_style_patterns', String(pattern.id), updates);
                    if (ok) totalRuleUpdates++;
                  } else {
                    const ok = await safeUpdateRuleConfidence(supabase, 'viral_style_patterns', String(pattern.id), {
                      last_used_at: now
                    });
                    if (ok) totalRuleUpdates++;
                  }
                }
              }
            }

            // ── Update published_decisions.brain_rules_used with resolved refs ──
            if (entryResolvedRefs.length > 0) {
              try {
                await supabase
                  .from('published_decisions')
                  .update({
                    brain_rules_used: entryResolvedRefs.map(r => ({
                      id: r.id,
                      table: r.table,
                      rule_preview: r.rule_preview
                    }))
                  })
                  .eq('id', pub.id);
              } catch {}
            }
          }
        }
      }
    }

    // Add aggregate warnings
    const noAttribCount = outcomes.filter(o => !o.has_attribution).length;
    if (noAttribCount > 0) {
      warnings.push(`NO_RULE_ATTRIBUTION: ${noAttribCount}/${outcomes.length} published_decisions have no brain_rules_used to attribute`);
    }

    return Response.json({
      ok: true,
      version: VERSION,
      mode,
      inspected: checked.length,
      outcomes,
      applied,
      rule_updates: totalRuleUpdates,
      warnings
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
