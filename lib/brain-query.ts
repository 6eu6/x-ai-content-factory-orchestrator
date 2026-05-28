import { supabaseAdmin } from './supabase';

/**
 * Brain Query System v1.0 — Smart concept retrieval with precise application instructions
 *
 * Problem it solves:
 * - Content was getting concepts as raw JSON without clear instructions
 * - The model didn't know what to do with each concept
 * - It didn't link concepts to the appropriate content type
 *
 * Solution:
 * - Each concept comes with an APPLICATION INSTRUCTION — a clear directive on how to apply it
 * - Concepts are composed based on content type (tweet, thread, reply, quote, article)
 * - Each content type gets the most suitable concepts + application instructions
 */

// ═══ Content types ═══

export type ContentType = 'single_tweet' | 'thread' | 'reply' | 'quote' | 'article';

// ═══ Concept structure with application instructions ═══

export type BrainConcept = {
  id: number;
  concept_type: string;        // precise_concept, psychological_trigger, viral_pattern, etc.
  concept_text: string;        // Concept text
  evidence: string;            // Supporting evidence
  confidence: number;          // Confidence level
  applies_to: string;          // Where it applies (content_strategy, engagement_crafting, etc.)
  source_type: string;         // Concept source
  application_instruction: string;  // 🆕 Application instruction — how to apply precisely
  relevance_to_task: string;   // 🆕 Why this concept matters for this specific task
};

export type StylePattern = {
  id: number;
  pattern_name: string;
  pattern_type: string;
  pattern_description: string;
  why_it_works: string;
  adaptation: string;
  confidence: number;
  application_instruction: string;  // 🆕 How to use the pattern
};

export type BrainQueryResult = {
  concepts: BrainConcept[];
  patterns: StylePattern[];
  total_rules: number;
  total_patterns: number;
  compiled_prompt_context: string;  // 🆕 Ready-made prompt context — organized and structured
};

// ═══ Application map — each concept type + content type = instruction ═══

const APPLICATION_MAP: Record<string, Record<ContentType, string>> = {
  precise_concept: {
    single_tweet: 'Use this exact mechanic as the structural backbone of the tweet. The tweet MUST embody this concept in its writing technique — not just mention it.',
    thread: 'Apply this concept to the thread STRUCTURE. Each tweet in the thread should demonstrate a different facet of this mechanic. The opening tweet should activate the concept as a hook.',
    reply: 'Apply this concept to add VALUE to the original tweet. Your reply should demonstrate this mechanic in action, making the reply standalone-useful.',
    quote: 'Use this concept as the LENS for your quote commentary. Your quote should reframe the original through this mechanic, adding original insight.',
    article: 'Build the article around this concept as the core thesis. Each section should explore a different dimension of this mechanic with examples.'
  },
  psychological_trigger: {
    single_tweet: 'Activate this psychological trigger in the FIRST LINE of the tweet. The opening must tap into this exact mechanism — identity signaling, surprise, validation, etc.',
    thread: 'Layer this trigger across the thread. The hook tweet activates it, middle tweets deepen it, and the conclusion satisfies it.',
    reply: 'Use this trigger to make the reply IRRESISTIBLE to engage with. The reply should activate the same trigger that made the original go viral.',
    quote: 'Your quote commentary should amplify this trigger. If the original used surprise, add a deeper surprise. If validation, add a stronger validation angle.',
    article: 'Weave this trigger throughout the article. The headline should activate it, the body should sustain it, and the conclusion should reward it.'
  },
  viral_pattern: {
    single_tweet: 'Mirror this viral pattern in the tweet structure. Copy the MECHANIC (not the topic) — if the pattern is "contrarian claim → hidden cost", use that exact structure.',
    thread: 'Use this pattern as the thread blueprint. The thread should follow the same progression that made the original viral.',
    reply: 'Apply this pattern to make the reply feel like a natural extension of the viral content. Same energy, same mechanic.',
    quote: 'Use this pattern to structure your quote commentary. The quote should follow the same viral mechanic but from a fresh angle.',
    article: 'Structure the article using this viral pattern as the narrative arc. The article should follow the same psychological journey.'
  },
  media_impact: {
    single_tweet: 'Consider how this media insight affects the tweet. If the pattern shows images boost engagement, structure the tweet to work WITH visual context.',
    thread: 'Plan media placement in the thread based on this insight. Put images where they maximize the viral mechanic.',
    reply: 'Reference this media insight if relevant — e.g., if screenshots boost credibility, suggest one in the reply.',
    quote: 'If the original has media, use this insight to craft a quote that complements or contrasts with the visual.',
    article: 'Plan visual elements in the article based on this insight. Add charts, screenshots, or diagrams where the pattern shows they matter most.'
  },
  conversation_context: {
    single_tweet: 'Use this audience insight to target the tweet precisely. Write for the EXACT audience profile that engages with this type of content.',
    thread: 'Address the thread to this specific audience. Each tweet should speak directly to what this audience cares about.',
    reply: 'Match the conversation energy. Your reply should speak the same language and address the same concerns visible in the replies.',
    quote: 'Your quote should speak to the same audience but add a perspective they are missing.',
    article: 'Write the article for this specific audience segment. Use their language, address their pain points, reference their tools.'
  },
  viral_concept: {
    single_tweet: 'Apply this extracted concept as the tweet formula. The concept is a proven pattern — use it as a template for structure.',
    thread: 'Expand this concept across the thread. Each tweet should explore a different application of the concept.',
    reply: 'Use this concept to add a deeper layer to the conversation. Show how the concept applies to the original tweet\'s topic.',
    quote: 'Reframe the original tweet through this concept lens. Show how this concept explains or extends the original insight.',
    article: 'Build the article around proving and exploring this concept. Use real examples and evidence to support it.'
  }
};

