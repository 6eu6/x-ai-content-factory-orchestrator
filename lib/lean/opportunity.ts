/**
 * Lean Core — Opportunity radar (real-time)
 *
 * The "seize the moment" layer the worker runs continuously. Instead of a daily
 * digest, it watches the niche, finds FRESH tweets worth reacting to right now,
 * and produces a ready-to-paste reply/quote + a media recommendation — pushed
 * to Telegram the moment it appears.
 *
 * Cost discipline: a free deterministic prefilter removes everything stale /
 * low-signal / already-seen BEFORE any model call. Only the strongest few
 * candidates reach a single batched model call.
 */

import { callModel, parseModelJson } from '../model-router';
import { recallBrainContext } from '../brain';
import { supabaseAdmin } from '../supabase';
import { harvestSources, type HarvestedTweet } from './harvest';
import { loadSourceAccounts, languageName, type LeanConfig } from './config';
import { gateSuggestion } from './gate';
import type { Profile } from './profile';

export type Opportunity = {
  tweet_id: string;
  source_handle: string;
  source_url: string;
  source_text: string;
  source_media_type: string;
  source_age_hours: number | null;
  action: 'reply' | 'quote';
  suggestion_text: string;
  media_recommendation: string;
  why: string;
  score: number;
};

export type RadarOptions = {
  freshHours?: number;     // only consider tweets younger than this
  minVelocity?: number;    // engagement-per-hour floor (momentum)
  maxCandidates?: number;  // how many survivors reach the model
  minScore?: number;       // opportunity score floor to surface
};

/** Free, deterministic prefilter — runs before any paid model call. */
function prefilter(tweets: HarvestedTweet[], seen: Set<string>, opts: Required<RadarOptions>): HarvestedTweet[] {
  return tweets
    .filter((t) => t.tweet_id && !seen.has(t.tweet_id))
    .filter((t) => t.age_hours != null && t.age_hours <= opts.freshHours)
    .filter((t) => t.velocity >= opts.minVelocity)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, opts.maxCandidates);
}

async function loadSeen(accountHandle: string): Promise<Set<string>> {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from('opportunities')
    .select('tweet_id')
    .eq('account_handle', accountHandle)
    .order('created_at', { ascending: false })
    .limit(500);
  return new Set((data || []).map((r: any) => String(r.tweet_id)));
}

export async function runOpportunityRadar(
  profile: Profile,
  cfg: LeanConfig,
  options: RadarOptions = {},
): Promise<Opportunity[]> {
  const opts: Required<RadarOptions> = {
    freshHours: options.freshHours ?? 6,
    minVelocity: options.minVelocity ?? 8,
    maxCandidates: options.maxCandidates ?? 8,
    minScore: options.minScore ?? 7,
  };

  const sources = cfg.sourceHandles.length
    ? cfg.sourceHandles.slice(0, cfg.sourceLimit).map((handle) => ({ handle, tier: null, category: null, followers: null }))
    : await loadSourceAccounts(cfg.sourceLimit);

  const tweets = await harvestSources(sources, cfg.tweetsPerSource);
  const seen = await loadSeen(profile.accountHandle);
  const candidates = prefilter(tweets, seen, opts);
  if (!candidates.length) return [];

  // Brain grounding for relevance + quality.
  const recallQuery = [cfg.niche, ...candidates.slice(0, 6).map((t) => t.text)].join(' \n ').slice(0, 1500);
  const brain = await recallBrainContext(recallQuery, cfg.niche).catch(() => null);

  const lang = languageName(cfg.tweetLanguage);
  const system = [
    `You are an opportunity scout for the X account @${cfg.accountHandle} in the niche "${cfg.niche}".`,
    `Decide which fresh tweets are worth reacting to RIGHT NOW, and write the reaction in ${lang}.`,
    'Be strict: only surface a tweet if a reply or quote from us can genuinely earn engagement and fit the niche.',
    'VOICE: ' + cfg.voice,
    brain?.algorithm?.length ? 'ALGORITHM MECHANICS: ' + brain.algorithm.slice(0, 4).map((m) => m.content.slice(0, 140)).join(' | ') : '',
    brain?.avoid?.length ? 'AVOID: ' + brain.avoid.slice(0, 3).map((m) => m.content.slice(0, 120)).join(' | ') : '',
    'For each tweet you choose, also recommend the media format (e.g. "text-only reply is enough", "pair a quote with a screenshot", "a 10s screen recording would lift this"). Never claim we will generate media.',
    'Return ONLY JSON: {"opportunities":[{"index":<n>,"action":"reply|quote","text":"<reaction, <=280 chars>","media_recommendation":"<short>","score":<1-10>,"why":"<short>"}]}',
    'Omit any tweet not worth reacting to. Max 280 chars per text. No engagement-bait.',
  ].filter(Boolean).join('\n');

  const user = candidates
    .map((t, i) => `[${i}] @${t.source_handle} | ${Math.round(t.age_hours || 0)}h | vel ${t.velocity} | media:${t.media_type}\n"${t.text.replace(/\s+/g, ' ').slice(0, 240)}"`)
    .join('\n\n');

  let parsed: any = {};
  try {
    const raw = await callModel('opportunity_judge', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { response_format: { type: 'json_object' }, temperature: 0.4, max_tokens: 1600 });
    parsed = parseModelJson(raw);
  } catch {
    return [];
  }

  const items: any[] = Array.isArray(parsed?.opportunities) ? parsed.opportunities : [];
  const out: Opportunity[] = [];
  for (const it of items) {
    const idx = Number(it?.index);
    const cand = candidates[idx];
    if (!cand) continue;
    const action = String(it?.action || '').toLowerCase();
    if (action !== 'reply' && action !== 'quote') continue;
    const text = String(it?.text || '').trim();
    const score = Number(it?.score) || 0;
    if (score < opts.minScore) continue;
    if (!gateSuggestion(text, 280, cfg.tweetLanguage).ok) continue;
    out.push({
      tweet_id: cand.tweet_id,
      source_handle: cand.source_handle,
      source_url: cand.tweet_url,
      source_text: cand.text,
      source_media_type: cand.media_type,
      source_age_hours: cand.age_hours,
      action: action as 'reply' | 'quote',
      suggestion_text: text,
      media_recommendation: String(it?.media_recommendation || '').trim().slice(0, 200),
      why: String(it?.why || '').trim().slice(0, 160),
      score,
    });
  }
  return out;
}

export type StoredOpportunity = Opportunity & { id: string };

/** Persist surfaced opportunities (deduped by unique constraint). Returns inserted rows with ids. */
export async function persistOpportunities(accountHandle: string, opps: Opportunity[]): Promise<StoredOpportunity[]> {
  if (!opps.length) return [];
  const supabase = supabaseAdmin();
  const inserted: StoredOpportunity[] = [];
  for (const o of opps) {
    const { data, error } = await supabase.from('opportunities').insert({
      account_handle: accountHandle,
      tweet_id: o.tweet_id,
      source_handle: o.source_handle,
      source_url: o.source_url,
      source_text: o.source_text.slice(0, 500),
      source_media_type: o.source_media_type,
      action: o.action,
      suggestion_text: o.suggestion_text,
      media_recommendation: o.media_recommendation,
      score: o.score,
      notified_at: new Date().toISOString(),
    }).select('id').maybeSingle();
    if (!error && data) inserted.push({ ...o, id: (data as any).id }); // unique violation => already seen => skip
  }
  return inserted;
}
