import { runBackground } from '../../../../lib/background';
import { optionalEnv } from '../../../../lib/env';
import { supabaseAdmin } from '../../../../lib/supabase';
import { assertTelegramChat, extractHandles, htmlEscape, sendTelegramMessage, answerCallbackQuery } from '../../../../lib/telegram';
import { getActiveProfile, updateProfile, type Profile } from '../../../../lib/lean/profile';
import { languageName } from '../../../../lib/lean/config';
import { runLeanLoop } from '../../../../lib/lean/run';
import { researchTopic, formatBrief } from '../../../../lib/lean/research';

const VERSION = 'telegram-webhook-lean-v2';
export const maxDuration = 300;

/** Bilingual control panel. UI language follows the active profile. */
type Lang = 'ar' | 'en';

function t(lang: Lang, key: string): string {
  const ar: Record<string, string> = {
    welcome: 'جاهز ✅ — عقل اقتراح المحتوى. اضغط «اقتراحات» لتوليد دفعة الآن.\nالنشر يدوي، والنظام يكتشف ما تنشره تلقائياً ويتعلّم منه — لا حاجة لتسجيله.\nالإعدادات قابلة للتغيير من زر «إعدادات».',
    suggest_started: '⏳ يولّد اقتراحات الآن من العقل…',
    suggest_failed: '❌ فشل توليد الاقتراحات',
    niche_set: '✅ تم تغيير النيش إلى',
    lang_set: '✅ لغة التغريدات الآن',
    bot_set: '✅ لغة الواجهة الآن',
    add_account_hint: 'أرسل حسابات X للزحف والتعلّم. مثال:\nemollick naval levelsio',
    added: 'تمت إضافة',
    accounts_title: 'قائمة حسابات المصادر',
    no_accounts: 'لا توجد حسابات. استخدم زر إضافة حساب.',
    brain_title: 'حالة العقل',
    unknown: 'استخدم الأزرار. للاقتراحات اضغط «اقتراحات» أو اكتب «تشغيل».',
  };
  const en: Record<string, string> = {
    welcome: 'Ready ✅ — the content brain. Tap Suggest to generate now.\nPublishing is manual; the system auto-detects what you post and learns from it — no logging needed.\nChange anything from the Settings button.',
    suggest_started: '⏳ Generating suggestions from the brain…',
    suggest_failed: '❌ Failed to generate suggestions',
    niche_set: '✅ Niche changed to',
    lang_set: '✅ Tweet language is now',
    bot_set: '✅ UI language is now',
    add_account_hint: 'Send X handles to crawl and learn from. Example:\nemollick naval levelsio',
    added: 'Added',
    accounts_title: 'Source accounts',
    no_accounts: 'No accounts yet. Use the Add account button.',
    brain_title: 'Brain status',
    unknown: 'Use the buttons. Tap Suggest, or type "run".',
  };
  return (lang === 'en' ? en : ar)[key] || '';
}

function keyboard(lang: Lang) {
  const labels = lang === 'en'
    ? [['🧠 Suggest', '🧠 Brain'], ['➕ Add account', '📋 Accounts'], ['⚙️ Settings']]
    : [['🧠 اقتراحات', '🧠 العقل'], ['➕ إضافة حساب', '📋 الحسابات'], ['⚙️ إعدادات']];
  return { keyboard: labels.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, one_time_keyboard: false };
}

// ── Interactive settings card ───────────────────────────────────────────────
function settingsView(p: Profile | null, lang: Lang): { text: string; markup: any } {
  const isAr = lang === 'ar';
  const m = p?.mix || { replies: 2, quotes: 1, standalone: 0 };
  const text = [
    `<b>⚙️ ${isAr ? 'الإعدادات' : 'Settings'}</b>`,
    `${isAr ? 'الحساب' : 'account'}: @${htmlEscape(p?.accountHandle || '-')}`,
    `${isAr ? 'النيش' : 'niche'}: ${htmlEscape(p?.niche || '-')}`,
    `${isAr ? 'لغة التغريدات' : 'tweet language'}: ${languageName(p?.tweetLanguage || 'en')}`,
    `${isAr ? 'لغة الواجهة' : 'bot language'}: ${languageName(p?.botLanguage || 'ar')}`,
    `${isAr ? 'المزيج' : 'mix'}: ${m.replies}/${m.quotes}/${m.standalone} (replies/quotes/standalone)`,
    '',
    `<i>${isAr ? 'لتغيير النيش أو لغة التغريدات اكتب:' : 'To change niche or tweet language, type:'}</i>`,
    `<code>${isAr ? 'نيش' : 'niche'} &lt;text&gt;</code> · <code>lang en|ar</code>`,
  ].join('\n');
  const markup = {
    inline_keyboard: [
      [
        { text: `${isAr ? 'الواجهة' : 'UI'}: 🇸🇦`, callback_data: 'set:bot:ar' },
        { text: `${isAr ? 'الواجهة' : 'UI'}: 🇬🇧`, callback_data: 'set:bot:en' },
      ],
      [
        { text: 'mix 2/1/0', callback_data: 'set:mix:2-1-0' },
        { text: 'mix 3/1/0', callback_data: 'set:mix:3-1-0' },
        { text: 'mix 1/1/0', callback_data: 'set:mix:1-1-0' },
      ],
      [
        { text: `${isAr ? 'تغريدات' : 'tweets'}: EN`, callback_data: 'set:lang:en' },
        { text: `${isAr ? 'تغريدات' : 'tweets'}: AR`, callback_data: 'set:lang:ar' },
      ],
    ],
  };
  return { text, markup };
}

