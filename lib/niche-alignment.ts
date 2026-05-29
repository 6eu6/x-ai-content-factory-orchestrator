/**
 * niche-alignment.ts — Phase 2C: Score whether an opportunity fits @30piq's niche
 *
 * @30piq is focused exclusively on: AI × productivity × career growth.
 * Many opportunities from scanning are off-niche (comics, movies, sports,
 * entertainment, celebrity gossip). These must be identified and rejected
 * BEFORE publish_gate to avoid wasting rewrite attempts on content that
 * can never be made niche-aligned.
 *
 * This module provides:
 * 1. Heuristic niche alignment scoring (1-10, no AI call needed)
 * 2. Off-niche detection with explicit reason tracking
 * 3. A guard that marks off-niche opportunities for pre-gate rejection
 *
 * IMPORTANT: If an opportunity is off-niche, we do NOT attempt to force
 * a fake AI/productivity rewrite. We reject it cleanly.
 */

// ═══ Types ═══

export type NicheAlignmentResult = {
  niche_alignment_score: number;      // 1-10 (10 = perfectly aligned)
  niche_alignment_reason: string;     // Human-readable explanation
  is_off_niche: boolean;              // true if score < 4
  aligned_topics: string[];           // Which aligned topics were found
  off_niche_topics: string[];         // Which off-niche topics were detected
};

export type OpportunityWithNiche = {
  crafted_text: string;
  source_text?: string;
  source_author?: string;
  why?: string;
  type: string;
  [key: string]: any;
};

// ═══ Niche Definitions ═══

/**
 * Aligned topic patterns — AI × productivity × career growth.
 * These signal that the content is on-niche for @30piq.
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

  // Productivity
  { pattern: /\b(productiv|workflow|automat|efficien|time.?sav|time.?manag)\b/i, topic: 'productivity' },
  { pattern: /\b(Notion|Obsidian|Todoist|Linear|Asana|Trello|Jira)\b/i, topic: 'productivity' },
  { pattern: /\b(automation|zapier|make\.com|n8n|IFTTT|Power Automate)\b/i, topic: 'automation' },
  { pattern: /\b(script|pipeline|CI\/CD|deploy|build tool|devops)\b/i, topic: 'automation' },
  { pattern: /\b(template|framework|system|process|methodology)\b/i, topic: 'productivity' },
  { pattern: /\b(outsource|delegate|batch|focus mode|deep work)\b/i, topic: 'productivity' },

  // Career growth / work
  { pattern: /\b(career|hire|hiring|job|salary|negotiat|promot|resign)\b/i, topic: 'career' },
  { pattern: /\b(resume|CV|portfolio|interview|cover letter)\b/i, topic: 'career' },
  { pattern: /\b(skill|upskill|reskill|learn|course|certif|bootcamp)\b/i, topic: 'career' },
  { pattern: /\b(founder|operator|startup|bootstrapped|indie hacker)\b/i, topic: 'career' },
  { pattern: /\b(remote work|freelanc|solopreneur|creator economy)\b/i, topic: 'career' },
  { pattern: /\b(software engineer|developer|SWE|programmer|tech lead)\b/i, topic: 'career' },

  // Building / tech
  { pattern: /\b(build|ship|launch|side project|MVP|prototype)\b/i, topic: 'building' },
  { pattern: /\b(API|SDK|open source|GitHub|repo|codebase)\b/i, topic: 'building' },
  { pattern: /\b(SaaS|B2B|product|feature|user feedback|iterate)\b/i, topic: 'building' },
  { pattern: /\b(Python|JavaScript|TypeScript|Rust|Go|React|Next\.js|Node)\b/i, topic: 'building' },
];

/**
 * Off-niche topic patterns — content that does NOT fit @30piq.
 * These strongly indicate the content should not be published.
 */
