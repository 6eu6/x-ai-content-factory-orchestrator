import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandle, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage, shortText } from '../../../../lib/telegram';

export async function POST(req: Request) {
  try {
    const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const update = await req.json();
    const message = update?.message;
    const chatId = String(message?.chat?.id || '');
    const userId = String(message?.from?.id || '');
    const username = String(message?.from?.username || '');
    const text = String(message?.text || '').trim();
    if (!chatId || !text) return Response.json({ ok: true, ignored: true });
    assertTelegramChat(chatId);

    const supabase = supabaseAdmin();
    const { data: state } = await supabase.from('telegram_bot_state').select('*').eq('chat_id', chatId).maybeSingle();
    await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, user_id: userId, username, last_message: text, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

    if (text === '/start' || text === 'القائمة' || text === 'Menu') {
      await clearFlow(supabase, chatId);
      await sendTelegramMessage(chatId, 'جاهز. اختر من لوحة التحكم:', MAIN_KEYBOARD);
      return Response.json({ ok: true });
    }

    if (state?.current_flow === 'awaiting_learning_account') {
      const handle = extractHandle(text);
      if (!handle) return reply(chatId, 'أرسل اليوزر فقط مثل: emollick أو @emollick');
      await supabase.from('accounts').upsert({ handle, username: handle, tier: 2, active: true, notes: 'Added from Telegram learning flow.' }, { onConflict: 'handle' });
      await clearFlow(supabase, chatId);
      await reply(chatId, `تمت إضافة حساب التعلم: @${htmlEscape(handle)}\n\nشغّل الآن: 🚀 تشغيل فحص تعلم أو 🔍 دورة تعلم ذكية`);
      return Response.json({ ok: true });
    }

    if (state?.current_flow === 'awaiting_learning_tweet') {
      const tweetUrl = extractTweetUrl(text);
      if (!tweetUrl) return reply(chatId, 'أرسل رابط تغريدة X صحيح مثل: https://x.com/user/status/123');
      await supabase.from('learning_tweet_queue').insert({ tweet_url: tweetUrl, source: 'telegram', status: 'pending', notes: 'Added from Telegram.' });
      await clearFlow(supabase, chatId);
      await reply(chatId, `تمت إضافة التغريدة لقائمة التعلم:\n${htmlEscape(tweetUrl)}`);
      return Response.json({ ok: true });
    }

    if (text === '📊 حالة الحساب') return accountStatus(supabase, chatId);
    if (text === '📊 مسح الأداء') return triggerEndpoint(req, chatId, '/api/account-performance-scan');
    if (text === '🧠 حالة التعلم') return learningStatus(supabase, chatId);
    if (text === '➕ إضافة حساب للتعلم') return startFlow(supabase, chatId, 'awaiting_learning_account', 'أرسل حساب X للتعلم منه. مثال: emollick أو @emollick');
    if (text === '🔗 إضافة تغريدة للتعلم') return startFlow(supabase, chatId, 'awaiting_learning_tweet', 'أرسل رابط تغريدة X ليتم إدخالها في قائمة التعلم.');
    if (text === '📋 المهام اليومية') return dailyTasks(supabase, chatId);
    if (text === '✅ محتوى جاهز للنشر') return readyContent(supabase, chatId);
    if (text === '🔍 دورة تعلم ذكية') return triggerEndpoint(req, chatId, '/api/learning-cycle');
    if (text === '🧭 محرك القرار') return triggerEndpoint(req, chatId, '/api/format-decision');
    if (text === '🏭 إنتاج المحتوى') return triggerEndpoint(req, chatId, '/api/production-cycle');
    if (text === '🚀 تشغيل فحص تعلم') return triggerEndpoint(req, chatId, '/api/viral-account-scan?max_accounts=2&tweets_per_account=8');
    if (text === '🧪 تشغيل خطة اليوم') return triggerEndpoint(req, chatId, '/api/daily-run');
    if (text === '🛡 فحص الحماية') return shieldTest(supabase, chatId);
    if (text === '🔎 اكتشاف تلقائي') return triggerEndpoint(req, chatId, '/api/research-intel-v4');
    if (text === '📦 زحف مستودع') return startFlow(supabase, chatId, 'awaiting_repo_url', 'أرسل رابط مستودع GitHub للتعلم منه.');

    await reply(chatId, 'لم أفهم الأمر. استخدم الأزرار في لوحة التحكم.');
    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET() { return Response.json({ ok: true, endpoint: 'telegram-webhook' }); }

async function reply(chatId: string, text: string) {
  await sendTelegramMessage(chatId, text, MAIN_KEYBOARD);
  return Response.json({ ok: true });
}

async function clearFlow(supabase: any, chatId: string) {
  await supabase.from('telegram_bot_state').update({ current_flow: null, flow_payload: {}, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
}

async function startFlow(supabase: any, chatId: string, flow: string, text: string) {
  await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, current_flow: flow, flow_payload: {}, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
  return reply(chatId, text);
}

async function accountStatus(supabase: any, chatId: string) {
  const [account, content, actions, cards] = await Promise.all([
    supabase.from('account_state').select('*').order('last_live_check_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('content_log').select('publish_status', { count: 'exact', head: false }).limit(200),
    supabase.from('action_queue').select('status', { count: 'exact', head: false }).eq('status', 'pending').limit(200),
    supabase.from('content_production_cards').select('quality_status').limit(200)
  ]);
  const rows = content.data || [];
  const ready = rows.filter((x: any) => x.publish_status === 'ready').length;
  const review = rows.filter((x: any) => x.publish_status === 'needs_review').length;
  const readyCards = (cards.data || []).filter((x: any) => x.quality_status === 'ready').length;
  const a = account.data || {};
  return reply(chatId, `<b>حالة الحساب @${htmlEscape(a.account_handle || '30piq')}</b>\nالمتابعين: ${a.followers_count ?? 0}\nالمنشورات: ${a.posts_count ?? 0}\nالمحتوى الجاهز: ${ready}\nبطاقات إنتاج جاهزة: ${readyCards}\nيحتاج مراجعة: ${review}\nالمهام المعلقة: ${actions.count ?? actions.data?.length ?? 0}\nآخر فحص: ${htmlEscape(a.last_live_check_at || '-')}`);
}

async function learningStatus(supabase: any, chatId: string) {
  const [accounts, runs, tweets, queued, cycles, opps, hyps, decisions, cards] = await Promise.all([
    supabase.from('accounts').select('id', { count: 'exact', head: true }),
    supabase.from('viral_scan_runs').select('id', { count: 'exact', head: true }),
    supabase.from('viral_tweet_analyses').select('id', { count: 'exact', head: true }),
    supabase.from('learning_tweet_queue').select('status').limit(100),
    supabase.from('learning_cycles').select('id', { count: 'exact', head: true }),
    supabase.from('content_opportunities').select('id', { count: 'exact', head: true }),
    supabase.from('original_content_hypotheses').select('quality_status').limit(200),
    supabase.from('content_format_decisions').select('status', { count: 'exact', head: false }).limit(200),
    supabase.from('content_production_cards').select('quality_status').limit(200)
  ]);
  const pendingTweets = (queued.data || []).filter((x: any) => x.status === 'pending').length;
  const readyHyps = (hyps.data || []).filter((x: any) => x.quality_status === 'ready').length;
  const selectedDecisions = (decisions.data || []).filter((x: any) => x.status === 'selected').length;
  const readyCards = (cards.data || []).filter((x: any) => x.quality_status === 'ready').length;
  return reply(chatId, `<b>حالة التعلم</b>\nحسابات التعلم: ${accounts.count ?? 0}\nعمليات فحص X: ${runs.count ?? 0}\nتغريدات محللة: ${tweets.count ?? 0}\nدورات تعلم ذكية: ${cycles.count ?? 0}\nفرص محتوى: ${opps.count ?? 0}\nفرضيات جاهزة: ${readyHyps}\nقرارات بانتظار الإنتاج: ${selectedDecisions}\nبطاقات إنتاج جاهزة: ${readyCards}\nتغريدات بانتظار التعلم: ${pendingTweets}`);
}

async function dailyTasks(supabase: any, chatId: string) {
  const { data } = await supabase.from('action_queue').select('priority,action_type,instruction,status,created_at').eq('status', 'pending').order('created_at', { ascending: false }).order('priority', { ascending: true }).limit(8);
  if (!data?.length) return reply(chatId, 'لا توجد مهام معلقة.');
  const lines = data.map((x: any, i: number) => `${i + 1}. [${htmlEscape(x.action_type)}] ${htmlEscape(shortText(x.instruction, 160))}`);
  return reply(chatId, `<b>المهام اليومية</b>\n${lines.join('\n')}`);
}

async function readyContent(supabase: any, chatId: string) {
  const { data: cards } = await supabase.from('content_production_cards').select('*').eq('quality_status', 'ready').order('created_at', { ascending: false }).limit(5);
  if (cards?.length) {
    const lines = cards.map((x: any, i: number) => `${i + 1}. <b>${htmlEscape(x.production_type)}</b>\n${htmlEscape(shortText(x.final_text || JSON.stringify(x.thread_items || x.article_outline || x.repo_plan || x.video_script || x.carousel_plan), 320))}`);
    return reply(chatId, `<b>بطاقات محتوى جاهزة</b>\n\n${lines.join('\n\n')}`);
  }
  const { data } = await supabase.from('content_log').select('id,content_type,final_text,publish_status,notes,created_at').eq('publish_status', 'ready').order('created_at', { ascending: false }).limit(5);
  if (!data?.length) return reply(chatId, 'لا يوجد محتوى مصفى وجاهز للنشر الآن. شغّل 🔍 دورة تعلم ذكية ثم 🧭 محرك القرار ثم 🏭 إنتاج المحتوى.');
  const lines = data.map((x: any, i: number) => `${i + 1}. <b>${htmlEscape(x.content_type)}</b>\n${htmlEscape(shortText(x.final_text, 260))}`);
  return reply(chatId, `<b>محتوى جاهز للنشر</b>\n\n${lines.join('\n\n')}`);
}

async function shieldTest(supabase: any, chatId: string) {
  const { data: recentContent } = await supabase
    .from('content_log')
    .select('final_text,content_type,publish_status')
    .neq('publish_status', 'rejected')
    .order('published_at', { ascending: false })
    .limit(3);

  if (!recentContent?.length) {
    return reply(chatId, 'لا يوجد محتوى حديث لفحصه. شغّل 🧪 تشغيل خطة اليوم أولاً.');
  }

  const { shieldCheck } = await import('../../../../lib/account-shield');
  const lines: string[] = ['🛡 <b>فحص الحماية — آخر محتوى</b>', '━'.repeat(30)];

  for (const item of recentContent) {
    try {
      const result = await shieldCheck({
        text: item.final_text || '',
        type: 'tweet',
        deep_check: true
      });
      const status = result.passed ? '✅' : result.risk_level === 'danger' ? '🚫' : '⚠️';
      lines.push(`${status} <b>${htmlEscape(item.content_type)}</b>: ${result.summary}`);
      if (result.ai_rewrite) {
        lines.push(`  ✏️ <i>${htmlEscape(result.ai_rewrite.slice(0, 150))}</i>`);
      }
    } catch {
      lines.push(`❓ <b>${htmlEscape(item.content_type)}</b>: فشل الفحص`);
    }
  }

  return reply(chatId, lines.join('\n'));
}

async function triggerEndpoint(req: Request, chatId: string, path: string) {
  await sendTelegramMessage(chatId, 'بدأت التشغيل. سأرسل النتيجة المختصرة بعد انتهاء الطلب.', MAIN_KEYBOARD);
  const origin = new URL(req.url).origin;
  const secret = optionalEnv('ORCHESTRATOR_SECRET');
  const separator = path.includes('?') ? '&' : '?';
  const res = await fetch(`${origin}${path}${separator}secret=${encodeURIComponent(secret)}`, { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) return reply(chatId, `فشل التشغيل: ${htmlEscape(json.error || res.statusText)}`);
  if (path.includes('learning-cycle')) return reply(chatId, `تمت دورة التعلم الذكية.\nالفرص: ${json.inserted?.opportunities ?? 0}\nالفرضيات: ${json.inserted?.hypotheses ?? 0}\nجاهز مبدئيًا: ${json.inserted?.ready_hypotheses ?? 0}`);
  if (path.includes('format-decision')) return reply(chatId, `تم تشغيل محرك القرار.\nقرارات جديدة: ${json.inserted?.length ?? 0}`);
  if (path.includes('production-cycle')) return reply(chatId, `تم إنتاج بطاقات المحتوى.\nالبطاقات: ${json.inserted?.cards ?? 0}\nجاهز للنشر: ${json.inserted?.ready ?? 0}`);
  if (path.includes('viral-account-scan')) return reply(chatId, `تم فحص التعلم.\nالحسابات: ${json.handles?.length ?? 0}\nالمحفوظ: ${json.persisted?.length ?? 0}\nالأخطاء: ${json.errors?.length ?? 0}`);
  const ready = json.contentPack?.ready_count ?? 0;
  const safe = json.contentPack?.safe_to_publish ? 'نعم' : 'لا';
  return reply(chatId, `تم تشغيل خطة اليوم.\nجاهز للنشر: ${ready}\nآمن للنشر: ${safe}\nالنسخة: ${htmlEscape(json.orchestrator_version || '-')}`);
}
