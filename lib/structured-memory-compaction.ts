/**
 * structured-memory-compaction.ts — Phase M1: Structured Memory Compaction
 *
 * Converts raw pipeline history into compact structured memory rules.
 * Inspired by a Wiki Layer, but runtime memory lives in Supabase.
 *
 * Core idea:
 * - Read pipeline outputs (judge failures, freshness rejections, publish_gate rejections)
 * - Extract compact signals (failure reason, topic key, source author, bad text, suggested fix)
 * - Compact signals into deterministic rules (AI optional only if needed)
 * - Upsert rules (increment support_count instead of duplicate insert)
 * - Update per-source-author memory
 *
 * Constraints:
 * - Never lower judge thresholds
 * - Never bypass publish_gate
 * - Never auto-post
 * - Never add generic templates
 * - Never hard-code account-specific text
 * - Never weaken safety
 */

import { supabaseAdmin } from './supabase';

// ═══ Types ═══

export type MemorySignal = {
  failure_reason?: string;
  topic_key?: string;
  source_author?: string;
  source_text_preview?: string;
  bad_candidate_text?: string;
  why_failed?: string;
  suggested_fix?: string;
  format?: string;         // reply | quote | standalone
  judge_scores?: {
    final_candidate_score: number;
    originality_score: number;
    usefulness_score: number;
    brief_alignment_score: number;
    evidence_safety_score: number;
    clarity_score: number;
  };
  freshness_rejected?: boolean;
  source_created_at?: string | null;
  recommended_angle?: string;
  shield_issues?: string[];
};

export type CompactRule = {
  rule_type: string;
  pattern: string;
  when_to_use: string;
  when_to_avoid: string;
  suggested_fix: string;
  example_bad: string;
  example_better: string;
  source_author?: string;
  topic_key?: string;
  confidence: number;
  support_count: number;
};

export type SourceAuthorMemoryUpdate = {
  source_author: string;
  common_topics: string[];
  good_angles: string[];
  bad_angles: string[];
  freshness_behavior: Record<string, any>;
  typical_failure_reasons: Record<string, number>;
  best_reply_strategy?: string;
  best_quote_strategy?: string;
};

export type CompactionResult = {
  rules_created: number;
  rules_updated: number;
  source_memories_created: number;
  source_memories_updated: number;
  input_items: number;
  signals_extracted: number;
  rules_compacted: number;
  error?: string;
};

// ═══ Part B.1: Extract Memory Signals ═══

/**
 * Extract compact memory signals from a completed pipeline run.
 *
 * Reads:
 * - opportunity_judge outputs (scores, failure reasons)
 * - publish_gate outputs (rejections, freshness)
 * - opportunity_intelligence (briefs, recommended angles)
 * - near-pass polish diagnostics
 *
 * Returns compact signals: failure reason, topic key, source author, bad text, suggested fix.
 */
