import { requiredEnv, optionalEnv } from './env';
import { supabaseAdmin } from './supabase';
import { callModel, TaskType } from './model-router';

/**
 * Account Shield — طبقة حماية الحساب
 *
 * يفحص كل محتوى قبل التسليم للتأكد إنه:
 * 1. ما فيه أنماط AI مكتشفة (Slop Detection)
 * 2. متوافق مع قواعد الحساب الصغير (Low-Follower Rules)
 * 3. ما يخالف الخوارزمية المخزنة في الذاكرة
 * 4. فيه عنصر أصلي حقيقي (Originality Gate)
 * 5. أي ادعاء رقمي له مصدر (Claim Verification)
 */

export type ShieldResult = {
  passed: boolean;
  risk_level: 'safe' | 'warning' | 'danger';
  checks: ShieldCheck[];
  summary: string;
  suggestions: string[];
};

export type ShieldCheck = {
  name: string;
  passed: boolean;
  severity: 'info' | 'warn' | 'block';
  detail: string;
};

// ═══════════════════════════════════════════════════
// كلمات وأنماط Slop المحظورة — من تحليل Banger Classifier
// ═══════════════════════════════════════════════════
const SLOP_FORBIDDEN_WORDS = [
  'delve', 'tapestry', 'crucial', 'synergy', 'leverage',
  'revolutionize', 'transform', 'unleash', 'navigate', 'foster',
  'elevate', 'empower', 'streamline', 'harness', 'pioneer',
  'game-changer', 'gamechanger', 'unlock the power',
  'in this thread', "let's dive in", 'here\'s the thing',
  'a thread on', 'in today\'s fast-paced', 'unlocking',
  'everything you need to know'
];

const SLOP_FORBIDDEN_PATTERNS = [
  /in this thread i'?ll show you/i,
  /let'?s dive in/i,
  /here'?s the thing/i,
  /a thread on \w+/i,
  /in today'?s fast-paced world/i,
  /unlock the power of/i,
  /game.?changer/i,
  /revolutionize your workflow/i,
  /^\d+\.\s+\w+/m,              // قائمة مرقمة كبداية
  /^[-•]\s+\w+/m,               // قائمة نقطية كبداية
];

// ═══════════════════════════════════════════════════
// قواعد الحساب الصغير (أقل من 500 متابع)
// ═══════════════════════════════════════════════════
const LOW_FOLLOWER_RULES = {
  max_external_links: 0,         // لا روابط خارجية
  max_tags_per_tweet: 0,         // لا tags
  max_replies_per_hour: 4,       // حد أقصى للردود
  no_identical_replies: true,    // لا ردود متشابهة
  no_mass_following: true        // لا متابعة جماعية
};

// ═══════════════════════════════════════════════════
// أنماط الادعاءات اللي تحتاج مصدر
// ═══════════════════════════════════════════════════
const UNSOURCED_CLAIM_PATTERNS = [
  /studies show/i,
  /research shows/i,
  /data shows/i,
  /experts say/i,
  /recent (studies|research|data)/i,
  /\d+\s*(percent|%|hours?|minutes?|x\s*(faster|better|more))/i,
  /saved (me|you|users?)\s+\d+/i,
  /increased by\s+\d+/i,
  /improved by\s+\d+/i,
];

function hasSlopWords(text: string): string[] {
  const lower = text.toLowerCase();
  return SLOP_FORBIDDEN_WORDS.filter(w => lower.includes(w));
}

function hasSlopPatterns(text: string): string[] {
  return SLOP_FORBIDDEN_PATTERNS
    .filter(p => p.test(text))
    .map(p => p.source);
}

function hasUnsourcedClaims(text: string, sources?: string[]): string[] {
  const found: string[] = [];
  for (const pattern of UNSOURCED_CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      const hasSource = sources?.some(s => s.length > 0) || /https?:\/\//i.test(text);
      if (!hasSource) found.push(pattern.source);
    }
  }
  return found;
}

function checkSymmetry(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const lengths = lines.map(l => l.trim().length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const allSimilar = lengths.every(l => Math.abs(l - avg) < avg * 0.3);
  return allSimilar;
}

async function getAccountFollowerCount(): Promise<number> {
  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('account_state')
      .select('followers_count')
      .eq('account_handle', optionalEnv('X_USERNAME', '30piq'))
      .maybeSingle();
    return data?.followers_count ?? 0;
  } catch {
    return 0;
  }
}

async function getAlgorithmRules(): Promise<string[]> {
  try {
    const supabase = supabaseAdmin();
    const { data } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(10);
    return (data || []).map((r: any) => r.rule);
  } catch {
    return [];
  }
}

/**
 * الفحص الرئيسي — يفحص أي محتوى قبل التسليم
 */
