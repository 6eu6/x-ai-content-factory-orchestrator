import { optionalEnv, requiredEnv } from '../../../../lib/env';
import { setTelegramWebhook, sendTelegramMessage, MAIN_KEYBOARD } from '../../../../lib/telegram';

/**
 * GET /api/telegram/diagnose
 *
 * General diagnostics endpoint — checks webhook status and fixes it if needed
 *
 * ?action=check       — Check webhook status only
 * ?action=fix         — Reset webhook to the correct URL
 * ?action=stop_flood  — Delete webhook temporarily to stop pending messages, then restore it
 * ?action=refresh_kb  — Send the new keyboard to the user (fixes stale buttons)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'check';
    const token = requiredEnv('TELEGRAM_BOT_TOKEN');
    const baseUrl = optionalEnv('PUBLIC_BASE_URL') || `${url.protocol}//${url.host}`;
    const expectedWebhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const webhookSecret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');

    // ═══ Send new keyboard ═══
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

    // 1. Fetch current webhook info from Telegram
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

    // 2. Stop flood: delete webhook + clear pending + restore webhook
    if (action === 'stop_flood') {
      // a) Temporarily delete webhook
      const deleteRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`, { method: 'GET' });
      const deleteData = await deleteRes.json();
      diagnosis.step1_delete_webhook = deleteData;

      // b) Wait one second
      await new Promise(r => setTimeout(r, 1000));

      // c) Re-set webhook with secret
      if (!webhookSecret) {
        diagnosis.fix_error = 'TELEGRAM_WEBHOOK_SECRET is not configured';
        diagnosis.ok = false;
        return Response.json(diagnosis, { status: 500 });
      }
      const fixResult = await setTelegramWebhook(expectedWebhookUrl, webhookSecret);
      diagnosis.step2_set_webhook = fixResult;
      diagnosis.fix_attempted = true;

      if (fixResult?.ok || fixResult?.result?.url === expectedWebhookUrl) {
        diagnosis.fix_success = true;
        diagnosis.message = `Flood stopped successfully. Deleted ${hasPendingUpdates} pending messages and restored webhook.`;
      } else {
        diagnosis.fix_success = false;
        diagnosis.ok = false;
        diagnosis.message = 'Failed to restore webhook after clearing pending updates!';
      }

      return Response.json(diagnosis);
    }

    // 3. If webhook doesn't match or fix was requested
    if (action === 'fix' || !diagnosis.webhook_matches || !currentUrl) {
      if (!webhookSecret) {
        diagnosis.fix_error = 'Cannot reset webhook because TELEGRAM_WEBHOOK_SECRET is not configured';
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
      diagnosis.warning = `${hasPendingUpdates} pending messages — use ?action=stop_flood to clear them`;
    }

    if (lastErrorMessage) {
      diagnosis.error_detail = `Last error: ${lastErrorMessage}`;
    }

    return Response.json(diagnosis);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
