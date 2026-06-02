import { runBackground } from '../../../../lib/background';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandles, extractTweetUrl, htmlEscape, sendTelegramMessage, answerCallbackQuery } from '../../../../lib/telegram';
import { tweetIdFromUrl } from '../../../../lib/x';
import { getActiveProfile, updateProfile } from '../../../../lib/lean/profile';
import { languageName } from '../../../../lib/lean/config';
import { runLeanLoop } from '../../../../lib/lean/run';
import { remember } from '../../../../lib/brain';
import { researchTopic, formatBrief } from '../../../../lib/lean/research';

const VERSION = 'telegram-webhook-lean-v1';
export const maxDuration = 300;

/** Minimal bilingual control panel. UI language follows the active profile. */
type Lang = 'ar' | 'en';

function t(lang: Lang, key: string): string {
  const ar: Record<string, string> = {
    welcome: 'جاهز ✅ — هذا عقل اقتراح المحتوى. اضغط زر الاقتراحات لتوليد دفعة اليوم.\nأوامر: «نيش <النص>» لتغيير النيش · «لغة en/ar» للغة التغريدات · «بوت en/ar» للغة الواجهة · «نشرت 1 <الرابط>» لتسجيل منشور.',
    suggest_started: '⏳ يولّد اقتراحات اليوم من العقل… ستصلك خلال لحظات.',
    suggest_failed: '❌ فشل توليد الاقتراحات',
    niche_set: '✅ تم تغيير النيش إلى',
    lang_set: '✅ لغة التغريدات الآن',
    bot_set: '✅ لغة الواجهة الآن',
    add_account_hint: 'أرسل حسابات X للزحف والتعلّم. مثال:\nemollick naval levelsio',
    added: 'تمت إضافة',
    accounts_title: 'قائمة حسابات المصادر',
    no_accounts: 'لا توجد حسابات. استخدم زر إضافة حساب.',
    published_ok: '✅ تم تسجيل المنشور — سيُقاس أداؤه ويتعلّم منه العقل.',
    published_bad: '❌ الصيغة: نشرت 1 ثم رابط منشور X',
    brain_title: 'حالة العقل',
    unknown: 'استخدم الأزرار. للاقتراحات اضغط الزر، أو اكتب «تشغيل».',
  };
  const en: Record<string, string> = {
    welcome: 'Ready ✅ — this is the content brain. Tap Suggest to generate today\'s batch.\nCommands: "niche <text>" to change niche · "lang en/ar" tweet language · "bot en/ar" UI language · "published 1 <url>" to log a post.',
    suggest_started: '⏳ Generating today\'s suggestions from the brain… arriving shortly.',
    suggest_failed: '❌ Failed to generate suggestions',
    niche_set: '✅ Niche changed to',
    lang_set: '✅ Tweet language is now',
    bot_set: '✅ UI language is now',
    add_account_hint: 'Send X handles to crawl and learn from. Example:\nemollick naval levelsio',
    added: 'Added',
    accounts_title: 'Source accounts',
    no_accounts: 'No accounts yet. Use the Add account button.',
    published_ok: '✅ Post logged — its performance will be measured and the brain will learn from it.',
    published_bad: '❌ Format: published 1 <X post url>',
    brain_title: 'Brain status',
    unknown: 'Use the buttons. Tap Suggest, or type "run".',
  };
  return (lang === 'en' ? en : ar)[key] || '';
}

function keyboard(lang: Lang) {
  const labels = lang === 'en'
    ? [['🧠 Suggest', '🧠 Brain'], ['➕ Add account', '📋 Accounts'], ['✅ Log post', '⚙️ Settings']]
    : [['🧠 اقتراحات', '🧠 العقل'], ['➕ إضافة حساب', '📋 الحسابات'], ['✅ سجل منشور', '⚙️ إعدادات']];
  return { keyboard: labels.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, one_time_keyboard: false };
}

export async function POST(req: Request) {
  try {
    const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const update = await req.json();

    // Inline-button taps (✅ Published / 🔍 Deep research) on opportunity cards.
    if (update?.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb?.message?.chat?.id || '');
      if (chatId) {
        assertTelegramChat(chatId);
        runBackground(handleCallback(chatId, String(cb.id), String(cb.data || '')));
      }
      return Response.json({ ok: true, version: VERSION });
    }

    const message = update?.message;
    const chatId = String(message?.chat?.id || '');
    const text = String(message?.text || '').trim();
    if (!chatId || !text) return Response.json({ ok: true, ignored: true, version: VERSION });
    assertTelegramChat(chatId);
    runBackground(handleMessage(chatId, text));
    return Response.json({ ok: true, version: VERSION });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, endpoint: VERSION });
}

