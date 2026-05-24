import { requiredEnv, optionalEnv } from './env';
import { supabaseAdmin } from './supabase';
import { callModel, parseModelJson, TaskType } from './model-router';
import { FIRST_PERSON_CLAIM_PATTERNS } from './constants';

/**
 * Account Shield — طبقة حماية الحساب v2
 *
 * يفحص كل محتوى قبل التسليم للتأكد إنه:
 * 1. ما فيه أنماط AI مكتشفة (Slop Detection)
 * 2. متوافق مع قواعد الحساب الصغير (Low-Follower Rules)
 * 3. ما يخالف الخوارزمية المخزنة في الذاكرة
 * 4. فيه عنصر أصلي حقيقي (Originality Gate)
 * 5. أي ادعاء رقمي له مصدر (Claim Verification)
 * 6. [جديد] فحص AI عميق — يحلل الأسلوب والبنية
 * 7. [جديد] اقتراحات إعادة كتابة ذكية
 */

export type ShieldResult = {
  passed: boolean;
  risk_level: 'safe' | 'warning' | 'danger';
  checks: ShieldCheck[];
  summary: string;
  suggestions: string[];
  ai_rewrite?: string;     // [جديد] نسخة مُعاد كتابتها
  ai_analysis?: string;    // [جديد] تحليل AI مفصّل
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
  'everything you need to know',
  // إضافة: المزيد من كلمات AI المكتشفة
  'it\'s worth noting', 'at the end of the day', 'the reality is',
  'needless to say', 'important to note', 'it goes without saying',
  'landscape', 'realm', 'robust', 'seamless', 'cutting-edge',
  'next-generation', 'state-of-the-art', 'paradigm shift'
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
  /^\d+\.\s+\w+/m,
  /^[-•]\s+\w+/m,
  /here are \d+ (ways|things|reasons|tips)/i,
  /if you want to \w+, you need to/i,
  /the (secret|key) to \w+ is/i,
];

// ═══════════════════════════════════════════════════
// قواعد الحساب الصغير (أقل من 500 متابع)
// ═══════════════════════════════════════════════════
const LOW_FOLLOWER_RULES = {
  max_external_links: 0,
  max_tags_per_tweet: 0,
  max_replies_per_hour: 4,
  no_identical_replies: true,
  no_mass_following: true
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
 * [جديد] فحص AI عميق — يحلل الأسلوب والبنية باستخدام نموذج
 */
async function aiDeepCheck(
  text: string,
  contentType: string,
  originalityElement?: string,
  mechanicUsed?: string
): Promise<{ analysis: string; rewrite_suggestion: string; ai_detected: boolean }> {
  try {
    const response = await callModel('shield_check', [
      {
        role: 'system',
        content: `You are an AI content detector and Twitter/X shield checker for @${optionalEnv('X_USERNAME', '30piq')}.
Analyze the text for:
1. AI-generated patterns (slop, formulaic structure, generic phrasing)
2. Risk to account reputation
3. Algorithm compatibility
4. Engagement potential

Then suggest a BETTER version that:
- Sounds like a smart friend in tech, not a content mill
- Varies sentence length (some 3 words, some 15 words)
- Includes a specific detail, name, or reference
- Has a conversational hook
- Avoids all AI-slop words and patterns
- Under 240 characters for tweets

Return JSON only.`
      },
      {
        role: 'user',
        content: `Analyze this ${contentType} content:

"${text}"

Originality element: ${originalityElement || 'none'}
Mechanic used: ${mechanicUsed || 'none'}

Return JSON:
{
  "analysis": "detailed analysis of what's wrong and what's right",
  "ai_detected": true/false,
  "ai_confidence": 0.0-1.0,
  "issues": ["issue1", "issue2"],
  "rewrite_suggestion": "better version of the text that passes all checks",
  "engagement_prediction": "low|medium|high"
}`
      }
    ]);

    const parsed = parseModelJson(response);
    return {
      analysis: parsed.analysis || '',
      rewrite_suggestion: parsed.rewrite_suggestion || '',
      ai_detected: parsed.ai_detected ?? false
    };
  } catch {
    return { analysis: '', rewrite_suggestion: '', ai_detected: false };
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
    deep_check?: boolean;   // [جديد] فحص AI عميق
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
  // فقط الادعاءات غير الموثقة — الاستخدام العادي مثل "I think" أو "my approach" مسموح
  // الأنماط مُعرّفة في lib/constants.ts
  const hasFirstPersonClaim = FIRST_PERSON_CLAIM_PATTERNS.some(p => p.test(text));
  if (hasFirstPersonClaim) {
    checks.push({
      name: 'first_person_unverified_claim',
      passed: false,
      severity: 'warn',
      detail: 'Contains first-person claims that may need verification (I saved/improved/achieved... etc)'
    });
    suggestions.push('Remove unverified first-person claims. Use general framing like "this approach" or add a source URL.');
  } else {
    checks.push({ name: 'first_person_claims', passed: true, severity: 'info', detail: 'No unverified first-person claims' });
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

  // ═══ 11. [جديد] فحص AI عميق — لو طلب أو لو في warning ═══
  let aiAnalysis = '';
  let aiRewrite = '';

  const hasWarnings = checks.some(c => c.severity === 'warn' || c.severity === 'block');
  if (content.deep_check || hasWarnings) {
    const deepResult = await aiDeepCheck(text, content.type, content.originality_element, content.mechanic_used);
    aiAnalysis = deepResult.analysis;
    aiRewrite = deepResult.rewrite_suggestion;

    if (deepResult.ai_detected) {
      checks.push({
        name: 'ai_style_detected',
        passed: false,
        severity: 'warn',
        detail: 'AI writing style detected — content may sound artificial'
      });
      suggestions.push('Rewrite to sound more natural. Vary sentence length. Add a personal reaction or specific reference.');
    }

    if (deepResult.rewrite_suggestion && deepResult.rewrite_suggestion !== text) {
      suggestions.push(`Suggested rewrite: "${deepResult.rewrite_suggestion}"`);
    }
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
    suggestions,
    ai_rewrite: aiRewrite || undefined,
    ai_analysis: aiAnalysis || undefined
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
  // فقط ادعاءات أول شخص غير موثقة — الأنماط مُعرّفة في lib/constants.ts
  if (FIRST_PERSON_CLAIM_PATTERNS.some(p => p.test(text))) reasons.push('first_person_unverified_claim');
  if (hasUnsourcedClaims(text).length) reasons.push('unsourced_numeric_claims');
  if (!item?.originality_element && !item?.mechanic_used) reasons.push('missing_originality');

  return { safe: reasons.length === 0, reasons };
}
