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
import { sendTelegramMessage, htmlEscape, shortText, allowedChatId } from '../telegram';

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
  for (const s of generated) {
    const gate = gateSuggestion(s.text, 280, cfg.tweetLanguage);
    if (!gate.ok) {
      rejected.push({ reason: gate.reason, text: s.text });
      continue;
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
    if (chatId) await sendTelegramMessage(chatId, formatForTelegram(result));
  }

  return result;
}

export function formatForTelegram(r: LeanRunResult): string {
  const lines: string[] = [];
  lines.push(`<b>اقتراحات اليوم — @${htmlEscape(r.accountHandle)}</b>`);
  lines.push(`النيش: ${htmlEscape(r.niche)}`);
  lines.push(`مصادر مسحوبة: ${r.harvested} · أمثلة تعلّم: ${r.examplesUsed} · مقبولة: ${r.accepted}/${r.generated}`);
  lines.push('');

  const groups: { key: Suggestion['type']; title: string }[] = [
    { key: 'reply', title: '💬 ردود' },
    { key: 'quote', title: '🔁 اقتباسات' },
    { key: 'standalone', title: '✍️ تغريدات أصلية' },
  ];

  let n = 1;
  for (const g of groups) {
    const items = r.suggestions.filter((s) => s.type === g.key);
    if (!items.length) continue;
    lines.push(`<b>${g.title}</b>`);
    for (const s of items) {
      lines.push(`${n}. ${htmlEscape(s.text)}`);
      if (s.source_url) lines.push(`   ↳ ${htmlEscape(s.source_url)}`);
      if (s.rationale) lines.push(`   <i>${htmlEscape(shortText(s.rationale, 120))}</i>`);
      lines.push('');
      n++;
    }
  }

  if (!r.suggestions.length) {
    lines.push('لا توجد اقتراحات مقبولة هذه المرة — جرّب تشغيلاً آخر أو وسّع قائمة المصادر.');
  }
  return lines.join('\n').slice(0, 4000);
}
