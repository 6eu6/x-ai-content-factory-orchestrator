/**
 * opportunity-intelligence.ts — Phase 2D: AI Opportunity Intelligence Layer
 *
 * Evaluates raw opportunities and creates structured "Opportunity Briefs"
 * before content crafting. This is the intelligence gate that decides
 * whether an opportunity is worth crafting content for.
 *
 * Principle: Not every opportunity deserves content. Many raw opportunities
 * are off-niche, generic, or lack a useful angle. This module applies
 * both heuristic and AI-powered evaluation to filter opportunities early,
 * BEFORE the expensive content crafting step.
 *
 * This module does NOT:
 * - Lower quality thresholds
 * - Bypass existing quality checks
 * - Force fake AI angles onto unrelated content
 * - Craft any content itself
 *
 * It DOES:
 * - Evaluate each opportunity against the @30piq niche model
 * - Score on multiple dimensions (publishability, originality, niche fit, etc.)
 * - Apply hard rejection rules after AI evaluation
 * - Produce structured OpportunityBriefs with content guidance
 * - Track summary statistics for the pipeline
 * - Try to find legitimate adjacent angles before rejecting
 * - Provide precise rejection reasons (not vague weak_source catch-all)
 */

import { callModel, parseModelJson, TaskType } from './model-router';

// ═══ Types ═══

export type OpportunityBrief = {
  // Source identification
  source_summary: string;
  source_text: string;
  source_author: string;
  source_tweet_url: string;
  type: string;

  // AI-evaluated fields
  core_observation: string;
  why_it_matters: string;
  audience_relevance: string;
  niche_fit_score: number;              // 1-10
  originality_potential_score: number;  // 1-10
  usefulness_score: number;             // 1-10
  evidence_risk_score: number;          // 1-10 (higher = safer)
  viral_context_score: number;          // 1-10
  publishability_score: number;         // 1-10

  // Content guidance
  recommended_angle: string;
  content_format: 'reply' | 'quote' | 'standalone';
  do_not_claim: string[];
  required_context: string[];

  // Decision
  should_craft: boolean;
  rejection_reason?: string;

  // Phase 2D.1: Parse failure diagnostics (only set when AI call/parse fails)
  parse_failed?: boolean;
  intelligence_error_type?: 'model_call_failed' | 'json_parse_failed' | 'missing_required_fields';
  intelligence_error_message_short?: string;
  raw_model_output_preview?: string;

  // Phase 2D.4: Borderline rescue fields (only set when rescue was applied)
  rescue_applied?: boolean;
  rescue_reason?: string;
  original_rejection_reason?: string;
  rescue_originality_before?: number;
  rescue_originality_after?: number;
  rescue_angle_notes?: string;
  // Phase 2E.1: Discovery metadata from tweet prefiltering
  tweet_type?: 'original' | 'reply' | 'quote' | 'retweet';
  engagement_score?: number;
  discovery_score?: number;
  discovery_reason?: string;
  source_quality_score?: number;
  account_source_quality?: number;
};

export type RejectionDebug = {
  source_author: string;
  source_tweet_url: string;
  source_text_preview: string;
  rejection_reason: string;
  blocked_topic_label?: string;
  why_rejected?: string;
  niche_adjacent?: boolean;
  could_convert_to_operator_heuristic?: boolean;
  what_was_missing?: string;
  publishability_score: number;
  originality_potential_score: number;
  usefulness_score: number;
  niche_fit_score: number;
  content_format?: string;
  recommended_angle: string;
  recommended_angle_preview?: string;
  // Phase 2D.1: Parse failure diagnostics
  parse_failed?: boolean;
  intelligence_error_type?: 'model_call_failed' | 'json_parse_failed' | 'missing_required_fields';
  intelligence_error_message_short?: string;
  raw_model_output_preview?: string;
};

export type RescueDebug = {
  source_author: string;
  source_text_preview: string;
  original_rejection_reason: string;
  before_scores: {
    niche_fit: number;
    originality_potential: number;
    publishability: number;
    usefulness: number;
    evidence_risk: number;
  };
  after_scores: {
    originality_potential: number;
    publishability: number;
  } | null;
  rescue_passed: boolean;
  recommended_angle: string;
};

export type IntelligenceSummary = {
  raw_opportunity_count: number;
  intelligence_evaluated_count: number;
  intelligence_rejected_count: number;
  intelligence_selected_count: number;
  selected_opportunity_scores: { publishability: number; originality_potential: number; niche_fit: number }[];
  top_rejection_reasons: Record<string, number>;
  avg_publishability_score: number;
  avg_originality_potential_score: number;
  sampled_rejection_debug: RejectionDebug[];
  // Phase 2D.1: Parse failure tracking
  intelligence_parse_failed_count: number;
  parse_failure_rate: number;
  // Phase 2D.4: Borderline rescue tracking
  rescue_attempted_count: number;
  rescue_succeeded_count: number;
  rescue_failed_count: number;
  rescued_opportunity_count: number;
  rescue_reasons: string[];
  sampled_rescue_debug: RescueDebug[];
  // Phase 2E.3: Discovery rejection transparency
  rejection_debug_available: boolean;
  blocked_topic_examples: RejectionDebug[];
  generic_only_examples: RejectionDebug[];
  low_originality_examples: RejectionDebug[];
};

// ═══ Niche Model Constants ═══

/**
 * Core positioning: AI, creators, internet culture, productivity,
 * skills, and modern work.
 *
 * These are the topics that @30piq can legitimately speak about
 * with authority and originality.
 */
const ALLOWED_TOPICS = [
  'AI tools',
  'automation',
  'productivity',
  'career growth',
  'learning systems',
  'creator economy',
  'online business',
  'startups',
  'founder/operator workflows',
  'software/product workflows',
  'internet behavior',
  'attention economy',
  'personal leverage',
  'skill-building',
  'tech culture',
];

/**
 * Adjacent topics — allowed ONLY when they support a specific
 * @30piq-relevant angle. Pure adjacent-topic content is rejected.
 *
 * Expanded: also covers tool adoption, product/UX behavior,
 * work leverage, storytelling mechanics, and distribution.
 */
const ALLOWED_ADJACENT_TOPICS: Record<string, string> = {
  'entertainment': 'only if supports audience, brand, storytelling, attention economy, creative strategy, or internet culture insight',
  'sports/boxing': 'only if supports personal brand, leverage, distribution, incentives, or attention economy',
  'anime/comics/movies': 'only if supports storytelling, fandom, audience retention, brand symbols, or creator strategy',
  'internet trends': 'only if supports audience behavior, attention economy, distribution, or internet culture insight',
  'social media behavior': 'only if supports audience retention, attention economy, creator strategy, or distribution',
};

/**
 * Blocked topics — never allowed, regardless of angle.
 */
const BLOCKED_TOPICS = [
  'random jokes',
  'pure celebrity gossip',
  'pure sports reaction',
  'pure anime/comics opinion',
  'pure movie/TV commentary',
  'political controversy',
  'insults/slurs',
  'adult content',
  'tragedy/war exploitation',
  'empty viral bait',
];

// ═══ Topic Patterns for Heuristic Scoring ═══

/**
 * Allowed topic patterns — expanded from niche-alignment.ts.
 * These signal that the opportunity fits the @30piq niche.
 */
