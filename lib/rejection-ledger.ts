/**
 * rejection-ledger.ts — Phase 2A: Publish gate rejection diagnostics
 *
 * Persists every rejected opportunity from the publish_gate step into the
 * rejection_ledger table. This enables pattern analysis over the 30-day
 * @30piq experiment: which reasons dominate, which content gets rejected,
 * whether numeric claims correlate with rejection, etc.
 *
 * All DB writes catch their own errors and never crash the pipeline.
 */

import { supabaseAdmin } from './supabase';
import { createHash } from 'crypto';

// ═══ Types ═══

export type RejectionEntry = {
  run_id?: string | null;
  task_id?: string | null;
  opportunity_index: number;
  opportunity_type?: string | null;
  rejection_reason: string;
  shield_reason?: string | null;
  source_url_count?: number;
  numeric_claim_flag?: boolean;
  crafted_text_preview?: string | null;
  crafted_text_hash?: string | null;
  module_origin?: string;
};

// ═══ Helpers ═══

/**
 * Hash crafted text with SHA-256 for dedup and pattern analysis.
 * Returns null for empty/undefined input.
 */
export function hashCraftedText(text: string | null | undefined): string | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}

/**
 * Extract preview from crafted text (first 280 chars).
 */
export function craftTextPreview(text: string | null | undefined): string | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 280);
}

/**
 * Count source URLs in an opportunity object.
 * Looks for source_tweet_url and any URLs in entities.
 */
export function countSourceUrls(opp: any): number {
  let count = 0;
  if (opp?.source_tweet_url) count++;
  if (Array.isArray(opp?.entities?.urls)) count += opp.entities.urls.length;
  if (Array.isArray(opp?.extended_entities?.urls)) count += opp.extended_entities.urls.length;
  return count;
}

/**
 * Detect if the opportunity contains numeric claims.
 * Checks crafted_text for patterns like "increased by 40%", "$1.2M", "10x", etc.
 */
export function hasNumericClaim(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  // Patterns that indicate numeric claims
  return /(?:increased|decreased|grew|reduced|boosted|saved|cut|improved)\s+(by\s+)?\d/i.test(text) ||
         /\d+(?:\.\d+)?\s*%/i.test(text) ||
         /\$\d+/i.test(text) ||
         /\d+x\b/i.test(text);
}

// ═══ Core Functions ═══

/**
 * Record a single rejection entry.
 * Never throws.
 */
export async function recordRejection(entry: RejectionEntry): Promise<string | null> {
  try {
    const row = {
      run_id: entry.run_id || null,
      task_id: entry.task_id || null,
      opportunity_index: entry.opportunity_index,
      opportunity_type: entry.opportunity_type || null,
      rejection_reason: entry.rejection_reason,
      shield_reason: entry.shield_reason || null,
      source_url_count: entry.source_url_count ?? 0,
      numeric_claim_flag: entry.numeric_claim_flag ?? false,
      crafted_text_preview: entry.crafted_text_preview || null,
      crafted_text_hash: entry.crafted_text_hash || null,
      module_origin: entry.module_origin || 'publish_gate'
    };

    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('rejection_ledger')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[rejection-ledger] recordRejection DB error:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err: any) {
    console.error('[rejection-ledger] recordRejection exception:', err.message);
    return null;
  }
}

/**
 * Record multiple rejections in batch.
 * Never throws.
 */
export async function recordRejections(entries: RejectionEntry[]): Promise<number> {
  if (!entries.length) return 0;

  try {
    const rows = entries.map(entry => ({
      run_id: entry.run_id || null,
      task_id: entry.task_id || null,
      opportunity_index: entry.opportunity_index,
      opportunity_type: entry.opportunity_type || null,
      rejection_reason: entry.rejection_reason,
      shield_reason: entry.shield_reason || null,
      source_url_count: entry.source_url_count ?? 0,
      numeric_claim_flag: entry.numeric_claim_flag ?? false,
      crafted_text_preview: entry.crafted_text_preview || null,
      crafted_text_hash: entry.crafted_text_hash || null,
      module_origin: entry.module_origin || 'publish_gate'
    }));

    const supabase = supabaseAdmin();
    const { error } = await supabase
      .from('rejection_ledger')
      .insert(rows);

    if (error) {
      console.error('[rejection-ledger] recordRejections DB error:', error.message);
      return 0;
    }
    return rows.length;
  } catch (err: any) {
    console.error('[rejection-ledger] recordRejections exception:', err.message);
    return 0;
  }
}

/**
 * Record rejections from a publish_gate result.
 * Convenience function that maps PublishPolicyRejection[] to RejectionEntry[].
 * Never throws.
 */
export async function recordPublishGateRejections(
  rejections: Array<{
    index: number;
    type?: string;
    reason: string;
    preview: string;
  }>,
  options: {
    run_id?: string | null;
    task_id?: string | null;
    opportunities?: any[];
  }
): Promise<number> {
  if (!rejections.length) return 0;

  const entries: RejectionEntry[] = rejections.map(rej => {
    const opp = options.opportunities?.[rej.index];
    const craftedText = opp?.crafted_text || rej.preview;

    // Parse shield reason from rejection reason
    // Format: "shield_not_passed:reason1,reason2" or plain reason
    let shieldReason: string | null = null;
    let baseReason = rej.reason;
    if (rej.reason.startsWith('shield_not_passed:')) {
      shieldReason = rej.reason.replace('shield_not_passed:', '');
      baseReason = 'shield_not_passed';
    }

    return {
      run_id: options.run_id,
      task_id: options.task_id,
      opportunity_index: rej.index,
      opportunity_type: rej.type || opp?.type || null,
      rejection_reason: baseReason,
      shield_reason: shieldReason,
      source_url_count: opp ? countSourceUrls(opp) : 0,
      numeric_claim_flag: hasNumericClaim(craftedText),
      crafted_text_preview: craftTextPreview(craftedText),
      crafted_text_hash: hashCraftedText(craftedText),
      module_origin: 'publish_gate'
    };
  });

  return recordRejections(entries);
}

// ═══ Query Helpers ═══

/**
 * Get all rejections for a specific run.
 * Returns empty array on failure.
 */
export async function getRejectionsByRun(runId: string): Promise<any[]> {
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('rejection_ledger')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: true });

    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}
