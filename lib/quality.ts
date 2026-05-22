export type QualityResult = {
  status: 'ready' | 'needs_review';
  reasons: string[];
};

const UNSOURCED_CLAIM_PATTERNS = [
  /recent studies show/i,
  /research shows/i,
  /studies show/i,
  /data shows/i,
  /experts say/i,
  /\b\d+\s*(scientists|hours|papers|users|companies|percent|%)\b/i,
  /match top human/i,
  /expert level/i,
  /breakthrough/i,
  /first ai/i,
  /best ai/i,
  /free vs paid/i,
  /\$\d+/i
];

const GENERIC_PATTERNS = [
  /ai tools are not equal/i,
  /use ai to be more productive/i,
  /streamline your workflow/i,
  /share your thoughts/i,
  /what do you think/i,
  /which feature matters most/i
];

function hasSource(text: string, item: any) {
  const payload = JSON.stringify(item || {});
  return /https?:\/\//i.test(text) || /source_urls|source_url|source:/i.test(payload);
}

export function evaluateContentQuality(item: any): QualityResult {
  const text = String(item?.text || item?.final_text || '');
  const reasons: string[] = [];

  if (!text.trim()) reasons.push('empty_content');
  if (text.length > 240) reasons.push('over_240_chars');
  if (/#/.test(text)) reasons.push('has_hashtag');
  if (/\bI\b|\bmy\b|\bme\b/i.test(text)) reasons.push('first_person_claim_risk');

  const claimRisk = UNSOURCED_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
  if (claimRisk && !hasSource(text, item)) reasons.push('claim_needs_source');

  if (GENERIC_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('generic_or_engagement_bait');
  if (!item?.mechanic_used && !item?.viral_pattern_basis && !item?.why_this_is_not_generic) reasons.push('missing_mechanic_metadata');
  if (!item?.reply_trigger && !item?.bookmark_trigger) reasons.push('missing_engagement_mechanics');

  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}
