/**
 * niche-alignment.ts — Phase 2C / S1.3: Account Lens Alignment for @30piq
 *
 * Phase S1.3: Broadened from "AI × productivity × career growth" to
 * "Account Growth Lens" — AI-native operators, builders, productivity,
 * digital leverage, career growth, tools, creator growth, internet business,
 * and useful digital culture.
 *
 * The account can cover broader high-engagement topics when they have a
 * clear transferable angle for builders/operators/creators/AI-native workers.
 * Entertainment/sports/crypto/politics are NOT automatically rejected if
 * there is a concrete transferable operator/builder/creator lesson.
 *
 * What IS still rejected:
 * - Pure gossip, pure fandom, pure sports commentary
 * - Pure political ragebait
 * - Pure price speculation
 * - Memes with no transferable insight
 * - Forced/generic AI angles on unrelated topics
 *
 * This module provides:
 * 1. Heuristic account lens scoring (1-10, no AI call needed)
 * 2. Transferable angle detection
 * 3. Forced angle detection
 * 4. Off-lens detection with explicit reason tracking
 * 5. A guard that marks off-lens opportunities for pre-gate rejection
 *
 * IMPORTANT: If an opportunity is off-lens with no transferable angle,
 * we do NOT attempt to force a fake AI/productivity rewrite. We reject it cleanly.
 */

// ═══ Types ═══

export type NicheAlignmentResult = {
  niche_alignment_score: number;      // 1-10 (10 = perfectly aligned). S1.3: semantically "account_lens_score"
  niche_alignment_reason: string;     // Human-readable explanation
  is_off_niche: boolean;              // true if score < 4. S1.3: semantically "is_off_lens"
  aligned_topics: string[];           // Which aligned topics were found
  off_niche_topics: string[];         // Which off-lens topics were detected. S1.3: semantically "off_lens_topics"
  // Phase S1.3: New fields for account growth lens
  transferable_angle_score: number;   // 0-3: how strong the transferable angle is
  forced_angle_flag: boolean;         // true if the angle feels forced/generic
  forced_angle_reason?: string;       // Why the angle was flagged as forced
  allowed_adjacency_topics: string[];  // Adjacent topics with legitimate transferable angles
};

export type OpportunityWithNiche = {
  crafted_text: string;
  source_text?: string;
  source_author?: string;
  why?: string;
  type: string;
  [key: string]: any;
};

// ═══ Account Lens Definitions (Phase S1.3) ═══

/**
 * Core aligned topic patterns — the account lens.
 * These signal that the content is on-lens for @30piq.
 *
 * Phase S1.3: Expanded from narrow "AI × productivity × career growth" to:
 * AI tools and AI-native workflows, productivity and leverage,
 * building, shipping, startups, indie hacking, career growth and skill acquisition,
 * internet business and creator growth, digital behavior and attention,
 * software, automation, systems, tools, future of work.
 */
