import { runBackground } from '../../../../lib/background';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandles, extractTweetUrl, htmlEscape, MAIN_KEYBOARD, sendTelegramMessage } from '../../../../lib/telegram';
import { logPublishedDecision } from '../../../../lib/published-decision-logger';
import {
  enqueuePipelineRun,
  cancelPipelineRun,
  getPipelineRunStatus,
  getActivePipelineRun,
  markStuckTasks
} from '../../../../lib/pipeline-queue';

const VERSION = 'telegram-webhook-v8-queue';

// Extend Vercel function timeout to maximum allowed (requires Pro plan or higher)
export const maxDuration = 300;

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

    // ═══ 🧠 تشغيل كامل — ENQUEUE ONLY, no direct pipeline execution ═══
    if (text === '🧠 تشغيل كامل') {
      try {
        // Mark stuck tasks/runs first
        await markStuckTasks(10);

        // Check if there's already an active run
        const activeRun = await getActivePipelineRun();
        if (activeRun) {
          const shortId = String(activeRun.id).slice(0, 8);
          const status = await getPipelineRunStatus(activeRun.id);
          const ts = status.task_summary;
          await sendReply(chatId, [
            `⚠️ يوجد تشغيل جارٍ بالفعل!`,
            `🆔 ${shortId} | الحالة: ${htmlEscape(activeRun.status || '—')} | الخطوة: ${htmlEscape(activeRun.current_step || '—')}`,
            `📊 المهام: ${ts.completed}/${ts.total} مكتملة | ${ts.failed} فاشلة | ${ts.queued} في الانتظار`,
            ts.running > 0 ? `🔄 جاري التنفيذ: ${ts.running} مهمة` : '',
            status.current_account ? `👤 الحساب الحالي: @${htmlEscape(status.current_account)}` : '',
            '',
            'اضغط 🧾 حالة التشغيل للمتابعة أو 🔄 إعادة تشغيل للبدء من جديد أو ⏸ إيقاف التشغيل للإيقاف.'
          ].filter(Boolean).join('\n'));
          return;
        }

        // Enqueue new pipeline run
        const result = await enqueuePipelineRun({
          source: 'telegram-unified',
          notifyTelegram: true
        });

        if (result.ok && result.run_id) {
          const shortId = result.run_id.slice(0, 8);
          await sendReply(chatId, [
            '✅ تم إنشاء تشغيل جديد',
            `🆔 Run ID: ${shortId}`,
            `📊 عدد المهام: ${result.task_count}`,
            '⚙️ سيتم التنفيذ عبر العامل الخلفي',
            '',
            'اضغط 🧾 حالة التشغيل للمتابعة'
          ].join('\n'));
        } else {
          await sendReply(chatId, `❌ فشل إنشاء التشغيل: ${htmlEscape(result.message || 'unknown error')}`);
        }
      } catch (err: any) {
        await sendReply(chatId, `❌ خطأ: ${htmlEscape(err.message || 'unknown error')}`);
      }
      return;
    }

    // ═══ 🧾 حالة التشغيل — show task progress, NO pipeline execution ═══
    if (text === '🧾 حالة التشغيل' || text === 'حالة التشغيل') {
      try {
        // Auto-detect and mark stuck tasks/runs
        const stuckTasksMarked = await markStuckTasks(10);

        const status = await getPipelineRunStatus();

        if (!status.ok || !status.run) {
          await sendReply(chatId, 'ℹ️ لا توجد عمليات تشغيل مسجلة بعد.');
          return;
        }

        const run = status.run;
        const shortId = String(run.id).slice(0, 8);
        const ts = status.task_summary;
        const startedAt = run.started_at ? new Date(run.started_at) : null;

        let durationStr = '—';
        const isRunning = run.status === 'running' || run.status === 'queued';

        if (startedAt) {
          if (isRunning) {
            durationStr = formatDuration(Date.now() - startedAt.getTime());
          } else {
            const endTime = run.completed_at ? new Date(run.completed_at)
              : run.failed_at ? new Date(run.failed_at)
              : run.cancelled_at ? new Date(run.cancelled_at)
              : run.updated_at ? new Date(run.updated_at)
              : null;
            if (endTime) durationStr = formatDuration(endTime.getTime() - startedAt.getTime());
          }
        }

        const statusEmoji = run.status === 'completed' ? '✅'
          : run.status === 'completed_with_warnings' ? '⚠️'
          : run.status === 'failed' ? '❌'
          : run.status === 'stuck' ? '⚠️'
          : run.status === 'cancelled' ? '🚫'
          : run.status === 'queued' ? '📋'
          : '⏳';

        const lines: string[] = [
          `${statusEmoji} <b>حالة التشغيل</b>`,
          '━━━━━━━━━━━━━━━━━━━━',
          `🆔 Run: ${shortId}`,
          `📡 المصدر: ${htmlEscape(run.source || '—')}`,
          `📊 الحالة: <b>${htmlEscape(run.status || '—')}</b>`,
          `🔄 الخطوة: ${htmlEscape(run.current_step || '—')}`,
          `⏱ المدة: ${durationStr}`,
          `📊 المهام: ${ts.completed}/${ts.total} مكتملة | ${ts.failed} فاشلة | ${ts.queued} في الانتظار`,
        ];

        if (status.current_account) {
          lines.push(`👤 الحساب الحالي: @${htmlEscape(status.current_account)}`);
        }

        if (isRunning && startedAt) {
          const elapsedMin = (Date.now() - startedAt.getTime()) / 60000;
          if (elapsedMin > 5) {
            lines.push('');
            lines.push(`⚠️ التشغيل جارٍ منذ ${Math.round(elapsedMin)} دقيقة`);
          }
        }

        // Stuck warning
        if (run.status === 'stuck') {
          lines.push('');
          lines.push('⚠️ <b>التشغيل علِق — اضغط 🔄 إعادة تشغيل أو ⏸ إيقاف التشغيل</b>');
        }

        // Decision info
        if (status.selected !== null) lines.push(`🎯 مختار: ${status.selected} | مؤجل: ${status.rejected ?? 0}`);
        const dp = run.decision_payload || {};
        if (dp.selected !== undefined) lines.push(`🎯 مختار: ${dp.selected} | مؤجل: ${dp.held || 0}`);
        if (dp.gate_accepted !== undefined) lines.push(`🛡️ بوابة: ${dp.gate_accepted} صالح / ${dp.gate_rejected} مرفوض`);

        // Error
        if (run.error_message) {
          lines.push(`❌ الخطأ: ${htmlEscape(run.error_message.slice(0, 200))}`);
        }

        // Last 3 tasks
        const recentTasks = status.tasks.slice(-3).filter(t => t.status === 'completed' || t.status === 'failed');
        if (recentTasks.length > 0) {
          lines.push('');
          lines.push('<b>آخر المهام:</b>');
          for (const t of recentTasks) {
            const emoji = t.status === 'completed' ? '✅' : '❌';
            const account = t.account_handle ? ` @${t.account_handle}` : '';
            lines.push(`${emoji} ${htmlEscape(t.task_type)}${account}`);
          }
        }

        if (stuckTasksMarked > 0) {
          lines.push('');
          lines.push(`🔄 تم تعليم ${stuckTasksMarked} مهمة علِقة تلقائيًا`);
        }

        await sendReply(chatId, lines.join('\n'));
      } catch (err: any) {
        await sendReply(chatId, `❌ فشل جلب الحالة: ${htmlEscape(err.message || 'unknown')}`);
      }
      return;
    }

    // ═══ 🔄 إعادة تشغيل — cancel active run + enqueue new, NO pipeline execution ═══
    if (text === '🔄 إعادة تشغيل' || text === 'إعادة تشغيل') {
      try {
        // Mark stuck tasks first
        await markStuckTasks(10);

        // Cancel any active run
        const activeRun = await getActivePipelineRun();
        if (activeRun) {
          const cancelResult = await cancelPipelineRun(activeRun.id, 'telegram_retry');
          if (cancelResult.ok) {
            const shortId = String(activeRun.id).slice(0, 8);
            await sendReply(chatId, `🚫 تم إلغاء التشغيل السابق ${shortId} (${cancelResult.cancelled_tasks} مهمة ملغاة)`);
          }
        }

        // Enqueue new pipeline run
        const result = await enqueuePipelineRun({
          source: 'telegram-retry',
          notifyTelegram: true
        });

        if (result.ok && result.run_id) {
          const shortId = result.run_id.slice(0, 8);
          await sendReply(chatId, [
            '✅ تم إنشاء تشغيل جديد',
            `🆔 Run ID: ${shortId}`,
            `📊 عدد المهام: ${result.task_count}`,
            '⚙️ سيتم التنفيذ عبر العامل الخلفي',
            '',
            'اضغط 🧾 حالة التشغيل للمتابعة'
          ].join('\n'));
        } else {
          await sendReply(chatId, `❌ فشل إنشاء التشغيل: ${htmlEscape(result.message || 'unknown error')}`);
        }
      } catch (err: any) {
        await sendReply(chatId, `❌ خطأ: ${htmlEscape(err.message || 'unknown error')}`);
      }
      return;
    }

    // ═══ ⏸ إيقاف التشغيل — cancel active run and unfinished tasks ═══
    if (text === '⏸ إيقاف التشغيل' || text === 'إيقاف التشغيل') {
      try {
        const activeRun = await getActivePipelineRun();
        if (!activeRun) {
          await sendReply(chatId, 'ℹ️ لا يوجد تشغيل جارٍ لإيقافه.');
          return;
        }

        const shortId = String(activeRun.id).slice(0, 8);
        const cancelResult = await cancelPipelineRun(activeRun.id, 'telegram_manual_stop');

        if (cancelResult.ok) {
          await sendReply(chatId, [
            '🚫 <b>تم إيقاف التشغيل</b>',
            `🆔 ${shortId}`,
            `📊 مهام ملغاة: ${cancelResult.cancelled_tasks}`,
            '',
            'اضغط 🧠 تشغيل كامل للبدء من جديد'
          ].join('\n'));
        } else {
          await sendReply(chatId, `❌ فشل الإيقاف: ${htmlEscape(cancelResult.reason || 'unknown error')}`);
        }
      } catch (err: any) {
        await sendReply(chatId, `❌ خطأ: ${htmlEscape(err.message || 'unknown error')}`);
      }
      return;
    }

    // ═══ نشرت — log published decision directly ═══
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

    await sendReply(chatId, 'استخدم الأزرار. للتشغيل: 🧠 تشغيل كامل. للحالة: 🧾 حالة التشغيل. لإعادة: 🔄 إعادة تشغيل. للإيقاف: ⏸ إيقاف التشغيل. بعد النشر: نشرت 1 الرابط');
  } catch (err: any) {
    console.error('[telegram unified] error:', err.message);
    await sendReply(chatId, `❌ خطأ: ${htmlEscape(err.message || 'unknown error')}`);
  }
}

// ═══ Helpers ═══

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
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