export async function extractMemorySignalsFromRun(runId: string): Promise<MemorySignal[]> {
  const supabase = supabaseAdmin();
  const signals: MemorySignal[] = [];

  // 1. Read opportunity_judge outputs
  const { data: judgeTask } = await supabase
    .from('pipeline_tasks')
    .select('result')
    .eq('run_id', runId)
    .eq('task_type', 'opportunity_judge')
    .eq('status', 'completed')
    .maybeSingle();

  if (judgeTask?.result?._opportunities) {
    const opportunities: any[] = judgeTask.result._opportunities;

    for (const opp of opportunities) {
      const judgeResult = opp._judge_result;
      const shieldIssues: string[] = opp.shield_issues || [];
      const sourceAuthor = opp.source_author || '';
      const sourceTextPreview = String(opp.source_text || '').slice(0, 200);
      const craftedText = String(opp.crafted_text || '').slice(0, 280);
      const brief = opp._brief || {};
      const recommendedAngle = brief.recommended_angle || '';
      const topicKey = inferTopicKey(sourceTextPreview, recommendedAngle);
      const format = opp.format || opp.type || '';

      // Extract signals from judge failures
      if (judgeResult && !judgeResult.passed) {
        const failureReasons: string[] = judgeResult.failure_reasons || [];

        // Originality failure signal
        if (judgeResult.originality_score < 7.8) {
          signals.push({
            failure_reason: 'originality_score_below_7.8',
            topic_key: topicKey,
            source_author: sourceAuthor,
            source_text_preview: sourceTextPreview,
            bad_candidate_text: craftedText,
            why_failed: `originality_score=${judgeResult.originality_score} (threshold 7.8)`,
            suggested_fix: inferOriginalityFix(judgeResult.originality_score, craftedText),
            format,
            judge_scores: {
              final_candidate_score: judgeResult.final_candidate_score,
              originality_score: judgeResult.originality_score,
              usefulness_score: judgeResult.usefulness_score,
              brief_alignment_score: judgeResult.brief_alignment_score,
              evidence_safety_score: judgeResult.evidence_safety_score,
              clarity_score: judgeResult.clarity_score,
            },
            recommended_angle: recommendedAngle,
            shield_issues: shieldIssues,
          });
        }

        // Brief alignment failure signal
        if (judgeResult.brief_alignment_score < 7.5) {
          signals.push({
            failure_reason: 'brief_alignment_below_7.5',
            topic_key: topicKey,
            source_author: sourceAuthor,
            source_text_preview: sourceTextPreview,
            bad_candidate_text: craftedText,
            why_failed: `brief_alignment_score=${judgeResult.brief_alignment_score} (threshold 7.5)`,
            suggested_fix: 'Preserve the recommended_angle\'s specific frame, not just topic. Reference the exact angle in the first sentence.',
            format,
            judge_scores: {
              final_candidate_score: judgeResult.final_candidate_score,
              originality_score: judgeResult.originality_score,
              usefulness_score: judgeResult.usefulness_score,
              brief_alignment_score: judgeResult.brief_alignment_score,
              evidence_safety_score: judgeResult.evidence_safety_score,
              clarity_score: judgeResult.clarity_score,
            },
            recommended_angle: recommendedAngle,
            shield_issues: shieldIssues,
          });
        }

        // Usefulness failure signal
        if (judgeResult.usefulness_score < 7) {
          signals.push({
            failure_reason: 'usefulness_below_7',
            topic_key: topicKey,
            source_author: sourceAuthor,
            source_text_preview: sourceTextPreview,
            bad_candidate_text: craftedText,
            why_failed: `usefulness_score=${judgeResult.usefulness_score} (threshold 7)`,
            suggested_fix: 'Add a concrete action, checklist, decision rule, or when-to-use condition. Avoid pure observation.',
            format,
            judge_scores: {
              final_candidate_score: judgeResult.final_candidate_score,
              originality_score: judgeResult.originality_score,
              usefulness_score: judgeResult.usefulness_score,
              brief_alignment_score: judgeResult.brief_alignment_score,
              evidence_safety_score: judgeResult.evidence_safety_score,
              clarity_score: judgeResult.clarity_score,
            },
            recommended_angle: recommendedAngle,
            shield_issues: shieldIssues,
          });
        }

        // Evidence safety failure signal
        if (judgeResult.evidence_safety_score < 8) {
          signals.push({
            failure_reason: 'evidence_safety_below_8',
            topic_key: topicKey,
            source_author: sourceAuthor,
            source_text_preview: sourceTextPreview,
            bad_candidate_text: craftedText,
            why_failed: `evidence_safety_score=${judgeResult.evidence_safety_score} (threshold 8)`,
            suggested_fix: 'Remove unsupported claims, numeric assertions without source, or invented personal experience.',
            format,
            judge_scores: {
              final_candidate_score: judgeResult.final_candidate_score,
              originality_score: judgeResult.originality_score,
              usefulness_score: judgeResult.usefulness_score,
              brief_alignment_score: judgeResult.brief_alignment_score,
              evidence_safety_score: judgeResult.evidence_safety_score,
              clarity_score: judgeResult.clarity_score,
            },
            recommended_angle: recommendedAngle,
            shield_issues: shieldIssues,
          });
        }

        // Final score failure signal (generic)
        if (judgeResult.final_candidate_score < 7.8 && failureReasons.length > 0) {
          signals.push({
            failure_reason: `final_score_below_7.8:${failureReasons[0]}`,
            topic_key: topicKey,
            source_author: sourceAuthor,
            source_text_preview: sourceTextPreview,
            bad_candidate_text: craftedText,
            why_failed: `final_candidate_score=${judgeResult.final_candidate_score} (threshold 7.8). Primary: ${failureReasons[0]}`,
            suggested_fix: inferScoreFix(judgeResult),
            format,
            judge_scores: {
              final_candidate_score: judgeResult.final_candidate_score,
              originality_score: judgeResult.originality_score,
              usefulness_score: judgeResult.usefulness_score,
              brief_alignment_score: judgeResult.brief_alignment_score,
              evidence_safety_score: judgeResult.evidence_safety_score,
              clarity_score: judgeResult.clarity_score,
            },
            recommended_angle: recommendedAngle,
            shield_issues: shieldIssues,
          });
        }
      }

      // Freshness rejection signal
      const freshnessIssues = shieldIssues.filter((i: string) =>
        i.includes('freshness') || i.includes('source_too_old') || i.includes('stale_source')
      );
      if (freshnessIssues.length > 0) {
        signals.push({
          failure_reason: 'freshness_rejected',
          topic_key: topicKey,
          source_author: sourceAuthor,
          source_text_preview: sourceTextPreview,
          why_failed: freshnessIssues.join('; '),
          suggested_fix: format === 'reply'
            ? 'High engagement old source should be standalone only, not reply. Consider downgrading to standalone if text is evergreen.'
            : 'Old source is too stale for this format.',
          format,
          freshness_rejected: true,
          source_created_at: opp.source_created_at || null,
          shield_issues: shieldIssues,
        });
      }
    }
  }

  // 2. Read publish_gate outputs for additional rejection signals
  const { data: gateTask } = await supabase
    .from('pipeline_tasks')
    .select('result')
    .eq('run_id', runId)
    .eq('task_type', 'publish_gate')
    .eq('status', 'completed')
    .maybeSingle();

  if (gateTask?.result?._rejected_opportunities) {
    const rejected: any[] = gateTask.result._rejected_opportunities;
    for (const opp of rejected) {
      const shieldIssues: string[] = opp.shield_issues || [];
      // Only extract freshness signals not already captured from judge
      const freshnessIssues = shieldIssues.filter((i: string) =>
        i.includes('freshness') || i.includes('source_too_old')
      );
      if (freshnessIssues.length > 0 && !signals.some(s =>
        s.source_author === (opp.source_author || '') && s.freshness_rejected
      )) {
        signals.push({
          failure_reason: 'freshness_rejected_at_gate',
          topic_key: inferTopicKey(String(opp.source_text || '').slice(0, 200), ''),
          source_author: opp.source_author || '',
          source_text_preview: String(opp.source_text || '').slice(0, 200),
          why_failed: freshnessIssues.join('; '),
          suggested_fix: 'Old high-engagement source should be standalone only.',
          format: opp.format || opp.type || '',
          freshness_rejected: true,
          shield_issues: shieldIssues,
        });
      }
    }
  }

  return signals;
}

