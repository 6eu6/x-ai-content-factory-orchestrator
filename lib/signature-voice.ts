/**
 * signature-voice.ts — Phase 2G.1: Signature Voice + Stronger Originality Strategy
 *
 * Provides a distinctive @30piq voice layer that goes beyond generic smart
 * commentary. While Phase 2G added RAG-guided originality (twist types, anti-patterns),
 * the output still felt like "smart generic commentary." This module enforces
 * a signature voice that produces:
 *
 * 1. A memorable first line (compressed frame, not summary)
 * 2. A sharper proprietary frame
 * 3. A concrete operator takeaway
 * 4. A compact signature phrase
 * 5. Evidence-safe wording
 *
 * This module does NOT:
 * - lower thresholds
 * - bypass shield
 * - auto-post
 * - invent unsupported claims
 * - add fake personal experience
 * - overfit to hardcoded examples
 * - make text verbose or thread-like
 * - use hashtags/emojis
 */

// ═══ Types ═══

export type SignatureVoiceContext = {
  recommended_angle?: string;
  source_text_preview?: string;
  twist_type_used?: string;
  originality_strategy?: string;
};

export type SignatureVoiceDiagnostics = {
  _signature_voice_used: boolean;
  _signature_phrase?: string;
  _operator_takeaway?: string;
  _signature_voice_score: number;
  _signature_voice_failure_reasons?: string[];
};

// ═══ Signature Voice Rules ═══

export const SIGNATURE_VOICE_RULES = {
  lead: 'Lead with a compressed frame, not a summary.',
  memorablePhrase: 'Use one memorable phrase the reader can repeat.',
  contrastFrame: 'Prefer "X is not A, it\'s B" when evidence-safe.',
  operatorRule: 'Prefer a practical operator rule.',
  avoidGenericCommentary: [
    'the future of...',
    'game changer',
    'AI is changing everything',
    'this is huge',
    'the real unlock',
    'builders should...',
  ],
  avoidVagueClaims: [
    'more productive',
    'better workflows',
    'unlocks potential',
  ],
  preferConcreteNouns: [
    'capability map',
    'judgment cache',
    'documented reasoning',
    'stale mental model',
    'second-model critic',
    'render target',
    'operator heuristic',
    'training set for taste',
  ],
  lengthConstraint: 'Keep under 280 chars unless explicitly long-form is enabled.',
};

// ═══ Anti-Pattern Detection ═══

/** Generic hype / AI commentary patterns */
const GENERIC_HYPE_PATTERNS = [
  /\bthe future of\b/i,
  /\bgame.?changer\b/i,
  /\bai is changing everything\b/i,
  /\bthis is huge\b/i,
  /\bthe real unlock\b/i,
  /\bbuilders should\b/i,
];

/** Vague claim patterns */
const VAGUE_CLAIM_PATTERNS = [
  /\bmore productive\b/i,
  /\bbetter workflows?\b/i,
  /\bunlocks? potential\b/i,
];

// ═══ Indicator Detection ═══

/**
 * Detect signature voice indicators in a crafted text.
 *
 * Returns an object with boolean flags for each indicator and the detected
 * signature phrase (if any) and operator takeaway (if any).
 */
