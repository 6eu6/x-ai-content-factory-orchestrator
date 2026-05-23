import { optionalEnv, requiredEnv } from './env';

export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🧪 تشغيل خطة اليوم' }, { text: '📊 حالة الحساب' }],
    [{ text: '📊 مسح الأداء' }, { text: '🧠 حالة التعلم' }],
    [{ text: '🏭 إنتاج المحتوى' }, { text: '✅ محتوى جاهز للنشر' }],
    [{ text: '🔍 دورة تعلم ذكية' }, { text: '🚀 تشغيل فحص تعلم' }],
    [{ text: '🧭 محرك القرار' }, { text: '📦 زحف مستودع' }],
    [{ text: '➕ إضافة حساب للتعلم' }, { text: '🔗 إضافة تغريدة للتعلم' }],
    [{ text: '📋 المهام اليومية' }, { text: '🛡 فحص الحماية' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

export function telegramToken() {
  return requiredEnv('TELEGRAM_BOT_TOKEN');
}

export function allowedChatId() {
  return optionalEnv('TELEGRAM_ALLOWED_CHAT_ID');
}

export function assertTelegramChat(chatId: string) {
  const allowed = allowedChatId();
  if (allowed && String(chatId) !== String(allowed)) throw new Error('Unauthorized Telegram chat');
}

export async function sendTelegramMessage(chatId: string, text: string, replyMarkup: any = MAIN_KEYBOARD) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function setTelegramWebhook(url: string, secretToken: string) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message'] })
  });
  if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function htmlEscape(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function shortText(value: any, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function extractHandle(text: string) {
  return String(text || '').replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[\s/?]/)[0].trim();
}

export function extractTweetUrl(text: string) {
  const match = String(text || '').match(/https?:\/\/(?:x|twitter)\.com\/[^\s]+\/status\/\d+/i);
  return match ? match[0] : '';
}

export function extractGitHubRepo(text: string) {
  const value = String(text || '').trim();
  const urlMatch = value.match(/https?:\/\/github\.com\/[^\s/]+\/[^\s/#?]+/i);
  if (urlMatch) return urlMatch[0];
  const shortMatch = value.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  return shortMatch ? value : '';
}