export async function shieldCheck(
  content: {
    text: string;
    type: 'tweet' | 'thread' | 'article' | 'reply' | 'quote' | 'video_script' | 'carousel';
    sources?: string[];
    originality_element?: string;
    mechanic_used?: string;
    reply_trigger?: string;
    bookmark_trigger?: string;
  }
): Promise<ShieldResult> {
  const checks: ShieldCheck[] = [];
  const suggestions: string[] = [];
  const text = content.text || '';
  const sources = content.sources || [];

  // ═══ 1. Slop Detection ═══
  const slopWords = hasSlopWords(text);
  const slopPatterns = hasSlopPatterns(text);
  if (slopWords.length > 0) {
    checks.push({
      name: 'slop_forbidden_words',
      passed: false,
      severity: 'block',
      detail: `Found forbidden AI-slop words: ${slopWords.join(', ')}`
    });
    suggestions.push(`Remove these words: ${slopWords.join(', ')}. Replace with casual alternatives.`);
  } else {
    checks.push({ name: 'slop_forbidden_words', passed: true, severity: 'info', detail: 'No forbidden words detected' });
  }

  if (slopPatterns.length > 0) {
    checks.push({
      name: 'slop_forbidden_patterns',
      passed: false,
      severity: 'block',
      detail: `Found forbidden AI patterns: ${slopPatterns.join(', ')}`
    });
    suggestions.push('Rewrite to avoid formulaic AI patterns. Use natural conversation flow.');
  } else {
    checks.push({ name: 'slop_forbidden_patterns', passed: true, severity: 'info', detail: 'No forbidden patterns detected' });
  }

  // ═══ 2. Symmetry Check ═══
  const isSymmetric = checkSymmetry(text);
  if (isSymmetric && text.split('\n').length >= 3) {
    checks.push({
      name: 'symmetry_detection',
      passed: false,
      severity: 'warn',
      detail: 'Content has perfectly symmetrical structure (AI-like pattern)'
    });
    suggestions.push('Vary sentence/line lengths. Add a shorter or longer paragraph to break symmetry.');
  } else {
    checks.push({ name: 'symmetry_detection', passed: true, severity: 'info', detail: 'Structure is varied enough' });
  }

  // ═══ 3. Emoji Check ═══
  const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojiCount > 2) {
    checks.push({
      name: 'emoji_overuse',
      passed: false,
      severity: 'warn',
      detail: `Too many emojis: ${emojiCount} (max 2 per tweet)`
    });
    suggestions.push('Reduce emojis to 0-2 maximum. Emojis at start AND end of same tweet are forbidden.');
  } else {
    checks.push({ name: 'emoji_overuse', passed: true, severity: 'info', detail: `Emoji count: ${emojiCount}` });
  }

  // ═══ 4. Hashtag Check ═══
  if (/#/.test(text)) {
    checks.push({
      name: 'hashtag_check',
      passed: false,
      severity: 'block',
      detail: 'Contains hashtags — forbidden for this account'
    });
    suggestions.push('Remove all hashtags. They trigger spam classifiers and reduce reach.');
  } else {
    checks.push({ name: 'hashtag_check', passed: true, severity: 'info', detail: 'No hashtags' });
  }

  // ═══ 5. First-Person Claim Check ═══
  const firstPersonMatches = text.match(/\bI\b|\bmy\b|\bme\b/i);
  if (firstPersonMatches) {
    checks.push({
      name: 'first_person_claims',
      passed: false,
      severity: 'warn',
      detail: 'Contains first-person claims (I/my/me) — risky if not backed by real experience'
    });
    suggestions.push('Remove first-person claims unless they are genuinely true. Use "this approach" or general framing instead.');
  } else {
    checks.push({ name: 'first_person_claims', passed: true, severity: 'info', detail: 'No first-person claims' });
  }

  // ═══ 6. Unsourced Claims Check ═══
  const unsourcedClaims = hasUnsourcedClaims(text, sources);
  if (unsourcedClaims.length > 0) {
    checks.push({
      name: 'unsourced_claims',
      passed: false,
      severity: 'block',
      detail: `Found claims without sources: ${unsourcedClaims.join(', ')}`
    });
    suggestions.push('Add source URLs or remove the specific numbers/claims.');
  } else {
    checks.push({ name: 'unsourced_claims', passed: true, severity: 'info', detail: 'All claims are sourced or opinion-based' });
  }

  // ═══ 7. Originality Gate ═══
  if (!content.originality_element && !content.mechanic_used) {
    checks.push({
      name: 'originality_gate',
      passed: false,
      severity: 'warn',
      detail: 'No originality element or mechanic specified — content may be generic'
    });
    suggestions.push('Add an original angle: personal test, comparison, counterargument, workflow, or screenshot.');
  } else {
    checks.push({ name: 'originality_gate', passed: true, severity: 'info', detail: `Originality: ${content.originality_element || content.mechanic_used}` });
  }

  // ═══ 8. Engagement Mechanics Check ═══
  if (!content.reply_trigger && !content.bookmark_trigger) {
    checks.push({
      name: 'engagement_mechanics',
      passed: false,
      severity: 'warn',
      detail: 'No reply trigger or bookmark trigger — content may not generate algorithm signals'
    });
    suggestions.push('Add a question, debatable point, or save-worthy insight to trigger replies and bookmarks.');
  } else {
    checks.push({ name: 'engagement_mechanics', passed: true, severity: 'info', detail: 'Has engagement mechanics' });
  }

  // ═══ 9. Low-Follower Rules ═══
  const followerCount = await getAccountFollowerCount();
  if (followerCount < 500) {
    const hasExternalLink = /https?:\/\//i.test(text);
    const hasTag = /@\w+/.test(text);
    
    if (hasExternalLink && LOW_FOLLOWER_RULES.max_external_links === 0) {
      checks.push({
        name: 'low_follower_link_rule',
        passed: false,
        severity: 'block',
        detail: `External link detected while followers < 500 (${followerCount}) — triggers SpamEapiLowFollowerClassifier`
      });
      suggestions.push('Replace the link with a screenshot of the page/tool. Links trigger spam classifier for low-follower accounts.');
    } else {
      checks.push({ name: 'low_follower_link_rule', passed: true, severity: 'info', detail: `Followers: ${followerCount}, no risky links` });
    }

    if (hasTag && LOW_FOLLOWER_RULES.max_tags_per_tweet === 0) {
      checks.push({
        name: 'low_follower_tag_rule',
        passed: false,
        severity: 'warn',
        detail: `Tagging detected while followers < 500 — risky for spam classifier`
      });
      suggestions.push('Remove tags. Tagging multiple people triggers spam detection for new accounts.');
    } else {
      checks.push({ name: 'low_follower_tag_rule', passed: true, severity: 'info', detail: `Followers: ${followerCount}, no risky tags` });
    }
  } else {
    checks.push({ name: 'low_follower_rules', passed: true, severity: 'info', detail: `Followers: ${followerCount} — above 500 threshold` });
  }

  // ═══ 10. Content Length Check ═══
  if (content.type === 'tweet' && text.length > 280) {
    checks.push({
      name: 'tweet_length',
      passed: false,
      severity: 'block',
      detail: `Tweet is ${text.length} chars — exceeds 280 limit`
    });
    suggestions.push('Shorten to under 280 characters. Move details to a thread if needed.');
  } else if (content.type === 'tweet' && text.length > 240) {
    checks.push({
      name: 'tweet_length',
      passed: true,
      severity: 'warn',
      detail: `Tweet is ${text.length} chars — within limit but close to 280`
    });
  } else {
    checks.push({ name: 'tweet_length', passed: true, severity: 'info', detail: `Length: ${text.length} chars` });
  }

  // ═══ حساب النتيجة النهائية ═══
  const blocked = checks.filter(c => c.severity === 'block');
  const warnings = checks.filter(c => c.severity === 'warn');
  const passed = blocked.length === 0;
  const riskLevel: ShieldResult['risk_level'] = blocked.length > 0 ? 'danger' : warnings.length > 1 ? 'warning' : 'safe';

  const summaryParts: string[] = [];
  if (blocked.length) summaryParts.push(`BLOCKED: ${blocked.map(c => c.name).join(', ')}`);
  if (warnings.length) summaryParts.push(`WARNINGS: ${warnings.map(c => c.name).join(', ')}`);
  if (passed) summaryParts.push('All critical checks passed');

  return {
    passed,
    risk_level: riskLevel,
    checks,
    summary: summaryParts.join(' | '),
    suggestions
  };
}

/**
 * فحص سريع بدون async — للـ quality gate الموجود
 */
export function quickShieldCheck(text: string, item?: any): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (hasSlopWords(text).length) reasons.push('slop_forbidden_words');
  if (hasSlopPatterns(text).length) reasons.push('slop_forbidden_patterns');
  if (checkSymmetry(text) && text.split('\n').length >= 3) reasons.push('symmetric_structure');
  if (/#/.test(text)) reasons.push('has_hashtag');
  if (/\bI\b|\bmy\b|\bme\b/i.test(text)) reasons.push('first_person_claim_risk');
  if (hasUnsourcedClaims(text).length) reasons.push('unsourced_numeric_claims');
  if (!item?.originality_element && !item?.mechanic_used) reasons.push('missing_originality');

  return { safe: reasons.length === 0, reasons };
}
