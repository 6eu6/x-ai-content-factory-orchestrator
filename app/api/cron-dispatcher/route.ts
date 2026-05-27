import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { scanXAccounts } from '../../../lib/content-engine-v3';
import { decideTelegramOpportunities, stageFromFollowerCount } from '../../../lib/decision-engine';
import { supabaseAdmin } from '../../../lib/supabase';

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalEnv(name, String(fallback));
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

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
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'manual';
    const notify = url.searchParams.get('notify') === '1';
    const username = optionalEnv('X_USERNAME', '30piq');
    const accountLimit = envNumber('CRON_SCAN_ACCOUNT_LIMIT', 5, 1, 15);
    const tweetsPerAccount = envNumber('CRON_SCAN_TWEETS_PER_ACCOUNT', 5, 1, 15);

    const scanResult = await scanXAccounts(accountLimit, tweetsPerAccount);
    const { followers, stage } = await getFollowerStage(username);
    const decision = decideTelegramOpportunities(scanResult.opportunities || [], stage);

    const supabase = supabaseAdmin();
    try {
      await supabase.from('decision_runs').insert({
        account_handle: username,
        account_stage: stage,
        raw_opportunities: scanResult.opportunities?.length || 0,
        selected_count: notify ? decision.selected.length : 0,
        held_count: decision.held.length + (notify ? 0 : decision.selected.length),
        budget: decision.budget,
        selected_payload: notify ? decision.selected.slice(0, 5).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          source_author: o.source_author,
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
    } catch {}

    return Response.json({
      ok: true,
      version: 'cron-dispatcher-v1',
      source,
      notify,
      account: { username, followers, stage },
      scan: {
        account_limit: accountLimit,
        tweets_per_account: tweetsPerAccount,
        accounts_scanned: scanResult.accounts_scanned,
        tweets_analyzed: scanResult.tweets_analyzed,
        viral_found: scanResult.viral_tweets_found,
        raw_opportunities: scanResult.opportunities?.length || 0,
        brain_updates: scanResult.brain_updates,
        media_downloaded: scanResult.media_downloaded,
        debug_log: (scanResult.debug_log || []).slice(0, 20)
      },
      decision: {
        evaluated: scanResult.opportunities?.length || 0,
        selected_if_notify: decision.selected.length,
        held: decision.held.length,
        min_final_score: decision.budget.min_final_score,
        delivery: notify ? 'telegram_delivery_requested' : 'silent_learning_only'
      }
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
