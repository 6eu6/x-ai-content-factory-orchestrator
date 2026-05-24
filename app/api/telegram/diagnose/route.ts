import { optionalEnv, requiredEnv } from '../../../../lib/env';
import { setTelegramWebhook } from '../../../../lib/telegram';

/**
 * GET /api/telegram/diagnose
 *
 * نقطة تشخيص عامة — تفحص حالة الـ webhook وتصلحه لو لازم
 * ما تحتاج ORCHESTRATOR_SECRET (عام عشان التشخيص)
 *
 * ?action=check   — فحص حالة الـ webhook فقط
 * ?action=fix     — إعادة ضبط الـ webhook للرابط الصحيح
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'check';
    const token = requiredEnv('TELEGRAM_BOT_TOKEN');
    const baseUrl = optionalEnv('PUBLIC_BASE_URL') || `${url.protocol}//${url.host}`;
    const expectedWebhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const webhookSecret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');

    // 1. جلب معلومات الـ webhook الحالية من Telegram
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const infoData = await infoRes.json();

    const currentUrl = infoData?.result?.url || '';
    const hasPendingUpdates = infoData?.result?.pending_update_count || 0;
    const lastErrorDate = infoData?.result?.last_error_date || 0;
    const lastErrorMessage = infoData?.result?.last_error_message || '';
    const lastSynchronizationErrorDate = infoData?.result?.last_synchronization_error_date || 0;

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
      telegram_raw_info: infoData?.result || null,
    };

    // 2. لو الـ webhook ما يطابق أو طلب الإصلاح
    if (action === 'fix' || !diagnosis.webhook_matches || !currentUrl) {
      if (!webhookSecret) {
        diagnosis.fix_error = 'لا يمكن إعادة ضبط الـ webhook لأن TELEGRAM_WEBHOOK_SECRET غير مضبوط في متغيرات البيئة';
        diagnosis.ok = false;
        return Response.json(diagnosis, { status: 500 });
      }

      const fixResult = await setTelegramWebhook(expectedWebhookUrl, webhookSecret);
      diagnosis.fix_result = fixResult;
      diagnosis.fix_attempted = true;

      // تأكد من نجاح الإصلاح
      if (fixResult?.ok || fixResult?.result?.url === expectedWebhookUrl) {
        diagnosis.fix_success = true;
        diagnosis.webhook_matches = true;
        diagnosis.current_webhook_url = expectedWebhookUrl;
      } else {
        diagnosis.fix_success = false;
        diagnosis.ok = false;
      }
    }

    // 3. لو فيه أخطاء سابقة، اعرضها
    if (hasPendingUpdates > 0) {
      diagnosis.warning = `يوجد ${hasPendingUpdates} رسالة معلقة في Telegram — الـ webhook ممكن يكون معطّل`;
    }

    if (lastErrorMessage) {
      diagnosis.error_detail = `آخر خطأ من Telegram: ${lastErrorMessage}`;
    }

    return Response.json(diagnosis);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, stack: err.stack?.slice(0, 300) }, { status: 500 });
  }
}
