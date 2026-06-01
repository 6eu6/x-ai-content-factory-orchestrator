import type { ContentOpportunity } from './content-engine-v3';
import { detectAIPatterns } from './crafted-text-cleaner';

export type DecisionStage = 'stage_0_new' | 'stage_1_under_500' | 'stage_2_500_to_2000' | 'stage_3_stable';

export type DecisionBudget = {
  max_total: number;
  max_quotes: number;
  max_replies: number;
  max_threads: number;
  min_final_score: number;
  allow_links: boolean;
  allow_hashtags: boolean;
};

export type DecisionScore = {
  final_score: number;
  momentum_score: number;
  brain_match_score: number;
  audience_fit_score: number;
  safety_score: number;
  originality_score: number;
  media_fit_score: number;
  rule_weight_adjustment: number;
  reasons: string[];
  rejection_reasons: string[];
};

export type DecidedOpportunity = ContentOpportunity & {
  decision_score: DecisionScore;
  decision_label: 'send' | 'hold';
};

const DEFAULT_BUDGETS: Record<DecisionStage, DecisionBudget> = {
  stage_0_new: {
    max_total: 2,
    max_quotes: 1,
    max_replies: 1,
    max_threads: 0,
    min_final_score: 7.0,
    allow_links: false,
    allow_hashtags: false
  },
  stage_1_under_500: {
    max_total: 3,
    max_quotes: 1,
    max_replies: 1,
    max_threads: 0,
    min_final_score: 7.0,
    allow_links: false,
    allow_hashtags: false
  },
  stage_2_500_to_2000: {
    max_total: 3,
    max_quotes: 1,
    max_replies: 1,
    max_threads: 0,
    min_final_score: 7.0,
    allow_links: true,
    allow_hashtags: false
  },
  stage_3_stable: {
    max_total: 4,
    max_quotes: 2,
    max_replies: 1,
    max_threads: 0,
    min_final_score: 7.0,
    allow_links: true,
    allow_hashtags: false
  }
};

export function stageFromFollowerCount(followers: number | null | undefined): DecisionStage {
  const n = Number(followers || 0);
  if (n <= 100) return 'stage_0_new';
  if (n < 500) return 'stage_1_under_500';
  if (n < 2000) return 'stage_2_500_to_2000';
  return 'stage_3_stable';
}

export function getDecisionBudget(stage: DecisionStage): DecisionBudget {
  return DEFAULT_BUDGETS[stage] || DEFAULT_BUDGETS.stage_1_under_500;
}

function clamp10(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, value));
}

function metricNumber(metrics: Record<string, any> | undefined, key: string): number {
  return Number(metrics?.[key] || 0);
}

function hasExternalLink(text: string): boolean {
  return /https?:\/\//i.test(text);
}

function hasHashtag(text: string): boolean {
  return /(^|\s)#\w+/i.test(text);
}

function looksDuplicative(text: string): boolean {
  const lower = text.toLowerCase();
  const repeatedHooks = [
    'here\'s the thing',
    'let\'s dive in',
    'in this thread',
    'everything you need to know',
    'game-changer',
    'unlock the power',
    'at the end of the day',
    'in today\'s world',
    'it\'s worth noting',
    'the bottom line is',
    'needless to say',
    'make no mistake',
    'here\'s what you need to know',
    'the truth is',
    'let\'s be clear',
    'deep dive',
    'think about it',
  ];
  return repeatedHooks.some(h => lower.includes(h));
}

