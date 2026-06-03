import { optionalEnv, requiredEnv } from './env';
import { fetchWithRetry } from './retry';

/**
 * The single source of truth for the bot's reply keyboard. Bilingual, clean —
 * no legacy pipeline buttons. Use this everywhere a persistent keyboard is shown.
 */
export function mainTelegramKeyboard(lang: 'ar' | 'en' = 'ar') {
  const labels = lang === 'en'
    ? [['🧠 Suggest', '🧠 Brain'], ['➕ Add account', '📋 Accounts'], ['⚙️ Settings']]
    : [['🧠 اقتراحات', '🧠 العقل'], ['➕ إضافة حساب', '📋 الحسابات'], ['⚙️ إعدادات']];
  return { keyboard: labels.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, one_time_keyboard: false };
}

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

// Default replyMarkup is undefined — callers pass mainTelegramKeyboard(lang)
// explicitly when they want the persistent keyboard. This prevents a stale
// legacy keyboard from leaking onto messages that omit the markup.
export async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  const token = telegramToken();
  const res = await fetchWithRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  }, { label: 'telegram sendMessage' });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function setTelegramWebhook(url: string, secretToken: string) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] })
  });
  if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Acknowledge an inline-button tap (stops Telegram's loading spinner). */
export async function answerCallbackQuery(callbackQueryId: string, text = '') {
  const token = telegramToken();
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) })
  }).catch(() => {});
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

/**
 * استخراج عدة يوزرات من رسالة واحدة
 * يدعم مسافات، فواصل، @، روابط
 * مثال: "@naval emollick, paulg https://x.com/sama"
 * ← ["naval", "emollick", "paulg", "sama"]
 */
export function extractHandles(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // استبدال الفواصل بمسافات
  const normalized = raw
    .replace(/[,،;؛\n\r]+/g, ' ')
    .replace(/https?:\/\/(x|twitter)\.com\//gi, '@');

  // تقسيم بمسافات
  const tokens = normalized.split(/\s+/).filter(Boolean);

  const handles: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    // إزالة @ من البداية
    let handle = token.replace(/^@+/, '').trim();
    // إزالة أي / أو ؟ متبقية
    handle = handle.split(/[/?]/)[0].trim();
    // تجاهل الفارغ والقصير جداً
    if (!handle || handle.length < 2) continue;
    // تجاهل التكرار
    const lower = handle.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    handles.push(handle);
  }

  return handles;
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

/**
 * إرسال صورة لتليجرام عبر URL
 */
export async function sendTelegramPhoto(chatId: string, photoUrl: string, caption: string = '', replyMarkup?: any) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption: caption.slice(0, 1024),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })
  });
  if (!res.ok) throw new Error(`Telegram sendPhoto failed: ${res.status}`);
  return res.json();
}

/**
 * إرسال فيديو لتليجرام عبر URL
 */
export async function sendTelegramVideo(chatId: string, videoUrl: string, caption: string = '', replyMarkup?: any) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      video: videoUrl,
      caption: caption.slice(0, 1024),
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    })
  });
  if (!res.ok) throw new Error(`Telegram sendVideo failed: ${res.status}`);
  return res.json();
}

/**
 * إرسال GIF/رسوم متحركة لتليجرام عبر URL
 */
export async function sendTelegramAnimation(chatId: string, animationUrl: string, caption: string = '', replyMarkup?: any) {
  const token = telegramToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendAnimation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      animation: animationUrl,
      caption: caption.slice(0, 1024),
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    })
  });
  if (!res.ok) throw new Error(`Telegram sendAnimation failed: ${res.status}`);
  return res.json();
}