// ═══ Part B.2: Compact Signals into Rules ═══

/**
 * Convert extracted signals into compact rules using deterministic logic.
 * AI is NOT used here — all rules are derived from known failure patterns.
 */
export function compactSignalsIntoRules(signals: MemorySignal[]): CompactRule[] {
  const rules: CompactRule[] = [];

  for (const signal of signals) {
    switch (signal.failure_reason) {
      case 'originality_score_below_7.8': {
        rules.push({
          rule_type: 'anti_pattern',
          pattern: 'Restating the source as a summary without adding a mechanism, tradeoff, or operator rule',
          when_to_use: 'When crafting reply or quote about a source that covers a common topic',
          when_to_avoid: 'When the source is genuinely novel and the first-mover angle is sufficient',
          suggested_fix: signal.suggested_fix || 'Do not restate the source as a summary. Add a mechanism, tradeoff, or operator rule.',
          example_bad: truncateText(signal.bad_candidate_text || '', 200),
          example_better: '',
          source_author: signal.source_author || undefined,
          topic_key: signal.topic_key || undefined,
          confidence: 0.5,
          support_count: 1,
        });
        break;
      }

      case 'brief_alignment_below_7.5': {
        rules.push({
          rule_type: 'brief_alignment_failure',
          pattern: 'Candidate covers the topic but not the recommended_angle\'s specific frame',
          when_to_use: 'When the brief specifies a recommended_angle that differs from the obvious take',
          when_to_avoid: 'When the angle is genuinely the same as the topic',
          suggested_fix: signal.suggested_fix || 'Candidate must preserve recommended_angle\'s specific frame, not just topic.',
          example_bad: truncateText(signal.bad_candidate_text || '', 200),
          example_better: '',
          source_author: signal.source_author || undefined,
          topic_key: signal.topic_key || undefined,
          confidence: 0.5,
          support_count: 1,
        });
        break;
      }

      case 'usefulness_below_7': {
        rules.push({
          rule_type: 'usefulness_failure',
          pattern: 'Observation without actionable takeaway, decision rule, or when-to-use condition',
          when_to_use: 'When crafting about trends, announcements, or general observations',
          when_to_avoid: 'When the content is deliberately provocative or contrarian (not observation)',
          suggested_fix: signal.suggested_fix || 'Add a concrete action, checklist, decision rule, or when-to-use condition.',
          example_bad: truncateText(signal.bad_candidate_text || '', 200),
          example_better: '',
          source_author: signal.source_author || undefined,
          topic_key: signal.topic_key || undefined,
          confidence: 0.5,
          support_count: 1,
        });
        break;
      }

      case 'evidence_safety_below_8': {
        rules.push({
          rule_type: 'anti_pattern',
          pattern: 'Unsupported numeric claim, invented personal experience, or assertion without source',
          when_to_use: 'When crafting about data, benchmarks, or results',
          when_to_avoid: 'When the claim is widely accepted common knowledge',
          suggested_fix: signal.suggested_fix || 'Remove unsupported claims or add specific source attribution.',
          example_bad: truncateText(signal.bad_candidate_text || '', 200),
          example_better: '',
          source_author: signal.source_author || undefined,
          topic_key: signal.topic_key || undefined,
          confidence: 0.5,
          support_count: 1,
        });
        break;
      }

      case 'freshness_rejected':
      case 'freshness_rejected_at_gate': {
        rules.push({
          rule_type: 'freshness_pattern',
          pattern: `High engagement old source treated as ${signal.format || 'reply'} opportunity`,
          when_to_use: `When considering ${signal.format || 'reply'} to old high-engagement sources`,
          when_to_avoid: 'When the source is recent (< 72h for reply, < 7d for quote)',
          suggested_fix: signal.suggested_fix || 'Old source should be standalone only, not reply.',
          example_bad: '',
          example_better: '',
          source_author: signal.source_author || undefined,
          topic_key: signal.topic_key || undefined,
          confidence: 0.5,
          support_count: 1,
        });
        break;
      }

      default: {
        // Generic final score failure
        if (signal.failure_reason?.startsWith('final_score_below_7.8')) {
          rules.push({
            rule_type: 'anti_pattern',
            pattern: `Low final score due to ${signal.failure_reason.replace('final_score_below_7.8:', '')}`,
            when_to_use: 'When similar failures recur for the same topic or source pattern',
            when_to_avoid: 'When the failure is a one-off edge case',
            suggested_fix: signal.suggested_fix || 'Focus on the primary failing dimension.',
            example_bad: truncateText(signal.bad_candidate_text || '', 200),
            example_better: '',
            source_author: signal.source_author || undefined,
            topic_key: signal.topic_key || undefined,
            confidence: 0.4,
            support_count: 1,
          });
        }
        break;
      }
    }
  }

  return rules;
}