async function handleCallback(chatId: string, callbackId: string, data: string) {
  const supabase = supabaseAdmin();
  const profile = await getActiveProfile().catch(() => null);
  const lang: Lang = (profile?.botLanguage === 'en' ? 'en' : 'ar');
  const send = (msg: string) => sendTelegramMessage(chatId, msg, keyboard(lang));

  const [kind, id] = data.split(':');
  if (!id) { await answerCallbackQuery(callbackId); return; }

  const { data: opp } = await supabase.from('opportunities').select('*').eq('id', id).maybeSingle();
  if (!opp) { await answerCallbackQuery(callbackId, lang === 'en' ? 'Not found' : 'غير موجود'); return; }

  if (kind === 'pub') {
    // One-tap close-the-loop: mark used + feed the endorsed text back as a voice
    // exemplar so future generations match what the human actually publishes.
    await supabase.from('opportunities').update({ status: 'published' }).eq('id', id);
    await remember({
      kind: 'voice',
      content: String((opp as any).suggestion_text || ''),
      weight: 6,
      niche: profile?.niche ?? null,
      language: profile?.tweetLanguage ?? 'en',
      source: 'used_suggestion',
    }).catch(() => {});
    await answerCallbackQuery(callbackId, lang === 'en' ? 'Logged ✅' : 'تم التسجيل ✅');
    await send(lang === 'en'
      ? '✅ Logged as published. The brain learned from it.\n(To measure real engagement, send: published <your post url>)'
      : '✅ سُجّل كمنشور وتعلّم منه العقل.\n(لقياس التفاعل الحقيقي أرسل: نشرت <رابط منشورك>)');
    return;
  }

  if (kind === 'res') {
    await answerCallbackQuery(callbackId, lang === 'en' ? 'Researching…' : 'يبحث…');
    const topic = String((opp as any).source_text || (opp as any).suggestion_text || '').slice(0, 280);
    try {
      const brief = await researchTopic(topic, profile?.tweetLanguage || 'en');
      await send(formatBrief(brief, lang));
    } catch (e: any) {
      await send(`❌ ${htmlEscape(e?.message || 'research failed')}`);
    }
    return;
  }

  await answerCallbackQuery(callbackId);
}

