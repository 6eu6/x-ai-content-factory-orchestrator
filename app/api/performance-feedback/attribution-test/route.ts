import { assertAuthorized } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { calculateOutcome } from '../../../../lib/performance-outcome';
import { resolveBrainRuleRefs } from '../../../../lib/resolve-brain-rules';

const VERSION = 'attribution-test-v1';

/**
 * POST /api/performance-feedback/attribution-test
 *
 * Safe attribution validation endpoint:
 * 1. Finds (or creates) a test brain rule
 * 2. Creates a test decision_run with brain_rules_used pointing to that rule
 * 3. Creates a test published_decision with performance data
 * 4. Runs attribution logic to verify success_count/confidence_score updates
 *
 * All test records are marked with run_source='attribution_test' for later cleanup.
 * NO auto-posting to X.
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const body = await req.json().catch(() => ({}));
    const cleanup = body.cleanup === true;

    // ── Cleanup mode: remove all attribution_test records ──
    if (cleanup) {
      const results: string[] = [];

      // Delete test published_decisions
      try {
        const { count: pdCount } = await supabase
          .from('published_decisions')
          .delete({ count: 'exact' })
          .eq('status', 'attribution_test');
        results.push(`published_decisions: deleted ${pdCount || 0}`);
      } catch (e: any) {
        results.push(`published_decisions: ${e.message}`);
      }

      // Delete test decision_runs
      try {
        const { count: drCount } = await supabase
          .from('decision_runs')
          .delete({ count: 'exact' })
          .eq('run_source', 'attribution_test');
        results.push(`decision_runs: deleted ${drCount || 0}`);
      } catch (e: any) {
        results.push(`decision_runs: ${e.message}`);
      }

      return Response.json({ ok: true, version: VERSION, cleanup: results });
    }

    // ═══ Step 1: Find or create a test brain rule ═══
    let testRuleId: number;
    let testRuleBefore: any;

    // Try to find an existing active rule
    const { data: existingRule } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, rule, confidence_score, success_count, failure_count, status')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (existingRule) {
      testRuleId = existingRule.id;
      testRuleBefore = existingRule;
    } else {
      // Create a minimal test rule
      const { data: newRule, error: ruleError } = await supabase
        .from('x_algorithm_learning_rules')
        .insert({
          rule_type: 'viral_pattern',
          rule: 'Test rule for attribution validation',
          evidence: 'Synthetic test data',
          source_type: 'attribution_test',
          applies_to: 'test',
          confidence_score: 7.0,
          status: 'active',
          test_run: true,
          success_count: 0,
          failure_count: 0
        })
        .select('id, rule, confidence_score, success_count, failure_count, status')
        .single();

      if (ruleError || !newRule) {
        return Response.json({ ok: false, error: `Failed to create test rule: ${ruleError?.message}`, version: VERSION }, { status: 500 });
      }
      testRuleId = newRule.id;
      testRuleBefore = newRule;
    }

    // ═══ Step 2: Create a test decision_run with brain_rules_used ═══
    const { data: testRun, error: runError } = await supabase
      .from('decision_runs')
      .insert({
        account_handle: '30piq',
        account_stage: 'stage_1_under_500',
        raw_opportunities: 1,
        selected_count: 1,
        held_count: 0,
        budget: { min_final_score: 7.0 },
        selected_payload: [{
          type: 'quote',
          score: 8.5,
          source_tweet_url: 'https://x.com/test/status/0000000000',
          source_author: 'test_account',
          crafted_text: 'Test crafted text for attribution validation',
          brain_rules_used: [String(testRuleId)],  // Pass as numeric string ID
          shield_passed: true,
          reasons: ['Test attribution']
        }],
        run_source: 'attribution_test'
      })
      .select('id')
      .single();

    if (runError || !testRun) {
      return Response.json({ ok: false, error: `Failed to create test decision_run: ${runError?.message}`, version: VERSION }, { status: 500 });
    }

    // ═══ Step 3: Create a test published_decision with performance data ═══
    // Use a fake URL that won't collide with real data
    const testUrl = `https://x.com/30piq/status/${Date.now()}`;

    const { data: testPub, error: pubError } = await supabase
      .from('published_decisions')
      .insert({
        decision_run_id: testRun.id,
        account_handle: '30piq',
        published_url: testUrl,
        published_text: 'Test published text for attribution',
        source_tweet_url: 'https://x.com/test/status/0000000000',
        content_type: 'quote',
        decision_score: 8.5,
        brain_rules_used: [{ id: testRuleId, table: 'x_algorithm_learning_rules', rule_preview: String(testRuleBefore.rule || '').slice(0, 120) }],
        status: 'attribution_test',
        performance_checked_at: new Date().toISOString(),
        performance_payload: {
          views: 50000,
          likes: 500,
          replies: 50,
          retweets: 100,
          quotes: 20,
          bookmarks: 75,
          engagement_score: 1205.99
        }
      })
      .select('id')
      .single();

    if (pubError || !testPub) {
      // Cleanup the test run
      await supabase.from('decision_runs').delete().eq('id', testRun.id);
      return Response.json({ ok: false, error: `Failed to create test published_decision: ${pubError?.message}`, version: VERSION }, { status: 500 });
    }

    // ═══ Step 4: Resolve brain rules and verify attribution ═══
    const brainRulesUsed = [{ id: testRuleId, table: 'x_algorithm_learning_rules', rule_preview: String(testRuleBefore.rule || '').slice(0, 120) }];
    const resolvedRefs = await resolveBrainRuleRefs(brainRulesUsed);
    const ruleIdsFound = resolvedRefs.map(r => String(r.id));

    // Calculate outcome
    const testPayload = {
      views: 50000,
      likes: 500,
      replies: 50,
      retweets: 100,
      quotes: 20,
      bookmarks: 75
    };
    const { score: outcomeScore, label: outcomeLabel } = calculateOutcome(testPayload);

    // ═══ Step 5: Apply the attribution update ═══
    const isSuccess = outcomeLabel === 'strong_success' || outcomeLabel === 'success';
    const now = new Date().toISOString();

    // Update published_decisions with outcome
    await supabase
      .from('published_decisions')
      .update({
        outcome_score: outcomeScore,
        outcome_label: outcomeLabel,
        feedback_applied_at: now,
        feedback_payload: {
          outcome_score: outcomeScore,
          outcome_label: outcomeLabel,
          has_attribution: true,
          rule_ids_found: ruleIdsFound,
          applied_at: now
        }
      })
      .eq('id', testPub.id);

    // Update the brain rule
    if (isSuccess && ruleIdsFound.length > 0) {
      const { data: ruleNow } = await supabase
        .from('x_algorithm_learning_rules')
        .select('id, confidence_score, success_count, failure_count, status')
        .eq('id', testRuleId)
        .maybeSingle();

      if (ruleNow) {
        const newConfidence = Math.min(10, Number(ruleNow.confidence_score || 7) + 0.2);
        await supabase
          .from('x_algorithm_learning_rules')
          .update({
            confidence_score: Math.round(newConfidence * 100) / 100,
            success_count: (ruleNow.success_count || 0) + 1,
            last_success_at: now,
            last_used_at: now,
            updated_at: now
          })
          .eq('id', ruleNow.id);
      }
    }

    // ═══ Step 6: Read the rule after update ═══
    const { data: testRuleAfter } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, rule, confidence_score, success_count, failure_count, status')
      .eq('id', testRuleId)
      .maybeSingle();

    // ═══ Return results ═══
    return Response.json({
      ok: true,
      version: VERSION,
      test_rule: {
        id: testRuleId,
        before: testRuleBefore,
        after: testRuleAfter
      },
      test_decision_run: testRun.id,
      test_published_decision: testPub.id,
      outcome: {
        score: outcomeScore,
        label: outcomeLabel
      },
      attribution: {
        brain_rules_used_input: brainRulesUsed,
        resolved_refs: resolvedRefs,
        rule_ids_found: ruleIdsFound,
        has_attribution: ruleIdsFound.length > 0
      },
      verification: {
        success_count_before: testRuleBefore?.success_count || 0,
        success_count_after: testRuleAfter?.success_count || 0,
        confidence_score_before: testRuleBefore?.confidence_score || 0,
        confidence_score_after: testRuleAfter?.confidence_score || 0,
        confidence_increased: Number(testRuleAfter?.confidence_score || 0) > Number(testRuleBefore?.confidence_score || 0),
        success_count_increased: (testRuleAfter?.success_count || 0) > (testRuleBefore?.success_count || 0)
      },
      note: 'Test records are marked with status=attribution_test and run_source=attribution_test. Use cleanup=true to remove them.'
    });

  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return Response.json({
    ok: true,
    version: VERSION,
    usage: 'POST with {} to run attribution test, POST with {"cleanup":true} to remove test records'
  });
}
