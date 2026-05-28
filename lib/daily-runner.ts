/**
 * daily-runner.ts — Shared daily pipeline orchestrator
 *
 * Canonical pipeline: load X account → scan → enrich → publish gate → decide → log → Telegram delivery
 *
 * Used by:
 *   - app/api/daily-run/route.ts (full run, API trigger)
 *   - app/api/telegram/webhook/route.ts (full run, Telegram trigger — NO HTTP self-fetch)
 *   - app/api/cron-dispatcher/route.ts (light cron run)
 *
 * This module MUST NOT import from route handlers. It is the upstream shared logic.
 */

import { optionalEnv, envNumber } from './env';
import { supabaseAdmin } from './supabase';
import { scanXAccounts } from './content-engine-v3';
import { sendTelegramMessage, allowedChatId, htmlEscape, shortText, sendTelegramPhoto, sendTelegramVideo, sendTelegramAnimation, MAIN_KEYBOARD } from './telegram';
import { decideTelegramOpportunities, stageFromFollowerCount } from './decision-engine';
import { enrichOpportunitiesWithRulePerformance } from './enrich-opportunities-with-rule-performance';
import { filterPublishableOpportunities } from './content-policy';

// ═══ Types ═══

export type DailyPipelineOptions = {
  source?: string;            // Label for decision_runs.run_source
  accountLimit?: number;      // Max accounts to scan (default 10)
  tweetsPerAccount?: number;  // Max tweets per account (default 8)
  lightMode?: boolean;        // Use lightMode scanning (default false)
  notifyTelegram?: boolean;   // Deliver recommendations to Telegram (default true)
  username?: string;          // Override X_USERNAME env
  runSource?: string;         // Explicit run_source label
};

export type DailyPipelineResult = {
  ok: boolean;
  error?: string;
  version: string;
  source: string;
  username: string;
  xSnapshot: { followers: number } | null;
  stage: string;
  scan: {
    account_limit: number;
    tweets_per_account: number;
    accounts_scanned: number;
    actual_accounts_scanned: number;
    manual_tweets_loaded: number;
    tweets_analyzed: number;
    viral_found: number;
    raw_opportunities: number;
    gate_accepted: number;
    gate_rejected: number;
    brain_updates: any;
    media_downloaded: number;
    light_mode: boolean;
    debug_log: any[];
  };
  publishGate: {
    accepted: number;
    rejected: number;
    reasons: string[];
  };
  decision: {
    selected: number;
    held: number;
    min_final_score: number;
    rule_performance: {
      enriched_opportunities: number;
      avg_weight: number;
      boosted_count: number;
      penalized_count: number;
    };
  };
  decision_run_id: string | null;
};

// ═══ Main pipeline ═══