async function handleMessage(chatId: string, text: string) {
  const supabase = supabaseAdmin();
  const profile = await getActiveProfile().catch(() => null);
  const lang: Lang = (profile?.botLanguage === 'en' ? 'en' : 'ar');
  const send = (msg: string) => sendTelegramMessage(chatId, msg, keyboard(lang));

  try {
    const { data: state } = await supabase.from('telegram_bot_state').select('*').eq('chat_id', chatId).maybeSingle();
    await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, last_message: text, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

    const lower = text.toLowerCase();

    if (text === '/start' || lower === 'menu' || text === 'القائمة' || lower === 'start') {
      await clearFlow(supabase, chatId);
      await send(t(lang, 'welcome'));
      return;
    }

    // Suggest (run the lean+brain loop). Delivery is handled inside (clean
    // per-suggestion, tap-to-copy messages).
    if (text.includes('اقتراح') || text.includes('تشغيل') || lower.includes('suggest') || lower === 'run') {
      await send(t(lang, 'suggest_started'));
      try {
        await runLeanLoop({ deliverTelegram: true });
      } catch (e: any) {
        await send(`${t(lang, 'suggest_failed')}: ${htmlEscape(e?.message || '')}`);
      }
      return;
    }

    // Change daily mix:  "mix 2 1 0"  (replies quotes standalone)
    const mixMatch = text.match(/^mix\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (mixMatch && profile) {
      const mix = {
        replies: Math.min(20, Number(mixMatch[1])),
        quotes: Math.min(20, Number(mixMatch[2])),
        standalone: Math.min(20, Number(mixMatch[3])),
      };
      await updateProfile(profile.accountHandle, { mix });
      await send(`${lang === 'en' ? '✅ Mix set' : '✅ تم ضبط المزيج'}: ${mix.replies}/${mix.quotes}/${mix.standalone} (replies/quotes/standalone)`);
      return;
    }

    // Change niche:  "niche ..."  /  "نيش ..."
    const nicheMatch = text.match(/^(?:niche|نيش)\s+(.{3,})/i);
    if (nicheMatch && profile) {
      const niche = nicheMatch[1].trim();
      await updateProfile(profile.accountHandle, { niche });
      await send(`${t(lang, 'niche_set')}: ${htmlEscape(niche)}`);
      return;
    }

    // Tweet language:  "lang en" / "لغة ar"
    const langMatch = text.match(/^(?:lang|language|لغة)\s+([a-z]{2})/i);
    if (langMatch && profile) {
      const code = langMatch[1].toLowerCase();
      await updateProfile(profile.accountHandle, { tweetLanguage: code });
      await send(`${t(lang, 'lang_set')}: ${languageName(code)}`);
      return;
    }

    // Bot UI language:  "bot en" / "بوت ar"
    const botMatch = text.match(/^(?:bot|بوت)\s+(ar|en)/i);
    if (botMatch && profile) {
      const code = botMatch[1].toLowerCase();
      await updateProfile(profile.accountHandle, { botLanguage: code });
      const newLang: Lang = code === 'en' ? 'en' : 'ar';
      await sendTelegramMessage(chatId, `${t(newLang, 'bot_set')}: ${languageName(code)}`, keyboard(newLang));
      return;
    }

    // Log a published post
    if (/^(?:نشرت|published)\s+/i.test(text)) {
      const after = text.replace(/^(?:نشرت|published)\s+/i, '').trim();
      const url = extractTweetUrl(after);
      if (!url || !tweetIdFromUrl(url)) {
        await send(t(lang, 'published_bad'));
        return;
      }
      await supabase.from('published_decisions').insert({
        account_handle: profile?.accountHandle || optionalEnv('X_USERNAME', '30piq').replace(/^@/, ''),
        published_url: url,
        status: 'published',
        content_type: 'manual',
      });
      await send(t(lang, 'published_ok'));
      return;
    }

    // Add account flow
    if (text.includes('إضافة حساب') || lower.includes('add account')) {
      await setFlow(supabase, chatId, 'awaiting_account');
      await send(t(lang, 'add_account_hint'));
      return;
    }
    if (state?.current_flow === 'awaiting_account') {
      await clearFlow(supabase, chatId);
      const handles = extractHandles(text).slice(0, 15);
      if (!handles.length) { await send(t(lang, 'add_account_hint')); return; }
      for (const handle of handles) {
        try { await supabase.from('accounts').upsert({ handle, tier: 2, active: true, notes: 'Added from Telegram' }, { onConflict: 'handle' }); }
        catch { try { await supabase.from('accounts').upsert({ handle }, { onConflict: 'handle' }); } catch {} }
      }
      await send(`${t(lang, 'added')} ${handles.length}: ${handles.map((h) => `@${htmlEscape(h)}`).join(', ')}`);
      return;
    }

    // List accounts
    if (text.includes('الحسابات') || lower.includes('accounts')) {
      const { data: accounts } = await supabase.from('accounts').select('handle, tier').eq('active', true).order('tier').limit(60);
      if (!accounts?.length) { await send(t(lang, 'no_accounts')); return; }
      await send(`<b>${t(lang, 'accounts_title')} (${accounts.length})</b>\n${accounts.map((a: any) => `• @${htmlEscape(a.handle)} · t${a.tier ?? '-'}`).join('\n')}`);
      return;
    }

    // Brain status
    if (text.includes('العقل') || lower.includes('brain')) {
      const { data } = await supabase.from('brain_memory').select('kind, status');
      const rows = (data || []) as any[];
      const active = rows.filter((r) => r.status === 'active').length;
      const byKind: Record<string, number> = {};
      for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const lines = Object.entries(byKind).map(([k, n]) => `• ${k}: ${n}`).join('\n');
      await send(`<b>🧠 ${t(lang, 'brain_title')}</b>\nactive: ${active}/${rows.length}\n${lines}`);
      return;
    }

    // Settings
    if (text.includes('إعدادات') || lower.includes('settings')) {
      const p = profile;
      await send([
        `<b>⚙️</b>`,
        `account: @${htmlEscape(p?.accountHandle || '-')}`,
        `niche: ${htmlEscape(p?.niche || '-')}`,
        `tweet language: ${languageName(p?.tweetLanguage || 'en')}`,
        `bot language: ${languageName(p?.botLanguage || 'ar')}`,
        `mix: ${p?.mix.replies}/${p?.mix.quotes}/${p?.mix.standalone} (replies/quotes/standalone)`,
      ].join('\n'));
      return;
    }

    await send(t(lang, 'unknown'));
  } catch (err: any) {
    await send(`❌ ${htmlEscape(err?.message || 'error')}`);
  }
}

async function clearFlow(supabase: any, chatId: string) {
  await supabase.from('telegram_bot_state').update({ current_flow: null, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
}
async function setFlow(supabase: any, chatId: string, flow: string) {
  await supabase.from('telegram_bot_state').upsert({ chat_id: chatId, current_flow: flow, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
}
