/**
 * pipeline-worker.ts — Durable worker that processes pipeline tasks from the Supabase queue
 *
 * This module implements the actual task processing logic. It is designed to be called
 * by either:
 *   1. The persistent scripts/pipeline-worker.ts (Oracle VPS, runs forever)
 *   2. The fallback app/api/pipeline-worker/route.ts (Vercel, small batch)
 *
 * Each task type maps to a specific pipeline step:
 *   - load_account_state: Load X account state and store in account_state table
 *   - scan_account: Scan a single X account (ONE account per task, FULL quality)
 *   - merge_scan_results: Merge all scan_account results + discover opportunities
 *   - enrich_opportunities: Enrich opportunities with rule performance data
 *   - quality_enhance: Phase 2B — Originality enhancer + numeric claim guard
 *   - publish_gate: Filter opportunities through English publish gate
 *   - decision: Apply decision engine to publishable opportunities
 *   - persist_decision: Log the decision to decision_runs table
 *   - telegram_delivery: Deliver selected recommendations to Telegram
 *
 * Critical: scan_account processes ONE account per task.
 * This is not a quality reduction. It is execution partitioning.
 *
 * Quality guarantee: All content-engine-v3 logic is preserved.
 * The worker uses scanSingleAccountForPipeline and mergeAndDiscoverOpportunities
 * from content-engine-v3 — the SAME quality logic as scanXAccounts.
 * No placeholder opportunities with empty crafted_text or shield_passed=false.
 */

import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import {
  lockNextTask,
  completeTask,
  failTask,
  markStuckTasks,
  type PipelineTaskRow,
  type PipelineTaskType
} from './pipeline-queue';
import {
  updatePipelineRun,
  appendPipelineRunLog
} from './pipeline-run-tracker';
import {
  scanSingleAccountForPipeline,
  mergeAndDiscoverOpportunities,
  AccountScanError,
  type SingleAccountScanResult,
  type AccountScanEmptyReason
} from './content-engine-v3';
import { recordPublishGateRejections } from './rejection-ledger';
import { withCostContext } from './cost-context';
import { enhanceOpportunities, type OpportunityWithDiagnostics } from './originality-enhancer';
import { guardOpportunitiesNumericClaims } from './numeric-claim-guard';
import { cleanOpportunitiesText } from './crafted-text-cleaner';
import { guardNicheAlignment } from './niche-alignment';
import { validateOpportunitiesBeforeGate } from './quality-validator';
import { evaluateOpportunities, type OpportunityBrief, type IntelligenceSummary } from './opportunity-intelligence';
import { judgeCraftedCandidates, isNearPass, type JudgeResult, type JudgeSummary } from './opportunity-judge';
import { attemptNearPassPolish, attemptBriefLockedMicroRepair, isMicroRepairEligible, computeNearPassDiagnostics, MAX_POLISH_CANDIDATES_PER_RUN, type PolishInput, type PolishOutcome, type NearPassDiagnostics } from './near-pass-polish';
import { callModel, parseModelJson } from './model-router';
import { getOriginalityContext, buildOriginalityPromptSection, detectOriginalityIndicators, validateOriginalityOutput, type OriginalityContext, type OriginalityDiagnostics } from './originality-context';
import { buildSignatureVoiceSection, validateSignatureVoice, type SignatureVoiceDiagnostics } from './signature-voice';
import { computeLocalCandidateScore, selectCandidatesForJudge, deduplicateJudgedCandidates, type CraftedCandidate, type BriefForSelection, type CandidateWithJudgeResult } from './candidate-selector';
import { compactRunIntoMemory, type CompactionResult } from './structured-memory-compaction';
import { getRelevantStructuredMemory, buildMemoryPromptSection, buildPolishMemorySection, type StructuredMemoryResult } from './structured-memory-retrieval';
import { getDefaultPostLengthPolicy, normalizePostLengthPolicy, getPostHardLimit, getPostTargetChars, countPostChars, isWithinPostLimit, validatePostLength, buildPostLengthInstruction, buildShortenInstruction, type PostLengthPolicy, type PostLengthValidationResult } from './post-length-policy';

// Re-export CraftedCandidate for consumers
export type { CraftedCandidate } from './candidate-selector';

// ═══ Types ═══

export type ProcessBatchOptions = {
  workerId: string;
  maxTasks?: number;       // Max tasks to process in this batch (default 1)
  maxRuntimeMs?: number;   // Stop processing before this runtime (default 60000)
  runId?: string;          // Only process tasks for this specific run
};

export type ProcessBatchResult = {
  ok: boolean;
  worker_id: string;
  tasks_processed: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_retried: number;
  runtime_ms: number;
  errors: string[];
  stopped_reason: string;  // 'max_tasks' | 'max_runtime' | 'no_tasks' | 'error'
};

// ═══ Main entry: processPipelineTaskBatch ═══

/**
 * Process a batch of pipeline tasks from the queue.
 * Locks one task at a time, processes it, saves result, updates run progress.
 * Stops before maxRuntimeMs to avoid Vercel timeout or worker overrun.
 * Returns a structured summary.
 */