export function scoreOpportunity(opp: ContentOpportunity, budget: DecisionBudget): DecisionScore {
  const metrics = opp.source_metrics || {};
  const text = String(opp.crafted_text || '');
  const likes = metricNumber(metrics, 'like_count');
  const replies = metricNumber(metrics, 'reply_count');
  const retweets = metricNumber(metrics, 'retweet_count');
  const quotes = metricNumber(metrics, 'quote_count');
  const bookmarks = metricNumber(metrics, 'bookmark_count');
  const views = metricNumber(metrics, 'view_count');

  const engagement = likes * 1.5 + replies * 3 + retweets * 4 + quotes * 5 + bookmarks * 3 + Math.min(views, 100000) / 800;
  const momentum_score = clamp10(Math.log10(engagement + 1) * 3.5 + (bookmarks > 0 ? 1.0 : 0) + (replies > 5 ? 0.8 : 0) + (likes > 100 ? 0.5 : 0));

  const brainRules = Array.isArray(opp.brain_rules_used) ? opp.brain_rules_used.filter(Boolean) : [];
  const brain_match_score = clamp10(4.5 + Math.min(brainRules.length, 5) * 1.0 + (opp.why ? 0.7 : 0));

  const isReply = opp.type === 'reply';
  const isQuote = opp.type === 'quote';
  const isThread = opp.type === 'thread' || opp.type === 'article';
  const audience_fit_score = clamp10(5.5 + (isReply ? 0.7 : 0) + (isQuote ? 0.8 : 0) + (opp.source_author ? 0.5 : 0) - (isThread ? 0.2 : 0));

  let safety_score = 10;
  const rejection_reasons: string[] = [];
  if (!opp.shield_passed) {
    safety_score -= Math.min(4, (opp.shield_issues || []).length * 1.3 || 2.5);
    rejection_reasons.push(`Shield warning: ${(opp.shield_issues || []).slice(0, 2).join(', ') || 'unknown issue'}`);
  }
  if (!budget.allow_links && hasExternalLink(text)) {
    safety_score -= 4;
    rejection_reasons.push('External link blocked for this account stage');
  }
  if (!budget.allow_hashtags && hasHashtag(text)) {
    safety_score -= 4;
    rejection_reasons.push('Hashtag blocked for this account stage');
  }
  if (text.length > 280) {
    safety_score -= 5;
    rejection_reasons.push('Text exceeds X character limit');
  }
  if (looksDuplicative(text)) {
    safety_score -= 2;
    rejection_reasons.push('Text contains repeated/AI-like hook pattern');
  }
  if (detectAIPatterns(text).is_ai_sounding) {
    safety_score -= 2;
    rejection_reasons.push('Text matches common AI-generated tweet patterns');
  }
  safety_score = clamp10(safety_score);

  const aiPenalty = detectAIPatterns(text).penalty_score;
  const originality_score = clamp10(5.5 + (text.length > 40 ? 0.7 : 0) + (/[?]/.test(text) ? 0.3 : 0) + (opp.why ? 0.8 : 0) - (looksDuplicative(text) ? 2.5 : 0) - aiPenalty);
  const media_fit_score = clamp10(5 + Math.min((opp.media_urls || []).length, 3) * 1.2 + (isQuote && (opp.media_urls || []).length ? 0.8 : 0));

  // Phase 6: Rule performance weight adjustment
  // Conservative: only ±0.4 max, and NEVER overrides safety_score
  let rule_weight_adjustment = 0;
  const avgWeight = opp.avg_brain_rule_weight;
  if (avgWeight !== undefined && avgWeight !== null && Number.isFinite(avgWeight)) {
    rule_weight_adjustment = Math.max(-0.4, Math.min(0.4, Math.round(((avgWeight - 0.6) * 1.0) * 100) / 100));
  }

  let final_score = clamp10(
    momentum_score * 0.30 +
    brain_match_score * 0.25 +
    audience_fit_score * 0.15 +
    safety_score * 0.15 +
    originality_score * 0.10 +
    media_fit_score * 0.05
  );

  // Apply rule weight adjustment AFTER base scoring
  // But ONLY if safety_score is acceptable — never let weight override safety
  if (safety_score >= 6.5 && opp.shield_passed) {
    final_score = clamp10(final_score + rule_weight_adjustment);
  }

  const reasons = [
    `Momentum ${momentum_score.toFixed(1)}/10 from source engagement`,
    `Brain match ${brain_match_score.toFixed(1)}/10 using ${brainRules.length} learned rules`,
    `Safety ${safety_score.toFixed(1)}/10 after shield and behavior checks`,
    `Originality ${originality_score.toFixed(1)}/10`,
  ];
  if (rule_weight_adjustment !== 0) {
    reasons.push(`Rule weight ${rule_weight_adjustment > 0 ? '+' : ''}${rule_weight_adjustment.toFixed(1)} (avg brain rule weight: ${avgWeight?.toFixed(2) || 'N/A'})`);
  }
  if ((opp.media_urls || []).length) reasons.push(`Media fit ${media_fit_score.toFixed(1)}/10 with ${(opp.media_urls || []).length} media item(s)`);

  return {
    final_score: Math.round(final_score * 10) / 10,
    momentum_score: Math.round(momentum_score * 10) / 10,
    brain_match_score: Math.round(brain_match_score * 10) / 10,
    audience_fit_score: Math.round(audience_fit_score * 10) / 10,
    safety_score: Math.round(safety_score * 10) / 10,
    originality_score: Math.round(originality_score * 10) / 10,
    media_fit_score: Math.round(media_fit_score * 10) / 10,
    rule_weight_adjustment: Math.round(rule_weight_adjustment * 100) / 100,
    reasons,
    rejection_reasons
  };
}