const STYLE_APPLICATION_MAP: Record<string, Record<ContentType, string>> = {
  hook: {
    single_tweet: 'Use this hook pattern for the opening line. The first 3-5 words MUST follow this hook mechanic.',
    thread: 'Apply this hook pattern to the FIRST tweet of the thread. This is the most critical element — if the hook fails, nobody reads the thread.',
    reply: 'Adapt this hook for the reply opening. Make the first line impossible to scroll past.',
    quote: 'Use this hook pattern as your quote opening. It should stop the scroll even without seeing the original tweet.',
    article: 'Apply this hook pattern to the article headline and first paragraph. The opening must create immediate curiosity.'
  },
  structure: {
    single_tweet: 'Follow this structural pattern exactly. If it is "setup → punchline", write the setup in line 1 and punchline in line 2.',
    thread: 'Use this structure as the thread skeleton. Map each structural element to a tweet position.',
    reply: 'Adapt this structure to the reply format. The reply should follow the same logical progression but condensed.',
    quote: 'Apply this structure to the quote format. The quote should have its own self-contained version of this structure.',
    article: 'Use this structure as the article outline. Each section should map to a structural element.'
  },
  bookmark_trigger: {
    single_tweet: 'Include the bookmarkable element from this pattern. The tweet should contain something worth saving — a checklist, a formula, a framework.',
    thread: 'Ensure at least one tweet in the thread is highly bookmarkable. Put the reference-worthy content in tweet 2-3, not the last tweet.',
    reply: 'Make the reply bookmarkable by including a concrete tip or framework the original tweet missed.',
    quote: 'Add a bookmarkable insight in the quote that makes people save both the original AND your commentary.',
    article: 'Include multiple bookmarkable elements — tables, checklists, frameworks — scattered throughout the article.'
  },
  reply_trigger: {
    single_tweet: 'Include the reply trigger from this pattern. End with something that makes people WANT to respond — a question, a controversial take, an "am I wrong?" moment.',
    thread: 'The last tweet of the thread should include a reply trigger that drives engagement back to the thread.',
    reply: 'Your reply should itself trigger further replies — ask a follow-up question or present a counter-angle.',
    quote: 'The quote commentary should invite responses — either through a strong opinion or an open question.',
    article: 'End the article with a reply trigger — a question or bold claim that drives comments.'
  }
};

// ═══ Core function — smart retrieval ═══

/**
 * queryBrainForContent — returns concepts with precise application instructions
 *
 * @param contentType The content type being built
 * @param maxConcepts Maximum number of concepts (default 8)
 * @param maxPatterns Maximum number of style patterns (default 5)
 */
export async function queryBrainForContent(
  contentType: ContentType,
  maxConcepts: number = 8,
  maxPatterns: number = 5
): Promise<BrainQueryResult> {
  const supabase = supabaseAdmin();

  // 1. Fetch algorithm rules — highest confidence
  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('id, rule_type, rule, evidence, confidence_score, applies_to, source_type, status')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(30);

  // 2. Fetch style patterns
  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('id, pattern_name, pattern_type, pattern_description, why_it_works, adaptation_for_30piq, confidence_score, status')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(15);

  // 3. Convert rules to concepts with application instructions
  const concepts: BrainConcept[] = (algoRules || [])
    .filter(r => {
      // Filter by content type
      const appliesTo = String(r.applies_to || '');
      if (contentType === 'single_tweet') return appliesTo.includes('content_strategy') || appliesTo.includes('engagement_crafting') || appliesTo.includes('viral_mechanics');
      if (contentType === 'thread') return appliesTo.includes('content_strategy') || appliesTo.includes('viral_mechanics');
      if (contentType === 'reply') return appliesTo.includes('engagement_crafting') || appliesTo.includes('reply_strategy');
      if (contentType === 'quote') return appliesTo.includes('engagement_crafting') || appliesTo.includes('content_strategy');
      if (contentType === 'article') return appliesTo.includes('content_strategy') || appliesTo.includes('viral_mechanics');
      return true; // If no filter, allow all
    })
    .slice(0, maxConcepts)
    .map(r => {
      const ruleType = r.rule_type || 'unknown';
      const appMap = APPLICATION_MAP[ruleType] || {};
      const instruction = appMap[contentType] || `Apply this ${ruleType} insight to your ${contentType} content.`;

      return {
        id: r.id,
        concept_type: ruleType,
        concept_text: String(r.rule || ''),
        evidence: String(r.evidence || ''),
        confidence: Number(r.confidence_score || 5),
        applies_to: String(r.applies_to || ''),
        source_type: String(r.source_type || ''),
        application_instruction: instruction,
        relevance_to_task: `This ${ruleType} (confidence: ${Number(r.confidence_score || 5).toFixed(1)}/10) is relevant because: ${String(r.evidence || '').slice(0, 100)}`
      };
    });

  // 4. Convert style patterns with application instructions
  const patterns: StylePattern[] = (stylePatterns || [])
    .slice(0, maxPatterns)
    .map(p => {
      const patternType = p.pattern_type || 'structure';
      const styleAppMap = STYLE_APPLICATION_MAP[patternType] || STYLE_APPLICATION_MAP.structure || {};
      const instruction = styleAppMap[contentType] || `Apply this ${patternType} pattern to your ${contentType} content.`;

      return {
        id: p.id,
        pattern_name: String(p.pattern_name || ''),
        pattern_type: patternType,
        pattern_description: String(p.pattern_description || ''),
        why_it_works: String(p.why_it_works || ''),
        adaptation: String(p.adaptation_for_30piq || ''),
        confidence: Number(p.confidence_score || 5),
        application_instruction: instruction
      };
    });

  // 5. Build ready-made prompt context — organized and clear
  const compiledPromptContext = buildPromptContext(concepts, patterns, contentType);

  return {
    concepts,
    patterns,
    total_rules: (algoRules || []).length,
    total_patterns: (stylePatterns || []).length,
    compiled_prompt_context: compiledPromptContext
  };
}