const ALIGNED_PATTERNS = [
  // AI / ML
  { pattern: /\b(AI|artificial intelligence|machine learning|ML|deep learning)\b/i, topic: 'AI' },
  { pattern: /\b(GPT|LLM|language model|large language model|ChatGPT|Claude|Gemini)\b/i, topic: 'AI_tools' },
  { pattern: /\b(prompt|prompting|prompt engineering|RAG|retrieval augmented)\b/i, topic: 'AI_tools' },
  { pattern: /\b(agent|AI agent|autonomous agent|AI workflow|AI automation)\b/i, topic: 'AI_tools' },
  { pattern: /\b(OpenAI|Anthropic|Hugging Face|Stability|Midjourney)\b/i, topic: 'AI_tools' },
  { pattern: /\b(fine.?tun|train.*model|model.*train|embedding|tokenizer)\b/i, topic: 'AI_tools' },
  { pattern: /\b(AI.*tool|tool.*AI|AI.*app|app.*AI|AI.*software)\b/i, topic: 'AI_tools' },
  { pattern: /\b(neural|transformer|diffusion|generative|foundation model)\b/i, topic: 'AI' },
  { pattern: /\b(copilot|cursor|v0|bolt|replit|code.*assist|AI.*code)\b/i, topic: 'AI_tools' },

  // Productivity / Leverage
  { pattern: /\b(productiv|workflow|automat|efficien|time.?sav|time.?manag)\b/i, topic: 'productivity' },
  { pattern: /\b(Notion|Obsidian|Todoist|Linear|Asana|Trello|Jira)\b/i, topic: 'productivity' },
  { pattern: /\b(automation|zapier|make\.com|n8n|IFTTT|Power Automate)\b/i, topic: 'automation' },
  { pattern: /\b(script|pipeline|CI\/CD|deploy|build tool|devops)\b/i, topic: 'automation' },
  { pattern: /\b(template|framework|system|process|methodology)\b/i, topic: 'productivity' },
  { pattern: /\b(outsource|delegate|batch|focus mode|deep work)\b/i, topic: 'productivity' },
  { pattern: /\b(leverage|compounding|asymmetric|ROI|return on investment)\b/i, topic: 'leverage' },

  // Career growth / Skills / Work
  { pattern: /\b(career|hire|hiring|job|salary|negotiat|promot|resign)\b/i, topic: 'career' },
  { pattern: /\b(resume|CV|portfolio|interview|cover letter)\b/i, topic: 'career' },
  { pattern: /\b(skill|upskill|reskill|learn|course|certif|bootcamp)\b/i, topic: 'skills' },
  { pattern: /\b(founder|operator|startup|bootstrapped|indie hacker)\b/i, topic: 'startups' },
  { pattern: /\b(remote work|freelanc|solopreneur|creator economy)\b/i, topic: 'creator_economy' },
  { pattern: /\b(software engineer|developer|SWE|programmer|tech lead)\b/i, topic: 'career' },
  { pattern: /\b(future of work|work.*future|new work|hybrid work|async work)\b/i, topic: 'future_of_work' },

  // Building / Tech / Software
  { pattern: /\b(build|ship|launch|side project|MVP|prototype)\b/i, topic: 'building' },
  { pattern: /\b(API|SDK|open source|GitHub|repo|codebase)\b/i, topic: 'building' },
  { pattern: /\b(SaaS|B2B|product|feature|user feedback|iterate)\b/i, topic: 'internet_business' },
  { pattern: /\b(Python|JavaScript|TypeScript|Rust|Go|React|Next\.js|Node)\b/i, topic: 'building' },
  { pattern: /\b(no.?code|low.?code|bubble|webflow|framer)\b/i, topic: 'building' },

  // Digital behavior / Attention / Internet business / Creator growth
  { pattern: /\b(internet culture|online behavior|viral|engagement|algorithm)\b/i, topic: 'digital_behavior' },
  { pattern: /\b(attention|attention economy|distraction|focus|dopamine)\b/i, topic: 'attention' },
  { pattern: /\b(content strategy|distribution|audience|followers|growth)\b/i, topic: 'creator_economy' },
  { pattern: /\b(creator|influencer|monetiz|newsletter|podcast)\b/i, topic: 'creator_economy' },
  { pattern: /\b(personal brand|brand.*build|brand.*strategy|positioning)\b/i, topic: 'creator_economy' },
  { pattern: /\b(storytelling|narrative|story structure|hook|mechanism)\b/i, topic: 'digital_behavior' },
  { pattern: /\b(software|automation|systems|tools?)\b/i, topic: 'building' },
];

/**
 * Off-lens topic patterns — content that does NOT directly fit @30piq.
 * Phase S1.3: These are NOT automatically hard-rejected. They are flagged
 * as off-lens, but if a transferable angle exists, they can still pass.
 *
 * Only pure versions (no transferable angle) are rejected.
 */