const ALLOWED_TOPIC_PATTERNS = [
  // AI / ML
  { pattern: /\b(AI|artificial intelligence|machine learning|ML|deep learning)\b/i, topic: 'AI tools' },
  { pattern: /\b(GPT|LLM|language model|large language model|ChatGPT|Claude|Gemini)\b/i, topic: 'AI tools' },
  { pattern: /\b(prompt|prompting|prompt engineering|RAG|retrieval augmented)\b/i, topic: 'AI tools' },
  { pattern: /\b(agent|AI agent|autonomous agent|AI workflow|AI automation)\b/i, topic: 'AI tools' },
  { pattern: /\b(OpenAI|Anthropic|Hugging Face|Stability|Midjourney)\b/i, topic: 'AI tools' },
  { pattern: /\b(fine.?tun|train.*model|model.*train|embedding|tokenizer)\b/i, topic: 'AI tools' },
  { pattern: /\b(AI.*tool|tool.*AI|AI.*app|app.*AI|AI.*software)\b/i, topic: 'AI tools' },
  { pattern: /\b(neural|transformer|diffusion|generative|foundation model)\b/i, topic: 'AI tools' },
  { pattern: /\b(copilot|cursor|v0|bolt|replit|code.*assist|AI.*code)\b/i, topic: 'AI tools' },

  // Automation / Productivity
  { pattern: /\b(productiv|workflow|automat|efficien|time.?sav|time.?manag)\b/i, topic: 'productivity' },
  { pattern: /\b(Notion|Obsidian|Todoist|Linear|Asana|Trello|Jira)\b/i, topic: 'productivity' },
  { pattern: /\b(automation|zapier|make\.com|n8n|IFTTT|Power Automate)\b/i, topic: 'automation' },
  { pattern: /\b(script|pipeline|CI\/CD|deploy|build tool|devops)\b/i, topic: 'automation' },
  { pattern: /\b(template|framework|system|process|methodology)\b/i, topic: 'productivity' },
  { pattern: /\b(outsource|delegate|batch|focus mode|deep work)\b/i, topic: 'productivity' },

  // Career / Learning / Skills
  { pattern: /\b(career|hire|hiring|job|salary|negotiat|promot|resign)\b/i, topic: 'career growth' },
  { pattern: /\b(resume|CV|portfolio|interview|cover letter)\b/i, topic: 'career growth' },
  { pattern: /\b(skill|upskill|reskill|learn|course|certif|bootcamp)\b/i, topic: 'learning systems' },
  { pattern: /\b(founder|operator|startup|bootstrapped|indie hacker)\b/i, topic: 'startups' },
  { pattern: /\b(remote work|freelanc|solopreneur|creator economy)\b/i, topic: 'creator economy' },
  { pattern: /\b(software engineer|developer|SWE|programmer|tech lead)\b/i, topic: 'career growth' },
  { pattern: /\b(personal leverage|leverage|compounding|asymmetric)\b/i, topic: 'personal leverage' },
  { pattern: /\b(skill.?build|practice|deliberate practice|10x|expert)\b/i, topic: 'skill-building' },

  // Building / Tech / Software
  { pattern: /\b(build|ship|launch|side project|MVP|prototype)\b/i, topic: 'software/product workflows' },
  { pattern: /\b(API|SDK|open source|GitHub|repo|codebase)\b/i, topic: 'software/product workflows' },
  { pattern: /\b(SaaS|B2B|product|feature|user feedback|iterate)\b/i, topic: 'online business' },
  { pattern: /\b(Python|JavaScript|TypeScript|Rust|Go|React|Next\.js|Node)\b/i, topic: 'software/product workflows' },
  { pattern: /\b(no.?code|low.?code|bubble|webflow|framer)\b/i, topic: 'software/product workflows' },

  // Internet culture / Attention economy
  { pattern: /\b(internet culture|online behavior|viral|engagement|algorithm)\b/i, topic: 'internet behavior' },
  { pattern: /\b(attention|attention economy|distraction|focus|dopamine)\b/i, topic: 'attention economy' },
  { pattern: /\b(content strategy|distribution|audience|followers|growth)\b/i, topic: 'creator economy' },
  { pattern: /\b(creator|influencer|monetiz|newsletter|podcast)\b/i, topic: 'creator economy' },
  { pattern: /\b(tech culture|silicon valley|tech bubble|hype cycle)\b/i, topic: 'tech culture' },

  // Expanded: tool adoption / product/UX behavior / work leverage
  { pattern: /\b(tool adoption|adopt.*tool|switch.*tool|try.*tool|tool.*stack|stack.*tool)\b/i, topic: 'software/product workflows' },
  { pattern: /\b(UX|user experience|user behavior|product behavior|product design|interface)\b/i, topic: 'software/product workflows' },
  { pattern: /\b(work leverage|work.*leverag|leverage.*work|output.*input|ROI|return on)\b/i, topic: 'personal leverage' },
  { pattern: /\b(storytelling|narrative|story structure|story arc|plot|hook|cliffhanger)\b/i, topic: 'creator economy' },
  { pattern: /\b(personal brand|brand.*build|brand.*strategy|positioning|niche down)\b/i, topic: 'creator economy' },
  { pattern: /\b(distribution|reach|amplif|shareability|word of mouth|referral)\b/i, topic: 'creator economy' },
];

/**
 * Blocked topic patterns — content that should NEVER be published.
 */
const BLOCKED_TOPIC_PATTERNS = [
  { pattern: /\b(joke|funny|lol|haha|lmao|rofl|memes?\b)/i, topic: 'random jokes' },
  { pattern: /\b(celebrit|gossip|rumor|scandal|divorce|breakup|relationship drama)/i, topic: 'pure celebrity gossip' },
  { pattern: /\b(Kardashian|Taylor Swift|Beyonce|Drake|Kanye|Travis Kelce|Justin Bieber)/i, topic: 'pure celebrity gossip' },
  { pattern: /\b(boxing match|UFC fight|MMA fight|game score|touchdown|home run|slam dunk)/i, topic: 'pure sports reaction' },
  { pattern: /\b(football|soccer|basketball|NBA|NFL|FIFA|World Cup|Premier League)\b(?!.*(?:leverage|brand|distribution|incentive|attention|strategy|creator|audience|personal brand))/i, topic: 'pure sports reaction' },
  { pattern: /\b(One Piece|Naruto|Dragon Ball|Bleach|Jujutsu|Attack on Titan|Demon Slayer|My Hero Academia)\b(?!.*(?:storytelling|fandom|retention|brand|creator|strategy|audience))/i, topic: 'pure anime/comics opinion' },
  { pattern: /\b(Superman|Batman|Avengers|Spider.?Man|Iron Man|comic|comics)\b(?!.*(?:storytelling|fandom|retention|brand|creator|strategy|audience))/i, topic: 'pure anime/comics opinion' },
  { pattern: /\b(movie|film|box office|trailer|Netflix|HBO|streaming|series|TV show)\b(?!.*(?:storytelling|audience|brand|creator|attention|strategy|retention))/i, topic: 'pure movie/TV commentary' },
  { pattern: /\b(politics|election|president|congress|senator|democrat|republican|partisan)/i, topic: 'political controversy' },
  { pattern: /\b(insult|slur|racist|sexist|homophob|bigot)/i, topic: 'insults/slurs' },
  { pattern: /\b(nsfw|porn|nude|explicit|adult|xxx)/i, topic: 'adult content' },
  { pattern: /\b(tragedy|war|mass shooting|terrorist|genocide|massacre)/i, topic: 'tragedy/war exploitation' },
  { pattern: /\b(viral bait|clickbait|rage bait|engagement farming|engagement farm)\b/i, topic: 'empty viral bait' },
];

/**
 * Adjacent topic patterns — allowed ONLY with a legitimate angle.
 * Expanded: also covers internet trends and social media behavior.
 */
const ADJACENT_TOPIC_PATTERNS = [
  {
    pattern: /\b(entertainment|Hollywood|celebrity|pop culture|music industry|streaming wars|content platform)\b/i,
    topic: 'entertainment',
    requiredAngle: 'audience, brand, storytelling, attention economy, creative strategy, or internet culture insight',
  },
  {
    pattern: /\b(boxing|UFC|MMA|fight|sports|athlete|championship|prize fight)\b/i,
    topic: 'sports/boxing',
    requiredAngle: 'personal brand, leverage, distribution, incentives, or attention economy',
  },
  {
    pattern: /\b(anime|manga|comic|superhero|fandom|cosplay|graphic novel|MCU|DCEU)\b/i,
    topic: 'anime/comics/movies',
    requiredAngle: 'storytelling, fandom, audience retention, brand symbols, or creator strategy',
  },
  {
    pattern: /\b(trending|viral trend|internet trend|tiktok trend|social media trend|meme culture|internet phenomenon)\b/i,
    topic: 'internet trends',
    requiredAngle: 'audience behavior, attention economy, distribution, or internet culture insight',
  },
  {
    pattern: /\b(social media|Twitter|X platform|Instagram|TikTok|YouTube|Reddit|LinkedIn)\b/i,
    topic: 'social media behavior',
    requiredAngle: 'audience retention, attention economy, creator strategy, or distribution',
  },
];

// ═══ Hard Rule Thresholds ═══

/**
 * publishability_score threshold for initial selection.
 * Lowered from 7.5 to 7.0 IF originality_potential >= 7.5 and niche_fit >= 5.
 * This allows genuinely original, on-niche opportunities that the AI scored
 * slightly lower on publishability to still get crafted.
 */
const MIN_PUBLISHABILITY_SCORE = 7.5;
const MIN_PUBLISHABILITY_SCORE_WITH_STRONG_ORIGINALITY = 7.0;
const MIN_ORIGINALITY_FOR_PUBLISHABILITY_RELAXATION = 7.5;

const MIN_ORIGINALITY_POTENTIAL_SCORE = 7;
const MIN_NICHE_FIT_SCORE = 5;
const MIN_USEFULNESS_SCORE = 6;

/**
 * If viral_context_score >= 8 and recommended_angle is strong (length >= 30),
 * usefulness can go as low as 5 instead of 6.
 */
const MIN_USEFULNESS_WITH_STRONG_VIRAL = 5;
const STRONG_VIRAL_CONTEXT_THRESHOLD = 8;
const STRONG_ANGLE_LENGTH_THRESHOLD = 30;

// ═══ Phase 2D.4: Borderline Rescue Thresholds ═══

/**
 * Rescue eligibility thresholds for high-niche borderline originality items.
 * These are MORE restrictive than the initial selection thresholds.
 * Rescue is only for items that are close to passing but need a sharper angle.
 */
