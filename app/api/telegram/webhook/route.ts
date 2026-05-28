import { runBackground } from '../../../../lib/background';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandles, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage } from '../../../../lib/telegram';

const VERSION = 'telegram-webhook-v4-unified-gated';

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

    if (!chatId || !text) return Response.json({ ok: true, ignored: true, version: VERSION });
    assertTelegramChat(chatId);

    runBackground(handleMessage(chatId, userId, username, text));
    return Response.json({ ok: true, version: VERSION });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, endpoint: VERSION });
}

async function handleMessage(chatId: string, userId: string, username: string, text: string) {
  try {
    const supabase = supabaseAdmin();
    await supabase.from('telegram_bot_state').upsert({
      chat_id: chatId,
      user_id: userId,
      username,
      last_message: text,
      updated_at: new Date().toISOString()
    }, { onConflict: 'chat_id' });

    const { data: state } = await supabase.from('telegram_bot_state').select('*').eq('chat_id', chatId).maybeSingle();

    if (text === '/start' || text === 'القائمة' || text === 'Menu') {
      await clearFlow(supabase, chatId);
      await sendReply(chatId, 'جاهز. الواجهة عربية، لكن محتوى X والتوصيات English-only. استخدم زر 🧠 تشغيل كامل.');
      return;
    }

    if (text === '🧠 تشغيل كامل') {
      await sendReply(chatId, '⏳ جاري تشغيل المسار الموحّد: crawl → English gate → decision engine → Telegram.');
      const result = await callInternalJson('/api/daily-run?source=telegram-unified');
      if (!result.ok) {
        await sendReply(chatId, `❌ فشل التشغيل: ${htmlEscape(result.error || 'unknown error')}`);
        return;
      }
      await sendReply(chatId, `✅ انتهى التشغيل الموحّد.\nالنسخة: ${htmlEscape(result.version || 'unknown')}\nمختار: ${result.decision?.selected ?? 0}\nمؤجل: ${result.decision?.held ?? 0}\nبوابة النشر: ${result.decision?.publish_gate?.accepted ?? 0} صالح / ${result.decision?.publish_gate?.rejected ?? 0} مرفوض`);
      return;
    }

    if (/^نشرت\s+/i.test(text)) {
      const parsed = parsePublishedCommand(text);
      if (!parsed.published_url) {
        await sendReply(chatId, '❌ الصيغة الصحيحة:\nنشرت 1 ثم رابط منشور X');
        return;
      }
      const result = await callInternalJson('/api/log-published-decision', {
        method: 'POST',
        body: {
          published_url: parsed.published_url,
          recommendation_index: parsed.recommendation_index
        }
      });
      if (!result.ok) {
        await sendReply(chatId, `❌ فشل تسجيل المنشور: ${htmlEscape(result.error || 'unknown error')}`);
        return;
      }
      await sendReply(chatId, [
        '✅ <b>تم تسجيل المنشور</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `🔗 ${htmlEscape(parsed.published_url)}`,
        parsed.recommendation_index ? `📋 توصية رقم: ${parsed.recommendation_index}` : '',
        result.recommendation_linked ? '🔗 مربوط بالتوصية: نعم' : '🔗 مربوط بآخر قرار: نعم',
        result.content_type ? `📝 النوع: ${htmlEscape(result.content_type)}` : '',
        result.decision_score !== undefined ? `نقاط: ${result.decision_score}` : '',
        result.brain_rules_count !== undefined ? `🧠 قواعد: ${result.brain_rules_count}` : '',
        '',
        '<i>سيتم فحص الأداء لاحقًا.</i>'
      ].filter(Boolean).join('\n'));
      return;
    }

    if (text === '➕ إضافة حساب') {
      await setFlow(supabase, chatId, 'awaiting_account');
      await sendReply(chatId, 'أرسل حسابات X للتعلم فقط. مثال:\nemollick naval sama');
      return;
    }

    if (state?.current_flow === 'awaiting_account') {
      await clearFlow(supabase, chatId);
      const handles = extractHandles(text).slice(0, 10);
      if (!handles.length) {
        await sendReply(chatId, 'أرسل يوزر صحيح مثل: emollick أو @naval');
        return;
      }
      for (const handle of handles) {
        try {
          await supabase.from('accounts').upsert({ handle, tier: 2, notes: 'Added from Telegram unified webhook' }, { onConflict: 'handle' });
        } catch {
          try { await supabase.from('accounts').upsert({ handle }, { onConflict: 'handle' }); } catch {}
        }
      }
      await sendReply(chatId, `✅ تمت إضافة ${handles.length} حساب تعلم:\n${handles.map(h => `• @${htmlEscape(h)}`).join('\n')}\n\nاضغط 🧠 تشغيل كامل لتشغيل المسار الموحّد.`);
      return;
    }

    if (text === '📋 قائمة الحسابات') {
      const { data: accounts } = await supabase.from('accounts').select('handle, tier, last_checked').order('tier', { ascending: true }).limit(50);
      if (!accounts?.length) {
        await sendReply(chatId, 'ℹ️ لا توجد حسابات. استخدم ➕ إضافة حساب.');
        return;
      }
      await sendReply(chatId, `📋 <b>قائمة الحسابات (${accounts.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n${accounts.map((a: any) => `• @${htmlEscape(a.handle)} | tier ${a.tier || '-'}`).join('\n')}`);
      return;
    }

    if (text === '🧩 محتويات العقل') {
      await sendReply(chatId, `🧩 ملخص العقل في المتصفح:\n<a href="${publicBaseUrl()}/api/brain-viewer">عرض تفصيلي</a>`);
      return;
    }

    if (['📊 تقرير الأداء', '✍️ اقتراح محتوى', '🔗 إضافة تغريدة'].includes(text)) {
      await sendReply(chatId, 'هذا الزر موقوف مؤقتًا في النسخة الموحدة حتى لا يختلط مع مسار النشر. استخدم 🧠 تشغيل كامل فقط.');
      return;
    }

    if (text === '✅ سجل منشور') {
      await sendReply(chatId, 'اكتب مباشرة: نشرت 1 ثم رابط منشور X');
      return;
    }

    if (text === '🔄 تصفير البيانات') {
      await sendReply(chatId, 'زر التصفير موقوف في النسخة الموحدة للحماية. أي تصفير يتم يدويًا فقط بعد مراجعة.');
      return;
    }

    await sendReply(chatId, 'استخدم الأزرار. للتشغيل: 🧠 تشغيل كامل. بعد النشر: نشرت 1 الرابط');
  } catch (err: any) {
    console.error('[telegram unified] error:', err.message);
    await sendReply(chatId, `❌ خطأ: ${htmlEscape(err.message || 'unknown error')}`);
  }
}

