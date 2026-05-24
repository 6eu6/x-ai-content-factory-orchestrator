/**
 * ثوابت مشتركة — ملف واحد لكل الأنماط المتكررة
 *
 * بدل ما نكرر نفس الأنماط في عدة ملفات، نعرفها هنا مرة واحدة
 * ونستوردها في كل مكان. هذا يمنع الانحراف بين الملفات.
 */

/**
 * أنماط أول شخص خطرة — فقط اللي تمثل ادعاءات غير موثقة
 * الاستخدام العادي مثل "I think" أو "my approach" مسموح
 *
 * تُستخدم في:
 * - lib/quality.ts (evaluateContentQuality)
 * - lib/content.ts (containsUnsafeClaim)
 * - lib/account-shield.ts (shieldCheck + quickShieldCheck)
 */
export const FIRST_PERSON_CLAIM_PATTERNS = [
  /i (saved|boosted|increased|improved|doubled|reduced|grew|cut|achieved)\b/i,
  /my (results?|experience|outcome|experiment|test|data|findings?) (show|prove|confirm|suggest|reveal|demonstrate)\b/i,
  /i (found|discovered|tested|proved|confirmed|measured|verified)\b/i,
  /i (got|achieved|reached|hit) \d+/i,
  /my \w+ (increased|improved|grew|doubled|reduced|boosted) (by )?\d+/i,
  // إضافات من content.ts اللي كانت مو موجودة في quality.ts
  /from (my )?experience,?\s*\d/i,
  /in my (experience|testing|experiment),?\s*/i,
  /saved (me |you |users? )?\d+/i,
];
