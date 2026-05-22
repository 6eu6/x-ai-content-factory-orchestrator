import { assertAuthorized, optionalEnv, requiredEnv } from '../../../../lib/env';
import { setTelegramWebhook } from '../../../../lib/telegram';

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const baseUrl = url.searchParams.get('base_url') || optionalEnv('PUBLIC_BASE_URL') || `${url.protocol}//${url.host}`;
    const webhookSecret = requiredEnv('TELEGRAM_WEBHOOK_SECRET');
    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const result = await setTelegramWebhook(webhookUrl, webhookSecret);
    return Response.json({ ok: true, webhookUrl, result });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