const RESCUE_MIN_NICHE_FIT = 8;
const RESCUE_MIN_PUBLISHABILITY = 7;
const RESCUE_MIN_USEFULNESS = 6;
const RESCUE_MIN_ORIGINALITY_POTENTIAL = 5.5;
const RESCUE_MIN_RECOMMENDED_ANGLE_LENGTH = 40;
const RESCUE_MIN_EVIDENCE_RISK = 7;
const RESCUE_MIN_SOURCE_TEXT_LENGTH = 60;
const RESCUE_MAX_ATTEMPTS_PER_RUN = 2;

/**
 * Rescue must raise originality_potential_score to at least this to pass.
 */
const RESCUE_MIN_ORIGINALITY_POTENTIAL_AFTER = 7;

// ═══ Canonical Rejection Reasons ═══

/**
 * Canonical rejection reasons — used for diagnostics and tracking.
 *
 * weak_source is reserved for truly empty/low-signal sources only.
 * It should NOT be used as a catch-all fallback.
 */
export const CANONICAL_REJECTION_REASONS = [
  'blocked_topic',
  'low_originality_potential',
  'low_niche_fit',
  'low_usefulness',
  'unsupported_claim_risk',
  'generic_only',
  'no_clear_angle',
  'language_or_context_mismatch',
  'insufficient_context',
  'weak_source',
  'intelligence_parse_failed',
] as const;

export type CanonicalRejectionReason = typeof CANONICAL_REJECTION_REASONS[number];

// ═══ Language Detection ═══

/**
 * Detect if text is primarily Arabic or other non-Latin script
 * that indicates a language/context mismatch for @30piq's audience.
 */
export function isNonLatinDominant(text: string): boolean {
  if (!text || text.length < 5) return false;
  const nonLatin = text.replace(/[A-Za-z0-9\s@#.,!?:;'"()\-_/\\&%$+=\[\]{}|<>~`]/g, '');
  // If more than 40% of characters are non-Latin, consider it non-Latin dominant
  return nonLatin.length / text.length > 0.4;
}

// ═══ Pure Heuristic Functions ═══

/**
 * Quick niche fit scoring using heuristic pattern matching.
 * No AI call needed — used for fast pre-filtering and as
 * supplementary signal in the AI evaluation.
 *
 * Returns:
 * - score: 1-10 niche fit estimate
 * - matched_topics: which allowed topics were found
 * - blocked: whether the text matches blocked patterns
 * - adjacent_with_angle: whether there's a legitimate adjacent angle
 */
export function quickNicheFitScore(text: string): {
  score: number;
  matched_topics: string[];
  blocked: boolean;
  blocked_topic_labels: string[];
  adjacent_with_angle: boolean;
  adjacent_matches: Array<{ topic: string; requiredAngle: string }>;
} {
  if (!text || text.length < 10) {
    return { score: 1, matched_topics: [], blocked: false, blocked_topic_labels: [], adjacent_with_angle: false, adjacent_matches: [] };
  }

  const matchedTopics: string[] = [];
  const blockedTopics: string[] = [];
  const adjacentMatches: Array<{ topic: string; requiredAngle: string }> = [];

  // Check allowed topic patterns
  for (const { pattern, topic } of ALLOWED_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      if (!matchedTopics.includes(topic)) {
        matchedTopics.push(topic);
      }
    }
  }

  // Check blocked topic patterns
  let blocked = false;
  for (const { pattern, topic } of BLOCKED_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      if (!blockedTopics.includes(topic)) {
        blockedTopics.push(topic);
      }
      blocked = true;
    }
  }

  // Check adjacent topic patterns
  for (const { pattern, topic, requiredAngle } of ADJACENT_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      adjacentMatches.push({ topic, requiredAngle });
    }
  }

  // Determine if there's a legitimate adjacent angle
  // An adjacent topic has a legitimate angle if the text ALSO contains
  // signals from the required angle domain
  const adjacentWithAngle = adjacentMatches.length > 0 && adjacentMatches.some(adj => {
    // Check if the text contains signals matching the required angle
    const angleSignals = [
      /\b(audience|brand|storytelling|attention economy|creative strategy|internet culture)\b/i,
      /\b(personal brand|leverage|distribution|incentive|attention)\b/i,
      /\b(fandom|retention|creator strategy|audience retention|brand symbols)\b/i,
      /\b(creator|content strategy|monetiz|growth|distribution|audience)\b/i,
      /\b(marketing|positioning|niche|differentiation)\b/i,
      /\b(behavior|psychology|habit|pattern|trend|signal)\b/i,
      /\b(strategy|system|framework|method|approach)\b/i,
    ];
    return angleSignals.some(signal => signal.test(text));
  });

  // Score calculation
  let score = 4.0; // Start below neutral — must earn its way up

  // Allowed topic boosts
  for (const topic of matchedTopics) {
    switch (topic) {
      case 'AI tools':
        score += 2.0;
        break;
      case 'productivity':
      case 'automation':
        score += 1.5;
        break;
      case 'career growth':
      case 'learning systems':
      case 'creator economy':
      case 'personal leverage':
        score += 1.3;
        break;
      case 'startups':
      case 'online business':
      case 'software/product workflows':
        score += 1.2;
        break;
      case 'internet behavior':
      case 'attention economy':
      case 'skill-building':
      case 'tech culture':
        score += 1.0;
        break;
      default:
        score += 0.5;
    }
  }

  // Adjacent with angle gives a moderate boost (less than core topics)
  if (adjacentWithAngle) {
    score += 0.8;
  }

  // Blocked topics heavily penalize
  if (blocked) {
    score -= 4.0;
  }

  // Clamp to 1-10
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  return {
    score,
    matched_topics: matchedTopics,
    blocked,
    blocked_topic_labels: blockedTopics,
    adjacent_with_angle: adjacentWithAngle,
    adjacent_matches: adjacentMatches,
  };
}

// ═══ Rejection Reason Helper ═══

/**
 * Determine the most specific rejection reason for a brief.
 *
 * Priority order matters: more specific reasons first.
 * Returns one of the canonical rejection reason strings.
 *
 * IMPORTANT: weak_source is reserved for truly empty/low-signal sources.
 * It should NOT be used as a catch-all fallback.
 */
export function determineRejectionReason(brief: OpportunityBrief): string {
  // Check blocked topic first (most severe)
  const heuristic = quickNicheFitScore(brief.source_text);
  if (heuristic.blocked && !heuristic.adjacent_with_angle) {
    return 'blocked_topic';
  }

  // Language or context mismatch — text is primarily non-Latin script
  // (Arabic, etc.) which doesn't match @30piq's English-language audience
  if (isNonLatinDominant(brief.source_text)) {
    return 'language_or_context_mismatch';
  }

  // Weak source — reserved for truly empty/low-signal sources ONLY.
  // This means the source has almost no substantive content.
  // Check early, before other reasons, since a truly empty source
  // shouldn't get a more specific reason.
  if (brief.source_text.length < 15) {
    return 'weak_source';
  }

  // Insufficient context — source is too short or vague to craft from
  if (brief.source_text.length < 30 && brief.core_observation.length < 15) {
    return 'insufficient_context';
  }

  // Low originality potential
  if (brief.originality_potential_score < MIN_ORIGINALITY_POTENTIAL_SCORE) {
    return 'low_originality_potential';
  }

  // Low niche fit (and no legitimate adjacent angle)
  if (brief.niche_fit_score < MIN_NICHE_FIT_SCORE && !heuristic.adjacent_with_angle) {
    return 'low_niche_fit';
  }

  // Low usefulness — the content wouldn't be actionable or specific enough
  if (brief.usefulness_score < MIN_USEFULNESS_SCORE &&
      !(brief.viral_context_score >= STRONG_VIRAL_CONTEXT_THRESHOLD && brief.recommended_angle.length >= STRONG_ANGLE_LENGTH_THRESHOLD)) {
    return 'low_usefulness';
  }

  // Unsupported claims
  if (brief.evidence_risk_score < 4 && brief.do_not_claim.length > 0) {
    return 'unsupported_claim_risk';
  }

  // Generic only — the only possible output is generic commentary
  if (
    brief.usefulness_score < 5 &&
    brief.originality_potential_score < 7 &&
    brief.recommended_angle.length < 20
  ) {
    return 'generic_only';
  }

  // No clear angle — the AI couldn't produce a specific angle
  if (!brief.recommended_angle || brief.recommended_angle.trim().length < 10) {
    return 'no_clear_angle';
  }

  // Default fallback: low_niche_fit (not weak_source)
  return 'low_niche_fit';
}

// ═══ Phase 2E.3: Rejection Debug Builder ═══

/**
 * Build an enriched RejectionDebug from an OpportunityBrief.
 * Includes per-reason detail fields for transparency:
 * - blocked_topic: which blocked topic label, why, niche adjacency
 * - generic_only: why generic, whether convertible to operator heuristic
 * - low_originality_potential: what was missing
 */