export function decideTelegramOpportunities(
  opportunities: ContentOpportunity[],
  stage: DecisionStage,
  budget: DecisionBudget = getDecisionBudget(stage)
): { selected: DecidedOpportunity[]; held: DecidedOpportunity[]; budget: DecisionBudget; stage: DecisionStage } {
  const decided: DecidedOpportunity[] = (opportunities || []).map(opp => {
    const decision_score = scoreOpportunity(opp, budget);
    return {
      ...opp,
      decision_score,
      decision_label: decision_score.final_score >= budget.min_final_score && decision_score.safety_score >= 7.0 ? 'send' : 'hold'
    };
  });

  // ═══ Deduplicate by crafted text similarity BEFORE selection ═══
  // Prevent sending identical/similar text for different types (quote+reply same source)
  const eligible = decided
    .filter(o => o.decision_label === 'send')
    .sort((a, b) => b.decision_score.final_score - a.decision_score.final_score);

  const seenTexts = new Set<string>();
  const dedupedEligible: DecidedOpportunity[] = [];
  for (const opp of eligible) {
    const text = String(opp.crafted_text || '').trim().toLowerCase();
    // Normalize: remove punctuation, extra spaces for comparison
    const normalized = text.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    // Check if >70% of text overlaps with any already-seen text
    let isDuplicate = false;
    if (normalized.length > 30) {
      for (const seen of seenTexts) {
        // Simple overlap check: if normalized text is a substring or very similar
        if (seen.includes(normalized) || normalized.includes(seen)) {
          isDuplicate = true;
          break;
        }
        // Character-level Jaccard-like similarity for short texts
        if (Math.abs(seen.length - normalized.length) < 30) {
          const common = [...seen].filter(c => normalized.includes(c)).length;
          const similarity = common / Math.max(seen.length, normalized.length);
          if (similarity > 0.75) {
            isDuplicate = true;
            break;
          }
        }
      }
    }
    if (!isDuplicate) {
      seenTexts.add(normalized);
      dedupedEligible.push(opp);
    }
  }

  const counts = { quote: 0, reply: 0, thread: 0 };
  const selected: DecidedOpportunity[] = [];

  for (const opp of dedupedEligible) {
    if (selected.length >= budget.max_total) break;
    if (opp.type === 'quote' && counts.quote >= budget.max_quotes) continue;
    if (opp.type === 'reply' && counts.reply >= budget.max_replies) continue;
    if ((opp.type === 'thread' || opp.type === 'article') && counts.thread >= budget.max_threads) continue;

    selected.push(opp);
    if (opp.type === 'quote') counts.quote++;
    else if (opp.type === 'reply') counts.reply++;
    else if (opp.type === 'thread' || opp.type === 'article') counts.thread++;
  }

  const selectedSet = new Set(selected.map(o => `${o.type}:${o.source_tweet_url}:${o.crafted_text}`));
  const held = decided
    .filter(o => !selectedSet.has(`${o.type}:${o.source_tweet_url}:${o.crafted_text}`))
    .sort((a, b) => b.decision_score.final_score - a.decision_score.final_score);

  return { selected, held, budget, stage };
}
