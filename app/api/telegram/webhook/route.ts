import { runBackground } from '../../../../lib/background';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandles, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage } from '../../../../lib/telegram';
import { runDailyPipeline } from '../../../../lib/daily-runner';
import { logPublishedDecision } from '../../../../lib/published-decision-logger';
import { getLatestPipelineRuns, getPipelineRun } from '../../../../lib/pipeline-run-tracker';

const VERSION = 'telegram-webhook-v6-tracked';

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

    // ═══ 🧠 تشغيل كامل — run shared pipeline directly (NO HTTP self-fetch) ═══
    if (text === '🧠 تشغيل كامل') {
      // Immediate status so the user knows the run started
      await sendReply(chatId, '⏳ بدأ التشغيل الموحّد...');

      try {
        const result = await runDailyPipeline({
          source: 'telegram-unified',
          notifyTelegram: true   // pipeline will deliver recommendations to Telegram itself
        });

        // Send run_id as soon as available
        if (result.pipeline_run_id) {
          const shortId = result.pipeline_run_id.slice(0, 8);
          await sendReply(chatId, `🆔 Run ID: ${shortId}`);
        }

        if (!result.ok) {
          await sendReply(chatId, `❌ فشل التشغيل: ${htmlEscape(result.error || 'unknown error')}`);
          return;
        }

        // Summary confirmation (recommendations were already sent by the pipeline)
        await sendReply(chatId, `✅ انتهى التشغيل الموحّد.\nالنسخة: ${htmlEscape(result.version || 'unknown')}\nمختار: ${result.decision.selected}\nمؤجل: ${result.decision.held}\nبوابة النشر: ${result.publishGate.accepted} صالح / ${result.publishGate.rejected} مرفوض`);
      } catch (pipelineErr: any) {
        await sendReply(chatId, `❌ فشل التشغيل: ${htmlEscape(pipelineErr.message || 'unknown error')}`);
      }
      return;
    }

    // ═══ 🧾 حالة التشغيل — show latest pipeline run status ═══
    if (text === '🧾 حالة التشغيل' || text === 'حالة التشغيل') {
      try {
        const runs = await getLatestPipelineRuns(1);
        if (!runs.length) {
          await sendReply(chatId, 'ℹ️ لا توجد عمليات تشغيل مسجلة بعد.');
          return;
        }

        const run = runs[0];
        const shortId = String(run.id).slice(0, 8);
        const startedAt = run.started_at ? new Date(run.started_at) : null;
        const updatedAt = run.updated_at ? new Date(run.updated_at) : null;
        const durationMs = startedAt && updatedAt ? updatedAt.getTime() - startedAt.getTime() : null;
        const durationStr = durationMs !== null ? `${Math.round(durationMs / 1000)}s` : '—';

        const statusEmoji = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '⏳';

        const lines: string[] = [
          `${statusEmoji} <b>حالة آخر تشغيل</b>`,
          '━━━━━━━━━━━━━━━━━━━━',
          `🆔 Run: ${shortId}`,
          `📡 المصدر: ${htmlEscape(run.source || '—')}`,
          `📊 الحالة: <b>${htmlEscape(run.status || '—')}</b>`,
          `🔄 الخطوة: ${htmlEscape(run.current_step || '—')}`,
          `⏱ المدة: ${durationStr}`,
          `👤 الحساب: ${htmlEscape(run.account_handle || '—')}`,
        ];

        // Decision info
        const dp = run.decision_payload || {};
        if (dp.selected !== undefined) lines.push(`🎯 مختار: ${dp.selected} | مؤجل: ${dp.held || 0}`);
        if (dp.gate_accepted !== undefined) lines.push(`🛡️ بوابة: ${dp.gate_accepted} صالح / ${dp.gate_rejected} مرفوض`);

        // Error
        if (run.error_message) {
          lines.push(`❌ الخطأ: ${htmlEscape(run.error_message.slice(0, 200))}`);
        }

        // Timing
        if (run.completed_at) lines.push(`✅ اكتمل: ${new Date(run.completed_at).toISOString().slice(0, 19)}`);
        if (run.failed_at) lines.push(`❌ فشل: ${new Date(run.failed_at).toISOString().slice(0, 19)}`);

        await sendReply(chatId, lines.join('\n'));
      } catch (err: any) {
        await sendReply(chatId, `❌ فشل جلب الحالة: ${htmlEscape(err.message || 'unknown')}`);
      }
      return;
    }

    // ═══ نشرت — log published decision directly (NO HTTP self-fetch) ═══
    if (/^نشرت\s+/i.test(text)) {
      const parsed = parsePublishedCommand(text);
      if (!parsed.published_url) {
        await sendReply(chatId, '❌ الصيغة الصحيحة:\nنشرت 1 ثم رابط منشور X');
        return;
      }

      const result = await logPublishedDecision({
        published_url: parsed.published_url,
        recommendation_index: parsed.recommendation_index
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

    await sendReply(chatId, 'استخدم الأزرار. للتشغيل: 🧠 تشغيل كامل. للحالة: 🧾 حالة التشغيل. بعد النشر: نشرت 1 الرابط');
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