function parsePublishedCommand(text: string): { recommendation_index: number | null; published_url: string | null } {
  const after = text.replace(/^نشرت\s+/i, '').trim();
  const indexed = after.match(/^(\d+)\s+(https?:\/\/\S+)/i);
  const recommendationIndex = indexed ? Number(indexed[1]) : null;
  const urlPart = indexed ? indexed[2] : after;
  return { recommendation_index: recommendationIndex, published_url: extractTweetUrl(urlPart) };
}

async function callInternalJson(path: string, init?: { method?: string; body?: any }) {
  const secret = optionalEnv('ORCHESTRATOR_SECRET');
  if (!secret) return { ok: false, error: 'Missing ORCHESTRATOR_SECRET' };
  const res = await fetch(`${publicBaseUrl()}${path}`, {
    method: init?.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-orchestrator-secret': secret },
    body: init?.body ? JSON.stringify(init.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
  return json;
}

function publicBaseUrl(): string {
  const explicit = optionalEnv('PUBLIC_BASE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = optionalEnv('VERCEL_URL');
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'https://x-ai-content-factory-orchestrator.vercel.app';
}

async function sendReply(chatId: string, text: string) {
  await sendTelegramMessage(chatId, text, MAIN_KEYBOARD);
}

async function clearFlow(supabase: any, chatId: string) {
  await supabase.from('telegram_bot_state').update({ current_flow: null, flow_payload: {}, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
}

async function setFlow(supabase: any, chatId: string, flow: string) {
  await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, current_flow: flow, flow_payload: {}, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
}
