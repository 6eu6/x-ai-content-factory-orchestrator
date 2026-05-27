export type BrainRuleInput = {
  id?: number | string;
  rule_type?: string | null;
  rule?: string | null;
  evidence?: string | null;
  source_type?: string | null;
  source_url?: string | null;
  applies_to?: string | null;
  confidence_score?: number | null;
  status?: string | null;
  updated_at?: string | null;
};

export type StylePatternInput = {
  id?: number | string;
  pattern_type?: string | null;
  pattern_name?: string | null;
  pattern_description?: string | null;
  why_it_works?: string | null;
  adaptation_for_30piq?: string | null;
  confidence_score?: number | null;
  status?: string | null;
  updated_at?: string | null;
};

export type QualityDecision = {
  quality_score: number;
  recommended_status: 'active' | 'watch' | 'archived';
  reasons: string[];
};

const GENERIC_RULE_PHRASES = [
  'good content',
  'valuable content',
  'clear hook',
  'strong hook',
  'engaging content',
  'be consistent',
  'post regularly',
  'use visuals',
  'tell a story',
  'be authentic',
  'provide value',
  'know your audience',
  'high quality content',
  'write better',
  'engage with audience'
];

const SPECIFICITY_HINTS = [
  'because',
  'when',
  'if',
  'contrast',
  'before/after',
  'specific',
  'mechanism',
  'pattern',
  'example',
  'evidence',
  'score:',
  '@',
  'views',
  'replies',
  'bookmarks',
  'quote',
  'thread',
  'reply'
];

function textOf(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ').trim();
}

function clamp10(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function isGeneric(text: string): boolean {
  const lower = text.toLowerCase();
  return GENERIC_RULE_PHRASES.some(p => lower.includes(p));
}

function specificityScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const hint of SPECIFICITY_HINTS) {
    if (lower.includes(hint)) score += 0.5;
  }
  if (text.length >= 90) score += 1;
  if (text.length >= 180) score += 1;
  if (/\d/.test(text)) score += 0.75;
  if (/https?:\/\//.test(text)) score += 0.5;
  return Math.min(3, score);
}

function evidenceScore(evidence?: string | null, sourceUrl?: string | null, sourceType?: string | null): number {
  let score = 0;
  const ev = evidence || '';
  if (ev.length >= 30) score += 1;
  if (ev.length >= 100) score += 1;
  if (sourceUrl) score += 1;
  if (sourceType && !['manual', 'unknown', ''].includes(sourceType)) score += 0.5;
  if (/@|score:|views|replies|bookmarks|engagement/i.test(ev)) score += 0.75;
  return Math.min(3, score);
}

function stalenessPenalty(updatedAt?: string | null): number {
  if (!updatedAt) return 0.5;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.5;
  const days = (Date.now() - t) / (24 * 60 * 60 * 1000);
  if (days > 90) return 1.5;
  if (days > 45) return 0.75;
  return 0;
}

export function evaluateBrainRule(rule: BrainRuleInput): QualityDecision {
  const content = textOf(rule.rule_type, rule.rule, rule.evidence, rule.applies_to);
  const reasons: string[] = [];
  const confidence = clamp10(Number(rule.confidence_score ?? 5));
  let score = 2 + confidence * 0.35;

  if (!rule.rule || rule.rule.trim().length < 25) {
    score -= 2;
    reasons.push('Rule text is too short to be actionable');
  }

  const spec = specificityScore(content);
  score += spec;
  if (spec >= 2) reasons.push('Rule has specific/mechanistic signals');
  else reasons.push('Rule lacks enough specificity');

  const ev = evidenceScore(rule.evidence, rule.source_url, rule.source_type);
  score += ev;
  if (ev >= 2) reasons.push('Rule has usable evidence');
  else reasons.push('Evidence is weak or missing');

  if (isGeneric(content)) {
    score -= 2.5;
    reasons.push('Rule appears generic and may not improve decisions');
  }

  const penalty = stalenessPenalty(rule.updated_at || null);
  if (penalty > 0) {
    score -= penalty;
    reasons.push('Rule is stale or missing updated_at');
  }

  score = Math.round(clamp10(score) * 10) / 10;
  let recommended_status: QualityDecision['recommended_status'] = 'active';
  if (score < 3.5) recommended_status = 'archived';
  else if (score < 6.5) recommended_status = 'watch';

  return { quality_score: score, recommended_status, reasons };
}

export function evaluateStylePattern(pattern: StylePatternInput): QualityDecision {
  const content = textOf(pattern.pattern_type, pattern.pattern_name, pattern.pattern_description, pattern.why_it_works, pattern.adaptation_for_30piq);
  const reasons: string[] = [];
  const confidence = clamp10(Number(pattern.confidence_score ?? 5));
  let score = 2 + confidence * 0.35;

  if (!pattern.pattern_name || pattern.pattern_name.trim().length < 8) {
    score -= 1.5;
    reasons.push('Pattern name is too short');
  }
  if (!pattern.pattern_description || pattern.pattern_description.trim().length < 40) {
    score -= 1.5;
    reasons.push('Pattern description is weak');
  }
  if (!pattern.adaptation_for_30piq || pattern.adaptation_for_30piq.trim().length < 30) {
    score -= 1.25;
    reasons.push('Adaptation for @30piq is weak or missing');
  }

  const spec = specificityScore(content);
  score += spec;
  if (spec >= 2) reasons.push('Pattern has specific structure or evidence');
  else reasons.push('Pattern needs more specificity');

  if (isGeneric(content)) {
    score -= 2;
    reasons.push('Pattern appears generic');
  }

  const penalty = stalenessPenalty(pattern.updated_at || null);
  if (penalty > 0) {
    score -= penalty;
    reasons.push('Pattern is stale or missing updated_at');
  }

  score = Math.round(clamp10(score) * 10) / 10;
  let recommended_status: QualityDecision['recommended_status'] = 'active';
  if (score < 3.5) recommended_status = 'archived';
  else if (score < 6.5) recommended_status = 'watch';

  return { quality_score: score, recommended_status, reasons };
}
