import { waitUntil } from '@vercel/functions';

/**
 * runBackground — تشغيل مهمة في الخلفية بشكل محمول بين البيئات
 *
 * - على Vercel (serverless): تُستدعى waitUntil لإبقاء الدالة حيّة بعد
 *   إرجاع الرد حتى تكتمل المهمة الخلفية.
 * - على خادم دائم (Raspberry Pi / Node عادي): لا يوجد سياق طلب لـ waitUntil،
 *   فتُرمى استثناءً ونتجاهله — العملية تبقى حيّة أصلاً فتكتمل المهمة وحدها.
 *
 * بهذا الشكل، نقل المشروع من Vercel إلى Pi لا يتطلب أي تعديل في نقاط الاستدعاء.
 */
export function runBackground(task: Promise<unknown>): void {
  const guarded = Promise.resolve(task).catch((err: unknown) => {
    const msg = (err as { message?: string })?.message || String(err);
    console.error('[background] task failed:', msg);
  });

  try {
    waitUntil(guarded);
  } catch {
    // ليست بيئة Vercel — العملية الدائمة ستكمل الـ promise من تلقاء نفسها.
  }
}