export function buildRejectionDebug(brief: OpportunityBrief): RejectionDebug {
  const heuristic = quickNicheFitScore(brief.source_text);
  const reason = brief.rejection_reason || determineRejectionReason(brief);

  const debug: RejectionDebug = {
    source_author: brief.source_author,
    source_tweet_url: brief.source_tweet_url,
    source_text_preview: brief.source_text.slice(0, 200),
    rejection_reason: reason,
    publishability_score: brief.publishability_score,
    originality_potential_score: brief.originality_potential_score,
    usefulness_score: brief.usefulness_score,
    niche_fit_score: brief.niche_fit_score,
    content_format: brief.content_format,
    recommended_angle: brief.recommended_angle,
    recommended_angle_preview: brief.recommended_angle.slice(0, 80),
  };

  // Enrich based on rejection reason
  if (reason === 'blocked_topic') {
    debug.blocked_topic_label = heuristic.blocked_topic_labels.length > 0
      ? heuristic.blocked_topic_labels.join(', ')
      : 'unknown blocked topic';
    debug.why_rejected = `Content matched blocked topic pattern(s): ${debug.blocked_topic_label}`;
    debug.niche_adjacent = heuristic.adjacent_with_angle;
    if (heuristic.adjacent_with_angle) {
      debug.why_rejected += ' (but has adjacent angle potential — still blocked by policy)';
    }
  }

  if (reason === 'generic_only') {
    debug.why_rejected = `Only generic commentary possible: usefulness=${brief.usefulness_score}, originality_potential=${brief.originality_potential_score}, angle_length=${brief.recommended_angle.length}`;
    debug.could_convert_to_operator_heuristic = brief.niche_fit_score >= 5 && brief.source_text.length >= 50;
    if (debug.could_convert_to_operator_heuristic) {
      debug.why_rejected += ' (might be convertible to operator heuristic with angle refinement)';
    }
  }

  if (reason === 'low_originality_potential') {
    debug.why_rejected = `Low originality potential: ${brief.originality_potential_score}/10`;
    if (brief.originality_potential_score < 5) {
      debug.what_was_missing = 'No unique angle, counterintuitive take, or specific expertise possible from this source';
    } else {
      debug.what_was_missing = 'Some angle exists but lacks specificity or counterintuitive element';
    }
  }

  // Add parse failure diagnostics if present
  const anyBrief = brief as any;
  if (anyBrief.parse_failed) {
    debug.parse_failed = true;
    debug.intelligence_error_type = anyBrief.intelligence_error_type;
    debug.intelligence_error_message_short = anyBrief.intelligence_error_message_short;
    debug.raw_model_output_preview = anyBrief.raw_model_output_preview;
  }

  return debug;
}

// ═══ Adjacent Angle Discovery ═══

/**
 * Angle keywords for the "candidate but needs angle" middle path.
 * If a source has engagement signals but no direct AI angle,
 * check if one of these legitimate adjacent angles can be applied.
 */
const ADJACENT_ANGLE_KEYWORDS: Array<{ keywords: RegExp; angle: string }> = [
  { keywords: /\b(creator|influencer|content creator|YouTuber|streamer)\b/i, angle: 'creator strategy — how creators build and retain audiences' },
  { keywords: /\b(brand|personal brand|rebrand|image)\b/i, angle: 'personal brand — the intentional positioning behind public perception' },
  { keywords: /\b(story|narrative|arc|character|plot|hook)\b/i, angle: 'storytelling mechanics — the narrative structures that drive engagement' },
  { keywords: /\b(algorithm|feed|timeline|recommendation|For You)\b/i, angle: 'distribution — how platform algorithms shape what people see' },
  { keywords: /\b(app|tool|platform|feature|update|launch|release)\b/i, angle: 'tool adoption — what the adoption pattern reveals about user behavior' },
  { keywords: /\b(habit|routine|workflow|practice|system|process)\b/i, angle: 'work leverage — how systematic approaches create compounding returns' },
  { keywords: /\b(learn|course|teach|tutorial|skill|master|practice)\b/i, angle: 'learning systems — the methodology behind effective skill acquisition' },
  { keywords: /\b(price|cost|pay|revenue|income|profit|monetiz|business model)\b/i, angle: 'online business — the economic model and incentive structure' },
  { keywords: /\b(viral|trending|going viral|blew up|blew up on|took off)\b/i, angle: 'attention economy — why this captured attention and what it reveals about audience behavior' },
  { keywords: /\b(million|billions?|views?|followers?|subscribers?|downloads?)\b/i, angle: 'distribution — the mechanics of how content reaches massive audiences' },
];

/**
 * Try to discover a legitimate adjacent angle for a source that
 * doesn't have a direct AI/productivity angle but has engagement
 * or behavioral signals.
 *
 * Returns the angle string if found, or null if no honest angle exists.
 * The angle must be HONEST and SUPPORTED by the source text.
 */
export function discoverAdjacentAngle(sourceText: string): string | null {
  if (!sourceText || sourceText.length < 30) return null;

  for (const { keywords, angle } of ADJACENT_ANGLE_KEYWORDS) {
    if (keywords.test(sourceText)) {
      return angle;
    }
  }

  return null;
}

// ═══ AI-Powered Evaluation ═══

/**
 * Build the system prompt for opportunity intelligence evaluation.
 * Includes all niche model rules so the AI can make informed decisions.
 *
 * Key change: The prompt now instructs the AI to look for adjacent angles
 * before rejecting, and to score publishability more generously for
 * sources with strong originality or engagement signals.
 */
function buildIntelligenceSystemPrompt(): string {
  const allowedTopicsStr = ALLOWED_TOPICS.map(t => `- ${t}`).join('\n');
  const adjacentTopicsStr = Object.entries(ALLOWED_ADJACENT_TOPICS)
    .map(([topic, angle]) => `- ${topic} → ${angle}`)
    .join('\n');
  const blockedTopicsStr = BLOCKED_TOPICS.map(t => `- ${t}`).join('\n');

  return `You are an Opportunity Intelligence Analyst for @30piq, an X account focused on AI, creators, internet culture, productivity, skills, and modern work.

Your job: Evaluate a raw opportunity and produce a structured "Opportunity Brief" as JSON. Be honest but not overly strict — aim to select 2-5 genuinely promising opportunities from every 10-20 raw opportunities.

═══ NICHE MODEL RULES ═══

ALLOWED TOPICS (strong niche fit):
${allowedTopicsStr}

ADJACENT TOPICS (allowed ONLY with a legitimate angle):
${adjacentTopicsStr}

BLOCKED TOPICS (never allowed):
${blockedTopicsStr}

═══ EVALUATION RULES ═══

1. NICHE FIT: Score 1-10 how well the opportunity fits the @30piq niche. Core topics = 7-10. Adjacent with clear angle = 5-6. No clear angle = 1-4.

2. ORIGINALITY POTENTIAL: Score 1-10 how much original insight @30piq could add. If the only possible response is "nice" or generic agreement, score 1-3. If there's a unique angle, counterintuitive take, or specific expertise to share, score 7-10.

3. USEFULNESS: Score 1-10 how useful the resulting content would be for @30piq's audience (builders, operators, creators, tech professionals). Actionable + specific = high. Vague + generic = low. A useful observation about internet behavior or audience patterns scores at least 6.

4. EVIDENCE RISK: Score 1-10 (higher = safer) how risky the claims would be. If the source makes unsourced claims that @30piq would need to repeat or endorse, score low. If the claims are self-evident or well-sourced, score high.

5. VIRAL CONTEXT: Score 1-10 the viral potential of the source conversation. High engagement + ongoing discussion = high. Dead conversation = low.

6. PUBLISHABILITY: Score 1-10 the overall likelihood that content crafted from this opportunity would pass all quality gates and be worth publishing. This is your composite judgment. IMPORTANT: If originality_potential >= 7.5 and niche_fit >= 5, a publishability score of 7.0 is acceptable (do not default-reject at 7.0). Score 7.0+ for opportunities with a clear, specific, honest angle.

7. If the source does not support a useful angle for the @30piq niche, reject it. Do NOT force a fake AI angle. BUT: if the source has engagement, behavioral, or internet-culture signals, try to find a legitimate adjacent angle (attention economy, creator strategy, distribution, audience behavior, storytelling mechanics, personal brand, work leverage) BEFORE rejecting.

8. The "do_not_claim" field should list specific claims from the source that @30piq should NOT repeat (unsourced stats, controversial opinions, unverified claims).

9. The "required_context" field should list context that MUST be included for the content to be honest and useful.

10. The "recommended_angle" must be specific and actionable — not "share a thought" or "add perspective". It should describe the EXACT angle @30piq would take. If you can find a legitimate adjacent angle, put it here.

11. "content_format" should be:
    - "reply" if responding directly to the source tweet
    - "quote" if quote-tweeting with added commentary
    - "standalone" if the idea can stand on its own without referencing the source

12. REJECTION REASONS — use ONLY these specific reasons (do NOT use "weak_source" as a catch-all):
    - "blocked_topic" — content is in the blocked list
    - "low_originality_potential" — no original insight possible
    - "low_niche_fit" — does not fit the niche even with adjacent angle
    - "low_usefulness" — content would not be useful to the audience
    - "unsupported_claim_risk" — would require repeating unsourced claims
    - "generic_only" — only generic commentary possible
    - "no_clear_angle" — no specific, actionable angle exists
    - "language_or_context_mismatch" — source language doesn't match audience
    - "insufficient_context" — source is too short or vague
    - "weak_source" — ONLY for truly empty/low-signal sources (< 15 chars)

═══ OUTPUT FORMAT ═══

Return valid JSON only:
{
  "source_summary": "1-2 sentence summary of the source",
  "core_observation": "The key insight or event in the source",
  "why_it_matters": "Why this matters for @30piq's audience",
  "audience_relevance": "Who specifically in the audience would care and why",
  "niche_fit_score": N,
  "originality_potential_score": N,
  "usefulness_score": N,
  "evidence_risk_score": N,
  "viral_context_score": N,
  "publishability_score": N,
  "recommended_angle": "The specific angle @30piq should take (or empty string if no good angle exists)",
  "content_format": "reply" | "quote" | "standalone",
  "do_not_claim": ["claim 1", "claim 2"],
  "required_context": ["context 1"],
  "should_craft": true | false,
  "rejection_reason": "reason or null"
}`;
}

