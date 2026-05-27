import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { scanXAccounts } from '../../../lib/content-engine-v3';
import { sendTelegramMessage, allowedChatId, htmlEscape, shortText, sendTelegramPhoto, sendTelegramVideo, sendTelegramAnimation, MAIN_KEYBOARD } from '../../../lib/telegram';
import { decideTelegramOpportunities, stageFromFollowerCount } from '../../../lib/decision-engine';

/**
 * GET/POST /api/daily-run
 *
 * النسخة الجديدة المبسطة:
 * 1. زحف X → تحليل → تعليم العقل → فرص تفاعل → تسليم تلقرام
 * 2. لا توليد AI — فقط تفاعل حقيقي مبني على المحتوى المزحوف
 */
export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const username = optionalEnv('X_USERNAME', '30piq');

    // ═══ 1. فحص الحساب ═══
    let xSnapshot: any = null;
    try {
      const { getXUserByUsername } = await import('../../../lib/x');
      xSnapshot = await getXUserByUsername(username);
      const supabase = supabaseAdmin();
      await supabase.from('account_state').upsert({
        account_handle: username,
        x_url: `https://x.com/${username}`,
        followers_count: xSnapshot.followers_count ?? null,
        following_count: xSnapshot.following_count ?? null,
        posts_count: xSnapshot.tweet_count ?? null,
        last_live_check_at: new Date().toISOString(),
        last_known_source: 'daily_run'
      }, { onConflict: 'account_handle' });
    } catch {}

    // ═══ 2. الزحف والتحليل ═══
    const scanResult = await scanXAccounts(5, 10);
    const stage = stageFromFollowerCount(xSnapshot?.followers_count ?? 0);
    const decision = decideTelegramOpportunities(scanResult.opportunities || [], stage);

    // ═══ 3. تسجيل ═══
    const supabase = supabaseAdmin();
    try {
      await supabase.from('daily_checkins').upsert({
        checkin_date: new Date().toISOString().slice(0, 10),
        execution_mode: 'v4_decision_gated_crawl',
        account_checked: Boolean(xSnapshot),
        tweets_planned: decision.selected.length,
        creator_posts_analyzed: scanResult.tweets_analyzed,
        notes: `v4: raw ${scanResult.opportunities?.length || 0}, selected ${decision.selected.length}, held ${decision.held.length}, stage ${stage}`
      }, { onConflict: 'checkin_date' });
    } catch {}

    // ═══ 4. تسليم لتلقرام ═══
    const chatId = allowedChatId();
    if (chatId) {
      try {
        await deliverToTelegram(chatId, scanResult, username, decision, xSnapshot?.followers_count ?? 0);
      } catch {}
    }

    return Response.json({
      ok: true,
      version: 'v4-decision-gated-crawl',
      xSnapshot: xSnapshot ? { followers: xSnapshot.followers_count } : null,
      decision: {
        stage,
        selected: decision.selected.length,
        held: decision.held.length,
        min_final_score: decision.budget.min_final_score
      },
      scan: {
        accounts_scanned: scanResult.accounts_scanned,
        tweets_analyzed: scanResult.tweets_analyzed,
        viral_found: scanResult.viral_tweets_found,
        raw_opportunities: scanResult.opportunities?.length || 0,
        brain_updates: scanResult.brain_updates,
        media_downloaded: scanResult.media_downloaded
      }
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

async function deliverToTelegram(chatId: string, result: any, username: string, decision: any, followers: number) {
  const lines: string[] = [];

  lines.push(`🧠 <b>Decision Run — ${new Date().toISOString().slice(0, 10)}</b>`);
  lines.push(`الحساب: @${username} | المتابعون: ${followers || 0}`);
  lines.push(`المرحلة: <b>${decision.stage}</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 زحف: ${result.accounts_scanned} حساب | ${result.tweets_analyzed} تغريدة | خام: ${result.opportunities?.length || 0}`);
  lines.push(`🧠 عقل: +${result.brain_updates.algorithm_rules} قاعدة +${result.brain_updates.style_patterns} نمط`);
  lines.push(`🎯 القرار: ${decision.selected.length} مرسل | ${decision.held.length} مؤجل | الحد الأدنى: ${decision.budget.min_final_score}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  const selected = decision.selected || [];
  if (!selected.length) {
    lines.push('\n🟡 <b>لا توجد توصية نشر قوية الآن</b>');
    lines.push('العقل وجد فرصًا، لكنها لم تتجاوز بوابة القرار. الأفضل عدم النشر بدل إرسال محتوى ضعيف.');
    const topHeld = (decision.held || [])[0];
    if (topHeld) {
      lines.push('\n<b>أقرب فرصة مؤجلة:</b>');
      lines.push(`Score: ${topHeld.decision_score.final_score}/10`);
      lines.push(`${htmlEscape(shortText(topHeld.crafted_text, 220))}`);
      if (topHeld.decision_score.rejection_reasons?.length) {
        lines.push(`سبب التأجيل: ${htmlEscape(topHeld.decision_score.rejection_reasons[0])}`);
      }
    }
  } else {
    lines.push(`\n<b>✅ توصيات النشر المختارة (${selected.length})</b>`);
    for (let i = 0; i < selected.length; i++) {
      const opp = selected[i];
      const typeLabel = opp.type === 'quote' ? '📌 اقتباس' : opp.type === 'reply' ? '↩️ رد' : opp.type === 'thread' ? '🧵 ثريد' : '📰 مقال';
      const score = opp.decision_score;
      lines.push(`\n${i + 1}. ${typeLabel} — <b>${score.final_score}/10</b>`);
      if (opp.source_tweet_url) lines.push(`🔗 ${opp.source_tweet_url}`);
      lines.push(`<i>${htmlEscape(shortText(opp.crafted_text, opp.type === 'thread' ? 900 : 280))}</i>`);
      lines.push(`💡 ${htmlEscape((score.reasons || []).slice(0, 3).join(' | '))}`);
      if ((opp.media_urls || []).length) {
        lines.push(`🎬 وسائط مناسبة: ${(opp.media_urls || []).slice(0, 3).map((m: any) => m.type).join(', ')}`);
      }
    }
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>انسخ وانشر يدويًا فقط. بعد النشر شغّل تقرير الأداء لاحقًا للتعلم.</i>');

  await sendTelegramMessage(chatId, lines.join('\n'), MAIN_KEYBOARD);

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
