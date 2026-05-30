/**
 * tweet-candidate-scorer.ts — Phase 2E.1: Smart Tweet Prefiltering
 *
 * Pure module for scoring and prefiltering tweet candidates before
 * expensive AI analysis. No DB dependencies — all functions are pure.
 *
 * The goal: fetch MORE tweets from the API (up to the 20-result cap),
 * then select only the best candidates for AI analysis based on
 * engagement signals, tweet type, keyword matching, and content patterns.
 *
 * This replaces the old approach of processing ALL fetched tweets
 * through the AI analysis loop regardless of quality.
 */

// ═══ Types ═══

export type TweetCandidate = {
  id: string;
  text: string;
  like_count: number;
  reply_count: number;
  retweet_count: number;
  quote_count: number;
  bookmark_count: number;
  view_count: number;
  is_reply: boolean;
  is_retweet: boolean;
  is_quote: boolean;
  in_reply_to_tweet_id?: string | null;
  quoted_tweet_text?: string;
  quoted_tweet_author?: string;
  language?: string | null;
  created_at?: string | null;
  raw?: any;
};

export type ScoredCandidate = TweetCandidate & {
  candidate_score: number;
  skip_reason?: string;
};

export type PrefilterResult = {
  fetched: number;
  after_prefilter: number;
  selected_for_analysis: number;
  skipped_retweets: number;
  skipped_replies: number;
  skipped_low_engagement: number;
  skipped_off_niche: number;
  top_candidate_scores: number[];
  selected: ScoredCandidate[];
};

// ═══ Constants ═══

/**
 * Keywords that signal AI/creator/work/internet-culture content.
 * Matches get a bonus to their candidate score.
 */
const NICHE_KEYWORDS = [
  /\b(AI|GPT|LLM|ChatGPT|Claude|Gemini|Copilot|machine learning|deep learning)\b/i,
  /\b(automation|workflow|productivity|no-?code|low-?code)\b/i,
  /\b(creator|creator economy|audience|newsletter|podcast|content strategy)\b/i,
  /\b(startup|founder|operator|indie hacker|bootstrapped|SaaS)\b/i,
  /\b(career|skill|upskill|remote work|freelanc|solopreneur)\b/i,
  /\b(algorithm|viral|engagement|distribution|attention economy)\b/i,
  /\b(build|ship|launch|side project|MVP|prototype|open source)\b/i,
  /\b(Python|JavaScript|TypeScript|Rust|React|Next\.js|API|SDK)\b/i,
  /\b(internet culture|online behavior|tech culture|silicon valley)\b/i,
  /\b(Notion|Obsidian|Cursor|Replit|Vercel|Supabase|Figma)\b/i,
];

/**
 * Hook patterns that signal strong opinion, hidden behavior, reframing,
 * contradiction, or operator lesson. These tend to produce better content.
 */