const OFF_LENS_PATTERNS = [
  // Entertainment / pop culture
  { pattern: /\b(Superman|Batman|DC|Marvel|Avengers|Spider.?Man|Iron Man|comic|comics)\b/i, topic: 'comics' },
  { pattern: /\b(One Piece|Naruto|Dragon Ball|anime|manga|Bleach|Jujutsu|Attack on Titan)\b/i, topic: 'anime' },
  { pattern: /\b(movie|film|box office|trailer|Netflix|HBO|streaming|series|TV show)\b/i, topic: 'movies' },
  { pattern: /\b(celebrit|gossip|rumor|scandal|divorce|breakup|relationship)\b/i, topic: 'celebrity_gossip' },
  { pattern: /\b(influencer|TikTok star|YouTube star|vlogger|content creator drama)\b/i, topic: 'influencer_drama' },
  { pattern: /\b(boxing|UFC|fight|MMA|Jake Paul|KSI|boxing match)\b/i, topic: 'influencer_boxing' },
  { pattern: /\b(meme|viral joke|funny tweet|comedy|stand.?up|humor)\b/i, topic: 'memes' },
  { pattern: /\b(Kardashian|Taylor Swift|Beyonce|Drake|Kanye|Travis Kelce)\b/i, topic: 'celebrity_gossip' },
  { pattern: /\b(football|soccer|basketball|NBA|NFL|FIFA|World Cup|Premier League)\b/i, topic: 'sports' },
  { pattern: /\b(video game|gaming|Fortnite|Roblox|Minecraft|gamer|esport)\b/i, topic: 'gaming' },
  { pattern: /\b(recipe|cooking|food|restaurant|diet|weight loss|fitness routine)\b/i, topic: 'lifestyle' },
  { pattern: /\b(fashion|outfit|style|beauty|makeup|skincare)\b/i, topic: 'fashion' },
  { pattern: /\b(travel|vacation|destination|tourist|hotel|flight)\b/i, topic: 'travel' },
  { pattern: /\b(politics|election|president|congress|senator|political|democrat|republican)\b/i, topic: 'politics' },
  { pattern: /\b(crypto|bitcoin|Ethereum|NFT|token|blockchain|DeFi|Web3)\b/i, topic: 'crypto' },
];

/**
 * Transferable angle patterns — signals that an off-lens topic has a
 * legitimate transferable angle for builders/operators/creators.
 *
 * If an off-lens topic is detected BUT one of these transferable angles
 * is also present, the penalty is reduced and the topic may pass.
 */
const TRANSFERABLE_ANGLE_PATTERNS = [
  { pattern: /\b(audience|audience psychology|audience behavior|audience retention)\b/i, angle: 'audience_psychology' },
  { pattern: /\b(builder lesson|operator lesson|creator lesson|lesson for)\b/i, angle: 'builder_lesson' },
  { pattern: /\b(operator takeaway|actionable takeaway|practical takeaway)\b/i, angle: 'operator_takeaway' },
  { pattern: /\b(creator growth|creator strategy|creator economy|content strategy)\b/i, angle: 'creator_growth' },
  { pattern: /\b(product adoption|adoption pattern|user adoption|tool adoption)\b/i, angle: 'product_adoption' },
  { pattern: /\b(workflow|system|insight|mechanism|framework)\b/i, angle: 'workflow_insight' },
  { pattern: /\b(career leverage|skill leverage|personal leverage|digital leverage)\b/i, angle: 'career_leverage' },
  { pattern: /\b(incentive design|incentive structure|community behavior|product behavior)\b/i, angle: 'incentive_design' },
  { pattern: /\b(attention economy|distribution|viral mechanism|spread|reach)\b/i, angle: 'attention_economy' },
  { pattern: /\b(platform dynamic|platform behavior|information behavior|information spread)\b/i, angle: 'platform_dynamics' },
  { pattern: /\b(storytelling|narrative|story structure|hook|frame)\b/i, angle: 'storytelling' },
  { pattern: /\b(personal brand|brand strategy|positioning|niche)\b/i, angle: 'personal_brand' },
  { pattern: /\b(monetiz|business model|revenue model|pricing)\b/i, angle: 'business_model' },
  { pattern: /\b(strategy|signal|pattern|trend|insight|takeaway|lesson)\b/i, angle: 'general_transferable' },
];

/**
 * Forced angle patterns — signals that an AI/productivity angle is
 * being force-fitted onto an unrelated topic in a generic/artificial way.
 */
const FORCED_ANGLE_PATTERNS = [
  /\bmeans?\s+.{0,40}\bAI\b.{0,30}\b(will|can|could|should)\b/i,          // "means AI will..."
  /\bimplication.{0,15}\bAI\b.{0,30}\b(future|change|transform)\b/i,      // "implication for AI..."
  /\bshows?\s+why.{0,30}\bAI\b/i,                                          // "shows why AI..."
  /\bwhat.{0,30}means.{0,20}for.{0,15}\bAI\b/i,                            // "What this means for AI"
  /\bAI\s+lesson\s+from\b/i,                                               // "AI lesson from..."
  /\bproductivity\s+lesson\s+from\b/i,                                     // "Productivity lesson from..."
  /\bhow\s+AI\s+changed?\b.{0,20}\b(entertainment|sports|gaming|movie)\b/i, // "How AI changed sports"
  /\b(why|how).{0,30}matters?\s+for\s+(AI|productivity)\b/i,              // "Why this matters for AI"
  /\bthis\s+is\s+why.{0,20}\b(AI|agent)\b/i,                               // "this is why agents matter"
];

