import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { calculateOutcome, OutcomeLabel } from '../../../lib/performance-outcome';

const VERSION = 'performance-feedback-v1';

const MAX_RULE_UPDATES_PER_RUN = 50;

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

      // Try to find rule IDs from brain_rules_used
      const ruleIdsFound: string[] = [];
      let hasAttribution = false;

      if (brainRulesUsed.length > 0) {
        for (const ref of brainRulesUsed) {
          if (typeof ref === 'string') {
            if (/^\d+$/.test(ref)) {
              ruleIdsFound.push(ref);
            }
          } else if (typeof ref === 'object' && ref !== null) {
            const id = (ref as any).id || (ref as any).rule_id || (ref as any).pattern_id;
            if (id) ruleIdsFound.push(String(id));
          }
        }
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

            for (const ruleId of ruleIdsFound) {
              if (totalRuleUpdates >= MAX_RULE_UPDATES_PER_RUN) {
                warnings.push(`MAX_RULE_UPDATES_REACHED: ${MAX_RULE_UPDATES_PER_RUN}`);
                break;
              }

              // Try x_algorithm_learning_rules first (numeric IDs)
              if (/^\d+$/.test(ruleId)) {
                const { data: rule } = await supabase
                  .from('x_algorithm_learning_rules')
                  .select('id, confidence_score, success_count, failure_count, status')
                  .eq('id', Number(ruleId))
                  .maybeSingle();

                if (rule) {
                  if (isSuccess) {
                    const newConfidence = Math.min(10, Number(rule.confidence_score || 7) + 0.2);
                    await supabase
                      .from('x_algorithm_learning_rules')
                      .update({
                        confidence_score: Math.round(newConfidence * 100) / 100,
                        success_count: (rule.success_count || 0) + 1,
                        last_success_at: now,
                        last_used_at: now,
                        updated_at: now
                      })
                      .eq('id', rule.id);
                    totalRuleUpdates++;
                  } else if (isWeak) {
                    const newConfidence = Math.max(1, Number(rule.confidence_score || 7) - 0.2);
                    const newFailureCount = (rule.failure_count || 0) + 1;
                    const newSuccessCount = rule.success_count || 0;
                    const updates: Record<string, any> = {
                      confidence_score: Math.round(newConfidence * 100) / 100,
                      failure_count: newFailureCount,
                      last_failure_at: now,
                      last_used_at: now,
                      updated_at: now
                    };
                    if (newFailureCount >= 3 && newSuccessCount === 0 && rule.status === 'active') {
                      updates.status = 'watch';
                    }
                    await supabase
                      .from('x_algorithm_learning_rules')
                      .update(updates)
                      .eq('id', rule.id);
                    totalRuleUpdates++;
                  } else {
                    await supabase
                      .from('x_algorithm_learning_rules')
                      .update({ last_used_at: now, updated_at: now })
                      .eq('id', rule.id);
                    totalRuleUpdates++;
                  }
                }
              }

              // Try viral_style_patterns (by numeric ID)
              if (/^\d+$/.test(ruleId)) {
                const { data: pattern } = await supabase
                  .from('viral_style_patterns')
                  .select('id, confidence_score, success_count, failure_count, status')
                  .eq('id', Number(ruleId))
                  .maybeSingle();

                if (pattern) {
                  if (isSuccess) {
                    const newConfidence = Math.min(10, Number(pattern.confidence_score || 7) + 0.2);
                    await supabase
                      .from('viral_style_patterns')
                      .update({
                        confidence_score: Math.round(newConfidence * 100) / 100,
                        success_count: (pattern.success_count || 0) + 1,
                        last_success_at: now,
                        last_used_at: now,
                        updated_at: now
                      })
                      .eq('id', pattern.id);
                    totalRuleUpdates++;
                  } else if (isWeak) {
                    const newConfidence = Math.max(1, Number(pattern.confidence_score || 7) - 0.2);
                    const newFailureCount = (pattern.failure_count || 0) + 1;
                    const newSuccessCount = pattern.success_count || 0;
                    const updates: Record<string, any> = {
                      confidence_score: Math.round(newConfidence * 100) / 100,
                      failure_count: newFailureCount,
                      last_failure_at: now,
                      last_used_at: now,
                      updated_at: now
                    };
                    if (newFailureCount >= 3 && newSuccessCount === 0 && pattern.status === 'active') {
                      updates.status = 'watch';
                    }
                    await supabase
                      .from('viral_style_patterns')
                      .update(updates)
                      .eq('id', pattern.id);
                    totalRuleUpdates++;
                  } else {
                    await supabase
                      .from('viral_style_patterns')
                      .update({ last_used_at: now, updated_at: now })
                      .eq('id', pattern.id);
                    totalRuleUpdates++;
                  }
                }
              }
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