/**
 * AI-powered opportunity evaluation.
 *
 * Uses callModel to evaluate the source text against the niche model
 * and produce a structured OpportunityBrief.
 *
 * After AI evaluation, hard rules are applied:
 * - should_craft = false if publishability_score < 7.5
 *   (EXCEPT: >= 7.0 if originality_potential >= 7.5 and niche_fit >= 5)
 * - should_craft = false if originality_potential_score < 7
 * - should_craft = false if niche_fit_score < 5 unless adjacent_with_angle
 * - should_craft = false if usefulness_score < 6
 *   (EXCEPT: >= 5 if viral_context_score >= 8 and recommended_angle is strong)
 * - should_craft = false if the opportunity requires unsupported claims
 * - should_craft = false if the only possible output is generic commentary
 *
 * These hard rules are enforced AFTER AI evaluation and cannot be overridden.
 */
export async function evaluateOpportunity(opp: Record<string, any>): Promise<OpportunityBrief> {
  const sourceText = String(opp.source_text || opp.text || '');
  const sourceAuthor = String(opp.source_author || opp.author || opp.username || '');
  const sourceTweetUrl = String(opp.source_tweet_url || opp.tweet_url || opp.url || '');
  const type = String(opp.type || 'reply');

  // Pre-flight heuristic check
  const heuristic = quickNicheFitScore(sourceText);

  // If blocked by heuristic, short-circuit immediately (no AI call needed)
  if (heuristic.blocked && !heuristic.adjacent_with_angle) {
    return {
      source_summary: `Blocked topic detected: ${sourceText.slice(0, 100)}`,
      source_text: sourceText,
      source_author: sourceAuthor,
      source_tweet_url: sourceTweetUrl,
      type,
      core_observation: '',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: Math.max(1, heuristic.score),
      originality_potential_score: 1,
      usefulness_score: 1,
      evidence_risk_score: 10,
      viral_context_score: 1,
      publishability_score: 1,
      recommended_angle: '',
      content_format: 'reply',
      do_not_claim: ['All claims from blocked topic source'],
      required_context: [],
      should_craft: false,
      rejection_reason: 'blocked_topic',
      // Phase 2E.1: Copy discovery metadata from opportunity input
      tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
      engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
      discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
      discovery_reason: opp.discovery_reason || undefined,
      source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
      account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
    };
  }

  // Language mismatch pre-flight: if source is primarily non-Latin script,
  // short-circuit with language_or_context_mismatch (no AI call needed)
  if (isNonLatinDominant(sourceText) && heuristic.matched_topics.length === 0) {
    return {
      source_summary: `Non-Latin dominant source: ${sourceText.slice(0, 100)}`,
      source_text: sourceText,
      source_author: sourceAuthor,
      source_tweet_url: sourceTweetUrl,
      type,
      core_observation: '',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: Math.max(1, heuristic.score),
      originality_potential_score: 1,
      usefulness_score: 1,
      evidence_risk_score: 10,
      viral_context_score: 1,
      publishability_score: 1,
      recommended_angle: '',
      content_format: 'reply',
      do_not_claim: ['Source is in non-Latin script'],
      required_context: [],
      should_craft: false,
      rejection_reason: 'language_or_context_mismatch',
      // Phase 2E.1: Copy discovery metadata from opportunity input
      tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
      engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
      discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
      discovery_reason: opp.discovery_reason || undefined,
      source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
      account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
    };
  }

  // AI evaluation
  try {
    const aiResponse = await callModel('opportunity_intelligence' as TaskType, [
      {
        role: 'system',
        content: buildIntelligenceSystemPrompt(),
      },
      {
        role: 'user',
        content: `Evaluate this opportunity for @30piq:

Source text: "${sourceText.slice(0, 600)}"
Source author: @${sourceAuthor}
Source URL: ${sourceTweetUrl}
Opportunity type: ${type}
Heuristic niche fit: ${heuristic.score}/10
Heuristic matched topics: ${heuristic.matched_topics.join(', ') || 'none'}
Heuristic adjacent with angle: ${heuristic.adjacent_with_angle}

Produce the Opportunity Brief JSON now.`,
      },
    ], {
      temperature: 0.05,
      max_tokens: 2600,
      response_format: { type: 'json_object' },
    });

    // Phase 2D.1: Robust JSON parsing with required field validation
    let parsed: any;
    try {
      parsed = parseModelJson(aiResponse);
    } catch (parseErr: any) {
      // JSON parse failed — return intelligence_parse_failed, NOT insufficient_context
      console.error(`[opportunity-intelligence] JSON parse failed for @${sourceAuthor}: ${parseErr?.message || 'unknown'}`);
      return {
        source_summary: `Intelligence parse failed: json_parse_failed`,
        source_text: sourceText,
        source_author: sourceAuthor,
        source_tweet_url: sourceTweetUrl,
        type,
        core_observation: '',
        why_it_matters: '',
        audience_relevance: '',
        niche_fit_score: Math.max(1, heuristic.score),
        originality_potential_score: 1,
        usefulness_score: 1,
        evidence_risk_score: 10,
        viral_context_score: 1,
        publishability_score: 1,
        recommended_angle: '',
        content_format: 'reply',
        do_not_claim: [],
        required_context: [],
        should_craft: false,
        rejection_reason: 'intelligence_parse_failed',
        parse_failed: true,
        intelligence_error_type: 'json_parse_failed' as const,
        intelligence_error_message_short: (parseErr?.message || 'unknown').slice(0, 100),
        raw_model_output_preview: (aiResponse || '').slice(0, 200),
        // Phase 2E.1: Copy discovery metadata from opportunity input
        tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
        engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
        discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
        discovery_reason: opp.discovery_reason || undefined,
        source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
        account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
      };
    }

    // Phase 2D.1: Validate required score fields after parsing
    // If any critical score field is missing, treat as intelligence_parse_failed
    const REQUIRED_SCORE_FIELDS = [
      'niche_fit_score',
      'originality_potential_score',
      'usefulness_score',
      'evidence_risk_score',
      'viral_context_score',
      'publishability_score',
      'recommended_angle',
      'should_craft',
    ];
    const missingFields = REQUIRED_SCORE_FIELDS.filter(f => parsed[f] === undefined || parsed[f] === null);
    if (missingFields.length > 0) {
      console.error(`[opportunity-intelligence] Missing required fields for @${sourceAuthor}: ${missingFields.join(', ')}`);
      return {
        source_summary: `Intelligence parse failed: missing_required_fields (${missingFields.join(', ')})`,
        source_text: sourceText,
        source_author: sourceAuthor,
        source_tweet_url: sourceTweetUrl,
        type,
        core_observation: '',
        why_it_matters: '',
        audience_relevance: '',
        niche_fit_score: Math.max(1, heuristic.score),
        originality_potential_score: 1,
        usefulness_score: 1,
        evidence_risk_score: 10,
        viral_context_score: 1,
        publishability_score: 1,
        recommended_angle: '',
        content_format: 'reply',
        do_not_claim: [],
        required_context: [],
        should_craft: false,
        rejection_reason: 'intelligence_parse_failed',
        parse_failed: true,
        intelligence_error_type: 'missing_required_fields' as const,
        intelligence_error_message_short: `Missing: ${missingFields.join(', ')}`,
        raw_model_output_preview: (aiResponse || '').slice(0, 200),
        // Phase 2E.1: Copy discovery metadata from opportunity input
        tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
        engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
        discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
        discovery_reason: opp.discovery_reason || undefined,
        source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
        account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
      };
    }

    // Build the brief from AI response, with clamping and defaults
    const brief: OpportunityBrief = {
      source_summary: String(parsed.source_summary || '').slice(0, 300),
      source_text: sourceText,
      source_author: sourceAuthor,
      source_tweet_url: sourceTweetUrl,
      type,
      core_observation: String(parsed.core_observation || ''),
      why_it_matters: String(parsed.why_it_matters || ''),
      audience_relevance: String(parsed.audience_relevance || ''),
      niche_fit_score: clampScore(parsed.niche_fit_score),
      originality_potential_score: clampScore(parsed.originality_potential_score),
      usefulness_score: clampScore(parsed.usefulness_score),
      evidence_risk_score: clampScore(parsed.evidence_risk_score),
      viral_context_score: clampScore(parsed.viral_context_score),
      publishability_score: clampScore(parsed.publishability_score),
      recommended_angle: String(parsed.recommended_angle || ''),
      content_format: validateContentFormat(parsed.content_format),
      do_not_claim: Array.isArray(parsed.do_not_claim)
        ? parsed.do_not_claim.map(String)
        : [],
      required_context: Array.isArray(parsed.required_context)
        ? parsed.required_context.map(String)
        : [],
      should_craft: Boolean(parsed.should_craft),
      rejection_reason: parsed.rejection_reason || undefined,
      // Phase 2E.1: Copy discovery metadata from opportunity input
      tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
      engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
      discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
      discovery_reason: opp.discovery_reason || undefined,
      source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
      account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
    };

    // ═══ Apply hard rules AFTER AI evaluation ═══
    // These cannot be overridden by the AI.

    // Hard rule 1: publishability_score threshold
    // Standard: < 7.5 → reject
    // Relaxed: < 7.0 → reject even with strong originality
    // Between 7.0-7.4: allowed IF originality_potential >= 7.5 AND niche_fit >= 5
    if (brief.publishability_score < MIN_PUBLISHABILITY_SCORE_WITH_STRONG_ORIGINALITY) {
      // Below 7.0 — always reject
      brief.should_craft = false;
      brief.rejection_reason = determineRejectionReason(brief);
    } else if (brief.publishability_score < MIN_PUBLISHABILITY_SCORE) {
      // Between 7.0 and 7.4 — allow only with strong originality + niche fit
      if (brief.originality_potential_score >= MIN_ORIGINALITY_FOR_PUBLISHABILITY_RELAXATION && brief.niche_fit_score >= MIN_NICHE_FIT_SCORE) {
        // Allow through — the originality and niche fit compensate
      } else {
        brief.should_craft = false;
        brief.rejection_reason = determineRejectionReason(brief);
      }
    }

    // Hard rule 2: originality_potential_score < 7 → reject
    if (brief.originality_potential_score < MIN_ORIGINALITY_POTENTIAL_SCORE) {
      brief.should_craft = false;
      brief.rejection_reason = determineRejectionReason(brief);
    }

    // Hard rule 3: niche_fit_score < 5 unless adjacent_with_angle → reject
    if (brief.niche_fit_score < MIN_NICHE_FIT_SCORE && !heuristic.adjacent_with_angle) {
      // Middle path: try to discover an adjacent angle before rejecting
      const discoveredAngle = discoverAdjacentAngle(sourceText);
      if (discoveredAngle && brief.recommended_angle.length < 10) {
        brief.recommended_angle = discoveredAngle;
        // Don't reject — the discovered angle gives it a niche path
      } else if (!discoveredAngle) {
        brief.should_craft = false;
        brief.rejection_reason = determineRejectionReason(brief);
      }
      // If adjacent_with_angle from heuristic OR discovered angle, allow through
    }

    // Hard rule 4: usefulness_score threshold
    // Standard: < 6 → reject
    // Relaxed: >= 5 if viral_context >= 8 and recommended_angle is strong
    if (brief.usefulness_score < MIN_USEFULNESS_SCORE) {
      const hasStrongViralAngle = brief.viral_context_score >= STRONG_VIRAL_CONTEXT_THRESHOLD &&
        brief.recommended_angle.length >= STRONG_ANGLE_LENGTH_THRESHOLD;
      if (brief.usefulness_score >= MIN_USEFULNESS_WITH_STRONG_VIRAL && hasStrongViralAngle) {
        // Allow — viral context + strong angle compensates for lower usefulness
      } else {
        brief.should_craft = false;
        brief.rejection_reason = determineRejectionReason(brief);
      }
    }

    // Hard rule 5: unsupported claims risk → reject
    if (brief.evidence_risk_score < 4 && brief.do_not_claim.length >= 2) {
      brief.should_craft = false;
      brief.rejection_reason = 'unsupported_claim_risk';
    }

    // Hard rule 6: generic only → reject
    // The only possible output is generic commentary (no specific angle possible)
    if (
      brief.usefulness_score < 5 &&
      brief.originality_potential_score < 7 &&
      (!brief.recommended_angle || brief.recommended_angle.trim().length < 20)
    ) {
      brief.should_craft = false;
      brief.rejection_reason = 'generic_only';
    }

    // Middle path: if still rejected but has engagement signals and no recommended_angle,
    // try to discover an adjacent angle one more time
    if (!brief.should_craft &&
        brief.rejection_reason !== 'blocked_topic' &&
        brief.rejection_reason !== 'unsupported_claim_risk' &&
        brief.rejection_reason !== 'language_or_context_mismatch' &&
        (!brief.recommended_angle || brief.recommended_angle.trim().length < 10) &&
        brief.viral_context_score >= 5) {
      const discoveredAngle = discoverAdjacentAngle(sourceText);
      if (discoveredAngle) {
        brief.recommended_angle = discoveredAngle;
        // Re-evaluate: does the discovered angle change the decision?
        if (brief.originality_potential_score >= MIN_ORIGINALITY_POTENTIAL_SCORE &&
            brief.publishability_score >= MIN_PUBLISHABILITY_SCORE_WITH_STRONG_ORIGINALITY &&
            brief.niche_fit_score >= MIN_NICHE_FIT_SCORE) {
          brief.should_craft = true;
          brief.rejection_reason = undefined;
        }
      }
    }

    return brief;

  } catch (err: any) {
    // Phase 2D.1: AI model call failed — return intelligence_parse_failed, NOT insufficient_context
    // This is the model call itself failing (network error, API error, timeout, etc.)
    // Do NOT allow the opportunity through without evaluation
    const errorMsg = (err?.message || 'unknown').slice(0, 100);
    console.error(`[opportunity-intelligence] AI model call failed for @${sourceAuthor}: ${errorMsg}`);

    return {
      source_summary: `Intelligence parse failed: model_call_failed`,
      source_text: sourceText,
      source_author: sourceAuthor,
      source_tweet_url: sourceTweetUrl,
      type,
      core_observation: '',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: Math.max(1, heuristic.score),
      originality_potential_score: 1,
      usefulness_score: 1,
      evidence_risk_score: 10,
      viral_context_score: 1,
      publishability_score: 1,
      recommended_angle: '',
      content_format: 'reply',
      do_not_claim: [],
      required_context: [],
      should_craft: false,
      rejection_reason: 'intelligence_parse_failed',
      parse_failed: true,
      intelligence_error_type: 'model_call_failed' as const,
      intelligence_error_message_short: errorMsg,
      // Phase 2E.1: Copy discovery metadata from opportunity input
      tweet_type: opp.tweet_type as 'original' | 'reply' | 'quote' | 'retweet' | undefined,
      engagement_score: typeof opp.engagement_score === 'number' ? opp.engagement_score : undefined,
      discovery_score: typeof opp.discovery_score === 'number' ? opp.discovery_score : undefined,
      discovery_reason: opp.discovery_reason || undefined,
      source_quality_score: typeof opp.source_quality_score === 'number' ? opp.source_quality_score : undefined,
      account_source_quality: typeof opp.account_source_quality === 'number' ? opp.account_source_quality : undefined,
    };
  }
}

