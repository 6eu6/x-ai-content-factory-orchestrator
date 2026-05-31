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
import { attemptNearPassPolish, computeNearPassDiagnostics, MAX_POLISH_CANDIDATES_PER_RUN, type PolishInput, type PolishOutcome, type NearPassDiagnostics } from './near-pass-polish';
import { callModel, parseModelJson } from './model-router';
import { getOriginalityContext, buildOriginalityPromptSection, detectOriginalityIndicators, validateOriginalityOutput, type OriginalityContext, type OriginalityDiagnostics } from './originality-context';
import { buildSignatureVoiceSection, validateSignatureVoice, type SignatureVoiceDiagnostics } from './signature-voice';

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
 */
function localCraftingChecks(
  craftedText: string,
  brief: { do_not_claim: string[] },
  sourceText?: string
): string[] {
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

  // Check: length 40–280
  if (craftedText.length < 40) {
    failures.push('too_short_under_40');
  }
  if (craftedText.length > 280) {
    failures.push('too_long_over_280');
  }

  return failures;
}

/**
 * Craft content from a brief using the selected_candidate_crafting model route.
 *
 * Phase 2D.3: JSON contract — the model MUST return a JSON object:
 *   { "crafted_text": "...", "format": "...", "brief_alignment_score": N,
 *     "claims_to_avoid_checked": bool, "notes": "..." }
 *
 * If JSON parse fails or crafted_text is missing, we return crafted_text=null
 * with brief_alignment_score=1 and a selected_candidate_crafting_parse_failed note.
 *
 * After successful parse, run local quality checks + validateBriefAlignment.
 * If checks fail, make ONE repair attempt.
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
  originalityContext?: OriginalityContext | null
): Promise<{
  crafted_text: string | null;
  format: string;
  brief_alignment_score: number;
  brief_alignment_notes: string[];
  invented_personal_experience_flag: boolean;
  ignored_recommended_angle_flag: boolean;
  _brief_crafting_parse_failed?: boolean;
  _brief_crafting_repair_attempted?: boolean;
  _brief_crafting_repair_applied?: boolean;
  _brief_crafting_failure_reason?: string;
  _originality_diagnostics?: OriginalityDiagnostics;
  _signature_voice_diagnostics?: SignatureVoiceDiagnostics;
}> {
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

  // Phase 2D.3: JSON contract system prompt
  // Phase 2G: Updated JSON schema to include originality_strategy, twist_type_used, avoided_anti_patterns
  const systemPrompt = `You are a content crafter for @30piq, an X account focused on AI, creators, internet culture, productivity, skills, and modern work.

Your task: Craft a tweet that STRICTLY follows the Opportunity Brief below. The brief was produced by an intelligence analyst who identified this as a promising opportunity with a specific recommended angle.

═══ MANDATORY RULES ═══

1. FOLLOW THE RECOMMENDED ANGLE exactly. The recommended_angle is your primary directive — do NOT substitute it with a different angle.

2. DO NOT invent personal experience. Never write "I tried", "I found", "I tested", "my experience", "I used", "I built", "I discovered", "I learned", "I noticed" — unless the source tweet is FROM @30piq themselves confirming this experience.

3. DO NOT use vague or grand phrases: no "brilliant minds", "game changer", "this is huge", "seeing X gives me hope", "so inspiring", "hype cycle", "labs get serious", "foundational breakthroughs attract elite builders", "groundbreaking".

4. AVOID all do_not_claim terms listed below — these are claims the source does NOT support and must not be repeated.

5. INCLUDE all required_context items — these are facts/points that MUST be present for the content to be honest.

6. INCLUDE at least one concrete takeaway for builders/operators. Not just a broad interpretation — give a specific, actionable signal or insight.

7. Keep claims as interpretations, not facts: prefer "A useful signal is..." over "This proves..."; prefer "One way to read this..." over "This means...".

8. Do NOT invent historical parallels unless the source or required_context directly supports them.

9. Sound analytical, specific, and calm — not a hype account, not a content mill, not a life coach.

10. Keep crafted_text under 280 characters. It must be at least 40 characters.

11. English ONLY.

12. No hashtags, no AI slop words (delve, crucial, leverage, game-changer, unlock, empower, elevate, foster, streamline, harness, cutting-edge, paradigm, synergy).

13. Return a JSON object with this exact schema:
    { "crafted_text": "string under 280 chars", "format": "quote|reply|standalone", "brief_alignment_score": number, "originality_strategy": "string explaining what makes this original", "twist_type_used": "one of: inversion|mechanism|operator_heuristic|cost_of_being_stale|timeline_shift|capability_map|distribution_positioning|constraint_insight|failure_mode_insight", "signature_phrase": "3-8 word repeatable phrase from the text", "operator_takeaway": "concrete operator rule or actionable signal", "avoided_anti_patterns": ["list of anti-patterns you consciously avoided"], "claims_to_avoid_checked": boolean, "notes": "short string" }
    - crafted_text: The tweet text, plain text only (no JSON/markdown inside it).
    - format: The content format.
    - brief_alignment_score: Your self-assessment 1-10 of how well the text follows the recommended_angle.
    - originality_strategy: Brief explanation of what makes your text original (not just a summary or generic take).
    - twist_type_used: The twist type you applied from the suggested types (or "none" if none fits).
    - signature_phrase: A compact, repeatable phrase from your crafted text (3-8 words). Think "capability map", "stale mental model", "judgment cache for taste".
    - operator_takeaway: A concrete operator rule or actionable signal. Think "When evaluating X, check Y" or "The signal is Z".
    - avoided_anti_patterns: List of anti-patterns you consciously avoided.
    - claims_to_avoid_checked: True if you verified the text avoids all do_not_claim terms.
    - notes: Brief note on your crafting decisions.

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
Publishability: ${brief.publishability_score}/10${originalitySection}${signatureVoiceSection}`;

  const userPrompt = `Craft a brief-faithful tweet for this opportunity:

Source by @${sourceAuthor}: "${sourceText}"

Original drafted text (IGNORE its angle — use the brief's angle instead): "${originalCrafted}"

Return a JSON object with crafted_text, format, brief_alignment_score, originality_strategy, twist_type_used, signature_phrase, operator_takeaway, avoided_anti_patterns, claims_to_avoid_checked, and notes.`;

  try {
    const response = await callModel('selected_candidate_crafting' as any, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.18, max_tokens: 900, response_format: { type: 'json_object' } });

    // Phase 2D.3: Strict JSON parse — the contract requires a JSON object
    let parsed: any;
    try {
      parsed = parseModelJson(String(response || ''));
    } catch {
      parsed = null;
    }

    // Require crafted_text field in parsed JSON
    if (!parsed || typeof parsed !== 'object' || typeof parsed.crafted_text !== 'string' || !parsed.crafted_text.trim()) {
      return {
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

    let crafted = parsed.crafted_text.trim();
    const modelFormat = parsed.format || brief.content_format || 'reply';
    const modelBriefScore = typeof parsed.brief_alignment_score === 'number' ? parsed.brief_alignment_score : undefined;

    // Do NOT use raw model output if it still looks like JSON/malformed
    if (/^\s*\{/.test(crafted) || /^```/.test(crafted)) {
      return {
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

    // Phase 2D.3: Pre-judge self-check — local quality checks + validateBriefAlignment
    const alignment = validateBriefAlignment(crafted, brief, sourceText);
    const localFailures = localCraftingChecks(crafted, brief, sourceText);
    const allNotes = [...alignment.notes, ...localFailures];

    // If local checks fail, attempt ONE repair
    let repairAttempted = false;
    let repairApplied = false;
    let repairFailureReason: string | undefined;

    if (localFailures.length > 0 || alignment.score < 7.0) {
      repairAttempted = true;
      console.log(`[craftFromBrief] Local checks failed (${localFailures.join(', ')}), brief_alignment_score=${alignment.score}. Attempting one repair.`);

      try {
        const repairResponse = await callModel('selected_candidate_crafting' as any, [
          {
            role: 'system',
            content: `You are a content crafter for @30piq. Your previous draft had quality issues that must be fixed.

Fix these specific problems:
${localFailures.map(f => `- ${f}`).join('\n')}
${alignment.score < 7.0 ? `- brief_alignment_score is only ${alignment.score}/10 — must better follow the recommended angle` : ''}

MANDATORY RULES (same as before):
- Follow the recommended_angle exactly: ${brief.recommended_angle}
- No invented personal experience
- No generic/vague praise ("brilliant minds", "game changer", "hype cycle", "gives me hope")
- Avoid do_not_claim terms
- Include at least one concrete takeaway for builders/operators
- Keep claims as interpretations, not facts
- Under 280 chars, at least 40 chars
- English only, no hashtags, no AI slop

Return a JSON object: { "crafted_text": "...", "format": "...", "brief_alignment_score": N, "claims_to_avoid_checked": bool, "notes": "..." }`,
          },
          {
            role: 'user',
            content: `Previous draft that needs repair:
"${crafted}"

Source by @${sourceAuthor}: "${sourceText}"

Return a repaired JSON object.`,
          },
        ], { temperature: 0.18, max_tokens: 900, response_format: { type: 'json_object' } });

        let repairParsed: any;
        try {
          repairParsed = parseModelJson(String(repairResponse || ''));
        } catch {
          repairParsed = null;
        }

        if (repairParsed && typeof repairParsed.crafted_text === 'string' && repairParsed.crafted_text.trim()) {
          const repairedText = repairParsed.crafted_text.trim();
          // Verify repair doesn't look like JSON
          if (!/^\s*\{/.test(repairedText) && !/^```/.test(repairedText)) {
            // Re-validate repaired text
            const repairAlignment = validateBriefAlignment(repairedText, brief, sourceText);
            const repairLocalFailures = localCraftingChecks(repairedText, brief, sourceText);

            // Accept repair if it improves the situation (fewer failures or better alignment)
            if (repairLocalFailures.length < localFailures.length || repairAlignment.score > alignment.score) {
              crafted = repairedText;
              repairApplied = true;
              // Update alignment info to the repaired version
              alignment.score = repairAlignment.score;
              alignment.notes = [...repairAlignment.notes, ...repairLocalFailures, 'repair_applied'];
              alignment.invented_personal_experience = repairAlignment.invented_personal_experience;
              alignment.ignored_recommended_angle = repairAlignment.ignored_recommended_angle;
            } else {
              repairFailureReason = 'repair_no_improvement';
            }
          } else {
            repairFailureReason = 'repair_crafted_text_is_json_wrapper';
          }
        } else {
          repairFailureReason = 'repair_json_missing_crafted_text';
        }
      } catch (repairErr: any) {
        console.warn(`[craftFromBrief] Repair attempt failed: ${(repairErr?.message || 'unknown').slice(0, 200)}`);
        repairFailureReason = `repair_exception:${(repairErr?.message || 'unknown').slice(0, 50)}`;
      }
    }

    // Phase 2G: Parse originality output fields from model response
    const originalityOutput = validateOriginalityOutput(parsed);
    const originalityIndicators = detectOriginalityIndicators(crafted);

    // Phase 2G.1: Validate signature voice
    const signatureVoiceDiagnostics = validateSignatureVoice(crafted);
    // Override the model-declared signature_phrase and operator_takeaway if available
    if (parsed.signature_phrase && typeof parsed.signature_phrase === 'string') {
      signatureVoiceDiagnostics._signature_phrase = parsed.signature_phrase.trim();
    }
    if (parsed.operator_takeaway && typeof parsed.operator_takeaway === 'string') {
      signatureVoiceDiagnostics._operator_takeaway = parsed.operator_takeaway.trim();
    }

    return {
      crafted_text: crafted,
      format: modelFormat || brief.content_format || 'reply',
      brief_alignment_score: alignment.score,
      brief_alignment_notes: alignment.notes,
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
  } catch (err: any) {
    console.warn(`[craftFromBrief] AI call failed: ${(err?.message || 'unknown').slice(0, 200)}`);
    return {
      crafted_text: null,
      format: brief.content_format || 'reply',
      brief_alignment_score: 1,
      brief_alignment_notes: [`AI call failed: ${(err?.message || 'unknown').slice(0, 100)}`],
      invented_personal_experience_flag: false,
      ignored_recommended_angle_flag: true,
      _brief_crafting_parse_failed: true,
      _brief_crafting_failure_reason: `ai_call_failed:${(err?.message || 'unknown').slice(0, 50)}`,
    };
  }
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
        tweets: xSnapshot.tweet_count || 0
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

    const { enrichOpportunitiesWithRulePerformance } = await import('./enrich-opportunities-with-rule-performance');
    const rulePerformanceStats = await enrichOpportunitiesWithRulePerformance(opportunities);

    // Phase 2D.2: Brief-faithful recrafting for selected opportunities that have a _brief.
    // The original crafted_text from content-engine-v3 was generated BEFORE intelligence,
    // so it ignores the recommended_angle. We now recraft using selected_candidate_crafting.
    // Phase 2G: Fetch originality context ONCE per run, share across all candidates.
    let briefRecraftCount = 0;
    let briefRecraftFailed = 0;
    let originalityContextUsedCount = 0;
    let originalityContextFetchFailedCount = 0;
    const originalityTwistTypeCounts: Record<string, number> = {};
    const originalityAntiPatternsUsed: string[] = [];
    // Phase 2G.1: Signature voice task-level diagnostics
    let signatureVoiceUsedCount = 0;
    let signatureVoiceScoreSum = 0;
    let signatureVoiceScoreCount = 0;
    const signatureVoiceFailureReasonsAll: string[] = [];

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

          const recraftResult = await craftFromBrief(opp, brief, originalityCtx);
          if (recraftResult.crafted_text) {
            opportunities[i] = {
              ...opp,
              crafted_text: recraftResult.crafted_text,
              _brief_used_for_crafting: true,
              _brief_alignment_score: recraftResult.brief_alignment_score,
              _brief_alignment_notes: recraftResult.brief_alignment_notes,
              _invented_personal_experience_flag: recraftResult.invented_personal_experience_flag,
              _ignored_recommended_angle_flag: recraftResult.ignored_recommended_angle_flag,
              // Phase 2D.3 diagnostics
              _brief_crafting_parse_failed: recraftResult._brief_crafting_parse_failed || false,
              _brief_crafting_repair_attempted: recraftResult._brief_crafting_repair_attempted || false,
              _brief_crafting_repair_applied: recraftResult._brief_crafting_repair_applied || false,
              _brief_crafting_failure_reason: recraftResult._brief_crafting_failure_reason,
              // Phase 2G: Originality diagnostics
              _originality_context_used: recraftResult._originality_diagnostics?._originality_context_used ?? false,
              _originality_twist_type_used: recraftResult._originality_diagnostics?._originality_twist_type_used,
              _originality_strategy: recraftResult._originality_diagnostics?._originality_strategy,
              _originality_context_items_count: recraftResult._originality_diagnostics?._originality_context_items_count ?? 0,
              _avoided_originality_anti_patterns: recraftResult._originality_diagnostics?._avoided_originality_anti_patterns,
              // Phase 2G.1: Signature voice diagnostics
              _signature_voice_used: recraftResult._signature_voice_diagnostics?._signature_voice_used ?? false,
              _signature_phrase: recraftResult._signature_voice_diagnostics?._signature_phrase,
              _operator_takeaway: recraftResult._signature_voice_diagnostics?._operator_takeaway,
              _signature_voice_score: recraftResult._signature_voice_diagnostics?._signature_voice_score ?? 0,
              _signature_voice_failure_reasons: recraftResult._signature_voice_diagnostics?._signature_voice_failure_reasons,
            };
            briefRecraftCount++;

            // Track twist type counts
            if (recraftResult._originality_diagnostics?._originality_twist_type_used) {
              const twist = recraftResult._originality_diagnostics._originality_twist_type_used;
              originalityTwistTypeCounts[twist] = (originalityTwistTypeCounts[twist] || 0) + 1;
            }
            if (recraftResult._originality_diagnostics?._avoided_originality_anti_patterns) {
              originalityAntiPatternsUsed.push(...recraftResult._originality_diagnostics._avoided_originality_anti_patterns);
            }
            // Phase 2G.1: Track signature voice stats
            if (recraftResult._signature_voice_diagnostics?._signature_voice_used) {
              signatureVoiceUsedCount++;
            }
            if (recraftResult._signature_voice_diagnostics?._signature_voice_score) {
              signatureVoiceScoreSum += recraftResult._signature_voice_diagnostics._signature_voice_score;
              signatureVoiceScoreCount++;
            }
            if (recraftResult._signature_voice_diagnostics?._signature_voice_failure_reasons) {
              signatureVoiceFailureReasonsAll.push(...recraftResult._signature_voice_diagnostics._signature_voice_failure_reasons);
            }
          } else {
            briefRecraftFailed++;
            // Mark the brief as attempted but failed
            opportunities[i] = {
              ...opp,
              _brief_used_for_crafting: true,
              _brief_alignment_score: recraftResult.brief_alignment_score,
              _brief_alignment_notes: recraftResult.brief_alignment_notes,
              _invented_personal_experience_flag: recraftResult.invented_personal_experience_flag,
              _ignored_recommended_angle_flag: recraftResult.ignored_recommended_angle_flag,
              // Phase 2D.3 diagnostics
              _brief_crafting_parse_failed: recraftResult._brief_crafting_parse_failed || false,
              _brief_crafting_repair_attempted: recraftResult._brief_crafting_repair_attempted || false,
              _brief_crafting_repair_applied: recraftResult._brief_crafting_repair_applied || false,
              _brief_crafting_failure_reason: recraftResult._brief_crafting_failure_reason,
              // Phase 2G: Originality diagnostics (even on failure)
              _originality_context_used: recraftResult._originality_diagnostics?._originality_context_used ?? false,
              _originality_twist_type_used: recraftResult._originality_diagnostics?._originality_twist_type_used,
              _originality_strategy: recraftResult._originality_diagnostics?._originality_strategy,
              _originality_context_items_count: recraftResult._originality_diagnostics?._originality_context_items_count ?? 0,
              _avoided_originality_anti_patterns: recraftResult._originality_diagnostics?._avoided_originality_anti_patterns,
              // Phase 2G.1: Signature voice diagnostics (even on failure)
              _signature_voice_used: recraftResult._signature_voice_diagnostics?._signature_voice_used ?? false,
              _signature_phrase: recraftResult._signature_voice_diagnostics?._signature_phrase,
              _operator_takeaway: recraftResult._signature_voice_diagnostics?._operator_takeaway,
              _signature_voice_score: recraftResult._signature_voice_diagnostics?._signature_voice_score ?? 0,
              _signature_voice_failure_reasons: recraftResult._signature_voice_diagnostics?._signature_voice_failure_reasons,
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
    // Phase 2D.3: Prefer opp._brief directly over intelBriefs source_text lookup
    const candidates = opportunities.map(opp => {
      const oppBrief = (opp as any)._brief;
      const brief = (oppBrief && oppBrief.recommended_angle) ? oppBrief
        : intelBriefs[(opp.source_text || '').slice(0, 100)] || {};
      return {
        crafted_text: opp.crafted_text || '',
        brief,
        opportunity: opp,
      };
    });

    // Run judge on all candidates
    const { results, summary } = await judgeCraftedCandidates(candidates.map(c => ({
      crafted_text: c.crafted_text,
      brief: c.brief,
    })));

    // Apply judge results to opportunities — judge-failed ones get shield_passed=false
    const judgedOpportunities = opportunities.map((opp, i) => {
      const judgeResult = results[i];
      if (!judgeResult) return opp;

      return {
        ...opp,
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
      };
    });

    // ═══ Phase 2F: Near-Pass Polish ═══
    // For failed candidates that are close to passing, attempt ONE targeted polish.
    // This runs AFTER the first judge pass and BEFORE returning results.
    const polishOutcomes: PolishOutcome[] = [];
    let polishAttempted = 0;

    if (summary.judge_failed_count > 0) {
      // Identify near-pass candidates (sorted by final_candidate_score descending for priority)
      const nearPassIndices: number[] = [];
      for (let i = 0; i < results.length; i++) {
        const judgeResult = results[i];
        const opp = judgedOpportunities[i];
        const candidate = candidates[i];
        if (!judgeResult || judgeResult.passed) continue;

        const craftedText = opp.crafted_text || candidate?.crafted_text || '';
        const brief = candidate?.brief || (opp as any)?._brief || {};

        if (isNearPass(judgeResult, craftedText, brief)) {
          nearPassIndices.push(i);
        }
      }

      // Limit to MAX_POLISH_CANDIDATES_PER_RUN, prioritized by score (highest first)
      nearPassIndices.sort((a, b) => results[b].final_candidate_score - results[a].final_candidate_score);
      const eligibleIndices = nearPassIndices.slice(0, MAX_POLISH_CANDIDATES_PER_RUN);

      for (const idx of eligibleIndices) {
        const judgeResult = results[idx];
        const opp = judgedOpportunities[idx];
        const candidate = candidates[idx];
        const brief = candidate?.brief || (opp as any)?._brief || {};
        const craftedText = opp.crafted_text || candidate?.crafted_text || '';

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
        };

        // Phase 2G: If originality failure, fetch originality context for the polish
        const isOriginalityFailure = judgeResult.originality_score < 7.8 ||
          judgeResult.failure_reasons.some(r => r.includes('originality') || r.includes('missing_originality'));
        if (isOriginalityFailure) {
          try {
            const originalityCtx = await getOriginalityContext({
              source_text: String(opp.source_text || opp.text || ''),
              source_author: opp.source_author,
              brief: brief,
              current_text: craftedText,
              failure_reasons: judgeResult.failure_reasons,
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

    // Recompute pass/fail counts after polish (some may have flipped)
    const finalPassedCount = judgedOpportunities.filter(o => o.shield_passed !== false).length;
    const finalFailedCount = judgedOpportunities.filter(o => o.shield_passed === false).length;

    // Log summary
    console.log(`[pipeline-worker] opportunity_judge: ${finalPassedCount} passed, ${finalFailedCount} failed (after near-pass polish). Near-pass: ${nearPassDiagnostics.near_pass_candidates_count} eligible, ${nearPassDiagnostics.near_pass_polish_attempted_count} attempted, ${nearPassDiagnostics.near_pass_polish_passed_count} rescued. Avg final_candidate_score: ${summary.avg_final_candidate_score}`);

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
        near_pass_candidates_count: nearPassDiagnostics.near_pass_candidates_count,
        near_pass_polish_attempted_count: nearPassDiagnostics.near_pass_polish_attempted_count,
        near_pass_polish_applied_count: nearPassDiagnostics.near_pass_polish_applied_count,
        near_pass_polish_passed_count: nearPassDiagnostics.near_pass_polish_passed_count,
        near_pass_polish_failed_count: nearPassDiagnostics.near_pass_polish_failed_count,
        near_pass_polish_failure_reasons: nearPassDiagnostics.near_pass_polish_failure_reasons,
        average_score_before_polish: nearPassDiagnostics.average_score_before_polish,
        average_score_after_polish: nearPassDiagnostics.average_score_after_polish,
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
    const publishGate = filterPublishableOpportunities(opportunities);

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

    return {
      ok: true,
      result: {
        accepted: publishGate.accepted.length,
        rejected: publishGate.rejected.length,
        reasons: publishGate.rejected.slice(0, 5).map((r: any) => r.reason),
        _accepted: publishGate.accepted,
        _rejected: publishGate.rejected
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

    return {
      ok: true,
      result: {
        delivered: Boolean(chatId),
        selected_count: decision.selected?.length || 0,
        chat_id: chatId || null
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
