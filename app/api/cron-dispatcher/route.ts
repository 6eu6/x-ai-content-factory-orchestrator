import { assertAuthorized, optionalEnv, envNumber } from '../../../lib/env';
import { scanXAccounts } from '../../../lib/content-engine-v3';
import { decideTelegramOpportunities, stageFromFollowerCount } from '../../../lib/decision-engine';
import { supabaseAdmin } from '../../../lib/supabase';
import { enrichOpportunitiesWithRulePerformance } from '../../../lib/enrich-opportunities-with-rule-performance';
import { filterPublishableOpportunities } from '../../../lib/content-policy';
import type { ContentOpportunity } from '../../../lib/content-engine-v3';

// ═══ Error sanitization — never leak secrets ═══

const SECRET_PATTERNS = [
  /TWITTERAPI_IO_KEY/gi,
  /ORCHESTRATOR_SECRET/gi,
  /OPENAI_API_KEY/gi,
  /SUPABASE_SERVICE_ROLE_KEY/gi,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /eyJ[a-zA-Z0-9_-]{20,}/g,  // JWT-like tokens
];

function sanitizeError(message: string): string {
  let safe = message;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, '[REDACTED]');
  }
  // Truncate very long error messages
  if (safe.length > 500) safe = safe.slice(0, 500) + '...';
  return safe;
}

type ExternalError = {
  provider: 'twitterapi.io' | 'openrouter' | 'supabase';
  phase: string;
  status?: number;
  message: string;
  response_preview?: string;
};

type TimingInfo = {
  started_at: string;
  scan_ms?: number;
  enrichment_ms?: number;
  decision_ms?: number;
  total_ms?: number;
};

