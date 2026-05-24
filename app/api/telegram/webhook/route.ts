import { waitUntil } from '@vercel/functions';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandle, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage, sendTelegramPhoto, sendTelegramVideo, sendTelegramAnimation, shortText } from '../../../../lib/telegram';
import { scanXAccounts, scanSingleTweet } from '../../../../lib/content-engine-v3';

/**
 * Telegram Webhook Handler v3 — مبسط
 *
 * 3 أزرار فقط:
 * 🧠 تشغيل كامل — زحف + عقل + محتوى + تسليم
 * 📊 تقرير الأداء — فحص الحساب
 * 🔄 تصفير البيانات — مسح كل شيء ما عدا العقل
 *
 * + إضافة حساب / إضافة تغريدة
 *
 * يرد على Telegram فوراً (waitUntil للخلفية)
 */
export async function POST(req: Request) {
  try {
    const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const update = await req.json();
    const message = update?.message;
    const chatId = String(message?.chat?.id || '');
    const userId = String(message?.from?.id || '');
    const username = String(message?.from?.username || '');
    const text = String(message?.text || '').trim();

    if (!chatId || !text) return Response.json({ ok: true, ignored: true });
    assertTelegramChat(chatId);

    // ═══ رد فوري — المعالجة في الخلفية ═══
    waitUntil(handleMessage(chatId, userId, username, text));
    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET() { return Response.json({ ok: true, endpoint: 'telegram-webhook-v3' }); }

// ═══ معالجة الرسائل ═══

async function handleMessage(chatId: string, userId: string, username: string, text: string) {
  try {
    const supabase = supabaseAdmin();

    // حفظ حالة المحادثة
    await supabase.from('telegram_bot_state').upsert({
      chat_id: chatId, user_id: userId, username,
      last_message: text, updated_at: new Date().toISOString()
    }, { onConflict: 'chat_id' });

    const { data: state } = await supabase.from('telegram_bot_state').select('*').eq('chat_id', chatId).maybeSingle();

    // ═══ الأوامر الأساسية ═══
    if (text === '/start' || text === 'القائمة' || text === 'Menu') {
      await clearFlow(supabase, chatId);
      await sendReply(chatId, 'جاهز. اختر من الأزرار:');
      return;
    }

    // ═══ إضافة حساب ═══
    if (text === '➕ إضافة حساب') {
      await setFlow(supabase, chatId, 'awaiting_account');
      await sendReply(chatId, 'أرسل حساب X للتعلم منه. مثال: emollick أو @emollick أو رابط الحساب');
      return;
    }

    if (state?.current_flow === 'awaiting_account') {
      await clearFlow(supabase, chatId);
      const handle = extractHandle(text);
      if (!handle) { await sendReply(chatId, 'أرسل يوزر صحيح مثل: emollick أو @emollick'); return; }

      try {
        await supabase.from('accounts').upsert({ handle, username: handle, tier: 2, active: true, notes: 'Added from Telegram' }, { onConflict: 'handle' });
      } catch {
        try { await supabase.from('accounts').upsert({ handle, username: handle }, { onConflict: 'handle' }); } catch {}
      }

      // جلب معلومات الحساب
      let info = '';
      try {
        const { getXUserByUsername } = await import('../../../../lib/x');
        const snapshot = await getXUserByUsername(handle);
        if (snapshot) {
          info = `\n\n✅ @${htmlEscape(handle)}\nالمتابعين: ${snapshot.followers_count ?? '?'}\nالتغريدات: ${snapshot.tweet_count ?? '?'}`;
          try {
            await supabase.from('accounts').update({
              notes: `Followers: ${snapshot.followers_count}, Added: ${new Date().toISOString()}`,
              updated_at: new Date().toISOString()
            }).eq('handle', handle);
          } catch {}
        }
      } catch { info = `\n\n⚠️ لم أتمكن من جلب معلومات @${htmlEscape(handle)} الآن.`; }

      await sendReply(chatId, `تمت إضافة حساب التعلم: @${htmlEscape(handle)}${info}\n\nشغّل 🧠 تشغيل كامل لبدء التحليل.`);
      return;
    }

    // ═══ إضافة تغريدة ═══
    if (text === '🔗 إضافة تغريدة') {
      await setFlow(supabase, chatId, 'awaiting_tweet');
      await sendReply(chatId, 'أرسل رابط تغريدة X مثل: https://x.com/user/status/123');
      return;
    }

    if (state?.current_flow === 'awaiting_tweet') {
      await clearFlow(supabase, chatId);
      const tweetUrl = extractTweetUrl(text);
      if (!tweetUrl) { await sendReply(chatId, 'أرسل رابط تغريدة X صحيح'); return; }

      await sendReply(chatId, `⏳ جاري تحليل التغريدة...`);

      const result = await scanSingleTweet(tweetUrl);
      if (!result.ok) { await sendReply(chatId, `❌ فشل التحليل: ${htmlEscape(result.error || '')}`); return; }

      const a = result.analysis;
      const m = result.media || [];
      const diag = (result as any).diagInfo || '';
      const deep = (result as any).deepAnalysis as { viralReason: string; stylePattern: string; adaptation: string; mediaImpact: string } | undefined;

      let msg = `✅ <b>تم تحليل التغريدة</b>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `المؤلف: @${htmlEscape(a.username || '')}\n`;
      msg += `التفاعل: ${a.engagement_score ?? 0}\n`;
      msg += `لكل 1K متابع: ${a.engagement_per_1k_followers ?? 0}\n`;
      msg += `الوسائط: ${m.length > 0 ? m.map(x => x.type === 'photo' ? '📷' : x.type === 'video' ? '🎬' : '🎞️').join(' ') : 'لا يوجد'}\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `<i>${htmlEscape(shortText(a.text || '', 200))}</i>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      // تحليل عميق
      if (deep) {
        msg += `🔥 <b>ليش انتشرت:</b> ${htmlEscape(deep.viralReason.slice(0, 200))}\n`;
        msg += `✍️ <b>نمط الأسلوب:</b> ${htmlEscape(deep.stylePattern.slice(0, 150))}\n`;
        msg += `🎬 <b>تأثير الوسائط:</b> ${htmlEscape(deep.mediaImpact.slice(0, 150))}\n`;
      }
      // عرض معلومات تشخيصية للوسائط
      if (diag) msg += `${diag}\n`;
      msg += `\n<i>✅ تم تخزين التحليل + قواعد الانتشار + أنماط الأسلوب في العقل.</i>`;

      await sendReply(chatId, msg);
      return;
    }

    // ═══ تشغيل كامل ═══
    if (text === '🧠 تشغيل كامل') {
      await sendReply(chatId, '⏳ جاري الزحف والتحليل... سأرسل النتائج عند الانتهاء.');

      const scanResult = await scanXAccounts(5, 10);

      // تسليم النتائج لتلقرام
      await deliverScanResults(chatId, scanResult);
      return;
    }

    // ═══ تقرير الأداء ═══
    if (text === '📊 تقرير الأداء') {
      await sendReply(chatId, '⏳ جاري فحص الحساب...');

      try {
        const { scanAccountPerformance } = await import('../../../../lib/performance-feedback');
        const username = optionalEnv('X_USERNAME', '30piq');
        await scanAccountPerformance(10, username);
        // الأداء يرسل تلقائياً لتلقرام
      } catch (e: any) {
        await sendReply(chatId, `❌ فشل الفحص: ${htmlEscape(e.message || '')}`);
      }
      return;
    }

    // ═══ تصفير البيانات ═══
    if (text === '🔄 تصفير البيانات') {
      await setFlow(supabase, chatId, 'awaiting_reset');
      await sendReply(chatId, '⚠️ <b>تأكيد تصفير البيانات</b>\n\nيتم حذف:\n• المهام والمحتوى المولّد\n• سجلات التسليم والجلسات\n• نتائج البحث والاتجاهات\n\n<b>يُحافظ عليه (العقل):</b>\n✅ قواعد خوارزمية X\n✅ أنماط الأسلوب\n✅ الحسابات المُضافة\n✅ قواعد التعلم\n\nأرسل <b>نعم</b> للتأكيد.');
      return;
    }

    if (state?.current_flow === 'awaiting_reset') {
      await clearFlow(supabase, chatId);
      if (['نعم', 'اي', 'أي', 'اه', 'آه', 'yes', '١'].includes(text.trim().toLowerCase())) {
        await resetOperationalData(supabase, chatId);
      } else {
        await sendReply(chatId, 'تم الإلغاء. لم يتم حذف شيء.');
      }
      return;
    }

    // ═══ أمر غير معروف ═══
    await sendReply(chatId, 'استخدم الأزرار في لوحة التحكم.');
  } catch (err: any) {
    console.error('Telegram handler error:', err.message);
  }
}

// ═══ تسليم نتائج الزحف ═══

async function deliverScanResults(chatId: string, result: any) {
  const lines: string[] = [];

  // 1. ملخص الزحف
  lines.push(`🧠 <b>نتيجة التشغيل الكامل</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 حسابات مزحوفة: ${result.accounts_scanned}`);
  lines.push(`📝 تغريدات محللة: ${result.tweets_analyzed}`);
  lines.push(`🔥 تغريدات فيروسية: ${result.viral_tweets_found}`);
  lines.push(`🎬 وسائط مكتشفة: ${result.media_downloaded}`);
  lines.push(`🧠 تحديثات العقل: ${result.brain_updates.algorithm_rules} قاعدة + ${result.brain_updates.style_patterns} نمط`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  const opps = result.opportunities || [];

  if (!opps.length) {
    lines.push('');
    lines.push('ℹ️ لم تُكتشف فرص تفاعل حالياً.');
    lines.push('أضف المزيد من الحسابات عبر زر "➕ إضافة حساب".');
    await sendReply(chatId, lines.join('\n'));
    return;
  }

  // 2. فرص التفاعل
  lines.push('');
  lines.push(`<b>📋 فرص التفاعل (${opps.length})</b>`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');

  for (let i = 0; i < Math.min(opps.length, 5); i++) {
    const opp = opps[i];
    const typeLabel = opp.type === 'quote' ? '📌 اقتباس' : opp.type === 'reply' ? '↩️ رد' : opp.type === 'thread' ? '🧵 ثريد' : '📰 مقال';
    const shieldIcon = opp.shield_passed ? '✅' : '⚠️';

    lines.push(`\n${i + 1}. ${typeLabel} ${shieldIcon}`);
    if (opp.source_tweet_url) lines.push(`🔗 ${opp.source_tweet_url}`);
    lines.push(`<i>${htmlEscape(shortText(opp.crafted_text, 280))}</i>`);
    if (opp.why) lines.push(`💡 ${opp.why}`);
    if (opp.shield_issues?.length) lines.push(`⚠️ ${opp.shield_issues.join(', ')}`);
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>انسخ المحتوى وانشره يدوياً على X</i>');

  await sendReply(chatId, lines.join('\n'));
}

// ═══ مساعدات ═══

async function sendReply(chatId: string, text: string) {
  await sendTelegramMessage(chatId, text, MAIN_KEYBOARD);
}

async function clearFlow(supabase: any, chatId: string) {
  await supabase.from('telegram_bot_state').update({ current_flow: null, flow_payload: {}, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
}

async function setFlow(supabase: any, chatId: string, flow: string) {
  await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, current_flow: flow, flow_payload: {}, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
}

async function resetOperationalData(supabase: any, chatId: string) {
  await sendTelegramMessage(chatId, '🔄 جاري التصفير...', MAIN_KEYBOARD);

  const tablesToDelete = [
    'action_queue', 'content_log', 'content_deliveries', 'session_logs',
    'daily_checkins', 'content_opportunities', 'original_content_hypotheses',
    'content_format_decisions', 'content_production_cards', 'learning_tweet_queue',
    'learning_cycles', 'performance_scans', 'telegram_bot_state', 'account_state',
    'viral_scan_runs', 'viral_tweet_analyses', 'raw_research_items', 'trends',
    'creator_intel', 'discovered_items', 'repo_source_files', 'growth_learning_runs',
    'requirement_status', 'target_plans',
  ];

  let deletedTotal = 0;
  for (const table of tablesToDelete) {
    try {
      const { count } = await supabase.from(table).delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      deletedTotal += count ?? 0;
    } catch {}
  }

  // تحقق من العقل
  const keptTables = ['x_algorithm_learning_rules', 'viral_style_patterns', 'viral_account_patterns', 'working_memory', 'system_learning_rules', 'model_routing_rules', 'accounts', 'repo_extracted_rules'];
  let keptTotal = 0;
  for (const table of keptTables) {
    try {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      keptTotal += count ?? 0;
    } catch {}
  }

  await sendReply(chatId, `✅ <b>تم التصفير</b>\n━━━━━━━━━━━━━━━━━━━━\nحُذف: ${deletedTotal} صف\n🧠 العقل محفوظ: ${keptTotal} صف\n\nشغّل 🧠 تشغيل كامل لبدء تجربة جديدة.`);
}
