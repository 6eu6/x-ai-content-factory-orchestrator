import { waitUntil } from '@vercel/functions';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandle, extractHandles, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage, shortText } from '../../../../lib/telegram';
import { scanXAccounts, scanSingleTweet } from '../../../../lib/content-engine-v3';

/**
 * Telegram Webhook Handler v3.1 — تحليل حقيقي بالذكاء الاصطناعي
 *
 * 3 أزرار فقط:
 * 🧠 تشغيل كامل — زحف + عقل + محتوى + تسليم
 * 📊 تقرير الأداء — فحص الحساب
 * 🔄 تصفير البيانات — مسح كل شيء ما عدا العقل
 *
 * + إضافة حساب / إضافة تغريدة
 *
 * القواعد:
 * - لا يرسل وسائط (صور/فيديو) لتلقرام — فقط يحللها ويتعلم منها
 * - التحليل العميق يستخدم AI حقيقي (مو hardcoded)
 * - التشخيص في server logs فقط (ما يعرض للمستخدم)
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

export async function GET() { return Response.json({ ok: true, endpoint: 'telegram-webhook-v3.1' }); }

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
      await sendReply(chatId, 'أرسل يوزر X أو أكثر مفصولة بمسافة أو فاصلة.\nمثال: emollick @naval paulg\nأو: @emollick, @sama, elonmusk');
      return;
    }

    if (state?.current_flow === 'awaiting_account') {
      await clearFlow(supabase, chatId);
      const handles = extractHandles(text);
      if (!handles.length) { await sendReply(chatId, 'أرسل يوزر صحيح مثل: emollick أو @emollick\nتقدر ترسل عدة يوزرات: naval emollick paulg'); return; }

      const results: string[] = [];
      const maxHandles = 10; // حد أقصى للحماية

      for (const handle of handles.slice(0, maxHandles)) {
        // حفظ في قاعدة البيانات — بدون active (العمود غير موجود)
        try {
          await supabase.from('accounts').upsert({ handle, tier: 2, notes: 'Added from Telegram' }, { onConflict: 'handle' });
        } catch {
          try { await supabase.from('accounts').upsert({ handle }, { onConflict: 'handle' }); } catch {}
        }

        // جلب معلومات الحساب
        let info = '';
        try {
          const { getXUserByUsername } = await import('../../../../lib/x');
          const snapshot = await getXUserByUsername(handle);
          if (snapshot) {
            info = ` ✅ (${snapshot.followers_count ?? '?'} متابع, ${snapshot.tweet_count ?? '?'} تغريدة)`;
            try {
              await supabase.from('accounts').update({
                notes: `Followers: ${snapshot.followers_count}, Added: ${new Date().toISOString()}`
              }).eq('handle', handle);
            } catch {}
          }
        } catch { info = ` ⚠️ (لم أجلب المعلومات)`; }

        results.push(`• @${htmlEscape(handle)}${info}`);
      }

      const skippedCount = handles.length > maxHandles ? handles.length - maxHandles : 0;
      let msg = `<b>تمت إضافة ${results.length} حساب تعلم:</b>\n━━━━━━━━━━━━━━━━━━━━\n${results.join('\n')}`;
      if (skippedCount > 0) msg += `\n\n⚠️ تم تجاهل ${skippedCount} يوزر (الحد الأقصى ${maxHandles})`;
      msg += `\n\nشغّل 🧠 تشغيل كامل لبدء التحليل.`;
      await sendReply(chatId, msg);
      return;
    }

    // ═══ قائمة الحسابات ═══
    if (text === '📋 قائمة الحسابات') {
      try {
        const { data: accounts, error } = await supabase
          .from('accounts')
          .select('handle, tier, category, followers, notes, last_checked')
          .order('tier', { ascending: true });

        if (error || !accounts?.length) {
          await sendReply(chatId, 'ℹ️ لا توجد حسابات مضافة حالياً.\nأضف حسابات عبر زر ➕ إضافة حساب.');
          return;
        }

        const tierLabels: Record<number, string> = { 1: '⭐', 2: '✅', 3: '📌' };
        const lines: string[] = [];
        lines.push(`📋 <b>قائمة الحسابات (${accounts.length})</b>`);
        lines.push('━━━━━━━━━━━━━━━━━━━━');

        for (const a of accounts) {
          const icon = tierLabels[a.tier] || '📌';
          const followerInfo = a.followers ? ` | ${a.followers.toLocaleString()} متابع` : '';
          const categoryInfo = a.category ? ` | ${a.category}` : '';
          const lastCheck = a.last_checked ? ` | فحص: ${a.last_checked}` : '';
          lines.push(`${icon} @${htmlEscape(a.handle)}${followerInfo}${categoryInfo}${lastCheck}`);
        }

        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`⭐ = Tier 1 | ✅ = Tier 2 | 📌 = Tier 3`);
        lines.push(`<i>شغّل 🧠 تشغيل كامل لزحف هذه الحسابات.</i>`);

        await sendReply(chatId, lines.join('\n'));
      } catch (e: any) {
        await sendReply(chatId, `❌ فشل جلب الحسابات: ${htmlEscape(e.message || '')}`);
      }
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

      await sendReply(chatId, `⏳ جاري التحليل العميق بالذكاء الاصطناعي...`);

      const result = await scanSingleTweet(tweetUrl);
      if (!result.ok) { await sendReply(chatId, `❌ فشل التحليل: ${htmlEscape(result.error || '')}`); return; }

      const a = result.analysis;
      const m = result.media || [];
      const deep = result.deepAnalysis;

      // ═══ عرض التحليل — بدون إرسال وسائط، بدون تشخيص ═══
      let msg = `✅ <b>تم التحليل العميق</b>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `المؤلف: @${htmlEscape(a.username || '')}\n`;
      msg += `التفاعل: ${a.engagement_score ?? 0}\n`;
      msg += `لكل 1K متابع: ${a.engagement_per_1k_followers ?? 0}\n`;
      msg += `النوع: ${a.tweet_type || 'original'}\n`;
      msg += `الوسائط: ${m.length > 0 ? m.map(x => x.type === 'photo' ? '📷' : x.type === 'video' ? '🎬' : '🎞️').join(' ') : 'لا يوجد'}\n`;
      if (a.time_label) msg += `الوقت: ${htmlEscape(a.time_label)}\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `<i>${htmlEscape(shortText(a.text || '', 200))}</i>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;

      // التحليل العميق الحقيقي من AI — بالانجليزي لأن المحتوى انجليزي
      if (deep) {
        msg += `\n🔥 <b>Why it went viral:</b>\n${htmlEscape(deep.viralReason.slice(0, 400))}\n`;
        msg += `\n✍️ <b>Style pattern:</b>\n${htmlEscape(deep.stylePattern.slice(0, 250))}\n`;
        msg += `\n🎬 <b>Media impact:</b>\n${htmlEscape(deep.mediaImpact.slice(0, 200))}\n`;
        msg += `\n⏰ <b>Timing insight:</b>\n${htmlEscape(deep.timingInsight.slice(0, 200))}\n`;
        msg += `\n📝 <b>Tweet type insight:</b>\n${htmlEscape(deep.tweetTypeInsight.slice(0, 200))}\n`;
        msg += `\n📊 <b>Engagement quality:</b>\n${htmlEscape(deep.engagementQuality.slice(0, 200))}\n`;
        msg += `\n🎯 <b>Transferable adaptation:</b>\n${htmlEscape(deep.adaptation.slice(0, 250))}\n`;
      }

      msg += `\n<i>✅ تم تخزين التحليل + أنماط الانتشار + الأسلوب + التوقيت + النوع في العقل.</i>`;

      // لا نرسل أي وسائط (صور/فيديو) لتلقرام — فقط التحليل
      await sendReply(chatId, msg);
      return;
    }

    // ═══ تشغيل كامل ═══
    if (text === '🧠 تشغيل كامل') {
      await sendReply(chatId, '⏳ جاري الزحف والتحليل العميق... سأرسل النتائج عند الانتهاء.');

      const scanResult = await scanXAccounts(5, 10);

      // سجّل التشخيص في server logs
      if (scanResult.debug_log?.length) {
        console.log('[scanXAccounts] Debug log:', scanResult.debug_log.join('\n'));
      }

      // تسليم النتائج لتلقرام
      await deliverScanResults(chatId, scanResult);
      return;
    }

    // ═══ محتويات العقل ═══
    if (text === '🧩 محتويات العقل') {
      await sendReply(chatId, '⏳ جاري استرجاع محتويات العقل...');
      try {
        const summary = await getBrainSummary(supabase);
        const viewerUrl = `${optionalEnv('VERCEL_URL', 'https://x-ai-content-factory-orchestrator.vercel.app')}/api/brain-viewer`;
        await sendReply(chatId, `${summary}\n\n🔗 <a href="${viewerUrl}">عرض تفصيلي في المتصفح</a>\n📊 <a href="${viewerUrl}?format=json">بيانات خام JSON</a>`);
      } catch (e: any) {
        await sendReply(chatId, `❌ فشل الاسترجاع: ${htmlEscape(e.message || '')}`);
      }
      return;
    }

    // ═══ تقرير الأداء ═══
    if (text === '📊 تقرير الأداء') {
      await sendReply(chatId, '⏳ جاري فحص الحساب وتحليل الأداء...');

      try {
        const username = optionalEnv('X_USERNAME', '30piq');

        // ═══ خطوة 1: جلب التغريدات ═══
        let tweets: any[] = [];
        try {
          const { getXUserTimeline, scoreXTweet } = await import('../../../../lib/x');
          tweets = await getXUserTimeline(username, 10, true);
        } catch (fetchErr: any) {
          await sendReply(chatId, `❌ فشل جلب التغريدات: ${htmlEscape(fetchErr.message || 'خطأ في الاتصال بـ X')}`);
          return;
        }

        if (!tweets.length) {
          await sendReply(chatId, 'ℹ️ لم يتم العثور على تغريدات في حسابك. انشر محتوى أول ثم أعد الفحص.');
          return;
        }

        // ═══ خطوة 2: تحليل سريع بدون AI (مقاييس فقط) ═══
        const { scoreXTweet } = await import('../../../../lib/x');
        const analyses: any[] = [];

        for (const tweet of tweets) {
          const m = tweet.public_metrics || {};
          const views = m.view_count || 0;
          const likes = m.like_count || 0;
          const replies = m.reply_count || 0;
          const retweets = m.retweet_count || 0;
          const quotes = m.quote_count || 0;
          const bookmarks = m.bookmark_count || 0;

          const engagementScore = scoreXTweet(tweet);
          const viewAdjustedScore = views > 0 ? (engagementScore / views) * 1000 : 0;

          let verdict = 'average';
          if (viewAdjustedScore > 50 || (likes > 5 && bookmarks > 2)) verdict = 'high_performer';
          if (viewAdjustedScore < 5 && views > 100) verdict = 'underperformer';

          analyses.push({
            text_preview: (tweet.text || '').slice(0, 200),
            tweet_url: `https://x.com/${username}/status/${tweet.id}`,
            performance_score: Math.round(viewAdjustedScore * 100) / 100,
            verdict,
            metrics: { views, likes, replies, retweets, quotes, bookmarks },
            success_factors: [],
            failure_factors: []
          });
        }

        // ═══ خطوة 3: تحليل AI (محاولة — لو فشل نكمل بدونها) ═══
        try {
          const { callModel, parseModelJson } = await import('../../../../lib/model-router');
          const analysisContext = analyses.map(a => ({
            text: a.text_preview,
            verdict: a.verdict,
            score: a.performance_score,
            metrics: a.metrics
          }));

          const aiResponse = await callModel('performance_analysis', [
            {
              role: 'system',
              content: 'You are an X/Twitter growth analyst. Analyze tweet performance briefly. Output valid JSON array only.'
            },
            {
              role: 'user',
              content: `Analyze these tweets from @${username}. For each, give success/failure factors:\n${JSON.stringify(analysisContext, null, 2)}\n\nReturn JSON: [{"text_preview":"...","success_factors":["..."],"failure_factors":["..."]}]`
            }
          ]);

          const parsed = parseModelJson(aiResponse);
          if (Array.isArray(parsed)) {
            for (let i = 0; i < analyses.length && i < parsed.length; i++) {
              analyses[i].success_factors = parsed[i]?.success_factors || [];
              analyses[i].failure_factors = parsed[i]?.failure_factors || [];
            }
          }
        } catch (aiErr: any) {
          console.log('[Performance Report] AI analysis failed, continuing without it:', aiErr.message);
        }

        // ═══ خطوة 4: عرض النتائج ═══
        const winners = analyses.filter((a: any) => a.verdict === 'high_performer');
        const losers = analyses.filter((a: any) => a.verdict === 'underperformer');
        const avg = analyses.length > 0
          ? (analyses.reduce((s: number, a: any) => s + a.performance_score, 0) / analyses.length).toFixed(2)
          : '0';

        const lines: string[] = [];
        lines.push(`📊 <b>تقرير الأداء</b> — @${username}`);
        lines.push('━━━━━━━━━━━━━━━━━━━━');
        lines.push(`📝 تغريدات مُفحوصة: ${tweets.length}`);
        lines.push(`✅ ناجحة: ${winners.length} | ⚠️ عادية: ${tweets.length - winners.length - losers.length} | ❌ ضعيفة: ${losers.length}`);
        lines.push(`📈 متوسط الأداء: ${avg}`);
        lines.push('━━━━━━━━━━━━━━━━━━━━');

        if (winners.length > 0) {
          lines.push('\n🏆 <b>التغريدات الناجحة:</b>');
          for (const w of winners.slice(0, 3)) {
            lines.push(`  📌 ${htmlEscape(shortText(w.text_preview, 80))}`);
            if (w.success_factors?.length) lines.push(`     ✦ ${htmlEscape(w.success_factors[0].slice(0, 80))}`);
            lines.push(`     نقاط: ${w.performance_score} | ❤️ ${w.metrics.likes} 🔁 ${w.metrics.retweets} 🔖 ${w.metrics.bookmarks}`);
          }
        }

        if (losers.length > 0) {
          lines.push('\n📉 <b>التغريدات الضعيفة:</b>');
          for (const l of losers.slice(0, 3)) {
            lines.push(`  📌 ${htmlEscape(shortText(l.text_preview, 80))}`);
            if (l.failure_factors?.length) lines.push(`     ✦ ${htmlEscape(l.failure_factors[0].slice(0, 80))}`);
            lines.push(`     نقاط: ${l.performance_score} | ❤️ ${l.metrics.likes} 🔁 ${l.metrics.retweets} 🔖 ${l.metrics.bookmarks}`);
          }
        }

        lines.push('\n━━━━━━━━━━━━━━━━━━━━');
        lines.push(`<i>تم التحليل. شغّل 🧠 تشغيل كامل لتعلم العقل من النتائج.</i>`);

        await sendReply(chatId, lines.join('\n'));

        // ═══ خطوة 5: تحديثات التعلم في الخلفية (بدون انتظار) ═══
        try {
          const { scanAccountPerformance } = await import('../../../../lib/performance-feedback');
          // هذا يشغّل التحليل الكامل في الخلفية — لو فشل ما يأثر على التقرير المعروض
          scanAccountPerformance(10, username).catch(() => {});
        } catch {}

      } catch (e: any) {
        console.error('[Performance Report] Fatal error:', e.message);
        await sendReply(chatId, `❌ فشل الفحص: ${htmlEscape(e.message || 'خطأ غير معروف')}`);
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

  // لو كل شيء صفر — اعرض نصائح للتصحيح
  if (result.tweets_analyzed === 0 && result.accounts_scanned === 0) {
    lines.push('');
    lines.push('⚠️ <b>لم يتم العثور على بيانات</b>');
    lines.push('تأكد من:');
    lines.push('1. إضافة حسابات عبر زر ➕ إضافة حساب');
    lines.push('2. إضافة تغريدات عبر زر 🔗 إضافة تغريدة');
    lines.push('3. التحقق من اتصال Supabase');

    // أضف معلومات تشخيصية مختصرة لو متوفرة
    const debugLog = result.debug_log || [];
    if (debugLog.length > 0) {
      const relevantErrors = debugLog.filter(l => l.includes('error') || l.includes('exception') || l.includes('FAILED'));
      if (relevantErrors.length > 0) {
        lines.push('');
        lines.push('<b>🔧 أخطاء:</b>');
        for (const err of relevantErrors.slice(0, 3)) {
          lines.push(`• ${htmlEscape(err.slice(0, 100))}`);
        }
      }
    }
  }

  const opps = result.opportunities || [];

  if (!opps.length && result.tweets_analyzed > 0) {
    lines.push('');
    lines.push('ℹ️ لم تُكتشف فرص تفاعل حالياً.');
    lines.push('أضف المزيد من الحسابات عبر زر "➕ إضافة حساب".');
    await sendReply(chatId, lines.join('\n'));
    return;
  }

  // 2. فرص التفاعل
  if (opps.length) {
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
  }

  await sendReply(chatId, lines.join('\n'));
}

// ═══ ملخص محتويات العقل (قصير لتلقرام — التفاصيل في رابط المتصفح) ═══

async function getBrainSummary(supabase: any): Promise<string> {
  const lines: string[] = [];
  lines.push('🧩 <b>ملخص العقل</b>');
  lines.push('━━━━━━━━━━━━━━━━━━━━');

  // إحصائيات سريعة
  const { count: algoCount } = await supabase
    .from('x_algorithm_learning_rules')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: styleCount } = await supabase
    .from('viral_style_patterns')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: sysCount } = await supabase
    .from('system_learning_rules')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: mcpCount } = await supabase
    .from('mcp_opportunity_map')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: antiCount } = await supabase
    .from('x_algorithm_learning_rules')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'anti_pattern');

  const totalAlgo = algoCount || 0;
  const totalStyle = styleCount || 0;
  const totalSys = sysCount || 0;
  const totalMcp = mcpCount || 0;
  const totalAnti = antiCount || 0;

  lines.push(`📊 القواعد الخوارزمية: ${totalAlgo}`);
  lines.push(`✍️ أنماط الأسلوب: ${totalStyle}`);
  lines.push(`⚙️ قواعد النظام السببية: ${totalSys}`);
  lines.push(`🛠️ فرص MCP: ${totalMcp}`);
  lines.push(`🚫 أنماط مضادة: ${totalAnti}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  // أعلى 3 قواعد فقط
  if (totalAlgo > 0) {
    const { data: topRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, confidence_score')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(3);

    lines.push('\n🏆 <b>أعلى القواعد:</b>');
    for (const r of (topRules || [])) {
      const conf = Number(r.confidence_score || 0).toFixed(1);
      lines.push(`  ${conf}⭐ ${htmlEscape(String(r.rule || '').slice(0, 80))}`);
    }
  }

  // أعلى 3 أنماط
  if (totalStyle > 0) {
    const { data: topPatterns } = await supabase
      .from('viral_style_patterns')
      .select('pattern_name, confidence_score')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(3);

    lines.push('\n✍️ <b>أعلى الأنماط:</b>');
    for (const p of (topPatterns || [])) {
      const conf = Number(p.confidence_score || 0).toFixed(1);
      lines.push(`  ${conf}⭐ ${htmlEscape(String(p.pattern_name || '').slice(0, 60))}`);
    }
  }

  if (totalAlgo === 0 && totalStyle === 0) {
    lines.push('');
    lines.push('⚠️ <b>العقل فارغ!</b>');
    lines.push('شغّل 🧠 تشغيل كامل أو أضف تغريدات لتعليم العقل.');
  }

  return lines.join('\n');
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
