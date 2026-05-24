import { optionalEnv, requiredEnv } from '../../../../lib/env';
import { setTelegramWebhook, sendTelegramMessage, MAIN_KEYBOARD } from '../../../../lib/telegram';

/**
 * GET /api/telegram/diagnose
 *
 * نقطة تشخيص عامة — تفحص حالة الـ webhook وتصلحه لو لازم
 *
 * ?action=check       — فحص حالة الـ webhook فقط
 * ?action=fix         — إعادة ضبط الـ webhook للرابط الصحيح
 * ?action=stop_flood  — حذف الـ webhook مؤقتاً لإيقاف الرسائل المعلقة، ثم إعادته
 * ?action=refresh_kb  — إرسال الكيبورد الجديد للمستخدم (يحل مشكلة الأزرار القديمة)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'check';
    const token = requiredEnv('TELEGRAM_BOT_TOKEN');
    const baseUrl = optionalEnv('PUBLIC_BASE_URL') || `${url.protocol}//${url.host}`;
    const expectedWebhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const webhookSecret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');

    // ═══ إرسال الكيبورد الجديد ═══
    if (action === 'refresh_kb') {
      const chatId = optionalEnv('TELEGRAM_ALLOWED_CHAT_ID');
      if (!chatId) return Response.json({ ok: false, error: 'TELEGRAM_ALLOWED_CHAT_ID not set' }, { status: 500 });
      
      try {
        await sendTelegramMessage(chatId, '✅ تم تحديث لوحة التحكم:', MAIN_KEYBOARD);
        return Response.json({ ok: true, message: 'Keyboard refreshed successfully', chat_id: chatId });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // 1. جلب معلومات الـ webhook الحالية من Telegram
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const infoData = await infoRes.json();

    const currentUrl = infoData?.result?.url || '';
    const hasPendingUpdates = infoData?.result?.pending_update_count || 0;
    const lastErrorDate = infoData?.result?.last_error_date || 0;
    const lastErrorMessage = infoData?.result?.last_error_message || '';

    const diagnosis: Record<string, any> = {
      ok: true,
      action,
      current_webhook_url: currentUrl,
      expected_webhook_url: expectedWebhookUrl,
      webhook_matches: currentUrl === expectedWebhookUrl,
      webhook_secret_configured: Boolean(webhookSecret),
      pending_update_count: hasPendingUpdates,
      last_error: lastErrorMessage || 'none',
      last_error_date: lastErrorDate ? new Date(lastErrorDate * 1000).toISOString() : 'none',
    };

    // 2. إيقاف الفلود: حذف الـ webhook + تنظيف المعلقات + إعادة الـ webhook
    if (action === 'stop_flood') {
      // أ) حذف الـ webhook مؤقتاً
      const deleteRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`, { method: 'GET' });
      const deleteData = await deleteRes.json();
      diagnosis.step1_delete_webhook = deleteData;

      // ب) انتظار ثانية
      await new Promise(r => setTimeout(r, 1000));

      // ج) إعادة ضبط الـ webhook مع الـ secret
      if (!webhookSecret) {
        diagnosis.fix_error = 'TELEGRAM_WEBHOOK_SECRET غير مضبوط';
        diagnosis.ok = false;
        return Response.json(diagnosis, { status: 500 });
      }
      const fixResult = await setTelegramWebhook(expectedWebhookUrl, webhookSecret);
      diagnosis.step2_set_webhook = fixResult;
      diagnosis.fix_attempted = true;

      if (fixResult?.ok || fixResult?.result?.url === expectedWebhookUrl) {
        diagnosis.fix_success = true;
        diagnosis.message = `تم إيقاف الفلود بنجاح. حُذفت ${hasPendingUpdates} رسالة معلقة وأُعيد ضبط الـ webhook.`;
      } else {
        diagnosis.fix_success = false;
        diagnosis.ok = false;
        diagnosis.message = 'فشل إعادة ضبط الـ webhook بعد حذف المعلقات!';
      }

      return Response.json(diagnosis);
    }

    // 3. لو الـ webhook ما يطابق أو طلب الإصلاح
    if (action === 'fix' || !diagnosis.webhook_matches || !currentUrl) {
      if (!webhookSecret) {
        diagnosis.fix_error = 'لا يمكن إعادة ضبط الـ webhook لأن TELEGRAM_WEBHOOK_SECRET غير مضبوط';
        diagnosis.ok = false;
        return Response.json(diagnosis, { status: 500 });
      }

      const fixResult = await setTelegramWebhook(expectedWebhookUrl, webhookSecret);
      diagnosis.fix_result = fixResult;
      diagnosis.fix_attempted = true;

      if (fixResult?.ok || fixResult?.result?.url === expectedWebhookUrl) {
        diagnosis.fix_success = true;
        diagnosis.webhook_matches = true;
        diagnosis.current_webhook_url = expectedWebhookUrl;
      } else {
        diagnosis.fix_success = false;
        diagnosis.ok = false;
      }
    }

    if (hasPendingUpdates > 0) {
      diagnosis.warning = `يوجد ${hasPendingUpdates} رسالة معلقة — استخدم ?action=stop_flood لإيقافها`;
    }

    if (lastErrorMessage) {
      diagnosis.error_detail = `آخر خطأ: ${lastErrorMessage}`;
    }

    return Response.json(diagnosis);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