// ═══ Phase 2D.4: Borderline Rescue ═══

/**
 * Rescue result returned by the rescue model call.
 */
export type RescueEvaluationResult = {
  rescue_passed: boolean;
  originality_potential_score: number;
  publishability_score: number;
  recommended_angle: string;
  why_this_is_now_original: string;
  do_not_claim: string[];
  required_context: string[];
};

/**
 * Check if a rejected brief is eligible for borderline rescue.
 *
 * Eligible rescue candidates must meet ALL of the following:
 * - rejection_reason === 'low_originality_potential'
 * - niche_fit_score >= 8
 * - publishability_score >= 7
 * - usefulness_score >= 6
 * - originality_potential_score >= 5.5
 * - recommended_angle length >= 40
 * - not parse_failed
 * - not blocked topic
 * - evidence_risk_score >= 7
 * - source_text length >= 60
 *
 * Excluded rejection reasons (never rescued):
 * - blocked_topic
 * - generic_only
 * - unsupported_claim_risk
 * - intelligence_parse_failed
 */
export function isEligibleForRescue(brief: OpportunityBrief): boolean {
  // Must have been rejected with low_originality_potential
  if (brief.rejection_reason !== 'low_originality_potential') {
    return false;
  }

  // Not eligible if parse failed
  if ((brief as any).parse_failed === true) {
    return false;
  }

  // Not eligible if blocked topic
  const heuristic = quickNicheFitScore(brief.source_text);
  if (heuristic.blocked && !heuristic.adjacent_with_angle) {
    return false;
  }

  // Score thresholds
  if (brief.niche_fit_score < RESCUE_MIN_NICHE_FIT) return false;
  if (brief.publishability_score < RESCUE_MIN_PUBLISHABILITY) return false;
  if (brief.usefulness_score < RESCUE_MIN_USEFULNESS) return false;
  if (brief.originality_potential_score < RESCUE_MIN_ORIGINALITY_POTENTIAL) return false;
  if (brief.evidence_risk_score < RESCUE_MIN_EVIDENCE_RISK) return false;

  // Must have a meaningful recommended angle
  if (!brief.recommended_angle || brief.recommended_angle.length < RESCUE_MIN_RECOMMENDED_ANGLE_LENGTH) return false;

  // Must have enough source text to work with
  if (!brief.source_text || brief.source_text.length < RESCUE_MIN_SOURCE_TEXT_LENGTH) return false;

  return true;
}