// ═══ Part B.3: Upsert Compact Rules ═══

/**
 * Upsert compact rules into Supabase.
 *
 * Deduplication key: (rule_type, pattern, source_author, topic_key)
 * If exists:
 *   - increment support_count
 *   - update confidence (weighted average)
 *   - update last_seen_at
 * If new:
 *   - insert
 */
export async function upsertCompactRules(rules: CompactRule[]): Promise<{
  created: number;
  updated: number;
}> {
  const supabase = supabaseAdmin();
  let created = 0;
  let updated = 0;

  for (const rule of rules) {
    // Check for existing rule
    const sourceAuthorFilter = rule.source_author
      ? `eq.${rule.source_author}`
      : 'is.null';
    const topicKeyFilter = rule.topic_key
      ? `eq.${rule.topic_key}`
      : 'is.null';

    const { data: existing } = await supabase
      .from('compact_operator_rules')
      .select('id, support_count, confidence')
      .eq('rule_type', rule.rule_type)
      .eq('pattern', rule.pattern)
      .eq('source_author', rule.source_author || null)
      .eq('topic_key', rule.topic_key || null)
      .maybeSingle();

    if (existing) {
      // Update: increment support_count, adjust confidence, update last_seen_at
      const newSupportCount = (existing.support_count || 0) + 1;
      const newConfidence = Math.min(0.95,
        ((existing.confidence || 0.5) * (existing.support_count || 1) + rule.confidence) / newSupportCount
      );

      const { error } = await supabase
        .from('compact_operator_rules')
        .update({
          support_count: newSupportCount,
          confidence: newConfidence,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Update suggested_fix if the new one is longer (more detailed)
          ...(rule.suggested_fix && rule.suggested_fix.length > 10 ? { suggested_fix: rule.suggested_fix } : {}),
          // Update example_bad if the new one is provided
          ...(rule.example_bad ? { example_bad: rule.example_bad } : {}),
        })
        .eq('id', existing.id);

      if (!error) {
        updated++;
      } else {
        console.warn(`[structured-memory-compaction] Failed to update rule: ${error.message}`);
      }
    } else {
      // Insert new rule
      const { error } = await supabase
        .from('compact_operator_rules')
        .insert({
          rule_type: rule.rule_type,
          pattern: rule.pattern,
          when_to_use: rule.when_to_use,
          when_to_avoid: rule.when_to_avoid,
          suggested_fix: rule.suggested_fix,
          example_bad: rule.example_bad,
          example_better: rule.example_better,
          source_author: rule.source_author || null,
          topic_key: rule.topic_key || null,
          confidence: rule.confidence,
          support_count: rule.support_count,
        });

      if (!error) {
        created++;
      } else {
        console.warn(`[structured-memory-compaction] Failed to insert rule: ${error.message}`);
      }
    }
  }

  return { created, updated };
}

