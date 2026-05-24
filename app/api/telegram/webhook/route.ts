import { waitUntil } from '@vercel/functions';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandle, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage, shortText } from '../../../../lib/telegram';

/**
 * Telegram Webhook Handler
 *
 * التحسين الرئيسي: يرد على Telegram فوراً (200 OK) ويشتغل في الخلفية
 * هذا يمنع Read timeout expired و flood الرسائل
 */
export async function POST(req: Request) {
  let update: any;
  try {
    const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    update = await req.json();
    const message = update?.message;
    const chatId = String(message?.chat?.id || '');
    const userId = String(message?.from?.id || '');
    const username = String(message?.from?.username || '');
    const text = String(message?.text || '').trim();

    if (!chatId || !text) return Response.json({ ok: true, ignored: true });
    assertTelegramChat(chatId);

    // ═══ رد فوري على Telegram — لا يستنى أي شيء ═══
    // كل المعالجة تتم في الخلفية عبر waitUntil
    const processingPromise = handleMessage(chatId, userId, username, text, req);
    waitUntil(processingPromise);

    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET() { return Response.json({ ok: true, endpoint: 'telegram-webhook' }); }

/**
 * handleMessage — المعالجة الفعلية للرسالة (تعمل في الخلفية)
 */
async function handleMessage(chatId: string, userId: string, username: string, text: string, req: Request) {
  try {
    const supabase = supabaseAdmin();
    const { data: state } = await supabase.from('telegram_bot_state').select('*').eq('chat_id', chatId).maybeSingle();
    await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, user_id: userId, username, last_message: text, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

    if (text === '/start' || text === 'القائمة' || text === 'Menu') {
      await clearFlow(supabase, chatId);
      await sendTelegramMessage(chatId, 'جاهز. اختر من لوحة التحكم:', MAIN_KEYBOARD);
      return;
    }

    if (state?.current_flow === 'awaiting_learning_account') {
      const handle = extractHandle(text);
      if (!handle) { await sendReply(chatId, 'أرسل اليوزر فقط مثل: emollick أو @emollick أو رابط الحساب'); return; }
      let addedOk = false;
      let accountInfo = '';
      try {
        const { error } = await supabase.from('accounts').upsert({ handle, username: handle, tier: 2, active: true, notes: 'Added from Telegram learning flow.' }, { onConflict: 'handle' });
        if (!error) addedOk = true;
      } catch {}
      if (!addedOk) {
        try {
          const { error } = await supabase.from('accounts').upsert({ handle, username: handle }, { onConflict: 'handle' });
          if (!error) addedOk = true;
        } catch {}
      }
      try {
        const { getXUserByUsername } = await import('../../../../lib/x');
        const snapshot = await getXUserByUsername(handle);
        if (snapshot) {
          accountInfo = `\n\n✅ معلومات الحساب:\nالاسم: ${htmlEscape(snapshot.name || handle)}\nالمتابعين: ${snapshot.followers_count ?? '?'}\nالتغريدات: ${snapshot.tweet_count ?? '?'}`;
          try {
            await supabase.from('accounts').update({
              notes: `Added from Telegram. Followers: ${snapshot.followers_count}, Tweets: ${snapshot.tweet_count}, Verified: ${snapshot.verified || false}`,
              updated_at: new Date().toISOString()
            }).eq('handle', handle);
          } catch {}
        }
      } catch (err: any) {
        accountInfo = '\n\n⚠️ لم أتمكن من جلب معلومات الحساب الآن (سيتم جلبها لاحقاً).';
      }
      await clearFlow(supabase, chatId);
      if (addedOk) {
        await sendReply(chatId, `تمت إضافة حساب التعلم: @${htmlEscape(handle)}${accountInfo}\n\nشغّل الآن: 🚀 تشغيل فحص تعلم أو 🔍 دورة تعلم ذكية`);
      } else {
        await sendReply(chatId, `⚠️ قد يكون الحساب مضافاً مسبقاً: @${htmlEscape(handle)}${accountInfo}\n\nشغّل الآن: 🚀 تشغيل فحص تعلم أو 🔍 دورة تعلم ذكية`);
      }
      return;
    }

    if (state?.current_flow === 'awaiting_learning_tweet') {
      const tweetUrl = extractTweetUrl(text);
      if (!tweetUrl) { await sendReply(chatId, 'أرسل رابط تغريدة X صحيح مثل: https://x.com/user/status/123'); return; }
      const { data: insertedTweet, error: insertError } = await supabase.from('learning_tweet_queue').insert({ tweet_url: tweetUrl, source: 'telegram', status: 'pending', notes: 'Added from Telegram.' }).select('*').single();
      if (insertError) {
        await clearFlow(supabase, chatId);
        await sendReply(chatId, `خطأ في إضافة التغريدة: ${htmlEscape(insertError.message)}`);
        return;
      }
      let processResult = '';
      try {
        const { fetchTwitterApiJson, twitterApiBase, extractTweets, analyzeXTweet } = await import('../../../../lib/x');
        const urlMatch = String(tweetUrl).match(/\/status\/(\d+)/);
        if (urlMatch) {
          const tweetId = urlMatch[1];
          const base = twitterApiBase();
          const json = await fetchTwitterApiJson(`${base}/twitter/tweet/${tweetId}`);
          const rawTweets = extractTweets(json);
          if (rawTweets.length > 0) {
            const raw = rawTweets[0];
            const tweetUsername = raw?.author?.userName || raw?.author?.username || 'unknown';
            const user = { username: tweetUsername, followers_count: Number(raw?.author?.followers || 0), public_metrics: { followers_count: Number(raw?.author?.followers || 0) } };
            const normalized = {
              id: String(raw.id || raw.tweetId || raw.rest_id || tweetId),
              text: raw.text || raw.full_text || raw.content || '',
              created_at: raw.createdAt || raw.created_at || raw.created_at_iso,
              public_metrics: {
                like_count: Number(raw.likeCount || raw.likes || raw.favorite_count || 0),
                reply_count: Number(raw.replyCount || raw.replies || raw.reply_count || 0),
                retweet_count: Number(raw.retweetCount || raw.retweets || raw.retweet_count || 0),
                quote_count: Number(raw.quoteCount || raw.quotes || raw.quote_count || 0),
                bookmark_count: Number(raw.bookmarkCount || raw.bookmarks || 0),
                view_count: Number(raw.viewCount || raw.views || 0)
              },
              entities: raw.entities || {},
              is_reply: Boolean(raw.isReply || raw.in_reply_to_status_id),
              author: raw.author || raw.user
            };
            const analysis = analyzeXTweet(normalized, user);
            await supabase.from('learning_tweet_queue').update({
              status: 'processed',
              fetched_data: analysis,
              updated_at: new Date().toISOString()
            }).eq('id', insertedTweet.id);
            const eng = analysis.engagement_per_1k_followers ?? 0;
            processResult = `\n\n✅ تم التحليل:\nالمؤلف: @${htmlEscape(tweetUsername)}\nالمتابعين: ${user.followers_count}\nالتفاعل/1K: ${eng}\nالنص: ${htmlEscape(shortText(analysis.text, 120))}`;
          } else {
            await supabase.from('learning_tweet_queue').update({
              status: 'failed',
              error: 'No tweet data returned from API',
              updated_at: new Date().toISOString()
            }).eq('id', insertedTweet.id);
            processResult = '\n\n⚠️ لم يتم العثور على بيانات التغريدة. ستُعالج لاحقاً في دورة التعلم.';
          }
        }
      } catch (processErr: any) {
        await supabase.from('learning_tweet_queue').update({
          status: 'failed',
          error: String(processErr.message || processErr).slice(0, 500),
          updated_at: new Date().toISOString()
        }).eq('id', insertedTweet.id);
        processResult = `\n\n⚠️ فشل التحليل الفوري: ${htmlEscape(String(processErr.message || '').slice(0, 100))}. ستُعالج لاحقاً في دورة التعلم.`;
      }
      await clearFlow(supabase, chatId);
      await sendReply(chatId, `تمت إضافة التغريدة لقائمة التعلم:\n${htmlEscape(tweetUrl)}${processResult}`);
      return;
    }

    // ═══ زحف مستودع GitHub ═══
    if (state?.current_flow === 'awaiting_repo_url') {
      const { extractGitHubRepo } = await import('../../../../lib/telegram');
      const repoUrl = extractGitHubRepo(text);
      if (!repoUrl) { await sendReply(chatId, 'أرسل رابط مستودع GitHub صحيح مثل: https://github.com/owner/repo أو owner/repo'); return; }
      await clearFlow(supabase, chatId);
      await sendTelegramMessage(chatId, 'بدأت عملية زحف المستودع. سأرسل النتيجة بعد الانتهاء.', MAIN_KEYBOARD);
      const origin = optionalEnv('PUBLIC_BASE_URL') || 'https://x-ai-content-factory-orchestrator.vercel.app';
      const secret = optionalEnv('ORCHESTRATOR_SECRET');
      try {
        const res = await fetch(`${origin}/api/repo-ingest?secret=${encodeURIComponent(secret)}&repo_url=${encodeURIComponent(repoUrl)}`, { method: 'GET' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) { await sendReply(chatId, `فشل زحف المستودع: ${htmlEscape(json.error || res.statusText)}`); return; }
        const ingested = json.ingested ?? json.files_ingested ?? 0;
        await sendReply(chatId, `تم زحف المستودع بنجاح.\nالملفات المستوردة: ${ingested}\n\nشغّل الآن: 🔍 دورة تعلم ذكية أو 🚀 تشغيل فحص تعلم`);
      } catch (e: any) {
        await sendReply(chatId, `فشل زحف المستودع: ${htmlEscape(e.message || 'خطأ غير معروف')}`);
      }
      return;
    }

    // ═══ تأكيد التصفير ═══
    if (state?.current_flow === 'awaiting_reset_confirmation') {
      await clearFlow(supabase, chatId);
      const confirmText = text.trim();
      if (confirmText === 'نعم' || confirmText === 'اي' || confirmText === 'أي' || confirmText === 'اه' || confirmText === 'آه' || confirmText.toLowerCase() === 'yes' || confirmText === '١') {
        await resetOperationalData(supabase, chatId);
      } else {
        await sendReply(chatId, 'تم إلغاء التصفير. لم يتم حذف أي شيء.');
      }
      return;
    }

    // ═══ معالجة الأزرار ═══
    if (text === '📊 حالة الحساب') return accountStatus(supabase, chatId);
    if (text === '📊 مسح الأداء') return triggerEndpoint(chatId, '/api/account-performance-scan');
    if (text === '🧠 حالة التعلم') return learningStatus(supabase, chatId);
    if (text === '➕ إضافة حساب للتعلم') return startFlow(supabase, chatId, 'awaiting_learning_account', 'أرسل حساب X للتعلم منه. مثال: emollick أو @emollick أو رابط الحساب');
    if (text === '🔗 إضافة تغريدة للتعلم') return startFlow(supabase, chatId, 'awaiting_learning_tweet', 'أرسل رابط تغريدة X ليتم إدخالها في قائمة التعلم.');
    if (text === '📋 المهام اليومية') return dailyTasks(supabase, chatId);
    if (text === '✅ محتوى جاهز للنشر') return readyContent(supabase, chatId);
    if (text === '🔍 دورة تعلم ذكية') return triggerEndpoint(chatId, '/api/learning-cycle');
    if (text === '🧭 محرك القرار') return triggerEndpoint(chatId, '/api/format-decision');
    if (text === '🏭 إنتاج المحتوى') return triggerEndpoint(chatId, '/api/production-cycle');
    if (text === '🚀 تشغيل فحص تعلم') return triggerEndpoint(chatId, '/api/viral-account-scan?max_accounts=2&tweets_per_account=8');
    if (text === '🧪 تشغيل خطة اليوم') return triggerEndpoint(chatId, '/api/daily-run');
    if (text === '🛡 فحص الحماية') return shieldTest(supabase, chatId);
    if (text === '🔎 اكتشاف تلقائي') return triggerEndpoint(chatId, '/api/research-intel-v4');
    if (text === '📦 زحف مستودع') return startFlow(supabase, chatId, 'awaiting_repo_url', 'أرسل رابط مستودع GitHub للتعلم منه.');
    if (text === '📅 مراجعة أسبوعية') return triggerEndpoint(chatId, '/api/weekly-review');
    if (text === '🧹 صيانة الذاكرة') return triggerEndpoint(chatId, '/api/memory-maintenance-run');
    if (text === '📈 تعلم النمو') return triggerEndpoint(chatId, '/api/growth-learning-run');
    if (text === '🔄 تصفير البيانات') return startFlow(supabase, chatId, 'awaiting_reset_confirmation', '⚠️ <b>تأكيد تصفير البيانات</b>\n\nسيتم حذف جميع البيانات التشغيلية:\n• المهام والمحتوى المولّد\n• سجلات التسليم والجلسات\n• الفرضيات والفرص والبطاقات\n• نتائج البحث والاتجاهات\n\n<b>ما يُحافظ عليه (العقل):</b>\n✅ قواعد خوارزمية X\n✅ أنماط الأسلوب الفيروسي\n✅ أنماط الحسابات\n✅ الذاكرة العاملة\n✅ قواعد التعلم السببية\n✅ الحسابات المُضافة\n✅ قواعد توجيه النماذج\n\nأرسل <b>نعم</b> للتأكيد أو أي شيء آخر للإلغاء.');

    await sendReply(chatId, 'لم أفهم الأمر. استخدم الأزرار في لوحة التحكم.');
  } catch (err: any) {
    // سجّل الخطأ بس ما ترمي استثناء (عشان ما تعطل الخلفية)
    console.error('Telegram handler error:', err.message);
  }
}

async function sendReply(chatId: string, text: string) {
  await sendTelegramMessage(chatId, text, MAIN_KEYBOARD);
}

async function clearFlow(supabase: any, chatId: string) {
  await supabase.from('telegram_bot_state').update({ current_flow: null, flow_payload: {}, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
}

async function startFlow(supabase: any, chatId: string, flow: string, text: string) {
  await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, current_flow: flow, flow_payload: {}, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
  await sendReply(chatId, text);
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
  await sendReply(chatId, `<b>حالة الحساب @${htmlEscape(a.account_handle || '30piq')}</b>\nالمتابعين: ${a.followers_count ?? 0}\nالمنشورات: ${a.posts_count ?? 0}\nالمحتوى الجاهز: ${ready}\nبطاقات إنتاج جاهزة: ${readyCards}\nيحتاج مراجعة: ${review}\nالمهام المعلقة: ${actions.count ?? actions.data?.length ?? 0}\nآخر فحص: ${htmlEscape(a.last_live_check_at || '-')}`);
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
  await sendReply(chatId, `<b>حالة التعلم</b>\nحسابات التعلم: ${accounts.count ?? 0}\nعمليات فحص X: ${runs.count ?? 0}\nتغريدات محللة: ${tweets.count ?? 0}\nدورات تعلم ذكية: ${cycles.count ?? 0}\nفرص محتوى: ${opps.count ?? 0}\nفرضيات جاهزة: ${readyHyps}\nقرارات بانتظار الإنتاج: ${selectedDecisions}\nبطاقات إنتاج جاهزة: ${readyCards}\nتغريدات بانتظار التعلم: ${pendingTweets}`);
}

async function dailyTasks(supabase: any, chatId: string) {
  const { data } = await supabase.from('action_queue').select('priority,action_type,instruction,status,created_at').eq('status', 'pending').order('priority', { ascending: true }).limit(20);
  if (!data?.length) { await sendReply(chatId, 'لا توجد مهام معلقة.\n\nشغّل 🧪 تشغيل خطة اليوم أولاً لتوليد المهام.'); return; }

  const cleanInstruction = (raw: string): string => {
    let text = String(raw || '').trim();
    text = text.replace(/\[(\w+)\]\s*/g, '');
    text = text.replace(/^(human_publish_or_engage|quality_review_or_research|publish|engage|review|research|create_asset|log_results)\s*[:\-—]?\s*/i, '');
    text = text.replace(/claim_needs_source/g, 'يحتاج مصدر موثق');
    text = text.replace(/generic_or_engagement_bait/g, 'محتوى عام أو بيت تفاعل');
    text = text.replace(/first_person_claim/g, 'ادعاء شخصي غير موثق');
    text = text.replace(/unsourced_claim/g, 'ادعاء بدون مصدر');
    text = text.replace(/hashtag_violation/g, 'يحتوي هاشتاقات');
    text = text.replace(/too_short/g, 'قصير جداً');
    text = text.replace(/instruction_instead_of_content/g, 'تعليمات بدل محتوى');
    return text.trim();
  };

  const seenTypes = new Set<string>();
  const seenInstructions = new Set<string>();
  const unique = data.filter((x: any) => {
    const cleanText = cleanInstruction(x.instruction || '');
    if (!cleanText) return false;
    const typeKey = String(x.action_type || '').toLowerCase();
    if (['publish', 'human_publish_or_engage'].includes(typeKey) && seenTypes.has('publish')) return false;
    if (['engage'].includes(typeKey) && seenTypes.has('engage')) return false;
    if (['review', 'quality_review_or_research'].includes(typeKey) && seenTypes.has('review')) return false;
    if (['research'].includes(typeKey) && seenTypes.has('research')) return false;
    const normalKey = cleanText.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seenInstructions.has(normalKey)) return false;
    seenTypes.add(typeKey === 'human_publish_or_engage' ? 'publish' : typeKey === 'quality_review_or_research' ? 'review' : typeKey);
    seenInstructions.add(normalKey);
    return true;
  }).slice(0, 6);

  const typeLabels: Record<string, { emoji: string; label: string }> = {
    publish: { emoji: '✍️', label: 'نشر' },
    engage: { emoji: '💬', label: 'تفاعل' },
    review: { emoji: '🔍', label: 'مراجعة' },
    research: { emoji: '🔎', label: 'بحث' },
    create_asset: { emoji: '🏗️', label: 'إنشاء أصل' },
    log_results: { emoji: '📊', label: 'تسجيل' },
    human_publish_or_engage: { emoji: '✍️', label: 'نشر/تفاعل' },
    quality_review_or_research: { emoji: '🔍', label: 'مراجعة جودة' }
  };

  const lines = unique.map((x: any, i: number) => {
    const typeInfo = typeLabels[x.action_type] || { emoji: '📋', label: x.action_type || 'مهمة' };
    const cleanText = cleanInstruction(x.instruction || '');
    return `${i + 1}. ${typeInfo.emoji} <b>${typeInfo.label}:</b> ${htmlEscape(shortText(cleanText, 180))}`;
  });
  await sendReply(chatId, `<b>📋 المهام اليومية</b>\n━━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\n<i>شغّل 🧪 تشغيل خطة اليوم لتحديث المهام</i>`);
}

async function readyContent(supabase: any, chatId: string) {
  const { data: cards } = await supabase.from('content_production_cards').select('*').eq('quality_status', 'ready').order('created_at', { ascending: false }).limit(5);
  if (cards?.length) {
    const lines = cards.map((x: any, i: number) => `${i + 1}. <b>${htmlEscape(x.production_type)}</b>\n${htmlEscape(shortText(x.final_text || JSON.stringify(x.thread_items || x.article_outline || x.repo_plan || x.video_script || x.carousel_plan), 320))}`);
    await sendReply(chatId, `<b>بطاقات محتوى جاهزة</b>\n\n${lines.join('\n\n')}`);
    return;
  }
  const { data } = await supabase.from('content_log').select('id,content_type,final_text,publish_status,notes,created_at').eq('publish_status', 'ready').order('created_at', { ascending: false }).limit(5);
  if (!data?.length) { await sendReply(chatId, 'لا يوجد محتوى مصفى وجاهز للنشر الآن. شغّل 🔍 دورة تعلم ذكية ثم 🧭 محرك القرار ثم 🏭 إنتاج المحتوى.'); return; }
  const lines = data.map((x: any, i: number) => `${i + 1}. <b>${htmlEscape(x.content_type)}</b>\n${htmlEscape(shortText(x.final_text, 260))}`);
  await sendReply(chatId, `<b>محتوى جاهز للنشر</b>\n\n${lines.join('\n\n')}`);
}

async function shieldTest(supabase: any, chatId: string) {
  const { data: recentContent } = await supabase
    .from('content_log')
    .select('final_text,content_type,publish_status')
    .neq('publish_status', 'rejected')
    .order('published_at', { ascending: false })
    .limit(3);

  if (!recentContent?.length) {
    await sendReply(chatId, 'لا يوجد محتوى حديث لفحصه. شغّل 🧪 تشغيل خطة اليوم أولاً.');
    return;
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

  await sendReply(chatId, lines.join('\n'));
}

async function resetOperationalData(supabase: any, chatId: string) {
  await sendTelegramMessage(chatId, '🔄 بدأت عملية التصفير... جاري الحذف.', MAIN_KEYBOARD);

  const tablesToDelete = [
    'action_queue', 'content_log', 'content_deliveries', 'session_logs',
    'daily_checkins', 'content_opportunities', 'original_content_hypotheses',
    'content_format_decisions', 'content_production_cards', 'learning_tweet_queue',
    'learning_cycles', 'performance_scans', 'telegram_bot_state', 'account_state',
    'viral_scan_runs', 'viral_tweet_analyses', 'raw_research_items', 'trends',
    'creator_intel', 'discovered_items', 'repo_source_files', 'growth_learning_runs',
    'requirement_status', 'target_plans',
  ];

  const results: { table: string; deleted: number | string }[] = [];

  for (const table of tablesToDelete) {
    try {
      const { count, error } = await supabase.from(table).delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) {
        results.push({ table, deleted: `خطأ: ${error.message?.slice(0, 50)}` });
      } else {
        results.push({ table, deleted: count ?? 0 });
      }
    } catch (e: any) {
      results.push({ table, deleted: `خطأ: ${String(e.message || '').slice(0, 50)}` });
    }
  }

  const keptTables = [
    'x_algorithm_learning_rules', 'viral_style_patterns', 'viral_account_patterns',
    'working_memory', 'system_learning_rules', 'model_routing_rules', 'accounts', 'repo_extracted_rules',
  ];

  const keptCounts: { table: string; rows: number }[] = [];
  for (const table of keptTables) {
    try {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      keptCounts.push({ table, rows: count ?? 0 });
    } catch {
      keptCounts.push({ table, rows: -1 });
    }
  }

  const deletedTotal = results.reduce((sum, r) => typeof r.deleted === 'number' ? sum + r.deleted : sum, 0);
  const keptTotal = keptCounts.reduce((sum, r) => sum + Math.max(r.rows, 0), 0);

  const lines = [
    `✅ <b>تم تصفير البيانات بنجاح</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<b>تم حذف:</b> ${deletedTotal} صف من ${tablesToDelete.length} جدول`,
    ``,
    `<b>🧠 العقل محفوظ:</b> ${keptTotal} صف`,
  ];

  for (const k of keptCounts) {
    if (k.rows > 0) {
      lines.push(`  ✅ ${k.table}: ${k.rows}`);
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>شغّل 🧪 تشغيل خطة اليوم لبدء تجربة جديدة بالعقل المحفوظ</i>');

  await sendReply(chatId, lines.join('\n'));
}

/**
 * triggerEndpoint — يشغّل endpoint آخر ويبعت النتيجة لتليجرام
 *
 * التحسين: يرسل رسالة "بدأت" فوراً ويشتغل في الخلفية
 */
async function triggerEndpoint(chatId: string, path: string) {
  const autoDelivers = path.includes('daily-run');

  // أرسل رسالة فورية للمستخدم
  if (autoDelivers) {
    await sendTelegramMessage(chatId, '⏳ جاري تشغيل خطة اليوم... سأرسل النتيجة عند الانتهاء.', MAIN_KEYBOARD);
  } else {
    await sendTelegramMessage(chatId, '⏳ بدأت التشغيل... سأرسل النتيجة عند الانتهاء.', MAIN_KEYBOARD);
  }

  const origin = optionalEnv('PUBLIC_BASE_URL') || 'https://x-ai-content-factory-orchestrator.vercel.app';
  const secret = optionalEnv('ORCHESTRATOR_SECRET');
  const separator = path.includes('?') ? '&' : '?';

  try {
    const res = await fetch(`${origin}${path}${separator}secret=${encodeURIComponent(secret)}`, { method: 'GET' });
    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.ok) {
      await sendReply(chatId, `❌ فشل التشغيل: ${htmlEscape(json.error || res.statusText)}`);
      return;
    }

    if (path.includes('learning-cycle')) { await sendReply(chatId, `✅ تمت دورة التعلم الذكية.\nالفرص: ${json.inserted?.opportunities ?? 0}\nالفرضيات: ${json.inserted?.hypotheses ?? 0}\nجاهز مبدئيًا: ${json.inserted?.ready_hypotheses ?? 0}`); return; }
    if (path.includes('format-decision')) { await sendReply(chatId, `✅ تم تشغيل محرك القرار.\nقرارات جديدة: ${json.inserted?.length ?? 0}`); return; }
    if (path.includes('production-cycle')) { await sendReply(chatId, `✅ تم إنتاج بطاقات المحتوى.\nالبطاقات: ${json.inserted?.cards ?? 0}\nجاهز للنشر: ${json.inserted?.ready ?? 0}`); return; }
    if (path.includes('viral-account-scan')) { await sendReply(chatId, `✅ تم فحص التعلم.\nالحسابات: ${json.handles?.length ?? 0}\nالمحفوظ: ${json.persisted?.length ?? 0}\nالأخطاء: ${json.errors?.length ?? 0}`); return; }
    if (path.includes('weekly-review')) { await sendReply(chatId, `✅ تمت المراجعة الأسبوعية.\n${htmlEscape(json.summary || json.version || 'تم بنجاح')}`); return; }
    if (path.includes('memory-maintenance')) { await sendReply(chatId, `✅ تمت صيانة الذاكرة.\n${htmlEscape(json.summary || json.version || 'تم بنجاح')}`); return; }
    if (path.includes('growth-learning')) { await sendReply(chatId, `✅ تم تعلم النمو.\nقواعد الخوارزمية: ${json.inserted?.algorithm_rules ?? 0}\nأنماط الأسلوب: ${json.inserted?.style_patterns ?? 0}\nفرص MCP: ${json.inserted?.mcp_opportunities ?? 0}`); return; }
    if (path.includes('research-intel')) { await sendReply(chatId, `✅ تم الاكتشاف التلقائي.\n${htmlEscape(json.intel?.market_read || json.version || 'تم بنجاح')}`); return; }

    // daily-run — ملخص
    if (autoDelivers) {
      const ready = json.contentPack?.ready_count ?? 0;
      const needsReview = (json.contentPack?.quality_gate || []).filter((q: any) => q.status === 'needs_review').length;
      const blocked = (json.contentPack?.shield_results || []).filter((s: any) => !s.passed).length;
      const types = [...new Set((json.diverse_content || []).map((d: any) => d.content_type))].join(', ') || 'تغريدات';
      await sendReply(chatId, `✅ تم تشغيل خطة اليوم.\nجاهز للنشر: ${ready} | يحتاج مراجعة: ${needsReview} | محظور: ${blocked}\nالأنواع: ${types}\n\n📋 اضغط المهام اليومية لمشاهدة الخطوات التالية.`);
      return;
    }

    const ready = json.contentPack?.ready_count ?? 0;
    const safe = json.contentPack?.safe_to_publish ? 'نعم' : 'لا';
    await sendReply(chatId, `✅ تم التشغيل.\nجاهز للنشر: ${ready}\nآمن للنشر: ${safe}\nالنسخة: ${htmlEscape(json.orchestrator_version || json.version || '-')}`);
  } catch (e: any) {
    await sendReply(chatId, `❌ فشل التشغيل: ${htmlEscape(e.message || 'خطأ غير معروف')}`);
  }
}
