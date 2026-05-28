export type PublishPolicyRejection = {
  index: number;
  type?: string;
  reason: string;
  preview: string;
};

export type PublishPolicyResult<T> = {
  accepted: T[];
  rejected: PublishPolicyRejection[];
};

const ARABIC_RE = /[\u0600-\u06FF]/;
const VALID_X_STATUS_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\?.*)?$/i;
const JSONISH_RE = /^\s*[\{\[]|"(?:tweet|text|quote)"\s*:/i;

export const ENGLISH_ACCOUNT_CONTENT_POLICY = [
  'Audience: English-speaking markets: US, UK, Canada, Australia, and similar.',
  'Publishable content language: English only. Never write Arabic in content meant for X.',
  'Telegram interface can be Arabic; model instructions and publishable output must be English.',
  'No hashtags, no decorative emojis, no inflated claims, no invented statistics.',
  'Write direct, specific, concise content. Avoid generic AI-style phrasing.',
  'Reject output that looks like JSON, metadata, explanations, or formatting wrappers.',
  'Only publish recommendations that pass account shield and source validation.'
].join('\n');

export function containsArabic(text: string): boolean {
  return ARABIC_RE.test(text || '');
}

export function looksJsonish(text: string): boolean {
  return JSONISH_RE.test(String(text || '').trim());
}

export function isValidXStatusUrl(url: string): boolean {
  return VALID_X_STATUS_RE.test(String(url || '').trim());
}

export function isEnglishPublishableText(text: string): { ok: boolean; reason?: string } {
  const value = String(text || '').trim();
  if (value.length < 10) return { ok: false, reason: 'too_short' };
  if (value.length > 1200) return { ok: false, reason: 'too_long' };
  if (containsArabic(value)) return { ok: false, reason: 'arabic_content_detected' };
  if (looksJsonish(value)) return { ok: false, reason: 'json_or_metadata_output' };
  return { ok: true };
}

export function filterPublishableOpportunities<T extends {
  type?: string;
  crafted_text?: string;
  source_tweet_url?: string;
  shield_passed?: boolean;
  shield_issues?: string[];
}>(opportunities: T[] = []): PublishPolicyResult<T> {
  const accepted: T[] = [];
  const rejected: PublishPolicyRejection[] = [];

  opportunities.forEach((opp, index) => {
    const preview = String(opp?.crafted_text || '').slice(0, 140);
    const type = String(opp?.type || 'unknown');

    if (opp?.shield_passed !== true) {
      rejected.push({ index, type, reason: `shield_not_passed:${(opp?.shield_issues || []).join(',') || 'unknown'}`, preview });
      return;
    }

    const textCheck = isEnglishPublishableText(opp?.crafted_text || '');
    if (!textCheck.ok) {
      rejected.push({ index, type, reason: textCheck.reason || 'text_policy_failed', preview });
      return;
    }

    if ((type === 'reply' || type === 'quote') && !isValidXStatusUrl(opp?.source_tweet_url || '')) {
      rejected.push({ index, type, reason: 'invalid_source_tweet_url', preview });
      return;
    }

    accepted.push(opp);
  });

  return { accepted, rejected };
}