async function getFollowerStage(username: string) {
  try {
    const { getXUserByUsername } = await import('../../../lib/x');
    const snapshot = await getXUserByUsername(username);
    return {
      followers: snapshot?.followers_count || 0,
      stage: stageFromFollowerCount(snapshot?.followers_count || 0)
    };
  } catch {
    return { followers: 0, stage: stageFromFollowerCount(0) };
  }
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  const timings: TimingInfo = { started_at: new Date(startedAt).toISOString() };
  const externalErrors: ExternalError[] = [];
  let partial = false;
  let partialReason: string | null = null;

  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'manual';
    const notify = url.searchParams.get('notify') === '1';
    const username = optionalEnv('X_USERNAME', '30piq');

    // ═══ Phase 6.1: Lighter limits for cron ═══
    const accountLimit = envNumber('CRON_SCAN_ACCOUNT_LIMIT', 2, 1, 15);
    const tweetsPerAccount = envNumber('CRON_SCAN_TWEETS_PER_ACCOUNT', 3, 1, 15);
    const maxRuntimeMs = envNumber('CRON_MAX_RUNTIME_MS', 45000, 10000, 120000);

    // ═══ 1. Scan with lightMode ═══
    let scanResult;
    const scanStart = Date.now();
    try {
      scanResult = await scanXAccounts(accountLimit, tweetsPerAccount, { lightMode: true });
      timings.scan_ms = Date.now() - scanStart;

      // ═══ Runtime guard: check if we're approaching the limit ═══
      if (Date.now() - startedAt > maxRuntimeMs * 0.8) {
        partial = true;
        partialReason = 'runtime_guard_reached';
      }
    } catch (scanErr: any) {
      timings.scan_ms = Date.now() - scanStart;
      const errMsg = sanitizeError(scanErr.message || 'Unknown scan error');

      // Detect provider from error message
      if (/twitterapi|api\.twitterapi/i.test(errMsg)) {
        externalErrors.push({
          provider: 'twitterapi.io',
          phase: 'scan',
          status: scanErr.status,
          message: errMsg,
          response_preview: sanitizeError(String(scanErr.response_preview || errMsg).slice(0, 200))
        });
      } else if (/openrouter|openai/i.test(errMsg)) {
        externalErrors.push({
          provider: 'openrouter',
          phase: 'scan_deep_analysis',
          message: errMsg
        });
      } else {
        externalErrors.push({
          provider: 'supabase',
          phase: 'scan',
          message: errMsg
        });
      }

      // Return partial result instead of crashing
      return Response.json({
        ok: true,
        partial: true,
        reason: 'scan_failed_gracefully',
        version: 'cron-dispatcher-v2',
        source,
        timings,
        external_errors: externalErrors,
        scan: { account_limit: accountLimit, tweets_per_account: tweetsPerAccount, accounts_scanned: 0, tweets_analyzed: 0, viral_found: 0, raw_opportunities: 0, brain_updates: { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 }, media_downloaded: 0, debug_log: [] },
        decision: { evaluated: 0, selected_if_notify: 0, held: 0, min_final_score: 0, delivery: 'scan_failed', rule_performance: { enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0 } }
      });
    }

    // If runtime guard hit after scan, return early
    if (partial) {
      return Response.json({
        ok: true,
        partial: true,
        reason: partialReason,
        version: 'cron-dispatcher-v2',
        source,
        notify,
        account: { username, followers: 0, stage: 'stage_0_new' },
        timings,
        external_errors: externalErrors,
        scan: {
          account_limit: accountLimit,
          tweets_per_account: tweetsPerAccount,
          accounts_scanned: scanResult.accounts_scanned,
          tweets_analyzed: scanResult.tweets_analyzed,
          viral_found: scanResult.viral_tweets_found,
          raw_opportunities: scanResult.opportunities?.length || 0,
          brain_updates: scanResult.brain_updates,
          media_downloaded: scanResult.media_downloaded,
          light_mode: scanResult.light_mode || true,
          debug_log: (scanResult.debug_log || []).slice(0, 20)
        },
        decision: { evaluated: 0, selected_if_notify: 0, held: 0, min_final_score: 0, delivery: 'partial_run', rule_performance: { enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0 } }
      });
    }

    // ═══ 2. Get follower stage ═══
    const { followers, stage } = await getFollowerStage(username);

    // ═══ 3. Enrich opportunities with rule performance ═══
    let rulePerformanceStats = { enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0 };
    const enrichStart = Date.now();
    try {
      rulePerformanceStats = await enrichOpportunitiesWithRulePerformance(scanResult.opportunities || []);
    } catch (enrichErr: any) {
      externalErrors.push({
        provider: 'supabase',
        phase: 'enrichment',
        message: sanitizeError(enrichErr.message || 'Enrichment failed')
      });
    }
    timings.enrichment_ms = Date.now() - enrichStart;

    // ═══ 4. Publish gate — filter out non-publishable content BEFORE decision ═══
    const publishGate = filterPublishableOpportunities(scanResult.opportunities || []);

    // ═══ 5. Decision — only on gated publishable opportunities ═══
    const decisionStart = Date.now();
    const decision = decideTelegramOpportunities(publishGate.accepted as ContentOpportunity[] || [], stage);
    timings.decision_ms = Date.now() - decisionStart;
    (decision as any)._publishGate = {
      accepted: publishGate.accepted.length,
      rejected: publishGate.rejected.length,
      reasons: publishGate.rejected.slice(0, 5).map(r => r.reason)
    };

    // ═══ 6. Log to Supabase ═══
    const supabase = supabaseAdmin();
    try {
      await supabase.from('decision_runs').insert({
        account_handle: username,
        account_stage: stage,
        raw_opportunities: scanResult.opportunities?.length || 0,
        selected_count: notify ? decision.selected.length : 0,
        held_count: decision.held.length + (notify ? 0 : decision.selected.length),
        budget: { ...decision.budget, publish_gate: (decision as any)._publishGate },
        selected_payload: notify ? decision.selected.slice(0, 5).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          source_author: o.source_author,
          crafted_text: (o.crafted_text || '').slice(0, 280),
          brain_rules_used: (o.brain_rules_used || []).slice(0, 20),
          shield_passed: o.shield_passed ?? null
        })) : [],
        held_summary: decision.held.slice(0, 10).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          rejection_reasons: o.decision_score?.rejection_reasons || []
        })),
        run_source: `cron_dispatcher:${source}${notify ? ':notify' : ':silent'}`
      });
    } catch (dbErr: any) {
      externalErrors.push({
        provider: 'supabase',
        phase: 'log_decision_run',
        message: sanitizeError(dbErr.message || 'DB insert failed')
      });
    }

    timings.total_ms = Date.now() - startedAt;

    return Response.json({
      ok: true,
      partial: false,
      version: 'cron-dispatcher-v2',
      source,
      notify,
      account: { username, followers, stage },
      timings,
      external_errors: externalErrors,
      scan: {
        account_limit: accountLimit,
        tweets_per_account: tweetsPerAccount,
        accounts_scanned: scanResult.accounts_scanned,
        actual_accounts_scanned: scanResult.actual_accounts_scanned ?? scanResult.accounts_scanned,
        manual_tweets_loaded: scanResult.manual_tweets_loaded ?? 0,
        tweets_analyzed: scanResult.tweets_analyzed,
        viral_found: scanResult.viral_tweets_found,
        raw_opportunities: scanResult.opportunities?.length || 0,
        gate_accepted: publishGate.accepted.length,
        gate_rejected: publishGate.rejected.length,
        brain_updates: scanResult.brain_updates,
        media_downloaded: scanResult.media_downloaded,
        light_mode: scanResult.light_mode || true,
        debug_log: (scanResult.debug_log || []).slice(0, 20)
      },
      decision: {
        evaluated: publishGate.accepted.length || 0,
        selected_if_notify: decision.selected.length,
        held: decision.held.length,
        min_final_score: decision.budget.min_final_score,
        delivery: notify ? 'telegram_delivery_requested' : 'silent_learning_only',
        rule_performance: rulePerformanceStats,
        publish_gate: (decision as any)._publishGate
      }
    });
  } catch (err: any) {
    timings.total_ms = Date.now() - startedAt;
    return Response.json({
      ok: false,
      partial: false,
      error: sanitizeError(err.message || 'Unknown error'),
      timings,
      external_errors: externalErrors
    }, { status: 500 });
  }
}
