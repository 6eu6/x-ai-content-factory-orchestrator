/**
 * Oracle worker — continuous opportunity radar
 *
 * Runs autonomously on the Oracle VM (PM2). Each cycle it scans the niche for
 * fresh, high-momentum tweets worth reacting to, generates a ready-to-paste
 * reply/quote grounded in the brain, and pushes a Telegram notification the
 * moment an opportunity appears. Then it sleeps until the next cycle ("rests
 * when the task is done"). Quality over quantity: a strict daily cap prevents
 * flooding; a deterministic prefilter keeps model cost low.
 *
 * Run:  npm run worker
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.worker' });
loadEnv({ path: '.env.local' });
loadEnv();

import { supabaseAdmin } from '../lib/supabase';
import { sendTelegramMessage, allowedChatId, htmlEscape } from '../lib/telegram';
import { listProfiles } from '../lib/lean/profile';
import { configFromProfile } from '../lib/lean/config';
import { runOpportunityRadar, persistOpportunities, type Opportunity } from '../lib/lean/opportunity';
import { learnMediaPatterns } from '../lib/lean/media-learning';
import { runCrawl } from '../lib/lean/crawl';
import { runFeedbackScan } from '../lib/lean/feedback';
import { runLeanLoop } from '../lib/lean/run';
import { pruneBrain } from '../lib/brain/prune';
import type { Profile } from '../lib/lean/profile';

const POLL_MINUTES = num('LEAN_POLL_MINUTES', 20, 5, 240);
const DAILY_CAP = num('LEAN_DAILY_OPP_CAP', 5, 1, 50);

function num(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function notifiedToday(accountHandle: string): Promise<number> {
  const supabase = supabaseAdmin();
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('opportunities')
    .select('*', { count: 'exact', head: true })
    .eq('account_handle', accountHandle)
    .gte('created_at', since.toISOString());
  return count ?? 0;
}

function opportunityKeyboard(id: string, lang: string) {
  const isAr = lang === 'ar';
  return {
    inline_keyboard: [[
      { text: isAr ? '✅ نشرت' : '✅ Published', callback_data: `pub:${id}` },
      { text: isAr ? '🔍 بحث عميق' : '🔍 Deep research', callback_data: `res:${id}` },
    ]],
  };
}

function formatOpportunity(o: Opportunity, lang: string): string {
  const isAr = lang === 'ar';
  const head = isAr ? '🎯 فرصة الآن' : '🎯 Opportunity';
  const act = o.action === 'quote' ? (isAr ? 'اقتباس' : 'Quote') : (isAr ? 'رد' : 'Reply');
  return [
    `<b>${head}</b> · ${act} · ${o.score}/10`,
    `↳ @${htmlEscape(o.source_handle)} (${htmlEscape(o.source_media_type)})`,
    `${htmlEscape(o.source_url)}`,
    '',
    `<b>${isAr ? 'المقترح' : 'Suggested'}:</b>`,
    htmlEscape(o.suggestion_text),
    o.media_recommendation ? `\n🎬 ${htmlEscape(o.media_recommendation)}` : '',
  ].filter(Boolean).join('\n');
}

let lastDailyDay = -1;

/**
 * Heavier once-a-day routine, centralised here so nothing depends on Vercel's
 * 300s limit: outward learning (crawl), inward learning (feedback), media
 * insight, a standalone-ideas digest, and weekly forgetting.
 */
async function dailyRoutine(profile: Profile): Promise<void> {
  const cfg = configFromProfile(profile);
  try { await learnMediaPatterns(cfg); } catch (e: any) { console.error('[worker] media-learn:', e?.message); }
  try { await runCrawl({ accountHandle: profile.accountHandle }); } catch (e: any) { console.error('[worker] crawl:', e?.message); }
  try { await runFeedbackScan({ accountHandle: profile.accountHandle }); } catch (e: any) { console.error('[worker] feedback:', e?.message); }
  // Morning digest (standalone ideas + mix) delivered to Telegram.
  try { await runLeanLoop({ deliverTelegram: true, accountHandle: profile.accountHandle }); } catch (e: any) { console.error('[worker] digest:', e?.message); }
  if (new Date().getUTCDay() === 0) {
    try { await pruneBrain(); } catch (e: any) { console.error('[worker] prune:', e?.message); }
  }
}

async function cycleForProfile(profile: Profile): Promise<number> {
  const cfg = configFromProfile(profile);
  const chatId = allowedChatId();

  const already = await notifiedToday(profile.accountHandle);
  if (already >= DAILY_CAP) return 0;

  const opps = await runOpportunityRadar(profile, cfg);
  if (!opps.length) return 0;

  // Respect the remaining daily budget.
  const room = Math.max(0, DAILY_CAP - already);
  const top = opps.sort((a, b) => b.score - a.score).slice(0, room);
  const inserted = await persistOpportunities(profile.accountHandle, top);

  if (chatId) {
    for (const o of inserted) {
      try {
        await sendTelegramMessage(chatId, formatOpportunity(o, profile.botLanguage), opportunityKeyboard(o.id, profile.botLanguage));
      } catch { /* keep going */ }
    }
  }
  return inserted.length;
}

async function runOnce(): Promise<void> {
  const profiles = (await listProfiles()).filter((p) => p.active);
  const day = new Date().getUTCDate();
  const runDaily = day !== lastDailyDay;

  for (const p of profiles) {
    try {
      if (runDaily) await dailyRoutine(p);
      const n = await cycleForProfile(p);
      console.log(`[worker] @${p.accountHandle}: surfaced ${n} opportunity(ies)`);
    } catch (e: any) {
      console.error(`[worker] @${p.accountHandle} error:`, e?.message || e);
    }
  }
  if (runDaily) lastDailyDay = day;
}

async function main(): Promise<void> {
  console.log(`[worker] starting — poll every ${POLL_MINUTES}m, daily cap ${DAILY_CAP}/account`);
  // Fail fast if core env is missing.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const started = Date.now();
    try { await runOnce(); } catch (e: any) { console.error('[worker] cycle error:', e?.message || e); }
    const elapsed = Date.now() - started;
    const wait = Math.max(0, POLL_MINUTES * 60_000 - elapsed);
    console.log(`[worker] cycle done in ${Math.round(elapsed / 1000)}s — sleeping ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

main().catch((e) => {
  console.error('[worker] fatal:', e);
  process.exit(1);
});