export function detectSignatureVoiceIndicators(text: string): {
  hasMemorableFirstLine: boolean;
  hasContrastOrInversion: boolean;
  hasOperatorTakeaway: boolean;
  hasCompactPhrase: boolean;
  hasGenericHype: boolean;
  hasVagueCommentary: boolean;
  isTooLong: boolean;
  isTooAbstract: boolean;
  detectedSignaturePhrase: string | null;
  detectedOperatorTakeaway: string | null;
} {
  if (!text || typeof text !== 'string') {
    return {
      hasMemorableFirstLine: false,
      hasContrastOrInversion: false,
      hasOperatorTakeaway: false,
      hasCompactPhrase: false,
      hasGenericHype: false,
      hasVagueCommentary: false,
      isTooLong: false,
      isTooAbstract: false,
      detectedSignaturePhrase: null,
      detectedOperatorTakeaway: null,
    };
  }

  const trimmed = text.trim();
  const firstSentence = trimmed.split(/[.!?\n]/)[0] || trimmed;

  // Memorable first line: the first sentence is short, punchy, and not a summary
  // A compressed frame starts with a claim, contrast, or concrete noun — not "This is about..."
  const summaryStarters = /^(this (is|shows|means|article|post|thread)|here('s| is)|so,|basically|in short|tl;dr)/i;
  const hasMemorableFirstLine = firstSentence.length > 0 &&
    firstSentence.length <= 80 &&
    !summaryStarters.test(firstSentence.trim());

  // Contrast or inversion: "X is not A, it's B" or explicit contrast signals
  const hasContrastOrInversion = /\bis not\b.*\bit(?:'s| is)\b/i.test(trimmed) ||
    /\bnot .* but\b/i.test(trimmed) ||
    /\binstead of\b/i.test(trimmed) ||
    /\brather than\b/i.test(trimmed) ||
    /\bthe opposite\b/i.test(trimmed) ||
    /\bthe mistake\b/i.test(trimmed) ||
    /\bdon't\b.*\bdo\b/i.test(trimmed) ||
    /, not \b/i.test(trimmed) ||
    /\bnot \w+, (it's|it is|the|that|but)\b/i.test(trimmed);

  // Operator takeaway: a practical instruction or heuristic
  const operatorTakeawayPatterns = [
    /\b(if|when) you\b.{0,30}\b(use|need|want|evaluate|choose|build|pick)\b/i,
    /\b(your (move|play|signal|filter|rule|heuristic))\b/i,
    /\b(the (move|play|signal|rule|heuristic|filter|key|trick)) is\b/i,
    /\b(stop|start|switch|avoid|skip|try|use)\b.{0,20}\b(instead|now|before|after)\b/i,
    /\b(stop)\b.{0,30}\b(start)\b/i,
    /\b(always|never)\b.{0,30}\b(if|when|unless)\b/i,
  ];

  const hasOperatorTakeaway = operatorTakeawayPatterns.some(p => p.test(trimmed));

  // Compact reusable phrase: a short, quotable phrase (5-15 words)
  // e.g. "capability map", "judgment cache", "stale mental model"
  const concreteNounPatterns = SIGNATURE_VOICE_RULES.preferConcreteNouns;
  const hasConcreteNoun = concreteNounPatterns.some(noun =>
    trimmed.toLowerCase().includes(noun.toLowerCase())
  );

  // Also check for any "X is Y" pattern that could be a reusable phrase
  const compactPhraseMatch = trimmed.match(
    /([A-Z][a-z]+(?:\s+[a-z]+){1,5}\s+(?:is|are|means|becomes)\s+[a-z]+(?:\s+[a-z]+){0,4})/
  );

  const hasCompactPhrase = hasConcreteNoun || !!compactPhraseMatch;

  // Detect signature phrase — the most quotable compact phrase
  let detectedSignaturePhrase: string | null = null;
  if (hasConcreteNoun) {
    // Find the sentence containing the concrete noun
    const sentences = trimmed.split(/[.!?\n]/);
    for (const noun of concreteNounPatterns) {
      const match = sentences.find(s => s.toLowerCase().includes(noun.toLowerCase()));
      if (match) {
        detectedSignaturePhrase = match.trim().slice(0, 80);
        break;
      }
    }
  }
  if (!detectedSignaturePhrase && compactPhraseMatch) {
    detectedSignaturePhrase = compactPhraseMatch[1].slice(0, 80);
  }

  // Detect operator takeaway text
  let detectedOperatorTakeaway: string | null = null;
  for (const pattern of operatorTakeawayPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      // Get the sentence containing the operator takeaway
      const startIdx = Math.max(0, (match.index || 0) - 10);
      const endIdx = Math.min(trimmed.length, (match.index || 0) + match[0].length + 40);
      detectedOperatorTakeaway = trimmed.slice(startIdx, endIdx).trim().slice(0, 80);
      break;
    }
  }

  // Generic hype detection
  const hasGenericHype = GENERIC_HYPE_PATTERNS.some(p => p.test(trimmed));

  // Vague AI commentary
  const hasVagueCommentary = VAGUE_CLAIM_PATTERNS.some(p => p.test(trimmed));

  // Too long (over 280 chars)
  const isTooLong = trimmed.length > 280;

  // Too abstract: no concrete nouns, no numbers, no specific references
  const hasConcreteDetail = /\b\d+\b/.test(trimmed) ||
    concreteNounPatterns.some(n => trimmed.toLowerCase().includes(n.toLowerCase())) ||
    /\b(RAG|LLM|API|MCP|fine-tun|embed|vector|prompt|agent|token|inference|batch|pipeline|workflow)\b/i.test(trimmed);
  const isTooAbstract = !hasConcreteDetail && trimmed.length > 60;

  return {
    hasMemorableFirstLine,
    hasContrastOrInversion,
    hasOperatorTakeaway,
    hasCompactPhrase,
    hasGenericHype,
    hasVagueCommentary,
    isTooLong,
    isTooAbstract,
    detectedSignaturePhrase,
    detectedOperatorTakeaway,
  };
}

// ═══ Score Heuristic ═══

/**
 * Compute a signature voice score (0-10) for the crafted text.
 *
 * Scoring:
 * +2 memorable first line
 * +2 contains contrast or inversion
 * +2 contains concrete operator takeaway
 * +2 contains compact reusable phrase
 * +1 evidence-safe qualifier when needed
 * -2 generic hype
 * -2 vague AI commentary
 * -2 too long or too abstract
 *
 * Clamp 0-10.
 */
export function computeSignatureVoiceScore(text: string): {
  score: number;
  breakdown: {
    memorableFirstLine: number;
    contrastOrInversion: number;
    operatorTakeaway: number;
    compactPhrase: number;
    evidenceSafeQualifier: number;
    genericHypePenalty: number;
    vagueCommentaryPenalty: number;
    tooLongOrAbstractPenalty: number;
  };
} {
  const indicators = detectSignatureVoiceIndicators(text);

  const memorableFirstLine = indicators.hasMemorableFirstLine ? 2 : 0;
  const contrastOrInversion = indicators.hasContrastOrInversion ? 2 : 0;
  const operatorTakeaway = indicators.hasOperatorTakeaway ? 2 : 0;
  const compactPhrase = indicators.hasCompactPhrase ? 2 : 0;

  // Evidence-safe qualifier: if text has qualifiers like "likely", "probably",
  // "one signal", "suggests" — award +1 only if it also has claims that need qualifying
  const hasClaimsNeedingQualifiers = /\d+%|\$\d+|\d+x\b/i.test(text);
  const hasEvidentialQualifier = /\b(likely|probably|one (signal|way|read)|suggests?|appears?|indicates?|points? to)\b/i.test(text);
  const evidenceSafeQualifier = (hasClaimsNeedingQualifiers && hasEvidentialQualifier) ? 1 : 0;

  const genericHypePenalty = indicators.hasGenericHype ? -2 : 0;
  const vagueCommentaryPenalty = indicators.hasVagueCommentary ? -2 : 0;
  const tooLongOrAbstractPenalty = (indicators.isTooLong || indicators.isTooAbstract) ? -2 : 0;

  const raw = memorableFirstLine + contrastOrInversion + operatorTakeaway + compactPhrase +
    evidenceSafeQualifier + genericHypePenalty + vagueCommentaryPenalty + tooLongOrAbstractPenalty;

  const score = Math.max(0, Math.min(10, raw));

  return {
    score,
    breakdown: {
      memorableFirstLine,
      contrastOrInversion,
      operatorTakeaway,
      compactPhrase,
      evidenceSafeQualifier,
      genericHypePenalty,
      vagueCommentaryPenalty,
      tooLongOrAbstractPenalty,
    },
  };
}

// ═══ Validation ═══

/**
 * Validate signature voice in a crafted text.
 *
 * Returns a SignatureVoiceDiagnostics object with score, detected phrase/takeaway,
 * and failure reasons if score < 7.
 *
 * NOTE: This does NOT automatically fail the candidate — it only adds diagnostics.
 * The existing validator (originality indicators, evidence safety, etc.) still
 * determines pass/fail. But if signature_voice_score < 7, it's flagged for analysis.
 */
export function validateSignatureVoice(text: string): SignatureVoiceDiagnostics {
  const indicators = detectSignatureVoiceIndicators(text);
  const { score } = computeSignatureVoiceScore(text);

  const failureReasons: string[] = [];
  if (!indicators.hasMemorableFirstLine) failureReasons.push('no_memorable_first_line');
  if (!indicators.hasContrastOrInversion) failureReasons.push('no_contrast_or_inversion');
  if (!indicators.hasOperatorTakeaway) failureReasons.push('no_operator_takeaway');
  if (!indicators.hasCompactPhrase) failureReasons.push('no_compact_phrase');
  if (indicators.hasGenericHype) failureReasons.push('contains_generic_hype');
  if (indicators.hasVagueCommentary) failureReasons.push('contains_vague_commentary');
  if (indicators.isTooLong) failureReasons.push('text_over_280_chars');
  if (indicators.isTooAbstract) failureReasons.push('too_abstract');

  return {
    _signature_voice_used: true,
    _signature_phrase: indicators.detectedSignaturePhrase || undefined,
    _operator_takeaway: indicators.detectedOperatorTakeaway || undefined,
    _signature_voice_score: score,
    _signature_voice_failure_reasons: score < 7 ? failureReasons : undefined,
  };
}

// ═══ Prompt Builder ═══

/**
 * Build a SIGNATURE VOICE section for insertion into crafting or polish prompts.
 * This is a ready-to-insert prompt block that goes AFTER the ORIGINALITY CONTEXT section.
 */
export function buildSignatureVoiceSection(context?: SignatureVoiceContext): string {
  const angleHint = context?.recommended_angle
    ? `\n- Your recommended angle: "${context.recommended_angle}" — the signature phrase should distill this angle, not restate it.`
    : '';

  const twistHint = context?.twist_type_used
    ? `\n- Your twist type: ${context.twist_type_used} — the signature phrase should embody this twist.`
    : '';

  return `═══ SIGNATURE VOICE ═══

You are writing as @30piq — a distinctive analytical voice, not a generic AI commentator.

SIGNATURE VOICE RULES:
- Lead with a compressed frame, not a summary. The first line should make the reader stop.
- Use ONE memorable phrase the reader can repeat. Think "capability map", "judgment cache", "stale mental model" — not "more productive", "better workflows".
- Prefer "X is not A, it's B" when evidence-safe.
- Prefer a practical operator rule: "When X, use Y" or "The signal is Z".
- Avoid generic AI commentary at all costs:
  - "the future of..." → FORBIDDEN
  - "game changer" → FORBIDDEN
  - "AI is changing everything" → FORBIDDEN
  - "this is huge" → FORBIDDEN
  - "the real unlock" → FORBIDDEN
  - "builders should..." → FORBIDDEN
- Avoid vague claims:
  - "more productive" → replace with specific mechanism
  - "better workflows" → replace with concrete operator rule
  - "unlocks potential" → replace with evidence-safe frame
- Prefer concrete nouns: capability map, judgment cache, documented reasoning, stale mental model, second-model critic, render target, operator heuristic, training set for taste.
- Keep under 280 chars unless explicitly long-form is enabled.
- No hashtags, no emojis.${angleHint}${twistHint}

REQUIRED OUTPUT FIELDS:
- "signature_phrase": A compact, repeatable phrase from your crafted text (e.g., "stale mental model", "judgment cache for taste"). Must be 3-8 words.
- "operator_takeaway": A concrete operator rule or actionable signal (e.g., "When evaluating AI tools, check if they reduce judgment cache misses"). Must be practical and specific.

SIGNATURE VOICE IS NOT OPTIONAL. Every crafted text must have a memorable first line, a compact phrase, and an operator takeaway.`;
}
