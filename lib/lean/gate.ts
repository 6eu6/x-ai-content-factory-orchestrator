/**
 * Lean Core — One simple gate
 *
 * The legacy pipeline had FIVE stacked AI gates with thresholds so strict
 * (originality >= 7.8, evidence_safety >= 8) that it rejected ~98% of its own
 * output and produced zero recommendations for days. An AI judging another
 * AI's "originality" on a 1–10 scale is noise, not a quality signal.
 *
 * This replaces all of that with a handful of cheap, deterministic checks that
 * catch the things that actually matter for a manual-publish workflow:
 *   - it must be English
 *   - it must fit in a tweet
 *   - it must be real prose (not JSON / not an empty stub)
 *   - it must not be obvious engagement-bait slop
 *
 * Taste is the human's job at publish time. The tool's job is to never waste
 * the human's attention on broken or junk suggestions.
 */

export type GateResult = { ok: boolean; reason?: string };

const BAIT_PATTERNS: RegExp[] = [
  /^\s*(hot take|interesting take)\b/i,
  /\bthis is huge\b/i,
  /\bgame[- ]changer\b/i,
  /\bthoughts\?\s*$/i,
  /^\s*so true\b/i,
  /^\s*this\.\s*$/i,
  /\bmind[- ]?blown\b/i,
  /\bwe are so back\b/i,
];

const ARABIC = /[؀-ۿ]/;
// Non-latin scripts that indicate the model wrote in the wrong language when
// English content was requested.
const NON_LATIN_WORD = /[؀-ۿЀ-ӿ一-鿿぀-ヿ가-힯]/;

// Fabricated-statistic patterns. Kept deliberately narrow (only the clearest
// invented-number phrasings) so we do not repeat the legacy mistake of
// rejecting everything numeric. A source-backed reply can still cite the source
// tweet's own numbers; this targets unsupported claims the model invents.
const FABRICATED_STAT_PATTERNS: RegExp[] = [
  /\b(?:studies|research|data|surveys?)\s+(?:show|shows|prove|proves|confirm|confirms|reveal|reveals)\b/i,
  /\b\d{1,3}%\s+of\s+(?:people|users|developers|companies|startups|teams)\b/i,
  /\b(?:increased|decreased|grew|dropped|boosted|reduced|cut|improved|saved)\s+(?:by\s+)?\d{1,3}%/i,
  /\b\d+x\s+(?:faster|better|more|higher|cheaper|productive)\b/i,
  /\b(?:millions?|billions?)\s+of\s+(?:people|users|developers|dollars)\b/i,
];

/** True when the text states an invented-sounding statistic with no cited source/link. */
export function hasUnsupportedNumericClaim(text: string): boolean {
  const t = String(text || '');
  const hasSource = /https?:\/\/\S+/i.test(t); // a linked source excuses the number
  if (hasSource) return false;
  return FABRICATED_STAT_PATTERNS.some((re) => re.test(t));
}

/**
 * @param language expected publish language ('en', 'ar', ...). Language checks
 *   are only enforced for 'en' (must be latin script). For non-English profiles
 *   we trust the generator + human review rather than guess every script.
 */
export function gateSuggestion(text: string, maxLen = 280, language = 'en'): GateResult {
  const t = String(text || '').trim();

  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 8) return { ok: false, reason: 'too_short' };
  if (t.length > maxLen) return { ok: false, reason: `over_${maxLen}_chars` };

  // Reject JSON / structured leakage from the model.
  if (/^[[{]/.test(t) && /[\]}]\s*$/.test(t)) return { ok: false, reason: 'looks_like_json' };
  if (/"(text|reply|quote|content)"\s*:/.test(t)) return { ok: false, reason: 'json_field_leak' };

  // Language enforcement (English profiles must be latin script).
  if (language === 'en') {
    if (ARABIC.test(t)) return { ok: false, reason: 'arabic_in_english_profile' };
    if (NON_LATIN_WORD.test(t)) return { ok: false, reason: 'non_english_script' };
  } else if (language === 'ar') {
    if (!ARABIC.test(t)) return { ok: false, reason: 'expected_arabic' };
  }

  for (const re of BAIT_PATTERNS) {
    if (re.test(t)) return { ok: false, reason: 'engagement_bait' };
  }

  if (hasUnsupportedNumericClaim(t)) return { ok: false, reason: 'unsupported_numeric_claim' };

  return { ok: true };
}

/** Cheap near-duplicate check against recently published text. */
export function isNearDuplicate(text: string, recent: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(text);
  if (!a) return false;
  const aWords = new Set(a.split(' '));
  for (const r of recent) {
    const b = norm(r);
    if (!b) continue;
    if (a === b) return true;
    const bWords = new Set(b.split(' '));
    let overlap = 0;
    for (const w of aWords) if (bWords.has(w)) overlap++;
    const ratio = overlap / Math.max(aWords.size, bWords.size);
    if (ratio > 0.75) return true; // ~same post reworded
  }
  return false;
}