const HOOK_PATTERNS = [
  /(?:the real reason|what they don't tell you|nobody talks about|here's the truth)/i,
  /(?:secret|hidden|unpopular opinion|controversial take|hot take)/i,
  /(?:actually|in reality|the truth is|here's what happened)/i,
  /(?:but wait|plot twist|contrary to|on the other hand)/i,
  /(?:lesson learned|what I learned|mistake I made|how I finally)/i,
  /(?:stop doing|don't do this|why you should|you need to)/i,
  /(?:this changed|game changer|mind blown|eye.?opening)/i,
  /(?:I spent \d+|after \d+ (?:years|months|hours)|in the last \d+)/i,
];

/**
 * Giveaway/announcement patterns — these rarely produce useful content.
 */
const GIVEAWAY_PATTERNS = [
  /\b(giveaway|giving away|free stuff|win a|enter to win)\b/i,
  /\b(announcement|announcing|excited to announce|we're launching)\b/i,
  /\b(AMA|ask me anything|Q&A|live stream|livestream)\b/i,
  /\b(follow me|retweet to win|like and share|tag a friend)\b/i,
];

/**
 * Check if text is primarily non-Latin script (Arabic, CJK, etc.)
 * without containing niche keywords.
 */
function isNonLatinDominant(text: string): boolean {
  if (!text || text.length < 5) return false;
  const nonLatin = text.replace(/[A-Za-z0-9\s@#.,!?:;'"()\-_/\\&%$+=\[\]{}|<>~`]/g, '');
  return nonLatin.length / text.length > 0.4;
}

// ═══ Scoring Logic ═══

/**
 * Compute the base engagement score using the existing scoreXTweet formula.
 *
 * like_count * 1 + reply_count * 2 + retweet_count * 3 +
 * quote_count * 4 + bookmark_count * 2 + min(view_count, 100000) / 1000
 */
export function computeBaseEngagementScore(candidate: TweetCandidate): number {
  return (
    candidate.like_count * 1 +
    candidate.reply_count * 2 +
    candidate.retweet_count * 3 +
    candidate.quote_count * 4 +
    candidate.bookmark_count * 2 +
    Math.min(candidate.view_count, 100000) / 1000
  );
}

/**
 * Score and prefilter tweet candidates for AI analysis.
 *
 * This is the main export. It scores all candidates, applies bonuses/penalties,
 * and selects the top `maxAnalyze` candidates by score for AI analysis.
 *
 * @param candidates - Raw tweet candidates from the API
 * @param options - Configuration options
 * @returns PrefilterResult with selected candidates and diagnostics
 */
export function scoreAndPrefilterTweets(
  candidates: TweetCandidate[],
  options?: { maxAnalyze?: number }
): PrefilterResult {
  const maxAnalyze = options?.maxAnalyze ?? 8;

  let skippedRetweets = 0;
  let skippedReplies = 0;
  let skippedLowEngagement = 0;
  let skippedOffNiche = 0;

  // Compute average engagement for low-engagement baseline
  const engagementScores = candidates.map(computeBaseEngagementScore);
  const avgEngagement = engagementScores.length > 0
    ? engagementScores.reduce((a, b) => a + b, 0) / engagementScores.length
    : 0;

  // Score each candidate
  const scored: ScoredCandidate[] = candidates.map((candidate, index) => {
    const baseScore = engagementScores[index];
    let score = baseScore;
    let skipReason: string | undefined;

    // ═══ Tweet type bonuses/penalties ═══

    // Original tweet bonus: +5
    if (!candidate.is_reply && !candidate.is_retweet && !candidate.is_quote) {
      score += 5;
    }

    // Reply penalty: -3 (unless reply has high engagement > 2x average)
    if (candidate.is_reply && !candidate.is_retweet && !candidate.is_quote) {
      if (baseScore > avgEngagement * 2) {
        // High-engagement reply — no penalty
      } else {
        score -= 3;
      }
    }

    // Quote tweet bonus: +2 (if it has commentary — i.e., text beyond the quoted text)
    if (candidate.is_quote) {
      const quotedLen = (candidate.quoted_tweet_text || '').length;
      if (candidate.text.length > quotedLen + 10) {
        score += 2; // Has its own commentary
      }
    }

    // Retweet penalty: -10 (pure RT with no commentary)
    if (candidate.is_retweet) {
      score -= 10;
      // Mark for skipping if score is very low
      if (score < -5) {
        skipReason = 'retweet_no_commentary';
        skippedRetweets++;
      }
    }

    // ═══ Content-based bonuses/penalties ═══

    // Keyword bonus: check for AI/creator/work/internet-culture keywords, +3 if match
    const hasNicheKeyword = NICHE_KEYWORDS.some(pattern => pattern.test(candidate.text));
    if (hasNicheKeyword) {
      score += 3;
    }

    // Hook pattern bonus: +2 for strong opinion, hidden behavior, reframing, etc.
    const hasHookPattern = HOOK_PATTERNS.some(pattern => pattern.test(candidate.text));
    if (hasHookPattern) {
      score += 2;
    }

    // Short contextless penalty: -5 if text length < 20 and is_reply
    if (candidate.text.length < 20 && candidate.is_reply) {
      score -= 5;
    }

    // Non-English penalty: -5 if language is set and not 'en' and not 'ar'
    // (or if nonLatin dominant and no niche keywords)
    if (candidate.language && candidate.language !== 'en' && candidate.language !== 'ar') {
      score -= 5;
      if (!hasNicheKeyword && isNonLatinDominant(candidate.text)) {
        skipReason = skipReason || 'non_english_off_niche';
        skippedOffNiche++;
      }
    } else if (!candidate.language && isNonLatinDominant(candidate.text) && !hasNicheKeyword) {
      score -= 5;
      skipReason = skipReason || 'non_latin_off_niche';
      skippedOffNiche++;
    }

    // Giveaway/announcement penalty: -8 for giveaway, announcement, AMA patterns
    const isGiveaway = GIVEAWAY_PATTERNS.some(pattern => pattern.test(candidate.text));
    if (isGiveaway) {
      score -= 8;
    }

    // Low engagement penalty: -3 if engagement is below account baseline
    if (baseScore < avgEngagement * 0.5 && avgEngagement > 0) {
      score -= 3;
      if (score < -5 && !skipReason) {
        skipReason = 'low_engagement';
        skippedLowEngagement++;
      }
    }

    // Count skipped replies (short contextless ones that are also low engagement)
    if (candidate.is_reply && candidate.text.length < 20 && score < 0 && !skipReason) {
      skipReason = 'short_reply';
      skippedReplies++;
    }

    return {
      ...candidate,
      candidate_score: Math.round(score * 100) / 100,
      skip_reason: skipReason,
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.candidate_score - a.candidate_score);

  // Select top candidates for analysis (excluding those with explicit skip reasons)
  const eligible = scored.filter(c => !c.skip_reason);
  const selected = eligible.slice(0, maxAnalyze);

  // Collect top candidate scores for diagnostics
  const topCandidateScores = scored
    .slice(0, Math.min(5, scored.length))
    .map(c => c.candidate_score);

  return {
    fetched: candidates.length,
    after_prefilter: eligible.length,
    selected_for_analysis: selected.length,
    skipped_retweets: skippedRetweets,
    skipped_replies: skippedReplies,
    skipped_low_engagement: skippedLowEngagement,
    skipped_off_niche: skippedOffNiche,
    top_candidate_scores: topCandidateScores,
    selected,
  };
}

/**
 * Convert a normalized tweet from getXUserTimeline to TweetCandidate format.
 */
export function normalizedTweetToCandidate(tweet: any): TweetCandidate {
  const m = tweet.public_metrics || {};
  return {
    id: String(tweet.id || ''),
    text: tweet.text || '',
    like_count: Number(m.like_count || 0),
    reply_count: Number(m.reply_count || 0),
    retweet_count: Number(m.retweet_count || 0),
    quote_count: Number(m.quote_count || 0),
    bookmark_count: Number(m.bookmark_count || 0),
    view_count: Number(m.view_count || 0),
    is_reply: Boolean(tweet.is_reply),
    is_retweet: Boolean(tweet.is_retweet || (tweet.text || '').startsWith('RT @')),
    is_quote: Boolean(tweet.is_quote_tweet),
    in_reply_to_tweet_id: tweet.in_reply_to_tweet_id || null,
    quoted_tweet_text: tweet.quoted_tweet_text || '',
    quoted_tweet_author: tweet.quoted_tweet_author || '',
    language: tweet.language || null,
    created_at: tweet.created_at || null,
    raw: tweet,
  };
}