export async function runDailyPipeline(options: DailyPipelineOptions = {}): Promise<DailyPipelineResult> {
  const source = options.source || 'daily_run';
  const username = options.username || optionalEnv('X_USERNAME', '30piq');
  const accountLimit = options.accountLimit ?? envNumber('DAILY_SCAN_ACCOUNT_LIMIT', 10, 1, 30);
  const tweetsPerAccount = options.tweetsPerAccount ?? envNumber('DAILY_SCAN_TWEETS_PER_ACCOUNT', 8, 1, 25);
  const lightMode = options.lightMode ?? false;
  const notifyTelegram = options.notifyTelegram ?? true;
  const runSource = options.runSource || source;

  // ═══ 1. Load X account state ═══
  let xSnapshot: any = null;
  try {
    const { getXUserByUsername } = await import('./x');
    xSnapshot = await getXUserByUsername(username);
    const supabase = supabaseAdmin();
    await supabase.from('account_state').upsert({
      account_handle: username,
      x_url: `https://x.com/${username}`,
      followers_count: xSnapshot.followers_count ?? null,
      following_count: xSnapshot.following_count ?? null,
      posts_count: xSnapshot.tweet_count ?? null,
      last_live_check_at: new Date().toISOString(),
      last_known_source: runSource
    }, { onConflict: 'account_handle' });
  } catch {}

  // ═══ 2. Scan ═══
  const scanResult = await scanXAccounts(accountLimit, tweetsPerAccount, lightMode ? { lightMode: true } : undefined);
  const stage = stageFromFollowerCount(xSnapshot?.followers_count ?? 0);

  // ═══ 3. Enrich with rule performance ═══
  let rulePerformanceStats = { enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0 };
  try {
    rulePerformanceStats = await enrichOpportunitiesWithRulePerformance(scanResult.opportunities || []);
  } catch {}

  // ═══ 4. Publish gate ═══
  const publishGate = filterPublishableOpportunities(scanResult.opportunities || []);

  // ═══ 5. Decision ═══
  const decision = decideTelegramOpportunities(publishGate.accepted || [], stage);
  (decision as any)._publishGate = {
    accepted: publishGate.accepted.length,
    rejected: publishGate.rejected.length,
    reasons: publishGate.rejected.slice(0, 5).map(r => r.reason)
  };
  (decision as any)._rulePerformance = rulePerformanceStats;

  // ═══ 6. Log daily checkin (only for non-cron, full runs) ═══
  if (!lightMode) {
    const supabase = supabaseAdmin();
    try {
      await supabase.from('daily_checkins').upsert({
        checkin_date: new Date().toISOString().slice(0, 10),
        execution_mode: 'v5_english_publish_gate',
        account_checked: Boolean(xSnapshot),
        tweets_planned: decision.selected.length,
        creator_posts_analyzed: scanResult.tweets_analyzed,
        notes: `v5: raw ${scanResult.opportunities?.length || 0}, gate_ok ${publishGate.accepted.length}, gate_blocked ${publishGate.rejected.length}, selected ${decision.selected.length}, held ${decision.held.length}, stage ${stage}, account_limit ${accountLimit}, tweets_per_account ${tweetsPerAccount}, source ${runSource}`
      }, { onConflict: 'checkin_date' });
    } catch {}
  }

  // ═══ 7. Insert decision_runs ═══
  let decisionRunId: string | null = null;
  const supabase = supabaseAdmin();
  try {
    const { data: insertedRun } = await supabase.from('decision_runs').insert({
      account_handle: username,
      account_stage: stage,
      raw_opportunities: scanResult.opportunities?.length || 0,
      selected_count: decision.selected.length,
      held_count: decision.held.length,
      budget: { ...decision.budget, publish_gate: (decision as any)._publishGate },
      selected_payload: decision.selected.slice(0, 5).map((o: any) => ({
        type: o.type,
        score: o.decision_score?.final_score,
        source_tweet_url: o.source_tweet_url,
        source_author: o.source_author,
        crafted_text: shortText(o.crafted_text || '', 280),
        brain_rules_used: (o.brain_rules_used || []).slice(0, 20),
        shield_passed: o.shield_passed ?? null,
        reasons: o.decision_score?.reasons || []
      })),
      held_summary: decision.held.slice(0, 10).map((o: any) => ({
        type: o.type,
        score: o.decision_score?.final_score,
        source_tweet_url: o.source_tweet_url,
        rejection_reasons: o.decision_score?.rejection_reasons || []
      })),
      run_source: runSource
    }).select('id').single();
    decisionRunId = insertedRun?.id || null;
    (decision as any)._runId = decisionRunId;
  } catch {}

  // ═══ 8. Telegram delivery ═══
  if (notifyTelegram) {
    const chatId = allowedChatId();
    if (chatId) {
      try {
        await deliverDecisionToTelegram(chatId, scanResult, username, decision, xSnapshot?.followers_count ?? 0);
      } catch (telegramErr: any) {
        console.error('[daily-runner] Telegram delivery failed:', telegramErr.message);
      }
    }
  }

  // ═══ 9. Build result ═══
  return {
    ok: true,
    version: 'v5-english-publish-gate',
    source,
    username,
    xSnapshot: xSnapshot ? { followers: xSnapshot.followers_count } : null,
    stage,
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
      light_mode: lightMode,
      debug_log: (scanResult.debug_log || []).slice(0, 20)
    },
    publishGate: {
      accepted: publishGate.accepted.length,
      rejected: publishGate.rejected.length,
      reasons: publishGate.rejected.slice(0, 5).map(r => r.reason)
    },
    decision: {
      selected: decision.selected.length,
      held: decision.held.length,
      min_final_score: decision.budget.min_final_score,
      rule_performance: rulePerformanceStats
    },
    decision_run_id: decisionRunId
  };
}

// ═══ Telegram delivery (single source of truth) ═══

