/**
 * Lean Core — Profiles
 *
 * A profile is everything that makes one account's loop distinct: its handle,
 * niche, the language its content is published in, the Telegram UI language, its
 * voice, and its daily mix. This is the seam that lets the same engine run many
 * accounts / niches / languages later — without touching the pipeline code.
 */

import { supabaseAdmin } from '../supabase';

export type Profile = {
  id: string;
  accountHandle: string;
  niche: string;
  tweetLanguage: string; // language of published content (e.g. 'en', 'ar')
  botLanguage: string;   // Telegram UI language
  voice: string | null;
  mix: { replies: number; quotes: number; standalone: number };
  sourceHandles: string[];
  active: boolean;
  isDefault: boolean;
};

function rowToProfile(row: any): Profile {
  const mix = row.mix || {};
  return {
    id: row.id,
    accountHandle: String(row.account_handle).replace(/^@/, ''),
    niche: row.niche,
    tweetLanguage: row.tweet_language || 'en',
    botLanguage: row.bot_language || 'ar',
    voice: row.voice ?? null,
    mix: {
      replies: Number(mix.replies ?? 6),
      quotes: Number(mix.quotes ?? 3),
      standalone: Number(mix.standalone ?? 4),
    },
    sourceHandles: Array.isArray(row.source_handles) ? row.source_handles : [],
    active: Boolean(row.active),
    isDefault: Boolean(row.is_default),
  };
}

/** The active profile to run. Prefers the default, else the first active one. */
export async function getActiveProfile(accountHandle?: string): Promise<Profile | null> {
  const supabase = supabaseAdmin();
  if (accountHandle) {
    const { data } = await supabase.from('profiles').select('*').eq('account_handle', accountHandle.replace(/^@/, '')).maybeSingle();
    if (data) return rowToProfile(data);
  }
  const { data: def } = await supabase.from('profiles').select('*').eq('is_default', true).eq('active', true).maybeSingle();
  if (def) return rowToProfile(def);
  const { data: any } = await supabase.from('profiles').select('*').eq('active', true).order('created_at').limit(1).maybeSingle();
  return any ? rowToProfile(any) : null;
}

export async function listProfiles(): Promise<Profile[]> {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from('profiles').select('*').order('is_default', { ascending: false }).order('created_at');
  return (data || []).map(rowToProfile);
}

/** Update niche / language / voice / mix for a profile (used by Telegram commands). */
export async function updateProfile(accountHandle: string, patch: Partial<{
  niche: string;
  tweetLanguage: string;
  botLanguage: string;
  voice: string;
  mix: Profile['mix'];
}>): Promise<void> {
  const supabase = supabaseAdmin();
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.niche !== undefined) update.niche = patch.niche;
  if (patch.tweetLanguage !== undefined) update.tweet_language = patch.tweetLanguage;
  if (patch.botLanguage !== undefined) update.bot_language = patch.botLanguage;
  if (patch.voice !== undefined) update.voice = patch.voice;
  if (patch.mix !== undefined) update.mix = patch.mix;
  await supabase.from('profiles').update(update).eq('account_handle', accountHandle.replace(/^@/, ''));
}