/**
 * Adjacent topic patterns — off-lens topics with a clear transfer path.
 * These get a partial score boost if the transferable angle is detected.
 */
const ALLOWED_ADJACENCY_PATTERNS = [
  { pattern: /\b(entertainment|Hollywood|celebrity|pop culture|music industry)\b/i, topic: 'entertainment', transferAngle: 'audience, brand, storytelling, attention economy, or creative strategy' },
  { pattern: /\b(sports|athlete|championship|prize fight|boxer)\b/i, topic: 'sports', transferAngle: 'personal brand, leverage, distribution, incentives, or attention economy' },
  { pattern: /\b(anime|manga|comic|superhero|fandom|cosplay)\b/i, topic: 'anime_comics', transferAngle: 'storytelling, fandom, audience retention, brand symbols, or creator strategy' },
  { pattern: /\b(movie|film|box office|trailer|streaming|series)\b/i, topic: 'movies_tv', transferAngle: 'audience behavior, attention economy, storytelling, or distribution' },
  { pattern: /\b(crypto|bitcoin|Ethereum|blockchain|DeFi|Web3)\b/i, topic: 'crypto', transferAngle: 'product adoption, community behavior, incentive design, or token economics' },
  { pattern: /\b(politics|election|policy|regulation|partisan)\b/i, topic: 'politics', transferAngle: 'platform dynamics, information behavior, or policy impact on tech' },
  { pattern: /\b(gaming|esport|game design|game studio)\b/i, topic: 'gaming', transferAngle: 'product design, community building, retention mechanics, or distribution' },
  { pattern: /\b(meme|viral|internet trend|tiktok trend)\b/i, topic: 'internet_trends', transferAngle: 'attention economy, audience behavior, or distribution mechanics' },
];

// ═══ Scoring ═══

/**
 * Score account lens alignment for an opportunity.
 * Uses heuristic pattern matching — no AI call needed.
 *
 * Phase S1.3 scoring guide:
 *  8-10: Strongly on-lens (core account topics)
 *  5-7:  On-lens with adjacent/transferable angle
 *  4-5:  Off-lens but with some transferable angle (may pass)
 *  1-3:  Off-lens with no transferable angle (should be rejected)
 *
 * The scoring now considers:
 * - transferable_angle_score: 0-3 based on how strong the transferable angle is
 * - forced_angle_flag: true if a generic AI/productivity angle is being forced
 * - allowed_adjacency_topics: adjacent topics with legitimate transfer paths
 */