export async function deliverDecisionToTelegram(
  chatId: string,
  scanResult: any,
  username: string,
  decision: any,
  followers: number
): Promise<void> {
  const runShortId = decision._runId ? String(decision._runId).slice(0, 8) : '—';
  const gate = decision._publishGate || { accepted: 0, rejected: 0, reasons: [] };
  const lines: string[] = [];

  lines.push(`🧠 <b>Decision Run — ${new Date().toISOString().slice(0, 10)}</b>`);
  lines.push(`الحساب: @${username} | المتابعون: ${followers || 0}`);
  lines.push(`المرحلة: <b>${decision.stage}</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 زحف: ${scanResult.actual_accounts_scanned ?? scanResult.accounts_scanned} حساب | ${scanResult.manual_tweets_loaded ?? 0} تغريدة يدوية | ${scanResult.tweets_analyzed} محللة | خام: ${scanResult.opportunities?.length || 0}`);
  lines.push(`🧠 عقل: +${scanResult.brain_updates.algorithm_rules} قاعدة +${scanResult.brain_updates.style_patterns} نمط`);
  lines.push(`🛡️ بوابة النشر: ${gate.accepted} صالح | ${gate.rejected} مرفوض`);
  lines.push(`🎯 القرار: ${decision.selected.length} مرسل | ${decision.held.length} مؤجل | الحد الأدنى: ${decision.budget.min_final_score}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  const rulePerf = (decision as any)._rulePerformance;
  if (rulePerf && rulePerf.enriched_opportunities > 0) {
    lines.push(`🧪 وزن قواعد العقل: avg ${rulePerf.avg_weight} / boosted ${rulePerf.boosted_count} / penalized ${rulePerf.penalized_count}`);
  }

  const selected = decision.selected || [];
  if (!selected.length) {
    lines.push('\n🟡 <b>لا توجد توصية نشر قوية الآن</b>');
    lines.push('كل الفرص الضعيفة أو غير المناسبة تم حجبها قبل الوصول لك.');
    if (gate.reasons?.length) {
      lines.push('\n<b>أسباب الحجب الأعلى:</b>');
      for (const reason of gate.reasons.slice(0, 3)) lines.push(`• ${htmlEscape(reason)}`);
    }
  } else {
    lines.push(`\n<b>✅ توصيات النشر المختارة (${selected.length})</b>`);
    lines.push(`<i>Run: ${runShortId}</i>`);
    for (let i = 0; i < selected.length; i++) {
      const opp = selected[i];
      const typeLabel = opp.type === 'quote' ? '📌 Quote' : opp.type === 'reply' ? '↩️ Reply' : opp.type === 'thread' ? '🧵 Thread' : '📰 Article';
      const score = opp.decision_score;
      const recNum = i + 1;
      lines.push(`\n<b>Rec #${recNum}</b> ${typeLabel} — <b>${score.final_score}/10</b>`);
      if (opp.source_tweet_url) lines.push(`🔗 ${opp.source_tweet_url}`);
      lines.push(`<i>${htmlEscape(shortText(opp.crafted_text, opp.type === 'thread' ? 900 : 280))}</i>`);
      lines.push(`💡 ${htmlEscape((score.reasons || []).slice(0, 3).join(' | '))}`);
      if ((opp.media_urls || []).length) {
        lines.push(`🎬 وسائط مناسبة: ${(opp.media_urls || []).slice(0, 3).map((m: any) => m.type).join(', ')}`);
      }
    }
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>انسخ وانشر يدويًا فقط. بعد النشر أرسل:</i>');
  lines.push('<i>نشرت 1 https://x.com/30piq/status/...</i>');
  lines.push('<i>(غيّر الرقم حسب التوصية)</i>');

  await sendTelegramMessage(chatId, lines.join('\n'), MAIN_KEYBOARD);

  // Send media for first selected opportunity
  const sendMedia = optionalEnv('SEND_SELECTED_MEDIA_TO_TELEGRAM', 'true') === 'true';
  if (sendMedia) {
    for (const opp of selected.slice(0, 1)) {
      for (const media of (opp.media_urls || []).slice(0, 2)) {
        try {
          const caption = `Media for selected ${opp.type} — score ${opp.decision_score.final_score}/10`;
          if (media.type === 'photo') await sendTelegramPhoto(chatId, media.url, htmlEscape(caption));
          else if (media.type === 'video') await sendTelegramVideo(chatId, media.url, htmlEscape(caption));
          else if (media.type === 'animated_gif') await sendTelegramAnimation(chatId, media.url, htmlEscape(caption));
        } catch {}
      }
    }
  }
}