export async function POST(req: Request) {
  try {
    const secret = optionalEnv('TELEGRAM_WEBHOOK_SECRET');
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const update = await req.json();

    // Inline-button taps: settings changes (set:*) and 🔍 Deep research (res:*).
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

  const parts = data.split(':');
  const kind = parts[0];

  // Interactive settings — change + save + re-render (changes apply on next run).
  if (kind === 'set' && profile) {
    const field = parts[1];
    const val = parts[2] || '';
    if (field === 'bot' && (val === 'ar' || val === 'en')) {
      await updateProfile(profile.accountHandle, { botLanguage: val });
    } else if (field === 'lang' && /^[a-z]{2}$/.test(val)) {
      await updateProfile(profile.accountHandle, { tweetLanguage: val });
    } else if (field === 'mix') {
      const [r, q, s] = val.split('-').map((n) => Math.min(20, Math.max(0, Number(n) || 0)));
      await updateProfile(profile.accountHandle, { mix: { replies: r, quotes: q, standalone: s } });
    }
    await answerCallbackQuery(callbackId, lang === 'en' ? 'Saved ✓' : 'حُفظ ✓');
    const fresh = await getActiveProfile().catch(() => null);
    const newLang: Lang = fresh?.botLanguage === 'en' ? 'en' : 'ar';
    const view = settingsView(fresh, newLang);
    await sendTelegramMessage(chatId, view.text, view.markup);
    return;
  }

  // 🔍 Deep research on an opportunity card.
  if (kind === 'res' && parts[1]) {
    const { data: opp } = await supabase.from('opportunities').select('*').eq('id', parts[1]).maybeSingle();
    if (!opp) { await answerCallbackQuery(callbackId, lang === 'en' ? 'Not found' : 'غير موجود'); return; }
    await answerCallbackQuery(callbackId, lang === 'en' ? 'Researching…' : 'يبحث…');
    const topic = String((opp as any).source_text || (opp as any).suggestion_text || '').slice(0, 280);
    try {
      const brief = await researchTopic(topic, profile?.tweetLanguage || 'en');
      await sendTelegramMessage(chatId, formatBrief(brief, lang), keyboard(lang));
    } catch (e: any) {
      await sendTelegramMessage(chatId, `❌ ${htmlEscape(e?.message || 'research failed')}`, keyboard(lang));
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

    // Suggest — delivery handled inside (clean per-suggestion, tap-to-copy).
    if (text.includes('اقتراح') || text.includes('تشغيل') || lower.includes('suggest') || lower === 'run') {
      await send(t(lang, 'suggest_started'));
      try {
        await runLeanLoop({ deliverTelegram: true });
      } catch (e: any) {
        await send(`${t(lang, 'suggest_failed')}: ${htmlEscape(e?.message || '')}`);
      }
      return;
    }

    // Settings (interactive card)
    if (text.includes('إعدادات') || lower.includes('settings')) {
      const view = settingsView(profile, lang);
      await sendTelegramMessage(chatId, view.text, view.markup);
      return;
    }

    // mix R Q S
    const mixMatch = text.match(/^mix\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (mixMatch && profile) {
      const mix = { replies: Math.min(20, Number(mixMatch[1])), quotes: Math.min(20, Number(mixMatch[2])), standalone: Math.min(20, Number(mixMatch[3])) };
      await updateProfile(profile.accountHandle, { mix });
      await send(`${lang === 'en' ? '✅ Mix set' : '✅ تم ضبط المزيج'}: ${mix.replies}/${mix.quotes}/${mix.standalone}`);
      return;
    }

    // niche <text>
    const nicheMatch = text.match(/^(?:niche|نيش)\s+(.{3,})/i);
    if (nicheMatch && profile) {
      const niche = nicheMatch[1].trim();
      await updateProfile(profile.accountHandle, { niche });
      await send(`${t(lang, 'niche_set')}: ${htmlEscape(niche)}`);
      return;
    }

    // lang en|ar (tweet language)
    const langMatch = text.match(/^(?:lang|language|لغة)\s+([a-z]{2})/i);
    if (langMatch && profile) {
      const code = langMatch[1].toLowerCase();
      await updateProfile(profile.accountHandle, { tweetLanguage: code });
      await send(`${t(lang, 'lang_set')}: ${languageName(code)}`);
      return;
    }

    // bot en|ar (UI language)
    const botMatch = text.match(/^(?:bot|بوت)\s+(ar|en)/i);
    if (botMatch && profile) {
      const code = botMatch[1].toLowerCase();
      await updateProfile(profile.accountHandle, { botLanguage: code });
      const newLang: Lang = code === 'en' ? 'en' : 'ar';
      await sendTelegramMessage(chatId, `${t(newLang, 'bot_set')}: ${languageName(code)}`, keyboard(newLang));
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