export function scoreNicheAlignment(opp: OpportunityWithNiche): NicheAlignmentResult {
  const text = [opp.crafted_text, opp.source_text, opp.why].filter(Boolean).join(' ');

  const alignedTopics: string[] = [];
  const offLensTopics: string[] = [];
  const allowedAdjacencyTopics: string[] = [];
  let transferableAngleScore = 0;
  let forcedAngleFlag = false;
  let forcedAngleReason: string | undefined;

  // Check aligned patterns
  for (const { pattern, topic } of ALIGNED_PATTERNS) {
    if (pattern.test(text)) {
      if (!alignedTopics.includes(topic)) {
        alignedTopics.push(topic);
      }
    }
  }

  // Check off-lens patterns
  for (const { pattern, topic } of OFF_LENS_PATTERNS) {
    if (pattern.test(text)) {
      if (!offLensTopics.includes(topic)) {
        offLensTopics.push(topic);
      }
    }
  }

  // Check transferable angle patterns
  const matchedTransferableAngles: string[] = [];
  for (const { pattern, angle } of TRANSFERABLE_ANGLE_PATTERNS) {
    if (pattern.test(text)) {
      if (!matchedTransferableAngles.includes(angle)) {
        matchedTransferableAngles.push(angle);
      }
    }
  }
  transferableAngleScore = Math.min(matchedTransferableAngles.length, 3);

  // Check forced angle patterns
  for (const pattern of FORCED_ANGLE_PATTERNS) {
    if (pattern.test(text)) {
      forcedAngleFlag = true;
      forcedAngleReason = `Forced AI/productivity angle detected`;
      break;
    }
  }

  // Check allowed adjacency patterns
  for (const { pattern, topic, transferAngle } of ALLOWED_ADJACENCY_PATTERNS) {
    if (pattern.test(text)) {
      // Adjacency is only "allowed" if a transferable angle also exists
      if (transferableAngleScore > 0 || alignedTopics.length > 0) {
        if (!allowedAdjacencyTopics.includes(topic)) {
          allowedAdjacencyTopics.push(topic);
        }
      }
    }
  }

  // ── Score calculation ──
  let score = 5.0; // Start neutral

  // Aligned topics boost score
  for (const topic of alignedTopics) {
    switch (topic) {
      case 'AI':
      case 'AI_tools':
        score += 1.5;
        break;
      case 'productivity':
      case 'automation':
      case 'leverage':
        score += 1.2;
        break;
      case 'career':
      case 'building':
      case 'startups':
      case 'skills':
        score += 1.0;
        break;
      case 'creator_economy':
      case 'internet_business':
      case 'digital_behavior':
      case 'attention':
      case 'future_of_work':
        score += 1.2;
        break;
      default:
        score += 0.5;
    }
  }

  // Transferable angle gives a moderate boost
  score += transferableAngleScore * 0.5;

  // Allowed adjacency topics give a small boost
  score += allowedAdjacencyTopics.length * 0.3;

  // Off-lens topics penalize score — but LESS if there's a transferable angle
  for (const topic of offLensTopics) {
    // If there's a strong transferable angle, reduce the penalty
    const hasTransferableAngle = transferableAngleScore >= 2;
    const hasAdjacency = allowedAdjacencyTopics.length > 0;
    const penaltyMultiplier = (hasTransferableAngle || hasAdjacency) ? 0.4 : 1.0;

    switch (topic) {
      case 'comics':
      case 'anime':
      case 'celebrity_gossip':
      case 'influencer_boxing':
      case 'influencer_drama':
        score -= 3.0 * penaltyMultiplier;
        break;
      case 'movies':
      case 'memes':
      case 'sports':
      case 'gaming':
        score -= 2.5 * penaltyMultiplier;
        break;
      case 'crypto':
      case 'politics':
        // Crypto/politics with transferable angle (incentive design, platform dynamics)
        // gets a much reduced penalty
        score -= 2.0 * penaltyMultiplier;
        break;
      default:
        score -= 2.0 * penaltyMultiplier;
    }
  }

  // Forced angle penalty — if the angle is forced/generic, penalize heavily
  if (forcedAngleFlag) {
    score -= 3.0;
  }

  // Clamp to 1-10
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  // Determine if off-lens (score < 4 means no viable angle exists)
  const isOffLens = score < 4;

  // Build reason
  const parts: string[] = [];
  if (alignedTopics.length > 0) {
    parts.push(`On-lens: ${alignedTopics.join(', ')}`);
  }
  if (offLensTopics.length > 0) {
    parts.push(`Off-lens: ${offLensTopics.join(', ')}`);
  }
  if (allowedAdjacencyTopics.length > 0) {
    parts.push(`Adjacent: ${allowedAdjacencyTopics.join(', ')}`);
  }
  if (transferableAngleScore > 0) {
    parts.push(`Transferable: ${matchedTransferableAngles.join(', ')}`);
  }
  if (forcedAngleFlag) {
    parts.push(`FORCED: ${forcedAngleReason}`);
  }
  if (alignedTopics.length === 0 && offLensTopics.length === 0) {
    parts.push('No strong lens signals detected');
  }

  const reason = parts.join('; ');
  return {
    niche_alignment_score: score,
    niche_alignment_reason: reason,
    is_off_niche: isOffLens,
    aligned_topics: alignedTopics,
    off_niche_topics: offLensTopics,
    transferable_angle_score: transferableAngleScore,
    forced_angle_flag: forcedAngleFlag,
    forced_angle_reason: forcedAngleReason,
    allowed_adjacency_topics: allowedAdjacencyTopics,
  };
}

/**
 * Batch score and guard account lens alignment for all opportunities.
 *
 * Off-lens opportunities (no transferable angle) are marked with:
 * - niche_alignment_score
 * - niche_alignment_reason
 * - pre_gate_rejection_reason: 'off_niche' (backward compat) or 'off_lens'
 * - shield_passed: false (ensures publish_gate rejects them)
 * - quality_notes updated
 *
 * IMPORTANT: Off-lens opportunities are NOT rewritten into fake AI angles.
 * They are cleanly rejected with a clear reason.
 */