const OFF_NICHE_PATTERNS = [
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

// ═══ Scoring ═══

/**
 * Score niche alignment for an opportunity.
 * Uses heuristic pattern matching — no AI call needed.
 *
 * Score guide:
 *  8-10: Strongly aligned with @30piq niche
 *  5-7:  Partially aligned or neutral
 *  1-4:  Off-niche — should be rejected
 */
export function scoreNicheAlignment(opp: OpportunityWithNiche): NicheAlignmentResult {
  const text = [opp.crafted_text, opp.source_text, opp.why].filter(Boolean).join(' ');

  const alignedTopics: string[] = [];
  const offNicheTopics: string[] = [];
  let score = 5.0; // Start neutral

  // Check aligned patterns
  for (const { pattern, topic } of ALIGNED_PATTERNS) {
    if (pattern.test(text)) {
      if (!alignedTopics.includes(topic)) {
        alignedTopics.push(topic);
      }
    }
  }

  // Check off-niche patterns
  for (const { pattern, topic } of OFF_NICHE_PATTERNS) {
    if (pattern.test(text)) {
      if (!offNicheTopics.includes(topic)) {
        offNicheTopics.push(topic);
      }
    }
  }

  // Score adjustments
  // Aligned topics boost score
  for (const topic of alignedTopics) {
    switch (topic) {
      case 'AI':
      case 'AI_tools':
        score += 1.5;
        break;
      case 'productivity':
      case 'automation':
        score += 1.2;
        break;
      case 'career':
      case 'building':
        score += 1.0;
        break;
      default:
        score += 0.5;
    }
  }

  // Off-niche topics penalize score heavily
  for (const topic of offNicheTopics) {
    switch (topic) {
      case 'comics':
      case 'anime':
      case 'celebrity_gossip':
      case 'influencer_boxing':
      case 'influencer_drama':
        score -= 3.0;
        break;
      case 'movies':
      case 'memes':
      case 'sports':
      case 'gaming':
        score -= 2.5;
        break;
      default:
        score -= 2.0;
    }
  }

  // Clamp to 1-10
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  // Determine if off-niche
  const isOffNiche = score < 4;

  // Build reason
  const parts: string[] = [];
  if (alignedTopics.length > 0) {
    parts.push(`Aligned: ${alignedTopics.join(', ')}`);
  }
  if (offNicheTopics.length > 0) {
    parts.push(`Off-niche: ${offNicheTopics.join(', ')}`);
  }
  if (alignedTopics.length === 0 && offNicheTopics.length === 0) {
    parts.push('No strong niche signals detected');
  }

  const reason = parts.join('; ');
  return {
    niche_alignment_score: score,
    niche_alignment_reason: reason,
    is_off_niche: isOffNiche,
    aligned_topics: alignedTopics,
    off_niche_topics: offNicheTopics
  };
}

/**
 * Batch score and guard niche alignment for all opportunities.
 *
 * Off-niche opportunities are marked with:
 * - niche_alignment_score
 * - niche_alignment_reason
 * - pre_gate_rejection_reason: 'off_niche'
 * - shield_passed: false (ensures publish_gate rejects them)
 * - quality_notes updated
 *
 * IMPORTANT: Off-niche opportunities are NOT rewritten into fake AI angles.
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
  };
} {
  if (!opportunities?.length) {
    return { guarded: [], off_niche: [], summary: { total: 0, aligned: 0, off_niche: 0, avg_score: 0 } };
  }

  const guarded: OpportunityWithNiche[] = [];
  const offNiche: Array<{ opportunity: OpportunityWithNiche; alignment: NicheAlignmentResult }> = [];
  let totalScore = 0;

  for (const opp of opportunities) {
    const alignment = scoreNicheAlignment(opp);
    totalScore += alignment.niche_alignment_score;

    const enriched: OpportunityWithNiche = {
      ...opp,
      niche_alignment_score: alignment.niche_alignment_score,
      niche_alignment_reason: alignment.niche_alignment_reason,
    };

    if (alignment.is_off_niche) {
      // Mark as rejected — do NOT attempt to rewrite into a fake AI angle
      enriched.shield_passed = false;
      enriched.shield_issues = [...(opp.shield_issues || []), 'off_niche'];
      enriched.pre_gate_rejection_reason = 'off_niche';
      enriched.quality_notes = [
        opp.quality_notes || '',
        `Off-niche (${alignment.niche_alignment_score}/10): ${alignment.niche_alignment_reason}`
      ].filter(Boolean).join('; ');

      offNiche.push({ opportunity: enriched, alignment });
      // Still include in guarded array for pipeline transparency
      guarded.push(enriched);
    } else {
      enriched.quality_notes = [
        opp.quality_notes || '',
        `Niche aligned (${alignment.niche_alignment_score}/10): ${alignment.niche_alignment_reason}`
      ].filter(Boolean).join('; ');
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
      avg_score: Math.round((totalScore / opportunities.length) * 10) / 10
    }
  };
}
