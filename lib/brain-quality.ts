/**
 * Brain Quality Evaluator v1.0 — تقييم جودة القواعد والأنماط بدون لمس قاعدة البيانات
 *
 * يقيم:
 * - هل القاعدة عامة جدًا؟
 * - هل فيها دليل؟
 * - هل فيها آلية محددة؟
 * - هل فيها مصدر؟
 * - هل قديمة؟
 * - هل تصلح تبقى active؟
 * - هل الأفضل تتحول watch؟
 * - هل ضعيفة جدًا وتستحق archived؟
 */

export type QualityVerdict = {
  quality_score: number;          // 0–10
  recommended_status: 'active' | 'watch' | 'archived';
  reasons: string[];
};

// ═══ معايير التقييم ═══

/** أقل طول مقبول لنص القاعدة قبل اعتبارها عامة جدًا */
const MIN_RULE_LENGTH = 30;

/** أقل طول مقبول لنص النمط قبل اعتباره غير مكتمل */
const MIN_PATTERN_LENGTH = 30;

/** أقل طول مقبول للدليل */
const MIN_EVIDENCE_LENGTH = 15;

/** علامات عامة — كلمات مفتاحية تدل أن القاعدة سطحية */
const GENERIC_PHRASES = [
  'content that resonates',
  'engaging content',
  'good content',
  'high quality',
  'relevant content',
  'valuable content',
  'useful content',
  'important to',
  'it is important',
  'make sure to',
  'always remember',
  'best practices',
  'general best',
  'overall strategy',
  'be authentic',
  'be consistent',
  'create value',
  'build trust',
  'stay relevant',
  'keep it real',
  'content strategy',
  'audience engagement',
  'social media',
  'viral content',
  'grow your',
  'increase engagement',
  'boost your',
  'maximize your',
  'optimize your',
];

/** أنماط خام — أسماء من مصادر بدون تحليل */
const RAW_SOURCE_PATTERN = /use this crawled item as a source-grounded pattern/i;
const GITHUB_REPO_PATTERN = /^[a-z0-9_-]+\/[a-z0-9_-]+$/i;
const URL_PATTERN = /https?:\/\//i;

// ═══ منطق التقييم ═══

/**
 * evaluateBrainRule — يقيّم قاعدة خوارزمية واحدة
 *
 * @param rule صف من جدول x_algorithm_learning_rules
 * @returns حكم الجودة مع التوصية
 */
export function evaluateBrainRule(rule: Record<string, any>): QualityVerdict {
  const reasons: string[] = [];
  let score = 7.0; // نبدأ من 7 (محايد-إيجابي)

  const ruleText = String(rule.rule || '').trim();
  const evidence = String(rule.evidence || '').trim();
  const confidence = Number(rule.confidence_score ?? 5);
  const ruleType = String(rule.rule_type || '');
  const sourceType = String(rule.source_type || '');
  const appliesTo = String(rule.applies_to || '');
  const status = String(rule.status || 'active');

  // ── 1. طول النص: هل القاعدة عامة جدًا؟ ──
  if (!ruleText || ruleText.length < MIN_RULE_LENGTH) {
    score -= 2.5;
    reasons.push(`Rule text too short (${ruleText.length} chars, minimum ${MIN_RULE_LENGTH})`);
  }

  // ── 2. عبارات عامة ──
  const lowerRule = ruleText.toLowerCase();
  const genericMatches = GENERIC_PHRASES.filter(p => lowerRule.includes(p));
  if (genericMatches.length >= 2) {
    score -= 2.0;
    reasons.push(`Contains ${genericMatches.length} generic phrases: ${genericMatches.slice(0, 3).join(', ')}`);
  } else if (genericMatches.length === 1) {
    score -= 0.7;
    reasons.push(`Contains generic phrase: ${genericMatches[0]}`);
  }

  // ── 3. الدليل ──
  if (!evidence || evidence.length < MIN_EVIDENCE_LENGTH) {
    score -= 1.5;
    reasons.push('Missing or weak evidence');
  } else if (evidence.length > 40) {
    score += 0.5;
    reasons.push('Has substantial evidence');
  }

  // ── 4. آلية محددة ──
  const hasMechanic =
    /specific|mechanic|trigger|pattern|formula|framework|technique|method|approach|when .* then|if .* then/i.test(ruleText);
  if (hasMechanic) {
    score += 0.8;
    reasons.push('Contains specific mechanic/pattern');
  } else {
    score -= 0.5;
    reasons.push('Lacks specific mechanic');
  }

  // ── 5. نوع القاعدة ──
  const strongTypes = ['precise_concept', 'psychological_trigger', 'viral_pattern', 'media_impact'];
  const weakTypes = ['conversation_context', 'general_observation'];
  if (strongTypes.includes(ruleType)) {
    score += 0.3;
  } else if (weakTypes.includes(ruleType)) {
    score -= 0.3;
    reasons.push(`Weak rule type: ${ruleType}`);
  }

  // ── 6. المصدر ──
  if (!sourceType || sourceType === 'unknown') {
    score -= 0.5;
    reasons.push('No source type');
  }

  // ─ـ 7. applies_to ──
  if (!appliesTo) {
    score -= 0.3;
    reasons.push('Missing applies_to field');
  }

  // ── 8. الثقة ──
  if (confidence < 3) {
    score -= 1.5;
    reasons.push(`Very low confidence: ${confidence}`);
  } else if (confidence < 5) {
    score -= 0.7;
    reasons.push(`Low confidence: ${confidence}`);
  } else if (confidence >= 8) {
    score += 0.3;
  }

  // ── 9. الحالة الحالية ──
  if (status === 'watch') {
    // قاعدة watch ابدأ أقل شوي
    score -= 0.5;
    reasons.push('Currently in watch status');
  }

  // ── 10. قواعد بدون rule_type ──
  if (!ruleType) {
    score -= 0.5;
    reasons.push('Missing rule_type');
  }

  // ── حد النتيجة ──
  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

  // ── التوصية ──
  let recommended_status: QualityVerdict['recommended_status'];
  if (score >= 5.5) {
    recommended_status = 'active';
  } else if (score >= 3.0) {
    recommended_status = 'watch';
  } else {
    recommended_status = 'archived';
  }

  return { quality_score: score, recommended_status, reasons };
}

