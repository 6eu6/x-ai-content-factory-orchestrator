/**
 * Lean Core — Durable once-per-day guard
 *
 * In-memory flags reset when PM2 restarts, which let the daily digest re-send
 * the same day. This claims a per-account/per-day task row in worker_state so a
 * restart can't repeat it. Atomic: insert-if-absent, and we only proceed if WE
 * inserted it.
 */

import { supabaseAdmin } from '../supabase';

export function utcDate(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function dailyKey(account: string, task: string, date = utcDate()): string {
  return `${task}:${String(account).replace(/^@/, '')}:${date}`;
}

/**
 * Returns true exactly once per (account, task, UTC day) — the caller that
 * receives true owns the task today. Restart-safe.
 */
export async function claimDailyTask(account: string, task: string): Promise<boolean> {
  const supabase = supabaseAdmin();
  const key = dailyKey(account, task);
  const { data } = await supabase
    .from('worker_state')
    .upsert({ key, sent_at: new Date().toISOString() }, { onConflict: 'key', ignoreDuplicates: true })
    .select('key')
    .maybeSingle();
  return !!data; // row returned only when we actually inserted it
}

/** Housekeeping: drop worker_state rows older than N days. */
export async function cleanupWorkerState(days = 14): Promise<void> {
  const supabase = supabaseAdmin();
  await supabase.from('worker_state').delete().lt('sent_at', new Date(Date.now() - days * 86_400_000).toISOString());
}
