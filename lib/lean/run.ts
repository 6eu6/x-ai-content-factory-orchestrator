/**
 * Lean Core — Orchestrator
 *
 * The entire daily growth loop in one readable function:
 *   load config -> harvest niche tweets -> pull own winners (RAG) ->
 *   generate batch -> gate + dedupe -> format -> deliver to Telegram.
 *
 * Light enough to run inside a single Vercel function or a cron — no Oracle
 * worker / durable queue required for the lean path.
 */

import { getLeanConfig, configFromProfile, loadSourceAccounts } from './config';
import { getActiveProfile } from './profile';
import { harvestSources } from './harvest';
import { getWinningExamples, getRecentlyPublished } from './memory';
import { generateSuggestions, type Suggestion } from './generate';
import { gateSuggestion, isNearDuplicate } from './gate';
import { envNumber } from '../env';
import { sendTelegramMessage, htmlEscape, shortText, allowedChatId } from '../telegram';

// A reply/quote to a stale tweet is dead on arrival. Hard freshness limits.
const REPLY_MAX_HOURS = envNumber('LEAN_REPLY_MAX_HOURS', 48, 1, 336);
const QUOTE_MAX_HOURS = envNumber('LEAN_QUOTE_MAX_HOURS', 168, 1, 720);

export type LeanRunResult = {
  ok: boolean;
  accountHandle: string;
  niche: string;
  harvested: number;
  examplesUsed: number;
  generated: number;
  accepted: number;
  rejected: { reason: string; text: string }[];
  suggestions: Suggestion[];
};

export async function runLeanLoop(opts?: { deliverTelegram?: boolean; runId?: string; accountHandle?: string }): Promise<LeanRunResult> {
  // Profile is the canonical config source; env config is the cold-start fallback.
  const profile = await getActiveProfile(opts?.accountHandle).catch(() => null);
  const cfg = profile ? configFromProfile(profile) : getLeanConfig();
  const sources = cfg.sourceHandles.length
    ? cfg.sourceHandles.slice(0, cfg.sourceLimit).map((handle) => ({ handle, tier: null, category: null, followers: null }))
    : await loadSourceAccounts(cfg.sourceLimit);
  const tweets = await harvestSources(sources, cfg.tweetsPerSource);
  const examples = await getWinningExamples(cfg.accountHandle, 6);
  const recent = await getRecentlyPublished(cfg.accountHandle, 25);

  const generated = await generateSuggestions(cfg, tweets, examples, opts?.runId);

  const accepted: Suggestion[] = [];
  const rejected: { reason: string; text: string }[] = [];
  const usedSources = new Set<string>(); // one suggestion per source tweet per batch
  const usedHandles = new Set<string>(); // and one per source account per batch (diversity)
  for (const s of generated) {
    const gate = gateSuggestion(s.text, 280, cfg.tweetLanguage);
    if (!gate.ok) {
      rejected.push({ reason: gate.reason, text: s.text });
      continue;
    }
    // Freshness: reply/quote must target a recent source.
    if (s.type !== 'standalone') {
      if (!s.source_url) {
        rejected.push({ reason: 'reply_quote_missing_source', text: s.text });
        continue;
      }
      const limit = s.type === 'reply' ? REPLY_MAX_HOURS : QUOTE_MAX_HOURS;
      if (s.source_age_hours != null && s.source_age_hours > limit) {
        rejected.push({ reason: `source_too_old_for_${s.type}`, text: s.text });
        continue;
      }
      if (usedSources.has(s.source_url)) {
        rejected.push({ reason: 'source_already_used_in_batch', text: s.text });
        continue;
      }
      usedSources.add(s.source_url);
    }
    // Diversity: at most one suggestion per source account per batch.
    if (s.source_handle) {
      const h = s.source_handle.toLowerCase();
      if (usedHandles.has(h)) {
        rejected.push({ reason: 'source_handle_already_used_in_batch', text: s.text });
        continue;
      }
      usedHandles.add(h);
    }
    if (isNearDuplicate(s.text, recent)) {
      rejected.push({ reason: 'near_duplicate_of_recent', text: s.text });
      continue;
    }
    if (isNearDuplicate(s.text, accepted.map((a) => a.text))) {
      rejected.push({ reason: 'duplicate_within_batch', text: s.text });
      continue;
    }
    accepted.push(s);
  }

  const result: LeanRunResult = {
    ok: true,
    accountHandle: cfg.accountHandle,
    niche: cfg.niche,
    harvested: tweets.length,
    examplesUsed: examples.length,
    generated: generated.length,
    accepted: accepted.length,
    rejected,
    suggestions: accepted,
  };

  if (opts?.deliverTelegram) {
    const chatId = allowedChatId();
    const lang = profile?.botLanguage === 'en' ? 'en' : 'ar';
    if (chatId) await deliverSuggestions(chatId, result, lang);
  }

  return result;
}

const TYPE_LABEL: Record<string, { ar: string; en: string }> = {
  reply: { ar: '💬 رد', en: '💬 Reply' },
  quote: { ar: '🔁 اقتباس', en: '🔁 Quote' },
  standalone: { ar: '✍️ تغريدة', en: '✍️ Tweet' },
};

/**
 * Clean Telegram UX: a short header that makes clear these are CANDIDATES (pick
 * one, don't publish all), then ONE message per suggestion. The post text is
 * wrapped in <code> so a single tap copies it; the source link is a tappable
 * inline button so a tap opens the tweet to reply/quote.
 */
export async function deliverSuggestions(chatId: string, r: LeanRunResult, lang: 'ar' | 'en'): Promise<void> {
  const isAr = lang === 'ar';
  if (!r.suggestions.length) {
    await sendTelegramMessage(chatId, isAr
      ? 'لا توجد اقتراحات مقبولة هذه المرة — الفلتر رفض الضعيف. جرّب لاحقاً.'
      : 'No suggestions passed the filter this time. Try again later.');
    return;
  }

  const header = isAr
    ? `<b>مرشّحات اليوم — @${htmlEscape(r.accountHandle)}</b>\nاختر <b>واحدة</b> فقط وانشرها يدوياً — هذه مرشّحات لا جدول نشر. (${r.suggestions.length})`
    : `<b>Today's candidates — @${htmlEscape(r.accountHandle)}</b>\nPick <b>one</b>, publish it manually. These are candidates, not a publishing schedule. (${r.suggestions.length})`;
  await sendTelegramMessage(chatId, header);

  let n = 1;
  for (const s of r.suggestions) {
    const label = (TYPE_LABEL[s.type] || TYPE_LABEL.standalone)[lang];
    const age = s.source_age_hours != null ? ` · ${Math.round(s.source_age_hours)}h` : '';
    const who = s.source_handle ? ` · @${htmlEscape(s.source_handle)}` : '';
    const lines = [
      `${n}/${r.suggestions.length} · ${label}${who}${age}`,
      `<code>${htmlEscape(s.text)}</code>`,
    ];
    if (s.rationale) lines.push(`<i>${htmlEscape(shortText(s.rationale, 120))}</i>`);
    const markup = s.source_url
      ? { inline_keyboard: [[{ text: isAr ? '🔗 افتح التغريدة' : '🔗 Open tweet', url: s.source_url }]] }
      : undefined;
    await sendTelegramMessage(chatId, lines.join('\n'), markup).catch(() => {});
    n++;
  }
}