/**
 * evaluateStylePattern — يقيّم نمط أسلوبي واحد
 *
 * @param pattern صف من جدول viral_style_patterns
 * @returns حكم الجودة مع التوصية
 */
export function evaluateStylePattern(pattern: Record<string, any>): QualityVerdict {
  const reasons: string[] = [];
  let score = 7.0;

  const patternName = String(pattern.pattern_name || '').trim();
  const patternType = String(pattern.pattern_type || '');
  const patternDescription = String(pattern.pattern_description || '').trim();
  const whyItWorks = String(pattern.why_it_works || '').trim();
  const adaptation = String(pattern.adaptation_for_30piq || '').trim();
  const confidence = Number(pattern.confidence_score ?? 5);
  const status = String(pattern.status || 'active');

  // ── 1. اسم النمط ──
  if (!patternName || patternName.length < 5) {
    score -= 2.0;
    reasons.push('Pattern name too short or missing');
  }

  // ── 2. اسم خام من مصدر ──
  if (RAW_SOURCE_PATTERN.test(patternName) || GITHUB_REPO_PATTERN.test(patternName) || URL_PATTERN.test(patternName)) {
    score -= 3.0;
    reasons.push('Raw source name — not a real style pattern');
  }

  // ── 3. الوصف ──
  if (!patternDescription || patternDescription.length < MIN_PATTERN_LENGTH) {
    score -= 2.0;
    reasons.push(`Pattern description too short (${patternDescription.length} chars, minimum ${MIN_PATTERN_LENGTH})`);
  } else if (patternDescription.length > 80) {
    score += 0.5;
    reasons.push('Has substantial description');
  }

  // ── 4. raw source in description ──
  if (RAW_SOURCE_PATTERN.test(patternDescription)) {
    score -= 2.5;
    reasons.push('Description is raw source placeholder');
  }

  // ── 5. why_it_works ──
  if (!whyItWorks || whyItWorks.length < 15) {
    score -= 1.0;
    reasons.push('Missing or weak "why it works" explanation');
  } else {
    score += 0.3;
    reasons.push('Has "why it works" explanation');
  }

  // ── 6. التكييف ──
  if (adaptation && adaptation.length > 20) {
    score += 0.5;
    reasons.push('Has adaptation guidance');
  }

  // ── 7. نوع النمط ──
  const strongTypes = ['hook', 'structure', 'bookmark_trigger', 'reply_trigger'];
  if (!patternType) {
    score -= 0.5;
    reasons.push('Missing pattern_type');
  } else if (strongTypes.includes(patternType)) {
    score += 0.3;
  }

  // ── 8. عبارات عامة ──
  const lowerDesc = patternDescription.toLowerCase();
  const genericMatches = GENERIC_PHRASES.filter(p => lowerDesc.includes(p));
  if (genericMatches.length >= 2) {
    score -= 1.5;
    reasons.push(`Contains ${genericMatches.length} generic phrases in description`);
  }

  // ── 9. الثقة ──
  if (confidence < 3) {
    score -= 1.5;
    reasons.push(`Very low confidence: ${confidence}`);
  } else if (confidence < 5) {
    score -= 0.5;
    reasons.push(`Low confidence: ${confidence}`);
  } else if (confidence >= 8) {
    score += 0.3;
  }

  // ── 10. الحالة الحالية ──
  if (status === 'watch') {
    score -= 0.5;
    reasons.push('Currently in watch status');
  }

  // ── حد النتيجة ──
  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

  // ── التوصية ──
  let recommended_status: QualityVerdict['recommended_status'];
  if (score >= 5.5) {
    recommended_status = 'active';
  } else if (score >= 3.0) {
    recommended_status = 'watch';
  } else {
    recommended_status = 'archived';
  }

  return { quality_score: score, recommended_status, reasons };
}
