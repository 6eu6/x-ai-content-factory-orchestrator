import { waitUntil } from '@vercel/functions';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandle, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage, shortText } from '../../../../lib/telegram';
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
        const brainReport = await getBrainContents(supabase);
        await sendReply(chatId, brainReport);
      } catch (e: any) {
        await sendReply(chatId, `❌ فشل الاسترجاع: ${htmlEscape(e.message || '')}`);
      }
      return;
    }

    // ═══ تقرير الأداء ═══
    if (text === '📊 تقرير الأداء') {
      await sendReply(chatId, '⏳ جاري فحص الحساب...');

      try {
        const { scanAccountPerformance } = await import('../../../../lib/performance-feedback');
        const username = optionalEnv('X_USERNAME', '30piq');
        await scanAccountPerformance(10, username);
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

// ═══ استرجاع محتويات العقل ═══

async function getBrainContents(supabase: any): Promise<string> {
  const lines: string[] = [];
  lines.push('🧩 <b>محتويات العقل</b>');
  lines.push('━━━━━━━━━━━━━━━━━━━━');

  // 1. القواعد الخوارزمية — حسب النوع
  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('id, rule_type, rule, evidence, confidence_score, applies_to, status, source_type')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(50);

  const algoRulesList = algoRules || [];
  const totalAlgo = algoRulesList.length;

  // تجميع حسب rule_type
  const byType: Record<string, any[]> = {};
  for (const r of algoRulesList) {
    const t = r.rule_type || 'unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(r);
  }

  lines.push(`\n📊 <b>القواعد الخوارزمية (${totalAlgo})</b>`);

  const typeLabels: Record<string, string> = {
    'precise_concept': '🎯 مفاهيم دقيقة',
    'psychological_trigger': '🧠 آليات نفسية',
    'viral_pattern': '🔥 أنماط انتشار',
    'media_impact': '🎬 تأثير الوسائط',
    'conversation_context': '💬 سياق المحادثة',
    'viral_concept': '⚡ مفاهيم فيروسية',
    'ranking': '📈 ترتيب',
    'reply': '↩️ ردود',
    'bookmark': '🔖 حفظ',
    'safety': '🛡️ أمان'
  };

  for (const [type, rules] of Object.entries(byType)) {
    const label = typeLabels[type] || `📌 ${type}`;
    lines.push(`\n<b>${label} (${rules.length})</b>`);
    for (const r of rules.slice(0, 8)) {
      const conf = Number(r.confidence_score || 0).toFixed(1);
      const ruleText = String(r.rule || '').slice(0, 120);
      const evidenceText = String(r.evidence || '').slice(0, 80);
      lines.push(`  ${conf}⭐ <i>${htmlEscape(ruleText)}</i>`);
      if (evidenceText) lines.push(`     └ ${htmlEscape(evidenceText)}`);
    }
    if (rules.length > 8) lines.push(`  ... +${rules.length - 8} أكثر`);
  }

  // 2. أنماط الأسلوب
  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('id, pattern_name, pattern_type, pattern_description, why_it_works, adaptation_for_30piq, confidence_score, status')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(20);

  const styleList = stylePatterns || [];
  lines.push(`\n\n✍️ <b>أنماط الأسلوب (${styleList.length})</b>`);
  for (const p of styleList.slice(0, 10)) {
    const conf = Number(p.confidence_score || 0).toFixed(1);
    const name = String(p.pattern_name || '').slice(0, 80);
    const desc = String(p.pattern_description || '').slice(0, 100);
    lines.push(`  ${conf}⭐ <b>${htmlEscape(name)}</b>`);
    lines.push(`     ${htmlEscape(desc)}`);
    if (p.adaptation_for_30piq) {
      lines.push(`     → ${htmlEscape(String(p.adaptation_for_30piq).slice(0, 80))}`);
    }
  }
  if (styleList.length > 10) lines.push(`  ... +${styleList.length - 10} أكثر`);

  // 3. فرص MCP
  const { data: mcpOpps } = await supabase
    .from('mcp_opportunity_map')
    .select('id, opportunity_area, mcp_use_case, confidence_score, status')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const mcpList = mcpOpps || [];
  if (mcpList.length > 0) {
    lines.push(`\n\n🛠️ <b>فرص MCP (${mcpList.length})</b>`);
    for (const m of mcpList) {
      const conf = Number(m.confidence_score || 0).toFixed(1);
      lines.push(`  ${conf}⭐ ${htmlEscape(String(m.opportunity_area || '').slice(0, 80))}`);
      lines.push(`     └ ${htmlEscape(String(m.mcp_use_case || '').slice(0, 80))}`);
    }
  }

  // 4. قواعد النظام
  const { data: sysRules } = await supabase
    .from('system_learning_rules')
    .select('id, rule_type, rule, confidence_score, status')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const sysList = sysRules || [];
  if (sysList.length > 0) {
    lines.push(`\n\n⚙️ <b>قواعد النظام (${sysList.length})</b>`);
    for (const s of sysList) {
      const conf = Number(s.confidence_score || 0).toFixed(1);
      lines.push(`  ${conf}⭐ ${htmlEscape(String(s.rule || '').slice(0, 100))}`);
    }
  }

  // 5. ملخص التطبيق
  lines.push('\n\n━━━━━━━━━━━━━━━━━━━━');
  lines.push('🤖 <b>كيف يطبّق الذكاء الاصطناعي التعلم:</b>');
  lines.push('');
  lines.push('<b>عند إنشاء تغريدة:</b>');
  lines.push('• يأخذ أعلى 5 قواعد خوارزمية');
  lines.push('• يأخذ أعلى 3 أنماط أسلوبية');
  lines.push('• يدمجها في برومبت التوليد');
  lines.push('');
  lines.push('<b>عند إنشاء ثريد:</b>');
  lines.push('• يأخذ أعلى 5 قواعد + 5 أنماط');
  lines.push('• يبني الثريد على الأساس المتعلم');
  lines.push('');
  lines.push('<b>عند إنشاء فرص تفاعل:</b>');
  lines.push('• يأخذ أعلى 10 قواعد + 10 أنماط');
  lines.push('• يصيغ اقتباسات/ردود حسب القواعد');

  if (totalAlgo === 0 && styleList.length === 0) {
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