/**
 * Build the rescue evaluation system prompt.
 * This is a second-pass evaluation specifically designed to find a sharper angle
 * for borderline originality items that are otherwise high-quality.
 */
function buildRescueSystemPrompt(): string {
  return `You are an Opportunity Rescue Analyst for @30piq, an X account focused on AI, creators, internet culture, productivity, skills, and modern work.

You previously rejected an opportunity because its originality was borderline. Your task now: try to find a sharper, non-obvious operator/builder angle that makes this worth crafting.

If you CANNOT find a genuinely sharper angle, reject it. Do not pass generic commentary.

═══ RULES ═══

1. The original angle was too generic or obvious. You must find a MATERIALLY DIFFERENT angle — not just rephrase the same take.

2. Valid rescue angles include:
   - Talent migration as a leading indicator (who is moving where, and what it signals)
   - Incentive structure analysis (what incentives are driving behavior, and what breaks)
   - Second-order effects (what happens downstream that nobody is talking about)
   - Operator/playbook framing (specific action steps from a general trend)
   - Counter-signal analysis (why the obvious take is wrong or incomplete)
   - Cross-domain pattern matching (applying a framework from one domain to another)

3. INVALID rescue angles (will be rejected):
   - Repeating the original angle with different words
   - Generic contrarianism ("actually this is bad/good")
   - Vague "implications" without specifics
   - Fake contrarianism that just agrees from a different starting point

4. No unsupported claims. Do not invent statistics, studies, or facts.

5. originality_potential_score must be >= 7 for rescue to pass.

6. recommended_angle must be specific and actionable — describe the EXACT angle @30piq would take.

═══ OUTPUT FORMAT ═══

Return valid JSON only:
{
  "rescue_passed": boolean,
  "originality_potential_score": number,
  "publishability_score": number,
  "recommended_angle": "string — the new, sharper angle",
  "why_this_is_now_original": "string — explain why this angle is materially different from the common take",
  "do_not_claim": ["claims that must not be repeated"],
  "required_context": ["context that must be included"]
}`;
}

/**
 * Evaluate a borderline candidate for rescue using a second AI call.
 *
 * This is only called when:
 * - selectedBriefs.length === 0
 * - The candidate is eligible for rescue (isEligibleForRescue returns true)
 *
 * Returns the rescue evaluation result, or null if the AI call fails.
 */