// ═══ Part B.4: Update Source Author Memory ═══

/**
 * Update per-source-author memory from extracted signals.
 *
 * For each source_author:
 *   - update common_topics
 *   - good_angles (from judge-passed opportunities)
 *   - bad_angles (from judge-failed opportunities)
 *   - typical_failure_reasons
 *   - freshness_behavior
 *   - best_reply_strategy / best_quote_strategy
 */
export async function updateSourceAuthorMemory(signals: MemorySignal[]): Promise<{
  created: number;
  updated: number;
}> {
  const supabase = supabaseAdmin();
  let created = 0;
  let updated = 0;

  // Group signals by source_author
  const byAuthor = new Map<string, MemorySignal[]>();
  for (const signal of signals) {
    const author = signal.source_author || '';
    if (!author) continue;
    const existing = byAuthor.get(author) || [];
    existing.push(signal);
    byAuthor.set(author, existing);
  }

  for (const [author, authorSignals] of byAuthor) {
    // Extract data from signals
    const topicKeys = [...new Set(authorSignals.map(s => s.topic_key).filter(Boolean))] as string[];
    const badAngles = [...new Set(
      authorSignals
        .filter(s => s.recommended_angle && !s.judge_scores?.final_candidate_score || (s.judge_scores?.final_candidate_score || 0) < 7.8)
        .map(s => s.recommended_angle)
        .filter(Boolean)
    )] as string[];

    // Count failure reasons
    const failureReasons: Record<string, number> = {};
    for (const signal of authorSignals) {
      if (signal.failure_reason) {
        const key = signal.failure_reason.split(':')[0]; // strip specific reason suffix
        failureReasons[key] = (failureReasons[key] || 0) + 1;
      }
    }

    // Freshness behavior
    const freshnessBehavior: Record<string, any> = {};
    const freshnessSignals = authorSignals.filter(s => s.freshness_rejected);
    if (freshnessSignals.length > 0) {
      freshnessBehavior.frequently_stale = true;
      freshnessBehavior.rejection_count = freshnessSignals.length;
      freshnessBehavior.formats_rejected = [...new Set(freshnessSignals.map(s => s.format).filter(Boolean))];
    }

    // Check for existing source_author_memory
    const { data: existing } = await supabase
      .from('source_author_memory')
      .select('*')
      .eq('source_author', author)
      .maybeSingle();

    if (existing) {
      // Merge with existing data
      const existingTopics: string[] = existing.common_topics || [];
      const existingBadAngles: string[] = existing.bad_angles || [];
      const existingFailures: Record<string, number> = existing.typical_failure_reasons || {};
      const existingFreshness: Record<string, any> = existing.freshness_behavior || {};

      const mergedTopics = [...new Set([...existingTopics, ...topicKeys])];
      const mergedBadAngles = [...new Set([...existingBadAngles, ...badAngles])];
      const mergedFailures = { ...existingFailures };
      for (const [key, count] of Object.entries(failureReasons)) {
        mergedFailures[key] = (mergedFailures[key] || 0) + count;
      }

      const newSupportCount = (existing.support_count || 0) + 1;
      const newConfidence = Math.min(0.95,
        ((existing.confidence || 0.5) * (existing.support_count || 1) + 0.5) / newSupportCount
      );

      const { error } = await supabase
        .from('source_author_memory')
        .update({
          common_topics: mergedTopics,
          bad_angles: mergedBadAngles,
          typical_failure_reasons: mergedFailures,
          freshness_behavior: freshnessBehavior.frequently_stale
            ? { ...existingFreshness, ...freshnessBehavior }
            : existingFreshness,
          support_count: newSupportCount,
          confidence: newConfidence,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (!error) {
        updated++;
      } else {
        console.warn(`[structured-memory-compaction] Failed to update source_author_memory: ${error.message}`);
      }
    } else {
      // Insert new source_author_memory
      const { error } = await supabase
        .from('source_author_memory')
        .insert({
          source_author: author,
          common_topics: topicKeys,
          good_angles: [],
          bad_angles: badAngles,
          freshness_behavior: freshnessBehavior,
          typical_failure_reasons: failureReasons,
          best_reply_strategy: null,
          best_quote_strategy: null,
          confidence: 0.5,
          support_count: 1,
        });

      if (!error) {
        created++;
      } else {
        console.warn(`[structured-memory-compaction] Failed to insert source_author_memory: ${error.message}`);
      }
    }
  }

  return { created, updated };
}

// ═══ Full Compaction Pipeline ═══

/**
 * Run the full compaction pipeline for a given run_id.
 *
 * 1. Extract signals from pipeline outputs
 * 2. Compact signals into rules
 * 3. Upsert rules
 * 4. Update source author memory
 * 5. Log compaction run
 */
export async function compactRunIntoMemory(runId: string): Promise<CompactionResult> {
  try {
    // Step 1: Extract signals
    const signals = await extractMemorySignalsFromRun(runId);

    if (signals.length === 0) {
      // No signals to compact — log and return
      await logCompactionRun(runId, 'pipeline_run', 0, 0, 0, 0, signals.length, 'completed');
      return {
        rules_created: 0,
        rules_updated: 0,
        source_memories_created: 0,
        source_memories_updated: 0,
        input_items: 0,
        signals_extracted: 0,
        rules_compacted: 0,
      };
    }

    // Step 2: Compact signals into rules
    const rules = compactSignalsIntoRules(signals);

    // Step 3: Upsert rules
    const upsertResult = await upsertCompactRules(rules);

    // Step 4: Update source author memory
    const authorResult = await updateSourceAuthorMemory(signals);

    // Step 5: Log compaction run
    await logCompactionRun(
      runId,
      'pipeline_run',
      upsertResult.created,
      upsertResult.updated,
      authorResult.created,
      authorResult.updated,
      signals.length,
      'completed'
    );

    return {
      rules_created: upsertResult.created,
      rules_updated: upsertResult.updated,
      source_memories_created: authorResult.created,
      source_memories_updated: authorResult.updated,
      input_items: signals.length,
      signals_extracted: signals.length,
      rules_compacted: rules.length,
    };
  } catch (err: any) {
    // Log failure
    await logCompactionRun(runId, 'pipeline_run', 0, 0, 0, 0, 0, 'failed', err.message);
    return {
      rules_created: 0,
      rules_updated: 0,
      source_memories_created: 0,
      source_memories_updated: 0,
      input_items: 0,
      signals_extracted: 0,
      rules_compacted: 0,
      error: err.message,
    };
  }
}

// ═══ Helpers ═══

function inferTopicKey(sourceText: string, recommendedAngle: string): string {
  const combined = `${sourceText} ${recommendedAngle}`.toLowerCase();

  // Extract key technical terms
  const topicPatterns: Array<{ pattern: RegExp; key: string }> = [
    { pattern: /\b(ai agents?)\b/i, key: 'ai_agents' },
    { pattern: /\b(llm|large language model)\b/i, key: 'llm' },
    { pattern: /\b(rag|retrieval.?augmented)\b/i, key: 'rag' },
    { pattern: /\b(fine.?tun)/i, key: 'fine_tuning' },
    { pattern: /\b(embedding|vector)\b/i, key: 'embeddings' },
    { pattern: /\b(mcp|model context protocol)\b/i, key: 'mcp' },
    { pattern: /\b(prompt|prompting)\b/i, key: 'prompting' },
    { pattern: /\b(inference)\b/i, key: 'inference' },
    { pattern: /\b(open.?source)\b/i, key: 'open_source' },
    { pattern: /\b(api)\b/i, key: 'api' },
    { pattern: /\b(agent|agentic)\b/i, key: 'agents' },
    { pattern: /\b(token|context.?window)\b/i, key: 'token_economics' },
    { pattern: /\b(benchmark|eval|evaluation)\b/i, key: 'evaluation' },
    { pattern: /\b(pipeline|workflow|automation)\b/i, key: 'automation' },
    { pattern: /\b(startup|product|saas)\b/i, key: 'product' },
    { pattern: /\b(safety|alignment|guardrail)\b/i, key: 'safety' },
  ];

  for (const { pattern, key } of topicPatterns) {
    if (pattern.test(combined)) return key;
  }

  // Fallback: first 3 significant words
  const words = combined.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return words.slice(0, 3).join('_') || 'general';
}

function inferOriginalityFix(score: number, text: string): string {
  if (score < 6) {
    return 'Completely reframe the angle. The current text is a summary, not an insight. Add a mechanism, tradeoff, or operator rule.';
  }
  if (score < 7) {
    return 'Add a specific mechanism, tradeoff, or operator rule. Do not restate the source as a summary.';
  }
  return 'Strengthen the unique angle. Add a concrete example or decision rule that the source does not provide.';
}

function inferScoreFix(scores: { originality_score: number; usefulness_score: number; brief_alignment_score: number; evidence_safety_score: number }): string {
  const weaknesses: string[] = [];
  if (scores.originality_score < 7.8) weaknesses.push('originality');
  if (scores.usefulness_score < 7) weaknesses.push('usefulness');
  if (scores.brief_alignment_score < 7.5) weaknesses.push('brief alignment');
  if (scores.evidence_safety_score < 8) weaknesses.push('evidence safety');
  return `Focus on improving: ${weaknesses.join(', ')}`;
}

function truncateText(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

async function logCompactionRun(
  runId: string,
  source: string,
  rulesCreated: number,
  rulesUpdated: number,
  sourceMemoriesCreated: number,
  sourceMemoriesUpdated: number,
  inputItems: number,
  status: string,
  errorMessage?: string
): Promise<void> {
  try {
    const supabase = supabaseAdmin();
    await supabase.from('memory_compaction_runs').insert({
      run_id: runId,
      source,
      rules_created: rulesCreated,
      rules_updated: rulesUpdated,
      source_memories_created: sourceMemoriesCreated,
      source_memories_updated: sourceMemoriesUpdated,
      input_items: inputItems,
      status,
      error_message: errorMessage || null,
    });
  } catch (err: any) {
    console.warn(`[structured-memory-compaction] Failed to log compaction run: ${(err?.message || 'unknown').slice(0, 200)}`);
  }
}
