import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';

function sinceIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const warning_flags: string[] = [];
    const dayAgo = sinceIso(24);

    const { count: totalAccounts } = await supabase
      .from('accounts')
      .select('*', { count: 'exact', head: true });

    const { count: neverScanned } = await supabase
      .from('accounts')
      .select('*', { count: 'exact', head: true })
      .is('last_checked', null);

    const { count: scannedLast24h } = await supabase
      .from('accounts')
      .select('*', { count: 'exact', head: true })
      .gte('last_checked', dayAgo);

    const { data: oldestRows } = await supabase
      .from('accounts')
      .select('last_checked')
      .not('last_checked', 'is', null)
      .order('last_checked', { ascending: true })
      .limit(1);

    let nextToScan: any[] = [];
    let nextError: string | null = null;
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('handle, tier, notes, last_checked, followers, category')
        .order('last_checked', { ascending: true, nullsFirst: true })
        .order('tier', { ascending: true })
        .limit(10);
      if (error) nextError = error.message;
      else nextToScan = data || [];
    } catch (e: any) {
      nextError = e.message;
    }

    const { count: tweetTotal } = await supabase
      .from('viral_tweet_analyses')
      .select('*', { count: 'exact', head: true });

    const { count: tweetLast24h } = await supabase
      .from('viral_tweet_analyses')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', dayAgo);

    const { count: algorithmRulesActive } = await supabase
      .from('x_algorithm_learning_rules')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: stylePatternsActive } = await supabase
      .from('viral_style_patterns')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { data: latestRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, confidence_score, source_type, updated_at')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(10);

    const { data: latestDecisions } = await supabase .from('decision_runs')
      .select('account_stage, raw_opportunities, selected_count, held_count, run_source, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    // ── Published decisions stats ──
    let publishedDecisions: any = { total: 0, unchecked: 0, checked_last_24h: 0, feedback_applied: 0, feedback_pending: 0, outcome_summary: {}, latest: [] };
    try {
      const { count: publishedTotal } = await supabase
        .from('published_decisions')
        .select('*', { count: 'exact', head: true });

      const { count: publishedUnchecked } = await supabase
        .from('published_decisions')
        .select('*', { count: 'exact', head: true })
        .is('performance_checked_at', null);

      const { count: publishedChecked24h } = await supabase
        .from('published_decisions')
        .select('*', { count: 'exact', head: true })
        .gte('performance_checked_at', dayAgo);

      const { count: feedbackApplied } = await supabase
        .from('published_decisions')
        .select('*', { count: 'exact', head: true })
        .not('feedback_applied_at', 'is', null);

      const { count: feedbackPending } = await supabase
        .from('published_decisions')
        .select('*', { count: 'exact', head: true })
        .not('performance_checked_at', 'is', null)
        .is('feedback_applied_at', null);

      // Outcome label breakdown
      const outcomeSummary: Record<string, number> = {};
      try {
        const { data: outcomeData } = await supabase
          .from('published_decisions')
          .select('outcome_label')
          .not('outcome_label', 'is', null);
        for (const row of (outcomeData || [])) {
          const label = row.outcome_label || 'unknown';
          outcomeSummary[label] = (outcomeSummary[label] || 0) + 1;
        }
      } catch {}

      const { data: latestPublished } = await supabase
        .from('published_decisions')
        .select('id, account_handle, published_url, content_type, status, decision_score, outcome_label, outcome_score, performance_payload, created_at, performance_checked_at, feedback_applied_at')
        .order('created_at', { ascending: false })
        .limit(5);

      publishedDecisions = {
        total: publishedTotal || 0,
        unchecked: publishedUnchecked || 0,
        checked_last_24h: publishedChecked24h || 0,
        feedback_applied: feedbackApplied || 0,
        feedback_pending: feedbackPending || 0,
        outcome_summary: outcomeSummary,
        latest: latestPublished || []
      };
    } catch {
      // Table may not exist yet — that's ok
    }

    const total = totalAccounts || 0;
    const never = neverScanned || 0;
    const scanned = scannedLast24h || 0;
    const tweets = tweetTotal || 0;
    const recentTweets = tweetLast24h || 0;
    const rules = algorithmRulesActive || 0;

    if (total === 0) warning_flags.push('NO_ACCOUNTS');
    if (total > 0 && never / total > 0.4) warning_flags.push('MANY_NEVER_SCANNED');
    if (total > 0 && scanned === 0) warning_flags.push('NO_ACCOUNTS_SCANNED_LAST_24H');
    if (tweets === 0) warning_flags.push('NO_TWEETS_ANALYZED');
    if (recentTweets === 0) warning_flags.push('NO_RECENT_TWEETS_ANALYZED');
    if (rules === 0) warning_flags.push('NO_ACTIVE_BRAIN_RULES');
    if (total > 5 && scanned <= 5) warning_flags.push('SCAN_SCOPE_MAY_BE_TOO_SMALL');
    if (nextError) warning_flags.push('NEXT_TO_SCAN_QUERY_ERROR');
    if (publishedDecisions.unchecked > 0) {
      // Check if any are older than 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const staleUnchecked = (publishedDecisions.latest || []).filter(
        (p: any) => !p.performance_checked_at && new Date(p.created_at) < twentyFourHoursAgo
      );
      if (staleUnchecked.length > 0) {
        warning_flags.push('PUBLISHED_DECISIONS_UNCHECKED');
      }
    }
    if (publishedDecisions.feedback_pending > 0) {
      warning_flags.push('FEEDBACK_PENDING');
    }

    return Response.json({
      ok: true,
      generated_at: new Date().toISOString(),
      accounts: {
        total,
        never_scanned: never,
        scanned_last_24h: scanned,
        oldest_last_checked: oldestRows?.[0]?.last_checked || null,
        next_to_scan: nextToScan,
        next_to_scan_error: nextError
      },
      tweets: {
        viral_tweet_analyses_total: tweets,
        last_24h: recentTweets
      },
      brain: {
        algorithm_rules_active: rules,
        style_patterns_active: stylePatternsActive || 0,
        latest_rules: latestRules || []
      },
      decisions: {
        latest: latestDecisions || []
      },
      published_decisions: publishedDecisions,
      warning_flags
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