// ═══ Build ready-made context ═══

function buildPromptContext(concepts: BrainConcept[], patterns: StylePattern[], contentType: ContentType): string {
  const lines: string[] = [];

  lines.push(`=== BRAIN LEARNING — Apply precisely when creating ${contentType} content ===`);
  lines.push('');

  if (concepts.length > 0) {
    lines.push('LEARNED CONCEPTS (apply each one using its APPLICATION INSTRUCTION):');
    lines.push('');

    // Sort by confidence
    const sorted = [...concepts].sort((a, b) => b.confidence - a.confidence);

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      lines.push(`CONCEPT ${i + 1} [${c.concept_type}] (confidence: ${c.confidence.toFixed(1)}/10):`);
      lines.push(`  MECHANIC: ${c.concept_text}`);
      lines.push(`  EVIDENCE: ${c.evidence.slice(0, 150)}`);
      lines.push(`  HOW TO APPLY: ${c.application_instruction}`);
      lines.push('');
    }
  }

  if (patterns.length > 0) {
    lines.push('LEARNED STYLE PATTERNS (use as structural templates):');
    lines.push('');

    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      lines.push(`PATTERN ${i + 1} [${p.pattern_type}] (confidence: ${p.confidence.toFixed(1)}/10):`);
      lines.push(`  NAME: ${p.pattern_name}`);
      lines.push(`  DESCRIPTION: ${p.pattern_description.slice(0, 150)}`);
      if (p.why_it_works) lines.push(`  WHY IT WORKS: ${p.why_it_works.slice(0, 100)}`);
      if (p.adaptation) lines.push(`  ADAPTATION: ${p.adaptation.slice(0, 100)}`);
      lines.push(`  HOW TO APPLY: ${p.application_instruction}`);
      lines.push('');
    }
  }

  if (concepts.length === 0 && patterns.length === 0) {
    lines.push('NO LEARNED CONCEPTS YET — write using general best practices.');
  }

  lines.push('=== END BRAIN LEARNING ===');

  return lines.join('\n');
}

// ═══ Quick retrieval of top concepts (for use in content-engine-v3) ═══

/**
 * getTopBrainRules — returns top rules without detailed instructions
 * (compatible with current usage in discoverOpportunities)
 */
export async function getTopBrainRules(limit: number = 10) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from('x_algorithm_learning_rules')
    .select('id, rule_type, rule, evidence, applies_to, confidence_score')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(limit);
  return data || [];
}

/**
 * getTopStylePatterns — returns top style patterns
 */
export async function getTopStylePatterns(limit: number = 10) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from('viral_style_patterns')
    .select('id, pattern_name, pattern_type, pattern_description, adaptation_for_30piq, why_it_works, confidence_score')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(limit);
  return data || [];
}

/**
 * getBrainStats — returns brain statistics
 */
export async function getBrainStats() {
  const supabase = supabaseAdmin();

  const { count: algoCount } = await supabase
    .from('x_algorithm_learning_rules')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: patternCount } = await supabase
    .from('viral_style_patterns')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: mcpCount } = await supabase
    .from('mcp_opportunity_map')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  const { count: sysCount } = await supabase
    .from('system_learning_rules')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  return {
    algorithm_rules: algoCount || 0,
    style_patterns: patternCount || 0,
    mcp_opportunities: mcpCount || 0,
    system_rules: sysCount || 0,
    total: (algoCount || 0) + (patternCount || 0) + (mcpCount || 0) + (sysCount || 0)
  };
}