export async function evaluateRescueCandidate(
  brief: OpportunityBrief
): Promise<RescueEvaluationResult | null> {
  try {
    const response = await callModel('opportunity_intelligence' as TaskType, [
      {
        role: 'system',
        content: buildRescueSystemPrompt(),
      },
      {
        role: 'user',
        content: `You previously rejected this opportunity because originality was borderline. Try to find a sharper, non-obvious operator/builder angle. If you cannot, reject it. Do not pass generic commentary.

Source text: "${brief.source_text.slice(0, 600)}"
Source author: @${brief.source_author}
Original recommended_angle: "${brief.recommended_angle}"
Original scores: niche_fit=${brief.niche_fit_score}, originality_potential=${brief.originality_potential_score}, publishability=${brief.publishability_score}, usefulness=${brief.usefulness_score}, evidence_risk=${brief.evidence_risk_score}

Return the rescue evaluation JSON now.`,
      },
    ], {
      temperature: 0.12,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });

    let parsed: any;
    try {
      parsed = parseModelJson(response);
    } catch {
      console.warn(`[opportunity-intelligence] Rescue JSON parse failed for @${brief.source_author}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Validate required fields
    if (typeof parsed.rescue_passed !== 'boolean') return null;
    if (typeof parsed.originality_potential_score !== 'number') return null;
    if (typeof parsed.publishability_score !== 'number') return null;
    if (typeof parsed.recommended_angle !== 'string') return null;
    if (typeof parsed.why_this_is_now_original !== 'string') return null;

    const result: RescueEvaluationResult = {
      rescue_passed: parsed.rescue_passed && parsed.originality_potential_score >= RESCUE_MIN_ORIGINALITY_POTENTIAL_AFTER,
      originality_potential_score: clampScore(parsed.originality_potential_score),
      publishability_score: clampScore(parsed.publishability_score),
      recommended_angle: String(parsed.recommended_angle || ''),
      why_this_is_now_original: String(parsed.why_this_is_now_original || ''),
      do_not_claim: Array.isArray(parsed.do_not_claim) ? parsed.do_not_claim.map(String) : [],
      required_context: Array.isArray(parsed.required_context) ? parsed.required_context.map(String) : [],
    };

    // Additional validation: if the new angle is basically the same as the original, reject
    if (result.rescue_passed && brief.recommended_angle.length >= 10) {
      const originalWords = brief.recommended_angle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
      const newWords = result.recommended_angle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
      if (originalWords.length > 0 && newWords.length > 0) {
        const overlap = newWords.filter(w => originalWords.includes(w)).length;
        const overlapRatio = overlap / Math.max(newWords.length, 1);
        // If >80% of significant words are the same, the angle is not materially different
        if (overlapRatio > 0.8) {
          console.log(`[opportunity-intelligence] Rescue rejected: angle not materially different (${(overlapRatio * 100).toFixed(0)}% overlap) for @${brief.source_author}`);
          result.rescue_passed = false;
        }
      }
    }

    return result;
  } catch (err: any) {
    console.warn(`[opportunity-intelligence] Rescue evaluation failed for @${brief.source_author}: ${(err?.message || 'unknown').slice(0, 200)}`);
    return null;
  }
}

// ═══ Batch Evaluation ═══

/**
 * Evaluate a batch of opportunities and produce OpportunityBriefs.
 *
 * After initial evaluation, if selectedBriefs.length === 0, runs a
 * borderline rescue pass for high-niche items rejected only for
 * low_originality_potential (Phase 2D.4).
 *
 * Returns:
 * - briefs: All evaluated briefs (both selected and rejected)
 * - summary: Statistics about the evaluation run
 */
export async function evaluateOpportunities(
  opportunities: Record<string, any>[]
): Promise<{ briefs: OpportunityBrief[]; summary: IntelligenceSummary }> {
  const emptySummary: IntelligenceSummary = {
    raw_opportunity_count: 0,
    intelligence_evaluated_count: 0,
    intelligence_rejected_count: 0,
    intelligence_selected_count: 0,
    selected_opportunity_scores: [],
    top_rejection_reasons: {},
    avg_publishability_score: 0,
    avg_originality_potential_score: 0,
    sampled_rejection_debug: [],
    intelligence_parse_failed_count: 0,
    parse_failure_rate: 0,
    rescue_attempted_count: 0,
    rescue_succeeded_count: 0,
    rescue_failed_count: 0,
    rescued_opportunity_count: 0,
    rescue_reasons: [],
    sampled_rescue_debug: [],
    // Phase 2E.3: Discovery rejection transparency
    rejection_debug_available: false,
    blocked_topic_examples: [],
    generic_only_examples: [],
    low_originality_examples: [],
  };

  if (!opportunities?.length) {
    return { briefs: [], summary: emptySummary };
  }

  const briefs: OpportunityBrief[] = [];
  const rejectionReasons: Record<string, number> = {};

  // Evaluate each opportunity
  for (const opp of opportunities) {
    const brief = await evaluateOpportunity(opp);
    briefs.push(brief);

    // Track rejection reasons
    if (!brief.should_craft && brief.rejection_reason) {
      rejectionReasons[brief.rejection_reason] = (rejectionReasons[brief.rejection_reason] || 0) + 1;
    }
  }

  // Compute summary statistics
  const evaluatedCount = briefs.length;
  let rejectedCount = briefs.filter(b => !b.should_craft).length;
  let selectedCount = briefs.filter(b => b.should_craft).length;

  // Phase 2D.4: Borderline rescue — only when selectedBriefs === 0
  let rescueAttemptedCount = 0;
  let rescueSucceededCount = 0;
  let rescueFailedCount = 0;
  const rescueReasons: string[] = [];
  const rescueDebugEntries: RescueDebug[] = [];

  const selectedBriefs = briefs.filter(b => b.should_craft);

  if (selectedBriefs.length === 0) {
    // Find eligible rescue candidates
    const rescueCandidates = briefs.filter(b => !b.should_craft && isEligibleForRescue(b));

    if (rescueCandidates.length > 0) {
      console.log(`[opportunity-intelligence] No selected opportunities. Found ${rescueCandidates.length} borderline rescue candidate(s). Attempting up to ${RESCUE_MAX_ATTEMPTS_PER_RUN}.`);

      // Sort by originality_potential_score descending (best candidates first)
      rescueCandidates.sort((a, b) => b.originality_potential_score - a.originality_potential_score);

      // Attempt rescue on up to RESCUE_MAX_ATTEMPTS_PER_RUN candidates
      const candidatesToAttempt = rescueCandidates.slice(0, RESCUE_MAX_ATTEMPTS_PER_RUN);

      for (const candidate of candidatesToAttempt) {
        rescueAttemptedCount++;

        const rescueResult = await evaluateRescueCandidate(candidate);

        if (rescueResult && rescueResult.rescue_passed) {
          // Rescue succeeded — flip should_craft
          const originalRejectionReason = candidate.rejection_reason || 'low_originality_potential';
          const originalityBefore = candidate.originality_potential_score;

          candidate.should_craft = true;
          candidate.rejection_reason = undefined;
          candidate.rescue_applied = true;
          candidate.rescue_reason = 'borderline_low_originality';
          candidate.original_rejection_reason = originalRejectionReason;
          candidate.rescue_originality_before = originalityBefore;
          candidate.rescue_originality_after = rescueResult.originality_potential_score;
          candidate.rescue_angle_notes = rescueResult.why_this_is_now_original;

          // Update scores from rescue evaluation
          candidate.originality_potential_score = rescueResult.originality_potential_score;
          candidate.publishability_score = rescueResult.publishability_score;

          // Update recommended angle to the new sharper angle
          if (rescueResult.recommended_angle && rescueResult.recommended_angle.length >= 10) {
            candidate.recommended_angle = rescueResult.recommended_angle;
          }

          // Merge do_not_claim and required_context
          if (rescueResult.do_not_claim.length > 0) {
            candidate.do_not_claim = [...new Set([...candidate.do_not_claim, ...rescueResult.do_not_claim])];
          }
          if (rescueResult.required_context.length > 0) {
            candidate.required_context = [...new Set([...candidate.required_context, ...rescueResult.required_context])];
          }

          rescueSucceededCount++;
          rescueReasons.push(`rescued:${candidate.source_author}:borderline_low_originality`);

          rescueDebugEntries.push({
            source_author: candidate.source_author,
            source_text_preview: candidate.source_text.slice(0, 120),
            original_rejection_reason: originalRejectionReason,
            before_scores: {
              niche_fit: candidate.niche_fit_score,
              originality_potential: originalityBefore,
              publishability: candidate.publishability_score,
              usefulness: candidate.usefulness_score,
              evidence_risk: candidate.evidence_risk_score,
            },
            after_scores: {
              originality_potential: rescueResult.originality_potential_score,
              publishability: rescueResult.publishability_score,
            },
            rescue_passed: true,
            recommended_angle: rescueResult.recommended_angle,
          });

          // Update counts
          selectedCount++;
          rejectedCount--;

          console.log(`[opportunity-intelligence] Rescue SUCCEEDED for @${candidate.source_author}: originality ${originalityBefore} → ${rescueResult.originality_potential_score}, angle: ${rescueResult.recommended_angle.slice(0, 80)}`);
        } else {
          // Rescue failed
          rescueFailedCount++;
          rescueReasons.push(`rescue_failed:${candidate.source_author}:angle_not_sharper`);

          rescueDebugEntries.push({
            source_author: candidate.source_author,
            source_text_preview: candidate.source_text.slice(0, 120),
            original_rejection_reason: candidate.rejection_reason || 'unknown',
            before_scores: {
              niche_fit: candidate.niche_fit_score,
              originality_potential: candidate.originality_potential_score,
              publishability: candidate.publishability_score,
              usefulness: candidate.usefulness_score,
              evidence_risk: candidate.evidence_risk_score,
            },
            after_scores: rescueResult ? {
              originality_potential: rescueResult.originality_potential_score,
              publishability: rescueResult.publishability_score,
            } : null,
            rescue_passed: false,
            recommended_angle: rescueResult?.recommended_angle || '',
          });

          console.log(`[opportunity-intelligence] Rescue FAILED for @${candidate.source_author}: could not find sharper angle`);
        }
      }
    } else {
      console.log(`[opportunity-intelligence] No selected opportunities and no eligible rescue candidates.`);
    }
  }

  // Recompute after potential rescue
  const finalSelectedBriefs = briefs.filter(b => b.should_craft);
  const selectedOpportunityScores = finalSelectedBriefs.map(b => ({
    publishability: b.publishability_score,
    originality_potential: b.originality_potential_score,
    niche_fit: b.niche_fit_score,
  }));

  // Average scores across ALL evaluated (not just selected)
  const avgPublishability = evaluatedCount > 0
    ? Math.round((briefs.reduce((sum, b) => sum + b.publishability_score, 0) / evaluatedCount) * 10) / 10
    : 0;
  const avgOriginalityPotential = evaluatedCount > 0
    ? Math.round((briefs.reduce((sum, b) => sum + b.originality_potential_score, 0) / evaluatedCount) * 10) / 10
    : 0;

  // Sort rejection reasons by frequency (top reasons first)
  const topRejectionReasons: Record<string, number> = {};
  const sortedReasons = Object.entries(rejectionReasons)
    .sort(([, a], [, b]) => b - a);
  for (const [reason, count] of sortedReasons) {
    topRejectionReasons[reason] = count;
  }

  // Phase 2D.1: Track parse failures for diagnostics
  const parseFailedCount = briefs.filter((b: any) => b.parse_failed === true || b.rejection_reason === 'intelligence_parse_failed').length;
  const parseFailureRate = evaluatedCount > 0 ? Math.round((parseFailedCount / evaluatedCount) * 100) / 100 : 0;

  if (parseFailureRate > 0.5) {
    console.warn(`[opportunity-intelligence] Parse failure rate high: ${parseFailureRate} (${parseFailedCount}/${evaluatedCount})`);
  }

  // Phase 2E.3: Build enriched rejection debug using buildRejectionDebug
  // (up to 10 items for full transparency)
  const rejectedBriefs = briefs.filter(b => !b.should_craft);
  const allRejectionDebug = rejectedBriefs.map(b => buildRejectionDebug(b));
  const sampledRejectionDebug = allRejectionDebug.slice(0, 10);

  // Phase 2E.3: Per-reason examples for task-level diagnostics
  const blockedTopicExamples = allRejectionDebug
    .filter(d => d.rejection_reason === 'blocked_topic')
    .slice(0, 5);
  const genericOnlyExamples = allRejectionDebug
    .filter(d => d.rejection_reason === 'generic_only')
    .slice(0, 5);
  const lowOriginalityExamples = allRejectionDebug
    .filter(d => d.rejection_reason === 'low_originality_potential')
    .slice(0, 5);

  const rejectionDebugAvailable = allRejectionDebug.length > 0;

  return {
    briefs,
    summary: {
      raw_opportunity_count: opportunities.length,
      intelligence_evaluated_count: evaluatedCount,
      intelligence_rejected_count: rejectedCount,
      intelligence_selected_count: selectedCount,
      selected_opportunity_scores: selectedOpportunityScores,
      top_rejection_reasons: topRejectionReasons,
      avg_publishability_score: avgPublishability,
      avg_originality_potential_score: avgOriginalityPotential,
      sampled_rejection_debug: sampledRejectionDebug,
      intelligence_parse_failed_count: parseFailedCount,
      parse_failure_rate: parseFailureRate,
      // Phase 2D.4: Rescue diagnostics
      rescue_attempted_count: rescueAttemptedCount,
      rescue_succeeded_count: rescueSucceededCount,
      rescue_failed_count: rescueFailedCount,
      rescued_opportunity_count: rescueSucceededCount,
      rescue_reasons: rescueReasons,
      sampled_rescue_debug: rescueDebugEntries.slice(0, 3),
      // Phase 2E.3: Discovery rejection transparency
      rejection_debug_available: rejectionDebugAvailable,
      blocked_topic_examples: blockedTopicExamples,
      generic_only_examples: genericOnlyExamples,
      low_originality_examples: lowOriginalityExamples,
    },
  };
}

// ═══ Utility Functions ═══

/**
 * Clamp a score to 1-10 range.
 * Handles NaN, Infinity, and out-of-range values.
 */
function clampScore(value: any): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.min(10, Math.round(num * 10) / 10));
}

/**
 * Validate content_format field from AI response.
 * Only 'reply', 'quote', or 'standalone' are allowed.
 */
function validateContentFormat(value: any): 'reply' | 'quote' | 'standalone' {
  const valid = ['reply', 'quote', 'standalone'];
  if (typeof value === 'string' && valid.includes(value)) {
    return value as 'reply' | 'quote' | 'standalone';
  }
  return 'reply'; // Default to reply (safest/most common)
}