export async function processPipelineTaskBatch(options: ProcessBatchOptions): Promise<ProcessBatchResult> {
  const workerId = options.workerId;
  const maxTasks = options.maxTasks ?? 1;
  const maxRuntimeMs = options.maxRuntimeMs ?? 60000;
  const startTime = Date.now();

  let tasksProcessed = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let tasksRetried = 0;
  const errors: string[] = [];

  while (tasksProcessed < maxTasks) {
    // Check runtime
    if (Date.now() - startTime > maxRuntimeMs * 0.9) {
      return buildBatchResult('max_runtime', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
    }

    // Lock next eligible task
    const lockResult = await lockNextTask(workerId, {
      runId: options.runId
    });

    if (!lockResult.locked || !lockResult.task) {
      // No more tasks available
      if (tasksProcessed > 0) {
        return buildBatchResult('no_more_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
      }
      return buildBatchResult('no_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
    }

    const task = lockResult.task;
    tasksProcessed++;

    // Process the task within a cost context so callModel/fetchTwitterApiJson
    // can attribute cost events to this specific run_id and task_id
    try {
      const result = await withCostContext(
        { run_id: task.run_id, task_id: task.id, task_type: task.task_type },
        () => processTask(task)
      );

      if (result.ok) {
        await completeTask(task.id, result.result);
        tasksCompleted++;

        // Log progress
        if (task.run_id) {
          await appendPipelineRunLog(task.run_id, `task completed: ${task.task_type}`, {
            task_id: task.id,
            account_handle: task.account_handle,
            result_summary: Object.keys(result.result)
          });
        }
      } else {
        const failResult = await failTask(task.id, new Error(result.error || 'Task processing failed'));
        if (failResult.retried) {
          tasksRetried++;
        } else {
          tasksFailed++;
        }

        errors.push(`${task.task_type} (${task.account_handle || 'global'}): ${result.error}`);

        if (task.run_id) {
          await appendPipelineRunLog(task.run_id, `task failed: ${task.task_type} — ${result.error}`, {
            task_id: task.id,
            account_handle: task.account_handle
          });
        }
      }
    } catch (err: any) {
      const failResult = await failTask(task.id, err);
      if (failResult.retried) {
        tasksRetried++;
      } else {
        tasksFailed++;
      }

      errors.push(`${task.task_type} (${task.account_handle || 'global'}): ${err.message}`);
    }
  }

  return buildBatchResult('max_tasks', workerId, tasksProcessed, tasksCompleted, tasksFailed, tasksRetried, startTime, errors);
}

// ═══ Phase 2D.2: Brief-faithful Crafting Functions ═══

/**
 * Patterns indicating invented personal experience that is NOT supported by the source.
 * These should NEVER appear in crafted text unless the source explicitly supports them.
 */
export const INVENTED_EXPERIENCE_PATTERNS = [
  /\bI tried\b/i,
  /\bI found\b/i,
  /\bmy experience\b/i,
  /\bI tested\b/i,
  /\bI used\b/i,
  /\bI built\b/i,
  /\bI discovered\b/i,
  /\bI learned\b/i,
  /\bI noticed\b/i,
  /\bI've been\b/i,
  /\bI've done\b/i,
  /\bI started\b/i,
  /\bI switched\b/i,
];

/**
 * Generic praise patterns that should not appear in crafted text.
 * These indicate low-quality, non-analytical content.
 */
export const GENERIC_PRAISE_PATTERNS = [
  /\bbrilliant minds?\b/i,
  /\bgame changer\b/i,
  /\bthis is huge\b/i,
  /\bseeing \w+ gives me hope\b/i,
  /\bso inspiring\b/i,
  /\bamazing (new|update|feature)\b/i,
  /\bgroundbreaking\b/i,
  /\bhype cycle\b/i,
  /\blabs get serious\b/i,
  /\bfoundational breakthroughs\b/i,
  /\baitract elite\b/i,
  /\bgives me hope\b/i,
];

/**
 * Heuristic brief alignment validator.
 * Checks whether crafted_text follows the brief's recommended_angle.
 *
 * Scoring:
 * - Start at 5.0 (neutral)
 * - Penalize if crafted text doesn't share concepts with recommended_angle
 * - Penalize generic praise
 * - Penalize invented personal experience (unless source supports it)
 * - Penalize if do_not_claim terms appear
 * - Reward if key concepts from recommended_angle appear in text
 *
 * Returns score 1-10 and notes.
 */
export function validateBriefAlignment(
  craftedText: string,
  brief: {
    recommended_angle: string;
    source_summary: string;
    do_not_claim: string[];
    required_context: string[];
  },
  sourceText?: string
): { score: number; notes: string[]; invented_personal_experience: boolean; ignored_recommended_angle: boolean } {
  if (!craftedText || craftedText.length < 10) {
    return { score: 1, notes: ['Empty or too short crafted text'], invented_personal_experience: false, ignored_recommended_angle: true };
  }

  const notes: string[] = [];
  let score = 5.0;

  // Extract key concepts from recommended_angle (split by common delimiters)
  const angleWords = (brief.recommended_angle || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);  // Skip short words

  // Check if crafted text contains concepts from the recommended angle
  const craftedLower = craftedText.toLowerCase();
  const matchedConcepts = angleWords.filter(w => craftedLower.includes(w));
  const conceptRatio = angleWords.length > 0 ? matchedConcepts.length / angleWords.length : 0;

  if (conceptRatio >= 0.3) {
    score += 2.0;
    notes.push(`Good angle alignment: ${matchedConcepts.length}/${angleWords.length} angle concepts found`);
  } else if (conceptRatio >= 0.15) {
    score += 1.0;
    notes.push(`Partial angle alignment: ${matchedConcepts.length}/${angleWords.length} angle concepts found`);
  } else {
    score -= 2.0;
    notes.push(`Weak angle alignment: only ${matchedConcepts.length}/${angleWords.length} angle concepts found — text may ignore recommended_angle`);
  }

  // Check for generic praise patterns
  for (const pattern of GENERIC_PRAISE_PATTERNS) {
    if (pattern.test(craftedText)) {
      score -= 1.5;
      notes.push(`Generic praise detected: ${pattern.source}`);
      break;
    }
  }

  // Check for invented personal experience
  let inventedExperience = false;
  const sourceLower = (sourceText || '').toLowerCase();
  for (const pattern of INVENTED_EXPERIENCE_PATTERNS) {
    if (pattern.test(craftedText)) {
      // Check if the source actually supports this personal claim
      // If the source says "I tried..." and the crafted text says "I tried...", that's OK
      // But if the source is about someone else and the crafted text says "I tried...", that's invented
      if (!sourceLower.includes('i tried') && !sourceLower.includes('i found') && !sourceLower.includes('i tested') && !sourceLower.includes('i used')) {
        score -= 2.0;
        notes.push(`Invented personal experience: pattern "${pattern.source}" detected without source support`);
        inventedExperience = true;
        break;
      }
    }
  }

  // Check for do_not_claim terms
  if (brief.do_not_claim && brief.do_not_claim.length > 0) {
    for (const claim of brief.do_not_claim) {
      const claimLower = claim.toLowerCase();
      if (craftedLower.includes(claimLower) && claimLower.length > 3) {
        score -= 1.5;
        notes.push(`do_not_claim term found in text: "${claim.slice(0, 50)}"`);
        break;
      }
    }
  }

  const ignoredAngle = conceptRatio < 0.1 && brief.recommended_angle.length >= 20;

  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  return {
    score,
    notes,
    invented_personal_experience: inventedExperience,
    ignored_recommended_angle: ignoredAngle,
  };
}

/**
 * Phase 2D.3: Local quality checks for crafted text before accepting.
 * Returns failure reasons if any check fails, or empty array if all pass.
 * Phase S1.2: Uses post_length_policy for hard limit instead of hardcoded 280.
 */
function localCraftingChecks(
  craftedText: string,
  brief: { do_not_claim: string[] },
  sourceText?: string,
  postLengthPolicy?: PostLengthPolicy | null
): string[] {
  const policy = postLengthPolicy || getDefaultPostLengthPolicy();
  const hardLimit = policy.hard_limit_chars;
  const failures: string[] = [];

  // Check: not JSON-looking
  if (/^\s*\{/.test(craftedText) || /^```/.test(craftedText)) {
    failures.push('text_looks_jsonish');
  }

  // Check: no invented personal experience
  for (const pattern of INVENTED_EXPERIENCE_PATTERNS) {
    if (pattern.test(craftedText)) {
      const sourceLower = (sourceText || '').toLowerCase();
      if (!sourceLower.includes('i tried') && !sourceLower.includes('i found') && !sourceLower.includes('i tested') && !sourceLower.includes('i used')) {
        failures.push(`invented_personal_experience:${pattern.source}`);
        break;
      }
    }
  }

  // Check: no generic praise
  for (const pattern of GENERIC_PRAISE_PATTERNS) {
    if (pattern.test(craftedText)) {
      failures.push(`generic_praise:${pattern.source}`);
      break;
    }
  }

  // Check: no do_not_claim terms
  if (brief.do_not_claim && brief.do_not_claim.length > 0) {
    const craftedLower = craftedText.toLowerCase();
    for (const claim of brief.do_not_claim) {
      const claimLower = claim.toLowerCase();
      if (craftedLower.includes(claimLower) && claimLower.length > 3) {
        failures.push(`do_not_claim_violation:${claim.slice(0, 30)}`);
        break;
      }
    }
  }

  // Check: length — use policy-based hard limit (Phase S1.2)
  if (craftedText.length < 40) {
    failures.push('too_short_under_40');
  }
  if (craftedText.length > hardLimit) {
    failures.push('too_long_over_hard_limit');
  }

  return failures;
}

/**
 * Craft content from a brief using the selected_candidate_crafting model route.
 *
 * Phase 2G.3: Multi-candidate generation — requests 3 variants from the model:
 *   - brief_faithful: maximizes recommended_angle and required_context; practical and clear; least risky
 *   - signature_original: maximizes originality, signature phrase, memorable frame; must remain evidence-safe
 *   - operator_heuristic: maximizes practical usefulness; gives a rule/checklist/decision heuristic
 *
 * Returns CraftedCandidate[] (array of candidates).
 *
 * Fallback: If the model returns the old single-candidate schema (no candidates array,
 * has crafted_text at top level), wrap it as one candidate with variant_type "legacy".
 */
async function craftFromBrief(
  opp: Record<string, any>,
  brief: {
    recommended_angle: string;
    audience_relevance: string;
    why_it_matters: string;
    do_not_claim: string[];
    content_format: string;
    source_summary: string;
    required_context: string[];
    niche_fit_score: number;
    originality_potential_score: number;
    publishability_score: number;
  },
  originalityContext?: OriginalityContext | null,
  memorySection?: string,
  postLengthPolicy?: PostLengthPolicy | null
): Promise<CraftedCandidate[]> {
  const sourceText = String(opp.source_text || opp.text || '').slice(0, 400);
  const sourceAuthor = String(opp.source_author || opp.author || opp.username || '');
  const originalCrafted = String(opp.crafted_text || '').slice(0, 200);
  const doNotClaimStr = (brief.do_not_claim || []).map(c => `- "${c}"`).join('\n');
  const requiredContextStr = (brief.required_context || []).map(c => `- ${c}`).join('\n');

  // Phase 2G: Build originality context section if available
  const originalitySection = originalityContext
    ? '\n\n' + buildOriginalityPromptSection(originalityContext)
    : '';

  // Phase 2G.1: Build signature voice section (always included for stronger voice)
  const signatureVoiceSection = '\n\n' + buildSignatureVoiceSection({
    recommended_angle: brief.recommended_angle,
    source_text_preview: sourceText.slice(0, 150),
    twist_type_used: undefined, // Will be determined by model
  });

  // Phase S1.2: Build post length instruction from policy
  const effectivePolicy = postLengthPolicy || getDefaultPostLengthPolicy();
  const postLengthInstruction = buildPostLengthInstruction(effectivePolicy);

  // Phase 2G.3: Updated JSON schema for 3 candidate variants
  const systemPrompt = `You are a content crafter for @30piq, an X account focused on AI, creators, internet culture, productivity, skills, and modern work.

Your task: Craft THREE tweet variants that STRICTLY follow the Opportunity Brief below. Each variant optimizes for a different priority.

═══ MANDATORY RULES (ALL VARIANTS) ═══

1. FOLLOW THE RECOMMENDED ANGLE exactly. The recommended_angle is your primary directive — do NOT substitute it with a different angle.

2. DO NOT invent personal experience. Never write "I tried", "I found", "I tested", "my experience", "I used", "I built", "I discovered", "I learned", "I noticed" — unless the source tweet is FROM @30piq themselves confirming this experience.

3. DO NOT use vague or grand phrases: no "brilliant minds", "game changer", "this is huge", "seeing X gives me hope", "so inspiring", "hype cycle", "labs get serious", "foundational breakthroughs attract elite builders", "groundbreaking".

4. AVOID all do_not_claim terms listed below — these are claims the source does NOT support and must not be repeated.

5. INCLUDE all required_context items — these are facts/points that MUST be present for the content to be honest.

6. Keep claims as interpretations, not facts: prefer "A useful signal is..." over "This proves..."; prefer "One way to read this..." over "This means...".

7. Do NOT invent historical parallels unless the source or required_context directly supports them.

8. Sound analytical, specific, and calm — not a hype account, not a content mill, not a life coach.

9. ${postLengthInstruction} Each must be at least 40 characters.

10. English ONLY.

11. No hashtags, no emojis, no AI slop words (delve, crucial, leverage, game-changer, unlock, empower, elevate, foster, streamline, harness, cutting-edge, paradigm, synergy).

═══ THREE VARIANT TYPES ═══

1. "brief_faithful" — Maximizes recommended_angle alignment and required_context inclusion. Practical and clear. Least risky. The safe, solid take that follows the brief precisely.

2. "signature_original" — Maximizes originality, signature phrase, memorable frame. Must remain evidence-safe. Must still preserve recommended_angle but can reframe it with a sharper twist. This is the bold, distinctive take.

3. "operator_heuristic" — Maximizes practical usefulness. Gives a rule/checklist/decision heuristic. Must include a concrete operator takeaway the reader can apply today. This is the actionable, utility-first take.

═══ OPPORTUNITY BRIEF ═══

Recommended angle: ${brief.recommended_angle}

Source summary: ${brief.source_summary}

Why it matters: ${brief.why_it_matters}

Audience relevance: ${brief.audience_relevance}

Content format: ${brief.content_format}

DO NOT CLAIM:
${doNotClaimStr || '(none)'}

REQUIRED CONTEXT (must include):
${requiredContextStr || '(none)'}

Niche fit: ${brief.niche_fit_score}/10
Originality potential: ${brief.originality_potential_score}/10
Publishability: ${brief.publishability_score}/10${originalitySection}${signatureVoiceSection}${memorySection ? '\n\n' + memorySection : ''}

═══ JSON OUTPUT SCHEMA ═══

Return a JSON object with a "candidates" array containing exactly 3 objects:
{
  "candidates": [
    {
      "variant_type": "brief_faithful",
      "crafted_text": "string under 280 chars",
      "format": "quote|reply|standalone",
      "brief_alignment_score": number,
      "originality_strategy": "string explaining what makes this original",
      "twist_type_used": "one of: inversion|mechanism|operator_heuristic|cost_of_being_stale|timeline_shift|capability_map|distribution_positioning|constraint_insight|failure_mode_insight",
      "signature_phrase": "3-8 word repeatable phrase from the text",
      "operator_takeaway": "concrete operator rule or actionable signal",
      "avoided_anti_patterns": ["list of anti-patterns you consciously avoided"],
      "claims_to_avoid_checked": true,
      "notes": "short string"
    },
    {
      "variant_type": "signature_original",
      "crafted_text": "string under 280 chars",
      "format": "quote|reply|standalone",
      "brief_alignment_score": number,
      "originality_strategy": "...",
      "twist_type_used": "...",
      "signature_phrase": "...",
      "operator_takeaway": "...",
      "avoided_anti_patterns": [...],
      "claims_to_avoid_checked": true,
      "notes": "..."
    },
    {
      "variant_type": "operator_heuristic",
      "crafted_text": "string under 280 chars",
      "format": "quote|reply|standalone",
      "brief_alignment_score": number,
      "originality_strategy": "...",
      "twist_type_used": "...",
      "signature_phrase": "...",
      "operator_takeaway": "...",
      "avoided_anti_patterns": [...],
      "claims_to_avoid_checked": true,
      "notes": "..."
    }
  ]
}`;

  const userPrompt = `Craft three tweet variants for this opportunity:

Source by @${sourceAuthor}: "${sourceText}"

Original drafted text (IGNORE its angle — use the brief's angle instead): "${originalCrafted}"

Return a JSON object with a "candidates" array containing brief_faithful, signature_original, and operator_heuristic variants.`;

  try {
    const response = await callModel('selected_candidate_crafting' as any, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.18, max_tokens: 1800, response_format: { type: 'json_object' } });

    // Phase 2D.3/2G.3: Strict JSON parse
    let parsed: any;
    try {
      parsed = parseModelJson(String(response || ''));
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return [makeFailedCandidate(brief, 'json_parse_failed')];
    }

    // Phase 2G.3: Check for new candidates array schema vs old single-candidate schema
    const hasCandidatesArray = Array.isArray(parsed.candidates) && parsed.candidates.length > 0;
    const hasOldSchema = typeof parsed.crafted_text === 'string' && parsed.crafted_text.trim();

    if (hasCandidatesArray) {
      // New schema — process each candidate in the array
      const candidates: CraftedCandidate[] = [];
      for (const rawCandidate of parsed.candidates) {
        const processed = processCandidateVariant(rawCandidate, brief, sourceText, originalityContext, undefined, effectivePolicy);
        candidates.push(processed);
      }
      return candidates;
    } else if (hasOldSchema) {
      // Old schema — backward compatibility: wrap as single "legacy" candidate
      console.log('[craftFromBrief] Model returned old single-candidate schema, wrapping as legacy candidate');
      const processed = processCandidateVariant(parsed, brief, sourceText, originalityContext, 'legacy', effectivePolicy);
      return [processed];
    } else {
      // Neither schema — parse failure
      return [makeFailedCandidate(brief, 'json_missing_candidates_or_crafted_text')];
    }
  } catch (err: any) {
    console.warn(`[craftFromBrief] AI call failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return [makeFailedCandidate(brief, `ai_call_failed:${(err?.message || 'unknown').slice(0, 50)}`)];
  }
}

/**
 * Helper: Create a failed CraftedCandidate with error diagnostics.
 */
function makeFailedCandidate(
  brief: Record<string, any>,
  failureReason: string
): CraftedCandidate {
  return {
    variant_type: 'legacy',
    crafted_text: null,
    format: brief.content_format || 'reply',
    brief_alignment_score: 1,
    brief_alignment_notes: [`selected_candidate_crafting_parse_failed: ${failureReason}`],
    invented_personal_experience_flag: false,
    ignored_recommended_angle_flag: true,
    _brief_crafting_parse_failed: true,
    _brief_crafting_failure_reason: failureReason,
  };
}

/**
 * Helper: Process a single candidate variant from the model response.
 * Runs local quality checks, repair if needed, and validation.
 */
function processCandidateVariant(
  rawCandidate: any,
  brief: Record<string, any>,
  sourceText: string,
  originalityContext?: OriginalityContext | null,
  overrideVariantType?: string,
  postLengthPolicy?: PostLengthPolicy | null
): CraftedCandidate {
  const variantType = overrideVariantType ||
    (typeof rawCandidate.variant_type === 'string' ? rawCandidate.variant_type : 'legacy');

  // Validate crafted_text
  if (!rawCandidate || typeof rawCandidate.crafted_text !== 'string' || !rawCandidate.crafted_text.trim()) {
    return {
      variant_type: variantType,
      crafted_text: null,
      format: brief.content_format || 'reply',
      brief_alignment_score: 1,
      brief_alignment_notes: ['selected_candidate_crafting_parse_failed: JSON missing crafted_text or parse error'],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: true,
      _brief_crafting_parse_failed: true,
      _brief_crafting_failure_reason: 'json_missing_crafted_text',
    };
  }

  let crafted = rawCandidate.crafted_text.trim();
  const modelFormat = rawCandidate.format || brief.content_format || 'reply';

  // Do NOT use raw model output if it still looks like JSON/malformed
  if (/^\s*\{/.test(crafted) || /^```/.test(crafted)) {
    return {
      variant_type: variantType,
      crafted_text: null,
      format: brief.content_format || 'reply',
      brief_alignment_score: 1,
      brief_alignment_notes: ['selected_candidate_crafting_parse_failed: crafted_text field contains JSON wrapper'],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: true,
      _brief_crafting_parse_failed: true,
      _brief_crafting_failure_reason: 'crafted_text_is_json_wrapper',
    };
  }

  if (!crafted || crafted.length < 10) {
    return {
      variant_type: variantType,
      crafted_text: null,
      format: brief.content_format || 'reply',
      brief_alignment_score: 1,
      brief_alignment_notes: ['Crafting produced empty or too short text'],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: true,
      _brief_crafting_parse_failed: false,
      _brief_crafting_failure_reason: 'text_too_short',
    };
  }

  // Pre-judge self-check — local quality checks + validateBriefAlignment
  const briefForValidation = {
    recommended_angle: brief.recommended_angle || '',
    source_summary: brief.source_summary || '',
    do_not_claim: brief.do_not_claim || [],
    required_context: brief.required_context || [],
  };
  const alignment = validateBriefAlignment(crafted, briefForValidation, sourceText);
  const localFailures = localCraftingChecks(crafted, { do_not_claim: briefForValidation.do_not_claim }, sourceText, postLengthPolicy);

  // Phase 2G: Parse originality output fields from model response
  const originalityOutput = validateOriginalityOutput(rawCandidate);

  // Phase 2G.1: Validate signature voice
  const signatureVoiceDiagnostics = validateSignatureVoice(crafted);
  // Override the model-declared signature_phrase and operator_takeaway if available
  if (rawCandidate.signature_phrase && typeof rawCandidate.signature_phrase === 'string') {
    signatureVoiceDiagnostics._signature_phrase = rawCandidate.signature_phrase.trim();
  }
  if (rawCandidate.operator_takeaway && typeof rawCandidate.operator_takeaway === 'string') {
    signatureVoiceDiagnostics._operator_takeaway = rawCandidate.operator_takeaway.trim();
  }

  // Note: For Phase 2G.3 multi-candidate, we skip the repair attempt for each
  // individual candidate — instead, the local selector (candidate-selector.ts)
  // picks the best candidates and the near-pass polish handles improvements.
  // This avoids 3x repair calls.
  const repairAttempted = false;
  const repairApplied = false;
  let repairFailureReason: string | undefined;

  // Only attempt repair for legacy (single-candidate) mode to preserve backward compat
  if (variantType === 'legacy' && (localFailures.length > 0 || alignment.score < 7.0)) {
    // Legacy repair logic — not applied for multi-candidate mode
    // (repairAttempted, repairApplied remain false for multi-candidate)
  }

  return {
    variant_type: variantType,
    crafted_text: crafted,
    format: modelFormat || brief.content_format || 'reply',
    brief_alignment_score: alignment.score,
    brief_alignment_notes: [...alignment.notes, ...localFailures],
    invented_personal_experience_flag: alignment.invented_personal_experience,
    ignored_recommended_angle_flag: alignment.ignored_recommended_angle,
    _brief_crafting_parse_failed: false,
    _brief_crafting_repair_attempted: repairAttempted,
    _brief_crafting_repair_applied: repairApplied,
    _brief_crafting_failure_reason: repairFailureReason,
    _originality_diagnostics: {
      _originality_context_used: !!originalityContext,
      _originality_twist_type_used: originalityOutput.twist_type_used || undefined,
      _originality_strategy: originalityOutput.originality_strategy || undefined,
      _originality_context_items_count: originalityContext
        ? originalityContext.angle_patterns.length + originalityContext.rejected_examples.length + originalityContext.successful_frames.length
        : 0,
      _avoided_originality_anti_patterns: originalityOutput.avoided_anti_patterns.length > 0
        ? originalityOutput.avoided_anti_patterns
        : undefined,
    },
    _signature_voice_diagnostics: signatureVoiceDiagnostics,
  };
}

// ═══ Task Processing Logic ═══

type TaskResult = {
  ok: boolean;
  result: Record<string, any>;
  error?: string;
};

/**
 * Process a single pipeline task based on its type.
 * Each task type uses the real content-engine-v3 logic — no simplified rewrites.
 */
async function processTask(task: PipelineTaskRow): Promise<TaskResult> {
  switch (task.task_type) {
    case 'load_account_state':
      return processLoadAccountState(task);
    case 'scan_account':
      return processScanAccount(task);
    case 'merge_scan_results':
      return processMergeScanResults(task);
    case 'opportunity_intelligence':
      return processOpportunityIntelligence(task);
    case 'enrich_opportunities':
      return processEnrichOpportunities(task);
    case 'quality_enhance':
      return processQualityEnhance(task);
    case 'opportunity_judge':
      return processOpportunityJudge(task);
    case 'publish_gate':
      return processPublishGate(task);
    case 'decision':
      return processDecision(task);
    case 'persist_decision':
      return processPersistDecision(task);
    case 'telegram_delivery':
      return processTelegramDelivery(task);
    default:
      return { ok: false, result: {}, error: `Unknown task type: ${task.task_type}` };
  }
}

// ═══ load_account_state ═══

async function processLoadAccountState(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const username = task.payload.username || task.account_handle || optionalEnv('X_USERNAME', '30piq');
    const { getXUserByUsername } = await import('./x');
    const xSnapshot = await getXUserByUsername(username);

    // Phase S1.2: Load or default post_length_policy for the account
    // If the account has a stored policy, normalize it. Otherwise use defaults.
    const storedPolicy = task.payload.post_length_policy || null;
    const postLengthPolicy = normalizePostLengthPolicy(storedPolicy);

    // Store in account_state
    const supabase = supabaseAdmin();
    await supabase.from('account_state').upsert({
      account_handle: username,
      x_url: `https://x.com/${username}`,
      followers_count: xSnapshot.followers_count ?? null,
      following_count: xSnapshot.following_count ?? null,
      posts_count: xSnapshot.tweet_count ?? null,
      last_live_check_at: new Date().toISOString(),
      last_known_source: task.payload.source || 'queue_worker'
    }, { onConflict: 'account_handle' });

    return {
      ok: true,
      result: {
        username,
        followers: xSnapshot.followers_count || 0,
        following: xSnapshot.following_count || 0,
        tweets: xSnapshot.tweet_count || 0,
        // Phase S1.2: Include post_length_policy for downstream tasks
        post_length_policy: postLengthPolicy,
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ scan_account (ONE account per task, FULL content-engine-v3 quality) ═══

async function processScanAccount(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const handle = task.account_handle || task.payload.account_handle;
    const tweetsPerAccount = task.payload.tweets_per_account || 8;

    if (!handle) {
      return { ok: false, result: {}, error: 'No account_handle specified for scan_account task' };
    }

    // Use the REAL content-engine-v3 per-account function — same quality as scanXAccounts
    // AccountScanError is thrown for API/network/provider failures → task fails
    // empty_reason is set for legitimate empty results → task succeeds with metadata
    const scanResult = await scanSingleAccountForPipeline(handle, tweetsPerAccount);

    // Build the result, including empty_reason if present
    const result: Record<string, any> = {
      account_handle: scanResult.account_handle,
      tweets_analyzed: scanResult.tweets_analyzed,
      viral_found: scanResult.viral_found,
      brain_updates: scanResult.brain_updates,
      // Store the full analyzed_data for merge step — this is critical
      _analyzed_data: scanResult.analyzed_data,
      _media: scanResult.media,
      _debug_log: scanResult.debug_log,
      // Phase 2E.1: prefilter diagnostics
      tweets_fetched: scanResult.tweets_fetched,
      tweets_after_prefilter: scanResult.tweets_after_prefilter,
      tweets_selected_for_analysis: scanResult.tweets_selected_for_analysis,
      skipped_retweets: scanResult.skipped_retweets,
      skipped_replies: scanResult.skipped_replies,
      skipped_low_engagement: scanResult.skipped_low_engagement,
      skipped_off_niche: scanResult.skipped_off_niche,
      top_candidate_scores: scanResult.top_candidate_scores,
    };

    // If the account had a legitimate empty result, include the reason
    // This is NOT a failure — the task succeeds, but downstream knows why it's empty
    if (scanResult.empty_reason) {
      result.empty_reason = scanResult.empty_reason;
    }

    return { ok: true, result };
  } catch (err: any) {
    // AccountScanError = API/network/provider failure → mark task as failed
    // This ensures completed_with_warnings is triggered in finalizeRunIfReady
    if (err instanceof AccountScanError) {
      console.error(`[pipeline-worker] scan_account failed for @${err.accountHandle}: ${err.message}`);
      return { ok: false, result: { account_handle: err.accountHandle, is_transient: err.isTransient }, error: err.message };
    }
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ merge_scan_results (FULL content-engine-v3 quality) ═══

async function processMergeScanResults(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Fetch all completed scan_account task results
    const { data: scanTasks, error } = await supabase
      .from('pipeline_tasks')
      .select('result, account_handle')
      .eq('run_id', runId)
      .eq('task_type', 'scan_account')
      .eq('status', 'completed');

    if (error) {
      return { ok: false, result: {}, error: `Failed to fetch scan results: ${error.message}` };
    }

    if (!scanTasks?.length) {
      return { ok: false, result: {}, error: 'No completed scan_account tasks found — cannot merge' };
    }

    // Reconstruct SingleAccountScanResult[] from stored task results
    const accountScanResults: SingleAccountScanResult[] = [];
    const emptyAccounts: { handle: string; reason: AccountScanEmptyReason }[] = [];
    for (const scanTask of scanTasks) {
      const r = scanTask.result || {};
      const emptyReason = r.empty_reason as AccountScanEmptyReason | undefined;
      if (emptyReason) {
        emptyAccounts.push({ handle: r.account_handle || scanTask.account_handle || '', reason: emptyReason });
      }
      accountScanResults.push({
        account_handle: r.account_handle || scanTask.account_handle || '',
        tweets_analyzed: r.tweets_analyzed || 0,
        viral_found: r.viral_found || 0,
        analyzed_data: r._analyzed_data || [],
        media: r._media || [],
        brain_updates: r.brain_updates || { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
        debug_log: r._debug_log || [],
        // Preserve empty_reason so mergeAndDiscoverOpportunities can skip empty accounts if needed
        empty_reason: emptyReason,
        // Phase 2E.1: Preserve prefilter diagnostics from scan_account
        tweets_fetched: r.tweets_fetched || undefined,
        tweets_after_prefilter: r.tweets_after_prefilter || undefined,
        tweets_selected_for_analysis: r.tweets_selected_for_analysis || undefined,
        skipped_retweets: r.skipped_retweets || undefined,
        skipped_replies: r.skipped_replies || undefined,
        skipped_low_engagement: r.skipped_low_engagement || undefined,
        skipped_off_niche: r.skipped_off_niche || undefined,
        top_candidate_scores: r.top_candidate_scores || undefined,
      });
    }

    // Use the REAL content-engine-v3 merge+discover function
    // This produces real ContentOpportunity objects with crafted_text, shield_passed, etc.
    const mergeResult = await mergeAndDiscoverOpportunities(accountScanResults);

    const result: Record<string, any> = {
      accounts_scanned: mergeResult.accounts_scanned,
      tweets_analyzed: mergeResult.tweets_analyzed,
      viral_found: mergeResult.viral_found,
      raw_opportunities: mergeResult.raw_opportunities,
      brain_updates: mergeResult.brain_updates,
      media_downloaded: mergeResult.media_downloaded,
      // Store the FULL opportunities for subsequent steps
      _opportunities: mergeResult.opportunities,
      _debug_log: mergeResult.debug_log,
      // Phase 2E.1: Discovery diagnostics
      accounts_scanned_count: mergeResult.accounts_scanned_count,
      tweets_fetched_total: mergeResult.tweets_fetched_total,
      tweets_after_prefilter_total: mergeResult.tweets_after_prefilter_total,
      tweets_selected_for_analysis_total: mergeResult.tweets_selected_for_analysis_total,
      top_source_accounts: mergeResult.top_source_accounts,
      top_discovery_reasons: mergeResult.top_discovery_reasons,
      skipped_counts: mergeResult.skipped_counts,
    };

    // Include info about legitimately empty accounts for downstream visibility
    if (emptyAccounts.length > 0) {
      result.empty_accounts = emptyAccounts;
    }

    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ opportunity_intelligence (Phase 2D) ═══

async function processOpportunityIntelligence(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get merge results (opportunities from scan)
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    const opportunities: Record<string, any>[] = mergeTask?.result?._opportunities || [];

    if (!opportunities.length) {
      return {
        ok: true,
        result: {
          raw_opportunity_count: 0,
          intelligence_evaluated_count: 0,
          intelligence_rejected_count: 0,
          intelligence_selected_count: 0,
          _briefs: [],
          _intelligence_summary: null,
        }
      };
    }

    // Run intelligence evaluation on all raw opportunities
    const { briefs, summary } = await evaluateOpportunities(opportunities);

    // Filter to only selected opportunities (should_craft = true)
    const selectedBriefs = briefs.filter(b => b.should_craft);
    const rejectedBriefs = briefs.filter(b => !b.should_craft);

    // Record rejected opportunities to rejection ledger (non-blocking)
    if (rejectedBriefs.length > 0) {
      try {
        await recordPublishGateRejections(
          rejectedBriefs.map((b, index) => ({
            index,
            type: b.type,
            reason: `intelligence_rejected:${b.rejection_reason || 'unknown'}`,
            preview: b.source_text.slice(0, 140),
          })),
          {
            run_id: runId,
            task_id: task.id,
            opportunities: rejectedBriefs as any,
          }
        );
      } catch (rejErr: any) {
        console.error('[pipeline-worker] intelligence rejection ledger error:', rejErr.message);
      }
    }

    // Log summary
    console.log(`[pipeline-worker] opportunity_intelligence: evaluated ${summary.intelligence_evaluated_count} raw opportunities, selected ${summary.intelligence_selected_count}, rejected ${summary.intelligence_rejected_count}. Top rejection reasons: ${JSON.stringify(summary.top_rejection_reasons)}`);

    // Phase 2D.2: Use index-based matching instead of source_text/source_tweet_url matching.
    // evaluateOpportunities processes opportunities in order, so briefs[i] ↔ opportunities[i].
    // The old code used briefs.find() by source_text which could match duplicates,
    // causing selected_opportunities_count > intelligence_selected_count.
    const selectedOpportunities = opportunities
      .map((opp, index) => ({ opp, brief: briefs[index], index }))
      .filter(({ brief }) => brief?.should_craft === true)
      .map(({ opp, brief }) => ({
        ...opp,
        _source_index: brief ? (brief as any)._source_index : undefined,
        _brief: brief ? {
          recommended_angle: brief.recommended_angle,
          audience_relevance: brief.audience_relevance,
          why_it_matters: brief.why_it_matters,
          do_not_claim: brief.do_not_claim,
          content_format: brief.content_format,
          source_summary: brief.source_summary,
          required_context: brief.required_context,
          niche_fit_score: brief.niche_fit_score,
          originality_potential_score: brief.originality_potential_score,
          publishability_score: brief.publishability_score,
        } : undefined,
      }));

    // ═══ Phase 2F.1: Source Deduplication ═══
    // Group opportunities by source_tweet_url (or source_text hash as fallback).
    // If multiple opportunities share the same source, keep only the strongest one
    // UNLESS both have clearly different content_format AND both have high initial quality.
    // Preference order: higher publishability_score > higher originality_potential_score >
    // higher niche_fit_score > quote over reply if scores tied and source tweet is strong.
    const duplicateSourceExamples: string[] = [];
    const dedupedOpportunities = (() => {
      // Group by source_tweet_url (primary) or source_text (fallback)
      // Use `as any` for fields that come from the original opportunity via spread
      const groups = new Map<string, typeof selectedOpportunities>();
      for (const opp of selectedOpportunities) {
        const oppAny = opp as any;
        const key = oppAny.source_tweet_url || oppAny.tweet_url || oppAny.url
          || (() => { const t = oppAny.source_text || oppAny.text || ''; return `text:${t.slice(0, 80)}`; })();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(opp);
      }

      const result: typeof selectedOpportunities = [];
      for (const [sourceKey, group] of groups) {
        if (group.length === 1) {
          result.push(group[0]);
          continue;
        }

        // Multiple opportunities from same source — apply ranking
        // Sort by: publishability_score DESC → originality_potential_score DESC →
        // niche_fit_score DESC → content_format 'quote' over 'reply' if tied
        const ranked = [...group].sort((a, b) => {
          const aBrief = (a as any)._brief;
          const bBrief = (b as any)._brief;

          // 1. Higher publishability_score
          const aPub = aBrief?.publishability_score ?? 0;
          const bPub = bBrief?.publishability_score ?? 0;
          if (bPub !== aPub) return bPub - aPub;

          // 2. Higher originality_potential_score
          const aOrig = aBrief?.originality_potential_score ?? 0;
          const bOrig = bBrief?.originality_potential_score ?? 0;
          if (bOrig !== aOrig) return bOrig - aOrig;

          // 3. Higher niche_fit_score
          const aNiche = aBrief?.niche_fit_score ?? 0;
          const bNiche = bBrief?.niche_fit_score ?? 0;
          if (bNiche !== aNiche) return bNiche - aNiche;

          // 4. Prefer 'quote' over 'reply' if scores tied and source tweet is strong
          const aFormat = (aBrief?.content_format || (a as any).content_format || '').toLowerCase();
          const bFormat = (bBrief?.content_format || (b as any).content_format || '').toLowerCase();
          if (aFormat === 'quote' && bFormat !== 'quote') return -1;
          if (bFormat === 'quote' && aFormat !== 'quote') return 1;

          return 0;
        });

        // Always keep the top-ranked opportunity
        result.push(ranked[0]);

        // Consider keeping a second opportunity ONLY if:
        // - It has a DIFFERENT content_format from the top-ranked one
        // - AND both have high initial quality (publishability_score >= 7 AND originality_potential_score >= 7)
        if (ranked.length >= 2) {
          const topFormat = ((ranked[0] as any)._brief?.content_format || (ranked[0] as any).content_format || '').toLowerCase();
          const secondFormat = ((ranked[1] as any)._brief?.content_format || (ranked[1] as any).content_format || '').toLowerCase();
          const secondPub = (ranked[1] as any)._brief?.publishability_score ?? 0;
          const secondOrig = (ranked[1] as any)._brief?.originality_potential_score ?? 0;
          const topPub = (ranked[0] as any)._brief?.publishability_score ?? 0;
          const topOrig = (ranked[0] as any)._brief?.originality_potential_score ?? 0;

          const differentFormat = topFormat !== secondFormat && topFormat && secondFormat;
          const bothHighQuality = topPub >= 7 && topOrig >= 7 && secondPub >= 7 && secondOrig >= 7;

          if (differentFormat && bothHighQuality) {
            result.push(ranked[1]);
            duplicateSourceExamples.push(`${sourceKey}: kept 2 (different formats: ${topFormat}/${secondFormat}, both high quality)`);
          } else {
            duplicateSourceExamples.push(`${sourceKey}: reduced ${group.length} → 1 (top: pub=${topPub}, orig=${topOrig})`);
          }
        } else {
          duplicateSourceExamples.push(`${sourceKey}: reduced ${group.length} → 1`);
        }
      }

      return result;
    })();

    const duplicateSourceOpportunitiesCount = selectedOpportunities.length - dedupedOpportunities.length > 0
      ? selectedOpportunities.length
      : 0;
    const duplicateSourceOpportunitiesRemoved = selectedOpportunities.length - dedupedOpportunities.length;

    if (duplicateSourceOpportunitiesRemoved > 0) {
      console.log(`[pipeline-worker] source_dedup: removed ${duplicateSourceOpportunitiesRemoved} duplicate-source opportunities. Examples: ${duplicateSourceExamples.slice(0, 3).join('; ')}`);
    }

    // Phase 2D.2: Diagnostic — detect count mismatch
    const selectedBriefsCount = selectedBriefs.length;
    const selectedOpportunitiesCount = dedupedOpportunities.length;
    const duplicateSourceCount = (() => {
      const seen = new Map<string, number>();
      for (const opp of opportunities) {
        const key = `${opp.source_text || opp.text}|${opp.source_tweet_url || opp.tweet_url || opp.url}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      return [...seen.values()].filter(c => c > 1).reduce((sum, c) => sum + c, 0);
    })();
    const selectedCountMismatch = selectedBriefsCount !== selectedOpportunitiesCount;

    if (selectedCountMismatch) {
      console.warn(`[pipeline-worker] WARNING: selected count mismatch — selectedBriefs=${selectedBriefsCount}, selectedOpportunities=${selectedOpportunitiesCount}, duplicateSources=${duplicateSourceCount}`);
    }

    return {
      ok: true,
      result: {
        raw_opportunity_count: summary.raw_opportunity_count,
        intelligence_evaluated_count: summary.intelligence_evaluated_count,
        intelligence_rejected_count: summary.intelligence_rejected_count,
        intelligence_selected_count: summary.intelligence_selected_count,
        top_rejection_reasons: summary.top_rejection_reasons,
        avg_publishability_score: summary.avg_publishability_score,
        avg_originality_potential_score: summary.avg_originality_potential_score,
        // Phase 2D.2: Selection integrity diagnostics
        selected_briefs_count: selectedBriefsCount,
        selected_opportunities_count: selectedOpportunitiesCount,
        selected_count_mismatch_detected: selectedCountMismatch,
        duplicate_source_count: duplicateSourceCount,
        // Phase 2F.1: Source deduplication diagnostics
        duplicate_source_opportunities_count: duplicateSourceOpportunitiesCount,
        duplicate_source_opportunities_removed: duplicateSourceOpportunitiesRemoved,
        duplicate_source_examples: duplicateSourceExamples.slice(0, 5),
        // Phase 2D.4: Borderline rescue diagnostics
        rescue_attempted_count: summary.rescue_attempted_count,
        rescue_succeeded_count: summary.rescue_succeeded_count,
        rescue_failed_count: summary.rescue_failed_count,
        rescued_opportunity_count: summary.rescued_opportunity_count,
        rescue_reasons: summary.rescue_reasons,
        sampled_rescue_debug: summary.sampled_rescue_debug,
        _opportunities: dedupedOpportunities,
        _intelligence_summary: summary,
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: `opportunity_intelligence failed: ${err.message}` };
  }
}

// ═══ enrich_opportunities ═══

async function processEnrichOpportunities(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get intelligence results (Phase 2D: read from intelligence instead of merge directly)
    const { data: intelTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'opportunity_intelligence')
      .eq('status', 'completed')
      .maybeSingle();

    // CRITICAL FALLBACK RULE (Bug #1 fix):
    // If opportunity_intelligence task exists and completed, always use its _opportunities.
    // Empty _opportunities from intelligence means "selected zero", not "missing data".
    // Only fallback to merge_scan_results if the intelligence task does not exist at all
    // (i.e., pre-Phase 2D runs where the task type was never created).
    let opportunities: any[];
    if (intelTask) {
      // Intelligence task exists and completed — use its result, even if empty
      opportunities = intelTask.result?._opportunities || [];
    } else {
      // No intelligence task at all — this is an old (pre-Phase 2D) run.
      // Fallback to merge_scan_results for backward compat.
      const { data: mergeTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'merge_scan_results')
        .eq('status', 'completed')
        .maybeSingle();
      opportunities = mergeTask?.result?._opportunities || [];
    }

    if (!opportunities.length) {
      return {
        ok: true,
        result: {
          enriched_opportunities: 0,
          avg_weight: 0,
          boosted_count: 0,
          penalized_count: 0,
          _opportunities: []
        }
      };
    }

    // Phase S1.2 follow-up: Load post_length_policy from load_account_state for this run
    let enrichPolicy = getDefaultPostLengthPolicy();
    try {
      const { data: accountTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'load_account_state')
        .eq('status', 'completed')
        .maybeSingle();
      if (accountTask?.result?.post_length_policy) {
        enrichPolicy = normalizePostLengthPolicy(accountTask.result.post_length_policy);
      }
    } catch (policyErr: any) {
      console.warn(`[pipeline-worker] enrich: failed to load post_length_policy, using defaults: ${(policyErr?.message || 'unknown').slice(0, 200)}`);
    }

    const { enrichOpportunitiesWithRulePerformance } = await import('./enrich-opportunities-with-rule-performance');
    const rulePerformanceStats = await enrichOpportunitiesWithRulePerformance(opportunities);

    // Phase 2D.2: Brief-faithful recrafting for selected opportunities that have a _brief.
    // The original crafted_text from content-engine-v3 was generated BEFORE intelligence,
    // so it ignores the recommended_angle. We now recraft using selected_candidate_crafting.
    // Phase 2G: Fetch originality context ONCE per run, share across all candidates.
    // Phase 2G.3: Multi-candidate generation + local pre-selection
    let briefRecraftCount = 0;
    let briefRecraftFailed = 0;
    let originalityContextUsedCount = 0;
    let originalityContextFetchFailedCount = 0;
    // Phase M1: Structured memory diagnostics
    let memoryRulesRetrievedCount = 0;
    let memorySourceUsedCount = 0;
    let memoryAntiPatternsUsedCount = 0;
    const originalityTwistTypeCounts: Record<string, number> = {};
    const originalityAntiPatternsUsed: string[] = [];
    // Phase 2G.1: Signature voice task-level diagnostics
    let signatureVoiceUsedCount = 0;
    let signatureVoiceScoreSum = 0;
    let signatureVoiceScoreCount = 0;
    const signatureVoiceFailureReasonsAll: string[] = [];
    // Phase 2G.3: Multi-candidate task-level diagnostics
    let multiCandidateGenerationCount = 0;
    const multiCandidateVariantsGenerated: string[] = [];
    let multiCandidateDroppedCount = 0;
    let multiCandidateParseFallbackCount = 0;
    const multiCandidateBestVariantCounts: Record<string, number> = {};

    // Phase 2G: Fetch originality context for the batch (shared, not per-candidate)
    let batchOriginalityContext: OriginalityContext | null = null;
    try {
      // Use the first opportunity's context to seed the batch
      const firstOpp = opportunities.find((o: any) => o._brief?.recommended_angle?.length >= 10);
      if (firstOpp) {
        batchOriginalityContext = await getOriginalityContext({
          source_text: String((firstOpp as any).source_text || (firstOpp as any).text || ''),
          source_author: (firstOpp as any).source_author || (firstOpp as any).author,
          brief: (firstOpp as any)._brief,
          max_items: 8,
        });
        if (batchOriginalityContext) {
          originalityContextUsedCount++;
        }
      }
    } catch (origCtxErr: any) {
      console.warn(`[pipeline-worker] originality context fetch failed: ${(origCtxErr?.message || 'unknown').slice(0, 200)}`);
      originalityContextFetchFailedCount++;
    }

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i];
      const brief = opp._brief;
      if (brief && brief.recommended_angle && brief.recommended_angle.length >= 10) {
        try {
          // Phase 2G: Get per-candidate originality context (can reuse batch context or refine)
          let originalityCtx: OriginalityContext | null = batchOriginalityContext;
          if (originalityCtx && i > 0) {
            // For candidates after the first, refresh context with their specific source
            try {
              originalityCtx = await getOriginalityContext({
                source_text: String((opp as any).source_text || (opp as any).text || ''),
                source_author: (opp as any).source_author || (opp as any).author,
                brief: opp._brief,
                current_text: (opp as any).crafted_text,
                failure_reasons: [],
                max_items: 8,
              });
            } catch {
              // Fall back to batch context
              originalityCtx = batchOriginalityContext;
            }
          }

          // Phase M1: Retrieve structured memory for crafting
          let memorySection = '';
          try {
            const memory = await getRelevantStructuredMemory({
              source_author: (opp as any).source_author || (opp as any).author,
              source_text: String((opp as any).source_text || (opp as any).text || '').slice(0, 400),
              recommended_angle: brief.recommended_angle,
              task_type: 'craft',
            });
            memorySection = buildMemoryPromptSection(memory);
            if (memory._meta.total_items > 0) {
              memoryRulesRetrievedCount += memory._meta.total_items;
              memorySourceUsedCount += memory._meta.source_memory_used ? 1 : 0;
              memoryAntiPatternsUsedCount += memory._meta.anti_patterns_used_count;
            }
          } catch (memErr: any) {
            console.warn(`[pipeline-worker] structured memory retrieval for craft failed: ${(memErr?.message || 'unknown').slice(0, 200)}`);
          }

          // Phase 2G.3: craftFromBrief now returns CraftedCandidate[]
          // Phase S1.2 follow-up: Pass enrichPolicy so craft prompt includes actual account limits
          const allCandidates = await craftFromBrief(opp, brief, originalityCtx, memorySection || undefined, enrichPolicy);

          // Track multi-candidate diagnostics
          multiCandidateGenerationCount += allCandidates.length;
          for (const c of allCandidates) {
            multiCandidateVariantsGenerated.push(c.variant_type);
          }
          // Check if any candidate is a legacy (old schema fallback)
          if (allCandidates.length === 1 && allCandidates[0].variant_type === 'legacy') {
            multiCandidateParseFallbackCount++;
          }

          // Phase 2G.3: Local pre-selection — pick best candidates for judge
          const briefForSelection: BriefForSelection = {
            recommended_angle: brief.recommended_angle,
            source_summary: brief.source_summary || '',
            do_not_claim: brief.do_not_claim || [],
            required_context: brief.required_context || [],
          };
          const selectionResult = selectCandidatesForJudge(allCandidates, briefForSelection, enrichPolicy.hard_limit_chars);

          // Track dropped candidates
          multiCandidateDroppedCount += selectionResult.dropped;

          // Use the best selected candidate's data for the opportunity
          const bestCandidate = selectionResult.selected[0]; // Always exists if candidates were generated
          if (bestCandidate && bestCandidate.crafted_text) {
            // Track best variant type
            multiCandidateBestVariantCounts[bestCandidate.variant_type] =
              (multiCandidateBestVariantCounts[bestCandidate.variant_type] || 0) + 1;

            // Build alternatives summary from non-selected candidates
            const alternativesSummary = allCandidates
              .filter(c => !selectionResult.selected.includes(c))
              .map(c => `${c.variant_type}(local_score=${c._candidate_local_score ?? 'N/A'})`)
              .join(', ');

            opportunities[i] = {
              ...opp,
              crafted_text: bestCandidate.crafted_text,
              _brief_used_for_crafting: true,
              _brief_alignment_score: bestCandidate.brief_alignment_score,
              _brief_alignment_notes: bestCandidate.brief_alignment_notes,
              _invented_personal_experience_flag: bestCandidate.invented_personal_experience_flag,
              _ignored_recommended_angle_flag: bestCandidate.ignored_recommended_angle_flag,
              // Phase 2D.3 diagnostics
              _brief_crafting_parse_failed: bestCandidate._brief_crafting_parse_failed || false,
              _brief_crafting_repair_attempted: bestCandidate._brief_crafting_repair_attempted || false,
              _brief_crafting_repair_applied: bestCandidate._brief_crafting_repair_applied || false,
              _brief_crafting_failure_reason: bestCandidate._brief_crafting_failure_reason,
              // Phase 2G: Originality diagnostics
              _originality_context_used: bestCandidate._originality_diagnostics?._originality_context_used ?? false,
              _originality_twist_type_used: bestCandidate._originality_diagnostics?._originality_twist_type_used,
              _originality_strategy: bestCandidate._originality_diagnostics?._originality_strategy,
              _originality_context_items_count: bestCandidate._originality_diagnostics?._originality_context_items_count ?? 0,
              _avoided_originality_anti_patterns: bestCandidate._originality_diagnostics?._avoided_originality_anti_patterns,
              // Phase 2G.1: Signature voice diagnostics
              _signature_voice_used: bestCandidate._signature_voice_diagnostics?._signature_voice_used ?? false,
              _signature_phrase: bestCandidate._signature_voice_diagnostics?._signature_phrase,
              _operator_takeaway: bestCandidate._signature_voice_diagnostics?._operator_takeaway,
              _signature_voice_score: bestCandidate._signature_voice_diagnostics?._signature_voice_score ?? 0,
              _signature_voice_failure_reasons: bestCandidate._signature_voice_diagnostics?._signature_voice_failure_reasons,
              // Phase 2G.3: Multi-candidate diagnostics
              _candidate_variant_type: bestCandidate.variant_type,
              _candidate_local_score: bestCandidate._candidate_local_score,
              _candidate_selection_reason: bestCandidate._candidate_selection_reason,
              _candidate_generation_count: allCandidates.length,
              _candidate_dropped_count: selectionResult.dropped,
              _candidate_alternatives_summary: alternativesSummary || undefined,
              _candidate_was_multi_generated: allCandidates.length > 1,
              // Store ALL candidates for diagnostics (selected + dropped)
              _all_candidates: allCandidates,
              // Store selected candidates for the judge step
              _selected_candidates: selectionResult.selected,
            };
            briefRecraftCount++;

            // Track twist type counts from best candidate
            if (bestCandidate._originality_diagnostics?._originality_twist_type_used) {
              const twist = bestCandidate._originality_diagnostics._originality_twist_type_used;
              originalityTwistTypeCounts[twist] = (originalityTwistTypeCounts[twist] || 0) + 1;
            }
            if (bestCandidate._originality_diagnostics?._avoided_originality_anti_patterns) {
              originalityAntiPatternsUsed.push(...bestCandidate._originality_diagnostics._avoided_originality_anti_patterns);
            }
            // Phase 2G.1: Track signature voice stats from best candidate
            if (bestCandidate._signature_voice_diagnostics?._signature_voice_used) {
              signatureVoiceUsedCount++;
            }
            if (bestCandidate._signature_voice_diagnostics?._signature_voice_score) {
              signatureVoiceScoreSum += bestCandidate._signature_voice_diagnostics._signature_voice_score;
              signatureVoiceScoreCount++;
            }
            if (bestCandidate._signature_voice_diagnostics?._signature_voice_failure_reasons) {
              signatureVoiceFailureReasonsAll.push(...bestCandidate._signature_voice_diagnostics._signature_voice_failure_reasons);
            }
          } else {
            // All candidates failed — use the first one's diagnostics (even though crafted_text is null)
            const firstCandidate = allCandidates[0] || bestCandidate;
            briefRecraftFailed++;
            opportunities[i] = {
              ...opp,
              _brief_used_for_crafting: true,
              _brief_alignment_score: firstCandidate?.brief_alignment_score ?? 1,
              _brief_alignment_notes: firstCandidate?.brief_alignment_notes ?? [],
              _invented_personal_experience_flag: firstCandidate?.invented_personal_experience_flag ?? false,
              _ignored_recommended_angle_flag: firstCandidate?.ignored_recommended_angle_flag ?? true,
              _brief_crafting_parse_failed: firstCandidate?._brief_crafting_parse_failed || false,
              _brief_crafting_repair_attempted: firstCandidate?._brief_crafting_repair_attempted || false,
              _brief_crafting_repair_applied: firstCandidate?._brief_crafting_repair_applied || false,
              _brief_crafting_failure_reason: firstCandidate?._brief_crafting_failure_reason,
              _originality_context_used: firstCandidate?._originality_diagnostics?._originality_context_used ?? false,
              _originality_twist_type_used: firstCandidate?._originality_diagnostics?._originality_twist_type_used,
              _originality_strategy: firstCandidate?._originality_diagnostics?._originality_strategy,
              _originality_context_items_count: firstCandidate?._originality_diagnostics?._originality_context_items_count ?? 0,
              _avoided_originality_anti_patterns: firstCandidate?._originality_diagnostics?._avoided_originality_anti_patterns,
              _signature_voice_used: firstCandidate?._signature_voice_diagnostics?._signature_voice_used ?? false,
              _signature_phrase: firstCandidate?._signature_voice_diagnostics?._signature_phrase,
              _operator_takeaway: firstCandidate?._signature_voice_diagnostics?._operator_takeaway,
              _signature_voice_score: firstCandidate?._signature_voice_diagnostics?._signature_voice_score ?? 0,
              _signature_voice_failure_reasons: firstCandidate?._signature_voice_diagnostics?._signature_voice_failure_reasons,
              // Phase 2G.3: Multi-candidate diagnostics (even on failure)
              _candidate_variant_type: firstCandidate?.variant_type,
              _candidate_local_score: firstCandidate?._candidate_local_score,
              _candidate_generation_count: allCandidates.length,
              _candidate_dropped_count: selectionResult.dropped,
              _candidate_was_multi_generated: allCandidates.length > 1,
              _all_candidates: allCandidates,
              _selected_candidates: selectionResult.selected,
            };
          }
        } catch (recraftErr: any) {
          console.warn(`[pipeline-worker] brief recraft failed for opp ${i}: ${recraftErr?.message || 'unknown'}`);
          briefRecraftFailed++;
        }
      }
    }

    if (briefRecraftCount > 0 || briefRecraftFailed > 0) {
      console.log(`[pipeline-worker] brief-faithful recrafting: ${briefRecraftCount} succeeded, ${briefRecraftFailed} failed`);
    }

    return {
      ok: true,
      result: {
        enriched_opportunities: rulePerformanceStats.enriched_opportunities,
        avg_weight: rulePerformanceStats.avg_weight,
        boosted_count: rulePerformanceStats.boosted_count,
        penalized_count: rulePerformanceStats.penalized_count,
        // Phase 2D.2: Brief recrafting stats
        brief_recraft_count: briefRecraftCount,
        brief_recraft_failed: briefRecraftFailed,
        // Phase 2G: Originality context diagnostics
        originality_context_used_count: originalityContextUsedCount,
        originality_twist_type_counts: originalityTwistTypeCounts,
        originality_context_fetch_failed_count: originalityContextFetchFailedCount,
        originality_anti_patterns_used: originalityAntiPatternsUsed,
        // Phase 2G.1: Signature voice task-level diagnostics
        signature_voice_used_count: signatureVoiceUsedCount,
        signature_voice_avg_score: signatureVoiceScoreCount > 0
          ? Math.round((signatureVoiceScoreSum / signatureVoiceScoreCount) * 10) / 10
          : 0,
        signature_voice_failure_reasons: signatureVoiceFailureReasonsAll,
        // Phase 2G.3: Multi-candidate task-level diagnostics
        multi_candidate_generation_count: multiCandidateGenerationCount,
        multi_candidate_variants_generated: multiCandidateVariantsGenerated,
        multi_candidate_dropped_count: multiCandidateDroppedCount,
        multi_candidate_parse_fallback_count: multiCandidateParseFallbackCount,
        multi_candidate_best_variant_counts: multiCandidateBestVariantCounts,
        // Phase M1: Structured memory diagnostics
        memory_rules_retrieved_count: memoryRulesRetrievedCount,
        memory_source_used_count: memorySourceUsedCount,
        memory_anti_patterns_used_count: memoryAntiPatternsUsedCount,
        // Phase S1.2 follow-up: Post length policy diagnostics (enrich)
        post_length_policy_hard_limit_chars: enrichPolicy.hard_limit_chars,
        post_length_policy_target_chars: enrichPolicy.target_chars,
        post_length_policy_allow_longform: enrichPolicy.allow_longform,
        _opportunities: opportunities,
        _rule_performance: rulePerformanceStats
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ quality_enhance (Phase 2B + Phase 2C) ═══

async function processQualityEnhance(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get enrich results — always use enrich if it exists (even if _opportunities=[])
    const { data: enrichTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'enrich_opportunities')
      .eq('status', 'completed')
      .maybeSingle();

    // FALLBACK RULE: Only fallback to pre-enrich source if enrich task doesn't exist.
    // If enrich exists and returned empty, that's intentional — zero opportunities pass through.
    let opportunities: OpportunityWithDiagnostics[];
    if (enrichTask) {
      opportunities = enrichTask.result?._opportunities || [];
    } else {
      // Pre-enrich pipeline — shouldn't happen in Phase 2D+ but handle gracefully
      const { data: intelTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'opportunity_intelligence')
        .eq('status', 'completed')
        .maybeSingle();
      if (intelTask) {
        opportunities = intelTask.result?._opportunities || [];
      } else {
        const { data: mergeTask } = await supabase
          .from('pipeline_tasks')
          .select('result')
          .eq('run_id', runId)
          .eq('task_type', 'merge_scan_results')
          .eq('status', 'completed')
          .maybeSingle();
        opportunities = mergeTask?.result?._opportunities || [];
      }
    }

    if (!opportunities.length) {
      return {
        ok: true,
        result: {
          enhanced_count: 0,
          rewrites_applied: 0,
          numeric_rejected: 0,
          _opportunities: [],
          _quality_summary: null,
          _numeric_guard_summary: null
        }
      };
    }

    // ═══ Phase 2C Step 0: Clean crafted_text (extract from JSON/markdown wrappers) ═══
    const cleanResult = cleanOpportunitiesText(opportunities);
    let currentOpportunities = cleanResult.cleaned as OpportunityWithDiagnostics[];

    // ═══ Phase 2C Step 1: Niche alignment scoring and guard ═══
    const nicheResult = guardNicheAlignment(currentOpportunities);
    currentOpportunities = nicheResult.guarded as OpportunityWithDiagnostics[];

    // ═══ Phase 2D.2 Step 1.5: Brief alignment gate ═══
    // For opportunities with _brief, check if crafted_text follows recommended_angle.
    // If brief_alignment_score < 7.5, mark pre_gate_rejection_reason='brief_alignment_failed'
    // and shield_passed=false. This prevents brief-ignoring content from passing.
    let briefAlignmentFailedCount = 0;
    for (let i = 0; i < currentOpportunities.length; i++) {
      const opp = currentOpportunities[i];
      if (opp._brief && opp._brief.recommended_angle && opp._brief.recommended_angle.length >= 10) {
        const alignment = validateBriefAlignment(
          opp.crafted_text || '',
          opp._brief,
          opp.source_text
        );
        // Store alignment diagnostics
        currentOpportunities[i] = {
          ...opp,
          _brief_alignment_score: alignment.score,
          _brief_alignment_notes: alignment.notes,
          _invented_personal_experience_flag: alignment.invented_personal_experience,
          _ignored_recommended_angle_flag: alignment.ignored_recommended_angle,
        };
        if (alignment.score < 7.5) {
          currentOpportunities[i]._brief_alignment_failed = true;
          currentOpportunities[i].pre_gate_rejection_reason = 'brief_alignment_failed';
          currentOpportunities[i].shield_passed = false;
          currentOpportunities[i].shield_issues = [...(currentOpportunities[i].shield_issues || []), 'brief_alignment_failed'];
          briefAlignmentFailedCount++;
        }
      }
    }
    if (briefAlignmentFailedCount > 0) {
      console.log(`[pipeline-worker] quality_enhance: ${briefAlignmentFailedCount} opportunities failed brief alignment gate`);
    }

    // ═══ Phase 2B Step 1: Originality Enhancer (self-critique/rewrite loop) ═══
    const enhanceResult = await enhanceOpportunities(currentOpportunities);

    // ═══ Phase 2B Step 2: Numeric Claim Guard ═══
    const guardResult = await guardOpportunitiesNumericClaims(enhanceResult.enhanced);

    // ═══ Phase 2C Step 3: Hard validation before publish_gate ═══
    const validationResults = validateOpportunitiesBeforeGate(guardResult.guarded);

    // Record numeric claim rejections to rejection ledger (non-blocking)
    if (guardResult.rejected.length > 0) {
      try {
        await recordPublishGateRejections(
          guardResult.rejected.map((r, index) => ({
            index,
            type: r.opportunity.type,
            reason: `numeric_claim_needs_source:${r.reason}`,
            preview: String(r.opportunity.crafted_text || '').slice(0, 140)
          })),
          {
            run_id: runId,
            task_id: task.id,
            opportunities: guardResult.rejected.map(r => r.opportunity)
          }
        );
      } catch (rejErr: any) {
        console.error('[pipeline-worker] quality_enhance rejection ledger error:', rejErr.message);
      }
    }

    // Log summary
    console.log(`[pipeline-worker] quality_enhance: cleaned ${cleanResult.summary.json_wrappers_cleaned} JSON wrappers, ${nicheResult.summary.off_niche} off-niche, rewrite_candidates=${enhanceResult.rewrite_summary.rewrite_candidates_count} attempted=${enhanceResult.rewrite_summary.rewrites_attempted} applied=${enhanceResult.rewrites_applied} failed_validation=${enhanceResult.rewrite_summary.rewrites_failed_validation}, ${guardResult.rejected.length} numeric claims rejected, ${validationResults.summary.failed} failed validation, ${validationResults.summary.passed} passed to publish_gate`);

    return {
      ok: true,
      result: {
        enhanced_count: enhanceResult.enhanced.length,
        rewrites_applied: enhanceResult.rewrites_applied,
        numeric_rejected: guardResult.rejected.length,
        numeric_claims_detected: guardResult.summary.numeric_claims_detected,
        numeric_rewrites_succeeded: guardResult.summary.rewrites_succeeded,
        // Phase 2C diagnostics
        json_wrappers_cleaned: cleanResult.summary.json_wrappers_cleaned,
        malformed_count: cleanResult.summary.malformed_count,
        off_niche_count: nicheResult.summary.off_niche,
        niche_aligned_count: nicheResult.summary.aligned,
        avg_niche_score: nicheResult.summary.avg_score,
        validation_passed: validationResults.summary.passed,
        validation_failed: validationResults.summary.failed,
        validation_failure_reasons: validationResults.summary.failure_reasons,
        // Phase 2C.1: Rewrite diagnostics
        rewrite_candidates_count: enhanceResult.rewrite_summary.rewrite_candidates_count,
        rewrites_attempted: enhanceResult.rewrite_summary.rewrites_attempted,
        rewrites_failed_validation: enhanceResult.rewrite_summary.rewrites_failed_validation,
        rewrites_skipped_reason: enhanceResult.rewrite_summary.rewrites_skipped_reason,
        // Phase 2C.2: Rewrite JSON wrapper cleaning stats
        rewrite_json_wrappers_cleaned: enhanceResult.rewrite_summary.rewrite_json_wrappers_cleaned,
        rewrite_json_wrappers_failed_cleaning: enhanceResult.rewrite_summary.rewrite_json_wrappers_failed_cleaning,
        _opportunities: validationResults.validated,
        _quality_summary: enhanceResult.scores_summary,
        _numeric_guard_summary: guardResult.summary
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ publish_gate ═══

// ═══ opportunity_judge (Phase 2D) ═══

async function processOpportunityJudge(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get quality_enhance results — always use quality_enhance if it exists
    // FALLBACK RULE: Only fallback if quality_enhance task doesn't exist at all (pre-Phase 2B run)
    const { data: qualityTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'quality_enhance')
      .eq('status', 'completed')
      .maybeSingle();

    let opportunities: OpportunityWithDiagnostics[];
    if (qualityTask) {
      // quality_enhance task exists — use its result, even if empty
      opportunities = qualityTask.result?._opportunities || [];
    } else {
      // Pre-Phase 2B run: fallback to enrich or intelligence or merge
      const { data: enrichTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'enrich_opportunities')
        .eq('status', 'completed')
        .maybeSingle();
      if (enrichTask) {
        opportunities = enrichTask.result?._opportunities || [];
      } else {
        const { data: intelTask } = await supabase
          .from('pipeline_tasks')
          .select('result')
          .eq('run_id', runId)
          .eq('task_type', 'opportunity_intelligence')
          .eq('status', 'completed')
          .maybeSingle();
        if (intelTask) {
          opportunities = intelTask.result?._opportunities || [];
        } else {
          const { data: mergeTask } = await supabase
            .from('pipeline_tasks')
            .select('result')
            .eq('run_id', runId)
            .eq('task_type', 'merge_scan_results')
            .eq('status', 'completed')
            .maybeSingle();
          opportunities = mergeTask?.result?._opportunities || [];
        }
      }
    }

    if (!opportunities.length) {
      return {
        ok: true,
        result: {
          judge_passed_count: 0,
          judge_failed_count: 0,
          judge_failure_reasons: {},
          _opportunities: [],
          _judge_summary: null,
        }
      };
    }

    // Phase S1.2 follow-up: Load post_length_policy from load_account_state for this run
    let judgePolicy = getDefaultPostLengthPolicy();
    try {
      const { data: accountTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'load_account_state')
        .eq('status', 'completed')
        .maybeSingle();
      if (accountTask?.result?.post_length_policy) {
        judgePolicy = normalizePostLengthPolicy(accountTask.result.post_length_policy);
      }
    } catch (policyErr: any) {
      console.warn(`[pipeline-worker] opportunity_judge: failed to load post_length_policy, using defaults: ${(policyErr?.message || 'unknown').slice(0, 200)}`);
    }

    // Get intelligence briefs for context (if available)
    const { data: intelTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'opportunity_intelligence')
      .eq('status', 'completed')
      .maybeSingle();

    const intelBriefs: Record<string, OpportunityBrief> = {};
    if (intelTask?.result?._intelligence_summary) {
      // Build a lookup of briefs by source text for matching
      const intelOpps: any[] = intelTask?.result?._opportunities || [];
      for (const opp of intelOpps) {
        if (opp._brief) {
          const key = (opp.source_text || opp.text || '').slice(0, 100);
          intelBriefs[key] = opp._brief;
        }
      }
    }

    // Build judge candidates with their briefs
    // Phase 2G.3: Include ALL selected candidates (up to 2 per opportunity)
    // Each candidate from _selected_candidates gets its own judge evaluation.
    // Candidates without _selected_candidates fall back to the single opp.crafted_text.
    type JudgeCandidateEntry = {
      crafted_text: string;
      brief: Record<string, any>;
      opportunityIndex: number; // maps back to opportunities[] index
      candidateVariantType?: string;
      candidateLocalScore?: number;
      candidateSelectionReason?: string;
      sourceKey: string; // for deduplication after judging
    };

    const candidates: JudgeCandidateEntry[] = [];
    for (let oppIdx = 0; oppIdx < opportunities.length; oppIdx++) {
      const opp = opportunities[oppIdx];
      const oppBrief = (opp as any)._brief;
      const brief = (oppBrief && oppBrief.recommended_angle) ? oppBrief
        : intelBriefs[(opp.source_text || '').slice(0, 100)] || {};
      const sourceKey = String((opp as any).source_text || (opp as any).text || '').slice(0, 100);

      // Phase 2G.3: Check for multi-candidate selection
      const selectedCandidates: CraftedCandidate[] | undefined = (opp as any)._selected_candidates;

      if (selectedCandidates && selectedCandidates.length > 0) {
        // Multi-candidate mode: add each selected candidate for judging
        // HARDEN: Filter null/undefined candidates and candidates without non-empty crafted_text
        let validCandidateCount = 0;
        let candidateMissingTextCount = 0;
        let candidateNullCount = 0;

        for (const cand of selectedCandidates) {
          // Guard: skip null/undefined candidates
          if (!cand || typeof cand !== 'object') {
            candidateNullCount++;
            continue;
          }
          // Guard: skip candidates without non-empty crafted_text
          if (!cand.crafted_text || typeof cand.crafted_text !== 'string' || !cand.crafted_text.trim()) {
            candidateMissingTextCount++;
            continue;
          }
          candidates.push({
            crafted_text: cand.crafted_text,
            brief,
            opportunityIndex: oppIdx,
            candidateVariantType: cand.variant_type,
            candidateLocalScore: cand._candidate_local_score,
            candidateSelectionReason: cand._candidate_selection_reason,
            sourceKey,
          });
          validCandidateCount++;
        }

        // If no valid selected candidates, fallback to opp.crafted_text
        if (validCandidateCount === 0) {
          if (opp.crafted_text && typeof opp.crafted_text === 'string' && opp.crafted_text.trim()) {
            candidates.push({
              crafted_text: opp.crafted_text,
              brief,
              opportunityIndex: oppIdx,
              sourceKey,
            });
          }
          // If no crafted text at all, mark opportunity as safely rejected below
        }
      } else {
        // Single-candidate mode (legacy): use the opportunity's crafted_text
        // HARDEN: Guard against undefined/empty crafted_text
        if (opp.crafted_text && typeof opp.crafted_text === 'string' && opp.crafted_text.trim()) {
          candidates.push({
            crafted_text: opp.crafted_text,
            brief,
            opportunityIndex: oppIdx,
            sourceKey,
          });
        }
        // If no crafted text at all, this opportunity will have no candidates for judging
        // and will be marked as safely rejected below
      }
    }

    // HARDEN: If no valid candidates, return early with diagnostics (don't crash)
    if (candidates.length === 0) {
      // Mark ALL opportunities as safely rejected with candidate_missing_crafted_text
      const rejectedOpportunities = opportunities.map(opp => ({
        ...opp,
        shield_passed: false,
        shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
        _candidate_generation_error: 'no_valid_crafted_text',
      }));

      return {
        ok: true,
        result: {
          judge_passed_count: 0,
          judge_failed_count: opportunities.length,
          judge_failure_reasons: { candidate_missing_crafted_text: opportunities.length },
          _opportunities: rejectedOpportunities,
          _judge_summary: null,
          // Phase 2G.3 Hotfix diagnostics
          multi_candidate_invalid_count: opportunities.length,
          multi_candidate_empty_selected_count: opportunities.length,
          candidate_validation_failed_count: 0,
          candidate_missing_text_count: 0,
          judge_result_missing_count: 0,
        }
      };
    }

    // Run judge on all candidates
    const { results, summary } = await judgeCraftedCandidates(candidates.map(c => ({
      crafted_text: c.crafted_text,
      brief: c.brief,
    })));

    // Phase 2G.3: Dedupe candidates from the SAME source/opportunity before applying results.
    // For opportunities with multiple candidates, keep only the best judged candidate.
    // HARDEN: Synthesize failed judge result if results[i] is missing
    const FAILED_JUDGE_RESULT: JudgeResult = {
      originality_score: 1,
      usefulness_score: 1,
      niche_fit_score: 1,
      evidence_safety_score: 1,
      clarity_score: 1,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      brief_alignment_score: 1,
      final_candidate_score: 1,
      passed: false,
      failure_reasons: ['judge_result_missing'],
    };

    // Track diagnostics
    let judgeResultMissingCount = 0;

    const candidatesWithJudgeResults: CandidateWithJudgeResult[] = candidates.map((c, i) => {
      const judgeResult: JudgeResult = results[i] || FAILED_JUDGE_RESULT;
      if (!results[i]) {
        judgeResultMissingCount++;
      }
      return {
        candidate: {
          variant_type: c.candidateVariantType || 'legacy',
          crafted_text: c.crafted_text,
          format: '',
          brief_alignment_score: 0,
          brief_alignment_notes: [],
          invented_personal_experience_flag: false,
          ignored_recommended_angle_flag: false,
          _candidate_local_score: c.candidateLocalScore,
          _candidate_selection_reason: c.candidateSelectionReason,
        },
        judgeResult: {
          passed: judgeResult.passed,
          final_candidate_score: judgeResult.final_candidate_score,
          originality_score: judgeResult.originality_score,
          brief_alignment_score: judgeResult.brief_alignment_score,
          evidence_safety_score: judgeResult.evidence_safety_score,
        },
        sourceKey: c.sourceKey,
        _candidateIndex: i, // explicit index for safe mapping (replaces indexOf)
      };
    });

    const dedupedCandidates = deduplicateJudgedCandidates(candidatesWithJudgeResults);

    // Build a map from sourceKey to the best candidate's judge result and metadata
    // HARDEN: Use explicit _candidateIndex instead of fragile indexOf(entry)
    const bestCandidateBySource = new Map<string, {
      judgeResult: JudgeResult;
      variantType?: string;
      localScore?: number;
      selectionReason?: string;
      candidateIndex: number; // index into original candidates[] array
      craftedText?: string; // best candidate's crafted_text for applying back to opportunity
    }>();
    for (const entry of dedupedCandidates) {
      const explicitIndex = (entry as any)._candidateIndex ?? candidatesWithJudgeResults.indexOf(entry);
      bestCandidateBySource.set(entry.sourceKey, {
        judgeResult: results[explicitIndex] || FAILED_JUDGE_RESULT,
        variantType: entry.candidate.variant_type,
        localScore: entry.candidate._candidate_local_score,
        selectionReason: entry.candidate._candidate_selection_reason,
        candidateIndex: explicitIndex,
        craftedText: entry.candidate.crafted_text || undefined,
      });
    }

    // Apply judge results to opportunities — judge-failed ones get shield_passed=false
    // HARDEN: Also apply best candidate's crafted_text back and handle missing candidates safely
    let candidateValidationFailedCount = 0;
    let candidateMissingTextCount = 0;

    const judgedOpportunities: OpportunityWithDiagnostics[] = opportunities.map((opp, i) => {
      const sourceKey = String((opp as any).source_text || (opp as any).text || '').slice(0, 100);
      const bestEntry = bestCandidateBySource.get(sourceKey);

      // Check if this opportunity had any candidates at all
      const oppCandidates = candidates.filter(c => c.opportunityIndex === i);
      if (oppCandidates.length === 0) {
        // No candidates for this opportunity — safely reject
        candidateValidationFailedCount++;
        return {
          ...opp,
          shield_passed: false,
          shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
          _candidate_generation_error: 'no_valid_crafted_text',
        };
      }

      // Find the judge result for the best candidate from this opportunity
      // If this opportunity had multiple candidates, only the best one's result is used
      let judgeResult: JudgeResult | undefined;
      let bestVariantType: string | undefined;
      let bestLocalScore: number | undefined;
      let bestSelectionReason: string | undefined;
      let bestCraftedText: string | undefined;

      if (bestEntry) {
        judgeResult = bestEntry.judgeResult;
        bestVariantType = bestEntry.variantType;
        bestLocalScore = bestEntry.localScore;
        bestSelectionReason = bestEntry.selectionReason;
        bestCraftedText = bestEntry.craftedText;
      } else {
        // Fallback: find the first candidate for this opportunity
        const candIdx = candidates.findIndex(c => c.opportunityIndex === i);
        judgeResult = candIdx >= 0 ? results[candIdx] : undefined;
      }

      if (!judgeResult) {
        // No judge result — safely reject
        candidateMissingTextCount++;
        return {
          ...opp,
          shield_passed: false,
          shield_issues: [...(opp.shield_issues || []), 'candidate_missing_crafted_text'],
          _candidate_generation_error: 'no_valid_crafted_text',
        };
      }

      // HARDEN: Apply best candidate's crafted_text back to opportunity.crafted_text
      // This ensures the opportunity carries the best variant's text into publish_gate
      const textToApply = bestCraftedText && bestCraftedText.trim()
        ? bestCraftedText
        : (opp.crafted_text || undefined);

      return {
        ...opp,
        // Apply best candidate's crafted_text (if different from current)
        ...(textToApply ? { crafted_text: textToApply, _selected_candidate_text_applied: !!bestCraftedText } : {}),
        _judge_result: {
          passed: judgeResult.passed,
          final_candidate_score: judgeResult.final_candidate_score,
          originality_score: judgeResult.originality_score,
          usefulness_score: judgeResult.usefulness_score,
          niche_fit_score: judgeResult.niche_fit_score,
          evidence_safety_score: judgeResult.evidence_safety_score,
          clarity_score: judgeResult.clarity_score,
          brief_alignment_score: judgeResult.brief_alignment_score,
          generic_bait_flag: judgeResult.generic_bait_flag,
          unsupported_claim_flag: judgeResult.unsupported_claim_flag,
          failure_reasons: judgeResult.failure_reasons,
        },
        // If judge fails, mark shield_passed=false so publish_gate rejects it
        ...(judgeResult.passed ? {} : {
          shield_passed: false,
          shield_issues: [...(opp.shield_issues || []), `judge_failed:${judgeResult.failure_reasons[0] || 'unknown'}`],
        }),
        // Phase 2G.3: Preserve multi-candidate metadata after judge dedup
        ...(bestVariantType ? { _candidate_variant_type: bestVariantType } : {}),
        ...(bestLocalScore !== undefined ? { _candidate_local_score: bestLocalScore } : {}),
        ...(bestSelectionReason ? { _candidate_selection_reason: bestSelectionReason } : {}),
      };
    });

    // ═══ Phase 2F: Near-Pass Polish ═══
    // For failed candidates that are close to passing, attempt ONE targeted polish.
    // This runs AFTER the first judge pass and BEFORE returning results.
    const polishOutcomes: PolishOutcome[] = [];
    let polishAttempted = 0;
    // Phase M1: Track polish memory usage
    let polishMemoryUsedCount = 0;
    // Track eligible indices for micro-repair later (Phase 2G.2)
    let polishEligibleIndices: number[] = [];

    if (summary.judge_failed_count > 0) {
      // Phase 2G.3 Hotfix #2: Iterate deduped judgedOpportunities, NOT raw results[]
      // After multi-candidate judging + dedupe, results.length can be > judgedOpportunities.length
      // (e.g. 2 opportunities × 2 candidates = 4 results, but only 2 judgedOpportunities).
      // Using raw results[i] / candidates[i] / judgedOpportunities[i] crashes when i >= judgedOpportunities.length.
      // Instead, iterate judgedOpportunities and use each opportunity's _judge_result (already set after dedupe).
      const nearPassIndices: number[] = [];
      for (let i = 0; i < judgedOpportunities.length; i++) {
        const opp = judgedOpportunities[i];
        const judgeResult = (opp as any)?._judge_result;
        if (!judgeResult || judgeResult.passed) continue;

        const craftedText = opp.crafted_text || '';
        // Find first candidate for this opportunity for brief access
        const oppCandidate = candidates.find(c => c.opportunityIndex === i);
        const brief = oppCandidate?.brief || (opp as any)?._brief || {};

        if (isNearPass(judgeResult, craftedText, brief)) {
          nearPassIndices.push(i);
        }
      }

      // Limit to MAX_POLISH_CANDIDATES_PER_RUN, prioritized by score (highest first)
      nearPassIndices.sort((a, b) => (judgedOpportunities[a] as any)?._judge_result?.final_candidate_score - (judgedOpportunities[b] as any)?._judge_result?.final_candidate_score);
      const eligibleIndices = nearPassIndices.slice(0, MAX_POLISH_CANDIDATES_PER_RUN);
      polishEligibleIndices = eligibleIndices;

      for (const idx of eligibleIndices) {
        const opp = judgedOpportunities[idx];
        const judgeResult = (opp as any)?._judge_result;

        // Guard: no aligned judge result — mark and skip (do not crash)
        if (!judgeResult) {
          judgedOpportunities[idx] = {
            ...judgedOpportunities[idx],
            shield_passed: false,
            shield_issues: [...(judgedOpportunities[idx].shield_issues || []), 'judge_result_missing'],
            _judge_result_missing: true,
          };
          continue;
        }

        const oppCandidate = candidates.find(c => c.opportunityIndex === idx);
        const brief = oppCandidate?.brief || (opp as any)?._brief || {};
        const craftedText = opp.crafted_text || '';

        const polishInput: PolishInput = {
          crafted_text: craftedText,
          brief: {
            source_summary: brief.source_summary || brief.source_summary,
            recommended_angle: brief.recommended_angle || brief.angle,
            why_it_matters: brief.why_it_matters,
            required_context: brief.required_context,
            do_not_claim: brief.do_not_claim,
          },
          judge_failure_reasons: judgeResult.failure_reasons,
          judge_scores: {
            final_candidate_score: judgeResult.final_candidate_score,
            originality_score: judgeResult.originality_score,
            usefulness_score: judgeResult.usefulness_score,
            brief_alignment_score: judgeResult.brief_alignment_score,
            evidence_safety_score: judgeResult.evidence_safety_score,
            clarity_score: judgeResult.clarity_score,
          },
          source_text_preview: (opp.source_text || '').slice(0, 200),
          source_author: opp.source_author || '',
          // Phase S1.2 follow-up: Pass actual policy for hard cap enforcement in polish
          post_length_policy: judgePolicy,
        };

        // Phase M1: Retrieve structured memory for polish
        try {
          const memory = await getRelevantStructuredMemory({
            source_author: opp.source_author || '',
            source_text: String(opp.source_text || '').slice(0, 400),
            recommended_angle: brief.recommended_angle || brief.angle,
            candidate_text: craftedText,
            task_type: 'polish',
            failure_reasons: judgeResult.failure_reasons || [],
          });
          const memoryStr = buildPolishMemorySection(memory);
          if (memoryStr) {
            polishInput.learning_memory_section = memoryStr;
            polishMemoryUsedCount++;
          }
        } catch (memErr: any) {
          console.warn(`[pipeline-worker] structured memory retrieval for polish failed: ${(memErr?.message || 'unknown').slice(0, 200)}`);
        }

        // Phase 2G: If originality failure, fetch originality context for the polish
        const isOriginalityFailure = judgeResult.originality_score < 7.8 ||
          (judgeResult.failure_reasons || []).some((r: string) => r.includes('originality') || r.includes('missing_originality'));
        if (isOriginalityFailure) {
          try {
            const originalityCtx = await getOriginalityContext({
              source_text: String(opp.source_text || (opp as any).text || ''),
              source_author: opp.source_author,
              brief: brief,
              current_text: craftedText,
              failure_reasons: judgeResult.failure_reasons || [],
              max_items: 6,
            });
            polishInput.originality_context = originalityCtx;
          } catch (origCtxErr: any) {
            console.warn(`[pipeline-worker] originality context fetch for polish failed: ${(origCtxErr?.message || 'unknown').slice(0, 200)}`);
          }
        }

        try {
          const outcome = await attemptNearPassPolish(polishInput);
          polishOutcomes.push(outcome);
          polishAttempted++;

          if (outcome.applied && outcome.polished_text) {
            // Apply polished text to the opportunity
            const polishedOpp = judgedOpportunities[idx];

            if (outcome.passed) {
              // Polish succeeded — re-judge passed! Replace crafted_text, selectively resolve shield issues.
              // DO NOT blindly set shield_passed=true — only remove issues that the polish actually resolved.
              // - Remove old judge_failed:* issues (the re-judge passed)
              // - Optionally remove brief_alignment_failed only if after_judge.brief_alignment_score >= 7.5
              // - Optionally remove missing_originality only if after_judge.originality_score >= 7.8
              // - Keep all other shield issues (numeric, non-judge, etc.)
              const afterJudgeScores = outcome.after_judge;
              const remainingShieldIssues = (polishedOpp.shield_issues || []).filter((issue: string) => {
                // Remove judge_failed:* — the re-judge passed, so judge failure is resolved
                if (issue.startsWith('judge_failed:')) return false;
                // Remove brief_alignment_failed only if the re-judge confirms brief_alignment_score >= 7.5
                if (issue === 'brief_alignment_failed' && (afterJudgeScores?.brief_alignment_score ?? 0) >= 7.5) return false;
                // Remove missing_originality only if the re-judge confirms originality_score >= 7.8
                if (issue === 'missing_originality' && (afterJudgeScores?.originality_score ?? 0) >= 7.8) return false;
                // Keep all other issues (numeric, non-judge, etc.)
                return true;
              });

              judgedOpportunities[idx] = {
                ...polishedOpp,
                crafted_text: outcome.polished_text,
                shield_passed: remainingShieldIssues.length === 0,
                shield_issues: remainingShieldIssues,
                _judge_result: {
                  ...(polishedOpp as any)._judge_result,
                  passed: true,
                  final_candidate_score: outcome.after_judge?.final_candidate_score || judgeResult.final_candidate_score,
                  originality_score: outcome.after_judge?.originality_score || judgeResult.originality_score,
                  usefulness_score: outcome.after_judge?.usefulness_score || judgeResult.usefulness_score,
                  niche_fit_score: outcome.after_judge?.niche_fit_score || judgeResult.niche_fit_score,
                  evidence_safety_score: outcome.after_judge?.evidence_safety_score || judgeResult.evidence_safety_score,
                  clarity_score: outcome.after_judge?.clarity_score || judgeResult.clarity_score,
                  brief_alignment_score: outcome.after_judge?.brief_alignment_score || judgeResult.brief_alignment_score,
                  generic_bait_flag: outcome.after_judge?.generic_bait_flag || false,
                  unsupported_claim_flag: outcome.after_judge?.unsupported_claim_flag || false,
                  failure_reasons: outcome.after_judge?.failure_reasons || [],
                },
                _near_pass_polish_applied: true,
                _near_pass_polish_before_judge: outcome.before_judge,
                _near_pass_polish_after_judge: outcome.after_judge,
              };

              console.log(`[pipeline-worker] near_pass_polish: candidate ${idx} PASSED after polish. Before: ${outcome.before_judge?.final_candidate_score}, After: ${outcome.after_judge?.final_candidate_score}`);
            } else {
              // Polish applied but still failing — keep polished text only if it improved
              // IMPORTANT (Phase 2F.1): Update _judge_result and shield_issues to reflect
              // the after_judge state, NOT the stale pre-polish state.
              // Without this, diagnostics show the old score (e.g. 7) even though
              // the polished text now scores 8, and shield_issues show stale reasons.
              const afterJudge = outcome.after_judge;
              const staleShieldIssues = polishedOpp.shield_issues || [];

              // Remove stale judge_failed:* issues (they reflect the pre-polish judge, not the re-judge)
              const issuesWithoutStaleJudge = staleShieldIssues.filter((issue: string) =>
                !issue.startsWith('judge_failed:')
              );

              // Add new judge_failed reason from the re-judge (if any failure reasons)
              const newJudgeFailedReason = (afterJudge?.failure_reasons?.length ?? 0) > 0
                ? `judge_failed:${afterJudge!.failure_reasons[0]}`
                : null;

              // Rebuild shield_issues: stale judge_failed removed, new one added
              let rebuiltShieldIssues = [...issuesWithoutStaleJudge];
              if (newJudgeFailedReason) {
                rebuiltShieldIssues.push(newJudgeFailedReason);
              }

              // Conditionally remove missing_originality if after_judge.originality_score >= 7.8
              if (afterJudge && afterJudge.originality_score >= 7.8) {
                rebuiltShieldIssues = rebuiltShieldIssues.filter((issue: string) => issue !== 'missing_originality');
              }

              // Conditionally remove brief_alignment_failed if after_judge.brief_alignment_score >= 7.5
              if (afterJudge && afterJudge.brief_alignment_score >= 7.5) {
                rebuiltShieldIssues = rebuiltShieldIssues.filter((issue: string) => issue !== 'brief_alignment_failed');
              }

              judgedOpportunities[idx] = {
                ...polishedOpp,
                crafted_text: outcome.polished_text,
                // Still shield_passed=false since re-judge didn't pass
                // (unless remainingShieldIssues.length === 0 AND after_judge.passed is true)
                shield_passed: rebuiltShieldIssues.length === 0 && (afterJudge?.passed ?? false),
                shield_issues: rebuiltShieldIssues,
                _judge_result: {
                  ...(polishedOpp as any)._judge_result,
                  passed: afterJudge?.passed ?? false,
                  final_candidate_score: afterJudge?.final_candidate_score ?? (polishedOpp as any)._judge_result?.final_candidate_score,
                  originality_score: afterJudge?.originality_score ?? (polishedOpp as any)._judge_result?.originality_score,
                  usefulness_score: afterJudge?.usefulness_score ?? (polishedOpp as any)._judge_result?.usefulness_score,
                  niche_fit_score: afterJudge?.niche_fit_score ?? (polishedOpp as any)._judge_result?.niche_fit_score,
                  evidence_safety_score: afterJudge?.evidence_safety_score ?? (polishedOpp as any)._judge_result?.evidence_safety_score,
                  clarity_score: afterJudge?.clarity_score ?? (polishedOpp as any)._judge_result?.clarity_score,
                  brief_alignment_score: afterJudge?.brief_alignment_score ?? (polishedOpp as any)._judge_result?.brief_alignment_score,
                  generic_bait_flag: afterJudge?.generic_bait_flag ?? false,
                  unsupported_claim_flag: afterJudge?.unsupported_claim_flag ?? false,
                  failure_reasons: afterJudge?.failure_reasons ?? [],
                },
                _near_pass_polish_applied: true,
                _near_pass_polish_before_judge: outcome.before_judge,
                _near_pass_polish_after_judge: outcome.after_judge,
              };

              console.log(`[pipeline-worker] near_pass_polish: candidate ${idx} improved but still failing. Before: ${outcome.before_judge?.final_candidate_score}, After: ${outcome.after_judge?.final_candidate_score}. Shield issues: ${JSON.stringify(rebuiltShieldIssues)}`);
            }
          } else if (outcome.attempted && outcome.polish_failed_reason) {
            // Polish attempted but failed validation
            judgedOpportunities[idx] = {
              ...judgedOpportunities[idx],
              _near_pass_polish_failed_reason: outcome.polish_failed_reason,
            };

            console.log(`[pipeline-worker] near_pass_polish: candidate ${idx} polish failed: ${outcome.polish_failed_reason}`);
          }
        } catch (polishErr: any) {
          console.warn(`[pipeline-worker] near_pass_polish error for candidate ${idx}: ${(polishErr?.message || 'unknown').slice(0, 200)}`);
          polishOutcomes.push({
            attempted: true,
            applied: false,
            passed: false,
            polished_text: null,
            before_judge: null,
            after_judge: null,
            polish_failed_reason: `polish_exception:${(polishErr?.message || 'unknown').slice(0, 50)}`,
            what_changed: null,
            targeted_failures: [],
          });
        }
      }
    }

    // Compute near-pass diagnostics
    const nearPassDiagnostics = computeNearPassDiagnostics(polishOutcomes);

    // ═══ Phase 2G.2: Brief-Locked Micro-Repair ═══
    // For candidates that went through near-pass polish, improved significantly,
    // but still fail ONLY on brief_alignment, attempt one micro-repair.
    const microRepairIndices: number[] = [];
    for (let i = 0; i < polishOutcomes.length; i++) {
      const outcome = polishOutcomes[i];
      // Only consider outcomes that were applied and have after_judge
      if (!outcome.applied || !outcome.after_judge) continue;
      // The candidate must still be failing
      if (outcome.after_judge.passed) continue;

      // Find the index in judgedOpportunities that corresponds to this polish outcome
      // The polishOutcomes are in the same order as polishEligibleIndices
      const eligibleIdx = polishEligibleIndices.length > i
        ? polishEligibleIndices[i]
        : -1;
      if (eligibleIdx < 0) continue;

      // Check if micro-repair is eligible
      const afterJudge = outcome.after_judge;
      // Phase 2G.3 Hotfix #2: eligibleIdx is a judgedOpportunities index, not a candidates[] index
      const oppCandidateForMicro = candidates.find(c => c.opportunityIndex === eligibleIdx);
      const brief = oppCandidateForMicro?.brief || {};
      const currentText = outcome.polished_text || judgedOpportunities[eligibleIdx]?.crafted_text || '';

      // isMicroRepairEligible imported from near-pass-polish
      if (!isMicroRepairEligible(afterJudge)) continue;

      microRepairIndices.push(i);
    }

    for (const polishIdx of microRepairIndices) {
      const outcome = polishOutcomes[polishIdx];
      const eligibleIdx = polishEligibleIndices.length > polishIdx
        ? polishEligibleIndices[polishIdx]
        : -1;
      if (eligibleIdx < 0) continue;

      // Phase 2G.3 Hotfix #2: eligibleIdx is a judgedOpportunities index, not a candidates[] index
      const oppCandidateForMicro = candidates.find(c => c.opportunityIndex === eligibleIdx);
      const brief = oppCandidateForMicro?.brief || {};
      const currentText = outcome.polished_text || judgedOpportunities[eligibleIdx]?.crafted_text || '';
      const afterJudge = outcome.after_judge!;

      try {
        const microOutcome = await attemptBriefLockedMicroRepair(currentText, brief, afterJudge);
        polishOutcomes[polishIdx] = {
          ...outcome,
          _brief_locked_polish_attempted: microOutcome._brief_locked_polish_attempted,
          _brief_locked_polish_applied: microOutcome._brief_locked_polish_applied,
          _brief_locked_polish_before_judge: microOutcome._brief_locked_polish_before_judge,
          _brief_locked_polish_after_judge: microOutcome._brief_locked_polish_after_judge,
          _brief_locked_polish_reason: microOutcome._brief_locked_polish_reason,
        };

        if (microOutcome.applied && microOutcome.polished_text) {
          const polishedOpp = judgedOpportunities[eligibleIdx];

          if (microOutcome.passed) {
            // Micro-repair passed! Apply it
            const microAfterJudge = microOutcome.after_judge;
            const remainingShieldIssues = (polishedOpp.shield_issues || []).filter((issue: string) => {
              if (issue.startsWith('judge_failed:')) return false;
              if (issue === 'brief_alignment_failed' && (microAfterJudge?.brief_alignment_score ?? 0) >= 7.5) return false;
              if (issue === 'missing_originality' && (microAfterJudge?.originality_score ?? 0) >= 7.8) return false;
              return true;
            });

            judgedOpportunities[eligibleIdx] = {
              ...polishedOpp,
              crafted_text: microOutcome.polished_text,
              shield_passed: remainingShieldIssues.length === 0,
              shield_issues: remainingShieldIssues,
              _judge_result: {
                ...(polishedOpp as any)._judge_result,
                passed: true,
                final_candidate_score: microAfterJudge?.final_candidate_score || afterJudge.final_candidate_score,
                originality_score: microAfterJudge?.originality_score || afterJudge.originality_score,
                usefulness_score: microAfterJudge?.usefulness_score || afterJudge.usefulness_score,
                niche_fit_score: microAfterJudge?.niche_fit_score || afterJudge.niche_fit_score,
                evidence_safety_score: microAfterJudge?.evidence_safety_score || afterJudge.evidence_safety_score,
                clarity_score: microAfterJudge?.clarity_score || afterJudge.clarity_score,
                brief_alignment_score: microAfterJudge?.brief_alignment_score || afterJudge.brief_alignment_score,
                generic_bait_flag: microAfterJudge?.generic_bait_flag || false,
                unsupported_claim_flag: microAfterJudge?.unsupported_claim_flag || false,
                failure_reasons: microAfterJudge?.failure_reasons || [],
              },
              _near_pass_polish_applied: true,
              _near_pass_polish_before_judge: outcome.before_judge,
              _near_pass_polish_after_judge: microAfterJudge,
              _brief_locked_polish_applied: true,
              _brief_locked_polish_before_judge: afterJudge,
              _brief_locked_polish_after_judge: microAfterJudge,
            };

            console.log(`[pipeline-worker] brief_locked_micro_repair: candidate ${eligibleIdx} PASSED after micro-repair. Brief alignment: ${afterJudge.brief_alignment_score} → ${microAfterJudge?.brief_alignment_score}`);
          } else {
            // Micro-repair improved but still not passing
            const microAfterJudge = microOutcome.after_judge;
            const currentShieldIssues = polishedOpp.shield_issues || [];
            const rebuiltIssues = currentShieldIssues.filter((issue: string) =>
              !issue.startsWith('judge_failed:')
            );
            const newFailureReasons = microAfterJudge?.failure_reasons || [];
            if (newFailureReasons.length > 0) {
              rebuiltIssues.push(`judge_failed:${newFailureReasons[0]}`);
            }

            // Conditionally remove brief_alignment_failed if score improved enough
            if (microAfterJudge && microAfterJudge.brief_alignment_score >= 7.5) {
              const idx = rebuiltIssues.indexOf('brief_alignment_failed');
              if (idx >= 0) rebuiltIssues.splice(idx, 1);
            }

            judgedOpportunities[eligibleIdx] = {
              ...polishedOpp,
              crafted_text: microOutcome.polished_text,
              shield_passed: rebuiltIssues.length === 0 && (microAfterJudge?.passed ?? false),
              shield_issues: rebuiltIssues,
              _judge_result: {
                ...(polishedOpp as any)._judge_result,
                passed: microAfterJudge?.passed ?? false,
                final_candidate_score: microAfterJudge?.final_candidate_score ?? afterJudge.final_candidate_score,
                originality_score: microAfterJudge?.originality_score ?? afterJudge.originality_score,
                usefulness_score: microAfterJudge?.usefulness_score ?? afterJudge.usefulness_score,
                niche_fit_score: microAfterJudge?.niche_fit_score ?? afterJudge.niche_fit_score,
                evidence_safety_score: microAfterJudge?.evidence_safety_score ?? afterJudge.evidence_safety_score,
                clarity_score: microAfterJudge?.clarity_score ?? afterJudge.clarity_score,
                brief_alignment_score: microAfterJudge?.brief_alignment_score ?? afterJudge.brief_alignment_score,
                generic_bait_flag: microAfterJudge?.generic_bait_flag ?? false,
                unsupported_claim_flag: microAfterJudge?.unsupported_claim_flag ?? false,
                failure_reasons: newFailureReasons,
              },
              _near_pass_polish_applied: true,
              _near_pass_polish_before_judge: outcome.before_judge,
              _near_pass_polish_after_judge: microAfterJudge,
              _brief_locked_polish_applied: true,
              _brief_locked_polish_before_judge: afterJudge,
              _brief_locked_polish_after_judge: microAfterJudge,
            };

            console.log(`[pipeline-worker] brief_locked_micro_repair: candidate ${eligibleIdx} improved but still failing. Brief alignment: ${afterJudge.brief_alignment_score} → ${microAfterJudge?.brief_alignment_score}`);
          }
        }
      } catch (microErr: any) {
        console.warn(`[pipeline-worker] brief_locked_micro_repair error for candidate ${eligibleIdx}: ${(microErr?.message || 'unknown').slice(0, 200)}`);
      }
    }

    // Recompute near-pass diagnostics (including micro-repair outcomes)
    const nearPassDiagnosticsFinal = computeNearPassDiagnostics(polishOutcomes);

    // Recompute pass/fail counts after polish (some may have flipped)
    const finalPassedCount = judgedOpportunities.filter(o => o.shield_passed !== false).length;
    const finalFailedCount = judgedOpportunities.filter(o => o.shield_passed === false).length;

    // Log summary
    console.log(`[pipeline-worker] opportunity_judge: ${finalPassedCount} passed, ${finalFailedCount} failed (after near-pass polish + micro-repair). Near-pass: ${nearPassDiagnosticsFinal.near_pass_candidates_count} eligible, ${nearPassDiagnosticsFinal.near_pass_polish_attempted_count} attempted, ${nearPassDiagnosticsFinal.near_pass_polish_passed_count} rescued. Brief-locked: ${nearPassDiagnosticsFinal.brief_locked_polish_attempted_count} attempted, ${nearPassDiagnosticsFinal.brief_locked_polish_applied_count} applied, ${nearPassDiagnosticsFinal.brief_locked_polish_passed_count} rescued. Avg final_candidate_score: ${summary.avg_final_candidate_score}`);

    return {
      ok: true,
      result: {
        judge_passed_count: finalPassedCount,
        judge_failed_count: finalFailedCount,
        judge_failure_reasons: summary.judge_failure_reasons,
        avg_final_candidate_score: summary.avg_final_candidate_score,
        avg_originality_score: summary.avg_originality_score,
        _opportunities: judgedOpportunities,
        _judge_summary: summary,
        // Phase 2F: Near-pass diagnostics
        near_pass_candidates_count: nearPassDiagnosticsFinal.near_pass_candidates_count,
        near_pass_polish_attempted_count: nearPassDiagnosticsFinal.near_pass_polish_attempted_count,
        near_pass_polish_applied_count: nearPassDiagnosticsFinal.near_pass_polish_applied_count,
        near_pass_polish_passed_count: nearPassDiagnosticsFinal.near_pass_polish_passed_count,
        near_pass_polish_failed_count: nearPassDiagnosticsFinal.near_pass_polish_failed_count,
        near_pass_polish_failure_reasons: nearPassDiagnosticsFinal.near_pass_polish_failure_reasons,
        average_score_before_polish: nearPassDiagnosticsFinal.average_score_before_polish,
        average_score_after_polish: nearPassDiagnosticsFinal.average_score_after_polish,
        // Phase 2G.2: Brief-locked polish diagnostics
        brief_locked_polish_attempted_count: nearPassDiagnosticsFinal.brief_locked_polish_attempted_count,
        brief_locked_polish_applied_count: nearPassDiagnosticsFinal.brief_locked_polish_applied_count,
        brief_locked_polish_passed_count: nearPassDiagnosticsFinal.brief_locked_polish_passed_count,
        // Phase 2G.3: Multi-candidate judge diagnostics
        multi_candidate_variants_judged: candidates.length,
        multi_candidate_variants_generated: candidates.filter(c => c.candidateVariantType).map(c => c.candidateVariantType!),
        // Phase 2G.3 Hotfix: Candidate validation diagnostics
        candidate_validation_failed_count: candidateValidationFailedCount,
        candidate_missing_text_count: candidateMissingTextCount,
        judge_result_missing_count: judgeResultMissingCount,
        multi_candidate_invalid_count: judgedOpportunities.filter(o => (o as any)._candidate_generation_error).length,
        multi_candidate_empty_selected_count: judgedOpportunities.filter(o => (o as any)._candidate_generation_error === 'no_valid_crafted_text').length,
        // Phase 2G.3 Hotfix #2: Raw vs deduped counts for clarity
        raw_candidate_judged_count: results.length,
        deduped_opportunity_judged_count: judgedOpportunities.length,
        // Phase M1: Structured memory diagnostics (polish)
        polish_memory_used_count: polishMemoryUsedCount,
        // Phase S1.2: Post length policy diagnostics (opportunity_judge)
        candidate_over_limit_count: judgedOpportunities.filter(o => (o.crafted_text || '').length > judgePolicy.hard_limit_chars).length,
        polish_over_limit_count: polishOutcomes.filter(o => o.polish_failed_reason === 'polished_text_over_hard_limit').length,
        polish_shorten_attempted_count: polishOutcomes.filter(o => o._shorten_attempted).length,
        polish_shorten_success_count: polishOutcomes.filter(o => o._shorten_attempted && o._shorten_applied).length,
        // Phase S1.2 follow-up: Actual policy fields for diagnostics
        post_length_policy_hard_limit_chars: judgePolicy.hard_limit_chars,
        post_length_policy_target_chars: judgePolicy.target_chars,
        post_length_policy_allow_longform: judgePolicy.allow_longform,
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: `opportunity_judge failed: ${err.message}` };
  }
}

async function processPublishGate(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;

    // Get opportunity_judge results (Phase 2D: judge filters before publish_gate)
    // FALLBACK RULE: Only fallback if the newer upstream task type doesn't exist at all.
    // If judge exists and returned empty _opportunities, that's intentional — zero pass through.
    const { data: judgeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'opportunity_judge')
      .eq('status', 'completed')
      .maybeSingle();

    let opportunities;
    if (judgeTask) {
      // Judge task exists and completed — use its _opportunities, even if empty
      opportunities = judgeTask.result?._opportunities || [];
    } else {
      // No judge task at all — pre-Phase 2D run. Fallback chain.
      const { data: qualityTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'quality_enhance')
        .eq('status', 'completed')
        .maybeSingle();
      if (qualityTask) {
        opportunities = qualityTask.result?._opportunities || [];
      } else {
        const { data: enrichTask } = await supabase
          .from('pipeline_tasks')
          .select('result')
          .eq('run_id', runId)
          .eq('task_type', 'enrich_opportunities')
          .eq('status', 'completed')
          .maybeSingle();
        opportunities = enrichTask?.result?._opportunities || [];
      }
    }

    const { filterPublishableOpportunities } = await import('./content-policy');

    // Phase S1.2: Load post_length_policy from load_account_state results
    let publishGatePolicy = getDefaultPostLengthPolicy();
    try {
      const { data: accountTask } = await supabase
        .from('pipeline_tasks')
        .select('result')
        .eq('run_id', runId)
        .eq('task_type', 'load_account_state')
        .eq('status', 'completed')
        .maybeSingle();
      if (accountTask?.result?.post_length_policy) {
        publishGatePolicy = normalizePostLengthPolicy(accountTask.result.post_length_policy);
      }
    } catch (policyErr: any) {
      console.warn(`[pipeline-worker] publish_gate: failed to load post_length_policy, using defaults: ${(policyErr?.message || 'unknown').slice(0, 200)}`);
    }

    // Phase S1.1: Enable freshness gate with default settings
    // Phase S1.2: Pass hard limit from post_length_policy
    const publishGate = filterPublishableOpportunities(opportunities, {
      enableFreshnessGate: true,
      hardLimitChars: publishGatePolicy.hard_limit_chars,
    });

    // Phase 2A: Persist rejections to rejection_ledger
    if (publishGate.rejected.length > 0) {
      try {
        await recordPublishGateRejections(publishGate.rejected, {
          run_id: runId,
          task_id: task.id,
          opportunities
        });
      } catch (rejErr: any) {
        console.error('[pipeline-worker] publish_gate rejection ledger error:', rejErr.message);
        // Non-blocking: don't fail the task if rejection persistence fails
      }
    }

    // Phase S1.1: Include freshness diagnostics in result
    const freshnessStats = publishGate.freshnessStats || {};
    const freshnessRejectionReasons = publishGate.rejected
      .filter((r: any) =>
        r.reason === 'missing_source_created_at_for_reply' ||
        r.reason === 'source_too_old_for_reply' ||
        r.reason === 'missing_source_created_at_for_quote' ||
        r.reason === 'source_too_old_for_quote'
      )
      .map((r: any) => r.reason);

    return {
      ok: true,
      result: {
        accepted: publishGate.accepted.length,
        rejected: publishGate.rejected.length,
        reasons: publishGate.rejected.slice(0, 5).map((r: any) => r.reason),
        _accepted: publishGate.accepted,
        _rejected: publishGate.rejected,
        // Phase S1.1: Freshness gate diagnostics
        _freshness_stats: freshnessStats,
        _freshness_rejection_reasons: freshnessRejectionReasons,
        // Phase S1.2: Post length policy diagnostics
        post_length_policy_hard_limit_chars: publishGatePolicy.hard_limit_chars,
        post_length_policy_target_chars: publishGatePolicy.target_chars,
        post_length_policy_allow_longform: publishGatePolicy.allow_longform,
        publish_gate_length_rejected_count: publishGate.rejected.filter((r: any) => r.reason === 'post_over_hard_limit').length,
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ decision ═══

async function processDecision(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get publish_gate results
    const { data: gateTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'publish_gate')
      .eq('status', 'completed')
      .maybeSingle();

    const accepted = gateTask?.result?._accepted || [];

    // Get load_account_state results for follower count
    const { data: accountTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'load_account_state')
      .eq('status', 'completed')
      .maybeSingle();

    const followers = accountTask?.result?.followers || 0;

    const { decideTelegramOpportunities, stageFromFollowerCount } = await import('./decision-engine');
    const stage = stageFromFollowerCount(followers);
    const decision = decideTelegramOpportunities(accepted, stage);

    // Attach metadata
    (decision as any)._publishGate = {
      accepted: gateTask?.result?.accepted ?? 0,
      rejected: gateTask?.result?.rejected ?? 0,
      reasons: gateTask?.result?.reasons || []
    };

    // Get enrich results for rule performance
    const { data: enrichTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'enrich_opportunities')
      .eq('status', 'completed')
      .maybeSingle();

    (decision as any)._rulePerformance = enrichTask?.result?._rule_performance || {
      enriched_opportunities: 0, avg_weight: 0, boosted_count: 0, penalized_count: 0
    };

    return {
      ok: true,
      result: {
        selected: decision.selected.length,
        held: decision.held.length,
        min_final_score: decision.budget.min_final_score,
        stage: decision.stage,
        _decision: decision,
        followers
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ persist_decision ═══

async function processPersistDecision(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get decision results
    const { data: decisionTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'decision')
      .eq('status', 'completed')
      .maybeSingle();

    const decision = decisionTask?.result?._decision;
    if (!decision) {
      return { ok: false, result: {}, error: 'No decision result found' };
    }

    // Get merge results for scan data
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    // Get gate results
    const { data: gateTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'publish_gate')
      .eq('status', 'completed')
      .maybeSingle();

    const { shortText } = await import('./telegram');

    // Insert into decision_runs
    let decisionRunId: string | null = null;
    try {
      const { data: insertedRun } = await supabase.from('decision_runs').insert({
        account_handle: username,
        account_stage: decision.stage,
        raw_opportunities: mergeTask?.result?.raw_opportunities || 0,
        selected_count: decision.selected.length,
        held_count: decision.held.length,
        budget: { ...decision.budget, publish_gate: (decision as any)._publishGate },
        selected_payload: decision.selected.slice(0, 5).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          source_author: o.source_author,
          crafted_text: shortText(o.crafted_text || '', 280),
          brain_rules_used: (o.brain_rules_used || []).slice(0, 20),
          shield_passed: o.shield_passed ?? null,
          reasons: o.decision_score?.reasons || []
        })),
        held_summary: decision.held.slice(0, 10).map((o: any) => ({
          type: o.type,
          score: o.decision_score?.final_score,
          source_tweet_url: o.source_tweet_url,
          rejection_reasons: o.decision_score?.rejection_reasons || []
        })),
        run_source: task.payload.source || 'queue_worker'
      }).select('id').single();
      decisionRunId = insertedRun?.id || null;
    } catch (dbErr: any) {
      console.error('[pipeline-worker] persist_decision DB error:', dbErr.message);
    }

    // Log daily checkin
    try {
      await supabase.from('daily_checkins').upsert({
        checkin_date: new Date().toISOString().slice(0, 10),
        execution_mode: 'v7_queue_worker',
        account_checked: true,
        tweets_planned: decision.selected.length,
        creator_posts_analyzed: mergeTask?.result?.tweets_analyzed || 0,
        notes: `v7 queue: raw ${mergeTask?.result?.raw_opportunities || 0}, gate_ok ${gateTask?.result?.accepted || 0}, selected ${decision.selected.length}, held ${decision.held.length}, stage ${decision.stage}`
      }, { onConflict: 'checkin_date' });
    } catch {}

    return {
      ok: true,
      result: {
        decision_run_id: decisionRunId,
        selected_count: decision.selected.length,
        held_count: decision.held.length,
        _decision: decision
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ telegram_delivery ═══

async function processTelegramDelivery(task: PipelineTaskRow): Promise<TaskResult> {
  try {
    const supabase = supabaseAdmin();
    const notifyTelegram = task.payload.notify_telegram !== false;

    if (!notifyTelegram) {
      return { ok: true, result: { delivered: false, reason: 'notify_telegram=false' } };
    }

    const runId = task.run_id;
    const username = task.payload.username || optionalEnv('X_USERNAME', '30piq');

    // Get persist_decision results
    const { data: persistTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'persist_decision')
      .eq('status', 'completed')
      .maybeSingle();

    const decision = persistTask?.result?._decision;
    if (!decision) {
      return { ok: false, result: {}, error: 'No decision result found for Telegram delivery' };
    }

    // Get merge results for scan data
    const { data: mergeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'merge_scan_results')
      .eq('status', 'completed')
      .maybeSingle();

    // Bug #2 fix: Fetch opportunity_intelligence result for Phase 2D diagnostics
    const { data: intelTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'opportunity_intelligence')
      .eq('status', 'completed')
      .maybeSingle();

    // Bug #2 fix: Fetch opportunity_judge result for Phase 2D diagnostics
    const { data: judgeTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'opportunity_judge')
      .eq('status', 'completed')
      .maybeSingle();

    // Get account state
    const { data: accountTask } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'load_account_state')
      .eq('status', 'completed')
      .maybeSingle();

    const followers = accountTask?.result?.followers || 0;

    // Build a scan-like result for the delivery function
    const scanResult = {
      actual_accounts_scanned: mergeTask?.result?.accounts_scanned || 0,
      accounts_scanned: mergeTask?.result?.accounts_scanned || 0,
      manual_tweets_loaded: 0,
      tweets_analyzed: mergeTask?.result?.tweets_analyzed || 0,
      viral_tweets_found: mergeTask?.result?.viral_found || 0,
      opportunities: mergeTask?.result?._opportunities || [],
      brain_updates: mergeTask?.result?.brain_updates || { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
      media_downloaded: mergeTask?.result?.media_downloaded || 0,
      debug_log: []
    };

    // Bug #2 fix: Attach Phase 2D diagnostics to decision for Telegram reporting
    (decision as any)._intelligenceDiagnostics = intelTask?.result ? {
      raw_opportunity_count: intelTask.result.raw_opportunity_count ?? 0,
      intelligence_evaluated_count: intelTask.result.intelligence_evaluated_count ?? 0,
      intelligence_selected_count: intelTask.result.intelligence_selected_count ?? 0,
      intelligence_rejected_count: intelTask.result.intelligence_rejected_count ?? 0,
      top_rejection_reasons: intelTask.result.top_rejection_reasons ?? {},
    } : null;

    // Phase 2E.1: Attach discovery summary for Telegram
    const tweetsFetched = mergeTask?.result?.tweets_fetched_total ?? mergeTask?.result?.tweets_analyzed ?? 0;
    const tweetsAnalyzed = mergeTask?.result?.tweets_selected_for_analysis_total ?? mergeTask?.result?.tweets_analyzed ?? 0;
    const rawOpportunities = mergeTask?.result?.raw_opportunities ?? 0;
    (decision as any)._discoverySummary = `Discovery: fetched ${tweetsFetched} → analyzed ${tweetsAnalyzed} → raw ${rawOpportunities}`;

    (decision as any)._judgeDiagnostics = judgeTask?.result ? {
      judge_passed_count: judgeTask.result.judge_passed_count ?? 0,
      judge_failed_count: judgeTask.result.judge_failed_count ?? 0,
      judge_failure_reasons: judgeTask.result.judge_failure_reasons ?? {},
    } : null;

    // Phase S1.1: Attach freshness diagnostics from publish_gate to decision for Telegram
    const { data: gateTaskForFreshness } = await supabase
      .from('pipeline_tasks')
      .select('result')
      .eq('run_id', runId)
      .eq('task_type', 'publish_gate')
      .eq('status', 'completed')
      .maybeSingle();

    if (gateTaskForFreshness?.result?._freshness_stats) {
      if (!(decision as any)._publishGate) {
        (decision as any)._publishGate = {};
      }
      (decision as any)._publishGate._freshnessStats = gateTaskForFreshness.result._freshness_stats;
    }

    // Set the decision run ID
    const decisionRunId = persistTask?.result?.decision_run_id;
    (decision as any)._runId = decisionRunId;

    // Deliver to Telegram
    const { deliverDecisionToTelegram } = await import('./daily-runner');
    const { allowedChatId } = await import('./telegram');
    const chatId = allowedChatId();

    if (chatId) {
      await deliverDecisionToTelegram(chatId, scanResult, username, decision, followers);
    }

    // Phase M1: Trigger memory compaction for this run (fire-and-forget, must not fail main run)
    let compactionResult: CompactionResult | null = null;
    try {
      compactionResult = await compactRunIntoMemory(runId);
      console.log(`[pipeline-worker] memory compaction: ${compactionResult.rules_created} rules created, ${compactionResult.rules_updated} rules updated, ${compactionResult.source_memories_created} source memories created, ${compactionResult.source_memories_updated} source memories updated, ${compactionResult.signals_extracted} signals extracted`);
    } catch (compactErr: any) {
      console.warn(`[pipeline-worker] memory compaction failed (non-blocking): ${(compactErr?.message || 'unknown').slice(0, 200)}`);
    }

    return {
      ok: true,
      result: {
        delivered: Boolean(chatId),
        selected_count: decision.selected?.length || 0,
        chat_id: chatId || null,
        // Phase M1: Memory compaction diagnostics
        memory_compaction_rules_created: compactionResult?.rules_created ?? 0,
        memory_compaction_rules_updated: compactionResult?.rules_updated ?? 0,
        memory_compaction_source_memories_created: compactionResult?.source_memories_created ?? 0,
        memory_compaction_source_memories_updated: compactionResult?.source_memories_updated ?? 0,
      }
    };
  } catch (err: any) {
    return { ok: false, result: {}, error: err.message };
  }
}

// ═══ Helper: Build batch result ═══

function buildBatchResult(
  stoppedReason: string,
  workerId: string,
  tasksProcessed: number,
  tasksCompleted: number,
  tasksFailed: number,
  tasksRetried: number,
  startTime: number,
  errors: string[]
): ProcessBatchResult {
  return {
    ok: true,
    worker_id: workerId,
    tasks_processed: tasksProcessed,
    tasks_completed: tasksCompleted,
    tasks_failed: tasksFailed,
    tasks_retried: tasksRetried,
    runtime_ms: Date.now() - startTime,
    errors,
    stopped_reason: stoppedReason
  };
}