export function guardNicheAlignment(
  opportunities: OpportunityWithNiche[]
): {
  guarded: OpportunityWithNiche[];
  off_niche: Array<{
    opportunity: OpportunityWithNiche;
    alignment: NicheAlignmentResult;
  }>;
  summary: {
    total: number;
    aligned: number;
    off_niche: number;
    avg_score: number;
    // Phase S1.3: Account lens diagnostics
    forced_angle_count: number;
    transferable_angle_count: number;
    allowed_adjacency_count: number;
    off_lens_count: number;
    off_lens_reasons: string[];
  };
} {
  if (!opportunities?.length) {
    return {
      guarded: [],
      off_niche: [],
      summary: {
        total: 0,
        aligned: 0,
        off_niche: 0,
        avg_score: 0,
        forced_angle_count: 0,
        transferable_angle_count: 0,
        allowed_adjacency_count: 0,
        off_lens_count: 0,
        off_lens_reasons: [],
      },
    };
  }

  const guarded: OpportunityWithNiche[] = [];
  const offNiche: Array<{ opportunity: OpportunityWithNiche; alignment: NicheAlignmentResult }> = [];
  let totalScore = 0;
  let forcedAngleCount = 0;
  let transferableAngleCount = 0;
  let allowedAdjacencyCount = 0;
  let offLensCount = 0;
  const offLensReasons: string[] = [];

  for (const opp of opportunities) {
    const alignment = scoreNicheAlignment(opp);
    totalScore += alignment.niche_alignment_score;

    // Track diagnostics
    if (alignment.forced_angle_flag) forcedAngleCount++;
    if (alignment.transferable_angle_score >= 2) transferableAngleCount++;
    if (alignment.allowed_adjacency_topics.length > 0) allowedAdjacencyCount++;

    const enriched: OpportunityWithNiche = {
      ...opp,
      niche_alignment_score: alignment.niche_alignment_score,
      niche_alignment_reason: alignment.niche_alignment_reason,
      // Phase S1.3: New diagnostic fields
      _transferable_angle_score: alignment.transferable_angle_score,
      _forced_angle_flag: alignment.forced_angle_flag,
      _forced_angle_reason: alignment.forced_angle_reason,
      _allowed_adjacency_topics: alignment.allowed_adjacency_topics,
    };

    if (alignment.is_off_niche) {
      offLensCount++;
      offLensReasons.push(alignment.off_niche_topics.join(','));

      // Mark as rejected — do NOT attempt to rewrite into a fake AI angle
      enriched.shield_passed = false;
      enriched.shield_issues = [...(opp.shield_issues || []), 'off_niche'];
      enriched.pre_gate_rejection_reason = 'off_niche';
      enriched.quality_notes = [
        opp.quality_notes || '',
        `Off-lens (${alignment.niche_alignment_score}/10): ${alignment.niche_alignment_reason}`
      ].filter(Boolean).join('; ');

      offNiche.push({ opportunity: enriched, alignment });
      // Still include in guarded array for pipeline transparency
      guarded.push(enriched);
    } else {
      // On-lens (or off-lens with transferable angle that scored >= 4)
      enriched.quality_notes = [
        opp.quality_notes || '',
        `Lens aligned (${alignment.niche_alignment_score}/10): ${alignment.niche_alignment_reason}`
      ].filter(Boolean).join('; ');

      // If forced angle was detected, add a shield issue warning (but don't auto-reject)
      if (alignment.forced_angle_flag) {
        enriched.shield_issues = [...(opp.shield_issues || []), 'forced_angle_warning'];
        enriched._forced_angle_flag = true;
        enriched._forced_angle_reason = alignment.forced_angle_reason;
      }

      guarded.push(enriched);
    }
  }

  return {
    guarded,
    off_niche: offNiche,
    summary: {
      total: opportunities.length,
      aligned: opportunities.length - offNiche.length,
      off_niche: offNiche.length,
      avg_score: Math.round((totalScore / opportunities.length) * 10) / 10,
      // Phase S1.3: Account lens diagnostics
      forced_angle_count: forcedAngleCount,
      transferable_angle_count: transferableAngleCount,
      allowed_adjacency_count: allowedAdjacencyCount,
      off_lens_count: offLensCount,
      off_lens_reasons: [...new Set(offLensReasons)],
    }
  };
}
