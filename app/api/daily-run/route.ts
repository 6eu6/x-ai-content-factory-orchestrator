import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { scanXAccounts } from '../../../lib/content-engine-v3';
import { sendTelegramMessage, allowedChatId, htmlEscape, shortText, sendTelegramPhoto, sendTelegramVideo, sendTelegramAnimation, MAIN_KEYBOARD } from '../../../lib/telegram';

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

    // ═══ 3. تسجيل ═══
    const supabase = supabaseAdmin();
    try {
      await supabase.from('daily_checkins').upsert({
        checkin_date: new Date().toISOString().slice(0, 10),
        execution_mode: 'v3_crawl_and_engage',
        account_checked: Boolean(xSnapshot),
        tweets_planned: scanResult.opportunities?.length || 0,
        creator_posts_analyzed: scanResult.tweets_analyzed,
        notes: `v3: scanned ${scanResult.accounts_scanned} accounts, ${scanResult.tweets_analyzed} tweets, ${scanResult.viral_tweets_found} viral, ${scanResult.opportunities?.length || 0} opportunities`
      }, { onConflict: 'checkin_date' });
    } catch {}

    // ═══ 4. تسليم لتلقرام ═══
    const chatId = allowedChatId();
    if (chatId) {
      try {
        await deliverToTelegram(chatId, scanResult, username);
      } catch {}
    }

    return Response.json({
      ok: true,
      version: 'v3-crawl-and-engage',
      xSnapshot: xSnapshot ? { followers: xSnapshot.followers_count } : null,
      scan: {
        accounts_scanned: scanResult.accounts_scanned,
        tweets_analyzed: scanResult.tweets_analyzed,
        viral_found: scanResult.viral_tweets_found,
        opportunities: scanResult.opportunities?.length || 0,
        brain_updates: scanResult.brain_updates,
        media_downloaded: scanResult.media_downloaded
      }
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

async function deliverToTelegram(chatId: string, result: any, username: string) {
  const lines: string[] = [];

  lines.push(`🧠 <b>التشغيل الكامل — ${new Date().toISOString().slice(0, 10)}</b>`);
  lines.push(`الحساب: @${username}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 حسابات: ${result.accounts_scanned} | تغريدات: ${result.tweets_analyzed} | فيروسية: ${result.viral_tweets_found}`);
  lines.push(`🧠 عقل: +${result.brain_updates.algorithm_rules} قاعدة +${result.brain_updates.style_patterns} نمط`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  const opps = result.opportunities || [];
  if (!opps.length) {
    lines.push('\nℹ️ لا فرص تفاعل حالياً. أضف حسابات عبر تلقرام.');
  } else {
    lines.push(`\n<b>📋 فرص التفاعل (${opps.length})</b>`);
    for (let i = 0; i < Math.min(opps.length, 5); i++) {
      const opp = opps[i];
      const typeLabel = opp.type === 'quote' ? '📌 اقتباس' : opp.type === 'reply' ? '↩️ رد' : opp.type === 'thread' ? '🧵 ثريد' : '📰 مقال';
      const shield = opp.shield_passed ? '✅' : '⚠️';
      lines.push(`\n${i + 1}. ${typeLabel} ${shield}`);
      if (opp.source_tweet_url) lines.push(`🔗 ${opp.source_tweet_url}`);
      lines.push(`<i>${htmlEscape(shortText(opp.crafted_text, 280))}</i>`);
    }
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>انسخ وانشر يدوياً</i>');

  await sendTelegramMessage(chatId, lines.join('\n'), MAIN_KEYBOARD);

  // أرسل الوسائط
  for (const opp of opps) {
    for (const media of (opp.media_urls || []).slice(0, 3)) {
      try {
        if (media.type === 'photo') await sendTelegramPhoto(chatId, media.url, '📷');
        else if (media.type === 'video') await sendTelegramVideo(chatId, media.url, '🎬');
        else if (media.type === 'animated_gif') await sendTelegramAnimation(chatId, media.url, '🎞️');
      } catch {}
    }
  }
}
